# Verification report: `Admiral-Billy/Pokerogue-App` + `Admiral-Billy/pokerogue`

Date of check: **2026-09-12**
Sources: fresh shallow clones at `C:\dev\pokerogue-offline\upstream\Pokerogue-App` (HEAD `41e9835`) and
`C:\dev\pokerogue-offline\upstream\admiral-pokerogue-fork` (HEAD `c16a3bbf`, 2025-12-20), plus the GitHub REST API
and the upstream source tarball of `pagefaultgames/pokerogue` at `e4e9b53` (current `main` HEAD).

> Caveat that shapes the whole report: **the local fork clone is misleading.** The fork's own working tree is
> 2,779 commits behind upstream and only 3 files ahead, and its build workflow **does not build the fork's own
> source at all** - it checks out `pagefaultgames/pokerogue` fresh on every run. Any conclusion drawn from files
> inside `admiral-pokerogue-fork/` (its `.env*`, its `src/`, its `vite.config.ts`) is about a dead tree.

---

## Summary table

| # | Claim | Verdict | Evidence (file:line) |
|---|---|---|---|
| 1a | Offline game files come from `Admiral-Billy/pokerogue` releases, asset `game.zip`, ~500 MB | **TRUE** | `upstream/Pokerogue-App/src/globals.js:22`; `src/file_tab.js:105`, `:108`; API: `game.zip` = 507.1 MB |
| 1b | Rebuilt automatically from upstream | **TRUE** | fork `.github/workflows/update.yml:1-101` (cron + checkout of `pagefaultgames/pokerogue@main`); 7,278 workflow runs, every ~2-5 h, all `success` |
| 1c | "Release dates track upstream releases" | **TRUE, but not how the wording implies** | The fork keeps **one rolling release**, tagged `release-<upstream short sha>`, not one per upstream release. Current: `release-e4e9b53`, published 2026-08-23T20:13Z, 10 min after upstream tag `v1.12.0.11` (2026-08-23T20:03Z) |
| 1d | Has it stalled? Gap to upstream HEAD? | **NOT stalled. Gap = 0 commits** | `game.zip` was built from upstream `e4e9b53`, which **is** `pagefaultgames/pokerogue@main` HEAD right now (`compare e4e9b53...main` -> `identical`, `ahead_by 0`). The `beta` branch (the repo's *default* branch) has moved on to `da1d0eff`; that is what makes the fork look stale at first glance. |
| 2a | Wrapper records installed offline version in `currentVersion.txt` | **TRUE** | `src/main.js:144` (path), `src/file_tab.js:157` (write), `src/utils.js:94` (read) |
| 2b | `--clear-cache` deletes things under `%APPDATA%\PokeRogue` | **TRUE** | `src/main.js:147-172`; triggered from `src/file_tab.js:66-96` (menu "Reload + clear cache", `Ctrl+F5`) |
| 2c | Can `--clear-cache` delete localStorage / save data? | **NO - `Local Storage` is explicitly excluded** (but `Cookies`, `Session Storage`, `IndexedDB` are deleted) | `src/main.js:150`, `:159` |
| 3a | Online vs offline load path | Online = `loadURL('https://pokerogue.net/')`; offline = `loadFile(<gameDir>/index.html)` -> **`file://` origin** | `src/main.js:95-103`, `src/utils.js:219-228` |
| 3b | Offline toggle persisted | Menu checkbox -> `globals.isOfflineMode`, saved to `<userData>\settings.json` | `src/settings_tab.js:16-26`, `src/utils.js:150`, `:171` |
| 3c | Electron version | **29.3.3** (`^29.3.3`, installed 29.3.3) | `package.json:19`; build log `electron=29.3.3` |
| 3d | nodeIntegration / contextIsolation on the game window | **nodeIntegration off, contextIsolation on, sandbox on - Electron 29 defaults; no `webPreferences` is passed at all** | `src/main.js:19-26` |
| 3e | Preload script to hook? | **None on the game window.** `src/utils_preload.js` is attached only to utility windows | `src/utils.js:15-33`, `src/utils_preload.js:1-6` |
| 4a | How is the offline game served? | **`file://` via `BrowserWindow.loadFile`** - no local HTTP server, no custom protocol | `src/main.js:96` |
| 4b | Does the `VITE_BYPASS_LOGIN` build make network calls? | **No calls to `api.pokerogue.net`.** Every `pokerogueApi` call site is behind `!bypassLogin` / `isLocalServerConnected`; base URL compiled into the app build is `http://localhost:8001` | upstream `src/constants/app-constants.ts:21`, `src/api/api.ts` (last line), `src/utils/common.ts:290-302`, `src/phases/title-phase.ts:330`, `src/phases/game-over-phase.ts:268`, `src/system/game-data.ts:323,348,1373` |
| 4c | What does the fork change to make the offline build? | **Almost nothing in `src/`.** It adds `.github/workflows/update.yml` and runs upstream's own `pnpm build:app` (`vite build --mode app`, upstream `.env.app` -> `VITE_BYPASS_LOGIN=1`) | fork `.github/workflows/update.yml:70`; upstream `package.json` `build:app`; upstream `.env.app` |
| 5 | Build feasibility on this machine | **`npm install` OK (38 s, 390 pkgs, exit 0). `electron-builder --win --dir` produced a complete `win-unpacked` (266 MB, `PokeRogue.exe`, `resources/app.asar`) but exited 1** on a `winCodeSign` symlink-extraction failure | `C:\dev\pokerogue-offline\scratch\build-unpacked.log` |
| 6 | Licences | Wrapper **MIT**; game **AGPL-3.0-only** (assets CC-BY-NC-SA-4.0, some explicitly unlicensed) | `Pokerogue-App/LICENSE`; upstream `LICENSE`, `README.md:28-41`, `REUSE.toml` |

---

## 1. Where the offline game files come from, and how current they are

### The download URL

```js
// upstream/Pokerogue-App/src/globals.js:22
let latestGameReleaseUrl = 'https://api.github.com/repos/Admiral-Billy/pokerogue/releases/latest';
```

Used by `utils.fetchLatestGameVersionInfo()` (`src/utils.js:104-134`), consumed in `src/file_tab.js:105`:

```js
let zipAsset = releaseData.assets.find((asset) => asset.name === 'game.zip');
const zipUrl = zipAsset.browser_download_url;          // :108
```

So: **always `releases/latest` of `Admiral-Billy/pokerogue`, always the asset literally named `game.zip`.**
There is no version pinning and no integrity check (no hash, no signature). `utils.downloadFile`
(`src/utils.js:241-280`) follows exactly one 302 and, notably, **never checks `response.statusCode`
and never rejects on a truncated body** - `fileStream.on('finish')` resolves regardless. A failed or partial
download produces a corrupt `game.zip` that then throws inside `AdmZip` *after*
`fs.rmSync(globals.gameDir, {recursive:true, force:true})` has already deleted the previous game files
(`src/file_tab.js:140-150`). That ordering is a real "you now have no offline game" failure mode for us.

### Releases on `Admiral-Billy/pokerogue` (API, 2026-09-12)

There is exactly **one** release in the repository - the workflow deletes older ones
(`update.yml:209-216`, `dev-drprasad/delete-older-releases`, `keep_latest: 1`, `delete_tags: true`).

| published | tag | asset | size | downloads | asset last updated |
|---|---|---|---|---|---|
| 2026-08-23T20:13:02Z | `release-e4e9b53` (release name `e4e9b53`) | `game.zip` | **507.1 MB** | 7,269 | 2026-08-23T20:13:22Z |
| | | `game_beta.zip` | 503.6 MB | 1 | 2026-09-12T14:43:37Z |
| | | `game_futaba_mod.zip` | 288.7 MB | 7 | 2026-09-12T14:41:29Z |
| | | `kanto_version.zip` | 484.2 MB | 0 | 2026-09-12T14:42:18Z |

(The release's `created_at` of 2025-12-21 is only the date of the fork commit the tag points at, `c16a3bbf`;
`published_at` is the real build date.)

### Comparison with `pagefaultgames/pokerogue`

Last 10 upstream releases:

| published | tag |
|---|---|
| 2026-08-23T20:03:06Z | v1.12.0.11  <- **`e4e9b53`** |
| 2026-07-25T01:47:40Z | v1.12.0.10 |
| 2026-07-17T10:02:24Z | v1.12.0.9 |
| 2026-07-16T22:32:25Z | v1.12.0.8 |
| 2026-07-10T20:17:41Z | v1.12.0.7 |
| 2026-07-09T22:54:45Z | v1.12.0.6 |
| 2026-07-07T00:27:03Z | v1.12.0.5 |
| 2026-07-04T02:55:10Z | v1.12.0.4 |
| 2026-07-04T02:53:54Z | v1.12.0.3 |
| 2026-07-01T11:27:04Z | v1.12.0.2 |

- Upstream tag `v1.12.0.11` -> commit `e4e9b538...`, 2026-08-23T19:50Z.
- `game.zip` was published 2026-08-23T20:13Z - **10 minutes after the upstream hotfix landed on `main`.**
- `GET /repos/pagefaultgames/pokerogue/branches/main` -> HEAD is still `e4e9b5383be7c9e171d32a9daaea2658d475c521`.
- `GET /compare/e4e9b53...main` -> `status: identical`, `ahead_by: 0`, `total_commits: 0`.

**Gap between the latest offline build and upstream production HEAD: zero commits, zero days.**
The offline `game.zip` is built from the same source `pokerogue.net` is serving (both from `main`),
differing only in the vite build mode (`app` vs `production`).

The thing that *looks* like staleness: `pagefaultgames/pokerogue`'s **default branch is `beta`**, which is at
`da1d0eff` (2026-09-12). The fork tracks `main` deliberately (`update.yml:21`), which is correct for us -
`main` is the released/production branch and the one whose save format the live server accepts.

### Is the rebuild actually automatic?

Yes. `admiral-pokerogue-fork/.github/workflows/update.yml`:

- `on: schedule: cron: '*/180 * * * *'` (lines 4-5) plus `push` to `main`.
  Note: `*/180` in the **minute** field is out of range (0-59); cron reduces this to "minute 0", i.e. it is
  scheduled hourly, and observed runs land every ~2-5 h with GitHub's scheduling jitter.
- `actions/checkout@v5` of `repository: pagefaultgames/pokerogue`, `ref: main`, `submodules: recursive`
  (lines 18-22) - **the fork's own tree is thrown away.**
- The short SHA of that checkout is compared to the name of the newest release (lines 24-49); if equal,
  `stop_build=true` and every `game.zip`-related step is skipped.
- Otherwise `pnpm build:app` (line 70) -> `cd dist; echo <sha> > currentVersion.txt; zip -r game.zip .`
  (lines 74-77), release `release-<sha>` created, `game.zip` uploaded (lines 79-101).
- Steps for `game_futaba_mod.zip`, `kanto_version.zip` and `game_beta.zip` (lines 109-207) have **no `if:` guard**,
  which is why those three assets are re-uploaded on *every* run (hence today's timestamps on a 20-day-old
  release) while `game.zip` is untouched. This is expected behaviour, not a failure.

Workflow-run history (API, last 20): runs #17641-#17660, 2026-09-09 -> 2026-09-12, **all `conclusion: success`**,
all on fork head `c16a3bb`. Total runs: 7,278. The automation is alive and healthy.

**Note that `currentVersion.txt` is also written by the build workflow into the zip** (`update.yml:76`), so the
file exists inside `game.zip` before the app ever writes it. See section 2.

### Implication for us

Depending on `releases/latest` of a single-release repo means: when a new upstream hotfix lands, the *only*
`game.zip` in existence is replaced within hours, and the old one is deleted. We cannot pin to a known-good build
by URL. If we want reproducibility we must **mirror the `game.zip` we shipped** (or build it ourselves from an
upstream tag with `pnpm build:app`, which is a handful of CI lines - see section 4).

---

## 2. `currentVersion.txt` and `--clear-cache`

### `currentVersion.txt`

| What | Where |
|---|---|
| Path computed | `src/main.js:144` - `globals.currentVersionPath = path.join(globals.gameDir, 'currentVersion.txt')` |
| Written after a successful download/extract | `src/file_tab.js:157` - `fs.writeFile(globals.currentVersionPath, releaseData.tag_name, 'utf8', ...)` |
| Read back | `src/utils.js:92-102` - `fetchCurrentGameVersionInfo()` |
| Displayed | `src/about_tab.js` "About the app..." dialog |

Content is the **release tag**, e.g. `release-e4e9b53`. (The workflow's own in-zip `currentVersion.txt` contains
the bare short SHA `e4e9b53` instead - the app overwrites it with the tag after extraction, so the two formats
differ depending on whether the app has ever run the downloader itself.)

`gameDir` itself (`src/main.js:136-142`):

```js
if (process.platform === 'darwin') globals.gameDir = path.join(app.getPath('userData'), 'game');
else                               globals.gameDir = path.join(__dirname, '../..', 'game');
```

On Windows, packaged, `__dirname` is `<install>\resources\app.asar\src`, so
**`gameDir = <install dir>\resources\game`** - i.e. *inside the installation directory*, not in `%APPDATA%`.
(Verified by resolving the path: `C:\Program Files\PokeRogue\resources\app.asar\src` + `../..` + `game`
-> `C:\Program Files\PokeRogue\resources\game`.)

Consequences for our installer:

- 507 MB of game files land next to `PokeRogue.exe`; installing under `C:\Program Files` makes the in-app
  "Download files for offline" fail or need elevation (the upstream README warns about exactly this).
- The default NSIS config is `perMachine: false` + `allowToChangeInstallationDirectory: true`
  (`package.json:60-66`), so the default target is a per-user, writable location. Good default; we should turn
  off `allowToChangeInstallationDirectory` for a non-technical user so the user cannot pick `Program Files`.
- An app *update* that replaces the install directory can wipe `resources\game`, forcing a 507 MB re-download.

### `--clear-cache`

Entry point (`src/file_tab.js:66-96`): menu **File -> "Reload + clear cache"**, accelerator `Ctrl+F5`. It calls
`app.relaunch({ args: process.argv.slice(1).concat(['--clear-cache']) })` then `app.quit()`.

Handler (`src/main.js:146-172`), running inside `app.whenReady()`:

```js
if (process.argv.includes('--clear-cache')) {
  const userDataPath        = app.getPath('userData');                  // %APPDATA%\PokeRogue
  const settingsFilePath    = path.join(userDataPath, 'settings.json');
  const localStorageDirPath = path.join(userDataPath, 'Local Storage');
  const offlineGameDirPath  = path.join(userDataPath, 'game');          // macOS only
  const files = fs.readdirSync(userDataPath);
  files.forEach(file => {
    const filePath = path.join(userDataPath, file);
    if (filePath !== settingsFilePath && filePath !== localStorageDirPath && filePath !== offlineGameDirPath) {
      if (fs.lstatSync(filePath).isDirectory()) fs.rmdirSync(filePath, { recursive: true });
      else fs.unlinkSync(filePath);
    }
  });
}
```

**Exactly what it deletes:** every entry directly under `%APPDATA%\PokeRogue` **except** the three names
`settings.json`, `Local Storage`, `game`. In a normal Electron 29 profile that means it deletes, among others:

- `Cookies`, `Cookies-journal` -> **logs the user out of the online pokerogue.net account** (`pokerogue_sessionId`)
- `Session Storage\`, `IndexedDB\`, `Service Worker\`, `Cache\`, `Code Cache\`, `GPUCache\`, `blob_storage\`
- `Local State`, `Preferences`, `Network\`, `Network Persistent State`, `TransportSecurity`
- `Partitions\` (if any named partitions ever existed)

**Can it delete localStorage / save data? No.** `Local Storage\` (the LevelDB holding `data_Guest`,
`sessionData*_Guest`, and `data_<username>` for the online origin) is explicitly excluded, and `settings.json`
is preserved. Caveats worth knowing for our design:

- It is a **non-recursive name filter on the top level only**. Anything nested is fair game.
- It is **not** what the README tells users to do - the README says "delete the whole `%AppData%/Pokerogue`",
  which *does* destroy offline saves. Expect users (and support threads) to recommend exactly that.
- The `clearCache()` helper also calls `app.commandLine.appendSwitch('clear-cache')` (`file_tab.js:87`), which is
  a *Chromium* switch - separate from the `process.argv` check above and effectively a no-op for this logic.
- `fs.rmdirSync(..., {recursive:true})` is deprecated in Node 20 (Electron 29) and emits a warning; it still works.

---

## 3. Wrapper architecture

### Process / window model

- Single main process, `src/main.js` (`package.json:5` -> `"main": "src/main.js"`). No renderer code of its own
  beyond injected CSS/JS snippets.
- **Game window** (`src/main.js:19-26`):
  ```js
  globals.mainWindow = new BrowserWindow({
    width: 1280, height: 749, autoHideMenuBar: true, menuBarVisible: false, icon: 'icons/PR', show: false
  });
  ```
  **No `webPreferences` at all.** Therefore Electron 29 defaults apply:
  `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`,
  `preload: undefined`, default (persistent, unnamed) session - **no `partition` is set anywhere in the repo.**
- **Utility windows** (wiki, RogueDex, type charts, team builder, Smogon, SearchDex) go through
  `utils.createWindow()` (`src/utils.js:15-33`), which *does* set
  `preload: src/utils_preload.js`, `nodeIntegration: false`, `contextIsolation: true`.
  `src/utils_preload.js:1-6` exposes only `window.ipcRenderer.send(channel, data)`. The single `ipcMain` listener
  in the app is `about_tab::buttonClick::appUpdate` (`src/about_tab.js:162`).
- Those utility windows also install `@cliqz/adblocker-electron` (`src/utilities_tab.js:202`, `:288`, `:429`,
  `:517`, `:605`), which **fetches filter lists from the network when opened** - the only unsolicited outbound
  traffic in the wrapper besides the two GitHub API calls (`src/globals.js:21-22`).

**Hook points available to us:** none on the game window today. Adding one is trivial and non-invasive -
setting `webPreferences.preload` on the main `BrowserWindow` keeps `contextIsolation: true` and gives us a place
to read and write `localStorage` on both origins. Note `webContents.executeJavaScript` already works without any
preload and is already used by the app (`src/main.js:122-129`, which removes the `tnc-links` element after load).

### Online vs offline

```js
// src/main.js:95-103 (and identically src/utils.js:219-228 for soft reset)
if (globals.isOfflineMode)      globals.mainWindow.loadFile(path.join(globals.gameDir, 'index.html'));
else if (globals.isBeta)        globals.mainWindow.loadURL('https://beta.pokerogue.net/');
else                            globals.mainWindow.loadURL('https://pokerogue.net/');
```

- Offline is **`loadFile` -> the `file://` origin.**
- The beta branch is dead code - the menu entry is commented out (`src/settings_tab.js:6-15`).

### Toggle and persistence

- Menu **Settings -> "Offline mode (uses separate save, requires game files)"** -
  `src/settings_tab.js:16-26`. A checkbox, `enabled: globals.gameFilesDownloaded`, which flips
  `globals.isOfflineMode`, calls `utils.saveSettings()` then `utils.resetGame()`.
- Persisted in `<userData>\settings.json` as `isOfflineMode` (`src/utils.js:150`), reloaded at
  `src/utils.js:171`:
  ```js
  globals.isOfflineMode = globals.gameFilesDownloaded ? settings.isOfflineMode : false;
  ```
  `gameFilesDownloaded` is just `fs.existsSync(gameDir)` (`src/main.js:143`) - a *directory existence* check,
  with no validation that `index.html` is actually inside it.
- `settings.json` is written on window `close` (`src/main.js:35-37`) and on every toggle, so a hard kill loses
  window-geometry changes but not the offline flag.

**There is no automatic online/offline detection anywhere.** The mode is a sticky manual checkbox - the core
gap our project has to close.

### Where userData / localStorage lives

- `app.getName()` comes from `package.json:2` `"name": "PokeRogue"`, so
  **`app.getPath('userData')` = `%APPDATA%\PokeRogue`** (= `C:\Users\<user>\AppData\Roaming\PokeRogue`).
- **No `session.fromPartition(...)` and no `partition:` in any `webPreferences`** -> the default persistent
  session. Both origins therefore share one profile directory:
  - `%APPDATA%\PokeRogue\Local Storage\leveldb\` - contains **both** origins' localStorage:
    - `file://` origin -> the offline save: `data_Guest`, `sessionData*_Guest`, settings, `prLang`
    - `https://pokerogue.net` origin -> the online save: `data_<username>`, `sessionData*_<username>`
  - `%APPDATA%\PokeRogue\Cookies` - `pokerogue_sessionId` for the online origin
  - `%APPDATA%\PokeRogue\settings.json` - wrapper settings (written by the wrapper, not by Chromium)
  - `%APPDATA%\PokeRogue\game\` - offline game files **on macOS only**
- Game files on Windows: `<install dir>\resources\game\` (see section 2).

That both saves live in one LevelDB under one profile is the most useful fact here for the sync design: the main
process can drive both origins by loading each in a (hidden) `BrowserWindow` and calling
`webContents.executeJavaScript` against `localStorage`, with no cross-origin trickery needed.

### Versions

| | |
|---|---|
| Electron | **29.3.3** (`package.json:19` `"electron": "^29.3.3"`; installed tree = 29.3.3; build log `electron=29.3.3`) |
| Chromium / Node inside | Electron 29 -> Chromium 122, Node 20.9 |
| App version | `2.4.6f` (`package.json:3`); latest published wrapper release `v2.4.6f`, 2026-09-07 |
| Packager | `electron-builder` 24.13.3 (`package.json:20`) |

---

## 4. How the offline game is served, and what the fork changes

### Serving

**`file://` only.** `BrowserWindow.loadFile(path.join(gameDir, 'index.html'))` (`src/main.js:96`,
`src/utils.js:221`). There is no `http.createServer`, no `protocol.registerFileProtocol` / `protocol.handle`,
no custom scheme registration anywhere in the repo.

