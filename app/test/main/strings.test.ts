// The words she reads. These tests are not about wording taste — they guard the two rules the
// owner set on 2026-09-13: everything is German, and nothing is technical.

import { describe, expect, it } from "vitest";
import { formatPlayTime, formatRelative } from "../../src/main/format";
import { APP_NAME, DE, OWNER_NAME } from "../../src/main/strings.de";

/** Every string in DE, with the functions called with plausible arguments. */
function allStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
    } else if (typeof value === "function") {
      out.push(String((value as (...a: never[]) => string)(47 as never, 3 as never)));
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(DE);
  return out;
}

describe("the German strings", () => {
  it("has no empty ones", () => {
    for (const s of allStrings()) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("contains no technical words", () => {
    // The banned list from DECISIONS.md 2026-09-13 plus the obvious neighbours.
    const banned = [
      "sync", "server", "cache", "token", "mirror", "proxy", "backup", "api", "json",
      "merge", "conflict", "upload", "download", "localstorage", "commit", "http",
    ];
    for (const s of allStrings()) {
      const lower = s.toLowerCase();
      for (const word of banned) {
        expect(lower.includes(word), `"${word}" appears in: ${s}`).toBe(false);
      }
    }
  });

  it("contains no English sentences", () => {
    // A cheap smell test: these words cannot occur in a German sentence of ours.
    const english = [" the ", " your ", " you ", " and ", " is ", " we ", " please ", " again"];
    for (const s of allStrings()) {
      const padded = ` ${s.toLowerCase()} `;
      for (const word of english) {
        expect(padded.includes(word), `"${word.trim()}" appears in: ${s}`).toBe(false);
      }
    }
  });

  it("keeps the game's own label for play time", () => {
    // game-build/dist/game/locales/de/game-stats-ui-handler.json: "playTime":"Spielzeit"
    expect(DE.settings.playTime).toBe("Spielzeit");
    expect(DE.conflict.playTime).toBe("Spielzeit");
  });

  it("calls the app PokéRogue, with the accent, everywhere it names it", () => {
    expect(APP_NAME).toBe("PokéRogue");
    expect(DE.titles.game).toBe("PokéRogue");
    for (const s of allStrings()) {
      expect(s.includes("PokeRogue"), `unaccented name in: ${s}`).toBe(false);
    }
  });

  it("tells her who to ask about a new version, and that nothing is lost", () => {
    expect(DE.needsGameUpdate.detail).toContain(OWNER_NAME);
    expect(DE.needsGameUpdate.detail).toContain("Browser");
    expect(DE.needsGameUpdate.detail).toContain("nichts verloren");
  });

  it("offers only the three save choices the settings page is allowed to have", () => {
    expect(Object.keys(DE.settings).sort()).toEqual(
      [
        "aboutHeading",
        "backupsHeading",
        "conflictAsk",
        "conflictHeading",
        "conflictHere",
        "conflictOnline",
        "footnote",
        "gameVersion",
        "heading",
        "lastSavedOnline",
        "notYet",
        "openFolder",
        "playTime",
        "unknown",
      ].sort(),
    );
  });
});

describe("numbers as words", () => {
  it("says play time the way a person would", () => {
    expect(formatPlayTime(0)).toBe("weniger als eine Minute");
    expect(formatPlayTime(45 * 60)).toBe("45 Min.");
    expect(formatPlayTime(132 * 3600 + 12 * 60)).toBe("132 Std. 12 Min.");
    expect(formatPlayTime(null)).toBe("—");
    expect(formatPlayTime(-1)).toBe("—");
  });

  it("says when something last happened", () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const ago = (ms: number) => formatRelative(now - ms, now);
    expect(ago(0)).toBe("gerade eben");
    expect(ago(60_000)).toBe("vor einer Minute");
    expect(ago(12 * 60_000)).toBe("vor 12 Minuten");
    expect(ago(60 * 60_000)).toBe("vor einer Stunde");
    expect(ago(5 * 60 * 60_000)).toBe("vor 5 Stunden");
    expect(ago(24 * 60 * 60_000)).toBe("gestern");
    expect(ago(3 * 24 * 60 * 60_000)).toBe("vor 3 Tagen");
    expect(ago(60 * 24 * 60 * 60_000)).toMatch(/^am \d+\. \w+$/);
    expect(formatRelative(null)).toBe("noch nie");
  });
});
