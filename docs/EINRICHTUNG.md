# Einrichtung mit ihr: einmalig, ca. 20 Minuten

Leitfaden für dich. Du gehst das einmal mit ihr am Laptop durch, danach muss sie nichts mehr wissen.

## Vorher, bei dir

- [ ] Auf GitHub unter **Releases** gibt es ein Release `release-v…-app…`. Falls nicht: Tab **Actions** → **Release** → **Run workflow**, ca. 30 Minuten warten.
- [ ] `PokeRogue-Setup.exe` aus dem Release herunterladen und auf einen USB-Stick legen, oder den Link bereithalten.
- [ ] Sie hat ihren PokéRogue-Benutzernamen und ihr Passwort parat.

## Am Laptop

**1. Aktueller Stand im Browser merken**
- [ ] Auf pokerogue.net einloggen, **Menü → Statistiken → Spielzeit** notieren.
- [ ] Browser-Tab schließen. Damit ist sichergestellt, dass nicht beide gleichzeitig speichern.

**2. Installieren** (WLAN an)
- [ ] `PokeRogue-Setup.exe` doppelklicken.
- [ ] Bei „Der Computer wurde durch Windows geschützt“: **Weitere Informationen → Trotzdem ausführen**.
- [ ] Nach etwa einer Minute startet PokéRogue von selbst. Symbol liegt auf dem Desktop.

**3. Einloggen**
- [ ] Mit ihrem normalen Namen und Passwort im Spiel einloggen.
- [ ] **Menü → Statistiken → Spielzeit** zeigt denselben Wert wie im Browser. Wenn nicht: nicht weiterspielen, siehe „Wenn etwas nicht stimmt“.

**4. Offline ausprobieren**
- [ ] Flugmodus einschalten.
- [ ] Eine Runde fortsetzen oder starten und eine Welle spielen.
- [ ] PokéRogue schließen und wieder öffnen. Sie ist ohne Nachfrage eingeloggt und die Runde ist auf der letzten Welle.

**5. Wieder online**
- [ ] Flugmodus aus, PokéRogue offen lassen, eine Minute warten.
- [ ] Rechtsklick auf das PokéRogue-Symbol unten rechts in der Taskleiste → **Einstellungen…**
- [ ] „Zuletzt online gespeichert“ zeigt „gerade eben“ oder „vor einer Minute“. Damit ist der Offline-Fortschritt in ihrem Konto.

**6. Ihr in drei Sätzen erklären**
- „Spiel ab jetzt immer über dieses Symbol, mit oder ohne Internet.“
- „Wenn ein Fenster sagt, dass eine neue Version geladen wird, einfach weiterspielen und danach auf *Jetzt neu starten* klicken.“
- „Falls es mal fragt, welcher Spielstand bleiben soll, nimm den mit der höheren Spielzeit.“

## Gut zu wissen

- **Updates** kommen von selbst: Beim Start prüft die App die Version, lädt Neues herunter und installiert beim Neustart. Das sind rund 600 MB. Läuft das über ihren Handy-Hotspot, einfach PokéRogue schließen, dann lädt es beim nächsten Start im WLAN.
- **Im Browser spielen** geht weiter, sollte aber die Ausnahme sein. Wurde auf beiden Seiten gespielt, ohne dass die App online war, kommt die Frage nach dem Spielstand.
- **Sicherungskopien** liegen in `Dokumente\PokeRogue Backups`. Jede Datei lässt sich im Spiel über **Menü → Daten verwalten → Daten importieren** zurückholen.

## Wenn etwas nicht stimmt

- Nichts löschen, nicht neu installieren.
- Die Protokolle liegen unter `%APPDATA%\PokeRogue Offline\logs`. Die neueste Datei zeigt, was passiert ist, und enthält kein Passwort.
- Der Spielstand ist in `%APPDATA%\PokeRogue Offline\mirror` und zusätzlich als Sicherungskopie in `Dokumente\PokeRogue Backups`.
