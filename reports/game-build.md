# Report — game build (Milestone: `game-build/`)

Built 2026-09-12 on Windows 11 (Node 24.19.0, pnpm 10.34.5 launcher → 10.33.2 pinned by the repo's
`packageManager` field, git 2.x).

**Result: `C:\dev\pokerogue-offline\game-build\dist\game\` — `index.html` at its root, 34 094 files,
668.4 MB. All verification checks pass.**

---

## 1. What was built

| | |
|---|---|
| Upstream | `pagefaultgames/pokerogue` |
| Tag | `v1.12.0.11` (existed; no fallback needed) |
| Commit | `e4e9b5383be7c9e171d32a9daaea2658d475c521` |
| `package.json` version | `1.12.0.11` |
| Submodule `assets` | `909b43612324622608023b3beb2f24f4ef159c1d` |
| Submodule `locales` | `e46279a0a511e5b6f552dfcab522644822b2908a` |
| Build command | `pnpm vite build --mode offline` |
| Vite | 8.0.16 (rolldown) |

`e4e9b53` is the same commit the Admiral-Billy fork's `game.zip` was built from — so this is the
same upstream tree, differently configured.

### Build configuration

`game-build/work/pokerogue/.env.offline` (untracked, created by the build script — **no tracked
upstream file was modified, and nothing under `upstream/` was touched**):

```
VITE_BYPASS_LOGIN=0
VITE_BYPASS_TUTORIAL=0
VITE_SERVER_URL=http://127.0.0.1:47830/api
VITE_DISCORD_CLIENT_ID=1248062921129459756
VITE_GOOGLE_CLIENT_ID=955345393540-2k6lfftf0fdnb0krqmpthjnqavfvvf73.apps.googleusercontent.com
VITE_I18N_DEBUG=0
```

Compared with upstream's own env files, **the only value that differs from `.env.production` is
`VITE_SERVER_URL`**. The Discord/Google client IDs are copied verbatim from `.env.production`.
`.env.app` differs more (it is the offline/no-login build: `VITE_BYPASS_LOGIN=1`,
`VITE_SERVER_URL=http://localhost:8001`, dummy OAuth IDs, plus `VITE_PORT=8000` which only affects
the dev server). Upstream also ships `.env` (the fallback, always loaded first — `--mode offline`
layers `.env.offline` on top of it), `.env.beta` and `.env.test`; none of them matter here.

No other `VITE_*` variable is read by `src/`. Complete list of consumers found:
`VITE_SERVER_URL` (`src/api/api.ts:76` → `new PokerogueApi(...)`;
`src/ui/handlers/login-form-ui-handler.ts:20` beta-banner check;
`src/ui/handlers/menu-ui-handler.ts:629,649` and `oauth-providers-ui-handler.ts:88` OAuth redirect
URIs), `VITE_BYPASS_LOGIN` (`src/constants/app-constants.ts:21`), `VITE_BYPASS_TUTORIAL`,
`VITE_I18N_DEBUG`, `VITE_PORT` (dev server only).

### The typed `HTTP_URL` check is not a problem

`src/vite.env.d.ts:4` declares ``type HTTP_URL = `http${"" | "s"}://${string}` `` and
`VITE_SERVER_URL?: HTTP_URL`. `http://127.0.0.1:47830/api` satisfies it (`${string}` covers the
path), so **no workaround was needed**. It is a `tsc` type anyway; `vite build` does not typecheck.

---

## 2. Timings and disk

| Step | Wall time |
|---|---|
| `git clone --depth 1 --recurse-submodules --shallow-submodules` | ~100 s (~1.1 GB working tree) |
| `pnpm install --frozen-lockfile` (cold store) | 70.5 s |
| `pnpm install --frozen-lockfile` (warm) | 1.0 s |
| `vite build --mode offline` | 30–37 s (Vite reports "built in 30.3 s") |
| copy `dist/` → `dist\game\` | 32–37 s |
| zip (`CompressionLevel::Fastest`) | 151 s |
| **full cold run** | **~7 min** |

Peak disk: clone + `node_modules` + `dist` ≈ **2.1 GB** in `game-build\work\`, plus 668 MB in
`dist\game\` and 511 MB for the zip. The `vite build` step alone consumed 740 MB (measured as free-space
delta on C:).

---

## 3. Verification results

### (a) API base

| Check | Result |
|---|---|
| `http://127.0.0.1:47830/api` in JS bundle | **present**, 2 occurrences |
| `api.pokerogue.net` anywhere in `dist` | **absent** (0 occurrences, including `.map` files) |

