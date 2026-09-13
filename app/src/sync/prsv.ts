// DESIGN.md §3.1 — the game's `.prsv` save format, reimplemented on node:crypto only.
//
// The upstream client encrypts exports with `CryptoJS.AES.encrypt(text, saveKey)` where saveKey is
// a *passphrase* string (upstream/pokerogue/src/constants.ts:57). CryptoJS then uses its
// OpenSSL-compatible passphrase mode, which is byte-for-byte:
//
//   base64( "Salted__" || salt[8] || AES-256-CBC(PKCS#7(plaintext)) )
//   key||iv = EVP_BytesToKey(MD5, passphrase, salt, iterations = 1, 48 bytes)
//             key = bytes 0..31, iv = bytes 32..47
//
// Equivalent to `openssl enc -aes-256-cbc -md md5 -base64 -k x0i2O7WRiANTqPmZ`.
// Verified in both directions against a real crypto-js@4.2.0 (test fixtures in
// test/sync/fixtures/*.cryptojs.prsv were produced by it).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Public in upstream `src/constants.ts:57`. Not a secret; it is in the shipped bundle. */
export const PRSV_KEY = "x0i2O7WRiANTqPmZ";

const MAGIC = Buffer.from("Salted__", "latin1");
const SALT_LEN = 8;
const KEY_LEN = 32;
const IV_LEN = 16;
const BLOCK = 16;

export type PrsvErrorKind =
  | "empty"
  | "not-base64"
  | "too-short"
  | "bad-magic"
  | "bad-block-size"
  | "bad-padding"
  | "not-utf8";

/** Thrown by {@link decryptPrsv} and friends. Never leaks the blob contents into the message. */
export class PrsvError extends Error {
  readonly kind: PrsvErrorKind;
  constructor(kind: PrsvErrorKind, message: string) {
    super(message);
    this.name = "PrsvError";
    this.kind = kind;
  }
}

/**
 * OpenSSL EVP_BytesToKey with MD5 and a single iteration — what CryptoJS's `OpenSSLKdf` does.
 */
function evpBytesToKey(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const pass = Buffer.from(passphrase, "latin1");
  const out: Buffer[] = [];
  let total = 0;
  let block = Buffer.alloc(0);
  while (total < KEY_LEN + IV_LEN) {
    block = createHash("md5").update(Buffer.concat([block, pass, salt])).digest();
    out.push(block);
    total += block.length;
  }
  const derived = Buffer.concat(out, KEY_LEN + IV_LEN);
  return { key: derived.subarray(0, KEY_LEN), iv: derived.subarray(KEY_LEN, KEY_LEN + IV_LEN) };
}

/**
 * Encrypt a JSON string into the exact blob the game's Import accepts.
 * @param json - the plaintext (normally JSON; not validated here)
 * @param salt - test-only override so fixtures can be reproduced byte-for-byte
 */
export function encryptPrsv(json: string, salt: Buffer = randomBytes(SALT_LEN)): string {
  if (salt.length !== SALT_LEN) {
    throw new PrsvError("too-short", `salt must be ${SALT_LEN} bytes`);
  }
  const { key, iv } = evpBytesToKey(PRSV_KEY, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(true);
  const body = Buffer.concat([cipher.update(Buffer.from(json, "utf8")), cipher.final()]);
  return Buffer.concat([MAGIC, salt, body]).toString("base64");
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decrypt a `.prsv` blob. Rejects anything that is not one with a typed {@link PrsvError} —
 * it never returns a partially-decoded or empty string the way CryptoJS does.
 */
export function decryptPrsv(blob: string): string {
  if (typeof blob !== "string") {
    throw new PrsvError("empty", "not a string");
  }
  const compact = blob.replace(/\s+/g, "");
  if (compact.length === 0) {
    throw new PrsvError("empty", "empty blob");
  }
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new PrsvError("not-base64", "not valid base64");
  }
  const raw = Buffer.from(compact, "base64");
  // Buffer.from is lenient; a strict re-encode catches anything it silently dropped.
  if (raw.toString("base64") !== compact) {
    throw new PrsvError("not-base64", "not valid base64");
  }
  if (raw.length < MAGIC.length + SALT_LEN + BLOCK) {
    throw new PrsvError("too-short", "blob too short to be a save");
  }
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new PrsvError("bad-magic", "missing OpenSSL 'Salted__' header");
  }
  const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const body = raw.subarray(MAGIC.length + SALT_LEN);
  if (body.length % BLOCK !== 0) {
    throw new PrsvError("bad-block-size", "ciphertext is not a whole number of blocks");
  }
  const { key, iv } = evpBytesToKey(PRSV_KEY, salt);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(true);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new PrsvError("bad-padding", "could not decrypt (wrong key or corrupt file)");
  }
  const text = plain.toString("utf8");
  // Buffer -> utf8 replaces invalid sequences with U+FFFD rather than failing; round-trip to catch it.
  if (!Buffer.from(text, "utf8").equals(plain)) {
    throw new PrsvError("not-utf8", "decrypted bytes are not valid UTF-8");
  }
  return text;
}

