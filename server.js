import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
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

function buildIds(indexData) {
  if (!Number.isFinite(indexData?.id0) || !Array.isArray(indexData?.d)) {
    throw new Error("Unexpected player-prices-index format");
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

function summarizeValue(value, depth = 0) {
  if (depth > 2) return "[depth-limit]";

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 20).map(v => summarizeValue(v, depth + 1))
    };
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const sample = {};

    for (const key of keys.slice(0, 15)) {
      sample[key] = summarizeValue(value[key], depth + 1);
    }

    return {
      type: "object",
      keys: keys.slice(0, 50),
      sample
    };
  }

  return value;
}

async function loadPublicFiles(page) {
  return await page.evaluate(async () => {
    const manifestResponse = await fetch(
      "https://r2.fut.gg/26/manifest.json",
      { headers: { accept: "application/json" } }
    );

    if (!manifestResponse.ok) {
      throw new Error(`manifest HTTP ${manifestResponse.status}`);
    }

    const manifest = await manifestResponse.json();

    const indexHash = manifest["player-prices-index"];
    const ps5Hash = manifest["player-prices-ps5-dyn"];
    const tokenHash = manifest["token-store"];

    if (!indexHash || !ps5Hash || !tokenHash) {
      throw new Error("Required hashes missing from manifest");
    }

    const indexUrl =
      `https://r2.fut.gg/26/player-prices-index.v1.${indexHash}.json`;

    const priceUrl =
      `https://r2.fut.gg/26/player-prices-ps5-dyn.v1.${ps5Hash}.json`;

    const tokenUrl =
      `https://r2.fut.gg/26/token-store.v1.${tokenHash}.json`;

    const [indexResponse, priceResponse, tokenResponse] = await Promise.all([
      fetch(indexUrl, { headers: { accept: "application/json" } }),
      fetch(priceUrl, { headers: { accept: "application/json" } }),
      fetch(tokenUrl, { headers: { accept: "application/json" } })
    ]);

    return {
      manifest,
      indexStatus: indexResponse.status,
      priceStatus: priceResponse.status,
      tokenStatus: tokenResponse.status,
      indexData: indexResponse.ok ? await indexResponse.json() : null,
      priceData: priceResponse.ok ? await priceResponse.json() : null,
      tokenData: tokenResponse.ok ? await tokenResponse.json() : null,
      indexUrl,
      priceUrl,
      tokenUrl
    };
  });
}

async function get83Cards(page) {
  const result = await page.evaluate(async () => {
    const response = await fetch(
      "/api/fut/players/v2/26/?overall__gte=83&overall__lte=83&sorts=current_price",
      {
        credentials: "same-origin",
        headers: { accept: "application/json" }
      }
    );

    if (!response.ok) {
      throw new Error(`players HTTP ${response.status}`);
    }

    return await response.json();
  });

  return Array.isArray(result?.data) ? result.data : [];
}

async function getLivePagePrice(url) {
  const b = await getBrowser();
  const page = await b.newPage({
    viewport: { width: 1280, height: 900 }
  });

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

    const response = await waitPrice;
    const json = await response.json();

    return {
      livePrice: json?.data?.currentPrice?.price ?? null,
      platform: json?.data?.currentPrice?.platform ?? null,
      priceUpdatedAt: json?.data?.currentPrice?.priceUpdatedAt ?? null
    };
  } catch (error) {
    return {
      livePrice: null,
      platform: null,
      error: String(error)
    };
  } finally {
    await page.close().catch(() => {});
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API",
    version: "6.2-debug",
    nextTest: "GET /verify-price"
  });
});

app.get("/verify-price", async (req, res) => {
  let page;

  try {
    page = await newFutPage();

    const publicFiles = await loadPublicFiles(page);

    if (!publicFiles.indexData || !publicFiles.priceData) {
      throw new Error("Could not load public price files");
    }

    const ids = buildIds(publicFiles.indexData);
    const prices = Array.isArray(publicFiles.priceData?.p)
      ? publicFiles.priceData.p
      : [];

    // From v6.1 we already proved FUT.GG aligns player eaId with offset 1.
    const rawByEaId = new Map();

    const usable = Math.min(prices.length, Math.max(0, ids.length - 1));

    for (let i = 0; i < usable; i++) {
      rawByEaId.set(ids[i + 1], prices[i]);
    }

    const rows = await get83Cards(page);

    // Pick a few different cards with public compact values.
    const candidates = rows
      .filter(p =>
        Number.isFinite(p?.eaId) &&
        p?.url &&
        Number.isFinite(rawByEaId.get(p.eaId)) &&
        rawByEaId.get(p.eaId) > 0
      )
      .slice(0, 4);

    const comparisons = [];

    for (const p of candidates) {
      const url = new URL(p.url, "https://www.fut.gg").href;
      const live = await getLivePagePrice(url);

      comparisons.push({
        name: p.commonName || p.cardName || null,
        overall: p.overall ?? null,
        rarityName: p.rarityName ?? null,
        eaId: p.eaId,
        compactRawValue: rawByEaId.get(p.eaId),
        livePagePrice: live.livePrice,
        sameValue:
          Number.isFinite(live.livePrice) &&
          live.livePrice === rawByEaId.get(p.eaId),
        platform: live.platform,
        priceUpdatedAt: live.priceUpdatedAt ?? null,
        error: live.error ?? null,
        url
      });
    }

    const valid = comparisons.filter(c => Number.isFinite(c.livePagePrice));
    const directMatches = valid.filter(c => c.sameValue).length;

    res.json({
      ok: true,
      conclusion:
        valid.length && directMatches === valid.length
          ? "compact values appear to be direct prices"
          : valid.length
          ? "compact values are NOT direct coin prices; decoding is required"
          : "could not compare live prices",
      comparisons,
      publicFiles: {
        indexStatus: publicFiles.indexStatus,
        priceStatus: publicFiles.priceStatus,
        tokenStatus: publicFiles.tokenStatus,
        totalIndexedIds: ids.length,
        totalPriceValues: prices.length,
        tokenStoreSummary: summarizeValue(publicFiles.tokenData)
      },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
});

app.listen(port, () => {
  console.log(`FC Trading Price API v6.2-debug running on ${port}`);
});

