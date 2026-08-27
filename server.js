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
    service: "FC Price Browser"
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
      viewport: {
        width: 1440,
        height: 1200
      }
    });

    const captured = [];

    page.on("response", async response => {
      const responseUrl = response.url();

      if (
        responseUrl.includes("player-prices") ||
        responseUrl.includes("price-access") ||
        responseUrl.includes("manifest.json")
      ) {
        try {
          const body = await response.text();

          captured.push({
            url: responseUrl,
            status: response.status(),
            contentType:
              response.headers()["content-type"] || null,
            body: body.slice(0, 10000)
          });
        } catch (e) {
          captured.push({
            url: responseUrl,
            status: response.status(),
            error: String(e)
          });
        }
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(10000);

    const text = await page.locator("body").innerText();

    const itemId =
      text.match(/Item ID\s+(\d+)/i)?.[1] || null;

    const playerId =
      text.match(/Player ID\s+(\d+)/i)?.[1] || null;

    const title = await page.title();

    return res.json({
      ok: true,
      source: "FUT.GG",
      title,
      playerId:
        playerId ? Number(playerId) : null,
      itemId:
        itemId ? Number(itemId) : null,
      capturedRequests: captured,
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
  console.log(`FC Price Browser running on ${port}`);
});
