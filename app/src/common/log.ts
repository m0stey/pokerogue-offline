// Minimal logger contract shared by all modules. The main process supplies a file-backed
// implementation; tests pass a no-op or a collector.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

export function consoleLogger(scope = "app"): Logger {
  const fmt = (level: LogLevel, msg: string, data?: Record<string, unknown>) =>
    `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${data ? " " + JSON.stringify(redact(data)) : ""}`;
  return {
    debug: (m, d) => console.debug(fmt("debug", m, d)),
    info: (m, d) => console.info(fmt("info", m, d)),
    warn: (m, d) => console.warn(fmt("warn", m, d)),
    error: (m, d) => console.error(fmt("error", m, d)),
    child: (s) => consoleLogger(`${scope}:${s}`),
  };
}

/** Never log tokens or passwords in full. */
export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (/token|password|authorization/i.test(k) && typeof v === "string") {
      out[k] = v.slice(0, 6) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}
