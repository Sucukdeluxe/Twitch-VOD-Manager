# Twitch Downloader – Projekt-Memory

## Zweck und Arbeitsstand

Windows-Desktopanwendung auf Basis von Electron und TypeScript zum Durchsuchen, Herunterladen, Schneiden, Zusammenfügen und Verwalten von Twitch-VODs, Clips und lokalen Videos.

Am 6. September 2026 nach einem Festplatten-Reset aus den vorhandenen Remote-Repositories wiederhergestellt. Der lokale Projektordner heißt `Twitch Downloader`. Die Anwendung, Paketkennung, Installer, Update-Adressen und Remote-Repositories heißen weiterhin `Twitch VOD Manager` beziehungsweise `Twitch-VOD-Manager`. Die vollständige Produktumbenennung ist noch offen.

## Git und maßgeblicher Stand

- Arbeitsbranch: `public-v1`, Tracking: `origin/public-v1`.
- `origin`: https://github.com/Sucukdeluxe/Twitch-VOD-Manager.git (bestehendes öffentliches Repository).
- `forgejo`: https://git.24-music.de/Administrator/Twitch-VOD-Manager.git.
- Wiederhergestellte Basis: `35364ca5880ef96e365b65fe55b769d60455972a`, Tag `v1.0.19`, 14. August 2026. Beide Remotes hatten auf `public-v1` exakt diesen Commit.
- GitHubs Standardbranch `main` ist veraltet: `5113089`, Version 1.0.9. Forgejos `main` und `feat/v5-foundation` gehören zu älteren Entwicklungslinien vom Mai 2026. Deren größere Versionsnummern kennzeichnen keinen neueren Stand. Für die Fortsetzung `public-v1` verwenden.
- Forgejo ist auf diesem Rechner über HTTPS erreichbar; der geprüfte SSH-Zugriff wurde abgelehnt.
- Zusammengehörige Änderungen prüfen, committen, zu beiden Remotes pushen und die Commit-IDs verifizieren. Ein Push ist kein Release.

## Letzte Änderungen

- Queue-Details fahren seit dem 6. September 2026 beim Auf-/Zuklappen animiert ein und aus: Grid-Höhe und Deckkraft über 220/180 ms, Pfeilrotation über 220 ms. Bei reduzierten Windows-Animationen bleibt eine kurze 160-ms-Transition wie bei den bestehenden Workspace-Steuerelementen erhalten. Eingeklappte Details sind `inert`, damit unsichtbare Dateiaktionen nicht per Tastatur erreichbar sind. Build, 19 gezielte Tests und isolierter Queue-UI-Test einschließlich gemessener Zwischenhöhen in beiden Bewegungsmodi erfolgreich.
- Queue-Card-Nachbesserung am 6. September 2026: Wartestatus ohne sichtbare Umrandung und ohne gelblichen Hintergrund; gelber Statuspunkt und bisherige Abstände bleiben erhalten. In Hell/Dunkel geprüft, Queue-UI- und Stylesheet-Tests erfolgreich.
- 6. September 2026: Queue-Cards überarbeitet. Titel mit bis zu zwei Zeilen in 13 px; Datum von 10 auf 12 px vergrößert und rechts unter den Fortschrittsbalken gesetzt. Status als beschriftetes Badge, Entfernen/Wiederholen mit 32 × 32 px Klickfläche, Details und Fortschritt in 12 px, keine Kartenschrift unter 10 px. Wartende Einträge ohne doppelte Statuszeile, pausierte Downloads mit erhaltenem Prozentstand, längere Fehler umbrechend.
- Details lassen sich per Doppelklick auf die freie Kartenfläche einschließlich Titel, Datum und Balken umschalten. Ein eigener Pfeil unterstützt Einzelklick, Enter und Leertaste; Schaltflächen lösen keine zusätzliche Kartenaktion aus. Aufklappen aktualisiert die vorhandenen Elemente und erhält den Tastaturfokus.
- 6. September 2026: Windows-Hot-Dev-Start repariert. Die umbenannte Electron-EXE meldet `app.isPackaged` auch im Entwicklungsbetrieb als wahr; die Symbolauflösung berücksichtigt nun ausdrücklich `TWITCH_VOD_MANAGER_DEV` und verwendet das vorhandene `build/icon.ico`.
- 1.0.19: Streamlink und FFmpeg werden nach der Installation automatisch im Hintergrund eingerichtet; die Queue zeigt die Vorbereitung der Download-Werkzeuge an. Außerdem wurden instabile Electron-Smoke-Tests korrigiert.
- 1.0.18: Reparaturen bei Werkzeuginstallation und Windows-Kurzpfaden, robustere Download- und Wiederherstellungsabläufe, Verbesserungen an Updates, Diagnosen, Queue, Streamer-Auswahl und Video-Cutter sowie zusätzliche isolierte Prüfungen.
- 1.0.15 bis 1.0.17: bessere Einstellungsdarstellung, deutsche Diagnosetexte, System-Theme, Cutter-Wiederherstellung und begrenzte Wartezeiten beim Beenden.
- Details stehen in `CHANGELOG.md` und der Git-Historie. Git stellt keine vollständigen früheren Chats, lokalen Zugangsdaten oder verlorenen Nutzerdaten wieder her.

