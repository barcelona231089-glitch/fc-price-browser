import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

let browser;

const CACHE_TTL_MS = 60000;
const cache = new Map();

const DEFAULT_TEST_URLS = [
  "https://www.fut.gg/players/212198-bruno-fernandes/26-184761574/"
];

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage"
      ]
    });
  }

  return browser;
}

function avg(values) {
  const nums = values.filter(Number.isFinite);

  if (!nums.length) {
    return null;
  }

  return Math.round(
    nums.reduce((a, b) => a + b, 0) /
    nums.length
  );
}

function median(values) {
  const nums = values
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) {
    return null;
  }

  const middle = Math.floor(nums.length / 2);

  if (nums.length % 2) {
    return nums[middle];
  }

  return Math.round(
    (nums[middle - 1] + nums[middle]) / 2
  );
}

function pct(current, old) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(old) ||
    old === 0
  ) {
    return null;
  }

  return Number(
    (
      ((current - old) / old) *
      100
    ).toFixed(2)
  );
}

function closest(history, millisecondsAgo) {
  if (
    !Array.isArray(history) ||
    !history.length
  ) {
    return null;
  }

  const target =
    Date.now() - millisecondsAgo;

  let best = null;
  let bestDifference = Infinity;

  for (const point of history) {
    const timestamp =
      Date.parse(point.date);

    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(point.price)
    ) {
      continue;
    }

    const difference =
      Math.abs(timestamp - target);

    if (difference < bestDifference) {
      bestDifference = difference;
      best = point.price;
    }
  }

  return best;
}

function analyzeMarket(currentPrice, history) {
  const prices = (history || [])
    .map(x => x.price)
    .filter(Number.isFinite);

  if (
    !Number.isFinite(currentPrice) ||
    prices.length < 3
  ) {
    return {
      marketStatus: "UNKNOWN",
      signal: "HOLD",
      recentLow: null,
      recentHigh: null,
      recentAverage: null
    };
  }

  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const average = avg(prices);

  let marketStatus = "STABLE";
  let signal = "HOLD";

  if (
    Number.isFinite(average) &&
    currentPrice <= average * 0.88
  ) {
    marketStatus = "STRONG DROP";
    signal = "WATCH";
  } else if (
    Number.isFinite(average) &&
    currentPrice <= average * 0.93
  ) {
    marketStatus = "DROP";
    signal = "WATCH";
  }

  if (
    Number.isFinite(low) &&
    currentPrice <= low * 1.05
  ) {
    marketStatus = "NEAR LOW";

    if (
      Number.isFinite(average) &&
      currentPrice <= average * 0.93
    ) {
      signal = "BUY";
    } else {
      signal = "WATCH";
    }
  } else if (
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    currentPrice >= low * 1.10 &&
    currentPrice < high * 0.95
  ) {
    marketStatus = "STRONG RECOVERY";
    signal = "HOLD";
  } else if (
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    currentPrice >= low * 1.05 &&
    currentPrice < high * 0.95
  ) {
    marketStatus = "RECOVERY";
    signal = "HOLD";
  }

  if (
    Number.isFinite(high) &&
    currentPrice >= high * 0.95
  ) {
    marketStatus = "HIGH MARKET";
    signal = "SELL";
  }

  return {
    marketStatus,
    signal,
    recentLow: low,
    recentHigh: high,
    recentAverage: average
  };
}

