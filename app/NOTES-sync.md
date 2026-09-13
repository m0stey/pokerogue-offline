# NOTES — `src/sync/`

Contract: `DESIGN.md` §3.1, §3.6–§3.9 (including the §3.4/§3.8 amendment on offline-cleared slots)
and the invariants in §4. Runtime dependencies: Node built-ins only (`crypto`, `fs`, `https`,
`path`). No `npm install` was run in `app/`.

Tests: `app/test/sync/` — `npx vitest run test/sync` → **276 passing, 1 skipped** (the live contract
test, which needs `LIVE=1`), across 9 files. Whole-repo `npx vitest run` → 341 passing, 1 skipped
across 14 files; `npx tsc --noEmit -p app` is clean.

---

## 1. What is here

| File | What it does |
|---|---|
| `prsv.ts` | `.prsv` crypto (CryptoJS-compatible), bypass-blob codec, the system-save key shortening/expansion |
| `compare.ts` | structural equality with `null`/`[]`/absent normalisation, `KNOWN_LOSSY_SESSION_FIELDS`, `CRITICAL_SESSION_FIELDS`, `verifySessionReadBack`, **`sessionEchoMatches`**, `isDescendantSystem` / `isDescendantSession`; re-exports `compareGameVersion` from `src/common/version.ts` (the proxy needs the same rule) |
| `reconcile.ts` | pure three-way decision: `noop` / `push` / `pull` / `conflict` |
| `errors.ts` | server prose + transport/HTML → a closed `ClassifiedError` union, plus plain-language wording |
| `upstream-api.ts` | `UpstreamApi` interface and `HttpUpstreamApi` (node `https`) |
| `mirror-port.ts` | the slice of `src/proxy/mirror.ts` the engine needs, declared locally so the two modules stay decoupled |
| `backup.ts` | `.prsv` backup writing with verify-after-write, identical-backup reuse, and retention/pruning |
| `engine.ts` | `runSync` |

## 2. Usage

```ts
import { createBackupManager } from "./sync/backup";
import { runSync } from "./sync/engine";
import { HttpUpstreamApi } from "./sync/upstream-api";

const api = new HttpUpstreamApi({ token: account.token, log });
const backup = createBackupManager({
  // Either a full path the user picked in settings…
  backupsDir: settings.backupsDir,
  // …or just Documents, and it uses `<documents>/PokeRogue Backups/`.
  documentsDir: app.getPath("documents"),
  userDataDir: app.getPath("userData"),
  log,
});

const result = await runSync({
  mirror,                       // the real Mirror satisfies MirrorPort structurally
  backup,
  api,
  policy: {
    mode: settings.conflictPolicy,            // "ask" | "prefer-this-computer" | "prefer-online"
    ask: (q) => showConflictDialog(q),        // only called when mode === "ask", once per run
  },
  log,
});
// result.summary is safe to show the user verbatim.
await backup.prune();                         // cheap; call it after a sync or at startup
```

`runSync` never throws for anything it anticipates — connectivity problems, rejections and
verification failures all come back in the result.

### Reading a `SyncResult` without substring-matching

```ts
interface SyncResult {
  pushed: string[];        // "system", "session2", …
  pulled: string[];
  conflicts: string[];
  errors: string[];        // "<target>:<reason-kind>", for logs
  warnings: string[];      // non-fatal, e.g. "session0:dropped-fields:playerFaints"
  needsGameUpdate: boolean;                 // the build is behind the account; sync cannot succeed
  unrecoverable: Array<{
    what: string;                           // "system" | "sessionN"
    reason: ClassifiedError;                // the typed reason, not a string to match
    backupPath: string | null;              // the .prsv to offer the user; null ⇒ even that failed
  }>;
  summary: string;         // one or two plain sentences, safe to show verbatim
}
```

