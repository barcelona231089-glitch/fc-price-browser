import express from 'express';
import {
  enrichRowsWithFutbinPublicGapFill,
  futbinPublicStatus
} from './futbinMarketV1064.js';

export const FUTBIN_BRIDGE_VERSION = '10.66.1-authorized-futbin-bridge-fast-status';

const AUTHORIZED_FEED_URL = String(process.env.FUTBIN_AUTHORIZED_FEED_URL || process.env.FUTBIN_BRIDGE_FEED_URL || '').trim();
const AUTHORIZED_FEED_TOKEN = String(process.env.FUTBIN_AUTHORIZED_FEED_TOKEN || process.env.FUTBIN_BRIDGE_FEED_TOKEN || '').trim();
const INGEST_TOKEN = String(process.env.FUTBIN_BRIDGE_INGEST_TOKEN || process.env.TRADER_FEED_INGEST_TOKEN || '').trim();
const REFRESH_MS = clamp(Number(process.env.FUTBIN_BRIDGE_REFRESH_MIN || 15), 5, 360) * 60_000;
const FETCH_TIMEOUT_MS = clamp(Number(process.env.FUTBIN_BRIDGE_TIMEOUT_MS || 15000), 4000, 60000);
const MAX_CARDS_PER_IMPORT = Math.round(clamp(Number(process.env.FUTBIN_BRIDGE_MAX_CARDS || 12000), 1, 50000));
const DIRECT_PUBLIC_ENABLED = String(process.env.FUTBIN_PUBLIC_DIRECT_ENABLED || 'false').trim().toLowerCase() === 'true';

let schemaReady = false;
let lastRefreshAt = 0;
let refreshInflight = null;
let lastSuccessAt = null;
let lastFailureAt = null;
let lastError = null;
let lastSource = null;
let importedCards = 0;
let importedSales = 0;
let importedHistory = 0;
let attachedRows = 0;
let directAttempts = 0;
let directSkips = 0;

