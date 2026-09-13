// DESIGN.md §3.7 — every overwrite is preceded by a verified `.prsv` on disk (Invariant §4.1).
//
// The files must be importable by the real game, so they are produced exactly the way
// `GameData.tryExportData` produces them:
//   - SYSTEM  : JSON -> convertSystemDataStr(data, shorten = true) -> AES
//   - SESSION : JSON -> AES                (upstream/pokerogue/src/system/game-data.ts:1291-1296
//                                           assigns `data = resp` with no key shortening)
//
// After writing, the file is re-read from disk, decrypted, parsed, and structurally compared
// against what we meant to save. Only then does `backup()` resolve.

import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import { structurallyEqual } from "./compare";
import { decryptPrsv, encryptPrsv, expandSystemDataStr, shortenSystemDataStr } from "./prsv";

export type BackupKind = "system" | "session";

/**
 * `conflict`, `update` and `rejected` are never pruned (DESIGN.md §3.7). Routine sync backups use
 * `sync` and follow the retention policy.
 * `rejected` is the fallback export written when the online service refused a save for a reason we
 * do not understand — the one copy she has if that refusal turns out to be permanent.
 */
export type BackupReason = "conflict" | "update" | "rejected" | string;

export const PROTECTED_REASONS: readonly string[] = ["conflict", "update", "rejected"];
export const BACKUP_FOLDER_NAME = "PokeRogue Backups";
export const RETENTION_DAYS = 30;

export interface BackupManager {
  backup(kind: BackupKind, slot: number | null, save: object, reason: BackupReason): Promise<string>;
  prune(): Promise<void>;
}

export interface BackupManagerOptions {
  /**
   * Full path of the backup folder. When given it is used verbatim, so the settings page can move
   * backups anywhere. When omitted it defaults to `<documentsDir>/PokeRogue Backups/`, which is the
   * DESIGN.md §3.7 location.
   */
  backupsDir?: string;
  /** The user's Documents folder. Required unless `backupsDir` is given. */
  documentsDir?: string;
  /** Electron `userData`; a second copy lands in `<userDataDir>/backups/`. */
  userDataDir: string;
  /** Injected clock. Tests advance it to exercise retention. */
  now?: () => Date;
  log?: Logger;
}

/** Where backups go, given the options. Exported so the settings page can show the same string. */
export function resolveBackupsDir(opts: Pick<BackupManagerOptions, "backupsDir" | "documentsDir">): string {
  if (opts.backupsDir) {
    return opts.backupsDir;
  }
  if (!opts.documentsDir) {
    throw new TypeError("createBackupManager needs either backupsDir or documentsDir");
  }
  return join(opts.documentsDir, BACKUP_FOLDER_NAME);
}

