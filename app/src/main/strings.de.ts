// Every word the user ever reads that is ours and not the game's, in one file so it can be
// reviewed in one sitting (DECISIONS.md 2026-09-13).
//
// Rules for this file:
//   * plain everyday German, informal "du";
//   * no technical words. Not "Sync", nicht "Server", nicht "Cache", nicht "Token", nicht "Mirror",
//     nicht "Proxy", nicht "Backup". Say "online gespeichert", "auf diesem Computer",
//     "Sicherungskopie";
//   * "Spielzeit" is the game's own German label for Play Time. The upstream public/locales
//     submodule is not checked out, but the built game carries the same files and
//     game-build/dist/game/locales/de/game-stats-ui-handler.json reads "playTime":"Spielzeit",
//     so it stays exactly that;
//   * the app is called "PokéRogue" everywhere, with the accent, like the game itself.

/**
 * Whose help she should ask for when a new version is needed. One constant, on purpose: it is the
 * only name in the app, and it is the only thing to change if someone else takes this over.
 */
export const OWNER_NAME = "Alexander";

export const APP_NAME = "PokéRogue";

export const DE = {
  /** Window titles. */
  titles: {
    game: APP_NAME,
    settings: `${APP_NAME} – Einstellungen`,
    conflict: "Welcher Spielstand soll bleiben?",
  },

  tray: {
    tooltip: APP_NAME,
    settings: "Einstellungen…",
    backups: "Sicherungskopien öffnen",
    showGame: "Spiel anzeigen",
    quit: "Beenden",
  },

  /** The one question we ever ask about saves. */
  conflict: {
    heading: "Welcher Spielstand soll bleiben?",
    lead:
      "Dein Spielstand auf diesem Computer ist anders als der, der online gespeichert ist. " +
      "Bitte wähle aus, mit welchem du weiterspielen möchtest.",
    here: "Auf diesem Computer",
    online: "Online gespeichert",
    playTime: "Spielzeit",
    lastPlayed: "Zuletzt gespielt",
    run: "Durchgang",
    keep: "Diesen behalten",
    note: "Der andere wird als Sicherungskopie auf diesem Computer gespeichert. Es geht nichts verloren.",
    remember: "Diese Auswahl merken (du kannst sie in den Einstellungen ändern)",
    nothingSaved: "nichts gespeichert",
    noRun: "Kein Durchgang",
    runInProgress: (wave: number): string => `Läuft gerade: Welle ${wave}`,
  },

  /** The settings page. Everything on it, in order. */
  settings: {
    heading: `${APP_NAME} – Einstellungen`,
    conflictHeading: "Wenn dein Spielstand hier und online unterschiedlich ist",
    conflictAsk: "Frag mich jedes Mal, welcher bleiben soll",
    conflictHere: "Immer den von diesem Computer behalten",
    conflictOnline: "Immer den online gespeicherten behalten",
    backupsHeading: "Sicherungskopien",
    openFolder: "Ordner öffnen",
    aboutHeading: "Über dein Spiel",
    gameVersion: "Spielversion",
    lastSavedOnline: "Zuletzt online gespeichert",
    playTime: "Spielzeit",
    footnote: "Dein Spielstand wird von allein online gespeichert. Du musst hier nichts tun.",
    unknown: "unbekannt",
    notYet: "noch nie",
  },

  /** Shown while she waits at quit, if saving takes more than two seconds. */
  splash: "Dein Spielstand wird online gespeichert…",

  /** A save the online service would not take. Her copy is on disk; she is told once. */
  backupSaved: {
    message: "Dein Spielstand ist sicher.",
    detail:
      "Wir konnten diesen Spielstand gerade nicht online speichern. Deshalb liegt jetzt eine " +
      "Sicherungskopie davon auf diesem Computer. Du kannst einfach weiterspielen – wir " +
      "versuchen es später noch einmal.",
    openFolder: "Ordner öffnen",
    ok: "OK",
  },

  /**
   * The game refuses to open an account whose save was written by a newer version of the game
   * (reports/milestone-1.md §3). There is nothing we can do about it here, so the only honest thing
   * is to say what happened, that nothing is lost, and who can fix it.
   */
  needsGameUpdate: {
    message: `${APP_NAME} hat eine neue Version bekommen.`,
    detail:
      `Das passiert, wenn du ${APP_NAME} zwischendurch im Browser gespielt hast. ` +
      "Dein Spielstand ist vollständig, es geht nichts verloren. " +
      `Damit du hier weiterspielen kannst, braucht dieser Computer die neue Version von ${APP_NAME}. ` +
      `Bitte frag ${OWNER_NAME} danach.`,
    ok: "OK",
  },

  /** One message, then the app closes. */
  startup: {
    message: `${APP_NAME} konnte nicht gestartet werden.`,
    close: "Schließen",
    portInUse:
      `Ein anderes Programm auf diesem Computer benutzt gerade etwas, das ${APP_NAME} braucht. ` +
      `Bitte starte den Computer neu und öffne ${APP_NAME} noch einmal.`,
    generic: "Beim Starten ist etwas schiefgegangen. Bitte starte den Computer neu und versuche es noch einmal.",
    missingFiles:
      `Die Spieldateien fehlen. Bitte installiere ${APP_NAME} noch einmal – ` +
      "dein gespeicherter Fortschritt bleibt dabei erhalten.",
  },

  /** Only ever seen in development, when there are no game files to serve. */
  placeholderPage: {
    title: APP_NAME,
    text:
      `Das Spiel wird auf diesem Computer noch eingerichtet. Bitte schließe dieses Fenster und ` +
      `öffne ${APP_NAME} gleich noch einmal.`,
  },

  /** Numbers turned into words (format.ts). */
  format: {
    nothing: "—",
    lessThanAMinute: "weniger als eine Minute",
    hoursMinutes: (h: number, m: number): string => `${h} Std. ${m} Min.`,
    minutes: (m: number): string => `${m} Min.`,
    never: "noch nie",
    justNow: "gerade eben",
    aMinuteAgo: "vor einer Minute",
    minutesAgo: (n: number): string => `vor ${n} Minuten`,
    anHourAgo: "vor einer Stunde",
    hoursAgo: (n: number): string => `vor ${n} Stunden`,
    yesterday: "gestern",
    daysAgo: (n: number): string => `vor ${n} Tagen`,
    onDate: (date: string): string => `am ${date}`,
  },
} as const;
