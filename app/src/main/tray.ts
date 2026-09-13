// The only piece of our own interface that is always reachable: a small icon next to the clock.
// The game window itself stays completely untouched - no overlay, no gear button, no banner.

import { Menu, Tray, nativeImage } from "electron";
import { join } from "node:path";
import type { Logger } from "../common/log";
import { DE } from "./strings.de";

export interface TrayActions {
  openSettings(): void;
  openBackupsFolder(): void;
  showGame(): void;
  quit(): void;
}

export interface TrayOptions {
  uiDir: string;
  log: Logger;
  actions: TrayActions;
}

/** Kept at module level so the garbage collector does not make the icon disappear. */
let tray: Tray | null = null;

export function createTray(opts: TrayOptions): Tray | null {
  const iconFile = join(opts.uiDir, "assets", "tray.png");
  try {
    const image = nativeImage.createFromPath(iconFile);
    if (image.isEmpty()) {
      opts.log.warn("tray icon file could not be read", { iconFile });
      return null;
    }
    tray = new Tray(image);
    tray.setToolTip(DE.tray.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: DE.tray.settings, click: () => opts.actions.openSettings() },
        { label: DE.tray.backups, click: () => opts.actions.openBackupsFolder() },
        { type: "separator" },
        { label: DE.tray.quit, click: () => opts.actions.quit() },
      ]),
    );
    tray.on("double-click", () => opts.actions.showGame());
    return tray;
  } catch (err) {
    // A missing tray is annoying, never fatal: the game still runs.
    opts.log.warn("could not create the tray icon", { error: String(err) });
    return null;
  }
}

export function destroyTray(): void {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}
