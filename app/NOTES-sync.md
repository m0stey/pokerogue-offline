# NOTES — `src/sync/`

Contract: `DESIGN.md` §3.1, §3.6–§3.9 and the invariants in §4. Runtime dependencies: Node built-ins
only (`crypto`, `fs`, `https`, `path`). No `npm install` was run in `app/`.

Tests: `app/test/sync/` — `npx vitest run test/sync` (199 passing, 1 skipped unless `LIVE=1`).

---

## 1. What is here

| File | What it does |
|---|---|
| `prsv.ts` | `.prsv` crypto (CryptoJS-compatible), bypass-blob codec, the system-save key shortening/expansion |
| `compare.ts` | structural equality with `null`/`[]`/absent normalisation, `KNOWN_LOSSY_SESSION_FIELDS`, `isDescendantSystem` / `isDescendantSession`, server-compatible `compareGameVersion` |
| `reconcile.ts` | pure three-way decision: `noop` / `push` / `pull` / `conflict` |
| `errors.ts` | server prose + transport/HTML → a closed `ClassifiedError` union, plus plain-language wording |
| `upstream-api.ts` | `UpstreamApi` interface and `HttpUpstreamApi` (node `https`) |
| `mirror-port.ts` | the slice of `src/proxy/mirror.ts` the engine needs, declared locally so the two modules stay decoupled |
| `backup.ts` | `.prsv` backup writing with verify-after-write, and retention/pruning |
| `engine.ts` | `runSync` |

## 2. Usage

```ts
import { createBackupManager } from "./sync/backup";
import { runSync } from "./sync/engine";
import { HttpUpstreamApi } from "./sync/upstream-api";

const api = new HttpUpstreamApi({ token: account.token, log });
const backup = createBackupManager({
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
verification failures all come back in `result.errors` (and `result.summary`).

### What the Mirror must guarantee

`mirror-port.ts` documents one requirement that is not spelled out in DESIGN.md §3.3:
**`dirty` must be derived from a structural comparison of `local` and `base` on every write**
(use `structurallyEqual` from `src/sync/compare.ts`), not kept as a sticky boolean. The engine
writes `writeLocalX` first and `setBaseX` second, and then expects `dirty === false`. The port also
adds `readState()` / `writeState()` for `state.json`, which §3.3 lists as a file but not as methods
— §4.4 requires the engine to read `clientSessionId` from there.

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
- **Session round trips are lossy.** `playerFaints` is not in the server's Go struct and is dropped;
  `dailyConfig` and `name` are `omitempty`; every empty array comes back as `null`
  (reports/live-api.md §3.17).
- **System round trips add `starterMoveData: null` and `starterEggMoveData: null`** and re-sort
  `gameStats` alphabetically (reports/live-api.md §3.13).
- **`Origin: https://pokerogue.net` is mandatory**; without it Cloudflare returns an HTML 403 even
  for a valid token. The token is the raw base64 string in `Authorization`, no `Bearer`.
- **Success statuses differ**: `system/update` → 204, `session/update` → 200, both with empty
  bodies. `upstream-api.ts` branches on status only.

## 4. Deviations from DESIGN.md, and why

1. **"Structural equality after normalising `null` ↔ `[]`" also covers an absent key.**
   DESIGN §3.6 names only `null` ↔ `[]`. Taken literally, the §3.8(6) "system: strict" read-back
   check could never pass, because the server *adds* `starterMoveData: null` /
   `starterEggMoveData: null` to saves that never had those keys. `compare.ts` therefore treats
   `null`, `[]` and absent as one value. The conflation is limited to emptiness — `0`, `""`, `{}`
   and a non-empty array are all still distinct from `null`.

2. **`isDescendant*` applies more guards than §3.6 lists.** DESIGN requires `playTime >=`,
   `timestamp >=`, and for sessions same `seed` with `waveIndex >=`. Added, each one mirroring a
   rule the server enforces or a way progress could vanish silently:
   - identical `trainerId`/`secretId` (a different pair is a different profile; the server rejects
     it with `stored trainer or secret ID does not match`);
   - no `gameVersion` regression (`existing version is greater`);
   - no regression of any monotone `gameStats` counter (`MONOTONE_GAME_STATS`);
   - `appliedMigrators` containment with identical values (`migrators desynced`);
   - sessions additionally require `playTime >=` when both saves carry one.
   Extra guards can only turn a silent fast-forward into a question for the user. They never lose
   data, and they never *cause* an overwrite.

