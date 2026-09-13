// PokeRogue Offline - Electron main process (DESIGN.md §3.10).
//
// Start-up order matters and is:
//   1. one instance only (a second launch just brings the first window forward)
//   2. userData -> %APPDATA%\PokeRogue Offline, so logs and saves are never next to the exe
//   3. file logger (nothing above this point can be logged to a file)
//   4. find the game files
//   5. start the local game server on 47830 (see PORT handling below)
//   6. ask whether we are online, open the window, and only then start saving online
//
// Nothing in here ever asks the user a question she did not cause, except the one conflict
// question. Everything she reads is in strings.de.ts.

import { BrowserWindow, app, net, powerMonitor, session } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../common/log";
import {
  GAME_PORT,
  type ConflictAnswer,
  type ConflictQuestion,
  type Connectivity,
  type Mirror,
  type ProxyHandle,
  type RuntimeDeps,
  type SyncResult,
} from "./contracts";
import {
  askConflict,
  hideSavingSplash,
  installDialogs,
  openBackupsFolder,
  openSettings,
  showBackupSavedNotice,
  showNeedsGameUpdateNotice,
  currentBackupsDir,
  openUpdateWindow,
  type UpdateWindowState,
  showSavingSplash,
  showStartupError,
  type SettingsPageData,
} from "./dialogs";
import { ensureGameFiles, type GameLocation } from "./game-files";
import { formatPlayTime, formatRelative } from "./format";
import { forceOfflineCheck as makeForceOfflineCheck, FORCE_OFFLINE_FILE } from "./dev-hooks";
import { createFileLogger } from "./logger";
import { createSecretCodec } from "./secret";
import { SettingsStore, readJsonSafe } from "./settings";
import { DE } from "./strings.de";
import { createTray, destroyTray } from "./tray";
import { Updater, type AvailableUpdate } from "./updater";
import { createGameWindow, focusWindow } from "./window";

const APP_FOLDER_NAME = "PokeRogue Offline";
const SYNC_AFTER_ONLINE_MS = 3_000;
const SYNC_EVERY_MS = 10 * 60_000;
const QUIT_SYNC_LIMIT_MS = 30_000;
const QUIT_SPLASH_AFTER_MS = 2_000;
const ONLINE_POLL_MS = 15_000;

// --- process-wide state ------------------------------------------------------

let log: Logger;
let settings: SettingsStore;
let mirror: Mirror | null = null;
let connectivity: Connectivity;
let runtime: RuntimeDeps | null = null;
let proxy: ProxyHandle | null = null;
let updater: Updater | null = null;
let gameWindow: BrowserWindow | null = null;
let gameLocation: GameLocation | null = null;

let syncTimer: NodeJS.Timeout | null = null;
let syncKickoff: NodeJS.Timeout | null = null;
let syncInFlight: Promise<SyncResult | null> | null = null;
let quitting = false;
let backupNoticeShown = false;
/** The "there is a new version" message is shown at most once per app start, wherever it comes from. */
let gameUpdateNoticeShown = false;
let lastOnline = false;

// -----------------------------------------------------------------------------
// Entry
// -----------------------------------------------------------------------------

// Keep everything in one place under %APPDATA%. Must run before app is ready.
app.setPath("userData", join(app.getPath("appData"), APP_FOLDER_NAME));
app.setAppUserModelId("net.pokerogue.offline");

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running - it will bring its window forward for us.
  app.exit(0);
} else {
  app.on("second-instance", () => focusWindow(gameWindow));
  app.whenReady().then(
    () =>
      start().catch((err: unknown) => {
        try {
          log?.error("start-up failed", { error: String(err) });
        } catch {
          console.error("PokeRogue could not start:", err);
        }
        showStartupError(DE.startup.generic);
        app.exit(1);
      }),
    (err: unknown) => {
      // Too early for the file logger; the console is all there is, and she must not read it.
      console.error("PokeRogue could not start:", err);
      showStartupError(DE.startup.generic);
      app.exit(1);
    },
  );
}