Consequences:

- The origin is the `file://` origin. **If we ever move the offline game behind `http://localhost:PORT` or a
  custom scheme, every existing offline save becomes invisible** (different localStorage origin). Any such change
  must be paired with a migration that reads the `file://` store first.
- Upstream's `index.html` registers `./service-worker.js` in an inline `<head>` script. Service workers are **not**
  available on `file://`; registration fails with a console error and is otherwise harmless (a
  `ServiceWorker registration failed` line is expected in offline mode, not a symptom of anything).
- Upstream loads i18n JSON through `i18next-http-backend` with a relative `./locales/<lng>/<file>.json`
  (`src/i18n.ts:159-181`) and Phaser loads assets by XHR. These resolve as `file://` sub-resource requests.
  They work in this packaged app in practice (7,269 downloads of this exact zip), but this is the most fragile
  part of the offline path and the first thing to smoke-test after any change to `webSecurity`, `sandbox`, or
  the scheme. We have not empirically verified it here (no GUI was launched).

### Does the `VITE_BYPASS_LOGIN` build make network calls?

Checked against the exact commit that produced `game.zip` (`pagefaultgames/pokerogue@e4e9b53`).

The flag:

```ts
// src/constants/app-constants.ts:21
export const bypassLogin = import.meta.env.VITE_BYPASS_LOGIN === "1";
// :16  export const isApp = import.meta.env.MODE === "app";
// :6   export const isDev = import.meta.env.MODE === "development";
```