function clamp(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}
function clean(value) { return String(value ?? '').trim(); }
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function integerOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
function toIso(value, fallback = null) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? new Date(t).toISOString() : fallback;
}
function median(values = []) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function average(values = []) {
  const a = values.map(Number).filter(Number.isFinite);
  return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
}
function normalizeSales(raw = []) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 2000)) {
    if (!item || typeof item !== 'object') continue;
    const listedPrice = integerOrNull(item.listedPrice ?? item.listed_for ?? item.listed ?? item.startPrice);
    const soldPrice = integerOrNull(item.soldPrice ?? item.sold_for ?? item.salePrice ?? item.price) ?? 0;
    if (!(listedPrice > 0)) continue;
    const observedAt = toIso(item.observedAt ?? item.date ?? item.time ?? item.soldAt ?? item.listedAt, new Date().toISOString());
    const eaTax = integerOrNull(item.eaTax ?? item.tax) ?? (soldPrice > 0 ? Math.round(soldPrice * 0.05) : 0);
    const netPrice = integerOrNull(item.netPrice ?? item.net) ?? (soldPrice > 0 ? soldPrice - eaTax : 0);
    out.push({
      observedAt,
      listedPrice,
      soldPrice,
      sold: item.sold === true || soldPrice > 0,
      status: item.sold === true || soldPrice > 0 ? 'SOLD' : 'NOT_SOLD',
      eaTax,
      netPrice,
      type: clean(item.type || item.kind || '') || null
    });
  }
  return out;
}
function normalizeHistory(raw = []) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw.slice(0, 50000)) {
    let observedAt = null;
    let price = null;
    if (Array.isArray(item) && item.length >= 2) {
      observedAt = toIso(item[0]);
      price = integerOrNull(item[1]);
    } else if (item && typeof item === 'object') {
      observedAt = toIso(item.observedAt ?? item.recordedAt ?? item.date ?? item.time ?? item.timestamp);
      price = integerOrNull(item.price ?? item.value ?? item.bin ?? item.average);
    }
    if (!observedAt || !(price > 0)) continue;
    const key = `${observedAt}|${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ observedAt, price });
  }
  return out.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}
function salesMetrics(sales = []) {
  const sold = sales.filter(x => Number(x.soldPrice) > 0);
  const unsold = sales.filter(x => !(Number(x.soldPrice) > 0));
  const soldPrices = sold.map(x => Number(x.soldPrice));
  const avgSold = average(soldPrices);
  const medSold = median(soldPrices);
  const avgUnsold = average(unsold.map(x => Number(x.listedPrice)));
  return {
    listingsObserved: sales.length,
    soldListings: sold.length,
    unsoldListings: unsold.length,
    sellThroughRate: sales.length ? Number(((sold.length / sales.length) * 100).toFixed(2)) : null,
    averageSoldPrice: avgSold == null ? null : Math.round(avgSold),
    medianSoldPrice: medSold == null ? null : Math.round(medSold),
    minSoldPrice: soldPrices.length ? Math.min(...soldPrices) : null,
    maxSoldPrice: soldPrices.length ? Math.max(...soldPrices) : null,
    averageUnsoldPrice: avgUnsold == null ? null : Math.round(avgUnsold),
    lastSaleAt: sold.length ? [...sold].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0].observedAt : null,
    lastSalePrice: sold.length ? [...sold].sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0].soldPrice : null
  };
}
function historyWindows(history = [], currentPrice = null) {
  const now = Date.now();
  const defs = { m5:300000, m15:900000, h1:3600000, h6:21600000, h24:86400000, d7:604800000, d30:2592000000 };
  const sorted = normalizeHistory(history);
  const current = Number(currentPrice) > 0 ? Number(currentPrice) : (sorted.at(-1)?.price ?? null);
  const out = {};
  for (const [key, ms] of Object.entries(defs)) {
    const cutoff = now - ms;
    const inside = sorted.filter(p => Date.parse(p.observedAt) >= cutoff && Date.parse(p.observedAt) <= now);
    const anchor = [...sorted].reverse().find(p => Date.parse(p.observedAt) <= cutoff) || inside[0] || null;
    const prices = inside.map(p => p.price);
    out[key] = {
      samples: inside.length,
      anchorAt: anchor?.observedAt ?? null,
      anchorPrice: anchor?.price ?? null,
      currentPrice: current,
      changePct: anchor && current ? Number((((current - anchor.price) / anchor.price) * 100).toFixed(3)) : null,
      low: prices.length ? Math.min(...prices) : null,
      high: prices.length ? Math.max(...prices) : null
    };
  }
  return out;
}
function normalizeCard(raw, gameYear = '26', source = 'AUTHORIZED_FEED') {
  if (!raw || typeof raw !== 'object') return null;
  const eaId = clean(raw.eaId ?? raw.ea_id ?? raw.assetId ?? raw.playerId ?? raw.id);
  if (!/^\d+$/.test(eaId)) return null;
  const sales = normalizeSales(raw.sales ?? raw.salesHistory ?? raw.listings ?? []);
  const history = normalizeHistory(raw.history ?? raw.priceHistory ?? []);
  const metrics = { ...salesMetrics(sales), ...(raw.salesMetrics && typeof raw.salesMetrics === 'object' ? raw.salesMetrics : {}) };
  const pricePlayStation = integerOrNull(raw.pricePlayStation ?? raw.psPrice ?? raw.consolePrice ?? raw.price ?? raw.currentPrice);
  const detail = {
    version: FUTBIN_BRIDGE_VERSION,
    source: clean(raw.source || source) || source,
    gameYear: clean(raw.gameYear || gameYear).slice(-2),
    eaId,
    futbinId: clean(raw.futbinId ?? raw.futbin_id) || null,
    slug: clean(raw.slug) || null,
    name: clean(raw.name ?? raw.playerName) || null,
    rating: integerOrNull(raw.rating ?? raw.overall),
    primaryPosition: clean(raw.primaryPosition ?? raw.position) || null,
    alternatePositions: Array.isArray(raw.alternatePositions) ? raw.alternatePositions.map(clean).filter(Boolean).slice(0,10) : [],
    nation: clean(raw.nation) || null,
    league: clean(raw.league) || null,
    club: clean(raw.club) || null,
    cardVersion: clean(raw.cardVersion ?? raw.versionName ?? raw.rarityName ?? raw.promoName) || null,
    rarityClass: clean(raw.rarityClass) || null,
    promoName: clean(raw.promoName) || null,
    isSpecial: typeof raw.isSpecial === 'boolean' ? raw.isSpecial : null,
    gamesPlayedConsole: integerOrNull(raw.gamesPlayedConsole ?? raw.gamesPlayed ?? raw.games),
    gamesPlayedPc: integerOrNull(raw.gamesPlayedPc),
    gpgConsole: numberOrNull(raw.gpgConsole ?? raw.gpg),
    gpgPc: numberOrNull(raw.gpgPc),
    pricePlayStation,
    priceXbox: integerOrNull(raw.priceXbox),
    pricePc: integerOrNull(raw.pricePc),
    priceUpdatedAtConsole: toIso(raw.priceUpdatedAtConsole ?? raw.priceUpdatedAt ?? raw.updatedAt),
    trendConsolePct: numberOrNull(raw.trendConsolePct ?? raw.trendPct ?? raw.trend),
    priceRangeMin: integerOrNull(raw.priceRangeMin),
    priceRangeMax: integerOrNull(raw.priceRangeMax),
    prpPct: numberOrNull(raw.prpPct ?? raw.prp),
    popularityRank: integerOrNull(raw.popularityRank ?? raw.popularity),
    likes: integerOrNull(raw.likes),
    dislikes: integerOrNull(raw.dislikes),
    inPacksState: clean(raw.inPacksState) || null,
    marketAverageBin: integerOrNull(raw.marketAverageBin ?? raw.averageBin),
    marketHigh: integerOrNull(raw.marketHigh ?? raw.high),
    marketLow: integerOrNull(raw.marketLow ?? raw.low),
    eaAveragePrice: integerOrNull(raw.eaAveragePrice),
    salesMetrics: metrics,
    sales,
    history,
    historyWindows: raw.historyWindows && typeof raw.historyWindows === 'object' ? raw.historyWindows : historyWindows(history, pricePlayStation),
    fetchedAt: toIso(raw.fetchedAt, new Date().toISOString())
  };
  return detail;
}

async function ensureSchema(pool) {
  if (!pool || schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_bridge_cards (
    ea_id VARCHAR(32) PRIMARY KEY,
    game_year VARCHAR(2) NOT NULL,
    source VARCHAR(120) NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_bridge_sales (
    ea_id VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    listed_price INTEGER NOT NULL,
    sold_price INTEGER NOT NULL DEFAULT 0,
    sold BOOLEAN NOT NULL DEFAULT FALSE,
    source VARCHAR(120) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(ea_id, observed_at, listed_price, sold_price, source)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_bridge_history (
    ea_id VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    price INTEGER NOT NULL,
    source VARCHAR(120) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE(ea_id, observed_at, price, source)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fc_futbin_bridge_cards_year ON fc_futbin_bridge_cards(game_year)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fc_futbin_bridge_history_ea_time ON fc_futbin_bridge_history(ea_id, observed_at DESC)`);
  schemaReady = true;
}