- `needsGameUpdate` is the trigger for the "update the game" dialog. It is set for both
  `needs-game-update` (the save online is newer than this build) and `version-too-low` (this build
  is below the server's hard minimum) — both are fixed by updating.
- `unrecoverable` now also carries an `unknown-rejection` (backup reason `rejected`). It is the trigger for DESIGN §3.10's "backup exported" notice. A backup is always
  *attempted* before an entry is added, and `backupPath` says whether it worked. When it is `null`,
  `errors` also carries `<what>:backup-failed`.
- `warnings` never reach `summary`; they are for the log and the settings page.

### What the Mirror must guarantee

Verified at compile time by `test/sync/mirror-port.contract.test.ts`, which does
`const _p: MirrorPort = {} as Mirror` — if `Mirror` loses a method or changes a field type, `tsc`
fails there instead of the app failing at runtime.

`mirror-port.ts` documents one requirement that is not spelled out in DESIGN.md §3.3:
**`dirty` must be derived from a structural comparison of `local` and `base` on every write**, not
kept as a sticky boolean. The real `Mirror` does exactly this. The port also uses
`readState()` / `writeState()` for `state.json`, which §3.3 lists as a file but not as methods, and
the optional `setSessionSynced()` for settling a slot after an offline clear. All timestamps are
ISO-8601 strings, matching the Mirror's on-disk format.

## 3. Verified facts this code is built on

- **`.prsv` format.** `base64("Salted__" + salt[8] + AES-256-CBC(PKCS#7(plaintext)))`, key/IV from
  `EVP_BytesToKey(MD5, "x0i2O7WRiANTqPmZ", salt, 1 iteration, 48 bytes)`. Confirmed *byte-for-byte*
  against real `crypto-js@4.2.0`: the fixtures `test/sync/fixtures/*.cryptojs.prsv` were produced by
  crypto-js (generator: `scratch/cryptojs-ref/gen.cjs`, run once in a throwaway folder) and
  `decryptPrsv` reads them; re-encrypting with the fixture's own salt reproduces the fixture string
  exactly.
- **System exports are key-shortened, session exports are not.** `tryExportData`
  (`upstream/pokerogue/src/system/game-data.ts:1269-1316`) calls `convertSystemDataStr(data, true)`
  for `SYSTEM` and assigns the session response verbatim (`data = resp`, line 1296). `backup.ts`
  does exactly that, and a test asserts a session `.prsv` still contains `"moveset"`/`"ivs"`.
- **The shortening is a raw string substitution over the whole JSON text**, not a key-aware
  transform, and the client rewrites `"trainerId":N` / `"secretId":N` while doing it. `prsv.ts`
  reproduces that literally, including the replacement order that makes `$sa` expand before `$s`
  and the legacy `$pAttr → $pa` fixup on the import side.
- **Session round trips are lossy.** The server decodes into `defs.SessionSaveData` and discards
  every key that struct does not have. `playerFaints` is the one we know about; `dailyConfig` and
  `name` are `omitempty`; every empty array comes back as `null` (reports/live-api.md §3.17).
- **System round trips add `starterMoveData: null` and `starterEggMoveData: null`** and re-sort
  `gameStats` alphabetically (reports/live-api.md §3.13).
- **`Origin: https://pokerogue.net` is mandatory**; without it Cloudflare returns an HTML 403 even
  for a valid token. The token is the raw base64 string in `Authorization`, no `Bearer`.
- **Success statuses differ**: `system/update` → 204, `session/update` → 200, `session/delete` → 200,
  all with empty bodies. `upstream-api.ts` branches on status only.

## 4. The two amendments, as implemented

### 4a. Propagating a run finished offline (`session/delete`)

`UpstreamApi.deleteSession(slot, clientSessionId)` issues `GET /savedata/session/delete?slot=N&…`
(it really is a GET — `session-savedata-api.ts:80` uses `doGet`). `runSync` calls it **only** when
`mayPropagateClear(record, remote)` returns true, which requires **all four**:

1. `record.local === null` — the game removed the run here;
2. `record.clearedAt` is a non-empty string — it was an offline *clear*, not some other way of
   ending up empty;
3. `record.base !== null` — we know what the server had;
4. `remote` is non-null and structurally equals `base` — nobody has touched the slot online since.

Then, in order: a **verified `.prsv` of the server's copy** (if it cannot be written, the delete
does not happen at all), the delete, a read-back proving the slot is now empty, and only then
`setSessionSynced(slot, null)`. Any other null-`local` case falls through to a normal reconcile.
`mayPropagateClear` is exported and unit-tested; there is a test for the allowed case and one for
each of the six ways a precondition can fail, each asserting `deleteSession` was never called.

The pre-delete backup uses `reason: "update"`, which §3.7 lists as never pruned — a finished run is
exactly the thing you do not want deleted from the backups folder 31 days later.

### 4b. Session read-back verification

`verifySessionReadBack(sent, got)` compares **only the top-level keys the server's response actually
contains** (after `null`/`[]`/absent normalisation), because the set of keys it drops cannot be
enumerated ahead of a client release. It returns:

- `difference` — the path of the first mismatch among the keys the server kept ⇒ **error**;
- `criticalProblem` — a field in `CRITICAL_SESSION_FIELDS` (`seed`, `waveIndex`, `timestamp`,
  `party`, `gameMode`, and `playTime` when we sent one) that is missing or differs ⇒ **error**;
