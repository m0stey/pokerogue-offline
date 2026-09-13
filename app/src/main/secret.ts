// The one place Electron's `safeStorage` is touched.
//
// `safeStorage` wraps Windows DPAPI: the ciphertext can only be read back by the same Windows user
// on the same machine. That is what keeps the account token out of a copied-away `%APPDATA%` folder
// and away from other accounts on the laptop. It is not, and cannot be, protection against anything
// running as the user — SECURITY.md says so in plain words.

import { safeStorage } from "electron";
import type { Logger } from "../common/log";
import type { SecretCodec } from "../common/secret";
import { plainSecret } from "../common/secret";

/**
 * A codec backed by `safeStorage`, or the plain one with a warning in the log when Windows has no
 * credential store to offer. Never throws: being unable to protect the token is a reason to note it,
 * not a reason to refuse to start.
 *
 * Must be called after the app is ready — `isEncryptionAvailable()` is not meaningful before.
 */
export function createSecretCodec(log: Logger): SecretCodec {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch (err) {
    log.warn("could not ask Windows whether it can protect the sign-in", { error: String(err) });
  }
  if (!available) {
    log.warn("Windows cannot protect the stored sign-in on this computer; it is kept as plain text");
    return plainSecret;
  }
  return {
    available: true,
    protect: (value) => safeStorage.encryptString(value).toString("base64"),
    unprotect: (stored) => safeStorage.decryptString(Buffer.from(stored, "base64")),
  };
}
