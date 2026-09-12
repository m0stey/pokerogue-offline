# Client verification: `pagefaultgames/pokerogue`

**Repo verified:** `C:\dev\pokerogue-offline\upstream\pokerogue`
**HEAD:** `da1d0efff3c48b5b4f2b9eb448051793971999bd` — *dev: enable `noNestedTernary` rule at `warn`* (2026-09-12)
**Client version (`package.json:4`):** `1.12.1.0`
**Nothing in `upstream/` was modified.** Read-only inspection, plus one throwaway `crypto-js@4.2.0` install in `%TEMP%\pkrv` for the cipher-format check in claim 3.

> Note: the `locales/` and `assets/` submodules are **not** checked out in this clone (`.gitmodules:6-13`), so i18n message *text* could not be read — only the i18n **keys**. Where a user-visible string is quoted below, it is the key, not the rendered English.

---

## Summary table

| # | Claim | Verdict | Primary evidence |
|---|---|---|---|
| 1 | Offline build uses `VITE_BYPASS_LOGIN=1`, user is `Guest`, key is `data_Guest` | **CONFIRMED** (one naming correction) | `.env.app:1`, `.env.development:1`; `src/constants/app-constants.ts:21`; `src/account.ts:22-28`, `:59-67`; `src/system/game-data.ts:273` |
| 2 | Bypass mode stores `btoa(encodeURIComponent(json))`, unencrypted | **CONFIRMED** | `src/utils/data.ts:48-60` |
| 3 | `.prsv` = `CryptoJS.AES.encrypt(json, "x0i2O7WRiANTqPmZ")`; key public; OpenSSL `Salted__` + MD5 EVP_BytesToKey (1 iter) + AES-256-CBC | **CONFIRMED** (empirically round-tripped) | `src/constants.ts:57`; `src/system/game-data.ts:1305-1313`; `package.json:52` |
| 4 | API base `https://api.pokerogue.net`; auth header is the raw `pokerogue_sessionId` cookie value | **CONFIRMED** (header name is `Authorization`) | `.env.production:3`; `src/api/api-base.ts:84-89`; `src/constants.ts:11` |
| 5 | `clientSessionId` — generation, transport, "session not active" handling | **CONFIRMED / documented** | `src/account.ts:10`; `src/utils/common.ts:21-31`; `src/system/game-data.ts:283, 1032, 1093, 1261` |
| 6 | Online game writes system save to `data_<username>` in the same AES format as `.prsv`, before uploading | **CONFIRMED, with one material difference** (`.prsv` is *key-shortened*; localStorage is not) | `src/system/game-data.ts:273`, `:1227-1240` vs `:1281-1305` |
| 7 | Ground truth for progress: Menu → Game Stats → Play Time | **CONFIRMED** | `src/ui/handlers/menu-ui-handler.ts:27`, `:585-587`; `src/ui/handlers/game-stats-ui-handler.ts:28-31`; `src/battle-scene.ts:647-661` |
| 8 | Save-data version constant, migrator mechanism, network-error behaviour in `saveAll` | **CHANGED vs. the brief's model** — no separate save-version constant exists, and a network error is neither queued nor retried; it kicks the player to the title screen | `package.json:4`; `src/system/version-migration/version-converter.ts:62`, `:130-232`; `src/api/savedata-api.ts:23-34`; `src/phases/encounter-phase.ts:300-309` |
| 9 | Exact set of API endpoints | **Documented** — 20 rows across `src/api/*` | see §9 |

### Corrections to the brief's facts table

1. **`data_Guest` is right, but the *session* key for slot 0 is `sessionData_Guest` (no `0`).** `src/account.ts:66` builds `sessionData${slotId || ""}_${username}`, so slots are `sessionData_X`, `sessionData1_X` … `sessionData4_X`.
2. **The offline env file is `.env.app` (build mode `app`, `pnpm build:app`)**, not a hand-set variable. `.env.development` also sets `VITE_BYPASS_LOGIN=1`. `.env`, `.env.production` and `.env.beta` all set `0`.
3. **The auth header is `Authorization: <raw cookie value>`** — no `Bearer` prefix. The client also always sends `PKR-Client-Version: <package.json version>`.
4. **`.prsv` system exports are key-shortened** (`$sa`, `$ca`, …) before encryption; the `data_<user>` localStorage blob is not. Same key, same cipher, different plaintext. Both import correctly.
5. **`importData` rewrites `playTime` in an imported system save** to `<currently loaded playTime> + 60`, discarding the imported value (`src/system/game-data.ts:1406`). This is the single most important finding for the sync design — see §3.
6. **On any `saveAll` failure in online mode — including a plain network error — the game calls `globalScene.reset(true)` and drops the player to the title screen**, losing the un-synced wave. Nothing is queued or retried.
7. **The game already ships a bulk local-save exporter**: the login screen's download-saves button zips every `data_*` / `sessionData*` localStorage value as `.prsv` files (`src/ui/handlers/login-register-info-container-ui-handler.ts:216-247`). It writes the raw stored value, so in bypass mode those "`.prsv`" files are base64, not AES, and **will not import**.

---

## 1. Bypass login, `Guest`, `data_Guest` — CONFIRMED

`src/constants/app-constants.ts:21`
```ts
export const bypassLogin = import.meta.env.VITE_BYPASS_LOGIN === "1";
```

Env files (repo root):

| file | build mode | `VITE_BYPASS_LOGIN` | `VITE_SERVER_URL` |
|---|---|---|---|
| `.env` | default | `0` | `http://localhost:8001` |
| `.env.production` | `production` | `0` | `https://api.pokerogue.net` |
| `.env.beta` | `beta` | `0` | `https://apibeta.pokerogue.net` |
| `.env.development` | `development` | **`1`** | `http://localhost:8001` |
| `.env.app` | **`app`** (`pnpm build:app`) | **`1`** | `http://localhost:8001` |

`.env.app:1-3` is the offline/desktop build profile:
```
VITE_BYPASS_LOGIN=1
VITE_BYPASS_TUTORIAL=0
VITE_SERVER_URL=http://localhost:8001
```
`src/constants/app-constants.ts:16` — `export const isApp = import.meta.env.MODE === "app";`

