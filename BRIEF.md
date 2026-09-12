# Brief: PokeRogue offline + automatic save sync

## Goal

The target user plays PokeRogue (`pokerogue.net`) online on a Windows 11 laptop and is regularly offline for hours at a time. They are not technical at all: the end result must be one icon to double-click, with no toggles, no prompts, no manual exporting or importing, and no technical dialogs. Online it should be the online game; with no connection, the offline game, with the progress in it; and offline progress should end up back on the account by itself.

The account holds a large amount of accumulated progress. **Losing progress is the only unacceptable failure.** Everything else must degrade to "the user plays as before".

Starting point: `Admiral-Billy/Pokerogue-App`, an Electron wrapper (MIT) that can run the game from local files, but requires manually toggling offline mode and keeps a save that is entirely separate from the online account.

## Constraints

- Never test writes against the real account. Throwaway account only, for everything.
- Target is Windows 11, installed from a build the user runs once and then forgets about.
- The game's own export format is the only sanctioned way to hand a save back to the user, so backups should be restorable through the game's Import.
- Design, architecture, agent setup and verification strategy are yours to decide.

## Facts read from the upstream sources

Read out of the actual repositories. Confirm each one still holds — upstream moves — and correct anything that has changed.

| Fact | Where it came from |
|---|---|
| The offline build runs with `VITE_BYPASS_LOGIN=1`, so the user is `Guest` and the save key is `data_Guest` | pokerogue `src/account.ts`, `src/system/game-data.ts` |
| In that mode saves are stored as `btoa(encodeURIComponent(json))`, not encrypted | pokerogue `src/utils/data.ts` |
| A `.prsv` export is `CryptoJS.AES.encrypt(json, "x0i2O7WRiANTqPmZ")`; the key is public in the source. CryptoJS passphrase mode matches OpenSSL: `"Salted__"` + 8-byte salt, EVP_BytesToKey(MD5, 1 iteration), AES-256-CBC | pokerogue `src/constants.ts`, `exportData` |
| API base is `https://api.pokerogue.net`; the auth header is the raw `pokerogue_sessionId` cookie value | pokerogue `.env.production`, `src/api/api-base.ts` |
| The server stores one system save (dex, unlocks, eggs, stats) plus up to 5 session slots for runs in progress | pokerogue `src/api/system-savedata-api.ts`, `session-savedata-api.ts` |
| `GET /savedata/system/get?clientSessionId=X` makes X the active session; `update` requires being the active session | rogueserver `api/endpoints.go` |
| The server rejects an update with lower playtime than stored, mismatched `trainerId`/`secretId`, a save version below the minimum, or desynced migrators | rogueserver `api/endpoints.go` |
| `gameStats.playTime` only grows while playing, and the server enforces that it never decreases | rogueserver `api/endpoints.go` |
| The online game writes its system save into `pokerogue.net` localStorage under `data_<username>`, in the same AES format as `.prsv`, before uploading it | pokerogue `game-data.ts`, `saveSystem` / `saveAll` |
| The offline game files come from `Admiral-Billy/pokerogue` releases (`game.zip`, ~500 MB), rebuilt automatically from upstream; release dates track upstream releases | Pokerogue-App `src/globals.js` |
| The wrapper app records the installed offline version in `currentVersion.txt`, and has a `--clear-cache` path that deletes things under `%APPDATA%\PokeRogue` | Pokerogue-App `src/main.js`, `src/file_tab.js` |
| In-game ground truth for progress: Menu → Game Stats → Play Time | pokerogue `src/ui/handlers/game-stats-ui-handler.ts` |

## Open questions

- Nothing here has ever talked to the live API. All endpoint knowledge is source-read.
- The public `rogueserver` repository may lag what is actually deployed.
- Whether their terms treat automated use of the save API differently from the game's own import is unresolved.
- A self-built installer will be unsigned, so Windows will warn once during setup.

## Kickoff prompt

> Read BRIEF.md. Verify the facts table against the current upstream sources before designing anything, and report it back to me with file and line references.
>
> Then propose your own architecture, your own subagent setup, and your own verification strategy for reaching the goal, and tell me where you expect the risk to sit. Wait for my go-ahead before implementing.
