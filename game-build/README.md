# game-build

Builds the **unmodified upstream PokéRogue client** (`pagefaultgames/pokerogue`) for the
PokéRogue Offline wrapper. No fork, no patches — the only thing we add is one untracked
Vite mode file.

Repository for CI and releases: <https://github.com/m0stey/pokerogue-offline>

## What "configured for the wrapper" means

Two build-time values, and nothing else (`DESIGN.md` §1):

| Variable | Value | Effect |
|---|---|---|
| `VITE_BYPASS_LOGIN` | `0` | Login is **enabled**. The game uses its own login screen and the real save API. |
| `VITE_SERVER_URL` | `http://127.0.0.1:47830/api` | Compiled API base. Same origin as the served game, so no CORS and no preflights. |

Everything else is copied verbatim from upstream's `.env.production`.

Upstream's `vite.config.ts` calls `loadEnv(mode, ...)`, so `vite build --mode offline` reads
`.env.offline` on top of `.env`. `.env.offline` is created by the build script inside the throwaway
clone and is never committed — **no tracked upstream file is modified**.

`src/constants/app-constants.ts` compiles `bypassLogin = import.meta.env.VITE_BYPASS_LOGIN === "1"`
to a constant, which Rolldown folds and inlines, so the verify step checks the *effects* of
`bypassLogin === false` rather than looking for a name that no longer exists in the bundle.

## Usage

```powershell
# default: tag v1.12.0.11 -> game-build\dist\game + game-build\dist\game-v1.12.0.11.zip
.\build-game.ps1

# explicit
.\build-game.ps1 -Tag v1.12.0.11 -OutDir C:\dev\pokerogue-offline\game-build\dist\game

# fast iteration against an existing clone (skips the ~2 min clone; not reproducible)
.\build-game.ps1 -ReuseClone -NoZip
```

| Parameter | Default | Meaning |
|---|---|---|
| `-Tag` | `v1.12.0.11` | Upstream git tag. Keep in sync with `DESIGN.md` §1. |
| `-OutDir` | `dist\game` | Receives the build; `index.html` lands at its root. |
| `-WorkDir` | `work` | Clone scratch dir. Wiped on each run unless `-ReuseClone`. |
| `-ZipDir` | parent of `-OutDir` | Receives `game-<tag>.zip`, `game-<tag>.zip.sha256`, `version.json`. |
| `-ServerUrl` | `http://127.0.0.1:47830/api` | Compiled API base. Fixed by `DESIGN.md`; override only for experiments. |
| `-ReuseClone` | off | Reuse the existing clone instead of re-cloning. |
| `-NoZip` | off | Skip packaging. |

### Requirements

Node ≥ 22 (built and verified with 24.19.0), pnpm (auto-pinned to the repo's `packageManager`,
10.33.2), and git with submodule support. The script looks for pnpm at `%APPDATA%\npm\pnpm.cmd`
first, then on `PATH`, and adds `C:\Program Files\nodejs` to `PATH` if `node` is missing.

### Pipeline

1. `git clone --depth 1 --branch <tag> --recurse-submodules --shallow-submodules` — the
   **`locales` and `assets` submodules are required**; the build fails without `locales/`, and
   `dist` would be an empty shell without `assets/`.
2. Write `.env.offline` (Discord/Google client IDs read out of upstream `.env.production`).
3. `pnpm install --frozen-lockfile`.
4. `pnpm vite build --mode offline`.
5. Verify the bundle (see below). Any failure aborts the build.
6. Copy `dist/` to `-OutDir`, write `version.json`.
7. Zip to `game-<tag>.zip` (`CompressionLevel::Fastest` — the payload is ~80 % pre-compressed
   mp3/png, deflate buys almost nothing and costs minutes) plus a `.sha256` sidecar.

### Verify step

Aborts the build unless all of these hold:

- `http://127.0.0.1:47830/api` appears in the JS bundle.
- `api.pokerogue.net` does **not** appear in the JS bundle.
- `VITE_BYPASS_LOGIN` was substituted (no literal left).
- `/account/login`, `/account/info`, `/savedata/system/get`, `/savedata/system/update` and
  `/savedata/updateall` are all present — with `bypassLogin === true` these call sites are
  folded away, so their presence is the proof that login is compiled in.
- `index.html` references its assets with relative `./assets/...` paths.
- `assets/`, `locales/en/common.json`, `manifest.webmanifest`, `service-worker.js`,
  `images/`, `audio/`, `fonts/` exist in the output.

## Output

`-OutDir` is served by the wrapper at `/`. `index.html` sits at its root next to
`assets/`, `audio/`, `images/`, `battle-anims/`, `fonts/`, `locales/`, `manifest.webmanifest`
and `service-worker.js`.

At `v1.12.0.11`: 34 094 files, 668 MB on disk, 511 MB zipped.

See `reports/game-build.md` for verification results and everything the wrapper needs to know
about the served bundle (asset paths, the `/manifest.json` probe, the session cookie, and the
game's localStorage keys).

## CI

`.github/workflows/build-game.yml` in this repository does the same thing on Ubuntu:

- **`workflow_dispatch`** with a `tag` input (defaults to the pinned tag) — always builds.
- **Daily schedule** — resolves the newest upstream `v*` release tag and builds it only if a
  `game-<tag>` release does not already exist.

It publishes `game.zip`, `game.zip.sha256` and `version.json`
(`{tag, upstreamSha, gameVersion, builtAt}`) to a release named `game-<tag>` in
`m0stey/pokerogue-offline`, and prunes all but the newest 3 `game-*` releases.
