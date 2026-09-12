# Live API probe — api.pokerogue.net

Date of probe: **2026-09-12** (UTC). All requests made from a single IP, sequentially, with ≥1 s
spacing. **43 API requests + 8 requests to the static site**, all against a brand-new throwaway
account created for this probe. No other account was touched, named, guessed or enumerated.

Client source read for request shapes: `C:\dev\pokerogue-offline\upstream\pokerogue`
(`src/api/*.ts`, `src/system/game-data.ts`, `src/@types/save-data.ts`, `package.json` → version
`1.12.1.0`).
Server source read for expectations: `C:\dev\pokerogue-offline\upstream\rogueserver`
(`api/common.go`, `api/endpoints.go`, `api/savedata/*.go`, `api/account/*.go`, `defs/savedata.go`,
`db/savedata.go`, `db/account.go`).

Raw request/response logs: `C:\dev\pokerogue-offline\scratch\api-probe\log\*.h` (headers) and
`*.b` (bodies). Scripts and fixtures: `C:\dev\pokerogue-offline\scratch\api-probe\`.

## Throwaway account

Stored in `C:\dev\pokerogue-offline\scratch\api-probe\throwaway-account.json`.

| Field | Value |
|---|---|
| API base | `https://api.pokerogue.net` |
| username | `offsync_4djvj5` |
| password | `d4j9KKP8zs41ayNwed7bksO9X0he` |
| token (1st login, now revoked by logout) | `f1cv1A…` (44-char base64, 32 raw bytes) |
| token (2nd login, live) | `oaEAkA…` (44-char base64, 32 raw bytes) |

Note on the username: the server enforces `^\w{1,16}$` (`api/account/common.go:isValidUsername`),
so the requested `offsync-test-<random6>` shape is **invalid** — hyphens are rejected and 18 chars
exceed the limit. Underscores were used instead.

---

## 1. Summary table

| # | Test | Expected from source | Observed | Match? |
|---|---|---|---|---|
| 1 | Terms of service / usage policy | unknown (brief: unresolved) | **No ToS, privacy or acceptable-use page exists.** `/terms`, `/privacy`, `/tos`, `/legal` all 404. Only a Cloudflare-managed `robots.txt` (see §2). Repo has only AGPL-3.0 + CONTRIBUTING.md. | n/a — nothing prohibits or permits third-party clients |
| 2 | `POST /account/register`, form-urlencoded | 200, empty body | `200`, `Content-Length: 0` | ✅ |
| 2b | username charset | `^\w{1,16}$` | confirmed (hyphen form not attempted after source read) | ✅ |
| 3 | `POST /account/login` | JSON `{"token": base64(32 bytes)}`, no cookie | `200`, `{"token":"…"}`, 44-char base64. **No `Set-Cookie` header at all** — the client sets the cookie itself from the body | ✅ |
| 4 | `GET /account/info` | `{username, discordId, googleId, lastSessionSlot, hasAdminRole}` | exactly that; `lastSessionSlot: -1` on an empty account, `0` after writing slot 0 | ✅ |
| 5 | `GET /savedata/system/get` on empty account | 404 `save does not exist` | `404`, body `save does not exist`, `Content-Type: text/plain` | ✅ |
| 6a | system `update` with active clientSessionId A | 204 | `204 No Content`, empty body | ✅ |
| 6b | system `update` with never-GET'd clientSessionId B | 400 not-active | `400`, `session out of date: not active` | ✅ |
| 6c | GET with B, then `update` with A | A rejected | `400`, `session out of date: not active` | ✅ |
| 6d | `update` with playTime **lower** | 400 | `400`, `session out of date: existing playtime is greater` | ✅ |
| 6e | `update` with playTime **equal** | succeeds (`<` only) | `204 No Content` — **succeeds and overwrites** | ✅ (and dangerous) |
| 6f | `update` with mismatched `trainerId` | 400 | `400`, `session out of date: stored trainer or secret ID does not match` | ✅ |
| 6g | `update` with `gameVersion: "1.0.0"` | 400, min version 1.12.0.10 | `400`, `session out of date: save version below minimum game version` | ✅ |
| 6g2 | boundary: `1.12.0.9` / `1.12.0.10` | min is exactly `1.12.0.10` | `1.12.0.9` → below-minimum; `1.12.0.10` → `session out of date: existing version is greater` (stored save was 1.12.1.0) | ✅ min = 1.12.0.10 confirmed live |
| 6h | playTime +1, then GET and diff | exact round trip | `204`, then GET returns **semantically identical JSON**; only diff is two legacy fields added: `starterMoveData: null`, `starterEggMoveData: null`. `gameStats` keys re-sorted alphabetically. Big `caughtAttr` string `"34084861955"` survives as a string. | ⚠️ near-exact, two added nulls |
| 7a | `GET /savedata/session/get?slot=0` empty | 404 | `404`, `save does not exist` | ✅ |
| 7b | after that session GET with A, system `update` with B | B kicked out | `400 not active` — **session endpoints steal the active session even when they 404** | ✅ (source-consistent, but easy to miss) |
| 7c | session `update` with an **inactive** clientSessionId | source: no active check on `/savedata/session/{action}` | `200 OK`, empty body — **session writes are NOT gated on the active session** | ✅ |
| 7d | session round trip | lossy: server struct has no `playerFaints`, `[]` → `null` | `playerFaints:3` **dropped**, unknown field **dropped**, every empty array returned as `null` | ⚠️ lossy |
| 7e/f | session wave regression, same seed | 400 | `400`, `session out of date: existing wave index is greater` | ✅ |
| 7g | session wave regression with a **different seed** | allowed (guard is `seed ==` only) | `200 OK` — wave-1 run silently overwrote a stored wave-5 run | ✅ (and dangerous) |
| 7h | `session/get?slot=5` | 400 out of range | `400`, `slot id 5 out of range` | ✅ |
| 7i | `session/delete?slot=0` (HTTP **GET**) | 200 | `200`, empty body; subsequent GET → `404 save does not exist` | ✅ |
| 8 | `POST /savedata/updateall` | 200, writes both | `200`, empty body; system playTime and session slot 1 both written and read back | ✅ |
| 9 | `GET /savedata/system/verify` with a **stale** clientSessionId | 200 `{valid:false, systemData:<stored save>}` | **`500 Internal Server Error`, `failed to read session save data: sql: no rows in result set`** — but the active session **was still switched** (next verify returned `valid:true`) | ❌ **differs from source** |
| 9b | `verify` with the active clientSessionId | `{valid:true, systemData:<zero>}` | `200`, `{"valid":true,"systemData":{…all zero/null…}}` | ✅ |
| 10 | `GET /account/logout`, then reuse token | 200; then 401 | `200` empty; then `401 failed to validate token: sql: no rows in result set` on both `/account/info` and `/savedata/system/get` | ✅ |
| 11a | Missing `Origin` header | not in source | **`403` Cloudflare WAF block page** ("Sorry, you have been blocked") even with a valid token | ❌ **not in source — hard requirement** |
| 11b | `Origin: https://pokerogue.net`, no token | 401 | `401 missing token` (clean, no WAF) | ✅ |
| 11c | `PKR-Client-Version` missing or `1.0.0` | not read by server | `200` both times — header is **not** enforced | ✅ |
| 12 | active clientSessionId across logout/login | keyed on account uuid, not token | after logout + re-login, `update` with the previously-active `A` still succeeded (`204`) — **active session survives token rotation** | ✅ |
| 13 | Rate-limit headers / challenges | unknown | **No** `RateLimit-*`, `Retry-After` or `X-RateLimit-*` headers on any response. No JS challenge or CAPTCHA on correctly-shaped requests. | see §4 |

