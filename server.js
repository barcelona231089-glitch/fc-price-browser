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

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Price API"
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

  let page;

  try {
    const b = await getBrowser();

    page = await b.newPage({
      viewport: { width: 1440, height: 1200 }
    });

    const priceResponsePromise = page.waitForResponse(
      response =>
        response.url().includes("/api/fut/player-prices/") &&
        response.status() === 200,
      { timeout: 30000 }
    );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    const priceResponse = await priceResponsePromise;
    const priceJson = await priceResponse.json();

    const data = priceJson?.data;

    if (!data?.currentPrice) {
      return res.json({
        ok: false,
        error: "Price response received but currentPrice missing"
      });
    }

    const current = data.currentPrice;
    const completed = data.completedAuctions || [];
    const live = data.liveAuctions || [];
    const history = data.history || [];

    const bodyText = await page.locator("body").innerText();
    const title = await page.title();

    const playerId =
      bodyText.match(/Player ID\s+(\d+)/i)?.[1] || null;

    const itemId =
      bodyText.match(/Item ID\s+(\d+)/i)?.[1] || null;

    const liveBins = live
      .map(x => x.buyNowPrice)
      .filter(x => Number.isFinite(x));

    const lowestLiveBin =
      liveBins.length ? Math.min(...liveBins) : null;

    const lastSoldPrice =
      completed.length ? completed[0].soldPrice : null;

    const recentSold = completed
      .slice(0, 20)
      .map(x => x.soldPrice)
      .filter(x => Number.isFinite(x));

    const averageRecentSold =
      recentSold.length
        ? Math.round(
            recentSold.reduce((a, b) => a + b, 0) /
            recentSold.length
          )
        : null;

    return res.json({
      ok: true,
      source: "FUT.GG",
      player: title.split(" Winter")[0],
      playerId: playerId ? Number(playerId) : null,
      itemId: itemId ? Number(itemId) : null,
      platform: current.platform,
      price: current.price,
      lowestLiveBin,
      lastSoldPrice,
      averageRecentSold,
      extinct: current.isExtinct,
      priceUpdatedAt: current.priceUpdatedAt,
      history: history.slice(-30),
      updatedAt: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({
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
  console.log(`FC Trading Price API running on ${port}`);
});
