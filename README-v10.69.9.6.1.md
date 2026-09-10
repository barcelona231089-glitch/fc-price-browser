# FC Trader Brain v10.69.9.6.1

Hostless startup guard for the 24-month Permanent ML build.

## What changed

- Keeps the v10.69.9.6 730-day / FC25+FC26 ML architecture unchanged.
- Removes Permanent ML PostgreSQL initialization from the blocking HTTP startup path.
- Hostless can bring the HTTP server/health endpoint online while ML schema/model loading continues asynchronously.
- If initial ML schema/model loading fails, the ML runtime resets `started=false`, reports `START_RETRY_PENDING`, and retries after 60 seconds.
- ML failure is logged but does not intentionally terminate the Trader Brain HTTP process.
- No FUTBIN logic, price authority, trading rules, 730-day learning policy, or FC25/FC26 separation is changed.

## Upload to repository root

- `v1069961Loader.mjs`
- `v1069961Register.mjs`
- `package.json`

Keep all v10.69.9.6 and older files in place.

Expected runtime label after a successful deploy: `10.69.9.6.1-final`.