The user becomes `Guest` in `src/account.ts:12-34`:
```ts
export async function updateUserInfo(): Promise<[success: boolean, status: number]> {
  if (!bypassLogin) {
    const [accountInfo, status] = await pokerogueApi.account.getInfo();
    ...
  }

  loggedInUser = {
    username: "Guest",
    lastSessionSlot: -1,
    discordId: "",
    googleId: "",
    hasAdminRole: false,
  };
```

System-save key — `src/system/game-data.ts:273`:
```ts
localStorage.setItem(`data_${loggedInUser?.username}`, encrypt(systemData, bypassLogin));
```
→ `data_Guest` in bypass mode. There is no constant for this template; it is interpolated at seven sites (`:273`, `:296`, `:301`, `:317`, `:429`, `:1208`, `:1227-1228`).

Session-save key — `src/account.ts:59-67`:
```ts
export function getSessionDataLocalStorageKey(slotId: number): string {
  if (slotId < 0) {
    throw new Error("Cannot access a negative save slot ID from localstorage!");
  }

  // TODO: Default to `Guest` as a fallback for no logged in username
  // rather than leaving a trailing underscore
  return `sessionData${slotId || ""}_${loggedInUser?.username}`;
}
```
**Slot 0 has no digit**: `sessionData_Guest`, then `sessionData1_Guest` … `sessionData4_Guest`. Five slots (`src/account.ts:29`, `src/system/game-data.ts:571`).

`src/account.ts:36-48` also migrates legacy un-suffixed keys (`data`, `sessionData`, `sessionData1`–`4`) onto the current username, backing up any collision to `<key>_<user>_bak`. **This runs on every `updateUserInfo()` call in bypass mode**, so a stray legacy `data` key inside the Electron profile would silently overwrite `data_Guest`.

---

## 2. Storage format per mode, and the full key inventory — CONFIRMED

`src/utils/data.ts:48-60` — the entire encryption layer:
```ts
export function encrypt(data: string, bypassLogin: boolean): string {
  if (bypassLogin) {
    return btoa(encodeURIComponent(data));
  }
  return AES.encrypt(data, saveKey).toString();
}

export function decrypt(data: string, bypassLogin: boolean): string {
  if (bypassLogin) {
    return decodeURIComponent(atob(data));
  }
  return AES.decrypt(data, saveKey).toString(enc.Utf8);
}
```

So: **bypass → `btoa(encodeURIComponent(json))`** (reversible, unkeyed); **online → CryptoJS AES with the public `saveKey`**. One function, both modes; only the envelope differs. A base64 blob begins with the encoded `%7B` (`JTdC…`); an AES blob always begins `U2FsdGVkX1` (base64 of `Salted__`). That prefix is a reliable discriminator for the wrapper.

### What is written where

| localStorage key | Written by | Contents | Bypass encoding | Online encoding |
|---|---|---|---|---|
| `data_<user>` | `game-data.ts:273` (`saveSystem`), `:429` (`initSystem`), `:1227` (`saveAll`) | `SystemSaveData` JSON, full-length keys | base64 | AES |
| `sessionData_<user>` … `sessionData4_<user>` | `game-data.ts:809` (`getSession` cache), `:836`/`:848` (`renameSession`), `:1237` (`saveAll`) | `SessionSaveData` JSON | base64 | AES |
| `runHistoryData_<user>` | `game-data.ts:500-503` | up to 25 past runs (`RUN_HISTORY_LIMIT`) | base64 | AES |
| `starterPrefs_<user>` | `utils/data.ts:100` | starter preferences | **plain JSON** | plain JSON |
| `settings` | `system/settings/settings-manager.ts:114`, key from `getDataTypeKey(GameDataType.SETTINGS)` | settings + `meta.gameVersion` | **plain JSON** | plain JSON |
| `tutorials` | `game-data.ts:704` | tutorial flags | **plain JSON** | plain JSON |
| `seenDialogues` | `game-data.ts:732` | seen dialogues | **plain JSON** | plain JSON |
| `mappingConfigs` | `game-data.ts:625`, `:677` | gamepad mappings | **plain JSON** | plain JSON |
| `daily` | `game-data.ts:1053`, `:1061` | cleared daily seeds, `btoa(JSON)` | base64 | (bypass-only path) |
| `touchControl/positions/*`, `prLang` | `ui/settings/move-touch-controls-handler.ts:286`, `i18n.ts:202` | UI prefs | plain | plain |

Key **names** come from `getDataTypeKey` (`src/utils/data.ts:105-127`): `SYSTEM → "data"`, `SESSION → "sessionData"+slot`, plus `settings`, `tutorials`, `seenDialogues`, `runHistoryData`, `mappingConfigs`. The `_<username>` suffix is appended at the call sites, not by that function.

Only `data_*`, `sessionData*` and `runHistoryData_*` pass through `encrypt()`. **Settings, tutorials, seen dialogues and starter prefs are never username-scoped**, so an offline `Guest` and an online account sharing an origin share them.

---

## 3. `.prsv` export and the import path — CONFIRMED, plus critical import behaviour

### The key

`src/constants.ts:57`
```ts
export const saveKey = "x0i2O7WRiANTqPmZ"; // Temporary; secure encryption is not yet necessary
```
Public, in-source, unchanged. 16 ASCII characters — but in CryptoJS passphrase mode this is a *passphrase*, not a raw key; the actual AES key is 256-bit and derived from it.

### Export — `src/system/game-data.ts:1269-1316`

