import { GAME_YEAR } from './config.js';
import { fetchJson } from './utils.js';
import { FUTBIN_FC27_EA_TO_ID } from '../../futbinIdMapFc27.js';

// Confirmed direct FC27 mapping from the live FUTBIN response used to validate this adapter.
const UV_FUTBIN_FC27_EA_TO_ID = Object.freeze({ ...FUTBIN_FC27_EA_TO_ID, '230899': 778 });

const DEFAULT_BASE = 'https://www.futbin.org/futbin/api';
const DIRECT_BATCH_SIZE = 11;
const FILTER_PAGE_SIZE = 32;
const PRICE_CACHE_MS = Math.max(15_000, Number(process.env.FUTBIN_DIRECT_PRICE_CACHE_MS || 60_000));
const ID_CACHE_MS = Math.max(60_000, Number(process.env.FUTBIN_DIRECT_ID_CACHE_MS || 12 * 60 * 60_000));
const MAX_FILTER_PAGES = Math.max(1, Math.min(30, Number(process.env.FUTBIN_DIRECT_MAX_FILTER_PAGES || 12)));
const ERROR_BACKOFF_MS = Math.max(60_000, Number(process.env.FUTBIN_DIRECT_ERROR_BACKOFF_MS || 10 * 60_000));
const BLOCKED_BACKOFF_MS = Math.max(ERROR_BACKOFF_MS, Number(process.env.FUTBIN_DIRECT_BLOCKED_BACKOFF_MS || 60 * 60_000));

const eaToFutbinCache = new Map();
const ratingPageCache = new Map();
const priceCache = new Map();
const ratingPageInflight = new Map();

const state = {
  calls: 0,
  successes: 0,
  failures: 0,
  mappingCalls: 0,
  priceCalls: 0,
  cacheHits: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  disabledUntil: null,
  lastBackoffMs: 0,
  lastBlocked: false
};

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function directBase() {
  return String(process.env.FUTBIN_DIRECT_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}
function directEnabled(options = {}) {
  if (typeof options.enabled === 'boolean') return options.enabled;
  const raw = String(process.env.FUTBIN_DIRECT_ENABLED ?? 'false').trim().toLowerCase();
  const activationConfirmed = String(process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED ?? 'false').trim().toLowerCase() === 'true';
  return activationConfirmed && !['0', 'false', 'off', 'no'].includes(raw);
}

function discoveryEnabled(options = {}) {
  if (typeof options.discoveryEnabled === 'boolean') return options.discoveryEnabled;
  if (typeof options.fetcher === 'function') return true;
  return truthy(process.env.FUTBIN_DIRECT_DISCOVERY_ENABLED);
}

function platformCode(platform) {
  return platform === 'pc' ? 'PC' : 'PS';
}

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cacheRead(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit || Date.now() - hit.savedAt > ttlMs) return null;
  state.cacheHits += 1;
  return hit.value;
}

function cacheWrite(map, key, value) {
  map.set(key, { savedAt: Date.now(), value });
  return value;
}

function extractRows(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [];
}

function rememberMapping(year, row) {
  const eaId = finitePositive(row?.Player_Resource ?? row?.resource_id ?? row?.Player_ID);
  const futbinId = finitePositive(row?.ID ?? row?.id);
  if (!eaId || !futbinId) return null;
  cacheWrite(eaToFutbinCache, `${year}|${eaId}`, futbinId);
  return { eaId, futbinId };
}
function backoffActive() {
  return Boolean(state.disabledUntil && Date.now() < Date.parse(state.disabledUntil));
}

function applyDirectBackoff(error) {
  const message = String(error?.message || error);
  const blocked = /(?:HTTP\s*403|Cloudflare|non-JSON|Unexpected token)/i.test(message);
  const backoffMs = blocked ? BLOCKED_BACKOFF_MS : ERROR_BACKOFF_MS;
  state.lastFailureAt = new Date().toISOString();
  state.lastError = message;
  state.lastBackoffMs = backoffMs;
  state.lastBlocked = blocked;
  state.disabledUntil = new Date(Date.now() + backoffMs).toISOString();
  return { message, blocked, backoffMs };
}

async function directRequest(url, options = {}) {
  if (backoffActive()) {
    const error = new Error(`FUTBIN direct backoff until ${state.disabledUntil}`);
    error.code = 'FUTBIN_DIRECT_BACKOFF';
    throw error;
  }
  const fetcher = options.fetcher || fetchJson;
  state.calls += 1;
  try {
    const json = await fetcher(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        referer: 'https://www.futbin.com/'
      }
    });
    state.successes += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.disabledUntil = null;
    state.lastBackoffMs = 0;
    state.lastBlocked = false;
    return json;
  } catch (error) {
    state.failures += 1;
    applyDirectBackoff(error);
    throw error;
  }
}

