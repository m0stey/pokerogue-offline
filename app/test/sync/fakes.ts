// In-memory doubles for the sync engine's collaborators. Everything records into one shared call
// log so tests can assert ordering (e.g. "a backup was written before the overwrite").

import { structurallyEqual } from "../../src/sync/compare";
import type { BackupKind, BackupManager, BackupReason } from "../../src/sync/backup";
import type {
  AccountRecord,
  MirrorPort,
  MirrorStateRecord,
  SessionRecord,
  SystemRecord,
} from "../../src/sync/mirror-port";
import type { ApiResult, UpstreamApi } from "../../src/sync/upstream-api";
import type { AccountInfo, SaveSnapshot, SessionSave, SystemSave } from "../../src/sync/types";
import { SESSION_SLOTS } from "../../src/sync/types";

export type CallLog = string[];

/** One fixed instant for every test. Mirror timestamps are ISO-8601 strings on disk. */
export const NOW_MS = Date.parse("2026-09-12T12:00:00.000Z");
export const NOW_ISO = new Date(NOW_MS).toISOString();

// --- saves ---------------------------------------------------------------------------------------

export function makeSystem(over: Partial<SystemSave> = {}): SystemSave {
  return {
    trainerId: 60746,
    secretId: 44388,
    gender: 0,
    dexData: {},
    starterData: {},
    gameStats: { playTime: 1000, battles: 0, pokemonCaught: 0, pokemonSeen: 0 },
    unlocks: {},
    achvUnlocks: {},
    voucherUnlocks: {},
    voucherCounts: { "0": 0, "1": 0, "2": 0, "3": 0 },
    eggs: [],
    eggPity: [0, 0, 0, 0],
    unlockPity: [0, 0, 0, 0],
    gameVersion: "1.12.1.0",
    timestamp: 1789231606586,
    appliedMigrators: {},
    ...over,
  } as SystemSave;
}

/** A system save that is a legitimate continuation of {@link makeSystem}. */
export function advanceSystem(base: SystemSave, by = 60): SystemSave {
  const stats = base.gameStats as Record<string, unknown>;
  return {
    ...base,
    timestamp: (base.timestamp as number) + 1000,
    gameStats: { ...stats, playTime: (stats["playTime"] as number) + by, battles: ((stats["battles"] as number) ?? 0) + 1 },
  } as SystemSave;
}

export function makeSession(over: Partial<SessionSave> = {}): SessionSave {
  return {
    seed: "PROBESEED0001",
    playTime: 120,
    gameMode: 0,
    party: [{ id: 1, species: 1, level: 5 }],
    enemyParty: [],
    modifiers: [],
    enemyModifiers: [],
    arena: { biome: 0, tags: [], weather: null, terrain: null },
    pokeballCounts: { "0": 5 },
    money: 1000,
    score: 0,
    waveIndex: 1,
    battleType: 0,
    trainer: null,
    gameVersion: "1.12.1.0",
    timestamp: 1789231745765,
    challenges: [],
    mysteryEncounterType: -1,
    mysteryEncounterSaveData: { encounteredEvents: [], encounterSpawnChance: 1, queuedEncounters: [] },
    name: "probe run",
    playerFaints: 0,
    ...over,
  } as SessionSave;
}

export function advanceSession(base: SessionSave, waves = 1): SessionSave {
  return {
    ...base,
    waveIndex: (base.waveIndex as number) + waves,
    playTime: (base["playTime"] as number) + 60,
    timestamp: (base.timestamp as number) + 1000,
  } as SessionSave;
}

/**
 * The exact set of top-level keys `defs.SessionSaveData` (upstream/rogueserver/defs/savedata.go)
 * knows. Everything else the client sends is discarded at ingest — that is why `playerFaints`
 * vanishes, and why a future client field would too.
 */
export const SERVER_SESSION_KEYS: readonly string[] = [
  "seed",
  "playTime",
  "gameMode",
  "dailyConfig",
  "party",
  "enemyParty",
  "modifiers",
  "enemyModifiers",
  "arena",
  "pokeballCounts",
  "money",
  "score",
  "victoryCount",
  "faintCount",
  "reviveCount",
  "waveIndex",
  "battleType",
  "trainer",
  "gameVersion",
  "timestamp",
  "challenges",
  "mysteryEncounterType",
  "mysteryEncounterSaveData",
  "name",
];

/** What the server gives back: empty arrays become null, unknown keys disappear. */
export function serverEcho<T extends object>(save: T, keepKeys?: readonly string[]): T {
  const out = JSON.parse(JSON.stringify(save)) as Record<string, unknown>;
  if (keepKeys) {
    for (const key of Object.keys(out)) {
      if (!keepKeys.includes(key)) {
        delete out[key];
      }
    }
  } else {
    delete out["playerFaints"];
  }
  const nullifyEmpty = (o: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.length === 0) {
        o[k] = null;
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        nullifyEmpty(v as Record<string, unknown>);
      }
    }
  };
  nullifyEmpty(out);
  return out as T;
}

// --- mirror --------------------------------------------------------------------------------------