async function start(): Promise<void> {
  const userDataDir = app.getPath("userData");
  log = createFileLogger(join(userDataDir, "logs")).child("main");
  log.info("starting", { version: app.getVersion(), packaged: app.isPackaged, userDataDir });

  process.on("uncaughtException", (err) => log.error("unexpected problem", { error: String(err?.stack ?? err) }));
  process.on("unhandledRejection", (err) => log.error("unexpected problem", { error: String(err) }));

  settings = new SettingsStore(join(userDataDir, "settings.json"), app.getPath("documents"));

  const uiDir = join(__dirname, "..", "ui");
  installDialogs({
    uiDir,
    preloadFile: join(__dirname, "preload-ui.js"),
    log: log.child("dialogs"),
    settings,
    settingsPageData: () => settingsPageData(userDataDir),
  });

  runtime = loadRuntime(log);
  if (!runtime) {
    // Without the proxy and sync modules there is no game and no saving online: do not pretend.
    showStartupError(DE.startup.generic);
    app.exit(1);
    return;
  }

  // Connectivity first: the proxy needs it, and the update check asks it before looking anywhere.
  // A packaged build never gets the switch, so there is no way for her to end up stuck offline.
  const forceOfflineCheck = makeForceOfflineCheck({ isPackaged: app.isPackaged, userDataDir });
  if (forceOfflineCheck) log.info("development build: the force-offline switch is available", { file: FORCE_OFFLINE_FILE });
  connectivity = runtime.makeConnectivity(log.child("connectivity"), forceOfflineCheck);

  updater = new Updater({
    userDataDir,
    log: log.child("updater"),
    connectivity,
    installed: () => ({ gameTag: gameLocation?.tag ?? null, appVersion: app.getVersion() }),
    onUpdateAvailable: (update) => startAutoUpdate(update),
  });

  gameLocation = ensureGameFiles(
    { userDataDir, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged },
    log.child("game-files"),
  );
  if (!gameLocation && app.isPackaged) {
    showStartupError(DE.startup.missingFiles);
    app.exit(1);
    return;
  }

  if (runtime) {
    mirror = runtime.makeMirror(join(userDataDir, "mirror"), {
      // The account token is protected by Windows itself where that is possible (SECURITY.md).
      secret: createSecretCodec(log.child("secret")),
      log: log.child("mirror"),
    });
  }

  await forgetCachedGameFilesAfterUpdate(userDataDir);

  if (!(await startGameServer(userDataDir))) return;

  // Finding 12: apply the backup retention policy once per start (routine copies older than 30 days
  // are thinned to one per month; conflict and rejected copies are kept).
  void runtime
    ?.makeBackupManager({ documentsDir: app.getPath("documents"), userDataDir, log: log.child("backup") })
    .prune()
    .catch((err: unknown) => log.warn("could not tidy old backups", { error: String(err) }));

  scheduleSyncOnConnectivity();
  connectivity.start();

  gameWindow = createGameWindow({ userDataDir, log: log.child("window") });
  gameWindow.on("closed", () => {
    gameWindow = null;
  });

  createTray({
    uiDir,
    log: log.child("tray"),
    actions: {
      openSettings: () => openSettings(null),
      openBackupsFolder,
      showGame: () => focusWindow(gameWindow),
      quit: () => app.quit(),
    },
  });

  updater.start();

  // Waking from sleep on a plane, or landing: look at the network again straight away.
  powerMonitor.on("resume", () => {
    log.info("the computer woke up, checking the connection");
    void connectivity.probe();
  });
  lastOnline = safeIsOnline();
  const onlinePoll = setInterval(() => {
    const online = safeIsOnline();
    if (online && !lastOnline) {
      log.info("Windows reports a connection again, checking it");
      void connectivity.probe();
    }
    lastOnline = online;
  }, ONLINE_POLL_MS);
  onlinePoll.unref?.();

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", onBeforeQuit);
}

// -----------------------------------------------------------------------------
// The local game server
// -----------------------------------------------------------------------------

