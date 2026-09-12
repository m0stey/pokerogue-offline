# Verification result and architecture proposal — 2026-09-12

Detailed evidence: `verify-client.md`, `verify-server.md`, `verify-wrapper.md`, `live-api.md` (same folder).
Sources checked: pokerogue da1d0ef (beta, 2026-09-12; main = e4e9b53 = v1.12.0.11), rogueserver c7fed19 (2026-08-18), Pokerogue-App 41e9835, Admiral-Billy/pokerogue fork + releases API, and the live API with throwaway account `offsync_4djvj5` (51 requests).

## 1. Facts table — verdicts

| Brief fact | Verdict | Evidence |
|---|---|---|
| Offline build = `VITE_BYPASS_LOGIN=1`, user `Guest`, key `data_Guest` | CONFIRMED (env file is `.env.app`) | pokerogue `.env.app:1`, `src/account.ts:22-28,59-67`, `src/system/game-data.ts:273` |
| Bypass saves = `btoa(encodeURIComponent(json))`, unencrypted | CONFIRMED | `src/utils/data.ts:48-60` |
| `.prsv` = CryptoJS AES with public key; OpenSSL Salted__/MD5 EVP_BytesToKey/AES-256-CBC | CONFIRMED, round-tripped empirically | `src/constants.ts:57`, `game-data.ts:1305-1313` |
| API base `https://api.pokerogue.net`; auth = raw session id | CONFIRMED. Header is `Authorization` with no prefix; token comes back only in login JSON body, no cookie | `.env.production:3`, `src/api/api-base.ts:84-89`; live test 3 |
| One system save + up to 5 session slots | CONFIRMED | rogueserver `defs/savedata.go:20`, `db/savedata.go:55-181` |
| `system/get?clientSessionId=X` activates X; `update` requires active | CONFIRMED, plus: **every `/savedata/session/*` call seizes the active session (even a 404), and `session/update` is NOT gated on it** | `api/endpoints.go:275-284,475-521`; live tests 6b,6c,7b,7c |
| Rejects lower playtime / tid-sid mismatch / version below min / desynced migrators | CONFIRMED + CHANGED: min version is `1.12.0.10`; a 5th rule rejects a save whose `gameVersion` is below the stored one; tid/sid check is the HEAD commit itself and IS deployed | `api/endpoints.go:73-138`; live tests 6d,6f,6g,6g2 |
| `playTime` never decreases, server enforces | CONFIRMED. Strict `<`: **equal playtime overwrites** | `api/endpoints.go:107-109`; live test 6e |
| Online writes `data_<username>` as AES before upload | CONFIRMED; `.prsv` is key-shortened, localStorage copy is not | `game-data.ts:1227-1240` vs `1281-1305` |
| Offline files from Admiral-Billy releases, `game.zip` ~500 MB, auto-rebuilt, tracks upstream | CONFIRMED (507 MB). One rolling release `release-<sha>`, old ones deleted. Currently exactly at upstream main. The fork's 9-month-old tree is not the build source | Pokerogue-App `src/globals.js:22`; fork `.github/workflows/update.yml` |
| `currentVersion.txt`; `--clear-cache` deletes under `%APPDATA%\PokeRogue` | CONFIRMED. Game files actually live in `<install dir>\resources\game`. clear-cache spares Local Storage but deletes Cookies (logs her out) | `src/main.js:141-172`, `src/file_tab.js:66-96` |
| Ground truth: Menu → Game Stats → Play Time | CONFIRMED | `menu-ui-handler.ts:585-587`, `battle-scene.ts:647-661` |

Open questions from the brief, resolved:
- Live API matches source in 28 of 30 tests. Differences: `/savedata/system/verify` returns 500 on a stale session (still steals the active session); Cloudflare returns 403 HTML for any request without `Origin: https://pokerogue.net`.
- Deployed server vs repo: consistent, including the brand-new tid/sid rule.
- Terms: no terms of service, privacy or acceptable-use page exists (all 404). Only AGPL-3.0 on the code. Nothing prohibits or permits third-party clients.
- Licensing: wrapper MIT; game code AGPL-3.0; assets CC-BY-NC-SA-4.0 with some unlicensed. Redistributing an unmodified upstream build with a source link is the safe path.

## 2. Findings that shape the design

1. A bypass-mode offline profile generates its own trainerId/secretId and the server binds these on first write. A from-scratch offline save can never be uploaded. The offline copy must be seeded from the account.
2. The bypass build cannot reach the live API at all (`localhost:8001` compiled in, all API calls gated). Safe, but it means sync must live outside the game.
3. Version gating: uploads fail if the offline build's version is below the account's stored `gameVersion`. Playing once in the browser after an upstream release strands (does not lose) offline progress until the local build is updated.
4. Sessions have almost no server-side protection: a different seed overwrites any run, playtime is not checked, and round trips are lossy (`playerFaints` dropped, `[]` becomes `null`). The local pre-upload copy must be authoritative.
5. The client's `importData` overwrites imported playTime with current+60 s. Import is fine as a restore path but cannot be the sync path.
6. The online client on a network error mid-run resets to the title screen with no message and no retry queue.
7. Cloudflare requires the `Origin` header; CORS is locked to `https://pokerogue.net`. Sync must run in the Electron main process, and an HTML response must be classified as "offline", never as "rejected".
8. Server writes are blind REPLACE INTO, no CAS, no transactions. Backups plus read-back must carry the whole no-loss guarantee.

## 3. Architecture options

