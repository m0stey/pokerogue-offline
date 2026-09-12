# Verification: rogueserver (PokeRogue backend) against BRIEF.md

**Target:** `pagefaultgames/rogueserver`, shallow clone at `C:\dev\pokerogue-offline\upstream\rogueserver`
**HEAD:** `c7fed19ee566ebc93f72cc2ff5893443c933af55` — *"feat: Add tid/sid validation to system save update endpoint (#83)"*, Tue Aug 18 17:00:53 2026 -0500
**Method:** source read only. Nothing was executed against a live server, and nothing in `upstream/` was modified.
**Caveat that applies to every line below:** this is the public repo. The deployed `api.pokerogue.net` may run different code and certainly sits behind a reverse proxy / CDN that adds limits this repo does not contain.

---

## Summary table

| # | Claim | Verdict | Primary evidence |
|---|---|---|---|
| 1 | One system save + up to 5 session slots | **CONFIRMED** | `defs/savedata.go:20`, `db/db_setup.go:105-129`, `db/savedata.go:55-181` |
| 2 | `system/get?clientSessionId=X` makes X active; `update` requires active | **CONFIRMED, with a major addition** — session-slot endpoints do *not* check the active session, they **silently seize** it | `api/endpoints.go:475-521`, `api/endpoints.go:275-284`, `db/account.go:361-387` |
| 3 | Rejects lower playtime / tid-sid mismatch / version below min / desynced migrators | **CONFIRMED + CHANGED** — min version is now `1.12.0.10`, a 5th rule ("existing version is greater") exists, and tid/sid checking is brand new (it *is* this HEAD commit) | `api/endpoints.go:73-138`, `api/savedata/utils.go:31-39` |
| 4 | `gameStats.playTime` never decreases; server enforces it | **CONFIRMED** — strict `<`, equality is allowed | `api/endpoints.go:107-109` |
| 5 | Auth format, token life, account endpoints | **CONFIRMED** — raw base64 of 32 bytes in `Authorization`, no `Bearer`; nominal 1-week expiry that **is never enforced on read**; no rate limits, no captcha; username `^\w{1,16}$` | `api/common.go:80-95`, `api/account/*.go`, `db/account.go:30-40,389-397` |
| 6 | Session slot endpoint list & validation | **CONFIRMED + CHANGED** — `get/update/clear/newclear/delete`; update checks **only** seed+waveIndex, **no** playtime/version/tid-sid; `clear` **deletes the slot** | `api/endpoints.go:257-369`, `api/savedata/clear.go:43-85` |
| 7 | Combined `updateall` endpoint | **CONFIRMED** — `POST /savedata/updateall`, same system validation as `system/update`, **not transactional** | `api/endpoints.go:371-461` |
| 8 | Other sync-client constraints | See §8 — no body-size cap, no gzip, no content-type check on save endpoints, prod CORS locked to `gameurl`, plain-text error bodies, and a **score ≥ 20000 daily clear auto-bans the account** | `rogueserver.go:133-146`, `api/savedata/clear.go:62-64` |
| 9 | Full route list | See §9 — 20 routes | `api/common.go:32-78` |

---

## 1. Storage layer and the slot limit — CONFIRMED

**Slot limit constant** — `defs/savedata.go:20`:

```go
const SessionSlotCount = 5
```

It is the only slot bound in the codebase, referenced at `api/endpoints.go:270`, `api/savedata/update.go:48`, `api/savedata/clear.go:50`, `api/savedata/newclear.go:33`, `api/savedata/delete.go:43`. Valid slots are therefore `0..4`.

**System save** — exactly one row per account. `db/db_setup.go:123-128`:

```sql
CREATE TABLE IF NOT EXISTS systemSaveData (
       uuid BINARY(16) PRIMARY KEY,
       data LONGBLOB,
       timestamp TIMESTAMP,
       FOREIGN KEY (uuid) REFERENCES accounts (uuid) ON DELETE CASCADE ON UPDATE CASCADE
)
```

`data` is **gob-encoded then zstd-compressed**, not JSON (`db/savedata.go:79-103` write, `55-77` read). Writes use `REPLACE INTO`, so a system update is a full overwrite — there is no merge anywhere on the server.

**Alternate system-save backend:** if the env var `S3_SYSTEM_BUCKET_NAME` is set, the system save is stored in S3 as **plain JSON keyed by username** instead of in MySQL (`api/savedata/system.go:41-52`, `77-81`; `db/s3.go:17-61`). The `systemSaveData` table is then not even created (`db/db_setup.go:122`). Production may well use this path.

**Session saves** — up to 5 rows per account, keyed by slot. `db/db_setup.go:105-112`:

```sql
CREATE TABLE IF NOT EXISTS sessionSaveData (
       uuid BINARY(16),
       slot TINYINT,
       data LONGBLOB,
       timestamp TIMESTAMP,
       PRIMARY KEY (uuid, slot),
       FOREIGN KEY (uuid) REFERENCES accounts (uuid) ON DELETE CASCADE ON UPDATE CASCADE
)
```

Same gob+zstd encoding, same `REPLACE INTO` overwrite (`db/savedata.go:148-172`).

**What "system save" contains** — `defs/savedata.go:22-41`: `trainerId`, `secretId`, `gender`, `dexData`, `starterData`, legacy `starterMoveData`/`starterEggMoveData`, `gameStats`, `unlocks`, `achvUnlocks`, `voucherUnlocks`, `voucherCounts`, `eggs`, `eggPity`, `unlockPity`, `gameVersion`, `timestamp`, `appliedMigrators`. So dex/unlocks/eggs/stats: confirmed.

