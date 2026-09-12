# Leak Hotfix L4 - Official X API

Prioritaet:
1. Official X API v2
2. X public syndication
3. Public mirrors / search fallback
4. Telegram fallback

Die vier vorhandenen Handles bleiben:
FutSheriff, FutPoliceLeaks, Criminal__x, Futdonk.

Nach dem Upload in Hostless eine geheime Environment Variable setzen:

X_BEARER_TOKEN=<dein X Developer Bearer Token>

Den Token niemals ins Repo oder in Chat-Nachrichten schreiben.

Upload in den GitHub-Hauptordner:
- v1069965LeakHotfixL4Bootstrap.mjs
- v1069965LeakHotfixL4Loader.mjs
- package.json

Danach pruefen:
https://fc-trader-brain.hostless.app/api/public-leaks/status

Erwartet:
xApi.configured = true
und bei erfolgreicher API-Abfrage sourceStatus.x:<Handle>.provider = "Official X API v2"

Ohne Token oder bei API-Fehlern bleibt die bestehende Leak-Pipeline automatisch aktiv.
