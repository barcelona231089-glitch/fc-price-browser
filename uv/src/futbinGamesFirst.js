/**
 * FC27 FUTBIN PGP evidence gate and games-first ordering.
 * This module is independent of the existing UI and optimizer.
 * Lowest BIN is not a completed sale; PGP is historical usage, not sales velocity.
 */
const validId = value => /^\d{1,15}$/.test(String(value ?? '')) && Number(value) > 0;
const validCount = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000_000;
const validPrice = value => Number.isSafeInteger(value) && value >= 100 && value <= 15_000_000;

/** EA removed Common/Rare tiers for FC27 base Bronze/Silver/Gold. */
export function classifyFc27GoldBase(row) {
  if (!row || typeof row !== 'object') return null;
  const year = row.gameYear ?? (row.game === 'FC27' ? 27 : null);
  if (Number(year) !== 27) return null;
  const name = String(row.rareTypeName ?? row.cardType ?? '').trim();
  if (/^gold(?:\s+(?:non\s*rare|rare|common))?$/i.test(name)) return 'Gold';
  // Do not classify from raretype=0 alone: insufficient item identity.
  return null;
}

/** Exact item, FC27, console, OVR and historical PGP proof are mandatory. */
export function verifiedHistoricalPgp(row) {
  if (!row || typeof row !== 'object' || !validId(row.playerId)) return null;
  if (row.game !== 'FC27' || row.platform !== 'console') return null;
  const evidence = row.pgpEvidence;
  if (!evidence || evidence.gameYear !== 27 || evidence.platform !== 'console') return null;
  if (evidence.source && !['FUTBIN_PGP_HAR_SNAPSHOT', 'FUTBIN FC27 PGP HAR document'].includes(evidence.source)) return null;
  if (!validId(evidence.futbinId) || String(evidence.futbinId) !== String(row.playerId)) return null;
  if (!Number.isInteger(Number(row.rating)) || Number(row.rating) !== Number(evidence.rating)) return null;
  if (!validCount(evidence.futbinGamesCount)) return null;
  return Object.freeze({
    futbinId: String(row.playerId),
    games: evidence.futbinGamesCount,
    source: 'FUTBIN_PGP_HAR_SNAPSHOT',
    historical: true, live: false,
    observedAt: typeof evidence.futbinGamesObservedAt === 'string'
      && Number.isFinite(Date.parse(evidence.futbinGamesObservedAt))
      ? evidence.futbinGamesObservedAt : null,
    completedSalesVerified: false,
    buyAuthorized: false
  });
}

/** Highest verified PGP first; price is only a budget gate/tie-breaker. */
export function rankFc27ByGames(rows, {
  minGames = 1, budget = 300_000, maxPrice = 15_000_000
} = {}) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(minGames) || minGames < 1 ||
      !Number.isSafeInteger(budget) || budget < 0 ||
      !Number.isSafeInteger(maxPrice) || maxPrice < 100 || maxPrice > 15_000_000) {
    throw new TypeError('Invalid PGP ranking constraints');
  }
  const excluded = { invalidPrice: 0, missingOrMismatchedPgp: 0, belowGamesThreshold: 0, duplicateItem: 0 };
  const unique = new Map();
  for (const row of rows) {
    if (row?.source !== 'FUTBIN' || row?.game !== 'FC27' ||
        row?.platform !== 'console' || row?.evidence !== 'futbin-direct-json' ||
        row?.priceType !== 'lowest_listing' || row?.salesVerified !== false) {
      excluded.invalidPrice++;
      continue;
    }
    const price = Number(row?.coins);
    if (!validPrice(price) || price > budget || price > maxPrice) {
      excluded.invalidPrice++;
      continue;
    }
    const pgp = verifiedHistoricalPgp(row);
    if (!pgp) { excluded.missingOrMismatchedPgp++; continue; }
    if (pgp.games < minGames) { excluded.belowGamesThreshold++; continue; }
    const id = String(row.resourceId || '') + ':' + pgp.futbinId;
    if (!validId(row.resourceId)) { excluded.missingOrMismatchedPgp++; continue; }
    const entry = { ...row, pgpGames: pgp.games, pgpSource: pgp.source,
      pgpHistorical: true, pgpObservedAt: pgp.observedAt,
      salesVerified: false, buyAuthorized: false, tradeEligible: false };
    if (unique.has(id)) {
      excluded.duplicateItem++;
      if (price < unique.get(id).coins) unique.set(id, entry);
    } else unique.set(id, entry);
  }
  const candidates = [...unique.values()].sort((a,b) =>
    b.pgpGames - a.pgpGames || a.coins - b.coins || Number(a.playerId) - Number(b.playerId));
  return {
    candidates, excluded,
    evidence: 'HISTORICAL_FUTBIN_PGP_ONLY',
    rankedBy: 'PGP_GAMES_DESC_THEN_LISTING_PRICE_ASC',
    missingDataDoesNotPass: true,
    verifiedCompletedSales: 0, readyForTrading: false,
    note: 'Historical usage watchlist, not verified sales velocity or a profit prediction.'
  };
}
