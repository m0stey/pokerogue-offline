# v1 hardening — what changed

Date 2026-09-13. Trigger: the owner stopped the milestone-1 run part-way — *"the scope of the
project got a bit too big — I want a usable version for her that's stable and secure"* — and
`reports/milestone-1.md` §7 turned that into a list. This is what was done about it.

Nothing was committed. `upstream/` was not touched. No dependency was added.

**End state:** `npx tsc --noEmit` clean · `npx vitest run` **432 passed, 1 skipped** (21 files; was
348 passed / 1 skipped) · `npm run build` ok · `npx electron .` starts, serves the real game, syncs,
and exits cleanly with code 0 and no error in the log.

---

## 1. B2 — the server's echo was read as a change (`src/sync`)

**Was:** after every online save, the next sync decided `pull / remote-changed` for the run in
progress, backed up the local copy as a never-pruned `.prsv`, and overwrote the mirror with the
server's degraded copy. Observed three times in ten-minute intervals in the milestone log; roughly
144 files a day in `Documents\PokeRogue Backups`, and the offline copy of the run silently made
worse than what the game wrote.

**Cause:** `base` is the exact bytes the game sent (a deliberate choice, NOTES-sync §5.7), the
server stores a copy through a fixed Go struct and drops every key that struct does not have, and
`reconcile.ts` compared `base` against `remote` strictly. `KNOWN_LOSSY_SESSION_FIELDS` was not
enough, because the dropped set cannot be enumerated ahead of a client release.

**Now:** `compare.ts` gained `sessionEchoMatches(remote, ours)` — compare only the top-level keys
the server's copy actually contains, after the usual `null`/`[]`/absent normalisation, exactly what
`verifySessionReadBack` already does after a push. A dropped `CRITICAL_SESSION_FIELDS` key is still
a real difference, so this cannot swallow a genuinely mutilated remote. `reconcile.ts`'s `decide()`
now takes a separate comparator for anything involving `remote` (`eqRemote`), and
`engine.mayPropagateClear` uses it too. It is asymmetric on purpose: the server's copy comes first.

**System saves needed nothing.** Confirmed and covered by a test: `systemEquals` already treats
`null`, `[]` and an absent key as one value, which absorbs the `starterMoveData: null` /
`starterEggMoveData: null` the server adds, and key order is ignored, which absorbs the re-sorted
`gameStats`. Every system decision in the whole milestone log was `noop / already-equal`.

**Also in this item** (the DECISIONS.md 2026-09-13 item, NOTES-sync open question 1): an
`unknown-rejection` now exports a fallback `.prsv` of the local save with `reason: "rejected"`
(added to `PROTECTED_REASONS`, so never pruned) and is reported in `SyncResult.unrecoverable`. It
stays fail-safe: nothing is written to either side, the save stays dirty, the next sync tries again.

**Files:** `src/sync/compare.ts`, `src/sync/reconcile.ts`, `src/sync/engine.ts`, `src/sync/backup.ts`.
**Tests:** a `describe("the server's lossy echo of our own save is not a remote change (B2)")` block in
`test/sync/engine.test.ts` — the literal case from the report (base = bytes sent, remote = echo
without `playerFaints`, local = base ⇒ noop, **no backup written, no mirror write at all**), the
general case with a key the server's struct has never heard of, proof that a run that really moved
on online is still pulled (with its backup), proof that a remote missing a critical field is not
treated as an echo, and the system-save case. Plus unit tests in `test/sync/reconcile.test.ts` and
`test/sync/compare.test.ts`, and the two existing `unknown-rejection` tests updated/extended.

## 2. B3 — `session/newclear` at the end of every offline run (`src/proxy`)

**Read first, then fixed.** `upstream/pokerogue/src/api/session-savedata-api.ts:newclear` does a
**GET**, then `response.json()`, and **throws** unless the response is 2xx with a JSON body. The
caller, `game-over-phase.ts:handleGameOver`, catches that by clearing the phase queue, showing
`menu:serverCommunicationFailed` and **reloading the page two seconds later**. So the 503 we used to
answer offline tore down the game-over screen at the exact moment she is most attached to the
result.

**Now:** the offline replay answers `200` with the bare JSON boolean `false` — which is literally
what the server returns (`api/endpoints.go`, `case "newclear"` → `writeJSON(savedata.NewClear(...))`,
a Go `bool`). `false` is the honest value: the flag becomes `doGameOver(!isDaily || !!success)`, so a
classic run ignores it completely, and for a daily run we cannot know offline whether that seed was
already completed and must not hand out a first-clear reward twice.

