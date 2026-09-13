# NOTES — `src/proxy`

Implements DESIGN.md §3.3 (Mirror), §3.4 (proxy server) and §3.5 (Connectivity).
Runtime code is Node built-ins only. Tests: `npx vitest run test/proxy` (84 tests, 5 files).

```
src/proxy/
  mirror.ts        the local store (atomic writes, tolerant reads, snapshots)
  connectivity.ts  online/offline classification + probe scheduling
  upstream.ts      forward() over http(s) to api.pokerogue.net
  static.ts        static file server for the game build
  replay.ts        offline handlers (the API, answered from the mirror)
  server.ts        startProxy(): routing, side effects, logging
```

## How to use it

```ts
import { Mirror } from "./proxy/mirror";
import { Connectivity } from "./proxy/connectivity";
import { startProxy } from "./proxy/server";

const mirror = new Mirror(path.join(app.getPath("userData"), "mirror"));
const connectivity = new Connectivity({ log });      // probe() / start() / stop()
const proxy = await startProxy({
  gameDir,                 // <userData>/game/<version>
  mirror,
  port: 47830,             // default; pass 0 in tests for an ephemeral port
  connectivity,
  log,
});
connectivity.start();                                 // startup probe + 60 s / 5 min polling
connectivity.on("online", () => scheduleSync());      // also "offline" and "change"
// on Electron's online/offline events: void connectivity.probe();
await proxy.close();
```

`startProxy` resolves after the socket is listening and returns `{ port, url, close() }`. `port` is
the actual bound port (useful with `port: 0`). `log` is optional (defaults to the no-op logger);
`upstreamBaseUrl` / `upstreamTimeoutMs` exist for tests and point `forward()` at a local fake.

Mirror surface beyond DESIGN §3.3: `setSystemSynced(save)` / `setSessionSynced(n, save)` write base
and local in **one** atomic write (used by the proxy for "the server and we now agree"),
`clearLocalSession(n, finalSave)` for a run the game finished offline, `readState()` /
`writeState(patch)` / `ensureClientSessionId()` for `state.json` (DESIGN lists the file but no
accessor; the sync engine needs it), plus the exported helpers `structurallyEqual`, `assertSlot` and
`randomClientSessionId`.

Record shape (`system.json`, `session-<n>.json`):

```ts
{ base, local, localPrev, dirty, baseFetchedAt, localWrittenAt }        // system
{ …the same…, clearedAt: string | null, finalSave: SessionSave | null } // session
```

* **`localPrev`** is the value `local` held before the last write — a one-step undo (DESIGN §3.4).
  Every path that replaces `local` shifts it: `writeLocalSystem`, `writeLocalSession`,
  `deleteLocalSession`, `clearLocalSession`, and the `set*Synced` helpers (a pull overwriting local
  is exactly when an undo is wanted). Only one step is kept, in the same atomic write.
* **`clearedAt` / `finalSave`** are set by an offline `session/clear` and are what the sync engine's
  §3.8 delete precondition reads. They are reset to `null` as soon as the slot gets a new local save
  or the server's state is adopted (`setSessionSynced`), so a settled clear cannot fire twice.

### clientSessionId

Every forwarded `/api/savedata/*` request has its `clientSessionId` replaced with the install-wide id
from `state.json` (`mirror.ensureClientSessionId()`, created lazily on the first such request) — in
the query string, and in the JSON body for `updateall`. The game's per-page-load id never reaches the
server, so the game and the sync engine cannot kick each other out of the active session (DESIGN
§3.4, invariant §4.4). Confirmed against the client source: `UpdateAllSavedataRequest`
(`src/@types/api.ts:78-83`) carries `clientSessionId` in the **body**, and `savedata-api.ts:updateAll`
posts to `/savedata/updateall` with **no query string at all**; every other savedata endpoint carries
it as a query parameter. The body rewrite is a textual substitution of that one field, so the save
bytes are forwarded unchanged. Offline replay ignores the id entirely (one client).

