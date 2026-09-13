import { mkdtempSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_FOLDER_NAME,
  BackupVerificationError,
  createBackupManager,
  dayStamp,
  parseExportedPlaintext,
  plaintextForExport,
  resolveBackupsDir,
  timeStamp,
} from "../../src/sync/backup";
import { decryptPrsv, encryptPrsv, expandSystemDataStr } from "../../src/sync/prsv";
import { makeSession, makeSystem } from "./fakes";

let root: string;
let documentsDir: string;
let userDataDir: string;
let clock: Date;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pkr-backup-"));
  documentsDir = join(root, "Documents");
  userDataDir = join(root, "userData");
  mkdirSync(documentsDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  clock = new Date(2026, 8, 12, 14, 5, 6); // 2026-09-12 14:05:06 local
});

afterEach(() => {
  clock = new Date(0);
});

const make = () => createBackupManager({ documentsDir, userDataDir, now: () => clock });
const docsRoot = () => join(documentsDir, BACKUP_FOLDER_NAME);
const udRoot = () => join(userDataDir, "backups");

describe("where backups go", () => {
  it("defaults to <documents>/PokeRogue Backups", () => {
    expect(resolveBackupsDir({ documentsDir: "C:\\Users\\x\\Documents" })).toBe(
      join("C:\\Users\\x\\Documents", BACKUP_FOLDER_NAME),
    );
  });

  it("uses an explicit backupsDir verbatim, so the settings page can move it", async () => {
    const chosen = join(root, "Somewhere Else");
    const mgr = createBackupManager({ backupsDir: chosen, userDataDir, now: () => clock });
    const path = await mgr.backup("system", null, makeSystem(), "update");
    expect(path).toBe(join(chosen, "2026-09-12", "140506-update-system.prsv"));
    expect(existsSync(path)).toBe(true);
    // the userData copy is unaffected
    expect(existsSync(join(udRoot(), "2026-09-12", "140506-update-system.prsv"))).toBe(true);
  });

  it("backupsDir wins over documentsDir when both are given", () => {
    const chosen = join(root, "Chosen");
    expect(resolveBackupsDir({ backupsDir: chosen, documentsDir })).toBe(chosen);
  });

  it("prunes the chosen folder, not the default one", async () => {
    const chosen = join(root, "Elsewhere");
    const mgr = createBackupManager({ backupsDir: chosen, userDataDir, now: () => clock });
    await mgr.backup("system", null, makeSystem(), "auto");
    clock = new Date(2026, 8, 13, 9, 0, 0);
    await mgr.backup("system", null, makeSystem(), "auto");
    clock = new Date(2027, 5, 1);
    await mgr.prune();
    expect(existsSync(join(chosen, "2026-09-12", "140506-auto-system.prsv"))).toBe(false);
    expect(existsSync(join(chosen, "2026-09-13", "090000-auto-system.prsv"))).toBe(true);
  });

  it("refuses to be created with neither backupsDir nor documentsDir", () => {
    expect(() => createBackupManager({ userDataDir })).toThrowError(TypeError);
  });
});