---

## 2. Terms of service / usage policy (step 1)

**There is no terms-of-service, privacy or acceptable-use document.**

- `GET https://pokerogue.net/` → `200`, 8,238 bytes, a bare Vite SPA shell. The only outbound
  links in the HTML are `./assets/*`, `./logo512.png`, `./manifest.webmanifest`,
  `https://pokerogue.net` and a Cloudflare `cdn-cgi/content` URL. **No link to terms, privacy,
  legal, rules or EULA.**
- `GET https://pokerogue.net/terms`, `/privacy`, `/tos`, `/legal` → all `404` (1,388–1,389 bytes,
  the Cloudflare Pages 404 page).
- The client repo contains no legal text beyond the licence. `LICENSE` is GNU AGPL-3.0. The only
  hit for "terms" across `README.md`/`CONTRIBUTING.md` is about *GitHub's* terms for contributions:

  > As per GitHub's [terms of service](…), any contributions made to this repository will be
  > licensed under this repository's terms.

  — `upstream/pokerogue/CONTRIBUTING.md:15`. Nothing about clients, automation, or the API.
- `rogueserver` is AGPL-3.0 as well (`Copyright (C) 2024 - 2025 Pagefault Games`).

The only policy-shaped document served is `https://pokerogue.net/robots.txt` (identical bytes are
served at `https://api.pokerogue.net/robots.txt`, 1,836 bytes). It is Cloudflare's managed
content-signals boilerplate, and it concerns **crawling and AI training**, not API clients:

```
# As a condition of accessing this website, you agree to abide by the following
# content signals:
...
# search:   building a search index and providing search results ...
# ai-input: inputting content into one or more AI models ...
# ai-train: training or fine-tuning AI models.
# use:      how AI systems may consume the content (immediate, reference, or full).

# BEGIN Cloudflare Managed content

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /

User-agent: Amazonbot
Disallow: /
... (Applebot-Extended, Bytespider, CCBot, ClaudeBot,
      CloudflareBrowserRenderingCrawler, Google-Extended, GPTBot,
      meta-externalagent — each Disallow: /)

# END Cloudflare Managed Content
```

