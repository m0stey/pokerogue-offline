import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { noopLogger } from "../../src/common/log";
import { DEV_GAME_DIR, ensureGameFiles, gamePaths, locateGameDir, looksLikeGameDir } from "../../src/main/game-files";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokerogue-gamefiles-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeBuild(dir: string, version?: { tag: string; gameVersion: string }): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>", "utf8");
  if (version) fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify(version), "utf8");
  return dir;
}

describe("finding the game files", () => {
  it("ignores a leftover <userData>/game/current and serves the copy from the installer", () => {
    // Updates replace the program folder only. Serving anything else would make the updater compare
    // against a version it can never change: a reinstall on every start, or no app updates at all.
    const userDataDir = tempDir();
    const resourcesPath = tempDir();
    makeBuild(gamePaths(userDataDir).current, { tag: "v1.11.0.0", gameVersion: "1.11.0.0" });
    makeBuild(path.join(resourcesPath, "game"), { tag: "v1.12.0.11", gameVersion: "1.12.0.11" });

    expect(locateGameDir({ userDataDir, resourcesPath, isPackaged: true })).toEqual({
      dir: path.join(resourcesPath, "game"),
      source: "bundled",
      tag: "v1.12.0.11",
      gameVersion: "1.12.0.11",
    });
  });

  it("falls back to the copy that shipped with the installer", () => {
    const userDataDir = tempDir();
    const resourcesPath = tempDir();
    makeBuild(path.join(resourcesPath, "game"), { tag: "v1.12.0.11", gameVersion: "1.12.0.11" });
    expect(locateGameDir({ userDataDir, resourcesPath, isPackaged: true })?.source).toBe("bundled");
  });

  it("only looks at the development folder when the build is not packaged", () => {
    const userDataDir = tempDir();
    const resourcesPath = tempDir();
    const devGameDir = makeBuild(path.join(tempDir(), "dev"), { tag: "v1.12.0.11", gameVersion: "1.12.0.11" });

    expect(locateGameDir({ userDataDir, resourcesPath, isPackaged: true, devGameDir })).toBeNull();
    expect(locateGameDir({ userDataDir, resourcesPath, isPackaged: false, devGameDir })?.source).toBe("dev");
    expect(DEV_GAME_DIR).toContain("game-build");
  });

  it("reads a build with no version.json as 'we do not know'", () => {
    const userDataDir = tempDir();
    const resourcesPath = tempDir();
    makeBuild(path.join(resourcesPath, "game"));
    expect(locateGameDir({ userDataDir, resourcesPath, isPackaged: true })).toMatchObject({
      tag: null,
      gameVersion: null,
    });
  });

  it("needs an index.html before a folder counts as a game", () => {
    const empty = tempDir();
    expect(looksLikeGameDir(empty)).toBe(false);
    expect(looksLikeGameDir(makeBuild(path.join(empty, "build")))).toBe(true);
  });
});

describe("ensureGameFiles", () => {
  it("creates the game folder and reports where the game is", () => {
    const userDataDir = tempDir();
    const resourcesPath = tempDir();
    makeBuild(path.join(resourcesPath, "game"), { tag: "v1.12.0.11", gameVersion: "1.12.0.11" });

    const found = ensureGameFiles({ userDataDir, resourcesPath, isPackaged: true }, noopLogger);
    expect(found?.gameVersion).toBe("1.12.0.11");
    expect(fs.existsSync(gamePaths(userDataDir).root)).toBe(true);
  });

  it("makes no staging or previous folder any more — nothing here installs anything", () => {
    const userDataDir = tempDir();
    ensureGameFiles({ userDataDir, resourcesPath: tempDir(), isPackaged: true, devGameDir: tempDir() }, noopLogger);
    expect(fs.readdirSync(gamePaths(userDataDir).root)).toEqual([]);
    expect(Object.keys(gamePaths(userDataDir)).sort()).toEqual(["current", "root"]);
  });

  it("returns null when there is nothing to serve", () => {
    expect(
      ensureGameFiles(
        { userDataDir: tempDir(), resourcesPath: tempDir(), isPackaged: false, devGameDir: tempDir() },
        noopLogger,
      ),
    ).toBeNull();
  });
});
