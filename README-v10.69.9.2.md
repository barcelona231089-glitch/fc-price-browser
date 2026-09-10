# FC Trader Brain v10.69.9.2

Hotfix for the failed v10.69.9.1 Hostless deployment.

Cause:
v10.69.9.1 matched the old monitorOnce() header exactly. The current server has
HA and ÜV CPU-safe checks before `monitoringBusy = true`, so the loader threw
`monitor start anchor missing` at runtime. Docker build still succeeded because
the loader only runs when Node starts.

v10.69.9.2 anchors on the stable monitor body instead.

Changes:
- monitor phase telemetry in /api/readiness
- 8-minute hard watchdog (override: MONITOR_CYCLE_HARD_TIMEOUT_SECONDS)
- clean process exit on a truly stuck cycle so Hostless can restart it
- no trading/scoring/price/source-policy changes

Upload these files to the repo root, replacing package.json:
- package.json
- v106992Register.mjs
- v106992Loader.mjs

Then redeploy Hostless.
