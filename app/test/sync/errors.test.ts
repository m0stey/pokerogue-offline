import { describe, expect, it } from "vitest";
import {
  classifyResponse,
  classifyTransportError,
  describeForUser,
  isRetryable,
  isUnrecoverablePush,
  looksLikeHtml,
} from "../../src/sync/errors";
import type { ClassifiedError, ClassifiedErrorKind } from "../../src/sync/errors";

const plain = (status: number, body: string) =>
  classifyResponse({ status, contentType: "text/plain; charset=utf-8", body });

describe("classifying the server's prose errors", () => {
  // Every string observed live (reports/live-api.md §11), verbatim.
  const observed: [string, number, ClassifiedErrorKind][] = [
    ["save does not exist", 404, "save-not-found"],
    ["session out of date: not active", 400, "not-active"],
    ["session out of date: existing playtime is greater", 400, "playtime-lower"],
    ["session out of date: stored trainer or secret ID does not match", 400, "id-mismatch"],
    ["session out of date: save version below minimum game version", 400, "version-too-low"],
    ["session out of date: existing version is greater", 400, "needs-game-update"],
    ["session out of date: existing wave index is greater", 400, "wave-index-lower"],
    ["session out of date: migrators desynced", 400, "migrators-desynced"],
    ["no playtime found", 400, "no-playtime"],
    ["slot id 5 out of range", 400, "slot-out-of-range"],
    ["missing token", 401, "missing-token"],
    ["failed to validate token: sql: no rows in result set", 401, "auth-failed"],
  ];

  for (const [body, status, kind] of observed) {
    it(`${JSON.stringify(body)} -> ${kind}`, () => {
      expect(plain(status, body).kind).toBe(kind);
    });
  }

  it("tolerates the trailing newline the server actually sends", () => {
    expect(plain(400, "session out of date: not active\n").kind).toBe("not-active");
  });

  it("picks up the slot number", () => {
    const r = plain(400, "slot id 5 out of range");
    expect(r).toEqual({ kind: "slot-out-of-range", detail: "slot id 5 out of range", slot: 5 });
  });

  it("`existing version is greater` becomes needs-game-update (DESIGN.md §3.9)", () => {
    expect(plain(400, "session out of date: existing version is greater").kind).toBe("needs-game-update");
  });

  it("anything unrecognised is unknown-rejection, never a guess", () => {
    const r = plain(400, "some brand new error nobody has seen");
    expect(r.kind).toBe("unknown-rejection");
    expect(isUnrecoverablePush(r)).toBe(false);
  });

  it("an empty 400 body is still unknown-rejection", () => {
    expect(plain(400, "").kind).toBe("unknown-rejection");
  });

  it("5xx with a plain body is a server-error, not a rejection of our data", () => {
    const r = plain(500, "failed to read session save data: sql: no rows in result set");
    expect(r.kind).toBe("server-error");
    expect(isRetryable(r)).toBe(true);
  });
});

describe("HTML and transport failures are always offline (Invariant §4.2)", () => {
  it("a Cloudflare block page by content-type", () => {
    const r = classifyResponse({
      status: 403,
      contentType: "text/html; charset=UTF-8",
      body: "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title>",
    });
    expect(r.kind).toBe("offline");
  });

  it("an HTML body even without a content-type header", () => {
    const r = classifyResponse({ status: 200, contentType: null, body: "  <html><body>blocked</body></html>" });
    expect(r.kind).toBe("offline");
  });

  it("HTML wins over a substring that would otherwise match", () => {
    const r = classifyResponse({
      status: 400,
      contentType: "text/html",
      body: "<html>session out of date: not active</html>",
    });
    expect(r.kind).toBe("offline");
  });

  it("looksLikeHtml is not fooled by JSON or plain text", () => {
    expect(looksLikeHtml("application/json", '{"a":1}')).toBe(false);
    expect(looksLikeHtml("text/plain", "save does not exist")).toBe(false);
    expect(looksLikeHtml(null, "<not really html")).toBe(false);
  });

  it("transport errors", () => {
    for (const err of [
      new Error("getaddrinfo ENOTFOUND api.pokerogue.net"),
      Object.assign(new Error("socket hang up"), { name: "Error" }),
      "ECONNRESET",
      null,
    ]) {
      expect(classifyTransportError(err).kind).toBe("offline");
    }
  });
});

describe("classification groups", () => {
  it("the rejections that will never succeed as-is", () => {
    const kinds: ClassifiedErrorKind[] = [
      "playtime-lower",
      "id-mismatch",
      "version-too-low",
      "needs-game-update",
      "wave-index-lower",
      "migrators-desynced",
      "no-playtime",
    ];
    for (const kind of kinds) {
      expect(isUnrecoverablePush({ kind, detail: "" } as ClassifiedError)).toBe(true);
    }
    expect(isUnrecoverablePush({ kind: "offline", detail: "" })).toBe(false);
    expect(isUnrecoverablePush({ kind: "unknown-rejection", detail: "", status: 400 })).toBe(false);
  });

  it("every kind has plain, non-technical user wording", () => {
    const kinds: ClassifiedError[] = [
      { kind: "offline", detail: "x" },
      { kind: "not-active", detail: "x" },
      { kind: "playtime-lower", detail: "x" },
      { kind: "id-mismatch", detail: "x" },
      { kind: "version-too-low", detail: "x" },
      { kind: "needs-game-update", detail: "x" },
      { kind: "wave-index-lower", detail: "x" },
      { kind: "migrators-desynced", detail: "x" },
      { kind: "no-playtime", detail: "x" },
      { kind: "slot-out-of-range", detail: "x", slot: 5 },
      { kind: "auth-failed", detail: "x" },
      { kind: "missing-token", detail: "x" },
      { kind: "save-not-found", detail: "x" },
      { kind: "server-error", detail: "x", status: 500 },
      { kind: "unknown-rejection", detail: "x", status: 400 },
    ];
    for (const k of kinds) {
      const text = describeForUser(k);
      expect(text.length).toBeGreaterThan(10);
      // No jargon, no codes, no internal names.
      expect(text).not.toMatch(/HTTP|JSON|API|clientSessionId|token:|null|400|500|trainerId/);
    }
  });
});
