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
