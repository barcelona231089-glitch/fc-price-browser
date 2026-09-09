import express from "express";
import crypto from "crypto";

export const MARKET_EVIDENCE_VERSION = "1.0.0";
const BUILD = "10.69.0";

let schemaReady = false;
let schemaPromise = null;
let lastRefreshAt = null;
let lastRefreshSuccessAt = null;
let lastRefreshFailureAt = null;
let lastRefreshError = null;
let lastSource = null;
let cardsLoaded = 0;
let salesLoaded = 0;
let cacheLoadedAt = 0;
const cardCache = new Map();
const salesCache = new Map();

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clean(value, max = 180) {
  return String(value ?? "").trim().slice(0, max);
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeSale(row) {
  if (!row || typeof row !== "object") return null;
  const soldFor = finite(row.sold_for ?? row.soldFor ?? row.sale_price ?? row.salePrice ?? row.price);
  const listedFor = finite(row.listed_for ?? row.listedFor ?? row.list_price ?? row.listPrice);
  const netPrice = finite(row.net_price ?? row.netPrice);
  const eaTax = finite(row.ea_tax ?? row.eaTax ?? row.tax);
  const date = parseDate(row.date ?? row.sold_at ?? row.soldAt ?? row.time ?? row.timestamp);
  if (!Number.isFinite(soldFor) || soldFor <= 0) return null;
  return {
    date,
    listedFor: Number.isFinite(listedFor) ? Math.round(listedFor) : null,
    soldFor: Math.round(soldFor),
    eaTax: Number.isFinite(eaTax) ? Math.round(eaTax) : null,
    netPrice: Number.isFinite(netPrice) ? Math.round(netPrice) : null,
    status: clean(row.status ?? row.state ?? "SOLD", 40) || "SOLD"
  };
}

function normalizeCard(row) {
  if (!row || typeof row !== "object") return null;
  const eaId = clean(row.ea_id ?? row.eaId ?? row.resource_id ?? row.resourceId ?? row.id, 80);
  if (!eaId) return null;

  const games = finite(row.games ?? row.games_total ?? row.total_games);
  const gamesConsole = finite(row.games_console ?? row.console_games ?? row.games_ps ?? row.ps_games);
  const gamesPc = finite(row.games_pc ?? row.pc_games);
  const popularRank = finite(row.popular_rank ?? row.popularRank ?? row.popularity_rank ?? row.rank);
  const popularityCount = finite(row.popularity_count ?? row.popularityCount ?? row.popular_count);
  const sales = (Array.isArray(row.sales_history) ? row.sales_history :
    Array.isArray(row.salesHistory) ? row.salesHistory :
    Array.isArray(row.sales) ? row.sales : [])
    .map(normalizeSale).filter(Boolean);

  const observedAt = parseDate(row.observed_at ?? row.observedAt ?? row.updated_at ?? row.updatedAt) || new Date().toISOString();

  return {
    eaId,
    name: clean(row.name ?? row.player_name ?? row.playerName, 120) || null,
    rating: finite(row.rating ?? row.overall),
    version: clean(row.version ?? row.rarity ?? row.card_type ?? row.cardType, 120) || null,
    games: Number.isFinite(games) ? Math.round(games) : null,
    gamesConsole: Number.isFinite(gamesConsole) ? Math.round(gamesConsole) : null,
    gamesPc: Number.isFinite(gamesPc) ? Math.round(gamesPc) : null,
    popularRank: Number.isFinite(popularRank) ? Math.round(popularRank) : null,
    popularityCount: Number.isFinite(popularityCount) ? Math.round(popularityCount) : null,
    sales,
    source: clean(row.source ?? "NORMALIZED_EVIDENCE_FEED", 80),
    sourceUrl: clean(row.source_url ?? row.sourceUrl, 500) || null,
    observedAt
  };
}

function extractCards(payload) {
  const root = payload?.data ?? payload ?? {};
  const candidates = [
    root.cards, root.players, root.items, root.results,
    payload?.cards, payload?.players, payload?.items, payload?.results,
    Array.isArray(root) ? root : null,
    Array.isArray(payload) ? payload : null
  ];
  return (candidates.find(Array.isArray) || []).map(normalizeCard).filter(Boolean);
}

async function ensureSchema(pool) {
  if (!pool) return false;
  if (schemaReady) return true;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fc_market_evidence_cards (
        game_year TEXT NOT NULL,
        ea_id TEXT NOT NULL,
        player_name TEXT,
        rating INTEGER,
        version TEXT,
        games BIGINT,
        games_console BIGINT,
        games_pc BIGINT,
        popular_rank INTEGER,
        popularity_count BIGINT,
        source TEXT NOT NULL,
        source_url TEXT,
        observed_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (game_year, ea_id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fc_market_evidence_sales (
        game_year TEXT NOT NULL,
        ea_id TEXT NOT NULL,
        sale_key TEXT NOT NULL,
        sold_at TIMESTAMPTZ,
        listed_for INTEGER,
        sold_for INTEGER NOT NULL,
        ea_tax INTEGER,
        net_price INTEGER,
        status TEXT,
        source TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (game_year, ea_id, sale_key)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fc_market_evidence_sales_card_time
      ON fc_market_evidence_sales (game_year, ea_id, sold_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fc_market_evidence_popular
      ON fc_market_evidence_cards (game_year, popular_rank ASC)
      WHERE popular_rank IS NOT NULL
    `);
    schemaReady = true;
    return true;
  })().catch(error => {
    schemaReady = false;
    lastRefreshError = String(error?.message || error);
    return false;
  }).finally(() => { schemaPromise = null; });

  return schemaPromise;
}

function saleKey(eaId, sale) {
  return crypto.createHash("sha256").update(JSON.stringify([
    eaId, sale.date, sale.listedFor, sale.soldFor, sale.eaTax, sale.netPrice, sale.status
  ])).digest("hex").slice(0, 32);
}

async function upsertCards(pool, cards, gameYear) {
  if (!pool || !cards.length) return { cards: 0, sales: 0 };
  const ready = await ensureSchema(pool);
  if (!ready) throw new Error(lastRefreshError || "EVIDENCE_SCHEMA_NOT_READY");

  let cardCount = 0;
  let saleCount = 0;

  for (const card of cards) {
    await pool.query(`
      INSERT INTO fc_market_evidence_cards (
        game_year, ea_id, player_name, rating, version,
        games, games_console, games_pc, popular_rank, popularity_count,
        source, source_url, observed_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (game_year, ea_id) DO UPDATE SET
        player_name = COALESCE(EXCLUDED.player_name, fc_market_evidence_cards.player_name),
        rating = COALESCE(EXCLUDED.rating, fc_market_evidence_cards.rating),
        version = COALESCE(EXCLUDED.version, fc_market_evidence_cards.version),
        games = COALESCE(EXCLUDED.games, fc_market_evidence_cards.games),
        games_console = COALESCE(EXCLUDED.games_console, fc_market_evidence_cards.games_console),
        games_pc = COALESCE(EXCLUDED.games_pc, fc_market_evidence_cards.games_pc),
        popular_rank = COALESCE(EXCLUDED.popular_rank, fc_market_evidence_cards.popular_rank),
        popularity_count = COALESCE(EXCLUDED.popularity_count, fc_market_evidence_cards.popularity_count),
        source = EXCLUDED.source,
        source_url = COALESCE(EXCLUDED.source_url, fc_market_evidence_cards.source_url),
        observed_at = GREATEST(fc_market_evidence_cards.observed_at, EXCLUDED.observed_at),
        updated_at = NOW()
    `, [
      String(gameYear), card.eaId, card.name, Number.isFinite(card.rating) ? Math.round(card.rating) : null,
      card.version, card.games, card.gamesConsole, card.gamesPc, card.popularRank, card.popularityCount,
      card.source, card.sourceUrl, card.observedAt
    ]);
    cardCount += 1;

    for (const sale of card.sales) {
      const key = saleKey(card.eaId, sale);
      const result = await pool.query(`
        INSERT INTO fc_market_evidence_sales (
          game_year, ea_id, sale_key, sold_at, listed_for, sold_for,
          ea_tax, net_price, status, source, observed_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (game_year, ea_id, sale_key) DO NOTHING
      `, [
        String(gameYear), card.eaId, key, sale.date, sale.listedFor, sale.soldFor,
        sale.eaTax, sale.netPrice, sale.status, card.source, card.observedAt
      ]);
      saleCount += Number(result.rowCount || 0);
    }
  }

  return { cards: cardCount, sales: saleCount };
}

async function rebuildCache(pool, gameYear) {
  if (!pool) return;
  const ready = await ensureSchema(pool);
  if (!ready) return;

  const cards = await pool.query(`
    SELECT game_year, ea_id, player_name, rating, version, games, games_console,
           games_pc, popular_rank, popularity_count, source, source_url, observed_at
    FROM fc_market_evidence_cards
    WHERE game_year = $1
  `, [String(gameYear)]);

  cardCache.clear();
  for (const row of cards.rows) {
    cardCache.set(String(row.ea_id), {
      eaId: String(row.ea_id),
      name: row.player_name,
      rating: row.rating == null ? null : Number(row.rating),
      version: row.version,
      games: row.games == null ? null : Number(row.games),
      gamesConsole: row.games_console == null ? null : Number(row.games_console),
      gamesPc: row.games_pc == null ? null : Number(row.games_pc),
      popularRank: row.popular_rank == null ? null : Number(row.popular_rank),
      popularityCount: row.popularity_count == null ? null : Number(row.popularity_count),
      source: row.source,
      sourceUrl: row.source_url,
      observedAt: row.observed_at
    });
  }

  cacheLoadedAt = Date.now();
}

async function salesFor(pool, gameYear, eaId, limit = 50) {
  if (!pool) return salesCache.get(String(eaId)) || [];
  const ready = await ensureSchema(pool);
  if (!ready) return [];
  const result = await pool.query(`
    SELECT sold_at, listed_for, sold_for, ea_tax, net_price, status, source, observed_at
    FROM fc_market_evidence_sales
    WHERE game_year = $1 AND ea_id = $2
    ORDER BY COALESCE(sold_at, observed_at) DESC
    LIMIT $3
  `, [String(gameYear), String(eaId), Math.max(1, Math.min(500, Number(limit || 50)))]);
  return result.rows.map(row => ({
    date: row.sold_at,
    listedFor: row.listed_for == null ? null : Number(row.listed_for),
    soldFor: Number(row.sold_for),
    eaTax: row.ea_tax == null ? null : Number(row.ea_tax),
    netPrice: row.net_price == null ? null : Number(row.net_price),
    status: row.status,
    source: row.source,
    observedAt: row.observed_at
  }));
}

function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function salesStats(sales) {
  const sold = (Array.isArray(sales) ? sales : []).filter(s => Number.isFinite(Number(s.soldFor)));
  const now = Date.now();
  const last24h = sold.filter(s => {
    const t = s.date ? new Date(s.date).getTime() : NaN;
    return Number.isFinite(t) && now - t >= 0 && now - t <= 24 * 60 * 60_000;
  });
  return {
    samples: sold.length,
    observedSales24h: last24h.length || null,
    medianSold: median(sold.map(s => Number(s.soldFor))),
    minSold: sold.length ? Math.min(...sold.map(s => Number(s.soldFor))) : null,
    maxSold: sold.length ? Math.max(...sold.map(s => Number(s.soldFor))) : null,
    lastSaleAt: sold.find(s => s.date)?.date || null
  };
}

async function fetchFeed(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const headers = {
      accept: "application/json",
      "user-agent": "FC-Trader-Brain-Market-Evidence/10.69.0"
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`MARKET_EVIDENCE_FEED_HTTP_${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshMarketEvidenceV1069({ pool = null, gameYear = "26", force = false } = {}) {
  const url = clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000);
  const token = clean(process.env.MARKET_EVIDENCE_FEED_TOKEN, 1000);
  const refreshMs = Math.max(5, Number(process.env.MARKET_EVIDENCE_REFRESH_MIN || 15)) * 60_000;

  if (!pool) return { ok: false, status: "NO_DATABASE" };
  await ensureSchema(pool);
  if (!force && lastRefreshAt && Date.now() - new Date(lastRefreshAt).getTime() < refreshMs) {
    return { ok: true, status: "CACHED", cards: cardCache.size };
  }

  lastRefreshAt = new Date().toISOString();

  if (!url) {
    await rebuildCache(pool, gameYear);
    lastRefreshError = null;
    return {
      ok: true,
      status: cardCache.size ? "DATABASE_ONLY" : "WAITING_FOR_EVIDENCE_SOURCE",
      cards: cardCache.size
    };
  }

  try {
    const payload = await fetchFeed(url, token);
    const cards = extractCards(payload);
    if (!cards.length) throw new Error("MARKET_EVIDENCE_FEED_EMPTY");
    const saved = await upsertCards(pool, cards, gameYear);
    await rebuildCache(pool, gameYear);
    lastRefreshSuccessAt = new Date().toISOString();
    lastRefreshError = null;
    lastSource = url;
    cardsLoaded += saved.cards;
    salesLoaded += saved.sales;
    return { ok: true, status: "READY", ...saved };
  } catch (error) {
    lastRefreshFailureAt = new Date().toISOString();
    lastRefreshError = String(error?.message || error);
    await rebuildCache(pool, gameYear);
    return { ok: false, status: "ERROR", error: lastRefreshError, cachedCards: cardCache.size };
  }
}

export async function ingestMarketEvidenceV1069({ pool = null, gameYear = "26", payload } = {}) {
  if (!pool) throw new Error("NO_DATABASE");
  const cards = extractCards(payload);
  if (!cards.length) throw new Error("NO_VALID_EVIDENCE_CARDS");
  const saved = await upsertCards(pool, cards, gameYear);
  await rebuildCache(pool, gameYear);
  lastRefreshSuccessAt = new Date().toISOString();
  lastRefreshError = null;
  lastSource = "INGEST";
  cardsLoaded += saved.cards;
  salesLoaded += saved.sales;
  return saved;
}

export async function attachMarketEvidenceToRowsV1069({
  rows, brainWork, pool = null, gameYear = "26"
} = {}) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);
  let attached = 0;

  for (const row of rows) {
    const ev = cardCache.get(String(row?.eaId));
    if (!ev) continue;
    const sales = await salesFor(pool, gameYear, row.eaId, 60);
    const stats = salesStats(sales);

    row.marketEvidence = {
      ...ev,
      salesHistory: sales,
      salesStats: stats
    };
    row.evidenceGames = ev.games ?? ev.gamesConsole ?? null;
    row.evidenceGamesConsole = ev.gamesConsole ?? null;
    row.evidenceGamesPc = ev.gamesPc ?? null;
    row.evidencePopularRank = ev.popularRank ?? null;
    row.evidencePopularityCount = ev.popularityCount ?? null;
    row.evidenceSalesHistory = sales;
    row.evidenceObservedSales24h = stats.observedSales24h;
    row.evidenceMedianSold = stats.medianSold;

    const work = brainWork?.get?.(String(row.eaId));
    if (work?.input) {
      work.input.marketEvidence = {
        source: ev.source,
        observedAt: ev.observedAt,
        games: row.evidenceGames,
        gamesConsole: row.evidenceGamesConsole,
        gamesPc: row.evidenceGamesPc,
        popularRank: row.evidencePopularRank,
        popularityCount: row.evidencePopularityCount,
        observedSales24h: row.evidenceObservedSales24h,
        medianSold: row.evidenceMedianSold,
        salesSamples: stats.samples,
        salesHistory: sales.slice(0, 25)
      };
    }
    attached += 1;
  }
  return attached;
}

function statusPayload() {
  const withGames = [...cardCache.values()].filter(x => Number.isFinite(x.games) || Number.isFinite(x.gamesConsole) || Number.isFinite(x.gamesPc)).length;
  const withPopular = [...cardCache.values()].filter(x => Number.isFinite(x.popularRank)).length;
  return {
    ok: true,
    service: "FC Market Evidence API",
    apiVersion: MARKET_EVIDENCE_VERSION,
    build: BUILD,
    purpose: "FUT.GG supplement",
    replacesFutgg: false,
    fields: {
      games: true,
      salesHistory: true,
      popularRank: true,
      liquidityFromSales: true
    },
    sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)),
    ingestConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_INGEST_TOKEN, 1000)),
    cachedCards: cardCache.size,
    cardsWithGames: withGames,
    cardsWithPopularRank: withPopular,
    lastRefreshAt,
    lastRefreshSuccessAt,
    lastRefreshFailureAt,
    lastRefreshError,
    lastSource,
    cardsLoaded,
    salesLoaded,
    note: "Echte Games/Sales/Popular-Werte werden nur gespeichert, wenn eine erlaubte Quelle sie liefert. Fehlende Werte bleiben null; keine Daten werden erfunden."
  };
}

function requireIngestToken(req, res, next) {
  const required = clean(process.env.MARKET_EVIDENCE_INGEST_TOKEN, 1000);
  if (!required) return res.status(503).json({ ok: false, error: "INGEST_NOT_CONFIGURED" });
  const supplied = clean(
    req.get("x-ingest-token") ||
    String(req.get("authorization") || "").replace(/^Bearer\s+/i, ""),
    1000
  );
  if (supplied !== required) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  next();
}

export function createMarketEvidenceRouterV1069({ pool = null, gameYear = "26" } = {}) {
  const router = express.Router();

  router.get("/status", async (req, res) => {
    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);
    res.json(statusPayload());
  });

  router.get("/cards/:eaId", async (req, res) => {
    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);
    const eaId = String(req.params.eaId || "");
    const card = cardCache.get(eaId);
    if (!card) return res.status(404).json({ ok: false, error: "NO_EVIDENCE", eaId });
    const sales = await salesFor(pool, gameYear, eaId, 100);
    res.json({ ok: true, gameYear: String(gameYear), card: { ...card, salesStats: salesStats(sales), salesHistory: sales } });
  });

  router.get("/cards/:eaId/games", async (req, res) => {
    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);
    const card = cardCache.get(String(req.params.eaId || ""));
    if (!card) return res.status(404).json({ ok: false, error: "NO_EVIDENCE" });
    res.json({
      ok: true,
      eaId: card.eaId,
      games: card.games,
      gamesConsole: card.gamesConsole,
      gamesPc: card.gamesPc,
      source: card.source,
      observedAt: card.observedAt
    });
  });

  router.get("/cards/:eaId/sales", async (req, res) => {
    const eaId = String(req.params.eaId || "");
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const sales = await salesFor(pool, gameYear, eaId, limit);
    res.json({ ok: true, eaId, stats: salesStats(sales), rows: sales });
  });

  router.get("/popular", async (req, res) => {
    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);
    const limit = Math.max(1, Math.min(250, Number(req.query.limit || 100)));
    const rows = [...cardCache.values()]
      .filter(row => Number.isFinite(row.popularRank))
      .sort((a, b) => a.popularRank - b.popularRank)
      .slice(0, limit);
    res.json({
      ok: true,
      gameYear: String(gameYear),
      ranking: "SOURCE_POPULAR_RANK",
      synthetic: false,
      rows
    });
  });

  router.post("/ingest", requireIngestToken, async (req, res) => {
    try {
      const saved = await ingestMarketEvidenceV1069({ pool, gameYear, payload: req.body });
      res.json({ ok: true, ...saved });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  router.post("/refresh", requireIngestToken, async (req, res) => {
    const result = await refreshMarketEvidenceV1069({ pool, gameYear, force: true });
    res.status(result.ok ? 200 : 502).json(result);
  });

  return router;
}
