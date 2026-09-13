// Turning numbers into the sentences she actually reads. Deliberately no jargon, no seconds,
// no ISO timestamps anywhere the user can see them. The words themselves live in strings.de.ts.

import { DE } from "./strings.de";

/**
 * Seconds of play time -> "12 Std. 34 Min.".
 * The game's own German label for this number is "Spielzeit"
 * (game-build/dist/game/locales/de/game-stats-ui-handler.json), so that is the label we use.
 */
export function formatPlayTime(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return DE.format.nothing;
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h === 0 && m === 0) return DE.format.lessThanAMinute;
  if (h === 0) return DE.format.minutes(m);
  return DE.format.hoursMinutes(h, m);
}

/** A timestamp -> "gerade eben", "vor 5 Minuten", "gestern", "am 3. März". */
export function formatRelative(when: number | string | null | undefined, now = Date.now()): string {
  const ms = typeof when === "string" ? Date.parse(when) : when;
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return DE.format.never;
  const diff = Math.max(0, now - ms);
  const min = Math.round(diff / 60000);
  if (min < 1) return DE.format.justNow;
  if (min === 1) return DE.format.aMinuteAgo;
  if (min < 60) return DE.format.minutesAgo(min);
  const hours = Math.round(min / 60);
  if (hours === 1) return DE.format.anHourAgo;
  if (hours < 24) return DE.format.hoursAgo(hours);
  const days = Math.round(hours / 24);
  if (days === 1) return DE.format.yesterday;
  if (days < 7) return DE.format.daysAgo(days);
  return DE.format.onDate(new Date(ms).toLocaleDateString("de-DE", { day: "numeric", month: "long" }));
}