## Lokale Einrichtung und Befehle

Verifiziertes lokales Werkzeugumfeld: Node.js 24.19.0, npm 11.17.0 und PowerShell 7. Die CI verwendet Node.js 24.11.1.

Das `&` im übergeordneten Windows-Ordnernamen führt mit der standardmäßigen npm-Shell zu fehlerhaft ausgewerteten Befehlen. Deshalb enthält die lokale, über `.git/info/exclude` ausgeschlossene `.npmrc` den Eintrag `script-shell=pwsh`. Diese Einstellung bei einer erneuten Wiederherstellung im gleichen Ordner ebenfalls setzen.

```powershell
Set-Content -LiteralPath .npmrc -Value 'script-shell=pwsh' -Encoding utf8
npm ci --ignore-scripts --no-audit --no-fund
node node_modules/electron/install.js
npm run build
npm run dev
```

`npm ci` mit Installationsskripten scheiterte beim automatischen `node-gyp`-Aufruf im Ordner mit `&`. Die Wiederherstellung verwendet die mitgelieferte Windows-Binärdatei von `better-sqlite3`; ein SQLite-Test ausschließlich im Arbeitsspeicher war erfolgreich. Electron wurde anschließend ausdrücklich installiert.

- `npm run dev`: Entwicklungsstart mit Hot Reload; `npm start`: einmaliger Entwicklungsstart.
- Entwicklungsdaten liegen isoliert in `.dev-program-data/` und `.dev-user-data/`; beide Ordner sind ignoriert.
- Basisprüfungen: `npm run build`, `npm run lint`, `npm run security:check`, `npm run test:unit`.
- Queue-UI-Prüfung: `npm run test:e2e:queue-cards`; prüft sechs Zustände in Deutsch/Englisch und Hell/Dunkel sowie Doppelklick, Tastatur, Fortschrittsaktualisierung und Entfernen. Screenshots liegen ignoriert in `tmp_queue-card-artifacts/`. Auch in `test:e2e:focused` und dessen CI-Vertrag eingebunden.
- Isolierter Anwendungstest: `npm run test:e2e`.
- Umfassende Release-Prüfung: `npm run test:e2e:release`; Windows-Paket: `npm run dist:win`.
- Relevante Struktur: `src/main.ts`, `src/main/`, `src/renderer-*.ts`, `src/index.html`, `src/styles*.css`, `src/workspace*.css`, `scripts/` und `build/`.

## Entscheidungen und offene nächste Schritte

- Zunächst den aktuellen Quellstand und die Entwicklungsumgebung wiederherstellen. Keine neue Version veröffentlichen.
- Die gewünschte Umbenennung zu `Twitch Downloader` ist lokal umgesetzt. Eine Umbenennung der Remotes und der Anwendung samt Update-Kompatibilität ist gesondert abzustimmen und zu prüfen.
- Die Standardbranches wurden bei der Wiederherstellung nicht umgestellt oder mit älteren Entwicklungslinien zusammengeführt.
- Nächste fachliche Änderung von Sascha entgegennehmen; vor Änderungen diese Memory, `README.md`, `CHANGELOG.md` und den Git-Status lesen.
- Keine Geheimnisse, Datenbank-Dumps, Backups oder Nutzerdaten committen. Vor schreibenden Live-Datenänderungen gelten Saschas Vorgaben zu Bestandsprüfung, verifiziertem Backup, Staging-Test und ausdrücklichem Go.