`pnpm build:app` -> `vite build --mode app` -> `.env.app`:

```
VITE_BYPASS_LOGIN=1
VITE_SERVER_URL=http://localhost:8001
```

So in the shipped offline build: `bypassLogin === true`, `isDev === false`, and
`pokerogueApi = new PokerogueApi("http://localhost:8001")` (`src/api/api.ts`, last line) -
**the production API base `https://api.pokerogue.net` is never even compiled in.**

Every call site is gated:

| Call site | Guard |
|---|---|
| `src/account.ts:13` `account.getInfo()` | `if (!bypassLogin)` -> skipped |
| `src/phases/login-phase.ts:37` | `executeIf(bypassLogin \|\| hasSession, updateUserInfo)` -> local Guest path only |
| `src/system/game-data.ts:323, 348` (system save upload/download) | `if (bypassLogin) ...` -> localStorage only |
| `src/system/game-data.ts:1373` (`saveAll`) | `if (bypassLogin \|\| !sync) return` |
| `src/system/game-data.ts:597, 613, 920, 964, 1142, 1205, 1403` (sessions, run history, clear, import/export) | all `bypassLogin`-gated |
| `src/phases/title-phase.ts:330` (daily run seed) | `if (!bypassLogin \|\| isLocalServerConnected)` -> else seed = `btoa(ISO date)` generated locally |
| `src/phases/game-over-phase.ts:268` (score submit) | `if (!bypassLogin \|\| isLocalServerConnected)` |
| `src/utils/common.ts:290` | `isLocalServerConnected = !bypassLogin` -> `false`; `localPing()` only runs `if (isDev)` -> never |
| `src/ui/handlers/{login,registration,change-password,admin,menu}-ui-handler.ts` | unreachable UI: `menu-ui-handler.ts:79,132` remove `LOG_OUT` when `bypassLogin` |

