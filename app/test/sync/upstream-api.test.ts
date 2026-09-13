import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { RequestOptions } from "node:https";
import { describe, expect, it } from "vitest";
import { HttpUpstreamApi, toUrlSearchParams } from "../../src/sync/upstream-api";
import { makeSession, makeSystem } from "./fakes";

interface Captured {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  body: string;
}

interface Canned {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Instead of responding, emit this on the request. */
  error?: Error;
  /** Instead of responding, fire the `timeout` event. */
  timeout?: boolean;
}

/** A stand-in for `https.request` that records what went out and replays a canned response. */
function fakeRequest(canned: Canned | Canned[], captured: Captured[]) {
  const queue = Array.isArray(canned) ? [...canned] : [canned];
  return ((options: RequestOptions, cb?: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      write(c: string): void;
      end(): void;
      destroy(): void;
    };
    let body = "";
    req.write = (c: string) => {
      body += c;
    };
    req.destroy = () => {};
    req.end = () => {
      captured.push({
        method: String(options.method),
        path: String(options.path),
        headers: (options.headers ?? {}) as Record<string, unknown>,
        body,
      });
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      setImmediate(() => {
        if (next.error) {
          req.emit("error", next.error);
          return;
        }
        if (next.timeout) {
          req.emit("timeout");
          return;
        }
        const res = Readable.from([Buffer.from(next.body ?? "")]) as Readable & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = next.status;
        res.headers = next.headers ?? { "content-type": "text/plain" };
        cb?.(res);
      });
    };
    return req;
  }) as never;
}

const SYSTEM = makeSystem();
const SESSION = makeSession();

function api(canned: Canned | Canned[], captured: Captured[] = []) {
  return {
    captured,
    client: new HttpUpstreamApi({
      token: "TOKEN/abc+def=",
      timeoutMs: 50,
      requestImpl: fakeRequest(canned, captured),
    }),
  };
}

describe("request shape", () => {
  it("sends the headers the live server and Cloudflare require", async () => {
    const { client, captured } = api({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(SYSTEM) });
    await client.getSystem("CSID1");
    const req = captured[0]!;
    expect(req.headers["Origin"]).toBe("https://pokerogue.net");
    // Raw base64 token, no `Bearer` prefix.
    expect(req.headers["Authorization"]).toBe("TOKEN/abc+def=");
    expect(req.headers["PKR-Client-Version"]).toBe("1.12.1.0");
  });

  it("GET /savedata/system/get?clientSessionId=…", async () => {
    const { client, captured } = api({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(SYSTEM) });
    await client.getSystem("CSID1");
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.path).toBe("/savedata/system/get?clientSessionId=CSID1");
  });

  it("POST /savedata/system/update?clientSessionId=… with the raw JSON body", async () => {
    const { client, captured } = api({ status: 204, body: "" });
    const res = await client.updateSystem("CSID1", SYSTEM);
    expect(res.ok).toBe(true);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.path).toBe("/savedata/system/update?clientSessionId=CSID1");
    expect(captured[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(captured[0]!.body)).toEqual(SYSTEM);
  });

  it("GET /savedata/session/get?slot=N&clientSessionId=…", async () => {
    const { client, captured } = api({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(SESSION) });
    await client.getSession(3, "CSID1");
    expect(captured[0]!.path).toBe("/savedata/session/get?slot=3&clientSessionId=CSID1");
  });

  it("POST /savedata/session/update carries slot and the ids the client sends", async () => {
    const { client, captured } = api({ status: 200, body: "" });
    await client.updateSession(2, "CSID1", { ...SESSION, trainerId: 60746, secretId: 44388 });
    expect(captured[0]!.path).toBe(
      "/savedata/session/update?slot=2&trainerId=60746&secretId=44388&clientSessionId=CSID1",
    );
  });

  it("drops slot 0? no — 0 survives, as in the game's toUrlSearchParams", async () => {
    const { client, captured } = api({ status: 404, body: "save does not exist" });
    await client.getSession(0, "CSID1");
    expect(captured[0]!.path).toContain("slot=0");
    expect(toUrlSearchParams({ a: 0, b: false, c: undefined, d: "" }).toString()).toBe("a=0&b=false");
  });

  it("POST /account/login is form-urlencoded and stores the token", async () => {
    const { client, captured } = api({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"token":"NEWTOKEN="}',
    });
    const res = await client.login("offsync_test", "pw&with=chars");
    expect(res.ok).toBe(true);
    expect(captured[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(captured[0]!.body).toBe("username=offsync_test&password=pw%26with%3Dchars");
    expect(client.getToken()).toBe("NEWTOKEN=");
  });
});