`Connectivity` extends `EventEmitter` and emits `change` / `online` / `offline` with
`{ state, previous, reason }`. `state` starts at `unknown`. All timers are `unref()`ed and cleared
by `stop()`.

## Deviations from DESIGN.md, and why

1. **`dirty` is computed, not asserted.** DESIGN says the offline `system/update` sets `dirty=true`.
   The mirror instead derives `dirty = !structurallyEqual(local, base)` on every write. That is the
   same thing whenever the save actually changed, and it self-corrects if the game rewrites a save
   identical to base. Key order is ignored (Go re-sorts `gameStats`, see live-api §3.13).
2. **`GET /account/info` offline synthesises info when `account.json` has a token but no `info`.**
   DESIGN says "stored info (200) or 401 if none". A literal 401 creates a loop: the client drops
   the cookie, shows the login screen, our offline login hands back the stored token, and
   `updateUserInfo()` 401s again. We only 401 when there is no account record at all (`missing
   token` with no `Authorization` header, `failed to validate token: sql: no rows in result set`
   with one — both live strings). The synthesised `lastSessionSlot` is the highest local slot.
3. **tid/sid offline are checked against `base ?? local`**, not only `base`. DESIGN says "match base
   if base exists". With an offline-only first save there is no base, and accepting a save with a
   different `trainerId` would silently destroy it; `base ?? local` matches the server's "stored
   ids" semantics and is strictly safer.
4. **No `gameVersion` / minimum-version / `appliedMigrators` validation offline.** DESIGN §3.4 lists
   only playtime and tid/sid. The served build is pinned by the app, so the version rules cannot be
   violated locally, and the real server still enforces them when the sync engine pushes.
5. **No active-`clientSessionId` emulation offline.** There is exactly one client, so nothing can be
   "not active" — `session out of date: not active` never appears offline. `clientSessionId` is
   still required to be *present* on the session endpoints, exactly like the server.
6. **`GET /savedata/system/verify` returns `{valid:true, systemData:<zeroed>}`** (DESIGN allows
   "local or zeroed"). Zeroed is what the live server returns for an active session
   (live-api §3.22), and the client must not read `systemData` unless `valid` is `false`.
7. **Error bodies carry Go's trailing newline** (`http.Error` appends one; the live `Content-Length`s
   confirm it — `save does not exist` is 20 bytes). The client only ever does
   `startsWith("session out of date")`, so this is cosmetic, but it keeps bytes identical.
8. **Offline `session/clear` answers `{"success":<bool>,"error":""}`, not a flat `{"success":true}`.**
   DESIGN says `{"success":true}` "like the server". The server's `ClearResponse`
   (`api/savedata/clear.go:27-30`) has no `omitempty`, so it always marshals both fields, and
   `success` means "this seed completion was newly recorded" — only ever true for a *completed* run.
   We reproduce that: `success` is `true` exactly when the submitted save passes the server's
   `validateSessionCompleted` (classic `gameMode 0` with `battleType 2` at `waveIndex 200`, daily
   `gameMode 3` at `waveIndex 50`), otherwise `false`, so a game-over at wave 37 does not look like a
   first clear. Either way `error` is empty, which is the only thing the client checks before
   dropping its local copy (`game-data.ts:tryClearSession`); the slot's local goes to `null` (dirty)
   and `{clearedAt, finalSave}` are recorded. `finalSave` is the submitted body, or the last local
   save when the body is empty. An offline `clear` is never forwarded or replayed to the server.
   *Online*, the game's own `clear` is forwarded like any other call (that is the game playing
   normally, not a replay) and a 200 now empties the mirror slot — `setSessionSynced(n, null)`, the
   same side effect as `delete` — because the server's handler deletes the slot unconditionally.
   Without that the finished run would sit in the mirror looking dirty and could be pushed back.
   This side effect is not in DESIGN's list; it is the only way to keep base/local truthful.