async function persistCard(pool, detail) {
  await ensureSchema(pool);
  await pool.query(`
    INSERT INTO fc_futbin_bridge_cards(ea_id, game_year, source, fetched_at, payload)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(ea_id) DO UPDATE SET
      game_year=EXCLUDED.game_year,
      source=EXCLUDED.source,
      fetched_at=EXCLUDED.fetched_at,
      payload=EXCLUDED.payload
  `, [detail.eaId, detail.gameYear, detail.source, detail.fetchedAt, JSON.stringify(detail)]);
  for (const sale of detail.sales || []) {
    await pool.query(`
      INSERT INTO fc_futbin_bridge_sales(ea_id, observed_at, listed_price, sold_price, sold, source, payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT DO NOTHING
    `, [detail.eaId, sale.observedAt, sale.listedPrice, sale.soldPrice || 0, sale.sold === true, detail.source, JSON.stringify(sale)]);
    importedSales += 1;
  }
  for (const point of detail.history || []) {
    await pool.query(`
      INSERT INTO fc_futbin_bridge_history(ea_id, observed_at, price, source, payload)
      VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT DO NOTHING
    `, [detail.eaId, point.observedAt, point.price, detail.source, JSON.stringify(point)]);
    importedHistory += 1;
  }
  importedCards += 1;
}

