// The proxy HTTP server. Contract: DESIGN.md §3.4.
//
//   /api/*  -> upstream when connectivity says online (with mirroring side effects on success),
//              or answered from the mirror when offline. HTML or a transport error from upstream
//              flips connectivity to offline and the same request is re-answered from the mirror.
//   /*      -> the static game build.
//
// Branching is on HTTP status only; an empty body is never treated as success (DESIGN §4.3).

import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import { URLSearchParams } from "node:url";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import { readGameVersionFile, saveIsNewerThanBuild } from "../common/version";
import type { SessionSave, SystemSave } from "../sync/types";
import { SESSION_SLOTS } from "../sync/types";
import type { Connectivity } from "./connectivity";
import type { AccountRecord, Mirror } from "./mirror";
import { emptyResponse, replay, textResponse } from "./replay";
import type { ReplayResponse } from "./replay";
import { createStaticHandler } from "./static";
import { forward } from "./upstream";
import type { UpstreamResult } from "./upstream";

export const API_PREFIX = "/api";
export const DEFAULT_PORT = 47830;
export const DEFAULT_HOST = "127.0.0.1";
/** Refuse absurd bodies rather than buffering forever; real system saves are well under this. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Host headers we answer. Anything else is a DNS-rebinding attempt; see `hostAllowed`. */
export const ALLOWED_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];

export interface ProxyOptions {
  gameDir: string;
  mirror: Mirror;
  port?: number;
  host?: string;
  connectivity: Connectivity;
  log?: Logger;
  /** Injectable for tests; defaults to UPSTREAM_API. */
  upstreamBaseUrl?: string;
  upstreamTimeoutMs?: number;
  /**
   * The `gameVersion` of the build being served. Defaults to reading `<gameDir>/version.json`.
   * Used only to notice a save that is newer than this build (`needs-game-update`).
   */
  gameVersion?: string | null;
}

/** What the proxy tells the shell about. */
export interface ProxyEventMap {
  /**
   * The account's system save was written by a newer client than the build we serve, so this build
   * will refuse to load it (upstream/pokerogue/src/system/game-data.ts:437). The shell has to say
   * so in plain words; there is nothing the proxy can do about it.
   */
  "needs-game-update": [{ saveVersion: string; servedVersion: string }];
}

export interface ProxyHandle {
  close(): Promise<void>;
  readonly port: number;
  readonly url: string;
  /** `needs-game-update`. Node's EventEmitter, typed. */
  readonly events: EventEmitter<ProxyEventMap>;
}

type Source = "upstream" | "replay";

/**
 * DNS-rebinding guard. The proxy binds 127.0.0.1, but a page on the open internet can point a
 * hostname it controls at 127.0.0.1 and have the browser send requests here with *its* Host header;
 * same-origin then applies to that hostname, not to ours, so the page could read the save data.
 * Answering only our own two names closes it. A request with no Host header (HTTP/1.0) is refused
 * as well — no browser sends one, so nothing legitimate is lost.
 */
