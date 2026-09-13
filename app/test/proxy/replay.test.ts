import * as path from "node:path";
import { URLSearchParams } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Mirror } from "../../src/proxy/mirror";
import { replay } from "../../src/proxy/replay";
import type { ReplayRequest } from "../../src/proxy/replay";
import { cleanupTempDirs, form, makeSession, makeSystem, tempDir, withPlayTime } from "./helpers";

afterAll(cleanupTempDirs);

function mirror(): Mirror {
  return new Mirror(path.join(tempDir(), "mirror"));
}

function call(
  m: Mirror,
  requestPath: string,
  options: {
    method?: string;
    query?: Record<string, string>;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): { status: number; text: string; json: unknown } {
  const req: ReplayRequest = {
    method: options.method ?? "GET",
    path: requestPath,
    query: new URLSearchParams(options.query ?? {}),
    headers: options.headers ?? {},
    body: Buffer.from(options.body ?? "", "utf8"),
  };
  const res = replay(req, m);
  const text = res.body.toString("utf8");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: res.status, text, json: parsed };
}

const CSID = { clientSessionId: "abc123" };

describe("offline replay: account", () => {
  it("logs in a known user with the stored token and does not check the password", () => {
    const m = mirror();
    m.writeAccount({ username: "offsync", token: "stored-token", info: null, lastLoginAt: null });
    const res = call(m, "/account/login", {
      method: "POST",
      body: form({ username: "offsync", password: "anything-at-all" }),
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ token: "stored-token" });
  });

  it("401s an unknown user", () => {
    const m = mirror();
    const empty = call(m, "/account/login", {
      method: "POST",
      body: form({ username: "nobody", password: "x" }),
    });
    expect(empty.status).toBe(401);
    expect(empty.text.trim()).toBe("offline: unknown user");

    m.writeAccount({ username: "offsync", token: "t", info: null, lastLoginAt: null });
    const other = call(m, "/account/login", {
      method: "POST",
      body: form({ username: "someone_else", password: "x" }),
    });
    expect(other.status).toBe(401);
    expect(other.text.trim()).toBe("offline: unknown user");
  });

  it("serves stored account info, or synthesises it, and 401s with no account", () => {
    const m = mirror();
    const none = call(m, "/account/info");
    expect(none.status).toBe(401);
    expect(none.text.trim()).toBe("missing token");
    expect(call(m, "/account/info", { headers: { authorization: "tok" } }).text.trim()).toBe(
      "failed to validate token: sql: no rows in result set",
    );

    m.writeAccount({
      username: "offsync",
      token: "t",
      info: { username: "offsync", lastSessionSlot: 3, discordId: "", googleId: "" },
      lastLoginAt: null,
    });
    const stored = call(m, "/account/info");
    expect(stored.status).toBe(200);
    expect((stored.json as { lastSessionSlot: number }).lastSessionSlot).toBe(3);

    const m2 = mirror();
    m2.writeAccount({ username: "offsync", token: "t", info: null, lastLoginAt: null });
    m2.writeLocalSession(2, makeSession());
    const synthesised = call(m2, "/account/info");
    expect(synthesised.status).toBe(200);
    expect(synthesised.json).toMatchObject({ username: "offsync", lastSessionSlot: 2 });
  });

  it("logs out with 200 and keeps the mirror", () => {
    const m = mirror();
    m.writeAccount({ username: "offsync", token: "t", info: null, lastLoginAt: null });
    const res = call(m, "/account/logout");
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expect(m.readAccount()?.token).toBe("t");
  });
});

