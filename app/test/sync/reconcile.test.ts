import { describe, expect, it } from "vitest";
import {
  reconcileSession,
  reconcileSessionExplained,
  reconcileSystem,
  reconcileSystemExplained,
} from "../../src/sync/reconcile";
import type { SessionSave, SystemSave } from "../../src/sync/types";
import { SERVER_SESSION_KEYS, advanceSession, advanceSystem, makeSession, makeSystem, serverEcho } from "./fakes";

// Three distinct system saves. A is the "base" state, B and C are divergent successors that are
// NOT descendants of each other (different trainerId keeps them from fast-forwarding).
const A = makeSystem();
const B = makeSystem({ timestamp: 1789231700000, gameStats: { playTime: 1100, battles: 5 } });
const C = makeSystem({ timestamp: 1789231700000, gameStats: { playTime: 1050, battles: 9 } });

type Slot = "null" | "A" | "B" | "C";
const pick = (s: Slot): SystemSave | null => (s === "null" ? null : s === "A" ? A : s === "B" ? B : C);

describe("reconcileSystem — the full base x local x remote matrix", () => {
  // base, local, remote, expected
  const table: [Slot, Slot, Slot, "noop" | "push" | "pull" | "conflict"][] = [
    // base = null
    ["null", "null", "null", "noop"],
    ["null", "null", "A", "pull"], // nothing here yet
    ["null", "A", "null", "push"], // first upload
    ["null", "A", "A", "noop"],
    ["null", "B", "C", "conflict"], // no base, two different saves
    // base = A, local unchanged
    ["A", "A", "A", "noop"],
    ["A", "A", "null", "pull"], // the save vanished online
    ["A", "A", "B", "pull"], // only the server moved
    // base = A, remote unchanged
    ["A", "B", "A", "push"], // only we moved
    ["A", "null", "A", "pull"], // nothing local to lose -> take the server's
    // base = A, both moved
    ["A", "B", "C", "conflict"],
    ["A", "B", "B", "noop"], // both moved to the same place
    ["A", "null", "null", "noop"],
    ["A", "B", "null", "push"], // gone online but we have new progress: restore it
    ["A", "null", "B", "pull"],
  ];

  for (const [base, local, remote, expected] of table) {
    it(`base=${base} local=${local} remote=${remote} -> ${expected}`, () => {
      expect(reconcileSystem(pick(base), pick(local), pick(remote))).toEqual({ kind: expected });
    });
  }
});

describe("reconcileSystem — fast-forward", () => {
  it("fast-forwards to the local save when it is a strict descendant of the remote", () => {
    const base = makeSystem();
    const local = advanceSystem(advanceSystem(base));
    const remote = advanceSystem(base);
    expect(reconcileSystemExplained(base, local, remote)).toEqual({
      kind: "push",
      reason: "fast-forward-local",
    });
  });

  it("fast-forwards to the remote save when it is a strict descendant of the local one", () => {
    const base = makeSystem();
    const local = advanceSystem(base);
    const remote = advanceSystem(advanceSystem(base));
    expect(reconcileSystemExplained(base, local, remote)).toEqual({
      kind: "pull",
      reason: "fast-forward-remote",
    });
  });

  it("escalates to a conflict when neither descends from the other", () => {
    expect(reconcileSystemExplained(A, B, C).kind).toBe("conflict");
  });

  it("does not mistake the server's null-padding for a change", () => {
    const local = makeSystem();
    const remote = { ...serverEcho(local), starterMoveData: null, starterEggMoveData: null } as SystemSave;
    expect(reconcileSystemExplained(local, local, remote)).toEqual({ kind: "noop", reason: "already-equal" });
  });

  it("treats equal play time with different stats as a real change (Invariant §4.5)", () => {
    const base = makeSystem();
    const local = makeSystem({ gameStats: { playTime: 1000, battles: 7 } });
    expect(reconcileSystem(base, local, base)).toEqual({ kind: "push" });
  });
});

// --- sessions -------------------------------------------------------------------------------------

const SA = makeSession();
const SB = makeSession({ seed: "DIFFERENTSEED9", waveIndex: 3, timestamp: 1789231800000 });
const SC = makeSession({ seed: "THIRDSEEDXXXXX", waveIndex: 7, timestamp: 1789231900000 });
const pickS = (s: Slot): SessionSave | null => (s === "null" ? null : s === "A" ? SA : s === "B" ? SB : SC);

