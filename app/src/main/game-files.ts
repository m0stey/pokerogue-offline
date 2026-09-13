// Where the game's static files live, and which version they are.
//
// Search order:
//   1. `<userData>/game/current/`      — installed or updated by the updater (wins, it is newest)
//   2. `<resourcesPath>/game/`         — the copy that shipped inside the installer
//   3. `C:\dev\pokerogue-offline\game-build\dist\game` — development only (`!app.isPackaged`)

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../common/log";
import { readGameVersionFile } from "../common/version";

// Forward slashes on purpose: Node accepts them on Windows and they survive every tool that
// touches this file (a doubled backslash in a literal is easy to lose).
export const DEV_GAME_DIR = "C:/dev/pokerogue-offline/game-build/dist/game";

export type GameSource = "installed" | "bundled" | "dev";

export interface GameLocation {
  dir: string;
  source: GameSource;
  /** Tag from `version.json`, e.g. `v1.12.0.11`. Null when the build has no version file. */
  tag: string | null;
  /**
   * `gameVersion` from `version.json`, e.g. `1.12.0.11` — the version this build stamps into saves
   * and the one a save's own `gameVersion` has to be compared against.
   */
  gameVersion: string | null;
}

export interface GamePaths {
  /** `<userData>/game` */
  root: string;
  /** `<userData>/game/current` — what we serve, when a newer build has been put there by hand. */
  current: string;
}

export interface LocateOptions {
  userDataDir: string;
  resourcesPath: string;
  isPackaged: boolean;
  /** Override for tests. */
  devGameDir?: string;
}

export function gamePaths(userDataDir: string): GamePaths {
  const root = join(userDataDir, "game");
  return { root, current: join(root, "current") };
}

/** A directory only counts as a game build if it actually has an index.html to serve. */
export function looksLikeGameDir(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}

export function locateGameDir(opts: LocateOptions): GameLocation | null {
  // Only the copy that shipped with the installer. Updates replace the whole program folder, so
  // a game folder anywhere else would never be updated and would make the updater compare against
  // the wrong version (a reinstall on every start, or app updates blocked for good).
  const candidates: Array<{ dir: string; source: GameSource }> = [
    { dir: join(opts.resourcesPath, "game"), source: "bundled" },
  ];
  if (!opts.isPackaged) candidates.push({ dir: opts.devGameDir ?? DEV_GAME_DIR, source: "dev" });

  for (const c of candidates) {
    if (looksLikeGameDir(c.dir)) {
      const version = readGameVersionFile(c.dir);
      return { dir: c.dir, source: c.source, tag: version.tag, gameVersion: version.gameVersion };
    }
  }
  return null;
}

/**
 * Make sure there is something to serve, and say where it is — or null, which the caller turns
 * into one plain-language message.
 *
 * Game updates arrive as a whole new installer (updater.ts), so the bundled copy in the program
 * folder is the only one ever served. `<userData>/game/current` is deliberately ignored.
 */
export function ensureGameFiles(opts: LocateOptions, log: Logger): GameLocation | null {
  const paths = gamePaths(opts.userDataDir);
  try {
    mkdirSync(paths.root, { recursive: true });
  } catch (err) {
    log.warn("could not create game folder", { dir: paths.root, error: String(err) });
  }

  const found = locateGameDir(opts);
  if (found) {
    log.info("serving game files", {
      dir: found.dir,
      source: found.source,
      tag: found.tag ?? "unknown",
      gameVersion: found.gameVersion ?? "unknown",
    });
  } else {
    log.error("no game files found", { tried: [join(opts.resourcesPath, "game"), DEV_GAME_DIR] });
  }
  return found;
}