async function fetchRatingPage(year, rating, page, platform, options = {}) {
  const key = `${year}|${platformCode(platform)}|${rating}|${page}`;
  const cached = cacheRead(ratingPageCache, key, ID_CACHE_MS);
  if (cached) return cached;
  if (ratingPageInflight.has(key)) return ratingPageInflight.get(key);

  const promise = (async () => {
    state.mappingCalls += 1;
    const params = new URLSearchParams({
      platform: platformCode(platform),
      rating: `${rating}-${rating}`,
      sort: 'rating',
      order: 'desc',
      page: String(page)
    });
    const json = await directRequest(`${directBase()}/${year}/getFilteredPlayers?${params}`, options);
    const rows = extractRows(json);
    for (const row of rows) rememberMapping(year, row);
    return cacheWrite(ratingPageCache, key, rows);
  })();

  ratingPageInflight.set(key, promise);
  try { return await promise; }
  finally { ratingPageInflight.delete(key); }
}
export function isDirectFutbinEnabled(options = {}) {
  const year = Number(options.gameYear ?? GAME_YEAR);
  return directEnabled(options) && year === 27;
}

export async function resolveDirectFutbinIds(cards = [], platform = 'console', options = {}) {
  const year = Number(options.gameYear ?? GAME_YEAR);
  const input = Array.isArray(cards) ? cards : [];
  const resolved = new Map();

  if (!isDirectFutbinEnabled({ ...options, gameYear: year })) {
    return { ok: false, year, resolved, missing: input.map(card => Number(card?.eaId)).filter(Number.isFinite), reason: 'DIRECT_DISABLED_OR_UNCONFIRMED_YEAR' };
  }

  const byRating = new Map();
  const canDiscover = discoveryEnabled(options);
  for (const card of input) {
    const eaId = finitePositive(card?.eaId);
    if (!eaId) continue;
    const supplied = finitePositive(card?.futbinId);
    if (supplied) cacheWrite(eaToFutbinCache, `${year}|${eaId}`, supplied);
    const cachedId = cacheRead(eaToFutbinCache, `${year}|${eaId}`, ID_CACHE_MS);
    if (cachedId) {
      resolved.set(String(eaId), cachedId);
      continue;
    }
    const staticId = year === 27 ? finitePositive(UV_FUTBIN_FC27_EA_TO_ID[String(eaId)]) : null;
    if (staticId) {
      cacheWrite(eaToFutbinCache, `${year}|${eaId}`, staticId);
      resolved.set(String(eaId), staticId);
      continue;
    }
    if (!canDiscover) continue;
    const rating = finitePositive(card?.overall);
    if (!rating) continue;
    if (!byRating.has(rating)) byRating.set(rating, []);
    byRating.get(rating).push(eaId);
  }

  for (const [rating, targetIds] of byRating) {
    const pending = new Set(targetIds.map(String));
    for (let page = 1; page <= MAX_FILTER_PAGES && pending.size; page++) {
      const rows = await fetchRatingPage(year, rating, page, platform, options);
      for (const eaId of [...pending]) {
        const futbinId = cacheRead(eaToFutbinCache, `${year}|${eaId}`, ID_CACHE_MS);
        if (futbinId) {
          resolved.set(eaId, futbinId);
          pending.delete(eaId);
        }
      }
      if (!rows.length || rows.length < FILTER_PAGE_SIZE) break;
    }
  }
  const missing = [];
  for (const card of input) {
    const eaId = finitePositive(card?.eaId);
    if (!eaId) continue;
    if (resolved.has(String(eaId))) continue;
    const futbinId = cacheRead(eaToFutbinCache, `${year}|${eaId}`, ID_CACHE_MS);
    if (futbinId) resolved.set(String(eaId), futbinId);
    else missing.push(eaId);
  }

  return { ok: true, year, resolved, missing };
}

