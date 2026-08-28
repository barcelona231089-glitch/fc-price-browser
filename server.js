import express from "express";
import pg from "pg";

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

    const rows = currentPricedCards(cards, bulk);
    const at = Date.now();

    recordMemory(rows, at);

    if (dbEnabled) {
      await recordDb(rows, at);
    }

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

async function buildTradingRows() {
  const [cards, bulk, positions] = await Promise.all([
    ensureUniverse(false),
    loadBulkPs5Prices(false),
    getPositions()
  ]);

  const current = currentPricedCards(cards, bulk);
  const ids = current.map(row => row.eaId);
  const now = Date.now();

  const thresholds = {
    m1: now - 60_000,
    h1: now - 60 * 60_000,
    h24: now - 24 * 60 * 60_000,
    d7: now - 7 * 24 * 60 * 60_000,
    d30: now - 30 * 24 * 60 * 60_000
  };

  let p1m;
  let p1h;
  let p24h;
  let p7d;
  let p30d;
  let ranges24h;

  if (dbEnabled) {
    [
      p1m,
      p1h,
      p24h,
      p7d,
      p30d,
      ranges24h
    ] = await Promise.all([
      lookupDb(ids, thresholds.m1),
      lookupDb(ids, thresholds.h1),
      lookupDb(ids, thresholds.h24),
      lookupDb(ids, thresholds.d7),
      lookupDb(ids, thresholds.d30),
      rangeDb(ids, thresholds.h24)
    ]);
  }

  const rows = current.map(card => {
    const key = String(card.eaId);

    const old1m =
      dbEnabled
        ? p1m.get(key) ?? null
        : lookupMemory(card.eaId, thresholds.m1);

    const old1h =
      dbEnabled
        ? p1h.get(key) ?? null
        : lookupMemory(card.eaId, thresholds.h1);

    const old24h =
      dbEnabled
        ? p24h.get(key) ?? null
        : lookupMemory(card.eaId, thresholds.h24);

    const old7d =
      dbEnabled
        ? p7d.get(key) ?? null
        : lookupMemory(card.eaId, thresholds.d7);

    const old30d =
      dbEnabled
        ? p30d.get(key) ?? null
        : lookupMemory(card.eaId, thresholds.d30);

    const range =
      dbEnabled
        ? ranges24h.get(key) ?? {
            low: null,
            high: null
          }
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
      change1h: changePct(card.price, old1h),
      change24h: changePct(card.price, old24h),
      change7d: changePct(card.price, old7d),
      change30d: changePct(card.price, old30d),
      low24h: range.low,
      high24h: range.high,
      distanceFrom24hLow:
        distancePct(card.price, range.low),
      tracked: positions.has(key)
    };

    Object.assign(row, signalFor(row));
    Object.assign(
      row,
      profitInfo(
        card.price,
        positions.get(key)
      )
    );

    return row;
  });

  rows.sort((a, b) => {
    if (a.tracked !== b.tracked) {
      return a.tracked ? -1 : 1;
    }

    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return (
      Math.abs(b.change24h ?? 0) -
      Math.abs(a.change24h ?? 0)
    );
  });

  return rows;
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Intelligence",
    version: "8.1-profit-watchlist",
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
      health: "GET /health"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "8.1-profit-watchlist",
    monitoringStarted,
    monitoringBusy,
    lastMonitorAt,
    lastMonitorError,
    cardsKnown: universe.length,
    dbEnabled,
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
    const rows = await buildTradingRows();

    res.json({
      ok: true,
      refreshSeconds: 60,
      dbEnabled,
      historyNote:
        dbEnabled
          ? "Dauerhafte Historie aktiv"
          : "Nur Arbeitsspeicher; Historie geht bei Render-Neustart verloren",
      totalPricedCards: rows.length,
      trackedPositions:
        rows.filter(row => row.tracked).length,
      rows,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
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
    Einzelkarten • 1m / 1h / 24h / 7d / 30d • 60-Sekunden-Refresh • 5 % EA-Steuer
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
        <th>1h</th>
        <th>24h</th>
        <th>7d</th>
        <th>30d</th>
        <th>24h Tief</th>
        <th>24h Hoch</th>
        <th>Signal</th>
        <th>Score</th>
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
      `FC Trading Intelligence v8.1 running on ${port}`
    );

    startMonitoring();
  }
);

