import express from "express";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

export const MARKET_EVIDENCE_VERSION = "1.0.0";
const BUILD = "10.69.3";

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


const FUTWIZ_POPULAR_URL = "https://www.futwiz.com/popular/";
const FUTWIZ_BASE = "https://www.futwiz.com";
// v10.69.3 legacy collector code below is disabled and never called.
let futwizStatus = {
  status: "IDLE",
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  popularCards: 0,
  salesCards: 0,
  salesRows: 0,
  blocked: false
};

let groundedStatus = {
  status: "IDLE",
  configured: false,
  model: null,
  callsToday: 0,
  dailyBudget: 3,
  lastBudgetDate: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastBatch: [],
  lastGroundingTitles: [],
  lastGroundingUrls: [],
  cardsReturned: 0,
  cardsWithGames: 0,
  cardsWithSales: 0,
  cardsWithPopularRank: 0
};
const groundedCardCooldown = new Map();

function geminiApiKey() {
  return clean(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    "",
    2000
  );
}

function resetGroundedBudgetIfNeeded() {
  const date = new Date().toISOString().slice(0, 10);
  if (groundedStatus.lastBudgetDate !== date) {
    groundedStatus.lastBudgetDate = date;
    groundedStatus.callsToday = 0;
  }
  groundedStatus.dailyBudget = Math.max(
    1,
    Math.min(12, Number(process.env.MARKET_EVIDENCE_GEMINI_DAILY_BUDGET || 3))
  );
  return {
    used: groundedStatus.callsToday,
    budget: groundedStatus.dailyBudget,
    remaining: Math.max(0, groundedStatus.dailyBudget - groundedStatus.callsToday)
  };
}

function safeJsonFromModel(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch {}
  }
  return null;
}

function groundingMeta(response) {
  const meta = response?.candidates?.[0]?.groundingMetadata || {};
  const chunks = Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
  const web = chunks.map(chunk => chunk?.web).filter(Boolean);
  const titles = web.map(x => clean(x?.title, 300)).filter(Boolean);
  const urls = web.map(x => clean(x?.uri, 1000)).filter(Boolean);
  return { titles, urls };
}

function trustedGrounding(meta) {
  const hay = [...(meta?.titles || []), ...(meta?.urls || [])].join(" ").toLowerCase();
  return hay.includes("futbin");
}

function candidateRowsForGrounding(liveRows) {
  const cooldownMs = Math.max(
    60,
    Number(process.env.MARKET_EVIDENCE_GEMINI_CARD_COOLDOWN_MIN || 720)
  ) * 60_000;
  const now = Date.now();

  return (Array.isArray(liveRows) ? liveRows : [])
    .filter(row => Number(row?.overall || 0) >= 82 && Number(row?.price || 0) > 0 && row?.name && row?.eaId)
    .filter(row => {
      const last = groundedCardCooldown.get(String(row.eaId)) || 0;
      return !last || now - last >= cooldownMs;
    })
    .sort((a, b) =>
      Number(b?.tracked || false) - Number(a?.tracked || false) ||
      Number(b?.intensiveWatch || false) - Number(a?.intensiveWatch || false) ||
      Number(b?.overall || 0) - Number(a?.overall || 0) ||
      Number(b?.price || 0) - Number(a?.price || 0)
    );
}

function normalizedGroundedSale(row) {
  if (!row || typeof row !== "object") return null;
  const soldFor = finite(row.soldFor ?? row.sold_for ?? row.price);
  if (!Number.isFinite(soldFor) || soldFor <= 0) return null;
  return {
    date: parseDate(row.date ?? row.soldAt ?? row.sold_at),
    listedFor: Number.isFinite(finite(row.listedFor ?? row.listed_for))
      ? Math.round(finite(row.listedFor ?? row.listed_for))
      : null,
    soldFor: Math.round(soldFor),
    eaTax: Math.round(soldFor * 0.05),
    netPrice: Math.round(soldFor * 0.95),
    status: clean(row.status || "SOLD", 40) || "SOLD"
  };
}