**Derived / denormalised state also written on a system update.** `UpdateSystem` first calls `UpdateAccountStats` (`api/savedata/system.go:72`), which fans `gameStats` and `voucherCounts` out into scalar columns on `accountStats` (`db/account.go:248-323`; columns listed at `db/account.go:249` and `db/db_setup.go:56-74`). These power the title-screen stats and are **not** read back into the save. Note `db/account.go:254-263`: if `gameStats` is not a `map[string]interface{}` of `float64` values it returns an error → the whole update 500s.

Other tables that matter to a sync client: `accounts` (holds `trainerId`, `secretId`, `banned`, `lastActivity`), `sessions` (auth tokens), `activeClientSessions` (the active-session lock, see §2), `dailyRuns` / `dailyRunCompletions` / `accountDailyRuns`.

---

## 2. The active client session — CONFIRMED, with a serious addition

### How it is stored

One row per account, overwritten in place. `db/db_setup.go:114-118`:

```sql
CREATE TABLE IF NOT EXISTS activeClientSessions (
       uuid BINARY(16) NOT NULL PRIMARY KEY,
       clientSessionId VARCHAR(32) NOT NULL,
       FOREIGN KEY (uuid) REFERENCES accounts (uuid) ON DELETE CASCADE ON UPDATE CASCADE
)
```

Note `VARCHAR(32)` — a longer `clientSessionId` will be truncated or rejected depending on MySQL strict mode. The game sends a UUID-shaped value here; worth measuring against the live server rather than assuming it fits.

`db/account.go:380-387`:

```go
func (s *store) UpdateActiveSession(uuid []byte, clientSessionId string) error {
	_, err := handle.Exec("INSERT INTO activeClientSessions (uuid, clientSessionId) VALUES (?, ?) ON DUPLICATE KEY UPDATE clientSessionId = ?", uuid, clientSessionId, clientSessionId)
```

`db/account.go:361-378`:

```go
func (s *store) IsActiveSession(uuid []byte, sessionId string) (bool, error) {
	var id string
	err := handle.QueryRow("SELECT clientSessionId FROM activeClientSessions WHERE uuid = ?", uuid).Scan(&id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = s.UpdateActiveSession(uuid, sessionId)
			...
			return true, nil
		}
		return false, err
	}
	return id == "" || id == sessionId, nil
}
```

Two consequences: **(a)** merely *asking* whether you are active claims the lock if no row exists yet; **(b)** an empty stored value means "everyone is active".

### Which endpoints set it, and which check it

| Endpoint | Checks active? | Sets active? | Line |
|---|---|---|---|
| `/savedata/system/get` | reads it, but does not enforce | **yes, if not already active** | `api/endpoints.go:480, 488-494` |
| `/savedata/system/update` | **yes — rejects** | no | `api/endpoints.go:517-521` |
| `/savedata/system/verify` | reads it, reports it | **yes, if not active** — and returns the server's save | `api/endpoints.go:562-584` |
| `/savedata/system/delete` | **no** | no | `api/endpoints.go:585-592` |
| `/savedata/session/*` (all actions) | **no** | **yes, unconditionally — every call seizes the lock** | `api/endpoints.go:275-284` |
| `POST /savedata/updateall` | **yes — rejects** | no | `api/endpoints.go:393-407` |

`api/endpoints.go:486-494` (the `get` case):

```go
	case "get":
		if !active {
			err = db.Store.UpdateActiveSession(uuid, r.URL.Query().Get("clientSessionId"))
```

`api/endpoints.go:517-521` (the `update` case):

```go
	case "update":
		if !active {
			httpError(w, r, fmt.Errorf("session out of date: not active"), http.StatusBadRequest)
			return
		}
```

**The claim is confirmed**, but the brief's model is incomplete in a way that matters for us:

`api/endpoints.go:275-284`, the shared preamble for **every** `/savedata/session/*` action:

```go
	if !r.URL.Query().Has("clientSessionId") {
		httpError(w, r, fmt.Errorf("missing clientSessionId"), http.StatusBadRequest)
		return
	}

	err = db.Store.UpdateActiveSession(uuid, r.URL.Query().Get("clientSessionId"))
	if err != nil {
		httpError(w, r, fmt.Errorf("failed to update active session: %s", err), http.StatusBadRequest)
		return
	}
```

There is no `IsActiveSession` call in `handleSession` at all. So a session-slot read — even a harmless `GET /savedata/session/get` — **unconditionally takes the active-session lock away from whoever held it**. If our sync client polls a session slot while the game is open in a browser tab, the *game's* next `system/update` fails with "session out of date: not active" and the game will typically prompt the user or refuse to save. This is the single most dangerous interaction for a background sync daemon and it is not visible from the `system` endpoints alone.

Corollary in the other direction: our client can always *become* active by calling `system/get` or `system/verify` first, then immediately `system/update` or `updateall`. There is no lease, TTL, or contention detection — last writer to touch it wins.

### Error response when not active

`api/common.go:120-123`:

```go
func httpError(w http.ResponseWriter, r *http.Request, err error, code int) {
	log.Printf("%s: %s\n", r.URL.Path, err)
	http.Error(w, err.Error(), code)
}
```

So: **HTTP 400 Bad Request**, `Content-Type: text/plain; charset=utf-8`, body is the literal string `session out of date: not active` followed by a newline. Every error in this server is plain text, never JSON — a client that assumes JSON error bodies will misparse all of them.

---

## 3. Update rejection rules — CONFIRMED, plus one rule the brief does not list