9. **`session/newclear` answers `200` with the bare JSON `false`**; `account/register`, `daily/*`
    and `game/titlestats` still get 503 `offline`, per the DESIGN catch-all. `newclear` had to come
    out of that bucket: `reports/verify-client.md` §9 said an `app`-mode build never calls it, and
    the milestone-1 run showed it does, at the end of **every** run. The client
    (`session-savedata-api.ts:newclear`) throws on anything that is not a 2xx with a JSON body, and
    `game-over-phase.ts:handleGameOver` catches that by clearing the phase queue, showing
    `serverCommunicationFailed` and reloading the page two seconds later — i.e. the 503 tore down
    the game-over screen at the exact moment the user is most attached to the result. The real server
    returns `writeJSON` of a Go `bool` (`api/endpoints.go`, `newclear` → `savedata.NewClear`), so we
    return the same thing. `false` is the honest value: the flag becomes
    `doGameOver(!isDaily || !!success)`, so a classic run ignores it entirely, and for a daily run
    we cannot know offline whether that seed was already completed and must not hand out a
    first-clear reward twice. Nothing is recorded and nothing is forwarded or queued — `newclear`
    only reads on the server, so there is nothing to replay later. The slot and `clientSessionId`
    arguments are deliberately **not** validated: an error here costs the user the end of a run, and
    there is no upside to reproducing the server argument checking for a read-only flag.
10. **Static server: no SPA fallback** (DESIGN §3.4 static bullet, updated). The built `index.html`
    references its assets as relative `./assets/...` URLs, so serving it for an arbitrary path would
    make the page resolve every asset against the wrong base. `index.html` is served for `/` and
    `/index.html` only; every other missing path — extensionless ones included — is a plain 404.
    That is deliberately what `GET /manifest.json` gets: the game fetches it at startup, it is not in
    `dist`, the fetch is wrapped in try/catch (reports/game-build.md §4.1), and it must not be
    confused with the real `/manifest.webmanifest`. Query strings are stripped before resolving
    (`getCachedUrl()` appends `?t=<timestamp>`). Other extras: a `..` segment in any encoding is
    answered `403` rather than silently normalised away; non-`GET`/`HEAD` is `405`;
    `X-Content-Type-Options: nosniff` is set; Range is not implemented (DESIGN says it is not
    required). The MIME map covers every type in the real build, including `.m4a`, `.mp4` and `.map`
    (reports/game-build.md §4.6).
11. **`forward()` sends `Accept-Encoding: identity`** in addition to `Origin`, so upstream bodies can
    be handed to the game verbatim without a decompression step. Only `Authorization`,
    `Content-Type`, `PKR-Client-Version` and `Accept` are passed through; everything else
    (cookies, user agent, custom headers) is dropped.
12. **`connectivity.state === "unknown"` is treated as "try upstream".** A successful upstream
    response marks online; HTML or a transport error marks offline. This means the app works even if
    the first probe has not finished when the game makes its first call.
13. **Request bodies over 64 MiB are refused with 413** rather than buffered indefinitely.
14. **The `Host` header must be ours.** The server binds `127.0.0.1`, and on top of that every
    request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets a plain 403 and is
    never routed — the DNS-rebinding guard (`hostAllowed`, SECURITY.md). Binding to localhost
    alone does not stop a page on the open internet pointing a hostname it owns at 127.0.0.1 and
    reading our answers as same-origin.
15. **The account token is encrypted at rest, without the proxy knowing about Electron.** The
    `Mirror` takes `{ secret: SecretCodec }` (`src/common/secret.ts`), defaulting to the identity
    codec; `src/main/secret.ts` passes one backed by Electron `safeStorage`. `account.json` then
    holds `tokenEnc` (base64) instead of `token`. A plain `token` is still read, and re-written
    protected on the first read once a codec is available. If the ciphertext cannot be decrypted
    (another Windows user, a reset credential store) the file is quarantined and `readAccount()`
    returns null, so the next login writes a clean one.
16. **The proxy notices a save from a newer game.** On a successful `system/get` — forwarded or
    replayed — the save's `gameVersion` is compared with `<gameDir>/version.json` → `gameVersion`
    using the server-semantics `compareGameVersion` (`src/common/version.ts`). If the save is
    newer, `needs-game-update` is emitted on `proxy.events` with both versions; the save itself is
    still handed to the game untouched, because the block is the client's to show and hiding the
    save would be worse. `state.json.gameVersionServed` is written at startup (milestone-1 B4).