3. **`SlotDecision` has a sibling with a reason.** `reconcile*Explained()` returns the decision plus
   a `reason` (`fast-forward-local`, `diverged`, …) for logs and tests. `reconcileSystem` /
   `reconcileSession` keep exactly the DESIGN signature and return `{ kind }` only.

4. **A `pull` of a null *system* save is turned into a `push`.** The literal rule
   (`local == base && remote != base ⇒ pull`) would, when the server has no system save at all,
   delete the only copy of the profile. The server never legitimately loses a system save (a 404
   there means a wiped or brand-new account), and pushing into an empty account always succeeds —
   the server skips playtime/version/migrator validation when no save exists and adopts the
   incoming `trainerId`/`secretId`. Logged as a warning when it happens.
   A `pull` of a null *session* is honoured (the run was finished or the slot was cleared online),
   but only after a verified `.prsv` of the local copy exists.

5. **404 is not an error at the API layer.** `getSystem`/`getSession` return
   `{ ok: true, status: 404, data: null }` for the body `save does not exist`, because "there is no
   save online" is a state the reconciler reasons about, not a failure. Any *other* 404 body is a
   normal `ok: false`.

6. **`UpstreamApi` gained `login`.** Required by deliverable 9 (the live contract test) and useful
   for a headless re-authentication. It is not used by `runSync`.

7. **Conflict backups use `reason: "conflict"`, plain fast-forwards use `"update"`.** Both are on
   the never-pruned list in §3.7, so this only affects the filename. An unrecoverable push rejection
   also writes a `"conflict"` backup of the *local* save — that is the file DESIGN §3.10's
   "backup exported" notice points at.

8. **No backup is written when the side being replaced is `null`.** There is nothing to lose. This
   keeps first-ever pushes and pulls-into-an-empty-slot from creating empty-ish noise files.

## 5. Known limits

- **The session read-back check can fail on a future client release.** §3.8(6) says to ignore the
  fields in `KNOWN_LOSSY_SESSION_FIELDS`, but the server drops *any* field its Go struct does not
  know, and that list cannot be enumerated ahead of time. If upstream adds a field before the server
  does, every session push will report `sessionN:verify-failed`, keep the slot dirty and retry
  forever. It fails safe (nothing is lost, nothing is deleted) but it is noisy. Re-check
  `upstream/rogueserver/defs/savedata.go` against `src/@types/save-data.ts` on every upstream bump
  and extend the list.
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

## 6. Open questions for the orchestrator

1. **`Mirror` API surface.** `mirror-port.ts` assumes `readState()` / `writeState(patch)` and the
   derived-`dirty` rule. If `src/proxy/mirror.ts` lands with a different shape, the port is the one
   file to change — the engine imports nothing from `src/proxy`.
2. **Who generates `clientSessionId`?** The engine reads it from `state.json` and refuses to run
   when it is missing. Someone in `src/main` has to create it once per install (32 url-safe chars,
   matching the game's own generator).
3. **Conflict dialog wording and the shape of `ConflictQuestion`.** It currently carries
   `playTime`, `timestamp`, `waveIndex` and `seed` for each side. If the dialog wants "last played"
   as a date or a party preview, say so and the shape can grow.
4. **Should a conflict's *losing* side also be pushed to a spare session slot** rather than only
   living as a `.prsv`? Out of scope for §3.8, but it is the one thing that would make a wrong
   answer in the dialog fully reversible from inside the game.
5. **`updateall` is deliberately unused.** §3.8's explicit sequence is implemented instead, per
   reports/live-api.md §9 (it is not transactional and writes the session before the system).

## 7. Live contract test

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
returned `playTime + 1` with the rest of the save structurally identical to what was sent.
