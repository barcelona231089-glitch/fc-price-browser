# FC Trader Brain v10.69.9.6.5

Purpose: connect the existing 24-month / 730-day AI and Permanent ML path to the real `public.fc_historical_price_archive` backfill without ever merging FC25 and FC26 into one absolute price curve.

## What changes

- `fc_historical_price_archive` is detected at runtime and used as a real historical source.
- FC25 rows are read only as `game_year=25`; FC26 rows only as `game_year=26`.
- Main Trader Brain archive platform defaults to `console`, matching the existing console/PS5 FUT.GG market snapshot. Override only with `HISTORICAL_ARCHIVE_PLATFORM=pc|xbox|console`.
- Existing `fc_own_market_price_history` remains usable as current real observations.
- Legacy `fc_price_history` remains FC26-only while FC26 is the active runtime because that table has no `game_year` column.
- Card AI context exposes 30/90/180/365/730-day statistics per game year.
- The top-level 730-day context is explicitly season-separated. Cross-season absolute price change is `null` / disabled.
- Up to 24 monthly profiles remain available across FC25 + FC26, still tagged with their game year.
- Permanent ML can learn cycle priors from the archive after real rows arrive.
- Historical ML horizons are now time-aware. Irregular/daily Wayback points are not treated as fixed 6-hour steps.
- No synthetic history, no fill-forward, no invented missing months.

## Deployment files

Upload to the existing repository root:

1. `v1069965Bootstrap.mjs`
2. `v1069965Loader.mjs`
3. `package.json`

Keep all existing v10.69.9.6.4 and older chain files. The new loader reuses the verified 6.4 server patch and the existing resilient Permanent ML startup patch.

## Expected health after deployment

- runtime version: `10.69.9.6.5-final`
- `historicalArchiveReader.configured: true`
- `historicalArchiveReader.table: fc_historical_price_archive`
- `historicalArchiveReader.sourceGameYears: ["25","26"]`
- `historicalArchiveReader.rawPricesMergedAcrossGameYears: false`
- `twoYearAiFeed.archiveTableAware: true` after the feed is loaded
- `permanentMl.archiveTableAware: true`
- `permanentMl.learningWindowDays: 730`

`full24MonthWindowAvailable` is deliberately evidence-based. It stays false until real observed coverage actually meets the required span and observed-day thresholds. The application must never turn it true just because the backfill job was requested.

## Database indexes

After the Windows FC25 + FC26 collector has completed its Vela import, run:

`sql/v1069965_historical_archive_indexes.sql`

Do not create these large archive indexes in the middle of the active bulk import unless you intentionally accept slower inserts.
