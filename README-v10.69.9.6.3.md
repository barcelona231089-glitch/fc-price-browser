# FC Trader Brain v10.69.9.6.3

24-month runtime activation fix after v10.69.9.6.2 booted but `/api/readiness` still reported `10.69.9.3-final`.

## What changed
- Keeps the known-good v10.69.9.3 loader chain as the base.
- Replaces the all-or-nothing v10.69.9.6 server patch with incremental, anchor-tolerant 24-month hooks.
- Learning windows are forced to 730 days even if an older loader already changed the previous numeric default.
- Permanent ML scoring is attached to each Trader Brain input in memory.
- FC25 + FC26 two-year history is attached only to sparse Gemini candidates.
- Permanent ML startup is non-blocking after DB initialization.
- `/health` immediately exposes `ml24Patch`, `twoYearAiFeed`, and `permanentMl` diagnostics.
- Runtime reports `10.69.9.6.3-final` only when all critical server hooks are active; otherwise `10.69.9.6.3-degraded`.
- Existing resilient Permanent ML retry patch remains active.
- Existing traderBrain 24m calibration/Gemini patch remains active.

## Upload
Replace/upload only:
- `v1069963Bootstrap.mjs`
- `v1069963Loader.mjs`
- `package.json`

Keep all existing v10.69.9.3, v10.69.9.6 and v10.69.9.6.1 files.

## Verify after deploy
1. `/api/readiness` should show version `10.69.9.6.3-final`.
2. `/health` should contain `ml24Patch.learningWindowDays: 730` and `ml24Patch.criticalOk.ok: true`.
3. `/health.permanentMl` should report targetMonths 24 / learningWindowDays 730.
4. `full24MonthWindowAvailable` may remain false until the database really contains the full real history. No synthetic rows are created.
