// DESIGN.md §3.8 — the sync engine.
//
// Sequence (§3.8): noop if nothing is dirty and the base is fresh; claim the clientSessionId with a
// `system/get`; decide the system save; decide each of the five session slots; then apply, system
// first, backing up whatever each write replaces *before* writing it, re-reading each slot
// immediately before pushing it, and reading back after every push to prove the write landed.
//
// Invariants enforced here (DESIGN.md §4):
//   1. Nothing that replaces data is written without a verified `.prsv` backup of what it replaces.
//   3. Every branch is on HTTP status (see upstream-api.ts), never on an empty body.
//   4. One clientSessionId per install, claimed by the opening `system/get`; any `not active`
//      means re-GET, re-decide, retry once, then stop.
//   5. Equal play time is not "unchanged" — compare.ts decides.
//   6. A local save is only replaced by a non-descendant remote when the conflict policy says so
//      and a backup exists.
//   7. `clear`, `newclear` and `verify` are never called. `session/delete` is called only to
//      propagate a run the game finished offline, under the four preconditions in
//      `mayPropagateClear`, and only after a verified backup of the server's copy.

import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import type { BackupManager, BackupReason } from "./backup";
import { sessionEchoMatches, sessionEquals, systemEquals, verifySessionReadBack } from "./compare";
import type { ClassifiedError } from "./errors";
import { describeForUser, isUnrecoverablePush } from "./errors";
import type { MirrorPort, SessionRecord } from "./mirror-port";
import { reconcileSessionExplained, reconcileSystemExplained } from "./reconcile";
import type { ApiResult, UpstreamApi } from "./upstream-api";
import type { ConflictPolicy, SessionSave, SystemSave } from "./types";
import { SESSION_SLOTS } from "./types";

export const BASE_FRESHNESS_MS = 5 * 60 * 1000;

/** One thing that could not be synced and will not succeed on a retry without user action. */
export interface UnrecoverableItem {
  /** `"system"` or `"session3"`. */
  what: string;
  reason: ClassifiedError;
  /**
   * The `.prsv` the user can import by hand, or `null` when even the backup failed (in which case
   * `errors` also carries `<what>:backup-failed`). A backup is always *attempted* before this is
   * reported.
   */
  backupPath: string | null;
}

export interface SyncResult {
  /** Target names, e.g. `"system"`, `"session2"`. */
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  errors: string[];
  /** Non-fatal observations, e.g. fields the server dropped from a session save. */
  warnings: string[];
  /** The game build is behind what the account needs; syncing cannot succeed until it is updated. */
  needsGameUpdate: boolean;
  /** Everything that was refused for good and the backup written for it. */
  unrecoverable: UnrecoverableItem[];
  /** One or two plain sentences, safe to show the user. No jargon, no error codes. */
  summary: string;
}

export interface ConflictSide {
  playTime: number | null;
  timestamp: number | null;
  /** Sessions only. */
  waveIndex: number | null;
  seed: string | null;
}

export interface ConflictQuestion {
  kind: "system" | "session";
  slot: number | null;
  /** `"system"` or `"session3"`. */
  target: string;
  thisComputer: ConflictSide | null;
  online: ConflictSide | null;
}

export interface ConflictPolicyPort {
  mode: ConflictPolicy;
  /** Only called when `mode` is `"ask"`, and at most once per sync run. */
  ask(question: ConflictQuestion): Promise<"this-computer" | "online">;
}

export interface SyncDeps {
  mirror: MirrorPort;
  backup: BackupManager;
  api: UpstreamApi;
  policy: ConflictPolicyPort;
  log?: Logger;
  /** Injected clock, ms since epoch. */
  now?: () => number;
  /** How long a `base` stays fresh enough to skip a sync entirely. Default 5 minutes. */
  freshnessMs?: number;
}

/** Thrown internally to unwind the whole run without half-writing anything. */
class SyncAborted extends Error {
  readonly reason: ClassifiedError;
  constructor(reason: ClassifiedError) {
    super(reason.kind);
    this.name = "SyncAborted";
    this.reason = reason;
  }
}

