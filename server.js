import express from "express";
import pg from "pg";
import { Client, GatewayIntentBits, Events } from "discord.js";
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

const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const DISCORD_ALERT_CHANNEL_ID = String(process.env.DISCORD_ALERT_CHANNEL_ID || "").trim();
const TRADER_SIGNAL_CHANNEL_ID = String(process.env.TRADER_SIGNAL_CHANNEL_ID || "").trim();
const DISCORD_CONFIGURED = Boolean(DISCORD_BOT_TOKEN);
const DISCORD_ALERT_COOLDOWN_MS = Math.max(5, Number(process.env.DISCORD_ALERT_COOLDOWN_MIN || 30)) * 60_000;
const DISCORD_MAX_ALERTS_PER_CYCLE = Math.max(1, Math.min(10, Number(process.env.DISCORD_MAX_ALERTS_PER_CYCLE || 5)));
const DISCORD_MIN_BUY_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_MIN_BUY_CONFIDENCE || 90)));
const DISCORD_MIN_SELL_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_MIN_SELL_CONFIDENCE || 84)));
const DISCORD_MIN_RATING_CONFIDENCE = Math.max(60, Math.min(95, Number(process.env.DISCORD_MIN_RATING_CONFIDENCE || 75)));

let lastDiscordSendAt = null;
let lastDiscordError = null;
let discordAlertsSent = 0;
let discordClientReady = false;
let discordResolvedChannelId = null;
let discordResolvedChannelName = null;
let traderSignalResolvedChannelId = null;
let traderSignalResolvedChannelName = null;
let traderSignalsReceived = 0;
let traderSignalsAccepted = 0;
let traderSignalsIgnored = 0;
let lastTraderSignalAt = null;
let lastTraderSignalError = null;
let discordBotTag = null;
let discordGuildCount = 0;
let discordClient = null;
let discordLoginPromise = null;
const memoryDiscordAlertState = new Map();
const memoryTraderSignals = [];

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
      target_ea_id BIGINT,
      initial_reference_price INTEGER,
      initial_reference_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v10.6-v10.6.2: bestehende Datenbanken ohne Datenverlust erweitern.
  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS target_ea_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS initial_reference_price INTEGER
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS initial_reference_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_signal_outcomes (
      signal_id VARCHAR(120) NOT NULL REFERENCES fc_discord_signals(id) ON DELETE CASCADE,
      horizon_minutes SMALLINT NOT NULL,
      initial_price INTEGER NOT NULL,
      observed_price INTEGER NOT NULL,
      gross_change_pct NUMERIC(10,4) NOT NULL,
      net_roi_after_tax_pct NUMERIC(10,4) NOT NULL,
      was_correct BOOLEAN NOT NULL,
      evaluation_reason TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (signal_id, horizon_minutes)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_trader_signal_outcomes_time
    ON fc_trader_signal_outcomes (evaluated_at DESC)
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_discord_alert_state (
      alert_key VARCHAR(180) PRIMARY KEY,
      alert_type VARCHAR(50) NOT NULL,
      last_action VARCHAR(100) NOT NULL,
      last_price INTEGER,
      last_confidence SMALLINT,
      last_fingerprint VARCHAR(250),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

function discordNumber(value) {
  return Number.isFinite(value)
    ? Math.round(value).toLocaleString("de-DE")
    : "-";
}

function discordPct(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}%`;
}


function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function collectDiscordText(message) {
  const parts = [];

  if (message?.content) parts.push(message.content);

  for (const embed of message?.embeds || []) {
    if (embed?.title) parts.push(embed.title);
    if (embed?.description) parts.push(embed.description);
    for (const field of embed?.fields || []) {
      if (field?.name) parts.push(field.name);
      if (field?.value) parts.push(field.value);
    }
  }

  // Discord Forwarded Messages / Message Snapshots, wenn vom Client unterstützt.
  try {
    const snapshots = message?.messageSnapshots;
    const values = snapshots?.values ? Array.from(snapshots.values()) : [];
    for (const snapshot of values) {
      if (snapshot?.content) parts.push(snapshot.content);
      for (const embed of snapshot?.embeds || []) {
        if (embed?.title) parts.push(embed.title);
        if (embed?.description) parts.push(embed.description);
        for (const field of embed?.fields || []) {
          if (field?.name) parts.push(field.name);
          if (field?.value) parts.push(field.value);
        }
      }
    }
  } catch {
    // Snapshot-Unterstützung ist optional. Normale Nachrichten funktionieren weiterhin.
  }

  return compactWhitespace(parts.join("\n"));
}

function detectTraderCall(text) {
  const lower = String(text || "").toLowerCase();

  const waitPatterns = [
    /\bwait\b/, /\bwarten\b/, /\bnoch warten\b/, /\bavoid\b/,
    /\bdon['’]?t buy\b/, /\bdo not buy\b/, /\bno buy\b/,
    /\bnicht kaufen\b/, /\bhold off\b/, /\bstand by\b/
  ];
  if (waitPatterns.some(pattern => pattern.test(lower))) return "WARTEN";

  const sellPatterns = [
    /\bsell\b/, /\bverkaufen\b/, /\bverkauf\b/, /\btake profit\b/,
    /\bprofit take\b/, /\bcash out\b/, /\bexit\b/, /\bdump\b/,
    /\bwill fall\b/, /\bgoing down\b/, /\bcrash incoming\b/
  ];
  if (sellPatterns.some(pattern => pattern.test(lower))) return "VERKAUFEN";

  const buyPatterns = [
    /\bbuy\b/, /\bkaufen\b/, /\binvest\b/, /\binvestment\b/,
    /\bsnipe\b/, /\baccumulate\b/, /\bstock up\b/, /\bload up\b/,
    /\bwill rise\b/, /\bgoing up\b/, /\bwill go up\b/, /\bsteigen\b/,
    /\brise soon\b/, /\bboom soon\b/
  ];
  if (buyPatterns.some(pattern => pattern.test(lower))) return "KAUFEN";

  return null;
}

function detectTraderCategory(text) {
  const lower = String(text || "").toLowerCase();
  if (/\bsbc\b|fodder|icon upgrade|upgrade sbc|potm|squad building/.test(lower)) return "SBC_FODDER";
  if (/leak|leaked|tomorrow content|content leak|evo leak|evolution leak/.test(lower)) return "LEAKS_CONTENT";
  if (/promo|toty|tots|futties|trailblazer|road to|rttf|future stars|team of the week|totw/.test(lower)) return "PROMO_CARDS";
  return "SHORT_TERM_FLIPS";
}

function detectExpectedTimeframe(text) {
  const raw = String(text || "");
  const patterns = [
    /\b(?:in\s+)?\d{1,2}\s*(?:min|mins|minute|minutes|m)\b/i,
    /\b(?:in\s+)?\d{1,2}\s*(?:h|hr|hrs|hour|hours|stunde|stunden)\b/i,
    /\b(?:today|heute|tonight|heute abend|tomorrow|morgen)\b/i,
    /\b(?:at\s*)?\d{1,2}(?::\d{2})?\s*(?:pm|am)?\b/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return compactWhitespace(match[0]);
  }
  return "nicht angegeben";
}

function detectSignalSource(message, text) {
  const explicit = String(text || "").match(/(?:source|quelle|trader)\s*[:\-]\s*@?([a-z0-9_.\-]{2,50})/i);
  if (explicit) return explicit[1];

  const atName = String(text || "").match(/@([a-z0-9_.\-]{3,50})/i);
  if (atName) return atName[1];

  return message?.author?.username || message?.author?.tag || "discord_signal";
}

function detectSignalTarget(text) {
  const raw = compactWhitespace(text);
  const lower = raw.toLowerCase();

  // Spieler aus unserer aktuell geladenen FUT.GG-Kartenliste erkennen.
  const candidates = latestTradingRows
    .filter(row => row?.name)
    .map(row => ({
      name: String(row.name),
      lower: String(row.name).toLowerCase(),
      eaId: String(row.eaId)
    }))
    .sort((a, b) => b.lower.length - a.lower.length);

  for (const card of candidates) {
    if (card.lower.length >= 4 && lower.includes(card.lower)) {
      return { target: card.name, eaId: card.eaId, kind: "player" };
    }
  }

  // Wenn nur der Nachname genannt wird, nur eindeutige Treffer akzeptieren.
  const surnameMatches = new Map();
  for (const card of candidates) {
    const tokens = card.lower.split(/[^a-zà-ÿ0-9]+/i).filter(Boolean);
    const surname = tokens.at(-1);
    if (!surname || surname.length < 4 || !lower.match(new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i"))) continue;
    if (!surnameMatches.has(surname)) surnameMatches.set(surname, []);
    surnameMatches.get(surname).push(card);
  }
  for (const matches of surnameMatches.values()) {
    if (matches.length === 1) {
      return { target: matches[0].name, eaId: matches[0].eaId, kind: "player" };
    }
  }

  // Rating-Signale, z.B. "83er", "88s" oder "88 fodder".
  const ratingMatch = lower.match(/\b(7[5-9]|8\d|9\d)(?:er|s)?\b/);
  if (ratingMatch) {
    const rating = Number(ratingMatch[1]);
    if (rating >= 75 && rating <= 99) {
      return { target: String(rating), rating, kind: "rating" };
    }
  }

  return null;
}

function parseTraderSignalMessage(message) {
  const text = collectDiscordText(message);
  if (!text || text.length < 3) {
    return { ok: false, reason: "Keine auswertbare Nachricht" };
  }

  const call = detectTraderCall(text);
  if (!call) {
    return { ok: false, reason: "Keine klare Aktion KAUFEN / VERKAUFEN / WARTEN erkannt" };
  }

  const targetInfo = detectSignalTarget(text);
  if (!targetInfo) {
    return { ok: false, reason: "Kein eindeutiger FUT.GG-Spieler oder Rating erkannt" };
  }

  const source = detectSignalSource(message, text);
  const category = detectTraderCategory(text);
  const expectedTimeframe = detectExpectedTimeframe(text);

  return {
    ok: true,
    signal: {
      id: `discord_${message.id}`,
      source,
      message: text.slice(0, 3000),
      playerOrRating: targetInfo.target,
      eaId: targetInfo.eaId || null,
      call,
      reason: text.slice(0, 1200),
      expectedTimeframe,
      sourceReliability: 50,
      category,
      timestamp: Date.now()
    }
  };
}

function currentReferenceForTraderSignal(signal) {
  const target = String(signal?.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;

  if (Number.isFinite(rating) && rating >= 75 && rating <= 99) {
    const prices = latestTradingRows
      .filter(row => row.overall === rating && row.cardType === "Base Rare" && Number.isFinite(row.price))
      .map(row => row.price);
    return median(prices);
  }

  if (signal?.eaId != null) {
    const row = latestTradingRows.find(item => String(item.eaId) === String(signal.eaId));
    if (Number.isFinite(row?.price)) return row.price;
  }

  const lower = target.toLowerCase();
  const exact = latestTradingRows.filter(row => String(row.name || "").toLowerCase() === lower && Number.isFinite(row.price));
  return exact.length ? median(exact.map(row => row.price)) : null;
}

async function saveIncomingTraderSignal(signal) {
  if (!signal) return;

  if (!dbEnabled) {
    memoryTraderSignals.unshift(signal);
    if (memoryTraderSignals.length > 500) memoryTraderSignals.length = 500;
    return;
  }

  const initialReferencePrice = currentReferenceForTraderSignal(signal);

  await pool.query(
    `
      INSERT INTO fc_discord_signals (
        id,
        source,
        message,
        player_or_rating,
        call,
        reason,
        expected_timeframe,
        source_reliability,
        category,
        target_ea_id,
        initial_reference_price,
        initial_reference_at,
        created_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        CASE WHEN $11::integer IS NULL THEN NULL ELSE NOW() END,
        NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [
      signal.id,
      signal.source,
      signal.message,
      signal.playerOrRating,
      signal.call,
      signal.reason,
      signal.expectedTimeframe,
      signal.sourceReliability,
      signal.category,
      signal.eaId ? String(signal.eaId) : null,
      Number.isFinite(initialReferencePrice) ? Math.round(initialReferencePrice) : null
    ]
  );

  const profileId = `trader_${String(signal.source).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80)}`;
  await pool.query(
    `
      INSERT INTO fc_trader_profiles (
        id, source, display_name, overall_accuracy, total_signals,
        reputation_badge, notes, updated_at
      )
      VALUES ($1,$2,$3,50,1,'Unbewiesen','Automatisch aus #trader-signals angelegt',NOW())
      ON CONFLICT (source)
      DO UPDATE SET
        total_signals = fc_trader_profiles.total_signals + 1,
        updated_at = NOW()
    `,
    [profileId, signal.source, signal.source]
  );
}

async function resolveTraderSignalChannel() {
  if (!discordClientReady || !discordClient?.isReady()) return null;

  if (TRADER_SIGNAL_CHANNEL_ID) {
    try {
      const configured = await discordClient.channels.fetch(TRADER_SIGNAL_CHANNEL_ID);
      if (configured?.isTextBased?.()) {
        traderSignalResolvedChannelId = configured.id;
        traderSignalResolvedChannelName = configured.name || "trader-signals";
        return configured;
      }
    } catch (error) {
      console.warn(
        `Trader-Signal Channel-ID ${TRADER_SIGNAL_CHANNEL_ID} nicht direkt erreichbar. Suche automatisch nach #trader-signals...`,
        error?.message || error
      );
    }
  }

  for (const guild of discordClient.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      const found = channels.find(channel =>
        channel && channel.name === "trader-signals" && channel.isTextBased?.()
      );
      if (found) {
        traderSignalResolvedChannelId = found.id;
        traderSignalResolvedChannelName = found.name;
        console.log(
          `Trader-Signal-Kanal automatisch gefunden: Guild "${guild.name}", #${found.name}, ID ${found.id}`
        );
        return found;
      }
    } catch (error) {
      console.warn(`Trader-Signal-Kanalsuche in "${guild.name}" fehlgeschlagen:`, error?.message || error);
    }
  }

  lastTraderSignalError = "#trader-signals wurde nicht gefunden oder ist für den Bot nicht sichtbar.";
  return null;
}

