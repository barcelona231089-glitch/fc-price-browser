// FUTBIN quotes enter the existing budget allocator as a watchlist, never as sales.
import { optimizeList, optimizeListWithSeed, maxAffordablePortfolioCount, priceStep, roundMarketPrice, capitalBandForPrice } from './uvEngine.js';
import { mapFutbinQuoteToUvCard } from './futbinOriginalSource.js';

export const WATCHLIST_NOTICE = 'FUTBIN-Angebotspreise: Die Positionen sind eine Beobachtungsliste. Zielpreise und Zielgewinne sind Rechenziele, keine bestätigten Verkäufe oder Kaufempfehlungen. Nachfrage, Games und Verkaufswahrscheinlichkeit sind derzeit unbekannt.';
export const SOURCE = 'FUTBIN_JSON_FC27_PS';
export function portfolioError(message, code, status = 422) {
  return Object.assign(new Error(message), { code, status });
}
export function validateBudget(budget) {
  if (!Number.isSafeInteger(budget) || budget < 30000 || budget > 100000000) {
    throw portfolioError('Budget muss zwischen 30.000 und 100.000.000 Coins liegen.', 'INVALID_BUDGET', 400);
  }
}
export function quoteCandidates(rows, { now = Date.now(), maxAgeMs = 30 * 60000 } = {}) {
  const byItem = new Map();
  const rejected = {};
  const reject = why => { rejected[why] = (rejected[why] || 0) + 1; };
  for (const row of rows) {
    const card = mapFutbinQuoteToUvCard(row);
    if (!card) { reject('INVALID_SOURCE_OR_ITEM'); continue; }
    const age = now - Date.parse(card.priceCheckedAt);
    if (age < -60000 || age > maxAgeMs) { reject('STALE_QUOTE'); continue; }
    if (!card.name || !Number.isInteger(card.overall) || card.overall < 82 || card.overall > 99) {
      reject('UNKNOWN_OR_LOW_RATING'); continue;
    }
    if (card.cardType === 'Base Common' || /bronze|silver|unknown|unbekannt|sbc|objective|reward|evolution|loan/i.test(card.rarityName || '')) {
      reject('UNSUPPORTED_OR_REWARD_VERSION'); continue;
    }
    if (!card.rarityName || card.price % priceStep(card.price) !== 0) { reject('INVALID_MARKET_STEP'); continue; }
    const previous = byItem.get(card.eaId);
    if (previous && previous.futbinId !== card.futbinId) {
      // Conflicting item mappings are not merged into a made-up card version.
      byItem.set(card.eaId, { ...previous, identityConflict: true });
      reject('CONFLICTING_ITEM_ID'); continue;
    }
    if (!previous || (!previous.identityConflict && Date.parse(card.priceCheckedAt) > Date.parse(previous.priceCheckedAt))) {
      byItem.set(card.eaId, card);
    }
  }
  return { cards: [...byItem.values()].filter(c => !c.identityConflict), rejected };
}

export function targetScenario(buyPrice, desiredProfit = 1500) {
  const target = Math.min(2000, Math.max(1000, desiredProfit));
  const sellPrice = roundMarketPrice((buyPrice + target) / 0.95, 'up');
  const tax = Math.floor(sellPrice * 0.05);
  const netProfit = sellPrice - tax - buyPrice;
  if (sellPrice > 15000000 || netProfit > 3000) return { sellPrice: null, startPrice: null, netProfit: null, tax: null };
  return { sellPrice, startPrice: Math.max(150, sellPrice - priceStep(sellPrice - 1)), netProfit, tax };
}

function allocationCard(card, budget, count) {
  const budgetFit = Math.max(0, 100 - Math.abs(Math.log(card.price / (budget / count))) * 25);
  return { ...card, recommendedBuyPrice: card.price, buyPrice: card.price,
    selectionScore: budgetFit, budgetTop100Score: budgetFit, budgetFit,
    // Only an allocation score; no imputed demand, sales or confidence inputs.
    riskPenalty: 0, traderEndgameProfileActive: false };
}
function publicCard(card, budget, count) {
  const { recommendedBuyPrice, selectionScore, budgetTop100Score, riskPenalty, ...clean } = card;
  return { ...clean, ...targetScenario(card.price),
    slot: null, buyPrice: card.price, buyMax: null, recommendedBuyPrice: null,
    buyAuthorized: false, readyForTrading: false, recommendationMode: 'FUTBIN_LISTING_WATCHLIST',
    scenarioOnly: true, expectedProfit: null, saleVerified: false, salesProbability: null,
    futbinSoldSampleCount: 0, futbinSoldPriceMedian: null, futbinGamesCount: null,
    demandSource: null, demandDataConfidence: null, saleLikelihoodIndex: null,
    qualityGrade: null, tradeQualityScore: null, priceActivityScore: null,
    usagePct: null, trend: 'unknown', capitalBand: capitalBandForPrice(card.price, budget, count),
    riskFlags: ['Verkäufe und Nachfrage nicht nachgewiesen'],
    recommendationLifecycle: { state: 'WATCH', recheckAfterMinutes: 10 } };
}