export interface FakeMirrorInit {
  system?: Partial<SystemRecord>;
  sessions?: (Partial<SessionRecord> | null)[];
  state?: Partial<MirrorStateRecord>;
  account?: AccountRecord | null;
  log?: CallLog;
}

export class FakeMirror implements MirrorPort {
  readonly calls: CallLog;
  private system: SystemRecord;
  private sessions: SessionRecord[];
  private state: MirrorStateRecord;
  private account: AccountRecord | null;

  constructor(init: FakeMirrorInit = {}) {
    this.calls = init.log ?? [];
    this.system = {
      base: null,
      local: null,
      dirty: false,
      baseFetchedAt: null,
      localWrittenAt: null,
      ...init.system,
    };
    this.system.dirty = !structurallyEqual(this.system.local, this.system.base);
    this.sessions = [];
    for (let i = 0; i < SESSION_SLOTS; i++) {
      const seed = init.sessions?.[i] ?? null;
      const rec: SessionRecord = {
        base: null,
        local: null,
        dirty: false,
        baseFetchedAt: null,
        localWrittenAt: null,
        clearedAt: null,
        finalSave: null,
        ...(seed ?? {}),
      };
      rec.dirty = !structurallyEqual(rec.local, rec.base);
      this.sessions.push(rec);
    }
    this.state = {
      clientSessionId: "TESTCSID000000000000000000000000",
      lastSyncAt: null,
      lastSyncResult: null,
      gameVersionServed: "1.12.1.0",
      ...init.state,
    };
    this.account = init.account ?? null;
  }

  readSystem(): SystemRecord {
    return { ...this.system };
  }

  writeLocalSystem(save: SystemSave): void {
    this.calls.push("mirror.writeLocalSystem");
    this.system.local = save;
    this.system.localWrittenAt = NOW_ISO;
    this.system.dirty = !structurallyEqual(this.system.local, this.system.base);
  }

  setBaseSystem(save: SystemSave | null): void {
    this.calls.push("mirror.setBaseSystem");
    this.system.base = save;
    this.system.baseFetchedAt = NOW_ISO;
    this.system.dirty = !structurallyEqual(this.system.local, this.system.base);
  }

  readSession(slot: number): SessionRecord {
    const rec = this.sessions[slot];
    if (!rec) {
      throw new Error(`no such slot ${slot}`);
    }
    return { ...rec };
  }

  writeLocalSession(slot: number, save: SessionSave): void {
    this.calls.push(`mirror.writeLocalSession${slot}`);
    const rec = this.sessions[slot]!;
    rec.local = save;
    rec.localWrittenAt = NOW_ISO;
    rec.clearedAt = null;
    rec.finalSave = null;
    rec.dirty = !structurallyEqual(rec.local, rec.base);
  }

  setBaseSession(slot: number, save: SessionSave | null): void {
    this.calls.push(`mirror.setBaseSession${slot}`);
    const rec = this.sessions[slot]!;
    rec.base = save;
    rec.baseFetchedAt = NOW_ISO;
    rec.dirty = !structurallyEqual(rec.local, rec.base);
  }

  deleteLocalSession(slot: number): void {
    this.calls.push(`mirror.deleteLocalSession${slot}`);
    const rec = this.sessions[slot]!;
    rec.local = null;
    rec.localWrittenAt = NOW_ISO;
    rec.dirty = !structurallyEqual(rec.local, rec.base);
  }

  /** Mirrors the proxy's `clearLocalSession`: the game finished this run while offline. */
  clearLocalSession(slot: number, finalSave: SessionSave | null): void {
    this.calls.push(`mirror.clearLocalSession${slot}`);
    const rec = this.sessions[slot]!;
    const previous = rec.local;
    rec.local = null;
    rec.localWrittenAt = NOW_ISO;
    rec.clearedAt = NOW_ISO;
    rec.finalSave = finalSave ?? previous;
    rec.dirty = !structurallyEqual(rec.local, rec.base);
  }

  setSessionSynced(slot: number, save: SessionSave | null): void {
    this.calls.push(`mirror.setSessionSynced${slot}`);
    const rec = this.sessions[slot]!;
    rec.base = save;
    rec.local = save;
    rec.baseFetchedAt = NOW_ISO;
    rec.localWrittenAt = NOW_ISO;
    rec.clearedAt = null;
    rec.finalSave = null;
    rec.dirty = false;
  }

  readAccount(): AccountRecord | null {
    return this.account;
  }

  readState(): MirrorStateRecord {
    return { ...this.state };
  }

  writeState(patch: Partial<MirrorStateRecord>): void {
    this.state = { ...this.state, ...patch };
  }

  snapshotLocal(): SaveSnapshot {
    return { system: this.system.local, sessions: this.sessions.map((s) => s.local) };
  }

  snapshotBase(): SaveSnapshot {
    return { system: this.system.base, sessions: this.sessions.map((s) => s.base) };
  }
}

// --- upstream api ---------------------------------------------------------------------------------

export interface FakeApiInit {
  system?: SystemSave | null;
  sessions?: (SessionSave | null)[];
  info?: AccountInfo;
  log?: CallLog;
}

