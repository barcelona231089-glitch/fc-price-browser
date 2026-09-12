-- Run after the FC25 + FC26 backfill has finished importing into Vela.
-- CONCURRENTLY avoids a long write lock, but must be executed outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fc_hist_archive_year_platform_card_time
ON public.fc_historical_price_archive (game_year, platform, ea_id, recorded_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fc_hist_archive_year_platform_time
ON public.fc_historical_price_archive (game_year, platform, recorded_at DESC);

ANALYZE public.fc_historical_price_archive;
