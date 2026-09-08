export const FUTBIN_PUBLIC_VERSION = '10.64-futbin-complete-market-memory';

const BASE_URL = String(process.env.FUTBIN_PUBLIC_BASE_URL || 'https://www.futbin.com').replace(/\/+$/, '');
const ENABLED = String(process.env.FUTBIN_PUBLIC_ENABLED || 'true').toLowerCase() !== 'false';
const MAX_PER_CYCLE = clamp(Number(process.env.FUTBIN_PUBLIC_MAX_PER_CYCLE || 3), 1, 10);
const FETCH_TIMEOUT_MS = clamp(Number(process.env.FUTBIN_PUBLIC_TIMEOUT_MS || 12000), 4000, 30000);
const CARD_COOLDOWN_MS = clamp(Number(process.env.FUTBIN_PUBLIC_CARD_COOLDOWN_MIN || 30), 5, 720) * 60_000;
const GLOBAL_MIN_INTERVAL_MS = clamp(Number(process.env.FUTBIN_PUBLIC_MIN_INTERVAL_SEC || 3), 1, 60) * 1000;
const BACKFILL_PAUSE_MS = clamp(Number(process.env.FUTBIN_PUBLIC_BACKFILL_PAUSE_SEC || 4), 2, 120) * 1000;
const HISTORY_WINDOWS = Object.freeze({ m5: 5*60_000, m15: 15*60_000, h1: 60*60_000, h6: 6*60*60_000, h24: 24*60*60_000, d7: 7*24*60*60_000, d30: 30*24*60*60_000 });
const MARKET_OVERVIEW_REFRESH_MS = clamp(Number(process.env.FUTBIN_MARKET_OVERVIEW_REFRESH_MIN || 10), 5, 60) * 60_000;
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
let marketOverviewCache = null;
let marketOverviewFetchedAt = 0;
let marketOverviewError = null;

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
  const dmy = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    let y = Number(dmy[3]);
    if (y < 100) y += 2000;
    const dt = Date.UTC(y, Number(dmy[2]) - 1, Number(dmy[1]), Number(dmy[4] || 0), Number(dmy[5] || 0), Number(dmy[6] || 0));
    if (Number.isFinite(dt)) return new Date(dt).toISOString();
  }
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

function pctChange(from, to) {
  const a = Number(from), b = Number(to);
  if (!(a > 0) || !Number.isFinite(b)) return null;
  return Number((((b - a) / a) * 100).toFixed(3));
}
function parsePercent(value) {
  const m = cleanText(value).match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}