All of these run for `system/update` (`api/endpoints.go:530-553`) and `updateall` (`api/endpoints.go:409-433`). They are declared as sentinel errors at `api/endpoints.go:40-58`.

**Crucial scoping detail:** playtime, version and migrator validation are **entirely skipped when no system save exists yet** — `api/endpoints.go:536-542`:

```go
		oldSystem, err := savedata.GetSystem(db.Store, uuid)
		if err != nil {
			if !errors.Is(err, savedata.ErrSaveNotExist) {
				httpError(w, r, fmt.Errorf("failed to retrieve playtime: %s", err), http.StatusInternalServerError)
				return
			}
		} else {
			err = validatePlaytime(system, oldSystem)
			...
			err = validateSystemVersion(system, oldSystem)
```

A fresh account accepts literally any system save. tid/sid validation is the exception — it runs first and always.

### 3a. tid/sid mismatch → 400

`api/endpoints.go:73-90`:

```go
func validateOrCreateIds(uuid []byte, systemData defs.SystemSaveData) (int, error) {
	storedTrainerId, storedSecretId, err := db.Store.FetchTrainerIds(uuid)
	if err != nil {
		return http.StatusInternalServerError, err
	}

	if storedTrainerId > 0 || storedSecretId > 0 {
		if systemData.TrainerId != storedTrainerId || systemData.SecretId != storedSecretId {
			return http.StatusBadRequest, ErrIdMismatch
		}
	} else {
		err = db.Store.UpdateTrainerIds(systemData.TrainerId, systemData.SecretId, uuid)
```

- **Status:** 400. **Body:** `session out of date: stored trainer or secret ID does not match\n` (`api/endpoints.go:43`).
- If the account has never had IDs recorded (both columns 0, the default per `db/db_setup.go:41-42`), the server **adopts whatever the client sends** — trust on first use.
- Columns are `SMALLINT(5) UNSIGNED`, i.e. `0..65535`.
- **This is new.** It is literally the HEAD commit (`c7fed19`, "Add tid/sid validation to system save update endpoint"). Older deployed code may not have it. The practical impact on us: the offline save must carry the *same* trainerId/secretId as the online account. The `VITE_BYPASS_LOGIN=1` guest save generates its own random tid/sid, so a naive "upload the guest save" will be rejected with this error. Any sync design has to rewrite tid/sid (or seed the offline save from the online one) before uploading.

### 3b. Lower playtime → 400

`api/endpoints.go:96-111` — full text quoted under §4.
- **Status:** 400. **Body:** `session out of date: existing playtime is greater\n` (`api/endpoints.go:46`).
- If `playTime` cannot be read as a number from either save: **400**, body `no playtime found\n` (`api/endpoints.go:40`).

### 3c. Save version below minimum → 400

`api/endpoints.go:116-123`:

```go
func validateSystemVersion(systemData defs.SystemSaveData, oldSystem defs.SystemSaveData) error {
	minVerCmp, err := savedata.CompareGameVersion("1.12.0.10", systemData.GameVersion)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrVersionCompare, err)
	}
	if minVerCmp > 0 {
		return ErrVersionTooLow
	}
```

- **Current minimum version constant: `1.12.0.10`.** It is a hard-coded string literal, not a named constant, and it appears twice: `api/endpoints.go:117` (validation) and `api/endpoints.go:507` (the `get` fixup below).
- **Status:** 400. **Body:** `session out of date: save version below minimum game version\n` (`api/endpoints.go:49`).
- A malformed/missing `gameVersion` yields 400 with `failed to compare versions: invalid version format: "..."` or `... invalid version component "x" in "..."`.

Version comparison semantics — `api/savedata/utils.go:12-71`: the string is split on `.`, must have **3 or 4** numeric components, trailing zeros are trimmed, then compared lexicographically as an int slice. So `1.12.0` == `1.12.0.0`, and `1.12.0.10` > `1.12.0.9`. A two-component or five-component version is an error.

### 3d. Existing version greater → 400 — **a rule the brief does not mention**

`api/endpoints.go:125-131`:

```go
	saveVerCmp, err := savedata.CompareGameVersion(oldSystem.GameVersion, systemData.GameVersion)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrVersionCompare, err)
	}
	if saveVerCmp > 0 {
		return ErrExistingVersionGreater
	}
```

- **Status:** 400. **Body:** `session out of date: existing version is greater\n` (`api/endpoints.go:52`).
- Direct consequence for us: **the offline build's game version must be ≥ the version already stored on the account.** If the user plays online on a newer release and then the offline bundle is an older build, the offline save can never be uploaded. The offline `game.zip` version therefore has to be kept at or ahead of what the online account last wrote — this is a hard sync precondition, not a nicety.

### 3e. Desynced migrators → 400 — what it concretely checks

`api/endpoints.go:133-135`:

```go
	if !savedata.ValidMigrators(systemData.AppliedMigrators, oldSystem.AppliedMigrators) {
		return ErrMigratorsDesynced
	}
```

`api/savedata/utils.go:30-39`:

```go
// Confirm that every migrator existing in the old save exists in the new save with identical timestamp
func ValidMigrators(new map[string]int, old map[string]int) bool {
	for migrator, timestamp := range old {
		newTimestamp := new[migrator]
		if newTimestamp != timestamp {
			return false
		}
	}
	return true
}
```

`appliedMigrators` is `map[string]int` (`defs/savedata.go:40`) — migrator name → the timestamp at which the client applied it. Keys look like `1.12.0.10-removeInvalidStarterAndDexData` (see `api/endpoints.go:512`).

