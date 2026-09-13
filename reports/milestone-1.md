# Milestone 1 — end-to-end run with the real game

Date 2026-09-13. Build: dev (`npm run build` + `electron .`), game `v1.12.0.11` from
`game-build/dist/game`, account **`offsync_37b4e9`** (`scratch/api-probe/throwaway-account-2.json`).
Evidence in `reports/milestone-1/`, scratch driver + raw stdout in `scratch/milestone/`.
App log: `%APPDATA%\PokeRogue Offline\logs\app-2026-09-13.log` (one file, whole day, all runs).

**This run was cut short on purpose.** The owner stopped the test part-way with "the scope of the
project got a bit too big — I want a usable version for the user that's stable and secure". Steps 4 and
7 are therefore only partly evidenced and steps 5b, 6b and 8 were not run. What *was* run is
reported honestly below, and §7 is the scope-cut proposal that follows from it.

## 1. Pass / fail

| # | What | Result | Evidence |
|---|---|---|---|
| 1 | App starts, serves the real game at `http://127.0.0.1:47830`, window opens | **pass** | `reports/milestone-1/01-launch.png`; log `proxy listening` 09:06:51.619Z |
| 2 | Login through the game's own login screen | **pass** | log 08:28:46.505Z `POST /account/login 200 source=upstream`; `03-after-login.png` |
| 2b | `Secure` cookie on `http://127.0.0.1` (the one real risk, reports/game-build.md §4.3) | **pass** | see §2 |
| 3 | Game-version modal with account 1 | **known bug, reproduced** | `02-bug-game-version-out-of-date.png`; see §3 |
| 4 | Classic run online, saves go upstream through the proxy with the rewritten install csid | **pass (partly re-run)** | run started and played to wave 4 by the earlier agent (`04-gamestats-online.png`, `scratch/milestone/07..25*.png`); the csid rewrite is now provable from the log — §4 |
| 4b | Independent server snapshot of slot 0 / system after the online run | **not run** (cut) | — |
| 5 | Force-offline flip, app answers from the mirror | **pass** | log 09:13:22Z `force-offline switch is on` → `connectivity online -> offline {"reason":"forced-offline"}`; `06-offline-title-still-logged-in.png` |
| 5b | Play 2+ waves offline, mirror `dirty=true` with higher playTime/waveIndex | **not run** (cut) | — |
| 5c | Full page reload while offline: login, system and session all answered from the mirror, run resumes | **pass** | log 09:13:35–36Z, three calls `source=replay` status 200; `07-offline-run-resumed.png` shows the identical wave-4 battle |
| 6 | Normal quit: before-quit sync attempted, no error dialog, no crash | **pass** | log 09:16:54.896Z `saving progress online {"reason":"closing the game"}` → `finished saving online {…errors:0}` → `closed`, 1.26 s |
| 6b | Harsh path (kill mid-play, relaunch offline, mirror intact) | **partly**: the app *was* killed with `Stop-Process` at 09:06 with a live run in slot 0, and the relaunch read mirror and server cleanly and resumed the run at wave 4 — but the relaunch was online, not offline | `05-relaunch-title-logged-in.png`; log 09:06:51–56Z |
| 7 | Back online → sync 3 s later, `system/get` then `session/get`, no errors | **pass (noop case only)** | log 09:16:32.728Z online → 09:16:35.739Z `saving progress online {"reason":"just came online"}`, every decision `noop`, 1.32 s |
| 7b | Offline progress actually pushed, `.prsv` written before each overwrite, server playTime/waveIndex up | **not run** (cut) — nothing was dirty, so there was nothing to push | — |
| 8 | Tray → Settings… screenshot | **not run** (cut); the page was rendered and checked in an earlier session | `scratch/settings.png` |
| – | **Negative: the periodic sync never produces `not active` and never reinitialises the save** | **pass** | six full sync runs while the game was open and online (08:38, 08:48, 08:58, 09:06, 09:16, and the quit sync) — **zero** errors, no `not active` anywhere in the log, the game never dropped back to the title screen or lost its run |

## 2. The cookie question — answered: it works

`reports/game-build.md` §4.3 called this "the single highest-value thing to smoke-test first": the
client writes `pokerogue_sessionId=<token>;Secure;SameSite=Strict;Domain=127.0.0.1;Path=/`, and if
Chromium refused a `Secure` cookie over plain `http://`, or refused the IP `Domain=`, every API
request would go out with an empty `Authorization` and the game would sit in a login loop.

**Chromium accepts it.** Three independent pieces of evidence from the log:

1. `08:28:46.505Z POST /account/login 200` immediately followed by `08:28:46.676Z GET /account/info
   200` (171 ms later). `/account/info` is sent by `updateUserInfo()` with
   `Authorization: <getCookie("pokerogue_sessionId")>`. An unstored or unreadable cookie yields an
   empty header and the server answers `401 missing token`. It answered **200**.
