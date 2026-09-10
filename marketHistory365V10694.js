import express from "express";

export const MARKET_HISTORY_365_VERSION = "1.1.0";
const BUILD = "10.69.4";
const WINDOW_DAYS = 365;
const STATUS_CACHE_MS = 15 * 60_000;

let statusCache = { at: 0, gameYear: null, value: null };

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(value, digits = 2) {
  const n = finite(value);
  return n == null ? null : Number(n.toFixed(digits));
}

function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

async function availableTables(pool) {
  if (!pool) return { own: false, legacy: false };
  try {
    const result = await pool.query(`
      SELECT
        to_regclass('public.fc_own_market_price_history') AS own_table,
        to_regclass('public.fc_price_history') AS legacy_table
    `);
    return {
      own: Boolean(result.rows?.[0]?.own_table),
      legacy: Boolean(result.rows?.[0]?.legacy_table)
    };
  } catch {
    return { own: false, legacy: false };
  }
}

function emptyCoverage() {
  return {
    earliestAt: null,
    latestAt: null,
    spanDays: 0,
    observedCalendarDays: 0,
    spanCoveragePct: 0,
    calendarCoveragePct: 0,
    observations: 0,
    cards: 0
  };
}

function emptyStatus(gameYear, reason) {
  return {
    ok: true,
    service: "FC 365-Day Market Learning Coverage",
    version: MARKET_HISTORY_365_VERSION,
    build: BUILD,
    gameYear: String(gameYear),
    requestedWindowDays: WINDOW_DAYS,
    learningWindowDays: WINDOW_DAYS,
    performanceLabWindowDays: WINDOW_DAYS,
    available: false,
    fullWindowAvailable: false,
    coverage: emptyCoverage(),
    sources: {},
    reason,
    policy: {
      noSyntheticBackfill: true,
      futggPrimary: true,
      olderDataMayInformPriors: true,
      recentDataKeepsHigherWeight: true,
      legacyUngroupedHistoryUsedForFc26Only: true
    }
  };
}

function coverageFromRow(row = {}) {
  const earliestAt = iso(row.earliest_at);
  const latestAt = iso(row.latest_at);
  const observations = Number(row.observations || 0);
  const cards = Number(row.cards || 0);
  const observedCalendarDays = Number(row.observed_days || 0);
  const earliestMs = earliestAt ? Date.parse(earliestAt) : NaN;
  const latestMs = latestAt ? Date.parse(latestAt) : NaN;
  const spanDays = Number.isFinite(earliestMs) && Number.isFinite(latestMs)
    ? Math.max(0, (latestMs - earliestMs) / 86_400_000)
    : 0;
  return {
    earliestAt,
    latestAt,
    spanDays: pct(spanDays),
    observedCalendarDays,
    spanCoveragePct: pct(Math.min(100, spanDays / WINDOW_DAYS * 100)),
    calendarCoveragePct: pct(Math.min(100, observedCalendarDays / WINDOW_DAYS * 100)),
    observations,
    cards
  };
}

async function queryCoverage(pool, sql, params = []) {
  const result = await pool.query(sql, params);
  return coverageFromRow(result.rows?.[0] || {});
}