Compiled call sites:

```js
// dist/assets/FadeOut-*.js
w = new PokerogueApi(`http://127.0.0.1:47830/api`)
// dist/assets/battle-scene-*.js
getRedirectUri = e => encodeURIComponent(`http://127.0.0.1:47830/api/auth/${e}/callback`)
```

Remaining `pokerogue.net` strings (none is an API call):

| Where | What | Matters? |
|---|---|---|
| `dist/assets/battle-scene-*.js` | `https://wiki.pokerogue.net/start` and `https://wiki.pokerogue.net/<lang>:start` — the **Wiki** entry in the in-game menu | Opens the external wiki in a new tab. The wrapper should decide whether to let it open in the system browser or suppress it. |
| `dist/index.html` lines 21–31 | `og:image`, `og:url`, `twitter:image`, `twitter:url`, `canonical` → `https://pokerogue.net` | Inert meta tags. No request is made. |
| `dist/locales/*/splash-texts.json` (13 languages) | the word `pokerogue.net` inside a splash message | Text only. |
| `dist/assets/*.js` (cookie deletion) | `removeCookie` writes `Domain=pokerogue.net` **only when `isBeta`** — folded away in this build | Not present. |

`apibeta.pokerogue.net` is absent (the beta-banner comparison folded away).

### (b) `bypassLogin` compiled to `false`

The identifier does not survive: `bypassLogin` is `import.meta.env.VITE_BYPASS_LOGIN === "1"`, which
Vite substitutes to `"0" === "1"`, Rolldown folds to `false`, and inlines everywhere. `grep bypassLogin`
on the bundle returns **0 hits**, so the constant has to be verified by its effects:

1. **`encrypt`/`decrypt` inlining.** `src/utils/data.ts` is
   `encrypt(data, bypassLogin) { return bypassLogin ? btoa(encodeURIComponent(data)) : AES.encrypt(...) }`.
   In the bundle, the save/export call sites are compiled to the **AES branch**:
   `` .encrypt(v,Ve), x = new Blob([y.toString()], {type:`text/json`}) `` and
   `.decrypt(t,Ve).toString(Nh.enc.Utf8)`. With `bypassLogin === true` these would have folded to
   `btoa(encodeURIComponent(...))` / `decodeURIComponent(atob(...))` instead. **This is the decisive
   proof.** (It also confirms saves are AES/`.prsv`-encrypted with `PRSV_KEY`, as `DESIGN.md` §3.1 assumes.)
2. **Server endpoints survive tree-shaking**: `/account/login`, `/account/register`, `/account/logout`,
   `/account/info`, `/savedata/system/get`, `/savedata/system/update`, `/savedata/session/get`,
   `/savedata/updateall`, `/game/titlestats` — each present exactly once.
3. `VITE_BYPASS_LOGIN` / `import.meta.env` do not appear as literals in the bundle (fully substituted).

The build script and the CI workflow both assert 1–3 and abort on failure.

### (c) Size and file count

