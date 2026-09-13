// `<userData>/settings.json`. Every field has a default, unknown fields are preserved, and every
// write is atomic (temp file + rename) so a crash can never leave a half-written settings file.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConflictPolicy } from "../sync/types";

export type MeteredPolicy = "ask" | "always" | "never";

export interface Settings {
  /** What to do when the save here and the save online both changed. */
  conflictPolicy: ConflictPolicy;
  /** True once she has answered the conflict question at least once. */
  askedOnce: boolean;
  /** Where the `.prsv` backups go. Default: `Documents\PokeRogue Backups`. */
  backupsDir: string;
  /** Whether game updates may be downloaded over a mobile connection. */
  allowMeteredDownloads: MeteredPolicy;
  /** Which release channel of the game build to follow. */
  gameUpdateChannel: string;
  /** The newest game version we have told the user about / installed. */
  lastSeenGameTag: string;
}

export function defaultSettings(documentsDir: string): Settings {
  return {
    conflictPolicy: "ask",
    askedOnce: false,
    backupsDir: join(documentsDir, "PokeRogue Backups"),
    allowMeteredDownloads: "ask",
    gameUpdateChannel: "stable",
    lastSeenGameTag: "",
  };
}

const CONFLICT_VALUES: ConflictPolicy[] = ["ask", "prefer-this-computer", "prefer-online"];
const METERED_VALUES: MeteredPolicy[] = ["ask", "always", "never"];

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
      allowMeteredDownloads: METERED_VALUES.includes(s.allowMeteredDownloads) ? s.allowMeteredDownloads : "ask",
      gameUpdateChannel:
        typeof s.gameUpdateChannel === "string" && s.gameUpdateChannel.trim() ? s.gameUpdateChannel : "stable",
      lastSeenGameTag: typeof s.lastSeenGameTag === "string" ? s.lastSeenGameTag : "",
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
