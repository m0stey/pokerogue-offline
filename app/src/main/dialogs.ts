// Every window and message box the user ever sees apart from the game itself.
// Rule for this file: no technical words. No "sync", "server", "API", "JSON", "conflict",
// "merge", "token". If a sentence needs one of those, the sentence is wrong.

import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import type { Logger } from "../common/log";
import type { ConflictAnswer, ConflictQuestion } from "./contracts";
import { formatPlayTime, formatRelative } from "./format";
import type { MeteredPolicy, SettingsStore } from "./settings";

export interface SettingsPageData {
  conflictPolicy: string;
  allowMeteredDownloads: MeteredPolicy;
  backupsDir: string;
  gameVersion: string;
  lastSavedOnline: string;
  playTime: string;
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

  ipcMain.handle("ui:data", (event) => sessions.get(event.sender.id)?.data ?? null);

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
}

export function describeConflict(q: ConflictQuestion, now = Date.now()): ConflictPageData {
  const card = (s: ConflictQuestion["thisComputer"]): ConflictCard => {
    if (!s) return { playTime: "nothing saved", lastPlayed: "—", run: q.kind === "session" ? "No run" : null };
    return {
      playTime: formatPlayTime(s.playTime),
      lastPlayed: formatRelative(s.timestamp, now),
      run:
        q.kind !== "session"
          ? null
          : typeof s.waveIndex === "number" && s.waveIndex > 0
            ? `Run in progress: wave ${s.waveIndex}`
            : "No run",
    };
  };
  return { here: card(q.thisComputer), online: card(q.online) };
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
      title: "Which progress should we keep?",
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
      const v = (value ?? {}) as { conflictPolicy?: unknown; allowMeteredDownloads?: unknown };
      const patch: Parameters<SettingsStore["update"]>[0] = {};
      if (
        v.conflictPolicy === "ask" ||
        v.conflictPolicy === "prefer-this-computer" ||
        v.conflictPolicy === "prefer-online"
      ) {
        patch.conflictPolicy = v.conflictPolicy;
        patch.askedOnce = v.conflictPolicy !== "ask";
      }
      if (
        v.allowMeteredDownloads === "ask" ||
        v.allowMeteredDownloads === "always" ||
        v.allowMeteredDownloads === "never"
      ) {
        patch.allowMeteredDownloads = v.allowMeteredDownloads;
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
    height: 720,
    title: "PokeRogue Settings",
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

export interface MeteredAnswer {
  download: boolean;
  remember: boolean;
}

/** Asked before a big download when Windows says this is a mobile connection. */
export async function askMeteredDownload(sizeText: string, parent?: BrowserWindow | null): Promise<MeteredAnswer> {
  const result = await showBox(parent, {
    type: "question",
    title: "PokeRogue",
    message: "You seem to be on a mobile connection.",
    detail: `Download the game update now (${sizeText}), or wait for Wi-Fi?`,
    buttons: ["Download now", "Wait for Wi-Fi"],
    defaultId: 1,
    cancelId: 1,
    checkboxLabel: "Always do this, do not ask again",
    checkboxChecked: false,
    noLink: true,
  });
  return { download: result.response === 0, remember: result.checkboxChecked };
}

/** Shown when we could not put the progress online and had to keep a copy instead. */
export async function showBackupSavedNotice(parent?: BrowserWindow | null): Promise<void> {
  const result = await showBox(parent, {
    type: "info",
    title: "PokeRogue",
    message: "Your progress is safe.",
    detail:
      "We could not put this progress on the PokeRogue website just now, so we saved a copy of it on this computer. You can keep playing - we will try again later.",
    buttons: ["Open backups folder", "OK"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) openBackupsFolder();
}

/** One message, then the app closes. Used when we truly cannot start. */
export function showStartupError(detail: string): void {
  dialog.showMessageBoxSync({
    type: "error",
    title: "PokeRogue",
    message: "PokeRogue could not start.",
    detail,
    buttons: ["Close"],
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
  void splash.loadFile(join(c.uiDir, "splash.html"));
}

export function hideSavingSplash(): void {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
}