function chunked(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export async function fetchDirectFutbinPrices(futbinIds = [], platform = 'console', options = {}) {
  const year = Number(options.gameYear ?? GAME_YEAR);
  const result = new Map();
  if (!isDirectFutbinEnabled({ ...options, gameYear: year })) {
    return { ok: false, year, prices: result, reason: 'DIRECT_DISABLED_OR_UNCONFIRMED_YEAR' };
  }

  const unique = [...new Set(futbinIds.map(finitePositive).filter(Boolean))];
  const pending = [];
  for (const id of unique) {
    const key = `${year}|${platformCode(platform)}|${id}`;
    const cached = cacheRead(priceCache, key, PRICE_CACHE_MS);
    if (cached) result.set(String(id), cached);
    else pending.push(id);
  }

  for (const batch of chunked(pending, DIRECT_BATCH_SIZE)) {
    state.priceCalls += 1;
    const params = new URLSearchParams({
      player_ids: batch.join(','),
      platform: platformCode(platform)
    });
    const json = await directRequest(`${directBase()}/${year}/getPlayersPrice?${params}`, options);
    const rows = extractRows(json);
    const returned = new Set();
    for (const row of rows) {
      const futbinId = finitePositive(row?.ID);
      if (!futbinId) continue;
      returned.add(String(futbinId));
      rememberMapping(year, row);
      const price = finitePositive(row?.LCPrice);
      const value = {
        id: futbinId,
        eaId: finitePositive(row?.Player_Resource ?? row?.Player_ID),
        name: row?.Player_Fullname ?? null,
        price,
        checked: row?.checked ?? null,
        source: 'FUTBIN_DIRECT_FC27'
      };
      cacheWrite(priceCache, `${year}|${platformCode(platform)}|${futbinId}`, value);
      result.set(String(futbinId), value);
    }

    for (const id of batch) {
      if (returned.has(String(id))) continue;
      const value = { id, eaId: null, name: null, price: null, checked: null, source: 'FUTBIN_DIRECT_FC27' };
      cacheWrite(priceCache, `${year}|${platformCode(platform)}|${id}`, value);
      result.set(String(id), value);
    }
  }

  return { ok: true, year, prices: result };
}

export async function getDirectFutbinCards(cards = [], platform = 'console', options = {}) {
  const year = Number(options.gameYear ?? GAME_YEAR);
  const mapped = await resolveDirectFutbinIds(cards, platform, { ...options, gameYear: year });
  if (!mapped.ok) return { ok: false, year, results: new Map(), reason: mapped.reason };
  const ids = [...new Set([...mapped.resolved.values()])];
  const priced = await fetchDirectFutbinPrices(ids, platform, { ...options, gameYear: year });
  const results = new Map();

  for (const card of cards) {
    const eaId = finitePositive(card?.eaId);
    if (!eaId) continue;
    const futbinId = mapped.resolved.get(String(eaId));
    if (!futbinId) {
      results.set(String(eaId), { ok: false, price: null, id: null, source: 'FUTBIN_DIRECT_FC27', reason: 'FUTBIN_ID_NOT_FOUND' });
      continue;
    }
    const row = priced.prices.get(String(futbinId));
    results.set(String(eaId), {
      ok: Boolean(row),
      price: finitePositive(row?.price),
      id: futbinId,
      name: row?.name ?? card?.name ?? null,
      rating: card?.overall ?? null,
      version: card?.cardType ?? card?.rarityName ?? null,
      position: card?.position ?? null,
      image: card?.image ?? null,
      rawMatched: true,
      source: 'FUTBIN_DIRECT_FC27',
      evidence: { gamesAvailable: false, salesHistoryAvailable: false }
    });
  }

  return { ok: true, year, results, missing: mapped.missing };
}

export function getFutbinDirectStatus() {
  return {
    configured: directEnabled(),
    active: isDirectFutbinEnabled(),
    gameYear: Number(GAME_YEAR),
    confirmedGameYear: 27,
    batchSize: DIRECT_BATCH_SIZE,
    staticMapCount: Object.keys(UV_FUTBIN_FC27_EA_TO_ID).length,
    discoveryEnabled: discoveryEnabled(),
    idCacheMs: ID_CACHE_MS,
    priceCacheMs: PRICE_CACHE_MS,
    errorBackoffMs: ERROR_BACKOFF_MS,
    blockedBackoffMs: BLOCKED_BACKOFF_MS,
    backoffActive: backoffActive(),
    ...state
  };
}

export function resetFutbinDirectCachesForTests() {
  eaToFutbinCache.clear();
  ratingPageCache.clear();
  priceCache.clear();
  ratingPageInflight.clear();
  state.calls = 0;
  state.successes = 0;
  state.failures = 0;
  state.mappingCalls = 0;
  state.priceCalls = 0;
  state.cacheHits = 0;
  state.lastSuccessAt = null;
  state.lastFailureAt = null;
  state.lastError = null;
  state.disabledUntil = null;
  state.lastBackoffMs = 0;
  state.lastBlocked = false;
}
