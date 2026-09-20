import { FUTBIN_FC27_EA_TO_ID } from "./futbinIdMapFc27.js";

const DEFAULT_PARSE_BASE = "https://api.parse.bot/scraper/21963078-8a17-40ff-a896-9b0b0ec3e828";
const DEFAULT_DAILY_BUDGET = 6;
const DEFAULT_MIN_INTERVAL_MS = 60 * 60_000;
const DEFAULT_CARD_CACHE_MS = 6 * 60 * 60_000;

const cardCache = new Map();
const state = {
  callsToday: 0,
  callsDate: "",
  successes: 0,
  failures: 0,
  applied: 0,
  lastCallAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastHttpStatus: null,
  lastRetryAfterSeconds: null,
  lastProviderCode: null,
  lastProviderMessage: null,
  lastPlayer: null,
  lastRunAt: null,
  lastRun: null,
  disabledUntil: null,
  circuitReason: null
};

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function configuredKey(options = {}) {
  return String(options.apiKey ?? process.env.FUTBIN_PARSE_API_KEY ?? "").trim();
}
function baseUrl(options = {}) {
  return String(
    options.baseUrl ??
    process.env.FUTBIN_PARSE_BASE_URL ??
    process.env.FUTBIN_PARSE_API_BASE ??
    DEFAULT_PARSE_BASE
  ).replace(/\/$/, "");
}
function dailyBudget(options = {}) {
  const raw = Number(options.dailyBudget ?? process.env.FUTBIN_PARSE_BRAIN_DAILY_BUDGET ?? process.env.FUTBIN_PARSE_DAILY_BUDGET ?? DEFAULT_DAILY_BUDGET);
  return Math.max(1, Math.min(50, Number.isFinite(raw) ? raw : DEFAULT_DAILY_BUDGET));
}
function minIntervalMs(options = {}) {
  const raw = Number(options.minIntervalMs ?? (Number(process.env.FUTBIN_PARSE_BRAIN_MIN_INTERVAL_MIN || 60) * 60_000));
  return Math.max(60_000, Number.isFinite(raw) ? raw : DEFAULT_MIN_INTERVAL_MS);
}
function cardCacheMs(options = {}) {
  const raw = Number(options.cardCacheMs ?? (Number(process.env.FUTBIN_PARSE_BRAIN_CARD_CACHE_MIN || 360) * 60_000));
  return Math.max(60_000, Number.isFinite(raw) ? raw : DEFAULT_CARD_CACHE_MS);
}
function retryAfterSeconds(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
}
async function providerError(response) {
  const status = Number(response?.status || 0) || null;
  const retrySeconds = retryAfterSeconds(response);
  let body = null;
  try {
    const text = typeof response?.text === "function" ? await response.text() : "";
    if (text) body = JSON.parse(text);
  } catch {}
  const providerCode = body?.code ?? body?.error_code ?? body?.error ?? null;
  const providerMessage = String(body?.message ?? body?.detail ?? body?.reason ?? "").slice(0, 180) || null;
  const error = new Error(`Parse FUTBIN HTTP ${status || "ERROR"}`);
  error.httpStatus = status;
  error.retryAfterSeconds = retrySeconds;
  error.providerCode = providerCode == null ? null : String(providerCode).slice(0, 80);
  error.providerMessage = providerMessage;
  return error;
}
function dateKey() {
  return new Date().toISOString().slice(0, 10);
}
function refreshDay() {
  const key = dateKey();
  if (state.callsDate !== key) {
    state.callsDate = key;
    state.callsToday = 0;
  }
}
function normalize(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function parseCoin(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Math.round(Number(value));
  const raw = String(value ?? "").trim().toUpperCase().replace(/[,\s]/g, "");
  if (!raw || ["0","-","N/A","NA","NULL","UNAVAILABLE"].includes(raw)) return null;
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/);
  if (!m) return null;
  const base = Number(m[1]);
  if (!(base > 0)) return null;
  const factor = m[2] === "B" ? 1_000_000_000 : m[2] === "M" ? 1_000_000 : m[2] === "K" ? 1_000 : 1;
  return Math.round(base * factor);
}
function rowsFrom(payload) {
  const root = payload?.data ?? payload ?? {};
  const candidates = [
    root?.players,
    root?.results,
    root?.items,
    payload?.players,
    payload?.results,
    payload?.items,
    Array.isArray(root) ? root : null,
    Array.isArray(payload) ? payload : null
  ];
  return candidates.find(Array.isArray) || [];
}
function pickPrice(item) {
  return parseCoin(
    item?.price_ps ??
    item?.pricePS ??
    item?.prices?.ps ??
    item?.prices?.console ??
    item?.price_console ??
    item?.LCPrice
  );
}
function matchRow(row, items) {
  const wantedName = normalize(row?.name);
  const wantedRating = Number(row?.overall);
  const wantedPosition = normalize(row?.position).split(" ")[0] || "";
  const wantedVersion = normalize(`${row?.rarityName || ""} ${row?.cardType || ""}`);
  const scored = [];

  for (const item of Array.isArray(items) ? items : []) {
    const price = pickPrice(item);
    if (!price) continue;
    const itemName = normalize(item?.name ?? item?.full_name ?? item?.player_name ?? item?.Player_Fullname);
    const itemRating = Number(item?.rating ?? item?.overall);
    if (!wantedName || !itemName) continue;
    if (!(itemName === wantedName || itemName.includes(wantedName) || wantedName.includes(itemName))) continue;
    if (Number.isFinite(wantedRating) && Number.isFinite(itemRating) && itemRating !== wantedRating) continue;

    let score = itemName === wantedName ? 60 : 40;
    if (Number.isFinite(wantedRating) && itemRating === wantedRating) score += 25;
    const itemPosition = normalize(item?.position);
    if (wantedPosition && itemPosition.includes(wantedPosition)) score += 5;

    const itemVersion = normalize(item?.version ?? item?.rarity ?? item?.card_type);
    if (wantedVersion && itemVersion) {
      const wantedTokens = new Set(wantedVersion.split(" ").filter(token => token.length >= 3));
      const itemTokens = new Set(itemVersion.split(" ").filter(token => token.length >= 3));
      let overlap = 0;
      for (const token of wantedTokens) if (itemTokens.has(token)) overlap += 1;
      if (overlap > 0) score += Math.min(15, overlap * 5);
    }
    scored.push({ item, price, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 70) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) {
    const a = scored[0].price;
    const b = scored[1].price;
    const spread = Math.abs(a - b) / Math.max(1, Math.min(a, b)) * 100;
    if (spread > 5) return null;
  }
  const best = scored[0];
  return {
    price: best.price,
    futbinId: best.item?.id ?? best.item?.player_id ?? best.item?.ID ?? null,
    matchConfidence: Math.max(70, Math.min(99, best.score)),
    version: best.item?.version ?? best.item?.rarity ?? best.item?.card_type ?? null
  };
}
function isImportant(row) {
  if (!row || positive(row.futbinPrice)) return false;
  if (!positive(row.eaId) || !positive(row.price) || !row.name) return false;

  const rating = Number(row.overall || 0);
  const action = String(row.aiAction || "");
  const confidence = Number(row.aiConfidence || 0);
  const originalAction = String(row?.aiBuyGuard?.originalAction || "");
  const originalConfidence = Number(row?.aiBuyGuard?.originalConfidence || 0);
  const exactStrongAction = ["JETZT KAUFEN","JETZT VERKAUFEN"].includes(action);
  const exactStrongGuard = ["JETZT KAUFEN","JETZT VERKAUFEN"].includes(originalAction);

  // Protect scarce Parse credits. Normal low-rated cards are never sampled just
  // because they are tracked. Sub-82 cards need an exceptional live BUY/SELL.
  if (rating < 82) {
    return (exactStrongAction && confidence >= 92) || (exactStrongGuard && originalConfidence >= 92);
  }

  if (row.tracked || row.intensiveWatch) return true;
  if (["JETZT KAUFEN","JETZT VERKAUFEN","VERKAUF PRÜFEN","VERKAUF PRÃœFEN"].includes(action)) return true;
  if (exactStrongGuard) return true;
  const movement = Math.max(Math.abs(Number(row.change5m || 0)), Math.abs(Number(row.change15m || 0)), Math.abs(Number(row.change1h || 0)));
  return confidence >= 90 && movement >= 8;
}
function priority(row) {
  const action = String(row?.aiAction || "");
  const weights = { "JETZT VERKAUFEN": 120, "JETZT KAUFEN": 115, "VERKAUF PRÜFEN": 110, "VERKAUF PRÃœFEN": 110 };
  return (row?.tracked ? 30 : 0) + (row?.intensiveWatch ? 20 : 0) + (weights[action] || 0) + Number(row?.aiConfidence || 0) / 10;
}
function applyMatch(row, match, brainWork, options = {}) {
  if (!row || !match?.price || !positive(row.price)) return false;
  const price = positive(match.price);
  if (!price) return false;
  const diffPct = Number((((price - Number(row.price)) / Number(row.price)) * 100).toFixed(2));
  const absDiff = Math.abs(diffPct);
  const maxDiffPct = Number(options.maxDiffPct ?? 12);
  const outlierDiffPct = Number(options.outlierDiffPct ?? 25);
  const checkedAt = new Date().toISOString();

  row.futbinPrice = price;
  row.futbinDiffPct = diffPct;
  row.futbinCrossCheck = absDiff >= outlierDiffPct ? "OUTLIER" : absDiff >= maxDiffPct ? "DIVERGENCE" : "MATCH";
  row.futbinProvider = "PARSE_FUTBIN_FC27";
  row.futbinMatchConfidence = match.matchConfidence;
  row.futbinId = match.futbinId ?? row.futbinId ?? null;
  row.futbinVersion = match.version ?? null;
  row.futbinCheckedAt = checkedAt;

  const work = brainWork?.get?.(String(row.eaId));
  if (work?.input) {
    work.input.futbinCrossCheck = {
      provider: row.futbinProvider,
      price,
      diffPct,
      status: row.futbinCrossCheck,
      matchConfidence: row.futbinMatchConfidence,
      checkedAt
    };
  }
  return true;
}

export async function enrichImportantRowsWithParseFutbinBrain(rows = [], brainWork = new Map(), options = {}) {
  const gameYear = Number(options.gameYear || 0);
  const now = Date.now();
  refreshDay();
  state.lastRunAt = new Date(now).toISOString();

  if (gameYear !== 27) {
    state.lastRun = { ok: false, reason: "NON_FC27", gameYear, applied: 0 };
    return state.lastRun;
  }

  const apiKey = configuredKey(options);
  if (!apiKey) {
    state.lastRun = { ok: false, reason: "NOT_CONFIGURED", gameYear, applied: 0 };
    return state.lastRun;
  }

  if (state.disabledUntil && now < Date.parse(state.disabledUntil)) {
    state.lastRun = { ok: false, reason: "CIRCUIT_OPEN", gameYear, applied: 0, disabledUntil: state.disabledUntil, circuitReason: state.circuitReason };
    return state.lastRun;
  }

  const candidates = (Array.isArray(rows) ? rows : [])
    .filter(isImportant)
    .sort((a, b) => priority(b) - priority(a));

  let applied = 0;
  const ttl = cardCacheMs(options);
  for (const row of candidates) {
    const cached = cardCache.get(String(row.eaId));
    if (cached && now - cached.at < ttl) {
      if (applyMatch(row, cached.match, brainWork, options)) applied += 1;
    }
  }

  const budget = dailyBudget(options);
  const remaining = Math.max(0, budget - state.callsToday);
  const lastCallMs = state.lastCallAt ? Date.parse(state.lastCallAt) : 0;
  const intervalReady = !lastCallMs || now - lastCallMs >= minIntervalMs(options);

  if (remaining <= 0 || !intervalReady) {
    state.applied += applied;
    state.lastRun = {
      ok: true,
      reason: remaining <= 0 ? "DAILY_BUDGET_REACHED" : "MIN_INTERVAL",
      gameYear,
      candidates: candidates.length,
      applied,
      callsToday: state.callsToday,
      dailyBudget: budget,
      remaining
    };
    return state.lastRun;
  }

  const uncached = candidates.filter(candidate => {
    const cached = cardCache.get(String(candidate.eaId));
    return !(cached && now - cached.at < ttl);
  });
  const batch = uncached
    .map(row => ({ row, futbinId: Number(row.futbinId || FUTBIN_FC27_EA_TO_ID?.[String(row.eaId)] || 0) }))
    .filter(entry => Number.isInteger(entry.futbinId) && entry.futbinId > 0)
    .slice(0, 500);

  if (!batch.length) {
    state.applied += applied;
    state.lastRun = { ok: true, reason: "CACHE_OR_UNMAPPED", gameYear, candidates: candidates.length, applied, callsToday: state.callsToday, dailyBudget: budget, remaining };
    return state.lastRun;
  }

  const endpoint = "get_fc27_market_snapshot";
  const ids = batch.map(entry => entry.futbinId).join(",");
  const url = `${baseUrl(options)}/${endpoint}?player_ids=${encodeURIComponent(ids)}&platform=ps&year=27`;
  const fetcher = options.fetcher || fetch;
  state.callsToday += 1;
  state.lastCallAt = new Date().toISOString();
  state.lastPlayer = `BATCH:${batch.length}`;

  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        "X-API-Key": apiKey,
        "user-agent": "FC-Trader-Brain/10.69.9.6.9"
      }
    });
    if (response && "ok" in response && !response.ok) throw await providerError(response);
    const payload = typeof response?.json === "function" ? await response.json() : response;
    const snapshotRows = payload?.players ?? payload?.data?.players ?? [];
    const byId = new Map((Array.isArray(snapshotRows) ? snapshotRows : []).map(item => [Number(item?.player_id ?? item?.id), item]));
    let matched = 0;
    for (const entry of batch) {
      const item = byId.get(entry.futbinId);
      const price = positive(item?.price);
      if (!price) continue;
      const match = { price, futbinId: entry.futbinId, matchConfidence: 100, version: entry.row?.rarityName ?? entry.row?.cardType ?? null };
      cardCache.set(String(entry.row.eaId), { at: Date.now(), match });
      if (applyMatch(entry.row, match, brainWork, options)) { applied += 1; matched += 1; }
    }
    if (!matched) throw new Error("NO_SAFE_FUTBIN_SNAPSHOT_PRICES");
    state.successes += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.lastHttpStatus = 200;
    state.lastRetryAfterSeconds = null;
    state.lastProviderCode = null;
    state.lastProviderMessage = null;
    state.disabledUntil = null;
    state.circuitReason = null;
  } catch (error) {
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = String(error?.message || error);
    state.lastHttpStatus = Number(error?.httpStatus || 0) || null;
    state.lastRetryAfterSeconds = Number.isFinite(Number(error?.retryAfterSeconds)) ? Number(error.retryAfterSeconds) : null;
    state.lastProviderCode = error?.providerCode ?? null;
    state.lastProviderMessage = error?.providerMessage ?? null;
    if (/HTTP\s*429/i.test(state.lastError)) {
      const quotaLike = /credit|quota|plan|billing|limit.*month/i.test(`${state.lastProviderCode || ""} ${state.lastProviderMessage || ""}`);
      const retryMs = state.lastRetryAfterSeconds != null ? state.lastRetryAfterSeconds * 1000 : 0;
      const fallbackMs = quotaLike ? 24 * 60 * 60_000 : 6 * 60 * 60_000;
      const backoffMs = Math.max(60_000, Math.min(24 * 60 * 60_000, retryMs || fallbackMs));
      state.disabledUntil = new Date(Date.now() + backoffMs).toISOString();
      state.circuitReason = quotaLike ? "QUOTA_EXHAUSTED" : "RATE_LIMITED";
    } else if (/HTTP\s*(?:401|403)/i.test(state.lastError)) {
      state.disabledUntil = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
      state.circuitReason = "ACCESS_BLOCKED";
    }
  }

  state.applied += applied;
  state.lastRun = {
    ok: state.lastError == null,
    gameYear,
    candidates: candidates.length,
    applied,
    callsToday: state.callsToday,
    dailyBudget: budget,
    remaining: Math.max(0, budget - state.callsToday),
    lastError: state.lastError
  };
  return state.lastRun;
}

export function getParseFutbinBrainFallbackStatus(options = {}) {
  refreshDay();
  const budget = dailyBudget(options);
  return {
    configured: Boolean(configuredKey(options)),
    provider: "PARSE_FUTBIN_FC27",
    gameYear: 27,
    endpoint: "get_fc27_market_snapshot",
    batchSize: 500,
    importantOnly: true,
    noSyntheticPrices: true,
    minIntervalMinutes: Math.round(minIntervalMs(options) / 60_000),
    cardCacheMinutes: Math.round(cardCacheMs(options) / 60_000),
    dailyBudget: budget,
    remaining: Math.max(0, budget - state.callsToday),
    ...state
  };
}

export function resetParseFutbinBrainFallbackForTests() {
  cardCache.clear();
  for (const key of Object.keys(state)) {
    if (["callsToday","successes","failures","applied"].includes(key)) state[key] = 0;
    else state[key] = null;
  }
  state.callsDate = "";
}
