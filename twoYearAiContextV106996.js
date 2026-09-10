export const TWO_YEAR_AI_CONTEXT_VERSION = "10.69.9.6";
const WINDOW_DAYS = 730;
const TARGET_MONTHS = 24;
const SOURCE_GAME_YEARS = ["25", "26"];
const CACHE_MS = Math.max(60_000, Math.min(60 * 60_000, Number(process.env.TWO_YEAR_AI_CONTEXT_CACHE_MIN || 15) * 60_000));

const cardCache = new Map();
let tableCache = { at: 0, value: null };
let coverageCache = { at: 0, activeGameYear: null, value: null };
let lastFeed = {
  version: TWO_YEAR_AI_CONTEXT_VERSION,
  status: "IDLE",
  targetMonths: TARGET_MONTHS,
  requestedWindowDays: WINDOW_DAYS,
  sourceGameYears: [...SOURCE_GAME_YEARS],
  activeGameYear: null,
  eaId: null,
  playerName: null,
  full24MonthWindowAvailable: false,
  globalObservedCalendarDays: 0,
  globalSpanDays: 0,
  cardObservedDays: 0,
  cardGameYearsFound: [],
  synthetic: false,
  loadedAt: null,
  error: null
};

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function rounded(value, digits = 2) {
  const n = finite(value);
  return n == null ? null : Number(n.toFixed(digits));
}
function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function pctChange(from, to) {
  const a = finite(from);
  const b = finite(to);
  if (a == null || b == null || a <= 0) return null;
  return rounded(((b - a) / a) * 100);
}
function daysBetween(a, b) {
  const x = Date.parse(a || "");
  const y = Date.parse(b || "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.max(0, (y - x) / 86_400_000);
}

async function availableTables(pool) {
  if (!pool) return { own: false, legacy: false };
  if (tableCache.value && Date.now() - tableCache.at < CACHE_MS) return tableCache.value;
  const result = await pool.query(`
    SELECT
      to_regclass('public.fc_own_market_price_history') AS own_table,
      to_regclass('public.fc_price_history') AS legacy_table
  `);
  const value = {
    own: Boolean(result.rows?.[0]?.own_table),
    legacy: Boolean(result.rows?.[0]?.legacy_table)
  };
  tableCache = { at: Date.now(), value };
  return value;
}

function coverageFromRow(row = {}) {
  const earliestAt = iso(row.earliest_at);
  const latestAt = iso(row.latest_at);
  return {
    earliestAt,
    latestAt,
    spanDays: earliestAt && latestAt ? rounded(daysBetween(earliestAt, latestAt)) : 0,
    observedCalendarDays: Number(row.observed_days || 0),
    observations: Number(row.observations || 0),
    cards: Number(row.cards || 0)
  };
}

async function globalCoverage(pool, activeGameYear) {
  const activeYear = String(activeGameYear || "26");
  if (coverageCache.value && coverageCache.activeGameYear === activeYear && Date.now() - coverageCache.at < CACHE_MS) {
    return coverageCache.value;
  }
  const tables = await availableTables(pool);
  const byGameYear = {};
  const sourceParts = [];

  for (const year of SOURCE_GAME_YEARS) {
    const yearParts = [];
    if (tables.own) {
      yearParts.push(`SELECT observed_at AS at, ea_id::text AS ea_id FROM fc_own_market_price_history
        WHERE game_year = '${year}' AND observed_at >= NOW() - INTERVAL '730 days'`);
    }
    // The legacy table has no game_year. It is only safe as FC26 evidence while
    // FC26 is the active runtime. Once FC27 is active it is not read as historical
    // FC26 because new rows could otherwise contaminate the prior.
    if (tables.legacy && year === "26" && activeYear === "26") {
      yearParts.push(`SELECT recorded_at AS at, ea_id::text AS ea_id FROM fc_price_history
        WHERE recorded_at >= NOW() - INTERVAL '730 days'`);
    }
    if (!yearParts.length) {
      byGameYear[year] = coverageFromRow({});
      continue;
    }
    const result = await pool.query(`
      WITH source AS (${yearParts.join(" UNION ALL ")})
      SELECT MIN(at) AS earliest_at, MAX(at) AS latest_at,
             COUNT(*)::bigint AS observations,
             COUNT(DISTINCT ea_id)::bigint AS cards,
             COUNT(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS observed_days
      FROM source
    `);
    byGameYear[year] = coverageFromRow(result.rows?.[0] || {});
    sourceParts.push(...yearParts);
  }

  let combined = coverageFromRow({});
  if (sourceParts.length) {
    const result = await pool.query(`
      WITH source AS (${sourceParts.join(" UNION ALL ")})
      SELECT MIN(at) AS earliest_at, MAX(at) AS latest_at,
             COUNT(*)::bigint AS observations,
             COUNT(DISTINCT ea_id)::bigint AS cards,
             COUNT(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS observed_days
      FROM source
    `);
    combined = coverageFromRow(result.rows?.[0] || {});
  }
  const full24MonthWindowAvailable = combined.spanDays >= 729 && combined.observedCalendarDays >= 700;
  const value = {
    requestedWindowDays: WINDOW_DAYS,
    targetMonths: TARGET_MONTHS,
    sourceGameYears: [...SOURCE_GAME_YEARS],
    byGameYear,
    combined,
    full24MonthWindowAvailable,
    synthetic: false
  };
  coverageCache = { at: Date.now(), activeGameYear: activeYear, value };
  return value;
}

async function cardDailyRows(pool, activeGameYear, eaId) {
  const activeYear = String(activeGameYear || "26");
  const tables = await availableTables(pool);
  const parts = [];
  const params = [String(eaId)];
  if (tables.own) {
    parts.push(`SELECT game_year::text AS game_year, price::int AS price, observed_at AS at
      FROM fc_own_market_price_history
      WHERE game_year IN ('25','26') AND ea_id::text = $1
        AND observed_at >= NOW() - INTERVAL '730 days'`);
  }
  if (tables.legacy && activeYear === "26") {
    parts.push(`SELECT '26'::text AS game_year, price::int AS price, recorded_at AS at
      FROM fc_price_history
      WHERE ea_id::text = $1 AND recorded_at >= NOW() - INTERVAL '730 days'`);
  }
  if (!parts.length) return [];
  const result = await pool.query(`
    WITH combined AS (
      SELECT DISTINCT game_year, price, at FROM (${parts.join(" UNION ALL ")}) raw
    )
    SELECT game_year,
           DATE_TRUNC('day', at) AS day,
           (ARRAY_AGG(price ORDER BY at ASC))[1] AS open_price,
           (ARRAY_AGG(price ORDER BY at DESC))[1] AS close_price,
           MIN(price)::int AS low_price,
           MAX(price)::int AS high_price,
           ROUND(AVG(price)::numeric, 2) AS avg_price,
           COUNT(*)::int AS observations
    FROM combined
    GROUP BY game_year, DATE_TRUNC('day', at)
    ORDER BY day ASC
  `, params);
  return (result.rows || []).map(row => ({
    gameYear: String(row.game_year),
    day: iso(row.day),
    openPrice: Number(row.open_price),
    closePrice: Number(row.close_price),
    lowPrice: Number(row.low_price),
    highPrice: Number(row.high_price),
    avgPrice: Number(row.avg_price),
    observations: Number(row.observations || 0)
  }));
}

function periodStats(rows, days, currentPrice = null, useCurrent = false) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const latestMs = Date.parse(rows.at(-1)?.day || "");
  if (!Number.isFinite(latestMs)) return null;
  const cutoff = latestMs - (Math.max(1, days) - 1) * 86_400_000;
  const slice = rows.filter(row => Number.isFinite(Date.parse(row?.day || "")) && Date.parse(row.day) >= cutoff);
  if (!slice.length) return null;
  const lows = slice.map(x => finite(x.lowPrice)).filter(Number.isFinite);
  const highs = slice.map(x => finite(x.highPrice)).filter(Number.isFinite);
  const avgs = slice.map(x => finite(x.avgPrice)).filter(Number.isFinite);
  const first = finite(slice[0]?.closePrice ?? slice[0]?.openPrice);
  const storedLast = finite(slice.at(-1)?.closePrice ?? slice.at(-1)?.avgPrice);
  const last = useCurrent && finite(currentPrice) != null ? finite(currentPrice) : storedLast;
  const low = lows.length ? Math.min(...lows) : null;
  const high = highs.length ? Math.max(...highs) : null;
  return {
    requestedDays: days,
    observedDays: slice.length,
    spanDays: rounded(daysBetween(slice[0]?.day, slice.at(-1)?.day)),
    firstClose: first,
    lastClose: storedLast,
    low,
    high,
    avg: avgs.length ? rounded(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
    changePct: pctChange(first, last),
    rangePositionPct: useCurrent && low != null && high != null && high > low && last != null
      ? rounded(((last - low) / (high - low)) * 100)
      : null
  };
}

function monthlyStats(rows, gameYear) {
  const buckets = new Map();
  for (const row of rows || []) {
    const day = iso(row?.day);
    if (!day) continue;
    const month = day.slice(0, 7);
    if (!buckets.has(month)) buckets.set(month, []);
    buckets.get(month).push(row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12).map(([month, monthRows]) => {
    const lows = monthRows.map(x => finite(x.lowPrice)).filter(Number.isFinite);
    const highs = monthRows.map(x => finite(x.highPrice)).filter(Number.isFinite);
    const avgs = monthRows.map(x => finite(x.avgPrice)).filter(Number.isFinite);
    const open = finite(monthRows[0]?.openPrice ?? monthRows[0]?.closePrice);
    const close = finite(monthRows.at(-1)?.closePrice ?? monthRows.at(-1)?.avgPrice);
    return {
      gameYear: String(gameYear), month, observedDays: monthRows.length, open, close,
      low: lows.length ? Math.min(...lows) : null,
      high: highs.length ? Math.max(...highs) : null,
      avg: avgs.length ? rounded(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null,
      changePct: pctChange(open, close)
    };
  });
}

function buildYearContext(rows, year, activeYear, currentPrice) {
  const yearRows = rows.filter(row => String(row.gameYear) === String(year));
  if (!yearRows.length) return {
    gameYear: String(year), available: false, observedDays: 0, spanDays: 0,
    earliestAt: null, latestAt: null, periods: {}, monthly: [], synthetic: false
  };
  const useCurrent = String(year) === String(activeYear);
  return {
    gameYear: String(year),
    available: true,
    observedDays: yearRows.length,
    spanDays: rounded(daysBetween(yearRows[0]?.day, yearRows.at(-1)?.day)),
    earliestAt: yearRows[0]?.day || null,
    latestAt: yearRows.at(-1)?.day || null,
    periods: {
      d30: periodStats(yearRows, 30, currentPrice, useCurrent),
      d90: periodStats(yearRows, 90, currentPrice, useCurrent),
      d180: periodStats(yearRows, 180, currentPrice, useCurrent),
      d365: periodStats(yearRows, 365, currentPrice, useCurrent)
    },
    monthly: monthlyStats(yearRows, year),
    synthetic: false
  };
}

function emptyContext(activeYear, eaId, playerName, currentPrice, coverage, reason) {
  return {
    available: false,
    version: TWO_YEAR_AI_CONTEXT_VERSION,
    role: Number(activeYear) <= 26 ? "FC25_PRIOR_PLUS_FC26_ACTIVE" : "FC25_FC26_HISTORICAL_PRIORS",
    activeGameYear: String(activeYear),
    sourceGameYears: [...SOURCE_GAME_YEARS],
    targetMonths: TARGET_MONTHS,
    requestedWindowDays: WINDOW_DAYS,
    eaId: String(eaId || ""),
    playerName: playerName || null,
    currentPrice: finite(currentPrice),
    globalCoverage: coverage || null,
    byGameYear: {},
    monthly: [],
    synthetic: false,
    rawPricesMergedAcrossGameYears: false,
    reason
  };
}

export async function loadTwoYearAiContextV106996({
  pool = null,
  activeGameYear = "26",
  eaId,
  playerName = null,
  currentPrice = null,
  force = false
} = {}) {
  const activeYear = String(activeGameYear || "26");
  const key = `${activeYear}:${String(eaId || "")}`;
  const cached = cardCache.get(key);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    lastFeed = { ...lastFeed, ...cached.status, status: "CACHE_HIT", loadedAt: new Date().toISOString() };
    return cached.value;
  }
  if (!pool || !eaId) {
    const value = emptyContext(activeYear, eaId, playerName, currentPrice, null, !pool ? "NO_DATABASE" : "EA_ID_REQUIRED");
    lastFeed = { ...lastFeed, status: value.reason, activeGameYear: activeYear, eaId: eaId ? String(eaId) : null, playerName, loadedAt: new Date().toISOString() };
    return value;
  }

  try {
    const [coverage, rows] = await Promise.all([
      globalCoverage(pool, activeYear),
      cardDailyRows(pool, activeYear, String(eaId))
    ]);
    const byGameYear = Object.fromEntries(SOURCE_GAME_YEARS.map(year => [year, buildYearContext(rows, year, activeYear, currentPrice)]));
    const monthly = SOURCE_GAME_YEARS.flatMap(year => byGameYear[year]?.monthly || [])
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-TARGET_MONTHS);
    const cardGameYearsFound = SOURCE_GAME_YEARS.filter(year => byGameYear[year]?.available);
    const cardObservedDays = SOURCE_GAME_YEARS.reduce((sum, year) => sum + Number(byGameYear[year]?.observedDays || 0), 0);
    const available = cardObservedDays > 0;
    const value = {
      available,
      version: TWO_YEAR_AI_CONTEXT_VERSION,
      role: Number(activeYear) <= 26 ? "FC25_PRIOR_PLUS_FC26_ACTIVE" : "FC25_FC26_HISTORICAL_PRIORS",
      activeGameYear: activeYear,
      sourceGameYears: [...SOURCE_GAME_YEARS],
      targetMonths: TARGET_MONTHS,
      requestedWindowDays: WINDOW_DAYS,
      eaId: String(eaId),
      playerName,
      currentPrice: finite(currentPrice),
      globalCoverage: coverage,
      cardGameYearsFound,
      cardObservedDays,
      byGameYear,
      monthly,
      synthetic: false,
      rawPricesMergedAcrossGameYears: false,
      full24MonthWindowAvailable: Boolean(coverage?.full24MonthWindowAvailable),
      reason: available
        ? (coverage?.full24MonthWindowAvailable ? "REAL_24_MONTH_CONTEXT_AVAILABLE" : "REAL_PARTIAL_24_MONTH_CONTEXT")
        : "NO_MATCHING_CARD_HISTORY"
    };
    const status = {
      activeGameYear: activeYear,
      eaId: String(eaId),
      playerName,
      full24MonthWindowAvailable: Boolean(coverage?.full24MonthWindowAvailable),
      globalObservedCalendarDays: Number(coverage?.combined?.observedCalendarDays || 0),
      globalSpanDays: Number(coverage?.combined?.spanDays || 0),
      cardObservedDays,
      cardGameYearsFound,
      synthetic: false,
      error: null
    };
    cardCache.set(key, { at: Date.now(), value, status });
    lastFeed = { ...lastFeed, ...status, status: available ? "READY" : "NO_MATCHING_CARD_HISTORY", loadedAt: new Date().toISOString() };
    return value;
  } catch (error) {
    const message = String(error?.message || error);
    const value = emptyContext(activeYear, eaId, playerName, currentPrice, null, `LOAD_FAILED: ${message}`);
    lastFeed = { ...lastFeed, status: "ERROR", activeGameYear: activeYear, eaId: String(eaId), playerName, loadedAt: new Date().toISOString(), error: message };
    return value;
  }
}

export function getTwoYearAiFeedStatusV106996() {
  return { ...lastFeed, sourceGameYears: [...SOURCE_GAME_YEARS], targetMonths: TARGET_MONTHS, requestedWindowDays: WINDOW_DAYS };
}

export const __test = { periodStats, monthlyStats, buildYearContext, coverageFromRow };
