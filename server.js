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

async function extractLowestBin(page) {
  return await page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    const parsePrice = (raw) => {
      if (!raw) return null;

      const compact = raw
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, "")
        .replace(/,/g, "")
        .toLowerCase();

      const match = compact.match(/(\d+(?:\.\d+)?)([km])?/i);
      if (!match) return null;

      let price = Number(match[1]);
      if (!Number.isFinite(price)) return null;

      if (match[2] === "k") price *= 1000;
      if (match[2] === "m") price *= 1000000;

      price = Math.round(price);

      return price >= 100 ? price : null;
    };

    const nodes = Array.from(document.querySelectorAll("body *"))
      .filter((el) => {
        const text = clean(el.textContent);
        return text === "Lowest BIN" || text.startsWith("Lowest BIN ");
      })
      .slice(0, 20);

    for (const node of nodes) {
      const candidates = [];

      if (node.nextElementSibling) {
        candidates.push(node.nextElementSibling);
      }

      if (node.parentElement) {
        candidates.push(node.parentElement);

        if (node.parentElement.nextElementSibling) {
          candidates.push(node.parentElement.nextElementSibling);
        }

        if (node.parentElement.parentElement) {
          candidates.push(node.parentElement.parentElement);
        }
      }

      for (const element of candidates) {
        const text = clean(
          element?.innerText || element?.textContent || ""
        );

        if (!text) continue;

        const matches =
          text.match(
            /\b\d{3,}(?:[.,]\d+)?\b|\b\d+(?:\.\d+)?[kKmM]\b/g
          ) || [];

        for (const value of matches) {
          const price = parsePrice(value);

          if (price) {
            return {
              price,
              raw: value,
              context: text.slice(0, 500)
            };
          }
        }
      }
    }

    const body = clean(document.body?.innerText || "");
    const index = body.indexOf("Lowest BIN");

    if (index !== -1) {
      const after = body.slice(index, index + 800);

      const matches =
        after.match(
          /\b\d{3,}(?:[.,]\d+)?\b|\b\d+(?:\.\d+)?[kKmM]\b/g
        ) || [];

      for (const value of matches) {
        const price = parsePrice(value);

        if (price) {
          return {
            price,
            raw: value,
            context: after
          };
        }
      }

      return {
        price: null,
        raw: null,
        context: after
      };
    }

    return {
      price: null,
      raw: null,
      context: null
    };
  });
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Price Browser",
    endpoint: "/price?url=https://www.fut.gg/players/..."
  });
});

app.get("/price", async (req, res) => {
  const url = req.query.url;

  if (!url || !url.startsWith("https://www.fut.gg/")) {
    return res.status(400).json({
      ok: false,
      error: "Valid public FUT.GG URL required"
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

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45000
    });

    await page.waitForTimeout(8000);

    const title = await page.title();
    const bodyText = await page.locator("body").innerText();

    const playerName =
      (await page
        .locator("h1")
        .first()
        .textContent()
        .catch(() => null)) ||
      title.split(" - ")[0] ||
      null;

    const itemIdMatch =
      bodyText.match(/Item ID\s+(\d+)/i);

    const playerIdMatch =
      bodyText.match(/Player ID\s+(\d+)/i);

    const lowestBin =
      await extractLowestBin(page);

    return res.json({
      ok: true,
      source: "FUT.GG",

      player:
        playerName
          ? playerName.trim()
          : null,

      playerId:
        playerIdMatch
          ? Number(playerIdMatch[1])
          : null,

      itemId:
        itemIdMatch
          ? Number(itemIdMatch[1])
          : null,

      lowestBin:
        lowestBin.price,

      rawLowestBin:
        lowestBin.raw,

      updatedAt:
        new Date().toISOString(),

      debug:
        lowestBin.price === null
          ? {
              message:
                "Page loaded, but Lowest BIN value was not found in visible DOM text.",
              lowestBinContext:
                lowestBin.context,
              title
            }
          : undefined
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
    `FC Price Browser running on ${port}`
  );
});
