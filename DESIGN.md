# DESIGN — PokeRogue Offline (working name)

Approved 2026-09-12. Read `reports/00-verification-and-proposal.md` for the why. This file is the contract every module is built against. Change it only by editing this file first.

## 0. The product in one paragraph

A Windows 11 Electron app. One icon. It serves an unmodified upstream PokeRogue build from `http://127.0.0.1:47830/` and the game's API base is compiled as `http://127.0.0.1:47830/api` (same origin, no CORS). A proxy inside the app forwards `/api/*` to `https://api.pokerogue.net` when online and answers from a local mirror when offline. On reconnect the sync engine reconciles mirror and server. The user never sees a mode switch. Losing progress is the only unacceptable failure.

## 1. Fixed constants

| Name | Value | Why fixed |
|---|---|---|
| `GAME_ORIGIN` | `http://127.0.0.1:47830` | Compiled into the game build and is the localStorage origin; must never change |
| `API_PREFIX` | `/api` | Compiled into the game build (`VITE_SERVER_URL=http://127.0.0.1:47830/api`) |
| `UPSTREAM_API` | `https://api.pokerogue.net` | |
| `UPSTREAM_ORIGIN_HEADER` | `Origin: https://pokerogue.net` | Cloudflare 403s without it |
| `PRSV_KEY` | `x0i2O7WRiANTqPmZ` | Public in upstream `src/constants.ts` |
| Session slots | `0..4`; slot 0 localStorage key `sessionData_<user>`, others `sessionData<n>_<user>` | |
| Game build tag | pinned per release, currently `v1.12.0.11` | |

## 2. Repository layout

```
app/                      Electron app (TypeScript, Node built-ins only at runtime)
  src/main/               Electron main: window, lifecycle, settings, dialogs, updater
  src/proxy/              HTTP server: static game + /api proxy + offline replay + mirror store
  src/sync/               Pure logic: prsv crypto, reconcile, backup manager, error classification
  src/ui/                 Small HTML pages: first-run login hint, conflict dialog, settings
  test/                   vitest tests (unit + fake-server integration)
game-build/               Scripts + GitHub Actions to build game.zip from an upstream tag
reports/                  Verification + milestone reports
scratch/                  Throwaway; never imported from
upstream/                 Read-only clones for reference
```

Rules for agents: runtime dependencies are Node built-ins only (`http`, `https`, `crypto`, `fs`, `path`, `zlib`, `stream`). Dev dependencies are already installed; do not run `npm install <pkg>` — if something is truly unavoidable, write it in `NOTES-<module>.md` and stub. Do not commit; the orchestrator commits. Never modify `upstream/`.

## 3. Module contracts

### 3.1 `src/sync/prsv.ts`
```ts
export function encryptPrsv(json: string): string;      // CryptoJS-compatible OpenSSL "Salted__" base64
export function decryptPrsv(blob: string): string;      // throws PrsvError on bad padding/format
export function decodeBypassBlob(b64: string): string;  // decodeURIComponent(atob())
export function encodeBypassBlob(json: string): string;
```
Must round-trip with a `.prsv` produced by the real client (test fixture from `scratch/api-probe` or produced via crypto-js in a dev-only test).

### 3.2 `src/sync/types.ts`
```ts
export type SystemSave = Record<string, unknown> & { trainerId: number; secretId: number; gameVersion: string; timestamp: number; gameStats: { playTime: number } & Record<string, unknown> };
export type SessionSave = Record<string, unknown> & { seed: string; waveIndex: number; timestamp: number; gameVersion: string };
export interface SaveSnapshot { system: SystemSave | null; sessions: (SessionSave | null)[]; /* length 5 */ }
```

### 3.3 `src/proxy/mirror.ts` — the local store
Directory: `<userData>/mirror/`. Files, all pretty JSON written atomically (write temp + rename):
- `account.json` `{ username, token, info: AccountInfo, lastLoginAt }`
- `system.json` `{ base: SystemSave|null, local: SystemSave|null, dirty: boolean, baseFetchedAt, localWrittenAt }`
- `session-<n>.json` same shape with `SessionSave`, n = 0..4
- `state.json` `{ clientSessionId: string, lastSyncAt, lastSyncResult, gameVersionServed }`

`base` = the last state known to be on the server (set after a successful GET from server or a successful verified push). `local` = what the game last wrote. `dirty` = local differs from base.