```ts
public async tryExportData(dataType: GameDataType, slotId = 0): Promise<boolean> {
    const dataKey = `${getDataTypeKey(dataType, slotId)}_${loggedInUser?.username}`;
    let data: string | null;

    if (bypassLogin || (dataType !== GameDataType.SYSTEM && dataType !== GameDataType.SESSION)) {
      const encrypted = localStorage.getItem(dataKey);
      if (typeof encrypted !== "string") {
        return false;
      }

      data = decrypt(encrypted, bypassLogin);
      if (dataType === GameDataType.SYSTEM) {
        data = this.convertSystemDataStr(data, true);          // <-- shorten keys
      }
    } else if (dataType === GameDataType.SYSTEM) {
      const resp = await pokerogueApi.savedata.system.get({ clientSessionId });   // <-- server, not localStorage
      if (typeof resp !== "string") {
        return false;
      }
      data = this.convertSystemDataStr(resp, true);
    } else {
      dataType satisfies GameDataType.SESSION;
      const resp = await pokerogueApi.savedata.session.get({ slot: slotId, clientSessionId });
      ...
    }

    if (!data || data.charAt(0) !== "{") {
      console.error("Exported save data is invalid JSON!", data);
      return false;
    }

    const encryptedData = AES.encrypt(data, saveKey);
    const blob = new Blob([encryptedData.toString()], { type: "text/json" });
    const link = document.createElement("a");
    link.href = window.URL.createObjectURL(blob);
    link.download = `${dataKey}.prsv`;
```

Three things worth flagging:
- **Online export reads from the server, not from localStorage.** Only in bypass mode (or for non-system/session data types) does it read the local blob.
- **System exports are key-shortened** by `convertSystemDataStr(data, true)` (`:534-548`) using `systemSaveShortKeyMap` (`src/constants/app-constants.ts:30-46`): `seenAttr→$sa`, `caughtAttr→$ca`, `natureAttr→$na`, `seenCount→$s`, `caughtCount→$c`, `hatchedCount→$hc`, `ivs→$i`, `moveset→$m`, `eggMoves→$em`, `candyCount→$x`, `friendship→$f`, `abilityAttr→$a`, `passiveAttr→$pa`, `valueReduction→$vr`, `classicWinCount→$wc`. The same function force-rewrites `trainerId`/`secretId` in the string to the *current* `GameData` values (`:539-540`).
- Filename is `<storagekey>.prsv`, e.g. `data_Guest.prsv`, `sessionData1_Ash.prsv`.

### Cipher format — empirically CONFIRMED

`package.json:52` pins `"crypto-js": "^4.2.0"`. `AES.encrypt(string, string)` with a *string* key selects CryptoJS's OpenSSL-compatible passphrase mode. Verified by round-trip against a throwaway `crypto-js@4.2.0` install:

```
ciphertext(b64) prefix:                     U2FsdGVkX18mE1sALV9p/FMA
magic (bytes 0..8):                         Salted__
node decrypt of a CryptoJS blob:            roundtrip OK = true
derived key length: 256 bits                iv length: 16 bytes
CryptoJS decrypt of a node-built OpenSSL blob: true
```

Format, confirmed in both directions:
```
base64( "Salted__" || salt[8] || AES-256-CBC( PKCS#7-padded plaintext ) )
key||iv = EVP_BytesToKey(MD5, passphrase = "x0i2O7WRiANTqPmZ", salt, iterations = 1, 48 bytes)
          -> key = bytes 0..31, iv = bytes 32..47
```
Equivalent to `openssl enc -aes-256-cbc -md md5 -base64 -k x0i2O7WRiANTqPmZ`. It is fully reproducible outside the browser with `node:crypto` alone — the wrapper needs no crypto-js dependency.

### Import — `src/system/game-data.ts:1319-1500`

Accepted file types (`:1327`): `.prsv, .json, .txt` (`.prsv` only on iOS).

Decode (`:1396-1400`) — **plaintext JSON is accepted as-is**:
```ts
let dataStr: string;
if (isValidJSON(saveData)) {
  dataStr = saveData;
} else {
  dataStr = AES.decrypt(saveData, saveKey).toString(enc.Utf8);
}
```
There is no base64/bypass branch here. A *bypass-mode* localStorage blob (`btoa(encodeURIComponent(...))`) is neither valid JSON nor a valid AES blob, so `AES.decrypt` returns `""` and the import fails validation. **An offline save must be re-wrapped as AES — or handed over as raw JSON — before it can be imported.** Raw JSON is the simplest legal input and needs no key at all.

Validation, per type (`:1402-1433`):

- `SYSTEM` (`:1404-1410`):
  ```ts
  dataStr = this.convertSystemDataStr(dataStr);                                          // un-shorten keys
  dataStr = dataStr.replace(/"playTime":\d+/, `"playTime":${this.gameStats.playTime + 60}`);
  const systemData = GameData.parseSystemData(dataStr);
  valid = !!systemData.dexData && !!systemData.timestamp;
  ```
  **The imported `playTime` is thrown away** and replaced with the currently-loaded account's `playTime + 60` (the regex has no `/g`, so only the first match — `gameStats.playTime` — is touched). This presumably exists to satisfy the server's monotonic-playtime rule, and it means **an import can never raise the server's stored play time by more than 60 seconds**: the offline hours are lost from the stat even though dex, unlocks, eggs and the rest transfer. Any sync design that routes through Import must account for this, and any progress check based on Play Time must not expect the number to survive a round trip.
  Note also that `convertSystemDataStr` overwrites `trainerId`/`secretId` with the *receiving* account's ids.
- `SESSION` (`:1411-1415`): `valid = !!sessionData.party && !!sessionData.enemyParty && !!sessionData.timestamp;`
- `RUN_HISTORY` (`:1416-1425`): every entry must have exactly the keys `isFavorite`, `isVictory`, `entry`.
- `SETTINGS`, `TUTORIALS` (`:1426-1429`): `valid = true` — no validation at all.

Failure shows `menuUiHandler:importCorrupt`. There is no checksum, signature, or version check on import.

