import express from "express";

const app = express();
const port = process.env.PORT || 3000;

const RATING_MIN = 75;
const RATING_MAX = 99;

const CARD_CACHE_MS = 15 * 60_000;
const PRICE_CACHE_MS = 60_000;
const MAX_PAGES = 60;
const FETCH_TIMEOUT_MS = 20_000;

const cardCache = new Map();
let bulkPriceCache = null;
const lastRatingSnapshots = new Map();

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
      const err = new Error(`${url} -> HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function average(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;

  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function trimmedMedian(values, trimPercent = 0.10) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;

  const trim = Math.floor(nums.length * trimPercent);
  const trimmed =
    nums.length - trim * 2 >= 3
      ? nums.slice(trim, nums.length - trim)
      : nums;

  return median(trimmed);
}

function pct(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }

  return Number((((current - previous) / previous) * 100).toFixed(2));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;

      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        results[i] = {
          ok: false,
          error: String(error),
          input: items[i]
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

async function collectAllCardsForRating(rating) {
  const cached = cardCache.get(rating);

  if (cached && Date.now() - cached.savedAt < CARD_CACHE_MS) {
    return {
      ...cached.data,
      cached: true
    };
  }

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

      cards.push({
        id: Number.isFinite(p.id) ? p.id : null,
        eaId: Number.isFinite(p.eaId) ? p.eaId : null,
        overall: Number.isFinite(p.overall) ? p.overall : null,
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
      });
    }

    pagesRead++;

    if (added === 0) break;
  }

  const data = {
    rating,
    cardCount: cards.length,
    pagesRead,
    cards,
    cached: false
  };

  cardCache.set(rating, {
    savedAt: Date.now(),
    data
  });

  return data;
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

async function loadBulkPs5Prices() {
  if (
    bulkPriceCache &&
    Date.now() - bulkPriceCache.savedAt < PRICE_CACHE_MS
  ) {
    return {
      ...bulkPriceCache,
      cached: true
    };
  }

  const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");
  const staticHash = manifest["player-prices-ps5"];

  if (!staticHash) {
    throw new Error("player-prices-ps5 missing from FUT.GG manifest");
  }

  const priceUrl =
    `https://r2.fut.gg/26/player-prices-ps5.v1.${staticHash}.json`;

  const data = await fetchJson(priceUrl);

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

  const result = {
    savedAt: Date.now(),
    map,
    priceUrl,
    totalValues: data.p.length,
    publishedAt:
      manifest?._published_at?.["player-prices-ps5-dyn"] ?? null,
    cached: false
  };

  bulkPriceCache = result;
  return result;
}

function attachPrices(cards, bulk) {
  return cards.map(card => {
    const row = Number.isFinite(card.eaId)
      ? bulk.map.get(card.eaId)
      : null;

    return {
      ...card,
      price: row?.price ?? null,
      priceStatusCode: row?.statusCode ?? null,
      hasPrice: Number.isFinite(row?.price)
    };
  });
}

function summarizeSubset(cards) {
  const priced = cards.filter(c => Number.isFinite(c.price));
  const prices = priced.map(c => c.price);
  const sorted = [...priced].sort((a, b) => a.price - b.price);

  return {
    cardCount: cards.length,
    pricedCards: priced.length,
    coveragePercent: cards.length
      ? Number(((priced.length / cards.length) * 100).toFixed(1))
      : 0,
    averagePrice: average(prices),
    medianPrice: median(prices),
    robustMedianPrice: trimmedMedian(prices),
    minimumPrice: prices.length ? Math.min(...prices) : null,
    maximumPrice: prices.length ? Math.max(...prices) : null,
    cheapest5: sorted.slice(0, 5).map(c => ({
      name: c.name,
      price: c.price,
      rarityName: c.rarityName,
      position: c.position,
      url: c.url
    }))
  };
}

function makeSignal(change1m) {
  if (!Number.isFinite(change1m)) return "WAIT";
  if (change1m <= -3) return "BUY WATCH";
  if (change1m <= -1) return "WATCH";
  if (change1m >= 3) return "SELL WATCH";
  if (change1m >= 1) return "RISING";
  return "STABLE";
}

function summarizeRating(rating, cards) {
  const all = summarizeSubset(cards);

  const rare = summarizeSubset(
    cards.filter(c =>
      String(c.rarityGroupName || c.rarityName || "")
        .toLowerCase()
        .includes("rare")
    )
  );

  const previous = lastRatingSnapshots.get(rating);
  const currentMedian = all.robustMedianPrice ?? all.medianPrice;

  const change1m = pct(currentMedian, previous?.median);

  lastRatingSnapshots.set(rating, {
    median: currentMedian,
    savedAt: Date.now()
  });

  return {
    rating,
    label: `${rating} Rated`,
    allCards: all,
    rareCards: rare,
    marketChangeSinceLastRefresh: change1m,
    signal: makeSignal(change1m)
  };
}