Nothing is recorded and nothing is forwarded or queued — `newclear` only reads on the server, so
there is nothing to replay later, and the engine never calls it (Invariant §4.7, still tested).
Slot and `clientSessionId` are deliberately **not** validated: an error here costs her the end of a
run, and there is no upside to reproducing argument checking for a read-only flag.

**Files:** `src/proxy/replay.ts`. **Tests:** a new `describe` in `test/proxy/replay.test.ts` (the
shape, tolerance of odd arguments, that the mirror is untouched, and that `session/clear` still works
afterwards) and one end-to-end test in `test/proxy/server.test.ts` asserting 200 + `false` + nothing
forwarded + nothing recorded. The two "503s everything else" tests were updated.

## 3. The game-version block — the real product risk

The client refuses to load an account whose system save carries a `gameVersion` greater than its own
build (`upstream/pokerogue/src/system/game-data.ts:437`), with an English modal there is no way past.
One browser session on pokerogue.net is enough to cause it. We cannot prevent it — the save is hers,
the modal is the client's — but we can stop it looking like a broken app.

- **`src/common/version.ts`** (new): `compareGameVersion` moved here from `src/sync/compare.ts`
  (which re-exports it, so nothing else changed) plus `saveIsNewerThanBuild` and
  `readGameVersionFile`. It lives in `common` because `src/proxy` must not import `src/sync` logic.
- **`src/proxy/server.ts`**: reads `<gameDir>/version.json` → `gameVersion` once at startup, writes
  it to `state.json.gameVersionServed` (**milestone-1 B4**, which nothing had ever written), and on
  every successful `GET /savedata/system/get` — forwarded **or** replayed — compares the save's
  `gameVersion` against it. If the save is newer it emits `needs-game-update` with both versions on
  the new `proxy.events` emitter. The save itself is passed to the game untouched.
- **`src/main`**: one German dialog, informal, no technical terms — *"PokéRogue hat eine neue Version
  bekommen. Das passiert, wenn du PokéRogue zwischendurch im Browser gespielt hast. Dein Spielstand
  ist vollständig, es geht nichts verloren. … Bitte frag `<OWNER_NAME>` danach."*, one button `OK`.
  Shown **at most once per app start**, from any of the three things that mean the same thing to her:
  the proxy event, `SyncResult.needsGameUpdate`, or the release feed (item 4). They all funnel
  through `showGameUpdateNotice()` behind a single flag.

`SyncResult.needsGameUpdate` and `SyncResult.unrecoverable` are now used as typed fields; `src/main`
no longer substring-matches `errors` at all (NOTES-main open questions 3 and 4, closed).

**Verified live:** the log line `serving game files {... "gameVersion":"1.12.0.11"}` and
`state.json` now reading `"gameVersionServed": "1.12.0.11"`.

**Files:** `src/common/version.ts`, `src/proxy/server.ts`, `src/main/game-files.ts`,
`src/main/contracts.ts`, `src/main/index.ts`, `src/main/dialogs.ts`, `src/main/strings.de.ts`.
**Tests:** `test/common/version.test.ts` (6) and a `describe("the game-version block")` in
`test/proxy/server.test.ts` (6: B4, no version.json, newer save online, same/older save, the offline
replay path, no save at all).

## 4. Scope trim — the updater is a notice only

**Deleted, not commented out:** the release download (resumable, `Range`), the SHA-256 verification,
`unzip` via `tar.exe`/`Expand-Archive`, `findGameRoot`, `parseSha256File`, `sha256File`,
`downloadWithResume`, `applyPendingUpdate`, `cleanupPreviousVersion`, `noteSessionCompleted`,
`isMeteredConnection` and its PowerShell/WinRT probe, the metered dialog, `formatSize`, the
`staging`/`previous` folders and the swap-repair branch in `ensureGameFiles`, the `pendingTag` /
`installedTag` / `previousTag` / `sessionsSinceInstall` state, and the `allowMeteredDownloads`,
`gameUpdateChannel` and `lastSeenGameTag` settings with their UI. `src/main/updater.ts` went from 486
lines to 193.

**Kept:** one look at `https://api.github.com/repos/m0stey/pokerogue-offline/releases` at most every
6 h and only while online (`lastCheckAt` still written *before* the check, so a failing check uses up
its slot instead of looping), skipping drafts and pre-releases; if the newest `game-<tag>` is newer
than the served tag, the item-3 dialog, once per app start. `compareTags` refuses to speak when
either tag is not a plain `x.y.z[.w]` — a wrong "there is a new version" sends her looking for an
installer that does not exist.

