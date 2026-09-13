// DESIGN.md §3.9 — turn the server's prose error bodies (and transport failures) into a closed set
// of reasons the engine can branch on.
//
// The server has no error codes: every rejection is a text/plain body (reports/live-api.md §11).
// Cloudflare, by contrast, answers with text/html — which must never be read as "the save was
// rejected" (Invariant §4.2). Anything we do not recognise is `unknown-rejection`, which the engine
// treats as "do nothing, keep the local save".

export type ClassifiedError =
  /** No usable connection: transport error, timeout, or an HTML page from Cloudflare. */
  | { kind: "offline"; detail: string; status?: number }
  /** `session out of date: not active` — another client claimed the account's active session. */
  | { kind: "not-active"; detail: string }
  /** `session out of date: existing playtime is greater` */
  | { kind: "playtime-lower"; detail: string }
  /** `session out of date: stored trainer or secret ID does not match` */
  | { kind: "id-mismatch"; detail: string }
  /** `session out of date: save version below minimum game version` */
  | { kind: "version-too-low"; detail: string }
  /** `session out of date: existing version is greater` — our game build is behind the account. */
  | { kind: "needs-game-update"; detail: string }
  /** `session out of date: existing wave index is greater` */
  | { kind: "wave-index-lower"; detail: string }
  /** `session out of date: migrators desynced` */
  | { kind: "migrators-desynced"; detail: string }
  /** `no playtime found` */
  | { kind: "no-playtime"; detail: string }
  /** `slot id N out of range` */
  | { kind: "slot-out-of-range"; detail: string; slot: number | null }
  /** `failed to validate token: ...` — the stored token is dead; the user must log in again. */
  | { kind: "auth-failed"; detail: string }
  /** `missing token` */
  | { kind: "missing-token"; detail: string }
  /** 404 `save does not exist` — a legitimate state, not a failure. */
  | { kind: "save-not-found"; detail: string }
  /** Any 5xx with a plain-text body. Retryable, but never treated as a rejection of our data. */
  | { kind: "server-error"; detail: string; status: number }
  /** Fail-safe bucket: do nothing, keep the local save, tell the user nothing technical. */
  | { kind: "unknown-rejection"; detail: string; status: number };

export type ClassifiedErrorKind = ClassifiedError["kind"];

/**
 * Rejections that mean "this particular save will never be accepted as it stands". The engine
 * exports a `.prsv` the user can import by hand and stops trying.
 */
export const UNRECOVERABLE_PUSH_KINDS: readonly ClassifiedErrorKind[] = [
  "playtime-lower",
  "id-mismatch",
  "version-too-low",
  "needs-game-update",
  "wave-index-lower",
  "migrators-desynced",
  "no-playtime",
];

/** Reasons where retrying later, unchanged, is the right move. */
export const RETRYABLE_KINDS: readonly ClassifiedErrorKind[] = ["offline", "server-error", "not-active"];

export function isUnrecoverablePush(reason: ClassifiedError): boolean {
  return UNRECOVERABLE_PUSH_KINDS.includes(reason.kind);
}

export function isRetryable(reason: ClassifiedError): boolean {
  return RETRYABLE_KINDS.includes(reason.kind);
}

/** Ordered longest-first so the more specific `session out of date:` strings win. */
const SUBSTRING_RULES: { match: string; make: (body: string) => ClassifiedError }[] = [
  { match: "not active", make: (b) => ({ kind: "not-active", detail: b }) },
  { match: "existing playtime is greater", make: (b) => ({ kind: "playtime-lower", detail: b }) },
  { match: "stored trainer or secret id does not match", make: (b) => ({ kind: "id-mismatch", detail: b }) },
  { match: "save version below minimum game version", make: (b) => ({ kind: "version-too-low", detail: b }) },
  { match: "existing version is greater", make: (b) => ({ kind: "needs-game-update", detail: b }) },
  { match: "existing wave index is greater", make: (b) => ({ kind: "wave-index-lower", detail: b }) },
  { match: "migrators desynced", make: (b) => ({ kind: "migrators-desynced", detail: b }) },
  { match: "no playtime found", make: (b) => ({ kind: "no-playtime", detail: b }) },
  { match: "failed to validate token", make: (b) => ({ kind: "auth-failed", detail: b }) },
  { match: "missing token", make: (b) => ({ kind: "missing-token", detail: b }) },
  { match: "save does not exist", make: (b) => ({ kind: "save-not-found", detail: b }) },
];