**Reading.** `User-agent: *` is `Allow: /`; the `Disallow` rules name only AI crawlers, none of
which a save-sync wrapper would identify as. The content signals restrict *AI training on the
content* and say nothing about programmatic use of the save API. The AGPL under which both the
client and the server are published explicitly permits running and modifying the software. So:
**nothing published by the operator prohibits a third-party client or automated save sync, and
nothing explicitly permits it either — the question the brief flagged as unresolved remains
formally unresolved, because no document addresses it.** The practical policy signal is the
Cloudflare WAF (§4), which blocks requests that do not look like the game client.

---

## 3. Per-request detail

Every request also carried `User-Agent: curl/8.x`. The `Authorization` value is the raw base64
token (this is what the client sends as the `pokerogue_sessionId` cookie value); it is redacted to
its first 6 characters below. Response headers common to all API responses are listed once here
and omitted from the individual entries:

```
Server: cloudflare
Access-Control-Allow-Origin: https://pokerogue.net
Access-Control-Allow-Methods: OPTIONS, GET, POST
Access-Control-Allow-Headers: Content-Type, Authorization, Pkr-Client-Version
Access-Control-Max-Age: 86400
cf-cache-status: DYNAMIC
Strict-Transport-Security: max-age=15552000; includeSubDomains; preload
Nel / Report-To: <Cloudflare NEL boilerplate>
CF-RAY: <per-request>
```

Note that `Access-Control-Allow-Origin` is the **literal string** `https://pokerogue.net`, not a
reflection of the request's `Origin` — so a browser context on any other origin cannot call this
API at all.

### 3.1 Register — `log/02-register`

```
POST https://api.pokerogue.net/account/register
Content-Type: application/x-www-form-urlencoded
PKR-Client-Version: 1.12.1.0
Origin: https://pokerogue.net

username=offsync_4djvj5&password=d4j9KKP8zs41ayNwed7bksO9X0he
```
```
HTTP/1.1 200 OK
Content-Length: 0
Expires: Sat, 12 Sep 2026 16:45:49 GMT
Cache-Control: no-cache

<empty body>
```

Confirms the client's `doPost(path, data, "form-urlencoded")` path in
`src/api/account-api.ts:register`. A JSON body would not work: the handler reads
`r.PostFormValue("username")`.

### 3.2 Login — `log/03-login`

```
POST https://api.pokerogue.net/account/login
Content-Type: application/x-www-form-urlencoded
PKR-Client-Version: 1.12.1.0
Origin: https://pokerogue.net

username=offsync_4djvj5&password=…
```
```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 57

{"token":"f1cv1AwFbY8AsWsd/gCTcEvEtKKyifmdITFpnm/xNco="}
```

**Token shape:** returned **only** in the JSON body field `token`. There is **no `Set-Cookie`
header** on the login response — grep for `set-cookie` in `log/03-login.h` returns nothing. The
token is standard base64 of 32 random bytes → 44 characters including one `=` pad, and it can
contain `+` and `/` (this one contains `/`). The client stores it verbatim in the
`pokerogue_sessionId` cookie and sends it back as the raw `Authorization` header value — it is
**not** `Bearer`-prefixed. Server-side, `tokenFromRequest` base64-decodes the header and requires
exactly 32 bytes.

A wrapper must therefore URL-encode nothing but must be careful if it ever puts the token in a
cookie header itself (`/` and `+` are legal in cookie values, `=` padding is fine).

### 3.3 Account info — `log/04-account-info`, `log/07i-account-info-with-session`

```
GET https://api.pokerogue.net/account/info
Authorization: f1cv1A…
PKR-Client-Version: 1.12.1.0
Origin: https://pokerogue.net
```
```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 101

{"username":"offsync_4djvj5","discordId":"","googleId":"","lastSessionSlot":-1,"hasAdminRole":false}
```

After writing session slot 0 the same call returns `"lastSessionSlot":0`. After deleting slot 0 it
would fall back (not re-checked). `lastSessionSlot: -1` is the empty-account sentinel and is what
the wrapper should treat as "no run in progress".

### 3.4 System get on an empty account — `log/05-system-get-empty`

```
GET https://api.pokerogue.net/savedata/system/get?clientSessionId=sBpg16PwiEQbCyQ9YWOGqylRMbwtiCX5
Authorization: f1cv1A…
```
```
HTTP/1.1 404 Not Found
Content-Type: text/plain; charset=utf-8
Content-Length: 20
X-Content-Type-Options: nosniff

save does not exist
```

Not an empty object, not a default save: a plain-text 404. The client's
`PokerogueSystemSavedataApi.get` returns the **number** `404` in this case, so the wrapper must
distinguish "no save yet" (404) from "network down" (null/throw). The GET still made
`clientSessionId=A` active despite the 404.

### 3.5 Minimal valid system save

Built from `SystemSaveData` (`src/@types/save-data.ts:25`) / `GameData.getSystemSaveData`
(`src/system/game-data.ts:149`) and `defs.SystemSaveData` (`defs/savedata.go`). The server decodes
into a **typed Go struct**, so field names must match exactly and `gameStats` must be a flat object
whose every value is a number (`db/account.go:UpdateAccountStats` does
`v.(float64)` on *every* key and errors out otherwise). Minimal accepted body
(`scratch/api-probe/sys-v1.json`):

