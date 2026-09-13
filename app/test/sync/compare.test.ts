import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KNOWN_LOSSY_SESSION_FIELDS,
  compareGameVersion,
  firstDifference,
  isDescendantSession,
  isDescendantSystem,
  sessionEquals,
  sessionEqualsStrict,
  structurallyEqual,
  systemEquals,
} from "../../src/sync/compare";
import type { SessionSave, SystemSave } from "../../src/sync/types";
import { advanceSession, advanceSystem, makeSession, makeSystem, serverEcho } from "./fakes";

const FIXTURES = join(__dirname, "fixtures");
const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("structural comparison", () => {
  it("ignores key order", () => {
    expect(structurallyEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("treats null, [] and an absent key as the same 'nothing'", () => {
    expect(structurallyEqual({ a: null }, { a: [] })).toBe(true);
    expect(structurallyEqual({ a: null }, {})).toBe(true);
    expect(structurallyEqual({ a: [] }, {})).toBe(true);
    expect(structurallyEqual({ a: [1] }, { a: null })).toBe(false);
    expect(structurallyEqual({ a: 0 }, { a: null })).toBe(false);
    expect(structurallyEqual({ a: "" }, { a: null })).toBe(false);
    expect(structurallyEqual({ a: {} }, { a: null })).toBe(false);
  });

  it("does not conflate numbers with numeric strings (caughtAttr)", () => {
    expect(structurallyEqual({ caughtAttr: "34084861955" }, { caughtAttr: 34084861955 })).toBe(false);
  });

  it("compares arrays element-wise and length-sensitively", () => {
    expect(structurallyEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(structurallyEqual([1, 2], [2, 1])).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("reports the path of the first difference", () => {
    expect(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } })).toBe("a.b.1");
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
  });

  it("honours ignorePaths", () => {
    expect(structurallyEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false);
    expect(structurallyEqual({ a: 1, b: 2 }, { a: 1, b: 3 }, { ignorePaths: ["b"] })).toBe(true);
    expect(structurallyEqual({ x: { y: 1 } }, { x: { y: 2 } }, { ignorePaths: ["x.y"] })).toBe(true);
  });
});

describe("save-level comparison against the real server's behaviour", () => {
  it("a system save survives the server round trip (two added nulls, resorted gameStats)", () => {
    const sent = read("system-final.json") as SystemSave;
    const got = { ...serverEcho(sent), starterMoveData: null, starterEggMoveData: null } as SystemSave;
    expect(systemEquals(sent, got)).toBe(true);
  });

  it("a session save does NOT survive strictly, but does after ignoring the known lossy fields", () => {
    const sent = read("session-sent.json") as SessionSave;
    const got = read("session-roundtrip.json") as SessionSave;
    // `someUnknownFutureField` is also dropped by the server; that is the documented limit of the
    // ignore-list approach, so compare against a copy without the canary.
    const sentWithoutCanary = { ...sent };
    delete (sentWithoutCanary as Record<string, unknown>)["someUnknownFutureField"];
    expect(sessionEqualsStrict(sentWithoutCanary, got)).toBe(false);
    expect(sessionEquals(sentWithoutCanary, got)).toBe(true);
  });

  it("playerFaints is on the ignore list (DESIGN.md §3.8)", () => {
    expect(KNOWN_LOSSY_SESSION_FIELDS).toContain("playerFaints");
  });

  it("equal play time is not 'unchanged' (Invariant §4.5)", () => {
    const a = makeSystem();
    const b = makeSystem({ gameStats: { playTime: 1000, battles: 7, pokemonCaught: 0, pokemonSeen: 0 } });
    expect((a.gameStats as { playTime: number }).playTime).toBe(
      (b.gameStats as { playTime: number }).playTime,
    );
    expect(systemEquals(a, b)).toBe(false);
  });

  it("null and a missing save are different things", () => {
    expect(systemEquals(null, null)).toBe(true);
    expect(systemEquals(makeSystem(), null)).toBe(false);
  });
});

describe("compareGameVersion", () => {
  it("matches the server's semantics", () => {
    expect(compareGameVersion("1.12.0.10", "1.12.0.9")).toBe(1);
    expect(compareGameVersion("1.12.0", "1.12.0.0")).toBe(0);
    expect(compareGameVersion("1.12.1.0", "1.12.1")).toBe(0);
    expect(compareGameVersion("1.12.0.9", "1.12.1.0")).toBe(-1);
  });

  it("returns null for malformed versions", () => {
    expect(compareGameVersion("1.12", "1.12.0")).toBeNull();
    expect(compareGameVersion("1.12.0.0.1", "1.12.0")).toBeNull();
    expect(compareGameVersion("x.y.z", "1.12.0")).toBeNull();
  });
});

describe("isDescendantSystem", () => {
  const base = makeSystem();

  it("anything descends from nothing", () => {
    expect(isDescendantSystem(base, null)).toBe(true);
    expect(isDescendantSystem(null, base)).toBe(false);
    expect(isDescendantSystem(null, null)).toBe(false);
  });

  it("an identical save is not a *strict* descendant", () => {
    expect(isDescendantSystem(base, makeSystem())).toBe(false);
  });

  it("more play time and a later timestamp descends", () => {
    expect(isDescendantSystem(advanceSystem(base), base)).toBe(true);
    expect(isDescendantSystem(base, advanceSystem(base))).toBe(false);
  });

  it("refuses when play time went backwards", () => {
    const older = makeSystem({ timestamp: 1789231607586, gameStats: { playTime: 900, battles: 0 } });
    expect(isDescendantSystem(older, base)).toBe(false);
  });

  it("refuses when the timestamp went backwards even if play time grew", () => {
    const odd = makeSystem({ timestamp: 1789231600000, gameStats: { playTime: 2000, battles: 0 } });
    expect(isDescendantSystem(odd, base)).toBe(false);
  });

  it("refuses a different profile (trainerId/secretId)", () => {
    const other = advanceSystem(makeSystem({ trainerId: 1 }));
    expect(isDescendantSystem(other, base)).toBe(false);
  });

  it("refuses a game-version regression (the server would too)", () => {
    const older = advanceSystem(makeSystem({ gameVersion: "1.12.0.10" }));
    expect(isDescendantSystem(older, base)).toBe(false);
  });

  it("refuses when a monotone counter went backwards", () => {
    const weird = advanceSystem(base);
    (weird.gameStats as Record<string, unknown>)["pokemonCaught"] = -1;
    expect(isDescendantSystem(weird, makeSystem({ gameStats: { playTime: 1000, pokemonCaught: 5 } }))).toBe(
      false,
    );
  });

  it("refuses when a migrator the old save recorded is missing or changed", () => {
    const withMigrator = makeSystem({ appliedMigrators: { "1.12.0.10-fix": 17 } });
    const advancedMissing = advanceSystem(makeSystem({ appliedMigrators: {} }));
    expect(isDescendantSystem(advancedMissing, withMigrator)).toBe(false);
    const advancedKept = advanceSystem(withMigrator);
    expect(isDescendantSystem(advancedKept, withMigrator)).toBe(true);
    const advancedExtra = advanceSystem(
      makeSystem({ appliedMigrators: { "1.12.0.10-fix": 17, "1.13-new": 20 } }),
    );
    expect(isDescendantSystem(advancedExtra, withMigrator)).toBe(true);
  });
});

describe("isDescendantSession", () => {
  const base = makeSession();

  it("anything descends from an empty slot", () => {
    expect(isDescendantSession(base, null)).toBe(true);
    expect(isDescendantSession(null, base)).toBe(false);
  });

  it("a later wave of the same run descends", () => {
    expect(isDescendantSession(advanceSession(base, 4), base)).toBe(true);
    expect(isDescendantSession(base, advanceSession(base, 4))).toBe(false);
  });

  it("a different seed is never a descendant, however far along", () => {
    const other = advanceSession(makeSession({ seed: "DIFFERENTSEED9" }), 40);
    expect(isDescendantSession(other, base)).toBe(false);
    expect(isDescendantSession(base, other)).toBe(false);
  });

  it("refuses a wave regression", () => {
    const regressed = { ...base, waveIndex: 0, timestamp: (base.timestamp as number) + 10 } as SessionSave;
    expect(isDescendantSession(regressed, base)).toBe(false);
  });

  it("refuses a timestamp regression", () => {
    const regressed = { ...base, waveIndex: 9, timestamp: (base.timestamp as number) - 10 } as SessionSave;
    expect(isDescendantSession(regressed, base)).toBe(false);
  });

  it("ignores the fields the server drops when checking equality", () => {
    const withFaints = makeSession({ playerFaints: 3 });
    expect(isDescendantSession(withFaints, base)).toBe(false); // equal apart from a lossy field
  });
});
