import { FUTBIN_PARSE_API_BASE, FUTBIN_CROSSCHECK_LIMIT, FUTBIN_SEARCH_ENDPOINT, GAME_YEAR } from './config.js';
import { clamp, fetchJson, mapLimit, normalizeName } from './utils.js';
import { extractFutbinStructuredEvidence } from './futbinEvidence.js';
import { getDirectFutbinCards, getFutbinDirectStatus, isDirectFutbinEnabled } from './futbinDirect.js';

const cache = new Map();
const CACHE_MS = 30 * 60_000;
const MARKET_CACHE_MS = 10 * 60_000;
const CATALOG_CACHE_MS = 30 * 60_000;
const CATALOG_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.FUTBIN_CATALOG_ENABLED || '').trim().toLowerCase());
const CATALOG_MAX_PAGES = Math.max(1, Math.min(12, Number(process.env.FUTBIN_CATALOG_MAX_PAGES || 6)));
const PARSE_RATE_LIMIT_FALLBACK_MS = Math.max(60_000, Number(process.env.FUTBIN_PARSE_RATE_LIMIT_BACKOFF_MS || 60 * 60_000));
let parseBackoffUntilMs = 0;
let parseBackoffReason = null;
let parseBackoffRetryAfterSeconds = null;
let marketCache = null;
const catalogCache = new Map();

function parseBackoffActive() {
  return Number(parseBackoffUntilMs) > Date.now();
}