A grep for literal remote `fetch(` calls in `src/` returns nothing; the only `https://` strings in `src/` are
Bulbapedia/Smogon/MDN references in comments and doc links, plus `pokerogue.net` in `index.html` meta tags
(inert `og:`/`twitter:` properties).

**Conclusion: the offline build is genuinely network-silent.** And if something ever slipped through, it would
hit `http://localhost:8001` and fail instantly rather than touching the live API - a useful safety property:
**an offline build can never accidentally write to the real account.**

### What the fork actually changes

`GET /repos/pagefaultgames/pokerogue/compare/main...Admiral-Billy:pokerogue:main`:
`status: diverged`, `ahead_by: 93`, `behind_by: 2779`, **`files: 3`**.

| File | Change |
|---|---|
| `.github/workflows/update.yml` | **added, 216 lines** - the entire mechanism (see section 1) |
| `package-lock.json` | micromatch 4.0.7 -> 4.0.8 (a dependency bump; the project uses pnpm now anyway) |
| `src/battle-scene.ts` | 1 line: `-export const bypassLogin = import.meta.env.VITE_BYPASS_LOGIN === "1";` -> `+export const bypassLogin = true;` |

The 93 commits ahead are almost entirely "Update update.yml" (May 2024 -> Dec 2025). The last substantive ones:
`98709b3b` "Bypass and configuration changes for offline builds" (2024-09-10), `a41dbeab` "Simplify version
tracking" (2024-09-28), `405b80dc` "Change to pnpm?" (2025-09-13), `c16a3bbf` "Slower scheduled updates" (2025-12-20).

