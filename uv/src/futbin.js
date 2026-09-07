import { FUTBIN_PARSE_API_BASE, FUTBIN_CROSSCHECK_LIMIT, FUTBIN_SEARCH_ENDPOINT } from './config.js';
import { clamp, fetchJson, mapLimit, normalizeName } from './utils.js';
import { extractFutbinStructuredEvidence } from './futbinEvidence.js';

const cache = new Map();
const CACHE_MS = 30 * 60_000;
const MARKET_CACHE_MS = 10 * 60_000;
let marketCache = null;
const extendedDataState = {
  gamesObserved: false,
  salesHistoryObserved: false,
  popularRankObserved: false,
  observedSalesPerDayObserved: false,
  lastObservedAt: null
};

function observeExtendedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return;
  if (evidence.gamesAvailable) extendedDataState.gamesObserved = true;
  if (evidence.salesHistoryAvailable) extendedDataState.salesHistoryObserved = true;
  if (Number.isFinite(evidence.futbinPopularRank)) extendedDataState.popularRankObserved = true;
  if (Number.isFinite(evidence.futbinObservedSalesPerDay)) extendedDataState.observedSalesPerDayObserved = true;
  if (evidence.gamesAvailable || evidence.salesHistoryAvailable || Number.isFinite(evidence.futbinPopularRank) || Number.isFinite(evidence.futbinObservedSalesPerDay)) {
    extendedDataState.lastObservedAt = new Date().toISOString();
  }
}

export function getFutbinExtendedDataStatus() {
  return {
    adapterReady: true,
    source: 'FUTBIN via Parse API structured fields only',
    gamesObserved: extendedDataState.gamesObserved,
    salesHistoryObserved: extendedDataState.salesHistoryObserved,
    popularRankObserved: extendedDataState.popularRankObserved,
    observedSalesPerDayObserved: extendedDataState.observedSalesPerDayObserved,
    lastObservedAt: extendedDataState.lastObservedAt,
    directFutbinScrape: false
  };
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['data', 'players', 'results', 'items']) {
    if (Array.isArray(json?.[key])) return json[key];
    if (Array.isArray(json?.data?.[key])) return json.data[key];
  }
  return [];
}

function numericPrice(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const clean = value.trim().toUpperCase().replace(/,/g, '.');
    const mult = clean.endsWith('K') ? 1000 : clean.endsWith('M') ? 1_000_000 : 1;
    const n = Number(clean.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n * mult : null;
  }
  return null;
}

