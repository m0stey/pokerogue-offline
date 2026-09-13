// The local mirror store. Contract: DESIGN.md §3.3.
//
// Layout under <dir> (normally <userData>/mirror/):
//   account.json      { username, tokenEnc | token, info, lastLoginAt }
//   system.json       { base, local, dirty, baseFetchedAt, localWrittenAt }
//   session-<n>.json  same shape with SessionSave, n = 0..4
//   state.json        { clientSessionId, lastSyncAt, lastSyncResult, gameVersionServed }
//
// Every write is atomic (temp file + fsync + rename). Every read is tolerant: a file that is
// missing, unreadable or not parseable as the expected shape reads as "nothing", and the damaged
// file is renamed aside with a `.corrupt-<timestamp>` suffix. Nothing is ever deleted.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import type { SecretCodec } from "../common/secret";
import { plainSecret } from "../common/secret";
import { SESSION_SLOTS } from "../sync/types";
import type { AccountInfo, SaveSnapshot, SessionSave, SystemSave } from "../sync/types";

export interface SaveRecord<T> {
  /** Last state known to be on the server. */
  base: T | null;
  /** What the game last wrote through the proxy. */
  local: T | null;
  /** What `local` held before the last write — a one-step undo (DESIGN §3.4). */
  localPrev: T | null;
  /** local differs from base. */
  dirty: boolean;
  baseFetchedAt: string | null;
  localWrittenAt: string | null;
}

export type SystemRecord = SaveRecord<SystemSave>;

export interface SessionRecord extends SaveRecord<SessionSave> {
  /** Set when the game finished the run in this slot offline (`session/clear`). */
  clearedAt: string | null;
  /** The save the game submitted with that clear (or the last local if it sent none). */
  finalSave: SessionSave | null;
}

export interface AccountRecord {
  username: string;
  token: string;
  info: AccountInfo | null;
  lastLoginAt: string | null;
}

export interface StateRecord {
  clientSessionId: string;
  lastSyncAt: string | null;
  lastSyncResult: string | null;
  gameVersionServed: string | null;
}

function emptyRecord<T>(): SaveRecord<T> {
  return {
    base: null,
    local: null,
    localPrev: null,
    dirty: false,
    baseFetchedAt: null,
    localWrittenAt: null,
  };
}

/** Key-order-independent structural equality. Used only to derive `dirty`. */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalise(value)) ?? "undefined";
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] !== undefined) {
        out[key] = canonicalise(src[key]);
      }
    }
    return out;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function assertSlot(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n >= SESSION_SLOTS) {
    throw new RangeError(`slot id ${n} out of range`);
  }
}

export interface MirrorOptions {
  /**
   * How the account token is protected on disk. The default stores it in the clear, which is what
   * the mirror did before; src/main passes an Electron `safeStorage`-backed codec.
   */
  secret?: SecretCodec;
  log?: Logger;
}

export class Mirror {
  readonly dir: string;
  private readonly secret: SecretCodec;
  private readonly log: Logger;

  constructor(dir: string, opts: MirrorOptions = {}) {
    this.dir = dir;
    this.secret = opts.secret ?? plainSecret;
    this.log = (opts.log ?? noopLogger).child("mirror");
    fs.mkdirSync(dir, { recursive: true });
  }

  // ---------------------------------------------------------------- system

  readSystem(): SystemRecord {
    return this.readRecord<SystemSave>(this.systemFile());
  }

  writeLocalSystem(save: SystemSave): void {
    const rec = this.readSystem();
    rec.localPrev = rec.local;
    rec.local = save;
    rec.localWrittenAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    this.writeJson(this.systemFile(), rec);
  }

  setBaseSystem(save: SystemSave | null): void {
    const rec = this.readSystem();
    rec.base = save;
    rec.baseFetchedAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    this.writeJson(this.systemFile(), rec);
  }

  /** Convenience for "the server and we now agree": sets base and local in one atomic write. */
  setSystemSynced(save: SystemSave | null): void {
    const rec = this.readSystem();
    const at = nowIso();
    rec.base = save;
    rec.localPrev = rec.local;
    rec.local = save;
    rec.baseFetchedAt = at;
    rec.localWrittenAt = at;
    rec.dirty = false;
    this.writeJson(this.systemFile(), rec);
  }

  // --------------------------------------------------------------- session

  readSession(n: number): SessionRecord {
    assertSlot(n);
    const file = this.sessionFile(n);
    const raw = this.readValidatedRaw(file);
    return {
      ...this.toRecord<SessionSave>(raw),
      clearedAt: typeof raw?.clearedAt === "string" ? raw.clearedAt : null,
      finalSave: isPlainObject(raw?.finalSave) ? (raw.finalSave as SessionSave) : null,
    };
  }

