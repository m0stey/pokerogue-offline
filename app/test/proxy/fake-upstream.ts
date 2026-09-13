// A local stand-in for https://api.pokerogue.net used by the proxy tests.
//
// It reproduces the behaviours the proxy has to cope with, as verified in reports/live-api.md and
// reports/verify-server.md: the mandatory Origin header, form-encoded account endpoints, the
// active-clientSessionId rule for system writes, tid/sid and playtime validation, the session
// wave-index guard and slot range, updateall, plus two failure modes — a Cloudflare-style
// text/html 403 and a request that never answers.

import * as http from "node:http";
import * as net from "node:net";
import { URL, URLSearchParams } from "node:url";

export type FakeMode = "normal" | "html403" | "hang";

export interface FakeRequestLog {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeAccount {
  username: string;
  password: string;
  token: string;
}

export interface FakeUpstream {
  readonly url: string;
  readonly port: number;
  mode: FakeMode;
  readonly requests: FakeRequestLog[];
  readonly state: {
    accounts: Map<string, FakeAccount>;
    tokens: Map<string, string>;
    system: Record<string, unknown> | null;
    sessions: (Record<string, unknown> | null)[];
    trainerId: number;
    secretId: number;
    activeClientSessionId: string | null;
  };
  close(): Promise<void>;
}

const CLOUDFLARE_HTML =
  "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>" +
  "<body><h1>Sorry, you have been blocked</h1><p>You are unable to access api.pokerogue.net</p></body></html>";

export async function startFakeUpstream(mode: FakeMode = "normal"): Promise<FakeUpstream> {
  const state: FakeUpstream["state"] = {
    accounts: new Map(),
    tokens: new Map(),
    system: null,
    sessions: [null, null, null, null, null],
    trainerId: 0,
    secretId: 0,
    activeClientSessionId: null,
  };
  const requests: FakeRequestLog[] = [];
  const sockets = new Set<net.Socket>();

  const fake = {
    mode,
    requests,
    state,
  } as { mode: FakeMode; requests: FakeRequestLog[]; state: FakeUpstream["state"] };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push({
        method: (req.method ?? "GET").toUpperCase(),
        path: req.url ?? "/",
        headers: req.headers,
        body,
      });

      if (fake.mode === "hang") {
        return; // never answers; the proxy must time out
      }
      if (fake.mode === "html403" || req.headers.origin !== "https://pokerogue.net") {
        html(res, 403, CLOUDFLARE_HTML);
        return;
      }
      handle(req, res, url, body, state);
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    get mode() {
      return fake.mode;
    },
    set mode(value: FakeMode) {
      fake.mode = value;
    },
    requests,
    state,
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

function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  body: string,
  state: FakeUpstream["state"],
): void {
  const path = url.pathname;
  const query = url.searchParams;

  switch (path) {
    case "/game/titlestats":
      json(res, 200, { playerCount: 123, battleCount: 4567 });
      return;

    case "/account/register": {
      const form = new URLSearchParams(body);
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";
      if (!/^\w{1,16}$/.test(username) || password.length < 6) {
        text(res, 500, "invalid username");
        return;
      }
      if (state.accounts.has(username)) {
        text(res, 500, "username is already taken");
        return;
      }
      state.accounts.set(username, { username, password, token: "" });
      empty(res, 200);
      return;
    }

    case "/account/login": {
      const form = new URLSearchParams(body);
      const username = form.get("username") ?? "";
      const password = form.get("password") ?? "";
      const account = state.accounts.get(username);
      if (!account) {
        text(res, 500, "account doesn't exist");
        return;
      }
      if (account.password !== password) {
        text(res, 500, "password doesn't match");
        return;
      }
      const token = Buffer.from(`token-${username}-${state.tokens.size}`.padEnd(32, ".")).toString(
        "base64",
      );
      account.token = token;
      state.tokens.set(token, username);
      json(res, 200, { token });
      return;
    }

    case "/account/logout": {
      const token = authOf(req);
      if (token) {
        state.tokens.delete(token);
      }
      empty(res, 200);
      return;
    }

    case "/account/info": {
      const username = authUser(req, state);
      if (!username) {
        text(res, 401, "missing token");
        return;
      }
      let lastSessionSlot = -1;
      state.sessions.forEach((s, i) => {
        if (s) {
          lastSessionSlot = i;
        }
      });
      json(res, 200, {
        username,
        discordId: "",
        googleId: "",
        lastSessionSlot,
        hasAdminRole: false,
      });
      return;
    }

    case "/savedata/system/get": {
      if (!requireAuth(req, res, state)) {
        return;
      }
      state.activeClientSessionId = query.get("clientSessionId");
      if (!state.system) {
        text(res, 404, "save does not exist");
        return;
      }
      json(res, 200, state.system);
      return;
    }

    case "/savedata/system/update": {
      if (!requireAuth(req, res, state)) {
        return;
      }
      if (query.get("clientSessionId") !== state.activeClientSessionId) {
        text(res, 400, "session out of date: not active");
        return;
      }
      const incoming = parse(body);
      if (!incoming) {
        text(res, 400, "failed to decode request body");
        return;
      }
      const rejection = validateSystem(incoming, state);
      if (rejection) {
        text(res, 400, rejection);
        return;
      }
      if (state.trainerId === 0 && state.secretId === 0) {
        state.trainerId = numberOf(incoming.trainerId);
        state.secretId = numberOf(incoming.secretId);
      }
      state.system = incoming;
      empty(res, 204);
      return;
    }

    case "/savedata/system/verify": {
      if (!requireAuth(req, res, state)) {
        return;
      }
      state.activeClientSessionId = query.get("clientSessionId");
      json(res, 200, { valid: true, systemData: {} });
      return;
    }

    case "/savedata/session/get":
    case "/savedata/session/update":
    case "/savedata/session/clear":
    case "/savedata/session/delete": {
      if (!requireAuth(req, res, state)) {
        return;
      }
      const raw = query.get("slot");
      if (raw === null || !/^[+-]?\d+$/.test(raw)) {
        text(res, 400, `strconv.Atoi: parsing "${raw ?? ""}": invalid syntax`);
        return;
      }
      const slot = Number.parseInt(raw, 10);
      if (slot < 0 || slot >= 5) {
        text(res, 400, `slot id ${slot} out of range`);
        return;
      }
      if (!query.has("clientSessionId")) {
        text(res, 400, "missing clientSessionId");
        return;
      }
      // Any session endpoint seizes the active session, even when it 404s.
      state.activeClientSessionId = query.get("clientSessionId");

      if (path.endsWith("/get")) {
        const stored = state.sessions[slot];
        if (!stored) {
          text(res, 404, "save does not exist");
          return;
        }
        json(res, 200, stored);
        return;
      }
      if (path.endsWith("/delete")) {
        state.sessions[slot] = null;
        empty(res, 200);
        return;
      }
      if (path.endsWith("/clear")) {
        // The real handler deletes the slot unconditionally and answers {success,error}.
        const finished = parse(body);
        state.sessions[slot] = null;
        json(res, 200, {
          success: numberOf(finished?.waveIndex) === 200 && numberOf(finished?.battleType) === 2,
          error: "",
        });
        return;
      }
      const incoming = parse(body);
      if (!incoming) {
        text(res, 400, "failed to decode request body");
        return;
      }
      const stored = state.sessions[slot];
      if (
        stored &&
        stored.seed === incoming.seed &&
        numberOf(stored.waveIndex) > numberOf(incoming.waveIndex)
      ) {
        text(res, 400, "session out of date: existing wave index is greater");
        return;
      }
      state.sessions[slot] = incoming;
      empty(res, 200);
      return;
    }

    case "/savedata/updateall": {
      if (!requireAuth(req, res, state)) {
        return;
      }
      const payload = parse(body);
      if (!payload) {
        text(res, 400, "failed to decode request body");
        return;
      }
      if (!payload.clientSessionId) {
        text(res, 400, "missing clientSessionId");
        return;
      }
      if (payload.clientSessionId !== state.activeClientSessionId) {
        text(res, 400, "session out of date: not active");
        return;
      }
      const system = payload.system as Record<string, unknown> | undefined;
      const session = payload.session as Record<string, unknown> | undefined;
      const slot = numberOf(payload.sessionSlotId);
      if (!system || !session) {
        text(res, 400, "failed to decode request body");
        return;
      }
      const rejection = validateSystem(system, state);
      if (rejection) {
        text(res, 400, rejection);
        return;
      }
      if (state.trainerId === 0 && state.secretId === 0) {
        state.trainerId = numberOf(system.trainerId);
        state.secretId = numberOf(system.secretId);
      }
      state.sessions[slot] = session;
      state.system = system;
      empty(res, 200);
      return;
    }

    default:
      text(res, 404, "404 page not found");
  }
}

function validateSystem(
  incoming: Record<string, unknown>,
  state: FakeUpstream["state"],
): string | null {
  if (state.trainerId > 0 || state.secretId > 0) {
    if (
      numberOf(incoming.trainerId) !== state.trainerId ||
      numberOf(incoming.secretId) !== state.secretId
    ) {
      return "session out of date: stored trainer or secret ID does not match";
    }
  }
  if (state.system) {
    const oldPlay = playTime(state.system);
    const newPlay = playTime(incoming);
    if (oldPlay === null || newPlay === null) {
      return "no playtime found";
    }
    if (newPlay < oldPlay) {
      return "session out of date: existing playtime is greater";
    }
  }
  return null;
}

function playTime(save: Record<string, unknown>): number | null {
  const stats = save.gameStats as Record<string, unknown> | undefined;
  const value = stats?.playTime;
  return typeof value === "number" ? value : null;
}

function authOf(req: http.IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (!value) {
    return null;
  }
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function authUser(req: http.IncomingMessage, state: FakeUpstream["state"]): string | null {
  const token = authOf(req);
  if (!token) {
    return null;
  }
  return state.tokens.get(token) ?? null;
}

function requireAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FakeUpstream["state"],
): boolean {
  const token = authOf(req);
  if (!token) {
    text(res, 401, "missing token");
    return false;
  }
  if (!state.tokens.has(token)) {
    text(res, 401, "failed to validate token: sql: no rows in result set");
    return false;
  }
  return true;
}

function parse(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function text(res: http.ServerResponse, status: number, message: string): void {
  const body = Buffer.from(`${message}\n`, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function html(res: http.ServerResponse, status: number, markup: string): void {
  const body = Buffer.from(markup, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=UTF-8",
    "Content-Length": String(body.length),
  });
  res.end(body);
}

function empty(res: http.ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Length": "0" });
  res.end();
}