`C:\dev\pokerogue-offline\game-build\dist\game\` — **34 094 files, 700 819 197 bytes (668.4 MB)**.
Zipped: `game-v1.12.0.11.zip`, 511.1 MB,
sha256 `06b9730572d4e6f2437a22215516e78322bb6f0d0b34b6e53085d05fdef2d3a7`.

| Top-level | Size |
|---|---|
| `audio/` | 435.9 MB |
| `images/` | 157.8 MB |
| `assets/` (the JS/CSS bundle + sourcemaps) | 34.2 MB |
| `battle-anims/` | 23.9 MB |
| `locales/` | 9.6 MB |
| `fonts/` | 6.9 MB |
| root files (`index.html`, `manifest.webmanifest`, `service-worker.js`, `logo128/512.png`, `exp-sprites.json`, `starter-colors.json`, `biome-bgm-loop-points.json`) | ~62 KB |

By type: `.mp3` 378.2 MB (178), `.json` 126.3 MB (14 290), `.png` 60.3 MB (17 018),
`.wav` 40.6 MB (1 217), `.map` 28.3 MB (9), `.m4a` 17.1 MB (1 335), `.ttf` 6.9 MB (5),
`.js` 5.9 MB (12), `.mp4` 4.7 MB (2).

JS chunks (all in `dist/assets/`): `loading-scene-b60MiSsA.js` 2.75 MB,
`preload-helper-DDCZiAQS.js` 1.30 MB, `index-C1nXnNNX.js` 1.04 MB, `battle-scene-DLyYQQ0v.js` 0.99 MB,
`FadeOut-BvKLoIDR.js` 92 KB, plus 5 small ones and `index-CgDu45Pt.css` 6.6 KB.

Build output is **deterministic**: three independent runs produced byte-identical chunk hashes.

### (d) Asset paths in `index.html`

**Relative (`./`), not root-absolute.** `vite.config.ts` sets `base: ""`.

```html
<script type="module" crossorigin src="./assets/index-C1nXnNNX.js"></script>
<link rel="modulepreload" crossorigin href="./assets/chunk-Bv0JxpqV.js">   (×4)
<link rel="stylesheet" crossorigin href="./assets/index-CgDu45Pt.css">
<link rel="manifest" href="./manifest.webmanifest">
<link rel="shortcut icon" href="./logo512.png">
@font-face src: url('./fonts/pokemon-emerald-pro.ttf'), url('./fonts/pkmnems.ttf')
```

i18n also loads relative: `./locales/<lng>/<namespace>.json` (`src/i18n.ts:181`). Phaser asset loads
are relative too.

Because the wrapper serves the game at `/`, relative and root-absolute resolve identically — **but
only as long as the document URL stays exactly `http://127.0.0.1:47830/`**. If the wrapper ever
serves the game under a sub-path, or SPA-falls-back a deep URL like `/foo/bar` to `index.html`,
every `./assets/...` resolves against `/foo/` and the game breaks. **Recommendation: serve
`index.html` only for `/` and `/index.html`, and return a real 404 for anything else** rather than
the SPA fallback in `DESIGN.md` §3.4. The game is a single page and never pushes history state, so
an SPA fallback buys nothing and can silently mask missing assets.

### Serving smoke test (step 5)