function parseRelativeAgeToIso(value, now = Date.now()) {
  const text = cleanText(value).toLowerCase();
  let m = text.match(/(\d+(?:\.\d+)?)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|hr|hrs|day|days)\s*ago/);
  if (!m) return parseDateLoose(value);
  const amount = Number(m[1]);
  const unit = m[2];
  const mult = /sec/.test(unit) ? 1_000 : /min/.test(unit) ? 60_000 : /hour|hr/.test(unit) ? 3_600_000 : 86_400_000;
  return new Date(now - amount * mult).toISOString();
}
function labelText(text, label, maxChars = 120) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = cleanText(text).match(new RegExp(`${escaped}\\s*:?\\s*([^|•]{1,${maxChars}}?)(?=\\s{2,}|(?:Price Updated|Price Range|Trend|Nation|League|Club|Position|Positions|Popularity|Likes|Dislikes|PRP|$))`, 'i'));
  return m ? cleanText(m[1]) : null;
}
function classifyCardVersion(value) {
  const t = normalizeName(value);
  if (!t) return { rarityClass: null, promoName: null, isSpecial: null };
  if (/icon/.test(t)) return { rarityClass: 'ICON', promoName: value, isSpecial: true };
  if (/hero/.test(t)) return { rarityClass: 'HERO', promoName: value, isSpecial: true };
  if (/team of the week|totw/.test(t)) return { rarityClass: 'TOTW', promoName: value, isSpecial: true };
  if (/evolution|evo/.test(t)) return { rarityClass: 'EVOLUTION', promoName: value, isSpecial: true };
  if (/gold rare|rare gold/.test(t)) return { rarityClass: 'GOLD_RARE', promoName: null, isSpecial: false };
  if (/gold common|common gold/.test(t)) return { rarityClass: 'GOLD_COMMON', promoName: null, isSpecial: false };
  if (/silver rare|rare silver/.test(t)) return { rarityClass: 'SILVER_RARE', promoName: null, isSpecial: false };
  if (/silver common|common silver/.test(t)) return { rarityClass: 'SILVER_COMMON', promoName: null, isSpecial: false };
  if (/bronze rare|rare bronze/.test(t)) return { rarityClass: 'BRONZE_RARE', promoName: null, isSpecial: false };
  if (/bronze common|common bronze/.test(t)) return { rarityClass: 'BRONZE_COMMON', promoName: null, isSpecial: false };
  return { rarityClass: 'SPECIAL', promoName: value, isSpecial: true };
}
function extractPositionCandidates(text) {
  const source = cleanText(text);
  const explicit = labelText(source, 'Alternate Positions') || labelText(source, 'Alt Positions') || labelText(source, 'Positions');
  const allowed = new Set(['GK','LB','LWB','CB','RB','RWB','CDM','CM','CAM','LM','RM','LW','RW','CF','ST']);
  const out = [];
  if (explicit) {
    for (const token of explicit.toUpperCase().split(/[\s,;/|]+/)) if (allowed.has(token) && !out.includes(token)) out.push(token);
  }
  if (!out.length) {
    const matches = source.toUpperCase().match(/\b(GK|LB|LWB|CB|RB|RWB|CDM|CM|CAM|LM|RM|LW|RW|CF|ST)\b/g) || [];
    for (const token of matches.slice(0, 12)) if (!out.includes(token)) out.push(token);
  }
  return out;
}
function extractImageAlts(html) {
  return [...String(html || '').matchAll(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/gi)]
    .map(m => cleanText(decodeEntities(m[1])))
    .filter(Boolean)
    .slice(0, 80);
}
function extractInPacksState(text) {
  const t = cleanText(text);
  if (/\bout of packs\b|\bnot in packs\b|\bleft packs\b/i.test(t)) return 'OUT_OF_PACKS';
  if (/\bin packs\b|\bcurrently in packs\b/i.test(t)) return 'IN_PACKS';
  return null;
}
function dedupeHistory(points = []) {
  const m = new Map();
  for (const p of points) {
    const t = Date.parse(p?.observedAt);
    const price = Number(p?.price);
    if (!Number.isFinite(t) || !(price > 0)) continue;
    m.set(`${new Date(t).toISOString()}|${Math.round(price)}`, { observedAt: new Date(t).toISOString(), price: Math.round(price) });
  }
  return [...m.values()].sort((a,b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}
export function computeHistoryWindows(history = [], currentPrice = null, now = Date.now()) {
  const points = dedupeHistory(history);
  if (Number(currentPrice) > 0) points.push({ observedAt: new Date(now).toISOString(), price: Math.round(Number(currentPrice)) });
  const sorted = dedupeHistory(points);
  const current = Number(currentPrice) > 0 ? Number(currentPrice) : (sorted.at(-1)?.price ?? null);
  const result = {};
  for (const [key, ms] of Object.entries(HISTORY_WINDOWS)) {
    const cutoff = now - ms;
    const inside = sorted.filter(p => Date.parse(p.observedAt) >= cutoff && Date.parse(p.observedAt) <= now);
    let anchor = [...sorted].reverse().find(p => Date.parse(p.observedAt) <= cutoff) || inside[0] || null;
    const prices = inside.map(p => Number(p.price)).filter(n => n > 0);
    const avg = average(prices);
    const dispersion = avg && prices.length >= 2 ? stddev(prices) / avg : null;
    result[key] = {
      samples: inside.length,
      anchorAt: anchor?.observedAt ?? null,
      anchorPrice: anchor?.price ?? null,
      currentPrice: current,
      changePct: anchor && current ? pctChange(anchor.price, current) : null,
      low: prices.length ? Math.min(...prices) : null,
      high: prices.length ? Math.max(...prices) : null,
      average: avg == null ? null : Math.round(avg),
      volatilityPct: dispersion == null ? null : Number((dispersion * 100).toFixed(3))
    };
  }
  return result;
}
function inferSourceFreshness(row, detail) {
  const futggAt = row?.priceUpdatedAt || row?.priceRecordedAt || row?.recordedAt || row?.updatedAt || null;
  const futbinAt = detail?.priceUpdatedAtConsole || detail?.fetchedAt || null;
  const a = Date.parse(String(futggAt || '')), b = Date.parse(String(futbinAt || ''));
  const diffMinutes = Number.isFinite(a) && Number.isFinite(b) ? Number(((b - a) / 60_000).toFixed(2)) : null;
  return {
    futggUpdatedAt: Number.isFinite(a) ? new Date(a).toISOString() : null,
    futbinUpdatedAt: Number.isFinite(b) ? new Date(b).toISOString() : null,
    futbinMinusFutggMinutes: diffMinutes,
    fresher: diffMinutes == null ? 'UNKNOWN' : diffMinutes > 1 ? 'FUTBIN' : diffMinutes < -1 ? 'FUTGG' : 'SIMILAR',
    preferredLivePriceSource: Number(row?.price) > 0 ? 'FUTGG' : Number(detail?.pricePlayStation) > 0 ? 'FUTBIN' : 'NONE'
  };
}
function computePriceComparison(row, detail) {
  const futgg = Number(row?.price);
  const futbin = Number(detail?.pricePlayStation || detail?.marketAverageBin || detail?.salesMetrics?.medianSoldPrice);
  const eaAvg = Number(detail?.eaAveragePrice);
  return {
    futggPrice: futgg > 0 ? futgg : null,
    futbinPrice: futbin > 0 ? futbin : null,
    eaAveragePrice: eaAvg > 0 ? eaAvg : null,
    futbinVsFutggPct: futgg > 0 && futbin > 0 ? pctChange(futgg, futbin) : null,
    futbinVsEaAveragePct: eaAvg > 0 && futbin > 0 ? pctChange(eaAvg, futbin) : null,
    futggVsEaAveragePct: eaAvg > 0 && futgg > 0 ? pctChange(eaAvg, futgg) : null,
    freshness: inferSourceFreshness(row, detail)
  };
}
function listingFingerprint(s) {
  return `${Math.round(Number(s?.listedPrice)||0)}|${cleanText(s?.type || '').toLowerCase()}`;
}
export function computeListingStructure(sales = []) {
  const valid = sales.filter(s => Number(s?.listedPrice) > 0).map(s => ({...s, _t: Date.parse(s?.observedAt)})).sort((a,b) => (a._t||0)-(b._t||0));
  let undercuts = 0, comparable = 0;
  for (let i=1;i<valid.length;i++) {
    if (!(valid[i-1].listedPrice > 0)) continue;
    comparable += 1;
    if (valid[i].listedPrice < valid[i-1].listedPrice) undercuts += 1;
  }
  const groups = new Map();
  for (const s of valid) {
    const key = listingFingerprint(s);
    const a = groups.get(key) || [];
    a.push(s);
    groups.set(key, a);
  }
  let estimatedRelists = 0;
  const estimatedTimeToSale = [];
  for (const group of groups.values()) {
    const ordered = group.filter(x => Number.isFinite(x._t)).sort((a,b)=>a._t-b._t);
    for (let i=1;i<ordered.length;i++) {
      if (!ordered[i-1].sold && ordered[i].sold) {
        estimatedRelists += 1;
        estimatedTimeToSale.push((ordered[i]._t - ordered[i-1]._t)/60_000);
      } else if (!ordered[i-1].sold && !ordered[i].sold) {
        estimatedRelists += 1;
      }
    }
  }
  const unsoldPrices = valid.filter(x => !x.sold).map(x => Number(x.listedPrice));
  const soldPrices = valid.filter(x => x.sold).map(x => Number(x.soldPrice));
  return {
    undercutObservations: comparable,
    undercutCount: undercuts,
    undercutRatePct: comparable ? Number((undercuts/comparable*100).toFixed(2)) : null,
    estimatedRelistCount: estimatedRelists,
    estimatedTimeToSaleMinutes: estimatedTimeToSale.length ? Number(median(estimatedTimeToSale).toFixed(2)) : null,
    estimatedTimeToSaleSamples: estimatedTimeToSale.length,
    soldPriceP25: soldPrices.length ? Math.round(quantile(soldPrices, .25)) : null,
    soldPriceP75: soldPrices.length ? Math.round(quantile(soldPrices, .75)) : null,
    unsoldPriceP25: unsoldPrices.length ? Math.round(quantile(unsoldPrices, .25)) : null,
    unsoldPriceP75: unsoldPrices.length ? Math.round(quantile(unsoldPrices, .75)) : null,
    note: 'Relist/time-to-sale values are estimates from repeated public listing rows, not unique EA listing IDs.'
  };
}
function quantile(values, q) {
  const a = values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}
function classifyCatalystText(value) {
  const t = cleanText(value).toLowerCase();
  if (/marquee|top.?partien|topspiel|derby/.test(t)) return 'MARQUEE_MATCHUPS';
  if (/\bsbc\b|squad building|icon sbc|hero sbc|challenge/.test(t)) return 'SBC';
  if (/\bevo|evolution/.test(t)) return 'EVO';
  if (/reward|rivals|champions|weekend league|squad battles/.test(t)) return 'REWARDS';
  if (/out.?of.?packs|leaves packs|leaving packs/.test(t)) return 'OUT_OF_PACKS';
  if (/pack supply|lightning round|store pack|pack weight|supply/.test(t)) return 'PACK_SUPPLY';
  if (/promo|futties|toty|tots|totw|future stars|fantasy|road to|rttf|rttk|shapeshifter|birthday|glory hunters|summer stars|path to glory|thunderstruck/.test(t)) return 'PROMO';
  if (/leak|trader|invest|buy|sell|kauf|verkauf/.test(t)) return 'LEAK_OR_TRADER';
  return 'GENERAL';
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
    const positions = extractPositionCandidates(context);
    const rowCardType = cleanText(row?.rarityName || row?.cardType || row?.rarityGroupName);
    const cardVersion = rowCardType && normalizeName(context).includes(normalizeName(rowCardType))
      ? rowCardType
      : (context.match(/\b(Team of the Week|TOTW|Icon|Hero|Evolution|Gold Rare|Gold Common|Silver Rare|Silver Common|Bronze Rare|Bronze Common|Summer Stars|Path To Glory|Glory Hunters|Thunderstruck|Future Stars|Fantasy|Birthday|TOTS|TOTY|RTTK|RTTF|FUTTIES)\b/i)?.[1] || null);
    out.push({
      futbinId: m[1], slug: m[2], href: `/${gameYear}/player/${m[1]}/${m[2]}`,
      name: m[2].replace(/-/g, ' '), rating: ratingMatch ? Number(ratingMatch[1]) : null,
      primaryPosition: positions[0] || null, alternatePositions: positions.slice(1), cardVersion, text: context
    });
  }
  return out.sort((a, b) => candidateScore(b, row) - candidateScore(a, row));
}

export function parseFutbinPlayerHtml(html) {
  const source = String(html || '');
  const text = stripHtml(source);
  const h1 = firstTagText(source, 'h1');
  const title = firstTagText(source, 'title');
  const titleSource = title || h1;
  const ratingMatch = title.match(/EA FC\s*\d+\s*-\s*(\d{2})\s*-/i) || h1.match(/\b(\d{2})\b/);
  const cardMatch = h1.match(/-\s*(.*?)\s*EA FC\s*\d+/i) || title.match(/^[^-]+?\s+(.+?)\s+EA FC\s*\d+/i);
  const gameMatches = [...text.matchAll(/has been used in\s+([\d,.]+)\s+games\s+with a GPG[^\d]*([\d.]+)/gi)];
  const currentPrice = text.match(/current price on FUT is\s+([\d,.kKmM]+)\s+on PlayStation,\s*([\d,.kKmM]+)\s+on Xbox,\s*and\s*([\d,.kKmM]+)\s+on PC/i);
  const trendMatches = [...text.matchAll(/Trend:\s*(-?\d+(?:\.\d+)?)%\s*(?:\(([-+]?[^)]+)\))?/gi)];
  const rangeMatches = [...text.matchAll(/Price Range:\s*([\d,.kKmM]+)\s*-\s*([\d,.kKmM]+)/gi)];
  const updateMatches = [...text.matchAll(/Price Updated:\s*([^*|•]{1,40}?ago|just now)/gi)];
  const addedMatch = text.match(/Player card added:\s*([0-9]{2}-[0-9]{2}-[0-9]{4})/i);
  const bio = text.match(/plays for\s+(.+?)\s+in\s+(.+?)\.\s+(?:He|She|They)\s+was born/i);
  const nationLabel = labelText(text, 'Nation');
  const leagueLabel = labelText(text, 'League');
  const clubLabel = labelText(text, 'Club');
  const positionLabel = labelText(text, 'Position');
  const alternatePositionLabel = labelText(text, 'Alternate Positions') || labelText(text, 'Alt Positions');
  const positions = [];
  for (const token of [
    ...extractPositionCandidates(positionLabel || ''),
    ...extractPositionCandidates(alternatePositionLabel || ''),
    ...extractPositionCandidates(text)
  ]) if (!positions.includes(token)) positions.push(token);
  const imageAlts = extractImageAlts(source);
  const cardVersion = cardMatch ? cleanText(cardMatch[1]) : null;
  const classInfo = classifyCardVersion(cardVersion);
  const popularity = parseAmount(labelText(text, 'Popularity') || labelText(text, 'Popularity Rank'));
  const likes = parseAmount(labelText(text, 'Likes'));
  const dislikes = parseAmount(labelText(text, 'Dislikes'));
  const prp = parsePercent(labelText(text, 'PRP') || '') ?? parsePercent(text.match(/\bPRP\s*:?\s*(-?\d+(?:\.\d+)?%?)/i)?.[1] || '');
  const weakFoot = parseAmount(labelText(text, 'Weak Foot'));
  const skills = parseAmount(labelText(text, 'Skills'));
  const height = labelText(text, 'Height');
  const nationFromImages = imageAlts.find(v => /^[A-Za-zÀ-ÿ .'-]{3,40}$/.test(v) && !/image|coin|futbin|playstation|xbox|pc/i.test(v)) || null;
  return {
    title: titleSource || null,
    rating: ratingMatch ? Number(ratingMatch[1]) : null,
    cardVersion,
    rarityClass: classInfo.rarityClass,
    promoName: classInfo.promoName,
    isSpecial: classInfo.isSpecial,
    primaryPosition: positions[0] || null,
    alternatePositions: positions.slice(1),
    nation: nationLabel || nationFromImages,
    club: clubLabel || (bio ? cleanText(bio[1]) : null),
    league: leagueLabel || (bio ? cleanText(bio[2]) : null),
    gamesPlayedConsole: gameMatches[0] ? parseAmount(gameMatches[0][1]) : null,
    gpgConsole: gameMatches[0] ? Number(gameMatches[0][2]) : null,
    gamesPlayedPc: gameMatches[1] ? parseAmount(gameMatches[1][1]) : null,
    gpgPc: gameMatches[1] ? Number(gameMatches[1][2]) : null,
    pricePlayStation: currentPrice ? parseAmount(currentPrice[1]) : null,
    priceXbox: currentPrice ? parseAmount(currentPrice[2]) : null,
    pricePc: currentPrice ? parseAmount(currentPrice[3]) : null,
    priceUpdatedAtConsole: updateMatches[0] ? parseRelativeAgeToIso(updateMatches[0][1]) : null,
    priceUpdatedAtPc: updateMatches[1] ? parseRelativeAgeToIso(updateMatches[1][1]) : null,
    trendConsolePct: trendMatches[0] ? Number(trendMatches[0][1]) : null,
    trendPcPct: trendMatches[1] ? Number(trendMatches[1][1]) : null,
    priceRangeMin: rangeMatches[0] ? parseAmount(rangeMatches[0][1]) : null,
    priceRangeMax: rangeMatches[0] ? parseAmount(rangeMatches[0][2]) : null,
    priceRangePcMin: rangeMatches[1] ? parseAmount(rangeMatches[1][1]) : null,
    priceRangePcMax: rangeMatches[1] ? parseAmount(rangeMatches[1][2]) : null,
    prpPct: prp,
    popularityRank: popularity,
    likes,
    dislikes,
    skills,
    weakFoot,
    height: height || null,
    inPacksState: extractInPacksState(text),
    cardAddedAt: addedMatch ? parseDateLoose(addedMatch[1]) : null,
    imageAlts
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
    const decoded = decodeEntities(raw);
    if (decoded.startsWith('{') || decoded.startsWith('[')) {
      try { walkJson(JSON.parse(decoded), points); } catch {}
    }

    // Many chart libraries embed time/price arrays inside JavaScript rather than pure JSON.
    // We only accept plausible Unix timestamps and positive market prices.
    const pairRe = /[\[(]\s*(1[5-9]\d{8,11}|2\d{9,11})\s*[,;]\s*["']?([\d,.]+[kKmM]?)["']?\s*[\])]/g;
    let m;
    while ((m = pairRe.exec(decoded)) && points.length < MAX_HISTORY_POINTS) {
      const t = timestampMs(Number(m[1]));
      const price = parseAmount(m[2]);
      if (t && price > 0) points.push({ observedAt: new Date(t).toISOString(), price });
    }

    const objectPairRe = /(?:timestamp|time|date|x)\s*[:=]\s*["']?(1[5-9]\d{8,11}|2\d{9,11})["']?[\s\S]{0,100}?(?:price|value|y|bin|avg|average)\s*[:=]\s*["']?([\d,.]+[kKmM]?)["']?/gi;
    while ((m = objectPairRe.exec(decoded)) && points.length < MAX_HISTORY_POINTS) {
      const t = timestampMs(Number(m[1]));
      const price = parseAmount(m[2]);
      if (t && price > 0) points.push({ observedAt: new Date(t).toISOString(), price });
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
      const observedAt = parseDateLoose(cells[0]);
      const eaTax = parseAmount(cells[3]) || (soldPrice > 0 ? Math.round(soldPrice * 0.05) : 0);
      const netPrice = parseAmount(cells[4]) || (soldPrice > 0 ? soldPrice - eaTax : 0);
      sales.push({
        observedAt,
        listedPrice,
        soldPrice,
        sold: soldPrice > 0,
        status: soldPrice > 0 ? 'SOLD' : 'NOT_SOLD',
        eaTax,
        netPrice,
        type: cells[5] || null,
        rawCells: cells.slice(0, 8)
      });
    }
  }
  const labelValue = label => {
    const m = text.match(new RegExp(`${label}\\s*([\\d,.kKmM]+)`, 'i'));
    return m ? parseAmount(m[1]) : null;
  };
  const labelPct = label => {
    const m = text.match(new RegExp(`${label}\\s*:?[\\s]*(-?\\d+(?:\\.\\d+)?)%`, 'i'));
    return m ? Number(m[1]) : null;
  };
  const trend = text.match(/Trend:\s*(-?\d+(?:\.\d+)?)%/i);
  const update = text.match(/Price Updated:\s*([^*|•]{1,40}?ago|just now)/i);
  const history = extractEmbeddedHistory(source);
  return {
    averageBin: labelValue('Average BIN'),
    high: labelValue('High'),
    low: labelValue('Low'),
    discardPrice: labelValue('Discard Price'),
    eaAveragePrice: labelValue('EA Avg\\. Price'),
    prpPct: labelPct('PRP'),
    trendPct: trend ? Number(trend[1]) : null,
    priceUpdatedAt: update ? parseRelativeAgeToIso(update[1]) : null,
    sales,
    listingStructure: computeListingStructure(sales),
    history
  };
}


export function parseFutbinMarketOverviewHtml(html) {
  const text = stripHtml(html);
  const indices = {};
  const re = /\bIndex\s*(100|86|85|84|83|82|81|Icons?|Gold|Special)\s+([0-9]+(?:\.[0-9]+)?)\s+(-?\d+(?:\.\d+)?)%\s*(?:([0-9]+(?:\.[0-9]+)?)\s+(-?\d+(?:\.\d+)?)%)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const rawKey = String(m[1]).toUpperCase();
    const key = rawKey.startsWith('ICON') ? 'ICONS' : rawKey;
    indices[key] = {
      consoleValue: Number(m[2]),
      consoleChangePct: Number(m[3]),
      pcValue: m[4] ? Number(m[4]) : null,
      pcChangePct: m[5] ? Number(m[5]) : null
    };
  }

  const ohlc = text.match(/\bOpen:\s*([0-9]+(?:\.[0-9]+)?)\s+Lowest:\s*([0-9]+(?:\.[0-9]+)?)\s+Highest:\s*([0-9]+(?:\.[0-9]+)?)/i);
  const momentumMatch =
    text.match(/Market Momentum[^0-9]{0,50}(\d{1,3}(?:\.\d+)?)\s*(?:\/\s*100|%|(?:Negative|Neutral|Positive))/i) ||
    text.match(/Market Momentum\s+(\d{1,3}(?:\.\d+)?)(?!\s*-\s*\d)/i);
  const marketMomentum = momentumMatch ? clamp(Number(momentumMatch[1]), 0, 100) : null;
  const marketMood = marketMomentum == null ? null : marketMomentum < 40 ? 'NEGATIVE' : marketMomentum >= 60 ? 'POSITIVE' : 'NEUTRAL';

  return {
    indices,
    index100Ohlc: ohlc ? { open:Number(ohlc[1]), low:Number(ohlc[2]), high:Number(ohlc[3]) } : null,
    marketMomentum,
    marketMood
  };
}


function ratingIndexKeyForRow(row) {
  const rarity = normalizeName(row?.rarityName || row?.cardType || row?.futbinPromoName);
  if (rarity.includes('icon')) return 'ICONS';
  const rating = Number(row?.rating ?? row?.overall);
  if (Number.isFinite(rating) && rating >= 81 && rating <= 86) return String(Math.round(rating));
  if (rarity.includes('special') || row?.futbinPublic?.isSpecial === true) return 'SPECIAL';
  if (rarity.includes('gold')) return 'GOLD';
  return '100';
}

function attachMarketOverviewToRows(rows, overview) {
  if (!overview || !Array.isArray(rows)) return;
  for (const row of rows) {
    const key = ratingIndexKeyForRow(row);
    row.futbinMarketOverview = overview;
    row.futbinMarketMomentum = overview.marketMomentum ?? null;
    row.futbinMarketMood = overview.marketMood ?? null;
    row.futbinRatingIndexKey = key;
    row.futbinRatingIndex = overview.indices?.[key] || overview.indices?.['100'] || null;
  }
}

export async function refreshFutbinMarketOverview({ pool = null, gameYear = '26', force = false } = {}) {
  if (!ENABLED) return marketOverviewCache;
  const now = Date.now();
  if (!force && marketOverviewCache && now - marketOverviewFetchedAt < MARKET_OVERVIEW_REFRESH_MS) return marketOverviewCache;
  try {
    const { html, url } = await fetchHtml(`/${String(gameYear)}/market`);
    const parsed = parseFutbinMarketOverviewHtml(html);
    const observedAt = new Date().toISOString();
    const overview = {
      version: FUTBIN_PUBLIC_VERSION,
      source: 'FUTBIN_PUBLIC_MARKET_OVERVIEW',
      gameYear: String(gameYear),
      fetchedAt: observedAt,
      url,
      ...parsed
    };
    marketOverviewCache = overview;
    marketOverviewFetchedAt = now;
    marketOverviewError = null;

    if (pool) {
      await ensureSchema(pool);
      await pool.query(`
        INSERT INTO fc_v1064_market_overview (game_year, observed_at, market_momentum, market_mood, payload)
        VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT DO NOTHING
      `, [String(gameYear), observedAt, overview.marketMomentum, overview.marketMood, JSON.stringify(overview)]);

      for (const [indexName, index] of Object.entries(overview.indices || {})) {
        if (!Number.isFinite(Number(index?.consoleValue))) continue;
        await pool.query(`
          INSERT INTO fc_v1063_market_index_history (game_year, observed_at, index_name, value, source, payload)
          VALUES ($1,$2,$3,$4,'FUTBIN_PUBLIC_MARKET',$5::jsonb)
          ON CONFLICT DO NOTHING
        `, [String(gameYear), observedAt, `INDEX_${indexName}`, Number(index.consoleValue), JSON.stringify(index)]);
      }
    }
    return overview;
  } catch (error) {
    marketOverviewError = String(error?.message || error);
    return marketOverviewCache;
  }
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
  const soldTimes = sold.map(s => Date.parse(s.observedAt)).filter(Number.isFinite).sort((a,b)=>a-b);
  const hours = times.length >= 2 ? Math.max((times.at(-1) - times[0]) / 3_600_000, 1 / 60) : null;
  const saleVelocityPerHour = hours ? sold.length / hours : null;
  const listingVelocityPerHour = hours ? valid.length / hours : null;
  const dispersion = avgSold ? stddev(soldPrices) / avgSold : null;
  const sampleFactor = Math.min(1, valid.length / 30);
  const velocityFactor = saleVelocityPerHour == null ? 0 : Math.min(1, saleVelocityPerHour / 12);
  const stabilityFactor = dispersion == null ? 0.4 : Math.max(0, 1 - Math.min(1, dispersion / 0.18));
  const liquidityScore = sellThroughRate == null ? null : Math.round(100 * (0.45 * sellThroughRate + 0.2 * sampleFactor + 0.2 * velocityFactor + 0.15 * stabilityFactor));
  const listingStructure = computeListingStructure(valid);
  const lastSold = [...sold].filter(x => Number.isFinite(Date.parse(x.observedAt))).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0] || sold[0] || null;
  const lastObserved = [...valid].filter(x => Number.isFinite(Date.parse(x.observedAt))).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0] || valid[0] || null;
  const medianTax = medSold ? Math.round(medSold * 0.05) : null;
  const medianNet = medSold ? medSold - medianTax : null;
  return {
    listingsObserved: valid.length,
    soldListings: sold.length,
    unsoldListings: unsold.length,
    sellThroughRate: sellThroughRate == null ? null : Number((sellThroughRate * 100).toFixed(2)),
    lastObservedAt: lastObserved?.observedAt ?? null,
    lastListingPrice: lastObserved?.listedPrice ?? null,
    lastListingStatus: lastObserved?.sold ? 'SOLD' : (lastObserved ? 'NOT_SOLD' : null),
    lastSaleAt: lastSold?.observedAt ?? null,
    lastSalePrice: lastSold?.soldPrice ?? null,
    averageSoldPrice: avgSold == null ? null : Math.round(avgSold),
    medianSoldPrice: medSold == null ? null : Math.round(medSold),
    minSoldPrice: soldPrices.length ? Math.min(...soldPrices) : null,
    maxSoldPrice: soldPrices.length ? Math.max(...soldPrices) : null,
    soldPriceP25: soldPrices.length ? Math.round(quantile(soldPrices, .25)) : null,
    soldPriceP75: soldPrices.length ? Math.round(quantile(soldPrices, .75)) : null,
    averageListedPrice: listed.length ? Math.round(average(listed)) : null,
    averageUnsoldPrice: avgUnsold == null ? null : Math.round(avgUnsold),
    soldVsUnsoldGapPct: avgSold && avgUnsold ? Number((((avgUnsold - avgSold) / avgSold) * 100).toFixed(2)) : null,
    saleVelocityPerHour: saleVelocityPerHour == null ? null : Number(saleVelocityPerHour.toFixed(2)),
    listingVelocityPerHour: listingVelocityPerHour == null ? null : Number(listingVelocityPerHour.toFixed(2)),
    medianEaTax: medianTax,
    medianNetAfterTax: medianNet,
    priceStabilityPct: dispersion == null ? null : Number((Math.max(0, 100 - dispersion * 100)).toFixed(2)),
    liquidityScore,
    ...listingStructure
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
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1064_event_memory (
    game_year VARCHAR(2) NOT NULL,
    event_id VARCHAR(160) NOT NULL,
    event_type VARCHAR(60) NOT NULL,
    source VARCHAR(120),
    event_at TIMESTAMPTZ,
    message TEXT,
    target TEXT,
    call VARCHAR(40),
    impact_15m NUMERIC(10,4),
    impact_1h NUMERIC(10,4),
    impact_6h NUMERIC(10,4),
    impact_24h NUMERIC(10,4),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (game_year, event_id)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v1064_event_memory_type_time ON fc_v1064_event_memory (game_year, event_type, event_at DESC)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1064_regime_daily (
    game_year VARCHAR(2) NOT NULL,
    day DATE NOT NULL,
    regime VARCHAR(40) NOT NULL,
    median_change_pct NUMERIC(10,4),
    rising_pct NUMERIC(10,4),
    falling_pct NUMERIC(10,4),
    median_abs_change_pct NUMERIC(10,4),
    cards INTEGER NOT NULL DEFAULT 0,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (game_year, day)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1064_market_overview (
    game_year VARCHAR(2) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_momentum NUMERIC(10,4),
    market_mood VARCHAR(20),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (game_year, observed_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS fc_v1064_feature_snapshots (
    game_year VARCHAR(2) NOT NULL,
    ea_id VARCHAR(32) NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    price INTEGER,
    futbin_price INTEGER,
    median_sold_price INTEGER,
    sell_through_rate NUMERIC(10,4),
    liquidity_score NUMERIC(10,4),
    games_played BIGINT,
    trend_pct NUMERIC(10,4),
    source_freshness VARCHAR(20),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (game_year, ea_id, observed_at)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v1064_feature_snapshots_ea_time ON fc_v1064_feature_snapshots (game_year, ea_id, observed_at DESC)`);
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
  const metrics = detail.salesMetrics || {};
  const comparison = detail.priceComparison || {};
  await pool.query(`
    INSERT INTO fc_v1064_feature_snapshots
      (game_year, ea_id, observed_at, price, futbin_price, median_sold_price, sell_through_rate, liquidity_score, games_played, trend_pct, source_freshness, payload)
    VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT DO NOTHING
  `, [
    String(detail.gameYear), eaId,
    Number(row.price) > 0 ? Math.round(Number(row.price)) : null,
    Number(detail.pricePlayStation || detail.marketAverageBin) > 0 ? Math.round(Number(detail.pricePlayStation || detail.marketAverageBin)) : null,
    Number(metrics.medianSoldPrice) > 0 ? Math.round(Number(metrics.medianSoldPrice)) : null,
    Number.isFinite(Number(metrics.sellThroughRate)) ? Number(metrics.sellThroughRate) : null,
    Number.isFinite(Number(metrics.liquidityScore)) ? Number(metrics.liquidityScore) : null,
    Number(detail.gamesPlayedConsole) > 0 ? Math.round(Number(detail.gamesPlayedConsole)) : null,
    Number.isFinite(Number(detail.trendConsolePct ?? detail.marketTrendPct)) ? Number(detail.trendConsolePct ?? detail.marketTrendPct) : null,
    comparison?.freshness?.fresher || 'UNKNOWN',
    JSON.stringify({
      historyWindows: detail.historyWindows || {},
      listingStructure: detail.listingStructure || metrics,
      priceComparison: comparison,
      cardVersion: detail.cardVersion || null,
      promoName: detail.promoName || null
    })
  ]);
}

function mergeIntoRow(row, detail) {
  const metrics = detail.salesMetrics || {};
  row.futbinPublic = detail;
  row.futbinGamesPlayedConsole = detail.gamesPlayedConsole ?? null;
  row.futbinGamesPlayedPc = detail.gamesPlayedPc ?? null;
  row.futbinTrendPct = detail.trendConsolePct ?? detail.marketTrendPct ?? null;
  row.futbinMedianSoldPrice = metrics.medianSoldPrice ?? null;
  row.futbinAverageSoldPrice = metrics.averageSoldPrice ?? null;
  row.futbinLastSalePrice = metrics.lastSalePrice ?? null;
  row.futbinLastSaleAt = metrics.lastSaleAt ?? null;
  row.futbinSellThroughRate = metrics.sellThroughRate ?? null;
  row.futbinSaleVelocityPerHour = metrics.saleVelocityPerHour ?? null;
  row.futbinListingVelocityPerHour = metrics.listingVelocityPerHour ?? null;
  row.futbinLiquidityScore = metrics.liquidityScore ?? null;
  row.futbinPriceStabilityPct = metrics.priceStabilityPct ?? null;
  row.futbinUndercutRatePct = metrics.undercutRatePct ?? null;
  row.futbinEstimatedRelistCount = metrics.estimatedRelistCount ?? 0;
  row.futbinEstimatedTimeToSaleMinutes = metrics.estimatedTimeToSaleMinutes ?? null;
  row.futbinListingsObserved = metrics.listingsObserved ?? 0;
  row.futbinSoldListings = metrics.soldListings ?? 0;
  row.futbinUnsoldListings = metrics.unsoldListings ?? 0;
  row.futbinHistoryWindows = detail.historyWindows || null;
  row.futbinPriceComparison = detail.priceComparison || null;
  row.futbinAvailableVersions = detail.availableVersions || [];
  row.futbinPromoName = detail.promoName ?? null;
  row.futbinRarityClass = detail.rarityClass ?? null;
  row.futbinPrpPct = detail.prpPct ?? null;
  row.futbinPopularityRank = detail.popularityRank ?? null;
  row.futbinLikes = detail.likes ?? null;
  row.futbinDislikes = detail.dislikes ?? null;
  row.futbinInPacksState = detail.inPacksState ?? null;

  // FUT.GG remains authoritative. FUTBIN only fills fields that are missing.
  if (!row.position && detail.primaryPosition) row.position = detail.primaryPosition;
  if ((!Array.isArray(row.alternatePositions) || !row.alternatePositions.length) && Array.isArray(detail.alternatePositions)) {
    row.alternatePositions = detail.alternatePositions;
  }
  if (!row.nation && detail.nation) row.nation = detail.nation;
  if (!row.league && detail.league) row.league = detail.league;
  if (!row.club && detail.club) row.club = detail.club;
  if (!row.rarityName && detail.cardVersion) row.rarityName = detail.cardVersion;
  if (!row.cardType && detail.rarityClass) row.cardType = detail.rarityClass;

  if (!(Number(row.futbinPrice) > 0)) row.futbinPrice = detail.pricePlayStation || detail.marketAverageBin || metrics.medianSoldPrice || null;
  row.futbinSource = 'FUTBIN_PUBLIC_GAP_FILL';
  row.futbinUpdatedAt = detail.priceUpdatedAtConsole || detail.fetchedAt;
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
  if (best && candidateScore(best, row) >= 45) {
    const resolved = {
      ...best,
      availableVersions: candidates.slice(0, 24).map(c => ({
        futbinId: c.futbinId,
        slug: c.slug,
        rating: c.rating ?? null,
        primaryPosition: c.primaryPosition ?? null,
        alternatePositions: c.alternatePositions ?? [],
        cardVersion: c.cardVersion ?? null,
        href: c.href
      }))
    };
    cardCache.set(eaId, resolved);
    matches += 1;
    return resolved;
  }
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
  const currentFutbinPrice = player.pricePlayStation || marketData.averageBin || metrics.medianSoldPrice || null;
  const history = dedupeHistory(marketData.history.slice(-MAX_HISTORY_POINTS));
  const classInfo = classifyCardVersion(player.cardVersion || card.cardVersion || row?.rarityName || row?.cardType);
  const detail = {
    version: FUTBIN_PUBLIC_VERSION,
    source: 'FUTBIN_PUBLIC',
    gameYear: String(gameYear),
    futbinId: card.futbinId,
    slug: card.slug,
    url: `${BASE_URL}${card.href}`,
    marketUrl: `${BASE_URL}${card.href}/market`,
    fetchedAt: new Date().toISOString(),
    ...player,
    cardVersion: player.cardVersion || card.cardVersion || null,
    rarityClass: player.rarityClass || classInfo.rarityClass,
    promoName: player.promoName || classInfo.promoName,
    isSpecial: player.isSpecial ?? classInfo.isSpecial,
    primaryPosition: player.primaryPosition || card.primaryPosition || null,
    alternatePositions: player.alternatePositions?.length ? player.alternatePositions : (card.alternatePositions || []),
    availableVersions: card.availableVersions || [],
    marketAverageBin: marketData.averageBin,
    marketHigh: marketData.high,
    marketLow: marketData.low,
    discardPrice: marketData.discardPrice,
    eaAveragePrice: marketData.eaAveragePrice,
    prpPct: player.prpPct ?? marketData.prpPct ?? null,
    marketTrendPct: marketData.trendPct,
    marketPriceUpdatedAt: marketData.priceUpdatedAt,
    salesMetrics: metrics,
    listingStructure: marketData.listingStructure || computeListingStructure(marketData.sales),
    sales: marketData.sales.slice(0, 500),
    history,
    historyWindows: computeHistoryWindows(history, currentFutbinPrice)
  };
  detail.priceComparison = computePriceComparison(row, detail);
  detail.dataCompleteness = {
    games: Number(detail.gamesPlayedConsole) > 0 || Number(detail.gamesPlayedPc) > 0,
    trend: Number.isFinite(Number(detail.trendConsolePct ?? detail.marketTrendPct)),
    soldListings: Number(metrics.soldListings) > 0,
    unsoldListings: Number(metrics.unsoldListings) > 0,
    priceHistory: history.length > 0,
    positions: Boolean(detail.primaryPosition),
    nation: Boolean(detail.nation),
    league: Boolean(detail.league),
    club: Boolean(detail.club),
    cardVersion: Boolean(detail.cardVersion),
    priceUpdateTime: Boolean(detail.priceUpdatedAtConsole || detail.marketPriceUpdatedAt),
    sourceFreshness: detail.priceComparison?.freshness?.fresher !== 'UNKNOWN'
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
  const overview = await refreshFutbinMarketOverview({ pool, gameYear }).catch(() => marketOverviewCache);
  attachMarketOverviewToRows(rows, overview);
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


async function tableExists(pool, name) {
  try {
    const r = await pool.query(`SELECT to_regclass($1) AS name`, [name]);
    return Boolean(r.rows?.[0]?.name);
  } catch { return false; }
}

async function importExistingEventMemory(pool, gameYear = '26') {
  await ensureSchema(pool);
  if (!(await tableExists(pool, 'fc_discord_signals'))) return 0;
  const bounds = seasonBounds(gameYear);
  let signals = [];
  try {
    const r = await pool.query(`
      SELECT * FROM fc_discord_signals
      WHERE source_event_at >= $1::timestamptz AND source_event_at <= $2::timestamptz
      ORDER BY source_event_at ASC
      LIMIT 12000
    `, [bounds.start, bounds.end]);
    signals = r.rows || [];
  } catch {
    try {
      const r = await pool.query(`SELECT * FROM fc_discord_signals ORDER BY source_event_at ASC LIMIT 12000`);
      signals = (r.rows || []).filter(row => {
        const t = Date.parse(row.source_event_at || row.created_at || row.timestamp || '');
        return Number.isFinite(t) && t >= Date.parse(bounds.start) && t <= Date.parse(bounds.end);
      });
    } catch { return 0; }
  }

  const impactsBySignal = new Map();
  if (await tableExists(pool, 'fc_trader_market_impacts')) {
    try {
      const r = await pool.query(`
        SELECT signal_id, horizon_minutes, market_median_change_pct
        FROM fc_trader_market_impacts
        WHERE signal_id = ANY($1::text[])
      `, [signals.map(x => String(x.id)).filter(Boolean)]);
      for (const row of r.rows || []) {
        const key = String(row.signal_id);
        const m = impactsBySignal.get(key) || {};
        const h = Number(row.horizon_minutes);
        const v = row.market_median_change_pct == null ? null : Number(row.market_median_change_pct);
        if (h === 15) m.m15 = v;
        else if (h === 60) m.h1 = v;
        else if (h === 360) m.h6 = v;
        else if (h === 1440) m.h24 = v;
        impactsBySignal.set(key, m);
      }
    } catch {}
  }

  let inserted = 0;
  for (const signal of signals) {
    const id = String(signal.id || '');
    if (!id) continue;
    const eventAt = signal.source_event_at || signal.created_at || signal.timestamp || null;
    const message = cleanText(signal.message || signal.reason || '');
    const type = classifyCatalystText(`${signal.category || ''} ${signal.source_channel_type || ''} ${message}`);
    const impacts = impactsBySignal.get(id) || {};
    const r = await pool.query(`
      INSERT INTO fc_v1064_event_memory
        (game_year,event_id,event_type,source,event_at,message,target,call,impact_15m,impact_1h,impact_6h,impact_24h,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (game_year,event_id) DO UPDATE SET
        event_type=EXCLUDED.event_type, source=EXCLUDED.source, event_at=EXCLUDED.event_at,
        message=EXCLUDED.message, target=EXCLUDED.target, call=EXCLUDED.call,
        impact_15m=COALESCE(EXCLUDED.impact_15m,fc_v1064_event_memory.impact_15m),
        impact_1h=COALESCE(EXCLUDED.impact_1h,fc_v1064_event_memory.impact_1h),
        impact_6h=COALESCE(EXCLUDED.impact_6h,fc_v1064_event_memory.impact_6h),
        impact_24h=COALESCE(EXCLUDED.impact_24h,fc_v1064_event_memory.impact_24h),
        payload=EXCLUDED.payload
      RETURNING 1
    `, [
      String(gameYear), id, type, cleanText(signal.source || signal.author || 'UNKNOWN').slice(0,120),
      eventAt, message.slice(0,4000), cleanText(signal.player_or_rating || signal.playerOrRating || '').slice(0,500),
      cleanText(signal.call || signal.action || '').slice(0,40),
      impacts.m15 ?? null, impacts.h1 ?? null, impacts.h6 ?? null, impacts.h24 ?? null,
      JSON.stringify({
        category: signal.category ?? null,
        sourceChannel: signal.source_channel ?? signal.sourceChannel ?? null,
        sourceChannelType: signal.source_channel_type ?? signal.sourceChannelType ?? null,
        signalKind: signal.signal_kind ?? signal.signalKind ?? null
      })
    ]);
    inserted += r.rowCount || 0;
  }
  return inserted;
}

async function buildRegimeCalendar(pool, gameYear = '26') {
  await ensureSchema(pool);
  const bounds = seasonBounds(gameYear);
  let rows = [];
  try {
    const r = await pool.query(`
      WITH card_day AS (
        SELECT day, ea_id, round(avg(COALESCE(close_price,average_price)))::numeric AS close_price
        FROM fc_v1063_season_daily
        WHERE game_year=$1 AND day >= $2::date AND day <= $3::date
        GROUP BY day, ea_id
      ), returns AS (
        SELECT day, ea_id, close_price,
          lag(close_price) OVER (PARTITION BY ea_id ORDER BY day) AS prev_close
        FROM card_day
      ), pct AS (
        SELECT day, ea_id,
          CASE WHEN prev_close>0 THEN ((close_price-prev_close)/prev_close)*100 END AS change_pct
        FROM returns
      )
      SELECT day,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY change_pct) AS median_change,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(change_pct)) AS median_abs_change,
        avg(CASE WHEN change_pct>0 THEN 1.0 ELSE 0.0 END)*100 AS rising_pct,
        avg(CASE WHEN change_pct<0 THEN 1.0 ELSE 0.0 END)*100 AS falling_pct,
        count(change_pct)::int AS cards
      FROM pct
      WHERE change_pct IS NOT NULL
      GROUP BY day
      ORDER BY day
    `, [String(gameYear), bounds.start.slice(0,10), bounds.end.slice(0,10)]);
    rows = r.rows || [];
  } catch { return 0; }

  let count = 0;
  let previousMedian = 0;
  for (const row of rows) {
    const medianChange = Number(row.median_change || 0);
    const medianAbs = Number(row.median_abs_change || 0);
    const rising = Number(row.rising_pct || 0);
    const falling = Number(row.falling_pct || 0);
    let regime = 'NORMAL';
    if (medianChange <= -4 || (falling >= 72 && medianChange <= -1.5)) regime = 'CRASH';
    else if (medianChange >= 2 && rising >= 62 && previousMedian < -1) regime = 'RECOVERY';
    else if (falling >= 62 && medianChange < -0.8) regime = 'SUPPLY_WAVE';
    else if (medianAbs <= 1.0 && Math.abs(medianChange) <= 0.6) regime = 'CALM';
    else if (medianChange >= 2.5 && rising >= 65) regime = 'BULLISH_PUSH';
    const r = await pool.query(`
      INSERT INTO fc_v1064_regime_daily
        (game_year,day,regime,median_change_pct,rising_pct,falling_pct,median_abs_change_pct,cards,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
      ON CONFLICT (game_year,day) DO UPDATE SET
        regime=EXCLUDED.regime,median_change_pct=EXCLUDED.median_change_pct,
        rising_pct=EXCLUDED.rising_pct,falling_pct=EXCLUDED.falling_pct,
        median_abs_change_pct=EXCLUDED.median_abs_change_pct,cards=EXCLUDED.cards,payload=EXCLUDED.payload
      RETURNING 1
    `, [String(gameYear), row.day, regime, medianChange, rising, falling, medianAbs, Number(row.cards||0), JSON.stringify({ previousMedian })]);
    count += r.rowCount || 0;
    previousMedian = medianChange;
  }
  return count;
}

async function globalSeasonMemory(pool, gameYear = '26') {
  await ensureSchema(pool);
  const out = { eventPatterns: {}, regimeCounts: {}, phasePatterns: {}, eventCount: 0, regimeDays: 0 };
  try {
    const r = await pool.query(`
      SELECT event_type, count(*)::int AS events,
        avg(impact_15m) AS impact_15m, avg(impact_1h) AS impact_1h,
        avg(impact_6h) AS impact_6h, avg(impact_24h) AS impact_24h
      FROM fc_v1064_event_memory
      WHERE game_year=$1
      GROUP BY event_type
    `, [String(gameYear)]);
    for (const row of r.rows || []) {
      out.eventPatterns[row.event_type] = {
        events: Number(row.events||0),
        avgImpact15mPct: row.impact_15m == null ? null : Number(Number(row.impact_15m).toFixed(3)),
        avgImpact1hPct: row.impact_1h == null ? null : Number(Number(row.impact_1h).toFixed(3)),
        avgImpact6hPct: row.impact_6h == null ? null : Number(Number(row.impact_6h).toFixed(3)),
        avgImpact24hPct: row.impact_24h == null ? null : Number(Number(row.impact_24h).toFixed(3))
      };
      out.eventCount += Number(row.events||0);
    }
  } catch {}
  try {
    const r = await pool.query(`
      SELECT regime, count(*)::int AS days
      FROM fc_v1064_regime_daily
      WHERE game_year=$1
      GROUP BY regime
    `, [String(gameYear)]);
    for (const row of r.rows || []) {
      out.regimeCounts[row.regime] = Number(row.days||0);
      out.regimeDays += Number(row.days||0);
    }
  } catch {}
  try {
    const bounds = seasonBounds(gameYear);
    const r = await pool.query(`
      SELECT
        (1 + floor((day - $2::date) / 30.0))::int AS phase,
        count(*)::int AS days,
        avg(median_change_pct) AS avg_change,
        avg(median_abs_change_pct) AS avg_abs_change,
        avg(CASE WHEN regime='CRASH' THEN 1.0 ELSE 0.0 END) AS crash_share,
        avg(CASE WHEN regime='RECOVERY' THEN 1.0 ELSE 0.0 END) AS recovery_share,
        avg(CASE WHEN regime='SUPPLY_WAVE' THEN 1.0 ELSE 0.0 END) AS supply_share,
        avg(rising_pct) AS rising_pct,
        avg(falling_pct) AS falling_pct
      FROM fc_v1064_regime_daily
      WHERE game_year=$1
      GROUP BY phase
      ORDER BY phase
    `, [String(gameYear), bounds.start.slice(0,10)]);
    for (const row of r.rows || []) {
      const key = `P${String(Math.max(1, Number(row.phase||1))).padStart(2,'0')}`;
      out.phasePatterns[key] = {
        days: Number(row.days||0),
        avgMarketChangePct: row.avg_change == null ? null : Number(Number(row.avg_change).toFixed(3)),
        avgAbsMarketChangePct: row.avg_abs_change == null ? null : Number(Number(row.avg_abs_change).toFixed(3)),
        crashSharePct: row.crash_share == null ? null : Number((Number(row.crash_share)*100).toFixed(2)),
        recoverySharePct: row.recovery_share == null ? null : Number((Number(row.recovery_share)*100).toFixed(2)),
        supplySharePct: row.supply_share == null ? null : Number((Number(row.supply_share)*100).toFixed(2)),
        risingPct: row.rising_pct == null ? null : Number(Number(row.rising_pct).toFixed(2)),
        fallingPct: row.falling_pct == null ? null : Number(Number(row.falling_pct).toFixed(2))
      };
    }
  } catch {}
  return out;
}

export async function bootstrapFc26SeasonMemory({ pool = null, gameYear = '26' } = {}) {
  if (!pool) return { ok: false, reason: 'NO_DB' };
  await ensureSchema(pool);
  const futggDaily = await aggregateExistingPriceHistory(pool, gameYear);
  const futbinDaily = await aggregateFutbinHistory(pool, gameYear);
  const eventMemory = await importExistingEventMemory(pool, gameYear).catch(() => 0);
  const regimeDays = await buildRegimeCalendar(pool, gameYear).catch(() => 0);
  const globalMemory = await globalSeasonMemory(pool, gameYear).catch(() => ({ eventPatterns:{}, regimeCounts:{}, eventCount:0, regimeDays:0 }));
  return { ok: true, gameYear: String(gameYear), futggDaily, futbinDaily, eventMemory, regimeDays, globalMemory };
}

export async function attachSeasonMemoryToRows({ rows = [], pool = null, gameYear = '26' } = {}) {
  if (!pool || !Array.isArray(rows) || !rows.length) return 0;
  await ensureSchema(pool);
  const bounds = seasonBounds(gameYear);
  const ids = [...new Set(rows.map(r => String(r.eaId ?? '')).filter(Boolean))].slice(0, 1500);
  if (!ids.length) return 0;
  const globalMemory = await globalSeasonMemory(pool, gameYear).catch(() => ({ eventPatterns:{}, regimeCounts:{}, eventCount:0, regimeDays:0 }));
  const result = await pool.query(`
    WITH card_day AS (
      SELECT ea_id, day,
        round(avg(COALESCE(close_price,average_price)))::int AS close_price,
        min(low_price)::int AS low_price,
        max(high_price)::int AS high_price,
        round(avg(average_price))::int AS average_price,
        count(DISTINCT source)::int AS sources
      FROM fc_v1063_season_daily
      WHERE game_year=$1 AND ea_id=ANY($2::text[]) AND day >= $3::date AND day <= $4::date
      GROUP BY ea_id, day
    ), d AS (
      SELECT ea_id, day, close_price, low_price, high_price, average_price, sources,
        lag(close_price) OVER (PARTITION BY ea_id ORDER BY day) AS prev_close,
        max(close_price) OVER (PARTITION BY ea_id ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_peak
      FROM card_day
    ), m AS (
      SELECT ea_id,
        count(*)::int AS days,
        min(day) AS first_day,
        max(day) AS last_day,
        (array_agg(close_price ORDER BY day ASC))[1]::int AS first_price,
        (array_agg(close_price ORDER BY day DESC))[1]::int AS last_price,
        round(avg(average_price))::int AS mean_price,
        min(low_price)::int AS season_low,
        max(high_price)::int AS season_high,
        avg(CASE WHEN prev_close>0 THEN ((close_price-prev_close)::numeric/prev_close)*100 END) AS avg_daily_change,
        avg(CASE WHEN prev_close>0 THEN abs(((close_price-prev_close)::numeric/prev_close)*100) END) AS avg_abs_daily_change,
        stddev_samp(CASE WHEN prev_close>0 THEN ((close_price-prev_close)::numeric/prev_close)*100 END) AS daily_volatility,
        avg(CASE WHEN prev_close>0 AND close_price>prev_close THEN 1.0 ELSE 0.0 END) AS green_day_share,
        avg(CASE WHEN prev_close>0 AND close_price<prev_close THEN 1.0 ELSE 0.0 END) AS red_day_share,
        avg(CASE WHEN prev_close>0 AND ((close_price-prev_close)::numeric/prev_close)*100<=-8 THEN 1.0 ELSE 0.0 END) AS crash_day_share,
        avg(CASE WHEN prev_close>0 AND ((close_price-prev_close)::numeric/prev_close)*100>=5 THEN 1.0 ELSE 0.0 END) AS recovery_day_share,
        min(CASE WHEN prev_close>0 THEN ((close_price-prev_close)::numeric/prev_close)*100 END) AS max_daily_drop,
        max(CASE WHEN prev_close>0 THEN ((close_price-prev_close)::numeric/prev_close)*100 END) AS max_daily_rise,
        min(CASE WHEN running_peak>0 THEN ((close_price-running_peak)::numeric/running_peak)*100 END) AS max_drawdown,
        max(sources)::int AS source_count
      FROM d
      GROUP BY ea_id
    ) SELECT * FROM m
  `, [String(gameYear), ids, bounds.start.slice(0,10), bounds.end.slice(0,10)]);
  const byId = new Map(result.rows.map(r => [String(r.ea_id), r]));
  let attached = 0;
  for (const row of rows) {
    row.fc26GlobalMemory = globalMemory;
    const s = byId.get(String(row.eaId));
    if (!s) continue;
    const firstPrice = Number(s.first_price || 0) || null;
    const lastPrice = Number(s.last_price || 0) || null;
    row.fc26SeasonMemory = {
      days: Number(s.days || 0),
      firstDay: s.first_day || null,
      lastDay: s.last_day || null,
      firstPrice,
      lastPrice,
      seasonReturnPct: firstPrice && lastPrice ? pctChange(firstPrice, lastPrice) : null,
      meanPrice: Number(s.mean_price || 0) || null,
      seasonLow: Number(s.season_low || 0) || null,
      seasonHigh: Number(s.season_high || 0) || null,
      avgDailyChangePct: s.avg_daily_change == null ? null : Number(Number(s.avg_daily_change).toFixed(3)),
      avgAbsDailyChangePct: s.avg_abs_daily_change == null ? null : Number(Number(s.avg_abs_daily_change).toFixed(3)),
      dailyVolatilityPct: s.daily_volatility == null ? null : Number(Number(s.daily_volatility).toFixed(3)),
      greenDaySharePct: s.green_day_share == null ? null : Number((Number(s.green_day_share) * 100).toFixed(2)),
      redDaySharePct: s.red_day_share == null ? null : Number((Number(s.red_day_share) * 100).toFixed(2)),
      crashDaySharePct: s.crash_day_share == null ? null : Number((Number(s.crash_day_share) * 100).toFixed(2)),
      recoveryDaySharePct: s.recovery_day_share == null ? null : Number((Number(s.recovery_day_share) * 100).toFixed(2)),
      maxDailyDropPct: s.max_daily_drop == null ? null : Number(Number(s.max_daily_drop).toFixed(3)),
      maxDailyRisePct: s.max_daily_rise == null ? null : Number(Number(s.max_daily_rise).toFixed(3)),
      maxDrawdownPct: s.max_drawdown == null ? null : Number(Number(s.max_drawdown).toFixed(3)),
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
  const queue = [...rows]
    .filter(r => r?.eaId && r?.name)
    .sort((a,b) => candidatePriority(b)-candidatePriority(a))
    .slice(0, clamp(Number(limit || 500), 1, 1000));
  backfillStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    requested: queue.length,
    processed: 0,
    enriched: 0,
    errors: 0,
    blockedCycles: 0,
    pausedUntil: null,
    lastError: null
  };
  (async () => {
    try {
      await bootstrapFc26SeasonMemory({ pool, gameYear });
      await fetchMarketIndexHistory(gameYear, pool).catch(error => { backfillStatus.lastError = String(error?.message || error); });

      for (const row of queue) {
        if (Date.now() < blockedUntil) {
          const wait = Math.max(0, blockedUntil - Date.now()) + 1_000;
          backfillStatus.blockedCycles += 1;
          backfillStatus.pausedUntil = new Date(Date.now() + wait).toISOString();
          if (backfillStatus.blockedCycles > 2) break;
          await sleep(wait);
          backfillStatus.pausedUntil = null;
        }

        backfillStatus.processed += 1;
        try {
          const detail = await fetchFutbinPublicForRow(row, { gameYear, pool, force: true });
          if (detail) backfillStatus.enriched += 1;
        } catch (error) {
          backfillStatus.errors += 1;
          backfillStatus.lastError = String(error?.message || error);
          if (/HTTP_401|HTTP_403|HTTP_429|BACKOFF/.test(backfillStatus.lastError)) {
            backfillStatus.blockedCycles += 1;
            if (backfillStatus.blockedCycles > 2) break;
            const wait = Math.max(0, blockedUntil - Date.now()) + 1_000;
            backfillStatus.pausedUntil = new Date(Date.now() + wait).toISOString();
            await sleep(wait);
            backfillStatus.pausedUntil = null;
          }
        }
        await sleep(BACKFILL_PAUSE_MS);
      }

      await aggregateFutbinHistory(pool, gameYear).catch(() => {});
      await bootstrapFc26SeasonMemory({ pool, gameYear }).catch(() => {});
    } finally {
      backfillStatus.running = false;
      backfillStatus.pausedUntil = null;
      backfillStatus.finishedAt = new Date().toISOString();
    }
  })();
  return { ok: true, status: backfillStatus };
}

export async function futbinPublicStatus({ pool = null, gameYear = '26' } = {}) {
  let db = null;
  let globalMemory = null;
  if (pool) {
    try {
      await ensureSchema(pool);
      const r = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM fc_futbin_public_cards) AS cards,
          (SELECT COUNT(*)::int FROM fc_futbin_public_sales) AS sales,
          (SELECT COUNT(*)::int FROM fc_futbin_public_sales WHERE sold_price>0) AS sold_sales,
          (SELECT COUNT(*)::int FROM fc_futbin_public_sales WHERE sold_price<=0) AS unsold_sales,
          (SELECT COUNT(*)::int FROM fc_futbin_public_history) AS history,
          (SELECT COUNT(*)::int FROM fc_v1063_season_daily WHERE game_year=$1) AS season_daily,
          (SELECT COUNT(DISTINCT ea_id)::int FROM fc_v1063_season_daily WHERE game_year=$1) AS season_cards,
          (SELECT COUNT(DISTINCT day)::int FROM fc_v1063_season_daily WHERE game_year=$1) AS season_days,
          (SELECT COUNT(*)::int FROM fc_v1063_market_index_history WHERE game_year=$1) AS market_index,
          (SELECT COUNT(*)::int FROM fc_v1064_event_memory WHERE game_year=$1) AS event_memory,
          (SELECT COUNT(*)::int FROM fc_v1064_regime_daily WHERE game_year=$1) AS regime_days,
          (SELECT COUNT(*)::int FROM fc_v1064_feature_snapshots WHERE game_year=$1) AS feature_snapshots,
          (SELECT COUNT(*)::int FROM fc_v1064_market_overview WHERE game_year=$1) AS market_overview_snapshots
      `, [String(gameYear)]);
      db = r.rows?.[0] || null;
      globalMemory = await globalSeasonMemory(pool, gameYear);
    } catch (error) { db = { error: String(error?.message || error) }; }
  }
  return {
    ok: true,
    version: FUTBIN_PUBLIC_VERSION,
    enabled: ENABLED,
    mode: 'FUTGG_FIRST_FUTBIN_COMPLETE_GAP_FILL',
    parseApiRequired: false,
    capabilities: {
      gamesPlayed: true,
      gpg: true,
      trend: true,
      platformPrices: true,
      priceUpdateTime: true,
      priceRange: true,
      prp: true,
      soldAndUnsoldListings: true,
      actualSoldPrices: true,
      sellThrough: true,
      saleVelocity: true,
      listingVelocity: true,
      liquidity: true,
      priceStability: true,
      undercutRate: true,
      estimatedRelists: true,
      estimatedTimeToSale: true,
      positions: true,
      nationLeagueClub: true,
      cardVersionPromo: true,
      versionComparison: true,
      priceHistory: true,
      historyWindows: Object.keys(HISTORY_WINDOWS),
      sourceFreshness: true,
      futbinMarketIndices: true,
      futbinMarketMomentum: true,
      ratingIndexContext: true,
      fc26EventMemory: true,
      fc26RegimeCalendar: true,
      fc26SeasonMemory: true
    },
    maxPerCycle: MAX_PER_CYCLE,
    cooldownMinutes: Math.round(CARD_COOLDOWN_MS/60_000),
    backfillPauseSeconds: Math.round(BACKFILL_PAUSE_MS/1000),
    blockedUntil: blockedUntil ? new Date(blockedUntil).toISOString() : null,
    lastSuccessAt,
    lastFailureAt,
    lastError,
    marketOverview: marketOverviewCache,
    marketOverviewError,
    marketOverviewRefreshMinutes: Math.round(MARKET_OVERVIEW_REFRESH_MS / 60_000),
    calls,
    matches,
    cardsEnriched,
    salesStored,
    historyStored,
    db,
    globalMemory,
    backfill: backfillStatus
  };
}