```ts
export class Mirror {
  constructor(dir: string);
  readSystem(): SystemRecord; writeLocalSystem(s: SystemSave): void; setBaseSystem(s: SystemSave|null): void;
  readSession(n): SessionRecord; writeLocalSession(n, s): void; setBaseSession(n, s|null): void; deleteLocalSession(n): void;
  readAccount(): AccountRecord|null; writeAccount(a): void;
  snapshotLocal(): SaveSnapshot; snapshotBase(): SaveSnapshot;
}
```

### 3.4 `src/proxy/server.ts`
```ts
export interface ProxyOptions { gameDir: string; mirror: Mirror; port: 47830; connectivity: Connectivity; log: Logger }
export function startProxy(opts: ProxyOptions): Promise<{ close(): Promise<void> }>;
```
Behaviour:
- Static: serve `gameDir` at `/` with correct MIME types, SPA fallback to `index.html`, `Cache-Control: no-cache` for `index.html`.
- `/api/*` online (see §4 classification): forward verbatim to `UPSTREAM_API` with the original method, body, `Authorization`, `Content-Type`, `PKR-Client-Version`, plus `Origin: https://pokerogue.net`. Return upstream status/body verbatim. Side effects on success only:
  - `POST /account/login` 200 → store token + username in `account.json` (username from the request body).
  - `GET /account/info` 200 → store info.
  - `GET /savedata/system/get` 200 → `setBaseSystem` + `writeLocalSystem` (dirty=false).
  - `POST /savedata/system/update` 204 → `writeLocalSystem(body)` + `setBaseSystem(body)`.
  - `GET /savedata/session/get` 200 → base+local for that slot; `POST .../update` 200 → base+local; `GET .../delete` 200 → base+local = null.
  - `POST /savedata/updateall` 200 → both.
- `/api/*` offline: 
  - `POST /account/login` → if username matches `account.json`, return `{token}` with the stored token (password is NOT verified offline; document this); else 401 `offline: unknown user`.
  - `GET /account/info` → stored info (200) or 401 if none.
  - `GET /account/logout` → 200, do not clear the mirror.
  - `GET /savedata/system/get` → local (200) or 404 `save does not exist`.
  - `POST /savedata/system/update` → apply server rules locally (playtime not lower, tid/sid match base if base exists) then `writeLocalSystem`, dirty=true, 204.
  - `GET /savedata/system/verify` → `{valid:true, systemData: local or zeroed}` 200.
  - session `get/update/delete` → local with the same statuses the server uses; `update` sets dirty. Serve `null` arrays as `[]` normalisation is NOT done here (game tolerates null); keep bytes as stored.
  - `POST /savedata/updateall` → both, 200.
  - `GET /game/titlestats`, `/daily/*`, anything else → 503 `offline` (game treats as unavailable).
- Any upstream response whose `Content-Type` starts with `text/html`, or any network error / timeout (10 s), flips `Connectivity` to offline and the request is re-answered from the mirror as above. Never surface HTML to the game.
- Status codes: never treat an empty body as success; branch on status.

### 3.5 `src/proxy/connectivity.ts`
```ts
export class Connectivity extends EventEmitter { state: 'online'|'offline'|'unknown'; probe(): Promise<void>; markOffline(reason): void; }
```
Probe = `GET https://api.pokerogue.net/game/titlestats` with `Origin`; JSON 200 ⇒ online. Runs at startup, every 60 s while offline, every 5 min while online, and on Electron `online` events.

### 3.6 `src/sync/reconcile.ts` — pure
```ts
export type SlotDecision = { kind: 'noop' } | { kind: 'push' } | { kind: 'pull' } | { kind: 'conflict' };
export function reconcileSystem(base: SystemSave|null, local: SystemSave|null, remote: SystemSave|null): SlotDecision;
export function reconcileSession(base: SessionSave|null, local: SessionSave|null, remote: SessionSave|null): SlotDecision;
```
Rules: structural equality after normalising `null`↔`[]` and key order. `remote == base && local != base` ⇒ push. `local == base && remote != base` ⇒ pull. Both differ ⇒ conflict, unless one is a strict descendant of the other by (`playTime` ≥, `timestamp` ≥, and for sessions same `seed` with `waveIndex` ≥) in which case fast-forward to the descendant. Everything else conflict. Never guess.

