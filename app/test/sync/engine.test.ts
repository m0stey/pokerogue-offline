import { describe, expect, it, vi } from "vitest";
import { runSync, summarise } from "../../src/sync/engine";
import type { ConflictPolicyPort, SyncDeps } from "../../src/sync/engine";
import { systemEquals } from "../../src/sync/compare";
import type { SessionSave, SystemSave } from "../../src/sync/types";
import {
  CallLog,
  FakeBackupManager,
  FakeMirror,
  FakeUpstreamApi,
  NOW_ISO,
  NOW_MS,
  advanceSession,
  advanceSystem,
  makeSession,
  makeSystem,
} from "./fakes";

/** An empty SyncResult, for exercising `summarise` directly. */
const emptyResult = () => ({
  pushed: [] as string[],
  pulled: [] as string[],
  conflicts: [] as string[],
  errors: [] as string[],
  warnings: [] as string[],
  needsGameUpdate: false,
  unrecoverable: [] as { what: string; reason: never; backupPath: string | null }[],
  summary: "",
});

const BASE_SYSTEM = makeSystem();
const BASE_SESSION = makeSession();

function policy(mode: ConflictPolicyPort["mode"], answer: "this-computer" | "online" = "this-computer") {
  const ask = vi.fn(async () => answer);
  return { port: { mode, ask } as ConflictPolicyPort, ask };
}

interface Rig {
  log: CallLog;
  mirror: FakeMirror;
  api: FakeUpstreamApi;
  backup: FakeBackupManager;
  deps: SyncDeps;
  ask: ReturnType<typeof vi.fn>;
}

function rig(init: {
  mirror?: ConstructorParameters<typeof FakeMirror>[0];
  api?: ConstructorParameters<typeof FakeUpstreamApi>[0];
  mode?: ConflictPolicyPort["mode"];
  answer?: "this-computer" | "online";
}): Rig {
  const log: CallLog = [];
  const mirror = new FakeMirror({ ...init.mirror, log });
  const api = new FakeUpstreamApi({ ...init.api, log });
  const backup = new FakeBackupManager(log);
  const p = policy(init.mode ?? "prefer-this-computer", init.answer);
  return {
    log,
    mirror,
    api,
    backup,
    ask: p.ask,
    deps: { mirror, api, backup, policy: p.port, now: () => NOW_MS },
  };
}

const order = (log: CallLog, a: string, b: string) => {
  const ia = log.indexOf(a);
  const ib = log.indexOf(b);
  expect(ia, `${a} should have happened`).toBeGreaterThanOrEqual(0);
  expect(ib, `${b} should have happened`).toBeGreaterThanOrEqual(0);
  expect(ia, `${a} should come before ${b} — got ${JSON.stringify(log)}`).toBeLessThan(ib);
};

describe("nothing to do", () => {
  it("skips entirely when nothing is dirty and the base is fresh", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: BASE_SYSTEM, baseFetchedAt: NOW_ISO },
        sessions: Array.from({ length: 5 }, () => ({ baseFetchedAt: NOW_ISO })),
      },
    });
    const res = await runSync(r.deps);
    expect(res).toMatchObject({ pushed: [], pulled: [], conflicts: [], errors: [], warnings: [] });
    expect(res.summary).toBe("Everything was already up to date.");
    expect(r.api.countOf("getSystem")).toBe(0);
  });

  it("still syncs when the base is stale, even with nothing dirty", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: BASE_SYSTEM, baseFetchedAt: "2020-01-01T00:00:00.000Z" },
        sessions: Array.from({ length: 5 }, () => ({ baseFetchedAt: "2020-01-01T00:00:00.000Z" })),
      },
      api: { system: BASE_SYSTEM },
    });
    await runSync(r.deps);
    expect(r.api.countOf("getSystem")).toBe(1);
  });

  it("does not skip while an offline clear is still waiting to be propagated", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: BASE_SYSTEM, baseFetchedAt: NOW_ISO },
        sessions: [
          { base: BASE_SESSION, local: null, clearedAt: NOW_ISO, baseFetchedAt: NOW_ISO },
          ...Array.from({ length: 4 }, () => ({ baseFetchedAt: NOW_ISO })),
        ],
      },
      api: { system: BASE_SYSTEM, sessions: [BASE_SESSION] },
    });
    await runSync(r.deps);
    expect(r.api.countOf("getSystem")).toBeGreaterThan(0);
  });

  it("refuses to run without a clientSessionId (Invariant §4.4)", async () => {
    const r = rig({ mirror: { state: { clientSessionId: "" } } });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["no-client-session-id"]);
    expect(r.api.countOf("getSystem")).toBe(0);
  });
});

