# Decisions log

## 2026-09-12 — kickoff answers from project owner

1. Architecture: a local game build with a sync layer is acceptable, but explore other options. Ease of use is top priority, second only to "never lose progress".
2. Scope: session slots (runs in progress) must be accessible offline, update regularly, and be synced — not only the system save.
3. Other devices: she has so far only played in a plain browser on pokerogue.net (single-device assumption is likely but not guaranteed).
4. Conflict policy: a one-time dialogue when both sides changed, plus a way to change the choice later in settings.
5. Login: username/password (not OAuth), to be confirmed.
6. Game updates: update regularly when online, but prompt before large downloads because she sometimes plays over a mobile hotspot.
7. Backups: owner asked for best practice on retention (count vs. time span) — to be proposed.
8. Live API: go-ahead granted; use a freshly created throwaway account only.
9. Project home: C:\dev\pokerogue-offline. Install all dependencies (target machine is Win11 with nothing preinstalled).
10. Always verify facts against upstream before designing.
11. Orchestration: multiple Opus agents, divided by step of the sequence.

## Environment facts (this dev machine)
- Windows 11 Home 10.0.26200, German locale, winget available.
- Node 24.19.0 / npm 11.17.0 installed via winget on 2026-09-12. Path: C:\Program Files\nodejs
- git 2.54, curl 8.19 present. No gh CLI, no Python.
- Upstream clones (shallow, 2026-09-12) in upstream/: pokerogue (da1d0ef), rogueserver (c7fed19, 2026-08-18), Pokerogue-App (41e9835, 2026-09-07), admiral-pokerogue-fork (c16a3bbf, 2025-12-20).

## 2026-09-12 — go-ahead

- Architecture approved: always-local game build behind a local caching proxy (Option B in reports/00-verification-and-proposal.md). Contract in DESIGN.md.
- Accepted: we build and host game.zip ourselves from pinned upstream tags; installer bundles the game (~600 MB).
- Backup policy approved: Documents\PokeRogue Backups, keep all for 30 days, then one per month, conflict/update backups kept forever.
- Same-origin API: game compiled with VITE_SERVER_URL=http://127.0.0.1:47830/api (client builds URLs as base + path, so a prefix works).
- GitHub repo for source, game releases and installer: https://github.com/m0stey/pokerogue-offline (UPDATE_REPO = m0stey/pokerogue-offline).

## 2026-09-13
- Sync engine: on an `unknown-rejection` the engine should also export a fallback `.prsv` of the local save (cheap, and "fail safe" must include "nothing lost"). To be done in the QA phase; not yet implemented.
- Session read-back verification compares only keys the server returned; dropped keys are warnings, critical keys (seed, waveIndex, timestamp, party, gameMode, playTime) are errors.
- Finished-offline runs propagate via `session/delete` only under four preconditions (see DESIGN §3.8); `clear` is never sent.
- UI language: German for every user-visible string (dialogs, settings page, tray, splash, installer). Plain everyday German, informal "du", no technical terms. Decided 2026-09-13.

## 2026-09-13 — scope trim: ship a stable, secure v1 in German

After the milestone-1 run was stopped part-way ("the scope of the project got a bit too big — I want
a usable version for her that's stable and secure"), the following was decided and is now implemented
(see `reports/hardening.md`, `SECURITY.md`, and the rewritten DESIGN.md §3.4/§3.6/§3.7/§3.9/§3.10).

- **The app no longer updates itself.** The downloading updater is gone — no release download, no
  SHA-256 check, no unpacking, no swap at next start, no `staging`/`previous` folders, no
  metered-connection detection and no metered prompt, and the `allowMeteredDownloads`,
  `gameUpdateChannel` and `lastSeenGameTag` settings with them. What is left is a notice: the GitHub
  release feed is read at most once every 6 h while online, and a newer `game-<tag>` produces one
  German message asking her to get the new installation. A new game version arrives as a new
  installer, run by hand. Rationale: ~600 MB of download-verify-unpack-swap machinery had never once
  run for real, and every part of it can leave the game files broken — which is the one thing that
  must not happen.
- **The game-version block is handled, not prevented.** The client refuses to load a system save
  newer than its own build, and one browser session on pokerogue.net causes it. The proxy now spots
  it on every `system/get` (online and offline) and the shell says, once per start, what happened,
  that nothing is lost, and who to ask. We cannot avoid the block; we can stop it looking like a
  broken app.
- **B2 fixed in `src/sync`:** any comparison against the server's copy of a *session* now tolerates
  the keys the server does not store. The server's echo of our own push is no longer read as "the
  server changed it", which ends the ten-minute pull loop and the ~144 never-pruned `.prsv` files a
  day.
- **B3 fixed in `src/proxy`:** offline `session/newclear` answers `200 false` (the server's own
  shape) instead of 503. A 503 made the client throw, wipe the game-over screen and reload the page.
- **`unknown-rejection` now exports a fallback `.prsv`** with `reason: "rejected"` (never pruned) and
  reports it in `SyncResult.unrecoverable` — the QA-phase item from 2026-09-13 above.
- **The account token is encrypted at rest** with Electron `safeStorage`. `src/proxy` stays
  Electron-free through an injectable `SecretCodec`.
- **The proxy refuses foreign `Host` headers** (DNS-rebinding guard) on top of binding `127.0.0.1`.
- **German everywhere**, with every string in one reviewable module `src/main/strings.de.ts`, and the
  NSIS installer set to German (`installerLanguages: de_DE`, `language: 1031`). "Spielzeit" is used
  for Play Time, matching the game's own German locale.
- **SECURITY.md** is written and states the two accepted weaknesses plainly: the offline login does
  not verify the password, and anyone with her Windows account has everything. The installer is
  unsigned.
- **Left as it was**: the conflict dialog's shape, the backup retention policy, the sync sequence,
  and the `clear`/`delete` rules. Nothing about how progress is decided or stored changed apart from
  B2.
