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

  /** Shown while the user waits at quit, if saving takes more than two seconds. */
  splash: "Dein Spielstand wird online gespeichert…",

  /** A save the online service would not take. The copy is on disk; the user is told once. */
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
   * (reports/milestone-1.md §3). The app looks for the new version at once; this is only shown when
   * none has been published yet (the release pipeline builds one within a few hours).
   */
  needsGameUpdate: {
    message: `${APP_NAME} hat eine neue Version bekommen.`,
    detail:
      `Das passiert, wenn du ${APP_NAME} zwischendurch im Browser gespielt hast. ` +
      "Dein Spielstand ist vollständig, es geht nichts verloren. " +
      "Die neue Version für diesen Computer wird gerade vorbereitet. " +
      `Öffne ${APP_NAME} in ein paar Stunden noch einmal, dann wird sie automatisch geladen.`,
    ok: "OK",
  },

  /** The small window shown while a new version downloads and when it is ready. */
  update: {
    title: `${APP_NAME} wird aktualisiert`,
    downloading: "Eine neue Version wird geladen. Du kannst dabei weiterspielen.",
    progress: (percent: number, mb: number): string => `${percent} % von ${mb} MB`,
    hide: "Im Hintergrund laden",
    ready: `Die neue Version ist bereit. ${APP_NAME} startet kurz neu, dein Spielstand wird vorher gespeichert.`,
    restartNow: "Jetzt neu starten",
    later: "Beim Schließen",
    failed: "Die neue Version konnte gerade nicht geladen werden. Das wird beim nächsten Start noch einmal versucht.",
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