**The `src/battle-scene.ts` edit is dead code.** `battle-scene.ts` no longer even defines `bypassLogin` upstream
(it moved to `src/constants/app-constants.ts`), and more importantly the workflow checks out upstream's tree, so
the fork's `src/` is never compiled. The offline behaviour comes **entirely from upstream's own first-class "app"
build mode** (`build:app` + `.env.app`), which upstream maintains for precisely this purpose.

The fork's local `.env`, `.env.production`, `vite.config.ts` and `package.json` (which has no `build:app` script
at all!) are the Dec-2025 snapshot of upstream and are irrelevant to the shipped artifact. Do not read them as
configuration for the offline build.

**This is good news for us:** reproducing `game.zip` ourselves is
`git clone --recursive pagefaultgames/pokerogue && git checkout <tag> && pnpm i && pnpm build:app && zip -r game.zip dist/*`.
No fork required, no patches to maintain, and we can pin to an upstream tag.

---

## 5. Build feasibility on this machine

Working copy: `C:\dev\pokerogue-offline\scratch\Pokerogue-App-build` (copy of `upstream\Pokerogue-App`, `.git`
removed; nothing in `upstream/` was modified). Node 24.19.0, npm 11.17.0.

### `npm install` - **succeeded**

```
added 390 packages in 38s
EXIT=0
```