**Does import upload? Yes** — `:1442-1481`, after a `menuUiHandler:confirmImport` CONFIRM prompt:
```ts
localStorage.setItem(dataKey, encrypt(dataStr, bypassLogin));

if (!bypassLogin && dataType < GameDataType.SETTINGS) {
  updateUserInfo().then(success => {
    if (!success[0]) {
      return displayError(i18next.t("menuUiHandler:importNoServer", { dataName }));
    }
    const { trainerId, secretId } = this;
    let updatePromise: Promise<string | null>;
    if (dataType === GameDataType.SESSION) {
      updatePromise = pokerogueApi.savedata.session.update({ slot: slotId, trainerId, secretId, clientSessionId }, dataStr);
    } else {
      updatePromise = pokerogueApi.savedata.system.update({ trainerId, secretId, clientSessionId }, dataStr);
    }
    updatePromise.then(error => {
      if (error) {
        console.error(error);
        return displayError(i18next.t("menuUiHandler:importError", { dataName }));
      }
      window.location.reload();
    });
  });
} else {
  window.location.reload();
}
```
So in online mode: **local write first, then a direct `POST /savedata/{system,session}/update`, then a full page reload on success.**

`GameDataType` ordering matters here: `SYSTEM`, `SESSION` and `RUN_HISTORY` are all `< SETTINGS`, so `RUN_HISTORY` enters the branch too — and falls into the `else`, POSTing run-history JSON to **`/savedata/system/update`**. That looks like a latent bug; do not import run history on a live account.

On upload failure the local blob has **already** been written and the page does **not** reload, leaving localStorage and the server divergent until the next save.

---

## 4. API base, auth header, login/register/logout — CONFIRMED

`.env.production:3` → `VITE_SERVER_URL=https://api.pokerogue.net`

`src/api/api.ts:76`
```ts
export const pokerogueApi = new PokerogueApi(import.meta.env.VITE_SERVER_URL ?? "http://localhost:8001");
```

`src/api/api-base.ts:83-98`
```ts
protected async doFetch(path: string, config: DoFetchConfig): Promise<Response> {
    config.headers = {
      ...config.headers,
      Authorization: getCookie(SESSION_ID_COOKIE_NAME),
      "Content-Type": config.headers?.["Content-Type"] ?? "application/json",
      "PKR-Client-Version": version,
    };
    ...
    // TODO: need some sort of error handling here?
    return await fetch(this.base + path, config as RequestInit);
}
```
- Header name: **`Authorization`**. Value: the **raw cookie value, no scheme prefix**.
- `PKR-Client-Version` = the `package.json` version (`1.12.1.0`). A wrapper talking to the API directly should send this too, or risk a server-side version gate.
- No `credentials: "include"` — the cookie is read by JS and copied into the header, so it must not be `HttpOnly`, and the API is cross-origin to the page.
- **No timeout, no retry, no queue** in `doFetch`. A `fetch` rejection is caught only by the individual callers.

`src/constants.ts:11`
```ts
/** Name of the session ID cookie */
export const SESSION_ID_COOKIE_NAME: string = "pokerogue_sessionId";
```
Duplicated at `src/utils/common.ts:288` as `export const sessionIdKey = "pokerogue_sessionId";` — both are live and used by different files.

Cookie write/read — `src/utils/cookies.ts:6-37`:
```ts
document.cookie = `${cName}=${cValue};Secure;SameSite=Strict;Domain=${window.location.hostname};Path=/;Expires=${expiration.toUTCString()}`;
```
90-day expiry (`:3-4`). `getCookie` **deletes the cookie and returns `""` if it finds more than one with that name** (`:22-26`) — a self-inflicted logout hazard if the wrapper also sets that cookie on a different domain scope.

**The token lives only in the cookie.** It is never written to localStorage or sessionStorage.

### Auth endpoints

| Operation | Method + path | Request | Response | Source |
|---|---|---|---|---|
| Login | `POST /account/login` | `application/x-www-form-urlencoded`: `username`, `password` | `200` → JSON `{ "token": string }`; error → text body | `account-api.ts:60-76` |
| Register | `POST /account/register` | form-urlencoded: `username`, `password` | `200` → (body ignored); error → text body | `account-api.ts:39-52` |
| Logout | `GET /account/logout` | — (auth header only) | ok / not | `account-api.ts:83-95` |
| Account info | `GET /account/info` | — | JSON `{username, lastSessionSlot, discordId, googleId, hasAdminRole}` | `account-api.ts:18-32`, `@types/api.ts:3-9` |
| Change password | `POST /account/changepw` | form-urlencoded: `password` | `200` / error text | `account-api.ts:97-110` |

On login (`account-api.ts:64-67`): `setCookie(SESSION_ID_COOKIE_NAME, loginResponse.token)`. On logout (`:94`) the cookie is removed **unconditionally**, even when the request failed.

Startup flow — `LoginPhase` (`src/phases/login-phase.ts:35-46`) only calls `updateUserInfo()` when `bypassLogin || !!getCookie(sessionIdKey)`. Status handling (`:68-82`): `null` or `400` → login/register form; `401` → drop cookie and `globalScene.reset(true, true)`; anything else → `UnavailablePhase` → `UnavailableModalUiHandler` (`src/ui/handlers/unavailable-modal-ui-handler.ts:62-80`), which shows `menu:errorServerDown` and retries `updateUserInfo()` with exponential backoff from 5 s to a 5-minute cap plus up to 10 s of jitter. **That retry loop covers login only — never saves.**

OAuth (browser redirects, not API calls): `https://discord.com/api/oauth2/authorize?...&redirect_uri=<VITE_SERVER_URL>/auth/discord/callback&state=<cookie token>` (`menu-ui-handler.ts:628-632`) and the Google equivalent (`:648-651`).

---

## 5. `clientSessionId` — CONFIRMED

**Generated once per page load**, at module scope — `src/account.ts:8-10`:
```ts
/** A random, 32-length alphanumeric string used to identify the current client session. */
// TODO: This should arguably be inside its own file
export const clientSessionId = randomString(32);
```
`randomString` (`src/utils/common.ts:21-31`) draws 32 characters from `[A-Za-z0-9]` using `Math.random()`. **It is never persisted** — every reload produces a new one. It is logged once at `game-data.ts:294` (`console.log("Client Session:", clientSessionId)`), which is the easiest place for the wrapper to observe it.

**Transport:** always a **query parameter** named `clientSessionId`, on every savedata endpoint — except `/savedata/updateall`, where it is a **body field** (`@types/api.ts:78-83`). It is never a header and never a cookie.

**"Session not active" handling.** The client has exactly one branch for it, keyed on a server-returned *string prefix*:

