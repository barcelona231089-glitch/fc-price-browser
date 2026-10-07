# API Traffic Finder

Fertiggestellter Stand des bestehenden Projekts. Das deutsche Dashboard analysiert öffentliche, ohne Anmeldung erreichbare Seiten und beobachtet ihre API-Anfragen. Die vorhandene normale Analyse und die interaktive Browseransicht bleiben erhalten.

## Start unter Windows

1. Node.js 24 installieren.
2. Die ZIP vollständig entpacken.
3. `START.cmd` doppelklicken. Beim ersten Start werden pnpm und die Projektabhängigkeiten eingerichtet. Ein vorhandener Chrome-/Edge-Browser wird verwendet; andernfalls wird Chromium installiert.

Das Dashboard öffnet sich unter **http://localhost:5173**. Das Backend läuft auf **5174**; `/api` wird automatisch weitergeleitet. Zum Beenden im Startfenster **Strg+C** drücken. Die erste Installation benötigt eine Internetverbindung.

## Start unter Linux, macOS oder Replit

Node.js 24 und pnpm 11.25.0 verwenden. Im entpackten Projektordner:

```sh
pnpm install --frozen-lockfile
pnpm setup:browser
pnpm dev
```

Unter Linux benötigt Chromium seine üblichen Systembibliotheken. Falls diese fehlen, installiert `pnpm --filter @workspace/api-server exec playwright install --with-deps chromium` auch die Browserabhängigkeiten. Ein bereits vorhandener Browser kann über `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` angegeben werden. In Replit wird vorhandenes Chromium automatisch gefunden; die Server binden dort an `0.0.0.0`.

Für den gebauten Stand:

```sh
pnpm build
pnpm start
```

Die ZIP enthält außerdem die bereits geprüften Builds. `node_modules` und Browserprogramme sind nicht enthalten; die Abhängigkeiten werden aus der beiliegenden Sperrdatei installiert. Eine Datenbank ist für den Traffic Finder nicht erforderlich. Die vorhandenen DB- und Mockup-Pakete sind weiterhin im Workspace vorhanden.

## Bedienung

- URL eingeben, Berechtigung bestätigen und die normale Analyse starten. Die Aufnahmedauer lässt sich auswählen.
- Die interaktive Analyse zeigt den entfernten Browser. Maus, Scrollen und gewöhnliche Tastatureingaben funktionieren. Die Aufzeichnung lässt sich pausieren und fortsetzen.
- **Ab hier beobachten** löscht die bisherigen Anfragen und beginnt die Beobachtung neu. Bereits laufende Antworten aus der vorherigen Aufnahme werden nicht nachträglich aufgenommen.
- Die Tabellen zeigen Methode, HTTP-Status, Host, Pfad, Ressourcentyp, erkannte API-Art und Dauer. Fetch/XHR, REST, GraphQL und WebSocket werden erkannt. Ein nicht vom Browser gelieferter Status wird als `—` angezeigt; das kann bei WebSocket-Handshakes vorkommen.
- API-Kandidaten haben eine Kennzeichnung mit Begründungen. Suche und Filter berücksichtigen auch JSON-Schema-Feldnamen. Fetch/XHR ist ein zusätzlicher Ressourcenfilter und kann sich mit REST oder GraphQL überschneiden.
- Endpoint-Gruppen fassen gleiche Methoden und Pfadmuster zusammen, etwa `/posts/1` und `/posts/2` zu `/posts/:id`.
- Aufklappbare JSON-Schemata zeigen Feldnamen und Typen. Die Schemata enthalten keine Antwortwerte.
- **JSON exportieren** lädt den bereinigten Aufnahmestand herunter. Screenshots, Sitzungsschlüssel, Header, Request-/Response-Bodies, URL-Parameterwerte und Geheimnisse sind ausgeschlossen.

## Datenschutz und Zugriffsschutz

Jede Analyse verwendet einen frischen Browserkontext. Traffic-Ergebnisse bleiben im Arbeitsspeicher; es gibt keine Speicherung in einer Datenbank, im Local Storage oder in einer Ergebnisdatei auf dem Server. Eine interaktive Sitzung endet spätestens nach 30 Minuten, nach drei Minuten Inaktivität oder beim Schließen.