describe("offline replay: system", () => {
  it("404s with the server's exact body when there is no save", () => {
    const res = call(mirror(), "/savedata/system/get", { query: CSID });
    expect(res.status).toBe(404);
    expect(res.text.trim()).toBe("save does not exist");
  });

  it("returns the local save and accepts an update as 204", () => {
    const m = mirror();
    const save = makeSystem();
    const update = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify(save),
    });
    expect(update.status).toBe(204);
    expect(update.text).toBe("");
    expect(m.readSystem().dirty).toBe(true);

    const get = call(m, "/savedata/system/get", { query: CSID });
    expect(get.status).toBe(200);
    expect(get.json).toEqual(save);
  });

  it("rejects a lower playtime and accepts an equal one", () => {
    const m = mirror();
    m.setSystemSynced(makeSystem());

    const lower = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify(withPlayTime(makeSystem(), 999)),
    });
    expect(lower.status).toBe(400);
    expect(lower.text.trim()).toBe("session out of date: existing playtime is greater");
    expect(m.readSystem().dirty).toBe(false);

    const equal = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify({ ...withPlayTime(makeSystem(), 1000), gender: 1 }),
    });
    expect(equal.status).toBe(204);

    const higher = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify(withPlayTime(makeSystem(), 1001)),
    });
    expect(higher.status).toBe(204);
    expect(m.readSystem().local?.gameStats).toMatchObject({ playTime: 1001 });
  });

  it("rejects a tid/sid that does not match the base save", () => {
    const m = mirror();
    m.setSystemSynced(makeSystem());
    const res = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify(makeSystem({ trainerId: 60747 })),
    });
    expect(res.status).toBe(400);
    expect(res.text.trim()).toBe("session out of date: stored trainer or secret ID does not match");
  });

  it("accepts any first save (no existing save means no validation)", () => {
    const m = mirror();
    const res = call(m, "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: JSON.stringify(withPlayTime(makeSystem({ trainerId: 1, secretId: 2 }), 0)),
    });
    expect(res.status).toBe(204);
  });

  it("400s a body that is not JSON", () => {
    const res = call(mirror(), "/savedata/system/update", {
      method: "POST",
      query: CSID,
      body: "<html>nope",
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain("failed to decode request body");
  });

  it("answers verify with valid:true and zeroed systemData", () => {
    const m = mirror();
    m.setSystemSynced(makeSystem());
    const res = call(m, "/savedata/system/verify", { query: CSID });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ valid: true });
    expect((res.json as { systemData: { trainerId: number } }).systemData.trainerId).toBe(0);
  });
});