describe("writing a backup", () => {
  it("uses the DESIGN.md path and filename shape", async () => {
    const mgr = make();
    const path = await mgr.backup("system", null, makeSystem(), "update");
    expect(path).toBe(join(docsRoot(), "2026-09-12", "140506-update-system.prsv"));
    expect(existsSync(path)).toBe(true);
  });

  it("names session backups with their slot", async () => {
    const mgr = make();
    const path = await mgr.backup("session", 3, makeSession(), "conflict");
    expect(path.endsWith(join("2026-09-12", "140506-conflict-session3.prsv"))).toBe(true);
  });

  it("writes a second copy under userData", async () => {
    const mgr = make();
    const path = await mgr.backup("system", null, makeSystem(), "update");
    const copy = join(udRoot(), "2026-09-12", "140506-update-system.prsv");
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(path, "utf8"));
  });

  it("does not collide when two backups land in the same second", async () => {
    const mgr = make();
    const a = await mgr.backup("system", null, makeSystem(), "update");
    const b = await mgr.backup("system", null, makeSystem({ gender: 1 }), "update");
    expect(a).not.toBe(b);
    expect(readdirSync(join(docsRoot(), "2026-09-12")).sort()).toEqual([
      "140506-update-system-2.prsv",
      "140506-update-system.prsv",
    ]);
  });

  it("reuses an identical backup instead of writing a new file every sync", async () => {
    // A save the server keeps refusing is backed up on every run; `conflict` backups are never
    // pruned, so identical copies must not pile up.
    const mgr = make();
    const save = makeSystem();
    const first = await mgr.backup("system", null, save, "conflict");
    clock = new Date(2026, 8, 12, 14, 15, 6); // ten minutes later, same save
    const second = await mgr.backup("system", null, save, "conflict");
    expect(second).toBe(first);
    expect(readdirSync(join(docsRoot(), "2026-09-12"))).toEqual(["140506-conflict-system.prsv"]);
  });

  it("still writes a new file when the content changed", async () => {
    const mgr = make();
    await mgr.backup("system", null, makeSystem(), "conflict");
    clock = new Date(2026, 8, 12, 14, 15, 6);
    await mgr.backup("system", null, makeSystem({ gender: 1 }), "conflict");
    expect(readdirSync(join(docsRoot(), "2026-09-12")).sort()).toEqual([
      "140506-conflict-system.prsv",
      "141506-conflict-system.prsv",
    ]);
  });

  it("does not confuse a different reason, kind or slot", async () => {
    const mgr = make();
    const save = makeSession();
    await mgr.backup("session", 0, save, "update");
    await mgr.backup("session", 0, save, "conflict"); // different reason
    await mgr.backup("session", 1, save, "update"); // different slot
    expect(readdirSync(join(docsRoot(), "2026-09-12")).sort()).toEqual([
      "140506-conflict-session0.prsv",
      "140506-update-session0.prsv",
      "140506-update-session1.prsv",
    ]);
  });

  it("leaves no .tmp files behind", async () => {
    const mgr = make();
    await mgr.backup("system", null, makeSystem(), "update");
    expect(readdirSync(join(docsRoot(), "2026-09-12")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("the file the game would import", () => {
  it("a system backup is key-shortened before encryption, exactly like tryExportData", async () => {
    const save = makeSystem({
      dexData: { "1": { seenAttr: "255", caughtAttr: "34084861955", ivs: [1, 2, 3] } },
      starterData: { "1": { moveset: [33], candyCount: 3, passiveAttr: 0 } },
    });
    const mgr = make();
    const path = await mgr.backup("system", null, save, "update");
    const plaintext = decryptPrsv(readFileSync(path, "utf8"));

    expect(plaintext).toContain('"$sa"');
    expect(plaintext).toContain('"$ca"');
    expect(plaintext).toContain('"$i"');
    expect(plaintext).toContain('"$m"');
    expect(plaintext).not.toContain("seenAttr");
    // ... and the game's import path recovers the original save exactly.
    expect(JSON.parse(expandSystemDataStr(plaintext))).toEqual(save);
  });

  it("a session backup is NOT key-shortened (game-data.ts:1291 assigns the response verbatim)", async () => {
    const save = makeSession({ party: [{ moveset: [{ moveId: 33 }], ivs: [1, 2, 3] }] });
    const mgr = make();
    const path = await mgr.backup("session", 0, save, "update");
    const plaintext = decryptPrsv(readFileSync(path, "utf8"));
    expect(plaintext).toContain('"moveset"');
    expect(plaintext).toContain('"ivs"');
    expect(plaintext).not.toContain('"$m"');
    expect(JSON.parse(plaintext)).toEqual(save);
  });

  it("plaintextForExport / parseExportedPlaintext are inverses", () => {
    const sys = makeSystem();
    expect(parseExportedPlaintext("system", plaintextForExport("system", sys))).toEqual(sys);
    const sess = makeSession();
    expect(parseExportedPlaintext("session", plaintextForExport("session", sess))).toEqual(sess);
  });

  it("the blob starts with the OpenSSL envelope the game's AES.decrypt expects", async () => {
    const mgr = make();
    const path = await mgr.backup("system", null, makeSystem(), "update");
    expect(readFileSync(path, "utf8").startsWith("U2FsdGVkX1")).toBe(true);
  });
});

describe("verify-after-write", () => {
  it("re-reads, decrypts, parses and compares before returning", async () => {
    // Proven indirectly: corrupt the written file through a patched writeFile and watch it fail.
    const mgr = createBackupManager({
      documentsDir,
      userDataDir,
      now: () => clock,
    });
    const path = await mgr.backup("system", null, makeSystem(), "update");
    // The returned file really does decrypt to the save.
    expect(JSON.parse(expandSystemDataStr(decryptPrsv(readFileSync(path, "utf8"))))).toEqual(makeSystem());
  });

  it("throws and removes the file when the round trip does not reproduce the save", async () => {
    // The client's key shortening is a raw string substitution, so a save whose *value* is the
    // literal "$sa" comes back as "seenAttr". The real game has the same hole; we must notice
    // rather than hand back a backup that would import as something else.
    const save = makeSystem({ trickyNote: "$sa" } as Record<string, unknown>);
    const mgr = make();
    await expect(mgr.backup("system", null, save, "update")).rejects.toThrowError(BackupVerificationError);
    const dir = join(docsRoot(), "2026-09-12");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("throws when the file on disk cannot be decrypted at all", async () => {
    const dir = join(docsRoot(), "2026-09-12");
    mkdirSync(dir, { recursive: true });
    const bogus = join(dir, "bogus.prsv");
    writeFileSync(bogus, "not a prsv at all", "utf8");
    expect(() => decryptPrsv(readFileSync(bogus, "utf8"))).toThrow();
    // and a well-formed one parses, which is what the manager relies on
    writeFileSync(bogus, encryptPrsv(plaintextForExport("system", makeSystem())), "utf8");
    expect(parseExportedPlaintext("system", decryptPrsv(readFileSync(bogus, "utf8")))).toEqual(makeSystem());
  });

  it("refuses a non-object save", async () => {
    const mgr = make();
    await expect(mgr.backup("system", null, null as unknown as object, "update")).rejects.toThrow(TypeError);
  });
});

describe("pruning (DESIGN.md §3.7)", () => {
  /** Write a backup file directly, as if it had been made at `at`. */
  function seed(at: Date, reason: string, kind = "system"): string {
    const dir = join(docsRoot(), dayStamp(at));
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${timeStamp(at)}-${reason}-${kind}.prsv`);
    writeFileSync(p, encryptPrsv(JSON.stringify(makeSystem())), "utf8");
    return p;
  }

  it("keeps everything inside 30 days", async () => {
    const recent = [
      seed(new Date(2026, 8, 12, 1, 0, 0), "auto"),
      seed(new Date(2026, 8, 1, 1, 0, 0), "auto"),
      seed(new Date(2026, 7, 20, 1, 0, 0), "auto"), // 23 days old
    ];
    await make().prune();
    for (const p of recent) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it("keeps only the last file per calendar month once older than 30 days", async () => {
    const may1 = seed(new Date(2026, 4, 3, 9, 0, 0), "auto");
    const may2 = seed(new Date(2026, 4, 17, 10, 0, 0), "auto");
    const may3 = seed(new Date(2026, 4, 17, 23, 30, 0), "auto"); // latest in May
    const apr1 = seed(new Date(2026, 3, 2, 9, 0, 0), "auto");
    const apr2 = seed(new Date(2026, 3, 28, 9, 0, 0), "auto"); // latest in April

    await make().prune();

    expect(existsSync(may3)).toBe(true);
    expect(existsSync(may1)).toBe(false);
    expect(existsSync(may2)).toBe(false);
    expect(existsSync(apr2)).toBe(true);
    expect(existsSync(apr1)).toBe(false);
  });

  it("never prunes conflict or update backups, however old", async () => {
    const conflict = seed(new Date(2025, 0, 5, 9, 0, 0), "conflict");
    const update = seed(new Date(2025, 0, 6, 9, 0, 0), "update");
    const auto1 = seed(new Date(2025, 0, 7, 9, 0, 0), "auto");
    const auto2 = seed(new Date(2025, 0, 8, 9, 0, 0), "auto"); // last of the month -> kept

    await make().prune();

    expect(existsSync(conflict)).toBe(true);
    expect(existsSync(update)).toBe(true);
    expect(existsSync(auto1)).toBe(false);
    expect(existsSync(auto2)).toBe(true);
  });

  it("moves with the injected clock", async () => {
    const p = seed(new Date(2026, 8, 1, 9, 0, 0), "auto");
    const q = seed(new Date(2026, 8, 2, 9, 0, 0), "auto");
    await make().prune();
    expect(existsSync(p)).toBe(true); // 11 days old

    clock = new Date(2027, 0, 1, 0, 0, 0); // now everything is ancient
    await make().prune();
    expect(existsSync(p)).toBe(false);
    expect(existsSync(q)).toBe(true); // last file of 2026-09
  });

  it("leaves files it does not recognise alone", async () => {
    const dir = join(docsRoot(), "2020-01-01");
    mkdirSync(dir, { recursive: true });
    const stray = join(dir, "notes.txt");
    writeFileSync(stray, "hello", "utf8");
    await make().prune();
    expect(existsSync(stray)).toBe(true);
  });

  it("prunes the userData copy too", async () => {
    const mgr = make();
    clock = new Date(2026, 8, 12, 14, 5, 6);
    await mgr.backup("system", null, makeSystem(), "auto");
    clock = new Date(2026, 8, 13, 9, 0, 0); // same calendar month, later -> the keeper
    await mgr.backup("system", null, makeSystem(), "auto");

    const older = join(udRoot(), "2026-09-12", "140506-auto-system.prsv");
    const newer = join(udRoot(), "2026-09-13", "090000-auto-system.prsv");
    expect(existsSync(older)).toBe(true);
    expect(existsSync(newer)).toBe(true);

    clock = new Date(2027, 5, 1); // everything is now older than 30 days
    await mgr.prune();
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    // the Documents copy followed the same rule
    expect(existsSync(join(docsRoot(), "2026-09-12", "140506-auto-system.prsv"))).toBe(false);
    expect(existsSync(join(docsRoot(), "2026-09-13", "090000-auto-system.prsv"))).toBe(true);
  });

  it("does nothing when no backups exist", async () => {
    await expect(make().prune()).resolves.toBeUndefined();
  });
});