Warnings only. Two packages have unrun install scripts under npm 11's `allow-scripts` gate:
`electron@29.3.3 (postinstall: node install.js)` and `lefthook@1.6.14`. **Electron's postinstall is the one that
downloads the Electron binary**, and it was not blocked here (`node_modules/electron/dist` was present and
electron-builder found 29.3.3), but on a clean machine with a stricter npm config this is the first thing to
check - `npm approve-scripts electron`, or `npm ci --foreground-scripts` in CI.

### Build scripts

`package.json:6-13` - **`electron-builder` 24.13.3** (not electron-forge):

```
"build":       "electron-builder"
"build:win":   "electron-builder --win"
"build:linux": "electron-builder --linux"
"build:mac":   "electron-builder --mac --universal"
```

`package.json:33-79` `build` block: `appId: com.example.pokerogue`, `productName: PokeRogue`, output `dist/`,
`extraResources: [keymap.json]`, **`win.target: "nsis"`** with
`nsis: { oneClick:false, perMachine:false, createDesktopShortcut:true, createStartMenuShortcut:true, allowToChangeInstallationDirectory:true }`.
Linux -> AppImage, mac -> dmg. `publish: ["github"]`.

The repo's own CI (`Pokerogue-App/.github/workflows/build.yml`) does not use the NSIS output as its main artifact -
it zips `dist/win-unpacked` into `PokeRogue-Windows.zip` and publishes a draft release (lines 27-49, 92-101).
The published `PokeRogue.Setup.2.4.6-f.exe` (75.1 MB) comes from electron-builder's own GitHub publish step.