describe("fast-forward push", () => {
  it("pushes the local system save when only this computer moved on", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local } },
      api: { system: BASE_SYSTEM },
    });
    const res = await runSync(r.deps);

    expect(res.pushed).toEqual(["system"]);
    expect(res.pulled).toEqual([]);
    expect(res.conflicts).toEqual([]);
    expect(res.errors).toEqual([]);
    expect(systemEquals(r.api.system, local)).toBe(true);
    expect(r.mirror.readSystem().dirty).toBe(false);
    expect(res.summary).toBe("Your progress was saved online.");
  });

  it("backs up the server's copy BEFORE overwriting it (Invariant §4.1)", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    await runSync(r.deps);

    order(r.log, "backup.system.update", "api.updateSystem");
    expect(r.backup.written).toHaveLength(1);
    expect(r.backup.written[0]).toMatchObject({ kind: "system", slot: null, reason: "update" });
    expect(systemEquals(r.backup.written[0]!.save as SystemSave, BASE_SYSTEM)).toBe(true);
  });

  it("does not back up an empty server slot — there is nothing to replace", async () => {
    const r = rig({ mirror: { system: { base: null, local: BASE_SYSTEM } }, api: { system: null } });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["system"]);
    expect(r.backup.written).toHaveLength(0);
  });

  it("pushes the system save before any session (DESIGN.md §3.8(5))", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) },
        sessions: [{ base: BASE_SESSION, local: advanceSession(BASE_SESSION) }],
      },
      api: { system: BASE_SYSTEM, sessions: [BASE_SESSION] },
    });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["system", "session0"]);
    order(r.log, "api.updateSystem", "api.updateSession0");
  });

  it("fast-forwards when both sides moved but the local save descends from the remote", async () => {
    const remote = advanceSystem(BASE_SYSTEM);
    const local = advanceSystem(remote);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: remote } });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["system"]);
    expect(res.conflicts).toEqual([]);
    expect(r.ask).not.toHaveBeenCalled();
  });
});

describe("pull", () => {
  it("pulls when only the server moved on, backing up the local copy first", async () => {
    const remote = advanceSystem(BASE_SYSTEM);
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local: BASE_SYSTEM } },
      api: { system: remote },
    });
    const res = await runSync(r.deps);

    expect(res.pulled).toEqual(["system"]);
    expect(systemEquals(r.mirror.readSystem().local, remote)).toBe(true);
    expect(r.mirror.readSystem().dirty).toBe(false);
    order(r.log, "backup.system.update", "mirror.writeLocalSystem");
    expect(r.backup.written[0]).toMatchObject({ kind: "system", reason: "update" });
    expect(res.summary).toBe("The progress you made elsewhere was brought over to this computer.");
  });

  it("pulls a session into an empty local slot without a backup", async () => {
    const r = rig({ mirror: {}, api: { sessions: [BASE_SESSION] } });
    const res = await runSync(r.deps);
    expect(res.pulled).toEqual(["session0"]);
    expect(r.backup.written).toHaveLength(0);
    expect(r.mirror.readSession(0).local).not.toBeNull();
  });

  it("clears a local session the server no longer has — but only after a backup", async () => {
    const r = rig({
      mirror: { sessions: [{ base: BASE_SESSION, local: BASE_SESSION }] },
      api: { sessions: [null] },
    });
    const res = await runSync(r.deps);
    expect(res.pulled).toEqual(["session0"]);
    order(r.log, "backup.session0.update", "mirror.deleteLocalSession0");
    expect(r.mirror.readSession(0).local).toBeNull();
    expect(r.mirror.readSession(0).base).toBeNull();
  });

  it("restores the system save instead of clearing it when the server has none", async () => {
    // base == local, remote == null: the literal rule says "pull", but that would delete the only
    // copy of the profile. Pushing into an empty account is always safe.
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local: BASE_SYSTEM, baseFetchedAt: 0 } },
      api: { system: null },
    });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["system"]);
    expect(r.mirror.readSystem().local).not.toBeNull();
  });
});