| Site | Code |
|---|---|
| `game-data.ts:282-289` (`saveSystem`) | `if (error.startsWith("session out of date")) { globalScene.phaseManager.clearPhaseQueue(); await this.reinitializeSaveData(); }` |
| `game-data.ts:1032-1035` (`deleteSession`) | same |
| `game-data.ts:1093-1096` (`tryClearSession`) | same, tested on `jsonResponse.error` |
| `game-data.ts:1261-1264` (`saveAll`) | same, tested on `saveError` |

`reinitializeSaveData` — `game-data.ts:581-599`:
```ts
private async reinitializeSaveData({ systemDataStr, message }: { systemDataStr?: string; message?: string } = {}): Promise<false> {
    const alertMessage = systemDataStr ? ErrorMessages.OUT_OF_DATE_LOCAL : ErrorMessages.OUT_OF_DATE;

    this.clearLocalData();

    if (systemDataStr) {
      await this.initSystem(systemDataStr);
    } else {
      await this.loadSystem();
    }

    return this.showInvalidSaveModal(false, message ?? alertMessage);
}
```
**`clearLocalData()` (`:566-574`) deletes `data_<user>` and all five `sessionData*_<user>` keys**, then re-pulls from the server. So a "session out of date" from the server *destroys the local copy of the save*. It is a no-op in bypass mode (`:567-569`), but any wrapper that treats `pokerogue.net` localStorage as a source of truth must snapshot **before** the online client can reach this path.

The i18n keys used (`game-data.ts:79-86`):
```ts
const ErrorMessages = {
  OUT_OF_DATE: i18next.t("gameData:reloadSaveData"),
  OUT_OF_DATE_LOCAL: i18next.t("gameData:reloadSaveDataLocal"),
  DATA_NOT_FOUND: i18next.t("gameData:saveDataNotFound"),
  TOO_MANY_CONNECTIONS: i18next.t("gameData:tooManyConnections"),
  FAILED_VALIDATION: i18next.t("gameData:failedSaveValidation"),
  GAME_OUT_OF_DATE: i18next.t("gameData:gameOutOfDate"),
} as const;
```
The modal is drawn by `showInvalidSaveModal` (`:236-258`) in `UiMode.ALERT_MODAL` and auto-dismisses after roughly five seconds; the caller then almost always calls `globalScene.reset(true)`.

**Separately**, `GameData.verify()` (`:550-564`) calls `GET /savedata/system/verify?clientSessionId=…`; if the server answers `{valid: false, systemData}` the client adopts the server's copy, wipes local, and shows `OUT_OF_DATE_LOCAL`. `verify()` returns `true` immediately when `bypassLogin`. It runs from `saveAll` on **every non-sync save** (`:1245`), i.e. on most waves.

Other observable strings: `loadSystem` surfaces `DATA_NOT_FOUND` on HTTP 404 (`:306-308`) and `TOO_MANY_CONNECTIONS` when the response text contains `"Too many connections"` (`:310-312`). `getSession` bails on the literal body `"save does not exist"` (`:801`). A `newclear` failure at game over (`game-over-phase.ts:274-282`) shows `menu:serverCommunicationFailed` and **hard-reloads the page after 2 seconds**.

---

## 6. Save/upload flow — CONFIRMED, with one material difference

### `saveSystem()` — `game-data.ts:260-291`

Order: build → validate → show saving icon → **write `data_<user>` locally** → if `bypassLogin`, stop and return `true` → `POST /savedata/system/update?clientSessionId=…` with the *unshortened* JSON → hide icon → on error, maybe `reinitializeSaveData`, return `false`.

```ts
localStorage.setItem(`data_${loggedInUser?.username}`, encrypt(systemData, bypassLogin));

if (bypassLogin) {
  globalScene.ui.savingIcon.hide();
  return true;
}

const error = await pokerogueApi.savedata.system.update({ clientSessionId }, systemData);
```
The local write happens **before** the upload and is **never rolled back** on failure. So the brief's claim holds: the local blob is the same AES envelope as a `.prsv`, written first, then uploaded.

**The one difference:** the `.prsv` file contains *key-shortened* JSON (`convertSystemDataStr(data, true)`, `:1282`/`:1289`), while `data_<user>` contains full-length keys. Cipher, key and envelope are identical; only the plaintext differs. Because `importData` runs `convertSystemDataStr(dataStr)` (un-shorten) on whatever it receives, and that is effectively a no-op on already-long keys, **a `data_<user>` value renamed to `.prsv` still imports correctly** — in online mode. In bypass mode it cannot, because the envelope is base64 (§2/§3).

### `saveAll(skipVerification, sync, useCachedSession, useCachedSystem)` — `game-data.ts:1186-1267`

1. `:1192-1197` — unless `skipVerification`, `await updateUserInfo()`; abort with `false` if it fails.
2. `:1199-1209` — build session + system data, or re-read them from localStorage when `useCachedSession`/`useCachedSystem`.
3. `:1211-1213` — `validateSystemData`; on failure `reinitializeSaveData({message: FAILED_VALIDATION})` → **wipes local data** (online only).
4. `:1216-1218` — show the saving icon only when `sync`.
5. `:1220-1225` — assemble `{ system, session, sessionSlotId, clientSessionId }`.
6. `:1227-1235` — **write `data_<user>`** (AES or base64 per mode).
7. `:1237-1240` — **write `sessionData<slot>_<user>`**.
8. `:1244-1248` — if `bypassLogin || !sync`: run `verify()` (no-op offline, a server round-trip online), hide icon, return.
9. `:1250` — `POST /savedata/updateall` with the whole request as JSON.
10. `:1251-1254` — when `sync`, reset `lastSavePlayTime = 0` and hide the icon.
11. `:1256-1266` — empty response → `true`. Otherwise: `"session out of date"` → clear the phase queue and `reinitializeSaveData()`; `console.error(saveError)`; return `false`.

**Both local writes happen before the network call, in both modes, and neither is reverted on failure.** Local is always kept; it is destroyed only by `clearLocalData()` inside `reinitializeSaveData` / `verify`.