/**
 * May the engine send `session/delete` for this slot? DESIGN.md §3.8 (amended): only to propagate a
 * run the game finished offline, and only when **all** of these hold.
 *
 * 1. `local` is `null` — the game removed the run here;
 * 2. `clearedAt` is recorded — it was an offline *clear*, not some other way of ending up empty;
 * 3. `base` is non-null — we know what the server had;
 * 4. `remote` structurally equals `base` — nobody has touched the slot online since. Compared with
 *    {@link sessionEchoMatches}, because `base` is the save *we* sent and the server's copy of it
 *    never carries the keys its Go struct does not know.
 *
 * The caller must still write a verified `.prsv` of `remote` before calling `deleteSession`.
 */
export function mayPropagateClear(rec: SessionRecord, remote: SessionSave | null): boolean {
  return (
    rec.local === null &&
    typeof rec.clearedAt === "string" &&
    rec.clearedAt.length > 0 &&
    rec.base !== null &&
    remote !== null &&
    sessionEchoMatches(remote, rec.base)
  );
}

function sideOf(save: SystemSave | SessionSave | null): ConflictSide | null {
  if (!save) {
    return null;
  }
  const rec = save as Record<string, unknown>;
  const stats = rec["gameStats"];
  const playTime =
    typeof rec["playTime"] === "number"
      ? (rec["playTime"] as number)
      : stats && typeof stats === "object" && typeof (stats as Record<string, unknown>)["playTime"] === "number"
        ? ((stats as Record<string, unknown>)["playTime"] as number)
        : null;
  return {
    playTime,
    timestamp: typeof rec["timestamp"] === "number" ? (rec["timestamp"] as number) : null,
    waveIndex: typeof rec["waveIndex"] === "number" ? (rec["waveIndex"] as number) : null,
    seed: typeof rec["seed"] === "string" ? (rec["seed"] as string) : null,
  };
}