2. The cookie **survives a full app restart**: at `09:06:53.715Z`, after `Stop-Process` and a fresh
   `electron .`, the game's first call was `GET /account/info 200` — no `POST /account/login`. The
   title screen reads *"Eingeloggt als: offsync_37b4e9"* (`05-relaunch-title-logged-in.png`).
3. The cookie **survives a page reload while offline** (`09:13:35.681Z`, `source=replay`), i.e. it
   is read back from `document.cookie` and not from any state the wrapper holds.

Neither escape hatch (serving on `localhost`, or a `Cookie`-header fallback in the proxy) is needed.
`GAME_ORIGIN` stays `http://127.0.0.1:47830`.

## 3. "Your game version is out of date" — a real product risk, not a test artefact

**Trigger.** `upstream/pokerogue/src/system/game-data.ts:437`:

```ts
if (!isDev && !isBeta && compareVersions(systemData.gameVersion, version) === 1) {
  await globalScene.ui.setMode(UiMode.ALERT_MODAL, ErrorMessages.GAME_OUT_OF_DATE);
  ... return false;   // the save is never loaded
}
```

If the **system save's** `gameVersion` is greater than the version compiled into the client, the
client shows a modal there is no way past and refuses to load the account. With throwaway account 1
this fired because the API-probe session had written a synthetic system save carrying
`gameVersion: "1.12.1.0"` (`scratch/api-probe/sys-final.json`) while our pinned build is
`1.12.0.11`. Account 2 has a save written by the real client, so it loads fine.

**Is it a risk for the account? Yes, and it is the worst failure mode we have.** The moment the user
opens pokerogue.net in a browser on any device the user gets upstream's newest client, and the first
save it writes stamps the newer `gameVersion` into the system save. From then on our pinned build
**cannot open the account at all** — not "sync fails", but a blocking English modal on a game that
otherwise looks perfectly fine. The user would reasonably conclude the app is broken. Note this happens
*before* any server rejection: the server-side `existing version is greater` error (DESIGN §3.9,
`SyncResult.needsGameUpdate`) is the second line of defence; the client-side block hits first.

**What the shell/proxy should do** (none of it is built yet):

1. **Detect it in the proxy**, where the save passes through anyway. On a successful
   `GET /savedata/system/get` — upstream *or* replay — compare the save's `gameVersion` with the
   served build's tag (`<gameDir>/version.json`, which `game-build` still has to emit; NOTES-main
   open question 6). If the save is newer, do not let the game meet that modal.
2. **Answer with our own dialog, in German**, e.g. *"Dein Spielstand aus dem Netz ist neuer als das
   Spiel auf diesem Computer. Wir holen gerade das Update — das dauert einen Moment."*, kick off
   `Updater.check()` immediately and reload the game window once the swap is ready.
3. **Route the sync-side signal to the same place**: `SyncResult.needsGameUpdate` is already set for
   both `needs-game-update` and `version-too-low`, and `src/main` already watches it.
4. **Until the release feed exists** (`m0stey/pokerogue-offline`, `game-<tag>` releases — NOTES-main
   open question 5, still unpublished) the honest fallback is a dialog telling the user that the progress
   is safe, that the user should play in the browser for now, and that the app will update itself later.
   Silent failure is not acceptable here.

## 4. clientSessionId rewrite — now provable from the log (bug found and fixed)

DESIGN §3.4 / invariant §4.4 require every forwarded `/savedata/*` call to carry the install-wide id
from `state.json`, never the game's per-page-load id. The code did this correctly, but
`src/proxy/server.ts` logged `rest` — the path **before** the rewrite — so the log showed the game's
id and the invariant could not be checked in the field:

```
08:28:46.871Z api {"path":"/savedata/system/get?clientSessionId=4wQkckCAEyktob8TxkCllEAe00PUJ8ON", …}
                                                                ^ the game's id, not what we sent
```

Fixed: for `source=upstream` the logged path is the one that actually left the process; the replay
branch still logs the game's own path, because that is the request we answered. After the fix, with
`state.json.clientSessionId = QrBguZOKDl5ugkk3WOMxJHYwb5O75wIC`:

```
09:06:54.257Z api {"method":"GET","path":"/savedata/system/get?clientSessionId=QrBguZOKDl5ugkk3WOMxJHYwb5O75wIC","status":200,"source":"upstream"}
09:06:54.435Z api {"method":"GET","path":"/savedata/session/get?slot=0&clientSessionId=QrBguZOKDl5ugkk3WOMxJHYwb5O75wIC","status":200,"source":"upstream"}
09:13:36.020Z api {"path":"/savedata/system/get?clientSessionId=BL9ydSB9UMoyTgvXW7t5cEXmCeObKZsC","source":"replay"}   <- the game's own id, offline, ignored
```

