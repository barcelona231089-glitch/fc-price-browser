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
    service: "FC Trading Price API",
    version: "4.0-debug",
    endpoints: {
      ratingDebug: "GET /debug-rating/83"
    }
  });
});

app.get("/debug-rating/:rating", async (req, res) => {
  const rating = Number(req.params.rating);

  if (!Number.isInteger(rating) || rating < 75 || rating > 99) {
    return res.status(400).json({
      ok: false,
      error: "Rating must be between 75 and 99"
    });
  }

  let page;

  try {
    const b = await getBrowser();

    page = await b.newPage({
      viewport: { width: 1440, height: 1400 }
    });

    const captured = [];

    page.on("response", async response => {
      const url = response.url();
      const type = response.request().resourceType();
      const contentType = response.headers()["content-type"] || "";

      const interesting =
        contentType.includes("application/json") ||
        url.includes("/api/") ||
        url.includes("r2.fut.gg");

      if (!interesting) return;
      if (captured.length >= 80) return;

      let body = null;

      try {
        body = await response.text();
      } catch {}

      captured.push({
        url,
        status: response.status(),
        resourceType: type,
        contentType,
        body: body ? body.slice(0, 6000) : null
      });
    });

    const target =
      `https://www.fut.gg/players/?overall__gte=${rating}` +
      `&overall__lte=${rating}&sorts=current_price`;

    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(10000);

    const title = await page.title();
    const bodyText = await page.locator("body").innerText();

    const links = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (!href) continue;
        if (href.includes("/players/")) {
          out.push({
            href,
            text: (a.innerText || a.textContent || "").trim().slice(0, 200)
          });
        }
      }
      return out.slice(0, 100);
    });

    res.json({
      ok: true,
      rating,
      target,
      title,
      bodyPreview: bodyText.slice(0, 5000),
      playerLinksFound: links.length,
      links,
      capturedResponses: captured,
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
  console.log(`FC Trading Price API running on ${port}`);
});