describe("conflicts", () => {
  // Two saves that moved apart: neither descends from the other.
  const local = makeSystem({ timestamp: 1789231700000, gameStats: { playTime: 1100, battles: 5 } });
  const remote = makeSystem({ timestamp: 1789231900000, gameStats: { playTime: 1050, battles: 9 } });

  it("prefer-this-computer pushes, after backing up the online copy as a conflict", async () => {
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local } },
      api: { system: remote },
      mode: "prefer-this-computer",
    });
    const res = await runSync(r.deps);
    expect(res.conflicts).toEqual(["system"]);
    expect(res.pushed).toEqual(["system"]);
    expect(r.ask).not.toHaveBeenCalled();
    expect(r.backup.written[0]).toMatchObject({ reason: "conflict" });
    order(r.log, "backup.system.conflict", "api.updateSystem");
    expect(systemEquals(r.api.system, local)).toBe(true);
  });

  it("prefer-online pulls, after backing up this computer's copy as a conflict", async () => {
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local } },
      api: { system: remote },
      mode: "prefer-online",
    });
    const res = await runSync(r.deps);
    expect(res.conflicts).toEqual(["system"]);
    expect(res.pulled).toEqual(["system"]);
    expect(r.backup.written[0]).toMatchObject({ reason: "conflict" });
    expect(systemEquals(r.backup.written[0]!.save as SystemSave, local)).toBe(true);
    // Invariant §4.6: a non-descendant remote only replaces local behind a policy decision AND a backup.
    order(r.log, "backup.system.conflict", "mirror.writeLocalSystem");
    expect(systemEquals(r.mirror.readSystem().local, remote)).toBe(true);
  });

  it("ask asks once and reuses the answer for the rest of the run", async () => {
    const localSess = makeSession({ seed: "LOCALSEED0001", waveIndex: 4, timestamp: 1789231800000 });
    const remoteSess = makeSession({ seed: "ONLINESEED001", waveIndex: 9, timestamp: 1789231810000 });
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local },
        sessions: [{ base: BASE_SESSION, local: localSess }],
      },
      api: { system: remote, sessions: [remoteSess] },
      mode: "ask",
      answer: "this-computer",
    });
    const res = await runSync(r.deps);
    expect(res.conflicts).toEqual(["system", "session0"]);
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(res.pushed).toEqual(["system", "session0"]);
  });

  it("the ask dialog gets plain facts about both sides", async () => {
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local } },
      api: { system: remote },
      mode: "ask",
      answer: "online",
    });
    await runSync(r.deps);
    expect(r.ask).toHaveBeenCalledWith({
      kind: "system",
      slot: null,
      target: "system",
      thisComputer: { playTime: 1100, timestamp: 1789231700000, waveIndex: null, seed: null },
      online: { playTime: 1050, timestamp: 1789231900000, waveIndex: null, seed: null },
    });
  });

  it("a conflicted save is never replaced without a backup", async () => {
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local } },
      api: { system: remote },
      mode: "ask",
      answer: "online",
    });
    await runSync(r.deps);
    expect(r.backup.written.some((b) => b.reason === "conflict")).toBe(true);
  });
});