async function fetchPrice(url) {

  const cached = cache.get(url);

  if (
    cached &&
    Date.now() - cached.savedAt <
      CACHE_TTL_MS
  ) {
    return {
      ...cached.data,
      cached: true
    };
  }

  const browser =
    await getBrowser();

  const page =
    await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200
      }
    });

  try {

    const waitForPrice =
      page.waitForResponse(
        response =>
          response
            .url()
            .includes(
              "/api/fut/player-prices/"
            ) &&
          response.status() === 200,
        {
          timeout: 30000
        }
      );

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    const priceResponse =
      await waitForPrice;

    const json =
      await priceResponse.json();

    const data =
      json?.data;

    if (!data?.currentPrice) {
      throw new Error(
        "currentPrice missing"
      );
    }

    const text =
      await page
        .locator("body")
        .innerText();

    const title =
      await page.title();

    const rating = Number(
      title.match(
        /\b(\d{2})\s+OVR\b/i
      )?.[1] ||
      text.match(
        /\b(\d{2})\s+OVR\b/i
      )?.[1] ||
      NaN
    );

    const playerId =
      text.match(
        /Player ID\s+(\d+)/i
      )?.[1] || null;

    const itemId =
      text.match(
        /Item ID\s+(\d+)/i
      )?.[1] || null;

    const current =
      data.currentPrice;

    const completed =
      data.completedAuctions || [];

    const live =
      data.liveAuctions || [];

    const history =
      data.history || [];

    const liveBins =
      live
        .map(x => x.buyNowPrice)
        .filter(Number.isFinite);

    const recentSold =
      completed
        .slice(0, 20)
        .map(x => x.soldPrice)
        .filter(Number.isFinite);

    const price1HourAgo =
      closest(
        history,
        60 * 60 * 1000
      );

    const price24HoursAgo =
      closest(
        history,
        24 * 60 * 60 * 1000
      );

    const price7DaysAgo =
      closest(
        history,
        7 * 24 * 60 * 60 * 1000
      );

    const analysis =
      analyzeMarket(
        current.price,
        history
      );

    const playerName =
      title
        .replace(
          /\s+\d{2}\s+OVR.*$/i,
          ""
        )
        .trim();

    const result = {
      ok: true,

      source: "FUT.GG",

      player: playerName,

      rating:
        Number.isFinite(rating)
          ? rating
          : null,

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

      lowestLiveBin:
        liveBins.length
          ? Math.min(...liveBins)
          : null,

      lastSoldPrice:
        completed.length
          ? completed[0].soldPrice
          : null,

      averageRecentSold:
        avg(recentSold),

      extinct:
        current.isExtinct,

      change1h:
        pct(
          current.price,
          price1HourAgo
        ),

      change24h:
        pct(
          current.price,
          price24HoursAgo
        ),

      change7d:
        pct(
          current.price,
          price7DaysAgo
        ),

      recentLow:
        analysis.recentLow,

      recentHigh:
        analysis.recentHigh,

      recentAverage:
        analysis.recentAverage,

      marketStatus:
        analysis.marketStatus,

      signal:
        analysis.signal,

      priceUpdatedAt:
        current.priceUpdatedAt,

      history:
        history.slice(-168),

      updatedAt:
        new Date().toISOString(),

      cached: false
    };

    cache.set(url, {
      savedAt: Date.now(),
      data: result
    });

    return result;

  } finally {

    await page
      .close()
      .catch(() => {});
  }
}

async function mapLimit(
  items,
  limit,
  functionToRun
) {

  const output =
    new Array(items.length);

  let index = 0;

  async function worker() {

    while (true) {

      const currentIndex =
        index++;

      if (
        currentIndex >=
        items.length
      ) {
        return;
      }

      try {

        output[currentIndex] =
          await functionToRun(
            items[currentIndex]
          );

      } catch (error) {

        output[currentIndex] = {
          ok: false,
          url: items[currentIndex],
          error: String(error)
        };
      }
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            limit,
            items.length
          )
      },
      () => worker()
    )
  );

  return output;
}

function ratingSummary(players) {

  const rows = [];

  for (
    let rating = 75;
    rating <= 99;
    rating++
  ) {

    const cards =
      players.filter(
        player =>
          player?.ok &&
          player.rating === rating &&
          Number.isFinite(
            player.price
          )
      );

    const prices =
      cards
        .map(x => x.price)
        .filter(Number.isFinite);

    const change1hValues =
      cards
        .map(x => x.change1h)
        .filter(Number.isFinite);

    const change24Values =
      cards
        .map(x => x.change24h)
        .filter(Number.isFinite);

    const change7Values =
      cards
        .map(x => x.change7d)
        .filter(Number.isFinite);

    let marketStatus =
      "NO DATA";

    let signal =
      "NO SIGNAL";

    if (cards.length) {

      const statusCounts = {};

      for (const card of cards) {

        const status =
          card.marketStatus ||
          "UNKNOWN";

        statusCounts[status] =
          (
            statusCounts[status] ||
            0
          ) + 1;
      }

      marketStatus =
        Object.entries(
          statusCounts
        )
        .sort(
          (a, b) =>
            b[1] - a[1]
        )[0]?.[0] ||
        "STABLE";

      const average24 =
        change24Values.length
          ? change24Values.reduce(
              (a, b) => a + b,
              0
            ) /
            change24Values.length
          : null;

      const average7 =
        change7Values.length
          ? change7Values.reduce(
              (a, b) => a + b,
              0
            ) /
            change7Values.length
          : null;

      if (
        Number.isFinite(average7) &&
        average7 <= -12
      ) {
        signal = "WATCH";
      }

      if (
        marketStatus ===
        "NEAR LOW"
      ) {
        signal = "BUY";
      }

      if (
        marketStatus ===
        "HIGH MARKET"
      ) {
        signal = "SELL";
      }
    }

    rows.push({

      rating,

      label:
        `${rating} Rated`,

      playerCount:
        cards.length,

      averagePrice:
        avg(prices),

      medianPrice:
        median(prices),

      minimumPrice:
        prices.length
          ? Math.min(...prices)
          : null,

      maximumPrice:
        prices.length
          ? Math.max(...prices)
          : null,

      averageChange1h:
        change1hValues.length
          ? Number(
              (
                change1hValues.reduce(
                  (a, b) =>
                    a + b,
                  0
                ) /
                change1hValues.length
              ).toFixed(2)
            )
          : null,

      averageChange24h:
        change24Values.length
          ? Number(
              (
                change24Values.reduce(
                  (a, b) =>
                    a + b,
                  0
                ) /
                change24Values.length
              ).toFixed(2)
            )
          : null,

      averageChange7d:
        change7Values.length
          ? Number(
              (
                change7Values.reduce(
                  (a, b) =>
                    a + b,
                  0
                ) /
                change7Values.length
              ).toFixed(2)
            )
          : null,

      marketStatus,

      signal
    });
  }

  return rows;
}