### Unpacked build: `npx electron-builder --win --dir` - **artifact produced, process exited 1**

Elapsed: ~90 s. Result:

```
dist/win-unpacked/            266 MB
  PokeRogue.exe
  resources/app.asar          14.7 MB
  resources/keymap.json
  (+ standard Electron 29 runtime: icudtl.dat, *.pak, ffmpeg.dll, vk_swiftshader.dll, locales/, ...)
dist/builder-debug.yml
```

The packaging step itself logged `packaging platform=win32 arch=x64 electron=29.3.3 appOutDir=dist\win-unpacked`
and completed. The failure comes **after** packaging, in the code-signing tooling bootstrap, and it repeated three
times (2 retries) before aborting:

```
- downloading url=https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z size=5.6 MB
X cannot execute  cause=exit status 2
  errorOut=ERROR: Cannot create symbolic link : Dem Client fehlt ein erforderliches Recht. :
    C:\Users\geber\AppData\Local\electron-builder\Cache\winCodeSign\<id>\darwin\10.12\lib\libcrypto.dylib
  ERROR: Cannot create symbolic link : ... libssl.dylib
  command='...\node_modules\7zip-bin\win\x64\7za.exe' x -bd '...\winCodeSign\<id>.7z' '-o...\winCodeSign\<id>'
EXIT=1
```

**Diagnosis:** the well-known electron-builder issue where extracting `winCodeSign-2.6.0.7z` needs
`SeCreateSymbolicLinkPrivilege` to create two macOS `.dylib` symlinks that are never used on Windows. The German
message means "the client is missing a required privilege". It is **not** a problem with the app, the source,
Node 24, or the dependency tree.

**Verdict: buildable.** Full log at `C:\dev\pokerogue-offline\scratch\build-unpacked.log`.

Fixes, cheapest first:

1. Enable **Windows Developer Mode** (Settings -> System -> For developers) - grants the symlink privilege to the
   current user, no elevation needed afterwards. The cache then extracts once and both `--dir` and the NSIS
   installer build cleanly.
2. Run the build once from an **elevated** shell to populate `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`,
   then build unelevated forever after.
3. Build in CI - the upstream `build.yml` on `windows-latest` does exactly this and works; GitHub runners have
   the privilege.

Not attempted: the full NSIS installer (`--win nsis`). It hits the *same* `winCodeSign` step, so expect the
identical failure until (1) or (2) is done. The unsigned-installer SmartScreen warning noted in the brief applies
independently of this.

No GUI was launched.

---

## 6. License check

| Component | License | Source |
|---|---|---|
| `Admiral-Billy/Pokerogue-App` (the wrapper) | **MIT**, (c) 2024 William Burleson | `upstream/Pokerogue-App/LICENSE`; GitHub API `license.spdx_id: MIT` |
| ...but its `package.json` says | `"license": "ISC"` (`package.json:16`) | inconsistent metadata; the `LICENSE` file governs |
| `pagefaultgames/pokerogue` (the game) | **AGPL-3.0-only** | `LICENSE` (GNU AGPL v3 text), `README.md:35`, `REUSE.toml`, API `license.spdx_id: AGPL-3.0` |
| `Admiral-Billy/pokerogue` (the fork) | AGPL-3.0 (inherited) | API `license.spdx_id: AGPL-3.0`, `fork: true` |
| Game documentation / doc comments | CC-BY-NC-SA-4.0 | `README.md:36` |
| Game **assets** (`pokerogue-assets` submodule - the bulk of the 507 MB) | CC-BY-NC-SA-4.0 *where licensable*, and explicitly: **"Files in `assets/` that are not explicitly licensed via `REUSE.toml` files should be considered to have _no_ licensing / copyright information"** | `README.md:38-40` |

### What this means for shipping `game.zip` inside our own installer

1. **The wrapper (MIT) is trivially fine.** Keep the copyright line and the MIT text in our distribution. Our
   modifications can be under any license; attribution is the only obligation.

