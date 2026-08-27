import express from "express";
import { chromium } from "playwright";

const app = express();
const port = process.env.PORT || 3000;
app.use(express.json({ limit: "1mb" }));

let browser;
const CACHE_TTL_MS = 60000;
const cache = new Map();

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

function avg(a) {
  const n = a.filter(Number.isFinite);
  return n.length ? Math.round(n.reduce((x,y)=>x+y,0)/n.length) : null;
}

function pct(cur, old) {
  return Number.isFinite(cur) && Number.isFinite(old) && old !== 0
    ? Number((((cur-old)/old)*100).toFixed(2))
    : null;
}

function closest(history, msAgo) {
  if (!Array.isArray(history) || !history.length) return null;
  const target = Date.now() - msAgo;
  let best = null, diff = Infinity;
  for (const p of history) {
    const t = Date.parse(p.date);
    if (!Number.isFinite(t) || !Number.isFinite(p.price)) continue;
    const d = Math.abs(t-target);
    if (d < diff) { diff = d; best = p.price; }
  }
  return best;
}

async function fetchPrice(url) {
  const c = cache.get(url);
  if (c && Date.now()-c.t < CACHE_TTL_MS) return {...c.data, cached:true};

  const b = await getBrowser();
  const page = await b.newPage({ viewport:{width:1440,height:1200} });

  try {
    const waitPrice = page.waitForResponse(
      r => r.url().includes("/api/fut/player-prices/") && r.status() === 200,
      { timeout: 30000 }
    );

    await page.goto(url, { waitUntil:"domcontentloaded", timeout:45000 });

    const response = await waitPrice;
    const json = await response.json();
    const data = json?.data;
    if (!data?.currentPrice) throw new Error("currentPrice missing");

    const text = await page.locator("body").innerText();
    const title = await page.title();

    const rating = Number(
      title.match(/\b(\d{2})\s+OVR\b/i)?.[1] ||
      text.match(/\b(\d{2})\s+OVR\b/i)?.[1] ||
      NaN
    );

    const playerId = text.match(/Player ID\s+(\d+)/i)?.[1] || null;
    const itemId = text.match(/Item ID\s+(\d+)/i)?.[1] || null;

    const current = data.currentPrice;
    const completed = data.completedAuctions || [];
    const live = data.liveAuctions || [];
    const history = data.history || [];

    const liveBins = live.map(x=>x.buyNowPrice).filter(Number.isFinite);
    const recentSold = completed.slice(0,20).map(x=>x.soldPrice).filter(Number.isFinite);

    const p1h = closest(history, 3600000);
    const p24h = closest(history, 86400000);
    const p7d = closest(history, 604800000);

    const prices = history.map(x=>x.price).filter(Number.isFinite);
    const low = prices.length ? Math.min(...prices) : null;
    const high = prices.length ? Math.max(...prices) : null;
    const havg = avg(prices);

    let marketStatus = "STABLE";
    let signal = "HOLD";

    if (Number.isFinite(havg) && current.price <= havg*0.88) {
      marketStatus = "STRONG DROP"; signal = "WATCH";
    } else if (Number.isFinite(havg) && current.price <= havg*0.93) {
      marketStatus = "DROP"; signal = "WATCH";
    }

    if (Number.isFinite(low) && current.price <= low*1.05) {
      marketStatus = "NEAR LOW";
      signal = Number.isFinite(havg) && current.price <= havg*0.93 ? "BUY" : "WATCH";
    } else if (Number.isFinite(low) && current.price >= low*1.10 && Number.isFinite(high) && current.price < high*0.95) {
      marketStatus = "STRONG RECOVERY";
    } else if (Number.isFinite(low) && current.price >= low*1.05 && Number.isFinite(high) && current.price < high*0.95) {
      marketStatus = "RECOVERY";
    }

    if (Number.isFinite(high) && current.price >= high*0.95) {
      marketStatus = "HIGH MARKET"; signal = "SELL";
    }

    const result = {
      ok:true,
      source:"FUT.GG",
      player:title.replace(/\s+\d{2}\s+OVR.*$/i,"").trim(),
      rating:Number.isFinite(rating)?rating:null,
      playerId:playerId?Number(playerId):null,
      itemId:itemId?Number(itemId):null,
      platform:current.platform,
      price:current.price,
      lowestLiveBin:liveBins.length?Math.min(...liveBins):null,
      lastSoldPrice:completed.length?completed[0].soldPrice:null,
      averageRecentSold:avg(recentSold),
      extinct:current.isExtinct,
      change1h:pct(current.price,p1h),
      change24h:pct(current.price,p24h),
      change7d:pct(current.price,p7d),
      recentLow:low,
      recentHigh:high,
      recentAverage:havg,
      marketStatus,
      signal,
      priceUpdatedAt:current.priceUpdatedAt,
      history:history.slice(-168),
      updatedAt:new Date().toISOString(),
      cached:false
    };

    cache.set(url,{t:Date.now(),data:result});
    return result;
  } finally {
    await page.close().catch(()=>{});
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = {ok:false,url:items[idx],error:String(e)}; }
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)}, worker));
  return out;
}

