# FC Trader Brain v10.69.9.6 - 24 Month Permanent ML Brain

This build is designed to be deployed directly on top of the currently live v10.69.9.3 chain. It deliberately does not require v10.69.9.4 or v10.69.9.5.

## Goal

Give the Trader Brain a permanent 24-month learning school using real FC25 + FC26 market evidence, while keeping each game-year economy separate.

Target learning window: **730 days / 24 months**.

## What is implemented

### Permanent PostgreSQL ML

`permanentMlBrainV106996.js` trains logistic outcome models and stores their learned weights in:

`fc_permanent_ml_models_v106996`

Learned weights survive restarts.

### FC25 + FC26 are separate models

Historical source years are:

- FC25
- FC26

The Brain never concatenates FC25 and FC26 absolute prices into one continuous price curve. Each game year trains its own normalized market-pattern and decision models. Older years are only down-weighted priors.

### 730-day learning window

The following default windows are now 730 days:

- Brain Learning
- Decision Performance Lab
- permanent decision-outcome training
- historical market-cycle training

### Decision outcome learning

Every persisted and evaluated Trader-Brain decision can become future learning material. Features include existing live-market movements plus public leak context and trader/Discord signals stored in the decision snapshot.

Labels use the real later outcomes at:

- 1h
- 6h
- 24h

A positive label means positive ROI **after the 5% EA tax**.

### Historical market-cycle learning

For each game year separately, the Brain samples real observed price cycles and learns:

- 24h movement
- 7d movement
- 30d movement
- distance from 24h low
- distance from 24h high

It learns whether similar situations later became net-positive after EA tax at 24h / 7d.

### 24-month Gemini market memory

`twoYearAiContextV106996.js` gives Gemini compact real history for FC25 and FC26 separately:

- 30d / 90d / 180d / 365d statistics per game year
- up to 12 monthly profiles per game year
- up to 24 monthly profiles total
- real global coverage status
- explicit `full24MonthWindowAvailable`

No missing month is invented.

### Walk-forward validation

Models train chronologically on the older 80% and validate on the newer 20%. A model becomes trusted only after enough real samples and sufficient balanced accuracy.

### Safe live use

The permanent ML layer can:

- confirm an existing BUY setup
- veto/downgrade an existing BUY when historical outcomes strongly disagree
- strengthen an exit signal
- flag an early opportunity for Gemini review

It **cannot create JETZT KAUFEN by itself** until the model has proven itself with real validation.

### Server safety

Live scoring is in-memory. There is no per-card SQL query inside the full market scan. Heavy retraining is scheduled and defers while the main monitor is busy.

## Data reality

This code supports and learns from 24 months, but it can only learn rows that actually exist in PostgreSQL.

If the database currently contains only a partial FC25/FC26 history, status will show partial coverage. It must not be described as a full 24-month-trained model until:

`full24MonthWindowAvailable: true`

The strict full-window check requires roughly the complete 730-day span and at least 700 observed calendar days.

No synthetic backfill is created.

## FUTBIN

No FUTBIN collector or FUTBIN policy is changed by this build.

## Deployment

The live repo already has v10.69.9.3. Upload/replace these root files:

- `permanentMlBrainV106996.js`
- `twoYearAiContextV106996.js`
- `v106996Loader.mjs`
- `v106996Register.mjs`
- `package.json`

Keep `v106993Register.mjs`, `v106993Loader.mjs`, and all earlier chain files.

Do not upload v10.69.9.4 or v10.69.9.5 for this build. v10.69.9.6 replaces that experimental path and starts directly from v10.69.9.3.

## Expected runtime

`10.69.9.6-final`

In `/api/trader-brain/status` look for:

- `twoYearAiFeed.targetMonths = 24`
- `twoYearAiFeed.requestedWindowDays = 730`
- `permanentMl.learningWindowDays = 730`
- `permanentMl.historicalSourceYears = ["25","26"]`
- `permanentMl.full24MonthWindowAvailable`
- `permanentMl.schoolCoverage`
- `permanentMl.decisionSamplesByYear`
- `permanentMl.cycleByYear`
- `permanentMl.models[].balancedAccuracy`

A fresh deployment may initially have zero trusted models. That is correct. Trust is earned from real validation.