async function rebuildSeasonDaily(pool, gameYear = '26') {
  if (!pool) return 0;
  await ensureSchema(pool);
  const result = await pool.query(`
    WITH d AS (
      SELECT ea_id, date_trunc('day', observed_at)::date AS day,
        min(price)::int AS low_price,
        max(price)::int AS high_price,
        round(avg(price))::int AS average_price,
        count(*)::int AS observations,
        (array_agg(price ORDER BY observed_at ASC))[1]::int AS open_price,
        (array_agg(price ORDER BY observed_at DESC))[1]::int AS close_price
      FROM fc_futbin_bridge_history h
      JOIN fc_futbin_bridge_cards c USING(ea_id)
      WHERE c.game_year=$1 AND price>0
      GROUP BY ea_id, date_trunc('day', observed_at)::date
    )
    INSERT INTO fc_v1063_season_daily(game_year, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, source, payload)
    SELECT $1, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, 'FUTBIN_AUTHORIZED_BRIDGE', '{}'::jsonb FROM d
    ON CONFLICT(game_year, ea_id, day, source) DO UPDATE SET
      open_price=EXCLUDED.open_price,
      close_price=EXCLUDED.close_price,
      low_price=EXCLUDED.low_price,
      high_price=EXCLUDED.high_price,
      average_price=EXCLUDED.average_price,
      observations=EXCLUDED.observations
    RETURNING 1
  `, [String(gameYear)]);
  return result.rowCount || 0;
}

export async function ingestFutbinBridgeV1066({ pool, payload, gameYear = '26', source = 'AUTHORIZED_IMPORT' } = {}) {
  if (!pool) return { ok: false, error: 'NO_DATABASE' };
  const rawCards = Array.isArray(payload) ? payload : Array.isArray(payload?.cards) ? payload.cards : payload?.card ? [payload.card] : [];
  if (!rawCards.length) return { ok: false, error: 'NO_CARDS' };
  const cards = rawCards.slice(0, MAX_CARDS_PER_IMPORT).map(card => normalizeCard(card, gameYear, source)).filter(Boolean);
  if (!cards.length) return { ok: false, error: 'NO_VALID_CARDS' };
  for (const card of cards) await persistCard(pool, card);
  const seasonDaily = await rebuildSeasonDaily(pool, String(gameYear)).catch(() => 0);
  lastSuccessAt = new Date().toISOString();
  lastFailureAt = null;
  lastError = null;
  lastSource = source;
  return { ok: true, version: FUTBIN_BRIDGE_VERSION, cards: cards.length, seasonDaily, source };
}

