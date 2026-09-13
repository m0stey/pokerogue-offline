# Acceptance v1 — 2026-09-13

## Installer
| | |
|---|---|
| File | `release/PokeRogue-Setup-0.1.0.exe` (not in git) |
| Size | 628,964,763 bytes (~600 MB, game bundled) |
| SHA-256 | `a8812518b0fbd1615bc61c9ce10423ddc8d4a748261dde0b7a8ac594fe4628e1` |
| Type | NSIS one-click, per-user, unsigned |
| Install dir | `%LOCALAPPDATA%\Programs\pokerogue-offline` |

Install method: interactive run of the installer under the developer's Windows account after deleting previous app data. No separate Windows user was created.

## Results

| Check | Build | Result |
|---|---|---|
| Installer runs, desktop and Start menu shortcuts created | packaged | pass |
| Game files bundled at `resources\game` with `version.json` | packaged | pass |
| Installed app serves game page and forwards the API | packaged | pass |
| Foreign `Host` header refused (403) | packaged | pass |
| Dev-only offline switch inert | packaged | pass |
| Login through the app | dev | pass |
| Saves load online through the proxy | dev | pass |
| Switch to offline detected | dev | pass |
| Offline system save (204) and run save (200) accepted | dev | pass |
| Offline reload returns offline progress | dev | pass |
| Mirror marks unsynced data | dev | pass |
| App saves online by itself after reconnect | dev | pass, 12.1 s after reconnect |
| Server play time 593 → 893 and wave 4 → 6, same run seed | dev | pass |
| Verified `.prsv` backups of the server state written before overwrite | dev | pass, both decrypt with the app's own module |
| Log errors during the whole run | both | 0 |

Script: `scratch/acceptance/offline-roundtrip.mjs` (acts as the game against the proxy, checks the real server independently with the install clientSessionId). Evidence: `reports/acceptance-v1/results.json`, `server-before.json`, `server-after.json`.

Real gameplay in the game window was verified in milestone 1 (login, online run, offline reload resuming the run). This run verified the save round trip with scripted saves in the game's exact request format, because the packaged app cannot be forced offline without admin rights.

## Findings
1. **Installer text is English** ("Installing, please wait…") despite the German NSIS settings. Cosmetic: the one-click installer shows only a progress bar for a few seconds.
2. **Private screenshots.** The interrupted agent captured the full desktop. They were moved to `scratch/` (git-ignored) and are not part of the repo.

## Known limitations for handover
- Windows warns once that the installer is from an unknown publisher.
- When PokéRogue releases a new version and the user plays it in the browser, the app shows a German notice and the user needs a new installer from the owner. Nothing is lost meanwhile.
- The first game release on GitHub has not been published yet, so the "new version available" check has nothing to compare against until the workflow runs once.
- Offline, the app does not check the password; anyone using the Windows account can open the game.
- App updates are manual: a new installer over the old one keeps all saves.
