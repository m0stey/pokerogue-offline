import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CRITICAL_SESSION_FIELDS,
  KNOWN_LOSSY_SESSION_FIELDS,
  compareGameVersion,
  firstDifference,
  isDescendantSession,
  isDescendantSystem,
  sessionEchoMatches,
  sessionEquals,
  sessionEqualsStrict,
  structurallyEqual,
  systemEquals,
  verifySessionReadBack,
} from "../../src/sync/compare";
import type { SessionSave, SystemSave } from "../../src/sync/types";
import {
  SERVER_SESSION_KEYS,
  advanceSession,
  advanceSystem,
  makeSession,
  makeSystem,
  serverEcho,
} from "./fakes";

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

describe("verifySessionReadBack — only the keys the server returned are compared", () => {
  const sent = makeSession({ playerFaints: 3 });

  it("accepts the real server's lossy echo of a save we just pushed", () => {
    const got = serverEcho(sent, SERVER_SESSION_KEYS);
    const v = verifySessionReadBack(sent, got);
    expect(v.ok).toBe(true);
    expect(v.difference).toBeNull();
    expect(v.criticalProblem).toBeNull();
    expect(v.droppedKeys).toEqual(["playerFaints"]);
  });

  it("reports an unknown future field as a dropped key, not a failure", () => {
    const withCanary = makeSession({ someUnknownFutureField: "canary" } as never);
    const got = serverEcho(withCanary, SERVER_SESSION_KEYS);
    const v = verifySessionReadBack(withCanary, got);
    expect(v.ok).toBe(true);
    expect(v.droppedKeys).toContain("someUnknownFutureField");
  });

  it("matches the real fixture pair from the live probe", () => {
    const probeSent = read("session-sent.json") as SessionSave;
    const probeGot = read("session-roundtrip.json") as SessionSave;
    const v = verifySessionReadBack(probeSent, probeGot);
    expect(v.ok).toBe(true);
    expect(v.droppedKeys.sort()).toEqual(["playerFaints", "someUnknownFutureField"]);
  });

  it("does not count an empty array we sent as dropped when the key is simply absent", () => {
    const s = makeSession({ challenges: [] });
    const got = serverEcho(s, SERVER_SESSION_KEYS) as Record<string, unknown>;
    delete got["challenges"];
    const v = verifySessionReadBack(s, got as SessionSave);
    expect(v.droppedKeys).not.toContain("challenges");
    expect(v.ok).toBe(true);
  });

  it("fails when a key the server kept has a different value", () => {
    const got = { ...serverEcho(sent, SERVER_SESSION_KEYS), money: 99999 } as SessionSave;
    const v = verifySessionReadBack(sent, got);
    expect(v.ok).toBe(false);
    expect(v.difference).toBe("money");
  });

  it("reports a nested difference with its path", () => {
    const got = JSON.parse(JSON.stringify(serverEcho(sent, SERVER_SESSION_KEYS))) as Record<string, unknown>;
    (got["arena"] as Record<string, unknown>)["biome"] = 12;
    const v = verifySessionReadBack(sent, got as SessionSave);
    expect(v.ok).toBe(false);
    expect(v.difference).toBe("arena.biome");
  });

  describe("critical fields are never merely warnings", () => {
    for (const field of CRITICAL_SESSION_FIELDS) {
      it(`a missing ${field} fails`, () => {
        const got = serverEcho(sent, SERVER_SESSION_KEYS) as Record<string, unknown>;
        expect(got[field], `the fixture must actually carry ${field}`).toBeDefined();
        delete got[field];
        const v = verifySessionReadBack(sent, got as SessionSave);
        expect(v.ok).toBe(false);
        expect(v.criticalProblem).toContain(field);
        expect(v.droppedKeys).toContain(field);
      });

      it(`a differing ${field} fails`, () => {
        const got = serverEcho(sent, SERVER_SESSION_KEYS) as Record<string, unknown>;
        got[field] = typeof got[field] === "number" ? (got[field] as number) + 1 : "changed";
        const v = verifySessionReadBack(sent, got as SessionSave);
        expect(v.ok).toBe(false);
        expect(v.criticalProblem).toContain(field);
      });
    }
  });

  it("fails when the slot came back empty", () => {
    const v = verifySessionReadBack(sent, null);
    expect(v.ok).toBe(false);
    expect(v.criticalProblem).toMatch(/no save/i);
  });

  it("KNOWN_LOSSY_SESSION_FIELDS stays as documentation of what we already know is dropped", () => {
    expect(KNOWN_LOSSY_SESSION_FIELDS).toContain("playerFaints");
    // and none of them is critical, or a push could never verify
    for (const f of KNOWN_LOSSY_SESSION_FIELDS) {
      expect(CRITICAL_SESSION_FIELDS).not.toContain(f);
    }
  });
});