async function handleTraderSignalMessage(message) {
  try {
    if (!message || message.author?.bot) return;

    const channelId = String(message.channelId || "");
    const targetChannel = traderSignalResolvedChannelId || TRADER_SIGNAL_CHANNEL_ID;
    if (!targetChannel || channelId !== String(targetChannel)) return;

    traderSignalsReceived++;
    lastTraderSignalAt = new Date().toISOString();

    const parsed = parseTraderSignalMessage(message);
    if (!parsed.ok) {
      traderSignalsIgnored++;
      lastTraderSignalError = parsed.reason;
      await message.reply({
        content: `⚪ Signal nicht übernommen: ${parsed.reason}. Schreibe z. B. **"BUY Harry Kane, 89er Fodder steigt wegen SBC morgen"**.`,
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => {});
      return;
    }

    await saveIncomingTraderSignal(parsed.signal);
    traderSignalsAccepted++;
    lastTraderSignalError = null;

    await message.reply({
      content:
        `📥 **Trader-Signal gespeichert** | ${parsed.signal.call} | ` +
        `**${parsed.signal.playerOrRating}** | Quelle: **${parsed.signal.source}** | ` +
        `Kategorie: ${parsed.signal.category}. Wird ab dem nächsten 60-Sekunden-Marktcheck gegen FUT.GG geprüft.`,
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => {});
  } catch (error) {
    traderSignalsIgnored++;
    lastTraderSignalError = String(error);
    console.error("Trader signal ingest error:", error);
  }
}

async function initDiscordBot() {
  if (!DISCORD_CONFIGURED) {
    lastDiscordError = "DISCORD_BOT_TOKEN fehlt";
    return false;
  }

  if (discordClientReady && discordClient?.isReady()) {
    return true;
  }

  if (discordLoginPromise) {
    return discordLoginPromise;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  discordClient.on("error", error => {
    lastDiscordError = `Discord Client: ${String(error)}`;
    console.error("Discord client error:", error);
  });

  discordClient.on("warn", warning => {
    console.warn("Discord client warning:", warning);
  });

  discordClient.on(Events.MessageCreate, message => {
    handleTraderSignalMessage(message).catch(error => {
      lastTraderSignalError = String(error);
      console.error("Trader signal message handler error:", error);
    });
  });

  discordLoginPromise = new Promise(async resolve => {
    const timeout = setTimeout(() => {
      lastDiscordError = "Discord Gateway Login Timeout";
      console.error("Discord Gateway Login Timeout");
      resolve(false);
    }, 25_000);

    discordClient.once(Events.ClientReady, async () => {
      clearTimeout(timeout);
      discordClientReady = true;
      discordBotTag = discordClient.user?.tag || discordClient.user?.username || "Bot";
      discordGuildCount = discordClient.guilds.cache.size;
      lastDiscordError = null;

      console.log(
        `Discord Gateway verbunden als ${discordBotTag} • Guilds: ${discordGuildCount}`
      );

      const channel = await resolveDiscordAlertChannel();
      if (channel) {
        console.log(
          `Discord Alert-Kanal gefunden: #${discordResolvedChannelName} (${discordResolvedChannelId})`
        );
      }

      const traderChannel = await resolveTraderSignalChannel();
      if (traderChannel) {
        console.log(
          `Discord Trader-Signal-Kanal gefunden: #${traderSignalResolvedChannelName} (${traderSignalResolvedChannelId})`
        );
      }

      resolve(true);
    });

    try {
      await discordClient.login(DISCORD_BOT_TOKEN);
    } catch (error) {
      clearTimeout(timeout);
      discordClientReady = false;
      lastDiscordError = `Discord Login fehlgeschlagen: ${String(error)}`;
      console.error("Discord login error:", error);
      resolve(false);
    }
  });

  return discordLoginPromise;
}

async function resolveDiscordAlertChannel() {
  if (!discordClientReady || !discordClient?.isReady()) return null;

  // 1) Bevorzugt die in Render konfigurierte Channel-ID.
  if (DISCORD_ALERT_CHANNEL_ID) {
    try {
      const configured = await discordClient.channels.fetch(DISCORD_ALERT_CHANNEL_ID);
      if (configured?.isTextBased?.() && typeof configured.send === "function") {
        discordResolvedChannelId = configured.id;
        discordResolvedChannelName = configured.name || "trading-alerts";
        return configured;
      }
    } catch (error) {
      console.warn(
        `Discord Channel-ID ${DISCORD_ALERT_CHANNEL_ID} nicht direkt erreichbar. Suche automatisch nach #trading-alerts...`,
        error?.message || error
      );
    }
  }

  // 2) Fallback: im/den Server(n), in denen der Bot Mitglied ist, nach #trading-alerts suchen.
  for (const guild of discordClient.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      const found = channels.find(channel =>
        channel &&
        channel.name === "trading-alerts" &&
        channel.isTextBased?.() &&
        typeof channel.send === "function"
      );

      if (found) {
        discordResolvedChannelId = found.id;
        discordResolvedChannelName = found.name;
        console.warn(
          `Discord Alert-Kanal automatisch gefunden: Guild "${guild.name}", #${found.name}, ID ${found.id}`
        );
        return found;
      }
    } catch (error) {
      console.warn(
        `Discord Kanäle von Guild "${guild.name}" konnten nicht gelesen werden:`,
        error?.message || error
      );
    }
  }

  lastDiscordError =
    "Discord Bot ist verbunden, aber #trading-alerts wurde nicht gefunden oder ist für den Bot nicht sichtbar.";
  return null;
}

async function sendDiscordPayload(payload) {
  if (!DISCORD_CONFIGURED) return { ok: false, skipped: "not_configured" };

  const ready = await initDiscordBot();
  if (!ready) {
    throw new Error(lastDiscordError || "Discord Bot konnte nicht verbunden werden");
  }

  const channel = await resolveDiscordAlertChannel();
  if (!channel) {
    throw new Error(lastDiscordError || "Discord Alert-Kanal nicht gefunden");
  }

  try {
    await channel.send({
      ...payload,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    lastDiscordError = `Discord send failed: ${String(error)}`;
    throw error;
  }

  lastDiscordSendAt = new Date().toISOString();
  lastDiscordError = null;
  discordAlertsSent++;
  return { ok: true };
}

async function getDiscordAlertState(alertKey) {
  if (dbEnabled) {
    const result = await pool.query(`
      SELECT alert_key, alert_type, last_action, last_price, last_confidence,
             last_fingerprint, last_sent_at
      FROM fc_discord_alert_state
      WHERE alert_key = $1
      LIMIT 1
    `, [alertKey]);

    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      alertKey: row.alert_key,
      alertType: row.alert_type,
      lastAction: row.last_action,
      lastPrice: row.last_price == null ? null : Number(row.last_price),
      lastConfidence: row.last_confidence == null ? null : Number(row.last_confidence),
      lastFingerprint: row.last_fingerprint,
      lastSentAt: new Date(row.last_sent_at).getTime()
    };
  }

  return memoryDiscordAlertState.get(alertKey) || null;
}

async function saveDiscordAlertState({ alertKey, alertType, action, price = null, confidence = null, fingerprint = "" }) {
  const state = {
    alertKey,
    alertType,
    lastAction: action,
    lastPrice: Number.isFinite(price) ? Math.round(price) : null,
    lastConfidence: Number.isFinite(confidence) ? Math.round(confidence) : null,
    lastFingerprint: fingerprint,
    lastSentAt: Date.now()
  };

  if (dbEnabled) {
    await pool.query(`
      INSERT INTO fc_discord_alert_state (
        alert_key, alert_type, last_action, last_price,
        last_confidence, last_fingerprint, last_sent_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (alert_key)
      DO UPDATE SET
        alert_type = EXCLUDED.alert_type,
        last_action = EXCLUDED.last_action,
        last_price = EXCLUDED.last_price,
        last_confidence = EXCLUDED.last_confidence,
        last_fingerprint = EXCLUDED.last_fingerprint,
        last_sent_at = NOW()
    `, [
      state.alertKey,
      state.alertType,
      state.lastAction,
      state.lastPrice,
      state.lastConfidence,
      state.lastFingerprint
    ]);
  } else {
    memoryDiscordAlertState.set(alertKey, state);
  }

  return state;
}

function discordAlertShouldSend(state, action, price, confidence, fingerprint) {
  if (!state) return true;
  if (state.lastAction !== action) return true;

  const age = Date.now() - state.lastSentAt;
  if (state.lastFingerprint !== fingerprint && age >= 5 * 60_000) return true;
  if (age < DISCORD_ALERT_COOLDOWN_MS) return false;

  const priceMove =
    Number.isFinite(price) && Number.isFinite(state.lastPrice) && state.lastPrice > 0
      ? Math.abs((price - state.lastPrice) / state.lastPrice) * 100
      : 0;

  const confidenceMove =
    Number.isFinite(confidence) && Number.isFinite(state.lastConfidence)
      ? Math.abs(confidence - state.lastConfidence)
      : 0;

  if (priceMove >= 3 || confidenceMove >= 5) return true;
  return age >= 2 * 60 * 60_000;
}

function cardDiscordAlertCandidate(row) {
  if (row.aiAction === "JETZT KAUFEN" && row.aiConfidence >= DISCORD_MIN_BUY_CONFIDENCE) {
    return { type: "buy", priority: 100 + row.aiConfidence };
  }

  if (row.aiAction === "VERKAUF PRÜFEN" && row.aiConfidence >= DISCORD_MIN_SELL_CONFIDENCE) {
    return { type: "sell", priority: 110 + row.aiConfidence };
  }

  const crash =
    row.aiAction === "NOCH WARTEN" &&
    row.aiConfidence >= 90 &&
    (
      (Number.isFinite(row.change1m) && row.change1m <= -7) ||
      (Number.isFinite(row.change5m) && row.change5m <= -10)
    );

  if (crash) return { type: "crash", priority: 90 + row.aiConfidence };
  return null;
}

function buildCardDiscordPayload(row, type) {
  const emoji = type === "buy" ? "🟢" : type === "sell" ? "💰" : "🚨";
  const titleAction = type === "crash" ? "NOCH WARTEN" : row.aiAction;
  const title = `${emoji} ${titleAction}: ${row.name || `EA ${row.eaId}`} (${row.overall})`;

  const fields = [
    { name: "Preis", value: `${discordNumber(row.price)} Coins`, inline: true },
    { name: "KI-Sicherheit", value: `${row.aiConfidence}%`, inline: true },
    { name: "Kartentyp", value: String(row.cardType || "-"), inline: true },
    { name: "1m / 5m / 15m", value: `${discordPct(row.change1m)} / ${discordPct(row.change5m)} / ${discordPct(row.change15m)}`, inline: false },
    { name: "24h Tief / Hoch", value: `${discordNumber(row.low24h)} / ${discordNumber(row.high24h)}`, inline: true },
    { name: "Rating-Markt", value: `${row.overall}er: ${String(row.ratingMarketTrend || "neutral").replaceAll("_", " ")}`, inline: true }
  ];

  if (type === "sell" && row.tracked) {
    fields.push({
      name: "Deine Position",
      value:
        `Kauf ${discordNumber(row.buyPrice)} × ${discordNumber(row.quantity || 1)} | ` +
        `Netto ${discordNumber(row.netProfitTotal)} Coins | ${discordPct(row.profitPercent)}`,
      inline: false
    });
  }

  fields.push({
    name: "KI-Grund",
    value: String(row.aiReason || "Keine Begründung verfügbar.").slice(0, 1000),
    inline: false
  });

  return {
    embeds: [{
      title,
      url: row.url || undefined,
      description:
        type === "buy"
          ? "Trader Brain sieht eine bestätigte Kauf-Trendwende."
          : type === "sell"
          ? "Eigener Bestand erreicht eine relevante Gewinn-/Ausstiegszone."
          : "Starker Abverkauf erkannt. Nicht blind in den Fall kaufen.",
      fields,
      footer: { text: "FC Trader Brain • automatische 60-Sekunden-Analyse" },
      timestamp: new Date().toISOString()
    }]
  };
}

function ratingDiscordAlertCandidate(stat) {
  if (!stat || stat.confidence < DISCORD_MIN_RATING_CONFIDENCE) return false;
  return ["KAUFZONE", "STARK STEIGEND", "STARK FALLEND"].includes(stat.marketSignal);
}

function buildRatingDiscordPayload(stat) {
  const emoji = stat.marketSignal === "KAUFZONE" ? "🟢" : stat.marketSignal === "STARK FALLEND" ? "🔻" : "🚀";
  return {
    embeds: [{
      title: `${emoji} ${stat.rating}ER MARKT: ${stat.marketSignal}`,
      description: String(stat.reason || "Rating-Markt-Signal erkannt."),
      fields: [
        { name: "Rating-Aktion", value: String(stat.marketAdvice), inline: true },
        { name: "Sicherheit", value: `${stat.confidence}%`, inline: true },
        { name: "Median", value: `${discordNumber(stat.medianPrice)} Coins`, inline: true },
        { name: "5m / 15m / 1h", value: `${discordPct(stat.change5m)} / ${discordPct(stat.change15m)} / ${discordPct(stat.change1h)}`, inline: false },
        { name: "Steigen / Fallen (5m)", value: `${Number(stat.risingPct5m || 0).toFixed(1)}% / ${Number(stat.fallingPct5m || 0).toFixed(1)}%`, inline: true },
        { name: "Nahe 24h-Tief", value: `${Number(stat.near24hLowPct || 0).toFixed(1)}%`, inline: true }
      ],
      footer: { text: "FC Trader Brain • Rating-Markt Intelligence" },
      timestamp: new Date().toISOString()
    }]
  };
}

async function processDiscordAlerts(rows, ratingStats) {
  if (!DISCORD_CONFIGURED) return;

  try {
    const candidates = [];

    for (const row of rows) {
      const candidate = cardDiscordAlertCandidate(row);
      if (candidate) candidates.push({ kind: "card", row, ...candidate });
    }

    for (const stat of Object.values(ratingStats || {})) {
      if (ratingDiscordAlertCandidate(stat)) {
        candidates.push({ kind: "rating", stat, type: "rating", priority: 120 + stat.confidence });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);
    let sentThisCycle = 0;

    for (const item of candidates) {
      if (sentThisCycle >= DISCORD_MAX_ALERTS_PER_CYCLE) break;

      if (item.kind === "card") {
        const row = item.row;
        const alertKey = `card:${row.eaId}`;
        const fingerprint = `${row.aiAction}|${Math.round((row.change5m ?? 0) * 10)}|${Math.round((row.change15m ?? 0) * 10)}`;
        const state = await getDiscordAlertState(alertKey);
        if (!discordAlertShouldSend(state, row.aiAction, row.price, row.aiConfidence, fingerprint)) continue;

        await sendDiscordPayload(buildCardDiscordPayload(row, item.type));
        await saveDiscordAlertState({
          alertKey,
          alertType: item.type,
          action: row.aiAction,
          price: row.price,
          confidence: row.aiConfidence,
          fingerprint
        });
        sentThisCycle++;
      } else {
        const stat = item.stat;
        const alertKey = `rating:${stat.rating}`;
        const fingerprint = `${stat.marketSignal}|${stat.marketAdvice}|${Math.round((stat.change5m ?? 0) * 10)}`;
        const state = await getDiscordAlertState(alertKey);
        if (!discordAlertShouldSend(state, stat.marketSignal, stat.medianPrice, stat.confidence, fingerprint)) continue;

        await sendDiscordPayload(buildRatingDiscordPayload(stat));
        await saveDiscordAlertState({
          alertKey,
          alertType: "rating",
          action: stat.marketSignal,
          price: stat.medianPrice,
          confidence: stat.confidence,
          fingerprint
        });
        sentThisCycle++;
      }
    }
  } catch (error) {
    lastDiscordError = String(error);
    console.error("Discord alerts error:", error);
  }
}

async function sendDiscordStartupMessage() {
  if (!DISCORD_CONFIGURED) return;

  try {
    const alertKey = "system:discord-connected";
    const state = await getDiscordAlertState(alertKey);
    const now = Date.now();
    if (state && now - state.lastSentAt < 12 * 60 * 60_000) return;

    await sendDiscordPayload({
      embeds: [{
        title: "✅ FC Trader Brain verbunden",
        description: "Automatische Trading-Alerts sind aktiv. Du musst die Webseite nicht geöffnet lassen.",
        fields: [
          { name: "Markt-Check", value: "alle 60 Sekunden", inline: true },
          { name: "Kaufalarm ab", value: `${DISCORD_MIN_BUY_CONFIDENCE}% KI-Sicherheit`, inline: true },
          { name: "Spam-Schutz", value: `${Math.round(DISCORD_ALERT_COOLDOWN_MS / 60_000)} Min. Cooldown`, inline: true }
        ],
        footer: { text: "FC Trading Intelligence v10.6.2" },
        timestamp: new Date().toISOString()
      }]
    });

    await saveDiscordAlertState({
      alertKey,
      alertType: "system",
      action: "CONNECTED",
      fingerprint: "v10.5.1"
    });
  } catch (error) {
    lastDiscordError = String(error);
    console.error("Discord startup message error:", error);
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

    await evaluateTraderSignalReliability(latestTradingRows);
    await automaticTraderBrain(latestTradingRows, built.brainWork);
    await processDiscordAlerts(latestTradingRows, latestRatingStats);
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
  if (!dbEnabled) return memoryTraderSignals.filter(signal => Date.now() - Number(signal.timestamp || 0) <= 6 * 60 * 60_000);

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
      market_confirmed,
      confirmation_details,
      target_ea_id,
      initial_reference_price,
      initial_reference_at,
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
    marketConfirmed: row.confirmation_details ? row.market_confirmed === true : null,
    confirmationDetails: row.confirmation_details || "",
    eaId: row.target_ea_id == null ? null : String(row.target_ea_id),
    initialReferencePrice: row.initial_reference_price == null ? null : Number(row.initial_reference_price),
    initialReferenceAt: row.initial_reference_at ? new Date(row.initial_reference_at).getTime() : null,
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

function reconstructPreviousPrice(currentPrice, changePctValue) {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(changePctValue) ||
    changePctValue <= -99
  ) {
    return null;
  }

  const divisor = 1 + changePctValue / 100;
  if (divisor <= 0) return null;

  return currentPrice / divisor;
}

function ratingWindowStats(cards, changeField) {
  const measured = cards.filter(card => Number.isFinite(card[changeField]));
  const moves = measured.map(card => card[changeField]);
  const rising = moves.filter(v => v >= 0.5).length;
  const falling = moves.filter(v => v <= -0.5).length;

  const previousPrices = measured
    .map(card => reconstructPreviousPrice(card.price, card[changeField]))
    .filter(Number.isFinite);

  return {
    measuredCards: measured.length,
    risingPct: moves.length
      ? Number(((rising / moves.length) * 100).toFixed(1))
      : 0,
    fallingPct: moves.length
      ? Number(((falling / moves.length) * 100).toFixed(1))
      : 0,
    medianMove: Number((median(moves) ?? 0).toFixed(2)),
    previousMedianPrice: median(previousPrices)
  };
}

function buildRatingStats(rows) {
  const byRating = new Map();

  for (const row of rows) {
    // Für Rating-/Fodder-Intelligence bewusst nur Base Rare verwenden.
    // Specials würden die Mediane und Marktbreite stark verzerren.
    if (row.cardType !== "Base Rare") continue;
    if (!byRating.has(row.overall)) byRating.set(row.overall, []);
    byRating.get(row.overall).push(row);
  }

  const stats = {};

  for (const [rating, cards] of byRating.entries()) {
    const currentMedian = median(cards.map(card => card.price));
    const w1m = ratingWindowStats(cards, "change1m");
    const w5m = ratingWindowStats(cards, "change5m");
    const w15m = ratingWindowStats(cards, "change15m");
    const w1h = ratingWindowStats(cards, "change1h");
    const w24h = ratingWindowStats(cards, "change24h");

    const nearLowCards = cards.filter(card =>
      Number.isFinite(card.distanceFrom24hLow) &&
      card.distanceFrom24hLow <= 5
    );

    const recoveryCards = cards.filter(card =>
      Number.isFinite(card.change5m) &&
      Number.isFinite(card.change15m) &&
      card.change5m >= 1 &&
      card.change15m >= 1
    );

    const nearLowPct = cards.length
      ? Number(((nearLowCards.length / cards.length) * 100).toFixed(1))
      : 0;

    const recoveryPct = cards.length
      ? Number(((recoveryCards.length / cards.length) * 100).toFixed(1))
      : 0;

    let trend = "neutral";
    if (w5m.risingPct >= 70 && w5m.medianMove >= 1) trend = "stark_steigend";
    else if (w5m.risingPct >= 55 || w5m.medianMove >= 0.6) trend = "steigend";
    else if (w5m.fallingPct >= 70 && w5m.medianMove <= -1) trend = "stark_fallend";
    else if (w5m.fallingPct >= 55 || w5m.medianMove <= -0.6) trend = "fallend";

    let marketSignal = "NEUTRAL";
    let marketAdvice = "BEOBACHTEN";
    let confidence = 58;
    let reason = "Kein klares Rating-Markt-Setup.";

    const enoughData = w5m.measuredCards >= 5;

    if (!enoughData) {
      marketSignal = "ZU WENIG DATEN";
      marketAdvice = "BEOBACHTEN";
      confidence = 35;
      reason = "Noch zu wenige Karten mit 5-Minuten-Historie für ein belastbares Rating-Signal.";
    } else if (
      w5m.fallingPct >= 70 &&
      w5m.medianMove <= -2
    ) {
      marketSignal = "STARK FALLEND";
      marketAdvice = "NOCH WARTEN";
      confidence = Math.min(
        95,
        Math.round(78 + Math.min(12, Math.abs(w5m.medianMove) * 2))
      );
      reason =
        `${w5m.fallingPct.toFixed(0)}% der ${rating}er fallen in 5m; ` +
        `Median-Bewegung ${w5m.medianMove.toFixed(2)}%. Breiter Abverkauf noch aktiv.`;
    } else if (
      nearLowPct >= 50 &&
      recoveryPct >= 45 &&
      w5m.risingPct >= 50 &&
      w5m.fallingPct < 40 &&
      w15m.medianMove >= 0.8 &&
      w15m.medianMove <= 10
    ) {
      marketSignal = "KAUFZONE";
      marketAdvice = "JETZT KAUFEN PRÜFEN";
      confidence = Math.min(
        95,
        Math.round(76 + Math.min(15, recoveryPct / 5))
      );
      reason =
        `${nearLowPct.toFixed(0)}% der ${rating}er liegen nahe ihrem 24h-Tief und ` +
        `${recoveryPct.toFixed(0)}% bestätigen 5m/15m-Erholung. Rating-Segment dreht.`;
    } else if (
      w5m.risingPct >= 70 &&
      w5m.medianMove >= 2
    ) {
      marketSignal = "STARK STEIGEND";

      if (w15m.medianMove >= 10) {
        marketAdvice = "NICHT HINTERHERKAUFEN";
        confidence = Math.min(
          95,
          Math.round(82 + Math.min(10, w5m.medianMove))
        );
        reason =
          `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
          `15m-Median bereits +${w15m.medianMove.toFixed(2)}%. FOMO-Risiko erhöht.`;
      } else {
        marketAdvice = "BEOBACHTEN";
        confidence = Math.min(
          95,
          Math.round(76 + Math.min(12, w5m.medianMove * 2))
        );
        reason =
          `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
          `5m-Median +${w5m.medianMove.toFixed(2)}%. Breite Aufwärtsbewegung bestätigt.`;
      }
    } else if (
      w5m.risingPct >= 60 ||
      w5m.medianMove >= 1
    ) {
      marketSignal = "STEIGEND";
      marketAdvice = "BEOBACHTEN";
      confidence = 68;
      reason =
        `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
        `5m-Median ${w5m.medianMove >= 0 ? "+" : ""}${w5m.medianMove.toFixed(2)}%.`;
    } else if (
      w5m.fallingPct >= 60 ||
      w5m.medianMove <= -1
    ) {
      marketSignal = "FÄLLT";
      marketAdvice = "NOCH WARTEN";
      confidence = 72;
      reason =
        `${w5m.fallingPct.toFixed(0)}% der ${rating}er fallen; ` +
        `5m-Median ${w5m.medianMove.toFixed(2)}%. Noch keine breite Trendwende.`;
    }

    stats[rating] = {
      rating,
      cardCount: cards.length,
      measuredCards: w5m.measuredCards,
      medianPrice: currentMedian,
      medianPrice1mAgo: w1m.previousMedianPrice,
      medianPrice5mAgo: w5m.previousMedianPrice,
      medianPrice15mAgo: w15m.previousMedianPrice,
      medianPrice1hAgo: w1h.previousMedianPrice,
      medianPrice24hAgo: w24h.previousMedianPrice,

      risingPct: w5m.risingPct,
      fallingPct: w5m.fallingPct,
      medianMove5m: w5m.medianMove,
      trend,

      change1m: w1m.medianMove,
      change5m: w5m.medianMove,
      change15m: w15m.medianMove,
      change1h: w1h.medianMove,
      change24h: w24h.medianMove,

      risingPct1m: w1m.risingPct,
      fallingPct1m: w1m.fallingPct,
      risingPct5m: w5m.risingPct,
      fallingPct5m: w5m.fallingPct,
      risingPct15m: w15m.risingPct,
      fallingPct15m: w15m.fallingPct,

      near24hLowPct: nearLowPct,
      recoveryPct,
      marketSignal,
      marketAdvice,
      confidence,
      reason
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

async function persistDiscordSignalMarketConfirmations(rows, brainWork) {
  if (!dbEnabled || !rows?.length || !brainWork?.size) return;

  const grouped = new Map();

  for (const row of rows) {
    const work = brainWork.get(String(row.eaId));
    const processedSignals = work?.confluence?.processedSignals || [];

    if (!processedSignals.length) continue;

    const hasMarketHistory = [
      row.change1m,
      row.change5m,
      row.change15m,
      row.change1h
    ].some(Number.isFinite);

    // Noch keine echte Historie vorhanden: Signal nicht voreilig als falsch speichern.
    if (!hasMarketHistory) continue;

    for (const signal of processedSignals) {
      if (!signal?.id) continue;

      const target = String(signal.playerOrRating || "").trim();
      const rating = /^\d{2}$/.test(target) ? Number(target) : null;
      const isRatingSignal = Number.isFinite(rating) && rating >= 75 && rating <= 99;

      // Rating-Signale wie "89er Fodder" nur mit Base-Rare-Karten
      // desselben Ratings prüfen. Specials und Commons verfälschen sonst den Fodder-Markt.
      if (isRatingSignal) {
        if (row.cardType !== "Base Rare" || row.overall !== rating) continue;
      }

      let group = grouped.get(signal.id);
      if (!group) {
        group = {
          id: signal.id,
          target,
          rating,
          isRatingSignal,
          checked: 0,
          confirmed: 0,
          details: new Set()
        };
        grouped.set(signal.id, group);
      }

      group.checked += 1;
      if (signal.marketConfirmation === true) group.confirmed += 1;
      if (signal.confirmationDetails) {
        group.details.add(String(signal.confirmationDetails));
      }
    }
  }

  for (const group of grouped.values()) {
    if (!group.checked) continue;

    const confirmationRatio = group.confirmed / group.checked;
    const marketConfirmed = confirmationRatio >= 0.5;
    const percent = Math.round(confirmationRatio * 100);

    const prefix = group.isRatingSignal
      ? `FUT.GG Rating-Check ${group.rating}er Base Rare`
      : `FUT.GG Spieler-Check ${group.target}`;

    const extraDetails = Array.from(group.details).slice(0, 3).join(" | ");
    const confirmationDetails = (
      `${prefix}: ${group.confirmed}/${group.checked} Marktprüfungen ` +
      `bestätigen das Trader-Signal (${percent}%).` +
      (extraDetails ? ` ${extraDetails}` : "")
    ).slice(0, 2000);

    await pool.query(
      `
        UPDATE fc_discord_signals
        SET
          market_confirmed = $2,
          confirmation_details = $3
        WHERE id = $1
          AND (
            market_confirmed IS DISTINCT FROM $2
            OR confirmation_details IS DISTINCT FROM $3
          )
      `,
      [group.id, marketConfirmed, confirmationDetails]
    );
  }
}

const TRADER_RELIABILITY_HORIZONS = [5, 15, 60, 360, 1440];
const TRADER_RELIABILITY_PRIOR_ACCURACY = 50;
const TRADER_RELIABILITY_PRIOR_STRENGTH = 8;
const TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH = 5;

function nearestTraderReliabilityHorizon(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;

  return TRADER_RELIABILITY_HORIZONS.reduce((best, candidate) => {
    const bestDistance = Math.abs(Math.log(best / minutes));
    const candidateDistance = Math.abs(Math.log(candidate / minutes));
    return candidateDistance < bestDistance ? candidate : best;
  }, TRADER_RELIABILITY_HORIZONS[0]);
}

function preferredTraderSignalHorizon(signal) {
  const timeframe = String(signal?.expectedTimeframe || "").toLowerCase().trim();

  if (/(morgen|tomorrow)/.test(timeframe)) return 1440;
  if (/(heute abend|tonight)/.test(timeframe)) return 360;
  if (/\b(heute|today)\b/.test(timeframe)) return 360;

  const minuteMatch = timeframe.match(/\b(\d{1,4})\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minuteMatch) {
    return nearestTraderReliabilityHorizon(Number(minuteMatch[1]));
  }

  const hourMatch = timeframe.match(/\b(\d{1,3})\s*(?:h|hr|hrs|hour|hours|stunde|stunden)\b/i);
  if (hourMatch) {
    return nearestTraderReliabilityHorizon(Number(hourMatch[1]) * 60);
  }

  switch (String(signal?.category || "").toUpperCase()) {
    case "SBC_FODDER":
      return 360;
    case "PROMO_CARDS":
      return 360;
    case "LEAKS_CONTENT":
      return 1440;
    case "SHORT_TERM_FLIPS":
    default:
      return 60;
  }
}

function traderReliabilityOutcomeWeight(signal, horizonMinutes) {
  const preferred = preferredTraderSignalHorizon(signal);
  const preferredIndex = TRADER_RELIABILITY_HORIZONS.indexOf(preferred);
  const horizonIndex = TRADER_RELIABILITY_HORIZONS.indexOf(Number(horizonMinutes));

  if (preferredIndex < 0 || horizonIndex < 0) return 0.25;

  const distance = Math.abs(preferredIndex - horizonIndex);

  if (distance === 0) return 1.0;
  if (distance === 1) return 0.6;
  if (distance === 2) return 0.3;
  return 0.1;
}

function smoothedTraderAccuracy(outcomes, priorStrength) {
  const clean = (outcomes || []).filter(item =>
    Number.isFinite(item.weight) &&
    item.weight > 0 &&
    typeof item.wasCorrect === "boolean"
  );

  const totalWeight = clean.reduce((sum, item) => sum + item.weight, 0);
  const weightedCorrect = clean.reduce(
    (sum, item) => sum + (item.wasCorrect ? item.weight : 0),
    0
  );

  const score =
    (
      TRADER_RELIABILITY_PRIOR_ACCURACY * priorStrength +
      weightedCorrect * 100
    ) /
    (priorStrength + totalWeight);

  return Number(score.toFixed(2));
}

async function loadTraderSignalsForReliability() {
  if (!dbEnabled) return [];

  const result = await pool.query(`
    SELECT
      id,
      source,
      player_or_rating,
      target_ea_id,
      call,
      category,
      initial_reference_price,
      initial_reference_at,
      created_at
    FROM fc_discord_signals
    WHERE created_at >= NOW() - INTERVAL '30 hours'
    ORDER BY created_at ASC
  `);

  return result.rows.map(row => ({
    id: row.id,
    source: row.source,
    playerOrRating: row.player_or_rating,
    eaId: row.target_ea_id == null ? null : String(row.target_ea_id),
    call: row.call,
    category: row.category || "SHORT_TERM_FLIPS",
    initialReferencePrice: row.initial_reference_price == null ? null : Number(row.initial_reference_price),
    initialReferenceAt: row.initial_reference_at ? new Date(row.initial_reference_at).getTime() : null,
    createdAt: new Date(row.created_at).getTime()
  }));
}

function traderSignalEaIds(signal, rows) {
  const target = String(signal?.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;

  if (Number.isFinite(rating) && rating >= 75 && rating <= 99) {
    return rows
      .filter(row => row.overall === rating && row.cardType === "Base Rare" && Number.isFinite(row.eaId))
      .map(row => String(row.eaId));
  }

  if (signal?.eaId) return [String(signal.eaId)];

  const lower = target.toLowerCase();
  return rows
    .filter(row => String(row.name || "").toLowerCase() === lower && Number.isFinite(row.eaId))
    .map(row => String(row.eaId));
}

async function traderSignalReferencePriceAt(signal, rows, atMs) {
  const ids = [...new Set(traderSignalEaIds(signal, rows))];
  if (!ids.length) return null;

  const historical = await lookupDb(ids, atMs);
  const prices = ids
    .map(id => historical.get(String(id)))
    .filter(Number.isFinite);

  if (prices.length) return median(prices);

  // Für sehr neue Signale darf der aktuelle Preis als Fallback dienen.
  if (Math.abs(Date.now() - atMs) <= 2 * 60_000) {
    const currentById = new Map(rows.map(row => [String(row.eaId), row.price]));
    const currentPrices = ids.map(id => currentById.get(String(id))).filter(Number.isFinite);
    if (currentPrices.length) return median(currentPrices);
  }

  return null;
}

async function ensureFrozenTraderSignalReference(signal, rows) {
  if (!dbEnabled || !signal?.id) return null;

  if (Number.isFinite(signal.initialReferencePrice) && signal.initialReferencePrice > 0) {
    return Math.round(signal.initialReferencePrice);
  }

  // Migration für Signale, die vor dem eingefrorenen Einstiegspreis angelegt wurden:
  // Falls bereits ein Outcome existiert, nehmen wir dessen allerersten Einstiegspreis.
  // Dadurch bleiben 5m, 15m, 1h, 6h und 24h garantiert auf derselben Basis.
  const previousOutcome = await pool.query(`
    SELECT initial_price
    FROM fc_trader_signal_outcomes
    WHERE signal_id = $1
    ORDER BY horizon_minutes ASC, evaluated_at ASC
    LIMIT 1
  `, [signal.id]);

  let frozenPrice = previousOutcome.rowCount
    ? Number(previousOutcome.rows[0].initial_price)
    : null;

  if (!Number.isFinite(frozenPrice) || frozenPrice <= 0) {
    frozenPrice = await traderSignalReferencePriceAt(signal, rows, signal.createdAt);
  }

  if (!Number.isFinite(frozenPrice) || frozenPrice <= 0) return null;

  frozenPrice = Math.round(frozenPrice);
  const frozenAt = new Date(signal.createdAt).toISOString();

  await pool.query(`
    UPDATE fc_discord_signals
    SET
      initial_reference_price = COALESCE(initial_reference_price, $2),
      initial_reference_at = COALESCE(initial_reference_at, $3)
    WHERE id = $1
  `, [signal.id, frozenPrice, frozenAt]);

  signal.initialReferencePrice = frozenPrice;
  signal.initialReferenceAt = signal.createdAt;
  return frozenPrice;
}

async function normalizeTraderSignalOutcomesToFrozenReference(signal, frozenPrice) {
  if (!dbEnabled || !signal?.id || !Number.isFinite(frozenPrice) || frozenPrice <= 0) return 0;

  const result = await pool.query(`
    SELECT horizon_minutes, observed_price, initial_price
    FROM fc_trader_signal_outcomes
    WHERE signal_id = $1
  `, [signal.id]);

  let corrected = 0;

  for (const row of result.rows) {
    const observedPrice = Number(row.observed_price);
    if (!Number.isFinite(observedPrice) || observedPrice <= 0) continue;

    const evaluation = evaluateTraderCall(signal.call, frozenPrice, observedPrice);
    const oldInitial = Number(row.initial_price);

    // Auch bestehende v10.6/v10.6.1-Outcomes werden auf denselben Einstiegspreis
    // zurückgerechnet, damit die Lernhistorie nicht mit wechselnden Basen arbeitet.
    const update = await pool.query(`
      UPDATE fc_trader_signal_outcomes
      SET
        initial_price = $3,
        gross_change_pct = $4,
        net_roi_after_tax_pct = $5,
        was_correct = $6,
        evaluation_reason = $7
      WHERE signal_id = $1
        AND horizon_minutes = $2
        AND (
          initial_price IS DISTINCT FROM $3
          OR gross_change_pct IS DISTINCT FROM $4
          OR net_roi_after_tax_pct IS DISTINCT FROM $5
          OR was_correct IS DISTINCT FROM $6
          OR evaluation_reason IS DISTINCT FROM $7
        )
    `, [
      signal.id,
      Number(row.horizon_minutes),
      frozenPrice,
      Number(evaluation.grossChangePct.toFixed(4)),
      Number(evaluation.netRoiAfterTaxPct.toFixed(4)),
      evaluation.wasCorrect,
      evaluation.reason
    ]);

    if (update.rowCount && oldInitial !== frozenPrice) corrected += 1;
  }

  return corrected;
}

function evaluateTraderCall(call, initialPrice, observedPrice) {
  const grossChangePct = ((observedPrice - initialPrice) / initialPrice) * 100;
  const netRoiAfterTaxPct = (((observedPrice * 0.95) - initialPrice) / initialPrice) * 100;
  const normalizedCall = String(call || "").toUpperCase();

  if (normalizedCall === "KAUFEN") {
    const wasCorrect = netRoiAfterTaxPct > 0;
    return {
      wasCorrect,
      grossChangePct,
      netRoiAfterTaxPct,
      reason: wasCorrect
        ? `KAUFEN war nach 5% EA-Steuer profitabel (${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI).`
        : `KAUFEN war nach 5% EA-Steuer noch nicht profitabel (${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI).`
    };
  }

  if (normalizedCall === "VERKAUFEN") {
    const wasCorrect = observedPrice < initialPrice;
    return {
      wasCorrect,
      grossChangePct,
      netRoiAfterTaxPct,
      reason: wasCorrect
        ? `VERKAUFEN war richtig: der Referenzpreis fiel danach um ${Math.abs(grossChangePct).toFixed(2)}%.`
        : `VERKAUFEN war zu früh: der Referenzpreis stieg danach um ${Math.max(0, grossChangePct).toFixed(2)}%.`
    };
  }

  // WARTEN wird daran gemessen, ob ein sofortiger Kauf bis zum Prüfzeitpunkt
  // nach EA-Steuer keinen positiven Netto-ROI gebracht hätte.
  const wasCorrect = netRoiAfterTaxPct <= 0;
  return {
    wasCorrect,
    grossChangePct,
    netRoiAfterTaxPct,
    reason: wasCorrect
      ? `WARTEN war sinnvoll: ein Sofortkauf wäre nach Steuer bei ${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI.`
      : `WARTEN verpasste einen profitablen Move von ${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI nach Steuer.`
  };
}

async function refreshTraderReliabilityProfiles() {
  if (!dbEnabled) return;

  const result = await pool.query(`
    SELECT
      s.source,
      s.category,
      s.expected_timeframe,
      o.horizon_minutes,
      o.was_correct
    FROM fc_trader_signal_outcomes o
    JOIN fc_discord_signals s ON s.id = o.signal_id
    ORDER BY s.source, o.evaluated_at ASC
  `);

  const bySource = new Map();

  for (const row of result.rows) {
    const source = String(row.source || "");
    if (!source) continue;

    if (!bySource.has(source)) {
      bySource.set(source, []);
    }

    const signalLike = {
      category: row.category || "SHORT_TERM_FLIPS",
      expectedTimeframe: row.expected_timeframe || ""
    };

    bySource.get(source).push({
      category: signalLike.category,
      horizonMinutes: Number(row.horizon_minutes),
      wasCorrect: row.was_correct === true,
      weight: traderReliabilityOutcomeWeight(signalLike, Number(row.horizon_minutes))
    });
  }

  for (const [source, outcomes] of bySource.entries()) {
    const overallAccuracy = smoothedTraderAccuracy(
      outcomes,
      TRADER_RELIABILITY_PRIOR_STRENGTH
    );

    const categoryAccuracy = category => {
      const selected = outcomes.filter(item => item.category === category);
      if (!selected.length) return null;
      return smoothedTraderAccuracy(
        selected,
        TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH
      );
    };

    const evaluatedOutcomes = outcomes.length;
    const effectiveWeight = outcomes.reduce((sum, item) => sum + item.weight, 0);

    let badge = "Unbewiesen";
    if (effectiveWeight >= 15 && overallAccuracy >= 80) badge = "Sehr stark";
    else if (effectiveWeight >= 8 && overallAccuracy >= 70) badge = "Stark";
    else if (effectiveWeight >= 8 && overallAccuracy < 40) badge = "Schwach";
    else if (effectiveWeight >= 8) badge = "Beobachten";

    await pool.query(`
      UPDATE fc_trader_profiles
      SET
        overall_accuracy = $2,
        accuracy_sbc_fodder = COALESCE($3, accuracy_sbc_fodder),
        accuracy_promo_cards = COALESCE($4, accuracy_promo_cards),
        accuracy_short_flips = COALESCE($5, accuracy_short_flips),
        accuracy_leaks = COALESCE($6, accuracy_leaks),
        reputation_badge = $7,
        notes = $8,
        updated_at = NOW()
      WHERE source = $1
    `, [
      source,
      overallAccuracy,
      categoryAccuracy("SBC_FODDER"),
      categoryAccuracy("PROMO_CARDS"),
      categoryAccuracy("SHORT_TERM_FLIPS"),
      categoryAccuracy("LEAKS_CONTENT"),
      badge,
      `v10.6.2 gewichtete Reliability: ${evaluatedOutcomes} Outcomes, effektives Gewicht ${effectiveWeight.toFixed(2)}, Bayes-Startbasis 50%.`
    ]);
  }
}

async function evaluateTraderSignalReliability(rows) {
  if (!dbEnabled || !rows?.length) return 0;

  const signals = await loadTraderSignalsForReliability();
  if (!signals.length) return 0;

  const existingResult = await pool.query(`
    SELECT signal_id, horizon_minutes
    FROM fc_trader_signal_outcomes
    WHERE signal_id = ANY($1::varchar[])
  `, [signals.map(signal => signal.id)]);

  const existing = new Set(
    existingResult.rows.map(row => `${row.signal_id}:${Number(row.horizon_minutes)}`)
  );

  let inserted = 0;
  const now = Date.now();

  for (const signal of signals) {
    const initialPrice = await ensureFrozenTraderSignalReference(signal, rows);
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) continue;

    await normalizeTraderSignalOutcomesToFrozenReference(signal, initialPrice);

    for (const horizonMinutes of TRADER_RELIABILITY_HORIZONS) {
      const key = `${signal.id}:${horizonMinutes}`;
      if (existing.has(key)) continue;

      const targetAt = signal.createdAt + horizonMinutes * 60_000;
      if (now < targetAt) continue;

      const observedPrice = await traderSignalReferencePriceAt(signal, rows, targetAt);
      if (!Number.isFinite(observedPrice) || observedPrice <= 0) continue;

      const evaluation = evaluateTraderCall(signal.call, initialPrice, observedPrice);

      const result = await pool.query(`
        INSERT INTO fc_trader_signal_outcomes (
          signal_id,
          horizon_minutes,
          initial_price,
          observed_price,
          gross_change_pct,
          net_roi_after_tax_pct,
          was_correct,
          evaluation_reason,
          evaluated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (signal_id, horizon_minutes) DO NOTHING
      `, [
        signal.id,
        horizonMinutes,
        Math.round(initialPrice),
        Math.round(observedPrice),
        Number(evaluation.grossChangePct.toFixed(4)),
        Number(evaluation.netRoiAfterTaxPct.toFixed(4)),
        evaluation.wasCorrect,
        evaluation.reason
      ]);

      if (result.rowCount) {
        inserted += 1;
        existing.add(key);
      }
    }
  }

  // v10.6.2: Profile in jedem Zyklus neu berechnen.
  // Dadurch werden auch bereits vorhandene v10.6-Outcomes sofort
  // mit Zeitfenster-Gewichtung und 50%-Startbasis korrigiert.
  await refreshTraderReliabilityProfiles();
  return inserted;
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

function normalizeDecisionForPosition(row, decision) {
  if (!decision || decision.action !== "VERKAUF PRÜFEN") return decision;

  const profit = Number.isFinite(row.profitPercent) ? row.profitPercent : null;
  const nearHigh =
    Number.isFinite(row.high24h) &&
    row.high24h > 0 &&
    row.price >= row.high24h * 0.97;

  const strongRun =
    (Number.isFinite(row.change15m) && row.change15m >= 10) ||
    (Number.isFinite(row.change1h) && row.change1h >= 12) ||
    (Number.isFinite(row.change24h) && row.change24h >= 18);

  const momentumCooling =
    (Number.isFinite(row.change1m) && row.change1m < 0) ||
    (
      Number.isFinite(row.change1m) &&
      Number.isFinite(row.change5m) &&
      row.change1m <= 0.5 &&
      row.change5m <= 3
    ) ||
    (
      Number.isFinite(row.change5m) &&
      Number.isFinite(row.change15m) &&
      row.change5m <= row.change15m - 2
    );

  // Verkaufshinweise sind nur für Karten sinnvoll, die der Nutzer wirklich besitzt.
  if (!row.tracked) {
    return {
      ...decision,
      action: "NICHT KAUFEN",
      confidence: Math.max(80, Math.min(92, decision.confidence ?? 82)),
      risk: "hoch",
      market_state: "stark gestiegen / Einstieg unattraktiv",
      reason: "Karte notiert nach starkem Anstieg nahe dem 24h-Hoch. Ohne eigenen Bestand kein Verkaufssignal: nicht hinterherkaufen, Rücksetzer abwarten.",
      recommended_horizon: "Rücksetzer abwarten"
    };
  }

  // Kein echter Netto-Gewinn nach EA-Steuer -> nicht vorschnell verkaufen.
  if (profit === null || profit < 6) {
    return {
      ...decision,
      action: "HALTEN",
      confidence: 78,
      risk: "mittel",
      market_state: "Position noch ohne ausreichende Gewinnmarge",
      reason: profit === null
        ? "Eigener Bestand erkannt, aber die Netto-Gewinnmarge ist noch nicht belastbar. Position weiter beobachten."
        : `Nach 5% EA-Steuer liegt der Netto-Gewinn erst bei ${profit.toFixed(2)}%. Für ein Verkaufssignal ist die Marge noch zu klein.`,
      recommended_horizon: "Weiter beobachten"
    };
  }

  // Sehr guter Nettogewinn nahe Widerstand: Gewinnmitnahme aktiv prüfen.
  if (profit >= 12 && nearHigh) {
    return {
      ...decision,
      confidence: Math.max(88, Math.min(95, decision.confidence ?? 88)),
      reason: `Eigener Bestand liegt nach 5% EA-Steuer bei +${profit.toFixed(2)}% Netto-Gewinn und notiert nahe dem 24h-Hoch. Gewinnmitnahme aktiv prüfen.`
    };
  }

  // Solider Gewinn reicht nur dann für Verkauf, wenn der starke Lauf sichtbar abkühlt.
  if (profit >= 6 && nearHigh && strongRun && momentumCooling) {
    return {
      ...decision,
      confidence: Math.max(84, Math.min(93, decision.confidence ?? 86)),
      reason: `Eigener Bestand liegt nach 5% EA-Steuer bei +${profit.toFixed(2)}% Netto-Gewinn. Preis ist nahe dem 24h-Hoch und das kurzfristige Momentum kühlt ab: Verkauf prüfen.`
    };
  }

  return {
    ...decision,
    action: "HALTEN",
    confidence: 82,
    risk: "niedrig",
    market_state: "Gewinnposition mit weiter laufendem Momentum",
    reason: `Eigener Bestand liegt bei +${profit.toFixed(2)}% Netto-Gewinn, aber der Aufwärtstrend ist noch nicht klar ausgelaufen. Weiter halten und Momentum beobachten.`,
    recommended_horizon: "Momentum weiter beobachten"
  };
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
    const rawDecision = baseDecisionFromQuant(quant, confluence);
    const decision = normalizeDecisionForPosition(row, rawDecision);
    applyDecisionToRow(row, decision);

    row.ratingMarketTrend = rating.trend;
    row.ratingMarketRisingPct = rating.risingPct;
    row.ratingMarketFallingPct = rating.fallingPct;

    brainWork.set(String(row.eaId), { input, quant, confluence });
  }

  await persistDiscordSignalMarketConfirmations(rows, brainWork);

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
      const rawDecision = await generateAiTraderDecision(
        geminiCandidate.work.input,
        geminiCandidate.work.quant,
        geminiCandidate.work.confluence
      );

      const decision = normalizeDecisionForPosition(geminiCandidate.row, rawDecision);
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
    version: "10.6.2-frozen-signal-entry",
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
      ratingIntelligence: "GET /api/ratings-intelligence",
      traderBrainHistory: "GET /api/trader-brain/feedback/history",
      geminiHealth: "GET /api/gemini-health",
      discordStatus: "GET /api/discord/status",
      traderReliabilityStatus: "GET /api/trader-reliability/status",
      health: "GET /health"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "10.6.2-frozen-signal-entry",
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
    discord: {
      configured: DISCORD_CONFIGURED,
      channelConfigured: Boolean(DISCORD_ALERT_CHANNEL_ID),
      tokenConfigured: Boolean(DISCORD_BOT_TOKEN),
      gatewayReady: discordClientReady,
      botTag: discordBotTag,
      guildCount: discordGuildCount,
      resolvedChannelId: discordResolvedChannelId,
      resolvedChannelName: discordResolvedChannelName,
      traderSignalChannelConfigured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
      traderSignalChannelId: traderSignalResolvedChannelId,
      traderSignalChannelName: traderSignalResolvedChannelName,
      traderSignalsReceived,
      traderSignalsAccepted,
      traderSignalsIgnored,
      lastTraderSignalAt,
      lastTraderSignalError,
      alertsSent: discordAlertsSent,
      lastSendAt: lastDiscordSendAt,
      lastError: lastDiscordError
    },
    now: new Date().toISOString()
  });
});

app.get("/api/trader-signals/status", async (req, res) => {
  try {
    const recent = await loadRecentDiscordSignals();
    return res.json({
      configured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
      channelId: traderSignalResolvedChannelId || TRADER_SIGNAL_CHANNEL_ID || null,
      channelName: traderSignalResolvedChannelName,
      received: traderSignalsReceived,
      accepted: traderSignalsAccepted,
      ignored: traderSignalsIgnored,
      lastSignalAt: lastTraderSignalAt,
      lastError: lastTraderSignalError,
      recentSignals: recent.slice(0, 25)
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

app.get("/api/trader-reliability/status", async (req, res) => {
  try {
    if (!dbEnabled) {
      return res.json({ enabled: false, reason: "PostgreSQL ist nicht aktiv." });
    }

    const [profiles, outcomes] = await Promise.all([
      pool.query(`
        SELECT
          source,
          display_name,
          overall_accuracy,
          total_signals,
          accuracy_sbc_fodder,
          accuracy_promo_cards,
          accuracy_short_flips,
          accuracy_leaks,
          reputation_badge,
          updated_at
        FROM fc_trader_profiles
        ORDER BY overall_accuracy DESC, total_signals DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT
          o.signal_id,
          s.source,
          s.player_or_rating,
          s.call,
          s.category,
          s.expected_timeframe,
          o.horizon_minutes,
          o.initial_price,
          o.observed_price,
          o.gross_change_pct,
          o.net_roi_after_tax_pct,
          o.was_correct,
          o.evaluation_reason,
          o.evaluated_at
        FROM fc_trader_signal_outcomes o
        JOIN fc_discord_signals s ON s.id = o.signal_id
        ORDER BY o.evaluated_at DESC
        LIMIT 100
      `)
    ]);

    return res.json({
      enabled: true,
      version: "10.6.2-frozen-signal-entry",
      method: {
        priorAccuracy: TRADER_RELIABILITY_PRIOR_ACCURACY,
        priorStrength: TRADER_RELIABILITY_PRIOR_STRENGTH,
        categoryPriorStrength: TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH,
        note: "Zeitfenster werden passend zu Erwartung/Kategorie gewichtet; der Einstiegspreis wird pro Signal einmal eingefroren und für 5m/15m/1h/6h/24h identisch verwendet."
      },
      horizonsMinutes: TRADER_RELIABILITY_HORIZONS,
      profiles: profiles.rows.map(row => ({
        source: row.source,
        displayName: row.display_name,
        overallAccuracy: Number(row.overall_accuracy || 50),
        totalSignals: Number(row.total_signals || 0),
        categoryAccuracy: {
          SBC_FODDER: Number(row.accuracy_sbc_fodder || 50),
          PROMO_CARDS: Number(row.accuracy_promo_cards || 50),
          SHORT_TERM_FLIPS: Number(row.accuracy_short_flips || 50),
          LEAKS_CONTENT: Number(row.accuracy_leaks || 50)
        },
        reputationBadge: row.reputation_badge,
        updatedAt: row.updated_at
      })),
      recentOutcomes: outcomes.rows.map(row => ({
        signalId: row.signal_id,
        source: row.source,
        playerOrRating: row.player_or_rating,
        call: row.call,
        category: row.category,
        expectedTimeframe: row.expected_timeframe || "",
        preferredHorizonMinutes: preferredTraderSignalHorizon({
          category: row.category,
          expectedTimeframe: row.expected_timeframe
        }),
        horizonMinutes: Number(row.horizon_minutes),
        reliabilityWeight: traderReliabilityOutcomeWeight(
          {
            category: row.category,
            expectedTimeframe: row.expected_timeframe
          },
          Number(row.horizon_minutes)
        ),
        initialPrice: Number(row.initial_price),
        observedPrice: Number(row.observed_price),
        grossChangePct: Number(row.gross_change_pct),
        netRoiAfterTaxPct: Number(row.net_roi_after_tax_pct),
        wasCorrect: row.was_correct,
        reason: row.evaluation_reason,
        evaluatedAt: row.evaluated_at
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

app.get("/api/discord/status", (req, res) => {
  res.json({
    configured: DISCORD_CONFIGURED,
    channelConfigured: Boolean(DISCORD_ALERT_CHANNEL_ID),
    tokenConfigured: Boolean(DISCORD_BOT_TOKEN),
    gatewayReady: discordClientReady,
    botTag: discordBotTag,
    guildCount: discordGuildCount,
    resolvedChannelId: discordResolvedChannelId,
    resolvedChannelName: discordResolvedChannelName,
    traderSignalChannelConfigured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
    traderSignalChannelId: traderSignalResolvedChannelId,
    traderSignalChannelName: traderSignalResolvedChannelName,
    traderSignalsReceived,
    traderSignalsAccepted,
    traderSignalsIgnored,
    lastTraderSignalAt,
    lastTraderSignalError,
    alertsSent: discordAlertsSent,
    lastSendAt: lastDiscordSendAt,
    lastError: lastDiscordError,
    cooldownMinutes: Math.round(DISCORD_ALERT_COOLDOWN_MS / 60_000),
    maxAlertsPerCycle: DISCORD_MAX_ALERTS_PER_CYCLE,
    minBuyConfidence: DISCORD_MIN_BUY_CONFIDENCE,
    minSellConfidence: DISCORD_MIN_SELL_CONFIDENCE,
    minRatingConfidence: DISCORD_MIN_RATING_CONFIDENCE
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
      ratingIntelligence: Object.values(latestRatingStats)
        .sort((a, b) => b.rating - a.rating),
      ratingAlerts: Object.values(latestRatingStats)
        .filter(r => !["NEUTRAL", "ZU WENIG DATEN"].includes(r.marketSignal)).length,
      geminiQuota: getGeminiQuotaInfo(),
      discord: {
        configured: DISCORD_CONFIGURED,
        alertsSent: discordAlertsSent,
        lastSendAt: lastDiscordSendAt,
        lastError: lastDiscordError
      },
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

app.get("/api/ratings-intelligence", (req, res) => {
  const priority = {
    "KAUFZONE": 6,
    "STARK FALLEND": 5,
    "STARK STEIGEND": 4,
    "FÄLLT": 3,
    "STEIGEND": 2,
    "NEUTRAL": 1,
    "ZU WENIG DATEN": 0
  };

  const ratings = Object.values(latestRatingStats)
    .sort((a, b) => {
      const signalDiff =
        (priority[b.marketSignal] ?? 0) -
        (priority[a.marketSignal] ?? 0);

      if (signalDiff !== 0) return signalDiff;
      return b.rating - a.rating;
    });

  res.json({
    ok: true,
    refreshSeconds: 60,
    source: "FUT.GG Base Rare",
    ratings,
    updatedAt: lastMonitorAt || new Date().toISOString()
  });
});

app.get("/api/trader-brain/status", (req, res) => {
  res.json({
    ok: true,
    version: "10.6.2-frozen-signal-entry",
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

  .rating-box {
    background: #161616;
    border: 1px solid #252525;
    border-radius: 10px;
    margin-bottom: 14px;
    overflow: hidden;
  }

  .rating-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: #1b1b1b;
    border-bottom: 1px solid #292929;
  }

  .rating-title {
    font-weight: 700;
    font-size: 16px;
  }

  .rating-sub {
    color: #999;
    font-size: 12px;
  }

  .rating-scroll {
    max-height: 330px;
    overflow: auto;
  }

  .rating-table {
    font-size: 12px;
  }

  .rating-table th,
  .rating-table td {
    padding: 7px 8px;
  }

  .rating-signal {
    font-weight: 800;
  }

  .rating-hot {
    background: #1b1b1b;
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

  <div class="rating-box">
    <div class="rating-head">
      <div>
        <div class="rating-title">Rating-Markt Intelligence</div>
        <div class="rating-sub">Base Rare • kompletter Rating-Markt • automatisch alle 60 Sekunden</div>
      </div>
      <div id="ratingSummary" class="rating-sub">Lade Rating-Märkte…</div>
    </div>

    <div class="rating-scroll">
      <table class="rating-table">
        <thead>
          <tr>
            <th>GES</th>
            <th>Median</th>
            <th>1m</th>
            <th>5m</th>
            <th>15m</th>
            <th>1h</th>
            <th>Steigen 5m</th>
            <th>Fallen 5m</th>
            <th>Nahe 24h-Tief</th>
            <th>Signal</th>
            <th>Rating-Aktion</th>
            <th>Sicherheit</th>
            <th>Grund</th>
          </tr>
        </thead>
        <tbody id="ratingRows"></tbody>
      </table>
    </div>
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
let allRatingRows = [];
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


function renderRatings() {
  const body = document.getElementById("ratingRows");
  const summary = document.getElementById("ratingSummary");

  if (!body || !summary) return;

  const priority = {
    "KAUFZONE": 6,
    "STARK FALLEND": 5,
    "STARK STEIGEND": 4,
    "FÄLLT": 3,
    "STEIGEND": 2,
    "NEUTRAL": 1,
    "ZU WENIG DATEN": 0
  };

  const rows = [...allRatingRows].sort((a, b) => {
    const p =
      (priority[b.marketSignal] ?? 0) -
      (priority[a.marketSignal] ?? 0);

    if (p !== 0) return p;
    return b.rating - a.rating;
  });

  body.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");

    if (
      row.marketSignal === "KAUFZONE" ||
      row.marketSignal === "STARK FALLEND" ||
      row.marketSignal === "STARK STEIGEND"
    ) {
      tr.className = "rating-hot";
    }

    tr.innerHTML = \`
      <td class="strong">\${row.rating}</td>
      <td>\${fmt(row.medianPrice)}</td>
      <td>\${pctCell(row.change1m)}</td>
      <td>\${pctCell(row.change5m)}</td>
      <td>\${pctCell(row.change15m)}</td>
      <td>\${pctCell(row.change1h)}</td>
      <td>\${Number(row.risingPct5m ?? 0).toFixed(1)}%</td>
      <td>\${Number(row.fallingPct5m ?? 0).toFixed(1)}%</td>
      <td>\${Number(row.near24hLowPct ?? 0).toFixed(1)}%</td>
      <td class="rating-signal">\${row.marketSignal}</td>
      <td class="strong">\${row.marketAdvice}</td>
      <td>\${row.confidence}%</td>
      <td style="text-align:left; white-space:normal; min-width:320px">\${row.reason}</td>
    \`;

    body.appendChild(tr);
  }

  const alerts = rows.filter(
    row => !["NEUTRAL", "ZU WENIG DATEN"].includes(row.marketSignal)
  ).length;

  summary.textContent =
    rows.length +
    " Ratings • " +
    alerts +
    " aktive Rating-Signale";
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

    allRatingRows =
      json.ratingIntelligence || [];

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
        " • Rating-Signale: " +
        (json.ratingAlerts ?? 0) +
        " • Gemini: " +
        (json.geminiQuota?.usedToday ?? 0) +
        "/" +
        (json.geminiQuota?.dailyBudget ?? 15) +
        " • Discord: " +
        (json.discord?.configured ? "AN" : "AUS") +
        " • Aktualisiert " +
        new Date(
          json.updatedAt
        ).toLocaleTimeString(
          "de-DE"
        );

    renderRatings();
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

  if (DISCORD_CONFIGURED) {
    await initDiscordBot();
  }

  await sendDiscordStartupMessage();
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
      `FC Trading Intelligence v10.6.2 Frozen Signal Entry running on ${port}`
    );

    startMonitoring();
  }
);