function pickPrice(row, platform) {
  const candidates = platform === 'pc'
    ? [row.price_pc, row.pc_price, row.prices?.pc, row.pricePc]
    : [row.price_ps, row.price_ps5, row.console_price, row.prices?.ps, row.prices?.ps5, row.pricePs];
  for (const value of candidates) {
    const n = numericPrice(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function toNumber(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const n = Number(value.replace('%', '').replace(',', '.').replace(/[^0-9+\-.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function collectArrays(value, path = '', out = []) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    out.push({ path, rows: value });
    for (let i = 0; i < Math.min(value.length, 3); i++) collectArrays(value[i], `${path}[${i}]`, out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) collectArrays(v, path ? `${path}.${k}` : k, out);
  return out;
}

function parseSeriesPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const v = toNumber(point[1]);
    return Number.isFinite(v) ? v : null;
  }
  if (!point || typeof point !== 'object') return null;
  for (const key of ['value', 'price', 'index', 'y', 'market_index']) {
    const v = toNumber(point[key]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function findBestSeries(json, platform) {
  const arrays = collectArrays(json);
  const platformTerms = platform === 'pc' ? ['pc'] : ['ps', 'console', 'playstation'];
  const candidates = arrays
    .map(item => {
      const values = item.rows.map(parseSeriesPoint).filter(Number.isFinite);
      const path = item.path.toLowerCase();
      let score = values.length;
      if (platformTerms.some(t => path.includes(t))) score += 50;
      if (path.includes('index') || path.includes('trend') || path.includes('series')) score += 25;
      return { ...item, values, score };
    })
    .filter(item => item.values.length >= 2)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.values || [];
}

function parseMovers(json) {
  const arrays = collectArrays(json);
  const candidates = arrays
    .filter(item => /mover|gain|loser|change|player/i.test(item.path))
    .flatMap(item => item.rows)
    .filter(row => row && typeof row === 'object' && !Array.isArray(row));
  const seen = new Set();
  const movers = [];
  for (const row of candidates) {
    const name = row.name || row.player_name || row.player || row.full_name;
    if (!name) continue;
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    const change = toNumber(row.change_pct ?? row.change ?? row.percent_change ?? row.percentage ?? row.price_change);
    const price = numericPrice(row.price_ps ?? row.price ?? row.current_price ?? row.price_pc);
    seen.add(key);
    movers.push({ name: String(name), normalizedName: key, changePct: change, price });
  }
  return movers.slice(0, 80);
}

function buildMarketContext(json, platform) {
  const series = findBestSeries(json, platform);
  const movers = parseMovers(json);
  let changePct = null;
  if (series.length >= 2 && series[0] !== 0) changePct = ((series.at(-1) - series[0]) / Math.abs(series[0])) * 100;
  let direction = 'unknown';
  if (Number.isFinite(changePct)) {
    if (changePct > 1.25) direction = 'rising';
    else if (changePct < -1.25) direction = 'falling';
    else direction = 'stable';
  }
  const stabilityScore = Number.isFinite(changePct) ? Math.max(25, Math.min(100, 100 - Math.abs(changePct) * 8)) : 55;
  return { ok: true, platform, direction, changePct, stabilityScore, seriesPoints: series.length, movers };
}

export async function getFutbinMarketTrends(platform = 'console') {
  const apiKey = String(process.env.FUTBIN_PARSE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, reason: 'FUTBIN_PARSE_API_KEY fehlt', direction: 'unknown', stabilityScore: 55, movers: [] };
  if (marketCache && Date.now() - marketCache.at < MARKET_CACHE_MS && marketCache.platform === platform) return marketCache.value;
  try {
    const url = `${FUTBIN_PARSE_API_BASE}/get_market_trends`;
    const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
    const value = buildMarketContext(json, platform);
    marketCache = { at: Date.now(), platform, value };
    return value;
  } catch (error) {
    const value = { ok: false, reason: String(error), direction: 'unknown', changePct: null, stabilityScore: 55, movers: [] };
    marketCache = { at: Date.now(), platform, value };
    return value;
  }
}

export function attachMarketMoverSignals(cards, marketContext) {
  const movers = Array.isArray(marketContext?.movers) ? marketContext.movers : [];
  const byName = new Map(movers.map(m => [m.normalizedName || normalizeName(m.name), m]));
  return cards.map(card => {
    const mover = byName.get(normalizeName(card.name));
    let marketMoverScore = 55;
    if (mover && Number.isFinite(mover.changePct)) {
      // Lazy/ÜV prefers active but not violently crashing cards.
      if (mover.changePct >= 0 && mover.changePct <= 12) marketMoverScore = Math.min(95, 70 + mover.changePct * 2);
      else if (mover.changePct > 12) marketMoverScore = 68;
      else if (mover.changePct > -5) marketMoverScore = 52;
      else marketMoverScore = 30;
    } else if (mover) marketMoverScore = 70;
    return { ...card, marketMover: mover || null, marketMoverScore };
  });
}

export async function searchFutbinCard(card, platform = 'console') {
  const apiKey = String(process.env.FUTBIN_PARSE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, reason: 'FUTBIN_PARSE_API_KEY fehlt' };
  const cacheKey = `${platform}|${normalizeName(card.name)}|${card.overall}|${card.cardType}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const url = `${FUTBIN_PARSE_API_BASE}/${FUTBIN_SEARCH_ENDPOINT}?query=${encodeURIComponent(card.name || '')}`;
  try {
    const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
    const rows = extractRows(json);
    const wanted = normalizeName(card.name);
    const matches = rows
      .filter(row => normalizeName(row.name || row.full_name) === wanted || normalizeName(row.name || row.full_name).includes(wanted))
      .map(row => ({
        row,
        ratingDelta: Math.abs(Number(row.rating || 0) - Number(card.overall || 0)),
        versionMatch: normalizeName(row.version || '') === normalizeName(card.rarityName || card.cardName || '') ? 0 : 1
      }))
      .sort((a, b) => a.ratingDelta - b.ratingDelta || a.versionMatch - b.versionMatch);
    const best = matches[0]?.row || rows[0] || null;
    const price = best ? pickPrice(best, platform) : null;
    const evidence = best ? extractFutbinStructuredEvidence(best, price || card.price) : { gamesAvailable: false, salesHistoryAvailable: false };
    observeExtendedEvidence(evidence);
    const value = {
      ok: Boolean(best), price, id: best?.id ?? null,
      name: best?.name ?? best?.full_name ?? null,
      rating: best?.rating ?? null, version: best?.version ?? null,
      position: best?.position ?? null, club: best?.club ?? null,
      image: best?.image_large ?? best?.image ?? null,
      rawMatched: Boolean(best),
      evidence
    };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    const value = { ok: false, reason: String(error) };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }
}

export async function crosscheckFutbin(cards, platform = 'console') {
  if (!process.env.FUTBIN_PARSE_API_KEY || FUTBIN_CROSSCHECK_LIMIT <= 0) {
    return cards.map(card => ({ ...card, futbinPrice: null, futbinChecked: false }));
  }
  const ranked = [...cards]
    .sort((a, b) => (b.selectionScore || b.uvScore || 0) - (a.selectionScore || a.uvScore || 0))
    .slice(0, FUTBIN_CROSSCHECK_LIMIT);
  const byId = new Map();
  const results = await mapLimit(ranked, 3, async card => ({ card, result: await searchFutbinCard(card, platform) }));
  for (const item of results) if (item?.card) byId.set(String(item.card.eaId), item.result);

  return cards.map(card => {
    const result = byId.get(String(card.eaId));
    const previousFutbinPrice = Number.isFinite(Number(card?.futbinPrice)) ? Number(card.futbinPrice) : null;
    const futbinPrice = Number.isFinite(result?.price) ? result.price : previousFutbinPrice;
    const diffPct = Number.isFinite(futbinPrice) && card.price ? ((futbinPrice - card.price) / card.price) * 100 : (Number.isFinite(Number(card?.sourceDiffPct)) ? Number(card.sourceDiffPct) : null);
    const evidence = result?.evidence || {};

    let popularityScore = Number.isFinite(card.popularityScore) ? Number(card.popularityScore) : null;
    let demandEvidenceScore = Number.isFinite(card.demandEvidenceScore) ? Number(card.demandEvidenceScore) : popularityScore;
    let demandDataConfidence = Number.isFinite(card.demandDataConfidence) ? Number(card.demandDataConfidence) : 45;
    let liquidityScore = Number.isFinite(card.liquidityScore) ? Number(card.liquidityScore) : null;
    const gamesScore = Number.isFinite(evidence.futbinGamesScore) ? Number(evidence.futbinGamesScore) : null;
    const salesScore = Number.isFinite(evidence.futbinSalesEvidenceScore) ? Number(evidence.futbinSalesEvidenceScore) : null;

    if (Number.isFinite(gamesScore)) {
      popularityScore = Number.isFinite(popularityScore) ? clamp(popularityScore * 0.78 + gamesScore * 0.22, 0, 98) : gamesScore;
      demandEvidenceScore = Number.isFinite(demandEvidenceScore) ? clamp(demandEvidenceScore * 0.80 + gamesScore * 0.20, 0, 98) : gamesScore;
      demandDataConfidence = clamp(demandDataConfidence + 10, 25, 98);
    }
    if (Number.isFinite(salesScore)) {
      liquidityScore = Number.isFinite(liquidityScore) ? clamp(liquidityScore * 0.82 + salesScore * 0.18, 0, 100) : salesScore;
      demandDataConfidence = clamp(demandDataConfidence + 8, 25, 98);
    }

    return {
      ...card,
      futbinPrice,
      futbinChecked: result ? true : Boolean(card.futbinChecked),
      futbinMatch: result ? Boolean(result?.ok) : Boolean(card.futbinMatch),
      futbinId: result?.id ?? card.futbinId ?? null,
      futbinVersion: result?.version ?? card.futbinVersion ?? null,
      image: card.image || result?.image || null,
      sourceDiffPct: Number.isFinite(diffPct) ? diffPct : null,
      ...evidence,
      gameplayDemandScore: Number.isFinite(gamesScore) ? gamesScore : card.gameplayDemandScore ?? null,
      popularityScore,
      demandEvidenceScore,
      demandDataConfidence,
      salesEvidenceScore: Number.isFinite(salesScore) ? salesScore : card.salesEvidenceScore ?? null,
      liquidityScore,
      expectedSalesPerDay: Number.isFinite(evidence.futbinObservedSalesPerDay) ? Number(evidence.futbinObservedSalesPerDay) : card.expectedSalesPerDay ?? null
    };
  });
}
