# FC Trader Brain v10.69.9.6.4

Purpose: repair the three server hooks that live v10.69.9.6.3 diagnostics proved were missing.

Live 6.3 diagnosis:
- brainWindow730: anchor-missing
- performanceWindow730: anchor-missing
- mlStartup: anchor-missing

Fixes:
- format-agnostic replacement of BRAIN_LEARNING_WINDOW_DAYS declaration to 730
- format-agnostic replacement of PERFORMANCE_LAB_WINDOW_DAYS declaration to 730
- ML startup insertion scoped to initializeRuntime() and anchored only on await initDb();
- non-blocking Permanent ML startup
- /health static patch diagnostics retained
- FC25 + FC26 remain separated
- real observed data only, no synthetic history

Upload to repository root:
1. v1069964Bootstrap.mjs
2. v1069964Loader.mjs
3. package.json

Keep all older chain files required by v106993Register.mjs and the existing 24m modules.

Expected /health after deployment:
- version: 10.69.9.6.4-final
- ml24Patch.criticalOk.ok: true
- ml24Patch.brainWindow730.ok: true
- ml24Patch.performanceWindow730.ok: true
- ml24Patch.mlStartup.ok: true
- permanentMl.started: true (after runtime initialization)
- permanentMl.learningWindowDays: 730
- permanentMl.performanceWindowDays: 730
- permanentMl.historicalSourceYears: ["25","26"]

Note: full24MonthWindowAvailable may correctly remain false until real FC25+FC26 database coverage actually spans the required period.