/** Mirror timestamps are ISO-8601 strings. Anything unparseable counts as "not fresh". */
function isoToMs(iso: string | null): number | null {
  if (typeof iso !== "string") {
    return null;
  }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export async function runSync(deps: SyncDeps): Promise<SyncResult> {
  const log = (deps.log ?? noopLogger).child("sync");
  const now = deps.now ?? (() => Date.now());
  const freshnessMs = deps.freshnessMs ?? BASE_FRESHNESS_MS;
  const { mirror, api, backup, policy } = deps;

  const result: SyncResult = {
    pushed: [],
    pulled: [],
    conflicts: [],
    errors: [],
    warnings: [],
    needsGameUpdate: false,
    unrecoverable: [],
    summary: "",
  };
  /** Remembered answer for `mode: "ask"` — the dialog appears once per run (§3.8). */
  let rememberedAnswer: "this-computer" | "online" | null = null;
  let notActiveRetries = 0;

  const state = mirror.readState();
  const csid = state.clientSessionId;
  if (typeof csid !== "string" || csid.length === 0) {
    result.errors.push("no-client-session-id");
    result.summary = "Something is not set up right on this computer, so nothing was synced.";
    return result;
  }

  try {
    // (1) Nothing to do? -------------------------------------------------------------------------
    if (isEverythingFresh(mirror, now(), freshnessMs)) {
      log.debug("nothing dirty and base is fresh; skipping");
      result.summary = "Everything was already up to date.";
      finishState(mirror, now(), result);
      return result;
    }

    // (2) Claim the clientSessionId and read the server's system save. --------------------------
    const remoteSystem = await getSystemOrThrow(api, csid);

    // (3) Decide the system save. ---------------------------------------------------------------
    const systemRecord = mirror.readSystem();
    const systemDecision = reconcileSystemExplained(systemRecord.base, systemRecord.local, remoteSystem);
    log.debug("system decision", { kind: systemDecision.kind, reason: systemDecision.reason });

    // (4) Decide every session slot. ------------------------------------------------------------
    interface SessionPlan {
      slot: number;
      decision: ReturnType<typeof reconcileSessionExplained>;
      remote: SessionSave | null;
      record: SessionRecord;
      propagateClear: boolean;
    }
    const sessionPlans: SessionPlan[] = [];
    for (let slot = 0; slot < SESSION_SLOTS; slot++) {
      const remote = await getSessionOrThrow(api, slot, csid);
      const rec = mirror.readSession(slot);
      const propagateClear = mayPropagateClear(rec, remote);
      const decision = reconcileSessionExplained(rec.base, rec.local, remote);
      log.debug("session decision", {
        slot,
        kind: propagateClear ? "propagate-clear" : decision.kind,
        reason: decision.reason,
      });
      sessionPlans.push({ slot, decision, remote, record: rec, propagateClear });
    }

    // (5)-(7) Apply. System first. ---------------------------------------------------------------
    let systemAction = await resolveConflict(
      "system",
      "system",
      null,
      systemDecision.kind,
      systemRecord.local,
      remoteSystem,
    );
    // A "pull" of nothing would wipe the only copy of the profile. The server never legitimately
    // loses a system save, so restore it instead — pushing into an empty account is always safe.
    if (systemAction === "pull" && remoteSystem === null) {
      log.warn("server has no system save; restoring this computer's copy instead of clearing it");
      systemAction = "push";
    }

    if (systemAction === "push" && systemRecord.local) {
      await pushSystem(systemRecord.local, remoteSystem, systemDecision.kind === "conflict");
    } else if (systemAction === "pull") {
      await pullSystem(systemRecord.local, remoteSystem, systemDecision.kind === "conflict");
    }

    // Sessions.
    for (const plan of sessionPlans) {
      const target = `session${plan.slot}`;
      if (plan.propagateClear) {
        await propagateOfflineClear(plan.slot, plan.remote as SessionSave);
        continue;
      }
      const local = plan.record.local;
      const action = await resolveConflict(
        "session",
        target,
        plan.slot,
        plan.decision.kind,
        local,
        plan.remote,
      );
      if (action === "push" && local) {
        await pushSession(plan.slot, local, plan.remote, plan.decision.kind === "conflict");
      } else if (action === "pull") {
        await pullSession(plan.slot, local, plan.remote, plan.decision.kind === "conflict");
      }
    }
  } catch (err) {
    if (err instanceof SyncAborted) {
      result.errors.push(err.reason.kind);
      log.warn("sync aborted", { kind: err.reason.kind, detail: err.reason.detail });
      result.summary = describeForUser(err.reason);
      finishState(mirror, now(), result);
      return result;
    }
    throw err;
  }

  result.summary = summarise(result);
  finishState(mirror, now(), result);
  return result;

  // --- helpers --------------------------------------------------------------------------------

  /** Turn a decision into the action to take, asking the policy when it is a conflict. */
  async function resolveConflict(
    kind: "system" | "session",
    target: string,
    slot: number | null,
    decision: "noop" | "push" | "pull" | "conflict",
    local: SystemSave | SessionSave | null,
    remote: SystemSave | SessionSave | null,
  ): Promise<"noop" | "push" | "pull"> {
    if (decision !== "conflict") {
      return decision;
    }
    result.conflicts.push(target);
    let answer: "this-computer" | "online";
    if (policy.mode === "prefer-this-computer") {
      answer = "this-computer";
    } else if (policy.mode === "prefer-online") {
      answer = "online";
    } else if (rememberedAnswer) {
      answer = rememberedAnswer;
    } else {
      answer = await policy.ask({
        kind,
        slot,
        target,
        thisComputer: sideOf(local),
        online: sideOf(remote),
      });
      rememberedAnswer = answer;
    }
    log.info("conflict resolved", { target, answer, mode: policy.mode });
    return answer === "this-computer" ? "push" : "pull";
  }

  async function pushSystem(local: SystemSave, remote: SystemSave | null, fromConflict: boolean): Promise<void> {
    const reason: BackupReason = fromConflict ? "conflict" : "update";
    // Invariant §4.1: back up what the server is about to lose, before touching it.
    if (remote) {
      await backup.backup("system", null, remote, reason);
    }
    let res = await api.updateSystem(csid, local);
    if (!res.ok && res.reason.kind === "not-active") {
      const retried = await retryAfterNotActive(async () => {
        const fresh = await getSystemOrThrow(api, csid);
        const rec = mirror.readSystem();
        const again = reconcileSystemExplained(rec.base, rec.local, fresh);
        if (again.kind !== "push") {
          log.info("system no longer needs a push after re-claiming the session", { kind: again.kind });
          return null;
        }
        if (fresh && !systemEquals(fresh, remote)) {
          await backup.backup("system", null, fresh, reason);
        }
        return api.updateSystem(csid, local);
      });
      if (retried === null) {
        return;
      }
      res = retried;
    }
    if (!res.ok) {
      await handlePushRejection("system", null, local, res.reason);
      return;
    }

    // (6) Read back and prove it landed.
    const readBack = await getSystemOrThrow(api, csid);
    if (!systemEquals(readBack, local)) {
      // Fail safe: leave `dirty` alone so the next sync tries again.
      result.errors.push("system:verify-failed");
      log.error("system read-back did not match what was pushed; keeping the save dirty");
      return;
    }
    // Base is set to the save we sent, not to the server's echo: the echo carries the server's own
    // normalisation (added `null`s, re-sorted keys) and storing it would leave the mirror
    // permanently "dirty" under a byte-level comparison. We have just proved the two are equivalent.
    mirror.setBaseSystem(local);
    result.pushed.push("system");
  }

  async function pullSystem(local: SystemSave | null, remote: SystemSave | null, fromConflict: boolean): Promise<void> {
    if (!remote) {
      return; // handled by the caller; a null pull never reaches here
    }
    const reason: BackupReason = fromConflict ? "conflict" : "update";
    if (local) {
      // Invariant §4.1 and §4.6: the local copy is backed up before anything replaces it.
      await backup.backup("system", null, local, reason);
    }
    mirror.writeLocalSystem(remote);
    mirror.setBaseSystem(remote);
    result.pulled.push("system");
  }

  async function pushSession(
    slot: number,
    local: SessionSave,
    remoteAtDecision: SessionSave | null,
    fromConflict: boolean,
  ): Promise<void> {
    const target = `session${slot}`;
    const reason: BackupReason = fromConflict ? "conflict" : "update";

    // §3.8(5): re-read the slot immediately before pushing. `session/update` is NOT gated on the
    // active session, so the server will happily let us clobber a run it accepted a second ago.
    const fresh = await getSessionOrThrow(api, slot, csid);
    if (!sessionEquals(fresh, remoteAtDecision)) {
      const rec = mirror.readSession(slot);
      const again = reconcileSessionExplained(rec.base, rec.local, fresh);
      log.info("slot changed online since we decided; re-deciding", { slot, kind: again.kind });
      const action = await resolveConflict("session", target, slot, again.kind, local, fresh);
      if (action !== "push") {
        if (action === "pull") {
          await pullSession(slot, local, fresh, again.kind === "conflict");
        }
        return;
      }
    }
    const remote = fresh;

    if (remote) {
      await backup.backup("session", slot, remote, reason);
    }
    let res = await api.updateSession(slot, csid, local);
    if (!res.ok && res.reason.kind === "not-active") {
      const retried = await retryAfterNotActive(async () => {
        await getSystemOrThrow(api, csid); // re-claim the active session
        const check = await getSessionOrThrow(api, slot, csid);
        const rec = mirror.readSession(slot);
        const again = reconcileSessionExplained(rec.base, rec.local, check);
        if (again.kind !== "push") {
          return null;
        }
        if (check && !sessionEquals(check, remote)) {
          await backup.backup("session", slot, check, reason);
        }
        return api.updateSession(slot, csid, local);
      });
      if (retried === null) {
        return;
      }
      res = retried;
    }
    if (!res.ok) {
      await handlePushRejection("session", slot, local, res.reason);
      return;
    }

    // (6) Read back. The server drops any field its Go struct does not know, so only the keys it
    // returned are compared; anything it silently discarded is a warning unless it is critical.
    const readBack = await getSessionOrThrow(api, slot, csid);
    const check = verifySessionReadBack(local, readBack);
    if (!check.ok) {
      result.errors.push(`${target}:verify-failed`);
      log.error("session read-back did not match what was pushed; keeping the save dirty", {
        slot,
        difference: check.difference,
        critical: check.criticalProblem,
      });
      return;
    }
    if (check.droppedKeys.length > 0) {
      const note = `${target}:dropped-fields:${check.droppedKeys.join(",")}`;
      result.warnings.push(note);
      log.warn("the online service does not store some parts of this run", {
        slot,
        droppedKeys: check.droppedKeys,
      });
    }
    // As for the system save: base is what we sent, which we have just proved the server holds an
    // equivalent copy of.
    mirror.setBaseSession(slot, local);
    result.pushed.push(target);
  }

  async function pullSession(
    slot: number,
    local: SessionSave | null,
    remote: SessionSave | null,
    fromConflict: boolean,
  ): Promise<void> {
    const reason: BackupReason = fromConflict ? "conflict" : "update";
    if (local) {
      await backup.backup("session", slot, local, reason);
    }
    if (remote === null) {
      // The run is gone online (finished, or the slot was cleared there). The local copy has just
      // been exported to a verified `.prsv`, so nothing is lost by letting the mirror follow.
      mirror.deleteLocalSession(slot);
      mirror.setBaseSession(slot, null);
    } else {
      mirror.writeLocalSession(slot, remote);
      mirror.setBaseSession(slot, remote);
    }
    result.pulled.push(`session${slot}`);
  }

  /**
   * The game finished this run offline. Preconditions were checked by {@link mayPropagateClear};
   * the only remaining duty is Invariant §4.1 — a verified `.prsv` of the server's copy first.
   */
  async function propagateOfflineClear(slot: number, remote: SessionSave): Promise<void> {
    const target = `session${slot}`;
    try {
      const path = await backup.backup("session", slot, remote, "update");
      log.info("propagating a run finished offline; the run was exported first", { slot, path });
    } catch (err) {
      result.errors.push(`${target}:backup-failed`);
      log.error("could not back up the run before removing it online; leaving it alone", {
        slot,
        err: String(err),
      });
      return;
    }

    const res = await api.deleteSession(slot, csid);
    if (!res.ok) {
      if (res.reason.kind === "offline") {
        throw new SyncAborted(res.reason);
      }
      result.errors.push(`${target}:${res.reason.kind}`);
      log.warn("could not remove the finished run online", { slot, kind: res.reason.kind });
      return;
    }

    const readBack = await getSessionOrThrow(api, slot, csid);
    if (readBack !== null) {
      result.errors.push(`${target}:verify-failed`);
      log.error("the finished run is still online after removing it", { slot });
      return;
    }
    if (mirror.setSessionSynced) {
      mirror.setSessionSynced(slot, null);
    } else {
      mirror.setBaseSession(slot, null);
    }
    result.pushed.push(target);
  }

  /**
   * Invariant §4.4: on `not active`, re-GET (re-claiming the id), re-decide, retry **once**, then
   * stop the whole run. Returns `null` when the retry is no longer wanted.
   */
  async function retryAfterNotActive<T>(attempt: () => Promise<ApiResult<T> | null>): Promise<ApiResult<T> | null> {
    if (notActiveRetries >= 1) {
      log.warn("another client keeps claiming the account; stopping");
      throw new SyncAborted({ kind: "not-active", detail: "another client claimed the session twice" });
    }
    notActiveRetries += 1;
    const res = await attempt();
    if (res && !res.ok && res.reason.kind === "not-active") {
      throw new SyncAborted(res.reason);
    }
    return res;
  }

  /**
   * A push the server refused. For anything that will never succeed as-is, a `.prsv` of the local
   * save is written *first* so the user can import it by hand — then it is reported, with the path
   * (or `null` when even that failed) in `result.unrecoverable`.
   */
  async function handlePushRejection(
    kind: "system" | "session",
    slot: number | null,
    local: SystemSave | SessionSave,
    reason: ClassifiedError,
  ): Promise<void> {
    const target = kind === "system" ? "system" : `session${slot}`;
    if (reason.kind === "offline") {
      throw new SyncAborted(reason);
    }
    if (reason.kind === "needs-game-update" || reason.kind === "version-too-low") {
      result.needsGameUpdate = true;
    }
    // `unknown-rejection` still means "do nothing, keep the save dirty, try again next time"
    // (DESIGN §3.9), but "fail safe" has to include "nothing is lost": if the rejection turns out
    // to be permanent, she must already have an importable copy. The file uses `reason: "rejected"`
    // so it is never pruned and is obvious in the backups folder.
    // (DECISIONS.md 2026-09-13, NOTES-sync.md §7.1.)
    const unrecoverable = isUnrecoverablePush(reason);
    if (unrecoverable || reason.kind === "unknown-rejection") {
      let backupPath: string | null = null;
      const backupReason: BackupReason = unrecoverable ? "conflict" : "rejected";
      try {
        backupPath = await backup.backup(kind, slot, local, backupReason);
        log.warn("push refused; exported a backup the user can import by hand", { target, path: backupPath });
      } catch (err) {
        log.error("could not write the fallback backup", { target, err: String(err) });
      }
      result.errors.push(`${target}:${reason.kind}`);
      if (backupPath === null) {
        result.errors.push(`${target}:backup-failed`);
      }
      result.unrecoverable.push({ what: target, reason, backupPath });
      return;
    }
    result.errors.push(`${target}:${reason.kind}`);
    // `dirty` is untouched, so the next sync will try again.
  }

  async function getSystemOrThrow(a: UpstreamApi, id: string): Promise<SystemSave | null> {
    const res = await a.getSystem(id);
    if (res.ok) {
      return res.data;
    }
    throw new SyncAborted(res.reason);
  }

  async function getSessionOrThrow(a: UpstreamApi, slot: number, id: string): Promise<SessionSave | null> {
    const res = await a.getSession(slot, id);
    if (res.ok) {
      return res.data;
    }
    throw new SyncAborted(res.reason);
  }
}

function isEverythingFresh(mirror: MirrorPort, nowMs: number, freshnessMs: number): boolean {
  const sys = mirror.readSystem();
  const sysAt = isoToMs(sys.baseFetchedAt);
  if (sys.dirty || sysAt === null || nowMs - sysAt >= freshnessMs) {
    return false;
  }
  for (let slot = 0; slot < SESSION_SLOTS; slot++) {
    const rec = mirror.readSession(slot);
    const at = isoToMs(rec.baseFetchedAt);
    if (rec.dirty || at === null || nowMs - at >= freshnessMs) {
      return false;
    }
    if (typeof rec.clearedAt === "string" && rec.clearedAt.length > 0) {
      return false; // an offline clear is still waiting to be propagated
    }
  }
  return true;
}

function finishState(mirror: MirrorPort, nowMs: number, result: SyncResult): void {
  try {
    mirror.writeState({
      lastSyncAt: new Date(nowMs).toISOString(),
      lastSyncResult: result.errors.length > 0 ? "error" : result.conflicts.length > 0 ? "conflict" : "ok",
    });
  } catch {
    /* the mirror is best-effort here; never fail a sync over bookkeeping */
  }
}

/** Plain wording for the status line. Never technical, never an error code. */
export function summarise(result: SyncResult): string {
  const parts: string[] = [];
  const saved = result.pushed.length;
  const got = result.pulled.length;
  if (saved > 0 && got > 0) {
    parts.push("Your progress was saved online and the newer progress from online was brought over.");
  } else if (saved > 0) {
    parts.push(saved === 1 ? "Your progress was saved online." : "Your progress and runs were saved online.");
  } else if (got > 0) {
    parts.push("The progress you made elsewhere was brought over to this computer.");
  } else if (result.errors.length === 0 && result.conflicts.length === 0) {
    parts.push("Everything was already up to date.");
  }
  if (result.conflicts.length > 0) {
    parts.push(
      result.conflicts.length === 1
        ? "One save was different in both places, so the one you chose was kept and the other was saved to your Documents folder."
        : "Some saves were different in both places, so the ones you chose were kept and the others were saved to your Documents folder.",
    );
  }
  if (result.needsGameUpdate) {
    parts.push("The game needs to be updated before your progress can be saved online again.");
  } else if (result.unrecoverable.length > 0) {
    parts.push(
      "Some progress could not be saved online. A copy was put in your Documents folder so nothing is lost.",
    );
  } else if (result.errors.length > 0) {
    parts.push("Something could not be saved online this time. Your progress is safe on this computer.");
  }
  return parts.join(" ");
}