export async function getMarketHistory365CoverageV10694({ pool = null, gameYear = "26", force = false } = {}) {
  const key = String(gameYear);
  if (!force && statusCache.value && statusCache.gameYear === key && Date.now() - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }

  if (!pool) return emptyStatus(key, "NO_DATABASE");
  const tables = await availableTables(pool);
  if (!tables.own && !tables.legacy) return emptyStatus(key, "PRICE_HISTORY_NOT_INITIALIZED");

  try {
    const sources = {};

    if (tables.own) {
      sources.ownMarketHistory = await queryCoverage(pool, `
        SELECT
          MIN(observed_at) AS earliest_at,
          MAX(observed_at) AS latest_at,
          COUNT(*)::bigint AS observations,
          COUNT(DISTINCT ea_id)::bigint AS cards,
          COUNT(DISTINCT (observed_at AT TIME ZONE 'UTC')::date)::int AS observed_days
        FROM fc_own_market_price_history
        WHERE game_year = $1
          AND observed_at >= NOW() - INTERVAL '365 days'
      `, [key]);
    }

    // fc_price_history predates the game-year column. The service was FC26 when
    // these rows were accumulated, so this legacy store is admissible for FC26
    // only. It is never carried into FC27 as if it were FC27 evidence.
    if (tables.legacy && key === "26") {
      sources.legacyFc26PriceHistory = await queryCoverage(pool, `
        SELECT
          MIN(recorded_at) AS earliest_at,
          MAX(recorded_at) AS latest_at,
          COUNT(*)::bigint AS observations,
          COUNT(DISTINCT ea_id)::bigint AS cards,
          COUNT(DISTINCT (recorded_at AT TIME ZONE 'UTC')::date)::int AS observed_days
        FROM fc_price_history
        WHERE recorded_at >= NOW() - INTERVAL '365 days'
      `);
    }

    const usable = Object.values(sources).filter(source => Number(source?.observations || 0) > 0);
    if (!usable.length) {
      const value = { ...emptyStatus(key, "NO_HISTORY_ROWS_IN_365_DAY_WINDOW"), sources };
      statusCache = { at: Date.now(), gameYear: key, value };
      return value;
    }

    const earliestAt = usable.map(x => x.earliestAt).filter(Boolean).sort()[0] || null;
    const latestAt = usable.map(x => x.latestAt).filter(Boolean).sort().at(-1) || null;
    const earliestMs = earliestAt ? Date.parse(earliestAt) : NaN;
    const latestMs = latestAt ? Date.parse(latestAt) : NaN;
    const spanDays = Number.isFinite(earliestMs) && Number.isFinite(latestMs)
      ? Math.max(0, (latestMs - earliestMs) / 86_400_000)
      : 0;
    const observedCalendarDays = Math.max(...usable.map(x => Number(x.observedCalendarDays || 0)), 0);
    const observations = usable.reduce((sum, x) => sum + Number(x.observations || 0), 0);
    const cards = Math.max(...usable.map(x => Number(x.cards || 0)), 0);

    const coverage = {
      earliestAt,
      latestAt,
      spanDays: pct(spanDays),
      observedCalendarDays,
      spanCoveragePct: pct(Math.min(100, spanDays / WINDOW_DAYS * 100)),
      calendarCoveragePct: pct(Math.min(100, observedCalendarDays / WINDOW_DAYS * 100)),
      observations,
      cards
    };

    const value = {
      ok: true,
      service: "FC 365-Day Market Learning Coverage",
      version: MARKET_HISTORY_365_VERSION,
      build: BUILD,
      gameYear: key,
      requestedWindowDays: WINDOW_DAYS,
      learningWindowDays: WINDOW_DAYS,
      performanceLabWindowDays: WINDOW_DAYS,
      available: true,
      fullWindowAvailable: spanDays >= 364,
      coverage,
      sources,
      reason: spanDays >= 364 ? "FULL_365_DAY_SPAN_AVAILABLE" : "PARTIAL_HISTORY_ONLY",
      policy: {
        noSyntheticBackfill: true,
        futggPrimary: true,
        olderDataMayInformPriors: true,
        recentDataKeepsHigherWeight: true,
        legacyUngroupedHistoryUsedForFc26Only: true
      }
    };

    statusCache = { at: Date.now(), gameYear: key, value };
    return value;
  } catch (error) {
    return emptyStatus(key, `QUERY_FAILED: ${String(error?.message || error)}`);
  }
}

export async function getCardDailyHistory365V10694({ pool = null, gameYear = "26", eaId, limit = 365 } = {}) {
  if (!pool || !eaId) return [];
  const tables = await availableTables(pool);
  if (!tables.own && !(tables.legacy && String(gameYear) === "26")) return [];

  const bounded = Math.max(1, Math.min(WINDOW_DAYS, Number(limit || WINDOW_DAYS)));
  const unions = [];
  const params = [String(gameYear), String(eaId)];

  if (tables.own) {
    unions.push(`
      SELECT price::integer AS price, observed_at AS at
      FROM fc_own_market_price_history
      WHERE game_year = $1 AND ea_id = $2
        AND observed_at >= NOW() - INTERVAL '365 days'
    `);
  }
  if (tables.legacy && String(gameYear) === "26") {
    unions.push(`
      SELECT price::integer AS price, recorded_at AS at
      FROM fc_price_history
      WHERE ea_id::text = $2
        AND recorded_at >= NOW() - INTERVAL '365 days'
    `);
  }

  const result = await pool.query(`
    WITH combined AS (
      SELECT DISTINCT price, at
      FROM (${unions.join(" UNION ALL ")}) source_rows
    )
    SELECT
      DATE_TRUNC('day', at) AS day,
      (ARRAY_AGG(price ORDER BY at ASC))[1] AS open_price,
      (ARRAY_AGG(price ORDER BY at DESC))[1] AS close_price,
      MIN(price) AS low_price,
      MAX(price) AS high_price,
      ROUND(AVG(price)::numeric, 2) AS avg_price,
      COUNT(*)::int AS observations
    FROM combined
    GROUP BY DATE_TRUNC('day', at)
    ORDER BY day DESC
    LIMIT $3
  `, [...params, bounded]);

  return result.rows.map(row => ({
    day: iso(row.day),
    openPrice: Number(row.open_price),
    closePrice: Number(row.close_price),
    lowPrice: Number(row.low_price),
    highPrice: Number(row.high_price),
    avgPrice: Number(row.avg_price),
    observations: Number(row.observations || 0)
  }));
}

export function createMarketHistory365RouterV10694({ pool = null, gameYear = "26" } = {}) {
  const router = express.Router();

  router.get("/status", async (req, res) => {
    const status = await getMarketHistory365CoverageV10694({ pool, gameYear, force: req.query.force === "1" });
    res.json(status);
  });

  router.get("/cards/:eaId", async (req, res) => {
    const eaId = String(req.params.eaId || "").trim();
    if (!eaId) return res.status(400).json({ ok: false, error: "EA_ID_REQUIRED" });
    try {
      const rows = await getCardDailyHistory365V10694({ pool, gameYear, eaId, limit: req.query.limit });
      res.json({
        ok: true,
        gameYear: String(gameYear),
        eaId,
        windowDays: WINDOW_DAYS,
        granularity: "1d",
        synthetic: false,
        rows
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  return router;
}
