export const FUTBIN_PUBLIC_VERSION = '10.63-futbin-public-gap-fill';

const BASE_URL = String(process.env.FUTBIN_PUBLIC_BASE_URL || 'https://www.futbin.com').replace(/\/+$/, '');
const ENABLED = String(process.env.FUTBIN_PUBLIC_ENABLED || 'true').toLowerCase() !== 'false';
const MAX_PER_CYCLE = clamp(Number(process.env.FUTBIN_PUBLIC_MAX_PER_CYCLE || 2), 1, 8);
const FETCH_TIMEOUT_MS = clamp(Number(process.env.FUTBIN_PUBLIC_TIMEOUT_MS || 12000), 4000, 30000);
const CARD_COOLDOWN_MS = clamp(Number(process.env.FUTBIN_PUBLIC_CARD_COOLDOWN_MIN || 30), 5, 720) * 60_000;
const GLOBAL_MIN_INTERVAL_MS = clamp(Number(process.env.FUTBIN_PUBLIC_MIN_INTERVAL_SEC || 3), 1, 60) * 1000;
const BLOCK_BACKOFF_MS = clamp(Number(process.env.FUTBIN_PUBLIC_BLOCK_BACKOFF_MIN || 30), 5, 360) * 60_000;
const MAX_HTML_BYTES = clamp(Number(process.env.FUTBIN_PUBLIC_MAX_HTML_MB || 4), 1, 12) * 1024 * 1024;
const MAX_HISTORY_POINTS = clamp(Number(process.env.FUTBIN_PUBLIC_MAX_HISTORY_POINTS || 12000), 100, 50000);

let schemaReady = false;
let lastFetchAt = 0;
let blockedUntil = 0;
let lastError = null;
let lastSuccessAt = null;
let lastFailureAt = null;
let calls = 0;
let matches = 0;
let cardsEnriched = 0;
let salesStored = 0;
let historyStored = 0;
let backfillStatus = { running: false, startedAt: null, finishedAt: null, requested: 0, processed: 0, enriched: 0, errors: 0, lastError: null };

const cardCache = new Map();
const lastCheckByEaId = new Map();

