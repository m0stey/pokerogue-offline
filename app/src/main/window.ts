// The one window the game runs in. It stays deliberately plain: no menu bar, no toolbar, no
// buttons of ours anywhere near the game. Everything we add lives in the tray icon instead.

import { BrowserWindow, app, screen, shell } from "electron";
import { join } from "node:path";
import type { Logger } from "../common/log";
import { GAME_ORIGIN } from "./contracts";
import { readJsonSafe, writeJsonAtomic } from "./settings";

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullScreen: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1280, height: 800, maximized: false, fullScreen: false };

/** pokerogue.net and its subdomains are the only links we hand to the real browser. */
export function isPokerogueLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return u.hostname === "pokerogue.net" || u.hostname.endsWith(".pokerogue.net");
  } catch {
    return false;
  }
}

function isOurOrigin(url: string): boolean {
  return url.startsWith(`${GAME_ORIGIN}/`) || url === GAME_ORIGIN;
}

function restoreState(file: string): WindowState {
  const s = readJsonSafe<Partial<WindowState>>(file, {});
  const state: WindowState = {
    width: typeof s.width === "number" && s.width >= 640 ? Math.round(s.width) : DEFAULT_STATE.width,
    height: typeof s.height === "number" && s.height >= 480 ? Math.round(s.height) : DEFAULT_STATE.height,
    maximized: s.maximized === true,
    fullScreen: s.fullScreen === true,
    x: typeof s.x === "number" ? Math.round(s.x) : undefined,
    y: typeof s.y === "number" ? Math.round(s.y) : undefined,
  };
  // If the laptop was on a second screen last time, do not open off-screen.
  if (state.x !== undefined && state.y !== undefined) {
    const area = screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height })
      .workArea;
    const visible = state.x < area.x + area.width && state.x + state.width > area.x &&
      state.y < area.y + area.height && state.y + state.height > area.y;
    if (!visible) {
      delete state.x;
      delete state.y;
    }
  }
  return state;
}

export interface GameWindowOptions {
  userDataDir: string;
  log: Logger;
  /** Where to load from; defaults to the local game server. */
  url?: string;
}

export function createGameWindow(opts: GameWindowOptions): BrowserWindow {
  const stateFile = join(opts.userDataDir, "window.json");
  const state = restoreState(stateFile);

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: "#1b1b1f",
    title: "PokeRogue",
    autoHideMenuBar: true,
    icon: join(__dirname, "..", "ui", "assets", "tray.png"),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.removeMenu();

  if (state.fullScreen) win.setFullScreen(true);
  else if (state.maximized) win.maximize();

  win.once("ready-to-show", () => win.show());

  // --- remember where she likes the window -----------------------------------
  let saveTimer: NodeJS.Timeout | null = null;
  const saveState = () => {
    try {
      const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
      writeJsonAtomic(stateFile, {
        ...bounds,
        maximized: win.isMaximized(),
        fullScreen: win.isFullScreen(),
      } satisfies WindowState);
    } catch (err) {
      opts.log.warn("could not remember the window size", { error: String(err) });
    }
  };
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 500);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) {
    win.on(ev as "resize", scheduleSave);
  }
  win.on("close", () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveState();
  });

  // --- F11 toggles fullscreen (and Escape leaves it) -------------------------
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F11") {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    } else if (input.key === "Escape" && win.isFullScreen()) {
      event.preventDefault();
      win.setFullScreen(false);
    } else if (!app.isPackaged && input.key === "F12") {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // --- nothing navigates away from the game ----------------------------------
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isPokerogueLink(url)) void shell.openExternal(url);
    else opts.log.info("blocked a pop-up", { url });
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isOurOrigin(url)) return;
    event.preventDefault();
    if (isPokerogueLink(url)) void shell.openExternal(url);
    else opts.log.info("blocked a page change", { url });
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (!isOurOrigin(url)) {
      event.preventDefault();
      opts.log.info("blocked a redirect", { url });
    }
  });

  // --- the game needs no device permissions ----------------------------------
  const session = win.webContents.session;
  session.setPermissionRequestHandler((_wc, permission, callback) => {
    opts.log.info("denied a permission request", { permission });
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);

  win.webContents.on("render-process-gone", (_e, details) => {
    opts.log.error("the game stopped unexpectedly, reloading", { reason: details.reason });
    if (!win.isDestroyed()) win.reload();
  });
  win.webContents.on("did-fail-load", (_e, code, description, url) => {
    if (code === -3) return; // aborted, normal during navigation
    opts.log.warn("the game page did not load", { code, description, url });
  });

  void win.loadURL(opts.url ?? `${GAME_ORIGIN}/`);
  return win;
}

/** Bring the existing window back to the front (second launch, or tray click). */
export function focusWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