function ratingSummary(players) {
  const rows = [];
  for (let rating=75; rating<=99; rating++) {
    const cards = players.filter(p=>p?.ok && p.rating===rating && Number.isFinite(p.price));
    const prices = cards.map(p=>p.price);
    const d24 = cards.map(p=>p.change24h).filter(Number.isFinite);
    const d7 = cards.map(p=>p.change7d).filter(Number.isFinite);

    rows.push({
      rating,
      label:`${rating} Rated`,
      playerCount:cards.length,
      averagePrice:avg(prices),
      minimumPrice:prices.length?Math.min(...prices):null,
      maximumPrice:prices.length?Math.max(...prices):null,
      averageChange24h:d24.length?Number((d24.reduce((a,b)=>a+b,0)/d24.length).toFixed(2)):null,
      averageChange7d:d7.length?Number((d7.reduce((a,b)=>a+b,0)/d7.length).toFixed(2)):null
    });
  }
  return rows;
}

app.get("/", (req,res)=>{
  res.json({
    online:true,
    service:"FC Trading Price API",
    version:"2.0",
    endpoints:{
      single:"GET /price?url=<FUT.GG URL>",
      batch:"POST /batch-prices",
      ratings:"POST /rating-markets"
    }
  });
});

app.get("/price", async (req,res)=>{
  const url = req.query.url;
  if (!url || !url.startsWith("https://www.fut.gg/")) {
    return res.status(400).json({ok:false,error:"Valid FUT.GG URL required"});
  }
  try { res.json(await fetchPrice(url)); }
  catch(e) { res.status(500).json({ok:false,error:String(e)}); }
});

app.post("/batch-prices", async (req,res)=>{
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const valid = urls.filter(x=>typeof x==="string" && x.startsWith("https://www.fut.gg/")).slice(0,50);
  if (!valid.length) return res.status(400).json({ok:false,error:"Provide urls: [...]"});
  const players = await mapLimit(valid,3,fetchPrice);
  res.json({ok:true,count:players.length,players,updatedAt:new Date().toISOString()});
});

app.post("/rating-markets", async (req,res)=>{
  const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  const valid = urls.filter(x=>typeof x==="string" && x.startsWith("https://www.fut.gg/")).slice(0,50);
  if (!valid.length) return res.status(400).json({ok:false,error:"Provide urls: [...]"});
  const players = await mapLimit(valid,3,fetchPrice);
  res.json({
    ok:true,
    source:"FUT.GG",
    ratings:ratingSummary(players),
    players,
    updatedAt:new Date().toISOString()
  });
});

app.listen(port,()=>console.log(`FC Trading Price API running on ${port}`));
