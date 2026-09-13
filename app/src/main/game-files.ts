// Where the game's static files live, and which version they are.
//
// Search order:
//   1. `<userData>/game/current/`      — installed or updated by the updater (wins, it is newest)
//   2. `<resourcesPath>/game/`         — the copy that shipped inside the installer
//   3. `C:\dev\pokerogue-offline\game-build\dist\game` — development only (`!app.isPackaged`)

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../common/log";

// Forward slashes on purpose: Node accepts them on Windows and they survive every tool that
// touches this file (a doubled backslash in a literal is easy to lose).
export const DEV_GAME_DIR = "C:/dev/pokerogue-offline/game-build/dist/game";

export type GameSource = "installed" | "bundled" | "dev";

export interface GameLocation {
  dir: string;
  source: GameSource;
  /** Tag from `version.json`, e.g. `v1.12.0.11`. Null when the build has no version file. */
  tag: string | null;
}

export interface GamePaths {
  /** `<userData>/game` */
  root: string;
  /** `<userData>/game/current` — what we serve. */
  current: string;
  /** `<userData>/game/previous` — kept until the new build has served one full session. */
  previous: string;
  /** `<userData>/game/staging` — downloads and unpacked candidates. */
  staging: string;
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
  return { root, current: join(root, "current"), previous: join(root, "previous"), staging: join(root, "staging") };
}

/** A directory only counts as a game build if it actually has an index.html to serve. */
export function looksLikeGameDir(dir: string): boolean {
  return existsSync(join(dir, "index.html"));
}

export function readVersionTag(dir: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "version.json"), "utf8")) as { tag?: unknown };
    return typeof raw.tag === "string" && raw.tag.trim() ? raw.tag.trim() : null;
  } catch {
    return null;
  }
}

export function locateGameDir(opts: LocateOptions): GameLocation | null {
  const paths = gamePaths(opts.userDataDir);
  const candidates: Array<{ dir: string; source: GameSource }> = [
    { dir: paths.current, source: "installed" },
    { dir: join(opts.resourcesPath, "game"), source: "bundled" },
  ];
  if (!opts.isPackaged) candidates.push({ dir: opts.devGameDir ?? DEV_GAME_DIR, source: "dev" });

  for (const c of candidates) {
    if (looksLikeGameDir(c.dir)) return { dir: c.dir, source: c.source, tag: readVersionTag(c.dir) };
  }
  return null;
}

/**
 * Make sure there is something to serve. Creates the `game/` folders, repairs a half-finished
 * update swap (current missing but previous present), and returns where the game is — or null,
 * which the caller turns into one plain-language message.
 */
export function ensureGameFiles(opts: LocateOptions, log: Logger): GameLocation | null {
  const paths = gamePaths(opts.userDataDir);
  for (const dir of [paths.root, paths.staging]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.warn("could not create game folder", { dir, error: String(err) });
    }
  }

  // A crash in the middle of the swap can leave `current` gone and `previous` intact.
  if (!looksLikeGameDir(paths.current) && looksLikeGameDir(paths.previous)) {
    try {
      renameSync(paths.previous, paths.current);
      log.warn("restored the previous game files after an interrupted update");
    } catch (err) {
      log.error("could not restore the previous game files", { error: String(err) });
    }
  }

  const found = locateGameDir(opts);
  if (found) log.info("serving game files", { dir: found.dir, source: found.source, tag: found.tag ?? "unknown" });
  else log.error("no game files found", { tried: [paths.current, join(opts.resourcesPath, "game"), DEV_GAME_DIR] });
  return found;
}