```json
{"trainerId":60746,"secretId":44388,"gender":0,"dexData":{},"starterData":{},
 "gameStats":{"playTime":1000,"battles":0,"classicSessionsPlayed":0,"sessionsWon":0,
 "highestEndlessWave":0,"highestLevel":0,"pokemonSeen":0,"pokemonDefeated":0,
 "pokemonCaught":0,"pokemonHatched":0,"eggsPulled":0,"eggHatchCount":0},
 "unlocks":{},"achvUnlocks":{},"voucherUnlocks":{},"voucherCounts":{"0":0,"1":0,"2":0,"3":0},
 "eggs":[],"eggPity":[0,0,0,0],"unlockPity":[0,0,0,0],
 "gameVersion":"1.12.1.0","timestamp":1789231606586,"appliedMigrators":{}}
```

### 3.6 System update, active session — `log/06a-system-update-A`

```
POST https://api.pokerogue.net/savedata/system/update?clientSessionId=sBpg16…
Authorization: f1cv1A…
Content-Type: application/json
PKR-Client-Version: 1.12.1.0
Origin: https://pokerogue.net
<sys-v1.json, 525 bytes>
```
```
HTTP/1.1 204 No Content
Expires: Sat, 12 Sep 2026 16:46:52 GMT
Cache-Control: no-cache

<empty body>
```

Success is **204 with an empty body**. The client treats `await response.text()` as an error
message, so `""` means success; a wrapper must not treat a non-2xx status as "no error" just
because the body is empty — check the status.

### 3.7 System update, never-active clientSessionId B — `log/06b-system-update-B-inactive`

```
POST …/savedata/system/update?clientSessionId=eFCzaclr3ZWU3RzNRvWo2gC0q5NBjyvF
<sys-v2.json, playTime 1001>
```
```
HTTP/1.1 400 Bad Request
Content-Type: text/plain; charset=utf-8
Content-Length: 32
X-Content-Type-Options: nosniff

session out of date: not active
```

### 3.8 GET with B (B becomes active), then update with A — `log/06c1`, `log/06c2`

`GET /savedata/system/get?clientSessionId=B` → `200`, body (575 bytes):

```json
{"trainerId":60746,"secretId":44388,"gender":0,"dexData":{},"starterData":{},
"starterMoveData":null,"starterEggMoveData":null,
"gameStats":{"battles":0,"classicSessionsPlayed":0,"eggHatchCount":0,"eggsPulled":0,
"highestEndlessWave":0,"highestLevel":0,"playTime":1000,"pokemonCaught":0,
"pokemonDefeated":0,"pokemonHatched":0,"pokemonSeen":0,"sessionsWon":0},
"unlocks":{},"achvUnlocks":{},"voucherUnlocks":{},"voucherCounts":{"0":0,"1":0,"2":0,"3":0},
"eggs":[],"eggPity":[0,0,0,0],"unlockPity":[0,0,0,0],"gameVersion":"1.12.1.0",
"timestamp":1789231606586,"appliedMigrators":{}}
```

Then `POST …/system/update?clientSessionId=A` → `400`, `session out of date: not active`.
**Confirmed: exactly one clientSessionId is active per account at a time, last GET wins.**

### 3.9 playTime lower — `log/06d-playtime-lower`

```
POST …/system/update?clientSessionId=B   (playTime 999, stored 1000)
```
```
HTTP/1.1 400 Bad Request
Content-Length: 50

session out of date: existing playtime is greater
```

### 3.10 playTime equal — `log/06e-playtime-equal`

```
POST …/system/update?clientSessionId=B   (playTime 1000 == stored 1000, battles changed 0 → 7)
```
```
HTTP/1.1 204 No Content
```

**Equal playtime is accepted and the whole save is replaced.** The check is `playtime < oldPlaytime`
only. This is a real overwrite vector: two saves that both sat at the same play time (e.g. the
online save was never played after the offline copy was taken) will silently clobber each other.

### 3.11 trainerId mismatch — `log/06f-trainerid-mismatch`

```
POST …/system/update?clientSessionId=B   (trainerId 60747, stored 60746)
```
```
HTTP/1.1 400 Bad Request
Content-Length: 64

session out of date: stored trainer or secret ID does not match
```

Note the ids are bound to the account on the **first** successful system write
(`validateOrCreateIds` creates them when both stored values are 0) and are immutable thereafter.

### 3.12 Old game version, and the exact minimum — `log/06g-old-version`, `log/06g2-*`

| `gameVersion` sent | Status | Body |
|---|---|---|
| `1.0.0` | 400 | `session out of date: save version below minimum game version` |
| `1.12.0.9` | 400 | `session out of date: save version below minimum game version` |
| `1.12.0.10` | 400 | `session out of date: existing version is greater` |
| `1.12.1.0` | 204 | *(success)* |

