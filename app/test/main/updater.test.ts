// Automatic update: find a newer release, download it, refuse anything that does not verify.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { noopLogger } from "../../src/common/log";
import type { Connectivity } from "../../src/main/contracts";
import {
  CHECKSUM_ASSET,
  INSTALLER_ASSET,
  RELEASE_INFO_ASSET,
  Updater,
  compareTags,
  isAllowedDownloadUrl,
  isNewer,
  parseChecksum,
  parseReleaseInfo,
  pickRelease,
  type AvailableUpdate,
  type InstalledVersion,
} from "../../src/main/updater";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokerogue-updater-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function connectivity(state: "online" | "offline"): Connectivity {
  return { state, probe: async () => undefined, markOffline: () => undefined, start: () => undefined, stop: () => undefined, on: () => undefined } as unknown as Connectivity;
}

const GH = "https://github.com/m0stey/pokerogue-offline/releases/download";
function release(tag: string, opts: { assets?: string[]; draft?: boolean; size?: number } = {}) {
  const names = opts.assets ?? [INSTALLER_ASSET, CHECKSUM_ASSET, RELEASE_INFO_ASSET];
  return {
    tag_name: tag,
    draft: opts.draft ?? false,
    prerelease: false,
    assets: names.map((name) => ({ name, browser_download_url: `${GH}/${tag}/${name}`, size: name === INSTALLER_ASSET ? (opts.size ?? 123) : 10 })),
  };
}

const INSTALLED: InstalledVersion = { gameTag: "v1.12.0.11", appVersion: "0.1.0" };

function rig(opts: { releases?: unknown; info?: unknown; online?: boolean; installed?: InstalledVersion } = {}) {
  const found: AvailableUpdate[] = [];
  const updater = new Updater({
    userDataDir: tempDir(),
    log: noopLogger,
    connectivity: connectivity(opts.online === false ? "offline" : "online"),
    installed: () => opts.installed ?? INSTALLED,
    onUpdateAvailable: (u) => found.push(u),
    fetchJson: async (url) => (url.endsWith(RELEASE_INFO_ASSET) ? opts.info : (opts.releases ?? [])),
  });
  return { updater, found };
}

describe("version rules", () => {
  it("compares tags like the game server, with or without a leading v", () => {
    expect(compareTags("v1.12.0.12", "1.12.0.11")).toBe(1);
    expect(compareTags("v1.12.0.11", "v1.12.0.11")).toBe(0);
    expect(compareTags("nonsense", "v1.12.0.11")).toBeNull();
  });

  it("updates for a newer game, or the same game with a newer app, never downgrades", () => {
    expect(isNewer({ gameTag: "v1.12.0.12", appVersion: "0.1.0" }, INSTALLED)).toBe(true);
    expect(isNewer({ gameTag: "v1.12.0.11", appVersion: "0.2.0" }, INSTALLED)).toBe(true);
    expect(isNewer({ gameTag: "v1.12.0.11", appVersion: "0.1.0" }, INSTALLED)).toBe(false);
    expect(isNewer({ gameTag: "v1.12.0.10", appVersion: "9.9.9" }, INSTALLED)).toBe(false);
  });

  it("treats an unreadable release description as nothing", () => {
    expect(parseReleaseInfo({ gameTag: "v1.12.0.12", appVersion: "0.1.0" })).toEqual({ gameTag: "v1.12.0.12", appVersion: "0.1.0" });
    expect(parseReleaseInfo({ gameTag: "latest", appVersion: "0.1.0" })).toBeNull();
    expect(parseReleaseInfo(null)).toBeNull();
  });

  it("reads checksums written by sha256sum", () => {
    const hex = "a".repeat(64);
    expect(parseChecksum(`${hex}  PokeRogue-Setup.exe\n`)).toBe(hex);
    expect(parseChecksum("nope")).toBeNull();
  });

  it("only downloads from GitHub over https", () => {
    expect(isAllowedDownloadUrl(`${GH}/x/${INSTALLER_ASSET}`)).toBe(true);
    expect(isAllowedDownloadUrl("https://release-assets.githubusercontent.com/abc")).toBe(true);
    expect(isAllowedDownloadUrl("http://github.com/x")).toBe(false);
    expect(isAllowedDownloadUrl("https://github.com.evil.example/x")).toBe(false);
  });
});

describe("pickRelease", () => {
  it("takes the newest published release that has all three files", () => {
    const picked = pickRelease([release("draft", { draft: true }), release("incomplete", { assets: [INSTALLER_ASSET] }), release("good", { size: 600 }), release("older")]);
    expect(picked?.releaseTag).toBe("good");
    expect(picked?.sizeBytes).toBe(600);
  });

  it("returns nothing for a feed that is not a list", () => {
    expect(pickRelease({ message: "rate limited" })).toBeNull();
  });
});

