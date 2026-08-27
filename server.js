import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();
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
  ) return "Base Common";

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

  if (cardInflight.has(rating)) return cardInflight.get(rating);

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

    const data = { rating, pagesRead, cards };
    cardCache.set(rating, { savedAt: Date.now(), data });
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
  for (let r = RATING_MIN; r <= RATING_MAX; r++) ratings.push(r);

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

  if (bulkPriceInflight) return bulkPriceInflight;

  bulkPriceInflight = (async () => {
    const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");
    const hash = manifest["player-prices-ps5"];

    if (!hash) throw new Error("player-prices-ps5 missing from FUT.GG manifest");

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
        price: Number.isFinite(data.p[i]) && data.p[i] > 0 ? data.p[i] : null,
        statusCode: Array.isArray(data.s) ? data.s[i] ?? null : null
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
}

function recordMemory(rows, at) {
  const cutoff = at - 31 * 24 * 60 * 60_000;

  for (const row of rows) {
    const oldPrice = lastMemoryPrice.get(row.eaId);

    if (oldPrice !== row.price) {
      const list = memoryHistory.get(row.eaId) || [];
      list.push({ t: at, price: row.price });

      while (list.length && list[0].t < cutoff) list.shift();

      memoryHistory.set(row.eaId, list);
      lastMemoryPrice.set(row.eaId, row.price);
    }
  }
}

async function recordDb(rows, at) {
  if (!dbEnabled || !rows.length) return;

  const ids = rows.map(r => String(r.eaId));
  const prices = rows.map(r => r.price);

  const previous = await pool.query(
    `SELECT ea_id::text AS ea_id, price
     FROM fc_price_state
     WHERE ea_id = ANY($1::bigint[])`,
    [ids]
  );

  const old = new Map(previous.rows.map(r => [r.ea_id, Number(r.price)]));
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
        `INSERT INTO fc_price_history (ea_id, price, recorded_at)
         SELECT * FROM UNNEST($1::bigint[], $2::int[], $3::timestamptz[])
        `,
        [
          changedIds,
          changedPrices,
          changedIds.map(() => new Date(at).toISOString())
        ]
      );
    }

    await client.query(
      `INSERT INTO fc_price_state (ea_id, price, recorded_at)
       SELECT * FROM UNNEST($1::bigint[], $2::int[], $3::timestamptz[])
       ON CONFLICT (ea_id)
       DO UPDATE SET price = EXCLUDED.price, recorded_at = EXCLUDED.recorded_at`,
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
    if (point.t <= threshold) result = point;
    else break;
  }

  return result?.price ?? null;
}

function rangeMemory(eaId, start) {
  const list = memoryHistory.get(eaId) || [];
  const vals = list.filter(x => x.t >= start).map(x => x.price);

  if (!vals.length) return { low: null, high: null };

  return {
    low: Math.min(...vals),
    high: Math.max(...vals)
  };
}

async function lookupDb(ids, threshold) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `SELECT DISTINCT ON (ea_id)
       ea_id::text AS ea_id, price
     FROM fc_price_history
     WHERE ea_id = ANY($1::bigint[])
       AND recorded_at <= $2
     ORDER BY ea_id, recorded_at DESC`,
    [ids.map(String), new Date(threshold).toISOString()]
  );

  return new Map(result.rows.map(r => [r.ea_id, Number(r.price)]));
}

async function rangeDb(ids, start) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `SELECT ea_id::text AS ea_id,
            MIN(price)::int AS low,
            MAX(price)::int AS high
     FROM fc_price_history
     WHERE ea_id = ANY($1::bigint[])
       AND recorded_at >= $2
     GROUP BY ea_id`,
    [ids.map(String), new Date(start).toISOString()]
  );

  return new Map(
    result.rows.map(r => [
      r.ea_id,
      { low: Number(r.low), high: Number(r.high) }
    ])
  );
}

function changePct(current, old) {
  if (!Number.isFinite(current) || !Number.isFinite(old) || old <= 0) return null;
  return Number((((current - old) / old) * 100).toFixed(2));
}

function distancePct(current, target) {
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return null;
  return Number((((current - target) / target) * 100).toFixed(2));
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

  const drop24 = Number.isFinite(row.change24h) && row.change24h <= -5;
  const drop7d = Number.isFinite(row.change7d) && row.change7d <= -8;
  const recover1h = Number.isFinite(row.change1h) && row.change1h >= 1;
  const rising24 = Number.isFinite(row.change24h) && row.change24h >= 5;
  const falling1h = Number.isFinite(row.change1h) && row.change1h <= -2;

  let score = 0;
  let signal = "HOLD";

  if (nearLow) score += 28;
  if (drop24) score += 24;
  if (drop7d) score += 18;
  if (recover1h) score += 24;
  if (falling1h) score -= 18;

  if (nearLow && (drop24 || drop7d) && recover1h) {
    signal = "BUY";
    score += 25;
  } else if (nearLow && (drop24 || drop7d)) {
    signal = "WATCH";
    score += 12;
  } else if (nearHigh && rising24) {
    signal = "SELL WATCH";
    score += 16;
  } else if (recover1h && drop24) {
    signal = "RECOVERY";
    score += 15;
  } else if (falling1h) {
    signal = "FALLING";
  }

  return {
    signal,
    score: Math.max(0, Math.min(100, Math.round(score)))
  };
}