export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== "string" || hostHeader === "") {
    return false;
  }
  const trimmed = hostHeader.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  // An IPv6 literal would be in brackets; we never serve on one, so a bracket is a straight no.
  if (trimmed.includes("[") || trimmed.includes("]")) {
    return false;
  }
  const name = colon === -1 ? trimmed : trimmed.slice(0, colon);
  const portPart = colon === -1 ? "" : trimmed.slice(colon + 1);
  if (portPart !== String(port)) {
    return false;
  }
  return ALLOWED_HOSTS.includes(name);
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const log = (opts.log ?? noopLogger).child("proxy");
  const { mirror, connectivity } = opts;
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const serveStatic = createStaticHandler({ dir: opts.gameDir, log });
  const events = new EventEmitter<ProxyEventMap>();

  // The version this build stamps into saves. Read once: the files cannot change under us.
  const servedGameVersion = opts.gameVersion ?? readGameVersionFile(opts.gameDir).gameVersion;
  // DESIGN §3.3 lists `gameVersionServed` in state.json; nothing wrote it before (milestone-1 B4).
  try {
    mirror.writeState({ gameVersionServed: servedGameVersion });
  } catch (err) {
    log.warn("could not record which game version is being served", { error: String(err) });
  }
  if (!servedGameVersion) {
    log.warn("the game build has no version.json; a save from a newer game cannot be noticed", {
      gameDir: opts.gameDir,
    });
  }

  /**
   * reports/milestone-1.md §3: if the system save's `gameVersion` is greater than the build's, the
   * client shows an English modal with no way past and refuses to load the account. One session in
   * a browser on pokerogue.net is enough to cause it. We cannot prevent it — the save is hers and
   * the modal is the client's — but the shell can say what happened, in words she can act on.
   */
  const checkGameVersion = (save: SystemSave | null, where: Source): void => {
    const saveVersion = typeof save?.gameVersion === "string" ? save.gameVersion : null;
    if (!saveVersion || !servedGameVersion) {
      return;
    }
    if (!saveIsNewerThanBuild(saveVersion, servedGameVersion)) {
      return;
    }
    log.warn("the save online was made with a newer version of the game than this one", {
      saveVersion,
      servedVersion: servedGameVersion,
      source: where,
    });
    events.emit("needs-game-update", { saveVersion, servedVersion: servedGameVersion });
  };

  // DESIGN §3.4 / §4.4: one clientSessionId per install. The game invents a new one on every page
  // load; if that reached the server it would fight the sync engine for the active session, so
  // every forwarded /savedata/* request carries the install-wide id instead.
  let installClientSessionId: string | null = null;
  const installId = (): string => {
    if (installClientSessionId === null) {
      installClientSessionId = mirror.ensureClientSessionId();
    }
    return installClientSessionId;
  };

  /** Set once the socket is listening; with `port: 0` the requested port is not the real one. */
  let boundPort = port;

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (!hostAllowed(req.headers.host, boundPort)) {
      log.warn("refused a request with a foreign Host header", { host: req.headers.host ?? "(none)" });
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end("forbidden\n");
      return;
    }
    if (isApiRequest(url)) {
      void handleApi(req, res, url).catch((err: unknown) => {
        log.error("api handler crashed", { error: String(err) });
        sendReplay(res, textResponse(503, "offline"));
      });
      return;
    }
    void serveStatic(req, res).catch((err: unknown) => {
      log.error("static handler crashed", { error: String(err) });
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end();
    });
  });

  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: string,
  ): Promise<void> {
    const started = Date.now();
    const rest = url.slice(API_PREFIX.length) || "/";
    const queryIndex = rest.indexOf("?");
    const apiPath = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
    const search = queryIndex === -1 ? "" : rest.slice(queryIndex + 1);
    const query = new URLSearchParams(search);
    const method = (req.method ?? "GET").toUpperCase();

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      const response = textResponse(413, String(err));
      sendReplay(res, response);
      log.warn("api request body rejected", { method, path: redactPath(rest), error: String(err) });
      return;
    }

    // The path is logged exactly as it left this process: for a forwarded /savedata/* call that is
    // the path *after* the clientSessionId rewrite, so the log proves the install-wide id (and not
    // the game's per-page-load one) is what the server saw (DESIGN §3.4, invariant §4.4).
    const finish = (status: number, source: Source, loggedPath: string = rest): void => {
      log.info("api", {
        method,
        path: redactPath(loggedPath),
        status,
        source,
        ms: Date.now() - started,
      });
    };

    if (connectivity.state !== "offline") {
      let upstreamPath = rest;
      let upstreamBody = body;
      if (apiPath.startsWith("/savedata/")) {
        const id = installId();
        upstreamPath = withInstallClientSessionId(rest, id);
        if (apiPath.replace(/\/+$/, "") === "/savedata/updateall") {
          upstreamBody = withInstallClientSessionIdInBody(body, id);
        }
      }
      const result = await forward({ method, path: upstreamPath, headers: req.headers }, upstreamBody, {
        baseUrl: opts.upstreamBaseUrl,
        timeoutMs: opts.upstreamTimeoutMs,
      });
      if (result.kind === "ok") {
        if (connectivity.state !== "online") {
          connectivity.markOnline("upstream-responded");
        }
        applySideEffects(apiPath, query, body, result, req.headers);
        sendUpstream(res, result);
        finish(result.status, "upstream", upstreamPath);
        return;
      }
      const reason = result.kind === "html" ? "upstream-html" : `upstream-${result.reason}`;
      log.warn("upstream unavailable, answering from mirror", {
        method,
        path: redactPath(rest),
        reason,
      });
      connectivity.markOffline(reason);
    }

    const response = replay({ method, path: apiPath, query, headers: req.headers, body }, mirror, log);
    if (apiPath.replace(/\/+$/, "") === "/savedata/system/get" && response.status === 200) {
      // The same check as on the online path: the block is the client's, so it fires offline too.
      checkGameVersion(parseJson(response.body) as SystemSave | null, "replay");
    }
    sendReplay(res, response);
    finish(response.status, "replay");
  }

  /** DESIGN §3.4: side effects on success only, branching on status codes. */
  function applySideEffects(
    apiPath: string,
    query: URLSearchParams,
    requestBody: Buffer,
    result: { status: number; body: Buffer },
    headers: http.IncomingHttpHeaders,
  ): void {
    try {
      switch (apiPath.replace(/\/+$/, "") || "/") {
        case "/account/login": {
          if (result.status !== 200) {
            return;
          }
          const token = (parseJson(result.body) as { token?: unknown } | null)?.token;
          if (typeof token !== "string" || token === "") {
            return;
          }
          const username = new URLSearchParams(requestBody.toString("utf8")).get("username") ?? "";
          const previous = mirror.readAccount();
          const record: AccountRecord = {
            username,
            token,
            info: previous && previous.username === username ? previous.info : null,
            lastLoginAt: new Date().toISOString(),
          };
          mirror.writeAccount(record);
          return;
        }
        case "/account/info": {
          if (result.status !== 200) {
            return;
          }
          const info = parseJson(result.body) as Record<string, unknown> | null;
          if (!info || typeof info.username !== "string") {
            return;
          }
          const previous = mirror.readAccount();
          mirror.writeAccount({
            username: info.username,
            token: previous?.token ?? headerValue(headers, "authorization") ?? "",
            info: info as AccountRecord["info"],
            lastLoginAt: previous?.lastLoginAt ?? null,
          });
          return;
        }
        case "/savedata/system/get": {
          if (result.status !== 200) {
            return;
          }
          const save = parseJson(result.body) as SystemSave | null;
          if (save) {
            mirror.setSystemSynced(save);
            checkGameVersion(save, "upstream");
          }
          return;
        }
        case "/savedata/system/update": {
          if (result.status !== 204) {
            return;
          }
          const save = parseJson(requestBody) as SystemSave | null;
          if (save) {
            mirror.setSystemSynced(save);
          }
          return;
        }
        case "/savedata/session/get": {
          if (result.status !== 200) {
            return;
          }
          const slot = slotFromQuery(query);
          const save = parseJson(result.body) as SessionSave | null;
          if (slot !== null && save) {
            mirror.setSessionSynced(slot, save);
          }
          return;
        }
        case "/savedata/session/update": {
          if (result.status !== 200) {
            return;
          }
          const slot = slotFromQuery(query);
          const save = parseJson(requestBody) as SessionSave | null;
          if (slot !== null && save) {
            mirror.setSessionSynced(slot, save);
          }
          return;
        }
        case "/savedata/session/delete":
        case "/savedata/session/clear": {
          // `clear` always deletes the slot server-side on a 200 (api/savedata/clear.go), so the
          // mirror must follow or a finished run would look dirty and be pushed back.
          if (result.status !== 200) {
            return;
          }
          const slot = slotFromQuery(query);
          if (slot !== null) {
            mirror.setSessionSynced(slot, null);
          }
          return;
        }
        case "/savedata/updateall": {
          if (result.status !== 200) {
            return;
          }
          const payload = parseJson(requestBody) as {
            system?: SystemSave;
            session?: SessionSave;
            sessionSlotId?: number;
          } | null;
          if (!payload) {
            return;
          }
          if (payload.system) {
            mirror.setSystemSynced(payload.system);
          }
          const slot = payload.sessionSlotId;
          if (
            payload.session &&
            typeof slot === "number" &&
            Number.isInteger(slot) &&
            slot >= 0 &&
            slot < SESSION_SLOTS
          ) {
            mirror.setSessionSynced(slot, payload.session);
          }
          return;
        }
        default:
          return;
      }
    } catch (err) {
      // A mirror problem must never break the game's request.
      log.error("mirror side effect failed", { path: apiPath, error: String(err) });
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  boundPort = actualPort;
  log.info("proxy listening", {
    url: `http://${host}:${actualPort}`,
    gameDir: opts.gameDir,
    gameVersion: servedGameVersion ?? "unknown",
  });

  return {
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    events,
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      });
    },
  };
}