describe("offline replay: sessions", () => {
  it("enforces the slot preamble exactly like the server", () => {
    const m = mirror();
    expect(call(m, "/savedata/session/get", { query: { ...CSID, slot: "5" } })).toMatchObject({
      status: 400,
    });
    expect(
      call(m, "/savedata/session/get", { query: { ...CSID, slot: "5" } }).text.trim(),
    ).toBe("slot id 5 out of range");
    expect(
      call(m, "/savedata/session/get", { query: { ...CSID, slot: "-1" } }).text.trim(),
    ).toBe("slot id -1 out of range");
    expect(call(m, "/savedata/session/get", { query: CSID }).text.trim()).toBe(
      'strconv.Atoi: parsing "": invalid syntax',
    );
    expect(
      call(m, "/savedata/session/get", { query: { ...CSID, slot: "abc" } }).text.trim(),
    ).toBe('strconv.Atoi: parsing "abc": invalid syntax');
    expect(call(m, "/savedata/session/get", { query: { slot: "0" } }).text.trim()).toBe(
      "missing clientSessionId",
    );
    // an empty clientSessionId is present, so it passes the preamble
    expect(
      call(m, "/savedata/session/get", { query: { slot: "0", clientSessionId: "" } }).status,
    ).toBe(404);
  });

  it("round-trips a session and answers update with 200", () => {
    const m = mirror();
    const session = makeSession();
    const update = call(m, "/savedata/session/update", {
      method: "POST",
      query: { ...CSID, slot: "3" },
      body: JSON.stringify(session),
    });
    expect(update.status).toBe(200);
    expect(update.text).toBe("");
    expect(m.readSession(3).dirty).toBe(true);

    const get = call(m, "/savedata/session/get", { query: { ...CSID, slot: "3" } });
    expect(get.status).toBe(200);
    expect(get.json).toEqual(session);
  });

  it("applies the wave-index guard only for the same seed", () => {
    const m = mirror();
    m.writeLocalSession(0, makeSession({ waveIndex: 5 }));

    const regress = call(m, "/savedata/session/update", {
      method: "POST",
      query: { ...CSID, slot: "0" },
      body: JSON.stringify(makeSession({ waveIndex: 1 })),
    });
    expect(regress.status).toBe(400);
    expect(regress.text.trim()).toBe("session out of date: existing wave index is greater");

    const otherSeed = call(m, "/savedata/session/update", {
      method: "POST",
      query: { ...CSID, slot: "0" },
      body: JSON.stringify(makeSession({ seed: "DIFFERENTSEED9", waveIndex: 1 })),
    });
    expect(otherSeed.status).toBe(200);
  });

  it("clears a finished run: slot emptied, clear recorded, {success,error} returned", () => {
    const m = mirror();
    const stored = makeSession({ waveIndex: 199 });
    m.setSessionSynced(0, stored);
    const final = makeSession({ waveIndex: 200, battleType: 2, gameMode: 0 });

    const res = call(m, "/savedata/session/clear", {
      method: "POST",
      query: { ...CSID, slot: "0", trainerId: "60746" },
      body: JSON.stringify(final),
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, error: "" });

    const record = m.readSession(0);
    expect(record.local).toBeNull();
    expect(record.base).toEqual(stored);
    expect(record.localPrev).toEqual(stored);
    expect(record.dirty).toBe(true);
    expect(record.finalSave).toEqual(final);
    expect(record.clearedAt).not.toBeNull();
    expect(call(m, "/savedata/session/get", { query: { ...CSID, slot: "0" } }).status).toBe(404);
  });

  it("reports success:false for a run that did not reach the end, but still clears it", () => {
    const m = mirror();
    m.setSessionSynced(2, makeSession({ waveIndex: 37 }));
    const res = call(m, "/savedata/session/clear", {
      method: "POST",
      query: { ...CSID, slot: "2" },
      body: JSON.stringify(makeSession({ waveIndex: 37, battleType: 0 })),
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: false, error: "" });
    expect(m.readSession(2).local).toBeNull();
    expect(m.readSession(2).clearedAt).not.toBeNull();
  });

  it("recognises a completed daily run (mode 3, wave 50)", () => {
    const m = mirror();
    const res = call(m, "/savedata/session/clear", {
      method: "POST",
      query: { ...CSID, slot: "1" },
      body: JSON.stringify(makeSession({ gameMode: 3, battleType: 2, waveIndex: 50 })),
    });
    expect(res.json).toEqual({ success: true, error: "" });
  });

  it("falls back to the stored local when clear carries no body, and honours the preamble", () => {
    const m = mirror();
    const stored = makeSession({ waveIndex: 8 });
    m.writeLocalSession(4, stored);
    const res = call(m, "/savedata/session/clear", {
      method: "POST",
      query: { ...CSID, slot: "4" },
    });
    expect(res.status).toBe(200);
    expect(m.readSession(4).finalSave).toEqual(stored);

    expect(
      call(m, "/savedata/session/clear", { method: "POST", query: { ...CSID, slot: "9" } }).text.trim(),
    ).toBe("slot id 9 out of range");
    expect(
      call(m, "/savedata/session/clear", { method: "POST", query: { slot: "0" } }).text.trim(),
    ).toBe("missing clientSessionId");
  });

  it("deletes a slot and then 404s it", () => {
    const m = mirror();
    m.setSessionSynced(1, makeSession());
    const del = call(m, "/savedata/session/delete", { query: { ...CSID, slot: "1" } });
    expect(del.status).toBe(200);
    expect(m.readSession(1).local).toBeNull();
    expect(m.readSession(1).dirty).toBe(true);
    expect(call(m, "/savedata/session/get", { query: { ...CSID, slot: "1" } }).status).toBe(404);
  });
});

