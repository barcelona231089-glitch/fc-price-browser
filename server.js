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

function buildIds(data) {
  if (!Number.isFinite(data?.id0) || !Array.isArray(data?.d)) {
    throw new Error("Unexpected compact price format");
  }

  const ids = [data.id0];
  let current = data.id0;

  for (const delta of data.d) {
    if (!Number.isFinite(delta)) continue;
    current += delta;
    ids.push(current);
  }

  return ids;
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
    version: "6.5-debug",
    nextTest: "GET /verify-bruno-fixed"
  });
});

app.get("/verify-bruno-fixed", async (req, res) => {
  try {
    const manifest = await fetchJson("https://r2.fut.gg/26/manifest.json");

    const staticHash = manifest["player-prices-ps5"];
    const dynHash = manifest["player-prices-ps5-dyn"];

    if (!staticHash || !dynHash) {
      throw new Error("Required price hashes missing from manifest");
    }

    const staticUrl =
      `https://r2.fut.gg/26/player-prices-ps5.v1.${staticHash}.json`;

    const dynUrl =
      `https://r2.fut.gg/26/player-prices-ps5-dyn.v1.${dynHash}.json`;

    const [staticData, dynData] = await Promise.all([
      fetchJson(staticUrl),
      fetchJson(dynUrl)
    ]);

    // IMPORTANT:
    // The static PS5 price file contains its OWN id0 + d index.
    // Its p[] array is aligned 1:1 with those IDs.
    const ids = buildIds(staticData);

    if (!Array.isArray(staticData.p) || !Array.isArray(dynData.p)) {
      throw new Error("Missing price arrays");
    }

    const idx = ids.findIndex(id => id === BRUNO.eaId);

    if (idx < 0) {
      throw new Error("Bruno eaId not found in static PS5 price index");
    }

    const live = await getLivePrice(BRUNO.url);

    const neighbors = [];

    for (let i = Math.max(0, idx - 3); i <= Math.min(ids.length - 1, idx + 3); i++) {
      neighbors.push({
        index: i,
        eaId: ids[i],
        staticP: staticData.p[i] ?? null,
        staticS: Array.isArray(staticData.s) ? staticData.s[i] ?? null : null,
        dynamicP: dynData.p[i] ?? null,
        dynamicS: Array.isArray(dynData.s) ? dynData.s[i] ?? null : null
      });
    }

    const staticP = staticData.p[idx] ?? null;
    const staticS = Array.isArray(staticData.s) ? staticData.s[idx] ?? null : null;
    const dynamicP = dynData.p[idx] ?? null;
    const dynamicS = Array.isArray(dynData.s) ? dynData.s[idx] ?? null : null;

    res.json({
      ok: true,
      player: BRUNO,
      live,
      fixedMapping: {
        sourceOfIds: "player-prices-ps5 file itself",
        index: idx,
        staticP,
        staticS,
        dynamicP,
        dynamicS
      },
      checks: {
        staticPequalsLive:
          Number.isFinite(staticP) &&
          Number.isFinite(live.price) &&
          staticP === live.price,
        dynamicPequalsLive:
          Number.isFinite(dynamicP) &&
          Number.isFinite(live.price) &&
          dynamicP === live.price
      },
      neighbors,
      lengths: {
        ids: ids.length,
        staticP: staticData.p.length,
        staticS: Array.isArray(staticData.s) ? staticData.s.length : null,
        dynamicP: dynData.p.length,
        dynamicS: Array.isArray(dynData.s) ? dynData.s.length : null
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
  console.log(`FC Trading Price API v6.5-debug running on ${port}`);
});


