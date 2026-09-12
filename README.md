# Leak Hotfix L3

Ändert die Leak-/Market-Knowledge-Messpunkte auf:

2m → 5m → 15m → 1h → 6h → 24h

Die eigentliche Marktreaktionsmessung und das Knowledge-Learning verwenden beide diese Horizonte.
Der Default für MARKET_KNOWLEDGE_MIN_SAMPLES wird von 12 auf 18 angehoben, damit die zwei
zusätzlichen kurzen Horizonte nicht allein zu einer zu frühen Reife einer Wissensregel führen.

Upload in den GitHub-Hauptordner:
- v1069965LeakHotfixL3Bootstrap.mjs
- v1069965LeakHotfixL3Loader.mjs
- package.json