export class BackupVerificationError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`backup verification failed for ${path}: ${detail}`);
    this.name = "BackupVerificationError";
    this.path = path;
  }
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `yyyy-mm-dd` in local time — the folder the user will look in. */
export function dayStamp(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** `HHmmss` in local time. */
export function timeStamp(d: Date): string {
  return `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function sanitiseReason(reason: string): string {
  const cleaned = String(reason).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 40) : "backup";
}

/** `system` / `session3` — matches the DESIGN filename template `<kind><slot>`. */
function kindLabel(kind: BackupKind, slot: number | null): string {
  return kind === "session" && slot !== null ? `session${slot}` : kind;
}

/** Render a save the way the game's export does, ready to be encrypted. */
export function plaintextForExport(kind: BackupKind, save: object): string {
  const json = JSON.stringify(save);
  if (kind !== "system") {
    return json;
  }
  const rec = save as Record<string, unknown>;
  const trainerId = typeof rec["trainerId"] === "number" ? (rec["trainerId"] as number) : undefined;
  const secretId = typeof rec["secretId"] === "number" ? (rec["secretId"] as number) : undefined;
  // Keep the save's own ids: the client rewrites them to the *receiving* profile's ids, which for
  // an export of this profile's own save is the same value.
  const ids = trainerId !== undefined && secretId !== undefined ? { trainerId, secretId } : undefined;
  return shortenSystemDataStr(json, ids);
}

/** Undo {@link plaintextForExport} — what the game's Import does before parsing. */
export function parseExportedPlaintext(kind: BackupKind, plaintext: string): unknown {
  const json = kind === "system" ? expandSystemDataStr(plaintext) : plaintext;
  return JSON.parse(json);
}

export function createBackupManager(opts: BackupManagerOptions): BackupManager {
  const now = opts.now ?? (() => new Date());
  const log = (opts.log ?? noopLogger).child("backup");
  const documentsRoot = resolveBackupsDir(opts);
  const userDataRoot = join(opts.userDataDir, "backups");

  async function uniquePath(dir: string, base: string): Promise<string> {
    let candidate = join(dir, `${base}.prsv`);
    let n = 2;
    // Two backups in the same second (same reason, same slot) would otherwise collide.
    while (await exists(candidate)) {
      candidate = join(dir, `${base}-${n}.prsv`);
      n += 1;
    }
    return candidate;
  }

  /**
   * A save that keeps being refused is backed up again on every sync. Since `conflict` and `update`
   * backups are never pruned, that would fill the folder with identical files — one every ten
   * minutes for as long as the rejection lasts. So: if an already-verified backup of exactly this
   * content, kind, slot and reason is sitting in today's folder, reuse it.
   */
  async function findIdenticalToday(
    dir: string,
    suffix: string,
    kind: BackupKind,
    save: object,
  ): Promise<string | null> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    for (const name of names.sort().reverse()) {
      if (!name.endsWith(".prsv") || !name.includes(suffix)) {
        continue;
      }
      const candidate = join(dir, name);
      try {
        const parsed = parseExportedPlaintext(kind, decryptPrsv(await readFile(candidate, "utf8")));
        if (structurallyEqual(parsed, save)) {
          return candidate;
        }
      } catch {
        continue; // unreadable or not ours: leave it alone
      }
    }
    return null;
  }

  async function backup(
    kind: BackupKind,
    slot: number | null,
    save: object,
    reason: BackupReason,
  ): Promise<string> {
    if (save === null || typeof save !== "object") {
      throw new TypeError("backup() needs a save object");
    }
    const at = now();
    const day = dayStamp(at);
    const suffix = `-${sanitiseReason(reason)}-${kindLabel(kind, slot)}`;
    const base = `${timeStamp(at)}${suffix}`;

    const existing = await findIdenticalToday(join(documentsRoot, day), suffix, kind, save);
    if (existing !== null) {
      log.debug("an identical backup already exists today; reusing it", { path: existing });
      return existing;
    }

    const plaintext = plaintextForExport(kind, save);
    const blob = encryptPrsv(plaintext);

    const primaryDir = join(documentsRoot, day);
    await mkdir(primaryDir, { recursive: true });
    const primaryPath = await uniquePath(primaryDir, base);

    // Write to a temp file and rename, so a crash never leaves a half-written ".prsv".
    const tmp = `${primaryPath}.tmp`;
    // Flushed to disk before the rename: the engine replaces the original right after this, and a
    // backup that only lived in the OS cache would not survive a dead battery.
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(blob, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, primaryPath);

    // Verify by reading the file back off disk — not from memory.
    const readBack = await readFile(primaryPath, "utf8");
    let parsed: unknown;
    try {
      const decrypted = decryptPrsv(readBack);
      parsed = parseExportedPlaintext(kind, decrypted);
    } catch (err) {
      await rm(primaryPath, { force: true });
      throw new BackupVerificationError(primaryPath, err instanceof Error ? err.message : String(err));
    }
    if (!structurallyEqual(parsed, save)) {
      await rm(primaryPath, { force: true });
      throw new BackupVerificationError(primaryPath, "re-read save does not match the original");
    }

    const mirrorDir = join(userDataRoot, day);
    await mkdir(mirrorDir, { recursive: true });
    await copyFile(primaryPath, join(mirrorDir, basename(primaryPath)));

    log.info("wrote backup", { kind, slot, reason, path: primaryPath });
    return primaryPath;
  }

  async function prune(): Promise<void> {
    for (const root of [documentsRoot, userDataRoot]) {
      await pruneRoot(root, now(), log);
    }
  }

  return { backup, prune };
}

interface BackupFile {
  path: string;
  day: string;
  name: string;
  reason: string;
  /** Local-time Date parsed from the folder day + the `HHmmss` prefix. */
  at: Date;
}

const NAME_RE = /^(\d{2})(\d{2})(\d{2})-([^-]+(?:-[^-]+)*?)-(system|session\d)(?:-\d+)?\.prsv$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseBackupFile(root: string, day: string, name: string): BackupFile | null {
  const dayMatch = DAY_RE.exec(day);
  const nameMatch = NAME_RE.exec(name);
  if (!dayMatch || !nameMatch) {
    return null;
  }
  const at = new Date(
    Number(dayMatch[1]),
    Number(dayMatch[2]) - 1,
    Number(dayMatch[3]),
    Number(nameMatch[1]),
    Number(nameMatch[2]),
    Number(nameMatch[3]),
  );
  return { path: join(root, day, name), day, name, reason: nameMatch[4] ?? "", at };
}

async function pruneRoot(root: string, at: Date, log: Logger): Promise<void> {
  let days: string[];
  try {
    days = await readdir(root);
  } catch {
    return; // nothing has ever been backed up
  }
  const cutoff = at.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const old: BackupFile[] = [];

  for (const day of days) {
    let names: string[];
    try {
      names = await readdir(join(root, day));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = parseBackupFile(root, day, name);
      if (!file) {
        continue; // unrecognised: never touched
      }
      if (file.at.getTime() >= cutoff) {
        continue; // inside the 30-day window: keep everything
      }
      if (PROTECTED_REASONS.includes(file.reason)) {
        continue; // conflict/update backups are never pruned
      }
      old.push(file);
    }
  }

  // Older than 30 days: keep the last file per calendar month, delete the rest.
  const byMonth = new Map<string, BackupFile[]>();
  for (const f of old) {
    const key = f.day.slice(0, 7);
    const list = byMonth.get(key);
    if (list) {
      list.push(f);
    } else {
      byMonth.set(key, [f]);
    }
  }
  for (const [, files] of byMonth) {
    files.sort((a, b) => a.at.getTime() - b.at.getTime() || a.name.localeCompare(b.name));
    const keep = files[files.length - 1];
    for (const f of files) {
      if (f === keep) {
        continue;
      }
      await rm(f.path, { force: true });
      log.debug("pruned backup", { path: f.path });
    }
  }

  // Drop directories left empty by the prune.
  for (const day of days) {
    try {
      const rest = await readdir(join(root, day));
      if (rest.length === 0) {
        await rm(join(root, day), { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
