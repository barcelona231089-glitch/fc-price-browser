const FUTBIN_BASE = "https://www.futbin.com";
export const FUTBIN_EVIDENCE_ADAPTER_VERSION = "10.69.6";

let nextRequestAt = 0;
const matchCache = new Map();
let popularCache = { at: 0, ranks: new Map() };

const state = {
  status: "IDLE",
  authorized: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  blocked: false,
  rateLimited: false,
  cardsAttempted: 0,
  cardsReturned: 0,
  cardsWithGames: 0,
  cardsWithSales: 0,
  cardsWithPopularRank: 0,
  salesRows: 0,
  requests: 0
};

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function enabled() {
  const raw = clean(process.env.MARKET_EVIDENCE_FUTBIN_AUTHORIZED || "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function num(value) {
  if (value == null) return null;
  const s = String(value).replace(/\u00a0/g, " ").replace(/,/g, "").trim();
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  if (/[kK]\b/.test(s)) n *= 1_000;
  else if (/[mM]\b/.test(s)) n *= 1_000_000;
  return Math.round(n);
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(value) {
  return decodeHtml(
    String(value ?? "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function canonical(value) {
  return clean(value, 200)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function canonicalVersion(value) {
  const s = canonical(value);
  const aliases = [
    ["goldrare", "goldrare"], ["rare", "goldrare"],
    ["goldcommon", "goldcommon"], ["common", "goldcommon"],
    ["teamoftheseason", "tots"], ["tots", "tots"],
    ["teamofheyear", "toty"], ["teamofyear", "toty"], ["toty", "toty"],
    ["teamofheweek", "totw"], ["teamofweek", "totw"], ["totw", "totw"],
    ["futbirthday", "futbirthday"], ["birthday", "futbirthday"],
    ["futties", "futties"], ["icon", "icon"], ["icons", "icon"],
    ["hero", "hero"], ["heroes", "hero"]
  ];
  for (const [needle, out] of aliases) if (s.includes(needle)) return out;
  return s;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function throttle() {
  const minDelay = Math.max(500, Math.min(5000, Number(process.env.MARKET_EVIDENCE_FUTBIN_REQUEST_DELAY_MS || 1200)));
  const now = Date.now();
  if (nextRequestAt > now) await sleep(nextRequestAt - now);
  nextRequestAt = Date.now() + minDelay;
}

async function fetchRaw(url, { json = false } = {}) {
  await throttle();
  const timeoutMs = Math.max(3000, Math.min(30000, Number(process.env.MARKET_EVIDENCE_FUTBIN_TIMEOUT_MS || 12000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    state.requests += 1;
    const response = await fetch(url, {
      headers: {
        "accept": json ? "application/json,text/plain;q=0.9,*/*;q=0.8" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        "user-agent": "FC-Trader-Brain-Evidence/10.69.6 (+read-only market research)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (response.status === 403) {
      const e = new Error("FUTBIN_HTTP_403_NO_BYPASS");
      e.code = "SOURCE_BLOCKED_NO_BYPASS";
      throw e;
    }
    if (response.status === 429) {
      const e = new Error("FUTBIN_HTTP_429_RATE_LIMITED");
      e.code = "SOURCE_RATE_LIMITED";
      throw e;
    }
    if (!response.ok) throw new Error(`FUTBIN_HTTP_${response.status}`);
    return json ? response.json() : response.text();
  } finally {
    clearTimeout(timer);
  }
}

function playerIdFromPath(path) {
  const m = clean(path, 1000).match(/\/(?:\d+\/)?player\/(\d+)(?:\/|$)/i);
  return m ? m[1] : null;
}

function absoluteUrl(path) {
  const p = clean(path, 1200);
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  return FUTBIN_BASE + (p.startsWith("/") ? p : "/" + p);
}

function selectExactSearchMatch(items, row) {
  const targetName = canonical(row?.name);
  const targetRating = Number(row?.overall);
  const targetVersion = canonicalVersion(row?.cardType || row?.rarityName || row?.version || "");

  const candidates = (Array.isArray(items) ? items : []).filter(item => {
    const name = canonical(item?.name);
    const rating = Number(item?.ratingSquare?.rating ?? item?.rating ?? item?.overall);
    return name && name === targetName &&
      (!Number.isFinite(targetRating) || !Number.isFinite(rating) || rating === targetRating);
  });

  if (!candidates.length) return null;

  const exactRating = candidates.filter(item => {
    const rating = Number(item?.ratingSquare?.rating ?? item?.rating ?? item?.overall);
    return !Number.isFinite(targetRating) || rating === targetRating;
  });
  const pool = exactRating.length ? exactRating : candidates;

  if (targetVersion) {
    const versionMatches = pool.filter(item => canonicalVersion(item?.version || item?.rarity || "") === targetVersion);
    if (versionMatches.length === 1) return versionMatches[0];
    if (versionMatches.length > 1) return null;
  }

  return pool.length === 1 ? pool[0] : null;
}

async function findFutbinCard(row, gameYear) {
  const key = [gameYear, canonical(row?.name), Number(row?.overall) || "", canonicalVersion(row?.cardType || row?.rarityName || row?.version || "")].join("|");
  const cached = matchCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60_000) return cached.value;

  const params = new URLSearchParams({
    targetPage: "PLAYER_PAGE",
    query: clean(row?.name, 120),
    year: String(gameYear),
    evolutions: "false"
  });
  const items = await fetchRaw(`${FUTBIN_BASE}/players/search?${params}`, { json: true });
  const item = selectExactSearchMatch(items, row);
  if (!item) {
    matchCache.set(key, { at: Date.now(), value: null });
    return null;
  }

  const path = item?.location?.url || item?.url || "";
  const futbinId = String(item?.id || playerIdFromPath(path) || "");
  if (!futbinId || !path) return null;

  const value = {
    futbinId,
    playerUrl: absoluteUrl(path),
    name: clean(item?.name, 120),
    rating: Number(item?.ratingSquare?.rating ?? item?.rating ?? row?.overall) || null,
    version: clean(item?.version || row?.cardType || row?.rarityName, 120) || null
  };
  matchCache.set(key, { at: Date.now(), value });
  return value;
}

function parseUsageGames(html) {
  const text = stripTags(html);
  const found = [];
  const re = /has been used in\s+([\d,.]+)\s+games\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = num(m[1]);
    if (Number.isFinite(n) && n >= 0) found.push(n);
    if (found.length >= 2) break;
  }

  const gamesConsole = Number.isFinite(found[0]) ? found[0] : null;
  const gamesPc = Number.isFinite(found[1]) ? found[1] : null;
  const games = gamesConsole == null && gamesPc == null
    ? null
    : (gamesConsole || 0) + (gamesPc || 0);

  return { games, gamesConsole, gamesPc };
}

function extractPopularIds(html) {
  const ranks = new Map();
  const re = /href\s*=\s*["']([^"']*\/(?:\d+\/)?player\/(\d+)(?:\/[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const id = String(m[2]);
    if (!ranks.has(id)) ranks.set(id, ranks.size + 1);
    if (ranks.size >= 250) break;
  }
  return ranks;
}

async function popularRanks() {
  const ttl = Math.max(5, Math.min(120, Number(process.env.MARKET_EVIDENCE_FUTBIN_POPULAR_CACHE_MIN || 20))) * 60_000;
  if (popularCache.ranks.size && Date.now() - popularCache.at < ttl) return popularCache.ranks;
  const html = await fetchRaw(`${FUTBIN_BASE}/popular`);
  popularCache = { at: Date.now(), ranks: extractPopularIds(html) };
  return popularCache.ranks;
}

function resolveSalesPath(marketHtml) {
  const html = String(marketHtml || "");

  const preferred = html.match(
    /<a\b[^>]*class\s*=\s*["'][^"']*\bmarket-grid-lates-sale-link\b[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i
  ) || html.match(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*class\s*=\s*["'][^"']*\bmarket-grid-lates-sale-link\b[^"']*["'][^>]*>/i
  );
  if (preferred?.[1]) return preferred[1].split("?")[0];

  const generic = html.match(/href\s*=\s*["']([^"']*\/\d+\/sales\/\d+\/[^"'?]+)[^"']*["']/i)
    || html.match(/href\s*=\s*["']([^"']*\/sales\/\d+\/[^"'?]+)[^"']*["']/i);
  return generic?.[1] ? generic[1].split("?")[0] : null;
}

function londonLocalToIso(value, now = new Date()) {
  const m = clean(value, 100).match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s+([AP]M)$/i);
  if (!m) return null;
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const month = months[m[1].toLowerCase()];
  if (month == null) return null;

  let hour = Number(m[3]) % 12;
  if (m[5].toUpperCase() === "PM") hour += 12;
  let year = now.getUTCFullYear();

  function convert(y) {
    const pretendUtc = Date.UTC(y, month, Number(m[2]), hour, Number(m[4]), 0);
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(pretendUtc))
      .filter(p => p.type !== "literal").map(p => [p.type, p.value]));
    const renderedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), 0
    );
    const offsetMs = renderedAsUtc - pretendUtc;
    return new Date(pretendUtc - offsetMs);
  }

  let out = convert(year);
  if (out.getTime() > now.getTime() + 24 * 60 * 60_000) out = convert(year - 1);
  return Number.isFinite(out.getTime()) ? out.toISOString() : null;
}

function extractCells(rowHtml) {
  const cells = [];
  const re = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(String(rowHtml || "")))) cells.push(m[1]);
  return cells;
}

function parseSalesHistory(html, limit = 100) {
  const source = String(html || "");
  const tableMatch = source.match(/<table\b[^>]*class\s*=\s*["'][^"']*\bauctions-table\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const body = tableMatch[1];
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;

  while ((rm = rowRe.exec(body)) && rows.length < Math.max(1, Math.min(500, Number(limit || 100)))) {
    const rowHtml = rm[1];
    if (!/fa-check|status[-_\s]?sold|>\s*sold\s*</i.test(rowHtml)) continue;
    const cells = extractCells(rowHtml);
    if (cells.length < 3) continue;

    const dateText = stripTags(cells[0]);
    const dm = dateText.match(/[A-Za-z]{3}\s+\d{1,2},\s+\d{1,2}:\d{2}\s+[AP]M/i);
    const listedFor = num(stripTags(cells[1]));
    const soldFor = num(stripTags(cells[2]));
    if (!Number.isFinite(soldFor) || soldFor <= 0) continue;

    const parsedTax = cells.length > 3 ? num(stripTags(cells[3])) : null;
    const parsedNet = cells.length > 4 ? num(stripTags(cells[4])) : null;
    const eaTax = Number.isFinite(parsedTax) ? parsedTax : Math.round(soldFor * 0.05);
    const netPrice = Number.isFinite(parsedNet) ? parsedNet : soldFor - eaTax;

    rows.push({
      date: dm ? londonLocalToIso(dm[0]) : null,
      listedFor: Number.isFinite(listedFor) ? listedFor : null,
      soldFor,
      eaTax,
      netPrice,
      status: "SOLD"
    });
  }
  return rows;
}

async function fetchSales(playerUrl, platform, limit) {
  const marketHtml = await fetchRaw(playerUrl.replace(/\/$/, "") + "/market");
  const path = resolveSalesPath(marketHtml);
  if (!path) return [];
  const fbPlatform = platform === "pc" ? "pc" : "ps";
  const url = new URL(absoluteUrl(path));
  url.searchParams.set("platform", fbPlatform);
  const html = await fetchRaw(url.toString());
  return parseSalesHistory(html, limit);
}

function selectRows(liveRows) {
  const minRating = Math.max(0, Math.min(99, Number(process.env.MARKET_EVIDENCE_FUTBIN_MIN_RATING || 82)));
  const batch = Math.max(1, Math.min(50, Number(process.env.MARKET_EVIDENCE_FUTBIN_BATCH || 8)));
  return (Array.isArray(liveRows) ? liveRows : [])
    .filter(row => row?.eaId && row?.name)
    .filter(row => !Number.isFinite(Number(row?.overall)) || Number(row.overall) >= minRating)
    .sort((a, b) =>
      Number(Boolean(b?.tracked)) - Number(Boolean(a?.tracked)) ||
      Number(Boolean(b?.intensiveWatch)) - Number(Boolean(a?.intensiveWatch)) ||
      Number(b?.overall || 0) - Number(a?.overall || 0) ||
      Number(b?.price || 0) - Number(a?.price || 0)
    )
    .slice(0, batch);
}

export async function collectFutbinEvidenceV10696({ liveRows = [], gameYear = "26", platform = "ps" } = {}) {
  state.authorized = enabled();
  state.lastAttemptAt = new Date().toISOString();
  state.blocked = false;
  state.rateLimited = false;
  state.lastError = null;
  state.cardsAttempted = 0;
  state.cardsReturned = 0;
  state.cardsWithGames = 0;
  state.cardsWithSales = 0;
  state.cardsWithPopularRank = 0;
  state.salesRows = 0;
  state.requests = 0;

  if (!state.authorized) {
    state.status = "NOT_AUTHORIZED";
    state.lastFailureAt = state.lastAttemptAt;
    state.lastError = "Set MARKET_EVIDENCE_FUTBIN_AUTHORIZED=true only when you are authorized to automate this source.";
    return { ok: false, status: state.status, cards: [] };
  }

  const selected = selectRows(liveRows);
  if (!selected.length) {
    state.status = "NO_CANDIDATES";
    return { ok: true, status: state.status, cards: [] };
  }

  state.status = "FETCHING";
  const cards = [];
  let ranks = new Map();

  try {
    ranks = await popularRanks();
  } catch (error) {
    state.lastError = String(error?.message || error);
    if (error?.code === "SOURCE_BLOCKED_NO_BYPASS") state.blocked = true;
    if (error?.code === "SOURCE_RATE_LIMITED") state.rateLimited = true;
  }

  const salesCardLimit = Math.max(0, Math.min(20, Number(process.env.MARKET_EVIDENCE_FUTBIN_SALES_CARDS || 4)));
  const salesLimit = Math.max(1, Math.min(250, Number(process.env.MARKET_EVIDENCE_FUTBIN_SALES_LIMIT || 100)));
  let salesCardsUsed = 0;

  for (const row of selected) {
    state.cardsAttempted += 1;
    try {
      const match = await findFutbinCard(row, gameYear);
      if (!match) continue;

      const playerHtml = await fetchRaw(match.playerUrl);
      const usage = parseUsageGames(playerHtml);
      const popularRank = ranks.get(String(match.futbinId)) || null;

      let sales = [];
      if (salesCardsUsed < salesCardLimit) {
        sales = await fetchSales(match.playerUrl, platform, salesLimit);
        salesCardsUsed += 1;
      }

      const hasGames = [usage.games, usage.gamesConsole, usage.gamesPc].some(Number.isFinite);
      const hasPopular = Number.isFinite(popularRank);
      const hasSales = sales.length > 0;
      if (!hasGames && !hasPopular && !hasSales) continue;

      cards.push({
        eaId: String(row.eaId),
        name: row.name,
        rating: Number(row.overall) || match.rating || null,
        version: row.cardType || row.rarityName || match.version || null,
        games: usage.games,
        gamesConsole: usage.gamesConsole,
        gamesPc: usage.gamesPc,
        popularRank,
        popularityCount: null,
        sales,
        source: "FUTBIN_PUBLIC_AUTHORIZED",
        sourceUrl: match.playerUrl,
        observedAt: new Date().toISOString()
      });

      if (hasGames) state.cardsWithGames += 1;
      if (hasPopular) state.cardsWithPopularRank += 1;
      if (hasSales) {
        state.cardsWithSales += 1;
        state.salesRows += sales.length;
      }
    } catch (error) {
      state.lastError = String(error?.message || error);
      if (error?.code === "SOURCE_BLOCKED_NO_BYPASS") {
        state.blocked = true;
        break;
      }
      if (error?.code === "SOURCE_RATE_LIMITED") {
        state.rateLimited = true;
        break;
      }
    }
  }

  state.cardsReturned = cards.length;
  if (cards.length) {
    state.status = "READY";
    state.lastSuccessAt = new Date().toISOString();
    state.lastFailureAt = null;
  } else {
    state.status = state.blocked ? "SOURCE_BLOCKED_NO_BYPASS"
      : state.rateLimited ? "SOURCE_RATE_LIMITED"
      : "NO_VERIFIED_EVIDENCE";
    state.lastFailureAt = new Date().toISOString();
  }

  return { ok: cards.length > 0, status: state.status, cards, source: "FUTBIN_PUBLIC_AUTHORIZED" };
}

export function getFutbinEvidenceStatusV10696() {
  return {
    adapterVersion: FUTBIN_EVIDENCE_ADAPTER_VERSION,
    mode: "READ_ONLY_NO_BYPASS",
    authorized: enabled(),
    ...state
  };
}

export const __test = {
  num,
  stripTags,
  canonical,
  canonicalVersion,
  playerIdFromPath,
  selectExactSearchMatch,
  parseUsageGames,
  extractPopularIds,
  resolveSalesPath,
  londonLocalToIso,
  parseSalesHistory
};
