// The only thing in this project that talks to api.pokerogue.net for sync purposes.
//
// Deliberately narrow: get/update system, get/update/delete session, account info, login. There is
// no `clear`, `newclear` or `verify` here and there must never be — Invariant §4.7. `clear` submits
// daily-run scores and can get an account banned; `verify` is broken on the live deployment and
// steals the active session (reports/live-api.md §8).
//
// `deleteSession` exists only so the engine can propagate a run the game finished *offline*
// (DESIGN.md §3.8, amended). It is irreversible and immediate — the engine gates it behind four
// preconditions and a verified `.prsv` backup; see `mayPropagateClear` in engine.ts.
//
// Request shapes copied from the game's own api layer (reports/verify-client.md §9):
//   GET  /savedata/system/get?clientSessionId=…
//   POST /savedata/system/update?clientSessionId=…            body: raw system JSON
//   GET  /savedata/session/get?slot=N&clientSessionId=…
//   POST /savedata/session/update?slot=N[&trainerId&secretId]&clientSessionId=…  body: raw JSON
//   GET  /savedata/session/delete?slot=N&clientSessionId=…    (an HTTP GET, not DELETE)
//   GET  /account/info
//   POST /account/login                                       body: form-urlencoded
//
// `Origin: https://pokerogue.net` is mandatory — without it Cloudflare answers 403 with an HTML
// block page even for a valid token (reports/live-api.md §4).

import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import { URL } from "node:url";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import type { ClassifiedError } from "./errors";
import { classifyResponse, classifyTransportError, looksLikeHtml } from "./errors";
import type { AccountInfo, SessionSave, SystemSave } from "./types";

export const UPSTREAM_API = "https://api.pokerogue.net";
export const UPSTREAM_ORIGIN = "https://pokerogue.net";
export const DEFAULT_CLIENT_VERSION = "1.12.1.0";
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ApiOk<T> {
  ok: true;
  status: number;
  data: T;
}

