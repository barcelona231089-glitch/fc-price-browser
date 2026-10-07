# API Traffic Finder

Bestehender pnpm-Workspace mit deutschem React/Vite-Dashboard und Express-/Playwright-Backend. Die vollständige Start- und Bedienungsanleitung steht in `README.md`, die geprüften Ergebnisse in `TESTERGEBNISSE.md`.

## Betrieb

- Node.js 24, pnpm 11.25.0.
- `pnpm install --frozen-lockfile`, `pnpm setup:browser`, `pnpm dev`.
- Dashboard Port 5173, Backend Port 5174, Vite-Proxy `/api`.
- In Replit bindet der Starter an `0.0.0.0`; lokal an `127.0.0.1`.
- `pnpm build` prüft und baut alle vorhandenen Pakete; `pnpm start` startet den gebauten Stand.
- `pnpm codegen` regeneriert Client und Zod-Validator aus `lib/api-spec/openapi.yaml`.
- Der Finder benötigt keine Datenbank. Das vorhandene DB-Paket bleibt erhalten.

## Architektur und Grenzen

- `lib/traffic-core` enthält gemeinsame Bereinigung, Schema-Erkennung, Filter und Endpoint-Gruppen.
- Das API-Schemafeld heißt ausschließlich `jsonSchema`; Zeitstempel sind ISO-Strings.
- Frische, kurzlebige Browserkontexte. Keine Traffic-Persistenz oder Speicherung von Headern, Bodies und Secrets.
- Nur öffentliche Ziele. Private/lokale Subrequests und Redirects werden blockiert, auch bei mehreren Weiterleitungen.
- Normale Analyse passiv; interaktive Analyse erlaubt gewöhnliche Bedienung, sperrt Zugangsdatenfelder und Zwischenablage.
- Kein Login-, CAPTCHA-, Anti-Bot- oder Zugriffsschutz-Bypass.
- Ergebnisse lassen sich nach API-Art/Kandidaten filtern, nach Pfaden und Schemafeldnamen suchen, gruppieren und bereinigt exportieren.

## Prüfbefehle

`pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:e2e`, `pnpm test:live`, `pnpm test:startup`.
