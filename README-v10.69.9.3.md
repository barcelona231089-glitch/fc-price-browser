# FC Trader Brain v10.69.9.3

Fixes the v10.69.9.2 startup failure.

Root cause:
v10.69.9.2 required the legacy
`enrichImportantRowsWithFutbinParse(...)` call as a telemetry anchor.
The active v10.66+ loader chain has already replaced that call with
`enrichRowsWithFutbinSafeV1066(...)`, so the telemetry loader aborted startup.

v10.69.9.3:
- supports both legacy and safe-bridge FUTBIN enrichment anchors
- treats diagnostic phase anchors as optional so telemetry cannot crash boot
- keeps the monitor watchdog and /api/readiness phase telemetry
- does not change prices, scoring, trading decisions, FUT.GG authority, or FUTBIN data policy

Upload to repo root:
- package.json (replace)
- v106993Register.mjs
- v106993Loader.mjs
- README-v10.69.9.3.md (optional)

Then redeploy Hostless.