export interface ApiErr {
  ok: false;
  status: number;
  reason: ClassifiedError;
  /** The raw response body (or the transport error text). Never shown to the user. */
  raw: string;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;

/**
 * What the sync engine is allowed to do to the server.
 *
 * A `404 save does not exist` is **not** an error: `getSystem`/`getSession` report it as
 * `{ ok: true, status: 404, data: null }`, because "there is no save online" is a normal state the
 * reconciler reasons about.
 */
export interface UpstreamApi {
  getSystem(clientSessionId: string): Promise<ApiResult<SystemSave | null>>;
  updateSystem(clientSessionId: string, save: SystemSave): Promise<ApiResult<null>>;
  getSession(slot: number, clientSessionId: string): Promise<ApiResult<SessionSave | null>>;
  updateSession(slot: number, clientSessionId: string, save: SessionSave): Promise<ApiResult<null>>;
  /**
   * DESTRUCTIVE and irreversible. Only legal from `runSync` to propagate a run the game finished
   * offline, under the four preconditions in DESIGN.md §3.8.
   */
  deleteSession(slot: number, clientSessionId: string): Promise<ApiResult<null>>;
  accountInfo(): Promise<ApiResult<AccountInfo>>;
}

export interface HttpUpstreamApiOptions {
  baseUrl?: string;
  token?: string | null;
  clientVersion?: string;
  timeoutMs?: number;
  log?: Logger;
  /** Injection point for tests; defaults to `https.request`. */
  requestImpl?: typeof httpsRequest;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class HttpUpstreamApi implements UpstreamApi {
  private readonly baseUrl: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly requestImpl: typeof httpsRequest;
  private token: string | null;

  constructor(opts: HttpUpstreamApiOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? UPSTREAM_API).replace(/\/+$/, "");
    this.token = opts.token ?? null;
    this.clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = (opts.log ?? noopLogger).child("upstream");
    this.requestImpl = opts.requestImpl ?? httpsRequest;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  // --- endpoints -------------------------------------------------------------------------------

  async getSystem(clientSessionId: string): Promise<ApiResult<SystemSave | null>> {
    const qs = toUrlSearchParams({ clientSessionId });
    return this.saveGet<SystemSave>(`/savedata/system/get?${qs}`);
  }

  async updateSystem(clientSessionId: string, save: SystemSave): Promise<ApiResult<null>> {
    const qs = toUrlSearchParams({ clientSessionId });
    return this.saveUpdate(`/savedata/system/update?${qs}`, save);
  }

  async getSession(slot: number, clientSessionId: string): Promise<ApiResult<SessionSave | null>> {
    const qs = toUrlSearchParams({ slot, clientSessionId });
    return this.saveGet<SessionSave>(`/savedata/session/get?${qs}`);
  }

  async updateSession(slot: number, clientSessionId: string, save: SessionSave): Promise<ApiResult<null>> {
    // The client sends trainerId/secretId here too; the server ignores them for sessions, but we
    // mirror the request shape so we look like the game.
    const qs = toUrlSearchParams({
      slot,
      trainerId: save["trainerId"],
      secretId: save["secretId"],
      clientSessionId,
    });
    return this.saveUpdate(`/savedata/session/update?${qs}`, save);
  }

  /** `delete` is an HTTP **GET** on this API (session-savedata-api.ts:80 uses `doGet`). */
  async deleteSession(slot: number, clientSessionId: string): Promise<ApiResult<null>> {
    const qs = toUrlSearchParams({ slot, clientSessionId });
    const res = await this.send("GET", `/savedata/session/delete?${qs}`);
    if ("error" in res) {
      return { ok: false, status: 0, reason: res.error, raw: res.raw };
    }
    if (res.status === 200) {
      return { ok: true, status: 200, data: null };
    }
    return this.fail(res);
  }

  async accountInfo(): Promise<ApiResult<AccountInfo>> {
    const res = await this.send("GET", "/account/info");
    if ("error" in res) {
      return { ok: false, status: 0, reason: res.error, raw: res.raw };
    }
    if (res.status !== 200) {
      return this.fail(res);
    }
    return this.parseJson<AccountInfo>(res);
  }

  /**
   * Live-contract-test helper and first-run fallback. The proxy handles the game's own login; this
   * exists so a headless sync can re-authenticate when it holds credentials.
   */
  async login(username: string, password: string): Promise<ApiResult<{ token: string }>> {
    const body = toUrlSearchParams({ username, password }).toString();
    const res = await this.send("POST", "/account/login", body, "application/x-www-form-urlencoded");
    if ("error" in res) {
      return { ok: false, status: 0, reason: res.error, raw: res.raw };
    }
    if (res.status !== 200) {
      return this.fail(res);
    }
    const parsed = this.parseJson<{ token: string }>(res);
    if (parsed.ok && typeof parsed.data.token === "string") {
      this.token = parsed.data.token;
    }
    return parsed;
  }

  // --- shared plumbing -------------------------------------------------------------------------

  private async saveGet<T>(path: string): Promise<ApiResult<T | null>> {
    const res = await this.send("GET", path);
    if ("error" in res) {
      return { ok: false, status: 0, reason: res.error, raw: res.raw };
    }
    if (res.status === 404) {
      // "save does not exist" — a state, not a failure.
      const reason = classifyResponse({ status: 404, contentType: contentTypeOf(res), body: res.body });
      if (reason.kind === "save-not-found") {
        return { ok: true, status: 404, data: null };
      }
      return { ok: false, status: 404, reason, raw: res.body };
    }
    if (res.status !== 200) {
      return this.fail(res);
    }
    return this.parseJson<T>(res) as ApiResult<T | null>;
  }

  private async saveUpdate(path: string, save: object): Promise<ApiResult<null>> {
    const body = JSON.stringify(save);
    const res = await this.send("POST", path, body, "application/json");
    if ("error" in res) {
      return { ok: false, status: 0, reason: res.error, raw: res.raw };
    }
    // system/update answers 204, session/update answers 200. Branch on status, never on an empty
    // body (Invariant §4.3).
    if (res.status === 200 || res.status === 204) {
      return { ok: true, status: res.status, data: null };
    }
    return this.fail(res);
  }

  private fail(res: RawResponse): ApiErr {
    const reason = classifyResponse({ status: res.status, contentType: contentTypeOf(res), body: res.body });
    this.log.warn("upstream rejected request", { status: res.status, kind: reason.kind });
    return { ok: false, status: res.status, reason, raw: res.body };
  }

  private parseJson<T>(res: RawResponse): ApiResult<T> {
    const ct = contentTypeOf(res);
    if (looksLikeHtml(ct, res.body)) {
      return {
        ok: false,
        status: res.status,
        reason: { kind: "offline", detail: "HTML page instead of save data", status: res.status },
        raw: res.body,
      };
    }
    try {
      return { ok: true, status: res.status, data: JSON.parse(res.body) as T };
    } catch {
      return {
        ok: false,
        status: res.status,
        reason: { kind: "unknown-rejection", detail: "response was not JSON", status: res.status },
        raw: res.body,
      };
    }
  }

  private send(
    method: "GET" | "POST",
    path: string,
    body?: string,
    contentType?: string,
  ): Promise<RawResponse | { error: ClassifiedError; raw: string }> {
    const url = new URL(this.baseUrl + path);
    const headers: Record<string, string> = {
      Origin: UPSTREAM_ORIGIN,
      "PKR-Client-Version": this.clientVersion,
      Accept: "*/*",
    };
    if (this.token) {
      // Raw base64 token, no `Bearer` prefix — this is what the game sends.
      headers["Authorization"] = this.token;
    }
    if (body !== undefined) {
      headers["Content-Type"] = contentType ?? "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const options: RequestOptions = {
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      headers,
      timeout: this.timeoutMs,
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: RawResponse | { error: ClassifiedError; raw: string }) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let req: ReturnType<typeof httpsRequest>;
      try {
        req = this.requestImpl(options, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            finish({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", (err: unknown) => finish({ error: classifyTransportError(err), raw: String(err) }));
        });
      } catch (err) {
        finish({ error: classifyTransportError(err), raw: String(err) });
        return;
      }
      req.on("timeout", () => {
        req.destroy();
        finish({
          error: { kind: "offline", detail: `timed out after ${this.timeoutMs}ms` },
          raw: "timeout",
        });
      });
      req.on("error", (err: unknown) => finish({ error: classifyTransportError(err), raw: String(err) }));
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }
}

function contentTypeOf(res: RawResponse): string | null {
  const raw = res.headers["content-type"] ?? res.headers["Content-Type"];
  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }
  return raw ?? null;
}

/**
 * Same semantics as the game's `ApiBase.toUrlSearchParams`: `undefined` and `""` are dropped,
 * everything else is stringified (so `0` and `false` survive).
 */
export function toUrlSearchParams(data: Record<string, unknown>): URLSearchParams {
  const pairs: [string, string][] = [];
  for (const [k, v] of Object.entries(data)) {
    const s = v === undefined ? "" : String(v);
    if (s !== "") {
      pairs.push([k, s]);
    }
  }
  return new URLSearchParams(pairs);
}
