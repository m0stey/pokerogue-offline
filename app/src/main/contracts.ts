// Adapter layer. Signatures follow DESIGN.md §3.3-§3.9 and were checked against the real modules
// in src/proxy and src/sync on 2026-09-12, so that src/main never imports them directly.
// `wiring.ts` is the only file that touches the implementations.
//
// If a real module's signature changes, fix DESIGN.md first, then this file - do not fork the
// contract here.

import type { Logger } from "../common/log";
import type { AccountInfo, ConflictPolicy, SaveSnapshot, SessionSave, SystemSave } from "../sync/types";

export type { AccountInfo, ConflictPolicy, Logger, SaveSnapshot, SessionSave, SystemSave };

/** DESIGN.md §1. Compiled into the game build; must never change. */
export const GAME_PORT = 47830;
export const GAME_ORIGIN = `http://127.0.0.1:${GAME_PORT}`;

// ---------------------------------------------------------------------------
// §3.3 Mirror - the local store
// ---------------------------------------------------------------------------

export interface SystemRecord {
  base: SystemSave | null;
  local: SystemSave | null;
  dirty: boolean;
  baseFetchedAt?: string | number | null;
  localWrittenAt?: string | number | null;
}

export interface SessionRecord {
  base: SessionSave | null;
  local: SessionSave | null;
  dirty: boolean;
  baseFetchedAt?: string | number | null;
  localWrittenAt?: string | number | null;
}

export interface AccountRecord {
  username: string;
  token: string;
  info?: AccountInfo | null;
  lastLoginAt?: string | number | null;
}

/** `<userData>/mirror/state.json`. Main only ever reads it (for the settings page). */
export interface MirrorState {
  clientSessionId: string;
  /** src/proxy writes an ISO string; src/sync/mirror-port.ts declares a number. Accept both. */
  lastSyncAt?: string | number | null;
  lastSyncResult?: string | null;
  gameVersionServed?: string | null;
}

export interface Mirror {
  readSystem(): SystemRecord;
  writeLocalSystem(s: SystemSave): void;
  setBaseSystem(s: SystemSave | null): void;
  readSession(n: number): SessionRecord;
  writeLocalSession(n: number, s: SessionSave): void;
  setBaseSession(n: number, s: SessionSave | null): void;
  deleteLocalSession(n: number): void;
  readAccount(): AccountRecord | null;
  readState(): MirrorState;
  snapshotLocal(): SaveSnapshot;
  snapshotBase(): SaveSnapshot;
}

// ---------------------------------------------------------------------------
// §3.5 Connectivity
// ---------------------------------------------------------------------------

export type ConnectivityState = "online" | "offline" | "unknown";

export interface Connectivity {
  state: ConnectivityState;
  probe(): Promise<void>;
  markOffline(reason: string): void;
  /** Starts the probe timers (60 s while offline, 5 min while online). */
  start(): void;
  stop(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must accept Node EventEmitter.on
  on(event: "online" | "offline" | "change", listener: (...args: any[]) => void): unknown;
}

// ---------------------------------------------------------------------------
// §3.4 Proxy
// ---------------------------------------------------------------------------

export interface ProxyOptions {
  gameDir: string;
  mirror: Mirror;
  port: number;
  connectivity: Connectivity;
  log: Logger;
}

export interface ProxyHandle {
  close(): Promise<void>;
}

export type StartProxy = (opts: ProxyOptions) => Promise<ProxyHandle>;

// ---------------------------------------------------------------------------
// §3.7 Backups
// ---------------------------------------------------------------------------

export interface BackupManager {
  backup(kind: "system" | "session", slot: number | null, save: object, reason: string): Promise<string>;
  prune(): Promise<void>;
}

// ---------------------------------------------------------------------------
// §3.8 Sync engine
// ---------------------------------------------------------------------------

/** Opaque to main: only the sync engine calls it. Declared so wiring can type the hand-off. */
export interface UpstreamApi {
  accountInfo(): Promise<unknown>;
}

export interface SyncResult {
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  errors: string[];
  /** One or two plain sentences from the engine, safe to show the user. */
  summary?: string;
}

/** One side of a conflict, as the engine describes it. */
export interface ConflictSide {
  /** `gameStats.playTime` (system) or `playTime` (session), in seconds. */
  playTime: number | null;
  /** Save timestamp, ms since epoch. */
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

export type ConflictKeep = "this-computer" | "online";

/** What our dialog gives back. The engine only wants `keep`; `remember` is ours. */
export interface ConflictAnswer {
  keep: ConflictKeep;
  remember: boolean;
}

export interface ConflictPolicyPort {
  mode: ConflictPolicy;
  /** Called only when `mode` is `"ask"`, at most once per sync run. */
  ask(question: ConflictQuestion): Promise<ConflictKeep>;
}

export interface SyncDeps {
  mirror: Mirror;
  backup: BackupManager;
  api: UpstreamApi;
  policy: ConflictPolicyPort;
  log?: Logger;
}

export type RunSync = (deps: SyncDeps) => Promise<SyncResult>;

/** Substrings the engine puts into `SyncResult.errors`, prefixed with the target name. */
export const NEEDS_GAME_UPDATE = "needs-game-update";
export const UNKNOWN_REJECTION = "unknown-rejection";

// ---------------------------------------------------------------------------
// What wiring.ts hands back to index.ts
// ---------------------------------------------------------------------------

export interface RuntimeDeps {
  makeMirror(dir: string): Mirror;
  makeConnectivity(log: Logger): Connectivity;
  startProxy: StartProxy;
  makeBackupManager(opts: { documentsDir: string; userDataDir: string; log: Logger }): BackupManager;
  makeUpstreamApi(opts: { token: string | null; log: Logger }): UpstreamApi;
  runSync: RunSync;
}