async function getMarketForRating(rating, includeCards = true) {
  const [cardData, bulk] = await Promise.all([
    collectAllCardsForRating(rating),
    loadBulkPs5Prices()
  ]);

  const cards = attachPrices(cardData.cards, bulk);

  return {
    ok: true,
    source: "FUT.GG public player list + PS5 bulk market prices",
    refreshSeconds: 60,
    rating: summarizeRating(rating, cards),
    metadata: {
      totalCardsFound: cardData.cardCount,
      pagesRead: cardData.pagesRead,
      cardsCached: cardData.cached,
      pricesCached: bulk.cached,
      bulkPriceValues: bulk.totalValues
    },
    ...(includeCards ? { cards } : {}),
    updatedAt: new Date().toISOString()
  };
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Market API",
    version: "7.0-core",
    ratingRange: `${RATING_MIN}-${RATING_MAX}`,
    priceRefreshSeconds: 60,
    endpoints: {
      dashboard: "GET /dashboard",
      oneRating: "GET /market/83",
      allRatings: "GET /markets",
      health: "GET /health"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "7.0-core",
    uptimeSeconds: Math.round(process.uptime()),
    cardCacheRatings: cardCache.size,
    bulkPricesCached: Boolean(bulkPriceCache),
    now: new Date().toISOString()
  });
});

app.get("/market/:rating", async (req, res) => {
  const rating = Number(req.params.rating);

  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return res.status(400).json({
      ok: false,
      error: `Rating must be ${RATING_MIN}-${RATING_MAX}`
    });
  }

  try {
    res.json(await getMarketForRating(rating, true));
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/markets", async (req, res) => {
  let min = Number(req.query.min ?? RATING_MIN);
  let max = Number(req.query.max ?? RATING_MAX);

  if (!Number.isInteger(min)) min = RATING_MIN;
  if (!Number.isInteger(max)) max = RATING_MAX;

  min = Math.max(RATING_MIN, min);
  max = Math.min(RATING_MAX, max);

  if (min > max) {
    return res.status(400).json({
      ok: false,
      error: "min must be <= max"
    });
  }

  const ratings = [];
  for (let r = min; r <= max; r++) ratings.push(r);

  try {
    // Direct HTTP only, no Chromium. Concurrency 4 is safe for Render Free.
    const results = await mapLimit(ratings, 4, async rating => {
      const market = await getMarketForRating(rating, false);
      return {
        ok: true,
        rating: market.rating,
        metadata: market.metadata
      };
    });

    res.json({
      ok: true,
      source: "FUT.GG public player list + PS5 bulk market prices",
      refreshSeconds: 60,
      minRating: min,
      maxRating: max,
      results,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/dashboard", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FC Trading Market</title>
<style>
  body{font-family:Arial,sans-serif;background:#111;color:#eee;margin:0;padding:20px}
  h1{margin:0 0 8px}
  .sub{color:#aaa;margin-bottom:18px}
  .status{margin:12px 0;padding:10px;background:#1b1b1b;border-radius:8px}
  table{width:100%;border-collapse:collapse;background:#181818}
  th,td{padding:10px;border-bottom:1px solid #2b2b2b;text-align:right}
  th:first-child,td:first-child{text-align:left}
  th{position:sticky;top:0;background:#222}
  tr:hover{background:#202020}
  .buy{font-weight:bold}
  .small{font-size:12px;color:#aaa}
  a{color:#ddd}
</style>
</head>
<body>
<h1>FC Trading Market</h1>
<div class="sub">FUT.GG PS5 bulk prices • Ratings 75–99 • Refresh every 60 seconds</div>
<div id="status" class="status">Loading market…</div>
<table>
<thead>
<tr>
<th>Rating</th>
<th>Cards</th>
<th>Priced</th>
<th>Robust Median</th>
<th>Rare Median</th>
<th>Min</th>
<th>Max</th>
<th>Δ</th>
<th>Signal</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>
<script>
const fmt = n => Number.isFinite(n) ? n.toLocaleString("de-DE") : "-";
const pct = n => Number.isFinite(n) ? (n > 0 ? "+" : "") + n.toFixed(2) + "%" : "-";

async function load(){
  const status = document.getElementById("status");
  try{
    status.textContent = "Loading all ratings…";
    const r = await fetch("/markets?min=75&max=99", {cache:"no-store"});
    const j = await r.json();

    if(!j.ok) throw new Error(j.error || "Market request failed");

    const rows = document.getElementById("rows");
    rows.innerHTML = "";

    for(const item of j.results){
      if(!item.ok){
        const tr = document.createElement("tr");
        tr.innerHTML = "<td colspan='9'>Error loading rating</td>";
        rows.appendChild(tr);
        continue;
      }

      const x = item.rating;
      const all = x.allCards;
      const rare = x.rareCards;

      const tr = document.createElement("tr");
      tr.innerHTML = \`
        <td><a href="/market/\${x.rating}" target="_blank">\${x.rating} Rated</a></td>
        <td>\${all.cardCount}</td>
        <td>\${all.pricedCards}</td>
        <td>\${fmt(all.robustMedianPrice)}</td>
        <td>\${fmt(rare.robustMedianPrice ?? rare.medianPrice)}</td>
        <td>\${fmt(all.minimumPrice)}</td>
        <td>\${fmt(all.maximumPrice)}</td>
        <td>\${pct(x.marketChangeSinceLastRefresh)}</td>
        <td class="buy">\${x.signal}</td>
      \`;
      rows.appendChild(tr);
    }

    status.innerHTML =
      "Updated: " + new Date(j.updatedAt).toLocaleTimeString("de-DE") +
      " <span class='small'>• automatic refresh in 60s</span>";
  }catch(e){
    status.textContent = "Error: " + e.message;
  }
}

load();
setInterval(load, 60000);
</script>
</body>
</html>`);
});

app.listen(port, () => {
  console.log(`FC Trading Market API v7 running on ${port}`);
});