function normalizeGroundedEvidenceItem(item, selectedRows, meta) {
  if (!item || typeof item !== "object") return null;
  const eaId = clean(item.eaId ?? item.ea_id, 80);
  const live = selectedRows.find(row => String(row?.eaId) === eaId);
  if (!live) return null;

  const trusted = trustedGrounding(meta);
  if (!trusted) return null;

  const games = finite(item.games);
  const gamesConsole = finite(item.gamesConsole ?? item.games_console);
  const gamesPc = finite(item.gamesPc ?? item.games_pc);
  const popularRank = finite(item.popularRank ?? item.popular_rank);
  const popularityCount = finite(item.popularityCount ?? item.popularity_count);
  const sales = (Array.isArray(item.salesHistory) ? item.salesHistory :
    Array.isArray(item.sales_history) ? item.sales_history :
    Array.isArray(item.sales) ? item.sales : [])
    .map(normalizedGroundedSale)
    .filter(Boolean)
    .slice(0, 50);

  // Accept only explicitly returned numeric evidence. Missing values stay null.
  if (![games, gamesConsole, gamesPc, popularRank, popularityCount].some(Number.isFinite) && !sales.length) {
    return null;
  }

  const sourceName = clean(item.sourceName ?? item.source ?? "GOOGLE_GROUNDED_SEARCH", 120);
  return {
    eaId,
    name: live.name,
    rating: Number(live.overall) || finite(item.rating),
    version: live.cardType || live.rarityName || clean(item.version, 120) || null,
    games: Number.isFinite(games) ? Math.round(games) : null,
    gamesConsole: Number.isFinite(gamesConsole) ? Math.round(gamesConsole) : null,
    gamesPc: Number.isFinite(gamesPc) ? Math.round(gamesPc) : null,
    popularRank: Number.isFinite(popularRank) ? Math.round(popularRank) : null,
    popularityCount: Number.isFinite(popularityCount) ? Math.round(popularityCount) : null,
    sales,
    source: sourceName,
    sourceUrl: clean(item.sourceUrl ?? item.source_url ?? meta?.urls?.[0], 1000) || null,
    observedAt: new Date().toISOString()
  };
}

async function collectGoogleGroundedEvidence({ liveRows, gameYear = "26" } = {}) {
  const key = geminiApiKey();
  groundedStatus.configured = Boolean(key);
  const budget = resetGroundedBudgetIfNeeded();
  groundedStatus.model = clean(process.env.MARKET_EVIDENCE_GEMINI_MODEL || "gemini-2.5-flash", 120);

  if (!key) {
    groundedStatus.status = "NOT_CONFIGURED";
    groundedStatus.lastError = "GEMINI_API_KEY/GOOGLE_API_KEY nicht gesetzt.";
    return [];
  }
  if (budget.remaining <= 0) {
    groundedStatus.status = "BUDGET_EXHAUSTED";
    return [];
  }

  const batchSize = Math.max(1, Math.min(5, Number(process.env.MARKET_EVIDENCE_GEMINI_BATCH || 4)));
  const selected = candidateRowsForGrounding(liveRows).slice(0, batchSize);
  if (!selected.length) {
    groundedStatus.status = "NO_CANDIDATES";
    return [];
  }

  groundedStatus.status = "SEARCHING";
  groundedStatus.lastAttemptAt = new Date().toISOString();
  groundedStatus.callsToday += 1;
  groundedStatus.lastBatch = selected.map(row => ({
    eaId: String(row.eaId),
    name: row.name,
    rating: Number(row.overall) || null
  }));
  for (const row of selected) groundedCardCooldown.set(String(row.eaId), Date.now());

  const requested = selected.map(row => ({
    eaId: String(row.eaId),
    name: row.name,
    rating: Number(row.overall) || null,
    version: row.cardType || row.rarityName || null
  }));

  const prompt = `
You are a strict FC 26 public-web evidence extractor.
Use Google Search grounding. Look for public indexed FUTBIN pages ONLY for the exact cards below.

Return ONE JSON object, no markdown:
{
  "cards": [
    {
      "eaId": "echo the supplied eaId",
      "games": integer|null,
      "gamesConsole": integer|null,
      "gamesPc": integer|null,
      "popularRank": integer|null,
      "popularityCount": integer|null,
      "salesHistory": [{"date": ISO-date-or-null, "listedFor": integer|null, "soldFor": integer, "status": "SOLD"}],
      "sourceName": "FUTBIN"|null,
      "sourceUrl": "public source URL or null"
    }
  ]
}

Rules:
- Use only facts directly supported by public indexed search results/pages.
- Do not estimate, infer, extrapolate, or invent.
- "Games" means Ultimate Team card usage/games shown by a source, not real-life matches.
- Popular rank must be an actual public card-popularity rank. Do not invent rank from price or comments.
- Sales history must contain only explicit sold-price observations. If exact sold observations are unavailable, return [].
- If a field is unavailable, return null.
- Match exact player + rating/version. If uncertain, leave fields null.
- Ignore real-life football statistics.
- FUT.GG remains the price source; do not return current prices.
Cards:
${JSON.stringify(requested)}
`.trim();

  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const response = await ai.models.generateContent({
      model: groundedStatus.model,
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0,
        maxOutputTokens: 2200
      }
    });

    const meta = groundingMeta(response);
    groundedStatus.lastGroundingTitles = meta.titles.slice(0, 20);
    groundedStatus.lastGroundingUrls = meta.urls.slice(0, 20);

    if (!trustedGrounding(meta)) {
      throw new Error("NO_TRUSTED_FUTBIN_GROUNDING");
    }

    const parsed = safeJsonFromModel(response?.text);
    const items = Array.isArray(parsed?.cards) ? parsed.cards : [];
    const cards = items
      .map(item => normalizeGroundedEvidenceItem(item, selected, meta))
      .filter(Boolean);

    groundedStatus.cardsReturned = cards.length;
    groundedStatus.cardsWithGames = cards.filter(x =>
      Number.isFinite(x.games) || Number.isFinite(x.gamesConsole) || Number.isFinite(x.gamesPc)
    ).length;
    groundedStatus.cardsWithSales = cards.filter(x => x.sales?.length).length;
    groundedStatus.cardsWithPopularRank = cards.filter(x => Number.isFinite(x.popularRank)).length;
    groundedStatus.lastSuccessAt = new Date().toISOString();
    groundedStatus.lastError = null;
    groundedStatus.status = cards.length ? "READY" : "NO_VERIFIED_FIELDS";
    return cards;
  } catch (error) {
    groundedStatus.lastFailureAt = new Date().toISOString();
    groundedStatus.lastError = String(error?.message || error);
    groundedStatus.status = "ERROR";
    return [];
  }
}


