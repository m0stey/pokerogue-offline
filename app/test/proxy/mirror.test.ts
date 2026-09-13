import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Mirror, structurallyEqual } from "../../src/proxy/mirror";
import { cleanupTempDirs, makeSession, makeSystem, tempDir, withPlayTime } from "./helpers";

afterAll(cleanupTempDirs);

function freshMirror(): Mirror {
  return new Mirror(path.join(tempDir(), "mirror"));
}

describe("Mirror: layout and atomic writes", () => {
  it("creates its directory and starts empty", () => {
    const mirror = freshMirror();
    expect(fs.existsSync(mirror.dir)).toBe(true);
    const system = mirror.readSystem();
    expect(system).toEqual({
      base: null,
      local: null,
      localPrev: null,
      dirty: false,
      baseFetchedAt: null,
      localWrittenAt: null,
    });
    expect(mirror.readSession(0)).toEqual({
      base: null,
      local: null,
      localPrev: null,
      dirty: false,
      baseFetchedAt: null,
      localWrittenAt: null,
      clearedAt: null,
      finalSave: null,
    });
    expect(mirror.readAccount()).toBeNull();
    expect(mirror.snapshotLocal()).toEqual({ system: null, sessions: [null, null, null, null, null] });
    expect(mirror.snapshotBase().sessions).toHaveLength(5);
  });

  it("writes pretty JSON atomically and leaves no temp files", () => {
    const mirror = freshMirror();
    mirror.writeLocalSystem(makeSystem());
    mirror.writeLocalSession(2, makeSession());
    mirror.writeAccount({ username: "u", token: "t", info: null, lastLoginAt: null });
    mirror.writeState({ clientSessionId: "abc" });

    const files = fs.readdirSync(mirror.dir).sort();
    expect(files).toEqual(["account.json", "session-2.json", "state.json", "system.json"]);
    for (const file of files) {
      const text = fs.readFileSync(path.join(mirror.dir, file), "utf8");
      expect(text.endsWith("\n")).toBe(true);
      expect(text).toContain("\n  "); // pretty printed
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("round-trips account and state", () => {
    const mirror = freshMirror();
    mirror.writeAccount({
      username: "offsync",
      token: "tok",
      info: { username: "offsync", lastSessionSlot: 0 },
      lastLoginAt: "2026-09-12T00:00:00.000Z",
    });
    expect(mirror.readAccount()).toEqual({
      username: "offsync",
      token: "tok",
      info: { username: "offsync", lastSessionSlot: 0 },
      lastLoginAt: "2026-09-12T00:00:00.000Z",
    });

    const id = mirror.ensureClientSessionId();
    expect(id).toHaveLength(32);
    expect(mirror.ensureClientSessionId()).toBe(id);
    expect(mirror.readState().clientSessionId).toBe(id);
  });
});

describe("Mirror: dirty flags", () => {
  it("marks local dirty when it differs from base and clean when it matches", () => {
    const mirror = freshMirror();
    const save = makeSystem();

    mirror.writeLocalSystem(save);
    expect(mirror.readSystem().dirty).toBe(true); // base is still null

    mirror.setBaseSystem(save);
    expect(mirror.readSystem().dirty).toBe(false);

    mirror.writeLocalSystem(withPlayTime(save, 2000));
    expect(mirror.readSystem().dirty).toBe(true);

    mirror.setSystemSynced(withPlayTime(save, 2000));
    const record = mirror.readSystem();
    expect(record.dirty).toBe(false);
    expect(record.base).toEqual(record.local);
    expect(record.baseFetchedAt).not.toBeNull();
    expect(record.localWrittenAt).not.toBeNull();
  });

  it("ignores key order when comparing", () => {
    const mirror = freshMirror();
    mirror.setBaseSystem(makeSystem({ trainerId: 1, secretId: 2 }));
    mirror.writeLocalSystem({
      ...makeSystem({ secretId: 2, trainerId: 1 }),
    });
    expect(mirror.readSystem().dirty).toBe(false);
    expect(structurallyEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("tracks session dirtiness including deletion", () => {
    const mirror = freshMirror();
    const session = makeSession();
    mirror.setSessionSynced(1, session);
    expect(mirror.readSession(1).dirty).toBe(false);

    mirror.writeLocalSession(1, makeSession({ waveIndex: 6 }));
    expect(mirror.readSession(1).dirty).toBe(true);

    mirror.setSessionSynced(1, session);
    mirror.deleteLocalSession(1);
    const record = mirror.readSession(1);
    expect(record.local).toBeNull();
    expect(record.base).not.toBeNull();
    expect(record.dirty).toBe(true);
  });

  it("keeps snapshots aligned with local and base", () => {
    const mirror = freshMirror();
    mirror.setSystemSynced(makeSystem());
    mirror.writeLocalSystem(withPlayTime(makeSystem(), 5000));
    mirror.setSessionSynced(0, makeSession());
    mirror.writeLocalSession(4, makeSession({ seed: "OTHER" }));

    const local = mirror.snapshotLocal();
    const base = mirror.snapshotBase();
    expect((local.system?.gameStats as { playTime: number }).playTime).toBe(5000);
    expect((base.system?.gameStats as { playTime: number }).playTime).toBe(1000);
    expect(local.sessions[4]?.seed).toBe("OTHER");
    expect(base.sessions[4]).toBeNull();
    expect(base.sessions[0]?.seed).toBe("PROBESEED0001");
  });
});

describe("Mirror: localPrev (one-step undo)", () => {
  it("keeps exactly one previous local for the system save", () => {
    const mirror = freshMirror();
    expect(mirror.readSystem().localPrev).toBeNull();

    const first = makeSystem();
    mirror.writeLocalSystem(first);
    expect(mirror.readSystem().localPrev).toBeNull(); // there was nothing before

    const second = withPlayTime(first, 2000);
    mirror.writeLocalSystem(second);
    expect(mirror.readSystem().localPrev).toEqual(first);

    const third = withPlayTime(first, 3000);
    mirror.writeLocalSystem(third);
    const record = mirror.readSystem();
    expect(record.local).toEqual(third);
    expect(record.localPrev).toEqual(second); // one step only
  });

  it("keeps the previous local for sessions, including on delete and sync", () => {
    const mirror = freshMirror();
    const wave1 = makeSession({ waveIndex: 1 });
    const wave2 = makeSession({ waveIndex: 2 });
    mirror.writeLocalSession(0, wave1);
    mirror.writeLocalSession(0, wave2);
    expect(mirror.readSession(0).localPrev).toEqual(wave1);

    mirror.deleteLocalSession(0);
    expect(mirror.readSession(0).local).toBeNull();
    expect(mirror.readSession(0).localPrev).toEqual(wave2);

    mirror.setSessionSynced(0, wave1);
    expect(mirror.readSession(0).localPrev).toBeNull(); // local was null before the pull
    mirror.setSessionSynced(0, wave2);
    expect(mirror.readSession(0).localPrev).toEqual(wave1);
  });

  it("survives a round trip through the file", () => {
    const mirror = freshMirror();
    mirror.writeLocalSystem(makeSystem());
    mirror.writeLocalSystem(withPlayTime(makeSystem(), 9000));
    const reopened = new Mirror(mirror.dir);
    expect((reopened.readSystem().localPrev?.gameStats as { playTime: number }).playTime).toBe(1000);
  });
});

describe("Mirror: offline clear bookkeeping", () => {
  it("clears the slot, records clearedAt and finalSave, and marks it dirty", () => {
    const mirror = freshMirror();
    const stored = makeSession({ waveIndex: 199 });
    mirror.setSessionSynced(0, stored);
    const final = makeSession({ waveIndex: 200, battleType: 2 });

    mirror.clearLocalSession(0, final);
    const record = mirror.readSession(0);
    expect(record.local).toBeNull();
    expect(record.base).toEqual(stored);
    expect(record.localPrev).toEqual(stored);
    expect(record.dirty).toBe(true);
    expect(record.finalSave).toEqual(final);
    expect(record.clearedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("falls back to the last local when the clear carries no save", () => {
    const mirror = freshMirror();
    const stored = makeSession({ waveIndex: 12 });
    mirror.writeLocalSession(3, stored);
    mirror.clearLocalSession(3, null);
    expect(mirror.readSession(3).finalSave).toEqual(stored);
  });

  it("forgets the clear once a new run is written or the server agrees", () => {
    const mirror = freshMirror();
    mirror.writeLocalSession(1, makeSession());
    mirror.clearLocalSession(1, makeSession());
    expect(mirror.readSession(1).clearedAt).not.toBeNull();

    mirror.writeLocalSession(1, makeSession({ seed: "NEWRUN" }));
    expect(mirror.readSession(1).clearedAt).toBeNull();
    expect(mirror.readSession(1).finalSave).toBeNull();

    mirror.clearLocalSession(1, makeSession());
    mirror.setSessionSynced(1, null);
    expect(mirror.readSession(1).clearedAt).toBeNull();
  });

  it("leaves the other slots and the system save untouched", () => {
    const mirror = freshMirror();
    mirror.setSystemSynced(makeSystem());
    mirror.setSessionSynced(0, makeSession());
    mirror.setSessionSynced(1, makeSession({ seed: "KEEPME" }));
    mirror.clearLocalSession(0, makeSession());

    expect(mirror.readSession(1).local?.seed).toBe("KEEPME");
    expect(mirror.readSession(1).clearedAt).toBeNull();
    expect(mirror.readSystem().dirty).toBe(false);
    expect(mirror.snapshotLocal().sessions).toEqual([
      null,
      mirror.readSession(1).local,
      null,
      null,
      null,
    ]);
  });
});

describe("Mirror: slot bounds", () => {
  it("rejects slots outside 0..4", () => {
    const mirror = freshMirror();
    for (const bad of [-1, 5, 1.5, Number.NaN]) {
      expect(() => mirror.readSession(bad)).toThrow(/out of range/);
      expect(() => mirror.writeLocalSession(bad, makeSession())).toThrow(/out of range/);
      expect(() => mirror.setBaseSession(bad, null)).toThrow(/out of range/);
      expect(() => mirror.deleteLocalSession(bad)).toThrow(/out of range/);
      expect(() => mirror.clearLocalSession(bad, null)).toThrow(/out of range/);
    }
    expect(() => mirror.readSession(0)).not.toThrow();
    expect(() => mirror.readSession(4)).not.toThrow();
  });
});

describe("Mirror: corrupt file recovery", () => {
  it("treats unparseable JSON as absent, renames it aside and never deletes it", () => {
    const mirror = freshMirror();
    mirror.writeLocalSystem(makeSystem());
    const file = path.join(mirror.dir, "system.json");
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const record = mirror.readSystem();
    expect(record.local).toBeNull();
    expect(record.dirty).toBe(false);

    const quarantined = fs.readdirSync(mirror.dir).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.startsWith("system.json.corrupt-")).toBe(true);
    expect(fs.readFileSync(path.join(mirror.dir, quarantined[0] as string), "utf8")).toBe(
      "{ this is not json",
    );
    expect(fs.existsSync(file)).toBe(false);

    // and the mirror is usable again straight away
    mirror.writeLocalSystem(makeSystem({ trainerId: 7 }));
    expect(mirror.readSystem().local?.trainerId).toBe(7);
  });

  it("quarantines an empty file, a wrong-shaped record and a broken account", () => {
    const mirror = freshMirror();
    fs.writeFileSync(path.join(mirror.dir, "session-0.json"), "   ", "utf8");
    expect(mirror.readSession(0).local).toBeNull();

    fs.writeFileSync(path.join(mirror.dir, "session-1.json"), JSON.stringify([1, 2, 3]), "utf8");
    expect(mirror.readSession(1).local).toBeNull();

    fs.writeFileSync(path.join(mirror.dir, "account.json"), JSON.stringify({ nope: true }), "utf8");
    expect(mirror.readAccount()).toBeNull();

    const quarantined = fs.readdirSync(mirror.dir).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(3);
  });

  it("never overwrites an existing quarantine file", () => {
    const mirror = freshMirror();
    const file = path.join(mirror.dir, "system.json");
    fs.writeFileSync(file, "broken-1", "utf8");
    mirror.readSystem();
    fs.writeFileSync(file, "broken-2", "utf8");
    mirror.readSystem();

    const quarantined = fs.readdirSync(mirror.dir).filter((f) => f.includes(".corrupt-"));
    expect(quarantined).toHaveLength(2);
    const contents = quarantined
      .map((f) => fs.readFileSync(path.join(mirror.dir, f), "utf8"))
      .sort();
    expect(contents).toEqual(["broken-1", "broken-2"]);
  });

  it("survives a truncated write by keeping the previous file until rename", () => {
    // The temp file is written first; the real file only ever changes by rename, so a reader that
    // races a writer sees either the old or the new content, never a partial file.
    const mirror = freshMirror();
    mirror.writeLocalSystem(makeSystem());
    const before = fs.readFileSync(path.join(mirror.dir, "system.json"), "utf8");
    fs.writeFileSync(path.join(mirror.dir, "system.json.tmp-orphan"), "partial", "utf8");
    expect(fs.readFileSync(path.join(mirror.dir, "system.json"), "utf8")).toBe(before);
    expect(mirror.readSystem().local?.trainerId).toBe(60746);
  });
});
