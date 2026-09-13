// Every window and message box the user ever sees apart from the game itself.
// Rule for this file: no technical words. No "Sync", "Server", "Cache", "Token", "Mirror".
// If a sentence needs one of those, the sentence is wrong. Every word lives in strings.de.ts.

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import type { Logger } from "../common/log";
import type { ConflictAnswer, ConflictQuestion } from "./contracts";
import { formatPlayTime, formatRelative } from "./format";
import type { SettingsStore } from "./settings";
import { APP_NAME, DE } from "./strings.de";

export interface SettingsPageData {
  conflictPolicy: string;
  backupsDir: string;
  gameVersion: string;
  lastSavedOnline: string;
  playTime: string;
  /** The words the page prints, so the HTML file itself carries no German. */
  text: typeof DE.settings;
}

export interface DialogContext {
  /** Folder holding the built HTML pages (dist/ui). */
  uiDir: string;
  /** Bundled preload for our pages (dist/main/preload-ui.js). */
  preloadFile: string;
  log: Logger;
  settings: SettingsStore;
  /** Fresh values for the settings page, gathered when the page asks. */
  settingsPageData: () => SettingsPageData;
}

interface UiSession {
  /** A value, or a function asked every time the page wants fresh data (the update window polls). */
  data: unknown;
  onSubmit?: (value: unknown) => unknown;
  onClosed?: () => void;
  /** While true the window refuses to close - used by the question the user must answer. */
  mustAnswer?: boolean;
}

let ctx: DialogContext | null = null;
const sessions = new Map<number, UiSession>();

export function installDialogs(context: DialogContext): void {
  ctx = context;

  ipcMain.handle("ui:data", (event) => {
    const data = sessions.get(event.sender.id)?.data;
    return typeof data === "function" ? (data as () => unknown)() : (data ?? null);
  });

  ipcMain.handle("ui:submit", (event, value: unknown) => {
    const session = sessions.get(event.sender.id);
    if (!session) return null;
    return session.onSubmit ? session.onSubmit(value) : null;
  });

  ipcMain.handle("ui:open-backups", () => {
    openBackupsFolder();
  });

  ipcMain.handle("ui:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const session = sessions.get(event.sender.id);
    if (session) session.mustAnswer = false;
    win?.close();
  });
}

function need(): DialogContext {
  if (!ctx) throw new Error("installDialogs() was not called");
  return ctx;
}

interface OpenUiOptions {
  page: string;
  width: number;
  height: number;
  title: string;
  parent?: BrowserWindow | null;
  modal?: boolean;
  alwaysOnTop?: boolean;
  session: UiSession;
}

