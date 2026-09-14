// The keys the window takes for itself. The list has to stay short: everything not in it belongs
// to the game, and the game uses nearly the whole keyboard.

import { describe, expect, it } from "vitest";
import { windowKeyAction, type KeyContext, type KeyPress } from "../../src/main/keys";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  type: "keyDown",
  key,
  control: false,
  meta: false,
  alt: false,
  ...mods,
});

const windowed: KeyContext = { fullScreen: false, devTools: false };
const fullscreen: KeyContext = { fullScreen: true, devTools: false };

describe("reloading the game", () => {
  it("is what F5 does, the same as in the browser", () => {
    expect(windowKeyAction(press("F5"), windowed)).toBe("reload");
    expect(windowKeyAction(press("F5"), fullscreen)).toBe("reload");
  });

  it("is what Ctrl+R does, in either letter case", () => {
    expect(windowKeyAction(press("r", { control: true }), windowed)).toBe("reload");
    expect(windowKeyAction(press("R", { control: true }), windowed)).toBe("reload");
  });

  it("also happens with Shift held, the browser's reload-and-forget-the-cache", () => {
    // Shift is not read at all: here there is nothing worth fetching again, the game's files are
    // on this computer either way.
    expect(windowKeyAction({ ...press("F5"), shift: true } as KeyPress, windowed)).toBe("reload");
    expect(windowKeyAction({ ...press("R", { control: true }), shift: true } as KeyPress, windowed)).toBe("reload");
  });

  it("does not happen on a bare R, which the game itself uses", () => {
    expect(windowKeyAction(press("r"), windowed)).toBeNull();
    expect(windowKeyAction(press("R"), windowed)).toBeNull();
  });

  it("does not happen on Alt+F5 or Alt+R, which are nobody's reload", () => {
    expect(windowKeyAction(press("F5", { alt: true }), windowed)).toBeNull();
    expect(windowKeyAction(press("r", { control: true, alt: true }), windowed)).toBeNull();
  });

  it("happens once per press, not again when the key comes back up", () => {
    expect(windowKeyAction({ ...press("F5"), type: "keyUp" }, windowed)).toBeNull();
    expect(windowKeyAction({ ...press("r", { control: true }), type: "char" }, windowed)).toBeNull();
  });
});

describe("fullscreen", () => {
  it("goes on and off with F11", () => {
    expect(windowKeyAction(press("F11"), windowed)).toBe("fullscreen-on");
    expect(windowKeyAction(press("F11"), fullscreen)).toBe("fullscreen-off");
  });

  it("is left with Escape, and Escape is the game's own key otherwise", () => {
    expect(windowKeyAction(press("Escape"), fullscreen)).toBe("fullscreen-off");
    expect(windowKeyAction(press("Escape"), windowed)).toBeNull();
  });
});

describe("the developer tools", () => {
  it("open with F12 only where they are allowed at all", () => {
    expect(windowKeyAction(press("F12"), { fullScreen: false, devTools: true })).toBe("devtools");
    expect(windowKeyAction(press("F12"), windowed)).toBeNull();
  });
});

describe("everything else", () => {
  it("belongs to the game", () => {
    for (const key of ["a", "s", "d", "Enter", "ArrowUp", "F1", "F4", "Shift", " "]) {
      expect(windowKeyAction(press(key), windowed)).toBeNull();
    }
  });
});