`game-files.ts` still looks in `<userData>/game/current` → `<resourcesPath>/game` → the dev folder,
so a build can still be dropped in by hand; only the pending-swap repair is gone.

**No dead tests were found to delete** — there had never been a `test/main/` directory. There is one
now.

**Files:** `src/main/updater.ts`, `src/main/game-files.ts`, `src/main/settings.ts`,
`src/main/dialogs.ts`, `src/main/index.ts`, `src/main/contracts.ts`, `src/ui/settings.html`,
`src/ui/settings.js`. **Tests:** `test/main/updater.test.ts` (16), `test/main/game-files.test.ts`
(8, including "makes no staging or previous folder any more"), `test/main/settings.test.ts` (5,
including that an old `allowMeteredDownloads` value is preserved verbatim and ignored).

## 5. Security hardening

**(a) The token is encrypted at rest.** `src/common/secret.ts` defines `SecretCodec`
(`available` / `protect` / `unprotect`) with an identity default; `Mirror` takes
`{ secret, log }` and writes `tokenEnc` (base64) instead of `token` whenever the codec is available,
reads either, and re-writes a plain token protected on the first read. If the ciphertext cannot be
decrypted (another Windows user, a reset credential store) the file is quarantined and `readAccount()`
returns null so the next login writes a clean one. `src/main/secret.ts` is the only file that touches
Electron `safeStorage`; it falls back to the plain codec with a warning in the log if Windows offers
no credential store. `src/proxy` stays Electron-free.
**Verified live:** the log line *"the stored sign-in is now protected by Windows"* on the first run
after the change, and `account.json` now holding `username / info / lastLoginAt / tokenEnc` with no
plain `token` anywhere in the file.
**Tests:** 5 in `test/proxy/mirror.test.ts` with a fake codec (protected round trip, plain fallback,
migration, undecryptable ciphertext, and a non-account file).

**(b) DNS-rebinding guard.** The proxy already bound `127.0.0.1` only (confirmed: `DEFAULT_HOST`, and
`startProxy` passes it to `listen`). It did **not** check the `Host` header — added. Anything that is
not `127.0.0.1:<port>` or `localhost:<port>` gets a plain 403 before routing, for the game files and
the API alike; a missing `Host` is refused too. The check uses the *bound* port, so it is right with
`port: 0` in tests. **Tests:** 2 in `test/proxy/server.test.ts`, covering the two allowed names
(case-insensitively) and six foreign ones including a bare host with no port, the wrong port, an IPv6
literal and a `nip.io`-style rebinding name, asserting no save data leaks and nothing is forwarded.

**(c) Dev-only hooks inert when packaged.** Extracted into `src/main/dev-hooks.ts` so they can be
tested: `forceOfflineCheck({isPackaged, userDataDir})` returns `undefined` when packaged however much
the file exists, and `devToolsAllowed(isPackaged)` gates F12. The dev game-directory fallback is
covered too (`test/main/game-files.test.ts`). **There is no devtools port environment variable** — the
task mentioned one, but `grep` over `src/` finds no `process.env` use at all. The three dev hooks
that do exist are the force-offline file, the F12 shortcut, and the dev game folder; all three are
gated and tested.

**(d) The game window.** Verified by reading `src/main/window.ts`: `contextIsolation` and `sandbox`
on, `nodeIntegration` off, no preload; `setWindowOpenHandler` denies everything (handing
`pokerogue.net` links to the real browser); `will-navigate` and `will-redirect` both block anything
that is not `GAME_ORIGIN`; `setPermissionRequestHandler` calls back `false`, `setPermissionCheckHandler`
returns false, `setDevicePermissionHandler` returns false; no menu. The claim held. Not unit-tested —
`window.ts` imports `electron` at module scope, so it cannot be loaded under vitest.

