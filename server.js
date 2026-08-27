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
    page = await b.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(4000);

    const title = await page.title();
    const text = await page.locator("body").innerText();

    res.json({
      ok: true,
      title,
      url,
      pageLoaded: text.length > 0,
      preview: text.slice(0, 1500)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err)
    });
  } finally {
    if (page) await page.close();
  }
});

app.listen(port, () => {
  console.log(`FC Price Browser running on ${port}`);
});