Changed: `app/src/proxy/server.ts` (`finish()` takes the path to log). Two tests added to
`app/test/proxy/server.test.ts`. `npx tsc --noEmit` clean; `npx vitest run` → **348 passed, 1
skipped**.

The game's own gameplay saves go out as `POST /savedata/updateall`, not as `session/update` +
`system/update`: the id travels in the JSON body there and is rewritten by
`withInstallClientSessionIdInBody()` (covered by an existing test). `system/update` is used only
when the profile is first created (log 08:30:50.543Z, 204).

## 5. Bugs

### B1 — proxy logged the pre-rewrite clientSessionId · **fixed**

See §4. `app/src/proxy/server.ts`, `app/test/proxy/server.test.ts`. Small, self-contained, tests green.

### B2 — every online save makes the next sync pull the server's lossy echo back over it, and write a never-pruned backup · **documented, not fixed (`src/sync`)**

Observed three times in a row, ten minutes apart, with nothing but normal play in between:

```
08:38:33.296Z session decision {"slot":0,"kind":"pull","reason":"remote-changed"}
08:38:34.144Z wrote backup {"kind":"session","slot":0,"reason":"update","path":"…\103834-update-session0.prsv"}
08:48:33.198Z session decision {"slot":0,"kind":"pull","reason":"remote-changed"}   (+ 104834-update-session0.prsv)
08:58:32.631Z session decision {"slot":0,"kind":"pull","reason":"remote-changed"}   (+ 105833-update-session0.prsv)
```

**Cause.** When the game saves online, `applySideEffects` stores `base` = the exact bytes the game
sent (`src/proxy/server.ts`, `updateall` → `mirror.setSessionSynced(slot, payload.session)`). The
server stores a *lossy* copy: it decodes into `defs.SessionSaveData` and silently drops every key
that struct does not have (`playerFaints` and friends — NOTES-sync §3). The next sync does
`session/get` and compares `base` against `remote` with **strict** structural equality, so it always
sees `remote != base` while `local == base`, which is exactly the DESIGN §3.6 rule for `pull`. The
engine then backs up local and overwrites it with the server's degraded copy.

The *system* save does not suffer from this — the server's system normalisation (added `null`s,
re-sorted `gameStats`) is already absorbed by `compare.ts`. Every system decision in the whole log
is `noop / already-equal`.

**Impact.**

- One never-pruned `.prsv` (`reason: "update"`, DESIGN §3.7 "never pruned") per ten minutes of play
  — roughly 144 files a day in `Documents\PokeRogue Backups`. Exactly the churn NOTES-sync §5.10 set
  out to prevent; its identical-content reuse cannot catch this, because each file really is different.
- The mirror's offline copy of the run is silently replaced by the server's degraded copy, so what
  the user takes on the plane is worse than what the game wrote. No visible loss today (the dropped
  fields are cosmetic), but it is a data-losing path that runs every ten minutes and it will bite
  the day a dropped field matters.
- Pointless upstream traffic and disk writes on every cycle.

**Proposed fix**, in order of preference:

1. In `src/sync/reconcile.ts`, compare `base` against `remote` for **sessions** with the same
   lossy-tolerant comparison the engine already trusts for read-back verification
   (`verifySessionReadBack` / `KNOWN_LOSSY_SESSION_FIELDS` in `src/sync/compare.ts`): a remote that
   differs from base *only* by keys the server is known to drop is not "remote-changed" ⇒ `noop`.
   This is the narrow, honest fix and it lives next to the knowledge it needs.
2. Or, in `src/sync/engine.ts`, write no backup for a `pull` whose remote is a descendant of local
   with the same `seed` and `waveIndex >=` and `playTime >=` — nothing is being lost, so DESIGN §4.1
   does not require a file. Fixes the churn but not the degradation.
3. Not recommended: store the server's echo as `base` in the proxy. NOTES-sync §5.7 explains why the
   opposite choice was made for pushes; doing it here would just move the asymmetry.