- `droppedKeys` — everything else we sent that did not come back ⇒ **warning**, surfaced as
  `sessionN:dropped-fields:a,b` in `result.warnings`.

A key whose value we sent as `null`/`[]` and that simply did not come back is not "dropped" — those
mean the same thing. `KNOWN_LOSSY_SESSION_FIELDS` is kept purely as documentation of what we already
know the server discards, and a test asserts none of it overlaps `CRITICAL_SESSION_FIELDS` (if it
did, a push could never verify).

This closes the "verify-failed forever" trap noted in the previous revision of this file: a future
client field now produces one warning per push instead of a permanently dirty slot.

## 5. Deviations from DESIGN.md, and why

1. **"Structural equality after normalising `null` ↔ `[]`" also covers an absent key.**
   DESIGN §3.6 names only `null` ↔ `[]`. Taken literally, the §3.8(6) "system: strict" read-back
   check could never pass, because the server *adds* `starterMoveData: null` /
   `starterEggMoveData: null` to saves that never had those keys. `compare.ts` therefore treats
   `null`, `[]` and absent as one value. The conflation is limited to emptiness — `0`, `""`, `{}`
   and a non-empty array are all still distinct from `null`.

2. **`isDescendant*` applies more guards than §3.6 lists.** DESIGN requires `playTime >=`,
   `timestamp >=`, and for sessions same `seed` with `waveIndex >=`. Added, each mirroring a rule
   the server enforces or a way progress could vanish silently: identical `trainerId`/`secretId`;
   no `gameVersion` regression; no regression of any monotone `gameStats` counter
   (`MONOTONE_GAME_STATS`); `appliedMigrators` containment with identical values; and for sessions
   `playTime >=` when both carry one. Extra guards can only turn a silent fast-forward into a
   question for the user — they never lose data and never *cause* an overwrite.

3. **`SlotDecision` has a sibling with a reason.** `reconcile*Explained()` returns the decision plus
   a `reason` (`fast-forward-local`, `diverged`, …) for logs and tests. `reconcileSystem` /
   `reconcileSession` keep exactly the DESIGN signature and return `{ kind }` only.

4. **A `pull` of a null *system* save is turned into a `push`.** The literal rule
   (`local == base && remote != base ⇒ pull`) would, when the server has no system save at all,
   delete the only copy of the profile. The server never legitimately loses a system save (a 404
   there means a wiped or brand-new account), and pushing into an empty account always succeeds —
   it skips playtime/version/migrator validation and adopts the incoming `trainerId`/`secretId`.
   Logged as a warning when it happens. A `pull` of a null *session* is honoured (the run was
   finished or the slot was cleared online), but only after a verified `.prsv` of the local copy.

5. **404 is not an error at the API layer.** `getSystem`/`getSession` return
   `{ ok: true, status: 404, data: null }` for the body `save does not exist`, because "there is no
   save online" is a state the reconciler reasons about, not a failure. Any *other* 404 body is a
   normal `ok: false`.

6. **`UpstreamApi` gained `login`.** Required by the live contract test and useful for a headless
   re-authentication. It is not used by `runSync`.

7. **After a verified push, `base` is set to the save we sent, not to the server's echo.** The echo
   carries the server's own normalisation (added `null`s, re-sorted keys, dropped fields); storing
   it would leave the mirror permanently `dirty` under the Mirror's byte-level canonical comparison,
   and every sync would push again forever. We have just *proved* the two are equivalent, so the
   local save is the honest thing to record.

8. **`SyncResult` gained `warnings`, `needsGameUpdate` and `unrecoverable`** (requested by the shell
   agent) so `src/main` never has to substring-match `errors`.

9. **`createBackupManager` accepts `backupsDir`** (a full path) as well as `documentsDir`, so the
   settings page can move the folder. `documentsDir` alone still gives the DESIGN §3.7 location.
   `resolveBackupsDir()` is exported so settings can display the same string.

10. **`backup()` reuses an identical backup from the same day** (same content, kind, slot and
    reason) instead of writing a new file. Without this, a save the server keeps refusing produced a
    fresh never-pruned `conflict` file on every sync — 144 identical files a day at the 10-minute
    sync interval. The reused file has already passed verify-after-write.

11. **Conflict backups use `reason: "conflict"`, plain fast-forwards and offline-clear propagation
    use `"update"`.** Both are on §3.7's never-pruned list, so this only affects the filename.

12. **No backup is written when the side being replaced is `null`.** There is nothing to lose.

