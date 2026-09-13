// DESIGN.md §3.6 — pure three-way reconciliation. No I/O, no clock, no randomness.
//
//   base   = what we last knew to be on the server
//   local  = what the game last wrote here
//   remote = what the server has right now
//
// The rules, in order:
//   local == remote                      -> noop (whatever base says, both sides already agree)
//   local is null, remote is not         -> pull (there is nothing here to lose)
//   remote == base && local != base      -> push
//   local  == base && remote != base     -> pull
//   both changed, one descends the other -> fast-forward to the descendant
//   anything else                        -> conflict. Never guess.

import { isDescendantSession, isDescendantSystem, sessionEquals, systemEquals } from "./compare";
import type { SessionSave, SystemSave } from "./types";

export type SlotDecision = { kind: "noop" } | { kind: "push" } | { kind: "pull" } | { kind: "conflict" };

/** Why a decision came out the way it did. Purely for logs and tests. */
export type DecisionReason =
  | "both-empty"
  | "already-equal"
  | "nothing-local"
  | "local-changed"
  | "remote-changed"
  | "fast-forward-local"
  | "fast-forward-remote"
  | "diverged";

export type ExplainedDecision = SlotDecision & { reason: DecisionReason };

const NOOP = { kind: "noop" } as const;
const PUSH = { kind: "push" } as const;
const PULL = { kind: "pull" } as const;
const CONFLICT = { kind: "conflict" } as const;

function decide<T>(
  base: T | null,
  local: T | null,
  remote: T | null,
  eq: (a: T | null, b: T | null) => boolean,
  descends: (a: T | null, b: T | null) => boolean,
): ExplainedDecision {
  if (local === null && remote === null) {
    return { ...NOOP, reason: "both-empty" };
  }
  if (eq(local, remote)) {
    return { ...NOOP, reason: "already-equal" };
  }
  if (local === null) {
    // Nothing here yet: taking the server's copy cannot destroy anything.
    return { ...PULL, reason: "nothing-local" };
  }

  const localChanged = !eq(local, base);
  const remoteChanged = !eq(remote, base);

  if (!remoteChanged && localChanged) {
    return { ...PUSH, reason: "local-changed" };
  }
  if (!localChanged && remoteChanged) {
    return { ...PULL, reason: "remote-changed" };
  }
  // Both sides moved away from base (or we have no base at all) and they disagree.
  if (descends(local, remote)) {
    return { ...PUSH, reason: "fast-forward-local" };
  }
  if (descends(remote, local)) {
    return { ...PULL, reason: "fast-forward-remote" };
  }
  return { ...CONFLICT, reason: "diverged" };
}

export function reconcileSystemExplained(
  base: SystemSave | null,
  local: SystemSave | null,
  remote: SystemSave | null,
): ExplainedDecision {
  return decide(base, local, remote, systemEquals, isDescendantSystem);
}

export function reconcileSessionExplained(
  base: SessionSave | null,
  local: SessionSave | null,
  remote: SessionSave | null,
): ExplainedDecision {
  return decide(base, local, remote, sessionEquals, isDescendantSession);
}

export function reconcileSystem(
  base: SystemSave | null,
  local: SystemSave | null,
  remote: SystemSave | null,
): SlotDecision {
  const { kind } = reconcileSystemExplained(base, local, remote);
  return { kind } as SlotDecision;
}

export function reconcileSession(
  base: SessionSave | null,
  local: SessionSave | null,
  remote: SessionSave | null,
): SlotDecision {
  const { kind } = reconcileSessionExplained(base, local, remote);
  return { kind } as SlotDecision;
}
