import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;

const RATING_MIN = 75;
const RATING_MAX = 99;
const CARD_CACHE_MS = 10 * 60_000;
const PRICE_CACHE_MS = 60_000;
const MAX_PAGES = 50;

let browser;
const cardsCache = new Map();
let priceMapCache = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

function average(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function median(values) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;

  const middle = Math.floor(nums.length / 2);

  return nums.length % 2
    ? nums[middle]
    : Math.round((nums[middle - 1] + nums[middle]) / 2);
}

async function newFutPage() {
  const b = await getBrowser();
  const page = await b.newPage({
    viewport: { width: 1440, height: 1000 }
  });

  await page.goto("https://www.fut.gg/players/", {
    waitUntil: "domcontentloaded",
    timeout: 45_000
  });

  return page;
}

async function collectAllCardsForRating(rating) {
  const cached = cardsCache.get(rating);

  if (cached && Date.now() - cached.savedAt < CARD_CACHE_MS) {
    return { ...cached.data, cached: true };
  }

  const page = await newFutPage();

  try {
    const cards = [];
    const seen = new Set();
    let pagesRead = 0;

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const pagePart = pageNumber === 1 ? "" : `&page=${pageNumber}`;

      const apiUrl =
        `/api/fut/players/v2/26/?overall__gte=${rating}` +
        `&overall__lte=${rating}&sorts=current_price${pagePart}`;

      const result = await page.evaluate(async (url) => {
        const response = await fetch(url, {
          credentials: "same-origin",
          headers: { accept: "application/json" }
        });

        return {
          ok: response.ok,
          status: response.status,
          text: await response.text()
        };
      }, apiUrl);

      if (!result.ok) {
        if (pageNumber === 1) {
          throw new Error(`Players API HTTP ${result.status}`);
        }
        break;
      }

      const json = JSON.parse(result.text);
      const rows = Array.isArray(json?.data) ? json.data : [];

      if (!rows.length) break;

      let added = 0;

      for (const p of rows) {
        const key = p.id ?? p.eaId ?? p.url;

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

    cardsCache.set(rating, {
      savedAt: Date.now(),
      data
    });

    return data;
  } finally {
    await page.close().catch(() => {});
  }
}

function buildCumulativeIds(indexData) {
  if (!Number.isFinite(indexData?.id0) || !Array.isArray(indexData?.d)) {
    throw new Error("Unexpected FUT.GG price index format");
  }

  const ids = [indexData.id0];
  let current = indexData.id0;

  for (const delta of indexData.d) {
    if (!Number.isFinite(delta)) continue;
    current += delta;
    ids.push(current);
  }

  return ids;
}

function chooseAlignment(ids, prices, wantedIds) {
  const wanted = new Set(wantedIds.filter(Number.isFinite));

  const candidates = [];

  // FUT.GG's compact index may align the first price to id0 or to
  // the first cumulative delta. Test both and choose whichever
  // matches more real card IDs from the requested rating.
  for (const offset of [0, 1]) {
    let matches = 0;
    let positiveMatches = 0;

    const length = Math.min(prices.length, Math.max(0, ids.length - offset));

    for (let i = 0; i < length; i++) {
      const id = ids[i + offset];

      if (wanted.has(id)) {
        matches++;
        if (Number.isFinite(prices[i]) && prices[i] > 0) {
          positiveMatches++;
        }
      }
    }

    candidates.push({
      offset,
      matches,
      positiveMatches
    });
  }

  candidates.sort(
    (a, b) =>
      b.matches - a.matches ||
      b.positiveMatches - a.positiveMatches
  );

  return candidates[0];
}

async function loadPublicPriceMap(wantedIds = []) {
  if (
    priceMapCache &&
    Date.now() - priceMapCache.savedAt < PRICE_CACHE_MS &&
    priceMapCache.map
  ) {
    return {
      ...priceMapCache,
      cached: true
    };
  }

  const page = await newFutPage();

  try {
    const payload = await page.evaluate(async () => {
      const manifestResponse = await fetch(
        "https://r2.fut.gg/26/manifest.json",
        { headers: { accept: "application/json" } }
      );

      if (!manifestResponse.ok) {
        throw new Error(`Manifest HTTP ${manifestResponse.status}`);
      }

      const manifest = await manifestResponse.json();

      const indexHash = manifest["player-prices-index"];
      const ps5Hash = manifest["player-prices-ps5-dyn"];

      if (!indexHash || !ps5Hash) {
        throw new Error("Required public price files missing from manifest");
      }

      const indexUrl =
        `https://r2.fut.gg/26/player-prices-index.v1.${indexHash}.json`;

      const priceUrl =
        `https://r2.fut.gg/26/player-prices-ps5-dyn.v1.${ps5Hash}.json`;

      const [indexResponse, priceResponse] = await Promise.all([
        fetch(indexUrl, { headers: { accept: "application/json" } }),
        fetch(priceUrl, { headers: { accept: "application/json" } })
      ]);

      if (!indexResponse.ok) {
        throw new Error(`Price index HTTP ${indexResponse.status}`);
      }

      if (!priceResponse.ok) {
        throw new Error(`Price data HTTP ${priceResponse.status}`);
      }

      return {
        manifest,
        indexData: await indexResponse.json(),
        priceData: await priceResponse.json(),
        indexUrl,
        priceUrl
      };
    });

    const ids = buildCumulativeIds(payload.indexData);
    const prices = Array.isArray(payload.priceData?.p)
      ? payload.priceData.p
      : [];

    if (!prices.length) {
      throw new Error("No prices in public price file");
    }

    const alignment = chooseAlignment(ids, prices, wantedIds);

    const map = new Map();
    const rawMap = new Map();

    const usableLength = Math.min(
      prices.length,
      Math.max(0, ids.length - alignment.offset)
    );

    for (let i = 0; i < usableLength; i++) {
      const id = ids[i + alignment.offset];
      const rawPrice = prices[i];

      rawMap.set(id, rawPrice);

      if (Number.isFinite(rawPrice) && rawPrice > 0) {
        map.set(id, rawPrice);
      }
    }

    const result = {
      savedAt: Date.now(),
      map,
      rawMap,
      alignment,
      totalIndexedIds: ids.length,
      totalPriceValues: prices.length,
      indexUrl: payload.indexUrl,
      priceUrl: payload.priceUrl,
      publishedAt:
        payload.manifest?._published_at?.["player-prices-ps5-dyn"] ?? null,
      cached: false
    };

    priceMapCache = result;

    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

function summarizeMarket(rating, cards) {
  const priced = cards.filter(c => Number.isFinite(c.price));
  const prices = priced.map(c => c.price);

  const sorted = [...priced].sort((a, b) => a.price - b.price);

  return {
    rating,
    totalCards: cards.length,
    pricedCards: priced.length,
    noPriceOrExtinct: cards.length - priced.length,
    coveragePercent: cards.length
      ? Number(((priced.length / cards.length) * 100).toFixed(1))
      : 0,
    averagePrice: average(prices),
    medianPrice: median(prices),
    minimumPrice: prices.length ? Math.min(...prices) : null,
    maximumPrice: prices.length ? Math.max(...prices) : null,
    cheapest10: sorted.slice(0, 10).map(c => ({
      name: c.name,
      price: c.price,
      rarityName: c.rarityName,
      position: c.position,
      url: c.url
    }))
  };
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API",
    version: "6.0",
    ratingRange: `${RATING_MIN}-${RATING_MAX}`,
    priceRefreshSeconds: 60,
    endpoints: {
      count: "GET /cards/83/count",
      allCards: "GET /cards/83",
      market: "GET /market/83"
    }
  });
});