**SECURITY.md** written at the repo root: what is protected and how, and the two honest limitations
(the offline login does not verify the password; anyone with access to her Windows account has
everything, backups included, because the `.prsv` key is public in the game's own source), plus the
unsigned installer and its SmartScreen warning.

## 6. German UI

Every user-visible string is now German, informal "du", no technical terms, and they all live in
**`src/main/strings.de.ts`** so they can be reviewed in one sitting. The full list is also mirrored
into `app/NOTES-main.md` for reading without opening the code.

Our two HTML pages get their words through the existing IPC (`data.text`), so no German is baked into
`conflict.html` / `settings.html`; the splash has no preload, so its one sentence travels in the
query string and a new `splash.js` prints it (its CSP already allowed `script-src 'self'`).
`format.ts` now produces `132 Std. 12 Min.`, `vor 5 Stunden`, `gestern`, `am 3. März`, `noch nie`.

**"Spielzeit"** is used for Play Time, and that is not a guess: the upstream `public/locales`
submodule really is missing, as expected, but the **built** game carries the same files, and
`game-build/dist/game/locales/de/game-stats-ui-handler.json` reads `"playTime":"Spielzeit"`. That is
the label the game itself shows her under Menü → Statistiken, so it is the label we use.

The settings page now has exactly: the conflict preference (three plain options), the backups folder
(path + `Ordner öffnen`), `Spielversion`, `Zuletzt online gespeichert`, `Spielzeit`. The mobile-data
section is gone.

The window title is `PokéRogue` (with the accent), as are the tray tooltip and every dialog title.
The electron-builder `productName` stays `PokeRogue`: it is the install folder and shortcut name, and
changing it would strand an existing installation.

**Installer:** `electron-builder.yml` gained `installerLanguages: de_DE`, `language: "1031"`,
`multiLanguageInstaller: false`, `displayLanguageSelector: false`. Option names verified for
electron-builder 26 in `node_modules/app-builder-lib/out/targets/nsis/nsisOptions.d.ts` (lines
191–206). `oneClick: true` and the rest of the NSIS block are unchanged.

**Tests:** `test/main/strings.test.ts` (9) — every string non-empty; **no** occurrence of "sync",
"server", "cache", "token", "mirror", "proxy", "backup", "api", "json", "merge", "conflict",
"upload", "download", "localstorage", "commit", "http"; no English filler words; `Spielzeit` is the
play-time label; the app is spelled `PokéRogue` everywhere; the update message names the owner,
mentions the browser and says nothing is lost; and the settings page has exactly the allowed keys.
Plus the German `format.ts` output.

## 7. Final verification

| | |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | **432 passed, 1 skipped**, 21 files (before: 348 / 1, 15 files) |
| `npm run build` | ok — `index.js`, `preload-ui.js`, `wiring.js`, `dist/ui/*` incl. `splash.js` |
| `npx electron .` | started against the dev game build, ran ~11 s, closed via the window: proxy up in 11 ms, connectivity online in 300 ms, sync at +3 s all `noop`, quit sync, `closed`, **exit code 0**, no error line |

The live run also confirmed items 3 and 5(a) end to end (`gameVersionServed` written, token migrated
to `tokenEnc`). No Electron process was left running. `%APPDATA%\PokeRogue Offline` was not deleted;
the milestone state is intact and the mirror still agrees with the server.

Docs updated: `DESIGN.md` §3.3/§3.4/§3.6/§3.7/§3.9/§3.10, `DECISIONS.md` (dated entry),
`SECURITY.md` (new), `app/NOTES-main.md` (file list, the German string list, decisions, open
questions, verification), `app/NOTES-proxy.md` (§9 rewritten, §14–§16 added), `app/NOTES-sync.md`
(§5.13–§5.14 added, open question 1 closed, counts).

---

## Left open

1. **`OWNER_NAME` in `strings.de.ts` is a guess** (`"Alexander"`). It is the only name in the app and
   it is in the one message that tells her who to ask. One constant; please confirm the spelling she
   would recognise.
2. **No `game-<tag>` release exists yet.** Until the workflow is dispatched once, the update check
   finds nothing, logs it and shows nothing — correct behaviour, but the release-feed half of the
   notice has never run against a real feed.
3. **`npm run dist` has still never been run**, so the German NSIS setup screens are unverified. The
   option names are checked against the electron-builder 26 type definitions, not against a build.
4. **The German pages have not been looked at on screen.** They render their labels from IPC now; the
   logic is tested, the visual result is not. Worth one screenshot pass before handover.
5. **`SyncResult.summary` is still English.** Nothing shows it to the user (it goes to the log); if a
   status line is ever added it has to be translated.
6. **`lastSyncAt` is an ISO string in `src/proxy` and a number in `src/sync/mirror-port.ts`**, still
   bridged by a cast in `wiring.ts`. Pre-existing, untouched, still worth fixing.
7. **The offline half of milestone 1 (steps 5b/6b/7b) is still not run** — play offline, kill the
   app, come back, watch the progress arrive online. The pieces are each verified in isolation; the
   combination is not, and B2 and B3 both changed behaviour on exactly that path.
8. **`fallback-server.ts` is still there**, and so is the `loadRuntime()` stand-in branch. It is dead
   weight now that the real modules always build, and deleting it is a separate small change.