describe("`not active` (Invariant §4.4)", () => {
  it("re-claims the session, re-decides and retries once", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = ({ call }) =>
      call === 1
        ? { ok: false, status: 400, reason: { kind: "not-active", detail: "not active" }, raw: "" }
        : null;

    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["system"]);
    expect(res.errors).toEqual([]);
    expect(r.api.countOf("updateSystem")).toBe(2);
    // The retry re-GETs first (claiming the id again) and then reads back after the push.
    expect(r.api.countOf("getSystem")).toBe(3);
    // …and the retry re-claims before it re-sends: get, update(fail), get, update(ok), get.
    expect(r.log.filter((c) => c === "api.getSystem" || c === "api.updateSystem")).toEqual([
      "api.getSystem",
      "api.updateSystem",
      "api.getSystem",
      "api.updateSystem",
      "api.getSystem",
    ]);
  });

  it("stops after the second rejection rather than fighting the other client", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "not-active", detail: "not active" },
      raw: "",
    });

    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["not-active"]);
    expect(res.pushed).toEqual([]);
    expect(r.api.countOf("updateSystem")).toBe(2);
    expect(r.mirror.readSystem().dirty).toBe(true);
    expect(res.summary).toMatch(/somewhere else/i);
  });

  it("drops the push when the re-decide says it is no longer needed", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = ({ call }) =>
      call === 1
        ? { ok: false, status: 400, reason: { kind: "not-active", detail: "not active" }, raw: "" }
        : null;
    // On the re-GET the other client has already uploaded exactly our save.
    r.api.onGetSystem = ({ call }) => (call === 2 ? { ok: true, status: 200, data: local } : null);

    const res = await runSync(r.deps);
    expect(res.pushed).toEqual([]);
    expect(r.api.countOf("updateSystem")).toBe(1);
  });
});

describe("rejections the server will never accept", () => {
  it("playtime rejection keeps the save dirty and leaves an importable backup", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "playtime-lower", detail: "session out of date: existing playtime is greater" },
      raw: "",
    });

    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["system:playtime-lower"]);
    expect(res.pushed).toEqual([]);
    expect(r.mirror.readSystem().dirty).toBe(true);
    expect(systemEquals(r.mirror.readSystem().base, BASE_SYSTEM)).toBe(true);

    const fallback = r.backup.written.find((b) => b.reason === "conflict");
    expect(fallback, "an importable .prsv of the local save must exist").toBeTruthy();
    expect(systemEquals(fallback!.save as SystemSave, local)).toBe(true);
    // The shell reads this instead of substring-matching `errors`.
    expect(res.unrecoverable).toHaveLength(1);
    expect(res.unrecoverable[0]!.what).toBe("system");
    expect(res.unrecoverable[0]!.reason.kind).toBe("playtime-lower");
    expect(res.unrecoverable[0]!.backupPath).toBe(fallback!.path);
    expect(res.needsGameUpdate).toBe(false);
    expect(res.summary).toMatch(/nothing is lost/i);
  });

  it("sets needsGameUpdate and still exports a backup", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "needs-game-update", detail: "session out of date: existing version is greater" },
      raw: "",
    });
    const res = await runSync(r.deps);
    expect(res.needsGameUpdate).toBe(true);
    expect(res.unrecoverable).toHaveLength(1);
    expect(res.unrecoverable[0]!.backupPath).toBeTruthy();
    expect(res.summary).toMatch(/updated/i);
  });

  it("sets needsGameUpdate for a save below the server minimum too", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "version-too-low", detail: "" },
      raw: "",
    });
    const res = await runSync(r.deps);
    expect(res.needsGameUpdate).toBe(true);
  });

  it("a version rejection is reported without touching the mirror", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "needs-game-update", detail: "session out of date: existing version is greater" },
      raw: "",
    });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["system:needs-game-update"]);
    expect(r.log).not.toContain("mirror.setBaseSystem");
  });

  it("an unknown rejection changes nothing at all (fail safe)", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "unknown-rejection", detail: "brand new error", status: 400 },
      raw: "",
    });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["system:unknown-rejection"]);
    expect(r.backup.written.filter((b) => b.reason === "conflict")).toHaveLength(0);
    expect(r.mirror.readSystem().dirty).toBe(true);
  });

  it("reports when even the fallback backup cannot be written", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: null, local } }, api: { system: null } });
    r.api.onUpdateSystem = () => ({
      ok: false,
      status: 400,
      reason: { kind: "id-mismatch", detail: "" },
      raw: "",
    });
    r.backup.failNext = true;
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["system:id-mismatch", "system:backup-failed"]);
    expect(res.unrecoverable).toEqual([
      { what: "system", reason: { kind: "id-mismatch", detail: "" }, backupPath: null },
    ]);
  });
});

