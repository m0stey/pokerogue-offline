// Offline replay of the PokeRogue API against the local mirror. Contract: DESIGN.md §3.4
// (the `/api/* offline` list). Status codes and plain-text bodies reproduce what the live server
// sends (reports/live-api.md §3, reports/verify-server.md §3/§6/§7) so the game cannot tell the
// difference.
//
// Deliberate differences from the live server, all documented in NOTES-proxy.md:
//   * no active-clientSessionId bookkeeping (there is exactly one client here, so nothing can be
//     "not active");
//   * no password verification on login;
//   * no gameVersion / migrator validation (the served build is fixed by the app).

import { URLSearchParams } from "node:url";
import type { Logger } from "../common/log";
import { noopLogger } from "../common/log";
import type { AccountInfo, SessionSave, SystemSave } from "../sync/types";
import { SESSION_SLOTS } from "../sync/types";
import type { Mirror } from "./mirror";

export interface ReplayRequest {
  method: string;
  /** Path below `/api`, query string removed, e.g. `/savedata/system/get`. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface ReplayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json";

/** What the live server returns from `verify` on an active session (reports/live-api.md §3.22). */
export const ZERO_SYSTEM_DATA = {
  trainerId: 0,
  secretId: 0,
  gender: 0,
  dexData: null,
  starterData: null,
  starterMoveData: null,
  starterEggMoveData: null,
  gameStats: null,
  unlocks: null,
  achvUnlocks: null,
  voucherUnlocks: null,
  voucherCounts: null,
  eggs: null,
  eggPity: null,
  unlockPity: null,
  gameVersion: "",
  timestamp: 0,
  appliedMigrators: null,
};

export function textResponse(status: number, message: string): ReplayResponse {
  // Go's http.Error appends a newline; keep the bytes identical.
  const body = Buffer.from(`${message}\n`, "utf8");
  return {
    status,
    headers: { "Content-Type": TEXT, "X-Content-Type-Options": "nosniff" },
    body,
  };
}

export function jsonResponse(status: number, value: unknown): ReplayResponse {
  return {
    status,
    headers: { "Content-Type": JSON_TYPE },
    body: Buffer.from(JSON.stringify(value), "utf8"),
  };
}

export function emptyResponse(status: number): ReplayResponse {
  return { status, headers: {}, body: Buffer.alloc(0) };
}

export function offlineResponse(): ReplayResponse {
  return textResponse(503, "offline");
}

/** Answer one `/api` request from the mirror. Never throws. */
export function replay(req: ReplayRequest, mirror: Mirror, log: Logger = noopLogger): ReplayResponse {
  const path = req.path.replace(/\/+$/, "") || "/";
  try {
    switch (path) {
      case "/account/login":
        return accountLogin(req, mirror);
      case "/account/info":
        return accountInfo(req, mirror);
      case "/account/logout":
        return emptyResponse(200);
      case "/savedata/system/get":
        return systemGet(mirror);
      case "/savedata/system/update":
        return systemUpdate(req, mirror);
      case "/savedata/system/verify":
        return jsonResponse(200, { valid: true, systemData: ZERO_SYSTEM_DATA });
      case "/savedata/session/get":
        return sessionGet(req, mirror);
      case "/savedata/session/update":
        return sessionUpdate(req, mirror);
      case "/savedata/session/delete":
        return sessionDelete(req, mirror);
      case "/savedata/session/clear":
        return sessionClear(req, mirror);
      case "/savedata/session/newclear":
        return sessionNewClear();
      case "/savedata/updateall":
        return updateAll(req, mirror);
      default:
        return offlineResponse();
    }
  } catch (err) {
    log.error("replay handler failed", { path, error: String(err) });
    return offlineResponse();
  }
}

// ------------------------------------------------------------------ account

function accountLogin(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const form = new URLSearchParams(req.body.toString("utf8"));
  const username = form.get("username") ?? "";
  const account = mirror.readAccount();
  if (!account || account.username !== username) {
    // Password is NOT checked offline: we have no verifier for it. Documented in NOTES-proxy.md.
    return textResponse(401, "offline: unknown user");
  }
  return jsonResponse(200, { token: account.token });
}

function accountInfo(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const account = mirror.readAccount();
  if (!account) {
    const hasAuth = headerValue(req.headers, "authorization");
    return textResponse(
      401,
      hasAuth ? "failed to validate token: sql: no rows in result set" : "missing token",
    );
  }
  if (account.info) {
    return jsonResponse(200, account.info);
  }
  const info: AccountInfo = {
    username: account.username,
    discordId: "",
    googleId: "",
    lastSessionSlot: lastLocalSessionSlot(mirror),
    hasAdminRole: false,
  };
  return jsonResponse(200, info);
}

function lastLocalSessionSlot(mirror: Mirror): number {
  let last = -1;
  for (let n = 0; n < SESSION_SLOTS; n++) {
    if (mirror.readSession(n).local) {
      last = n;
    }
  }
  return last;
}

// ------------------------------------------------------------------- system

function systemGet(mirror: Mirror): ReplayResponse {
  const local = mirror.readSystem().local;
  if (!local) {
    return textResponse(404, "save does not exist");
  }
  return jsonResponse(200, local);
}

function systemUpdate(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const parsed = parseJsonBody(req.body);
  if ("error" in parsed) {
    return textResponse(400, `failed to decode request body: ${parsed.error}`);
  }
  const incoming = parsed.value as SystemSave;
  const record = mirror.readSystem();

  const rejection = validateSystem(incoming, record.base, record.local);
  if (rejection) {
    return rejection;
  }

  mirror.writeLocalSystem(incoming);
  return emptyResponse(204);
}

/**
 * The subset of the server's system rules we can evaluate locally: tid/sid must match what we
 * believe the server holds, and playTime must not go backwards.
 */
function validateSystem(
  incoming: SystemSave,
  base: SystemSave | null,
  local: SystemSave | null,
): ReplayResponse | null {
  const idReference = base ?? local;
  if (idReference && (num(idReference.trainerId) > 0 || num(idReference.secretId) > 0)) {
    if (
      num(incoming.trainerId) !== num(idReference.trainerId) ||
      num(incoming.secretId) !== num(idReference.secretId)
    ) {
      return textResponse(400, "session out of date: stored trainer or secret ID does not match");
    }
  }

  // The server skips playtime validation entirely when no save exists yet.
  const existing = local ?? base;
  if (existing) {
    const incomingPlay = playTimeOf(incoming);
    const existingPlay = playTimeOf(existing);
    if (incomingPlay === null || existingPlay === null) {
      return textResponse(400, "no playtime found");
    }
    if (incomingPlay < existingPlay) {
      return textResponse(400, "session out of date: existing playtime is greater");
    }
  }
  return null;
}

function playTimeOf(save: SystemSave | null): number | null {
  const stats = save?.gameStats as Record<string, unknown> | undefined;
  const value = stats?.playTime;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ------------------------------------------------------------------ session

interface SlotOk {
  slot: number;
}

function sessionPreamble(req: ReplayRequest): SlotOk | ReplayResponse {
  const raw = req.query.get("slot");
  if (raw === null || !/^[+-]?\d+$/.test(raw)) {
    return textResponse(400, `strconv.Atoi: parsing "${raw ?? ""}": invalid syntax`);
  }
  const slot = Number.parseInt(raw, 10);
  if (slot < 0 || slot >= SESSION_SLOTS) {
    return textResponse(400, `slot id ${slot} out of range`);
  }
  if (!req.query.has("clientSessionId")) {
    return textResponse(400, "missing clientSessionId");
  }
  return { slot };
}

function isSlot(v: SlotOk | ReplayResponse): v is SlotOk {
  return "slot" in v;
}

function sessionGet(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const pre = sessionPreamble(req);
  if (!isSlot(pre)) {
    return pre;
  }
  const local = mirror.readSession(pre.slot).local;
  if (!local) {
    return textResponse(404, "save does not exist");
  }
  return jsonResponse(200, local);
}

function sessionUpdate(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const pre = sessionPreamble(req);
  if (!isSlot(pre)) {
    return pre;
  }
  const parsed = parseJsonBody(req.body);
  if ("error" in parsed) {
    return textResponse(400, `failed to decode request body: ${parsed.error}`);
  }
  const incoming = parsed.value as SessionSave;
  const existing = mirror.readSession(pre.slot).local;
  const guard = waveGuard(existing, incoming);
  if (guard) {
    return guard;
  }
  mirror.writeLocalSession(pre.slot, incoming);
  // The live server answers session/update with 200 (not the system endpoint's 204).
  return emptyResponse(200);
}

function sessionDelete(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const pre = sessionPreamble(req);
  if (!isSlot(pre)) {
    return pre;
  }
  mirror.deleteLocalSession(pre.slot);
  return emptyResponse(200);
}

/**
 * `POST /savedata/session/clear` — the run in this slot finished offline (DESIGN §3.4).
 *
 * The server's handler (api/savedata/clear.go) records daily-leaderboard scoring we must never
 * reproduce, then deletes the slot unconditionally and answers 200 with
 * `{"success":bool,"error":string}` — `success` is "this seed completion was newly recorded", and
 * the client (game-data.ts `tryClearSession`) only checks that `error` is empty before dropping its
 * local copy. We delete the local slot, record the clear for the sync engine, and reproduce that
 * body. This clear is never forwarded or replayed to the server as `clear`.
 */
function sessionClear(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const pre = sessionPreamble(req);
  if (!isSlot(pre)) {
    return pre;
  }
  const parsed = parseJsonBody(req.body);
  if ("error" in parsed && req.body.length > 0) {
    return textResponse(400, `failed to decode request body: ${parsed.error}`);
  }
  const submitted = "value" in parsed ? (parsed.value as SessionSave) : null;
  const record = mirror.readSession(pre.slot);
  mirror.clearLocalSession(pre.slot, submitted);
  const finished = sessionCompleted(submitted ?? record.local);
  return jsonResponse(200, { success: finished, error: "" });
}

/**
 * `GET /savedata/session/newclear` — "is this the first time this seed has been cleared?"
 *
 * This one is not optional and it is not harmless (reports/milestone-1.md §5, B3). The client calls
 * it at the *end of every run*, and `session-savedata-api.ts:newclear` **throws** on anything that
 * is not a 2xx with a JSON body. `game-over-phase.ts:handleGameOver` catches that by clearing the
 * phase queue, showing "serverCommunicationFailed" and **reloading the page two seconds later** —
 * i.e. answering the 503 we used to answer tore down the game-over screen at the exact moment the user
 * is most attached to the result.
 *
 * So we answer what the real server answers: `writeJSON` of a bare Go `bool`
 * (upstream/rogueserver/api/endpoints.go `case "newclear"` → `savedata.NewClear`), 200.
 *
 * `false` is the honest value. The flag becomes `doGameOver(!isDaily || !!success)`: for a classic
 * run it is ignored entirely, and for a daily run — which needs the online `/daily/*` endpoints to
 * start at all — we genuinely cannot know offline whether that seed was already completed, and
 * claiming a first clear would hand out a reward twice.
 *
 * Nothing is recorded and nothing is forwarded or queued: `newclear` only ever *reads* on the
 * server, so there is nothing to replay later, and the sync engine never calls it (Invariant §4.7).
 * Deliberately tolerant about slot and clientSessionId — an error here costs the user the end of a run,
 * and there is no upside to reproducing the server's argument checking for a read-only flag.
 */
function sessionNewClear(): ReplayResponse {
  return jsonResponse(200, false);
}

/** api/savedata/common.go `validateSessionCompleted`: classic wave 200, daily wave 50. */
function sessionCompleted(save: SessionSave | null): boolean {
  if (!save) {
    return false;
  }
  const mode = num(save.gameMode);
  const battleType = num(save.battleType);
  const wave = num(save.waveIndex);
  if (mode === 0) {
    return battleType === 2 && wave === 200;
  }
  if (mode === 3) {
    return battleType === 2 && wave === 50;
  }
  return false;
}

/** The server's only session guard: same seed and a strictly greater stored waveIndex. */
function waveGuard(existing: SessionSave | null, incoming: SessionSave): ReplayResponse | null {
  if (
    existing &&
    existing.seed === incoming.seed &&
    num(existing.waveIndex) > num(incoming.waveIndex)
  ) {
    return textResponse(400, "session out of date: existing wave index is greater");
  }
  return null;
}

// ----------------------------------------------------------------- updateall

function updateAll(req: ReplayRequest, mirror: Mirror): ReplayResponse {
  const parsed = parseJsonBody(req.body);
  if ("error" in parsed) {
    return textResponse(400, `failed to decode request body: ${parsed.error}`);
  }
  const payload = parsed.value as {
    system?: SystemSave;
    session?: SessionSave;
    sessionSlotId?: number;
    clientSessionId?: string;
  };

  if (!payload.clientSessionId) {
    return textResponse(400, "missing clientSessionId");
  }
  const slot = num(payload.sessionSlotId);
  if (!Number.isInteger(slot) || slot < 0 || slot >= SESSION_SLOTS) {
    // The handler has no range check; savedata.Update returns this as a 500.
    return textResponse(500, `slot id ${slot} out of range`);
  }
  const system = payload.system;
  const session = payload.session;
  if (!system || !session) {
    return textResponse(400, "failed to decode request body: missing system or session");
  }
  if (num(system.trainerId) === 0 && num(system.secretId) === 0) {
    return textResponse(500, "invalid system data");
  }

  const systemRecord = mirror.readSystem();
  const rejection = validateSystem(system, systemRecord.base, systemRecord.local);
  if (rejection) {
    return rejection;
  }
  const guard = waveGuard(mirror.readSession(slot).local, session);
  if (guard) {
    return guard;
  }

  // Server order: session first, then system.
  mirror.writeLocalSession(slot, session);
  mirror.writeLocalSystem(system);
  return emptyResponse(200);
}

// ------------------------------------------------------------------ helpers

function parseJsonBody(body: Buffer): { value: unknown } | { error: string } {
  const text = body.toString("utf8").trim();
  if (text === "") {
    return { error: "EOF" };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: "expected a JSON object" };
    }
    return { value };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function num(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return undefined;
}
