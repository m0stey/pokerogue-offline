// The switches that must be dead in the build the user gets.

import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { FORCE_OFFLINE_FILE, devToolsAllowed, forceOfflineCheck } from "../../src/main/dev-hooks";

describe("the force-offline switch", () => {
  it("does not exist in a packaged build, however much the file is there", () => {
    const check = forceOfflineCheck({
      isPackaged: true,
      userDataDir: "C:/users/test/AppData/Roaming/PokeRogue Offline",
      fileExists: () => true,
    });
    expect(check).toBeUndefined();
  });

  it("exists in a development build and follows the file", () => {
    const asked: string[] = [];
    let present = false;
    const check = forceOfflineCheck({
      isPackaged: false,
      userDataDir: "C:/work/userData",
      fileExists: (file) => {
        asked.push(file);
        return present;
      },
    });
    expect(check).toBeDefined();
    expect(check!()).toBe(false);
    present = true;
    expect(check!()).toBe(true);
    for (const file of asked) {
      expect(file.split(sep).join("/")).toBe(`C:/work/userData/${FORCE_OFFLINE_FILE}`);
    }
  });
});

describe("the developer tools", () => {
  it("are only reachable in a development build", () => {
    expect(devToolsAllowed(true)).toBe(false);
    expect(devToolsAllowed(false)).toBe(true);
  });
});