Concretely, the check is **one-directional containment with exact value equality**:
- Every key present in the **server's stored** save must be present in the **incoming** save with a **bit-identical int value**. A missing key reads as `0` from the Go map and fails.
- The incoming save **may** add keys the server has never seen. New migrators are fine; forgetting or altering an old one is not.
- **Status:** 400. **Body:** `session out of date: migrators desynced\n` (`api/endpoints.go:58`).

For us this means the offline client must round-trip `appliedMigrators` byte-for-byte from whatever the server last held. If the offline build's migration code re-runs a migrator and re-stamps its timestamp, every subsequent upload is permanently rejected. Any save we construct for upload should copy `appliedMigrators` from a fresh `system/get` and then union in only genuinely new keys.

### 3f. A related asymmetry on `get`

`api/endpoints.go:507-514`:

```go
		versionCmp, cmpErr := savedata.CompareGameVersion("1.12.0.10", save.GameVersion)
		...
		if versionCmp == 1 && save.AppliedMigrators["1.12.0.10-removeInvalidStarterAndDexData"] > 0 {
			save.GameVersion = "1.12.0.10"
		}
```

On read, a save that is below the minimum version but has already run that specific migrator is **reported to the client with its `gameVersion` rewritten to `1.12.0.10`**. So `system/get` can return a version that is not what is stored. A sync client that snapshots `gameVersion` from a `get` and later diffs it against a local copy will see a phantom change.

---

## 4. playTime monotonicity — CONFIRMED, strict less-than

`api/endpoints.go:96-111`:

```go
func validatePlaytime(systemData defs.SystemSaveData, oldSystem defs.SystemSaveData) error {
	playtime, ok := systemData.GameStats.(map[string]interface{})["playTime"].(float64)
	if !ok {
		return ErrNoPlaytime
	}

	oldPlaytime, ok := oldSystem.GameStats.(map[string]interface{})["playTime"].(float64)
	if !ok {
		return ErrNoPlaytime
	}

	if playtime < oldPlaytime {
		return ErrGreaterPlaytime
	}
	return nil
}
```

**The comparison is strict `<` at line 107. Equal playtime is accepted.** That is load-bearing for us: it means a save can be re-uploaded idempotently, and it means a merged save only needs `playTime >= server` — not strictly greater — to be accepted. It also means playTime alone cannot be used by the server to detect that a save went backwards in *content* while playtime stayed level.

**Latent crash worth knowing about.** The inner assertion `systemData.GameStats.(map[string]interface{})` on lines 97 and 102 is the *single-value* form, which **panics** rather than returning false. `GameStats` is declared `interface{}` (`defs/savedata.go:73`), so a request whose JSON omits `gameStats`, or sets it to `null`, a string, or an array, decodes to something that is not a `map[string]interface{}` and panics in the handler goroutine. Go's `net/http` recovers it, but the client sees a dropped connection or an empty 500. The `ok` on those lines only guards the `.(float64)` on the *value*, which is why `ErrNoPlaytime` fires for a present-but-non-numeric `playTime` and not for a missing `gameStats` object. Our client must always send a well-formed `gameStats` object; a defensive precondition check before upload is cheap insurance.

---

## 5. Auth — CONFIRMED

### Header parsing

`api/common.go:80-95`:

```go
func tokenFromRequest(r *http.Request) ([]byte, error) {
	if r.Header.Get("Authorization") == "" {
		return nil, fmt.Errorf("missing token")
	}

	token, err := base64.StdEncoding.DecodeString(r.Header.Get("Authorization"))
	if err != nil {
		return nil, fmt.Errorf("failed to decode token: %s", err)
	}

	if len(token) != account.TokenSize {
		return nil, fmt.Errorf("invalid token length: got %d, expected %d", len(token), account.TokenSize)
	}

	return token, nil
}
```

- The header value is the **raw token, with no `Bearer ` prefix and no scheme**. Adding one breaks it.
- Encoding is **standard** base64 (`+`/`/`, `=` padding), not URL-safe. `TokenSize = 32` (`api/account/common.go:39`), so a valid header is a 44-character base64 string decoding to exactly 32 bytes.
- This matches the brief's "the auth header is the raw `pokerogue_sessionId` cookie value" — the cookie set at `api/endpoints.go:739-747` carries exactly this base64 string.

`api/common.go:106-118` then resolves it: `db.Store.FetchUUIDFromToken(token)` → `SELECT uuid FROM sessions WHERE token = ?` (`db/account.go:389-397`). Failure produces `failed to validate token: sql: no rows in result set` at **401** for save endpoints.

### Token lifetime

`db/db_setup.go:48-53`:

```sql
CREATE TABLE IF NOT EXISTS sessions (
       token BINARY(32) NOT NULL PRIMARY KEY,
       uuid BINARY(16) NOT NULL,
       expire TIMESTAMP DEFAULT NULL,
       ...
)
```

`db/account.go:30-40` sets it on login:

```go
	_, err := handle.Exec("INSERT INTO sessions (uuid, token, expire) SELECT a.uuid, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 WEEK) FROM accounts a WHERE a.username = ?", token, username)
```

**Nominal lifetime: 1 week.** But `FetchUUIDFromToken` (`db/account.go:389-397`) does **not** filter on `expire`, and nothing in this repository deletes expired rows — no cron entry in `api/stats.go:33-49` or `api/daily/common.go:71-85` touches `sessions`. So as the code stands, **tokens do not actually expire**; the column is decorative. Production may run an external reaper. Design for re-login on 401 regardless, and do not assume a token survives a week.