### Option A — Two-origin bridge (extend Admiral-Billy as-is)
Online: load pokerogue.net. Offline: bypass build on `file://`. The wrapper copies saves between the two localStorage origins and pushes via the API.
- Pro: closest to the brief's starting point; online is literally pokerogue.net.
- Con: two save stores that diverge by design; the bypass build's own tid/sid must be overwritten by seeding; the online client's title-screen reset on network loss remains; every game update can change localStorage layout in two places; version gating bites hardest here because the browser client is always newer than the local one.

### Option B — Always-local game behind a local caching proxy (recommended)
The wrapper always runs one locally served game build (built from upstream with `VITE_SERVER_URL=http://127.0.0.1:<port>`, login enabled). A small proxy in the Electron main process sits between the game and `api.pokerogue.net`.
- Online: the proxy forwards every request unchanged (adding `Origin`), and mirrors every save payload it sees into a local store. The game is the online game, byte for byte the same API traffic, same account, same server checks.
- Offline: the proxy answers from the mirror. The game never sees a network error, so no title-screen reset. Writes are marked dirty.
- Reconnect: three-way reconcile (base = last server state seen, local = mirror, remote = server now). Fast-forward if only one side moved. Both moved → one-time dialogue with a remembered choice, changeable in settings. Every overwrite in either direction is preceded by a `.prsv` backup that is round-trip verified.
- Pro: one save store, one game build, no seeding step, tid/sid always correct, version gating disappears unless she plays in a plain browser; she never sees a login screen twice.
- Con: we build and host `game.zip` ourselves (GitHub Actions like the fork's, ~10 min per upstream release); the proxy must stub account endpoints offline; if she plays in the browser in parallel, the online-vs-mirror conflict still exists (handled by the reconcile).

### Option C — Use the game's own paths (newer-local-wins + Import)
Rely on `initSystem` adopting a newer local `data_<user>` and on Import for sessions.
- Rejected: Import destroys playTime; sessions are not covered; behaviour is undocumented and changes with upstream.

**Recommendation: Option B.** It is the only option where "she plays as before" and "never lose progress" do not fight each other, and the failure cases are all observable in one place.

## 4. Sync invariants (Option B)
- No write to server or mirror without a prior verified `.prsv` backup of what it replaces.
- One `clientSessionId` per sync run, claimed via `system/get`; on `not active`, re-fetch and re-check, never assume.
- Branch on HTTP status, never on empty body. `text/html` ⇒ offline.
- Push order: system first (validated by server), then sessions with a per-slot `session/get` compare (seed, waveIndex, timestamp) immediately before each write.
- Equal playtime is not proof of no change; compare timestamp and structural equality too.
- Session data: local copy authoritative; normalise `null` → `[]` when serving downloaded sessions.
- `updateall`, `clear`, `newclear`, `verify` are never called by the sync path.

## 5. Backups — proposed policy
Small files (hundreds of KB), so keep generously: every pre-overwrite backup for 30 days, then one per month indefinitely, plus permanent backups around each conflict resolution and each game update. Store under `Documents\PokeRogue Backups\` (survives uninstall and clear-cache, gets picked up by OneDrive if she uses it) with a copy in `%APPDATA%`. Each backup is a normal `.prsv` importable through the game's Import.

## 6. Updates
Bundle the current `game.zip` in the installer (roughly 600 MB installer) so first run needs no download. Afterwards check our release feed on each online launch; on a metered connection (Windows `Get-NetConnectionProfile` cost / `navigator.connection`) show one plain prompt, otherwise download to a staging folder, validate the zip, swap atomically on next launch. Never delete the old game before the new one is verified (upstream bug). If the server says "existing version is greater", trigger the update flow rather than surfacing an error.

## 7. Agent plan for implementation (Opus, one per step)
1. Game build pipeline: reproducible `pnpm build` from a pinned upstream tag with our env; GitHub Actions publishing `game.zip` + checksum; local build script for dev.
2. Proxy + mirror store: route table from `verify-server.md` §9, recording, offline stubs, dirty tracking; unit tests against a fake server; contract tests against the live API with the throwaway account.
3. Sync engine + backups: three-way reconcile, `.prsv` writer/reader with round-trip check, conflict dialogue + settings, error classification, retries; property tests for the no-loss invariant.
4. Electron shell: single window, proxy lifecycle, first-run, login persistence, updater with metered prompt, tiny settings page, plain-language status ("Last saved online: today 14:03").
5. Installer + clean-machine test: electron-builder NSIS, code-sign cache workaround (Developer Mode), test on a clean Win11 VM. Note: this dev machine is Win11 Home, no Windows Sandbox/Hyper-V; VirtualBox + evaluation ISO or a fresh Windows user account is needed.
6. Adversarial QA: kill network mid-save, kill app mid-sync, corrupt zip, disk full, wrong password, two clients on one account; each verified against Play Time on the throwaway account.

## 8. Where the risk sits
1. Cloudflare/WAF behaviour changes (undocumented, only observable live). Mitigation: HTML ⇒ offline classification, never destructive.
2. Upstream game or server changes semantics (the `verify` endpoint is already broken live). Mitigation: proxy is a passthrough online, so unknown routes just work; only save endpoints are interpreted.
3. She plays in a plain browser in parallel. Mitigation: three-way reconcile + dialogue; the app should become her only way to play.
4. Our build pipeline breaks when upstream changes its build. Mitigation: pinned tags, fallback to last good `game.zip`, app keeps working offline.
5. Unsigned installer warning (accepted in brief).
6. Untested assumption: the login-enabled build served from `http://127.0.0.1` behaves identically to pokerogue.net. First implementation milestone must prove this end to end on the throwaway account before anything else.
