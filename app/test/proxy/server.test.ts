import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../../src/common/log";
import { Connectivity } from "../../src/proxy/connectivity";
import { Mirror } from "../../src/proxy/mirror";
import { startProxy } from "../../src/proxy/server";
import type { ProxyHandle } from "../../src/proxy/server";
import { startFakeUpstream } from "./fake-upstream";
import type { FakeMode, FakeUpstream } from "./fake-upstream";
import {
  FORM_HEADERS,
  JSON_HEADERS,
  cleanupTempDirs,
  form,
  httpRequest,
  makeSession,
  makeSystem,
  tempDir,
  withPlayTime,
} from "./helpers";

interface LogLine {
  level: string;
  msg: string;
  data?: Record<string, unknown>;
}

function collectingLogger(lines: LogLine[], scope = "test"): Logger {
  const push = (level: string) => (msg: string, data?: Record<string, unknown>) =>
    lines.push({ level, msg: `${scope}:${msg}`, data });
  return {
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    child: (s: string) => collectingLogger(lines, `${scope}:${s}`),
  };
}

interface Harness {
  fake: FakeUpstream;
  mirror: Mirror;
  connectivity: Connectivity;
  proxy: ProxyHandle;
  logs: LogLine[];
  gameDir: string;
  token: string;
  close(): Promise<void>;
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.close();
  active = null;
  cleanupTempDirs();
});

async function setup(
  options: { mode?: FakeMode; upstreamTimeoutMs?: number; offline?: boolean } = {},
): Promise<Harness> {
  const fake = await startFakeUpstream(options.mode ?? "normal");
  const workspace = tempDir();
  const gameDir = path.join(workspace, "game");
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "index.html"), "<!doctype html><title>PokeRogue</title>", "utf8");
  fs.writeFileSync(path.join(gameDir, "game.js"), "// game", "utf8");

  const mirror = new Mirror(path.join(workspace, "mirror"));
  const logs: LogLine[] = [];
  const log = collectingLogger(logs);
  const connectivity = new Connectivity({ baseUrl: fake.url, timeoutMs: 500, log });
  if (options.offline) {
    connectivity.markOffline("test");
  } else {
    connectivity.markOnline("test");
  }

  const proxy = await startProxy({
    gameDir,
    mirror,
    port: 0,
    connectivity,
    log,
    upstreamBaseUrl: fake.url,
    upstreamTimeoutMs: options.upstreamTimeoutMs ?? 2000,
  });

  fake.state.accounts.set("offsync", {
    username: "offsync",
    password: "correct-horse",
    token: "",
  });

  const harness: Harness = {
    fake,
    mirror,
    connectivity,
    proxy,
    logs,
    gameDir,
    token: "",
    close: async () => {
      connectivity.stop();
      await proxy.close();
      await fake.close();
    },
  };
  active = harness;
  return harness;
}

async function login(h: Harness): Promise<string> {
  const res = await httpRequest(h.proxy.url, "/api/account/login", {
    method: "POST",
    headers: FORM_HEADERS,
    body: form({ username: "offsync", password: "correct-horse" }),
  });
  expect(res.status).toBe(200);
  h.token = (JSON.parse(res.body) as { token: string }).token;
  return h.token;
}

function auth(h: Harness): Record<string, string> {
  return { Authorization: h.token, "PKR-Client-Version": "1.12.1.0" };
}