describe("sessionEchoMatches — is the server's copy just its echo of ours? (B2)", () => {
  const sent = makeSession({ playerFaints: 4, someFutureClientField: { a: 1, b: [2] } });

  it("a lossy echo of the save we sent matches", () => {
    expect(sessionEchoMatches(serverEcho(sent, SERVER_SESSION_KEYS), sent)).toBe(true);
  });

  it("an empty array coming back as null matches", () => {
    const got = { ...serverEcho(sent, SERVER_SESSION_KEYS) } as Record<string, unknown>;
    got["enemyParty"] = null;
    expect(sessionEchoMatches(got as unknown as SessionSave, sent)).toBe(true);
  });

  it("a value the server actually changed does not match", () => {
    const got = { ...serverEcho(sent, SERVER_SESSION_KEYS), money: 12345 } as SessionSave;
    expect(sessionEchoMatches(got, sent)).toBe(false);
  });

  it("a save from somewhere else that is further along does not match", () => {
    expect(sessionEchoMatches(advanceSession(sent, 3), sent)).toBe(false);
  });

  it("a missing critical field does not match, however lossy the server is", () => {
    for (const field of CRITICAL_SESSION_FIELDS) {
      const got = { ...serverEcho(sent, SERVER_SESSION_KEYS) } as Record<string, unknown>;
      delete got[field];
      expect(sessionEchoMatches(got as unknown as SessionSave, sent), field).toBe(false);
    }
  });

  it("a non-critical key we sent as empty and did not get back still matches", () => {
    const got = { ...serverEcho(sent, SERVER_SESSION_KEYS) } as Record<string, unknown>;
    delete got["challenges"]; // sent as []
    expect(sessionEchoMatches(got as unknown as SessionSave, sent)).toBe(true);
  });

  it("nulls line up only with nulls", () => {
    expect(sessionEchoMatches(null, null)).toBe(true);
    expect(sessionEchoMatches(null, sent)).toBe(false);
    expect(sessionEchoMatches(sent, null)).toBe(false);
  });

  it("is asymmetric on purpose: the server's copy comes first", () => {
    const echo = serverEcho(sent, SERVER_SESSION_KEYS);
    expect(sessionEchoMatches(echo, sent)).toBe(true);
    // the other way round, `sent` carries a key the echo does not, which is a real difference
    expect(sessionEchoMatches(sent, echo)).toBe(false);
  });
});

describe("the system save needs no echo tolerance", () => {
  it("the nulls the server adds already compare equal", () => {
    const sent = makeSystem();
    const got = { ...serverEcho(sent), starterMoveData: null, starterEggMoveData: null } as SystemSave;
    expect(systemEquals(got, sent)).toBe(true);
  });

  it("and a re-sorted gameStats is the same object", () => {
    const sent = makeSystem();
    const stats = sent.gameStats as Record<string, unknown>;
    const resorted = Object.fromEntries(Object.keys(stats).sort().map((k) => [k, stats[k]]));
    expect(systemEquals({ ...sent, gameStats: resorted } as SystemSave, sent)).toBe(true);
  });
});