17. **Offline responses are re-serialised JSON.** The mirror stores parsed objects, so an offline
    `system/get` returns the same *values* but not necessarily the same bytes the game sent (key
    order, whitespace). Values survive exactly, including the big `caughtAttr` values the client
    sends as decimal strings. Online responses are byte-verbatim.
15. **`app/tsconfig.json` needed a one-line fix** to typecheck at all: TypeScript 7 removed
    `moduleResolution: "node"` (node10), so `tsc --noEmit -p app` failed before any source file was
    read. Changed to `"module": "node16"` + `"moduleResolution": "node16"`. Emit is unaffected in
    practice — `scripts/build.mjs` bundles the main process with esbuild and `package.json` is
    `"type": "commonjs"`, so the output stays CJS. Flagging it because the file is shared.

## Verification

* `npx vitest run test/proxy` → **5 files, 84 tests, all passing**.
* `npx tsc --noEmit -p app` → **0 errors in `src/proxy`**. Pre-existing errors elsewhere at the time
  of writing: `src/main/window.ts:119` (Electron event-name overload) and `src/sync/reconcile.ts`
  (3, `ExplainedDecision extends` a union) — both other agents' files.
* The test fake (`test/proxy/fake-upstream.ts`) emulates register/login/info/logout, system
  get+update with the active-session, playtime and tid/sid rules, session get/update/delete with the
  slot range and wave-index guard, `updateall`, plus a Cloudflare-style `text/html` 403 mode and a
  hang mode. It rejects any request without `Origin: https://pokerogue.net`, so the Origin
  requirement is enforced by every test that talks to it.
* `test/proxy/static.test.ts` also serves the **real** build from `game-build/dist/game` when that
  directory exists (the block is skipped otherwise): `/`, the `./assets/*.js` chunk index.html
  actually references, `/manifest.webmanifest`, `/manifest.json` (404) and
  `/locales/en/ability.json?t=…`.

## Open questions for the orchestrator

*(Questions 1, 2, 5 and 6 from the first round are settled — see DESIGN §3.4, §3.8, §4.7 — and are
implemented above: offline `clear`, the clientSessionId rewrite, `localPrev`, and backups staying in
the sync engine. `datatype` is gone from DESIGN and was never referenced by the code.)*

1. **Offline login status.** DESIGN prescribes `401 offline: unknown user`; the live server answers
   bad credentials with `500` plus a plain-text body. The client shows the body text either way and
   treats `400`/`null` as "show the login form", `401` as "drop the cookie and reset". Implemented
   as specified — confirm that a reset on an unknown offline user is what we want (it is harmless:
   the game returns to the login screen).
2. **Password is not verified offline** (DESIGN §3.4 says to document this). Anyone with access to
   the machine can log into the mirrored account by typing the right username. The mirror itself is
   plain JSON on disk, so this adds no new exposure — but it is worth stating in the UI copy.
3. **`success` on an offline `clear` of an *already completed* seed.** The server would answer
   `success:false` when the seed was completed before (`TryAddSeedCompletion`), and we cannot know
   that offline — we answer `true` for any completed run. The client only uses it as the `newClear`
   flag, so the worst case is a repeated "new clear" celebration for a seed already beaten online.
   Tracking completed seeds in the mirror would fix it; not worth it unless the flag drives rewards.
4. **Sync engine contract for the clear.** `session-<n>.json` now carries `clearedAt` and
   `finalSave`; the proxy resets both as soon as the slot gets a new local save or
   `setSessionSynced` runs. The engine's §3.8 `delete` precondition should read them from
   `mirror.readSession(n)` — flagging it so the sync agent wires up the same field names.
5. **`localPrev` is shifted by the `set*Synced` helpers too**, not only by `writeLocal*`. DESIGN
   §3.4 says "each `writeLocal*`"; a pull that replaces local is exactly the case where a one-step
   undo is wanted, so the online path shifts it as well. Say if that should be narrowed.