describe("proxy: static routing", () => {
  it("serves the game build for non-/api paths", async () => {
    const h = await setup();
    const index = await httpRequest(h.proxy.url, "/");
    expect(index.status).toBe(200);
    expect(index.body).toContain("PokeRogue");
    expect(index.headers["cache-control"]).toBe("no-cache");

    const asset = await httpRequest(h.proxy.url, "/game.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toBe("max-age=3600");

    const missing = await httpRequest(h.proxy.url, "/deep/link");
    expect(missing.status).toBe(404); // no SPA fallback
    const manifest = await httpRequest(h.proxy.url, "/manifest.json");
    expect(manifest.status).toBe(404);

    expect(h.fake.requests).toHaveLength(0);
  });
});

describe("proxy: online passthrough and mirroring", () => {
  it("forwards login and stores username + token", async () => {
    const h = await setup();
    const token = await login(h);
    const account = h.mirror.readAccount();
    expect(account?.username).toBe("offsync");
    expect(account?.token).toBe(token);
    expect(account?.lastLoginAt).not.toBeNull();

    const request = h.fake.requests.at(-1);
    expect(request?.headers.origin).toBe("https://pokerogue.net");
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("passes a rejected login through verbatim and writes nothing", async () => {
    const h = await setup();
    const res = await httpRequest(h.proxy.url, "/api/account/login", {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ username: "offsync", password: "wrong-password" }),
    });
    expect(res.status).toBe(500);
    expect(res.body.trim()).toBe("password doesn't match");
    expect(h.mirror.readAccount()).toBeNull();
  });

  it("stores account info on a 200", async () => {
    const h = await setup();
    await login(h);
    const res = await httpRequest(h.proxy.url, "/api/account/info", { headers: auth(h) });
    expect(res.status).toBe(200);
    expect(h.mirror.readAccount()?.info).toMatchObject({ username: "offsync", lastSessionSlot: -1 });
  });

  it("only forwards the allowed headers, always with Origin", async () => {
    const h = await setup();
    await login(h);
    await httpRequest(h.proxy.url, "/api/account/info", {
      headers: { ...auth(h), Accept: "application/json", "X-Evil": "1", Cookie: "a=b" },
    });
    const request = h.fake.requests.at(-1);
    expect(request?.headers.authorization).toBe(h.token);
    expect(request?.headers["pkr-client-version"]).toBe("1.12.1.0");
    expect(request?.headers.accept).toBe("application/json");
    expect(request?.headers.origin).toBe("https://pokerogue.net");
    expect(request?.headers["x-evil"]).toBeUndefined();
    expect(request?.headers.cookie).toBeUndefined();
  });

  it("mirrors system get (200) and update (204), and leaves the mirror alone on a 400", async () => {
    const h = await setup();
    await login(h);
    const system = makeSystem();

    const missing = await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    expect(missing.status).toBe(404);
    expect(missing.body.trim()).toBe("save does not exist");
    expect(h.mirror.readSystem().local).toBeNull();

    const update = await httpRequest(h.proxy.url, "/api/savedata/system/update?clientSessionId=A", {
      method: "POST",
      headers: { ...auth(h), ...JSON_HEADERS },
      body: JSON.stringify(system),
    });
    expect(update.status).toBe(204);
    let record = h.mirror.readSystem();
    expect(record.local).toEqual(system);
    expect(record.base).toEqual(system);
    expect(record.dirty).toBe(false);

    const get = await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual(system);
    record = h.mirror.readSystem();
    expect(record.dirty).toBe(false);

    const rejected = await httpRequest(
      h.proxy.url,
      "/api/savedata/system/update?clientSessionId=A",
      {
        method: "POST",
        headers: { ...auth(h), ...JSON_HEADERS },
        body: JSON.stringify(withPlayTime(system, 1)),
      },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body.trim()).toBe("session out of date: existing playtime is greater");
    expect(h.mirror.readSystem().local).toEqual(system);
  });

  it("mirrors session update, get and delete", async () => {
    const h = await setup();
    await login(h);
    const session = makeSession({ waveIndex: 4 });

    const update = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/update?slot=2&clientSessionId=A",
      { method: "POST", headers: { ...auth(h), ...JSON_HEADERS }, body: JSON.stringify(session) },
    );
    expect(update.status).toBe(200);
    expect(h.mirror.readSession(2).local).toEqual(session);
    expect(h.mirror.readSession(2).base).toEqual(session);
    expect(h.mirror.readSession(2).dirty).toBe(false);

    const get = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/get?slot=2&clientSessionId=A",
      { headers: auth(h) },
    );
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual(session);

    const removed = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/delete?slot=2&clientSessionId=A",
      { headers: auth(h) },
    );
    expect(removed.status).toBe(200);
    const record = h.mirror.readSession(2);
    expect(record.local).toBeNull();
    expect(record.base).toBeNull();
    expect(record.dirty).toBe(false);
  });

  it("empties the mirror slot when the game clears a run online", async () => {
    const h = await setup();
    await login(h);
    const session = makeSession({ waveIndex: 200, battleType: 2 });
    await httpRequest(h.proxy.url, "/api/savedata/session/update?slot=3&clientSessionId=A", {
      method: "POST",
      headers: { ...auth(h), ...JSON_HEADERS },
      body: JSON.stringify(session),
    });
    expect(h.mirror.readSession(3).local).toEqual(session);

    const cleared = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/clear?slot=3&trainerId=60746&clientSessionId=A",
      { method: "POST", headers: { ...auth(h), ...JSON_HEADERS }, body: JSON.stringify(session) },
    );
    expect(cleared.status).toBe(200);
    expect(JSON.parse(cleared.body)).toMatchObject({ success: true });
    const record = h.mirror.readSession(3);
    expect(record.local).toBeNull();
    expect(record.base).toBeNull();
    expect(record.dirty).toBe(false); // nothing left to push back
    expect(record.clearedAt).toBeNull();
    expect(h.fake.state.sessions[3]).toBeNull();
  });

  it("passes an out-of-range slot through untouched", async () => {
    const h = await setup();
    await login(h);
    const res = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/get?slot=5&clientSessionId=A",
      { headers: auth(h) },
    );
    expect(res.status).toBe(400);
    expect(res.body.trim()).toBe("slot id 5 out of range");
  });

  it("mirrors both halves of updateall", async () => {
    const h = await setup();
    await login(h);
    // updateall requires the active session upstream, which any savedata GET claims.
    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    const system = makeSystem();
    const session = makeSession({ seed: "UPDATEALLSEED", waveIndex: 2 });
    const res = await httpRequest(h.proxy.url, "/api/savedata/updateall", {
      method: "POST",
      headers: { ...auth(h), ...JSON_HEADERS },
      body: JSON.stringify({ system, session, sessionSlotId: 1, clientSessionId: "A" }),
    });
    expect(res.status).toBe(200);
    expect(h.mirror.readSystem().base).toEqual(system);
    expect(h.mirror.readSession(1).base).toEqual(session);
    expect(h.mirror.readSystem().dirty).toBe(false);
    expect(h.mirror.readSession(1).dirty).toBe(false);
  });

  it("replaces the game's clientSessionId with the install-wide id on every savedata call", async () => {
    const h = await setup();
    await login(h);
    // the install id is created lazily, on the first forwarded savedata request
    expect(h.mirror.readState().clientSessionId).toBe("");

    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=PAGE_LOAD_ID_1", {
      headers: auth(h),
    });
    await httpRequest(
      h.proxy.url,
      "/api/savedata/session/get?slot=0&clientSessionId=PAGE_LOAD_ID_2",
      { headers: auth(h) },
    );
    await httpRequest(
      h.proxy.url,
      "/api/savedata/system/update?clientSessionId=PAGE_LOAD_ID_3&trainerId=60746",
      {
        method: "POST",
        headers: { ...auth(h), ...JSON_HEADERS },
        body: JSON.stringify(makeSystem()),
      },
    );

    const installId = h.mirror.readState().clientSessionId;
    expect(installId).toHaveLength(32);
    const savedataRequests = h.fake.requests.filter((r) => r.path.startsWith("/savedata/"));
    expect(savedataRequests.length).toBe(3);
    for (const request of savedataRequests) {
      const received = new URL(request.path, "http://x").searchParams.get("clientSessionId");
      expect(received, request.path).toBe(installId);
    }
    // the game's own ids never left the machine
    const wire = JSON.stringify(h.fake.requests);
    expect(wire).not.toContain("PAGE_LOAD_ID");
    // other parameters and other endpoints are untouched
    expect(savedataRequests[2]?.path).toContain("trainerId=60746");
    expect(h.fake.requests.some((r) => r.path === "/account/login")).toBe(true);
    // the install id is stable across requests and restarts
    expect(h.mirror.readState().clientSessionId).toBe(installId);
  });

  it("logs the path it actually forwarded, so the log shows the install-wide clientSessionId", async () => {
    const h = await setup();
    await login(h);
    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=PAGE_LOAD_ID_1", {
      headers: auth(h),
    });
    const installId = h.mirror.readState().clientSessionId;
    const line = h.logs.filter((l) => l.msg.endsWith(":api")).at(-1);
    expect(line?.data?.source).toBe("upstream");
    expect(String(line?.data?.path)).toContain(`clientSessionId=${installId}`);
    expect(String(line?.data?.path)).not.toContain("PAGE_LOAD_ID");
  });

  it("logs the game's own path when the answer came from the mirror", async () => {
    const h = await setup({ offline: true });
    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=PAGE_LOAD_ID_1", {
      headers: auth(h),
    });
    const line = h.logs.filter((l) => l.msg.endsWith(":api")).at(-1);
    expect(line?.data?.source).toBe("replay");
    expect(String(line?.data?.path)).toContain("PAGE_LOAD_ID_1");
  });

  it("rewrites the clientSessionId inside the updateall body, leaving the saves byte-identical", async () => {
    const h = await setup();
    await login(h);
    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=PAGE_LOAD_ID", {
      headers: auth(h),
    });
    const installId = h.mirror.readState().clientSessionId;
    const system = makeSystem();
    const session = makeSession({ seed: "UPDATEALLSEED", waveIndex: 2 });
    const sent = JSON.stringify({
      system,
      session,
      sessionSlotId: 1,
      clientSessionId: "PAGE_LOAD_ID",
    });

    const res = await httpRequest(h.proxy.url, "/api/savedata/updateall", {
      method: "POST",
      headers: { ...auth(h), ...JSON_HEADERS },
      body: sent,
    });
    expect(res.status).toBe(200);

    const received = h.fake.requests.at(-1);
    expect(received?.path).toBe("/savedata/updateall");
    const parsed = JSON.parse(received?.body ?? "{}") as {
      clientSessionId: string;
      system: unknown;
      session: unknown;
      sessionSlotId: number;
    };
    expect(parsed.clientSessionId).toBe(installId);
    expect(parsed.system).toEqual(system);
    expect(parsed.session).toEqual(session);
    expect(parsed.sessionSlotId).toBe(1);
    expect(received?.body).not.toContain("PAGE_LOAD_ID");
    // only the id changed: everything either side of the field is the original text
    expect(received?.body).toBe(sent.replace("PAGE_LOAD_ID", installId));
  });

  it("marks connectivity online when a request succeeds from the unknown state", async () => {
    const h = await setup();
    h.connectivity.markOffline("test");
    h.connectivity.state = "unknown";
    await login(h);
    expect(h.connectivity.state).toBe("online");
  });

  it("logs every api request with method, path, status, source and duration, without the token", async () => {
    const h = await setup();
    await login(h);
    const entry = h.logs.find((l) => l.msg.endsWith(":api") && l.data?.path === "/account/login");
    expect(entry).toBeDefined();
    expect(entry?.data).toMatchObject({ method: "POST", status: 200, source: "upstream" });
    expect(typeof entry?.data?.ms).toBe("number");
    const serialised = JSON.stringify(h.logs);
    expect(serialised).not.toContain(h.token);
  });
});