The OAuth cookie is a separate, longer-lived artifact — `api/endpoints.go:739-747`:

```go
		http.SetCookie(w, &http.Cookie{
			Name:     "pokerogue_sessionId",
			Value:    sessionToken,
			Path:     "/",
			Secure:   true,
			SameSite: http.SameSiteStrictMode,
			Domain:   "pokerogue.net",
			Expires:  time.Now().Add(time.Hour * 24 * 30 * 3), // 3 months
		})
```

Tokens are also invalidated wholesale on password change: `ChangePW` calls `RemoveSessionsFromUUID` (`api/account/changepw.go:42`), deleting every session for the account.

### The account endpoints

| Endpoint | Method | Accepts | Returns on success | Returns on failure |
|---|---|---|---|---|
| `/account/register` | POST | form-encoded `username`, `password` (`api/endpoints.go:178`, via `r.PostFormValue`) | **200**, empty body (`api/endpoints.go:184`) | **500** + plain text (`api/endpoints.go:180`) |
| `/account/login` | POST | form-encoded `username`, `password` | **200** JSON `{"token":"<base64>"}` (`api/account/login.go:29`, `api/account/common.go:27-29`) | **500** + plain text |
| `/account/logout` | GET | `Authorization` header only | **200**, empty body | **400** if the header is missing/malformed; **401** if removal fails (`api/endpoints.go:226-241`) |
| `/account/info` | GET | `Authorization` header | **200** JSON `{username, discordId, googleId, lastSessionSlot, hasAdminRole}` (`api/account/info.go:20-26`) | **401** no/bad token; **500** on DB error |
| `/account/changepw` | POST | `Authorization` + form `password` | **200** JSON `{"token":"..."}` — a *fresh* token, all old ones invalidated | **401** / **500** |

Notes that bite:
- **Register and login return 500, not 400 or 401, for user error.** `api/endpoints.go:177-185` and `187-195` funnel every `error` into `http.StatusInternalServerError`. A duplicate username, a bad password, a nonexistent account — all 500 with a plain-text body like `account doesn't exist` or `password doesn't match`. Our client must read the body string, not the status, to tell "wrong password" from "server is down". That is an unpleasant distinction to get wrong in a tool whose whole job is not losing data.
- `Logout` (`api/account/logout.go:33-44`) issues `DELETE FROM sessions WHERE token = ?`; deleting zero rows is not an error, so logging out with a stale token still returns 200.
- `lastSessionSlot` is `-1` when the account has no session saves — `GetLatestSessionSaveDataSlot` returns `-1` on error (`db/account.go:138-146`) and `Info` swallows the error (`api/account/info.go:34`).

### Rate limits, captchas, username rules

- **No rate limiting anywhere.** `grep` for `MaxBytesReader|ratelimit|RateLimit|limiter` across all `.go`/`.yml`/`.yaml`/`.conf` files returns nothing.
- **No captcha.** Same grep, no hits for `captcha`.
- **Username rule** — `api/account/common.go:45`:

```go
	isValidUsername = regexp.MustCompile(`^\w{1,16}$`).MatchString
```

  1–16 characters of `[A-Za-z0-9_]`. Enforced on both register (`api/account/register.go:32`) and login (`api/account/login.go:41`). The DB column agrees: `username VARCHAR(16) UNIQUE NOT NULL` (`db/db_setup.go:34`).
- **Password rule:** `len(password) < 6` is rejected (`api/account/register.go:36`, `api/account/login.go:45`, `api/account/changepw.go:32`). That is a length check on the raw string, no complexity requirement. The client hashes client-side in some versions, so "password" here may already be a hex digest.
- The only throttle in the whole server is a concurrency semaphore around Argon2id, sized to `runtime.NumCPU()` — `api/account/common.go:43,46,52-56`. Argon2id is configured at 256 MiB per derivation (`ArgonMemory = 256 * 1024`, `api/account/common.go:33`), so logins are intentionally expensive. A sync client should log in **once** and cache the token, never per-request.

---

## 6. Session slot endpoints — CONFIRMED, with important gaps in validation

The route is a single wildcard handler: `mux.HandleFunc("/savedata/session/{action}", handleSession)` (`api/common.go:55`). **No method is specified**, so under Go 1.22+ `ServeMux` this matches GET, POST, PUT, DELETE — anything. The action is the last path segment.

### Shared preamble, applied to every action — `api/endpoints.go:257-284`

1. `uuidFromRequest` → **401** on missing/invalid `Authorization`.
2. `slot` **query parameter, required**, must parse as an integer → **400** with Go's `strconv` error text (e.g. `strconv.Atoi: parsing "": invalid syntax`) if absent or non-numeric.
3. `slot < 0 || slot >= 5` → **400**, body `slot id %d out of range` (`api/endpoints.go:270-273`).
4. `clientSessionId` query parameter must be **present** (value may be empty) → **400**, body `missing clientSessionId` (`api/endpoints.go:275-278`).
5. `UpdateActiveSession(uuid, clientSessionId)` — **unconditional seizure of the active-session lock**, see §2. **400** on DB error.

### The actions

| Action | Body | Validation beyond the preamble | Success response |
|---|---|---|---|
| `get` | none | — | **200** JSON `SessionSaveData`; **404** body `save does not exist` if the slot is empty (`api/endpoints.go:287-299`) |
| `update` | JSON `SessionSaveData` | **only** the wave-index rule below | **200**, empty body (`api/endpoints.go:327`) |
| `clear` | JSON `SessionSaveData` | none | **200** JSON `{"success":bool,"error":string}` (`api/savedata/clear.go:27-30`) |
| `newclear` | none | — | **200** JSON bool; **500** if the slot is empty (`api/endpoints.go:349-356`) |
| `delete` | none | — | **200**, empty body (`api/endpoints.go:357-364`) |
| anything else | — | — | **400**, body `unknown action` (`api/endpoints.go:365-367`) |

