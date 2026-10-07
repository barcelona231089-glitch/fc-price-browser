# Testergebnisse – API Traffic Finder

Geprüft unter Linux mit Node.js v24.19.0, pnpm 11.25.0 und echtem Chrome Headless Shell 154.0.8037.92. Letzter Live-Prüflauf: 2026-10-05T23:41:52.902Z (UTC). Es wurden keine Netzwerk- oder API-Antworten gemockt.

## Gesamtstand

| Prüfung | Ergebnis |
| --- | --- |
| `pnpm install --frozen-lockfile` | bestanden |
| `pnpm codegen` | Client und Zod-Validator erfolgreich neu generiert |
| `pnpm typecheck` | alle Libraries, Backend, Frontend, Mockup und Scripts bestanden |
| `pnpm build` | vollständiger Workspace erfolgreich gebaut |
| `pnpm test` | 8 Tests bestanden, 0 fehlgeschlagen |
| `pnpm test:e2e` | 15 echte Browserprüfungen bestanden |
| `pnpm test:live` | 4 öffentliche Live-Prüfungen bestanden |
| `pnpm test:startup` | gebaute UI, Backend und Proxy erfolgreich gestartet |

Die 204 ursprünglichen Quell-/Konfigurationsdateien sind weiterhin vorhanden. Hinzugekommen sind die gemeinsamen Traffic-Funktionen, Tests, Starter und Dokumentation. Die ZIP enthält keine installierten Abhängigkeiten, Browserprogramme, Umgebungsdateien mit Zugangsdaten oder Traffic-Rohdaten.

## Öffentlicher Live-Test

Ziel: `https://jsonplaceholder.typicode.com/posts/1` über UI-Port 5173 und echten `/api`-Proxy auf Backend-Port 5174, mit regulärer Produktionskonfiguration.

| Beobachtung | Ergebnis |
| --- | --- |
| Normale Analyse `/api/traffic/analyze` | HTTP 200 |
| Erfasster Zielrequest | GET /posts/1, HTTP 200, Host jsonplaceholder.typicode.com, REST |
| `jsonSchema`-Feldnamen | body, id, title, userId |
| Interaktive Sitzung starten | HTTP 201 |
| Interaktiven Zustand lesen | HTTP 200, Screenshot vorhanden, identisches Schema |
| Sitzung nach dem Schließen lesen | HTTP 404 |
| Bereinigter JSON-Download | echter Browserdownload, Schema ohne Werte, keine Bodies/Header |

Die Arbeitsumgebung hatte keine normale DNS-Auflösung; dafür wurde die dokumentierte Option `TRAFFIC_DNS_OVER_HTTPS=1` verwendet. Die Prüfung öffentlicher IP-Adressen blieb aktiv. Ein vorhandener Umgebungsproxy wurde verwendet. Es gab keine Ausnahme für das Live-Ziel und keine Ersatzantworten.

## Browser-E2E mit echtem Testserver

Der lokale Testserver erzeugt echte HTTP-, Fetch-, XHR-, GraphQL- und WebSocket-Verbindungen. Nur der Testprozess erlaubt dessen lokalen Fixture-Host; diese Ausnahme ist weder API-Parameter noch Produktionsoption. Geprüft wurden:

1. Normale Analyse über den vollständigen UI-/Proxy-/Backend-Pfad mit Method, Status, Host, Path, Ressourcentyp, API-Art, Dauer und Schema.
2. API-Kandidaten, sich überschneidende Fetch/XHR-/API-Filter, Suche nach Schemafeldnamen, leere Ergebnisse und Endpoint-Gruppen.
3. Echter normaler JSON-Download mit bereinigten Metadaten und wertfreiem `jsonSchema`.
4. Ungültige JSON-Antwort: Analyse HTTP 200 und `jsonSchema: null`, kein HTTP 500.
5. Gesperrte private Ziele bei einfacher und mehrfacher Weiterleitung; fremder UI-Origin HTTP 403.
6. Interaktive Analyse mit Screenshot, echten Requests und Polling.
7. Maskierte Zugangsdatenfelder und blockierte Eingabe im tatsächlich fokussierten Passwortfeld.
8. Pausieren, Fortsetzen und **Ab hier beobachten**; Endpoint-Gruppierung numerischer IDs.
9. Interaktive Suche, Filter, Kandidaten und leere Treffer.
10. Ausschluss einer echten, noch laufenden alten Antwort nach dem Aufnahme-Reset.
11. Gewöhnliche Tastatureingabe mit Enter löst einen echten Request aus.
12. Echter interaktiver JSON-Download ohne Sitzungsschlüssel, Screenshots, Parameterwerte und Secrets.
13. Gleichzeitige Sitzungen begrenzt, ohne bestehende Sitzungen zu schließen oder Browser zu verlieren.
14. Sauberes Schließen, danach HTTP 404; keine übertragenen Zugangsdaten und keine Browser-JavaScript-Fehler.
15. Mobilansicht ohne horizontalen Überlauf der gesamten Seite.

Im Fixture wurden 9 Requests erfasst, darunter 8 Fetch/XHR-, 4 REST-, 2 GraphQL- und 1 WebSocket-Erkennungen. Die Kategorien überschneiden sich. Die WebSocket-Verbindung wurde tatsächlich aufgebaut; Playwright liefert bei dieser gerouteten Verbindung keinen Handshake-Status. Die UI zeigt dafür korrekt `—` und erfindet keinen HTTP-Status.

## HTTP-500-Diagnose und Vertragskorrektur

Die exakte Meldung „The analysis result could not be prepared.“ stammt aus der Zod-Prüfung der fertigen Analyseantwort. Sie bedeutet eine Abweichung vom internen API-Antwortvertrag, keinen defekten `/api`-Proxy.

Der hochgeladene Quellstand enthielt noch weder `jsonSchema` noch `responseSchema`. Der beim Nutzer zuvor laufende neuere Stand und dessen fehlerhafter Datensatz waren nicht enthalten; der exakt gleiche Fehler ließ sich mit den unveränderten Quellmetadaten daher nicht reproduzieren. Die einzelne ursprüngliche fehlerhafte Eigenschaft ist damit nicht nachweisbar.

Der fertige Stand verwendet in Backend, OpenAPI, generiertem Zod-Schema, React-Client und beiden UIs ausschließlich `jsonSchema`. Zeitstempel sind ISO-Strings; jeder Request enthält `jsonSchema` oder ausdrücklich `null`. Schema-Erkennung ist begrenzt und ausfallsicher. Alte gebaute Artefakte wurden neu erzeugt. Ein Regressionstest lehnt das alte `responseSchema`-Feld als Ersatz ausdrücklich ab. Beide realen Live-Modi validieren die vollständigen Antworten erfolgreich.

## Beiliegende Nachweise

- `test-results/e2e.json`: Ergebnis der 15 Browserprüfungen (2026-10-05T23:30:54.798Z).
- `test-results/live.json`: Live-Ergebnis mit HTTP-Status und Schemafeldnamen.
- `test-results/startup.json`: Ergebnis des Produktionsstarters (2026-10-05T23:44:16.160Z).
- `test-results/live-dashboard.png` und `interactive-dashboard.png`: Screenshots der geprüften UI.
- `tests/`: reproduzierbare Regressionstests, Browser-E2E, Live-Test und Startprüfung.

Die Windows-Startdatei ist vorbereitet; die Tests wurden in der verfügbaren Linux-Umgebung ausgeführt. Webseiten hinter Anmeldung, CAPTCHA oder Anti-Bot-Schutz wurden nicht umgangen und zählen nicht als erreichbare öffentliche Testziele.