**Is the user told?** Only indirectly. A plain upload failure produces a `console.error` and a `false` return — no modal, no toast. The *caller* reacts:

| Caller | Call | On `false` |
|---|---|---|
| `src/phases/encounter-phase.ts:300-309` | `saveAll(true, waveIndex % 5 === 1 \|\| lastSavePlayTime >= 300)` | `globalScene.reset(true)` → **back to the title screen** |
| `src/phases/post-game-over-phase.ts:20-23` | `saveAll(true, true, true)` | `globalScene.reset(true)` |
| `src/ui/handlers/menu-ui-handler.ts:670-679` (Save & Quit) | `saveAll(true, true, true, true)` | always `globalScene.reset(true)` |
| `src/ui/handlers/egg-gacha-ui-handler.ts:512-513` | `saveAll(true, true, true)` / `saveSystem()` | handler-local |

Sync to the server therefore happens on **waves ending in 1 or 6** (`waveIndex % 5 === 1`, per the comment at `encounter-phase.ts:299`) **or when 300 s have elapsed since the last sync**; every other wave is a local-only write plus a `verify()` round-trip.

---

## 7. Menu → Game Stats → Play Time — CONFIRMED

`src/ui/handlers/menu-ui-handler.ts:24-35`
```ts
enum MenuOptions {
  GAME_SETTINGS,
  ACHIEVEMENTS,
  STATS,
  EGG_LIST,
  EGG_GACHA,
  POKEDEX,
  MANAGE_DATA,
  COMMUNITY,
  SAVE_AND_QUIT,
  LOG_OUT,
}
```
`:585-587`
```ts
case MenuOptions.STATS:
  ui.setOverlayMode(UiMode.GAME_STATS);
```

`src/ui/handlers/game-stats-ui-handler.ts:27-31` — Play Time is the **first** entry in the panel:
```ts
const displayStats: DisplayStats = {
  playTime: {
    label_key: "playTime",
    sourceFunc: gameData => getPlayTimeString(gameData.gameStats.playTime),
  },
```
Rendered through `i18next.t("gameStatsUiHandler:playTime")` (`:470-471`). The panel header is `gameStatsUiHandler:stats` with the username, or `common:guest` when `bypassLogin` (`:339-346`).

Format — `src/utils/common.ts:175-184`:
```ts
const secondsInHour = 3600;

export function getPlayTimeString(totalSeconds: number): string {
  const days = `${Math.floor(totalSeconds / (secondsInHour * 24))}`;
  const hours = `${Math.floor((totalSeconds % (secondsInHour * 24)) / secondsInHour)}`;
  const minutes = `${Math.floor((totalSeconds % secondsInHour) / 60)}`;
  const seconds = `${Math.floor(totalSeconds % 60)}`;

  return `${days.padStart(2, "0")}:${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}`;
}
```
i.e. **`DD:HH:MM:SS`**, zero-padded — four fields, not three. A wrapper reading this off-screen must parse accordingly.

### Where `playTime` is incremented

`src/battle-scene.ts:643-661`, inside `initSession()`:
```ts
this.playTimeTimer = this.time.addEvent({
  delay: fixedInt(1000),
  repeat: -1,
  callback: () => {
    if (this.gameData) {
      this.gameData.gameStats.playTime++;
    }
    if (this.sessionPlayTime !== null) {
      this.sessionPlayTime++;
    }
    if (this.lastSavePlayTime !== null) {
      this.lastSavePlayTime++;
    }
  },
});
```
**Unit: whole seconds. Rate: +1 per real second**, via a Phaser timer. `fixedInt` makes it immune to the in-game speed setting. It ticks whenever the scene is running — including on menus — not only in battle.

`gameStats.playTime` is declared at `src/system/game-stats.ts:5` and loaded at `:43` (`this.playTime = source?.playTime || 0;`). It is monotonic within a session and only persisted by a save. `lastSavePlayTime` drives the 300-second sync trigger and is zeroed at `game-data.ts:1252`. `sessionPlayTime` is the per-run figure written into `SessionSaveData.playTime` (`game-data.ts:758`) and the run-info screen. The egg-gacha screen runs its own unrelated `playTimeTimer` for animations (`egg-gacha-ui-handler.ts:904`).

---

## 8. Save version, migrators, and the network-error path

### There is no dedicated save-data version constant — CHANGED

The save "version" is simply the client version:
- `package.json:4` → `"version": "1.12.1.0"`
- `src/main.ts:8`, `:73` puts it into the Phaser game config as `version`
- `game-data.ts:163` (system) and `:775` (session) write `gameVersion: globalScene.game.config.gameVersion`
- `src/system/version-migration/version-converter.ts:62` → `const LATEST_VERSION = version;` (imported from `#package.json`)
- settings carry theirs separately at `meta.gameVersion` (`settings-manager.ts:23`)

A save's version *is* the version of the client that wrote it. Bumping the client bumps every save written afterwards. There is no `SAVE_DATA_VERSION`, no schema number, and no minimum-version constant on the client side — the brief's "a save version below the minimum" is a purely server-side rule.

### Migrator mechanism — `src/system/version-migration/version-converter.ts`

Migrators are `{name, version, migrate}` records, grouped by target version in `src/system/version-migration/versions/v*.ts` and aggregated at `:84-110`:
```ts
const systemMigrators: SystemSaveMigrator[] = [
  ...v1_0_3.systemMigrators, ...v1_0_4.systemMigrators, ...v1_7_0.systemMigrators, ...v1_8_3.systemMigrators,
  ...v1_12_0_0.systemMigrators, ...v1_12_0_1.systemMigrators, ...v1_12_0_3.systemMigrators,
  ...v1_12_0_10.systemMigrators, ...v1_12_1_0.systemMigrators,
];
const sessionMigrators: SessionSaveMigrator[] = [
  ...v1_0_4.sessionMigrators, ...v1_7_0.sessionMigrators, ...v1_9_0.sessionMigrators,
  ...v1_10_0.sessionMigrators, ...v1_12_0_0.sessionMigrators,
];
const settingsMigrators: SettingsSaveMigrator[] = [
  ...v1_0_4.settingsMigrators, ...v1_11_19.settingsMigrators, ...v1_12_1_0.settingsMigrators,
];
```
Sorted oldest → newest at `:113-115`.

