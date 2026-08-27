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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }

  return await response.json();
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
      sample: value.slice(0, 12).map(v => summarizeValue(v, depth + 1))
    };
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const sample = {};

    for (const key of keys.slice(0, 12)) {
      sample[key] = summarizeValue(value[key], depth + 1);
    }

    return {
      type: "object",
      keys: keys.slice(0, 40),
      sample
    };
  }

  return value;
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
    version: "6.3-debug",
    nextTest: "GET /verify-price"
  });
});

app.get("/verify-price", async (req, res) => {
  try {
    const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");

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

    const playersUrl =
      "https://www.fut.gg/api/fut/players/v2/26/" +
      "?overall__gte=83&overall__lte=83&sorts=current_price";

    const [indexData, priceData, tokenData, playersData] = await Promise.all([
      fetchJson(indexUrl),
      fetchJson(priceUrl),
      fetchJson(tokenUrl),
      fetchJson(playersUrl)
    ]);

    const ids = buildIds(indexData);
    const prices = Array.isArray(priceData?.p) ? priceData.p : [];

    if (!prices.length) {
      throw new Error("No compact prices found");
    }

    // v6.1 showed the best join is eaId with offset 1.
    const rawByEaId = new Map();

    const usable = Math.min(prices.length, Math.max(0, ids.length - 1));

    for (let i = 0; i < usable; i++) {
      rawByEaId.set(ids[i + 1], prices[i]);
    }

    const rows = Array.isArray(playersData?.data) ? playersData.data : [];

    const candidates = rows
      .filter(p =>
        Number.isFinite(p?.eaId) &&
        p?.url &&
        Number.isFinite(rawByEaId.get(p.eaId)) &&
        rawByEaId.get(p.eaId) > 0
      )
      .slice(0, 3);

    const comparisons = [];

    // Sequentially, to keep Render Free memory low.
    for (const p of candidates) {
      const url = new URL(p.url, "https://www.fut.gg").href;
      const live = await getLivePagePrice(url);

      const compactRawValue = rawByEaId.get(p.eaId);

      comparisons.push({
        name: p.commonName || p.cardName || null,
        overall: p.overall ?? null,
        rarityName: p.rarityName ?? null,
        eaId: p.eaId,
        compactRawValue,
        livePagePrice: live.livePrice,
        sameValue:
          Number.isFinite(live.livePagePrice) &&
          live.livePagePrice === compactRawValue,
        platform: live.platform,
        priceUpdatedAt: live.priceUpdatedAt ?? null,
        error: live.error ?? null,
        url
      });
    }

    // Fix comparison field in case of typo above
    for (const c of comparisons) {
      c.sameValue =
        Number.isFinite(c.livePagePrice) &&
        c.livePagePrice === c.compactRawValue;
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
        totalIndexedIds: ids.length,
        totalPriceValues: prices.length,
        tokenStoreSummary: summarizeValue(tokenData)
      },
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
  console.log(`FC Trading Price API v6.3-debug running on ${port}`);
});

