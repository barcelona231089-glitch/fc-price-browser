import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));

let browser;

const CACHE_TTL_MS = 60_000;
const PLAYER_LIMIT_PER_RATING = 40;   // safe first version
const RATING_MIN = 75;
const RATING_MAX = 99;

const priceCache = new Map();
const ratingLinkCache = new Map();

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

function avg(values) {
  const nums = values.filter(Number.isFinite);
  return nums.length
    ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)
    : null;
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2
    ? nums[mid]
    : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function pct(current, old) {
  if (!Number.isFinite(current) || !Number.isFinite(old) || old === 0) {
    return null;
  }
  return Number((((current - old) / old) * 100).toFixed(2));
}

function closest(history, msAgo) {
  if (!Array.isArray(history) || !history.length) return null;

  const target = Date.now() - msAgo;
  let bestPrice = null;
  let bestDiff = Infinity;

  for (const point of history) {
    const t = Date.parse(point.date);
    if (!Number.isFinite(t) || !Number.isFinite(point.price)) continue;

    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPrice = point.price;
    }
  }

  return bestPrice;
}

function analyze(currentPrice, history) {
  const prices = (history || []).map(x => x.price).filter(Number.isFinite);

  if (!Number.isFinite(currentPrice) || prices.length < 3) {
    return {
      marketStatus: "UNKNOWN",
      signal: "HOLD",
      recentLow: null,
      recentHigh: null,
      recentAverage: null
    };
  }

  const recentLow = Math.min(...prices);
  const recentHigh = Math.max(...prices);
  const recentAverage = avg(prices);

  let marketStatus = "STABLE";
  let signal = "HOLD";

  if (Number.isFinite(recentAverage) && currentPrice <= recentAverage * 0.88) {
    marketStatus = "STRONG DROP";
    signal = "WATCH";
  } else if (Number.isFinite(recentAverage) && currentPrice <= recentAverage * 0.93) {
    marketStatus = "DROP";
    signal = "WATCH";
  }

  if (Number.isFinite(recentLow) && currentPrice <= recentLow * 1.05) {
    marketStatus = "NEAR LOW";
    signal =
      Number.isFinite(recentAverage) && currentPrice <= recentAverage * 0.93
        ? "BUY"
        : "WATCH";
  } else if (
    Number.isFinite(recentLow) &&
    Number.isFinite(recentHigh) &&
    currentPrice >= recentLow * 1.10 &&
    currentPrice < recentHigh * 0.95
  ) {
    marketStatus = "STRONG RECOVERY";
    signal = "HOLD";
  } else if (
    Number.isFinite(recentLow) &&
    Number.isFinite(recentHigh) &&
    currentPrice >= recentLow * 1.05 &&
    currentPrice < recentHigh * 0.95
  ) {
    marketStatus = "RECOVERY";
    signal = "HOLD";
  }

  if (Number.isFinite(recentHigh) && currentPrice >= recentHigh * 0.95) {
    marketStatus = "HIGH MARKET";
    signal = "SELL";
  }

  return { marketStatus, signal, recentLow, recentHigh, recentAverage };
}

