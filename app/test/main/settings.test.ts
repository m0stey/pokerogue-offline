// settings.json after the scope trim: three fields, and anything an older version wrote is kept.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsStore, defaultSettings } from "../../src/main/settings";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pokerogue-settings-"));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const store = (file: string) => new SettingsStore(file, "C:/users/test/Documents");

describe("settings", () => {
  it("has exactly the three fields that are left", () => {
    expect(Object.keys(defaultSettings("C:/docs")).sort()).toEqual(["askedOnce", "backupsDir", "conflictPolicy"]);
  });

  it("writes its defaults on first use", () => {
    const file = path.join(tempDir(), "settings.json");
    expect(store(file).get()).toEqual({
      conflictPolicy: "ask",
      askedOnce: false,
      backupsDir: path.join("C:/users/test/Documents", "PokeRogue Backups"),
    });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("keeps what an older version wrote instead of throwing it away", () => {
    const file = path.join(tempDir(), "settings.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ conflictPolicy: "prefer-online", allowMeteredDownloads: "never", lastSeenGameTag: "v1" }),
      "utf8",
    );
    const s = store(file);
    expect(s.get().conflictPolicy).toBe("prefer-online");
    expect(s.get()).not.toHaveProperty("allowMeteredDownloads");

    s.update({ askedOnce: true });
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(onDisk.allowMeteredDownloads).toBe("never"); // preserved, simply ignored
    expect(onDisk.askedOnce).toBe(true);
  });

  it("refuses a conflict preference it does not know", () => {
    const file = path.join(tempDir(), "settings.json");
    fs.writeFileSync(file, JSON.stringify({ conflictPolicy: "whatever" }), "utf8");
    expect(store(file).get().conflictPolicy).toBe("ask");
  });

  it("survives an unreadable file", () => {
    const file = path.join(tempDir(), "settings.json");
    fs.writeFileSync(file, "{ not json", "utf8");
    expect(store(file).get().conflictPolicy).toBe("ask");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).conflictPolicy).toBe("ask");
  });
});