app.get("/cards/:rating/count", async (req, res) => {
  const rating = Number(req.params.rating);

  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return res.status(400).json({
      ok: false,
      error: `Rating must be ${RATING_MIN}-${RATING_MAX}`
    });
  }

  try {
    const data = await collectAllCardsForRating(rating);

    res.json({
      ok: true,
      rating,
      cardCount: data.cardCount,
      pagesRead: data.pagesRead,
      cached: data.cached,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/cards/:rating", async (req, res) => {
  const rating = Number(req.params.rating);

  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return res.status(400).json({
      ok: false,
      error: `Rating must be ${RATING_MIN}-${RATING_MAX}`
    });
  }

  try {
    const data = await collectAllCardsForRating(rating);

    res.json({
      ok: true,
      source: "FUT.GG public players API",
      ...data,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
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
    const cardData = await collectAllCardsForRating(rating);
    const cardIds = cardData.cards.map(c => c.id).filter(Number.isFinite);

    const priceData = await loadPublicPriceMap(cardIds);

    const cards = cardData.cards.map(card => {
      const rawPrice = Number.isFinite(card.id)
        ? priceData.rawMap.get(card.id)
        : undefined;

      const price = Number.isFinite(card.id)
        ? priceData.map.get(card.id) ?? null
        : null;

      return {
        ...card,
        price,
        extinctOrUnavailable: rawPrice === 0 || price == null
      };
    });

    const matchedCardIds = cards.filter(c =>
      Number.isFinite(c.id) && priceData.rawMap.has(c.id)
    ).length;

    res.json({
      ok: true,
      source: "FUT.GG public player list + public PS5 price data",
      refreshSeconds: 60,
      market: summarizeMarket(rating, cards),
      debug: {
        matchedCardIds,
        alignmentOffset: priceData.alignment.offset,
        alignmentMatches: priceData.alignment.matches,
        totalIndexedIds: priceData.totalIndexedIds,
        totalPriceValues: priceData.totalPriceValues,
        cardsCached: cardData.cached,
        pricesCached: priceData.cached
      },
      cards,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.listen(port, () => {
  console.log(`FC Trading Price API v6 running on ${port}`);
});