function clamp(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function cleanText(value) { return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim(); }
function normalizeName(value) {
  return cleanText(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function seasonBounds(gameYear = '26') {
  const yy = Number(String(gameYear).replace(/\D/g, '').slice(-2));
  const endYear = 2000 + (Number.isFinite(yy) ? yy : 26);
  return { start: `${endYear - 1}-09-01T00:00:00.000Z`, end: `${endYear}-09-30T23:59:59.999Z` };
}
function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function stripHtml(html) {
  return cleanText(decodeEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}
function firstTagText(html, tag) {
  const m = String(html || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
}
function parseAmount(value) {
  const raw = cleanText(value).replace(/,/g, '');
  if (!raw || raw === '-' || raw === '—') return null;
  const m = raw.match(/(-?\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2]?.toLowerCase() === 'k') n *= 1_000;
  if (m[2]?.toLowerCase() === 'm') n *= 1_000_000;
  return Math.round(n);
}
function parseDateLoose(value, year = new Date().getUTCFullYear()) {
  const text = cleanText(value);
  if (!text) return null;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return new Date(direct).toISOString();
  const withYear = Date.parse(`${text} ${year} UTC`);
  return Number.isFinite(withYear) ? new Date(withYear).toISOString() : null;
}
function median(values) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
function average(values) {
  const a = values.map(Number).filter(Number.isFinite);
  return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
}
function stddev(values) {
  const a = values.map(Number).filter(Number.isFinite);
  if (a.length < 2) return 0;
  const avg = average(a);
  return Math.sqrt(a.reduce((s, n) => s + (n - avg) ** 2, 0) / a.length);
}

async function fetchHtml(pathOrUrl) {
  if (!ENABLED) throw new Error('FUTBIN_PUBLIC_DISABLED');
  if (Date.now() < blockedUntil) throw new Error(`FUTBIN_PUBLIC_BACKOFF_UNTIL_${new Date(blockedUntil).toISOString()}`);
  const wait = GLOBAL_MIN_INTERVAL_MS - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);
  lastFetchAt = Date.now();
  calls += 1;
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BASE_URL}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,de;q=0.7',
        'cache-control': 'no-cache',
        'pragma': 'no-cache'
      }
    });
    if ([401,403,429].includes(res.status)) {
      blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
      throw new Error(`FUTBIN_PUBLIC_HTTP_${res.status}`);
    }
    if (!res.ok) throw new Error(`FUTBIN_PUBLIC_HTTP_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_HTML_BYTES) throw new Error(`FUTBIN_PUBLIC_BODY_TOO_LARGE_${buf.byteLength}`);
    lastSuccessAt = new Date().toISOString();
    lastError = null;
    return { url: res.url || url, html: buf.toString('utf8') };
  } catch (error) {
    lastFailureAt = new Date().toISOString();
    lastError = String(error?.message || error);
    throw error;
  } finally { clearTimeout(timer); }
}

function candidateScore(candidate, row) {
  let score = 0;
  const rowName = normalizeName(row?.name);
  const candName = normalizeName(candidate?.name || candidate?.slug);
  if (rowName && candName === rowName) score += 60;
  else if (rowName && candName && (candName.includes(rowName) || rowName.includes(candName))) score += 40;
  const rating = Number(row?.rating ?? row?.overall);
  if (Number.isFinite(rating) && Number(candidate?.rating) === rating) score += 45;
  const rarity = normalizeName(row?.rarityName || row?.cardType || row?.rarityGroupName);
  const text = normalizeName(candidate?.text);
  if (rarity && text && rarity.split(' ').some(t => t.length >= 4 && text.includes(t))) score += 20;
  return score;
}

export function parseFutbinSearchHtml(html, row = {}, gameYear = '26') {
  const source = String(html || '');
  const seen = new Set();
  const out = [];
  const re = new RegExp(`/${String(gameYear).replace(/\D/g, '')}/player/([^/?#"']+)/([^/?#"']+)`, 'g');
  let m;
  while ((m = re.exec(source))) {
    const key = `${m[1]}|${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const context = stripHtml(source.slice(Math.max(0, m.index - 900), Math.min(source.length, m.index + 1400)));
    const ratingMatch = context.match(/(?:^|\s)(\d{2})(?:\s|$)/);
    out.push({
      futbinId: m[1], slug: m[2], href: `/${gameYear}/player/${m[1]}/${m[2]}`,
      name: m[2].replace(/-/g, ' '), rating: ratingMatch ? Number(ratingMatch[1]) : null, text: context
    });
  }
  return out.sort((a, b) => candidateScore(b, row) - candidateScore(a, row));
}

export function parseFutbinPlayerHtml(html) {
  const text = stripHtml(html);
  const h1 = firstTagText(html, 'h1');
  const title = firstTagText(html, 'title');
  const titleSource = title || h1;
  const ratingMatch = title.match(/EA FC\s*\d+\s*-\s*(\d{2})\s*-/i) || h1.match(/\b(\d{2})\b/);
  const cardMatch = h1.match(/-\s*(.*?)\s*EA FC\s*\d+/i) || title.match(/^[^-]+?\s+(.+?)\s+EA FC\s*\d+/i);
  const gameMatches = [...text.matchAll(/has been used in\s+([\d,.]+)\s+games\s+with a GPG[^\d]*([\d.]+)/gi)];
  const currentPrice = text.match(/current price on FUT is\s+([\d,.kKmM]+)\s+on PlayStation,\s*([\d,.kKmM]+)\s+on Xbox,\s*and\s*([\d,.kKmM]+)\s+on PC/i);
  const trendMatches = [...text.matchAll(/Trend:\s*(-?\d+(?:\.\d+)?)%\s*\(([-+]?[^)]+)\)/gi)];
  const rangeMatch = text.match(/Price Range:\s*([\d,.kKmM]+)\s*-\s*([\d,.kKmM]+)/i);
  const addedMatch = text.match(/Player card added:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
  const bio = text.match(/plays for\s+(.+?)\s+in\s+(.+?)\.\s+He was born/i);
  return {
    title: titleSource || null,
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    cardVersion: cardMatch ? cleanText(cardMatch[1]) : null,
    gamesPlayedConsole: gameMatches[0] ? parseAmount(gameMatches[0][1]) : null,
    gpgConsole: gameMatches[0] ? Number(gameMatches[0][2]) : null,
    gamesPlayedPc: gameMatches[1] ? parseAmount(gameMatches[1][1]) : null,
    gpgPc: gameMatches[1] ? Number(gameMatches[1][2]) : null,
    pricePlayStation: currentPrice ? parseAmount(currentPrice[1]) : null,
    priceXbox: currentPrice ? parseAmount(currentPrice[2]) : null,
    pricePc: currentPrice ? parseAmount(currentPrice[3]) : null,
    trendConsolePct: trendMatches[0] ? Number(trendMatches[0][1]) : null,
    trendPcPct: trendMatches[1] ? Number(trendMatches[1][1]) : null,
    priceRangeMin: rangeMatch ? parseAmount(rangeMatch[1]) : null,
    priceRangeMax: rangeMatch ? parseAmount(rangeMatch[2]) : null,
    cardAddedAt: addedMatch ? parseDateLoose(addedMatch[1]) : null,
    club: bio ? cleanText(bio[1]) : null,
    league: bio ? cleanText(bio[2]) : null
  };
}

function timestampMs(value) {
  if (typeof value === 'number') {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function historyPointFromObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const timeKeys = ['timestamp','time','date','datetime','recorded_at','recordedAt','x'];
  const valueKeys = ['price','value','y','bin','avg','average'];
  let time = null, value = null;
  for (const key of timeKeys) if (key in obj) { time = timestampMs(obj[key]); if (time) break; }
  for (const key of valueKeys) if (key in obj) {
    const n = parseAmount(obj[key]) ?? Number(obj[key]);
    if (Number.isFinite(n) && n > 0) { value = Math.round(n); break; }
  }
  return time && value ? { observedAt: new Date(time).toISOString(), price: value } : null;
}
function walkJson(node, points, depth = 0) {
  if (depth > 10 || points.length >= MAX_HISTORY_POINTS) return;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (Array.isArray(item) && item.length >= 2) {
        const t = timestampMs(item[0]);
        const p = parseAmount(item[1]) ?? Number(item[1]);
        if (t && Number.isFinite(p) && p > 0) points.push({ observedAt: new Date(t).toISOString(), price: Math.round(p) });
      } else {
        const p = historyPointFromObject(item); if (p) points.push(p);
        walkJson(item, points, depth + 1);
      }
      if (points.length >= MAX_HISTORY_POINTS) break;
    }
  } else if (node && typeof node === 'object') {
    const p = historyPointFromObject(node); if (p) points.push(p);
    for (const value of Object.values(node)) { walkJson(value, points, depth + 1); if (points.length >= MAX_HISTORY_POINTS) break; }
  }
}
function extractEmbeddedHistory(html) {
  const points = [];
  const scripts = [...String(html || '').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => String(m[1] || '').trim());
  for (const raw of scripts) {
    if (points.length >= MAX_HISTORY_POINTS) break;
    if (!raw || raw.length > 6_000_000) continue;
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try { walkJson(JSON.parse(decodeEntities(raw)), points); } catch {}
    }
  }
  const unique = new Map();
  for (const p of points) unique.set(`${p.observedAt}|${p.price}`, p);
  return [...unique.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-MAX_HISTORY_POINTS);
}

export function parseFutbinMarketHtml(html) {
  const source = String(html || '');
  const text = stripHtml(source);
  const sales = [];
  const tables = source.match(/<table\b[\s\S]*?<\/table>/gi) || [];
  for (const table of tables) {
    const headerText = stripHtml(table).toLowerCase();
    if (!headerText.includes('listed for') || !headerText.includes('sold for')) continue;
    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    for (const tr of rows) {
      const cells = [...tr.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripHtml(m[1]));
      if (cells.length < 3 || /listed for/i.test(cells.join(' '))) continue;
      const listedPrice = parseAmount(cells[1]);
      const soldPrice = parseAmount(cells[2]) || 0;
      if (!listedPrice) continue;
      sales.push({ observedAt: parseDateLoose(cells[0]), listedPrice, soldPrice, sold: soldPrice > 0, eaTax: parseAmount(cells[3]) || 0, netPrice: parseAmount(cells[4]) || 0, type: cells[5] || null });
    }
  }
  const labelValue = label => {
    const m = text.match(new RegExp(`${label}\\s*([\\d,.kKmM]+)`, 'i'));
    return m ? parseAmount(m[1]) : null;
  };
  const trend = text.match(/Trend:\s*(-?\d+(?:\.\d+)?)%/i);
  return {
    averageBin: labelValue('Average BIN'), high: labelValue('High'), low: labelValue('Low'),
    discardPrice: labelValue('Discard Price'), eaAveragePrice: labelValue('EA Avg\\. Price'),
    trendPct: trend ? Number(trend[1]) : null, sales, history: extractEmbeddedHistory(source)
  };
}

export function computeFutbinSalesMetrics(sales = []) {
  const valid = sales.filter(s => Number(s?.listedPrice) > 0);
  const sold = valid.filter(s => Number(s?.soldPrice) > 0);
  const unsold = valid.filter(s => !(Number(s?.soldPrice) > 0));
  const soldPrices = sold.map(s => Number(s.soldPrice));
  const listed = valid.map(s => Number(s.listedPrice));
  const unsoldListed = unsold.map(s => Number(s.listedPrice));
  const avgSold = average(soldPrices), medSold = median(soldPrices), avgUnsold = average(unsoldListed);
  const sellThroughRate = valid.length ? sold.length / valid.length : null;
  const times = valid.map(s => Date.parse(s.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const hours = times.length >= 2 ? Math.max((times.at(-1) - times[0]) / 3_600_000, 1 / 60) : null;
  const saleVelocityPerHour = hours ? sold.length / hours : null;
  const dispersion = avgSold ? stddev(soldPrices) / avgSold : null;
  const sampleFactor = Math.min(1, valid.length / 30);
  const velocityFactor = saleVelocityPerHour == null ? 0 : Math.min(1, saleVelocityPerHour / 12);
  const stabilityFactor = dispersion == null ? 0.4 : Math.max(0, 1 - Math.min(1, dispersion / 0.18));
  const liquidityScore = sellThroughRate == null ? null : Math.round(100 * (0.45 * sellThroughRate + 0.2 * sampleFactor + 0.2 * velocityFactor + 0.15 * stabilityFactor));
  return {
    listingsObserved: valid.length, soldListings: sold.length, unsoldListings: unsold.length,
    sellThroughRate: sellThroughRate == null ? null : Number((sellThroughRate * 100).toFixed(2)),
    lastSalePrice: soldPrices.length ? soldPrices[0] : null,
    averageSoldPrice: avgSold == null ? null : Math.round(avgSold), medianSoldPrice: medSold == null ? null : Math.round(medSold),
    minSoldPrice: soldPrices.length ? Math.min(...soldPrices) : null, maxSoldPrice: soldPrices.length ? Math.max(...soldPrices) : null,
    averageListedPrice: listed.length ? Math.round(average(listed)) : null, averageUnsoldPrice: avgUnsold == null ? null : Math.round(avgUnsold),
    soldVsUnsoldGapPct: avgSold && avgUnsold ? Number((((avgUnsold - avgSold) / avgSold) * 100).toFixed(2)) : null,
    saleVelocityPerHour: saleVelocityPerHour == null ? null : Number(saleVelocityPerHour.toFixed(2)),
    priceStabilityPct: dispersion == null ? null : Number((Math.max(0, 100 - dispersion * 100)).toFixed(2)), liquidityScore
  };
}

async function ensureSchema(pool) {
  if (!pool || schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_public_cards (ea_id VARCHAR(32) PRIMARY KEY, futbin_id VARCHAR(120), slug VARCHAR(220), game_year VARCHAR(2) NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_public_sales (ea_id VARCHAR(32) NOT NULL, observed_at TIMESTAMPTZ, listed_price INTEGER NOT NULL, sold_price INTEGER NOT NULL DEFAULT 0, ea_tax INTEGER NOT NULL DEFAULT 0, net_price INTEGER NOT NULL DEFAULT 0, payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (ea_id, observed_at, listed_price, sold_price))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_futbin_public_sales_ea_time ON fc_futbin_public_sales (ea_id, observed_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_public_history (ea_id VARCHAR(32) NOT NULL, observed_at TIMESTAMPTZ NOT NULL, price INTEGER NOT NULL, source VARCHAR(40) NOT NULL DEFAULT 'FUTBIN_PUBLIC', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (ea_id, observed_at, price))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_futbin_public_history_ea_time ON fc_futbin_public_history (ea_id, observed_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1063_season_daily (game_year VARCHAR(2) NOT NULL, ea_id VARCHAR(32) NOT NULL, day DATE NOT NULL, open_price INTEGER, close_price INTEGER, low_price INTEGER, high_price INTEGER, average_price INTEGER, observations INTEGER NOT NULL DEFAULT 0, source VARCHAR(40) NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (game_year, ea_id, day, source))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1063_market_index_history (game_year VARCHAR(2) NOT NULL, observed_at TIMESTAMPTZ NOT NULL, index_name VARCHAR(80) NOT NULL DEFAULT 'MARKET', value NUMERIC(18,4) NOT NULL, source VARCHAR(40) NOT NULL DEFAULT 'FUTBIN_PUBLIC', payload JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY (game_year, observed_at, index_name, source))`);
  schemaReady = true;
}

async function persistCard(pool, row, card, detail) {
  if (!pool) return;
  await ensureSchema(pool);
  const eaId = String(row.eaId ?? row.id ?? '');
  await pool.query(`INSERT INTO fc_futbin_public_cards (ea_id, futbin_id, slug, game_year, fetched_at, payload) VALUES ($1,$2,$3,$4,NOW(),$5::jsonb) ON CONFLICT (ea_id) DO UPDATE SET futbin_id=EXCLUDED.futbin_id, slug=EXCLUDED.slug, game_year=EXCLUDED.game_year, fetched_at=NOW(), payload=EXCLUDED.payload`, [eaId, card.futbinId, card.slug, String(detail.gameYear), JSON.stringify(detail)]);
  for (const sale of detail.sales || []) {
    const result = await pool.query(`INSERT INTO fc_futbin_public_sales (ea_id, observed_at, listed_price, sold_price, ea_tax, net_price, payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`, [eaId, sale.observedAt, sale.listedPrice, sale.soldPrice || 0, sale.eaTax || 0, sale.netPrice || 0, JSON.stringify(sale)]);
    salesStored += result.rowCount || 0;
  }
  for (const point of detail.history || []) {
    if (!point.observedAt || !(Number(point.price) > 0)) continue;
    const result = await pool.query(`INSERT INTO fc_futbin_public_history (ea_id, observed_at, price) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [eaId, point.observedAt, Math.round(point.price)]);
    historyStored += result.rowCount || 0;
  }
}

function mergeIntoRow(row, detail) {
  const metrics = detail.salesMetrics || {};
  row.futbinPublic = detail;
  row.futbinGamesPlayedConsole = detail.gamesPlayedConsole ?? null;
  row.futbinGamesPlayedPc = detail.gamesPlayedPc ?? null;
  row.futbinTrendPct = detail.trendConsolePct ?? detail.marketTrendPct ?? null;
  row.futbinMedianSoldPrice = metrics.medianSoldPrice ?? null;
  row.futbinAverageSoldPrice = metrics.averageSoldPrice ?? null;
  row.futbinSellThroughRate = metrics.sellThroughRate ?? null;
  row.futbinSaleVelocityPerHour = metrics.saleVelocityPerHour ?? null;
  row.futbinLiquidityScore = metrics.liquidityScore ?? null;
  row.futbinListingsObserved = metrics.listingsObserved ?? 0;
  row.futbinSoldListings = metrics.soldListings ?? 0;
  row.futbinUnsoldListings = metrics.unsoldListings ?? 0;
  if (!(Number(row.futbinPrice) > 0)) row.futbinPrice = detail.pricePlayStation || detail.marketAverageBin || metrics.medianSoldPrice || null;
  row.futbinSource = 'FUTBIN_PUBLIC_GAP_FILL';
  row.futbinUpdatedAt = detail.fetchedAt;
  return row;
}

async function resolveCard(row, gameYear) {
  const eaId = String(row.eaId ?? row.id ?? '');
  if (cardCache.has(eaId)) return cardCache.get(eaId);
  const name = cleanText(row.name);
  if (!name) return null;
  const paths = [`/players?search=${encodeURIComponent(name)}`, `/players?player_name=${encodeURIComponent(name)}`];
  let candidates = [];
  for (const path of paths) {
    try {
      const { html } = await fetchHtml(path);
      candidates = parseFutbinSearchHtml(html, row, gameYear);
      if (candidates.length) break;
    } catch (error) {
      if (/HTTP_40[13]|HTTP_429|BACKOFF/.test(String(error?.message || error))) throw error;
    }
  }
  const best = candidates[0] || null;
  if (best && candidateScore(best, row) >= 45) { cardCache.set(eaId, best); matches += 1; return best; }
  return null;
}

export async function fetchFutbinPublicForRow(row, { gameYear = '26', pool = null, force = false } = {}) {
  if (!ENABLED || !row) return null;
  const eaId = String(row.eaId ?? row.id ?? '');
  if (!eaId) return null;
  const last = lastCheckByEaId.get(eaId) || 0;
  if (!force && Date.now() - last < CARD_COOLDOWN_MS) return row.futbinPublic || null;
  lastCheckByEaId.set(eaId, Date.now());
  const card = await resolveCard(row, String(gameYear));
  if (!card) return null;
  const summary = await fetchHtml(card.href);
  const market = await fetchHtml(`${card.href}/market`);
  const player = parseFutbinPlayerHtml(summary.html);
  const marketData = parseFutbinMarketHtml(market.html);
  const metrics = computeFutbinSalesMetrics(marketData.sales);
  const detail = {
    version: FUTBIN_PUBLIC_VERSION, source: 'FUTBIN_PUBLIC', gameYear: String(gameYear), futbinId: card.futbinId, slug: card.slug,
    url: `${BASE_URL}${card.href}`, fetchedAt: new Date().toISOString(), ...player,
    marketAverageBin: marketData.averageBin, marketHigh: marketData.high, marketLow: marketData.low,
    discardPrice: marketData.discardPrice, eaAveragePrice: marketData.eaAveragePrice, marketTrendPct: marketData.trendPct,
    salesMetrics: metrics, sales: marketData.sales.slice(0, 500), history: marketData.history.slice(-MAX_HISTORY_POINTS)
  };
  mergeIntoRow(row, detail);
  await persistCard(pool, row, card, detail).catch(error => { lastError = `persist: ${String(error?.message || error)}`; });
  cardsEnriched += 1;
  return detail;
}

function candidatePriority(row) {
  let score = 0;
  if (row?.adaptiveDataNeeds?.futbinDeepDive === true) score += 100;
  if (row?.tracked === true) score += 80;
  if (!(Number(row?.futbinMedianSoldPrice) > 0)) score += 35;
  if (!(Number(row?.futbinGamesPlayedConsole) > 0)) score += 25;
  if (!(Number.isFinite(Number(row?.futbinTrendPct)))) score += 20;
  if (row?.adaptivePublicCall === 'BUY' || row?.adaptivePublicCall === 'SELL') score += 60;
  score += Math.min(25, Number(row?.aiConfidence || 0) / 4);
  return score;
}

export async function enrichRowsWithFutbinPublicGapFill({ rows = [], brainWork = new Map(), gameYear = '26', pool = null } = {}) {
  if (!ENABLED || !Array.isArray(rows) || !rows.length || Date.now() < blockedUntil) return 0;
  const candidates = [...rows]
    .filter(row => row?.name && (row.adaptiveDataNeeds?.futbinDeepDive === true || row.tracked || row.adaptivePublicCall || !(Number(row.futbinMedianSoldPrice) > 0)))
    .sort((a, b) => candidatePriority(b) - candidatePriority(a))
    .slice(0, MAX_PER_CYCLE);
  let enriched = 0;
  for (const row of candidates) {
    try {
      const detail = await fetchFutbinPublicForRow(row, { gameYear, pool });
      if (!detail) continue;
      const work = brainWork?.get?.(String(row.eaId));
      if (work?.input && typeof work.input === 'object') work.input.futbinPublic = detail;
      enriched += 1;
    } catch (error) {
      lastError = String(error?.message || error);
      if (/BACKOFF|HTTP_401|HTTP_403|HTTP_429/.test(lastError)) break;
    }
  }
  return enriched;
}

async function aggregateExistingPriceHistory(pool, gameYear = '26') {
  await ensureSchema(pool);
  const bounds = seasonBounds(gameYear);
  const result = await pool.query(`
    WITH points AS (
      SELECT ea_id::text AS ea_id, recorded_at, price, date_trunc('day', recorded_at)::date AS day,
        row_number() OVER (PARTITION BY ea_id, date_trunc('day', recorded_at)::date ORDER BY recorded_at ASC) AS rn_first,
        row_number() OVER (PARTITION BY ea_id, date_trunc('day', recorded_at)::date ORDER BY recorded_at DESC) AS rn_last
      FROM fc_price_history WHERE recorded_at >= $2::timestamptz AND recorded_at <= $3::timestamptz AND price > 0
    ), agg AS (
      SELECT ea_id, day, min(price)::int AS low_price, max(price)::int AS high_price, round(avg(price))::int AS average_price,
        count(*)::int AS observations, max(price) FILTER (WHERE rn_first=1)::int AS open_price, max(price) FILTER (WHERE rn_last=1)::int AS close_price
      FROM points GROUP BY ea_id, day
    )
    INSERT INTO fc_v1063_season_daily (game_year, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, source, payload)
    SELECT $1, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, 'FUTGG_POSTGRES', '{}'::jsonb FROM agg
    ON CONFLICT (game_year, ea_id, day, source) DO UPDATE SET open_price=EXCLUDED.open_price, close_price=EXCLUDED.close_price, low_price=EXCLUDED.low_price, high_price=EXCLUDED.high_price, average_price=EXCLUDED.average_price, observations=EXCLUDED.observations
    RETURNING 1
  `, [String(gameYear), bounds.start, bounds.end]);
  return result.rowCount || 0;
}

async function aggregateFutbinHistory(pool, gameYear = '26') {
  await ensureSchema(pool);
  const bounds = seasonBounds(gameYear);
  const result = await pool.query(`
    WITH points AS (
      SELECT ea_id, observed_at, price, date_trunc('day', observed_at)::date AS day,
        row_number() OVER (PARTITION BY ea_id, date_trunc('day', observed_at)::date ORDER BY observed_at ASC) AS rn_first,
        row_number() OVER (PARTITION BY ea_id, date_trunc('day', observed_at)::date ORDER BY observed_at DESC) AS rn_last
      FROM fc_futbin_public_history WHERE observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz AND price > 0
    ), agg AS (
      SELECT ea_id, day, min(price)::int AS low_price, max(price)::int AS high_price, round(avg(price))::int AS average_price,
        count(*)::int AS observations, max(price) FILTER (WHERE rn_first=1)::int AS open_price, max(price) FILTER (WHERE rn_last=1)::int AS close_price
      FROM points GROUP BY ea_id, day
    )
    INSERT INTO fc_v1063_season_daily (game_year, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, source, payload)
    SELECT $1, ea_id, day, open_price, close_price, low_price, high_price, average_price, observations, 'FUTBIN_PUBLIC', '{}'::jsonb FROM agg
    ON CONFLICT (game_year, ea_id, day, source) DO UPDATE SET open_price=EXCLUDED.open_price, close_price=EXCLUDED.close_price, low_price=EXCLUDED.low_price, high_price=EXCLUDED.high_price, average_price=EXCLUDED.average_price, observations=EXCLUDED.observations
    RETURNING 1
  `, [String(gameYear), bounds.start, bounds.end]);
  return result.rowCount || 0;
}

export async function bootstrapFc26SeasonMemory({ pool = null, gameYear = '26' } = {}) {
  if (!pool) return { ok: false, reason: 'NO_DB' };
  await ensureSchema(pool);
  const futggDaily = await aggregateExistingPriceHistory(pool, gameYear);
  const futbinDaily = await aggregateFutbinHistory(pool, gameYear);
  return { ok: true, gameYear: String(gameYear), futggDaily, futbinDaily };
}

export async function attachSeasonMemoryToRows({ rows = [], pool = null, gameYear = '26' } = {}) {
  if (!pool || !Array.isArray(rows) || !rows.length) return 0;
  await ensureSchema(pool);
  const bounds = seasonBounds(gameYear);
  const ids = [...new Set(rows.map(r => String(r.eaId ?? '')).filter(Boolean))].slice(0, 1500);
  if (!ids.length) return 0;
  const result = await pool.query(`
    WITH d AS (
      SELECT ea_id, day, COALESCE(close_price, average_price) AS close_price,
        lag(COALESCE(close_price, average_price)) OVER (PARTITION BY ea_id ORDER BY day) AS prev_close,
        low_price, high_price, average_price, source
      FROM fc_v1063_season_daily
      WHERE game_year=$1 AND ea_id=ANY($2::text[]) AND day >= $3::date AND day <= $4::date
    ), m AS (
      SELECT ea_id, count(*)::int AS days, round(avg(average_price))::int AS mean_price,
        min(low_price)::int AS season_low, max(high_price)::int AS season_high,
        avg(CASE WHEN prev_close>0 THEN ((close_price-prev_close)::numeric/prev_close)*100 END) AS avg_daily_change,
        avg(CASE WHEN prev_close>0 THEN abs(((close_price-prev_close)::numeric/prev_close)*100) END) AS avg_abs_daily_change,
        avg(CASE WHEN prev_close>0 AND ((close_price-prev_close)::numeric/prev_close)<=-0.08 THEN 1.0 ELSE 0.0 END) AS crash_day_share,
        count(DISTINCT source)::int AS source_count
      FROM d GROUP BY ea_id
    ) SELECT * FROM m
  `, [String(gameYear), ids, bounds.start.slice(0,10), bounds.end.slice(0,10)]);
  const byId = new Map(result.rows.map(r => [String(r.ea_id), r]));
  let attached = 0;
  for (const row of rows) {
    const s = byId.get(String(row.eaId)); if (!s) continue;
    row.fc26SeasonMemory = {
      days: Number(s.days || 0), meanPrice: Number(s.mean_price || 0) || null,
      seasonLow: Number(s.season_low || 0) || null, seasonHigh: Number(s.season_high || 0) || null,
      avgDailyChangePct: s.avg_daily_change == null ? null : Number(Number(s.avg_daily_change).toFixed(3)),
      avgAbsDailyChangePct: s.avg_abs_daily_change == null ? null : Number(Number(s.avg_abs_daily_change).toFixed(3)),
      crashDaySharePct: s.crash_day_share == null ? null : Number((Number(s.crash_day_share) * 100).toFixed(2)),
      sources: Number(s.source_count || 0)
    };
    attached += 1;
  }
  return attached;
}

async function fetchMarketIndexHistory(gameYear = '26', pool = null) {
  if (!pool) return 0;
  await ensureSchema(pool);
  const { html } = await fetchHtml(`/${gameYear}/market`);
  const points = extractEmbeddedHistory(html);
  let inserted = 0;
  for (const point of points) {
    const result = await pool.query(`INSERT INTO fc_v1063_market_index_history (game_year, observed_at, index_name, value, source, payload) VALUES ($1,$2,'MARKET_GENERIC',$3,'FUTBIN_PUBLIC',$4::jsonb) ON CONFLICT DO NOTHING`, [String(gameYear), point.observedAt, point.price, JSON.stringify(point)]);
    inserted += result.rowCount || 0;
  }
  return inserted;
}

export async function startFc26Backfill({ rows = [], pool = null, gameYear = '26', limit = 500 } = {}) {
  if (backfillStatus.running) return { ok: false, reason: 'ALREADY_RUNNING', status: backfillStatus };
  const queue = [...rows].filter(r => r?.eaId && r?.name).sort((a,b) => candidatePriority(b)-candidatePriority(a)).slice(0, clamp(Number(limit || 500), 1, 1000));
  backfillStatus = { running: true, startedAt: new Date().toISOString(), finishedAt: null, requested: queue.length, processed: 0, enriched: 0, errors: 0, lastError: null };
  (async () => {
    try {
      await bootstrapFc26SeasonMemory({ pool, gameYear });
      await fetchMarketIndexHistory(gameYear, pool).catch(error => { backfillStatus.lastError = String(error?.message || error); });
      for (const row of queue) {
        if (Date.now() < blockedUntil) break;
        backfillStatus.processed += 1;
        try {
          const detail = await fetchFutbinPublicForRow(row, { gameYear, pool, force: true });
          if (detail) backfillStatus.enriched += 1;
        } catch (error) {
          backfillStatus.errors += 1; backfillStatus.lastError = String(error?.message || error);
          if (/HTTP_401|HTTP_403|HTTP_429|BACKOFF/.test(backfillStatus.lastError)) break;
        }
        await sleep(GLOBAL_MIN_INTERVAL_MS);
      }
      await aggregateFutbinHistory(pool, gameYear).catch(() => {});
    } finally { backfillStatus.running = false; backfillStatus.finishedAt = new Date().toISOString(); }
  })();
  return { ok: true, status: backfillStatus };
}

export async function futbinPublicStatus({ pool = null, gameYear = '26' } = {}) {
  let db = null;
  if (pool) {
    try {
      await ensureSchema(pool);
      const r = await pool.query(`SELECT (SELECT COUNT(*)::int FROM fc_futbin_public_cards) AS cards, (SELECT COUNT(*)::int FROM fc_futbin_public_sales) AS sales, (SELECT COUNT(*)::int FROM fc_futbin_public_history) AS history, (SELECT COUNT(*)::int FROM fc_v1063_season_daily WHERE game_year=$1) AS season_daily, (SELECT COUNT(*)::int FROM fc_v1063_market_index_history WHERE game_year=$1) AS market_index`, [String(gameYear)]);
      db = r.rows?.[0] || null;
    } catch (error) { db = { error: String(error?.message || error) }; }
  }
  return {
    ok: true, version: FUTBIN_PUBLIC_VERSION, enabled: ENABLED, mode: 'FUTGG_FIRST_FUTBIN_PUBLIC_GAP_FILL', parseApiRequired: false,
    maxPerCycle: MAX_PER_CYCLE, cooldownMinutes: Math.round(CARD_COOLDOWN_MS/60_000), blockedUntil: blockedUntil ? new Date(blockedUntil).toISOString() : null,
    lastSuccessAt, lastFailureAt, lastError, calls, matches, cardsEnriched, salesStored, historyStored, db, backfill: backfillStatus
  };
}