async function buildTradingRows() {
  const [cards, bulk] = await Promise.all([
    ensureUniverse(false),
    loadBulkPs5Prices(false)
  ]);

  const current = currentPricedCards(cards, bulk);
  const ids = current.map(r => r.eaId);
  const now = Date.now();

  const thresholds = {
    m1: now - 60_000,
    h1: now - 60 * 60_000,
    h24: now - 24 * 60 * 60_000,
    d7: now - 7 * 24 * 60 * 60_000,
    d30: now - 30 * 24 * 60 * 60_000
  };

  let p1m, p1h, p24h, p7d, p30d, ranges24h;

  if (dbEnabled) {
    [p1m, p1h, p24h, p7d, p30d, ranges24h] = await Promise.all([
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

    const old1m = dbEnabled ? p1m.get(key) ?? null : lookupMemory(card.eaId, thresholds.m1);
    const old1h = dbEnabled ? p1h.get(key) ?? null : lookupMemory(card.eaId, thresholds.h1);
    const old24h = dbEnabled ? p24h.get(key) ?? null : lookupMemory(card.eaId, thresholds.h24);
    const old7d = dbEnabled ? p7d.get(key) ?? null : lookupMemory(card.eaId, thresholds.d7);
    const old30d = dbEnabled ? p30d.get(key) ?? null : lookupMemory(card.eaId, thresholds.d30);

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
      change1h: changePct(card.price, old1h),
      change24h: changePct(card.price, old24h),
      change7d: changePct(card.price, old7d),
      change30d: changePct(card.price, old30d),
      low24h: range.low,
      high24h: range.high,
      distanceFrom24hLow: distancePct(card.price, range.low)
    };

    Object.assign(row, signalFor(row));
    return row;
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0));
  });

  return rows;
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Intelligence",
    version: "8.0-card-intelligence",
    refreshSeconds: 60,
    storage: dbEnabled ? "Postgres + memory fallback" : "memory only",
    endpoints: {
      trading: "GET /trading",
      tradingData: "GET /api/trading",
      overview: "GET /overview",
      health: "GET /health"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "8.0-card-intelligence",
    monitoringStarted,
    monitoringBusy,
    lastMonitorAt,
    lastMonitorError,
    cardsKnown: universe.length,
    dbEnabled,
    now: new Date().toISOString()
  });
});