  writeLocalSession(n: number, save: SessionSave): void {
    assertSlot(n);
    const rec = this.readSession(n);
    rec.localPrev = rec.local;
    rec.local = save;
    rec.localWrittenAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    // A new local save supersedes any earlier offline clear of this slot.
    rec.clearedAt = null;
    rec.finalSave = null;
    this.writeJson(this.sessionFile(n), rec);
  }

  /**
   * The game finished the run in this slot offline (`session/clear`). Local goes to null and the
   * clear is recorded so the sync engine can propagate it under the DESIGN §3.8 conditions.
   */
  clearLocalSession(n: number, finalSave: SessionSave | null): void {
    assertSlot(n);
    const rec = this.readSession(n);
    const previous = rec.local;
    rec.localPrev = previous;
    rec.local = null;
    rec.localWrittenAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    rec.clearedAt = nowIso();
    rec.finalSave = finalSave ?? previous;
    this.writeJson(this.sessionFile(n), rec);
  }

  setBaseSession(n: number, save: SessionSave | null): void {
    assertSlot(n);
    const rec = this.readSession(n);
    rec.base = save;
    rec.baseFetchedAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    this.writeJson(this.sessionFile(n), rec);
  }

  deleteLocalSession(n: number): void {
    assertSlot(n);
    const rec = this.readSession(n);
    rec.localPrev = rec.local;
    rec.local = null;
    rec.localWrittenAt = nowIso();
    rec.dirty = !structurallyEqual(rec.local, rec.base);
    this.writeJson(this.sessionFile(n), rec);
  }

  /** Convenience for "the server and we now agree" on one slot. */
  setSessionSynced(n: number, save: SessionSave | null): void {
    assertSlot(n);
    const rec = this.readSession(n);
    const at = nowIso();
    rec.base = save;
    rec.localPrev = rec.local;
    rec.local = save;
    rec.baseFetchedAt = at;
    rec.localWrittenAt = at;
    rec.dirty = false;
    // Whatever the server now holds is authoritative; an offline clear is settled.
    rec.clearedAt = null;
    rec.finalSave = null;
    this.writeJson(this.sessionFile(n), rec);
  }

  // --------------------------------------------------------------- account

  /**
   * The token is stored as `tokenEnc` whenever the configured {@link SecretCodec} can protect it,
   * and as a plain `token` otherwise. Both are read; a plain token found while protection *is*
   * available is re-written protected straight away, so an install that predates this migrates the
   * first time anything looks at the account.
   */
  readAccount(): AccountRecord | null {
    const raw = this.readJson(this.accountFile());
    if (raw === null) {
      return null;
    }
    const hasToken =
      isPlainObject(raw) && (typeof raw.token === "string" || typeof raw.tokenEnc === "string");
    if (!isPlainObject(raw) || typeof raw.username !== "string" || !hasToken) {
      this.quarantine(this.accountFile());
      return null;
    }

    let token: string;
    let needsMigration = false;
    if (typeof raw.tokenEnc === "string" && raw.tokenEnc !== "") {
      try {
        token = this.secret.unprotect(raw.tokenEnc);
      } catch (err) {
        // Windows will not give the token back (a different user, or a reset credential store).
        // There is nothing to salvage; put the file aside so the next login writes a clean one.
        this.log.error("the stored sign-in could not be read back and was put aside", {
          error: String(err),
        });
        this.quarantine(this.accountFile());
        return null;
      }
    } else {
      token = typeof raw.token === "string" ? raw.token : "";
      needsMigration = this.secret.available && token !== "";
    }

    const record: AccountRecord = {
      username: raw.username,
      token,
      info: isPlainObject(raw.info) ? (raw.info as AccountInfo) : null,
      lastLoginAt: typeof raw.lastLoginAt === "string" ? raw.lastLoginAt : null,
    };
    if (needsMigration) {
      try {
        this.writeAccount(record);
        this.log.info("the stored sign-in is now protected by Windows");
      } catch (err) {
        this.log.warn("could not protect the stored sign-in", { error: String(err) });
      }
    }
    return record;
  }

  writeAccount(account: AccountRecord): void {
    const stored: Record<string, unknown> = {
      username: account.username,
      info: account.info,
      lastLoginAt: account.lastLoginAt,
    };
    if (this.secret.available && account.token !== "") {
      stored.tokenEnc = this.secret.protect(account.token);
    } else {
      stored.token = account.token;
    }
    this.writeJson(this.accountFile(), stored);
  }