async function startGameServer(userDataDir: string): Promise<boolean> {
  try {
    if (!runtime || !mirror || !gameLocation) {
      // Nothing to serve: the game files are missing on a development build (a packaged build has
      // already shown DE.startup.missingFiles and exited).
      log.error("there are no game files to serve");
      showStartupError(DE.startup.missingFiles);
      app.exit(1);
      return false;
    }
    proxy = await runtime.startProxy({
      gameDir: gameLocation.dir,
      mirror,
      port: GAME_PORT,
      connectivity,
      log: log.child("proxy"),
      gameVersion: gameLocation.gameVersion,
      beforeSaveRead: () => syncBeforeGameLoadsSave(),
    });
    // The save online was written by a newer game than this build, so the game itself will
    // refuse to open her account (reports/milestone-1.md §3). Say so, once.
    proxy.events?.on("needs-game-update", (info) => {
      showGameUpdateNotice("her save was made with a newer game", info);
    });
    log.info("the game is being served", { port: GAME_PORT, dir: gameLocation.dir });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // We hold the single-instance lock, so this is not another copy of PokeRogue.
      log.error("port 47830 is already taken by another program");
      showStartupError(DE.startup.portInUse);
    } else {
      log.error("the game could not be started", { error: String(err) });
      showStartupError(DE.startup.generic);
    }
    app.exit(1);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Saving online
// -----------------------------------------------------------------------------

function scheduleSyncOnConnectivity(): void {
  connectivity.on("online", () => {
    log.info("we are online");
    if (syncKickoff) clearTimeout(syncKickoff);
    syncKickoff = setTimeout(() => void runSyncNow("just came online"), SYNC_AFTER_ONLINE_MS);
    if (!syncTimer) {
      syncTimer = setInterval(() => void runSyncNow("regular check"), SYNC_EVERY_MS);
      syncTimer.unref?.();
    }
    void updater?.maybeCheck("came online");
  });
  connectivity.on("offline", () => {
    log.info("we are offline - she can keep playing, everything is kept on this computer");
    if (syncKickoff) clearTimeout(syncKickoff);
    syncKickoff = null;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
  });
}

async function runSyncNow(reason: string): Promise<SyncResult | null> {
  if (!runtime || !mirror) return null; // nothing to save online yet
  if (connectivity.state !== "online") return null;
  if (!mirror.readAccount()) {
    // She has never logged in on this computer, so there is nothing of hers to save anywhere.
    log.debug("nothing to save online yet", { reason });
    return null;
  }
  if (syncInFlight) return syncInFlight;

  const userDataDir = app.getPath("userData");
  const deps = runtime;
  const theMirror = mirror;
  syncInFlight = (async (): Promise<SyncResult | null> => {
    try {
      log.info("saving progress online", { reason });
      const result = await deps.runSync({
        mirror: theMirror,
        backup: deps.makeBackupManager({
          documentsDir: app.getPath("documents"),
          userDataDir,
          log: log.child("backup"),
        }),
        api: deps.makeUpstreamApi({ token: theMirror.readAccount()?.token ?? null, log: log.child("upstream") }),
        policy: {
          mode: settings.get().conflictPolicy,
          ask: async (question) => (await onConflict(question)).keep,
        },
        log: log.child("sync"),
      });
      log.info("finished saving online", {
        pushed: result.pushed.length,
        pulled: result.pulled.length,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
      });
      afterSync(result);
      return result;
    } catch (err) {
      log.error("saving online did not work this time", { error: String(err) });
      return null;
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

/**
 * Waits for a sync while the game is loading its save and this computer has progress that is not
 * online yet. Bounded, so a missing answer never keeps the game on its loading screen for long;
 * the proxy then gives the game this computer's copy.
 */
async function syncBeforeGameLoadsSave(): Promise<void> {
  await Promise.race([
    runSyncNow("the game is loading its save"),
    new Promise((resolve) => setTimeout(resolve, 120_000)),
  ]);
}

/**
 * Online progress replaced a save on this computer. The game still holds the old one in memory and
 * in its own browser storage (which it prefers when that is newer), so its next save would undo the
 * sync. Its stored copies are first written to the backups folder, then removed, then the game
 * reloads and picks up the saves from the mirror.
 */
async function reloadGameWithBroughtOverSaves(pulled: string[]): Promise<void> {
  const win = gameWindow;
  const username = mirror?.readAccount()?.username;
  if (!win || win.isDestroyed() || !username) return;
  const keys = [`data_${username}`, `sessionData_${username}`, ...[1, 2, 3, 4].map((n) => `sessionData${n}_${username}`)];
  log.info("progress from online was brought over; reloading the game so it uses it", { pulled });
  try {
    const stored = (await win.webContents.executeJavaScript(
      `(() => { const keys = ${JSON.stringify(keys)}; const out = {}; for (const k of keys) { const v = localStorage.getItem(k); if (v !== null) out[k] = v; } return out; })()`,
    )) as Record<string, string>;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dir = join(currentBackupsDir(), `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
    mkdirSync(dir, { recursive: true });
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    for (const [key, value] of Object.entries(stored)) {
      // The game stores these exactly in the .prsv format, so they import like any other backup.
      writeFileSync(join(dir, `${time}-spielkopie-${key.replace(/[^\w-]/g, "_")}.prsv`), value, "utf8");
    }
    await win.webContents.executeJavaScript(`${JSON.stringify(Object.keys(stored))}.forEach((k) => localStorage.removeItem(k)); true`);
  } catch (err) {
    log.warn("could not clear the game's own copy before reloading", { error: String(err) });
  }
  if (!win.isDestroyed()) win.webContents.reload();
}

/** Clears Chromium's HTTP cache and the game's service-worker caches when the build changed. */
async function forgetCachedGameFilesAfterUpdate(userDataDir: string): Promise<void> {
  const marker = join(userDataDir, "served-build.txt");
  const current = `${gameLocation?.tag ?? "unknown"}|${app.getVersion()}`;
  let previous = "";
  try {
    previous = readFileSync(marker, "utf8").trim();
  } catch {
    /* first start */
  }
  if (previous === current) return;
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ["serviceworkers", "cachestorage"] });
    writeFileSync(marker, current, "utf8");
    log.info("new build: cleared cached game files", { previous: previous || null, current });
  } catch (err) {
    log.warn("could not clear cached game files", { error: String(err) });
  }
}

function afterSync(result: SyncResult): void {
  if (result.pulled.length > 0) {
    void reloadGameWithBroughtOverSaves(result.pulled);
  }
  // The engine says so outright now; nothing here matches on error strings any more.
  if (result.needsGameUpdate) {
    showGameUpdateNotice("the online service says the game is out of date");
  }
  // Something the online service refused: her progress was written to a file on this computer
  // instead, and she is told once per session that it is there.
  if ((result.unrecoverable?.length ?? 0) > 0 && !backupNoticeShown) {
    backupNoticeShown = true;
    void showBackupSavedNotice(gameWindow);
  }
}

/**
 * The one message about needing a newer version, from whichever of the three places noticed it:
 * the proxy seeing a save from a newer game, the sync engine being refused, or the release feed
 * having something newer. Shown at most once per app start — she can only do one thing about it.
 */
function showGameUpdateNotice(reason: string, detail?: Record<string, unknown>): void {
  if (gameUpdateNoticeShown || !updater) return;
  gameUpdateNoticeShown = true;
  log.warn("the game needs a newer version, looking for it now", { reason, ...detail });
  const u = updater;
  void (async () => {
    // Usually the new version is already published: then the update window takes over.
    if (u.updateFound) return;
    const found = await u.checkNow(reason);
    if (!found && !u.updateFound) void showNeedsGameUpdateNotice(gameWindow);
  })();
}

/**
 * A newer release exists: download it at once and show the update window with the progress.
 * She can keep playing. Once verified, the installer runs when PokeRogue closes (restart button
 * or closing the game), after the last save online.
 */
function startAutoUpdate(update: AvailableUpdate): void {
  const state: UpdateWindowState = { phase: "downloading", fraction: 0, sizeBytes: update.sizeBytes };
  log.info("downloading update", { release: update.releaseTag, bytes: update.sizeBytes });
  const win = openUpdateWindow(
    () => state,
    { restartNow: () => app.quit(), installOnClose: () => undefined },
    gameWindow,
  );
  const bar = (value: number) => {
    if (gameWindow && !gameWindow.isDestroyed()) gameWindow.setProgressBar(value);
  };
  updater
    ?.download(update, (fraction) => {
      state.fraction = fraction;
      bar(fraction);
    })
    .then(() => {
      state.phase = "ready";
      bar(-1);
      win.show();
    })
    .catch((err) => {
      log.warn("the update could not be downloaded", { error: String(err) });
      state.phase = "failed";
      bar(-1);
      win.show();
    });
}

async function onConflict(question: ConflictQuestion): Promise<ConflictAnswer> {
  const answer = await askConflict(question, gameWindow);
  if (answer.remember) {
    settings.update({
      conflictPolicy: answer.keep === "online" ? "prefer-online" : "prefer-this-computer",
      askedOnce: true,
    });
  } else {
    settings.update({ askedOnce: true });
  }
  return answer;
}

// -----------------------------------------------------------------------------
// Quitting: one last save, with a limit so she is never stuck
// -----------------------------------------------------------------------------

function onBeforeQuit(event: Electron.Event): void {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  void finishAndExit();
}

async function finishAndExit(): Promise<void> {
  let splashTimer: NodeJS.Timeout | null = null;
  try {
    if (runtime && mirror && connectivity.state === "online") {
      splashTimer = setTimeout(() => showSavingSplash(), QUIT_SPLASH_AFTER_MS);
      await Promise.race([
        runSyncNow("closing the game"),
        new Promise((resolve) => setTimeout(resolve, QUIT_SYNC_LIMIT_MS)),
      ]);
    }
  } catch (err) {
    log?.warn("the last save online did not finish", { error: String(err) });
  } finally {
    if (splashTimer) clearTimeout(splashTimer);
    hideSavingSplash();
  }
  try {
    // A verified new version waits: it installs now that the game is closed and starts it again.
    const installer = updater?.readyInstaller;
    if (installer) updater?.launchInstallerAfterExit(installer);
  } catch (err) {
    log?.warn("could not start the update installer", { error: String(err) });
  }
  try {
    updater?.stop();
    destroyTray();
    await Promise.race([proxy?.close() ?? Promise.resolve(), new Promise((r) => setTimeout(r, 2_000))]);
  } catch {
    /* on the way out anyway */
  }
  log?.info("closed");
  app.exit(0);
}

// -----------------------------------------------------------------------------
// Bits and pieces
// -----------------------------------------------------------------------------

/** Loads the proxy/sync modules. Without them there is no game server, so start-up fails. */
function loadRuntime(logger: Logger): RuntimeDeps | null {
  const file = join(__dirname, "wiring.js");
  if (!existsSync(file)) {
    logger.warn("running without saving online: the proxy and sync modules are not built yet");
    return null;
  }
  try {
    const requireFromHere = createRequire(__filename);
    const mod = requireFromHere("./wiring.js") as { loadRuntime: () => RuntimeDeps };
    return mod.loadRuntime();
  } catch (err) {
    logger.error("the proxy and sync modules could not be loaded", { error: String(err) });
    return null;
  }
}

function safeIsOnline(): boolean {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
}

/** Everything the settings page shows, in words. */
function settingsPageData(userDataDir: string): SettingsPageData {
  const s = settings.get();
  const peek = peekMirror(userDataDir);
  return {
    conflictPolicy: s.conflictPolicy,
    backupsDir: currentBackupsDir(),
    gameVersion: gameLocation?.tag ?? DE.settings.unknown,
    lastSavedOnline: peek.lastSyncAt ? formatRelative(peek.lastSyncAt) : DE.settings.notYet,
    playTime: formatPlayTime(peek.playTimeSeconds),
    text: DE.settings,
  };
}

/**
 * Read-only peek at the mirror for the settings page. Uses the Mirror object when there is one and
 * falls back to reading the two files directly, so the page also works before the mirror exists.
 */
function peekMirror(userDataDir: string): { playTimeSeconds: number | null; lastSyncAt: string | number | null } {
  // "Zuletzt online gespeichert" means it worked: failed or aborted attempts do not count.
  const dir = join(userDataDir, "mirror");
  let playTimeSeconds: number | null = null;
  try {
    const system = mirror ? mirror.snapshotLocal().system : readJsonSafe<{ local?: unknown }>(join(dir, "system.json"), {}).local;
    const stats = (system as { gameStats?: { playTime?: unknown } } | null | undefined)?.gameStats;
    if (typeof stats?.playTime === "number") playTimeSeconds = stats.playTime;
  } catch {
    /* nothing saved yet */
  }
  const state = mirror
    ? mirror.readState()
    : readJsonSafe<{ lastSuccessfulSyncAt?: string | null }>(join(dir, "state.json"), {});
  return { playTimeSeconds, lastSyncAt: state.lastSuccessfulSyncAt ?? null };
}
