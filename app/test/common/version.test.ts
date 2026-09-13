import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareGameVersion, readGameVersionFile, saveIsNewerThanBuild } from "../../src/common/version";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokerogue-version-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("compareGameVersion", () => {
  it("compares component-wise with trailing zeros trimmed (the server's rule)", () => {
    expect(compareGameVersion("1.12.1.0", "1.12.0.11")).toBe(1);
    expect(compareGameVersion("1.12.0.11", "1.12.1.0")).toBe(-1);
    expect(compareGameVersion("1.12.1.0", "1.12.1")).toBe(0);
    expect(compareGameVersion("1.12.1", "1.12.1.0")).toBe(0);
    expect(compareGameVersion("2.0.0", "1.99.99")).toBe(1);
  });

  it("refuses anything that is not three or four numbers", () => {
    for (const [a, b] of [
      ["1.12", "1.12.0"],
      ["1.12.0.0.1", "1.12.0"],
      ["v1.12.0", "1.12.0"],
      ["1.12.0-beta", "1.12.0"],
      ["", "1.12.0"],
    ]) {
      expect(compareGameVersion(a!, b!), `${a} vs ${b}`).toBeNull();
    }
  });
});

// upstream/pokerogue/src/system/game-data.ts:437 refuses the save when it is STRICTLY newer.
describe("saveIsNewerThanBuild", () => {
  it("is true only when the save is strictly newer than the build", () => {
    expect(saveIsNewerThanBuild("1.12.1.0", "1.12.0.11")).toBe(true);
    expect(saveIsNewerThanBuild("1.12.0.11", "1.12.0.11")).toBe(false);
    expect(saveIsNewerThanBuild("1.12.0.10", "1.12.0.11")).toBe(false);
  });

  it("never guesses when either side is missing or unreadable", () => {
    expect(saveIsNewerThanBuild(null, "1.12.0.11")).toBe(false);
    expect(saveIsNewerThanBuild("1.12.1.0", null)).toBe(false);
    expect(saveIsNewerThanBuild("not a version", "1.12.0.11")).toBe(false);
    expect(saveIsNewerThanBuild("1.12.1.0", "also not")).toBe(false);
  });
});

describe("readGameVersionFile", () => {
  it("reads the file game-build writes next to index.html", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "version.json"),
      JSON.stringify({ tag: "v1.12.0.11", gameVersion: "1.12.0.11", builtAt: "2026-09-12" }),
      "utf8",
    );
    expect(readGameVersionFile(dir)).toEqual({ tag: "v1.12.0.11", gameVersion: "1.12.0.11" });
  });

  it("reads a missing, empty or broken file as 'we do not know'", () => {
    expect(readGameVersionFile(path.join(tempDir(), "nope"))).toEqual({ tag: null, gameVersion: null });
    const broken = tempDir();
    fs.writeFileSync(path.join(broken, "version.json"), "{ not json", "utf8");
    expect(readGameVersionFile(broken)).toEqual({ tag: null, gameVersion: null });
    const blank = tempDir();
    fs.writeFileSync(path.join(blank, "version.json"), JSON.stringify({ tag: "  ", gameVersion: 12 }), "utf8");
    expect(readGameVersionFile(blank)).toEqual({ tag: null, gameVersion: null });
  });
});