### 3.7 `src/sync/backup.ts`
```ts
export interface BackupManager { backup(kind: 'system'|'session', slot: number|null, save: object, reason: string): Promise<string /*path*/>; prune(): Promise<void>; }
```
Writes `.prsv` (system: key-shortened exactly like the client's export; session: like the client's session export) to `Documents\PokeRogue Backups\<yyyy-mm-dd>\<HHmmss>-<reason>-<kind><slot>.prsv` and a copy under `<userData>/backups/`. After writing, re-read, decrypt, parse, and structurally compare — only then return. Retention: keep everything ≤ 30 days; older: keep the last file per calendar month; `reason` in {`conflict`, `update`} is never pruned.

### 3.8 `src/sync/engine.ts`
```ts
export interface SyncResult { pushed: string[]; pulled: string[]; conflicts: string[]; errors: string[]; }
export async function runSync(deps: { mirror; backup; api: UpstreamApi; policy: ConflictPolicy; log }): Promise<SyncResult>;
```
Sequence: (1) if nothing dirty and base fresh (< 5 min), noop. (2) `system/get` with the mirror's `clientSessionId` → remote system. (3) decide system. (4) for each slot: `session/get` → decide. (5) apply: for every push or pull, `backup()` the side being replaced first; push system before sessions; immediately before each session push, re-`get` and re-compare that slot. (6) after each push, GET back and structurally compare (system: strict; session: after null/[] normalisation, ignoring server-dropped fields listed in `KNOWN_LOSSY_SESSION_FIELDS`). (7) update base/local/dirty. Conflicts go to the policy: `ask` (dialog once, remembers answer), `prefer-this-computer`, `prefer-online`. Never call `clear`, `newclear`, `verify`, or session `delete` from the engine.

### 3.9 `src/sync/errors.ts`
Map server error substrings to typed reasons: `not active`, `existing playtime is greater`, `stored trainer or secret ID does not match`, `save version below minimum game version`, `existing version is greater`, `existing wave index is greater`, `slot id .* out of range`, `failed to validate token`, `missing token`. Unknown ⇒ `unknown-rejection` (fail safe: do nothing, keep dirty). `existing version is greater` ⇒ emit `needs-game-update`.

### 3.10 `src/main/`
- Single `BrowserWindow`, loads `GAME_ORIGIN`, no menu, fullscreen-capable, remembers size.
- On start: ensure game files present (`<userData>/game/<version>/`), start proxy, probe connectivity, open window; run sync 3 s after online is detected and every 10 min while online, and on window close (await, max 30 s, with a small "Saving online…" splash if > 2 s).
- Login: the game's own login screen (first run only; offline replay keeps the user logged in).
- Dialogs (plain German/English text to be decided; default English): conflict dialog, metered-download prompt, "backup exported" notice on unrecoverable rejection. Text must not contain technical terms.
- Settings page (`src/ui/settings.html`, opened via a small gear button overlay or tray): conflict preference, backups folder link, game version, "Last saved online: …", Play Time as reported by the mirror.
- Updater: check our GitHub release feed; metered check via PowerShell `Get-NetConnectionProfile | Select NetworkCategory, IsConnectedToInternet` plus `(Get-NetConnectionProfile).NetworkCost` where available; download to `<userData>/game/staging/`, verify SHA-256 from the release, unzip, swap on next start, keep previous version until the new one has served one successful session.

## 4. Invariants (tested)

1. No write to the server or to `mirror.local`/`mirror.base` that replaces data happens without a prior verified `.prsv` backup of what it replaces.
2. `text/html` from upstream or any transport error ⇒ `offline`, never `rejected`.
3. Branch on HTTP status only.
4. One `clientSessionId` per app install (stored in `state.json`), and every sync starts with `system/get` to claim it; any `not active` ⇒ re-GET, re-decide, retry once, then stop.
5. Equal playtime ≠ unchanged; structural comparison decides.
6. A mirror `local` is never overwritten by a `remote` that is not a descendant unless the conflict policy says so and a backup exists.
7. The engine never calls `clear`, `newclear`, `verify`, `delete`.

## 5. Milestone 1 (must pass before anything else is polished)

Built game served from `GAME_ORIGIN` through the proxy, in Electron, logged in with the throwaway account: start a run online, see saves arrive at the server (`system/get` from an independent script shows new playTime); disconnect (block upstream in the proxy), keep playing 2+ waves, close; reconnect, reopen: sync pushes, independent script shows the offline progress on the server, Play Time in game matches.