describe("propagating a run finished offline (DESIGN.md §3.8, amended)", () => {
  /** The mirror state the proxy leaves behind after `clearLocalSession`. */
  const clearedSlot = { base: BASE_SESSION, local: null, clearedAt: "2026-09-12T10:00:00.000Z" };

  it("deletes the slot online — after a verified backup of the server's copy", async () => {
    const r = rig({ mirror: { sessions: [clearedSlot] }, api: { sessions: [BASE_SESSION] } });
    const res = await runSync(r.deps);

    expect(res.pushed).toEqual(["session0"]);
    expect(res.errors).toEqual([]);
    expect(r.api.countOf("deleteSession0")).toBe(1);
    // Invariant §4.1: the backup is written first, and it holds the server's copy.
    order(r.log, "backup.session0.update", "api.deleteSession0");
    expect(r.backup.written).toHaveLength(1);
    expect(r.backup.written[0]).toMatchObject({ kind: "session", slot: 0, reason: "update" });
    expect(r.backup.written[0]!.save).toMatchObject({ seed: BASE_SESSION.seed });
    // and the slot is settled: nothing local, nothing online, no leftover clear marker.
    expect(r.api.sessions[0]).toBeNull();
    expect(r.mirror.readSession(0)).toMatchObject({ base: null, local: null, dirty: false, clearedAt: null });
  });

  it("verifies the slot really is gone before settling the mirror", async () => {
    const r = rig({ mirror: { sessions: [clearedSlot] }, api: { sessions: [BASE_SESSION] } });
    // The delete "succeeds" but the slot is still there.
    r.api.onDeleteSession = () => ({ ok: true, status: 200, data: null });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:verify-failed"]);
    expect(res.pushed).toEqual([]);
    expect(r.mirror.readSession(0).base).not.toBeNull();
  });

  it("never deletes when the backup could not be written", async () => {
    const r = rig({ mirror: { sessions: [clearedSlot] }, api: { sessions: [BASE_SESSION] } });
    r.backup.failNext = true;
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:backup-failed"]);
    expect(r.api.countOf("deleteSession0")).toBe(0);
    expect(r.api.sessions[0]).not.toBeNull();
  });

  it("reports a refused delete and leaves the clear pending", async () => {
    const r = rig({ mirror: { sessions: [clearedSlot] }, api: { sessions: [BASE_SESSION] } });
    r.api.onDeleteSession = () => ({
      ok: false,
      status: 400,
      reason: { kind: "unknown-rejection", detail: "nope", status: 400 },
      raw: "nope",
    });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:unknown-rejection"]);
    expect(r.mirror.readSession(0).clearedAt).toBe("2026-09-12T10:00:00.000Z");
  });

  it("aborts the whole run when the delete comes back as offline", async () => {
    const r = rig({ mirror: { sessions: [clearedSlot] }, api: { sessions: [BASE_SESSION] } });
    r.api.onDeleteSession = () => ({
      ok: false,
      status: 403,
      reason: { kind: "offline", detail: "html", status: 403 },
      raw: "<html>",
    });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["offline"]);
  });

  describe("each precondition on its own blocks the delete", () => {
    const cases: [string, Parameters<typeof rig>[0]][] = [
      [
        "local is not null (the game wrote a new run here)",
        {
          mirror: { sessions: [{ base: BASE_SESSION, local: advanceSession(BASE_SESSION), clearedAt: "x" }] },
          api: { sessions: [BASE_SESSION] },
        },
      ],
      [
        "no clearedAt recorded (the slot is just empty)",
        { mirror: { sessions: [{ base: BASE_SESSION, local: null }] }, api: { sessions: [BASE_SESSION] } },
      ],
      [
        "clearedAt is an empty string",
        {
          mirror: { sessions: [{ base: BASE_SESSION, local: null, clearedAt: "" }] },
          api: { sessions: [BASE_SESSION] },
        },
      ],
      [
        "base is null (we never knew what the server had)",
        {
          mirror: { sessions: [{ base: null, local: null, clearedAt: "2026-09-12T10:00:00.000Z" }] },
          api: { sessions: [BASE_SESSION] },
        },
      ],
      [
        "remote differs from base (somebody played online since)",
        {
          mirror: { sessions: [{ base: BASE_SESSION, local: null, clearedAt: "2026-09-12T10:00:00.000Z" }] },
          api: { sessions: [advanceSession(BASE_SESSION, 4)] },
        },
      ],
      [
        "remote is null (the server has already forgotten the run)",
        {
          mirror: { sessions: [{ base: BASE_SESSION, local: null, clearedAt: "2026-09-12T10:00:00.000Z" }] },
          api: { sessions: [null] },
        },
      ],
    ];

    for (const [name, init] of cases) {
      it(name, async () => {
        const r = rig(init);
        await runSync(r.deps);
        expect(r.api.countOf("deleteSession0")).toBe(0);
      });
    }

    it("falls back to a normal reconcile in those cases", async () => {
      // local is null and remote has a run -> plain pull, no delete.
      const r = rig({
        mirror: { sessions: [{ base: BASE_SESSION, local: null }] },
        api: { sessions: [BASE_SESSION] },
      });
      const res = await runSync(r.deps);
      expect(r.api.countOf("deleteSession0")).toBe(0);
      expect(res.pulled).toEqual(["session0"]);
    });
  });

  it("does not touch other slots", async () => {
    const r = rig({
      mirror: { sessions: [clearedSlot, { base: BASE_SESSION, local: BASE_SESSION }] },
      api: { sessions: [BASE_SESSION, BASE_SESSION] },
    });
    await runSync(r.deps);
    expect(r.api.countOf("deleteSession1")).toBe(0);
    expect(r.api.sessions[1]).not.toBeNull();
  });
});

