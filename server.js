import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;

const RATING_MIN = 75;
const RATING_MAX = 99;
const CACHE_TTL_MS = 60_000;
const MAX_PAGES = 50;

let browser;
const cardsCache = new Map();

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

async function collectAllCardsForRating(rating) {
  const cached = cardsCache.get(rating);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached.data, cached: true };
  }

  const b = await getBrowser();
  const page = await b.newPage({
    viewport: { width: 1440, height: 1000 }
  });

  try {
    await page.goto("https://www.fut.gg/players/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000
    });

    const all = [];
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
          headers: { "accept": "application/json" }
        });

        const text = await response.text();

        return {
          ok: response.ok,
          status: response.status,
          text
        };
      }, apiUrl);

      if (!result.ok) {
        if (pageNumber === 1) {
          throw new Error(`HTTP ${result.status} on first page`);
        }

        // End of pagination or unsupported page number.
        break;
      }

      let json;
      try {
        json = JSON.parse(result.text);
      } catch {
        throw new Error(`Invalid JSON on page ${pageNumber}`);
      }

      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) break;

      let addedThisPage = 0;

      for (const p of rows) {
        const key = p.eaId ?? p.id ?? p.url;
        if (key == null || seen.has(String(key))) continue;

        seen.add(String(key));
        addedThisPage++;

        all.push({
          id: p.id ?? null,
          eaId: p.eaId ?? null,
          overall: p.overall ?? null,
          name:
            p.commonName ||
            p.cardName ||
            [p.firstName, p.lastName].filter(Boolean).join(" ") ||
            null,
          cardName: p.cardName ?? null,
          firstName: p.firstName ?? null,
          lastName: p.lastName ?? null,
          rarityName: p.rarityName ?? null,
          rarityId: p.rarityId ?? null,
          rarityEaId: p.rarityEaId ?? null,
          rarityGroupName: p.rarityGroupName ?? null,
          position: p.position ?? null,
          club: p.club?.name ?? p.uniqueClub?.name ?? null,
          nation: p.nation?.name ?? null,
          league: p.league?.name ?? null,
          url: p.url ? new URL(p.url, "https://www.fut.gg").href : null,
          slug: p.slug ?? null,
          basePlayerSlug: p.basePlayerSlug ?? null,
          isEvolutionPlayerItem: p.isEvolutionPlayerItem ?? false,
          isProvisional: p.isProvisional ?? false,
          currentDbPrice: Number.isFinite(p.currentDbPrice)
            ? p.currentDbPrice
            : null
        });
      }

      pagesRead++;

      if (addedThisPage === 0) break;
    }

    const data = {
      ok: true,
      source: "FUT.GG public players API",
      rating,
      cardCount: all.length,
      pagesRead,
      cards: all,
      cached: false,
      updatedAt: new Date().toISOString()
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

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API",
    version: "5.1",
    refreshSeconds: 60,
    ratingRange: `${RATING_MIN}-${RATING_MAX}`,
    endpoints: {
      cardsByRating: "GET /cards/83",
      cardCountByRating: "GET /cards/83/count"
    }
  });
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
    res.json(await collectAllCardsForRating(rating));
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
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
      updatedAt: data.updatedAt
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.listen(port, () => {
  console.log(`FC Trading Price API v5.1 running on ${port}`);
});