A throwaway Node-built-ins-only static server (`game-build/work/serve-check.mjs`) bound to
127.0.0.1:47830 over `dist\game\`, then stopped. No request to `api.pokerogue.net`, no login attempt.

| Request | Status | Bytes |
|---|---|---|
| `GET /` | 200 | 7 145 |
| `GET /assets/index-C1nXnNNX.js` | 200 | 1 036 787 |
| `GET /manifest.webmanifest` | 200 | 572 |
| `GET /service-worker.js` | 200 | 335 |
| `GET /locales/en/common.json` | 200 | 382 |
| `GET /locales/de/common.json` | 200 | 428 |
| `GET /locales/en/common.json?t=123` | 200 | 382 |
| `GET /manifest.json` | 404 | — (expected, see §4) |

---

## 4. What the wrapper must know

### 4.1 `GET /manifest.json` — a root-absolute fetch that will 404

`src/init/init-manifest.ts` runs at startup, **before i18n**:

```js
try { const manifest = await fetch("/manifest.json").then(r => r.json()); initializeManifest(manifest["manifest"]); }
catch (err) { console.log("Manifest not found:", err); }
```

This file is **not** in `dist` — upstream's deploy generates it server-side (`prmanifest`) and uses it
for cache-busting query strings (`?t=<timestamp>`) on locale and asset URLs. It is wrapped in
try/catch, so a 404 is harmless: one `Manifest not found:` console line, and `getCachedUrl()` returns
URLs unchanged. **Serve a plain 404 for `/manifest.json`.** Do not SPA-fallback it to `index.html` and
do not confuse it with `/manifest.webmanifest`, which *is* present and is a different file.

Corollary: the wrapper's static handler **must ignore query strings** — `getCachedUrl` can append
`?t=...` to locale/asset URLs if a manifest is ever supplied. The smoke test above confirms a
query-string request works with a `pathname`-based handler.

### 4.2 Required request headers on `/api/*`

`src/api/api-base.ts:83-90` sets on **every** API request:

- `Authorization: <value of the pokerogue_sessionId cookie>` (bare token, no `Bearer`)
- `Content-Type: application/json` (or `application/x-www-form-urlencoded` for form posts — login and
  register use form-urlencoded)
- `PKR-Client-Version: 1.12.0.11` (from `package.json`)

`DESIGN.md` §3.4 already forwards all three plus `Origin: https://pokerogue.net`. Note the version
header is **pinned to the built tag**; if the upstream server starts rejecting old client versions,
that is the string to look at, and the failure mode is a `save version below minimum game version`
style rejection, not a transport error.

### 4.3 The session cookie — the one real risk on `http://127.0.0.1`

`src/utils/cookies.ts:6-10`, called from `account-api.ts:66` after a successful login:

```js
document.cookie = `pokerogue_sessionId=${token};Secure;SameSite=Strict;Domain=${window.location.hostname};Path=/;Expires=...`
```

On the wrapper's origin this becomes `Domain=127.0.0.1;Secure`. Two things to verify in Electron at
Milestone 1:

1. **`Secure` over plain HTTP.** Chromium treats `127.0.0.1` and `localhost` as trustworthy origins
   and (since Chrome 89) accepts `Secure` cookies from them over `http:`. Expected to work, **not
   yet empirically verified** — no GUI was launched for this report.
2. **`Domain=` set to an IP literal.** Chromium accepts a `Domain` attribute that is an IP address
   only when it equals the request host, and stores it host-only. `127.0.0.1` equals the host here,
   so it should be accepted.

If either fails, `getCookie()` returns `""`, every API request goes out with an empty `Authorization`
header, and the game sits in a login loop. **This is the single highest-value thing to smoke-test
first.** Two escape hatches if it does fail: (a) serve on `http://localhost:47830` instead — the
`Domain=localhost` form is unambiguous — but that changes the localStorage origin and is therefore a
one-way door per `DESIGN.md` §1; (b) have the proxy also accept the token from a `Cookie` header, which
the browser sends regardless, and not rely on `Authorization`.

Also note `getCookie()` *deletes* the cookie and returns `""` if it ever sees two cookies whose name
contains `pokerogue_sessionId`. The wrapper must not set a cookie of its own with an overlapping name.

### 4.4 OAuth

`http://127.0.0.1:47830/api/auth/discord/callback` and `.../auth/google/callback` are compiled in as
redirect URIs, with the real production client IDs. Those redirect URIs are **not registered** with
Discord/Google, so the OAuth flow cannot complete. `DESIGN.md` assumes the wrapper hides/disables the
buttons — confirmed necessary. The buttons live in
`menu-ui-handler.ts` (unlink) and `oauth-providers-ui-handler.ts` / the login form (link/login).

### 4.5 Service worker and manifest

- `dist/service-worker.js` **is present** and `index.html` registers `./service-worker.js` from an
  inline `<head>` script. Its content is trivial — an `install` log and `clients.claim()`; **it
  caches nothing and intercepts no `fetch`**. It will register successfully over `http://127.0.0.1`
  (unlike the fork's `file://` build, where registration fails). Harmless, but it does mean the page
  gets a controlling service worker; if the wrapper ever wants a clean slate it can call
  `session.clearStorageData({storages:['serviceworkers']})`.
- `dist/manifest.webmanifest` is present with `"scope": "/"` and `"start_url": "/"` — correct for
  serving at the origin root, no change needed. `index.html` also suppresses `beforeinstallprompt`.

### 4.6 MIME types the static server must get right

`.html .js .css .json .webmanifest .png .jpg .ttf .mp3 .m4a .wav .mp4 .map`. Serving `.js` as
anything but a JavaScript type breaks the ES-module `<script type="module">`. `.webmanifest` should
be `application/manifest+json`.

### 4.7 The game's own localStorage keys (origin `http://127.0.0.1:47830`)

Per-user (`<user>` = the logged-in username; note the trailing `_undefined` if none):

| Key | Contents |
|---|---|
| `data_<user>` | system save, AES-encrypted (same format as an exported `.prsv`) |
| `sessionData_<user>` | session slot 0, AES-encrypted |
| `sessionData1_<user>` … `sessionData4_<user>` | session slots 1–4 |
| `runHistoryData_<user>` | run history, AES-encrypted |
| `starterPrefs_<user>` | starter-select UI preferences, plain JSON |
| `data_<user>_bak`, `sessionData*_<user>_bak` | written by `account.ts`'s pre-username migration |

Global (**not** per user — these are the settings the wrapper's settings page must not clobber):

| Key | Contents |
|---|---|
| `settings` | all general/display/audio settings, JSON array of `{key, value}` |
| `settingsGamepad`, `settingsKeyboard` | control bindings |
| `tutorials` | seen tutorials, JSON |
| `seenDialogues` | seen dialogues, JSON |
| `mappingConfigs` | gamepad/keyboard mapping configs, JSON |
| `prLang` | selected language (also drives font loading) |
| `daily` | base64 list of cleared daily-run seeds |
| `touchControlPositionsLandscape`, `touchControlPositionsPortrait` | touch control layout |

Only `data_*`, `sessionData*` and `runHistoryData_*` are ever synced with the server. Everything else
is local-only and would be lost if the localStorage origin changed — another reason `GAME_ORIGIN` is
fixed.

### 4.8 Save-slot naming matches `DESIGN.md` §1

`getSessionDataLocalStorageKey(slot)` returns `` `sessionData${slotId || ""}_${username}` `` — i.e.
slot 0 has no digit. Confirmed against the built tag. Slots `0..4` (`account.ts` iterates `s < 5`).

---

## 5. Deviations from the plan

1. **Build mode is `offline`, not `production` — with two side effects.** `vite.config.ts` keys three
   things off `mode === "production"`:
   - `build.sourcemap: mode !== "production"` → **sourcemaps are generated** (9 `.map` files, 28.3 MB,
     4 % of the output; each JS chunk gets a trailing `//# sourceMappingURL=` comment). Kept: they cost
     little next to 436 MB of audio and make debugging the wrapper far easier. They are only fetched
     when devtools are open.
   - `treeshake.propertyReadSideEffects` / `unknownGlobalSideEffects` are less aggressive than a
     production build, and `console.log`/`console.debug` are **not** treated as pure, so log calls
     survive. Effect is larger JS chunks (about +10 %) and a chattier console. No behavioural risk.
   - Because `mode` is not `"production"` and `NODE_ENV` was not set, Vite computes
     `import.meta.env.PROD === false` / `DEV === true`. Nothing in `src/` reads either — the code keys
     off `import.meta.env.MODE` only (`isDev`/`isBeta`/`isApp`/`IS_TEST`, all `false` under
     `offline`, which is the production-like combination we want). Upstream's own `build:app` ships
     with exactly the same property.

   Both are avoidable by building `--mode production` with `VITE_SERVER_URL` passed through the
   environment (Vite's `loadEnv` lets a real env var override the file value). I did **not** do this,
   because `.env.offline` + `--mode offline` is what the plan specified, is self-documenting, and
   keeps the configuration in a file rather than in shell state. Flagging it as the one available
   knob if bundle size or console noise ever matters.

2. **`MODE` is not in upstream's `ImportMetaEnv` union** (`src/vite.env.d.ts:10` lists
   `"development" | "beta" | "production" | "test" | "app"`). This affects `pnpm typecheck` only, not
   `vite build`; we never run `tsc`. No file was patched to add `"offline"`.

3. **Two benign build warnings**, present in upstream's own builds too:
   `./fonts/pokemon-emerald-pro.ttf referenced in ./fonts/pokemon-emerald-pro.ttf didn't resolve at
   build time, it will remain unchanged to be resolved at runtime` (and the same for `pkmnems.ttf`).
   The fonts are in `dist/fonts/` and resolve at runtime. Not an error.

4. **`publicDir` is `false` for builds** (`vite.config.ts`), so Vite itself copies nothing. The
   `minify-public-json-files` plugin's `generateBundle` hook copies `./assets/**` → `dist/` and
   `./locales/**` → `dist/locales/` instead (14 290 JSON files minified). Consequence: **the clone
   must have both submodules**, and a `--depth 1` clone without `--recurse-submodules` produces a
   `dist` that builds fine but is an empty shell. The build script and the workflow both clone with
   `--recurse-submodules` and the verify step asserts `images/`, `audio/`, `fonts/` and
   `locales/en/common.json` exist.

5. **`pnpm` self-pins.** The launcher is 10.34.5 but `package.json`'s `packageManager` field makes it
   run as **10.33.2**. Expected, and good for reproducibility.

6. **Zip uses `CompressionLevel::Fastest`** (`-1` in the CI workflow). 668 MB → 511 MB in 151 s;
   `Optimal` would take many minutes for a couple of extra percent, since ~80 % of the payload is
   already-compressed mp3/png.

7. **`Invoke-Checked` in `build-game.ps1` drops `$ErrorActionPreference` to `Continue` around native
   commands.** PowerShell 5.1 with `-ErrorAction Stop` turns any stderr line from `git`/`pnpm`/`vite`
   into a terminating `NativeCommandError`; the first draft of the script died on vite's progress
   output. Exit codes are checked explicitly instead.

8. **`robocopy /MIR` was refused by the sandbox**; `Copy-Item -Recurse` is used instead (37 s for
   34 094 files).

9. **`.env.offline` and `version.json` are written without a UTF-8 BOM** via
   `[System.IO.File]::WriteAllText`. PowerShell 5.1's `-Encoding utf8` emits a BOM, which trips up
   `JSON.parse` and dotenv parsers.

10. **Nothing was committed** (per instruction) and **nothing under `upstream/` was touched**.
    `game-build/dist/` and `game-build/work/` are already in `.gitignore`, so the 668 MB output and
    the 2.1 GB work tree will not enter git.

---

## 6. Deliverables

| Path | What |
|---|---|
| `game-build/dist/game/` | **the built game** (`index.html` at the root) |
| `game-build/dist/game-v1.12.0.11.zip` | 511.1 MB |
| `game-build/dist/game-v1.12.0.11.zip.sha256` | `06b9730572d4e6f2437a22215516e78322bb6f0d0b34b6e53085d05fdef2d3a7` |
| `game-build/dist/version.json` | `{tag, upstreamSha, gameVersion, serverUrl, builtAt}` |
| `game-build/build-game.ps1` | `-Tag -OutDir -WorkDir -ZipDir -ServerUrl -ReuseClone -NoZip`; clone → env → install → build → verify → copy → zip + sha256 |
| `game-build/README.md` | how to run it, what it verifies, CI description |
| `.github/workflows/build-game.yml` | manual dispatch (tag input) + daily schedule; publishes `game.zip`, `game.zip.sha256`, `version.json` to release `game-<tag>` in `m0stey/pokerogue-offline`; keeps the newest 3 `game-*` releases |
| `game-build/work/pokerogue/` | the clone (gitignored, reusable via `-ReuseClone`) |
| `game-build/work/serve-check.mjs` | the throwaway static server used for the smoke test |

The workflow was validated by parsing the YAML and `bash -n`-checking all eight `run` blocks; it has
not been executed (no remote repo push from here). It is modelled on
`upstream/admiral-pokerogue-fork/.github/workflows/update.yml` but drops that workflow's three extra
third-party repos, its beta build, and its commit-hash-based release naming in favour of tag-based
releases, an explicit verify step, and `gh` instead of the archived `actions/create-release@v1`.

## 7. Suggested next checks (Milestone 1)

1. Load `http://127.0.0.1:47830/` in the Electron `BrowserWindow` and log in. **Watch for the
   `pokerogue_sessionId` cookie actually being stored** (§4.3) — this is the likeliest failure.
2. Confirm `Manifest not found:` is the only console error besides the expected ones, and that the
   service worker registers.
3. Confirm `PKR-Client-Version: 1.12.0.11` reaches `api.pokerogue.net` through the proxy and is
   accepted.
4. Decide the Wiki-link behaviour (§3a) and hide the OAuth buttons (§4.4).