describe("going offline mid-sync (Invariant §4.2)", () => {
  it("aborts cleanly with nothing half-written when HTML arrives", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) },
        sessions: [{ base: BASE_SESSION, local: advanceSession(BASE_SESSION) }],
      },
      api: { system: BASE_SYSTEM, sessions: [BASE_SESSION] },
    });
    // Cloudflare interstitial on the third slot, i.e. during the decision phase.
    r.api.onGetSession = (slot) =>
      slot === 2
        ? {
            ok: false,
            status: 403,
            reason: { kind: "offline", detail: "HTTP 403 HTML page (not the game server)", status: 403 },
            raw: "<!DOCTYPE html>",
          }
        : null;

    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["offline"]);
    expect(res.pushed).toEqual([]);
    expect(res.pulled).toEqual([]);
    expect(r.backup.written).toEqual([]);
    expect(r.log.filter((c) => c.startsWith("mirror.write") || c.startsWith("mirror.setBase"))).toEqual([]);
    expect(r.api.countOf("updateSystem")).toBe(0);
    expect(res.summary).toMatch(/no internet/i);
  });

  it("aborts without updating the base when the connection drops during the read-back", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onGetSystem = ({ call }) =>
      call === 2
        ? { ok: false, status: 0, reason: { kind: "offline", detail: "socket hang up" }, raw: "" }
        : null;
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["offline"]);
    expect(res.pushed).toEqual([]);
    expect(r.log).not.toContain("mirror.setBaseSystem");
    expect(r.mirror.readSystem().dirty).toBe(true);
  });

  it("a transport failure on the very first call does nothing at all", async () => {
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) } } });
    r.api.onGetSystem = () => ({
      ok: false,
      status: 0,
      reason: { kind: "offline", detail: "ENOTFOUND" },
      raw: "",
    });
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["offline"]);
    expect(r.log.filter((c) => c.startsWith("mirror.") || c.startsWith("backup."))).toEqual([]);
  });
});

