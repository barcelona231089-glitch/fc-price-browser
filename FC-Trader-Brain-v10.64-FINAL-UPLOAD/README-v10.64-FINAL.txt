FC Trader Brain v10.64 FINAL
===========================

Ziel
----
FUT.GG bleibt die primaere Live-Quelle. FUTBIN ergaenzt fehlende Trading-Daten.
Der Brain speichert und lernt aus vorhandener FC26-Markt-, Event- und Preis-Historie.
Discord bleibt strikt auf finale KAUFEN/VERKAUFEN-Calls begrenzt.

Wichtigste Erweiterungen
------------------------
- FUTBIN Games/GPG, Konsolen-/PC-Preise, Preis-Updatezeit, Trend, Price Range, PRP.
- Positionen, Nation/Liga/Club, Karten-Version/Promo, Versionsvergleich soweit oeffentlich erkennbar.
- Echte beobachtete Listed-for/Sold-for-Zeilen, verkauft/nicht verkauft, Steuer und Netto.
- Sell-through, Sale-/Listing-Velocity, Median/Ø/P25/P75/Min/Max Sales, Stabilitaet, Liquiditaet.
- Undercut-Rate, Relist- und Verkaufszeit-Schaetzungen aus beobachteten oeffentlichen Listing-Zeilen.
- Preis-Historie und Fenster 5m/15m/1h/6h/24h/7d/30d.
- FUTBIN Markt-Indizes, Rating-Index-Kontext und Market Momentum mit 10-Minuten-Cache.
- Source-Freshness FUT.GG vs FUTBIN und Preisvergleich zu EA Average.
- FC26 Season Memory: Tages-OHLC, Return, Volatilitaet, Drawdown, Crash/Recovery, Season-Phasen.
- FC26 Event Memory: SBC, EVO, Promo, Rewards, Supply, Out-of-Packs, Leaks/Trader und historische Auswirkungen.
- FC27 Transfer Learning nutzt FC26-Muster mit sinkendem Alt-Saison-Gewicht.
- Parse/FUTBIN-402 ist aus dem kritischen Runtime-Pfad entfernt.
- CPU-Governor, HA und ÜV v2.10.4 bleiben erhalten.
- Hostless startet ueber node --import/register() statt --experimental-loader.

FC Market API (read-only)
-------------------------
GET /api/market/player/:eaId
GET /api/market/prices/:eaId
GET /api/market/sales/:eaId
GET /api/market/versions/:eaId
GET /api/market/memory/:eaId
GET /api/market/history/:eaId
GET /api/market/demand/:eaId
GET /api/market/trends
GET /api/market/overview
GET /api/market/events
GET /api/market/regimes
GET /api/market/source-health

Diagnose
--------
GET /api/final-project/status
GET /api/futbin-public/status
GET /api/fc26-memory/status
GET /api/adaptive-brain/status
GET /api/uv/status

FC26 Memory
-----------
POST /api/fc26-memory/rebuild
POST /api/fc26-memory/backfill

Historische Daten werden NICHT erfunden. Der Brain nutzt alle vorhandenen FC26-Daten aus PostgreSQL,
FUT.GG, gespeicherter FUTBIN-Historie und vorhandenen Event-/Signal-Outcomes. Wenn ein historischer
Zeitraum bei den Quellen nicht vorhanden ist, bleibt er als fehlend behandelt.

Upload
------
Alle Dateien/Ordner aus diesem Paket in den ROOT des bestehenden GitHub-Repositories hochladen.
Vorhandene gleichnamige Dateien ersetzen. Bestehende andere Repo-Dateien NICHT loeschen.
Danach Hostless auf den neuen Commit deployen.
