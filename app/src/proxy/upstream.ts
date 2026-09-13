// Thin forwarder to the upstream PokeRogue API. Contract: DESIGN.md §3.4 (forwarding rules),
// §4.2 (text/html or transport error => offline, never "rejected").
//
// Node built-ins only. The base URL is injectable so tests can point it at a local http server;
// production always uses UPSTREAM_API.

import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export const UPSTREAM_API = "https://api.pokerogue.net";
/** Cloudflare 403s every request that does not carry this Origin (reports/live-api.md §4). */
export const UPSTREAM_ORIGIN_HEADER = "https://pokerogue.net";
export const FORWARD_TIMEOUT_MS = 10_000;

/** The only request headers we pass through; everything else is dropped. */
export const ALLOWED_REQUEST_HEADERS = ["authorization", "content-type", "pkr-client-version", "accept"] as const;

const CANONICAL_HEADER_NAME: Record<string, string> = {
  authorization: "Authorization",
  "content-type": "Content-Type",
  "pkr-client-version": "PKR-Client-Version",
  accept: "Accept",
};

export interface ForwardRequest {
  method: string | undefined;
  /** Path below the API root, e.g. `/savedata/system/get?clientSessionId=x`. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface ForwardOptions {
  /** Defaults to UPSTREAM_API. Tests pass an `http://127.0.0.1:<port>` stand-in. */
  baseUrl?: string;
  timeoutMs?: number;
}

export interface UpstreamOk {
  kind: "ok";
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface UpstreamHtml {
  kind: "html";
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface UpstreamError {
  kind: "error";
  /** Short machine-ish reason, e.g. `timeout`, `ECONNREFUSED`, `socket-error`. */
  reason: string;
  message: string;
}

export type UpstreamResult = UpstreamOk | UpstreamHtml | UpstreamError;

/**
 * Forward one request upstream. Never throws: transport problems come back as
 * `{ kind: "error" }`, Cloudflare interstitials as `{ kind: "html" }`.
 */
export function forward(
  req: ForwardRequest,
  body: Buffer | null,
  opts: ForwardOptions = {},
): Promise<UpstreamResult> {
  const baseUrl = opts.baseUrl ?? UPSTREAM_API;
  const timeoutMs = opts.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const target = new URL(joinPath(baseUrl, req.path));
  const transport = target.protocol === "http:" ? http : https;

  const headers: Record<string, string> = {
    Origin: UPSTREAM_ORIGIN_HEADER,
    // We hand the body back to the game verbatim, so never negotiate compression.
    "Accept-Encoding": "identity",
  };
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = pickHeader(req.headers, name);
    if (value !== undefined && value !== "") {
      headers[CANONICAL_HEADER_NAME[name] ?? name] = value;
    }
  }
  if (body) {
    headers["Content-Length"] = String(body.length);
  }

  return new Promise<UpstreamResult>((resolve) => {
    let settled = false;
    const done = (result: UpstreamResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(overall);
      resolve(result);
    };

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        method: (req.method ?? "GET").toUpperCase(),
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const flat = flattenHeaders(res.headers);
          const payload = Buffer.concat(chunks);
          const contentType = (flat["content-type"] ?? "").toLowerCase();
          if (contentType.startsWith("text/html")) {
            // Cloudflare (or any other interstitial). The caller must treat this as offline.
            done({ kind: "html", status, headers: flat, body: payload });
            return;
          }
          done({ kind: "ok", status, headers: flat, body: payload });
        });
        res.on("error", (err: Error) => {
          request.destroy();
          done({ kind: "error", reason: "response-error", message: err.message });
        });
      },
    );

    const overall = setTimeout(() => {
      request.destroy();
      done({ kind: "error", reason: "timeout", message: `no response within ${timeoutMs} ms` });
    }, timeoutMs);
    if (typeof overall.unref === "function") {
      overall.unref();
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      done({ kind: "error", reason: "timeout", message: `socket idle for ${timeoutMs} ms` });
    });

    request.on("error", (err: NodeJS.ErrnoException) => {
      done({ kind: "error", reason: err.code ?? "socket-error", message: err.message });
    });

    if (body && body.length > 0) {
      request.write(body);
    }
    request.end();
  });
}

function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) {
      continue;
    }
    if (Array.isArray(value)) {
      return value.join(", ");
    }
    return value;
  }
  return undefined;
}

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