// B3, reports/milestone-1.md §5: the client throws on any non-JSON / non-2xx answer here and
// reloads the page two seconds later, which would destroy the end-of-run screen.
describe("offline replay: session/newclear (the end of a run)", () => {
  it("answers 200 with a bare JSON boolean, exactly like the server", () => {
    const m = mirror();
    const res = call(m, "/savedata/session/newclear", {
      query: { ...CSID, slot: "0", isVictory: "false" },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("false"); // JSON.parse-able, which is what the client requires
    expect(res.json).toBe(false);
  });

  it("answers even when the slot or the clientSessionId is missing or odd", () => {
    const m = mirror();
    for (const query of [{}, { slot: "9" }, { slot: "nope", ...CSID }, { ...CSID }]) {
      const res = call(m, "/savedata/session/newclear", { query });
      expect(res.status, JSON.stringify(query)).toBe(200);
      expect(res.json, JSON.stringify(query)).toBe(false);
    }
  });

  it("changes nothing in the mirror — the run is still there for session/clear", () => {
    const m = mirror();
    m.setSessionSynced(0, makeSession());
    const before = JSON.stringify(m.readSession(0));
    call(m, "/savedata/session/newclear", { query: { ...CSID, slot: "0", isVictory: "true" } });
    expect(JSON.stringify(m.readSession(0))).toBe(before);
    expect(m.readSession(0).local).not.toBeNull();
  });

  it("and the run can then be cleared normally", () => {
    const m = mirror();
    m.setSessionSynced(0, makeSession());
    call(m, "/savedata/session/newclear", { query: { ...CSID, slot: "0", isVictory: "false" } });
    const cleared = call(m, "/savedata/session/clear", {
      method: "POST",
      query: { ...CSID, slot: "0" },
      body: JSON.stringify(makeSession()),
    });
    expect(cleared.status).toBe(200);
    expect(m.readSession(0).local).toBeNull();
    expect(m.readSession(0).clearedAt).not.toBeNull();
  });
});

describe("offline replay: updateall and the catch-all", () => {
  it("writes both halves and returns 200", () => {
    const m = mirror();
    const system = makeSystem();
    const session = makeSession();
    const res = call(m, "/savedata/updateall", {
      method: "POST",
      body: JSON.stringify({ system, session, sessionSlotId: 2, clientSessionId: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(m.readSystem().local).toEqual(system);
    expect(m.readSession(2).local).toEqual(session);
    expect(m.readSystem().dirty).toBe(true);
    expect(m.readSession(2).dirty).toBe(true);
  });

  it("validates clientSessionId, slot range and the system rules", () => {
    const m = mirror();
    const system = makeSystem();
    const session = makeSession();
    expect(
      call(m, "/savedata/updateall", {
        method: "POST",
        body: JSON.stringify({ system, session, sessionSlotId: 0 }),
      }).text.trim(),
    ).toBe("missing clientSessionId");

    const badSlot = call(m, "/savedata/updateall", {
      method: "POST",
      body: JSON.stringify({ system, session, sessionSlotId: 9, clientSessionId: "abc" }),
    });
    expect(badSlot.status).toBe(500);
    expect(badSlot.text.trim()).toBe("slot id 9 out of range");

    m.setSystemSynced(system);
    const lower = call(m, "/savedata/updateall", {
      method: "POST",
      body: JSON.stringify({
        system: withPlayTime(system, 1),
        session,
        sessionSlotId: 0,
        clientSessionId: "abc",
      }),
    });
    expect(lower.status).toBe(400);
    expect(lower.text.trim()).toBe("session out of date: existing playtime is greater");
  });

  it("503s everything else", () => {
    const m = mirror();
    for (const p of [
      "/game/titlestats",
      "/daily/seed",
      "/daily/rankings",
      "/account/register",
      "/anything",
    ]) {
      const res = call(m, p, { query: { ...CSID, slot: "0" } });
      expect(res.status, p).toBe(503);
      expect(res.text.trim(), p).toBe("offline");
    }
  });
});