### Does session `update` check playtime or version?

**No.** This is the answer to the explicit question, and it is a meaningful asymmetry with the system save. `api/endpoints.go:300-327` is the whole of it:

```go
	case "update":
		var session defs.SessionSaveData
		err = json.NewDecoder(r.Body).Decode(&session)
		...
		existingSave, err := savedata.GetSession(db.Store, uuid, slot)
		if err != nil {
			if !errors.Is(err, savedata.ErrSaveNotExist) {
				httpError(w, r, fmt.Errorf("failed to retrieve session save data: %s", err), http.StatusInternalServerError)
				return
			}
		} else {
			if existingSave.Seed == session.Seed && existingSave.WaveIndex > session.WaveIndex {
				httpError(w, r, fmt.Errorf("session out of date: existing wave index is greater"), http.StatusBadRequest)
				return
			}
		}

		err = savedata.UpdateSession(db.Store, uuid, slot, session)
```

The **only** guard is: *if the stored save has the same `seed` and a strictly greater `waveIndex`, reject with 400 `session out of date: existing wave index is greater`.* There is no playtime check, no `gameVersion` check, no minimum-version check, no migrator check, and no tid/sid check on session saves.

The seed equality condition is the loophole that matters: **a session with a different seed overwrites the slot unconditionally**, no matter how far along the stored run was. Starting a new run offline in slot 2 and syncing it will destroy an in-progress online run in slot 2 with no server-side objection. Slot-level conflict handling is entirely our problem, and the server will not help us detect it. `SessionSaveData` does carry `playTime` and `timestamp` fields (`defs/savedata.go:101,119`) that we can compare client-side — the server simply ignores them.

### What `clear` does

`clear` is **"I finished this run"**, and its final act is destructive. `api/endpoints.go:328-348` decodes the body, fetches today's daily seed, and calls `savedata.Clear`. `api/savedata/clear.go:43-85`:

```go
	sessionCompleted := validateSessionCompleted(save)

	if save.GameMode == 3 && save.Seed == seed {
		waveCompleted := save.WaveIndex
		if !sessionCompleted {
			waveCompleted--
		}

		if save.Score >= 20000 {
			store.SetAccountBanned(uuid, true)
		}

		err = store.AddOrUpdateAccountDailyRun(uuid, save.Score, waveCompleted)
		...
	}

	if sessionCompleted {
		response.Success, err = store.TryAddSeedCompletion(uuid, save.Seed, int(save.GameMode))
		...
	}

	err = store.DeleteSessionSaveData(uuid, slot)
```

So, in order:
1. If it is a **daily run** (`gameMode == 3`) whose seed matches today's server seed, the score and wave are recorded to the daily leaderboard — and **a score of 20000 or more bans the account outright** (`api/savedata/clear.go:62-64`, `db/account.go:325-332` sets `accounts.banned = 1`). This is an anti-cheat trap. A sync client must **never** replay or re-submit a daily `clear`.
2. If the run counts as completed — `validateSessionCompleted` (`api/savedata/common.go:24-33`): classic (`gameMode 0`) at `battleType == 2 && waveIndex == 200`, or daily (`gameMode 3`) at `battleType == 2 && waveIndex == 50` — the seed is recorded as completed and `success` reports whether it was newly recorded.
3. **The session slot is deleted, unconditionally** — line 79, outside every branch. Errors here are only logged, never surfaced; the response is still `200` with `success:false`.

`newclear` (`api/savedata/newclear.go:32-47`) is the read-only companion: it reads the slot, looks up whether that seed is already in `dailyRunCompletions`, and returns `!completed`. It **500**s if the slot is empty, because `ReadSessionSaveData`'s `sql.ErrNoRows` is returned raw rather than mapped to `ErrSaveNotExist`.

**Implication for us:** `clear` is not a safe read-side operation and must never be part of a sync path. Our client should only ever use `get`, `update`, and possibly `delete`.

---

## 7. `POST /savedata/updateall` — CONFIRMED

Registered at `api/common.go:59`: `mux.HandleFunc("POST /savedata/updateall", handleUpdateAll)` — this one **is** method-constrained to POST.

Request body — `api/endpoints.go:371-376`:

```go
type CombinedSaveData struct {
	System          defs.SystemSaveData  `json:"system"`
	Session         defs.SessionSaveData `json:"session"`
	SessionSlotId   int                  `json:"sessionSlotId"`
	ClientSessionId string               `json:"clientSessionId"`
}
```

Note `clientSessionId` travels **in the body**, not the query string, unlike every other save endpoint.

Validation, in order (`api/endpoints.go:379-446`):

1. Auth → **401**.
2. JSON decode → **400** `failed to decode request body: ...`.
3. `ClientSessionId == ""` → **400** `missing clientSessionId` (stricter than the session endpoints, which only require the parameter to be *present*).
4. `IsActiveSession` → **400** `session out of date: not active` if false; **400** `failed to check active session: ...` on DB error.
5. `validateOrCreateIds` → tid/sid rules from §3a.
6. If a system save exists: `validatePlaytime` then `validateSystemVersion` — the full §3b–3e battery. Skipped entirely for a fresh account.
7. The same seed+waveIndex session guard as `session/update` (`api/endpoints.go:435-446`).

