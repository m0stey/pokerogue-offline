// A stand-in for src/proxy/server.ts, used only while that module does not exist yet (and if it
// ever fails to load). It serves the static game files so the window shows something, and answers
// /api/* with 503 so the game behaves as if the network were down. It does NOT mirror or sync
// anything - delete this file's use as soon as wiring.ts can load the real proxy.

import { EventEmitter } from "node:events";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { get as httpsGet } from "node:https";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Logger } from "../common/log";
import type { Connectivity, ConnectivityState, ProxyHandle } from "./contracts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".atlas": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>PokeRogue</title>
<style>html,body{height:100%;margin:0;display:grid;place-items:center;background:#1b1b1f;color:#f2f2f5;
font:16px/1.5 "Segoe UI",system-ui,sans-serif;text-align:center}p{max-width:28rem;opacity:.8}</style>
<h1>PokeRogue</h1><p>The game is still being set up on this computer. Please close this window and start PokeRogue again in a moment.</p>`;

export interface FallbackOptions {
  gameDir: string | null;
  port: number;
  log: Logger;
}

export function startFallbackServer(opts: FallbackOptions): Promise<ProxyHandle> {
  const root = opts.gameDir ? resolve(opts.gameDir) : null;

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "offline" }));
      return;
    }
    if (!root) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(PLACEHOLDER);
      return;
    }
    let file = resolve(join(root, normalize(decodeURIComponent(url.pathname))));
    if (!file.startsWith(root + sep) && file !== root) file = join(root, "index.html");
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = { "Content-Type": type };
    if (file.endsWith("index.html")) headers["Cache-Control"] = "no-cache";
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  });

  return new Promise<ProxyHandle>((ok, fail) => {
    server.on("error", fail);
    server.listen(opts.port, "127.0.0.1", () => {
      opts.log.warn("running with the stand-in game server (no saving online yet)", { gameDir: opts.gameDir });
      ok({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Stand-in for src/proxy/connectivity.ts with the same probe as DESIGN.md §3.5, so that the rest
 * of main behaves identically before the real Connectivity lands. Same lifetime rules: probe at
 * start, every 60 s while offline, every 5 min while online.
 */
export class FallbackConnectivity extends EventEmitter implements Connectivity {
  state: ConnectivityState = "unknown";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly log: Logger) {
    super();
  }

  start(): void {
    void this.probe();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async probe(): Promise<void> {
    const online = await titlestatsReachable();
    this.set(online ? "online" : "offline", online ? "probe ok" : "probe failed");
    this.rearm();
  }

  markOffline(reason: string): void {
    this.set("offline", reason);
    this.rearm();
  }

  private set(next: ConnectivityState, reason: string): void {
    if (this.state === next) return;
    this.state = next;
    this.log.info(next === "online" ? "connection is back" : "no connection", { reason });
    this.emit(next);
    this.emit("change", next);
  }

  private rearm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.probe(), this.state === "online" ? 5 * 60_000 : 60_000);
    this.timer.unref?.();
  }
}

function titlestatsReachable(): Promise<boolean> {
  return new Promise((resolve_) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve_(ok);
      }
    };
    try {
      const req = httpsGet(
        "https://api.pokerogue.net/game/titlestats",
        { headers: { Origin: "https://pokerogue.net", Accept: "application/json" } },
        (res) => {
          const ok =
            res.statusCode === 200 && String(res.headers["content-type"] ?? "").includes("application/json");
          res.resume();
          done(ok);
        },
      );
      req.setTimeout(10_000, () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}