function openUi(opts: OpenUiOptions): BrowserWindow {
  const c = need();
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    title: opts.title,
    parent: opts.parent ?? undefined,
    modal: opts.modal ?? false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: opts.alwaysOnTop ?? false,
    show: false,
    backgroundColor: "#f7f7fa",
    autoHideMenuBar: true,
    icon: join(c.uiDir, "assets", "tray.png"),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: c.preloadFile,
    },
  });
  win.removeMenu();
  sessions.set(win.webContents.id, opts.session);
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("close", (event) => {
    const s = sessions.get(win.webContents.id);
    if (s?.mustAnswer) {
      event.preventDefault(); // the user has to pick one; there is no safe silent default
      win.focus();
    }
  });
  win.on("closed", () => {
    const s = sessions.get(win.webContents.id);
    sessions.delete(win.webContents.id);
    s?.onClosed?.();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void win.loadFile(join(c.uiDir, opts.page));
  return win;
}

// ---------------------------------------------------------------------------
// The one question we ever ask about saves
// ---------------------------------------------------------------------------

export interface ConflictCard {
  playTime: string;
  lastPlayed: string;
  /** Null for the system save, where "run" means nothing - the page hides the row. */
  run: string | null;
}

export interface ConflictPageData {
  here: ConflictCard;
  online: ConflictCard;
  /** The words the page prints, so the HTML file itself carries no German. */
  text: typeof DE.conflict;
}

export function describeConflict(q: ConflictQuestion, now = Date.now()): ConflictPageData {
  const t = DE.conflict;
  const card = (s: ConflictQuestion["thisComputer"]): ConflictCard => {
    if (!s) {
      return {
        playTime: t.nothingSaved,
        lastPlayed: DE.format.nothing,
        run: q.kind === "session" ? t.noRun : null,
      };
    }
    return {
      playTime: formatPlayTime(s.playTime),
      lastPlayed: formatRelative(s.timestamp, now),
      run:
        q.kind !== "session"
          ? null
          : typeof s.waveIndex === "number" && s.waveIndex > 0
            ? t.runInProgress(s.waveIndex)
            : t.noRun,
    };
  };
  return { here: card(q.thisComputer), online: card(q.online), text: t };
}

/**
 * Asks which save to keep. Rejects if the window is torn down (app quitting): the caller must
 * then change nothing and leave both sides as they are.
 */
export function askConflict(q: ConflictQuestion, parent?: BrowserWindow | null): Promise<ConflictAnswer> {
  const c = need();
  return new Promise<ConflictAnswer>((resolve, reject) => {
    let answered = false;
    const session: UiSession = {
      data: describeConflict(q),
      mustAnswer: true,
      onSubmit: (value) => {
        const v = (value ?? {}) as { keep?: unknown; remember?: unknown };
        const keep: ConflictAnswer["keep"] = v.keep === "online" ? "online" : "this-computer";
        const remember = v.remember === true;
        answered = true;
        session.mustAnswer = false;
        c.log.info("the user chose which progress to keep", { keep, remember });
        resolve({ keep, remember });
        setTimeout(() => {
          if (!win.isDestroyed()) win.close();
        }, 0);
        return { ok: true };
      },
      onClosed: () => {
        if (!answered) reject(new Error("the question window was closed without an answer"));
      },
    };
    const win = openUi({
      page: "conflict.html",
      width: 680,
      height: 580,
      title: DE.titles.conflict,
      parent,
      modal: Boolean(parent),
      alwaysOnTop: true,
      session,
    });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let settingsWindow: BrowserWindow | null = null;

export function openSettings(parent?: BrowserWindow | null): BrowserWindow {
  const c = need();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  const session: UiSession = {
    get data() {
      return c.settingsPageData();
    },
    onSubmit: (value) => {
      const v = (value ?? {}) as { conflictPolicy?: unknown };
      const patch: Parameters<SettingsStore["update"]>[0] = {};
      if (
        v.conflictPolicy === "ask" ||
        v.conflictPolicy === "prefer-this-computer" ||
        v.conflictPolicy === "prefer-online"
      ) {
        patch.conflictPolicy = v.conflictPolicy;
        patch.askedOnce = v.conflictPolicy !== "ask";
      }
      c.settings.update(patch);
      c.log.info("settings changed", { ...patch });
      return c.settingsPageData();
    },
    onClosed: () => {
      settingsWindow = null;
    },
  };
  settingsWindow = openUi({
    page: "settings.html",
    width: 560,
    height: 620,
    title: DE.titles.settings,
    parent,
    modal: false,
    session,
  });
  return settingsWindow;
}

export function openBackupsFolder(): void {
  const c = need();
  const dir = c.settings.get().backupsDir;
  void shell.openPath(dir).then(
    (err) => {
      if (err) c.log.warn("could not open the backups folder", { dir, error: err });
    },
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// Message boxes
// ---------------------------------------------------------------------------

/** Shown when we could not put the progress online and had to keep a copy instead. */
export async function showBackupSavedNotice(parent?: BrowserWindow | null): Promise<void> {
  const result = await showBox(parent, {
    type: "info",
    title: APP_NAME,
    message: DE.backupSaved.message,
    detail: DE.backupSaved.detail,
    buttons: [DE.backupSaved.openFolder, DE.backupSaved.ok],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) openBackupsFolder();
}

/**
 * The game (or the online service) says the account needs a newer build than the one on this
 * computer. Shown at most once per app start — the caller owns that flag — because there is exactly
 * one thing the user can do about it and repeating it would only worry the user.
 */
export async function showNeedsGameUpdateNotice(parent?: BrowserWindow | null): Promise<void> {
  await showBox(parent, {
    type: "info",
    title: APP_NAME,
    message: DE.needsGameUpdate.message,
    detail: DE.needsGameUpdate.detail,
    buttons: [DE.needsGameUpdate.ok],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

// ---------------------------------------------------------------------------
// The update window
// ---------------------------------------------------------------------------

export type UpdatePhase = "downloading" | "ready" | "failed";

export interface UpdateWindowState {
  phase: UpdatePhase;
  fraction: number;
  sizeBytes: number;
}

export interface UpdateWindowHandle {
  /** Brings the window back (or opens it again) to show the current phase. */
  show(): void;
  close(): void;
}

/**
 * Small window for the automatic update. Reads the live state on every poll, so the caller only
 * changes the state object. Buttons: while downloading, hide the window (the download goes on);
 * when ready, restart now or on close; when failed, OK.
 */
export function openUpdateWindow(
  state: () => UpdateWindowState,
  actions: { restartNow: () => void; installOnClose: () => void },
  parent?: BrowserWindow | null,
): UpdateWindowHandle {
  let win: BrowserWindow | null = null;
  const t = DE.update;
  const data = () => {
    const s = state();
    const mb = Math.max(1, Math.round(s.sizeBytes / (1024 * 1024)));
    switch (s.phase) {
      case "downloading":
        return { phase: s.phase, text: t.downloading, fraction: s.fraction, progressText: t.progress(Math.floor(s.fraction * 100), mb), secondary: null, primary: t.hide };
      case "ready":
        return { phase: s.phase, text: t.ready, secondary: t.later, primary: t.restartNow };
      default:
        return { phase: s.phase, text: t.failed, secondary: null, primary: t.ok };
    }
  };
  const onSubmit = (value: unknown) => {
    const { phase, button } = (value ?? {}) as { phase?: string; button?: string };
    if (phase === "ready" && button === "primary") actions.restartNow();
    else if (phase === "ready" && button === "secondary") actions.installOnClose();
    win?.close();
    return null;
  };
  const open = () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = openUi({
      page: "update.html",
      width: 440,
      height: 210,
      title: t.title,
      parent: parent ?? null,
      alwaysOnTop: true,
      session: { data, onSubmit, onClosed: () => (win = null) },
    });
  };
  open();
  return {
    show: open,
    close: () => {
      if (win && !win.isDestroyed()) win.close();
    },
  };
}

/** One message, then the app closes. Used when we truly cannot start. */
export function showStartupError(detail: string): void {
  dialog.showMessageBoxSync({
    type: "error",
    title: APP_NAME,
    message: DE.startup.message,
    detail,
    buttons: [DE.startup.close],
    noLink: true,
  });
}

async function showBox(
  parent: BrowserWindow | null | undefined,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  if (parent && !parent.isDestroyed()) return dialog.showMessageBox(parent, options);
  return dialog.showMessageBox(options);
}

// ---------------------------------------------------------------------------
// "Saving your progress online..." splash while the user waits at quit
// ---------------------------------------------------------------------------

let splash: BrowserWindow | null = null;

export function showSavingSplash(): void {
  const c = need();
  if (splash && !splash.isDestroyed()) return;
  splash = new BrowserWindow({
    width: 380,
    height: 150,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#1b1b1f",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.removeMenu();
  splash.once("ready-to-show", () => splash?.show());
  // The splash has no preload (it asks nothing and answers nothing), so its one sentence travels
  // in the query string and splash.js prints it. That keeps every German word in strings.de.ts.
  void splash.loadFile(join(c.uiDir, "splash.html"), {
    search: new URLSearchParams({ text: DE.splash }).toString(),
  });
}

export function hideSavingSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}
