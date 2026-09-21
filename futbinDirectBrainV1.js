import https from "node:https";
import { FUTBIN_FC27_EA_TO_ID } from "./futbinIdMapFc27.js";
import { getFutbinEndpointCandidates, getFutbinEndpointPolicy } from "./futbinEndpointRegistryV1.js";

const DEFAULT_BASE = "https://www.futbin.org/futbin/api";
const BATCH_SIZE = 11;
const ID_TTL_MS = Math.max(60_000, Number(process.env.FUTBIN_DIRECT_BRAIN_ID_CACHE_MS || 12 * 60 * 60_000));
const PRICE_TTL_MS = Math.max(30_000, Number(process.env.FUTBIN_DIRECT_BRAIN_PRICE_CACHE_MS || 3 * 60_000));
const MAX_FILTER_PAGES = Math.max(1, Math.min(20, Number(process.env.FUTBIN_DIRECT_BRAIN_MAX_FILTER_PAGES || 8)));
const MAX_PER_RATING = Math.max(3, Math.min(12, Number(process.env.FUTBIN_DIRECT_BRAIN_PER_RATING || 6)));
const MAX_IMPORTANT = Math.max(0, Math.min(40, Number(process.env.FUTBIN_DIRECT_BRAIN_IMPORTANT || 20)));
const ERROR_BACKOFF_MS = Math.max(60_000, Number(process.env.FUTBIN_DIRECT_BRAIN_ERROR_BACKOFF_MS || 10 * 60_000));
const BLOCKED_BACKOFF_MS = Math.max(ERROR_BACKOFF_MS, Number(process.env.FUTBIN_DIRECT_BRAIN_BLOCKED_BACKOFF_MS || 6 * 60 * 60_000));
const RATE_LIMIT_BACKOFF_MS = Math.max(ERROR_BACKOFF_MS, Number(process.env.FUTBIN_DIRECT_BRAIN_RATE_LIMIT_BACKOFF_MS || 2 * 60 * 60_000));

const idCache = new Map();
const pageCache = new Map();
const priceCache = new Map();
const inflightPages = new Map();