**Where versions are compared** — `:130-138`:
```ts
export function applySystemVersionMigration(data: SystemSaveData): void {
  const prevVersion = data.gameVersion;
  const isCurrentVersionHigher = compareVersions(prevVersion, LATEST_VERSION) === -1;

  if (isCurrentVersionHigher) {
    applyMigrators(systemMigrators, data, prevVersion);
    console.log(`System data successfully migrated to v${LATEST_VERSION}!`);
  }
}
```
and per migrator, `:219-232`:
```ts
function applyMigrators(migrators: readonly SaveMigrator[], data: SaveData, saveVersion: string): void {
  for (const migrator of migrators) {
    const isMigratorVersionHigher = compareVersions(saveVersion, migrator.version) === -1;

    if (isMigratorVersionHigher) {
      migrator.migrate(data as any);

      if ("appliedMigrators" in data) {
        const migratorNameVersion = `${migrator.version}-${migrator.name}`;
        (data.appliedMigrators as AppliedMigrators)[migratorNameVersion] = Date.now();
      }
    }
  }
}
```
`compareVersions` lives in `src/utils/migrator-utils.ts` (`extractVersion` at `:60`), parsing `#.#.#[.#]` into four numbers.

**`appliedMigrators`** is a `{ "<version>-<name>": <epoch ms> }` map, part of `SystemSaveData` (`@types/save-data.ts:41`), defaulted to `{}` at parse time (`game-data.ts:530`) and round-tripped on save (`:167`).

**This is what "desynced migrators" means from the client side.** Two clients at different versions produce different key sets in that map. A save written by an *older* client lacks the newer entries. A save written by a *newer* client carries entries the older client will never run — and the older client will never migrate *downward*, because `applySystemVersionMigration` only acts when the save is older than the client. The server compares this map against what it expects; the client neither validates it nor surfaces a specific message for it (a rejection would arrive as an opaque text body and be logged, not explained).

**Client-side version guards:**
- `applySessionVersionMigration` (`:149-176`) throws `SessionMigrationError` when `party` is not an array of objects (`:161-163`); a missing or non-string `gameVersion` is only warned about and migration is skipped (`:150-153`).
- `initSystem` (`game-data.ts:437-446`) refuses a save *newer* than the client, outside dev/beta:
  ```ts
  if (!isDev && !isBeta && compareVersions(systemData.gameVersion, version) === 1) {
    await globalScene.ui.setMode(UiMode.ALERT_MODAL, ErrorMessages.GAME_OUT_OF_DATE);
    ...
    return false;
  }
  ```
  **Direct consequence for the wrapper:** if the bundled offline build is a *newer* version than the deployed online site (or vice versa), the older client hard-refuses the save with `gameData:gameOutOfDate`. Offline and online builds must be kept version-matched, and the wrapper should compare `package.json` versions before letting a save cross.
- `initSystem` also prefers a local copy over the server's when it is newer (`:405-414`):
  ```ts
  if (cachedSystemData.timestamp > systemData.timestamp) {
    console.debug("Using cached system data");
    systemData = cachedSystemData;
    systemDataStr = cachedSystemDataStr;
  } else {
    this.clearLocalData();
  }
  ```
  **This is the client's own built-in "newer local wins" path.** A `data_<user>` blob whose `timestamp` exceeds the server's is adopted on load and written back on the next sync. The `else` branch deletes local data outright. Note that `loadSystem` reads that cached blob with `AES.decrypt(cachedSystem, saveKey)` directly (`:320`) rather than via `decrypt()` — equivalent here, since the branch is unreachable when `bypassLogin`, but it means the online client can only ever consume an AES-enveloped cache.

### Behaviour on a network error during `saveAll` (online mode) — no queue, no retry

`src/api/savedata-api.ts:23-34`:
```ts
public async updateAll(bodyData: UpdateAllSavedataRequest): Promise<string> {
    try {
      const rawBodyData = JSON.stringify(bodyData, (_k: any, v: any) =>
        typeof v === "bigint" ? (v <= MAX_INT_ATTR_VALUE ? Number(v) : v.toString()) : v,
      );
      const response = await this.doPost("/savedata/updateall", rawBodyData);
      return await response.text();
    } catch (err) {
      console.warn("Could not update all savedata!", err);
      return "Unknown error";
    }
}
```
A DNS failure, a downed adapter, a TLS error or an aborted connection rejects `fetch`, is caught here, and becomes the string `"Unknown error"` — **indistinguishable from a server-side rejection**, because the API is text-based and the response body is returned verbatim on any HTTP status. `saveAll` sees a truthy `saveError` that does not start with `"session out of date"`, so it logs and returns `false`.

Then `encounter-phase.ts:302-306`:
```ts
.then(success => {
  globalScene.disableMenu = false;
  if (!success) {
    return globalScene.reset(true);
  }
  this.doEncounter();
  globalScene.resetSeed();
});
```
`globalScene.reset(true)` (`battle-scene.ts:1103` onward, ending with `this.phaseManager.toTitleScreen(true)` at `:631-632`) destroys the party, nulls `currentBattle`, re-seeds, and returns to the title screen.

**Summary: nothing is queued, nothing is retried, and the failure is never explained to the user.** The local `data_<user>` and `sessionData<n>_<user>` writes from steps 6–7 survive, so the run is recoverable from its save slot — but the player is dumped to the title mid-wave with no message. The only retry machinery in the client (`UnavailableModalUiHandler`) covers login, not saving.

---

## 9. Endpoint table

Every call made by `src/api/*`. Base = `VITE_SERVER_URL` (`https://api.pokerogue.net` in production). All requests carry `Authorization: <pokerogue_sessionId cookie value>` and `PKR-Client-Version: 1.12.1.0`.

