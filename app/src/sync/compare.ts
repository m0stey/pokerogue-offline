// DESIGN.md §3.6 — structural comparison with normalisation, and the descendant test that lets
// the engine fast-forward instead of asking the user.
//
// Why not JSON.stringify: the server re-serialises through Go maps and structs, so key order
// changes (`gameStats` comes back alphabetised), empty arrays come back as `null`, and a couple of
// legacy fields are added as `null`. All of that is semantically identical data.

import type { SessionSave, SystemSave } from "./types";

/**
 * Fields the server silently drops from a session save, confirmed live
 * (reports/live-api.md §3.17 and upstream/rogueserver/defs/savedata.go).
 *
 * - `playerFaints` exists in the client's `SessionSaveData` but not in the server's Go struct, so
 *   it is discarded at ingest — always.
 * - `dailyConfig` and `name` are `omitempty` on the server and vanish when zero-valued/empty.
 *
 * Any *other* field the server does not know is dropped too; we cannot enumerate those, so a
 * read-back comparison after a session push can legitimately fail on a future client release.
 * That fails safe (the engine reports an error and keeps the save dirty); see NOTES-sync.md.
 */
export const KNOWN_LOSSY_SESSION_FIELDS: readonly string[] = ["playerFaints", "dailyConfig", "name"];

/**
 * `gameStats` counters that only ever go up. Used as an extra descendant guard so we never
 * fast-forward onto a save that has *lost* recorded progress.
 */
export const MONOTONE_GAME_STATS: readonly string[] = [
  "playTime",
  "battles",
  "classicSessionsPlayed",
  "sessionsWon",
  "highestEndlessWave",
  "highestLevel",
  "pokemonSeen",
  "pokemonDefeated",
  "pokemonCaught",
  "pokemonHatched",
  "eggsPulled",
  "eggHatchCount",
];

export interface CompareOptions {
  /**
   * Dot-separated paths to ignore on both sides, e.g. `"playerFaints"` or
   * `"mysteryEncounterSaveData.queuedEncounters"`.
   */
  ignorePaths?: readonly string[];
}

/**
 * `null`, `undefined` (i.e. an absent key) and `[]` all mean "nothing here".
 *
 * The server turns every empty array into `null` on a session round trip and adds
 * `starterMoveData: null` / `starterEggMoveData: null` to system saves that never had those keys,
 * so treating the three as one value is what makes a round-trip comparison meaningful at all.
 */
function isEmptyish(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

/**
 * Deep structural comparison. Returns the path of the first difference, or `null` when equal.
 * Key order never matters; `null`/`[]`/absent are interchangeable; `ignorePaths` are skipped.
 */
export function firstDifference(a: unknown, b: unknown, opts: CompareOptions = {}): string | null {
  const ignore = new Set(opts.ignorePaths ?? []);
  return walk(a, b, "");

  function walk(x: unknown, y: unknown, path: string): string | null {
    if (path && ignore.has(path)) {
      return null;
    }
    if (isEmptyish(x) && isEmptyish(y)) {
      return null;
    }
    if (isEmptyish(x) || isEmptyish(y)) {
      return path || "(root)";
    }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) {
        return path || "(root)";
      }
      for (let i = 0; i < x.length; i++) {
        const d = walk(x[i], y[i], joinPath(path, String(i)));
        if (d) {
          return d;
        }
      }
      return null;
    }
    if (isPlainObject(x) || isPlainObject(y)) {
      if (!isPlainObject(x) || !isPlainObject(y)) {
        return path || "(root)";
      }
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of keys) {
        const d = walk(x[k], y[k], joinPath(path, k));
        if (d) {
          return d;
        }
      }
      return null;
    }
    // Primitives. Numbers and numeric strings are NOT conflated: the server round-trips
    // `caughtAttr` as a string and a number would be a real difference.
    if (typeof x === "number" && typeof y === "number") {
      return Object.is(x, y) || x === y ? null : path || "(root)";
    }
    return x === y ? null : path || "(root)";
  }
}

/** Deep structural equality; see {@link firstDifference}. */
export function structurallyEqual(a: unknown, b: unknown, opts: CompareOptions = {}): boolean {
  return firstDifference(a, b, opts) === null;
}

/** System saves round-trip losslessly apart from added `null`s, so this is a full comparison. */
export function systemEquals(a: SystemSave | null, b: SystemSave | null): boolean {
  return structurallyEqual(a, b);
}

/** Session comparison that tolerates the fields the server is known to drop. */
export function sessionEquals(a: SessionSave | null, b: SessionSave | null): boolean {
  return structurallyEqual(a, b, { ignorePaths: KNOWN_LOSSY_SESSION_FIELDS });
}

/** Session comparison with nothing ignored — used between two *local* copies. */
export function sessionEqualsStrict(a: SessionSave | null, b: SessionSave | null): boolean {
  return structurallyEqual(a, b);
}

/**
 * Fields a session save is worthless without. If one of these is missing from, or differs in, the
 * server's copy of a save we just pushed, the push did not land and that is an error.
 * `playTime` is only checked when the save we sent actually carries one.
 */
export const CRITICAL_SESSION_FIELDS: readonly string[] = [
  "seed",
  "waveIndex",
  "timestamp",
  "party",
  "gameMode",
  "playTime",
];

export interface SessionReadBackResult {
  /** The push landed: everything the server kept matches, and no critical field was lost. */
  ok: boolean;
  /** Top-level keys we sent with real content that the server's copy does not have at all. */
  droppedKeys: string[];
  /** Path of the first difference among the keys the server *did* keep, or `null`. */
  difference: string | null;
  /** Set when a critical field is missing from or differs in the server's copy. */
  criticalProblem: string | null;
}

