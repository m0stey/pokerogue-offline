// File-backed Logger (src/common/log.ts contract) for the packaged app.
// `<userData>/logs/app-<yyyy-mm-dd>.log`, rotated at 5 MB, 10 files kept.
// Synchronous appends on purpose: a crash must not lose the last lines, and the volume is tiny.

import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Logger, LogLevel } from "../common/log";
import { redact } from "../common/log";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 10;

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface FileLogger extends Logger {
  /** Absolute path of the file currently being written. */
  readonly file: string;
  readonly dir: string;
}

export function createFileLogger(logsDir: string, scope = "app"): FileLogger {
  mkdirSync(logsDir, { recursive: true });

  const current = () => join(logsDir, `app-${today()}.log`);

  const rotate = (file: string) => {
    try {
      if (statSync(file).size < MAX_BYTES) return;
    } catch {
      return; // does not exist yet
    }
    // app-2026-09-12.log -> app-2026-09-12.1.log, .1 -> .2, ...
    const stamp = today();
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = join(logsDir, `app-${stamp}.${i}.log`);
      const to = join(logsDir, `app-${stamp}.${i + 1}.log`);
      try {
        renameSync(from, to);
      } catch {
        /* not there */
      }
    }
    try {
      renameSync(file, join(logsDir, `app-${stamp}.1.log`));
    } catch {
      /* ignore */
    }
    prune();
  };

  const prune = () => {
    try {
      const files = readdirSync(logsDir)
        .filter((f) => f.startsWith("app-") && f.endsWith(".log"))
        .map((f) => ({ f, t: statSync(join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const extra of files.slice(KEEP_FILES)) {
        try {
          unlinkSync(join(logsDir, extra.f));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  };

  const write = (level: LogLevel, s: string, msg: string, data?: Record<string, unknown>) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${s}] ${msg}${
      data ? " " + safeJson(redact(data)) : ""
    }\n`;
    const file = current();
    try {
      rotate(file);
      appendFileSync(file, line, "utf8");
    } catch {
      /* logging must never break the app */
    }
    // Also to stdout so `electron .` during development shows the same stream.
    if (level === "error") console.error(line.trimEnd());
    else console.log(line.trimEnd());
  };

  const make = (s: string): FileLogger => ({
    get file() {
      return current();
    },
    dir: logsDir,
    debug: (m, d) => write("debug", s, m, d),
    info: (m, d) => write("info", s, m, d),
    warn: (m, d) => write("warn", s, m, d),
    error: (m, d) => write("error", s, m, d),
    child: (sub: string) => make(`${s}:${sub}`),
  });

  prune();
  return make(scope);
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    return "[unserialisable]";
  }
}