const state = {
  calls: 0, successes: 0, failures: 0, mappingCalls: 0, priceCalls: 0,
  ipv4FallbackAttempts: 0, ipv4FallbackSuccesses: 0,
  cacheHits: 0, enriched: 0, lastSuccessAt: null, lastFailureAt: null,
  lastError: null, lastRunAt: null, lastRun: null, disabledUntil: null, circuitReason: null
};

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
function enabled() {
  const raw = process.env.FUTBIN_DIRECT_ENABLED ?? process.env.FUTBIN_DIRECT_BRAIN_ENABLED ?? "false";
  return truthy(raw) && truthy(process.env.FUTBIN_DIRECT_ACTIVATION_CONFIRMED);
}
function serverCollectorEnabled() {
  return truthy(process.env.FUTBIN_SERVER_COLLECTOR_ENABLED)
    && truthy(process.env.FUTBIN_SERVER_COLLECTOR_ACTIVATION_CONFIRMED);
}
function baseUrl() {
  return getFutbinEndpointCandidates()[0] || DEFAULT_BASE;
}
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function readCache(map, key, ttl) {
  const hit = map.get(key);
  if (!hit || Date.now() - hit.at > ttl) return null;
  state.cacheHits += 1;
  return hit.value;
}
function writeCache(map, key, value) {
  map.set(key, { at: Date.now(), value });
  return value;
}
function rowsFrom(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json)) return json;
  return [];
}
function chunksOf(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}
function requestJsonIpv4(url) {
  state.ipv4FallbackAttempts += 1;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      family: 4,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0",
        referer: "https://www.futbin.com/",
        "accept-language": "en-US,en;q=0.9"
      },
      timeout: 12000
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) {
          return reject(new Error(`FUTBIN direct IPv4 HTTP ${status}`));
        }
        try {
          const json = JSON.parse(body);
          state.ipv4FallbackSuccesses += 1;
          resolve(json);
        } catch {
          reject(new Error(`FUTBIN direct IPv4 non-JSON: ${body.slice(0, 80).replace(/\s+/g, " ")}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("FUTBIN direct IPv4 timeout")));
    req.on("error", reject);
  });
}

async function requestJson(url, fetcher = fetch) {
  state.calls += 1;
  try {
    let json;
    try {
      const response = await fetcher(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0",
          referer: "https://www.futbin.com/",
          "accept-language": "en-US,en;q=0.9"
        },
        cache: "no-store"
      });
      if (response && "ok" in response && !response.ok) throw new Error(`FUTBIN direct HTTP ${response.status}`);
      json = typeof response?.json === "function" ? await response.json() : response;
    } catch (primaryError) {
      if (fetcher !== fetch) throw primaryError;
      if (/HTTP\s*(?:401|403|429)/i.test(String(primaryError?.message || primaryError))) throw primaryError;
      json = await requestJsonIpv4(url);
    }
    state.successes += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return json;
  } catch (error) {
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = String(error?.message || error);
    throw error;
  }
}

function rememberMapping(year, row) {
  const eaId = positive(row?.Player_Resource ?? row?.resource_id ?? row?.Player_ID);
  const futbinId = positive(row?.ID ?? row?.id);
  if (!eaId || !futbinId) return;
  writeCache(idCache, `${year}|${eaId}`, futbinId);
}
async function ratingPage(year, rating, page, fetcher) {
  const key = `${year}|${rating}|${page}`;
  const cached = readCache(pageCache, key, ID_TTL_MS);
  if (cached) return cached;
  if (inflightPages.has(key)) return inflightPages.get(key);

  const promise = (async () => {
    state.mappingCalls += 1;
    const params = new URLSearchParams({
      platform: "PS", rating: `${rating}-${rating}`,
      sort: "rating", order: "desc", page: String(page)
    });
    const json = await requestJson(`${baseUrl()}/${year}/getFilteredPlayers?${params}`, fetcher);
    const rows = rowsFrom(json);
    for (const row of rows) rememberMapping(year, row);
    return writeCache(pageCache, key, rows);
  })();

  inflightPages.set(key, promise);
  try { return await promise; }
  finally { inflightPages.delete(key); }
}
async function resolveIds(cards, year, fetcher) {
  const resolved = new Map();
  const byRating = new Map();

  for (const card of cards) {
    const eaId = positive(card?.eaId);
    if (!eaId) continue;
    const cached = readCache(idCache, `${year}|${eaId}`, ID_TTL_MS);
    if (cached) {
      resolved.set(String(eaId), cached);
      continue;
    }
    const suppliedId = positive(card?.futbinId);
    if (suppliedId) {
      writeCache(idCache, `${year}|${eaId}`, suppliedId);
      resolved.set(String(eaId), suppliedId);
      continue;
    }
    if (year === 27) {
      const staticId = positive(FUTBIN_FC27_EA_TO_ID[String(eaId)]);
      if (staticId) {
        writeCache(idCache, `${year}|${eaId}`, staticId);
        resolved.set(String(eaId), staticId);
        continue;
      }
      // Production Hostless is currently blocked on FUTBIN discovery endpoints.
      // Unknown FC27 ids fail closed and are left to Parse. Custom test fetchers
      // may still exercise the discovery path deterministically.
      if (fetcher === fetch) continue;
    }
    const rating = positive(card?.overall);
    if (!rating) continue;
    if (!byRating.has(rating)) byRating.set(rating, []);
    byRating.get(rating).push(eaId);
  }

  for (const [rating, ids] of byRating) {
    const pending = new Set(ids.map(String));
    for (let page = 1; page <= MAX_FILTER_PAGES && pending.size; page++) {
      const rows = await ratingPage(year, rating, page, fetcher);
      for (const eaId of [...pending]) {
        const id = readCache(idCache, `${year}|${eaId}`, ID_TTL_MS);
        if (id) { resolved.set(eaId, id); pending.delete(eaId); }
      }
      if (!rows.length || rows.length < 32) break;
    }
  }
  return resolved;
}
async function fetchPrices(ids, year, fetcher) {
  const result = new Map();
  const pending = [];
  for (const id of [...new Set(ids.map(positive).filter(Boolean))]) {
    const key = `${year}|PS|${id}`;
    const cached = readCache(priceCache, key, PRICE_TTL_MS);
    if (cached) result.set(String(id), cached);
    else pending.push(id);
  }

  for (const batch of chunksOf(pending, BATCH_SIZE)) {
    state.priceCalls += 1;
    const params = new URLSearchParams({ player_ids: batch.join(","), platform: "PS" });
    const json = await requestJson(`${baseUrl()}/${year}/getPlayersPrice?${params}`, fetcher);
    const returned = new Set();
    for (const row of rowsFrom(json)) {
      const id = positive(row?.ID);
      if (!id) continue;
      returned.add(String(id));
      rememberMapping(year, row);
      const value = {
        id, eaId: positive(row?.Player_Resource ?? row?.Player_ID),
        name: row?.Player_Fullname ?? null,
        price: positive(row?.LCPrice),
        checkedAt: row?.checked ?? null
      };
      writeCache(priceCache, `${year}|PS|${id}`, value);
      result.set(String(id), value);
    }
    for (const id of batch) {
      if (returned.has(String(id))) continue;
      const value = { id, eaId: null, name: null, price: null, checkedAt: null };
      writeCache(priceCache, `${year}|PS|${id}`, value);
      result.set(String(id), value);
    }
  }
  return result;
}

function selectCards(rows, minRating = 82) {
  const selected = new Map();
  const byRating = new Map();
  for (const row of rows || []) {
    if (row?.cardType !== "Base Rare" || !positive(row?.eaId) || !positive(row?.price)) continue;
    const rating = Number(row.overall);
    if (!Number.isFinite(rating) || rating < Number(minRating || 82)) continue;
    if (!byRating.has(rating)) byRating.set(rating, []);
    byRating.get(rating).push(row);
  }
  for (const list of byRating.values()) {
    list.sort((a, b) => Number(b.aiConfidence || 0) - Number(a.aiConfidence || 0));
    for (const row of list.slice(0, MAX_PER_RATING)) selected.set(String(row.eaId), row);
  }

  const important = (rows || [])
    .filter(row => positive(row?.eaId) && positive(row?.price))
    .filter(row => row?.tracked || row?.intensiveWatch || ["JETZT KAUFEN","JETZT VERKAUFEN","VERKAUF PRÃœFEN"].includes(String(row?.aiAction)))
    .sort((a, b) => Number(b.aiConfidence || 0) - Number(a.aiConfidence || 0))
    .slice(0, MAX_IMPORTANT);
  for (const row of important) selected.set(String(row.eaId), row);
  return [...selected.values()];
}
export async function enrichRowsWithDirectFutbinBrain(rows = [], options = {}) {
  const year = Number(options.gameYear || 0);
  const started = Date.now();
  state.lastRunAt = new Date(started).toISOString();

  const active = enabled() || serverCollectorEnabled();
  if (!active || year !== 27) {
    state.lastRun = { ok: false, reason: "DISABLED_OR_NON_FC27", year, selected: 0, enriched: 0 };
    return state.lastRun;
  }
  if (state.disabledUntil && Date.now() < Date.parse(state.disabledUntil)) {
    state.lastRun = { ok: false, reason: "ERROR_BACKOFF", year, selected: 0, enriched: 0, disabledUntil: state.disabledUntil };
    return state.lastRun;
  }

  const selected = selectCards(rows, Number(options.minRating ?? 82));
  if (!selected.length) {
    state.lastRun = { ok: true, year, selected: 0, enriched: 0, missingIds: 0, missingPrices: 0 };
    return state.lastRun;
  }

  try {
    const ids = await resolveIds(selected, year, options.fetcher || fetch);
    const prices = await fetchPrices([...ids.values()], year, options.fetcher || fetch);
    let enriched = 0, missingIds = 0, missingPrices = 0;

    for (const row of selected) {
      const futbinId = ids.get(String(row.eaId));
      if (!futbinId) { missingIds += 1; continue; }
      const hit = prices.get(String(futbinId));
      const price = positive(hit?.price);
      row.futbinId = futbinId;
      row.futbinProvider = "FUTBIN_DIRECT_FC27";
      row.futbinCheckedAt = hit?.checkedAt || new Date().toISOString();
      if (!price) { missingPrices += 1; continue; }
      const diffPct = Number((((price - Number(row.price)) / Number(row.price)) * 100).toFixed(2));
      const absDiff = Math.abs(diffPct);
      const maxDiff = Number(options.maxDiffPct ?? 12);
      const outlierDiff = Number(options.outlierDiffPct ?? 25);
      row.futbinPrice = price;
      row.futbinDiffPct = diffPct;
      row.futbinCrossCheck = absDiff >= outlierDiff ? "OUTLIER" : absDiff >= maxDiff ? "DIVERGENCE" : "MATCH";
      row.futbinMatchConfidence = 100;
      enriched += 1;
    }

    state.enriched += enriched;
    state.disabledUntil = null;
    state.circuitReason = null;
    state.lastRun = {
      ok: true, year, selected: selected.length, enriched, missingIds, missingPrices,
      durationMs: Date.now() - started
    };
    return state.lastRun;
  } catch (error) {
    const message = String(error?.message || error);
    const blocked = /(?:HTTP\s*401|HTTP\s*403|non-JSON)/i.test(message);
    const rateLimited = /HTTP\s*429/i.test(message);
    const backoffMs = blocked ? BLOCKED_BACKOFF_MS : rateLimited ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS;
    state.disabledUntil = new Date(Date.now() + backoffMs).toISOString();
    state.circuitReason = blocked ? "ACCESS_BLOCKED" : rateLimited ? "RATE_LIMITED" : "UPSTREAM_ERROR";
    state.lastRun = {
      ok: false, year, selected: selected.length, enriched: 0,
      error: message, blocked, rateLimited, circuitReason: state.circuitReason, backoffMs, durationMs: Date.now() - started,
      disabledUntil: state.disabledUntil
    };
    return state.lastRun;
  }
}

export function getDirectFutbinBrainStatus() {
  return {
    enabled: enabled() || serverCollectorEnabled(),
    directEnabled: enabled(),
    serverCollectorEnabled: serverCollectorEnabled(),
    confirmedGameYear: 27,
    batchSize: BATCH_SIZE,
    maxPerRating: MAX_PER_RATING,
    maxImportant: MAX_IMPORTANT,
    staticMapCount: Object.keys(FUTBIN_FC27_EA_TO_ID).length,
    idCacheMs: ID_TTL_MS,
    priceCacheMs: PRICE_TTL_MS,
    endpointPolicy: getFutbinEndpointPolicy(),
    activeBaseUrl: baseUrl(),
    ...state
  };
}
export function resetDirectFutbinBrainForTests() {
  idCache.clear();
  pageCache.clear();
  priceCache.clear();
  inflightPages.clear();
  for (const key of Object.keys(state)) {
    if (["lastSuccessAt","lastFailureAt","lastError","lastRunAt","lastRun","disabledUntil","circuitReason"].includes(key)) state[key] = null;
    else state[key] = 0;
  }
}