function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchPublicHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "FC-Trader-Brain/10.69.1 public-data-reader"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      const error = new Error(`PUBLIC_SOURCE_BLOCKED_HTTP_${response.status}`);
      error.code = "SOURCE_BLOCKED_NO_BYPASS";
      throw error;
    }
    if (!response.ok) throw new Error(`PUBLIC_SOURCE_HTTP_${response.status}`);
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseCoin(text) {
  const raw = String(text || "").replace(/,/g, "").trim().toUpperCase();
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMB])?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2] === "K") n *= 1_000;
  if (m[2] === "M") n *= 1_000_000;
  if (m[2] === "B") n *= 1_000_000_000;
  return Math.round(n);
}

function parseFutwizPopular(html) {
  const out = [];
  const seen = new Set();
  const re = /href=["'](\/fc26\/player\/([^/"']+)\/(\d+)\/?)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const slug = m[2];
    const futwizId = m[3];
    if (seen.has(futwizId)) continue;
    seen.add(futwizId);

    const around = stripTags(html.slice(Math.max(0, m.index - 500), Math.min(html.length, m.index + 1200)));
    const ratingMatch = around.match(/\b(6[0-9]|7[0-9]|8[0-9]|9[0-9])\b/);
    const name = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

    out.push({
      futwizId,
      href,
      name,
      rating: ratingMatch ? Number(ratingMatch[1]) : null
    });
    if (out.length >= 120) break;
  }
  return out.map((row, index) => ({ ...row, popularRank: index + 1 }));
}

function parseFutwizSales(html) {
  const text = stripTags(html);
  const rows = [];
  const rowRe = /((?:Today|Yesterday|\d{1,2}\s+[A-Za-z]{3})\s+\d{1,2}:\d{2})\s+([0-9,.]+[KMB]?)\s+([0-9,.]+[KMB]?)\s+(BIN|Auction)/gi;
  let m;
  while ((m = rowRe.exec(text))) {
    const startPrice = parseCoin(m[2]);
    const finalPrice = parseCoin(m[3]);
    if (!Number.isFinite(finalPrice) || finalPrice <= 0) continue;
    rows.push({
      date: null,
      listedFor: startPrice,
      soldFor: finalPrice,
      eaTax: Math.round(finalPrice * 0.05),
      netPrice: Math.round(finalPrice * 0.95),
      status: m[4].toUpperCase(),
      sourceLabel: m[1]
    });
    if (rows.length >= 250) break;
  }
  return rows;
}