13. **Any comparison against the *server's* copy of a session tolerates the keys the server does
    not store** (`sessionEchoMatches`). This is the B2 fix from reports/milestone-1.md §5. The
    server decodes a session into a fixed Go struct and drops every key that struct does not have,
    so after a push the copy it hands back is never byte-identical to what we sent. `base` is what
    we sent (§5.7), so a strict `base` vs `remote` comparison reported `remote-changed` on every
    single sync: the engine backed up the local run and overwrote it with the server's degraded
    copy, every ten minutes, writing a never-pruned `.prsv` each time. `reconcile.ts` now takes a
    separate comparator for anything involving `remote`, and `mayPropagateClear` uses it too.
    `KNOWN_LOSSY_SESSION_FIELDS` was not enough on its own: the set of dropped keys cannot be
    enumerated ahead of a client release, which is exactly why `verifySessionReadBack` compares
    only what came back, and why this does the same. Dropping a `CRITICAL_SESSION_FIELDS` key is
    still a real difference. System saves needed no change — `systemEquals` already treats `null`,
    `[]` and an absent key as one value, which absorbs the two nulls the server adds.
14. **`unknown-rejection` now exports a fallback `.prsv`** with `reason: "rejected"` (never pruned)
    and appears in `result.unrecoverable`, answering open question 1 below. It is still fail-safe:
    nothing is written to either side and the save stays dirty, so the next sync tries again — she
    simply also has an importable copy if the refusal turns out to be permanent.

## 6. Known limits

- **A system save whose *string value* is literally `"$sa"` (or any other short key) cannot be
  backed up.** The client's shortening is a raw substitution, so expansion would turn the value into
  `"seenAttr"`. `backup.ts` detects the mismatch in verify-after-write and throws
  `BackupVerificationError` rather than hand back a file that would import as something else. The
  real game has the same hole; refusing is the safe side. There is a test for it.
- **Play Time as a progress signal is unreliable through Import.** `importData` overwrites the
  imported `playTime` with `<loaded playTime> + 60` (reports/verify-client.md §3). Backups written
  here are faithful; it is the *game's* import that rewrites the number. Any user-facing "Play Time"
  must come from the mirror, not from a re-imported save.
- **`backup.prune()` is not called by `runSync`.** The caller decides when (startup, or after a
  sync). Keeping it out of the sync path means a slow disk scan can never delay a save.
- **Backups are never encrypted with a per-user key.** `PRSV_KEY` is public and in the shipped game
  bundle; the `.prsv` files are exactly as protected as the game's own exports, no more.
- **A dropped *critical* field is an error, so a server-side schema change that stops storing, say,
  `party` would make every session push fail.** That is deliberate — it fails safe, loudly — but it
  means `CRITICAL_SESSION_FIELDS` should be re-checked against
  `upstream/rogueserver/defs/savedata.go` on every server bump.

## 7. Open questions for the orchestrator

1. ~~Should `unknown-rejection` also export a fallback `.prsv`?~~ **Answered yes** (DECISIONS.md
   2026-09-13) and implemented: `reason: "rejected"`, never pruned, reported in `unrecoverable`.
2. **Conflict dialog wording and the shape of `ConflictQuestion`.** It carries `playTime`,
   `timestamp`, `waveIndex` and `seed` per side. If the dialog wants "last played" as a date or a
   party preview, the shape can grow.
3. **`updateall` is deliberately unused.** §3.8's explicit sequence is implemented instead, per
   reports/live-api.md §9 (it is not transactional and writes the session before the system).
4. Answered by the coordinator and recorded here for the next reader: the Mirror is the real one at
   `src/proxy/mirror.ts`; `main` calls `ensureClientSessionId()` at startup; there is no spare-slot
   copy of a conflict's losing side — the `.prsv` backup is the sanctioned path.

## 8. Live contract test

`test/sync/live.test.ts`, skipped unless `LIVE=1`:

```
cd app && LIVE=1 npx vitest run test/sync/live.test.ts
```

It uses only `scratch/api-probe/throwaway-account.json` (it asserts the username starts with
`offsync_` before doing anything) and makes **4 requests**, each ≥ 1.1 s apart: `login`,
`system/get`, `system/update` (playTime + 1, same `trainerId`/`secretId`, `gameVersion` and
`appliedMigrators` taken from the fetched save), `system/get`.

**Result of the run on 2026-09-12:** passed, 6.3 s. Login returned a 44-character base64 token,
`system/get` returned the stored save, `system/update` returned **204**, and the second `system/get`
returned `playTime + 1` with the rest of the save structurally identical to what was sent. It has
not been re-run since (the code paths it covers have not changed; `deleteSession` is deliberately
**not** exercised live — it is irreversible).