describe("sessions", () => {
  it("re-reads the slot immediately before pushing and notices a remote change", async () => {
    const local = advanceSession(BASE_SESSION, 1);
    const movedOn = advanceSession(BASE_SESSION, 5);
    const r = rig({
      mirror: { sessions: [{ base: BASE_SESSION, local }] },
      api: { sessions: [BASE_SESSION] },
    });
    // call 1 = the decision GET, call 2 = the re-check right before the push.
    r.api.onGetSession = (slot, { call }) =>
      slot === 0 && call === 2 ? { ok: true, status: 200, data: movedOn } : null;

    const res = await runSync(r.deps);
    expect(r.api.countOf("updateSession0")).toBe(0); // the push was abandoned
    expect(res.pushed).toEqual([]);
    expect(res.pulled).toEqual(["session0"]); // the online run is further along
    expect(r.mirror.readSession(0).local).toMatchObject({ waveIndex: 6 });
  });

  it("goes through with the push when the re-check shows nothing changed", async () => {
    const local = advanceSession(BASE_SESSION, 1);
    const r = rig({
      mirror: { sessions: [{ base: BASE_SESSION, local }] },
      api: { sessions: [BASE_SESSION] },
    });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["session0"]);
    expect(r.api.countOf("getSession0")).toBe(3); // decide, re-check, read back
    order(r.log, "backup.session0.update", "api.updateSession0");
  });

  it("handles all five slots independently", async () => {
    const r = rig({
      mirror: {
        sessions: [
          { base: BASE_SESSION, local: advanceSession(BASE_SESSION) }, // push
          {}, // pull
          { base: BASE_SESSION, local: BASE_SESSION }, // noop
          null,
          null,
        ],
      },
      api: { sessions: [BASE_SESSION, makeSession({ seed: "ONLINEONLY001" }), BASE_SESSION, null, null] },
    });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["session0"]);
    expect(res.pulled).toEqual(["session1"]);
    expect(res.errors).toEqual([]);
  });

  it("tolerates the server dropping playerFaints on the read-back", async () => {
    const local = advanceSession(makeSession({ playerFaints: 3 }), 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["session0"]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual(["session0:dropped-fields:playerFaints"]);
  });

  it("warns (but does not fail) when the server drops a field nobody knew about", async () => {
    const local = advanceSession(makeSession({ someFutureField: "canary" } as never), 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["session0"]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual(["session0:dropped-fields:playerFaints,someFutureField"]);
    expect(r.mirror.readSession(0).dirty).toBe(false); // and it does not retry forever
  });

  it("pushing a save the server keeps whole produces no warning", async () => {
    // A save with nothing the server's struct lacks: no `playerFaints`, no future fields.
    const whole = { ...makeSession() } as Record<string, unknown>;
    delete whole["playerFaints"];
    const local = advanceSession(whole as SessionSave, 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    const res = await runSync(r.deps);
    expect(res.pushed).toEqual(["session0"]);
    expect(res.warnings).toEqual([]);
    expect(res.errors).toEqual([]);
  });
});

describe("read-back verification (DESIGN.md §3.8(6))", () => {
  it("reports an error and keeps the save dirty when the server did not store what we sent", async () => {
    const local = advanceSystem(BASE_SYSTEM);
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local } }, api: { system: BASE_SYSTEM } });
    r.api.onGetSystem = ({ call }) =>
      call === 2 ? { ok: true, status: 200, data: makeSystem({ gender: 1 }) as SystemSave } : null;

    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["system:verify-failed"]);
    expect(res.pushed).toEqual([]);
    expect(r.mirror.readSystem().dirty).toBe(true);
    expect(systemEquals(r.mirror.readSystem().base, BASE_SYSTEM)).toBe(true);
  });

  it("does the same for a session slot when a key the server kept differs", async () => {
    const local = advanceSession(BASE_SESSION, 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    r.api.onGetSession = (slot, { call }) =>
      slot === 0 && call === 3
        ? { ok: true, status: 200, data: makeSession({ money: 99999 }) as SessionSave }
        : null;

    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:verify-failed"]);
    expect(r.mirror.readSession(0).dirty).toBe(true);
  });

  it("fails when a critical field is missing from the server's copy", async () => {
    const local = advanceSession(BASE_SESSION, 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    r.api.onGetSession = (slot, { call }) => {
      if (slot !== 0 || call !== 3) {
        return null;
      }
      const stripped = { ...local } as Record<string, unknown>;
      delete stripped["party"]; // a dropped *critical* field is never just a warning
      return { ok: true, status: 200, data: stripped as SessionSave };
    };
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:verify-failed"]);
    expect(res.warnings).toEqual([]);
    expect(r.mirror.readSession(0).dirty).toBe(true);
  });

  it("fails when the slot is empty after a push", async () => {
    const local = advanceSession(BASE_SESSION, 1);
    const r = rig({ mirror: { sessions: [{ base: BASE_SESSION, local }] }, api: { sessions: [BASE_SESSION] } });
    r.api.onGetSession = (slot, { call }) =>
      slot === 0 && call === 3 ? { ok: true, status: 404, data: null } : null;
    const res = await runSync(r.deps);
    expect(res.errors).toEqual(["session0:verify-failed"]);
  });
});

