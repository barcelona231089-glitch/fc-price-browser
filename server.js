import express from "express";
import pg from "pg";
import {
  analyzeMarketPatterns,
  evaluateDiscordSignals,
  shouldUseGemini,
  generateAiTraderDecision,
  getGeminiQuotaInfo,
  checkGeminiHealth,
  evaluateTrackedDecision
} from "./traderBrain.js";

const { Pool } = pg;

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

const RATING_MIN = 75;
const RATING_MAX = 99;

const PRICE_REFRESH_MS = 60_000;
const META_REFRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGES = 60;
const META_CONCURRENCY = 3;

const cardCache = new Map();
const cardInflight = new Map();

let universe = [];
let universeBuiltAt = 0;

let bulkPriceCache = null;
let bulkPriceInflight = null;

let monitoringStarted = false;
let monitoringBusy = false;
let lastMonitorAt = null;
let lastMonitorError = null;
let latestTradingRows = [];
let latestRatingStats = {};
let lastBrainRunAt = null;
let lastBrainError = null;
let lastGeminiCandidate = null;
let lastGeminiAttemptAt = 0;
let lastEvaluationSweepAt = 0;
const lastGeminiByCard = new Map();

const GEMINI_MIN_INTERVAL_MS = Math.max(5, Number(process.env.GEMINI_MIN_INTERVAL_MIN || 30)) * 60_000;
const GEMINI_CARD_COOLDOWN_MS = Math.max(30, Number(process.env.GEMINI_CARD_COOLDOWN_MIN || 120)) * 60_000;

const memoryHistory = new Map();
const lastMemoryPrice = new Map();
const memoryPositions = new Map();

const dbEnabled = Boolean(process.env.DATABASE_URL);

const pool = dbEnabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 4
    })
  : null;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      const error = new Error(`${url} -> HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;

      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        results[i] = { ok: false, error: String(error), input: items[i] };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function classifyCard(card) {
  const rarity = String(card.rarityName || "").toLowerCase();
  const group = String(card.rarityGroupName || "").toLowerCase();

  if (rarity === "rare" || group === "rare") return "Base Rare";

  if (
    rarity.includes("common") ||
    group.includes("common") ||
    rarity === "non-rare"
  ) {
    return "Base Common";
  }

  return "Special";
}

async function collectAllCardsForRating(rating, force = false) {
  const cached = cardCache.get(rating);

  if (
    !force &&
    cached &&
    Date.now() - cached.savedAt < META_REFRESH_MS
  ) {
    return cached.data;
  }

  if (cardInflight.has(rating)) {
    return cardInflight.get(rating);
  }

  const promise = (async () => {
    const cards = [];
    const seen = new Set();
    let pagesRead = 0;

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const pagePart = pageNumber === 1 ? "" : `&page=${pageNumber}`;

      const url =
        `https://www.fut.gg/api/fut/players/v2/26/` +
        `?overall__gte=${rating}&overall__lte=${rating}` +
        `&sorts=current_price${pagePart}`;

      let json;

      try {
        json = await fetchJson(url);
      } catch (error) {
        if (pageNumber > 1 && error?.status === 404) break;
        throw error;
      }

      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) break;

      let added = 0;

      for (const p of rows) {
        const key = p.eaId ?? p.id ?? p.url;

        if (key == null || seen.has(String(key))) continue;

        seen.add(String(key));
        added++;

        const card = {
          id: Number.isFinite(p.id) ? p.id : null,
          eaId: Number.isFinite(p.eaId) ? p.eaId : null,
          overall: Number.isFinite(p.overall) ? p.overall : rating,
          name:
            p.commonName ||
            p.cardName ||
            [p.firstName, p.lastName].filter(Boolean).join(" ") ||
            null,
          cardName: p.cardName ?? null,
          rarityName: p.rarityName ?? null,
          rarityGroupName: p.rarityGroupName ?? null,
          position: p.position ?? null,
          club: p.club?.name ?? p.uniqueClub?.name ?? null,
          nation: p.nation?.name ?? null,
          league: p.league?.name ?? null,
          url: p.url ? new URL(p.url, "https://www.fut.gg").href : null,
          slug: p.slug ?? null
        };

        card.cardType = classifyCard(card);
        cards.push(card);
      }

      pagesRead++;

      if (added === 0) break;
    }

    const data = {
      rating,
      pagesRead,
      cards
    };

    cardCache.set(rating, {
      savedAt: Date.now(),
      data
    });

    return data;
  })();

  cardInflight.set(rating, promise);

  try {
    return await promise;
  } finally {
    cardInflight.delete(rating);
  }
}

async function ensureUniverse(force = false) {
  if (
    !force &&
    universe.length &&
    Date.now() - universeBuiltAt < META_REFRESH_MS
  ) {
    return universe;
  }

  const ratings = [];
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating++) {
    ratings.push(rating);
  }

  const results = await mapLimit(
    ratings,
    META_CONCURRENCY,
    rating => collectAllCardsForRating(rating, force)
  );

  const all = [];

  for (const result of results) {
    if (result?.cards) all.push(...result.cards);
  }

  const deduped = [];
  const seen = new Set();

  for (const card of all) {
    if (!Number.isFinite(card.eaId)) continue;

    const key = String(card.eaId);

    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(card);
  }

  universe = deduped;
  universeBuiltAt = Date.now();

  return universe;
}

function buildIds(priceData) {
  if (!Number.isFinite(priceData?.id0) || !Array.isArray(priceData?.d)) {
    throw new Error("Unexpected FUT.GG PS5 bulk-price format");
  }

  const ids = [priceData.id0];
  let current = priceData.id0;

  for (const delta of priceData.d) {
    if (!Number.isFinite(delta)) continue;
    current += delta;
    ids.push(current);
  }

  return ids;
}

async function loadBulkPs5Prices(force = false) {
  if (
    !force &&
    bulkPriceCache &&
    Date.now() - bulkPriceCache.savedAt < PRICE_REFRESH_MS
  ) {
    return bulkPriceCache;
  }

  if (bulkPriceInflight) {
    return bulkPriceInflight;
  }

  bulkPriceInflight = (async () => {
    const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");
    const hash = manifest["player-prices-ps5"];

    if (!hash) {
      throw new Error("player-prices-ps5 missing from FUT.GG manifest");
    }

    const url =
      `https://r2.fut.gg/26/player-prices-ps5.v1.${hash}.json`;

    const data = await fetchJson(url);

    if (!Array.isArray(data?.p)) {
      throw new Error("FUT.GG PS5 bulk-price array missing");
    }

    const ids = buildIds(data);

    if (ids.length !== data.p.length) {
      throw new Error(
        `Price mapping length mismatch: ids=${ids.length}, prices=${data.p.length}`
      );
    }

    const map = new Map();

    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], {
        price:
          Number.isFinite(data.p[i]) && data.p[i] > 0
            ? data.p[i]
            : null,
        statusCode:
          Array.isArray(data.s)
            ? data.s[i] ?? null
            : null
      });
    }

    bulkPriceCache = {
      savedAt: Date.now(),
      map,
      totalValues: data.p.length,
      sourceUrl: url
    };

    return bulkPriceCache;
  })();

  try {
    return await bulkPriceInflight;
  } finally {
    bulkPriceInflight = null;
  }
}

function currentPricedCards(cards, bulk) {
  const rows = [];

  for (const card of cards) {
    const priceRow = bulk.map.get(card.eaId);

    if (!priceRow || !Number.isFinite(priceRow.price)) continue;

    rows.push({
      ...card,
      price: priceRow.price,
      priceStatusCode: priceRow.statusCode
    });
  }

  return rows;
}

