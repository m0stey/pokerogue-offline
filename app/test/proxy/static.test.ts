import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentTypeFor, createStaticHandler, resolveWithinRoot } from "../../src/proxy/static";
import { cleanupTempDirs, httpRequest, tempDir } from "./helpers";

let baseUrl = "";
let server: http.Server;
let root = "";
let outside = "";

beforeAll(async () => {
  const workspace = tempDir();
  root = path.join(workspace, "game");
  outside = path.join(workspace, "secret.txt");
  fs.mkdirSync(path.join(root, "assets", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>PokeRogue</title>", "utf8");
  fs.writeFileSync(path.join(root, "app.js"), "console.log(1);\n", "utf8");
  fs.writeFileSync(path.join(root, "style.css"), "body{}", "utf8");
  fs.writeFileSync(path.join(root, "manifest.webmanifest"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "assets", "images", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, "assets", "audio.mp3"), Buffer.from([1, 2, 3, 4, 5]));
  fs.writeFileSync(outside, "TOP SECRET", "utf8");

  const handle = createStaticHandler({ dir: root });
  server = http.createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupTempDirs();
});

describe("static file server", () => {
  it("serves index.html at / with no-cache and the right length", async () => {
    const res = await httpRequest(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.body)));
    expect(res.body).toContain("PokeRogue");
  });

  it("serves index.html by name with no-cache too", async () => {
    const res = await httpRequest(baseUrl, "/index.html");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves assets with max-age=3600 and correct MIME types", async () => {
    const cases: [string, string][] = [
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/style.css", "text/css; charset=utf-8"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/assets/images/logo.png", "image/png"],
      ["/assets/audio.mp3", "audio/mpeg"],
    ];
    for (const [requestPath, expected] of cases) {
      const res = await httpRequest(baseUrl, requestPath);
      expect(res.status, requestPath).toBe(200);
      expect(res.headers["content-type"], requestPath).toBe(expected);
      expect(res.headers["cache-control"], requestPath).toBe("max-age=3600");
    }
  });

  it("covers every MIME type the design requires", () => {
    const expected: Record<string, string> = {
      "a.html": "text/html",
      "a.js": "text/javascript",
      "a.mjs": "text/javascript",
      "a.css": "text/css",
      "a.json": "application/json",
      "a.png": "image/png",
      "a.jpg": "image/jpeg",
      "a.webp": "image/webp",
      "a.svg": "image/svg+xml",
      "a.ico": "image/x-icon",
      "a.mp3": "audio/mpeg",
      "a.ogg": "audio/ogg",
      "a.wav": "audio/wav",
      "a.woff": "font/woff",
      "a.woff2": "font/woff2",
      "a.ttf": "font/ttf",
      "a.wasm": "application/wasm",
      "a.txt": "text/plain",
      "a.xml": "application/xml",
      "a.webmanifest": "application/manifest+json",
    };
    for (const [file, prefix] of Object.entries(expected)) {
      expect(contentTypeFor(file), file).toContain(prefix);
    }
    expect(contentTypeFor("a.unknown")).toBe("application/octet-stream");
  });

  it("supports HEAD with headers but no body", async () => {
    const res = await httpRequest(baseUrl, "/app.js", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers["content-length"]).toBe("16");
    expect(res.body).toBe("");
  });

  it("never falls back to index.html: every missing path is a 404", async () => {
    // The built index.html loads its assets from relative ./assets URLs, so serving it for an
    // arbitrary path would break asset resolution. There is no SPA fallback.
    for (const missing of [
      "/some/deep/route",
      "/play",
      "/missing-bundle.js",
      "/assets/nope.js",
      "/assets/images/",
    ]) {
      const res = await httpRequest(baseUrl, missing);
      expect(res.status, missing).toBe(404);
      expect(res.body.trim(), missing).toBe("not found");
    }
  });

  it("404s /manifest.json without confusing it with /manifest.webmanifest", async () => {
    const missing = await httpRequest(baseUrl, "/manifest.json");
    expect(missing.status).toBe(404);
    expect(missing.body.trim()).toBe("not found");

    const real = await httpRequest(baseUrl, "/manifest.webmanifest");
    expect(real.status).toBe(200);
    expect(real.headers["content-type"]).toBe("application/manifest+json");
  });

  it("ignores query strings when resolving files", async () => {
    const res = await httpRequest(baseUrl, "/app.js?t=1789231606586");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const index = await httpRequest(baseUrl, "/?t=123");
    expect(index.status).toBe(200);
    expect(index.body).toContain("PokeRogue");

    const stillMissing = await httpRequest(baseUrl, "/manifest.json?t=123");
    expect(stillMissing.status).toBe(404);
  });

  it("blocks path traversal in every encoding", async () => {
    const attempts = [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..\\secret.txt",
    ];
    for (const attempt of attempts) {
      const res = await httpRequest(baseUrl, attempt);
      expect(res.body, attempt).not.toContain("TOP SECRET");
      expect([403, 404], attempt).toContain(res.status);
    }
    expect(resolveWithinRoot(root, "/../secret.txt")).toBeNull();
    expect(resolveWithinRoot(root, "/assets/../../secret.txt")).toBeNull();
    expect(resolveWithinRoot(root, "/assets/logo.png")).toBe(path.join(root, "assets", "logo.png"));
  });

  it("rejects methods other than GET and HEAD", async () => {
    const res = await httpRequest(baseUrl, "/app.js", { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});

// Serves the real built game (game-build/dist/game) if it is present in this checkout.
const REAL_GAME_DIR = path.resolve(process.cwd(), "../game-build/dist/game");
const hasRealBuild = fs.existsSync(path.join(REAL_GAME_DIR, "index.html"));

describe.skipIf(!hasRealBuild)("static server against the real game build", () => {
  let realServer: http.Server;
  let realBaseUrl = "";

  beforeAll(async () => {
    const handle = createStaticHandler({ dir: REAL_GAME_DIR });
    realServer = http.createServer((req, res) => {
      void handle(req, res);
    });
    await new Promise<void>((resolve) => realServer.listen(0, "127.0.0.1", () => resolve()));
    const address = realServer.address();
    realBaseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => realServer.close(() => resolve()));
  });

  it("serves index.html and the JS chunk it references", async () => {
    const index = await httpRequest(realBaseUrl, "/");
    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.headers["cache-control"]).toBe("no-cache");

    const match = /src="\.(\/assets\/[^"]+\.js)"/.exec(index.body);
    expect(match, "index.html should reference a ./assets/*.js chunk").not.toBeNull();
    const chunk = await httpRequest(realBaseUrl, match?.[1] ?? "/missing.js");
    expect(chunk.status).toBe(200);
    expect(chunk.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(Number(chunk.headers["content-length"])).toBeGreaterThan(0);
  });

  it("serves manifest.webmanifest but 404s the manifest.json the game asks for at startup", async () => {
    const webmanifest = await httpRequest(realBaseUrl, "/manifest.webmanifest");
    expect(webmanifest.status).toBe(200);
    expect(webmanifest.headers["content-type"]).toBe("application/manifest+json");
    expect(() => JSON.parse(webmanifest.body)).not.toThrow();

    const manifest = await httpRequest(realBaseUrl, "/manifest.json");
    expect(manifest.status).toBe(404);
    expect(manifest.body).not.toContain("<!doctype");
  });

  it("serves a locale JSON through a cache-busting query string", async () => {
    const locale = await httpRequest(realBaseUrl, "/locales/en/ability.json?t=1789231606586");
    expect(locale.status).toBe(200);
    expect(locale.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(() => JSON.parse(locale.body)).not.toThrow();
  });
});
