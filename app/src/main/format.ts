// Turning numbers into the sentences she actually reads. Deliberately no jargon, no seconds,
// no ISO timestamps anywhere the user can see them.

/** Seconds of play time -> "12 h 34 m" (the game's own label for this number is "Play Time"). */
export function formatPlayTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0 && m === 0) return "less than a minute";
  if (h === 0) return `${m} m`;
  return `${h} h ${m} m`;
}

/** A timestamp -> "just now", "5 minutes ago", "yesterday", "on 3 March". */
export function formatRelative(when: number | string | null | undefined, now = Date.now()): string {
  const ms = typeof when === "string" ? Date.parse(when) : when;
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "never";
  const diff = Math.max(0, now - ms);
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min === 1) return "a minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hours = Math.round(min / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "long" })}`;
}

/** Bytes -> "about 500 MB" (rounded the way a person would say it). */
export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "a few hundred MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "less than 1 MB";
  if (mb < 1024) return `about ${Math.round(mb / 10) * 10 || Math.round(mb)} MB`;
  return `about ${(mb / 1024).toFixed(1)} GB`;
}
