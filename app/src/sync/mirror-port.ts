// The slice of the local store (DESIGN.md §3.3) that the sync engine needs.
//
// Declared here, not imported from src/proxy, so the two modules can be built and tested
// independently. `src/proxy/mirror.ts`'s `Mirror` satisfies this structurally — nothing needs to
// `implements` it, and `test/sync/mirror-port.contract.test.ts` asserts the assignability at
// compile time. The real records carry more than this (`localPrev`, `finalSave`, …); extra members
// are fine, missing ones are not, so this list is kept minimal.
//
// Timestamps are ISO-8601 strings, matching the Mirror's on-disk format.

import type { AccountInfo, SaveSnapshot, SessionSave, SystemSave } from "./types";

export interface SystemRecord {
  /** Last state known to be on the server. */
  base: SystemSave | null;
  /** What the game last wrote here. */
  local: SystemSave | null;
  /** `local` differs from `base`. Derived by the Mirror on every write. */
  dirty: boolean;
  baseFetchedAt: string | null;
  localWrittenAt: string | null;
}

export interface SessionRecord {
  base: SessionSave | null;
  local: SessionSave | null;
  dirty: boolean;
  baseFetchedAt: string | null;
  localWrittenAt: string | null;
  /**
   * Set by the proxy when the game finished this slot's run offline (DESIGN.md §3.4): `local` goes
   * to `null` and the clear is recorded here. It is the only thing that lets the engine propagate a
   * deletion to the server (DESIGN.md §3.8); every other null-`local` case is a normal reconcile.
   */
  clearedAt?: string | null;
  /** The save the game submitted with that clear. Listed for completeness; the engine backs up
   * the server's copy, not this one. */
  finalSave?: SessionSave | null;
}

export interface AccountRecord {
  username: string;
  token: string;
  info: AccountInfo | null;
  lastLoginAt: string | null;
}

export interface MirrorStateRecord {
  /** One per app install (Invariant §4.4); `main` calls `ensureClientSessionId()` at startup. */
  clientSessionId: string;
  lastSyncAt: string | null;
  lastSyncResult: string | null;
  gameVersionServed: string | null;
}

/**
 * Contract note for `src/proxy/mirror.ts`: after `writeLocalX` followed by `setBaseX` with the same
 * save, `dirty` must be `false` — the Mirror derives `dirty` from a structural comparison of
 * `local` and `base` rather than keeping a sticky flag. The engine always writes local first.
 */
export interface MirrorPort {
  readSystem(): SystemRecord;
  writeLocalSystem(save: SystemSave): void;
  setBaseSystem(save: SystemSave | null): void;

  readSession(slot: number): SessionRecord;
  writeLocalSession(slot: number, save: SessionSave): void;
  setBaseSession(slot: number, save: SessionSave | null): void;
  deleteLocalSession(slot: number): void;

  readAccount(): AccountRecord | null;

  readState(): MirrorStateRecord;
  /** The Mirror returns the merged state; the engine ignores the return value. */
  writeState(patch: Partial<MirrorStateRecord>): unknown;

  snapshotLocal(): SaveSnapshot;
  snapshotBase(): SaveSnapshot;

  /**
   * Optional atomic "the server and we now agree" helper. The Mirror has it; the engine uses it to
   * settle a slot after propagating an offline clear (it also resets `clearedAt`), and falls back
   * to `setBaseSession` when it is absent.
   */
  setSessionSynced?(slot: number, save: SessionSave | null): void;
}