function matchLiveRow(popular, liveRows) {
  const targetName = String(popular.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const candidates = (Array.isArray(liveRows) ? liveRows : []).filter(row => {
    const name = String(row?.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!name || !targetName) return false;
    const nameMatch = name === targetName || name.includes(targetName) || targetName.includes(name);
    if (!nameMatch) return false;
    if (Number.isFinite(popular.rating) && Number.isFinite(Number(row?.overall))) {
      return Number(row.overall) === Number(popular.rating);
    }
    return true;
  });
  return candidates[0] || null;
}

async function collectFutwizPublicEvidence({ liveRows, gameYear = "26", maxSalesCards = 8 } = {}) {
  futwizStatus.lastAttemptAt = new Date().toISOString();
  futwizStatus.status = "FETCHING";
  futwizStatus.blocked = false;
  try {
    const popularHtml = await fetchPublicHtml(FUTWIZ_POPULAR_URL);
    const popular = parseFutwizPopular(popularHtml);
    futwizStatus.popularCards = popular.length;

    const cards = [];
    const matched = popular
      .map(item => ({ item, row: matchLiveRow(item, liveRows) }))
      .filter(x => x.row);

    for (const { item, row } of matched) {
      cards.push({
        eaId: String(row.eaId),
        name: row.name,
        rating: Number(row.overall) || item.rating || null,
        version: row.cardType || row.rarityName || null,
        popularRank: item.popularRank,
        popularityCount: null,
        games: null,
        gamesConsole: null,
        gamesPc: null,
        sales: [],
        source: "FUTWIZ_PUBLIC",
        sourceUrl: FUTWIZ_BASE + item.href,
        observedAt: new Date().toISOString(),
        _futwizId: item.futwizId,
        _slug: item.href.split("/")[4] || ""
      });
    }

    let salesCards = 0;
    let salesRows = 0;
    for (const card of cards.slice(0, Math.max(0, Number(maxSalesCards || 0)))) {
      const slug = card._slug || String(card.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const url = `${FUTWIZ_BASE}/fc26/player/${slug}/${card._futwizId}/soldprices/console`;
      try {
        const salesHtml = await fetchPublicHtml(url);
        const sales = parseFutwizSales(salesHtml);
        card.sales = sales;
        if (sales.length) {
          salesCards += 1;
          salesRows += sales.length;
        }
      } catch (error) {
        if (error?.code === "SOURCE_BLOCKED_NO_BYPASS") throw error;
      }
      delete card._futwizId;
      delete card._slug;
    }

    for (const card of cards) {
      delete card._futwizId;
      delete card._slug;
    }

    futwizStatus.status = cards.length ? "READY" : "NO_MATCHES";
    futwizStatus.lastSuccessAt = new Date().toISOString();
    futwizStatus.lastError = null;
    futwizStatus.salesCards = salesCards;
    futwizStatus.salesRows = salesRows;
    return cards;
  } catch (error) {
    futwizStatus.lastFailureAt = new Date().toISOString();
    futwizStatus.lastError = String(error?.message || error);
    futwizStatus.blocked = error?.code === "SOURCE_BLOCKED_NO_BYPASS";
    futwizStatus.status = futwizStatus.blocked ? "SOURCE_BLOCKED_NO_BYPASS" : "ERROR";
    return [];
  }
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

export async function refreshMarketEvidenceV1069({ pool = null, gameYear = "26", force = false, liveRows = [] } = {}) {
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
    // v10.69.3 strict source policy:
    // FUT.GG remains PRIMARY. Supplemental evidence is FUTBIN-only.
    // No FUTWIZ or other market site is queried.
    const cards = await collectGoogleGroundedEvidence({ liveRows, gameYear });

    if (cards.length) {
      const saved = await upsertCards(pool, cards, gameYear);
      await rebuildCache(pool, gameYear);
      lastRefreshSuccessAt = new Date().toISOString();
      lastRefreshError = null;
      lastSource = "FUTBIN_GOOGLE_GROUNDED";
      cardsLoaded += saved.cards;
      salesLoaded += saved.sales;
      return { ok: true, status: "READY_FUTBIN_GROUNDED", ...saved };
    }

    await rebuildCache(pool, gameYear);
    lastRefreshError = groundedStatus.lastError || null;
    return {
      ok: cardCache.size > 0,
      status: groundedStatus.status || (cardCache.size ? "DATABASE_ONLY" : "WAITING_FOR_FUTBIN_EVIDENCE"),
      cards: cardCache.size,
      sourceError: lastRefreshError
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
  await refreshMarketEvidenceV1069({ pool, gameYear, liveRows: rows }).catch(() => null);
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
    gamesStatus: groundedStatus.cardsWithGames > 0 ? "OBSERVED_FROM_GROUNDED_PUBLIC_SOURCE" : "WAITING_FOR_VERIFIED_SOURCE",
    groundedSupplement: {
      provider: "FUTBIN_VIA_GOOGLE_GROUNDED_SEARCH",
      policy: "PUBLIC_INDEXED_WEB_ONLY",
      budget: resetGroundedBudgetIfNeeded(),
      ...groundedStatus
    },
    sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)) || groundedStatus.configured,
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
    note: "FUT.GG bleibt die Preis- und Marktquelle. Zusatzdaten kommen ausschließlich aus FUTBIN-Evidenz. Wenn direkter FUTBIN-Zugriff nicht verfügbar ist, darf Gemini Google Search nur öffentlich indexierte FUTBIN-Seiten auswerten. Games/Sales/Popular bleiben ohne verifizierte FUTBIN-Evidenz null/leer."
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
