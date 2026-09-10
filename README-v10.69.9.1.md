# FC Trader Brain v10.69.9.1 - Monitor Hang Guard

This is a small runtime hotfix on top of v10.69.8.

## What changes
- Adds the current market-cycle phase to `/api/readiness` and `/health`.
- Adds cycle and phase age telemetry.
- Adds a fail-safe watchdog. Default hard timeout: 720 seconds (12 minutes).
- If a cycle exceeds the hard timeout, the Node process exits so Hostless can restart cleanly.
- It never starts a second overlapping market cycle.

## What does NOT change
- No price logic changes.
- No scoring/trading decision changes.
- FUT.GG remains the price authority.
- No FUTBIN bypass logic is added.
- The local v10.69.9 Browser Evidence Collector stays separate.

## Optional environment variable
`MONITOR_CYCLE_HARD_TIMEOUT_SECONDS`

Allowed by the patch: 300 to 1800 seconds. Default: 720.

## Upload
Upload these files into the repository root, replacing `package.json`:
- `v106991Register.mjs`
- `v106991Loader.mjs`
- `package.json`
- optional README/test files

Then redeploy Hostless normally.

## Verification
Open `/api/readiness`. Under `checks.monitoringLoop` you should see fields such as:
- `phase`
- `cycleStartedAt`
- `cycleAgeSeconds`
- `phaseAgeSeconds`
- `hardTimeoutSeconds`
- `watchdogTrips`

If the Brain gets slow again, the `phase` field identifies the exact stage instead of only showing `busy:true`.