describe("results", () => {
  it("a 404 'save does not exist' is not an error — it is 'no save yet'", async () => {
    const { client } = api({ status: 404, body: "save does not exist" });
    const res = await client.getSystem("CSID1");
    expect(res).toEqual({ ok: true, status: 404, data: null });
  });

  it("branches on status, not on an empty body (Invariant §4.3)", async () => {
    const ok200 = await api({ status: 200, body: "" }).client.updateSession(0, "C", SESSION);
    const ok204 = await api({ status: 204, body: "" }).client.updateSystem("C", SYSTEM);
    const bad400 = await api({ status: 400, body: "" }).client.updateSystem("C", SYSTEM);
    expect(ok200.ok).toBe(true);
    expect(ok204.ok).toBe(true);
    expect(bad400.ok).toBe(false);
    expect(bad400.ok === false && bad400.reason.kind).toBe("unknown-rejection");
  });

  it("classifies a rejection and keeps the raw body", async () => {
    const { client } = api({ status: 400, body: "session out of date: not active" });
    const res = await client.updateSystem("CSID1", SYSTEM);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.reason.kind).toBe("not-active");
      expect(res.raw).toBe("session out of date: not active");
    }
  });

  it("an HTML content-type is offline, never a rejection", async () => {
    const { client } = await api({
      status: 403,
      headers: { "content-type": "text/html; charset=UTF-8" },
      body: "<!DOCTYPE html><html>Sorry, you have been blocked</html>",
    });
    const res = await client.updateSystem("CSID1", SYSTEM);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("offline");
  });

  it("HTML on a 200 GET is offline too", async () => {
    const { client } = api({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html>challenge</html>",
    });
    const res = await client.getSystem("CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("offline");
  });

  it("a transport error is offline", async () => {
    const { client } = api({ status: 0, error: new Error("getaddrinfo ENOTFOUND api.pokerogue.net") });
    const res = await client.getSystem("CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("offline");
    expect(res.status).toBe(0);
  });

  it("a timeout is offline", async () => {
    const { client } = api({ status: 0, timeout: true });
    const res = await client.getSystem("CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("offline");
  });

  it("a 200 that is not JSON is an unknown rejection, not a crash", async () => {
    const { client } = api({ status: 200, headers: { "content-type": "text/plain" }, body: "{oops" });
    const res = await client.getSystem("CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("unknown-rejection");
  });

  it("accountInfo parses the live shape", async () => {
    const { client } = api({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"username":"offsync_4djvj5","discordId":"","googleId":"","lastSessionSlot":-1,"hasAdminRole":false}',
    });
    const res = await client.accountInfo();
    expect(res.ok && res.data.username).toBe("offsync_4djvj5");
    expect(res.ok && res.data.lastSessionSlot).toBe(-1);
  });

  it("401 on account info is auth-failed", async () => {
    const { client } = api({ status: 401, body: "failed to validate token: sql: no rows in result set" });
    const res = await client.accountInfo();
    expect(res.ok === false && res.reason.kind).toBe("auth-failed");
  });
});

describe("Invariant §4.7 — the dangerous endpoints do not exist here", () => {
  it("has no clear, newclear, verify or updateall", () => {
    const client = new HttpUpstreamApi();
    for (const name of ["clear", "newclear", "verify", "updateAll", "updateall", "delete"]) {
      expect((client as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it("exposes exactly the sync surface", () => {
    const client = new HttpUpstreamApi();
    for (const name of [
      "getSystem",
      "updateSystem",
      "getSession",
      "updateSession",
      "deleteSession",
      "accountInfo",
      "login",
    ]) {
      expect(typeof (client as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

describe("session delete (only for propagating a run finished offline)", () => {
  it("is an HTTP GET on /savedata/session/delete with slot and clientSessionId", async () => {
    const { client, captured } = api({ status: 200, body: "" });
    const res = await client.deleteSession(2, "CSID1");
    expect(res).toEqual({ ok: true, status: 200, data: null });
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.path).toBe("/savedata/session/delete?slot=2&clientSessionId=CSID1");
    expect(captured[0]!.body).toBe("");
  });

  it("classifies a rejection", async () => {
    const { client } = api({ status: 400, body: "slot id 5 out of range" });
    const res = await client.deleteSession(5, "CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("slot-out-of-range");
  });

  it("an HTML answer is offline, not a successful delete", async () => {
    const { client } = api({
      status: 403,
      headers: { "content-type": "text/html" },
      body: "<html>blocked</html>",
    });
    const res = await client.deleteSession(0, "CSID1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason.kind).toBe("offline");
  });
});