/** Like {@link decryptPrsv} but returns `null` instead of throwing. */
export function tryDecryptPrsv(blob: string): string | null {
  try {
    return decryptPrsv(blob);
  } catch {
    return null;
  }
}

// --- bypass-login (VITE_BYPASS_LOGIN=1) localStorage blobs, upstream src/utils/data.ts:48-60 ---

/** `btoa(encodeURIComponent(data))` — what the offline build stores in localStorage. */
export function encodeBypassBlob(json: string): string {
  return Buffer.from(encodeURIComponent(json), "latin1").toString("base64");
}

/** `decodeURIComponent(atob(data))`. Throws {@link PrsvError} on anything malformed. */
export function decodeBypassBlob(b64: string): string {
  const compact = String(b64 ?? "").replace(/\s+/g, "");
  if (compact.length === 0) {
    throw new PrsvError("empty", "empty blob");
  }
  if (compact.length % 4 !== 0 || !BASE64_RE.test(compact)) {
    throw new PrsvError("not-base64", "not valid base64");
  }
  const latin1 = Buffer.from(compact, "base64").toString("latin1");
  try {
    return decodeURIComponent(latin1);
  } catch {
    throw new PrsvError("not-utf8", "blob is not percent-encoded text");
  }
}

// --- system save key shortening, upstream src/constants/app-constants.ts:30-46 ---

/** Verbatim copy of upstream `systemSaveShortKeyMap`. Insertion order is load-bearing. */
export const SYSTEM_SAVE_SHORT_KEY_MAP = {
  seenAttr: "$sa",
  caughtAttr: "$ca",
  natureAttr: "$na",
  seenCount: "$s",
  caughtCount: "$c",
  hatchedCount: "$hc",
  ivs: "$i",
  moveset: "$m",
  eggMoves: "$em",
  candyCount: "$x",
  friendship: "$f",
  abilityAttr: "$a",
  passiveAttr: "$pa",
  valueReduction: "$vr",
  classicWinCount: "$wc",
} as const;

export interface TrainerIds {
  trainerId: number;
  secretId: number;
}

/**
 * Verbatim port of `GameData.convertSystemDataStr` (upstream src/system/game-data.ts:533-548).
 *
 * It is a *raw string* substitution over the whole JSON text, not a key-aware transform — that is
 * exactly what the game does, and a re-implementation that only touched object keys would produce
 * blobs the game decodes differently. Replacement order matters: `$sa` is expanded before `$s`.
 *
 * `ids`, when given, rewrites every `"trainerId":N` / `"secretId":N` the way the client rewrites
 * them to the *receiving* profile's ids. Pass the save's own ids (the default when omitted) to keep
 * an export faithful to the save it came from.
 */
export function convertSystemDataStr(dataStr: string, shorten: boolean, ids?: TrainerIds): string {
  let out = dataStr;
  if (!shorten) {
    // Upstream: "Account for past key oversight"
    out = out.replace(/\$pAttr/g, "$pa");
  }
  if (ids) {
    out = out.replace(/"trainerId":\d+/g, `"trainerId":${ids.trainerId}`);
    out = out.replace(/"secretId":\d+/g, `"secretId":${ids.secretId}`);
  }
  const entries = Object.entries(SYSTEM_SAVE_SHORT_KEY_MAP);
  for (const [long, short] of entries) {
    const from = shorten ? long : short;
    const to = shorten ? short : long;
    out = out.replace(new RegExp(from.replace("$", "\\$"), "g"), to);
  }
  return out;
}

/** Long keys -> `$xx` keys, as `tryExportData` does before encrypting a SYSTEM export. */
export function shortenSystemDataStr(dataStr: string, ids?: TrainerIds): string {
  return convertSystemDataStr(dataStr, true, ids);
}

/** `$xx` keys -> long keys, as `importData` does before parsing a SYSTEM import. */
export function expandSystemDataStr(dataStr: string, ids?: TrainerIds): string {
  return convertSystemDataStr(dataStr, false, ids);
}