Cookies, Authorization-Header, Passwörter, Tokens und andere erkannte Zugangsdaten werden weder als Traffic-Metadaten gespeichert noch exportiert. JSON-Antworten werden nur vorübergehend zur Typ-/Feldnamen-Erkennung gelesen; Werte werden verworfen. Sensible Feldnamen werden aus dem Schema entfernt. Weitergeleitete Anfragen verwenden eine Header-Whitelist; Cookies und sensitive Antwortheader werden entfernt. URLs werden von Zugangsdaten, Query-Strings und Fragmenten bereinigt; verdächtige Pfadsegmente werden redigiert.

Die interaktive Ansicht maskiert Zugangsdatenfelder und JSON-Dokumente. Tastatureingaben in Passwort-/Tokenfelder sowie Zwischenablageaktionen sind blockiert. Private/lokale Ziele und entsprechende Weiterleitungen sind im regulären Betrieb gesperrt. Login, CAPTCHA, Anti-Bot und Zugriffsschutz werden nicht umgangen. Geschützte Antworten erscheinen als Warnung oder blockierter Request.

## Entwicklung und Tests

```sh
pnpm codegen       # OpenAPI → React-Client und Zod-API-Schema
pnpm typecheck
pnpm build
pnpm test          # 8 Regressionstests
pnpm test:e2e      # 15 echte Browserprüfungen mit lokalem HTTP-/WebSocket-Server
pnpm test:live     # 4 Live-Prüfungen gegen JSONPlaceholder
pnpm test:startup  # Startprüfung des gebauten Projekts
```

Vor Browserprüfungen `pnpm setup:browser` ausführen. Die E2E-/Live-Prüfungen benötigen freie Ports 5173 und 5174, die Startprüfung 6183 und 6184. Die E2E-Fixture darf ausschließlich im Testprozess lokal angesprochen werden; die Produktions-API hat keinen Schalter zum Freigeben privater Ziele.

Der API-Vertrag steht in `lib/api-spec/openapi.yaml`. Nach Änderungen `pnpm codegen` ausführen. Das einzige Schemafeld heißt durchgängig **`jsonSchema`**. ISO-Zeitstempel werden als Strings übertragen und validiert. Generierter Client und Validator sind in der ZIP aktuell.

Wichtige Dateien:

- `artifacts/api-server/src/lib/traffic-analyzer.ts`: Erfassung, Browser, sichere Requests und Netzwerkkontrollen.
- `artifacts/api-server/src/lib/interactive-traffic-session.ts`: interaktive Sitzungen.
- `lib/traffic-core/src/index.ts`: gemeinsame Bereinigung, JSON-Schema, Filter und Gruppierung.
- `artifacts/api-traffic-finder/src`: Dashboard und interaktive UI.
- `TESTERGEBNISSE.md` und `test-results/`: dokumentierte Prüfergebnisse.

Optionale Umgebungsvariablen: `API_PORT` (5174), `UI_PORT` (5173), `HOST`, `BASE_PATH` (`/`), `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` und `ALLOWED_ORIGINS` (kommagetrennte zusätzliche Browser-Ursprünge). In Umgebungen ohne funktionierende normale DNS-Auflösung kann `TRAFFIC_DNS_OVER_HTTPS=1` die weiterhin auf öffentliche IPs beschränkte DNS-Prüfung über Cloudflare verwenden. Für Node.js-Netzwerkzugriffe über einen vorhandenen Umgebungsproxy kann zusätzlich `NODE_USE_ENV_PROXY=1` erforderlich sein. Proxy-Zugangsdaten gehören ausschließlich in die Prozessumgebung.

## Der gemeldete HTTP-500-Fehler

„The analysis result could not be prepared.“ entsteht bei der internen Prüfung der Analyseantwort mit `AnalyzeTrafficResponse.safeParse`, nachdem die Browseranalyse bereits stattgefunden hat. Der Fehlerpfad liegt damit im Antwortvertrag. Der hochgeladene Quellstand war älter als der beschriebene laufende Stand: Er enthielt noch kein `jsonSchema`/`responseSchema`; der konkrete fehlerhafte Datensatz der zuvor laufenden Version war in der ZIP nicht enthalten.

Der fertige Stand vereinheitlicht Backend, OpenAPI, generierten Client, Validator und beide UIs auf `jsonSchema`, validiert Zeitstempel als ISO-Strings und setzt fehlende/nicht lesbare JSON-Schemata auf `null`. Die Builds wurden neu erzeugt. Sowohl normale als auch interaktive Live-Analyse von `https://jsonplaceholder.typicode.com/posts/1` funktionieren über den echten `/api`-Proxy ohne HTTP 500. Einzelheiten stehen in `TESTERGEBNISSE.md`.
