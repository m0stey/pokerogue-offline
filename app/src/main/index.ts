// PokeRogue Offline - Electron main process (DESIGN.md §3.10).
//
// Start-up order matters and is:
//   1. one instance only (a second launch just brings the first window forward)
//   2. userData -> %APPDATA%\PokeRogue Offline, so logs and saves are never next to the exe
//   3. file logger (nothing above this point can be logged to a file)
//   4. put a downloaded game update in place - must happen before anything opens those files
//   5. find the game files
//   6. start the local game server on 47830 (see PORT handling below)
//   7. ask whether we are online, open the window, and only then start saving online
//
// Nothing in here ever asks the user a question she did not cause, except the one conflict
// question and the mobile-connection question.

import { BrowserWindow, app, net, powerMonitor } from "electron";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../common/log";
import {
  GAME_PORT,
  NEEDS_GAME_UPDATE,
  UNKNOWN_REJECTION,
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
  askMeteredDownload,
  hideSavingSplash,
  installDialogs,
  openBackupsFolder,
  openSettings,
  showBackupSavedNotice,
  showSavingSplash,
  showStartupError,
  type SettingsPageData,
} from "./dialogs";
import { FallbackConnectivity, startFallbackServer } from "./fallback-server";
import { ensureGameFiles, type GameLocation } from "./game-files";
import { formatPlayTime, formatRelative } from "./format";
import { createFileLogger } from "./logger";
import { SettingsStore, readJsonSafe } from "./settings";
import { createTray, destroyTray } from "./tray";
import { Updater } from "./updater";
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
    () => void start(),
    (err: unknown) => {
      showStartupError(String(err));
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

  // Connectivity first: the proxy needs it, and the updater asks it before any download.
  connectivity = runtime
    ? runtime.makeConnectivity(log.child("connectivity"))
    : new FallbackConnectivity(log.child("connectivity"));

  updater = new Updater({
    userDataDir,
    log: log.child("updater"),
    settings,
    connectivity,
    installedTag: () => gameLocation?.tag ?? null,
    askMetered: (sizeText) => askMeteredDownload(sizeText, gameWindow),
  });

  // A finished download is swapped in here, while nothing has the files open yet.
  updater.applyPendingUpdate();

  gameLocation = ensureGameFiles(
    { userDataDir, resourcesPath: process.resourcesPath, isPackaged: app.isPackaged },
    log.child("game-files"),
  );
  if (!gameLocation && app.isPackaged) {
    showStartupError(
      "The game files are missing. Please install PokeRogue again - your saved progress will not be affected.",
    );
    app.exit(1);
    return;
  }

  if (runtime) mirror = runtime.makeMirror(join(userDataDir, "mirror"));

  if (!(await startGameServer(userDataDir))) return;

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

  updater.cleanupPreviousVersion();
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
    if (runtime && mirror && gameLocation) {
      proxy = await runtime.startProxy({
        gameDir: gameLocation.dir,
        mirror,
        port: GAME_PORT,
        connectivity,
        log: log.child("proxy"),
      });
    } else {
      proxy = await startFallbackServer({
        gameDir: gameLocation?.dir ?? null,
        port: GAME_PORT,
        log: log.child("proxy"),
      });
    }
    log.info("the game is being served", { port: GAME_PORT, dir: gameLocation?.dir ?? "(placeholder)" });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // We hold the single-instance lock, so this is not another copy of PokeRogue.
      log.error("port 47830 is already taken by another program");
      showStartupError(
        "Another program on this computer is already using something PokeRogue needs. Please restart the computer and start PokeRogue again.",
      );
    } else {
      log.error("the game could not be started", { error: String(err) });
      showStartupError("Something went wrong while starting the game. Please restart the computer and try again.");
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
  if (!runtime || !mirror) return null; // stand-in server: nothing to save online yet
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

function afterSync(result: SyncResult): void {
  if (result.errors.some((e) => e.includes(NEEDS_GAME_UPDATE))) {
    void updater?.checkNow("the game needs to be newer");
  }
  // Something the server refused for a reason we do not understand: her progress was written to a
  // backup file instead, and she is told once per session where it is.
  const unrecoverable = result.errors.some((e) => e.includes(UNKNOWN_REJECTION));
  if (unrecoverable && !backupNoticeShown) {
    backupNoticeShown = true;
    void showBackupSavedNotice(gameWindow);
  }
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
    updater?.noteSessionCompleted();
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

/** Loads the real proxy/sync modules if they have been built; otherwise we run stand-in mode. */
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
    allowMeteredDownloads: s.allowMeteredDownloads,
    backupsDir: s.backupsDir,
    gameVersion: gameLocation?.tag ?? "unknown",
    lastSavedOnline: peek.lastSyncAt ? formatRelative(peek.lastSyncAt) : "not yet",
    playTime: formatPlayTime(peek.playTimeSeconds),
  };
}

/**
 * Read-only peek at the mirror for the settings page. Uses the Mirror object when there is one and
 * falls back to reading the two files directly, so the page also works in stand-in mode.
 */
function peekMirror(userDataDir: string): { playTimeSeconds: number | null; lastSyncAt: string | number | null } {
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
    : readJsonSafe<{ lastSyncAt?: string | number | null }>(join(dir, "state.json"), {});
  return { playTimeSeconds, lastSyncAt: state.lastSyncAt ?? null };
}
