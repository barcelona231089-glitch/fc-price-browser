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
let priceFilesCache = null;

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

async function loadPublicPriceFiles() {
  if (
    priceFilesCache &&
    Date.now() - priceFilesCache.savedAt < PRICE_CACHE_MS
  ) {
    return {
      ...priceFilesCache,
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

    const result = {
      savedAt: Date.now(),
      ids,
      prices,
      totalIndexedIds: ids.length,
      totalPriceValues: prices.length,
      indexUrl: payload.indexUrl,
      priceUrl: payload.priceUrl,
      publishedAt:
        payload.manifest?._published_at?.["player-prices-ps5-dyn"] ?? null,
      cached: false
    };

    priceFilesCache = result;
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

function chooseJoinStrategy(cards, ids, prices) {
  const candidates = [];

  for (const keyType of ["eaId", "id"]) {
    const wanted = new Set(
      cards.map(c => c[keyType]).filter(Number.isFinite)
    );

    for (const offset of [0, 1]) {
      let matches = 0;
      let positiveMatches = 0;

      const length = Math.min(
        prices.length,
        Math.max(0, ids.length - offset)
      );

      for (let i = 0; i < length; i++) {
        const indexedId = ids[i + offset];

        if (wanted.has(indexedId)) {
          matches++;

          if (Number.isFinite(prices[i]) && prices[i] > 0) {
            positiveMatches++;
          }
        }
      }

      candidates.push({
        keyType,
        offset,
        matches,
        positiveMatches
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.matches - a.matches ||
      b.positiveMatches - a.positiveMatches
  );

  return {
    best: candidates[0],
    candidates
  };
}

function attachPrices(cards, priceFiles) {
  const strategy = chooseJoinStrategy(
    cards,
    priceFiles.ids,
    priceFiles.prices
  );

  const best = strategy.best;

  const rawMap = new Map();
  const positiveMap = new Map();

  const length = Math.min(
    priceFiles.prices.length,
    Math.max(0, priceFiles.ids.length - best.offset)
  );

  for (let i = 0; i < length; i++) {
    const indexedId = priceFiles.ids[i + best.offset];
    const rawPrice = priceFiles.prices[i];

    rawMap.set(indexedId, rawPrice);

    if (Number.isFinite(rawPrice) && rawPrice > 0) {
      positiveMap.set(indexedId, rawPrice);
    }
  }

  const joinedCards = cards.map(card => {
    const key = card[best.keyType];
    const rawPrice = Number.isFinite(key)
      ? rawMap.get(key)
      : undefined;

    const price = Number.isFinite(key)
      ? positiveMap.get(key) ?? null
      : null;

    return {
      ...card,
      price,
      extinctOrUnavailable: rawPrice === 0 || price == null
    };
  });

  return {
    cards: joinedCards,
    strategy
  };
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
    version: "6.1",
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
    const priceFiles = await loadPublicPriceFiles();

    const joined = attachPrices(cardData.cards, priceFiles);

    res.json({
      ok: true,
      source: "FUT.GG public player list + public PS5 price data",
      refreshSeconds: 60,
      market: summarizeMarket(rating, joined.cards),
      debug: {
        selectedKey: joined.strategy.best.keyType,
        alignmentOffset: joined.strategy.best.offset,
        matchedCardIds: joined.strategy.best.matches,
        positivePriceMatches: joined.strategy.best.positiveMatches,
        candidates: joined.strategy.candidates,
        totalIndexedIds: priceFiles.totalIndexedIds,
        totalPriceValues: priceFiles.totalPriceValues,
        cardsCached: cardData.cached,
        pricesCached: priceFiles.cached
      },
      cards: joined.cards,
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
  console.log(`FC Trading Price API v6.1 running on ${port}`);
});