app.get("/", (req, res) => {

  res.json({

    online: true,

    service:
      "FC Trading Price API",

    version: "2.1",

    refreshSeconds:
      CACHE_TTL_MS / 1000,

    ratingRange:
      "75-99",

    endpoints: {

      single:
        "GET /price?url=<FUT.GG URL>",

      test:
        "GET /test-ratings",

      batch:
        "POST /batch-prices",

      ratings:
        "POST /rating-markets"
    }
  });
});

app.get(
  "/price",
  async (req, res) => {

    const url =
      req.query.url;

    if (
      !url ||
      !url.startsWith(
        "https://www.fut.gg/"
      )
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Valid FUT.GG URL required"
        });
    }

    try {

      const result =
        await fetchPrice(url);

      res.json(result);

    } catch (error) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            String(error)
        });
    }
  }
);

app.get(
  "/test-ratings",
  async (req, res) => {

    let urls =
      req.query.url;

    if (!urls) {

      urls =
        DEFAULT_TEST_URLS;

    } else if (
      !Array.isArray(urls)
    ) {

      urls = [urls];
    }

    urls =
      urls
        .filter(
          value =>
            typeof value ===
              "string" &&
            value.startsWith(
              "https://www.fut.gg/"
            )
        )
        .slice(0, 20);

    if (!urls.length) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "No valid FUT.GG URLs"
        });
    }

    const players =
      await mapLimit(
        urls,
        3,
        fetchPrice
      );

    const ratings =
      ratingSummary(players);

    res.json({

      ok: true,

      source:
        "FUT.GG",

      refreshSeconds:
        60,

      testedPlayers:
        players.length,

      ratings,

      players,

      updatedAt:
        new Date().toISOString()
    });
  }
);

app.post(
  "/batch-prices",
  async (req, res) => {

    const urls =
      Array.isArray(
        req.body?.urls
      )
        ? req.body.urls
        : [];

    const valid =
      urls
        .filter(
          value =>
            typeof value ===
              "string" &&
            value.startsWith(
              "https://www.fut.gg/"
            )
        )
        .slice(0, 50);

    if (!valid.length) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Provide urls: [...]"
        });
    }

    const players =
      await mapLimit(
        valid,
        3,
        fetchPrice
      );

    res.json({

      ok: true,

      count:
        players.length,

      players,

      updatedAt:
        new Date().toISOString()
    });
  }
);

app.post(
  "/rating-markets",
  async (req, res) => {

    const urls =
      Array.isArray(
        req.body?.urls
      )
        ? req.body.urls
        : [];

    const valid =
      urls
        .filter(
          value =>
            typeof value ===
              "string" &&
            value.startsWith(
              "https://www.fut.gg/"
            )
        )
        .slice(0, 50);

    if (!valid.length) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Provide urls: [...]"
        });
    }

    const players =
      await mapLimit(
        valid,
        3,
        fetchPrice
      );

    res.json({

      ok: true,

      source:
        "FUT.GG",

      refreshSeconds:
        60,

      ratings:
        ratingSummary(
          players
        ),

      players,

      updatedAt:
        new Date().toISOString()
    });
  }
);

app.listen(
  port,
  () => {

    console.log(
      `FC Trading Price API running on ${port}`
    );
  }
);
