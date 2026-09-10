# FC Trader Brain v10.69.9.6.2

Hostless deployment diagnostic + fail-safe startup layer for the approved 24-month Permanent ML build.

## Why
v10.69.9.6 and v10.69.9.6.1 both built and pushed successfully on Hostless but failed before promotion, while v10.69.9.3 remained live. This revision removes the nested 9.6/9.6.1 register chain from the npm start path.

## Startup
`npm start` now runs `node ./v1069962Bootstrap.mjs`.

The bootstrap:
1. Registers only the known-good v10.69.9.3 loader chain.
2. Registers one consolidated v10.69.9.6.2 loader.
3. Imports server.js inside a visible try/catch so pre-HTTP import failures print a full stack trace.

## Fail-safe behavior
The consolidated loader attempts the approved 24-month patches. If a 24-month anchor is incompatible at runtime, it logs the exact error and returns the already-patched v10.69.9.3 source instead of killing the process. This makes the next Hostless result diagnostic:
- If the 24m patch works: runtime label becomes `10.69.9.6.2-final`.
- If a patch anchor fails: the app should still boot on the known-good base and the log identifies the failed patch.
- If deployment still fails before any bootstrap log appears: the failure is outside the Node/ML patch path and points to Hostless deployment/promotion/configuration.

## 24-month target retained
The feature modules remain unchanged: 730-day target, FC25 + FC26 separated by game_year, no synthetic history, persistent PostgreSQL ML, walk-forward validation, trader/leak/context features, 1h/6h/24h outcome learning and 5% EA tax-aware labels.

## Upload
Upload/replace only:
- v1069962Bootstrap.mjs
- v1069962Loader.mjs
- package.json

Keep the existing v10.69.9.6 files and the older v10.69.9.3 chain.
