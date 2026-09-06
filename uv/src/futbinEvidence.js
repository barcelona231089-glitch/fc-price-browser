import { clamp } from './utils.js';

const GAME_KEYS = new Set([
  'games', 'games_played', 'gamesplayed', 'total_games', 'totalgames',
  'pgp_games', 'pgpgames', 'matches_played', 'matchesplayed'
]);
const POPULAR_RANK_KEYS = new Set([
  'popular_rank', 'popularrank', 'popularity_rank', 'popularityrank',
  'usage_rank', 'usagerank', 'games_rank', 'gamesrank'
]);
const SALES_PER_DAY_KEYS = new Set([
  'sales_per_day', 'salesperday', 'sold_per_day', 'soldperday',
  'observed_sales_per_day', 'observedsalesperday'
]);
const SALES_ARRAY_RE = /(?:^|\.)(?:sales(?:_history)?|sale_history|transactions|sold_listings|sales_rows|recent_sales)(?:\.|$)/i;

function normalizedKey(key) {
  return String(key || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function parseCompactNumber(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/\s/g, '');
  if (!raw) return null;
  const suffix = raw.at(-1);
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  const body = multiplier > 1 ? raw.slice(0, -1) : raw;
  if (multiplier > 1) {
    const n = Number(body.replace(',', '.').replace(/[^0-9.+-]/g, ''));
    return Number.isFinite(n) ? n * multiplier : null;
  }
  const digits = body.replace(/[^0-9+-]/g, '');
  if (!digits || digits === '+' || digits === '-') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export function parseFutPrice(value) {
  if (Number.isFinite(value)) return Number(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/\s/g, '');
  if (!raw) return null;
  const suffix = raw.at(-1);
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : 1;
  if (multiplier > 1) {
    const n = Number(raw.slice(0, -1).replace(',', '.').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? Math.round(n * multiplier) : null;
  }
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function walkObject(value, visitor, path = '', depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return;
  if (Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    visitor(key, child, nextPath);
    if (child && typeof child === 'object' && !Array.isArray(child)) walkObject(child, visitor, nextPath, depth + 1);
  }
}

function firstFieldByKeys(row, keys, parser = parseCompactNumber) {
  let found = null;
  walkObject(row, (key, value) => {
    if (found !== null) return;
    if (!keys.has(normalizedKey(key))) return;
    const parsed = parser(value);
    if (Number.isFinite(parsed) && parsed >= 0) found = parsed;
  });
  return found;
}

function collectSalesArrays(value, path = '', out = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return out;
  if (Array.isArray(value)) {
    if (SALES_ARRAY_RE.test(path)) out.push(value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    collectSalesArrays(child, path ? `${path}.${key}` : key, out, depth + 1);
  }
  return out;
}

function explicitField(row, keys, parser = parseFutPrice) {
  if (!row || typeof row !== 'object') return null;
  for (const [key, value] of Object.entries(row)) {
    if (!keys.has(normalizedKey(key))) continue;
    const parsed = parser(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const SOLD_PRICE_KEYS = new Set(['sold_for', 'soldfor', 'sold_price', 'soldprice', 'sale_price', 'saleprice', 'final_price', 'finalprice']);
const LISTED_PRICE_KEYS = new Set(['listed_for', 'listedfor', 'listed_price', 'listedprice', 'list_price', 'listprice', 'start_price', 'startprice']);
const STATUS_KEYS = new Set(['status', 'state', 'result', 'outcome']);
const TIME_KEYS = new Set(['sold_at', 'soldat', 'timestamp', 'date', 'created_at', 'createdat', 'time']);

function saleStatus(row) {
  if (!row || typeof row !== 'object') return '';
  for (const [key, value] of Object.entries(row)) {
    if (STATUS_KEYS.has(normalizedKey(key)) && typeof value === 'string') return value.toLowerCase();
  }
  return '';
}

function saleTimestamp(row) {
  if (!row || typeof row !== 'object') return null;
  for (const [key, value] of Object.entries(row)) {
    if (!TIME_KEYS.has(normalizedKey(key))) continue;
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
}

export function parseSaleRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const status = saleStatus(row);
  const explicitlyNotSold = /unsold|expired|active|listed|cancel/.test(status) && !/sold/.test(status.replace('unsold', ''));
  let soldPrice = explicitField(row, SOLD_PRICE_KEYS);
  if (!Number.isFinite(soldPrice) && /\bsold\b/.test(status) && !/unsold/.test(status)) {
    soldPrice = explicitField(row, new Set(['price', 'bin', 'buy_now', 'buynow']));
  }
  if (explicitlyNotSold && !Number.isFinite(soldPrice)) soldPrice = null;
  const listedPrice = explicitField(row, LISTED_PRICE_KEYS);
  if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
    return listedPrice ? { sold: false, soldPrice: null, listedPrice, timestamp: saleTimestamp(row), status: status || null } : null;
  }
  return { sold: true, soldPrice, listedPrice: Number.isFinite(listedPrice) ? listedPrice : null, timestamp: saleTimestamp(row), status: status || 'sold' };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const mix = pos - lo;
  return sorted[lo] * (1 - mix) + sorted[hi] * mix;
}

function modePrice(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

export function gamesDemandScore(games) {
  const n = Number(games);
  if (!Number.isFinite(n) || n <= 0) return null;
  // FC usage spans several orders of magnitude. Log scaling prevents huge-name
  // cards from completely drowning out liquid lower-volume cards.
  return clamp(32 + (Math.log10(Math.max(1, n)) - 2.5) * 15.5, 30, 98);
}

export function buildSalesEvidence(rows, livePrice = null) {
  const parsed = (rows || []).map(parseSaleRow).filter(Boolean);
  const sold = parsed.filter(x => x.sold && Number.isFinite(x.soldPrice));
  const soldPrices = sold.map(x => Number(x.soldPrice)).sort((a, b) => a - b);
  if (!soldPrices.length) {
    return {
      available: false,
      rowCount: parsed.length,
      soldSampleCount: 0,
      listedSampleCount: parsed.filter(x => Number.isFinite(x.listedPrice)).length,
      soldPriceMedian: null,
      soldPriceP25: null,
      soldPriceP75: null,
      soldPriceMin: null,
      soldPriceMax: null,
      soldPriceMode: null,
      salesEvidenceScore: null,
      soldPremiumPctVsLive: null
    };
  }

  const median = quantile(soldPrices, 0.5);
  const p25 = quantile(soldPrices, 0.25);
  const p75 = quantile(soldPrices, 0.75);
  const min = soldPrices[0];
  const max = soldPrices.at(-1);
  const mode = modePrice(soldPrices);
  const live = Number(livePrice);
  const premiumPct = Number.isFinite(live) && live > 0 ? ((median - live) / live) * 100 : null;
  const sampleScore = clamp(42 + Math.log10(soldPrices.length + 1) * 24, 42, 92);
  const premiumScore = Number.isFinite(premiumPct) ? clamp(52 + premiumPct * 2.2, 25, 95) : 58;
  const dispersionPct = median > 0 ? ((p75 - p25) / median) * 100 : 100;
  const consistencyScore = clamp(94 - dispersionPct * 2.2, 38, 94);
  const salesEvidenceScore = clamp(sampleScore * 0.42 + premiumScore * 0.43 + consistencyScore * 0.15, 20, 96);

  return {
    available: true,
    rowCount: parsed.length,
    soldSampleCount: soldPrices.length,
    listedSampleCount: parsed.filter(x => Number.isFinite(x.listedPrice)).length,
    soldPriceMedian: Math.round(median),
    soldPriceP25: Math.round(p25),
    soldPriceP75: Math.round(p75),
    soldPriceMin: Math.round(min),
    soldPriceMax: Math.round(max),
    soldPriceMode: Math.round(mode),
    salesEvidenceScore,
    soldPremiumPctVsLive: Number.isFinite(premiumPct) ? premiumPct : null,
    latestSoldAt: sold.map(x => x.timestamp).filter(Boolean).sort().at(-1) || null
  };
}

export function scoreObservedSaleTarget(targetPrice, cardOrEvidence) {
  const target = Number(targetPrice);
  const n = Number(cardOrEvidence?.futbinSoldSampleCount ?? cardOrEvidence?.soldSampleCount ?? 0);
  const p25 = Number(cardOrEvidence?.futbinSoldPriceP25 ?? cardOrEvidence?.soldPriceP25);
  const median = Number(cardOrEvidence?.futbinSoldPriceMedian ?? cardOrEvidence?.soldPriceMedian);
  const p75 = Number(cardOrEvidence?.futbinSoldPriceP75 ?? cardOrEvidence?.soldPriceP75);
  const max = Number(cardOrEvidence?.futbinSoldPriceMax ?? cardOrEvidence?.soldPriceMax);
  if (!Number.isFinite(target) || target <= 0 || n < 2 || !Number.isFinite(median) || median <= 0) return null;
  if (Number.isFinite(p25) && target < p25) return 78;
  if (target <= median) return 93;
  if (Number.isFinite(p75) && target <= p75) return 88;
  if (Number.isFinite(max) && target <= max) return 62;
  if (Number.isFinite(max) && max > 0) {
    const overshootPct = ((target - max) / max) * 100;
    return clamp(42 - overshootPct * 4, 8, 42);
  }
  return 50;
}

export function extractFutbinStructuredEvidence(row, livePrice = null) {
  if (!row || typeof row !== 'object') return {
    gamesAvailable: false,
    salesHistoryAvailable: false
  };

  const games = firstFieldByKeys(row, GAME_KEYS, parseCompactNumber);
  const popularRank = firstFieldByKeys(row, POPULAR_RANK_KEYS, parseCompactNumber);
  const observedSalesPerDay = firstFieldByKeys(row, SALES_PER_DAY_KEYS, parseCompactNumber);
  const salesArrays = collectSalesArrays(row);
  const salesRows = salesArrays.flat();
  const sales = buildSalesEvidence(salesRows, livePrice);
  const gamesScore = gamesDemandScore(games);

  return {
    gamesAvailable: Number.isFinite(games) && games > 0,
    futbinGamesCount: Number.isFinite(games) ? Math.round(games) : null,
    futbinGamesScore: Number.isFinite(gamesScore) ? gamesScore : null,
    futbinPopularRank: Number.isFinite(popularRank) && popularRank > 0 ? Math.round(popularRank) : null,
    salesHistoryAvailable: Boolean(sales.available),
    futbinSalesRowCount: Number(sales.rowCount || 0),
    futbinSoldSampleCount: Number(sales.soldSampleCount || 0),
    futbinListedSampleCount: Number(sales.listedSampleCount || 0),
    futbinSoldPriceMedian: sales.soldPriceMedian,
    futbinSoldPriceP25: sales.soldPriceP25,
    futbinSoldPriceP75: sales.soldPriceP75,
    futbinSoldPriceMin: sales.soldPriceMin,
    futbinSoldPriceMax: sales.soldPriceMax,
    futbinSoldPriceMode: sales.soldPriceMode,
    futbinSoldPremiumPctVsLive: sales.soldPremiumPctVsLive,
    futbinSalesEvidenceScore: sales.salesEvidenceScore,
    futbinLatestSoldAt: sales.latestSoldAt || null,
    futbinObservedSalesPerDay: Number.isFinite(observedSalesPerDay) && observedSalesPerDay > 0 ? observedSalesPerDay : null,
    evidenceMode: Number.isFinite(games) || sales.available ? 'structured-parse-fields' : 'not-exposed'
  };
}