type Hook<T> = (ctx: { call: number }) => ApiResult<T> | null;

/**
 * An in-memory stand-in for the real server, including its two nastiest habits: it echoes session
 * saves back lossily, and it answers 404 for an empty slot.
 */
export class FakeUpstreamApi implements UpstreamApi {
  readonly calls: CallLog;
  system: SystemSave | null;
  sessions: (SessionSave | null)[];
  info: AccountInfo;
  /** Per-method hooks that can force a result. Return `null` to fall through to the default. */
  onGetSystem: Hook<SystemSave | null> | null = null;
  onUpdateSystem: Hook<null> | null = null;
  onGetSession: ((slot: number, ctx: { call: number }) => ApiResult<SessionSave | null> | null) | null = null;
  onUpdateSession: ((slot: number, ctx: { call: number }) => ApiResult<null> | null) | null = null;
  onDeleteSession: ((slot: number, ctx: { call: number }) => ApiResult<null> | null) | null = null;

  private counts: Record<string, number> = {};

  constructor(init: FakeApiInit = {}) {
    this.calls = init.log ?? [];
    this.system = init.system ?? null;
    this.sessions = [];
    for (let i = 0; i < SESSION_SLOTS; i++) {
      this.sessions.push(init.sessions?.[i] ?? null);
    }
    this.info = init.info ?? { username: "offsync_test", lastSessionSlot: -1 };
  }

  private bump(key: string): number {
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    return this.counts[key]!;
  }

  countOf(key: string): number {
    return this.counts[key] ?? 0;
  }

  async getSystem(_clientSessionId: string): Promise<ApiResult<SystemSave | null>> {
    const call = this.bump("getSystem");
    this.calls.push("api.getSystem");
    const forced = this.onGetSystem?.({ call });
    if (forced) {
      return forced;
    }
    if (this.system === null) {
      return { ok: true, status: 404, data: null };
    }
    return { ok: true, status: 200, data: serverEcho(this.system) };
  }

  async updateSystem(_clientSessionId: string, save: SystemSave): Promise<ApiResult<null>> {
    const call = this.bump("updateSystem");
    this.calls.push("api.updateSystem");
    const forced = this.onUpdateSystem?.({ call });
    if (forced) {
      return forced;
    }
    this.system = JSON.parse(JSON.stringify(save)) as SystemSave;
    return { ok: true, status: 204, data: null };
  }

  async getSession(slot: number, _clientSessionId: string): Promise<ApiResult<SessionSave | null>> {
    const call = this.bump(`getSession${slot}`);
    this.calls.push(`api.getSession${slot}`);
    const forced = this.onGetSession?.(slot, { call });
    if (forced) {
      return forced;
    }
    const s = this.sessions[slot] ?? null;
    if (s === null) {
      return { ok: true, status: 404, data: null };
    }
    return { ok: true, status: 200, data: serverEcho(s, SERVER_SESSION_KEYS) };
  }

  async updateSession(slot: number, _clientSessionId: string, save: SessionSave): Promise<ApiResult<null>> {
    const call = this.bump(`updateSession${slot}`);
    this.calls.push(`api.updateSession${slot}`);
    const forced = this.onUpdateSession?.(slot, { call });
    if (forced) {
      return forced;
    }
    this.sessions[slot] = JSON.parse(JSON.stringify(save)) as SessionSave;
    return { ok: true, status: 200, data: null };
  }

  async deleteSession(slot: number, _clientSessionId: string): Promise<ApiResult<null>> {
    const call = this.bump(`deleteSession${slot}`);
    this.calls.push(`api.deleteSession${slot}`);
    const forced = this.onDeleteSession?.(slot, { call });
    if (forced) {
      return forced;
    }
    this.sessions[slot] = null;
    return { ok: true, status: 200, data: null };
  }

  async accountInfo(): Promise<ApiResult<AccountInfo>> {
    this.calls.push("api.accountInfo");
    return { ok: true, status: 200, data: this.info };
  }
}

// --- backup ----------------------------------------------------------------------------------------

export interface RecordedBackup {
  kind: BackupKind;
  slot: number | null;
  save: object;
  reason: BackupReason;
  path: string;
}

export class FakeBackupManager implements BackupManager {
  readonly calls: CallLog;
  readonly written: RecordedBackup[] = [];
  failNext = false;

  constructor(log?: CallLog) {
    this.calls = log ?? [];
  }

  async backup(kind: BackupKind, slot: number | null, save: object, reason: BackupReason): Promise<string> {
    if (this.failNext) {
      this.failNext = false;
      this.calls.push("backup.FAILED");
      throw new Error("disk full");
    }
    const path = `C:\\fake\\${reason}-${kind}${slot ?? ""}-${this.written.length}.prsv`;
    this.written.push({ kind, slot, save: JSON.parse(JSON.stringify(save)) as object, reason, path });
    this.calls.push(`backup.${kind}${slot ?? ""}.${reason}`);
    return path;
  }

  async prune(): Promise<void> {
    this.calls.push("backup.prune");
  }
}