Then the writes — `api/endpoints.go:448-458`:

```go
	err = savedata.Update(db.Store, uuid, data.SessionSlotId, data.Session)
	...
	err = savedata.Update(db.Store, uuid, 0, data.System)
```

**Session first, then system, with no transaction.** The handler is literally annotated `// TODO wrap this in a transaction` at `api/endpoints.go:378`. If the system write fails after the session write succeeded, the account is left in a torn state: the run advanced but the dex/unlocks/playtime did not. On success: **200**, empty body.

Additional notes:
- There is **no slot-range check in the handler**. It is caught one layer down in `savedata.Update` (`api/savedata/update.go:47-50`), which returns `slot id %d out of range` — surfaced as **500**, not 400.
- `savedata.Update` also rejects a system save with `TrainerId == 0 && SecretId == 0` as `invalid system data` → **500** (`api/savedata/update.go:41-44`, duplicated in `api/savedata/system.go:68-70`).
- `updateall` **always writes both**. There is no way to send system-only or session-only through it, and a zero-valued `session` in the body will happily overwrite a real session slot with an empty one. For a sync client this is a footgun: prefer `system/update` alone when only the system save changed.
- Compare the success codes: `system/update` returns **204 No Content** (`api/endpoints.go:561`) while `updateall` returns **200** (`api/endpoints.go:460`) and `session/update` returns **200** (`api/endpoints.go:327`). Do not write a client that checks for a specific 2xx.

---

## 8. Everything else that constrains a sync client

**Content-Type.** The save endpoints do **not** check it — they call `json.NewDecoder(r.Body).Decode(...)` directly (`api/endpoints.go:302, 330, 387, 524`). Any or no `Content-Type` works. The **account** endpoints are the opposite: `r.PostFormValue` (`api/endpoints.go:178, 188, 204`) requires `application/x-www-form-urlencoded` (or multipart) and will silently see empty strings for a JSON body — which then surfaces as a confusing `invalid username` **500**. This is the most likely first-attempt bug when writing a client against this API.

**Gzip / compression.** None. No `Content-Encoding` handling on requests, no response compression — `grep gzip` over the repo returns nothing. The at-rest compression is zstd inside the DB layer (`db/savedata.go:64, 82`) and is invisible over HTTP. A production CDN may negotiate response gzip independently.

**Max body size.** No `http.MaxBytesReader` anywhere, and no `http.Server` struct is constructed at all — `rogueserver.go:104` calls `http.Serve(listener, handler)` with defaults, so there are **no read/write timeouts either**. Any body-size or timeout limit on `api.pokerogue.net` comes from infrastructure this repo does not describe. A large system save (hundreds of hours means a big `dexData`) is fine as far as this code is concerned, but should be measured against the live endpoint.

**CORS.** `rogueserver.go:133-146`:

```go
func prodHandler(router *http.ServeMux, clienturl string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "OPTIONS, GET, POST")
		w.Header().Set("Access-Control-Allow-Origin", clienturl)

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
```

`clienturl` defaults to `https://pokerogue.net` (`rogueserver.go:57`). Only that single origin is allowed, credentials are not allowed, and only `OPTIONS, GET, POST` are advertised. For an Electron wrapper this matters concretely: **calls made from a renderer with a different origin (`file://`, `app://`, localhost) will be blocked by the browser**, even though the server would have answered. Sync traffic must go from the **main process** (Node `net`/`fetch`, which ignores CORS) or through a session-level header rewrite — not from page JavaScript. `debugHandler` (`rogueserver.go:148-161`) allows `*` but only runs when `debug` is set on the server.

**Error body format.** Universally plain text via `http.Error` (`api/common.go:120-123`), i.e. `Content-Type: text/plain; charset=utf-8` with a trailing `\n`. Success bodies are JSON (`api/common.go:125-132`) except for the several endpoints that `fmt.Fprint` a bare value: `/game/classicsessioncount` (`api/endpoints.go:254`), `/daily/seed` (`api/endpoints.go:612`), `/daily/rankingpagecount` (`api/endpoints.go:670`).

**Everything that touches save state:**
- `/savedata/system/*` — read, write, delete the system save; `get` and `verify` also mutate the active-session lock.
- `/savedata/session/*` — read, write, delete session slots; **all** of them seize the active-session lock; `clear` **deletes a slot** and can **ban the account**.
- `/savedata/updateall` — writes both, non-transactionally.
- `/account/info` — reads `GetLatestSessionSaveDataSlot`, i.e. the most recently written slot (`db/account.go:138-146`, `ORDER BY timestamp DESC, slot ASC LIMIT 1`). Read-only, and genuinely useful for discovering which slot is live.
- `/admin/account/adminSearch` — returns another user's full system save, gated on a Discord admin role (`api/endpoints.go:1026-1032`).
- Any system write also rewrites the denormalised `accountStats` row (`api/savedata/system.go:72`), and `savedata.Update` / `Clear` / `Delete` bump `accounts.lastActivity` (`api/savedata/update.go:35`, `clear.go:45`, `delete.go:36`).

**Daily runs.** `/daily/seed` returns today's seed as a bare string (`api/endpoints.go:605-613`); the seed rotates at UTC midnight (`api/daily/common.go:71-85`). A session save with `gameMode == 3` is a daily run, and syncing one after the seed has rotated means `save.Seed != seed` in `Clear`, so it silently stops counting for the leaderboard. Combined with the ban rule, **daily runs should be excluded from any automatic sync**; they are low-value and high-risk.