async function getRatingPlayerUrls(rating) {
  const cached = ratingLinkCache.get(rating);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return cached.urls;
  }

  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 1400 } });

  try {
    const listUrl =
      `https://www.fut.gg/players/?overall__gte=${rating}` +
      `&overall__lte=${rating}&sorts=current_price`;

    await page.goto(listUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });

    await page.waitForTimeout(5000);

    const urls = await page.evaluate(() => {
      const out = new Set();

      for (const a of document.querySelectorAll('a[href*="/players/"]')) {
        const href = a.getAttribute("href");
        if (!href) continue;

        // Player detail URLs look like /players/212198-name/26-184761574/
        if (/^\/players\/\d+[^/]*\/\d+-\d+\/?$/.test(href)) {
          out.add(new URL(href, location.origin).href);
        }
      }

      return Array.from(out);
    });

    const limited = urls.slice(0, PLAYER_LIMIT_PER_RATING);

    ratingLinkCache.set(rating, {
      savedAt: Date.now(),
      urls: limited
    });

    return limited;
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchPlayerPrice(url) {
  const cached = priceCache.get(url);

  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width: 1440, height: 1200 } });

  try {
    const waitPrice = page.waitForResponse(
      response =>
        response.url().includes("/api/fut/player-prices/") &&
        response.status() === 200,
      { timeout: 30_000 }
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });

    const priceResponse = await waitPrice;
    const json = await priceResponse.json();
    const data = json?.data;

    if (!data?.currentPrice) {
      throw new Error("currentPrice missing");
    }

    const text = await page.locator("body").innerText();
    const title = await page.title();

    const rating = Number(
      title.match(/\b(\d{2})\s+OVR\b/i)?.[1] ||
      text.match(/\b(\d{2})\s+OVR\b/i)?.[1] ||
      NaN
    );

    const playerId = text.match(/Player ID\s+(\d+)/i)?.[1] || null;
    const itemId = text.match(/Item ID\s+(\d+)/i)?.[1] || null;

    const current = data.currentPrice;
    const completed = data.completedAuctions || [];
    const live = data.liveAuctions || [];
    const history = data.history || [];

    const liveBins = live.map(x => x.buyNowPrice).filter(Number.isFinite);
    const recentSold = completed.slice(0, 20).map(x => x.soldPrice).filter(Number.isFinite);

    const p1h = closest(history, 60 * 60 * 1000);
    const p24h = closest(history, 24 * 60 * 60 * 1000);
    const p7d = closest(history, 7 * 24 * 60 * 60 * 1000);

    const analysis = analyze(current.price, history);

    const result = {
      ok: true,
      source: "FUT.GG",
      player: title.replace(/\s+\d{2}\s+OVR.*$/i, "").trim(),
      rating: Number.isFinite(rating) ? rating : null,
      playerId: playerId ? Number(playerId) : null,
      itemId: itemId ? Number(itemId) : null,
      platform: current.platform,
      price: current.price,
      lowestLiveBin: liveBins.length ? Math.min(...liveBins) : null,
      lastSoldPrice: completed.length ? completed[0].soldPrice : null,
      averageRecentSold: avg(recentSold),
      extinct: current.isExtinct,
      change1h: pct(current.price, p1h),
      change24h: pct(current.price, p24h),
      change7d: pct(current.price, p7d),
      marketStatus: analysis.marketStatus,
      signal: analysis.signal,
      recentLow: analysis.recentLow,
      recentHigh: analysis.recentHigh,
      recentAverage: analysis.recentAverage,
      priceUpdatedAt: current.priceUpdatedAt,
      updatedAt: new Date().toISOString(),
      cached: false
    };

    priceCache.set(url, {
      savedAt: Date.now(),
      data: result
    });

    return result;
  } finally {
    await page.close().catch(() => {});
  }
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
          url: items[i],
          error: String(error)
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function summarizeRating(rating, players) {
  const good = players.filter(
    p => p?.ok && p.rating === rating && Number.isFinite(p.price)
  );

  const prices = good.map(p => p.price);
  const d1 = good.map(p => p.change1h).filter(Number.isFinite);
  const d24 = good.map(p => p.change24h).filter(Number.isFinite);
  const d7 = good.map(p => p.change7d).filter(Number.isFinite);

  let marketStatus = "NO DATA";
  let signal = "NO SIGNAL";

  if (good.length) {
    const statusCounts = {};

    for (const p of good) {
      const s = p.marketStatus || "UNKNOWN";
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    marketStatus =
      Object.entries(statusCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      "STABLE";

    if (marketStatus === "NEAR LOW") signal = "BUY";
    else if (marketStatus === "HIGH MARKET") signal = "SELL";
    else if (marketStatus === "STRONG DROP" || marketStatus === "DROP") {
      signal = "WATCH";
    } else {
      signal = "HOLD";
    }
  }

  return {
    rating,
    label: `${rating} Rated`,
    playerCount: good.length,
    averagePrice: avg(prices),
    medianPrice: median(prices),
    minimumPrice: prices.length ? Math.min(...prices) : null,
    maximumPrice: prices.length ? Math.max(...prices) : null,
    averageChange1h: d1.length
      ? Number((d1.reduce((a, b) => a + b, 0) / d1.length).toFixed(2))
      : null,
    averageChange24h: d24.length
      ? Number((d24.reduce((a, b) => a + b, 0) / d24.length).toFixed(2))
      : null,
    averageChange7d: d7.length
      ? Number((d7.reduce((a, b) => a + b, 0) / d7.length).toFixed(2))
      : null,
    marketStatus,
    signal
  };
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API",
    version: "3.0",
    refreshSeconds: 60,
    ratingRange: "75-99",
    maxPlayersPerRating: PLAYER_LIMIT_PER_RATING,
    endpoints: {
      single: "GET /price?url=<FUT.GG player URL>",
      oneRating: "GET /rating/86",
      allRatings: "GET /ratings"
    }
  });
});

app.get("/price", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://www.fut.gg/")) {
    return res.status(400).json({
      ok: false,
      error: "Valid FUT.GG URL required"
    });
  }

  try {
    res.json(await fetchPlayerPrice(url));
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/rating/:rating", async (req, res) => {
  const rating = Number(req.params.rating);

  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return res.status(400).json({
      ok: false,
      error: `Rating must be ${RATING_MIN}-${RATING_MAX}`
    });
  }

  try {
    const urls = await getRatingPlayerUrls(rating);
    const players = await mapLimit(urls, 3, fetchPlayerPrice);

    res.json({
      ok: true,
      source: "FUT.GG",
      refreshSeconds: 60,
      rating: summarizeRating(rating, players),
      players,
      discoveredUrls: urls.length,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/ratings", async (req, res) => {
  const ratings = [];

  // Free Render is small, so process one rating at a time.
  // This endpoint can take a while. Individual /rating/:rating is better for live use.
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating++) {
    try {
      const urls = await getRatingPlayerUrls(rating);
      const players = await mapLimit(urls, 3, fetchPlayerPrice);

      ratings.push({
        ...summarizeRating(rating, players),
        discoveredUrls: urls.length
      });
    } catch (error) {
      ratings.push({
        rating,
        label: `${rating} Rated`,
        playerCount: 0,
        marketStatus: "ERROR",
        signal: "NO SIGNAL",
        error: String(error)
      });
    }
  }

  res.json({
    ok: true,
    source: "FUT.GG",
    refreshSeconds: 60,
    ratings,
    updatedAt: new Date().toISOString()
  });
});

app.listen(port, () => {
  console.log(`FC Trading Price API running on ${port}`);
});