/**
 * Verify a session read-back (DESIGN.md §3.8(6)).
 *
 * The server decodes into a fixed Go struct, so it silently drops every field that struct does not
 * know — `playerFaints` today, anything a future client release adds tomorrow. Enumerating them all
 * is impossible, so instead of comparing both ways we compare **only the keys the server's response
 * actually contains**, after the usual `null`/`[]`/absent normalisation. Keys the server dropped
 * are reported as warnings, not errors — unless they are in {@link CRITICAL_SESSION_FIELDS}.
 */
export function verifySessionReadBack(sent: SessionSave, got: SessionSave | null): SessionReadBackResult {
  if (got === null || typeof got !== "object") {
    return {
      ok: false,
      droppedKeys: [],
      difference: "(root)",
      criticalProblem: "the server has no save in this slot",
    };
  }
  const sentRec = sent as Record<string, unknown>;
  const gotRec = got as Record<string, unknown>;

  // Only compare what came back. A key the server omitted is "dropped", not "different".
  let difference: string | null = null;
  for (const key of Object.keys(gotRec)) {
    const d = firstDifference(gotRec[key], sentRec[key]);
    if (d !== null) {
      difference = d === "(root)" ? key : `${key}.${d}`;
      break;
    }
  }

  const droppedKeys: string[] = [];
  for (const key of Object.keys(sentRec)) {
    if (!(key in gotRec) && !isEmptyish(sentRec[key])) {
      droppedKeys.push(key);
    }
  }

  let criticalProblem: string | null = null;
  for (const key of CRITICAL_SESSION_FIELDS) {
    if (!(key in sentRec) || isEmptyish(sentRec[key])) {
      continue; // we did not send it (or sent nothing there); there is nothing to lose
    }
    if (!(key in gotRec)) {
      criticalProblem = `${key} is missing from the copy online`;
      break;
    }
    if (firstDifference(gotRec[key], sentRec[key]) !== null) {
      criticalProblem = `${key} differs from what was sent`;
      break;
    }
  }

  return { ok: difference === null && criticalProblem === null, droppedKeys, difference, criticalProblem };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Compare two `x.y.z`-style version strings the way the server does
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
 * Is `a` a strict descendant of `b` — i.e. can `a` safely replace `b` without losing anything?
 *
 * DESIGN.md §3.6 requires `playTime >=` and `timestamp >=`. Three further guards are applied, each
 * mirroring a rule the server would enforce or a way progress could silently vanish (see
 * NOTES-sync.md): same `trainerId`/`secretId`, no `gameVersion` regression, no regression of any
 * monotone `gameStats` counter, and `appliedMigrators` containment. Being conservative here only
 * ever turns a fast-forward into a question for the user; it never loses data.
 *
 * `b === null` means "there is nothing to lose", so any non-null save descends from it.
 */
export function isDescendantSystem(a: SystemSave | null, b: SystemSave | null): boolean {
  if (a === null) {
    return false;
  }
  if (b === null) {
    return true;
  }
  if (systemEquals(a, b)) {
    return false; // not a *strict* descendant
  }
  if (a.trainerId !== b.trainerId || a.secretId !== b.secretId) {
    return false;
  }
  const at = num(a.timestamp);
  const bt = num(b.timestamp);
  if (at === null || bt === null || at < bt) {
    return false;
  }
  const verCmp = compareGameVersion(String(a.gameVersion), String(b.gameVersion));
  if (verCmp === null || verCmp < 0) {
    return false;
  }
  const as = isPlainObject(a.gameStats) ? a.gameStats : null;
  const bs = isPlainObject(b.gameStats) ? b.gameStats : null;
  if (!as || !bs) {
    return false;
  }
  const ap = num(as["playTime"]);
  const bp = num(bs["playTime"]);
  if (ap === null || bp === null || ap < bp) {
    return false;
  }
  for (const stat of MONOTONE_GAME_STATS) {
    const x = num(as[stat]);
    const y = num(bs[stat]);
    if (x !== null && y !== null && x < y) {
      return false;
    }
  }
  // Server rule: every migrator the older save recorded must be present with the same timestamp.
  const am = isPlainObject(a.appliedMigrators) ? a.appliedMigrators : {};
  const bm = isPlainObject(b.appliedMigrators) ? b.appliedMigrators : {};
  for (const [k, v] of Object.entries(bm)) {
    if (am[k] !== v) {
      return false;
    }
  }
  return true;
}

/**
 * Is session `a` a strict descendant of `b`? Only a continuation of the *same run* counts: same
 * `seed`, `waveIndex >=`, `timestamp >=`, and `playTime >=` when both carry one.
 *
 * A different seed is a different run — the server would happily let it overwrite (the wave-index
 * guard only fires on an equal seed), which is exactly the case DESIGN.md wants escalated.
 */
export function isDescendantSession(a: SessionSave | null, b: SessionSave | null): boolean {
  if (a === null) {
    return false;
  }
  if (b === null) {
    return true;
  }
  if (sessionEquals(a, b)) {
    return false;
  }
  if (typeof a.seed !== "string" || a.seed !== b.seed) {
    return false;
  }
  const aw = num(a.waveIndex);
  const bw = num(b.waveIndex);
  if (aw === null || bw === null || aw < bw) {
    return false;
  }
  const at = num(a.timestamp);
  const bt = num(b.timestamp);
  if (at === null || bt === null || at < bt) {
    return false;
  }
  const ap = num(a["playTime"]);
  const bp = num(b["playTime"]);
  if (ap !== null && bp !== null && ap < bp) {
    return false;
  }
  return true;
}
