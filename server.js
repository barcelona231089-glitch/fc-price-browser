import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;

let browser;

const BRUNO = {
  name: "Bruno Fernandes",
  eaId: 184761574,
  url: "https://www.fut.gg/players/212198-bruno-fernandes/26-184761574/"
};

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
      accept: "application/json",
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

function summarize(obj) {
  if (!obj || typeof obj !== "object") return obj;

  const out = {
    keys: Object.keys(obj)
  };

  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key])) {
      out[key] = {
        type: "array",
        length: obj[key].length,
        first10: obj[key].slice(0, 10)
      };
    } else if (
      obj[key] === null ||
      typeof obj[key] === "string" ||
      typeof obj[key] === "number" ||
      typeof obj[key] === "boolean"
    ) {
      out[key] = obj[key];
    }
  }

  return out;
}

async function getLivePrice(url) {
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
      price: json?.data?.currentPrice?.price ?? null,
      platform: json?.data?.currentPrice?.platform ?? null,
      priceUpdatedAt: json?.data?.currentPrice?.priceUpdatedAt ?? null
    };
  } finally {
    await page.close().catch(() => {});
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API",
    version: "6.4-debug",
    nextTest: "GET /verify-bruno"
  });
});

app.get("/verify-bruno", async (req, res) => {
  try {
    const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");

    const indexHash = manifest["player-prices-index"];
    const staticHash = manifest["player-prices-ps5"];
    const dynHash = manifest["player-prices-ps5-dyn"];

    if (!indexHash || !staticHash || !dynHash) {
      throw new Error("Required price hashes missing from manifest");
    }

    const indexUrl =
      `https://r2.fut.gg/26/player-prices-index.v1.${indexHash}.json`;

    const staticUrl =
      `https://r2.fut.gg/26/player-prices-ps5.v1.${staticHash}.json`;

    const dynUrl =
      `https://r2.fut.gg/26/player-prices-ps5-dyn.v1.${dynHash}.json`;

    const [indexData, staticData, dynData] = await Promise.all([
      fetchJson(indexUrl),
      fetchJson(staticUrl),
      fetchJson(dynUrl)
    ]);

    const ids = buildIds(indexData);

    // v6.1 proved eaId alignment uses ids[i + 1] for price array index i.
    const targetArrayIndex = ids.findIndex(id => id === BRUNO.eaId) - 1;

    const staticP = Array.isArray(staticData?.p) ? staticData.p : null;
    const dynP = Array.isArray(dynData?.p) ? dynData.p : null;

    const staticValue =
      staticP && targetArrayIndex >= 0 ? staticP[targetArrayIndex] ?? null : null;

    const dynValue =
      dynP && targetArrayIndex >= 0 ? dynP[targetArrayIndex] ?? null : null;

    const live = await getLivePrice(BRUNO.url);

    res.json({
      ok: true,
      player: BRUNO,
      live,
      index: {
        targetArrayIndex,
        totalIds: ids.length
      },
      publicPriceFiles: {
        staticValueAtBruno: staticValue,
        dynamicValueAtBruno: dynValue,
        staticSummary: summarize(staticData),
        dynamicSummary: summarize(dynData)
      },
      quickChecks: {
        staticEqualsLive:
          Number.isFinite(staticValue) &&
          Number.isFinite(live.price) &&
          staticValue === live.price,
        dynamicEqualsLive:
          Number.isFinite(dynValue) &&
          Number.isFinite(live.price) &&
          dynValue === live.price,
        staticPlusDynamicEqualsLive:
          Number.isFinite(staticValue) &&
          Number.isFinite(dynValue) &&
          Number.isFinite(live.price) &&
          staticValue + dynValue === live.price
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
  console.log(`FC Trading Price API v6.4-debug running on ${port}`);
});