const SLOT_RANGE_RE = /slot id\s+(-?\d+)?\s*out of range/i;

export interface ResponseShape {
  status: number;
  /** Raw `Content-Type` header, if any. */
  contentType?: string | null;
  /** Response body as text. */
  body: string;
}

/** `true` when the payload is a Cloudflare/proxy HTML page rather than the game server talking. */
export function looksLikeHtml(contentType: string | null | undefined, body: string): boolean {
  if (typeof contentType === "string" && contentType.trim().toLowerCase().startsWith("text/html")) {
    return true;
  }
  const head = body.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

/**
 * Classify a non-success HTTP response. Never called for 2xx.
 *
 * Invariant §4.2: anything HTML is `offline`, never `unknown-rejection` — a Cloudflare block is a
 * connectivity problem, not the server refusing our data.
 */
export function classifyResponse(res: ResponseShape): ClassifiedError {
  const body = typeof res.body === "string" ? res.body : "";
  if (looksLikeHtml(res.contentType, body)) {
    return { kind: "offline", detail: `HTTP ${res.status} HTML page (not the game server)`, status: res.status };
  }

  const lower = body.toLowerCase();
  const slotMatch = SLOT_RANGE_RE.exec(body);
  if (slotMatch) {
    const raw = slotMatch[1];
    return {
      kind: "slot-out-of-range",
      detail: body.trim(),
      slot: raw === undefined ? null : Number(raw),
    };
  }
  for (const rule of SUBSTRING_RULES) {
    if (lower.includes(rule.match)) {
      return rule.make(body.trim());
    }
  }
  if (res.status >= 500) {
    return { kind: "server-error", detail: body.trim() || `HTTP ${res.status}`, status: res.status };
  }
  return { kind: "unknown-rejection", detail: body.trim() || `HTTP ${res.status}`, status: res.status };
}

/** Classify a thrown transport failure (DNS, TLS, reset, abort, timeout). Always `offline`. */
export function classifyTransportError(err: unknown): ClassifiedError {
  const detail =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === "string" ? err : "network error";
  return { kind: "offline", detail };
}

/** Plain, non-technical wording for anything we show the user. No jargon, no error codes. */
export function describeForUser(reason: ClassifiedError): string {
  switch (reason.kind) {
    case "offline":
      return "No internet connection right now, so nothing was sent online.";
    case "not-active":
      return "The game is open somewhere else. Nothing was changed; it will try again later.";
    case "playtime-lower":
      return "The copy online has more play time than this one, so it was left alone. A backup of this computer's save was saved to your Documents folder.";
    case "id-mismatch":
      return "This save belongs to a different profile than the one online, so nothing was sent. A backup was saved to your Documents folder.";
    case "version-too-low":
      return "This game version is too old for the online service. Update the game, then try again.";
    case "needs-game-update":
      return "The save online was made with a newer version of the game. Update the game, then try again.";
    case "wave-index-lower":
      return "The run online is further along than this one, so it was left alone. A backup was saved to your Documents folder.";
    case "migrators-desynced":
      return "This save and the one online do not line up. Nothing was changed. A backup was saved to your Documents folder.";
    case "no-playtime":
      return "The save could not be read properly, so nothing was sent.";
    case "slot-out-of-range":
      return "One of the save slots could not be used.";
    case "auth-failed":
    case "missing-token":
      return "You have been signed out. Sign in again to keep your progress in sync.";
    case "save-not-found":
      return "There is no save online yet.";
    case "server-error":
      return "The online service is having trouble. Nothing was changed; it will try again later.";
    case "unknown-rejection":
      return "The online service would not accept the save. Nothing was changed and your progress is safe on this computer.";
  }
}