2. **The game is AGPL-3.0-only, and `game.zip` is a binary distribution of it.** Redistributing it obliges us to:
   - offer the **corresponding source** for that exact build (AGPL section 6) - in practice: state the upstream
     commit (`e4e9b53`), the build command (`pnpm build:app`), and link `pagefaultgames/pokerogue` at that commit
     plus the two asset/locale submodule commits;
   - include the AGPL-3.0 license text and the copyright notices (the upstream repo is REUSE-compliant, so its
     `LICENSES/` directory and `REUSE.toml` carry this - ship them alongside);
   - not impose additional restrictions.
   - AGPL section 13 (the network clause) concerns *users interacting with the program over a network*. Our app
     runs locally with no remote users, so it adds nothing beyond section 6 here. It would bite if we ever hosted
     the offline build.

3. **AGPL copyleft reaches our wrapper only if we create a combined work.** The current design - a separately
   licensed MIT Electron shell that loads an unmodified AGPL web app in a `BrowserWindow` - is the same
   "separate program / mere aggregation" posture that upstream itself effectively blesses by maintaining a
   `build:app` mode. **But our project specifically plans to inject code into the game's page** (preload or
   `executeJavaScript` reading and rewriting `localStorage`). Injected scripts that run inside the game and
   manipulate its save state are much more plausibly part of a combined work. **Safest course: license our
   injected/sync code AGPL-3.0 (or at minimum publish it), keep the shell MIT, and publish the whole thing.**
   That costs us nothing for a personal tool and removes the question entirely.

4. **The assets are the real problem, not the code.** `README.md:40` is an explicit disclaimer that unlisted files
   in `assets/` have *no* licensing information - these are Pokemon sprites, cries and music. Redistributing them
   is third-party IP risk that no license in this repo cures. Upstream mitigates by never shipping a binary;
   `Admiral-Billy` ships `game.zip` anyway.
   - **Recommendation: do not bundle `game.zip` inside our installer.** Have the installer/app download it at
     first run - which is exactly what the wrapper already does (`src/file_tab.js:101-182`) - or from our own
     mirror if pinning matters. This keeps our installer at ~75 MB instead of ~580 MB, keeps us out of the
     redistribution question for the assets, and matches what every existing user of this app already does. The
     cost is a first-run download that requires connectivity, which is fine: the user is online when the user installs.
   - The NC in CC-BY-NC-SA also means any distribution must be non-commercial. Not an issue for us.

5. **Trademark / fan-game reality check:** "PokeRogue", "Pokemon" and the sprites are third-party marks. A private
   build for one friend is not something anyone will notice; a public installer with Pokemon art inside it is a
   different exposure. Another argument for download-at-first-run over bundling.

---

## Appendix: corrections to the brief's facts table

| Row | Status |
|---|---|
| "The offline game files come from `Admiral-Billy/pokerogue` releases (`game.zip`, ~500 MB), rebuilt automatically from upstream; release dates track upstream releases" | **Correct in substance.** Refine to: there is *one rolling release* named after the upstream short SHA; `game.zip` is rebuilt within hours of any commit to upstream `main`; older releases and their tags are deleted, so there is no version history to pin to. Currently exactly in sync with upstream `main` HEAD `e4e9b53` = `v1.12.0.11`. |
| "The wrapper records the installed offline version in `currentVersion.txt`, and has a `--clear-cache` path that deletes things under `%APPDATA%\PokeRogue`" | **Correct.** Add: `currentVersion.txt` lives in `<install dir>\resources\game\` on Windows (**not** in `%APPDATA%`); `--clear-cache` preserves `Local Storage` and `settings.json` but **does delete `Cookies`**, i.e. it silently logs the user out of the online account. |
| "The offline build runs with `VITE_BYPASS_LOGIN=1`, so the user is `Guest` and the save key is `data_Guest`" | **Confirmed** at `e4e9b53`, via upstream's own `--mode app` build and `.env.app`, not via any fork patch. `src/constants/app-constants.ts:21`, `src/account.ts:22-33`. |
| "In that mode saves are stored as `btoa(encodeURIComponent(json))`, not encrypted" | **Confirmed**, now at `src/utils/data.ts:47-58` (moved out of `src/system/game-data.ts`). |
| "`CryptoJS.AES.encrypt(json, "x0i2O7WRiANTqPmZ")`; the key is public in the source" | **Confirmed** at `src/constants.ts:56` (`saveKey`). Cookie name `pokerogue_sessionId` at `src/constants.ts:10`. |
| "API base is `https://api.pokerogue.net`" | **Confirmed for the online build** (`.env.production`). In the **offline** build the compiled base is `http://localhost:8001` - a useful safety net that makes accidental writes to the live account impossible from offline mode. |
| "Starting point ... requires manually toggling offline mode and keeps a save that is entirely separate from the online account" | **Confirmed.** The separation is an *origin* separation (`file://` vs `https://pokerogue.net`) inside one shared Electron profile at `%APPDATA%\PokeRogue\Local Storage\leveldb`. |