async function initDb() {
  if (!dbEnabled) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_price_history (
      ea_id BIGINT NOT NULL,
      price INTEGER NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_price_history_ea_time
    ON fc_price_history (ea_id, recorded_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_price_state (
      ea_id BIGINT PRIMARY KEY,
      price INTEGER NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_positions (
      ea_id BIGINT PRIMARY KEY,
      buy_price INTEGER NOT NULL CHECK (buy_price > 0),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_brain_decisions (
      id VARCHAR(120) PRIMARY KEY,
      ea_id BIGINT NOT NULL,
      player_name VARCHAR(180) NOT NULL,
      rating SMALLINT NOT NULL,
      card_type VARCHAR(100) NOT NULL,
      initial_price INTEGER NOT NULL,
      action VARCHAR(50) NOT NULL,
      confidence SMALLINT NOT NULL CHECK (confidence >= 0 AND confidence <= 95),
      reason TEXT NOT NULL,
      risk VARCHAR(30) NOT NULL,
      market_state VARCHAR(160) NOT NULL,
      ea_tax_break_even INTEGER,
      ai_model_used VARCHAR(120),
      input_snapshot JSONB NOT NULL,
      decision_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_brain_decisions_ea_time
    ON fc_trader_brain_decisions (ea_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_brain_decisions_action_time
    ON fc_trader_brain_decisions (action, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_decision_evaluations (
      decision_id VARCHAR(120) PRIMARY KEY REFERENCES fc_trader_brain_decisions(id) ON DELETE CASCADE,
      price_after_5m INTEGER,
      price_after_15m INTEGER,
      price_after_1h INTEGER,
      price_after_6h INTEGER,
      price_after_24h INTEGER,
      roi_5m NUMERIC(8,2),
      roi_15m NUMERIC(8,2),
      roi_1h NUMERIC(8,2),
      roi_6h NUMERIC(8,2),
      roi_24h NUMERIC(8,2),
      max_roi NUMERIC(8,2),
      was_correct BOOLEAN,
      outcome_score SMALLINT,
      notes TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_discord_signals (
      id VARCHAR(120) PRIMARY KEY,
      source VARCHAR(120) NOT NULL,
      message TEXT NOT NULL,
      player_or_rating VARCHAR(140) NOT NULL,
      call VARCHAR(20) NOT NULL,
      reason TEXT,
      expected_timeframe VARCHAR(120),
      source_reliability SMALLINT DEFAULT 50,
      category VARCHAR(50),
      market_confirmed BOOLEAN DEFAULT FALSE,
      confirmation_details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_profiles (
      id VARCHAR(120) PRIMARY KEY,
      source VARCHAR(120) UNIQUE NOT NULL,
      display_name VARCHAR(180) NOT NULL,
      overall_accuracy NUMERIC(5,2) DEFAULT 50.00,
      total_signals INTEGER DEFAULT 0,
      accuracy_sbc_fodder NUMERIC(5,2) DEFAULT 50.00,
      accuracy_promo_cards NUMERIC(5,2) DEFAULT 50.00,
      accuracy_short_flips NUMERIC(5,2) DEFAULT 50.00,
      accuracy_leaks NUMERIC(5,2) DEFAULT 50.00,
      reputation_badge VARCHAR(50) DEFAULT 'Unbewiesen',
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function recordMemory(rows, at) {
  const cutoff = at - 31 * 24 * 60 * 60_000;

  for (const row of rows) {
    const oldPrice = lastMemoryPrice.get(row.eaId);

    if (oldPrice !== row.price) {
      const list = memoryHistory.get(row.eaId) || [];
      list.push({ t: at, price: row.price });

      while (list.length && list[0].t < cutoff) {
        list.shift();
      }

      memoryHistory.set(row.eaId, list);
      lastMemoryPrice.set(row.eaId, row.price);
    }
  }
}

async function recordDb(rows, at) {
  if (!dbEnabled || !rows.length) return;

  const ids = rows.map(row => String(row.eaId));
  const prices = rows.map(row => row.price);

  const previous = await pool.query(
    `
      SELECT ea_id::text AS ea_id, price
      FROM fc_price_state
      WHERE ea_id = ANY($1::bigint[])
    `,
    [ids]
  );

  const old = new Map(
    previous.rows.map(row => [
      row.ea_id,
      Number(row.price)
    ])
  );

  const changedIds = [];
  const changedPrices = [];

  for (let i = 0; i < ids.length; i++) {
    if (old.get(ids[i]) !== prices[i]) {
      changedIds.push(ids[i]);
      changedPrices.push(prices[i]);
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (changedIds.length) {
      await client.query(
        `
          INSERT INTO fc_price_history (ea_id, price, recorded_at)
          SELECT *
          FROM UNNEST(
            $1::bigint[],
            $2::int[],
            $3::timestamptz[]
          )
        `,
        [
          changedIds,
          changedPrices,
          changedIds.map(() => new Date(at).toISOString())
        ]
      );
    }

    await client.query(
      `
        INSERT INTO fc_price_state (ea_id, price, recorded_at)
        SELECT *
        FROM UNNEST(
          $1::bigint[],
          $2::int[],
          $3::timestamptz[]
        )
        ON CONFLICT (ea_id)
        DO UPDATE
        SET
          price = EXCLUDED.price,
          recorded_at = EXCLUDED.recorded_at
      `,
      [
        ids,
        prices,
        ids.map(() => new Date(at).toISOString())
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function monitorOnce() {
  if (monitoringBusy) return;

  monitoringBusy = true;

  try {
    const [cards, bulk] = await Promise.all([
      ensureUniverse(false),
      loadBulkPs5Prices(true)
    ]);

    const currentRows = currentPricedCards(cards, bulk);
    const at = Date.now();

    recordMemory(currentRows, at);

    if (dbEnabled) {
      await recordDb(currentRows, at);
    }

    const built = await buildTradingRows();
    latestTradingRows = built.rows;
    latestRatingStats = built.ratingStats;

    await automaticTraderBrain(latestTradingRows, built.brainWork);
    await evaluatePendingDecisions();

    lastMonitorAt = new Date(at).toISOString();
    lastMonitorError = null;
  } catch (error) {
    lastMonitorError = String(error);
    console.error("monitor error:", error);
  } finally {
    monitoringBusy = false;
  }
}

function lookupMemory(eaId, threshold) {
  const list = memoryHistory.get(eaId) || [];
  let result = null;

  for (const point of list) {
    if (point.t <= threshold) {
      result = point;
    } else {
      break;
    }
  }

  return result?.price ?? null;
}

function rangeMemory(eaId, start) {
  const list = memoryHistory.get(eaId) || [];
  const values = list
    .filter(point => point.t >= start)
    .map(point => point.price);

  if (!values.length) {
    return {
      low: null,
      high: null
    };
  }

  return {
    low: Math.min(...values),
    high: Math.max(...values)
  };
}

async function lookupDb(ids, threshold) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `
      SELECT DISTINCT ON (ea_id)
        ea_id::text AS ea_id,
        price
      FROM fc_price_history
      WHERE ea_id = ANY($1::bigint[])
        AND recorded_at <= $2
      ORDER BY ea_id, recorded_at DESC
    `,
    [
      ids.map(String),
      new Date(threshold).toISOString()
    ]
  );

  return new Map(
    result.rows.map(row => [
      row.ea_id,
      Number(row.price)
    ])
  );
}

async function rangeDb(ids, start) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `
      SELECT
        ea_id::text AS ea_id,
        MIN(price)::int AS low,
        MAX(price)::int AS high
      FROM fc_price_history
      WHERE ea_id = ANY($1::bigint[])
        AND recorded_at >= $2
      GROUP BY ea_id
    `,
    [
      ids.map(String),
      new Date(start).toISOString()
    ]
  );

  return new Map(
    result.rows.map(row => [
      row.ea_id,
      {
        low: Number(row.low),
        high: Number(row.high)
      }
    ])
  );
}

async function getPositions() {
  if (dbEnabled) {
    const result = await pool.query(`
      SELECT
        ea_id::text AS ea_id,
        buy_price,
        quantity,
        note,
        created_at,
        updated_at
      FROM fc_positions
    `);

    return new Map(
      result.rows.map(row => [
        row.ea_id,
        {
          buyPrice: Number(row.buy_price),
          quantity: Number(row.quantity),
          note: row.note ?? "",
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      ])
    );
  }

  return new Map(
    [...memoryPositions.entries()].map(([eaId, value]) => [
      String(eaId),
      value
    ])
  );
}

async function savePosition(eaId, buyPrice, quantity = 1, note = "") {
  if (dbEnabled) {
    await pool.query(
      `
        INSERT INTO fc_positions (
          ea_id,
          buy_price,
          quantity,
          note,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (ea_id)
        DO UPDATE
        SET
          buy_price = EXCLUDED.buy_price,
          quantity = EXCLUDED.quantity,
          note = EXCLUDED.note,
          updated_at = NOW()
      `,
      [
        String(eaId),
        buyPrice,
        quantity,
        note
      ]
    );

    return;
  }

  memoryPositions.set(String(eaId), {
    buyPrice,
    quantity,
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function deletePosition(eaId) {
  if (dbEnabled) {
    await pool.query(
      `
        DELETE FROM fc_positions
        WHERE ea_id = $1
      `,
      [String(eaId)]
    );

    return;
  }

  memoryPositions.delete(String(eaId));
}

function changePct(current, old) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(old) ||
    old <= 0
  ) {
    return null;
  }

  return Number(
    (((current - old) / old) * 100).toFixed(2)
  );
}

function distancePct(current, target) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(target) ||
    target <= 0
  ) {
    return null;
  }

  return Number(
    (((current - target) / target) * 100).toFixed(2)
  );
}

function signalFor(row) {
  const nearLow =
    Number.isFinite(row.low24h) &&
    row.low24h > 0 &&
    row.price <= row.low24h * 1.035;

  const nearHigh =
    Number.isFinite(row.high24h) &&
    row.high24h > 0 &&
    row.price >= row.high24h * 0.97;

  const drop24 =
    Number.isFinite(row.change24h) &&
    row.change24h <= -5;

  const drop7d =
    Number.isFinite(row.change7d) &&
    row.change7d <= -8;

  const recover1h =
    Number.isFinite(row.change1h) &&
    row.change1h >= 1;

  const rising24 =
    Number.isFinite(row.change24h) &&
    row.change24h >= 5;

  const falling1h =
    Number.isFinite(row.change1h) &&
    row.change1h <= -2;

  let score = 0;
  let signal = "HALTEN";

  if (nearLow) score += 28;
  if (drop24) score += 24;
  if (drop7d) score += 18;
  if (recover1h) score += 24;
  if (falling1h) score -= 18;

  if (nearLow && (drop24 || drop7d) && recover1h) {
    signal = "KAUFEN";
    score += 25;
  } else if (nearLow && (drop24 || drop7d)) {
    signal = "BEOBACHTEN";
    score += 12;
  } else if (nearHigh && rising24) {
    signal = "VERKAUF PRÜFEN";
    score += 16;
  } else if (recover1h && drop24) {
    signal = "ERHOLUNG";
    score += 15;
  } else if (falling1h) {
    signal = "FÄLLT";
  }

  return {
    signal,
    score:
      Math.max(
        0,
        Math.min(100, Math.round(score))
      )
  };
}


function profitInfo(currentPrice, position) {
  if (
    !position ||
    !Number.isFinite(position.buyPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return {
      buyPrice: null,
      quantity: null,
      saleAfterTax: null,
      tax: null,
      netProfitPerCard: null,
      netProfitTotal: null,
      profitPercent: null
    };
  }

  const quantity =
    Number.isFinite(position.quantity) &&
    position.quantity > 0
      ? position.quantity
      : 1;

  const saleAfterTax = Math.floor(currentPrice * 0.95);
  const tax = currentPrice - saleAfterTax;
  const netProfitPerCard = saleAfterTax - position.buyPrice;
  const netProfitTotal = netProfitPerCard * quantity;
  const profitPercent =
    position.buyPrice > 0
      ? Number(
          (
            (netProfitPerCard / position.buyPrice) *
            100
          ).toFixed(2)
        )
      : null;

  return {
    buyPrice: position.buyPrice,
    quantity,
    saleAfterTax,
    tax,
    netProfitPerCard,
    netProfitTotal,
    profitPercent
  };
}

async function loadRecentDiscordSignals() {
  if (!dbEnabled) return [];

  const result = await pool.query(`
    SELECT
      id,
      source,
      message,
      player_or_rating,
      call,
      reason,
      expected_timeframe,
      source_reliability,
      category,
      created_at
    FROM fc_discord_signals
    WHERE created_at >= NOW() - INTERVAL '6 hours'
    ORDER BY created_at DESC
    LIMIT 500
  `);

  return result.rows.map(row => ({
    id: row.id,
    source: row.source,
    message: row.message,
    playerOrRating: row.player_or_rating,
    call: row.call,
    reason: row.reason || "",
    expectedTimeframe: row.expected_timeframe || "",
    sourceReliability: Number(row.source_reliability || 50),
    category: row.category || "SHORT_TERM_FLIPS",
    timestamp: new Date(row.created_at).getTime()
  }));
}

async function loadTraderProfiles() {
  if (!dbEnabled) return {};

  const result = await pool.query(`
    SELECT *
    FROM fc_trader_profiles
  `);

  const profiles = {};

  for (const row of result.rows) {
    profiles[String(row.source).toLowerCase()] = {
      source: row.source,
      displayName: row.display_name,
      overallAccuracy: Number(row.overall_accuracy || 50),
      totalSignals: Number(row.total_signals || 0),
      specializationAccuracy: {
        SBC_FODDER: Number(row.accuracy_sbc_fodder || 50),
        PROMO_CARDS: Number(row.accuracy_promo_cards || 50),
        SHORT_TERM_FLIPS: Number(row.accuracy_short_flips || 50),
        LEAKS_CONTENT: Number(row.accuracy_leaks || 50)
      }
    };
  }

  return profiles;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[mid]
    : (clean[mid - 1] + clean[mid]) / 2;
}

function buildRatingStats(rows) {
  const byRating = new Map();

  for (const row of rows) {
    if (row.cardType !== "Base Rare") continue;
    if (!byRating.has(row.overall)) byRating.set(row.overall, []);
    byRating.get(row.overall).push(row);
  }

  const stats = {};

  for (const [rating, cards] of byRating.entries()) {
    const usable = cards.filter(card => Number.isFinite(card.change5m) || Number.isFinite(card.change1m));
    const moves = usable.map(card => Number.isFinite(card.change5m) ? card.change5m : card.change1m);
    const rising = moves.filter(v => v >= 0.5).length;
    const falling = moves.filter(v => v <= -0.5).length;
    const risingPct = moves.length ? Number(((rising / moves.length) * 100).toFixed(1)) : 0;
    const fallingPct = moves.length ? Number(((falling / moves.length) * 100).toFixed(1)) : 0;
    const medMove = median(moves) ?? 0;

    let trend = "neutral";
    if (risingPct >= 70 && medMove >= 1) trend = "stark_steigend";
    else if (risingPct >= 55 || medMove >= 0.6) trend = "steigend";
    else if (fallingPct >= 70 && medMove <= -1) trend = "stark_fallend";
    else if (fallingPct >= 55 || medMove <= -0.6) trend = "fallend";

    stats[rating] = {
      rating,
      cardCount: cards.length,
      measuredCards: moves.length,
      risingPct,
      fallingPct,
      medianMove5m: Number(medMove.toFixed(2)),
      medianPrice: median(cards.map(card => card.price)),
      trend
    };
  }

  return stats;
}

function matchingSignalsForRow(row, allSignals) {
  const ratingText = String(row.overall);
  const name = String(row.name || "").toLowerCase();
  const eaId = String(row.eaId);

  return allSignals.filter(signal => {
    const target = String(signal.playerOrRating || "").toLowerCase().trim();
    return (
      target === eaId ||
      target === ratingText ||
      target === `${ratingText}er` ||
      (target.length >= 4 && name.includes(target)) ||
      (name.length >= 4 && target.includes(name))
    );
  });
}

function baseDecisionFromQuant(quant, confluence) {
  return {
    action: quant.suggestedAction,
    confidence: Math.max(10, Math.min(95, quant.baseConfidence + confluence.confidenceModifier)),
    reason: quant.primaryReason,
    risk: quant.risk,
    market_state: quant.marketState,
    context_breakdown: {
      sbc_context: quant.sbcContext,
      pack_supply_context: quant.packSupplyContext,
      discord_trader_context: confluence.summary
    },
    key_factors: quant.keyFactors,
    entry_zone: quant.entryZone,
    target_exit_zone: quant.targetExitZone,
    trader_signals_confluence: {
      signalCount: confluence.signalCount,
      confirmedSignals: confluence.confirmedSignals,
      confluenceScore: confluence.confluenceScore,
      summary: confluence.summary
    },
    recommended_horizon: quant.suggestedAction === "JETZT KAUFEN" ? "15m - 2h" : "Markt weiter beobachten",
    eaTaxBreakEven: quant.eaTaxBreakEvenPrice,
    ai_model_used: "Quantitative Core"
  };
}

function applyDecisionToRow(row, decision) {
  row.aiAction = decision.action;
  row.aiConfidence = decision.confidence;
  row.aiReason = decision.reason;
  row.aiRisk = decision.risk;
  row.aiMarketState = decision.market_state;
  row.aiModelUsed = decision.ai_model_used || "Quantitative Core";
  row.aiKeyFactors = decision.key_factors || [];
  row.aiRecommendedHorizon = decision.recommended_horizon || null;
  row.aiEntryZone = decision.entry_zone || null;
  row.aiTargetExitZone = decision.target_exit_zone || null;
  row.aiContext = decision.context_breakdown || null;
  row.aiTraderConfluence = decision.trader_signals_confluence || null;
}

async function buildTradingRows() {
  const [cards, bulk, positions, allSignals, traderProfiles] = await Promise.all([
    ensureUniverse(false),
    loadBulkPs5Prices(false),
    getPositions(),
    loadRecentDiscordSignals(),
    loadTraderProfiles()
  ]);

  const current = currentPricedCards(cards, bulk);
  const ids = current.map(row => row.eaId);
  const now = Date.now();

  const thresholds = {
    m1: now - 60_000,
    m5: now - 5 * 60_000,
    m15: now - 15 * 60_000,
    h1: now - 60 * 60_000,
    h24: now - 24 * 60 * 60_000,
    d7: now - 7 * 24 * 60 * 60_000,
    d30: now - 30 * 24 * 60 * 60_000
  };

  let p1m = new Map();
  let p5m = new Map();
  let p15m = new Map();
  let p1h = new Map();
  let p24h = new Map();
  let p7d = new Map();
  let p30d = new Map();
  let ranges24h = new Map();

  if (dbEnabled) {
    [p1m, p5m, p15m, p1h, p24h, p7d, p30d, ranges24h] = await Promise.all([
      lookupDb(ids, thresholds.m1),
      lookupDb(ids, thresholds.m5),
      lookupDb(ids, thresholds.m15),
      lookupDb(ids, thresholds.h1),
      lookupDb(ids, thresholds.h24),
      lookupDb(ids, thresholds.d7),
      lookupDb(ids, thresholds.d30),
      rangeDb(ids, thresholds.h24)
    ]);
  }

  const rows = current.map(card => {
    const key = String(card.eaId);

    const old1m = (dbEnabled ? p1m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m1);
    const old5m = (dbEnabled ? p5m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m5);
    const old15m = (dbEnabled ? p15m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m15);
    const old1h = (dbEnabled ? p1h.get(key) : null) ?? lookupMemory(card.eaId, thresholds.h1);
    const old24h = (dbEnabled ? p24h.get(key) : null) ?? lookupMemory(card.eaId, thresholds.h24);
    const old7d = (dbEnabled ? p7d.get(key) : null) ?? lookupMemory(card.eaId, thresholds.d7);
    const old30d = (dbEnabled ? p30d.get(key) : null) ?? lookupMemory(card.eaId, thresholds.d30);

    const range = dbEnabled
      ? ranges24h.get(key) ?? { low: null, high: null }
      : rangeMemory(card.eaId, thresholds.h24);

    const row = {
      eaId: card.eaId,
      name: card.name,
      overall: card.overall,
      cardType: card.cardType,
      rarityName: card.rarityName,
      position: card.position,
      club: card.club,
      url: card.url,
      price: card.price,
      change1m: changePct(card.price, old1m),
      change5m: changePct(card.price, old5m),
      change15m: changePct(card.price, old15m),
      change1h: changePct(card.price, old1h),
      change24h: changePct(card.price, old24h),
      change7d: changePct(card.price, old7d),
      change30d: changePct(card.price, old30d),
      low24h: range.low ?? card.price,
      high24h: range.high ?? card.price,
      distanceFrom24hLow: distancePct(card.price, range.low),
      tracked: positions.has(key)
    };

    Object.assign(row, signalFor(row));
    Object.assign(row, profitInfo(card.price, positions.get(key)));
    return row;
  });

  const ratingStats = buildRatingStats(rows);
  const brainWork = new Map();

  for (const row of rows) {
    const rating = ratingStats[row.overall] || {
      trend: "neutral",
      risingPct: 0,
      fallingPct: 0
    };

    const signals = matchingSignalsForRow(row, allSignals);

    const input = {
      playerName: row.name || `EA ${row.eaId}`,
      eaId: row.eaId,
      rating: row.overall,
      cardType: row.cardType,
      currentPrice: row.price,
      change1m: row.change1m ?? 0,
      change5m: row.change5m ?? 0,
      change15m: row.change15m ?? 0,
      change1h: row.change1h ?? 0,
      change24h: row.change24h ?? 0,
      change7d: row.change7d ?? 0,
      change30d: row.change30d ?? 0,
      low24h: row.low24h ?? row.price,
      high24h: row.high24h ?? row.price,
      distanceTo24hLow: row.distanceFrom24hLow ?? 0,
      ratingMarketTrend: rating.trend,
      ratingMarketRisingPct: rating.risingPct,
      ratingMarketFallingPct: rating.fallingPct,
      marketContext: {
        packSupplyActive: false,
        overallMarketMood: "neutral"
      },
      discordSignals: signals
    };

    const quant = analyzeMarketPatterns(input);
    const confluence = evaluateDiscordSignals(signals, input, quant, traderProfiles);
    const decision = baseDecisionFromQuant(quant, confluence);
    applyDecisionToRow(row, decision);

    row.ratingMarketTrend = rating.trend;
    row.ratingMarketRisingPct = rating.risingPct;
    row.ratingMarketFallingPct = rating.fallingPct;

    brainWork.set(String(row.eaId), { input, quant, confluence });
  }

  const aiPriority = {
    "JETZT KAUFEN": 6,
    "VERKAUF PRÜFEN": 5,
    "NOCH WARTEN": 4,
    "NICHT KAUFEN": 3,
    "BEOBACHTEN": 2,
    "HALTEN": 1
  };

  rows.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    const actionDiff = (aiPriority[b.aiAction] ?? 0) - (aiPriority[a.aiAction] ?? 0);
    if (actionDiff !== 0) return actionDiff;
    if (b.aiConfidence !== a.aiConfidence) return b.aiConfidence - a.aiConfidence;
    return Math.abs(b.change5m ?? b.change1m ?? 0) - Math.abs(a.change5m ?? a.change1m ?? 0);
  });

  return { rows, brainWork, ratingStats };
}

function candidateScore(row, work) {
  const actionScore = {
    "JETZT KAUFEN": 100,
    "VERKAUF PRÜFEN": 95,
    "NOCH WARTEN": 85,
    "NICHT KAUFEN": 80,
    "BEOBACHTEN": 45,
    "HALTEN": 10
  }[row.aiAction] || 0;

  const movement =
    Math.min(40, Math.abs(row.change1m ?? 0) * 2) +
    Math.min(30, Math.abs(row.change5m ?? 0)) +
    Math.min(20, Math.abs(row.change15m ?? 0) * 0.5);

  const marketBreadth = Math.max(
    row.ratingMarketRisingPct ?? 0,
    row.ratingMarketFallingPct ?? 0
  ) >= 70 ? 20 : 0;

  const discordBonus = work.confluence.signalCount > 0 ? 10 : 0;
  return actionScore + movement + marketBreadth + discordBonus;
}

async function saveDecisionIfNeeded(row, work, decision, forceGemini = false) {
  if (!dbEnabled) return null;

  const important =
    ["JETZT KAUFEN", "VERKAUF PRÜFEN", "NICHT KAUFEN"].includes(decision.action) ||
    (decision.action === "NOCH WARTEN" && (Math.abs(row.change1m ?? 0) >= 5 || Math.abs(row.change5m ?? 0) >= 10));

  if (!important && !forceGemini) return null;

  const recent = await pool.query(`
    SELECT id, ai_model_used
    FROM fc_trader_brain_decisions
    WHERE ea_id = $1
      AND action = $2
      AND created_at >= NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 1
  `, [String(row.eaId), decision.action]);

  if (recent.rowCount) {
    const oldModel = String(recent.rows[0].ai_model_used || "");
    if (!forceGemini || oldModel.includes("Gemini")) return null;
  }

  const id = `dec_${row.eaId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await pool.query(`
    INSERT INTO fc_trader_brain_decisions (
      id, ea_id, player_name, rating, card_type, initial_price,
      action, confidence, reason, risk, market_state,
      ea_tax_break_even, ai_model_used, input_snapshot, decision_payload
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb
    )
  `, [
    id,
    String(row.eaId),
    row.name || `EA ${row.eaId}`,
    row.overall,
    row.cardType,
    row.price,
    decision.action,
    decision.confidence,
    decision.reason,
    decision.risk,
    decision.market_state,
    decision.eaTaxBreakEven || Math.ceil(row.price / 0.95),
    decision.ai_model_used || "Quantitative Core",
    JSON.stringify(work.input),
    JSON.stringify(decision)
  ]);

  return id;
}

async function automaticTraderBrain(rows, brainWork) {
  try {
    const candidates = [];

    for (const row of rows) {
      const work = brainWork.get(String(row.eaId));
      if (!work) continue;
      const gate = shouldUseGemini(work.input, work.quant, work.confluence);
      if (!gate.useGemini) continue;
      candidates.push({ row, work, gate, score: candidateScore(row, work) });
    }

    candidates.sort((a, b) => b.score - a.score);

    const quota = getGeminiQuotaInfo();
    const now = Date.now();
    let geminiCandidate = null;

    if (
      process.env.GEMINI_API_KEY &&
      !quota.quotaExhausted &&
      now - lastGeminiAttemptAt >= GEMINI_MIN_INTERVAL_MS
    ) {
      geminiCandidate = candidates.find(item => {
        const key = `${item.row.eaId}|${item.row.aiAction}`;
        const last = lastGeminiByCard.get(key) || 0;
        return now - last >= GEMINI_CARD_COOLDOWN_MS;
      }) || null;
    }

    if (geminiCandidate) {
      lastGeminiAttemptAt = now;
      const decision = await generateAiTraderDecision(
        geminiCandidate.work.input,
        geminiCandidate.work.quant,
        geminiCandidate.work.confluence
      );

      applyDecisionToRow(geminiCandidate.row, decision);
      lastGeminiCandidate = {
        eaId: geminiCandidate.row.eaId,
        player: geminiCandidate.row.name,
        action: decision.action,
        model: decision.ai_model_used,
        at: new Date().toISOString(),
        trigger: geminiCandidate.gate.triggerReason
      };

      lastGeminiByCard.set(
        `${geminiCandidate.row.eaId}|${decision.action}`,
        now
      );

      await saveDecisionIfNeeded(
        geminiCandidate.row,
        geminiCandidate.work,
        decision,
        String(decision.ai_model_used || "").includes("Gemini")
      );
    }

    if (dbEnabled) {
      const notable = rows
        .filter(row =>
          ["JETZT KAUFEN", "VERKAUF PRÜFEN", "NICHT KAUFEN"].includes(row.aiAction) ||
          (row.aiAction === "NOCH WARTEN" && (Math.abs(row.change1m ?? 0) >= 5 || Math.abs(row.change5m ?? 0) >= 10))
        )
        .sort((a, b) => b.aiConfidence - a.aiConfidence)
        .slice(0, 8);

      for (const row of notable) {
        const work = brainWork.get(String(row.eaId));
        if (!work) continue;
        const decision = {
          action: row.aiAction,
          confidence: row.aiConfidence,
          reason: row.aiReason,
          risk: row.aiRisk,
          market_state: row.aiMarketState,
          context_breakdown: row.aiContext,
          key_factors: row.aiKeyFactors,
          entry_zone: row.aiEntryZone,
          target_exit_zone: row.aiTargetExitZone,
          trader_signals_confluence: row.aiTraderConfluence,
          recommended_horizon: row.aiRecommendedHorizon,
          eaTaxBreakEven: Math.ceil(row.price / 0.95),
          ai_model_used: row.aiModelUsed
        };
        await saveDecisionIfNeeded(row, work, decision, false);
      }
    }

    lastBrainRunAt = new Date().toISOString();
    lastBrainError = null;
  } catch (error) {
    lastBrainError = String(error);
    console.error("Trader Brain error:", error);
  }
}

async function priceAtOrBefore(eaId, targetMs) {
  if (!dbEnabled) return null;

  const result = await pool.query(`
    SELECT price
    FROM fc_price_history
    WHERE ea_id = $1
      AND recorded_at <= $2
    ORDER BY recorded_at DESC
    LIMIT 1
  `, [String(eaId), new Date(targetMs).toISOString()]);

  return result.rowCount ? Number(result.rows[0].price) : null;
}

async function evaluatePendingDecisions() {
  if (!dbEnabled) return;
  if (Date.now() - lastEvaluationSweepAt < 5 * 60_000) return;
  lastEvaluationSweepAt = Date.now();

  const result = await pool.query(`
    SELECT
      d.*,
      e.price_after_5m,
      e.price_after_15m,
      e.price_after_1h,
      e.price_after_6h,
      e.price_after_24h
    FROM fc_trader_brain_decisions d
    LEFT JOIN fc_decision_evaluations e ON e.decision_id = d.id
    WHERE d.created_at >= NOW() - INTERVAL '30 hours'
    ORDER BY d.created_at DESC
    LIMIT 200
  `);

  const now = Date.now();

  for (const record of result.rows) {
    const created = new Date(record.created_at).getTime();
    const tracked = {
      after5m: record.price_after_5m == null ? null : Number(record.price_after_5m),
      after15m: record.price_after_15m == null ? null : Number(record.price_after_15m),
      after1h: record.price_after_1h == null ? null : Number(record.price_after_1h),
      after6h: record.price_after_6h == null ? null : Number(record.price_after_6h),
      after24h: record.price_after_24h == null ? null : Number(record.price_after_24h)
    };

    const horizons = [
      ["after5m", 5 * 60_000],
      ["after15m", 15 * 60_000],
      ["after1h", 60 * 60_000],
      ["after6h", 6 * 60 * 60_000],
      ["after24h", 24 * 60 * 60_000]
    ];

    let changed = false;
    for (const [field, offset] of horizons) {
      if (tracked[field] == null && now >= created + offset) {
        tracked[field] = await priceAtOrBefore(record.ea_id, created + offset);
        if (tracked[field] != null) changed = true;
      }
    }

    if (!changed && Object.values(tracked).every(value => value == null)) continue;

    const evaluation = evaluateTrackedDecision(
      record.action,
      Number(record.initial_price),
      tracked
    );

    await pool.query(`
      INSERT INTO fc_decision_evaluations (
        decision_id,
        price_after_5m,
        price_after_15m,
        price_after_1h,
        price_after_6h,
        price_after_24h,
        roi_5m,
        roi_15m,
        roi_1h,
        roi_6h,
        roi_24h,
        max_roi,
        was_correct,
        outcome_score,
        notes,
        evaluated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW()
      )
      ON CONFLICT (decision_id)
      DO UPDATE SET
        price_after_5m = EXCLUDED.price_after_5m,
        price_after_15m = EXCLUDED.price_after_15m,
        price_after_1h = EXCLUDED.price_after_1h,
        price_after_6h = EXCLUDED.price_after_6h,
        price_after_24h = EXCLUDED.price_after_24h,
        roi_5m = EXCLUDED.roi_5m,
        roi_15m = EXCLUDED.roi_15m,
        roi_1h = EXCLUDED.roi_1h,
        roi_6h = EXCLUDED.roi_6h,
        roi_24h = EXCLUDED.roi_24h,
        max_roi = EXCLUDED.max_roi,
        was_correct = EXCLUDED.was_correct,
        outcome_score = EXCLUDED.outcome_score,
        notes = EXCLUDED.notes,
        evaluated_at = NOW()
    `, [
      record.id,
      tracked.after5m,
      tracked.after15m,
      tracked.after1h,
      tracked.after6h,
      tracked.after24h,
      evaluation.roi5m,
      evaluation.roi15m,
      evaluation.roi1h,
      evaluation.roi6h,
      evaluation.roi24h,
      evaluation.maxRoi,
      evaluation.wasCorrect,
      evaluation.outcomeScore,
      evaluation.notes
    ]);
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Intelligence",
    version: "10.0-google-trader-brain",
    refreshSeconds: 60,
    storage:
      dbEnabled
        ? "Postgres + memory fallback"
        : "memory only",
    endpoints: {
      trading: "GET /trading",
      tradingData: "GET /api/trading",
      positionSave: "POST /api/position",
      positionDelete: "DELETE /api/position/:eaId",
      traderBrainStatus: "GET /api/trader-brain/status",
      traderBrainHistory: "GET /api/trader-brain/feedback/history",
      geminiHealth: "GET /api/gemini-health",
      health: "GET /health"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "10.0-google-trader-brain",
    monitoringStarted,
    monitoringBusy,
    lastMonitorAt,
    lastMonitorError,
    cardsKnown: universe.length,
    dbEnabled,
    traderBrainAutomatic: true,
    lastBrainRunAt,
    lastBrainError,
    geminiQuota: getGeminiQuotaInfo(),
    now: new Date().toISOString()
  });
});

app.post("/api/position", async (req, res) => {
  try {
    const eaId = Number(req.body?.eaId);
    const buyPrice = Number(req.body?.buyPrice);
    const quantity = Number(req.body?.quantity ?? 1);
    const note = String(req.body?.note ?? "").slice(0, 500);

    if (!Number.isFinite(eaId) || eaId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige eaId"
      });
    }

    if (
      !Number.isFinite(buyPrice) ||
      buyPrice <= 0 ||
      !Number.isInteger(buyPrice)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Kaufpreis muss eine positive ganze Zahl sein"
      });
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isInteger(quantity) ||
      quantity > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Menge muss 1 bis 1000 sein"
      });
    }

    await savePosition(
      eaId,
      buyPrice,
      quantity,
      note
    );

    res.json({
      ok: true,
      eaId,
      buyPrice,
      quantity,
      note
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.delete("/api/position/:eaId", async (req, res) => {
  try {
    const eaId = Number(req.params.eaId);

    if (!Number.isFinite(eaId) || eaId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige eaId"
      });
    }

    await deletePosition(eaId);

    res.json({
      ok: true,
      eaId
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/api/trading", async (req, res) => {
  try {
    let rows = latestTradingRows;

    if (!rows.length && !monitoringBusy) {
      const built = await buildTradingRows();
      rows = built.rows;
      latestTradingRows = rows;
      latestRatingStats = built.ratingStats;
    }

    res.json({
      ok: true,
      refreshSeconds: 60,
      dbEnabled,
      historyNote:
        dbEnabled
          ? "Dauerhafte Historie + Trader-Brain-Lernspeicher aktiv"
          : "Nur Arbeitsspeicher; Lernhistorie ist ohne PostgreSQL nicht dauerhaft",
      totalPricedCards: rows.length,
      trackedPositions: rows.filter(row => row.tracked).length,
      aiSummary: {
        buyNow: rows.filter(row => row.aiAction === "JETZT KAUFEN").length,
        wait: rows.filter(row => row.aiAction === "NOCH WARTEN").length,
        doNotBuy: rows.filter(row => row.aiAction === "NICHT KAUFEN").length,
        sellCheck: rows.filter(row => row.aiAction === "VERKAUF PRÜFEN").length
      },
      geminiQuota: getGeminiQuotaInfo(),
      lastBrainRunAt,
      lastBrainError,
      lastGeminiCandidate,
      rows,
      updatedAt: lastMonitorAt || new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/api/trader-brain/status", (req, res) => {
  res.json({
    ok: true,
    version: "10.0-google-trader-brain",
    automatic: true,
    refreshSeconds: 60,
    lastBrainRunAt,
    lastBrainError,
    lastGeminiCandidate,
    gemini: getGeminiQuotaInfo(),
    ratingStats: latestRatingStats
  });
});

app.get("/api/gemini-health", async (req, res) => {
  try {
    res.json(await checkGeminiHealth());
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-brain/feedback/history", async (req, res) => {
  if (!dbEnabled) {
    return res.json({ ok: true, total: 0, history: [], note: "PostgreSQL nicht aktiv" });
  }

  try {
    const result = await pool.query(`
      SELECT
        d.id,
        d.ea_id::text AS ea_id,
        d.player_name,
        d.rating,
        d.card_type,
        d.initial_price,
        d.action,
        d.confidence,
        d.reason,
        d.risk,
        d.market_state,
        d.ai_model_used,
        d.created_at,
        e.price_after_5m,
        e.price_after_15m,
        e.price_after_1h,
        e.price_after_6h,
        e.price_after_24h,
        e.roi_5m,
        e.roi_15m,
        e.roi_1h,
        e.roi_6h,
        e.roi_24h,
        e.was_correct,
        e.outcome_score,
        e.notes
      FROM fc_trader_brain_decisions d
      LEFT JOIN fc_decision_evaluations e ON e.decision_id = d.id
      ORDER BY d.created_at DESC
      LIMIT 100
    `);

    res.json({ ok: true, total: result.rowCount, history: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/overview", (req, res) => {
  res.redirect("/trading");
});

app.get("/trading", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FC Trading Intelligence</title>

<style>
  :root {
    color-scheme: dark;
    font-family: Arial, sans-serif;
  }

  body {
    margin: 0;
    background: #0f0f0f;
    color: #f2f2f2;
  }

  .wrap {
    padding: 18px 22px 40px;
  }

  h1 {
    margin: 0 0 5px;
    font-size: 30px;
  }

  .sub {
    color: #aaa;
    margin-bottom: 14px;
  }

  .bar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    padding: 12px;
    background: #181818;
    border-radius: 10px;
    margin-bottom: 12px;
  }

  input,
  select,
  button {
    background: #101010;
    color: #eee;
    border: 1px solid #333;
    padding: 9px 10px;
    border-radius: 7px;
  }

  button {
    cursor: pointer;
  }

  input {
    min-width: 180px;
  }

  .status {
    margin-left: auto;
    color: #aaa;
    font-size: 13px;
  }

  .storage {
    background: #181818;
    padding: 10px 12px;
    border-radius: 8px;
    margin-bottom: 12px;
    color: #bbb;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    background: #161616;
    font-size: 13px;
  }

  th,
  td {
    padding: 8px 7px;
    border-bottom: 1px solid #292929;
    text-align: right;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    text-align: left;
  }

  th {
    position: sticky;
    top: 0;
    background: #202020;
    z-index: 2;
  }

  tr:hover {
    background: #202020;
  }

  a {
    color: #fff;
  }

  .strong {
    font-weight: 700;
  }

  .muted {
    color: #777;
  }

  .pos {
    color: #8fe59b;
  }

  .neg {
    color: #ff9b9b;
  }

  .tracked {
    background: #1a1a1a;
  }

  .tiny {
    font-size: 11px;
    padding: 5px 7px;
  }
</style>
</head>

<body>
<div class="wrap">

  <h1>FC Trading Intelligence</h1>

  <div class="sub">
    Google Trader Brain • 1m / 5m / 15m / 1h / 24h / 7d / 30d • 60-Sekunden-Refresh • 5 % EA-Steuer
  </div>

  <div class="bar">

    <input
      id="search"
      placeholder="Spieler suchen…"
    >

    <select id="type">
      <option value="all">Alle Kartentypen</option>
      <option value="Base Rare">Base Rare</option>
      <option value="Base Common">Base Common</option>
      <option value="Special">Special</option>
    </select>

    <select id="minRating">
      ${Array.from(
        { length: 25 },
        (_, i) => 75 + i
      )
        .map(
          rating =>
            `<option value="${rating}">${rating}+</option>`
        )
        .join("")}
    </select>

    <select id="signal">
      <option value="all">Alle Signale</option>
      <option>KAUFEN</option>
      <option>BEOBACHTEN</option>
      <option>ERHOLUNG</option>
      <option>VERKAUF PRÜFEN</option>
      <option>HALTEN</option>
      <option>FÄLLT</option>
    </select>

    <select id="aiFilter">
      <option value="all">Alle KI-Entscheidungen</option>
      <option>JETZT KAUFEN</option>
      <option>NOCH WARTEN</option>
      <option>NICHT KAUFEN</option>
      <option>BEOBACHTEN</option>
      <option>HALTEN</option>
      <option>VERKAUF PRÜFEN</option>
    </select>

    <select id="trackedFilter">
      <option value="all">Alle Karten</option>
      <option value="tracked">Meine Käufe</option>
      <option value="notTracked">Ohne Kaufpreis</option>
    </select>

    <div
      id="status"
      class="status"
    >
      Wird geladen…
    </div>

  </div>

  <div
    id="storage"
    class="storage"
  >
    Lade Datenbankstatus…
  </div>

  <table>

    <thead>
      <tr>
        <th>Spieler</th>
        <th>GES</th>
        <th>Typ</th>
        <th>Preis</th>
        <th>1m</th>
        <th>5m</th>
        <th>15m</th>
        <th>1h</th>
        <th>24h</th>
        <th>7d</th>
        <th>30d</th>
        <th>24h Tief</th>
        <th>24h Hoch</th>
        <th>Signal</th>
        <th>Score</th>
        <th>KI-Entscheidung</th>
        <th>KI-Sicherheit</th>
        <th>KI-Grund</th>
        <th>Kaufpreis</th>
        <th>Menge</th>
        <th>EA-Steuer</th>
        <th>Nach Steuer</th>
        <th>Netto-Gewinn</th>
        <th>Gewinn %</th>
        <th>Aktion</th>
      </tr>
    </thead>

    <tbody id="rows"></tbody>

  </table>

</div>

<script>

let allRows = [];
let busy = false;

const fmt = value =>
  Number.isFinite(value)
    ? value.toLocaleString("de-DE")
    : "-";

function pctCell(value) {

  if (!Number.isFinite(value)) {
    return '<span class="muted">-</span>';
  }

  const cls =
    value > 0
      ? "pos"
      : value < 0
      ? "neg"
      : "";

  return (
    '<span class="' +
    cls +
    '">' +
    (value > 0 ? "+" : "") +
    value.toFixed(2) +
    "%</span>"
  );
}

function moneyClass(value) {
  if (!Number.isFinite(value)) return "";

  if (value > 0) return "pos";
  if (value < 0) return "neg";

  return "";
}

function render() {

  const query =
    document
      .getElementById("search")
      .value
      .trim()
      .toLowerCase();

  const type =
    document
      .getElementById("type")
      .value;

  const minRating =
    Number(
      document
        .getElementById("minRating")
        .value
    );

  const signal =
    document
      .getElementById("signal")
      .value;

  const aiFilter =
    document
      .getElementById("aiFilter")
      .value;

  const trackedFilter =
    document
      .getElementById("trackedFilter")
      .value;

  const filtered =
    allRows.filter(row => {

      if (row.overall < minRating) {
        return false;
      }

      if (
        type !== "all" &&
        row.cardType !== type
      ) {
        return false;
      }

      if (
        signal !== "all" &&
        row.signal !== signal
      ) {
        return false;
      }

      if (
        aiFilter !== "all" &&
        row.aiAction !== aiFilter
      ) {
        return false;
      }

      if (
        trackedFilter === "tracked" &&
        !row.tracked
      ) {
        return false;
      }

      if (
        trackedFilter === "notTracked" &&
        row.tracked
      ) {
        return false;
      }

      if (query) {

        const hay =
          [
            row.name,
            row.rarityName,
            row.club,
            row.position
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        if (!hay.includes(query)) {
          return false;
        }
      }

      return true;
    });

  const rowsEl =
    document.getElementById("rows");

  rowsEl.innerHTML = "";

  for (
    const row of filtered.slice(0, 500)
  ) {

    const tr =
      document.createElement("tr");

    if (row.tracked) {
      tr.className = "tracked";
    }

    const buyInput =
      row.tracked
        ? fmt(row.buyPrice)
        : "-";

    const qty =
      row.tracked
        ? fmt(row.quantity)
        : "-";

    const action =
      row.tracked
        ? \`
            <button
              class="tiny"
              onclick="editPosition(\${row.eaId})"
            >
              Ändern
            </button>

            <button
              class="tiny"
              onclick="removePosition(\${row.eaId})"
            >
              Löschen
            </button>
          \`
        : \`
            <button
              class="tiny"
              onclick="editPosition(\${row.eaId})"
            >
              Kaufpreis
            </button>
          \`;

    tr.innerHTML = \`
      <td>
        <a
          href="\${row.url}"
          target="_blank"
        >
          \${row.name || "-"}
        </a>
      </td>

      <td>\${row.overall}</td>

      <td>\${row.cardType}</td>

      <td>\${fmt(row.price)}</td>

      <td>\${pctCell(row.change1m)}</td>

      <td>\${pctCell(row.change5m)}</td>

      <td>\${pctCell(row.change15m)}</td>

      <td>\${pctCell(row.change1h)}</td>

      <td>\${pctCell(row.change24h)}</td>

      <td>\${pctCell(row.change7d)}</td>

      <td>\${pctCell(row.change30d)}</td>

      <td>\${fmt(row.low24h)}</td>

      <td>\${fmt(row.high24h)}</td>

      <td class="strong">
        \${row.signal}
      </td>

      <td>
        \${row.score}
      </td>

      <td class="strong">
        \${row.aiAction}
      </td>

      <td>
        \${row.aiConfidence}%
      </td>

      <td style="text-align:left; white-space:normal; min-width:320px">
        \${row.aiReason}
      </td>

      <td>
        \${buyInput}
      </td>

      <td>
        \${qty}
      </td>

      <td>
        \${fmt(row.tax)}
      </td>

      <td>
        \${fmt(row.saleAfterTax)}
      </td>

      <td class="\${moneyClass(row.netProfitTotal)} strong">
        \${fmt(row.netProfitTotal)}
      </td>

      <td>
        \${pctCell(row.profitPercent)}
      </td>

      <td>
        \${action}
      </td>
    \`;

    rowsEl.appendChild(tr);
  }

  document
    .getElementById("status")
    .textContent =
      filtered.length +
      " passende Karten • zeige " +
      Math.min(
        500,
        filtered.length
      );

}

async function editPosition(eaId) {

  const row =
    allRows.find(
      item => item.eaId === eaId
    );

  if (!row) return;

  const current =
    row.tracked
      ? String(row.buyPrice)
      : "";

  const buyRaw =
    prompt(
      "Kaufpreis für " +
      row.name +
      " in Coins:",
      current
    );

  if (buyRaw === null) return;

  const buyPrice =
    Number(
      String(buyRaw)
        .replace(/[.\s]/g, "")
        .replace(",", "")
    );

  if (
    !Number.isInteger(buyPrice) ||
    buyPrice <= 0
  ) {
    alert("Ungültiger Kaufpreis.");
    return;
  }

  const qtyRaw =
    prompt(
      "Wie viele Karten?",
      row.tracked
        ? String(row.quantity || 1)
        : "1"
    );

  if (qtyRaw === null) return;

  const quantity =
    Number(qtyRaw);

  if (
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    quantity > 1000
  ) {
    alert("Ungültige Menge.");
    return;
  }

  const response =
    await fetch(
      "/api/position",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body: JSON.stringify({
          eaId,
          buyPrice,
          quantity
        })
      }
    );

  const json =
    await response.json();

  if (!response.ok || !json.ok) {
    alert(
      json.error ||
      "Speichern fehlgeschlagen"
    );
    return;
  }

  await load();

}

async function removePosition(eaId) {

  const row =
    allRows.find(
      item => item.eaId === eaId
    );

  if (!row) return;

  if (
    !confirm(
      "Kaufpreis für " +
      row.name +
      " löschen?"
    )
  ) {
    return;
  }

  const response =
    await fetch(
      "/api/position/" + eaId,
      {
        method: "DELETE"
      }
    );

  const json =
    await response.json();

  if (!response.ok || !json.ok) {
    alert(
      json.error ||
      "Löschen fehlgeschlagen"
    );
    return;
  }

  await load();

}

async function load() {

  if (busy) return;

  busy = true;

  const status =
    document.getElementById("status");

  status.textContent =
    "Aktualisiere…";

  try {

    const response =
      await fetch(
        "/api/trading",
        {
          cache: "no-store"
        }
      );

    const json =
      await response.json();

    if (
      !response.ok ||
      !json.ok
    ) {
      throw new Error(
        json.error ||
        "Abruf fehlgeschlagen"
      );
    }

    allRows =
      json.rows || [];

    document
      .getElementById("storage")
      .textContent =
        (
          json.dbEnabled
            ? "Dauerhafte Historie: AN"
            : "Dauerhafte Historie: AUS"
        ) +
        " • " +
        json.historyNote +
        " • Eigene Käufe: " +
        json.trackedPositions +
        " • KI jetzt kaufen: " +
        (json.aiSummary?.buyNow ?? 0) +
        " • KI Verkauf prüfen: " +
        (json.aiSummary?.sellCheck ?? 0) +
        " • Gemini: " +
        (json.geminiQuota?.usedToday ?? 0) +
        "/" +
        (json.geminiQuota?.dailyBudget ?? 15) +
        " • Aktualisiert " +
        new Date(
          json.updatedAt
        ).toLocaleTimeString(
          "de-DE"
        );

    render();

  } catch (error) {

    status.textContent =
      "Fehler: " +
      error.message;

  } finally {

    busy = false;

  }

}

for (
  const id of [
    "search",
    "type",
    "minRating",
    "signal",
    "aiFilter",
    "trackedFilter"
  ]
) {

  document
    .getElementById(id)
    .addEventListener(
      id === "search"
        ? "input"
        : "change",
      render
    );

}

load();

setInterval(
  load,
  60_000
);

</script>

</body>
</html>`);
});

async function startMonitoring() {
  if (monitoringStarted) return;

  monitoringStarted = true;

  try {
    await initDb();
  } catch (error) {
    console.error(
      "DB init error:",
      error
    );

    lastMonitorError =
      "DB init: " +
      String(error);
  }

  monitorOnce();

  setInterval(
    monitorOnce,
    PRICE_REFRESH_MS
  );

  setInterval(
    () => {
      ensureUniverse(true).catch(
        error => {
          console.error(
            "metadata refresh error:",
            error
          );
        }
      );
    },
    META_REFRESH_MS
  );
}

app.listen(
  port,
  () => {
    console.log(
      `FC Trading Intelligence v10.1 Google Trader Brain Signal Fix running on ${port}`
    );

    startMonitoring();
  }
);