  // ----------------------------------------------------------------- state

  readState(): StateRecord {
    const raw = this.readJson(this.stateFile());
    const obj = isPlainObject(raw) ? raw : {};
    return {
      clientSessionId: typeof obj.clientSessionId === "string" ? obj.clientSessionId : "",
      lastSyncAt: typeof obj.lastSyncAt === "string" ? obj.lastSyncAt : null,
      lastSyncResult: typeof obj.lastSyncResult === "string" ? obj.lastSyncResult : null,
      gameVersionServed: typeof obj.gameVersionServed === "string" ? obj.gameVersionServed : null,
    };
  }

  writeState(patch: Partial<StateRecord>): StateRecord {
    const next = { ...this.readState(), ...patch };
    this.writeJson(this.stateFile(), next);
    return next;
  }

  /** One clientSessionId per install (DESIGN §4.4). Created on first use. */
  ensureClientSessionId(generate: () => string = randomClientSessionId): string {
    const state = this.readState();
    if (state.clientSessionId) {
      return state.clientSessionId;
    }
    return this.writeState({ clientSessionId: generate() }).clientSessionId;
  }

  // ------------------------------------------------------------- snapshots

  snapshotLocal(): SaveSnapshot {
    return {
      system: this.readSystem().local,
      sessions: this.allSlots().map((n) => this.readSession(n).local),
    };
  }

  snapshotBase(): SaveSnapshot {
    return {
      system: this.readSystem().base,
      sessions: this.allSlots().map((n) => this.readSession(n).base),
    };
  }

  // ------------------------------------------------------------- internals

  private allSlots(): number[] {
    return Array.from({ length: SESSION_SLOTS }, (_v, i) => i);
  }

  private systemFile(): string {
    return path.join(this.dir, "system.json");
  }

  private sessionFile(n: number): string {
    return path.join(this.dir, `session-${n}.json`);
  }

  private accountFile(): string {
    return path.join(this.dir, "account.json");
  }

  private stateFile(): string {
    return path.join(this.dir, "state.json");
  }

  private readRecord<T>(file: string): SaveRecord<T> {
    return this.toRecord<T>(this.readValidatedRaw(file));
  }

  /** Parsed record file, or null when it is absent or unusable (unusable files are quarantined). */
  private readValidatedRaw(file: string): Record<string, unknown> | null {
    const raw = this.readJson(file);
    if (raw === null) {
      return null;
    }
    if (!isPlainObject(raw) || !("base" in raw) || !("local" in raw)) {
      this.quarantine(file);
      return null;
    }
    return raw;
  }

  private toRecord<T>(raw: Record<string, unknown> | null): SaveRecord<T> {
    if (raw === null) {
      return emptyRecord<T>();
    }
    const base = isPlainObject(raw.base) ? (raw.base as T) : null;
    const local = isPlainObject(raw.local) ? (raw.local as T) : null;
    return {
      base,
      local,
      localPrev: isPlainObject(raw.localPrev) ? (raw.localPrev as T) : null,
      dirty: typeof raw.dirty === "boolean" ? raw.dirty : !structurallyEqual(local, base),
      baseFetchedAt: typeof raw.baseFetchedAt === "string" ? raw.baseFetchedAt : null,
      localWrittenAt: typeof raw.localWrittenAt === "string" ? raw.localWrittenAt : null,
    };
  }

  /** null = absent or unusable (unusable files are quarantined first). */
  private readJson(file: string): unknown {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.quarantine(file);
      return null;
    }
    if (text.trim() === "") {
      this.quarantine(file);
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      this.quarantine(file);
      return null;
    }
  }

  /** Rename a damaged file aside. Never deletes; never throws. */
  quarantine(file: string): string | null {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let target = `${file}.corrupt-${stamp}`;
    let n = 1;
    while (fs.existsSync(target)) {
      target = `${file}.corrupt-${stamp}-${n++}`;
    }
    try {
      fs.renameSync(file, target);
      return target;
    } catch {
      return null;
    }
  }

  private writeJson(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${(tmpCounter++).toString(36)}`;
    const text = `${JSON.stringify(data, null, 2)}\n`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

let tmpCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

const CSID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Same shape the client generates: 32 chars of [A-Za-z0-9]. */
export function randomClientSessionId(): string {
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += CSID_ALPHABET[Math.floor(Math.random() * CSID_ALPHABET.length)] ?? "0";
  }
  return out;
}
