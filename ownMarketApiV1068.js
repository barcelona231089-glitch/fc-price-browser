import express from "express";

export const OWN_MARKET_API_VERSION = "1.0.0";
const BUILD = "10.68.0";
const SOURCE_NAME = "FC_TRADER_NORMALIZED_MARKET";
const HEARTBEAT_MS = 60 * 60_000;
const MAX_MEMORY_POINTS = 288;

let schemaReady = false;
let schemaPromise = null;
let lastObserveAt = null;
let lastObserveError = null;
let observedRowsTotal = 0;
let persistedRowsTotal = 0;
let lastPersisted = new Map();
const memoryHistory = new Map();

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanText(value, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

function ownActivityScore(row) {
  const c1 = Math.abs(finite(row?.change1m) ?? 0);
  const c5 = Math.abs(finite(row?.change5m) ?? 0);
  const c15 = Math.abs(finite(row?.change15m) ?? 0);
  const c1h = Math.abs(finite(row?.change1h) ?? 0);
  const c24 = Math.abs(finite(row?.change24h) ?? 0);
  const breadth = Math.max(
    finite(row?.ratingMarketRisingPct) ?? 0,
    finite(row?.ratingMarketFallingPct) ?? 0
  );
  const tracked = row?.tracked ? 8 : 0;
  const intensive = row?.intensiveWatch ? 12 : 0;
  const score =
    Math.min(24, c1 * 3) +
    Math.min(24, c5 * 1.5) +
    Math.min(20, c15 * 0.8) +
    Math.min(16, c1h * 0.35) +
    Math.min(8, c24 * 0.08) +
    Math.min(8, breadth * 0.08) +
    tracked +
    intensive;
  return Number(Math.min(100, score).toFixed(2));
}

function normalizeRow(row) {
  return {
    eaId: String(row?.eaId ?? ""),
    name: cleanText(row?.name, 120),
    rating: finite(row?.overall),
    cardType: cleanText(row?.cardType, 80) || null,
    rarity: cleanText(row?.rarityName, 120) || null,
    position: cleanText(row?.position, 30) || null,
    club: cleanText(row?.club, 120) || null,
    nation: cleanText(row?.nation, 120) || null,
    league: cleanText(row?.league, 120) || null,
    price: finite(row?.price),
    change1m: finite(row?.change1m),
    change5m: finite(row?.change5m),
    change15m: finite(row?.change15m),
    change1h: finite(row?.change1h),
    change24h: finite(row?.change24h),
    change7d: finite(row?.change7d),
    change30d: finite(row?.change30d),
    low24h: finite(row?.low24h),
    high24h: finite(row?.high24h),
    ratingMarketTrend: cleanText(row?.ratingMarketTrend, 40) || null,
    ratingMarketRisingPct: finite(row?.ratingMarketRisingPct),
    ratingMarketFallingPct: finite(row?.ratingMarketFallingPct),
    activityScore: ownActivityScore(row),
    tracked: Boolean(row?.tracked),
    intensiveWatch: Boolean(row?.intensiveWatch),
    tradeable: row?.isTradeable == null ? null : Boolean(row.isTradeable),
    inPacks: row?.inPacks == null ? null : Boolean(row.inPacks),
    isSbc: row?.isSbc == null ? null : Boolean(row.isSbc),
    isObjective: row?.isObjective == null ? null : Boolean(row.isObjective),
    isExtinct: row?.isExtinct == null ? null : Boolean(row.isExtinct),
    source: cleanText(row?.dataSource, 80) || "FUT.GG",
    observedAt: new Date().toISOString()
  };
}

async function ensureSchema(pool) {
  if (!pool) return false;
  if (schemaReady) return true;
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fc_own_market_price_history (
        id BIGSERIAL PRIMARY KEY,
        game_year TEXT NOT NULL,
        ea_id TEXT NOT NULL,
        player_name TEXT,
        rating INTEGER,
        card_type TEXT,
        price INTEGER NOT NULL,
        activity_score NUMERIC(7,2),
        source TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fc_own_market_hist_card_time
      ON fc_own_market_price_history (game_year, ea_id, observed_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fc_own_market_hist_time
      ON fc_own_market_price_history (game_year, observed_at DESC)
    `);
    schemaReady = true;
    return true;
  })().catch(error => {
    schemaReady = false;
    lastObserveError = String(error?.message || error);
    return false;
  }).finally(() => {
    schemaPromise = null;
  });
  return schemaPromise;
}

function pushMemory(gameYear, row, atMs) {
  const key = `${gameYear}:${row.eaId}`;
  const arr = memoryHistory.get(key) || [];
  arr.push({
    price: row.price,
    activityScore: row.activityScore,
    observedAt: new Date(atMs).toISOString()
  });
  if (arr.length > MAX_MEMORY_POINTS) arr.splice(0, arr.length - MAX_MEMORY_POINTS);
  memoryHistory.set(key, arr);
}

export async function observeOwnMarketRowsV1068({ rows, pool = null, gameYear = "26" } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  if (!input.length) return { ok: false, reason: "NO_ROWS" };

  const now = Date.now();
  lastObserveAt = new Date(now).toISOString();
  observedRowsTotal += input.length;

  const persist = [];
  for (const raw of input) {
    const row = normalizeRow(raw);
    if (!row.eaId || !Number.isFinite(row.price) || row.price <= 0) continue;
    const key = `${gameYear}:${row.eaId}`;
    const previous = lastPersisted.get(key);
    const changed = !previous || previous.price !== row.price;
    const heartbeat = !previous || now - previous.at >= HEARTBEAT_MS;
    if (!changed && !heartbeat) continue;

    lastPersisted.set(key, { price: row.price, at: now });
    pushMemory(String(gameYear), row, now);
    persist.push(row);
  }

  if (!persist.length) {
    lastObserveError = null;
    return { ok: true, persisted: 0, observed: input.length };
  }

  if (!pool) {
    persistedRowsTotal += persist.length;
    lastObserveError = null;
    return { ok: true, persisted: persist.length, memoryOnly: true };
  }

  const ready = await ensureSchema(pool);
  if (!ready) return { ok: false, persisted: 0, error: lastObserveError };

  try {
    const years = persist.map(() => String(gameYear));
    const ids = persist.map(row => row.eaId);
    const names = persist.map(row => row.name || null);
    const ratings = persist.map(row => asInt(row.rating));
    const types = persist.map(row => row.cardType);
    const prices = persist.map(row => Math.round(row.price));
    const activity = persist.map(row => row.activityScore);
    const sources = persist.map(() => SOURCE_NAME);

    await pool.query(`
      INSERT INTO fc_own_market_price_history
        (game_year, ea_id, player_name, rating, card_type, price, activity_score, source, observed_at)
      SELECT *
      FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::int[],
        $5::text[],
        $6::int[],
        $7::numeric[],
        $8::text[],
        $9::timestamptz[]
      )
    `, [
      years, ids, names, ratings, types, prices, activity, sources,
      persist.map(() => new Date(now).toISOString())
    ]);

    persistedRowsTotal += persist.length;
    lastObserveError = null;
    return { ok: true, persisted: persist.length, observed: input.length };
  } catch (error) {
    lastObserveError = String(error?.message || error);
    return { ok: false, persisted: 0, error: lastObserveError };
  }
}

async function dbHistory(pool, gameYear, eaId, hours, limit) {
  if (!pool) return null;
  const ready = await ensureSchema(pool);
  if (!ready) return null;
  const result = await pool.query(`
    SELECT price, activity_score, source, observed_at
    FROM fc_own_market_price_history
    WHERE game_year = $1
      AND ea_id = $2
      AND observed_at >= NOW() - ($3::int * INTERVAL '1 hour')
    ORDER BY observed_at DESC
    LIMIT $4
  `, [String(gameYear), String(eaId), hours, limit]);
  return result.rows.map(row => ({
    price: Number(row.price),
    activityScore: row.activity_score == null ? null : Number(row.activity_score),
    source: row.source,
    observedAt: row.observed_at
  }));
}

function apiAuth(req, res, next) {
  const required = String(process.env.OWN_MARKET_API_KEY || "").trim();
  if (!required) return next();
  const supplied = String(
    req.get("x-api-key") ||
    String(req.get("authorization") || "").replace(/^Bearer\s+/i, "")
  ).trim();
  if (supplied !== required) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

function sortRows(rows, sort) {
  const copy = [...rows];
  const sorters = {
    price: (a, b) => (b.price ?? 0) - (a.price ?? 0),
    rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    activity: (a, b) => (b.activityScore ?? 0) - (a.activityScore ?? 0),
    move24h: (a, b) => Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0),
    move5m: (a, b) => Math.abs(b.change5m ?? 0) - Math.abs(a.change5m ?? 0)
  };
  copy.sort(sorters[sort] || sorters.activity);
  return copy;
}

function openApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "FC Market API",
      version: OWN_MARKET_API_VERSION,
      description: "Read-only normalized FC market API backed by the Trader Brain live snapshot and its own compressed price history."
    },
    paths: {
      "/api/market/v1/status": { get: { summary: "API and source status" } },
      "/api/market/v1/cards": { get: { summary: "List/search current market cards" } },
      "/api/market/v1/cards/{eaId}": { get: { summary: "Current card snapshot" } },
      "/api/market/v1/cards/{eaId}/history": { get: { summary: "Own compressed price history" } },
      "/api/market/v1/popular": { get: { summary: "Own market-activity ranking, not gameplay usage" } },
      "/api/market/v1/ratings": { get: { summary: "Current rating market intelligence" } },
      "/api/market/v1/market": { get: { summary: "Global market context" } }
    }
  };
}

export function createOwnMarketApiRouterV1068({
  getRows,
  getRatingStats,
  getMarketContext,
  getSourceHealth,
  getLastMonitorAt,
  pool = null,
  gameYear = "26"
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", String(process.env.OWN_MARKET_API_CORS_ORIGIN || "*"));
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    next();
  });
  router.use(apiAuth);

  router.get("/", (req, res) => {
    res.json({
      ok: true,
      service: "FC Market API",
      apiVersion: OWN_MARKET_API_VERSION,
      build: BUILD,
      gameYear: String(gameYear),
      docs: "/api/market/v1/openapi.json"
    });
  });

  router.get("/openapi.json", (req, res) => res.json(openApiSpec()));

  router.get("/status", (req, res) => {
    const rows = Array.isArray(getRows?.()) ? getRows() : [];
    res.json({
      ok: true,
      service: "FC Market API",
      apiVersion: OWN_MARKET_API_VERSION,
      build: BUILD,
      gameYear: String(gameYear),
      liveCards: rows.length,
      liveSource: "Trader Brain normalized snapshot",
      sourceIndependence: false,
      note: "Eigene API + eigene Historie. Der aktuelle Live-Preis stammt weiterhin aus dem vorhandenen Markt-Feed; die API erfindet keine Sales/Games/Gameplay-Popularity.",
      databaseHistory: Boolean(pool),
      lastMonitorAt: getLastMonitorAt?.() || null,
      lastObserveAt,
      lastObserveError,
      observedRowsTotal,
      persistedRowsTotal,
      memoryHistoryCards: memoryHistory.size
    });
  });

  router.get("/cards", (req, res) => {
    const all = (Array.isArray(getRows?.()) ? getRows() : []).map(normalizeRow);
    const minRating = finite(req.query.minRating);
    const maxRating = finite(req.query.maxRating);
    const minPrice = finite(req.query.minPrice);
    const maxPrice = finite(req.query.maxPrice);
    const search = cleanText(req.query.search, 80).toLowerCase();
    const limit = clampInt(req.query.limit, 1, 250, 100);
    const offset = clampInt(req.query.offset, 0, 100000, 0);
    const sort = cleanText(req.query.sort, 20) || "activity";

    let filtered = all.filter(row => {
      if (minRating != null && (row.rating ?? -1) < minRating) return false;
      if (maxRating != null && (row.rating ?? 999) > maxRating) return false;
      if (minPrice != null && (row.price ?? -1) < minPrice) return false;
      if (maxPrice != null && (row.price ?? Infinity) > maxPrice) return false;
      if (search) {
        const hay = `${row.name} ${row.club || ""} ${row.league || ""} ${row.nation || ""} ${row.rarity || ""}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    filtered = sortRows(filtered, sort);
    res.json({
      ok: true,
      gameYear: String(gameYear),
      total: filtered.length,
      limit,
      offset,
      rows: filtered.slice(offset, offset + limit)
    });
  });

  router.get("/cards/:eaId", (req, res) => {
    const eaId = String(req.params.eaId || "");
    const raw = (Array.isArray(getRows?.()) ? getRows() : []).find(row => String(row?.eaId) === eaId);
    if (!raw) return res.status(404).json({ ok: false, error: "CARD_NOT_FOUND", eaId });
    res.json({ ok: true, gameYear: String(gameYear), card: normalizeRow(raw) });
  });

  router.get("/cards/:eaId/history", async (req, res) => {
    const eaId = String(req.params.eaId || "");
    const hours = clampInt(req.query.hours, 1, 24 * 365, 24);
    const limit = clampInt(req.query.limit, 1, 2000, 500);
    try {
      let rows = await dbHistory(pool, gameYear, eaId, hours, limit);
      let source = "PostgreSQL";
      if (rows == null) {
        source = "memory";
        const cutoff = Date.now() - hours * 60 * 60_000;
        rows = (memoryHistory.get(`${gameYear}:${eaId}`) || [])
          .filter(row => new Date(row.observedAt).getTime() >= cutoff)
          .slice(-limit)
          .reverse();
      }
      res.json({ ok: true, gameYear: String(gameYear), eaId, hours, source, rows });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  router.get("/popular", (req, res) => {
    const limit = clampInt(req.query.limit, 1, 250, 100);
    const rows = sortRows((Array.isArray(getRows?.()) ? getRows() : []).map(normalizeRow), "activity")
      .slice(0, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
    res.json({
      ok: true,
      gameYear: String(gameYear),
      ranking: "OWN_MARKET_ACTIVITY",
      gameplayPopularity: false,
      note: "Ranking aus echten beobachteten Marktbewegungen und Marktbreite. Nicht als FUTBIN/FUT.GG Gameplay-Usage ausgeben.",
      rows
    });
  });

  router.get("/ratings", (req, res) => {
    res.json({
      ok: true,
      gameYear: String(gameYear),
      ratings: getRatingStats?.() || {}
    });
  });

  router.get("/market", (req, res) => {
    res.json({
      ok: true,
      gameYear: String(gameYear),
      context: getMarketContext?.() || null,
      sourceHealth: getSourceHealth?.() || null,
      lastMonitorAt: getLastMonitorAt?.() || null
    });
  });

  return router;
}