export async function refreshAuthorizedFutbinBridgeV1066({ pool, gameYear = '26', force = false } = {}) {
  if (!pool) return { ok: false, skipped: 'NO_DATABASE' };
  if (!AUTHORIZED_FEED_URL) return { ok: false, skipped: 'AUTHORIZED_FEED_NOT_CONFIGURED' };
  const now = Date.now();
  if (!force && lastRefreshAt && now - lastRefreshAt < REFRESH_MS) return { ok: true, skipped: 'REFRESH_COOLDOWN' };
  if (refreshInflight) return refreshInflight;
  refreshInflight = (async () => {
    lastRefreshAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = new URL(AUTHORIZED_FEED_URL);
      if (url.protocol !== 'https:') throw new Error('AUTHORIZED_FEED_REQUIRES_HTTPS');
      const headers = { accept: 'application/json' };
      if (AUTHORIZED_FEED_TOKEN) headers.authorization = `Bearer ${AUTHORIZED_FEED_TOKEN}`;
      const response = await fetch(url, { signal: ctrl.signal, headers, redirect: 'follow' });
      if (!response.ok) throw new Error(`AUTHORIZED_FEED_HTTP_${response.status}`);
      const data = await response.json();
      const result = await ingestFutbinBridgeV1066({ pool, payload: data, gameYear, source: 'FUTBIN_AUTHORIZED_FEED' });
      lastSuccessAt = new Date().toISOString();
      lastFailureAt = null;
      lastError = null;
      lastSource = 'FUTBIN_AUTHORIZED_FEED';
      return result;
    } catch (error) {
      lastFailureAt = new Date().toISOString();
      lastError = String(error?.message || error);
      return { ok: false, error: lastError };
    } finally {
      clearTimeout(timer);
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

function attachDetail(row, detail) {
  if (!row || !detail) return;
  row.futbinPublic = detail;
  row.futbinProvider = detail.source;
  row.futbinPrice = Number(detail.pricePlayStation) > 0 ? Number(detail.pricePlayStation) : Number(detail.marketAverageBin) > 0 ? Number(detail.marketAverageBin) : null;
  row.futbinTrendPct = numberOrNull(detail.trendConsolePct);
  row.futbinGamesPlayedConsole = integerOrNull(detail.gamesPlayedConsole);
  row.futbinGamesPlayedPc = integerOrNull(detail.gamesPlayedPc);
  row.futbinGpgConsole = numberOrNull(detail.gpgConsole);
  row.futbinGpgPc = numberOrNull(detail.gpgPc);
  row.futbinSalesMetrics = detail.salesMetrics || {};
  row.futbinMedianSoldPrice = integerOrNull(detail.salesMetrics?.medianSoldPrice);
  row.futbinLastSalePrice = integerOrNull(detail.salesMetrics?.lastSalePrice);
  row.futbinLastSaleAt = detail.salesMetrics?.lastSaleAt ?? null;
  row.futbinSellThroughRate = numberOrNull(detail.salesMetrics?.sellThroughRate);
  row.futbinLiquidityScore = numberOrNull(detail.salesMetrics?.liquidityScore);
  row.futbinHistoryWindows = detail.historyWindows || null;
  row.futbinPrimaryPosition = detail.primaryPosition || null;
  row.futbinAlternatePositions = detail.alternatePositions || [];
  row.futbinNation = detail.nation || null;
  row.futbinLeague = detail.league || null;
  row.futbinClub = detail.club || null;
  row.futbinCardVersion = detail.cardVersion || null;
  row.futbinPromoName = detail.promoName || null;
  row.futbinPrpPct = numberOrNull(detail.prpPct);
}

export async function attachFutbinBridgeRowsV1066({ rows = [], pool = null, gameYear = '26' } = {}) {
  if (!pool || !Array.isArray(rows) || !rows.length) return 0;
  await ensureSchema(pool);
  const ids = [...new Set(rows.map(r => clean(r?.eaId ?? r?.id)).filter(x => /^\d+$/.test(x)))];
  if (!ids.length) return 0;
  const result = await pool.query(`SELECT ea_id, payload FROM fc_futbin_bridge_cards WHERE game_year=$1 AND ea_id=ANY($2::text[])`, [String(gameYear), ids]);
  const byId = new Map((result.rows || []).map(r => [String(r.ea_id), r.payload]));
  let count = 0;
  for (const row of rows) {
    const detail = byId.get(String(row.eaId ?? row.id));
    if (!detail) continue;
    attachDetail(row, detail);
    count += 1;
  }
  attachedRows += count;
  return count;
}

export async function enrichRowsWithFutbinSafeV1066({ rows = [], brainWork = new Map(), gameYear = '26', pool = null } = {}) {
  await refreshAuthorizedFutbinBridgeV1066({ pool, gameYear }).catch(() => null);
  const bridgeAttached = await attachFutbinBridgeRowsV1066({ rows, pool, gameYear }).catch(() => 0);
  let directEnriched = 0;
  let directStatus = null;
  if (DIRECT_PUBLIC_ENABLED) {
    try {
      directAttempts += 1;
      directEnriched = await enrichRowsWithFutbinPublicGapFill({ rows, brainWork, gameYear, pool });
      directStatus = await futbinPublicStatus({ pool, gameYear }).catch(() => null);
    } catch (error) {
      lastError = String(error?.message || error);
    }
  } else {
    directSkips += 1;
  }
  // Authorized/imported data is the final gap-fill layer; it cannot replace FUT.GG live price.
  const finalAttached = await attachFutbinBridgeRowsV1066({ rows, pool, gameYear }).catch(() => 0);
  return { bridgeAttached: Math.max(bridgeAttached, finalAttached), directEnriched, directStatus, directPublicEnabled: DIRECT_PUBLIC_ENABLED };
}

export async function startFutbinBridgeBootstrapV1066({ pool = null, gameYear = '26' } = {}) {
  if (!pool) return { ok: false, error: 'NO_DATABASE' };
  await ensureSchema(pool);
  const refresh = await refreshAuthorizedFutbinBridgeV1066({ pool, gameYear, force: true }).catch(error => ({ ok:false, error:String(error) }));
  const seasonDaily = await rebuildSeasonDaily(pool, gameYear).catch(() => 0);
  return { ok: true, version: FUTBIN_BRIDGE_VERSION, refresh, seasonDaily };
}

let dbCountCache = {
  status: 'NOT_LOADED',
  cards: null,
  sales: null,
  history: null,
  updatedAt: null,
  error: null
};
let dbCountRefreshInflight = null;
let lastDbCountRefreshAt = 0;
const DB_COUNT_REFRESH_MS = 60_000;

async function dbCounts(pool, gameYear='26') {
  if (!pool) return null;
  await ensureSchema(pool);
  const r = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM fc_futbin_bridge_cards WHERE game_year=$1) AS cards,
    (SELECT COUNT(*)::int FROM fc_futbin_bridge_sales s JOIN fc_futbin_bridge_cards c USING(ea_id) WHERE c.game_year=$1) AS sales,
    (SELECT COUNT(*)::int FROM fc_futbin_bridge_history h JOIN fc_futbin_bridge_cards c USING(ea_id) WHERE c.game_year=$1) AS history
  `,[String(gameYear)]);
  return r.rows?.[0] || null;
}

function scheduleDbCountRefresh(pool, gameYear='26') {
  if (!pool) {
    dbCountCache = { status:'NO_DATABASE', cards:null, sales:null, history:null, updatedAt:new Date().toISOString(), error:null };
    return;
  }
  const now = Date.now();
  if (dbCountRefreshInflight) return;
  if (lastDbCountRefreshAt && now - lastDbCountRefreshAt < DB_COUNT_REFRESH_MS) return;
  lastDbCountRefreshAt = now;
  dbCountRefreshInflight = dbCounts(pool, gameYear)
    .then(counts => {
      dbCountCache = {
        status: 'OK',
        cards: Number(counts?.cards || 0),
        sales: Number(counts?.sales || 0),
        history: Number(counts?.history || 0),
        updatedAt: new Date().toISOString(),
        error: null
      };
    })
    .catch(error => {
      dbCountCache = {
        ...dbCountCache,
        status: 'ERROR',
        updatedAt: new Date().toISOString(),
        error: String(error?.message || error)
      };
    })
    .finally(() => { dbCountRefreshInflight = null; });
}

export async function futbinBridgeV1066Status({ pool = null, gameYear = '26' } = {}) {
  // Status endpoints must never wait on PostgreSQL. Refresh counts in the background.
  scheduleDbCountRefresh(pool, gameYear);
  return {
    ok: true,
    version: FUTBIN_BRIDGE_VERSION,
    mode: 'FUTGG_PRIMARY_AUTHORIZED_FUTBIN_BRIDGE',
    authorizedFeedConfigured: Boolean(AUTHORIZED_FEED_URL),
    ingestConfigured: Boolean(INGEST_TOKEN),
    directPublicEnabled: DIRECT_PUBLIC_ENABLED,
    directPublicPolicy: DIRECT_PUBLIC_ENABLED ? 'EXPLICITLY_ENABLED' : 'DISABLED_BY_DEFAULT_AFTER_HOSTLESS_403',
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    lastSuccessAt,
    lastFailureAt,
    lastError,
    lastSource,
    counters: { importedCards, importedSales, importedHistory, attachedRows, directAttempts, directSkips },
    db: dbCountCache,
    dbCountsRefreshing: Boolean(dbCountRefreshInflight),
    note: AUTHORIZED_FEED_URL
      ? 'Authorized FUTBIN feed bridge is configured. FUT.GG remains the live primary source.'
      : 'Direct Hostless requests are disabled by default after HTTP 403. Configure FUTBIN_AUTHORIZED_FEED_URL or import authorized/publicly obtained normalized data through the bridge endpoint.'
  };
}

function authorized(req) {
  if (!INGEST_TOKEN) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const token = String(req.headers['x-futbin-bridge-token'] || '').trim();
  return bearer === INGEST_TOKEN || token === INGEST_TOKEN;
}

export function createFutbinBridgeRouterV1066({ pool = null, gameYear = '26' } = {}) {
  const router = express.Router();
  router.get('/status', async (req, res) => {
    try { res.json(await futbinBridgeV1066Status({ pool, gameYear })); }
    catch (error) { res.status(500).json({ ok:false, version:FUTBIN_BRIDGE_VERSION, error:String(error) }); }
  });
  router.post('/refresh', async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ ok:false, error:'FUTBIN_BRIDGE_UNAUTHORIZED' });
    try { res.json(await refreshAuthorizedFutbinBridgeV1066({ pool, gameYear, force:true })); }
    catch (error) { res.status(500).json({ ok:false, error:String(error) }); }
  });
  router.post('/import', async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ ok:false, error:'FUTBIN_BRIDGE_UNAUTHORIZED' });
    try {
      const source = clean(req.body?.source || 'AUTHORIZED_IMPORT').slice(0,120) || 'AUTHORIZED_IMPORT';
      res.json(await ingestFutbinBridgeV1066({ pool, payload:req.body, gameYear:String(req.body?.gameYear || gameYear), source }));
    } catch (error) { res.status(400).json({ ok:false, error:String(error) }); }
  });
  return router;
}