Needs a regression test that reproduces the loop: push a session containing `playerFaints`, let the
fake upstream drop it (it already models the server's struct), and assert the *next* `runSync` is a
`noop` that writes no backup.

### B3 — `session/newclear` is called by this build · **QA item, no code change yet**

`reports/verify-client.md` §9 says an `app`-mode build never calls `newclear`. It did:
`08:41:59.447Z GET /savedata/session/newclear?slot=0&isVictory=false → 200 source=upstream`, when the
first run ended. Online it is forwarded like any other call and is harmless. **Offline it is a 503**
(NOTES-proxy §9) and nobody has checked what the client does with that at the end of a run — which is
the exact moment the user is most attached to the result. Needs one QA pass: end a run while offline and
watch for an error message or a lost clear.

### B4 — `state.json.gameVersionServed` is never written · **cosmetic**

Still `null` after five app starts. DESIGN §3.3 lists it and the settings page wants to show the game
version. Related: `game-build` still does not emit `version.json` next to `index.html` (NOTES-main
open question 6) — which is *also* what the §3 fix needs. One small change in `game-build` unblocks
both.

## 6. Timings and rough edges

**Timings** (from the log; dev build, warm disk):

| | |
|---|---|
| Process start → proxy listening | **12 ms** (09:06:51.607 → .619) |
| Process start → connectivity known (online) | **261 ms** |
| Process start → game's first API call | **~2.1 s**; playable title screen at ~3 s |
| Sync after the online edge | fires at **+3.0 s** exactly, as DESIGN §3.10 says |
| One full sync run (system + 5 slots, all noop) | **1.2 – 1.5 s** (six sequential upstream GETs, 130–540 ms each) |
| Before-quit sync | **1.26 s** — under the 2 s threshold, so the "Saving your progress online…" splash never appeared |
| An upstream API call through the proxy | 126 – 930 ms (login 926 ms; `updateall` 1.0 – 1.8 s) |
| An offline replay of an API call | **0 – 5 ms** |
| Force-offline switch → state flip | ≤ 5 s (the dev poll interval) |

**Rough edges a non-technical person would notice:**

1. **Offline, the title screen says "? Spieler Online"** instead of a player count (`/game/titlestats`
   → 503). Harmless, but it is the one visible "something is wrong" on an otherwise perfect offline
   screen. Either replay the last known count or accept the `?` deliberately.
2. **The game came up in German by itself** (system locale): `Fortfahren / Neues Spiel / Spiel laden`.
   Our own dialogs, tray and settings page are still English (DECISIONS 2026-09-13 chose German;
   translation pending). Today the user would see a German game inside an English wrapper.
3. **The version modal is the game's own, in English, and is a dead end** — see §3.
4. **First run means typing a username and password into the game's own login screen**, with no
   explanation from us. The BRIEF's "one icon" promise ends there. One small first-run hint page
   would cover it (DESIGN §2 already reserves `src/ui/` for this).
5. **Daily Run offline**: the title menu still offers online-only modes, `/daily/*` answers 503, and
   nobody has seen what the game shows the user. Untested.
6. **Login takes ~930 ms** with no progress feedback. Fine, but it is the slowest thing the user does.

## 7. What "stable and secure" needs, in order

Scope cut, in response to the owner's note. Everything below stands between today's state and
something that can be handed over; anything not on this list should wait.

**Must fix before the user gets it**

1. **The §3 game-version block.** Today one browser session on pokerogue.net permanently bricks the
   app for the user. Needs `version.json` from `game-build`, the proxy-side detection, our own German
   dialog, and the updater actually pointed at a published release. This is the whole ballgame.
2. **B2, the pull loop** — a data-degrading path that runs every ten minutes, plus ~144 files a day
   in the Documents folder.
3. **Publish the first `game-<tag>` release** (owner dispatches the Actions workflow) so the updater
   has something to talk to at all. Until then the entire update path is untested code.
4. **Finish the offline half of this test.** Steps 5b / 6b / 7b were cut, and they are the actual
   product promise: play offline, kill the app, come back, watch the progress arrive online. The
   force-offline flip, the offline replay, the reconnect sync and the clean quit are each verified in
   isolation now; the *combination* is not.

**Security, briefly.** Nothing alarming found. The proxy binds `127.0.0.1` only; the game window has
`contextIsolation` + `sandbox`, no preload, all navigation blocked and all permissions denied; the
forwarder drops cookies and unknown headers and passes only `Authorization`, `Content-Type`,
`PKR-Client-Version` and `Accept`; tokens are redacted in the log. Two accepted, documented
weaknesses remain: the mirror is plain JSON on disk including the account token, and **the offline
login does not verify the password** (NOTES-proxy open question 2). Both matter only to someone who
already has the Windows account, and both deserve one honest sentence on the settings page rather
than a code change.

**Can wait**: German translation of our own strings, conflict-dialog polish, the first-run hint page,
the `unknown-rejection` fallback export, app self-update (game-files-only is fine), and the tidy-ups
in NOTES-main (`lastSyncAt` type, deleting `fallback-server.ts`).

## 8. State left behind

No Electron process is running. The `force-offline` file was removed. The mirror is clean and agrees
with the server (`dirty:false` on system and on slot 0, run at wave 4, `lastSyncResult: "ok"`). The
only working-tree changes from this session are the B1 fix and its two tests; nothing was committed.