describe("proxy: flipping to offline", () => {
  it("treats Cloudflare HTML as offline and re-answers from the mirror", async () => {
    const h = await setup();
    await login(h);
    const system = makeSystem();
    // A savedata GET claims the active clientSessionId upstream before we may write.
    await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    await httpRequest(h.proxy.url, "/api/savedata/system/update?clientSessionId=A", {
      method: "POST",
      headers: { ...auth(h), ...JSON_HEADERS },
      body: JSON.stringify(system),
    });
    expect(h.connectivity.state).toBe("online");

    h.fake.mode = "html403";
    const res = await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).not.toContain("Cloudflare");
    expect(JSON.parse(res.body)).toEqual(system);
    expect(h.connectivity.state).toBe("offline");
    expect(h.connectivity.lastReason).toBe("upstream-html");

    const logged = h.logs.find((l) => l.msg.endsWith(":api") && l.data?.source === "replay");
    expect(logged).toBeDefined();
  });

  it("treats a hanging upstream as offline and re-answers from the mirror", async () => {
    const h = await setup({ upstreamTimeoutMs: 150 });
    await login(h);
    h.mirror.setSystemSynced(makeSystem());

    h.fake.mode = "hang";
    const started = Date.now();
    const res = await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(makeSystem());
    expect(h.connectivity.state).toBe("offline");
    expect(h.connectivity.lastReason).toBe("upstream-timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("treats a dead upstream as offline, never as a rejection", async () => {
    const h = await setup();
    await login(h);
    h.mirror.setSystemSynced(makeSystem());
    await h.fake.close();

    const res = await httpRequest(h.proxy.url, "/api/savedata/system/get?clientSessionId=A", {
      headers: auth(h),
    });
    expect(res.status).toBe(200);
    expect(h.connectivity.state).toBe("offline");
    expect(h.connectivity.lastReason).toMatch(/^upstream-/);
  });

  it("stays offline for later requests without touching the network", async () => {
    const h = await setup({ offline: true });
    h.mirror.writeAccount({
      username: "offsync",
      token: "stored-token",
      info: null,
      lastLoginAt: null,
    });
    const res = await httpRequest(h.proxy.url, "/api/account/login", {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ username: "offsync", password: "whatever" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ token: "stored-token" });
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe("proxy: offline behaviour end to end", () => {
  it("logs in a known user offline and rejects an unknown one", async () => {
    const h = await setup({ offline: true });
    const unknown = await httpRequest(h.proxy.url, "/api/account/login", {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ username: "stranger", password: "x" }),
    });
    expect(unknown.status).toBe(401);
    expect(unknown.body.trim()).toBe("offline: unknown user");

    h.mirror.writeAccount({ username: "offsync", token: "tok", info: null, lastLoginAt: null });
    const known = await httpRequest(h.proxy.url, "/api/account/login", {
      method: "POST",
      headers: FORM_HEADERS,
      body: form({ username: "offsync", password: "x" }),
    });
    expect(known.status).toBe(200);
    expect(JSON.parse(known.body)).toEqual({ token: "tok" });
  });

  it("applies the playtime rule offline and marks the mirror dirty", async () => {
    const h = await setup({ offline: true });
    const system = makeSystem();
    h.mirror.setSystemSynced(system);

    const lower = await httpRequest(h.proxy.url, "/api/savedata/system/update?clientSessionId=A", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(withPlayTime(system, 10)),
    });
    expect(lower.status).toBe(400);
    expect(lower.body.trim()).toBe("session out of date: existing playtime is greater");
    expect(h.mirror.readSystem().dirty).toBe(false);

    const higher = await httpRequest(h.proxy.url, "/api/savedata/system/update?clientSessionId=A", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(withPlayTime(system, 5000)),
    });
    expect(higher.status).toBe(204);
    const record = h.mirror.readSystem();
    expect(record.dirty).toBe(true);
    expect(record.base).toEqual(system);
    expect((record.local?.gameStats as { playTime: number }).playTime).toBe(5000);
  });

  it("plays two offline waves through updateall and keeps them dirty", async () => {
    const h = await setup({ offline: true });
    h.mirror.setSystemSynced(makeSystem());
    h.mirror.setSessionSynced(0, makeSession({ waveIndex: 1 }));

    for (const wave of [2, 3]) {
      const res = await httpRequest(h.proxy.url, "/api/savedata/updateall", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          system: withPlayTime(makeSystem(), 1000 + wave),
          session: makeSession({ waveIndex: wave }),
          sessionSlotId: 0,
          clientSessionId: "A",
        }),
      });
      expect(res.status).toBe(200);
    }
    expect(h.mirror.readSession(0).local?.waveIndex).toBe(3);
    expect(h.mirror.readSession(0).base?.waveIndex).toBe(1);
    expect(h.mirror.readSession(0).dirty).toBe(true);
    expect(h.mirror.readSystem().dirty).toBe(true);
    expect(h.mirror.snapshotLocal().sessions[0]?.waveIndex).toBe(3);
    expect(h.mirror.snapshotBase().sessions[0]?.waveIndex).toBe(1);
  });

  it("clears a run finished offline and records it for the sync engine", async () => {
    const h = await setup({ offline: true });
    const stored = makeSession({ waveIndex: 199 });
    h.mirror.setSessionSynced(0, stored);
    const final = makeSession({ waveIndex: 200, battleType: 2, gameMode: 0 });

    const res = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/clear?slot=0&trainerId=60746&clientSessionId=PAGE_LOAD_ID",
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(final) },
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ success: true, error: "" });

    const record = h.mirror.readSession(0);
    expect(record.local).toBeNull();
    expect(record.base).toEqual(stored);
    expect(record.dirty).toBe(true);
    expect(record.clearedAt).not.toBeNull();
    expect(record.finalSave).toEqual(final);
    expect(h.fake.requests).toHaveLength(0); // never forwarded

    const gone = await httpRequest(
      h.proxy.url,
      "/api/savedata/session/get?slot=0&clientSessionId=PAGE_LOAD_ID",
    );
    expect(gone.status).toBe(404);
  });

  it("503s the endpoints that have no offline answer", async () => {
    const h = await setup({ offline: true });
    for (const p of ["/api/game/titlestats", "/api/daily/seed", "/api/savedata/session/newclear?slot=0&clientSessionId=x"]) {
      const res = await httpRequest(h.proxy.url, p);
      expect(res.status, p).toBe(503);
      expect(res.body.trim(), p).toBe("offline");
    }
  });
});