The `1.12.0.10` result proves it passes the **minimum** check and fails only the separate
"newer than the stored save" check (stored save was `1.12.1.0`). So the **deployed minimum is
exactly `1.12.0.10`**, matching the hard-coded literal in `api/endpoints.go:validateSystemVersion`.
The response text never states the minimum — the client cannot learn it from the API.

Two distinct version rules are in play, and only the second one moves:

1. `gameVersion` ≥ `1.12.0.10` (constant, redeployed with the server).
2. `gameVersion` ≥ the **stored save's** `gameVersion`, else
   `session out of date: existing version is greater`.

### 3.13 Round trip with a realistic save — `log/06h1-rich-update`, `log/06h2-rich-get`

Sent a 1,125-byte save containing a populated `dexData` entry (with `caughtAttr` as the string
`"34084861955"`, i.e. a value beyond 2^32), a `starterData` entry, `unlocks`, `achvUnlocks`,
`voucherUnlocks`, `voucherCounts`, one egg, non-zero `eggPity`/`unlockPity`, and an
`appliedMigrators` entry. → `204`.

`GET` returned 1,175 bytes. Structural diff (`sys-rich.json` vs `log/06h2-rich-get.b`):

```
starterMoveData:    sent=undefined  got=null
starterEggMoveData: sent=undefined  got=null
```

Everything else — including the big `caughtAttr` **string**, the `ivs` array, the egg object, the
migrator timestamp — is byte-identical in value. `gameStats` keys come back sorted alphabetically
(Go map marshalling), so the JSON **text** differs even though the object is equal. Compare
structurally, never by string.

### 3.14 Session slot get on an empty account — `log/07a-session-get-empty`

```
GET https://api.pokerogue.net/savedata/session/get?slot=0&clientSessionId=A
```
```
HTTP/1.1 404 Not Found

save does not exist
```

### 3.15 Session endpoints hijack the active session — `log/07b`

Immediately after the 404 above (which used `A`), a system update with `B` — which had been active
— returned:

```
HTTP/1.1 400 Bad Request

session out of date: not active
```

`handleSession` calls `db.Store.UpdateActiveSession(uuid, clientSessionId)` **unconditionally,
before dispatching the action**, so *any* `/savedata/session/*` call — including one that 404s —
takes over the active session.

### 3.16 Session update does NOT check the active session — `log/07c-session-update-B-inactive`

With `A` active, a write using the inactive `B`:

```
POST https://api.pokerogue.net/savedata/session/update?slot=0&clientSessionId=B
Content-Type: application/json
<sess-v1.json, 1000 bytes>
```
```
HTTP/1.1 200 OK
Content-Length: 0
```

**Accepted.** Session writes are not gated on being the active session (unlike system writes). Note
also the success status is **200**, not the system endpoint's **204**.

### 3.17 Session round trip is lossy — `log/07d-session-get-roundtrip`

Sent (`sess-v1.json`) included `playerFaints: 3` and a canary field `someUnknownFutureField`.
`GET` returned 964 bytes. Diff:

```
playerFaints:                                sent=3      got=undefined   ← DROPPED
someUnknownFutureField:                      sent="canary" got=undefined ← DROPPED
arena.tags:                                  sent=[]     got=null
challenges:                                  sent=[]     got=null
enemyModifiers:                              sent=[]     got=null
enemyParty:                                  sent=[]     got=null
modifiers:                                   sent=[]     got=null
mysteryEncounterSaveData.encounteredEvents:  sent=[]     got=null
mysteryEncounterSaveData.queuedEncounters:   sent=[]     got=null
party[0]:                                    key order only (values identical)
```

Cause, confirmed in source: the server decodes the body into `defs.SessionSaveData`
(`defs/savedata.go`) and gob-encodes **the struct** (`db/savedata.go:StoreSessionSaveData`), so any
JSON key absent from the Go struct is discarded at ingest. The client's `SessionSaveData`
(`src/@types/save-data.ts:44`) has `playerFaints`; the server struct does not. `dailyConfig` is
`omitempty` on the server and vanishes when absent.

### 3.18 Wave-index guard, and the seed hole — `log/07e`, `log/07f`, `log/07g`

| Step | Request | Result |
|---|---|---|
| advance | slot 0, seed `PROBESEED0001`, waveIndex 1 → **5** | `200 OK` |
| regress, same seed | slot 0, seed `PROBESEED0001`, waveIndex 5 → **1** | `400`, `session out of date: existing wave index is greater` |
| regress, different seed | slot 0, seed `DIFFERENTSEED9`, waveIndex **1** | **`200 OK`** — the wave-5 run was overwritten |

The guard is `existingSave.Seed == session.Seed && existingSave.WaveIndex > session.WaveIndex`. A
different seed disables it entirely. `playTime` is **not** validated on session saves at all
(120 → 300 → 50 all accepted).

### 3.19 Slot range — `log/07h-session-slot5`

```
GET …/savedata/session/get?slot=5&clientSessionId=B
```
```
HTTP/1.1 400 Bad Request
Content-Length: 19

slot id 5 out of range
```

Valid slots are `0..4` (`defs.SessionSlotCount = 5`).