## Zuletzt verifizierter Stand

6. September 2026, wiederhergestellter Quellstand 1.0.19:

- Abhängigkeiten und Electron installiert; SQLite ausschließlich im Arbeitsspeicher geprüft.
- `npm run build`: erfolgreich.
- `npm run lint`: erfolgreich mit 15 bereits vorhandenen Warnungen, keine Fehler.
- `npm run security:check`: erfolgreich, keine Befunde.
- `npm run test:unit`: 82 Testdateien und 630 Tests erfolgreich.
- `npm run test:e2e`: erfolgreicher Electron-Start und Smoke-Test mit isolierten Datenverzeichnissen und Offline-Fixtures, keine gemeldeten Probleme.
- `PROJECT_MEMORY.md` separat auf sensible Inhalte geprüft; Ignore-Regeln für Umgebungsdateien, Entwicklungsdaten, Abhängigkeiten und lokale npm-Konfiguration geprüft.
- Kein vollständiger Release-, Installer- oder Live-Twitch-Test in dieser Wiederherstellung; keine Veröffentlichung erstellt.

6. September 2026, anschließende Hot-Dev-Reparatur:

- `npm run build`, die sechs Tests für App-Identität und Entwicklungs-EXE, `npm run security:check` und `npm run test:e2e` erfolgreich.
- `npm run lint`: keine Fehler, weiterhin 15 bestehende Warnungen.
- Tatsächlicher Start über `scripts/dev.mjs` mit der umbenannten Windows-EXE erfolgreich: Anwendungsfenster geöffnet, TypeScript-Watcher aktiv mit null Fehlern. Renderer-Dateien werden automatisch neu geladen; Änderungen am Main-Prozess lösen einen Neustart aus.
- Hot-Dev läuft mit den isolierten Entwicklungsdatenverzeichnissen. Der Launcher kann im Hintergrund über Node gestartet werden; Konsolenprotokolle liegen bei diesem Start außerhalb des Repositories im Windows-Temp-Verzeichnis.
- Streamlink 8.4.0 im Entwicklungsverzeichnis eingerichtet und per `--version` geprüft. Der vorhandene Managed-Tool-Installer hat Archiv- und EXE-Prüfsummen verifiziert; zum Entpacken wurde lokal PowerShell 7 mit `Expand-Archive -LiteralPath` und über Umgebungsvariablen übergebenen Pfaden verwendet.
- Der automatische Installationsversuch mit Windows PowerShell meldete zuvor `required-executable-missing`. Die lokale Einrichtung ist behoben; die Ursache im allgemeinen Entpackablauf ist noch offen.
- Anschließender Hot-Reload-Neustart tatsächlich ausgelöst und geprüft: Das neue Anwendungsfenster reagiert, und der reale Preflight meldet Internet, Streamlink, FFmpeg, FFprobe und beschreibbares Download-Verzeichnis als erfolgreich. Keine Live-Downloads gestartet.

6. September 2026, Queue-Card-Rework (unveröffentlicht, Version weiterhin 1.0.19):

- Build, alle 630 Unit-Tests, isolierte Queue-Card-Prüfung und umfassender Workspace-UI-Test erfolgreich; keine gemeldeten Laufzeitfehler.
- Queue-Screenshots in Hell und Dunkel visuell geprüft; Datum rechts unter dem Balken, ausreichend große Aktionsflächen und keine horizontale Überläufe.
- Lint ohne Fehler bei den bekannten 15 Warnungen. Lokale Entwicklungsdaten und installierte Drittanbieter-Werkzeuge sind nun ausdrücklich von ESLint ausgeschlossen; vier Lint-Konfigurationstests erfolgreich.
- Security-/Public-Manifest-, CI- und E2E-Isolationsprüfungen erfolgreich. Der neue UI-Test steht in der öffentlichen Datei-Allowlist; Entwicklungsdaten und Screenshots bleiben außerhalb von Git.
- Hot-Dev bleibt aktiv. Keine Veröffentlichung und kein Live-Download für diese UI-Änderung.