describe("checking", () => {
  it("announces a newer release once", async () => {
    const { updater, found } = rig({ releases: [release("r2")], info: { gameTag: "v1.12.0.12", appVersion: "0.1.0" } });
    expect((await updater.checkNow("startup"))?.releaseTag).toBe("r2");
    await updater.checkNow("again");
    expect(found).toHaveLength(1);
    expect(updater.updateFound).toBe(true);
  });

  it("says nothing when the release is the installed version", async () => {
    const { updater, found } = rig({ releases: [release("r1")], info: { gameTag: "v1.12.0.11", appVersion: "0.1.0" } });
    expect(await updater.checkNow("startup")).toBeNull();
    expect(found).toHaveLength(0);
  });

  it("does not look while offline, and the first online look after start is not skipped", async () => {
    const { updater, found } = rig({ online: false, releases: [release("r2")], info: { gameTag: "v1.12.0.12", appVersion: "0.1.0" } });
    expect(await updater.checkNow("startup")).toBeNull();
    (updater as unknown as { deps: { connectivity: Connectivity } }).deps.connectivity = connectivity("online");
    expect((await updater.maybeCheck("came online"))?.releaseTag).toBe("r2");
    expect(found).toHaveLength(1);
  });

  it("survives a broken feed without announcing anything", async () => {
    const found: AvailableUpdate[] = [];
    const updater = new Updater({
      userDataDir: tempDir(),
      log: noopLogger,
      connectivity: connectivity("online"),
      installed: () => INSTALLED,
      onUpdateAvailable: (u) => found.push(u),
      fetchJson: async () => {
        throw new Error("network down");
      },
    });
    expect(await updater.checkNow("startup")).toBeNull();
    expect(found).toHaveLength(0);
  });
});

describe("download", () => {
  const body = Buffer.alloc(60 * 1024 * 1024, 7);
  const goodSha = createHash("sha256").update(body).digest("hex");
  const update: AvailableUpdate = {
    gameTag: "v1.12.0.12",
    appVersion: "0.1.0",
    releaseTag: "release-v1.12.0.12-app0.1.0",
    installerUrl: `${GH}/r/${INSTALLER_ASSET}`,
    checksumUrl: `${GH}/r/${CHECKSUM_ASSET}`,
    sizeBytes: body.length,
  };

  function streamOf(data: Buffer, status = 200, claimed = data.length): IncomingMessage {
    const s = new PassThrough() as unknown as IncomingMessage;
    (s as unknown as { statusCode: number }).statusCode = status;
    (s as unknown as { headers: Record<string, string> }).headers = { "content-length": String(claimed) };
    setImmediate(() => (s as unknown as PassThrough).end(data));
    return s;
  }

  function downloader(checksum: string, data: Buffer, status = 200, claimed = data.length) {
    const userDataDir = tempDir();
    const updater = new Updater({
      userDataDir,
      log: noopLogger,
      connectivity: connectivity("online"),
      installed: () => INSTALLED,
      onUpdateAvailable: () => undefined,
      fetchText: async () => `${checksum}  ${INSTALLER_ASSET}`,
      openStream: async () => streamOf(data, status, claimed),
    });
    return { updater, userDataDir };
  }

  it("keeps a verified installer and reports progress up to 100 %", async () => {
    const { updater } = downloader(goodSha, body);
    const progress: number[] = [];
    const file = await updater.download(update, (f) => progress.push(f));
    expect(fs.statSync(file).size).toBe(body.length);
    expect(updater.readyInstaller).toBe(file);
    expect(progress.at(-1)).toBe(1);
  });

  it("throws away an installer whose checksum does not match", async () => {
    const { updater, userDataDir } = downloader("b".repeat(64), body);
    await expect(updater.download(update)).rejects.toThrow(/verification/);
    expect(updater.readyInstaller).toBeNull();
    expect(fs.readdirSync(path.join(userDataDir, "updates"))).toEqual([]);
  });

  it("throws away a truncated download", async () => {
    const short = body.subarray(0, body.length - 1000);
    const { updater } = downloader(createHash("sha256").update(short).digest("hex"), short, 200, body.length);
    await expect(updater.download({ ...update, sizeBytes: body.length })).rejects.toThrow();
    expect(updater.readyInstaller).toBeNull();
  });

  it("refuses a failed HTTP response", async () => {
    const { updater } = downloader(goodSha, Buffer.alloc(0), 404);
    await expect(updater.download(update)).rejects.toThrow(/404/);
  });
});