app.get("/api/trading", async (req, res) => {
  try {
    const rows = await buildTradingRows();

    res.json({
      ok: true,
      refreshSeconds: 60,
      dbEnabled,
      historyNote: dbEnabled
        ? "Persistent history enabled"
        : "Memory history only; long-term history resets when Render restarts",
      totalPricedCards: rows.length,
      rows,
      updatedAt: new Date().toISOString()
    });
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
  :root{
    color-scheme:dark;
    font-family:Arial,sans-serif;
  }
  body{
    margin:0;
    background:#0f0f0f;
    color:#f2f2f2;
  }
  .wrap{padding:18px 22px 40px}
  h1{margin:0 0 5px;font-size:30px}
  .sub{color:#aaa;margin-bottom:14px}
  .bar{
    display:flex;
    gap:10px;
    flex-wrap:wrap;
    align-items:center;
    padding:12px;
    background:#181818;
    border-radius:10px;
    margin-bottom:12px;
  }
  input,select{
    background:#101010;
    color:#eee;
    border:1px solid #333;
    padding:9px 10px;
    border-radius:7px;
  }
  input{min-width:220px}
  .status{
    margin-left:auto;
    color:#aaa;
    font-size:13px;
  }
  .storage{
    background:#181818;
    padding:10px 12px;
    border-radius:8px;
    margin-bottom:12px;
    color:#bbb;
  }
  table{
    width:100%;
    border-collapse:collapse;
    background:#161616;
    font-size:14px;
  }
  th,td{
    padding:9px 8px;
    border-bottom:1px solid #292929;
    text-align:right;
    white-space:nowrap;
  }
  th:first-child,td:first-child{text-align:left}
  th{
    position:sticky;
    top:0;
    background:#202020;
    z-index:2;
  }
  tr:hover{background:#202020}
  a{color:#fff}
  .buy{font-weight:700}
  .muted{color:#777}
  .pos{color:#8fe59b}
  .neg{color:#ff9b9b}
</style>
</head>
<body>
<div class="wrap">
  <h1>FC Trading Intelligence</h1>
  <div class="sub">Individual cards • 1m / 1h / 24h / 7d / 30d • 60 second refresh</div>

  <div class="bar">
    <input id="search" placeholder="Search player…">
    <select id="type">
      <option value="all">All card types</option>
      <option value="Base Rare">Base Rare</option>
      <option value="Base Common">Base Common</option>
      <option value="Special">Special</option>
    </select>
    <select id="minRating">
      ${Array.from({length:25},(_,i)=>75+i).map(r=>`<option value="${r}">${r}+</option>`).join("")}
    </select>
    <select id="signal">
      <option value="all">All signals</option>
      <option>BUY</option>
      <option>WATCH</option>
      <option>RECOVERY</option>
      <option>SELL WATCH</option>
      <option>HOLD</option>
      <option>FALLING</option>
    </select>
    <div id="status" class="status">Loading…</div>
  </div>

  <div id="storage" class="storage">Loading history status…</div>

  <table>
    <thead>
      <tr>
        <th>Player</th>
        <th>OVR</th>
        <th>Type</th>
        <th>Price</th>
        <th>1m</th>
        <th>1h</th>
        <th>24h</th>
        <th>7d</th>
        <th>30d</th>
        <th>24h Low</th>
        <th>24h High</th>
        <th>Signal</th>
        <th>Score</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
</div>

<script>
let allRows = [];
let busy = false;

const fmt = n => Number.isFinite(n) ? n.toLocaleString("de-DE") : "-";

function pctCell(n){
  if(!Number.isFinite(n)) return '<span class="muted">-</span>';
  const cls = n > 0 ? "pos" : n < 0 ? "neg" : "";
  return '<span class="' + cls + '">' +
    (n > 0 ? "+" : "") + n.toFixed(2) + '%</span>';
}

function render(){
  const q = document.getElementById("search").value.trim().toLowerCase();
  const type = document.getElementById("type").value;
  const minRating = Number(document.getElementById("minRating").value);
  const signal = document.getElementById("signal").value;

  const filtered = allRows.filter(x => {
    if(x.overall < minRating) return false;
    if(type !== "all" && x.cardType !== type) return false;
    if(signal !== "all" && x.signal !== signal) return false;

    if(q){
      const hay = [x.name,x.rarityName,x.club,x.position]
        .filter(Boolean).join(" ").toLowerCase();
      if(!hay.includes(q)) return false;
    }

    return true;
  });

  const rows = document.getElementById("rows");
  rows.innerHTML = "";

  for(const x of filtered.slice(0, 500)){
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td><a href="\${x.url}" target="_blank">\${x.name || "-"}</a></td>
      <td>\${x.overall}</td>
      <td>\${x.cardType}</td>
      <td>\${fmt(x.price)}</td>
      <td>\${pctCell(x.change1m)}</td>
      <td>\${pctCell(x.change1h)}</td>
      <td>\${pctCell(x.change24h)}</td>
      <td>\${pctCell(x.change7d)}</td>
      <td>\${pctCell(x.change30d)}</td>
      <td>\${fmt(x.low24h)}</td>
      <td>\${fmt(x.high24h)}</td>
      <td class="buy">\${x.signal}</td>
      <td>\${x.score}</td>
    \`;
    rows.appendChild(tr);
  }

  document.getElementById("status").textContent =
    filtered.length + " matching cards • showing first " +
    Math.min(500, filtered.length);
}

async function load(){
  if(busy) return;
  busy = true;

  const status = document.getElementById("status");
  status.textContent = "Refreshing…";

  try{
    const r = await fetch("/api/trading", {cache:"no-store"});
    const j = await r.json();

    if(!r.ok || !j.ok) throw new Error(j.error || "Request failed");

    allRows = j.rows || [];

    document.getElementById("storage").textContent =
      (j.dbEnabled ? "Persistent history: ON" : "Persistent history: OFF") +
      " • " + j.historyNote +
      " • Updated " + new Date(j.updatedAt).toLocaleTimeString("de-DE");

    render();
  }catch(e){
    status.textContent = "Error: " + e.message;
  }finally{
    busy = false;
  }
}

for(const id of ["search","type","minRating","signal"]){
  document.getElementById(id).addEventListener(
    id === "search" ? "input" : "change",
    render
  );
}

load();
setInterval(load, 60000);
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
    console.error("DB init error:", error);
    lastMonitorError = "DB init: " + String(error);
  }

  monitorOnce();
  setInterval(monitorOnce, PRICE_REFRESH_MS);

  setInterval(() => {
    ensureUniverse(true).catch(error => {
      console.error("metadata refresh error:", error);
    });
  }, META_REFRESH_MS);
}

app.listen(port, () => {
  console.log(`FC Trading Intelligence v8 running on ${port}`);
  startMonitoring();
});