function parseRetryAfterSeconds(error) {
  const message = String(error?.message || error || '');
  const match = message.match(/retry[_-]?after[^0-9]{0,24}(\d+)/i);
  const seconds = match ? Number(match[1]) : null;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function applyParseBackoff(error) {
  const message = String(error?.message || error || '');
  if (!/(?:HTTP\s*429|daily limit exceeded|rate[ -]?limit)/i.test(message)) return false;
  const retryAfterSeconds = parseRetryAfterSeconds(error);
  const requestedMs = retryAfterSeconds ? retryAfterSeconds * 1000 : PARSE_RATE_LIMIT_FALLBACK_MS;
  const backoffMs = Math.max(60_000, Math.min(24 * 60 * 60_000, requestedMs));
  parseBackoffUntilMs = Date.now() + backoffMs;
  parseBackoffReason = 'RATE_LIMITED';
  parseBackoffRetryAfterSeconds = retryAfterSeconds;
  return true;
}

export function getFutbinParseBackoffStatus() {
  return {
    active: parseBackoffActive(),
    reason: parseBackoffReason,
    retryAfterSeconds: parseBackoffRetryAfterSeconds,
    until: parseBackoffUntilMs > 0 ? new Date(parseBackoffUntilMs).toISOString() : null,
    fallbackMs: PARSE_RATE_LIMIT_FALLBACK_MS
  };
}

export function applyFutbinParseBackoffForTests(error) {
  return applyParseBackoff(error);
}

export function resetFutbinParseBackoffForTests() {
  parseBackoffUntilMs = 0;
  parseBackoffReason = null;
  parseBackoffRetryAfterSeconds = null;
}
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
  const direct = getFutbinDirectStatus();
  return {
    adapterReady: true,
    source: direct.configured ? 'FUTBIN direct FC27 API + Parse structured fallback' : 'FUTBIN via Parse API structured fields only',
    gamesObserved: extendedDataState.gamesObserved,
    salesHistoryObserved: extendedDataState.salesHistoryObserved,
    popularRankObserved: extendedDataState.popularRankObserved,
    observedSalesPerDayObserved: extendedDataState.observedSalesPerDayObserved,
    lastObservedAt: extendedDataState.lastObservedAt,
    directFutbinApi: direct,
    parseCatalogEnabled: CATALOG_ENABLED,
    parseCatalogMaxPages: CATALOG_MAX_PAGES,
    parseBackoff: getFutbinParseBackoffStatus(),
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
  if (parseBackoffActive()) return { ok: false, reason: 'FUTBIN_PARSE_RATE_LIMIT_BACKOFF', direction: 'unknown', stabilityScore: 55, movers: [] };
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
    applyParseBackoff(error);
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

async function loadFutbinCatalog(platform = 'console') {
  if (!CATALOG_ENABLED) return [];
  const apiKey = String(process.env.FUTBIN_PARSE_API_KEY || '').trim();
  if (!apiKey || parseBackoffActive()) return [];
  const gameYear = GAME_YEAR;
  const cacheKey = `${gameYear}|${platform}`;
  const cached = catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CATALOG_CACHE_MS) return cached.rows;

  const rows = [];
  for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
    const yearFlag = gameYear === 27 ? '&fc27_only=true' : '&fc26_only=true';
    const url = `${FUTBIN_PARSE_API_BASE}/get_players?page=${page}${yearFlag}`;
    const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
    const pageRows = extractRows(json);
    if (!pageRows.length) break;
    rows.push(...pageRows);
    if (pageRows.length < 25) break;
  }
  catalogCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

function matchCatalogCard(rows, card) {
  const wanted = normalizeName(card.name);
  const overall = Number(card.overall || 0);
  const matches = rows
    .filter(row => {
      const name = normalizeName(row.name || row.full_name);
      return name === wanted || (wanted && name.includes(wanted));
    })
    .map(row => ({
      row,
      ratingDelta: Math.abs(Number(row.rating || 0) - overall),
      versionMatch: normalizeName(row.version || '') === normalizeName(card.rarityName || card.cardName || card.cardType || '') ? 0 : 1
    }))
    .sort((a, b) => a.ratingDelta - b.ratingDelta || a.versionMatch - b.versionMatch);
  return matches[0]?.row || null;
}

export async function searchFutbinCard(card, platform = 'console') {
  const apiKey = String(process.env.FUTBIN_PARSE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, reason: 'FUTBIN_PARSE_API_KEY fehlt' };
  const cacheKey = `${platform}|${normalizeName(card.name)}|${card.overall}|${card.cardType}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (parseBackoffActive()) return { ok: false, reason: 'FUTBIN_PARSE_RATE_LIMIT_BACKOFF' };

  try {
    let best = null;
    try {
      const catalogRows = await loadFutbinCatalog(platform);
      best = matchCatalogCard(catalogRows, card);
    } catch {
      // Catalogue failure must not remove the existing per-card fallback.
    }
    if (!best) {
      const url = `${FUTBIN_PARSE_API_BASE}/${FUTBIN_SEARCH_ENDPOINT}?query=${encodeURIComponent(card.name || '')}`;
      const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
      const rows = extractRows(json);
      best = matchCatalogCard(rows, card) || rows[0] || null;
    }
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
    applyParseBackoff(error);
    return value;
  }
}

export async function crosscheckFutbin(cards, platform = 'console') {
  const directEnabled = isDirectFutbinEnabled();
  const parseConfigured = Boolean(String(process.env.FUTBIN_PARSE_API_KEY || '').trim());
  if ((!directEnabled && !parseConfigured) || FUTBIN_CROSSCHECK_LIMIT <= 0) {
    return cards.map(card => ({ ...card, futbinPrice: null, futbinChecked: false }));
  }
  const ranked = [...cards]
    .sort((a, b) => {
      const aNeedsPrice = Number(a?.price) > 0 && !(Number(a?.futbinPrice) > 0) ? 1 : 0;
      const bNeedsPrice = Number(b?.price) > 0 && !(Number(b?.futbinPrice) > 0) ? 1 : 0;
      if (aNeedsPrice !== bNeedsPrice) return bNeedsPrice - aNeedsPrice;
      return (b.selectionScore || b.uvScore || 0) - (a.selectionScore || a.uvScore || 0);
    })
    .slice(0, FUTBIN_CROSSCHECK_LIMIT);

  const byId = new Map();

  if (directEnabled) {
    try {
      const direct = await getDirectFutbinCards(ranked, platform);
      for (const card of ranked) {
        const result = direct?.results?.get?.(String(card.eaId));
        if (result) byId.set(String(card.eaId), result);
      }
    } catch {
      // Direct FUTBIN is optional. Parse remains the fail-closed fallback.
    }
  }

  const fallbackCards = parseConfigured
    ? ranked.filter(card => !(Number(byId.get(String(card.eaId))?.price) > 0))
    : [];
  const parseResults = parseConfigured
    ? await mapLimit(fallbackCards, 3, async card => ({ card, result: await searchFutbinCard(card, platform) }))
    : [];
  const results = parseResults.filter(item => {
    if (!item?.card) return false;
    const key = String(item.card.eaId);
    return item.result?.ok || !byId.has(key);
  });
  for (const item of results) if (item?.card) byId.set(String(item.card.eaId), item.result);

  return cards.map(card => {
    const result = byId.get(String(card.eaId));
    const previousFutbinPriceRaw = Number(card?.futbinPrice);
    const resultFutbinPriceRaw = Number(result?.price);
    const previousFutbinPrice = Number.isFinite(previousFutbinPriceRaw) && previousFutbinPriceRaw > 0 ? previousFutbinPriceRaw : null;
    const futbinPrice = Number.isFinite(resultFutbinPriceRaw) && resultFutbinPriceRaw > 0 ? resultFutbinPriceRaw : previousFutbinPrice;
    const previousSourceDiffRaw = Number(card?.sourceDiffPct);
    const diffPct = Number.isFinite(futbinPrice) && futbinPrice > 0 && Number(card.price) > 0
      ? ((futbinPrice - Number(card.price)) / Number(card.price)) * 100
      : (Number.isFinite(previousSourceDiffRaw) ? previousSourceDiffRaw : null);
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
      futbinProvider: result?.source ?? card.futbinProvider ?? null,
      futbinCheckedAt: result?.checked ?? result?.checkedAt ?? card.futbinCheckedAt ?? null,
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