### 3.20 Delete a session slot — `log/07j`, `log/07k`

`delete` is an **HTTP GET**, not DELETE (matches `session-savedata-api.ts:delete` using `doGet`):

```
GET https://api.pokerogue.net/savedata/session/delete?slot=0&clientSessionId=A
```
```
HTTP/1.1 200 OK
Content-Length: 0
```

A subsequent `session/get?slot=0` → `404 save does not exist`. Confirmed destructive and immediate;
there is no undo and no server-side history. (`clear` — the scoring/run-completion endpoint — and
`newclear` were **not** exercised: `clear` submits a run for daily-run scoring and has real
side-effects on leaderboards, which is out of scope for a save-sync wrapper.)

### 3.21 `updateall` — `log/08a`, `log/08b`, `log/08c`

```
POST https://api.pokerogue.net/savedata/updateall
Content-Type: application/json
{"system":{…playTime 1005…},"session":{…seed "UPDATEALLSEED", waveIndex 2…},
 "sessionSlotId":1,"clientSessionId":"sBpg16…"}
```
```
HTTP/1.1 200 OK
Content-Length: 0
```

Verified afterwards: `session/get?slot=1` returns the new session, and `system/get` returns
`gameStats.playTime = 1005`. So one request writes both. Caveats from source, relevant to the
design: `clientSessionId` goes in the **body**, not the query string; `updateall` **does** enforce
the active session (unlike the session endpoint); it applies the full system validation chain
(ids, playtime, version, migrators) plus the session wave-index guard; and it is explicitly
**not transactional** (`// TODO wrap this in a transaction`) — the session is written first, then
the system, so a failure between them leaves a session ahead of its system save.

### 3.22 `verify` — `log/09a-verify-stale`, `log/09b-verify-active`

With `B` active and a **stale** `A`:

```
GET https://api.pokerogue.net/savedata/system/verify?clientSessionId=A
```
```
HTTP/1.1 500 Internal Server Error
Content-Type: text/plain; charset=utf-8
Content-Length: 61
X-Content-Type-Options: nosniff

failed to read session save data: sql: no rows in result set
```

Immediately repeating the same call:

```
HTTP/1.1 200 OK

{"valid":true,"systemData":{"trainerId":0,"secretId":0,"gender":0,"dexData":null,
"starterData":null,"starterMoveData":null,"starterEggMoveData":null,"gameStats":null,
"unlocks":null,"achvUnlocks":null,"voucherUnlocks":null,"voucherCounts":null,"eggs":null,
"eggPity":null,"unlockPity":null,"gameVersion":"","timestamp":0,"appliedMigrators":null}}
```

Two findings:

1. **The stale-session branch of `verify` is broken in production.** Source expects
   `200 {"valid":false,"systemData":<the stored save>}`. Observed `500`. The likely cause is
   visible in the source: `savedata.GetSystem` reads from S3 when `S3_SYSTEM_BUCKET_NAME` is set,
   but the `verify` handler calls `db.Store.ReadSystemSaveData(uuid)` **directly**, bypassing the
   S3 path — so on the S3-backed deployment the MySQL row does not exist and the read errors. This
   also means the deployed server stores system saves in S3, not in the `systemSaveData` table.
2. **The side effect fires anyway.** `UpdateActiveSession` runs *before* the failing read, so the
   stale clientSessionId becomes active even though the caller gets a 500. The second call
   returning `valid:true` proves it.

`verify` on an already-active session returns `valid:true` with a **zero-value** `systemData` — not
the stored save. Do not read `systemData` unless `valid` is `false`.

### 3.23 Logout and token revocation — `log/10a`, `log/10b`, `log/10c`

```
GET https://api.pokerogue.net/account/logout
Authorization: f1cv1A…
```
```
HTTP/1.1 200 OK
Content-Length: 0
```

Reusing the same token afterwards:

```
GET /account/info            → 401  failed to validate token: sql: no rows in result set
GET /savedata/system/get?…   → 401  failed to validate token: sql: no rows in result set
```

Token revocation is immediate and total.

### 3.24 Active session survives token rotation — `log/12a`, `log/12b`

After logout, a fresh login returned a new token (`oaEAkA…`, also 44 chars). A system `update` with
`clientSessionId=A` — the id that was active before logout — then returned `204`. So the active
clientSessionId is stored **per account uuid**, not per token, and logging out does not clear it.

---

## 4. Rate limiting, Cloudflare, CORS, anti-bot (step 11)

**Everything is behind Cloudflare** (`Server: cloudflare`, `CF-RAY` on every response, including
error pages). Observations from 43 API requests at roughly 1 request every 1.5–3 s:

- **No rate-limit signalling of any kind.** No `RateLimit-Limit`, `RateLimit-Remaining`,
  `Retry-After`, `X-RateLimit-*` on any response, success or error. No `429` was seen. That does
  **not** mean there is no limit — it means a client gets no advance warning and must treat `429`
  and `403` as possible at any time.