describe("reconcileSession — the full base x local x remote matrix", () => {
  const table: [Slot, Slot, Slot, "noop" | "push" | "pull" | "conflict"][] = [
    ["null", "null", "null", "noop"],
    ["null", "null", "A", "pull"],
    ["null", "A", "null", "push"],
    ["null", "A", "A", "noop"],
    ["null", "B", "C", "conflict"],
    ["A", "A", "A", "noop"],
    ["A", "A", "null", "pull"], // the run was finished/cleared online
    ["A", "A", "B", "pull"],
    ["A", "B", "A", "push"],
    ["A", "null", "A", "pull"],
    ["A", "B", "C", "conflict"],
    ["A", "B", "B", "noop"],
    ["A", "null", "null", "noop"],
    ["A", "B", "null", "push"],
    ["A", "null", "B", "pull"],
  ];
  for (const [base, local, remote, expected] of table) {
    it(`base=${base} local=${local} remote=${remote} -> ${expected}`, () => {
      expect(reconcileSession(pickS(base), pickS(local), pickS(remote))).toEqual({ kind: expected });
    });
  }
});

describe("reconcileSession — fast-forward and the seed rule", () => {
  it("fast-forwards to a later wave of the same run", () => {
    const base = makeSession();
    const local = advanceSession(base, 4);
    const remote = advanceSession(base, 1);
    expect(reconcileSessionExplained(base, local, remote)).toEqual({
      kind: "push",
      reason: "fast-forward-local",
    });
    expect(reconcileSessionExplained(base, remote, local)).toEqual({
      kind: "pull",
      reason: "fast-forward-remote",
    });
  });

  it("never fast-forwards across different seeds, even when one is far ahead", () => {
    const base = makeSession();
    const local = advanceSession(base, 1);
    const remote = advanceSession(makeSession({ seed: "OTHERSEED0001" }), 40);
    expect(reconcileSession(base, local, remote)).toEqual({ kind: "conflict" });
  });

  it("ignores server-dropped fields when deciding", () => {
    const local = makeSession({ playerFaints: 3 });
    const remote = serverEcho(local);
    expect(reconcileSessionExplained(local, local, remote)).toEqual({
      kind: "noop",
      reason: "already-equal",
    });
  });

  // B2, reports/milestone-1.md §5: the field the server drops need not be one we know about.
  it("ignores a field the server's struct has never heard of", () => {
    const sent = makeSession({ playerFaints: 3, someFutureClientField: { a: 1 } });
    const remote = serverEcho(sent, SERVER_SESSION_KEYS);
    expect(reconcileSessionExplained(sent, sent, remote)).toEqual({
      kind: "noop",
      reason: "already-equal",
    });
  });

  it("does not mistake a server echo for a remote change when the local save moved on", () => {
    const sent = makeSession({ someFutureClientField: 1 });
    const remote = serverEcho(sent, SERVER_SESSION_KEYS);
    const local = advanceSession(sent, 2);
    // base = what we sent, remote = its echo ⇒ the server did not move: push, never conflict.
    expect(reconcileSessionExplained(sent, local, remote)).toEqual({
      kind: "push",
      reason: "local-changed",
    });
  });

  it("the tolerance is one-way: a real difference in a kept field is still a difference", () => {
    const local = makeSession({ waveIndex: 5 });
    const remote = makeSession({ waveIndex: 12 });
    expect(reconcileSessionExplained(local, local, remote).kind).toBe("pull");
  });
});

describe("purity", () => {
  it("does not mutate its inputs", () => {
    const base = makeSystem();
    const local = advanceSystem(base);
    const remote = makeSystem();
    const snapshots = [base, local, remote].map((s) => JSON.stringify(s));
    reconcileSystem(base, local, remote);
    expect([base, local, remote].map((s) => JSON.stringify(s))).toEqual(snapshots);
  });

  it("is deterministic", () => {
    for (let i = 0; i < 5; i++) {
      expect(reconcileSystem(A, B, C)).toEqual({ kind: "conflict" });
    }
  });
});
