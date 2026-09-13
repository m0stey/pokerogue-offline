# Security

What this app protects, how, and — just as important — what it does not protect. Written for the
person handing it over, not for the person using it.

Last reviewed 2026-09-13 (v1 hardening pass, `reports/hardening.md`).

## What there is to protect

One thing, really: **the PokéRogue account**. Concretely:

| Thing | Where it lives |
|---|---|
| The account token (what the game sends instead of the password) | `%APPDATA%\PokeRogue Offline\mirror\account.json` |
| The saves — the profile and up to five runs | `%APPDATA%\PokeRogue Offline\mirror\*.json` |
| Backups of saves, as `.prsv` | `Documents\PokeRogue Backups\` and `%APPDATA%\PokeRogue Offline\backups\` |
| The log | `%APPDATA%\PokeRogue Offline\logs\app-<date>.log` |

The password itself is never stored anywhere, by us or by the game.

## How it is protected

**The token is encrypted with Windows' own credential store.** `account.json` holds `tokenEnc`, a
base64 blob produced by Electron `safeStorage` (DPAPI underneath), not the token itself. Only the
same Windows user on the same machine can decrypt it, so copying the `%APPDATA%` folder to another
computer yields nothing usable. If Windows reports no credential store at all, the app falls back to
storing the token in the clear and writes a warning to the log rather than refusing to start; a
token written by an older version is re-encrypted the first time it is read.
(`src/main/secret.ts`, `src/proxy/mirror.ts`.)

**The local server is only reachable from this computer.** It binds `127.0.0.1` — never `0.0.0.0` —
so nothing on the Wi-Fi can reach it. On top of that, every request must carry a `Host` header of
`127.0.0.1:47830` or `localhost:47830`; anything else gets a 403 and is never answered. That second
check is the DNS-rebinding guard: binding to localhost alone does not stop a web page on the open
internet from pointing a hostname it owns at `127.0.0.1` and reading the answers as if they were its
own. (`src/proxy/server.ts`, `hostAllowed`.)

**The game window is a sealed browser.** `contextIsolation` and `sandbox` on, `nodeIntegration` off,
no preload at all. Pop-ups are denied; navigation and redirects away from `http://127.0.0.1:47830`
are blocked, with links to `pokerogue.net` handed to the real browser instead of being opened in the
window. Every permission request (camera, microphone, location, notifications, …) is refused, and so
is every device request. There is no menu bar to reach developer tools through.
(`src/main/window.ts`.)

**Our own pages cannot reach into the app.** The settings and conflict pages get a four-call
`contextBridge` (`data`, `submit`, `openBackups`, `close`) and nothing else, and their HTML carries a
`Content-Security-Policy` that allows only their own script and no network access whatsoever.
(`src/main/preload-ui.ts`, `src/ui/*.html`.)

**Only four headers are forwarded to the online service** — `Authorization`, `Content-Type`,
`PKR-Client-Version`, `Accept` — plus the `Origin` the service requires. Cookies, the user agent and
anything else the page sends are dropped. (`src/proxy/upstream.ts`.)

**The log never contains a whole token.** Any logged field whose name looks like a token, password
or authorization is cut to its first six characters, and any such query parameter in a logged URL is
replaced outright. (`src/common/log.ts` `redact`, `src/proxy/server.ts` `redactPath`.)

**The developer switches are dead in the shipped build.** The `force-offline` file and the F12
developer-tools shortcut both exist only when `app.isPackaged` is false, and there is a test for it.
(`src/main/dev-hooks.ts`, `test/main/dev-hooks.test.ts`.)

**Nothing is downloaded and run.** The app no longer fetches or installs game files; it only reads
the GitHub release list to see whether a newer version exists and says so. A new version means a new
installer, run by hand. That removes the whole class of "something was downloaded and swapped into
the game folder" problems.

## The two honest limitations

**1. The offline login does not check the password.** With no connection there is nothing to check it
against — we hold a token, not a password verifier. So when the app is offline, typing the right
*username* into the game's login screen is enough to get back in. Anyone who can already use the Windows account can therefore open the game as the user.

**2. Anyone with access to that Windows account has access to everything.** The token encryption is
tied to that account, which is exactly what makes it useful — and exactly what makes it useless
against someone sitting at an unlocked, signed-in laptop. The saves and the backups are plain files
(the `.prsv` backups use the game's own public key, `x0i2O7WRiANTqPmZ`, which is published in the
game's source, so they are exactly as protected as the game's own exports — that is, not). The real
protection there is a Windows password and a locked screen.

Both are accepted deliberately. Fixing either would mean asking the user for a password the app cannot
verify, which trades a problem the user does not actually have for a daily annoyance the user would.

## The installer is not signed

There is no code-signing certificate, so Windows SmartScreen shows a "Windows protected your PC"
warning the first time the installer runs; getting past it takes *More info → Run anyway*. This is
expected (BRIEF.md) and is the reason the installer should be handed over directly rather than
downloaded from somewhere the user found on their own. An unsigned installer cannot prove it came from us, so
whoever hands it over is the trust anchor.

## Automatic updates

The app downloads new installers by itself from the GitHub releases of `m0stey/pokerogue-offline`.
Safeguards: downloads only over https from `github.com` / `githubusercontent.com` (redirects
elsewhere are refused), the file must match the SHA-256 and size published in the same release, and
a version is never downgraded. The installer runs silently without admin rights (per-user install).

What this does not protect against: whoever controls the GitHub account or repository can publish a
release the app will install, because checksum and installer come from the same place. Protect the
GitHub account with two-factor authentication.

## Reporting

This is a two-person project; there is no security contact and no disclosure process. If something
here is wrong, fix it in the code and update this file in the same change.
