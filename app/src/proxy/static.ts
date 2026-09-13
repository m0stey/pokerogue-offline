// Static file server for the unmodified game build. Contract: DESIGN.md §3.4 (Static).
//
// GET/HEAD only, correct MIME types, path-traversal proof, `Cache-Control: no-cache` on index.html
// and `max-age=3600` for everything else. Range requests are not supported (the game never asks for
// them).
//
// There is NO SPA fallback: the built index.html references its assets with relative `./assets/...`
// URLs, so answering an arbitrary missing path with index.html would make the page resolve those
// assets against the wrong base. index.html is served for `/` and `/index.html` only; every other
// missing path is a plain 404. That is also what `GET /manifest.json` must get — the game fetches it
// at startup (reports/game-build.md §4.1), it is not in `dist`, the fetch is wrapped in try/catch,
// and it must not be confused with the real `/manifest.webmanifest`.
//
// Query strings are stripped before resolving, because `getCachedUrl()` can append `?t=<timestamp>`
// to locale and asset URLs.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL } from "node:url";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

export const DEFAULT_MIME = "application/octet-stream";
export const INDEX_FILE = "index.html";
const STATIC_CACHE_CONTROL = "max-age=3600";
const INDEX_CACHE_CONTROL = "no-cache";

export interface StaticHandlerOptions {
  dir: string;
  log?: Logger;
}

export type StaticHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

export function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? DEFAULT_MIME;
}

export function createStaticHandler(opts: StaticHandlerOptions): StaticHandler {
  const root = path.resolve(opts.dir);
  const log = (opts.log ?? noopLogger).child("static");

  return async function handle(req, res) {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      plain(res, 405, "method not allowed", method === "HEAD");
      return;
    }

    let pathname: string;
    try {
      // `.pathname` drops the query string: the game appends `?t=<timestamp>` to locale and asset
      // URLs whenever a manifest is present (reports/game-build.md §4.1).
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    } catch {
      plain(res, 400, "bad request", method === "HEAD");
      return;
    }
    if (pathname.includes("\0")) {
      plain(res, 400, "bad request", method === "HEAD");
      return;
    }

    const resolved = resolveWithinRoot(root, pathname);
    if (!resolved) {
      log.warn("blocked traversal attempt", { url: req.url ?? "" });
      plain(res, 403, "forbidden", method === "HEAD");
      return;
    }

    // `/` (and any directory) means that directory's index.html; only the root one exists in a
    // game build, and nothing else ever falls back to it.
    const target = isDirectory(resolved) ? path.join(resolved, INDEX_FILE) : resolved;
    const stat = statOrNull(target);

    if (!stat?.isFile()) {
      plain(res, 404, "not found", method === "HEAD");
      return;
    }

    const isIndex = path.resolve(target) === path.join(root, INDEX_FILE);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(target));
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", isIndex ? INDEX_CACHE_CONTROL : STATIC_CACHE_CONTROL);
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (method === "HEAD") {
      res.end();
      return;
    }

    await new Promise<void>((resolve) => {
      const stream = fs.createReadStream(target);
      stream.on("error", (err) => {
        log.error("static read failed", { file: target, error: String(err) });
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        res.end();
        resolve();
      });
      res.on("close", () => {
        stream.destroy();
        resolve();
      });
      stream.on("end", () => resolve());
      stream.pipe(res);
    });
  };
}

/** Returns the absolute path if (and only if) it stays inside `root`. */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  const rootAbs = path.resolve(root);
  const normalised = pathname.replace(/\\/g, "/");
  // Reject rather than silently collapse: a `..` segment (however it was encoded) is never a
  // legitimate request from the game build.
  if (normalised.split("/").some((segment) => segment === "..")) {
    return null;
  }
  const candidate = path.resolve(rootAbs, `.${path.posix.normalize(normalised)}`);
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + path.sep)) {
    return null;
  }
  return candidate;
}

function isDirectory(file: string): boolean {
  return statOrNull(file)?.isDirectory() === true;
}

function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function plain(res: http.ServerResponse, status: number, message: string, headOnly: boolean): void {
  const body = Buffer.from(message, "utf8");
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", "no-store");
  if (headOnly) {
    res.end();
    return;
  }
  res.end(body);
}
