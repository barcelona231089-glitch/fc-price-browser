export const FUTBIN_PARSE_EVIDENCE_ADAPTER_VERSION = "10.69.8";

const DEFAULT_PARSE_BASE =
  "https://api.parse.bot/scraper/21963078-8a17-40ff-a896-9b0b0ec3e828";

let nextRequestAt = 0;
let budgetDate = "";
let callsToday = 0;
let endpointMissingUntil = 0;
const matchCache = new Map();

const state = {
  status: "IDLE",
  configured: false,
  provider: "PARSE_MANAGED_FUTBIN_API",
  baseUrl: DEFAULT_PARSE_BASE,
  searchEndpoint: null,
  evidenceEndpoint: null,
  endpointAvailable: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  rateLimited: false,
  authFailed: false,
  cardsAttempted: 0,
  cardsReturned: 0,
  cardsWithGames: 0,
  cardsWithSales: 0,
  cardsWithPopularRank: 0,
  salesRows: 0,
  requests: 0,
  callsToday: 0,
  dailyBudget: 20
};

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function apiKey() {
  return clean(process.env.FUTBIN_PARSE_API_KEY || "", 1000);
}

function baseUrl() {
  return clean(process.env.FUTBIN_PARSE_BASE_URL || DEFAULT_PARSE_BASE, 1500)
    .replace(/\/+$/, "");
}

function evidenceEndpoint() {
  return clean(
    process.env.FUTBIN_PARSE_EVIDENCE_ENDPOINT || "get_player_evidence",
    120
  );
}

function searchEndpoint(gameYear) {
  const configured = clean(process.env.FUTBIN_PARSE_SEARCH_ENDPOINT || "", 120);
  if (configured) return configured;
  return String(gameYear) === "26" ? "search_players_fc26" : "search_players";
}

function canonical(value) {
  return clean(value, 240)
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
    ["teamofyear", "toty"], ["toty", "toty"],
    ["teamoftheweek", "totw"], ["teamofweek", "totw"], ["totw", "totw"],
    ["futbirthday", "futbirthday"], ["birthday", "futbirthday"],
    ["futties", "futties"], ["icon", "icon"], ["icons", "icon"],
    ["hero", "hero"], ["heroes", "hero"],
    ["path2glory", "pathtoglory"], ["pathtoglory", "pathtoglory"],
    ["summerstars", "summerstars"]
  ];
  for (const [needle, out] of aliases) {
    if (s.includes(needle)) return out;
  }
  return s;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value).replace(/\u00a0/g, " ").replace(/,/g, "").trim();
  const m = raw.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = Number(m[0]);
  if (!Number.isFinite(n)) return null;
  if (/[kK]\b/.test(raw)) n *= 1000;
  else if (/[mM]\b/.test(raw)) n *= 1000000;
  return n;
}