- **`Origin: https://pokerogue.net` is effectively mandatory.** This is the single most important
  undocumented finding. Three controlled requests:

  | Request | Result |
  |---|---|
  | valid token + `Origin: https://pokerogue.net` | `200` |
  | valid token, **no `Origin` header** | **`403` Cloudflare block page** ("Sorry, you have been blocked … the action you just performed triggered the security solution") |
  | **no token** + `Origin: https://pokerogue.net` | clean `401 missing token` from the app |

  An `OPTIONS` preflight with `Origin: file://` was likewise `403`-blocked. The block is the
  Cloudflare WAF, not the Go server (it returns an HTML interstitial with a `CF-RAY` and a
  challenge-platform script, and the app's own errors are always `text/plain`).
- **CORS is locked to one origin.** `Access-Control-Allow-Origin` is the literal
  `https://pokerogue.net`, never reflected. `Access-Control-Allow-Headers` is exactly
  `Content-Type, Authorization, Pkr-Client-Version`; `Access-Control-Allow-Methods` is
  `OPTIONS, GET, POST`. Any renderer/page on another origin (`file://`, `app://`, a local dev
  server) cannot call this API from browser `fetch`.
- **No JS challenge or CAPTCHA** was ever presented to a correctly-shaped request. `cf-cache-status`
  was `DYNAMIC` on every API call — nothing is cached.
- `PKR-Client-Version` is **not** enforced: omitting it and sending `1.0.0` both returned `200`.
  It is nonetheless in the allow-listed CORS headers and should be sent to look like the client.
- The static site is separately cached (`cf-cache-status: HIT`, `Age: 1716797` on `/`), so the
  game bundle and the API are different Cloudflare configurations.

---

## 5. Implications for the sync design

Ordered by how much each one threatens the "never lose progress" requirement.

1. **`Origin: https://pokerogue.net` must be on every API request, or Cloudflare 403s it.** This is
   not in either source repo; it was only visible live. A valid token without `Origin` is blocked
   with an HTML interstitial, *not* a JSON/text API error. Two consequences: (a) the sync client
   must set the header explicitly (Node/Electron main-process `fetch` or `net.request`, which does
   not set `Origin` by itself — a browser would); (b) the sync client must **not** run from a
   renderer on a non-`pokerogue.net` origin using plain `fetch`, because `Access-Control-Allow-Origin`
   is hard-coded to `https://pokerogue.net` and CORS will block the response even if the request
   reaches the server. Do the sync in the Electron **main** process.
   Also: the wrapper must be able to tell a Cloudflare 403 HTML page apart from an application
   error. Rule: if `Content-Type` is `text/html`, it is Cloudflare, not the game server — treat it
   as "network unavailable" and retry later, never as "the save was rejected".

2. **Equal `playTime` is accepted and overwrites the stored save.** The guard is strictly
   `new < old`. So a save taken from the account, carried offline, and uploaded again without ever
   being played still passes — as does an offline save whose play time merely *caught up* to the
   online one. The server offers no protection against two divergent saves at the same play time.
   The wrapper must do its own comparison before uploading: refuse to push unless the outgoing save
   is a strict descendant of what is currently stored (compare `playTime`, `timestamp`, and
   monotone counters like `gameStats.battles`/`pokemonCaught`/`pokemonSeen`), and take a local
   backup of the stored save (via the game's `.prsv` export format) *before* every push.

3. **`session/update` is not gated on the active clientSessionId, but `system/update` is.** A stale
   client can silently overwrite a session slot while being unable to touch the system save. That
   asymmetry means the wrapper can end up pushing an offline run into a slot that the online game
   has since moved on from, with no error. Any session push must be preceded by a `session/get` of
   that slot and an explicit comparison — the server will not stop it.

4. **The session wave-index guard is bypassed by a different `seed`.** `waveIndex 1` overwrote a
   stored `waveIndex 5` simply because the seed differed. An offline run started fresh will always
   have a different seed from whatever is online, so the server's only session-level protection
   does not apply to this project's main case. Treat session slots as unprotected: never push a
   session slot without first reading it and confirming the wrapper is not discarding a run the
   user still wants. Prefer pushing into a slot that is empty or that holds the same seed.

5. **Session saves do not round-trip losslessly.** `playerFaints` — a real field of the current
   client's `SessionSaveData` — is **silently dropped**, because the server's Go struct predates it.
   So is any field the server does not know, and every empty array comes back as `null`. A
   round-tripped run is therefore *not* byte-identical to the one that was uploaded. Consequences:
   the wrapper must (a) never use "upload then download and compare" as its integrity check for
   sessions — it will always differ; (b) keep the pre-upload local copy as the authoritative
   backup; (c) normalise `null` → `[]` when feeding a downloaded session back into an offline
   client, or the offline game may choke on `challenges: null` / `modifiers: null`.
   System saves are effectively lossless (only two legacy `null` fields are added), so a
   structural equality check *is* valid for the system save — but it must be structural, not
   string-based, since `gameStats` keys come back alphabetised.

6. **Version gating is a two-sided trap, and it is the biggest structural risk to this project.**
   Confirmed live: the minimum is exactly `1.12.0.10`, *and* a save whose `gameVersion` is lower
   than the stored save's is rejected with `existing version is greater`. The offline build from
   `Admiral-Billy/pokerogue` tracks upstream releases with a lag. If the user opens the online game
   once after an upstream release, the stored save's `gameVersion` moves up, and **the offline
   build can no longer upload at all** until it is rebuilt — the offline progress is stranded on
   the laptop, not lost, but not syncable either. The wrapper must (a) compare the offline build's
   version against the stored save's `gameVersion` *before* the user plays offline and warn/ update
   then, not after the flight; (b) when a push fails on either version error, fall back to writing
   a `.prsv` export the user can import by hand, and say so in non-technical language; (c) never
   silently retry forever. Note the server never tells the client what the minimum is — it is a
   hard-coded literal that moves with server deploys.

7. **Exactly one `clientSessionId` is active per account, last writer wins, and *any*
   `/savedata/session/*` call claims it — even a 404.** Confirmed: a `session/get` that returned
   `save does not exist` still evicted the other id. And the active id **survives logout and
   re-login** — it is keyed on the account, not the token. Practical rule for the wrapper: generate
   **one** `clientSessionId` per sync operation, do a `system/get` (or `session/get`) to claim it,
   and complete the whole push before anything else touches the account. If the user has the online
   game open in a browser tab, either side can evict the other at any moment. The wrapper should
   do its sync in one tight sequence and re-claim (`system/get`) and re-check if a
   `session out of date: not active` comes back, rather than assuming it still owns the session.

8. **`/savedata/system/verify` is broken on the live deployment — do not rely on it.** Source says
   it returns `{valid:false, systemData:<stored save>}` for a stale session; live it returns a
   `500` with `failed to read session save data: sql: no rows in result set`, because the handler
   reads MySQL directly while the deployment stores system saves in S3. It *still* steals the
   active session as a side effect before failing. So: (a) never use `verify` to fetch the server's
   save — use `system/get`; (b) if the wrapper calls it at all (the stock client does, at startup),
   expect a `500` and do not surface it as an error; (c) be aware that calling it re-points the
   active session.

9. **`updateall` works but is not atomic.** One `POST /savedata/updateall` writes system + one
   session slot, enforces the active session (via a `clientSessionId` field in the **body**), and
   applies the full validation chain. But the source carries `// TODO wrap this in a transaction`
   and writes the session *before* the system. A failure in between leaves a session slot ahead of
   its system save. For a sync whose whole point is not losing progress, prefer the explicit
   sequence — `system/get` (claim) → `system/update` → `session/update` per slot — so each step's
   failure is individually observable, and use `updateall` only if a single atomic-looking call is
   needed for speed.

10. **Success statuses are inconsistent; empty bodies are not a success signal.** `system/update` →
    `204`, `session/update` → `200`, `updateall` → `200`, `register` → `200`, `session/delete` →
    `200`, all with empty bodies. Meanwhile every rejection is a `400`/`401`/`404` with a
    `text/plain` body. The stock client's pattern of returning `await response.text()` as "the
    error message" means a failed call and a successful one both yield `""` if the status is
    ignored. The wrapper must branch on `response.status`, never on body emptiness.

11. **Error strings are the only machine-readable signal, and they are prose.** The full set
    observed: `save does not exist`, `session out of date: not active`,
    `session out of date: existing playtime is greater`,
    `session out of date: stored trainer or secret ID does not match`,
    `session out of date: save version below minimum game version`,
    `session out of date: existing version is greater`,
    `session out of date: existing wave index is greater`, `slot id 5 out of range`,
    `missing token`, `failed to validate token: sql: no rows in result set`. There are no error
    codes. Match on these substrings, but always have a default branch that fails safe (keep the
    local save, do not delete anything).

12. **`trainerId`/`secretId` bind to the account on first write and are immutable.** For this
    project the account already has them, so the offline save must carry the *same* pair or every
    push is rejected with `stored trainer or secret ID does not match`. The offline `data_Guest`
    save created by a `VITE_BYPASS_LOGIN=1` build will have its **own** randomly generated pair —
    so a fresh offline profile can never be pushed to the account as-is. The sync design must
    **seed the offline profile from the account's downloaded save** rather than let the offline
    build generate a new one; a "start offline from scratch and merge later" path does not exist.

13. **Minor confirmations worth recording.** `lastSessionSlot: -1` is the empty-account sentinel.
    Valid session slots are `0..4`; slot `5` → `400 slot id 5 out of range`. `session/delete` is an
    HTTP **GET** and is immediate and irreversible. Login returns the token **only** in the JSON
    body — there is no `Set-Cookie`, so a wrapper that expects a cookie jar will find it empty;
    the token is 44 base64 chars (32 bytes) and is sent as the raw `Authorization` value with no
    `Bearer` prefix. Usernames must match `^\w{1,16}$` and passwords must be ≥ 6 characters.
    `PKR-Client-Version` is accepted but not enforced.