| # | Method | Path | Query params | Body | Response | Source |
|---|---|---|---|---|---|---|
| 1 | GET | `/account/info` | — | — | JSON `UserInfo` | `account-api.ts:20` |
| 2 | POST | `/account/register` | — | form-urlencoded `username`, `password` | text on error | `account-api.ts:41` |
| 3 | POST | `/account/login` | — | form-urlencoded `username`, `password` | JSON `{token}` | `account-api.ts:62` |
| 4 | GET | `/account/logout` | — | — | — | `account-api.ts:85` |
| 5 | POST | `/account/changepw` | — | form-urlencoded `password` | text on error | `account-api.ts:99` |
| 6 | POST | `/auth/discord/logout` | — | — | ok / not | `api.ts:45` |
| 7 | POST | `/auth/google/logout` | — | — | ok / not | `api.ts:63` |
| 8 | GET | `/game/titlestats` | — | — | JSON `{playerCount, battleCount}` | `api.ts:31` |
| 9 | GET | `/daily/seed` | — | — | text (seed) | `daily-api.ts:8` |
| 10 | POST | `/savedata/updateall` | — | JSON `{system: SystemSaveData, session: SessionSaveData, sessionSlotId: number, clientSessionId: string}` | text (`""` = success) | `savedata-api.ts:28` |
| 11 | GET | `/savedata/system/get` | `clientSessionId` | — | text: system JSON, or an error body; `404` = no save | `system-savedata-api.ts:20` |
| 12 | GET | `/savedata/system/verify` | `clientSessionId` | — | JSON `{valid: boolean, systemData: SystemSaveData}` | `system-savedata-api.ts:42` |
| 13 | POST | `/savedata/system/update` | `clientSessionId`, optional `trainerId`, `secretId` | raw system JSON (`Content-Type: application/json`) | text (`""` = success) | `system-savedata-api.ts:67` |
| 14 | GET | `/savedata/session/get` | `slot`, `clientSessionId` | — | text: session JSON, or `"save does not exist"` | `session-savedata-api.ts:44` |
| 15 | POST | `/savedata/session/update` | `slot`, `trainerId`, `secretId`, `clientSessionId` | raw session JSON | text (`""` = success) | `session-savedata-api.ts:63` |
| 16 | GET | `/savedata/session/delete` | `slot`, `clientSessionId` | — | ok, else text | `session-savedata-api.ts:80` |
| 17 | POST | `/savedata/session/clear` | `slot`, `trainerId`, `clientSessionId` | JSON `SessionSaveData` | JSON `{error?, success?}` | `session-savedata-api.ts:105` |
| 18 | GET | `/savedata/session/newclear` | `slot`, `isVictory`, `clientSessionId` | — | JSON boolean | `session-savedata-api.ts:24` |
| 19 | GET | `/admin/account/adminSearch` | `username` | — | JSON `SearchAccountResponse` | `admin-api.ts:56` |
| 20 | POST | `/admin/account/{discord\|google}{Link\|Unlink}` | — | form-urlencoded `username` + `discordId` / `googleId` | ok / `404` | `admin-api.ts:25-29` |

Notes:
- Query strings are built by `toUrlSearchParams` (`api-base.ts:108-114`), which **drops any key whose value is `undefined` or `""`** and stringifies the rest. `false` and `0` survive (as `"false"` / `"0"`). That is why `UpdateSystemSavedataRequest.trainerId`/`secretId` are optional — they simply vanish from the query when not supplied, as in the normal `saveSystem` path (`game-data.ts:280` sends only `clientSessionId`), whereas the import path sends all three (`:1467`).
- `updateAll` and `system.update` serialise `bigint` as a `Number` when `<= 0x80000000` (`MAX_INT_ATTR_VALUE`, `src/constants.ts:14`) and as a decimal **string** above that — this covers the dex `caughtAttr` / `seenAttr` fields. Any wrapper that re-serialises a save must replicate this exactly or the server will see different values.
- Non-savedata browser redirects (not fetches): `<base>/auth/discord/callback` and `<base>/auth/google/callback` as OAuth `redirect_uri`, with the session token passed as `state`.
- In `isDev` builds only, `localPing()` (`src/utils/common.ts:298-304`) hits `/game/titlestats` to set `isLocalServerConnected`, which gates daily-run seed fetching (`title-phase.ts:330`) and `newclear` (`game-over-phase.ts:266`). In an `app`-mode build `isDev` is false, so `isLocalServerConnected` stays at its initial `!bypassLogin` = `false` and those paths take the offline branch (`offlineNewClear`, date-derived daily seed).

---

## Additional findings relevant to the brief

1. **A built-in bulk local exporter already exists.** `src/ui/handlers/login-register-info-container-ui-handler.ts:216-247` (`downloadSaves`) zips **every** localStorage key containing `data_` or `sessionData` as `<key>.prsv` into `pokerogue_saves.zip`. It writes the raw stored value, so in bypass mode those files are base64, not AES, and will not import. `showUsernames` (`:172-208`) lists all `data_*` keys — a cheap way to confirm which usernames a profile holds saves for (capped by `MAX_SAVES_FOR_USERNAME_PANEL`).
2. **`getSession` caches server sessions into localStorage** (`game-data.ts:809`) and **prefers the local copy whenever present** (`:792-795`). A stale local session therefore shadows the server's for that slot.
3. **Legacy-key migration runs on every `updateUserInfo()` in bypass mode** (`account.ts:36-48`) and will clobber `data_Guest` from a bare `data` key, backing the old value up to `data_Guest_bak`.
4. **`validateSystemData` failure destroys local saves in online mode.** `saveSystem` (`:263-265`) and `saveAll` (`:1211-1213`) both route a validation failure into `reinitializeSaveData`, which calls `clearLocalData()`. `clearLocalData` short-circuits when `bypassLogin` (`:567-569`), so an offline-only profile is protected; an online profile is not.
5. **Settings, tutorials, seen dialogues and starter prefs are not username-scoped**, so an offline `Guest` and an online account sharing a browser origin share them.
6. **None of this is a stable API contract.** The savedata endpoints return bare text, and the client's only structured check on a failure is `startsWith("session out of date")`. Anything the wrapper builds on top of these strings should be treated as fragile and re-verified against each upstream release.
