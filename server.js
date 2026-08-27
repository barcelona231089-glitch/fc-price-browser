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

    let priceData = null;

    page.on("response", async response => {
      const responseUrl = response.url();

      if (
        responseUrl.includes(
          "/api/fut/player-prices/"
        )
      ) {
        try {
          const json = await response.json();

          if (json?.data?.currentPrice) {
            priceData = json.data;
          }
        } catch {}
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(10000);

    const bodyText =
      await page.locator("body").innerText();

    const title = await page.title();

    const playerId =
      bodyText.match(/Player ID\s+(\d+)/i)?.[1] || null;

    const itemId =
      bodyText.match(/Item ID\s+(\d+)/i)?.[1] || null;

    if (!priceData) {
      return res.json({
        ok: false,
        error: "Price data not received",
        playerId,
        itemId
      });
    }

    const current =
      priceData.currentPrice;

    const completed =
      priceData.completedAuctions || [];

    const live =
      priceData.liveAuctions || [];

    const history =
      priceData.history || [];

    const lowestLiveBin =
      live.length
        ? Math.min(
            ...live
              .map(x => x.buyNowPrice)
              .filter(Boolean)
          )
        : null;

    const lastSoldPrice =
      completed.length
        ? completed[0].soldPrice
        : null;

    const recentSoldPrices =
      completed
        .slice(0, 20)
        .map(x => x.soldPrice);

    const averageRecentSold =
      recentSoldPrices.length
        ? Math.round(
            recentSoldPrices.reduce(
              (a, b) => a + b,
              0
            ) / recentSoldPrices.length
          )
        : null;

    return res.json({
      ok: true,

      source: "FUT.GG",

      player:
        title.split(" Winter")[0],

      playerId:
        playerId
          ? Number(playerId)
          : null,

      itemId:
        itemId
          ? Number(itemId)
          : null,

      platform:
        current.platform,

      price:
        current.price,

      lowestLiveBin,

      lastSoldPrice,

      averageRecentSold,

      priceUpdatedAt:
        current.priceUpdatedAt,

      extinct:
        current.isExtinct,

      history:
        history.slice(-30),

      updatedAt:
        new Date().toISOString()
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
  console.log(
    `FC Trading Price API running on ${port}`
  );
});