describe("bookkeeping and wording", () => {
  it("records the outcome in the mirror state", async () => {
    const r = rig({
      mirror: { system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) } },
      api: { system: BASE_SYSTEM },
    });
    await runSync(r.deps);
    expect(r.mirror.readState()).toMatchObject({
      lastSyncAt: NOW_ISO,
      lastSyncResult: "ok",
    });
  });

  it("marks a run with errors", async () => {
    const r = rig({ mirror: { system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) } } });
    r.api.onGetSystem = () => ({ ok: false, status: 0, reason: { kind: "offline", detail: "x" }, raw: "" });
    await runSync(r.deps);
    expect(r.mirror.readState().lastSyncResult).toBe("error");
  });

  it("summaries stay free of technical language", () => {
    const summaries = [
      summarise({ ...emptyResult(), pushed: ["system"] }),
      summarise({ ...emptyResult(), pulled: ["session1"] }),
      summarise({ ...emptyResult(), pushed: ["system"], pulled: ["session1"] }),
      summarise({ ...emptyResult(), conflicts: ["system"] }),
      summarise({ ...emptyResult(), conflicts: ["system", "session1"] }),
      summarise({ ...emptyResult(), errors: ["system:playtime-lower"] }),
      summarise({
        ...emptyResult(),
        errors: ["system:playtime-lower"],
        unrecoverable: [{ what: "system", reason: {} as never, backupPath: "C:\\x.prsv" }],
      }),
      summarise({ ...emptyResult(), errors: ["system:needs-game-update"], needsGameUpdate: true }),
      summarise({ ...emptyResult(), warnings: ["session0:dropped-fields:playerFaints"] }),
      summarise(emptyResult()),
    ];
    for (const s of summaries) {
      expect(s.length).toBeGreaterThan(10);
      expect(s).not.toMatch(
        /sync|push|pull|server|session\d|system|API|HTTP|null|dirty|clientSessionId|prsv|JSON/i,
      );
    }
  });

  it("warnings never leak into the summary", () => {
    const s = summarise({ ...emptyResult(), pushed: ["session0"], warnings: ["session0:dropped-fields:x"] });
    expect(s).toBe("Your progress was saved online.");
  });
});

describe("Invariant §4.7 — the engine never touches the destructive endpoints", () => {
  it("only ever calls get/update", async () => {
    const r = rig({
      mirror: {
        system: { base: BASE_SYSTEM, local: advanceSystem(BASE_SYSTEM) },
        sessions: [{ base: BASE_SESSION, local: advanceSession(BASE_SESSION) }, {}],
      },
      api: { system: BASE_SYSTEM, sessions: [BASE_SESSION, makeSession({ seed: "ONLINE0001" })] },
    });
    await runSync(r.deps);
    for (const call of r.log.filter((c) => c.startsWith("api."))) {
      expect(call).toMatch(/^api\.(getSystem|updateSystem|getSession\d|updateSession\d|accountInfo)$/);
    }
    expect(r.log.join(" ")).not.toMatch(/clear|newclear|verify|delete(?!LocalSession)/);
  });
});