function isApiRequest(url: string): boolean {
  return (
    url === API_PREFIX ||
    url.startsWith(`${API_PREFIX}/`) ||
    url.startsWith(`${API_PREFIX}?`)
  );
}

function sendUpstream(res: http.ServerResponse, result: UpstreamResult): void {
  if (result.kind === "error") {
    sendReplay(res, emptyResponse(503));
    return;
  }
  res.statusCode = result.status;
  const contentType = result.headers["content-type"];
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
  res.setHeader("Content-Length", String(result.body.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(result.body);
}

function sendReplay(res: http.ServerResponse, response: ReplayResponse): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.statusCode = response.status;
  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }
  res.setHeader("Content-Length", String(response.body.length));
  res.setHeader("Cache-Control", "no-store");
  if (response.body.length === 0) {
    res.end();
    return;
  }
  res.end(response.body);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err) => reject(err));
  });
}

function parseJson(body: Buffer): unknown {
  const text = body.toString("utf8").trim();
  if (text === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function slotFromQuery(query: URLSearchParams): number | null {
  const raw = query.get("slot");
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const slot = Number.parseInt(raw, 10);
  return slot >= 0 && slot < SESSION_SLOTS ? slot : null;
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * Replace the game's per-page-load `clientSessionId` query parameter with the install-wide id.
 * Only rewrites when the parameter is actually present, so request semantics never change.
 */
export function withInstallClientSessionId(pathWithQuery: string, id: string): string {
  const index = pathWithQuery.indexOf("?");
  if (index === -1) {
    return pathWithQuery;
  }
  const params = new URLSearchParams(pathWithQuery.slice(index + 1));
  if (!params.has("clientSessionId")) {
    return pathWithQuery;
  }
  params.set("clientSessionId", id);
  return `${pathWithQuery.slice(0, index)}?${params.toString()}`;
}

/**
 * The same rewrite for `updateall`, whose `clientSessionId` travels in the JSON body (confirmed in
 * the client's `UpdateAllSavedataRequest`, `src/@types/api.ts`, and `savedata-api.ts:updateAll`,
 * which posts the body with no query string at all). Done as a textual substitution so the save
 * itself is forwarded byte-for-byte.
 */
export function withInstallClientSessionIdInBody(body: Buffer, id: string): Buffer {
  if (body.length === 0) {
    return body;
  }
  const text = body.toString("utf8");
  const field = /"clientSessionId"\s*:\s*"(?:[^"\\]|\\.)*"/;
  if (!field.test(text)) {
    return body;
  }
  return Buffer.from(text.replace(field, `"clientSessionId":${JSON.stringify(id)}`), "utf8");
}

/** Query strings carry no secrets today, but never log anything token-shaped. */
export function redactPath(pathWithQuery: string): string {
  const index = pathWithQuery.indexOf("?");
  if (index === -1) {
    return pathWithQuery;
  }
  const params = new URLSearchParams(pathWithQuery.slice(index + 1));
  for (const key of [...params.keys()]) {
    if (/token|password|auth/i.test(key)) {
      params.set(key, "…");
    }
  }
  const query = params.toString();
  return query === "" ? pathWithQuery.slice(0, index) : `${pathWithQuery.slice(0, index)}?${query}`;
}