export function buildFutbinPortfolio(rows, { budget, now = Date.now(), previousCards = [], filters = {} } = {}) {
  validateBudget(budget);
  const requestedCount = 100;
  const { cards, rejected } = quoteCandidates(rows, { now });
  const settings = normalizeFilters(filters);
  const filtered = cards.filter(c => c.price >= settings.minPrice && c.price <= settings.maxPrice &&
    (settings.minGames === 0 || (Number.isInteger(c.futbinGamesCount) && c.futbinGamesCount >= settings.minGames)) &&
    (settings.minSales === 0 || (c.salesHistoryAvailable === true && c.futbinSoldSampleCount >= settings.minSales)));
  const candidates = filtered.map(c => allocationCard(c, budget, requestedCount));
  const count = maxAffordablePortfolioCount(candidates, budget, Math.max(1, Math.min(requestedCount, candidates.length))).count;
  let result;
  try {
    if (!count) result = { selected: [] };
    else {
    const previousIds = new Set(previousCards.map(c => String(c.eaId)));
    const seed = candidates.filter(c => previousIds.has(String(c.eaId)));
    result = seed.length ? optimizeListWithSeed(candidates, budget, count, seed) : optimizeList(candidates, budget, count);
    }
  } catch (e) {
    throw portfolioError('Liste mit den derzeit verfügbaren FUTBIN-Preisen nicht berechenbar: ' + e.message, 'INSUFFICIENT_FUTBIN_CANDIDATES');
  }
  const selected = result.selected.map((c,i) => ({ ...publicCard(c, budget, count), slot: i+1 }));
  const totalBuy = selected.reduce((sum,c) => sum + c.price, 0);
  const unique = new Set(selected.map(c => c.eaId)).size;
  if (selected.length !== count || totalBuy > budget) throw portfolioError('Budget-/100-Karten-Prüfung fehlgeschlagen.', 'ALLOCATION_INVALID', 500);
  const previousIds = new Set(previousCards.map(c => String(c.eaId)));
  return { ok: true, gameYear: 27, platform: 'console', source: SOURCE,
    mode: 'FUTBIN_LISTING_WATCHLIST', priceSourceMode: 'FUTBIN_ONLY',
    budget, count, requestedCount, generatedCount: count, filters: settings,
    dynamicCountReduced: count < requestedCount,
    uniqueCardCount: unique, repeatedSlots: count-unique, maxExactCardCopies: 2,
    totalBuy, unusedBudget: budget-totalBuy, budgetUsagePct: totalBuy/budget*100,
    totalExpectedProfit: null, scenarioTargetProfit: selected.reduce((s,c) => s + (c.netProfit || 0), 0),
    confirmedSales: 0, recommendationCount: 0, readyForTrading: false,
    specialCount: selected.filter(c=>c.cardType==='Special').length,
    candidatePoolSize: candidates.length, rejectedCandidates: rejected,
    demandContext: { available: false, source: null, status: 'UNKNOWN' },
    sources: { primary: 'FUTBIN', secondary: null, history: null },
    generatedAt: new Date(now).toISOString(), dataNotice: (count < requestedCount ? `${count}/100 passende Positionen mit den vorhandenen Daten und Filtern. ` : '') + WATCHLIST_NOTICE,
    rebalance: previousCards.length ? { retainedCount: selected.filter(c=>previousIds.has(String(c.eaId))).length,
      replacementCount: selected.filter(c=>!previousIds.has(String(c.eaId))).length } : null,
    cards: selected };
}

export function recheckFutbinPortfolio(portfolio, rows, { now = Date.now() } = {}) {
  if (portfolio?.source !== SOURCE || portfolio.gameYear !== 27 || portfolio.platform !== 'console') {
    throw portfolioError('Diese Liste gehört nicht zur aktuellen FUTBIN-FC27-Quelle.', 'LIST_SOURCE_MISMATCH');
  }
  const live = new Map(quoteCandidates(rows, { now }).cards.map(c=>[String(c.eaId), c]));
  const checkedAt = new Date(now).toISOString();
  const counts = { WATCH: 0, MISSING: 0 };
  const cards = portfolio.cards.map(previous => {
    const card = live.get(String(previous.eaId));
    if (!card || card.futbinId !== previous.futbinId) {
      counts.MISSING++;
      return { eaId: previous.eaId, slot: previous.slot, status: 'MISSING', buyAuthorized: false,
        currentPrice: null, fresh: null, reasons: ['Kein aktueller FUTBIN-Preis für diese genaue Karten-ID.'] };
    }
    const fresh = { ...publicCard(allocationCard(card, portfolio.budget, 100), portfolio.budget, 100), slot: previous.slot };
    counts.WATCH++;
    return { eaId: card.eaId, slot: previous.slot, status: 'WATCH', buyAuthorized: false,
      currentPrice: card.price, priceDriftPct: (card.price/previous.price-1)*100,
      fresh, reasons: ['Angebotspreis geprüft. Verkaufsnachweis fehlt; keine Kauf-Freigabe.'] };
  });
  return { ok: true, checkedAt, cards, summary: { counts }, readyForTrading: false, dataNotice: WATCHLIST_NOTICE };
}

export function normalizeFilters(input = {}) {
  const read=(key, fallback, max)=>{
    const value=input[key] === undefined || input[key] === '' || input[key] === null ? fallback : Number(input[key]);
    if(!Number.isSafeInteger(value) || value<0 || value>max) throw portfolioError('Ungültiger Filter: '+key, 'INVALID_FILTER', 400);
    return value;
  };
  const result={minPrice:read('minPrice',0,15000000),maxPrice:read('maxPrice',15000000,15000000),
    minGames:read('minGames',0,10000000000),minSales:read('minSales',0,1000000)};
  if(result.minPrice>result.maxPrice) throw portfolioError('Preis von darf nicht über Preis bis liegen.', 'INVALID_FILTER',400);
  return result;
}
