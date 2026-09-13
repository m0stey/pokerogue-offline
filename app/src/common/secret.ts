// How a secret (today: the account token) is turned into the bytes that sit in a file, and back.
//
// The Mirror lives in src/proxy and must stay free of Electron, but the only real protection we
// have on Windows is Electron's `safeStorage`, which wraps DPAPI. So the Mirror takes one of these
// and src/main hands it the safeStorage-backed implementation (see main/secret.ts).
//
// What this protects against: another user account on the same machine reading the token out of
// `account.json`, and the token surviving in a copied-away profile folder. What it does NOT protect
// against: anything running as her own Windows user, which can ask DPAPI to decrypt it just as we
// do. That is written down honestly in SECURITY.md.

export interface SecretCodec {
  /**
   * `false` for the identity codec below. The caller stores the value in the clear when this is
   * false, rather than pretending an unprotected value is protected.
   */
  readonly available: boolean;
  /** Secret -> the string to store. */
  protect(value: string): string;
  /** The stored string -> the secret. Throws when it cannot be read back. */
  unprotect(stored: string): string;
}

/** The default: no protection at all. Used in tests, and when safeStorage is unavailable. */
export const plainSecret: SecretCodec = {
  available: false,
  protect: (value) => value,
  unprotect: (stored) => stored,
};