function integer(value) {
  const n = finiteNumber(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = integer(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function unwrap(payload) {
  if (payload == null) return null;
  if (
    typeof payload === "object" &&
    payload.data != null &&
    (
      payload.status == null ||
      String(payload.status).toLowerCase() === "success"
    )
  ) return payload.data;
  return payload;
}

function arraysFromSearch(payload) {
  const data = unwrap(payload);
  const candidates = [
    data?.players,
    data?.results,
    data?.items,
    data?.cards,
    data
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function exactMatch(items, row) {
  const targetName = canonical(row?.name);
  const targetRating = Number(row?.overall ?? row?.rating);
  const targetVersion = canonicalVersion(
    row?.cardType || row?.rarityName || row?.version || ""
  );

  const byNameRating = (Array.isArray(items) ? items : []).filter(item => {
    const name = canonical(item?.name || item?.full_name);
    const rating = Number(item?.rating ?? item?.overall);
    return name === targetName &&
      (!Number.isFinite(targetRating) ||
       !Number.isFinite(rating) ||
       rating === targetRating);
  });

  if (!byNameRating.length) return null;

  const exactRating = byNameRating.filter(item => {
    const rating = Number(item?.rating ?? item?.overall);
    return !Number.isFinite(targetRating) || rating === targetRating;
  });
  const pool = exactRating.length ? exactRating : byNameRating;

  if (targetVersion) {
    const vm = pool.filter(item =>
      canonicalVersion(item?.version || item?.rarity || item?.card_type || "") === targetVersion
    );
    if (vm.length === 1) return vm[0];
    if (vm.length > 1) return null;
  }

  return pool.length === 1 ? pool[0] : null;
}

function resetBudgetIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDate) {
    budgetDate = today;
    callsToday = 0;
  }
}

function dailyBudget() {
  return Math.max(
    1,
    Math.min(5000, Number(process.env.MARKET_EVIDENCE_PARSE_DAILY_BUDGET || 20))
  );
}

function minDelayMs() {
  // 13s stays below Parse's published free-tier 5 req/min limit.
  return Math.max(
    250,
    Math.min(60000, Number(process.env.MARKET_EVIDENCE_PARSE_MIN_DELAY_MS || 13000))
  );
}

async function throttle() {
  const now = Date.now();
  if (nextRequestAt > now) {
    await new Promise(resolve => setTimeout(resolve, nextRequestAt - now));
  }
  nextRequestAt = Date.now() + minDelayMs();
}

function endpointMissingError(status, text) {
  const lower = String(text || "").toLowerCase();
  return status === 404 ||
    lower.includes("endpoint") && (
      lower.includes("not found") ||
      lower.includes("available endpoints") ||
      lower.includes("unknown endpoint")
    );
}

async function parseGet(endpoint, params = {}) {
  resetBudgetIfNeeded();
  const max = dailyBudget();
  state.dailyBudget = max;
  state.callsToday = callsToday;

  if (callsToday >= max) {
    const error = new Error("PARSE_DAILY_BUDGET_REACHED");
    error.code = "DAILY_BUDGET_REACHED";
    throw error;
  }

  await throttle();

  const url = new URL(`${baseUrl()}/${encodeURIComponent(endpoint)}`);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const timeoutMs = Math.max(
    3000,
    Math.min(30000, Number(process.env.MARKET_EVIDENCE_PARSE_TIMEOUT_MS || 15000))
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    state.requests += 1;
    callsToday += 1;
    state.callsToday = callsToday;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "X-API-Key": apiKey(),
        "user-agent": "FC-Trader-Brain-Parse-Evidence/10.69.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    const text = await response.text();

    if (response.status === 401 || response.status === 403) {
      const error = new Error(`PARSE_AUTH_${response.status}`);
      error.code = "AUTH_FAILED";
      throw error;
    }
    if (response.status === 429) {
      const error = new Error("PARSE_HTTP_429_RATE_LIMITED");
      error.code = "RATE_LIMITED";
      throw error;
    }
    if (!response.ok) {
      const error = new Error(
        endpointMissingError(response.status, text)
          ? "PARSE_EVIDENCE_ENDPOINT_NOT_AVAILABLE"
          : `PARSE_HTTP_${response.status}`
      );
      error.code = endpointMissingError(response.status, text)
        ? "EVIDENCE_ENDPOINT_NOT_AVAILABLE"
        : "PARSE_HTTP_ERROR";
      throw error;
    }

    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      const error = new Error("PARSE_INVALID_JSON");
      error.code = "INVALID_JSON";
      throw error;
    }

    if (
      payload &&
      typeof payload === "object" &&
      String(payload.status || "").toLowerCase() === "error"
    ) {
      const raw = JSON.stringify(payload);
      const error = new Error(
        endpointMissingError(200, raw)
          ? "PARSE_EVIDENCE_ENDPOINT_NOT_AVAILABLE"
          : clean(payload.error || payload.message || raw, 500)
      );
      error.code = endpointMissingError(200, raw)
        ? "EVIDENCE_ENDPOINT_NOT_AVAILABLE"
        : "PARSE_API_ERROR";
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCard(row, gameYear) {
  const key = [
    gameYear,
    canonical(row?.name),
    Number(row?.overall ?? row?.rating) || "",
    canonicalVersion(row?.cardType || row?.rarityName || row?.version || "")
  ].join("|");

  const cached = matchCache.get(key);
  if (cached && Date.now() - cached.at < 24 * 60 * 60_000) {
    return cached.value;
  }

  const endpoint = searchEndpoint(gameYear);
  const queryParam = clean(process.env.FUTBIN_PARSE_SEARCH_PARAM || "query", 60);
  const params = { [queryParam]: clean(row?.name, 120), page: 1 };

  if (endpoint === "search_players" && String(gameYear) === "26") {
    params.fc26_only = "true";
  }

  const payload = await parseGet(endpoint, params);
  const item = exactMatch(arraysFromSearch(payload), row);
  if (!item) {
    matchCache.set(key, { at: Date.now(), value: null });
    return null;
  }

  const id = clean(item?.id || item?.player_id || item?.playerId, 120);
  if (!id) return null;

  const value = {
    id,
    name: clean(item?.name || item?.full_name || row?.name, 120),
    rating: integer(item?.rating ?? item?.overall ?? row?.overall),
    version: clean(
      item?.version || item?.rarity || item?.card_type ||
      row?.cardType || row?.rarityName || row?.version,
      120
    ) || null,
    sourceUrl: clean(item?.url || item?.player_url, 1500) || null
  };
  matchCache.set(key, { at: Date.now(), value });
  return value;
}

function readPath(obj, path) {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function firstValue(obj, paths) {
  for (const path of paths) {
    const value = readPath(obj, path);
    if (value != null && value !== "") return value;
  }
  return null;
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeSale(raw) {
  if (!raw || typeof raw !== "object") return null;

  const status = clean(
    firstValue(raw, ["status", "state", "result", "auction_status"]) || "SOLD",
    50
  ).toUpperCase();

  if (status && !["SOLD", "COMPLETED", "COMPLETE", "SUCCESS"].includes(status)) {
    return null;
  }

  const soldFor = firstFinite(
    firstValue(raw, [
      "soldFor", "sold_for", "sold_price", "price",
      "sale_price", "final_price"
    ])
  );
  if (!Number.isFinite(soldFor) || soldFor <= 0) return null;

  const listedFor = firstFinite(
    firstValue(raw, [
      "listedFor", "listed_for", "listed_price", "starting_price", "list_price"
    ])
  );

  const parsedTax = firstFinite(
    firstValue(raw, ["eaTax", "ea_tax", "tax"])
  );
  const parsedNet = firstFinite(
    firstValue(raw, ["netPrice", "net_price", "net"])
  );

  const eaTax = Number.isFinite(parsedTax)
    ? parsedTax
    : Math.round(soldFor * 0.05);
  const netPrice = Number.isFinite(parsedNet)
    ? parsedNet
    : soldFor - eaTax;

  const date = isoDate(
    firstValue(raw, [
      "date", "sold_at", "soldAt", "timestamp", "time", "completed_at"
    ])
  );

  return {
    date,
    listedFor: Number.isFinite(listedFor) ? listedFor : null,
    soldFor,
    eaTax,
    netPrice,
    status: "SOLD"
  };
}

function normalizeEvidence(payload, row, match) {
  const data = unwrap(payload) || {};

  const gamesConsole = firstFinite(
    firstValue(data, [
      "gamesConsole", "games_console", "console_games",
      "usage.games_console", "usage.console_games", "games.console"
    ])
  );
  const gamesPc = firstFinite(
    firstValue(data, [
      "gamesPc", "games_pc", "pc_games",
      "usage.games_pc", "usage.pc_games", "games.pc"
    ])
  );

  let games = firstFinite(
    firstValue(data, [
      "games", "games_total", "total_games",
      "usage.games", "usage.total_games", "games.total"
    ])
  );
  if (!Number.isFinite(games) &&
      (Number.isFinite(gamesConsole) || Number.isFinite(gamesPc))) {
    games = (gamesConsole || 0) + (gamesPc || 0);
  }

  const popularRank = firstFinite(
    firstValue(data, [
      "popularRank", "popular_rank", "rank",
      "popularity.rank", "popular.rank"
    ])
  );
  const popularityCount = firstFinite(
    firstValue(data, [
      "popularityCount", "popularity_count", "popular_count",
      "popularity.count", "popular.count"
    ])
  );

  const rawSales = firstValue(data, [
    "sales", "salesHistory", "sales_history",
    "completed_sales", "market.sales", "market.sales_history"
  ]);
  const sales = (Array.isArray(rawSales) ? rawSales : [])
    .map(normalizeSale)
    .filter(Boolean)
    .slice(0, Math.max(
      1,
      Math.min(500, Number(process.env.MARKET_EVIDENCE_PARSE_SALES_LIMIT || 100))
    ));

  const hasGames = [games, gamesConsole, gamesPc].some(Number.isFinite);
  const hasPopular = Number.isFinite(popularRank);
  const hasSales = sales.length > 0;

  if (!hasGames && !hasPopular && !hasSales) return null;

  return {
    eaId: String(row.eaId),
    name: row.name,
    rating: integer(row.overall ?? row.rating ?? match?.rating),
    version:
      row.cardType || row.rarityName || row.version || match?.version || null,
    games,
    gamesConsole,
    gamesPc,
    popularRank,
    popularityCount,
    sales,
    source: "FUTBIN_PARSE_MANAGED_API",
    sourceUrl: match?.sourceUrl || null,
    observedAt: new Date().toISOString()
  };
}

function selectRows(liveRows) {
  const minRating = Math.max(
    0,
    Math.min(99, Number(process.env.MARKET_EVIDENCE_PARSE_MIN_RATING || 82))
  );
  const batch = Math.max(
    1,
    Math.min(25, Number(process.env.MARKET_EVIDENCE_PARSE_BATCH || 3))
  );

  return (Array.isArray(liveRows) ? liveRows : [])
    .filter(row => row?.eaId && row?.name)
    .filter(row =>
      !Number.isFinite(Number(row?.overall)) ||
      Number(row.overall) >= minRating
    )
    .sort((a, b) =>
      Number(Boolean(b?.tracked)) - Number(Boolean(a?.tracked)) ||
      Number(Boolean(b?.intensiveWatch)) - Number(Boolean(a?.intensiveWatch)) ||
      Number(b?.overall || 0) - Number(a?.overall || 0) ||
      Number(b?.price || 0) - Number(a?.price || 0)
    )
    .slice(0, batch);
}

export async function collectFutbinParseEvidenceV10698({
  liveRows = [],
  gameYear = "26",
  platform = "ps"
} = {}) {
  const configured = Boolean(apiKey());
  state.configured = configured;
  state.baseUrl = baseUrl();
  state.searchEndpoint = searchEndpoint(gameYear);
  state.evidenceEndpoint = evidenceEndpoint();
  state.lastAttemptAt = new Date().toISOString();
  state.lastError = null;
  state.rateLimited = false;
  state.authFailed = false;
  state.cardsAttempted = 0;
  state.cardsReturned = 0;
  state.cardsWithGames = 0;
  state.cardsWithSales = 0;
  state.cardsWithPopularRank = 0;
  state.salesRows = 0;
  state.requests = 0;

  resetBudgetIfNeeded();
  state.callsToday = callsToday;
  state.dailyBudget = dailyBudget();

  if (!configured) {
    state.status = "NOT_CONFIGURED";
    state.endpointAvailable = null;
    return { ok: false, status: state.status, cards: [] };
  }

  if (endpointMissingUntil > Date.now()) {
    state.status = "EVIDENCE_ENDPOINT_NOT_AVAILABLE";
    state.endpointAvailable = false;
    state.lastError =
      `Parse endpoint ${evidenceEndpoint()} is not available yet. Add it in Parse or configure FUTBIN_PARSE_EVIDENCE_ENDPOINT.`;
    return { ok: false, status: state.status, cards: [] };
  }

  const selected = selectRows(liveRows);
  if (!selected.length) {
    state.status = "NO_CANDIDATES";
    return { ok: true, status: state.status, cards: [] };
  }

  state.status = "FETCHING";
  const cards = [];

  for (const row of selected) {
    state.cardsAttempted += 1;
    try {
      const match = await resolveCard(row, gameYear);
      if (!match) continue;

      const payload = await parseGet(evidenceEndpoint(), {
        player_id: match.id,
        year: String(gameYear),
        platform: platform === "pc" ? "pc" : "ps"
      });
      state.endpointAvailable = true;

      const card = normalizeEvidence(payload, row, match);
      if (!card) continue;

      cards.push(card);
      if ([card.games, card.gamesConsole, card.gamesPc].some(Number.isFinite)) {
        state.cardsWithGames += 1;
      }
      if (Number.isFinite(card.popularRank)) {
        state.cardsWithPopularRank += 1;
      }
      if (card.sales.length) {
        state.cardsWithSales += 1;
        state.salesRows += card.sales.length;
      }
    } catch (error) {
      state.lastError = String(error?.message || error);

      if (error?.code === "EVIDENCE_ENDPOINT_NOT_AVAILABLE") {
        state.endpointAvailable = false;
        const cooldownMin = Math.max(
          5,
          Math.min(
            360,
            Number(process.env.MARKET_EVIDENCE_PARSE_MISSING_COOLDOWN_MIN || 30)
          )
        );
        endpointMissingUntil = Date.now() + cooldownMin * 60_000;
        break;
      }
      if (error?.code === "RATE_LIMITED") {
        state.rateLimited = true;
        break;
      }
      if (error?.code === "AUTH_FAILED") {
        state.authFailed = true;
        break;
      }
      if (error?.code === "DAILY_BUDGET_REACHED") {
        break;
      }
    }
  }

  state.cardsReturned = cards.length;
  state.callsToday = callsToday;

  if (cards.length) {
    state.status = "READY";
    state.lastSuccessAt = new Date().toISOString();
    state.lastFailureAt = null;
    state.lastError = null;
  } else {
    if (state.endpointAvailable === false) {
      state.status = "EVIDENCE_ENDPOINT_NOT_AVAILABLE";
    } else if (state.authFailed) {
      state.status = "AUTH_FAILED";
    } else if (state.rateLimited) {
      state.status = "RATE_LIMITED";
    } else if (callsToday >= dailyBudget()) {
      state.status = "DAILY_BUDGET_REACHED";
    } else {
      state.status = "NO_VERIFIED_EVIDENCE";
    }
    state.lastFailureAt = new Date().toISOString();
  }

  return {
    ok: cards.length > 0,
    status: state.status,
    cards,
    source: "FUTBIN_PARSE_MANAGED_API"
  };
}

export function getFutbinParseEvidenceStatusV10698() {
  resetBudgetIfNeeded();
  return {
    adapterVersion: FUTBIN_PARSE_EVIDENCE_ADAPTER_VERSION,
    mode: "MANAGED_PARSE_API",
    configured: Boolean(apiKey()),
    ...state,
    callsToday,
    dailyBudget: dailyBudget()
  };
}

export const __test = {
  canonical,
  canonicalVersion,
  finiteNumber,
  unwrap,
  arraysFromSearch,
  exactMatch,
  normalizeSale,
  normalizeEvidence
};
