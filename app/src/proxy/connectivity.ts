// Connectivity classification. Contract: DESIGN.md §3.5 and invariant §4.2.
//
// The probe is `GET <upstream>/game/titlestats` with the mandatory Origin header:
//   JSON 200                                  => online
//   text/html (Cloudflare) | transport error | timeout (10 s) => offline
//
// Every timer is unref'd so it can never hold the Electron process open, and `stop()` clears them.

import { EventEmitter } from "node:events";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import { FORWARD_TIMEOUT_MS, forward } from "./upstream";

export type ConnectivityState = "online" | "offline" | "unknown";

export const PROBE_PATH = "/game/titlestats";
export const ONLINE_PROBE_INTERVAL_MS = 5 * 60_000;
export const OFFLINE_PROBE_INTERVAL_MS = 60_000;

export interface ConnectivityOptions {
  log?: Logger;
  /** Injectable for tests; defaults to UPSTREAM_API inside `forward`. */
  baseUrl?: string;
  timeoutMs?: number;
  onlineIntervalMs?: number;
  offlineIntervalMs?: number;
}

export interface ConnectivityChange {
  state: ConnectivityState;
  previous: ConnectivityState;
  reason: string;
}

export class Connectivity extends EventEmitter {
  state: ConnectivityState = "unknown";
  lastReason: string | null = null;
  lastChangeAt: string | null = null;
  lastProbeAt: string | null = null;

  private readonly log: Logger;
  private readonly baseUrl: string | undefined;
  private readonly timeoutMs: number;
  private readonly onlineIntervalMs: number;
  private readonly offlineIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  constructor(opts: ConnectivityOptions = {}) {
    super();
    this.log = (opts.log ?? noopLogger).child("connectivity");
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS;
    this.onlineIntervalMs = opts.onlineIntervalMs ?? ONLINE_PROBE_INTERVAL_MS;
    this.offlineIntervalMs = opts.offlineIntervalMs ?? OFFLINE_PROBE_INTERVAL_MS;
  }

  get isOnline(): boolean {
    return this.state === "online";
  }

  /** One probe. Never rejects. Concurrent calls share the in-flight probe. */
  probe(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    const run = this.runProbe().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /** Start periodic probing (60 s while offline, 5 min while online). Idempotent. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.probe().then(() => this.schedule());
  }

  /** Stop all timers. Safe to call repeatedly. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  markOffline(reason: string): void {
    this.setState("offline", reason);
  }

  markOnline(reason = "upstream-responded"): void {
    this.setState("online", reason);
  }

  private async runProbe(): Promise<void> {
    const result = await forward(
      { method: "GET", path: PROBE_PATH, headers: { accept: "application/json" } },
      null,
      { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs },
    );
    this.lastProbeAt = new Date().toISOString();

    if (result.kind === "error") {
      this.markOffline(`probe-${result.reason}`);
      return;
    }
    if (result.kind === "html") {
      this.markOffline("probe-html");
      return;
    }
    if (result.status !== 200) {
      this.markOffline(`probe-status-${result.status}`);
      return;
    }
    const contentType = (result.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("json")) {
      this.markOffline("probe-not-json");
      return;
    }
    try {
      JSON.parse(result.body.toString("utf8"));
    } catch {
      this.markOffline("probe-bad-json");
      return;
    }
    this.markOnline("probe-ok");
  }

  private schedule(): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const delay = this.state === "online" ? this.onlineIntervalMs : this.offlineIntervalMs;
    this.timer = setTimeout(() => {
      void this.probe().then(() => this.schedule());
    }, delay);
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  private setState(next: ConnectivityState, reason: string): void {
    const previous = this.state;
    this.lastReason = reason;
    if (previous === next) {
      return;
    }
    this.state = next;
    this.lastChangeAt = new Date().toISOString();
    this.log.info(`connectivity ${previous} -> ${next}`, { reason });
    const change: ConnectivityChange = { state: next, previous, reason };
    this.emit("change", change);
    this.emit(next, change);
    // Re-arm at the new cadence immediately rather than after the old one elapses.
    if (this.running) {
      this.schedule();
    }
  }
}
