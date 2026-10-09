// Stateless, fail-closed FUTBIN FC27 console listing analysis.
// Listings are not completed sales, and cannot authorize ÜV buy recommendations.
export const CONSOLE_MAX_AGE_MS = 30 * 60 * 1000;
export const CONSOLE_TARGET_COUNT = 100;

export function analyzeFutbinConsoleExport(exportData, { now = Date.now(), budget = 100_000 } = {}) {
  if (!exportData || typeof exportData !== 'object' || Array.isArray(exportData) ||
      exportData.schemaVersion !== 1 || exportData.source !== 'FUTBIN' ||
      !Array.isArray(exportData.prices) || exportData.prices.length > 2000) {
    throw new TypeError('Ungültiger FUTBIN-Export. Erwartet: schemaVersion 1, source FUTBIN und prices[].');
  }
  if (!Number.isSafeInteger(budget) || budget < 30_000 || budget > 100_000_000) {
    throw new RangeError('Budget muss zwischen 30.000 und 100.000.000 Coins liegen.');
  }
  const unique = new Map();
  let invalid = 0;
  let stale = 0;
  for (const p of exportData.prices) {
    if (!p || p.source !== 'FUTBIN' || p.game !== 'FC27' ||
        p.platform !== 'console' || !/^[1-9]\d{0,14}$/.test(String(p.playerId)) ||
        !Number.isSafeInteger(p.coins) || p.coins < 100 || p.coins > 15_000_000 ||
        p.priceType !== 'visible_listing' || p.evidence !== 'visible-price-box' ||
        p.salesVerified !== false || typeof p.capturedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(p.capturedAt)) {
      invalid++;
      continue;
    }
    const capturedMs = Date.parse(p.capturedAt);
    if (!Number.isFinite(capturedMs) || capturedMs > now + 60_000) {
      invalid++;
      continue;
    }
    if (now - capturedMs > CONSOLE_MAX_AGE_MS) {
      stale++;
      continue;
    }
    const id = String(p.playerId);
    const prev = unique.get(id);
    if (!prev || prev.capturedMs < capturedMs) {
      unique.set(id, {
        playerId: id, capturedMs, capturedAt: p.capturedAt,
        platform: 'console', priceCoins: p.coins, source: 'FUTBIN',
        evidence: 'visible-price-box', priceType: 'visible_listing',
        completedSalesVerified: false, status: 'WAIT',
        buyMax: null, sellPrice: null, expectedProfit: null
      });
    }
  }
  const cards = [...unique.values()]
    .sort((a, b) => a.priceCoins - b.priceCoins)
    .map(({capturedMs, ...card}) => card);
  const missing = Math.max(0, CONSOLE_TARGET_COUNT - cards.length);
  const affordableListings = cards.filter(c => c.priceCoins <= budget).length;
  const insufficient = cards.length < CONSOLE_TARGET_COUNT;
  const note = !cards.length
    ? 'Keine frischen FUTBIN-Konsolenpreise vorhanden. FUTBIN erneut im Browser öffnen und neu exportieren.'
    : 'Nur FUTBIN-Angebotspreise vorhanden, keine bestätigten Verkäufe. Deshalb keine Kaufempfehlung.';
  return {
    ok: true, mode: 'FUTBIN_FC27_CONSOLE_ONLY', source: 'FUTBIN',
    game: 'FC27', platform: 'console', budget,
    importedRows: exportData.prices.length, freshPlayers: cards.length,
    affordableListings, unaffordableListings: cards.length - affordableListings,
    staleRows: stale, invalidRows: invalid, targetCount: CONSOLE_TARGET_COUNT,
    missingForTarget: missing, insufficientPlayerEvidence: insufficient,
    confirmedSales: 0, recommendations: [], recommendationCount: 0,
    readyForTrading: false, status: 'BLOCKED_NO_CONFIRMED_SALES',
    cards, notice: note,
    safeguards: ['no_pc', 'no_futgg', 'no_parse', 'no_fallback',
      'no_unverified_sales', 'no_stale_listings', 'no_fabricated_buy_prices']
  };
}