**The `banned` flag.** Set by `SetAccountBanned` (`db/account.go:325-332`). Within this repo it only gates leaderboard visibility (`db/daily.go:63, 65, 92`) — nothing here blocks a banned account from saving. What the deployed stack does with the flag is out of scope of this source, so treat a ban as potentially account-ending.

**Ordering guarantees.** There are none. `REPLACE INTO` (`db/savedata.go:97, 166`) means every write is a blind full overwrite with no compare-and-swap, no ETag, no version column consulted at write time. The playtime and wave-index checks in the handlers are the *only* concurrency protection, they are read-then-write with no locking, and two simultaneous updates can interleave. For a "never lose progress" requirement, the server offers us no atomicity primitive — the client must keep its own local backups and verify by reading back after every write.

---

## 9. Full route table

All routes are registered in `api/common.go:32-78` (`func Init`). Patterns without a leading method match **any** HTTP method under Go 1.22+ `ServeMux`. "Auth" means a valid `Authorization` token is required.

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| GET | `/account/info` | `handleAccountInfo` (`endpoints.go:140`) | yes | 401 without a token |
| POST | `/account/register` | `handleAccountRegister` (`endpoints.go:177`) | no | form-encoded; errors are 500 |
| POST | `/account/login` | `handleAccountLogin` (`endpoints.go:187`) | no | form-encoded; errors are 500 |
| POST | `/account/changepw` | `handleAccountChangePW` (`endpoints.go:197`) | yes | invalidates all existing tokens |
| GET | `/account/logout` | `handleAccountLogout` (`endpoints.go:226`) | token only | 400 on bad header, 401 on failure |
| GET | `/game/titlestats` | `handleGameTitleStats` (`endpoints.go:244`) | no | JSON `{playerCount, battleCount}` |
| GET | `/game/classicsessioncount` | `handleGameClassicSessionCount` (`endpoints.go:253`) | no | bare integer, not JSON |
| **any** | `/savedata/session/{action}` | `handleSession` (`endpoints.go:257`) | yes | `get`/`update`/`clear`/`newclear`/`delete`; **always seizes the active session** |
| **any** | `/savedata/system/{action}` | `handleSystem` (`endpoints.go:468`) | yes | `get`/`update`/`verify`/`delete` |
| POST | `/savedata/updateall` | `handleUpdateAll` (`endpoints.go:379`) | yes | requires active session; not transactional |
| GET | `/daily/seed` | `handleDailySeed` (`endpoints.go:605`) | no | bare string |
| GET | `/daily/rankings` | `handleDailyRankings` (`endpoints.go:620`) | no | `category`, `page` |
| GET | `/daily/rankingpagecount` | `handleDailyRankingPageCount` (`endpoints.go:654`) | no | bare integer |
| **any** | `/auth/{provider}/callback` | `handleProviderCallback` (`endpoints.go:674`) | no | `discord`/`google`; sets the `pokerogue_sessionId` cookie |
| **any** | `/auth/{provider}/logout` | `handleProviderLogout` (`endpoints.go:758`) | yes | 400 (not 401) on a bad token |
| POST | `/admin/account/discordLink` | `handleAdminDiscordLink` (`endpoints.go:781`) | yes + Discord admin role | 403 without the role |
| POST | `/admin/account/discordUnlink` | `handleAdminDiscordUnlink` (`endpoints.go:828`) | yes + role | |
| POST | `/admin/account/googleLink` | `handleAdminGoogleLink` (`endpoints.go:886`) | yes + role | |
| POST | `/admin/account/googleUnlink` | `handleAdminGoogleUnlink` (`endpoints.go:933`) | yes + role | |
| GET | `/admin/account/adminSearch` | `handleAdminSearch` (`endpoints.go:991`) | yes + role | returns another user's full system save |

`OPTIONS` on any path short-circuits to 200 in the CORS wrapper before reaching the mux (`rogueserver.go:139-142`).

---

## What this changes for the design

Five findings move the risk picture, in rough order of how much they matter to "never lose progress":

1. **Session-slot endpoints seize the active-session lock without checking it** (`api/endpoints.go:275-284`). A background sync that touches a session slot while the game is open will break the game's own saving. Sync must be strictly serialised against the game being open — not merely "careful about the system save".
2. **Session `update` has essentially no server-side conflict detection** (`api/endpoints.go:315-318`). A different seed overwrites any stored run in that slot. All slot-level merge logic, and all detection of "this would destroy an in-progress run", is ours to build and ours to get right.
3. **tid/sid must match, and the check is brand new** (`api/endpoints.go:73-90`, HEAD commit `c7fed19`). The `VITE_BYPASS_LOGIN=1` guest save will not carry the account's IDs, so the offline save must be seeded from the online one rather than created fresh — and the deployed server may or may not enforce this yet, which makes it a moving target.
4. **The offline build's `gameVersion` must be ≥ what the account last stored**, and `appliedMigrators` must round-trip exactly (`api/endpoints.go:125-135`, `api/savedata/utils.go:31-39`). This couples the offline `game.zip` version to the user online play in a way that will silently block sync if the offline bundle falls behind.
5. **`updateall` is not transactional and `clear` can ban the account** (`api/endpoints.go:378`, `api/savedata/clear.go:62-64`). Prefer separate `system/update` calls over `updateall`, and keep `clear` out of every sync path.

The one piece of genuinely good news: **equal playtime is accepted** (`api/endpoints.go:107`), so uploads are idempotent and a retry after an ambiguous failure is safe. That, plus reading back after every write, is the foundation the safety story should be built on — because the server provides no atomicity, no versioning, and no conflict detection of its own.
