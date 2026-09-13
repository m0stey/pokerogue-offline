// The updater is a notice, not an installer (DECISIONS.md 2026-09-13). These tests cover the
// three things it still has to get right: only look while online, only look every six hours, and
// only speak up when there really is something newer.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { noopLogger } from "../../src/common/log";
import type { Connectivity } from "../../src/main/contracts";
import { Updater, compareTags, gameTag } from "../../src/main/updater";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokerogue-updater-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeConnectivity(state: "online" | "offline" | "unknown"): Connectivity {
  return {
    state,
    probe: async () => undefined,
    markOffline: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    on: () => undefined,
  };
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, ...extra });

interface Rig {
  updater: Updater;
  seen: { latestTag: string; installedTag: string }[];
  fetches: string[];
  userDataDir: string;
}

function rig(options: {
  releases?: unknown;
  installed?: string | null;
  online?: boolean;
  userDataDir?: string;
}): Rig {
  const seen: Rig["seen"] = [];
  const fetches: string[] = [];
  const userDataDir = options.userDataDir ?? tempDir();
  const updater = new Updater({
    userDataDir,
    log: noopLogger,
    connectivity: fakeConnectivity(options.online === false ? "offline" : "online"),
    installedTag: () => (options.installed === undefined ? "v1.12.0.11" : options.installed),
    onNewerVersion: (info) => seen.push(info),
    fetchJson: async (url) => {
      fetches.push(url);
      return options.releases ?? [];
    },
  });
  return { updater, seen, fetches, userDataDir };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("gameTag", () => {
  it("takes the tag out of a `game-<tag>` release, from tag_name or name", () => {
    expect(gameTag({ tag_name: "game-v1.12.0.11" })).toBe("v1.12.0.11");
    expect(gameTag({ tag_name: null, name: "game-v1.13.0.0" })).toBe("v1.13.0.0");
  });

  it("ignores anything that is not a game release", () => {
    expect(gameTag({ tag_name: "v1.12.0.11" })).toBeNull();
    expect(gameTag({ tag_name: "app-v0.1.0" })).toBeNull();
    expect(gameTag({ tag_name: "game-" })).toBeNull();
    expect(gameTag({})).toBeNull();
  });
});

describe("compareTags", () => {
  it("compares tags with or without the leading v", () => {
    expect(compareTags("v1.12.1.0", "v1.12.0.11")).toBe(1);
    expect(compareTags("1.12.0.11", "v1.12.0.11")).toBe(0);
    expect(compareTags("v1.12.0.10", "v1.12.0.11")).toBe(-1);
  });

  it("refuses to guess about a tag it cannot read", () => {
    expect(compareTags("nightly", "v1.12.0.11")).toBeNull();
    expect(compareTags("v1.12.0.11", "latest")).toBeNull();
  });
});

describe("Updater: the notice", () => {
  it("speaks up once when a newer game release exists", async () => {
    const r = rig({ releases: [release("game-v1.13.0.0"), release("game-v1.12.0.11")] });
    await r.updater.checkNow("test");
    expect(r.seen).toEqual([{ latestTag: "v1.13.0.0", installedTag: "v1.12.0.11" }]);
  });

  it("says nothing when the newest release is the one we serve, or older", async () => {
    for (const tag of ["game-v1.12.0.11", "game-v1.12.0.10"]) {
      const r = rig({ releases: [release(tag)] });
      await r.updater.checkNow("test");
      expect(r.seen, tag).toEqual([]);
    }
  });

  it("skips drafts and pre-releases", async () => {
    const r = rig({
      releases: [
        release("game-v2.0.0.0", { draft: true }),
        release("game-v1.99.0.0", { prerelease: true }),
        release("game-v1.12.0.11"),
      ],
    });
    await r.updater.checkNow("test");
    expect(r.seen).toEqual([]);
  });

  it("says nothing when it cannot tell which version is served", async () => {
    const r = rig({ releases: [release("game-v1.13.0.0")], installed: null });
    await r.updater.checkNow("test");
    expect(r.seen).toEqual([]);
  });

  it("says nothing when the tags cannot be compared", async () => {
    const r = rig({ releases: [release("game-nightly")] });
    await r.updater.checkNow("test");
    expect(r.seen).toEqual([]);
  });

  it("says nothing, and never asks GitHub, when a release feed answer makes no sense", async () => {
    const r = rig({ releases: { message: "Not Found" } });
    await r.updater.checkNow("test");
    expect(r.seen).toEqual([]);
  });

  it("swallows a failing check entirely", async () => {
    const r = rig({});
    const updater = new Updater({
      userDataDir: r.userDataDir,
      log: noopLogger,
      connectivity: fakeConnectivity("online"),
      installedTag: () => "v1.12.0.11",
      onNewerVersion: () => expect.unreachable("should not speak up"),
      fetchJson: async () => {
        throw new Error("no network");
      },
    });
    await expect(updater.checkNow("test")).resolves.toBeUndefined();
  });
});

describe("Updater: when it looks", () => {
  it("never looks while offline", async () => {
    const r = rig({ releases: [release("game-v1.13.0.0")], online: false });
    await r.updater.checkNow("test");
    await r.updater.maybeCheck("test");
    expect(r.fetches).toEqual([]);
    expect(r.seen).toEqual([]);
  });

  it("looks at most once every six hours, remembered across restarts", async () => {
    const userDataDir = tempDir();
    const first = rig({ releases: [release("game-v1.12.0.11")], userDataDir });
    await first.updater.maybeCheck("startup");
    expect(first.fetches).toHaveLength(1);

    await first.updater.maybeCheck("timer");
    expect(first.fetches).toHaveLength(1);

    // A fresh Updater over the same folder reads the timestamp back.
    const second = rig({ releases: [release("game-v1.12.0.11")], userDataDir });
    await second.updater.maybeCheck("startup");
    expect(second.fetches).toEqual([]);
  });

  it("uses up its slot even when the check fails, instead of retrying in a loop", async () => {
    const userDataDir = tempDir();
    let calls = 0;
    const updater = new Updater({
      userDataDir,
      log: noopLogger,
      connectivity: fakeConnectivity("online"),
      installedTag: () => "v1.12.0.11",
      onNewerVersion: () => undefined,
      fetchJson: async () => {
        calls += 1;
        throw new Error("no network");
      },
    });
    await updater.maybeCheck("startup");
    await updater.maybeCheck("timer");
    expect(calls).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(userDataDir, "update-state.json"), "utf8")).lastCheckAt)
      .toBeGreaterThan(0);
  });

  it("asks the right repository", async () => {
    const r = rig({ releases: [] });
    await r.updater.checkNow("test");
    expect(r.fetches).toEqual(["https://api.github.com/repos/m0stey/pokerogue-offline/releases?per_page=20"]);
  });

  it("downloads nothing and touches no game folder", async () => {
    const userDataDir = tempDir();
    const r = rig({ releases: [release("game-v1.13.0.0")], userDataDir });
    await r.updater.checkNow("test");
    expect(fs.readdirSync(userDataDir).sort()).toEqual(["update-state.json"]);
  });
});
