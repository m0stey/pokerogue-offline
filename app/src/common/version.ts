// Game version comparison, with the *server's* semantics.
//
// It lives in src/common because two very different places need it and neither should import the
// other: `src/sync` reasons about it when deciding whether a save can be pushed, and `src/proxy`
// needs it to spot the case in reports/milestone-1.md §3 — a system save stamped by a newer client
// than the build we serve, which makes the game refuse to load the account at all
// (upstream/pokerogue/src/system/game-data.ts:437, "Your game version is out of date").

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Compare two `x.y.z[.w]` version strings the way the server does
 * (upstream/rogueserver/api/savedata/utils.go): split on `.`, 3 or 4 numeric components, trailing
 * zeros trimmed, compared component-wise. Returns -1/0/1, or `null` if either is unparseable.
 */
export function compareGameVersion(a: string, b: string): number | null {
  const parse = (s: string): number[] | null => {
    if (typeof s !== "string") {
      return null;
    }
    const parts = s.split(".");
    if (parts.length < 3 || parts.length > 4) {
      return null;
    }
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) {
        return null;
      }
      nums.push(Number(p));
    }
    while (nums.length > 0 && nums[nums.length - 1] === 0) {
      nums.pop();
    }
    return nums;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) {
    return null;
  }
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    if (xi !== yi) {
      return xi > yi ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Would the client built at `servedVersion` refuse to load a system save stamped `saveVersion`?
 *
 * The client's rule is `compareVersions(systemData.gameVersion, version) === 1` — strictly newer,
 * so an equal or older save is fine. A version we cannot parse is never treated as a refusal:
 * guessing here would produce a dialog for no reason.
 */
export function saveIsNewerThanBuild(saveVersion: string | null | undefined, servedVersion: string | null | undefined): boolean {
  if (typeof saveVersion !== "string" || typeof servedVersion !== "string") {
    return false;
  }
  return compareGameVersion(saveVersion, servedVersion) === 1;
}

export interface GameVersionFile {
  /** Release tag, e.g. `v1.12.0.11`. What the update check compares. */
  tag: string | null;
  /** The version the *client* stamps into saves, e.g. `1.12.0.11`. What the save carries. */
  gameVersion: string | null;
}

/**
 * Read `<gameDir>/version.json`, emitted by game-build next to `index.html`.
 * Missing, unreadable or malformed reads as "we do not know", never as an error.
 */
export function readGameVersionFile(gameDir: string): GameVersionFile {
  try {
    const raw = JSON.parse(readFileSync(join(gameDir, "version.json"), "utf8")) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    return { tag: str(raw["tag"]), gameVersion: str(raw["gameVersion"]) };
  } catch {
    return { tag: null, gameVersion: null };
  }
}
