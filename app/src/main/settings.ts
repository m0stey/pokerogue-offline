// `<userData>/settings.json`. Every field has a default, unknown fields are preserved, and every
// write is atomic (temp file + rename) so a crash can never leave a half-written settings file.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConflictPolicy } from "../sync/types";

// The download settings (`allowMeteredDownloads`, `gameUpdateChannel`, `lastSeenGameTag`) went
// away with the downloading updater on 2026-09-13. Anything still in an existing settings.json is
// kept verbatim as an unknown field and simply ignored.

export interface Settings {
  /** What to do when the save here and the save online both changed. */
  conflictPolicy: ConflictPolicy;
  /** True once the user has answered the conflict question at least once. */
  askedOnce: boolean;
  /** Where the `.prsv` backups go. Default: `Documents\PokeRogue Backups`. */
  backupsDir: string;
}

export function defaultSettings(documentsDir: string): Settings {
  return {
    conflictPolicy: "ask",
    askedOnce: false,
    backupsDir: join(documentsDir, "PokeRogue Backups"),
  };
}

const CONFLICT_VALUES: ConflictPolicy[] = ["ask", "prefer-this-computer", "prefer-online"];

export class SettingsStore {
  private data: Settings;
  private readonly unknown: Record<string, unknown> = {};

  constructor(
    private readonly file: string,
    documentsDir: string,
  ) {
    this.data = defaultSettings(documentsDir);
    this.load();
  }

  get(): Readonly<Settings> {
    return this.data;
  }

  /** Merge a patch, validate, persist. Returns the settings as they now are. */
  update(patch: Partial<Settings>): Readonly<Settings> {
    this.data = this.sanitise({ ...this.data, ...patch });
    this.save();
    return this.data;
  }

  private load(): void {
    if (!existsSync(this.file)) {
      this.save();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (!(k in this.data)) this.unknown[k] = v;
      }
      this.data = this.sanitise({ ...this.data, ...(raw as Partial<Settings>) });
    } catch {
      // Corrupt or unreadable: keep defaults and overwrite with something valid.
      this.save();
    }
  }

  private sanitise(s: Settings): Settings {
    const fallback = this.data;
    return {
      conflictPolicy: CONFLICT_VALUES.includes(s.conflictPolicy) ? s.conflictPolicy : "ask",
      askedOnce: typeof s.askedOnce === "boolean" ? s.askedOnce : false,
      backupsDir: typeof s.backupsDir === "string" && s.backupsDir.trim() ? s.backupsDir : fallback.backupsDir,
    };
  }

  private save(): void {
    writeJsonAtomic(this.file, { ...this.unknown, ...this.data });
  }
}

/** Write temp + rename: readers never see a partial file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
