// Original FC ÜV Brain FUTBIN-only primary *price* source.
// FUTBIN Lowest BIN is a listing quote, NEVER evidence of an actual sale.
import { originalUvFutbinPriceFeed } from './futbinConsoleApi.js';

export function isFutbinOnlyUvMode() {
  return String(process.env.UV_PRICE_SOURCE || '').trim().toUpperCase() === 'FUTBIN_ONLY';
}

const positiveInt = x => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null;
const validPrice = x => Number.isSafeInteger(Number(x)) && Number(x) >= 100 && Number(x) <= 15_000_000;

export function mapFutbinQuoteToUvCard(row) {
  if (!row || row.source !== 'FUTBIN' || row.game !== 'FC27' ||
      row.platform !== 'console' || row.evidence !== 'futbin-direct-json' ||
      row.priceType !== 'lowest_listing' || row.salesVerified !== false ||
      !validPrice(row.coins) || !positiveInt(row.resourceId) ||
      !positiveInt(row.playerId) || !Number.isFinite(Date.parse(row.capturedAt))) return null;

  const type = String(row.cardType || '').toLowerCase();
  // Treat ambiguous reward-like or unknown card versions conservatively.
  let cardType;
  if (type.includes('non rare') || type.includes('common')) cardType = 'Base Common';
  else if (type.includes('gold rare') || type.includes('silver rare')) cardType = 'Base Rare';
  else cardType = 'Special';
  const price = Number(row.coins);
  return {
    eaId: Number(row.resourceId), id: Number(row.playerId),
    futbinId: Number(row.playerId), itemId: Number(row.playerId),
    overall: Number.isInteger(Number(row.rating)) ? Number(row.rating) : null,
    name: row.playerName || null, cardName: row.playerName || null,
    position: row.position || null, club: row.club || null,
    nation: row.nation || null, league: row.league || null,
    cardType, rarityName: row.cardType || null,
    price, futbinPrice: price,
    priceStatusCode: null, // FUTBIN Lowest BIN is not a FUT.GG tradeability confirmation.
    priceSource: 'FUTBIN_JSON_FC27_PS',
    priceEvidence: 'lowest_bin_listing_only',
    priceCheckedAt: row.capturedAt,
    futbinSourceCheckedAt: row.sourceCheckedAt || null,
    futbinChecked: true,
    saleVerified: false, futbinSoldSampleCount: 0,
    marketTradeableConfirmed: false,
    salesProbability: null,
    url: 'https://www.futbin.com/27/player/' + Number(row.playerId)
  };
}

export function getOriginalFutbinSourceStatus() {
  return originalUvFutbinPriceFeed.getStatus();
}

export function getOriginalFutbinMarketSnapshot({ minCards = 1, maxAgeMs = 30*60_000 } = {}) {
  originalUvFutbinPriceFeed.ensureRefreshed();
  const status = originalUvFutbinPriceFeed.getStatus();
  const age = status.lastSuccessAt ? Date.now() - Date.parse(status.lastSuccessAt) : Number.POSITIVE_INFINITY;
  const cards = originalUvFutbinPriceFeed.getRows()
    .map(mapFutbinQuoteToUvCard).filter(Boolean);
  const unique = new Map(cards.map(card => [String(card.eaId), card]));
  if (!status.hasSuccessfulFetch || age > maxAgeMs || unique.size < minCards) {
    const error = new Error('FUTBIN-only: Quelle noch nicht bereit, zu alt oder zu wenige echte Konsolenpreise. ' +
      'Quelle=' + status.currentPhase + ', Spieler=' + unique.size +
      (status.lastError ? ', Fehler=' + status.lastError : ''));
    error.code = 'UV_FUTBIN_SOURCE_NOT_READY';
    error.status = 503;
    throw error;
  }
  return {
    cards: [...unique.values()],
    priceSource: 'FUTBIN_JSON_FC27_PS',
    sourceUrl: status.sourceUrl,
    updatedAt: status.lastSuccessAt,
    sourceAgeMs: age,
    snapshotAgeSeconds: Math.floor(age/1000),
    requiresLiveRecheck: age > 5*60_000,
    sharedSnapshot: false,
    live: true,
    sharedSnapshotMode: 'FUTBIN_ONLY_LOWEST_BIN',
    confirmedSales: 0
  };
}
