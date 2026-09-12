import { Buffer } from "node:buffer";
import { patchTraderBrainV106996 } from "./v106996Loader.mjs";
import { patchPermanentMlV1069961 } from "./v1069961Loader.mjs";
import { __test as v1069964Test } from "./v1069964Loader.mjs";

export const V1069965_BOOTSTRAP_VERSION = "10.69.9.6.5-historical-archive-730";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function requiredReplace(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

function replaceFunctionBlock(source, startAnchor, nextAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`[v10.69.9.6.5] ${label} start anchor missing`);
  const end = source.indexOf(nextAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`[v10.69.9.6.5] ${label} end anchor missing`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

export function patchTwoYearArchiveV1069965(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5 historical archive reader")) return out;

  out = out.replace(
    'export const TWO_YEAR_AI_CONTEXT_VERSION = "10.69.9.6";',
    'export const TWO_YEAR_AI_CONTEXT_VERSION = "10.69.9.6.5";'
  );

  const yearAnchor = 'const SOURCE_GAME_YEARS = ["25", "26"];';
  out = requiredReplace(
    out,
    yearAnchor,
    `${yearAnchor}\n// v10.69.9.6.5 historical archive reader. The main Trader Brain is console/PS5,\n// so archived history defaults to the matching console series. The value is\n// allow-listed before it is ever embedded in SQL.\nconst ARCHIVE_PLATFORM_RAW = String(process.env.HISTORICAL_ARCHIVE_PLATFORM || "console").trim().toLowerCase();\nconst HISTORICAL_ARCHIVE_PLATFORM = ["console", "pc", "xbox"].includes(ARCHIVE_PLATFORM_RAW)\n  ? ARCHIVE_PLATFORM_RAW\n  : "console";`,
    "two-year archive platform"
  );

  const availableTables = String.raw`async function availableTables(pool) {
  if (!pool) return { archive: false, own: false, legacy: false };
  if (tableCache.value && Date.now() - tableCache.at < CACHE_MS) return tableCache.value;
  const result = await pool.query(` + "`" + String.raw`
    SELECT
      to_regclass('public.fc_historical_price_archive') AS archive_table,
      to_regclass('public.fc_own_market_price_history') AS own_table,
      to_regclass('public.fc_price_history') AS legacy_table
  ` + "`" + String.raw`);
  const value = {
    archive: Boolean(result.rows?.[0]?.archive_table),
    own: Boolean(result.rows?.[0]?.own_table),
    legacy: Boolean(result.rows?.[0]?.legacy_table)
  };
  tableCache = { at: Date.now(), value };
  return value;
}`;
  out = replaceFunctionBlock(
    out,
    "async function availableTables(pool) {",
    "function coverageFromRow(row = {}) {",
    availableTables,
    "availableTables"
  );

  const globalCoverage = String.raw`async function globalCoverage(pool, activeGameYear) {
  const activeYear = String(activeGameYear || "26");
  if (coverageCache.value && coverageCache.activeGameYear === activeYear && Date.now() - coverageCache.at < CACHE_MS) {
    return coverageCache.value;
  }
  const tables = await availableTables(pool);
  const byGameYear = {};
  const sourceParts = [];

  for (const year of SOURCE_GAME_YEARS) {
    const yearParts = [];
    if (tables.archive) {
      yearParts.push(` + "`" + String.raw`SELECT recorded_at AS at, ea_id::text AS ea_id FROM fc_historical_price_archive
        WHERE game_year = \${Number(year)} AND platform = '\${HISTORICAL_ARCHIVE_PLATFORM}'
          AND price > 0
          AND recorded_at >= NOW() - INTERVAL '730 days'
          AND recorded_at <= NOW() + INTERVAL '1 day'` + "`" + String.raw`);
    }
    if (tables.own) {
      yearParts.push(` + "`" + String.raw`SELECT observed_at AS at, ea_id::text AS ea_id FROM fc_own_market_price_history
        WHERE game_year = '\${year}' AND price > 0 AND observed_at >= NOW() - INTERVAL '730 days'` + "`" + String.raw`);
    }
    // Legacy history has no game_year and is admitted only as FC26 evidence
    // while FC26 is the active runtime. This prevents later FC27 contamination.
    if (tables.legacy && year === "26" && activeYear === "26") {
      yearParts.push(` + "`" + String.raw`SELECT recorded_at AS at, ea_id::text AS ea_id FROM fc_price_history
        WHERE price > 0 AND recorded_at >= NOW() - INTERVAL '730 days'` + "`" + String.raw`);
    }
    if (!yearParts.length) {
      byGameYear[year] = coverageFromRow({});
      continue;
    }
    const result = await pool.query(` + "`" + String.raw`
      WITH source AS (\${yearParts.join(" UNION ")})
      SELECT MIN(at) AS earliest_at, MAX(at) AS latest_at,
             COUNT(*)::bigint AS observations,
             COUNT(DISTINCT ea_id)::bigint AS cards,
             COUNT(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS observed_days
      FROM source
    ` + "`" + String.raw`);
    byGameYear[year] = coverageFromRow(result.rows?.[0] || {});
    sourceParts.push(...yearParts);
  }

  let combined = coverageFromRow({});
  if (sourceParts.length) {
    const result = await pool.query(` + "`" + String.raw`
      WITH source AS (\${sourceParts.join(" UNION ")})
      SELECT MIN(at) AS earliest_at, MAX(at) AS latest_at,
             COUNT(*)::bigint AS observations,
             COUNT(DISTINCT ea_id)::bigint AS cards,
             COUNT(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS observed_days
      FROM source
    ` + "`" + String.raw`);
    combined = coverageFromRow(result.rows?.[0] || {});
  }

  const full24MonthWindowAvailable = combined.spanDays >= 729 && combined.observedCalendarDays >= 700;
  const value = {
    requestedWindowDays: WINDOW_DAYS,
    targetMonths: TARGET_MONTHS,
    sourceGameYears: [...SOURCE_GAME_YEARS],
    archiveTablePresent: Boolean(tables.archive),
    archivePlatform: HISTORICAL_ARCHIVE_PLATFORM,
    byGameYear,
    combined,
    full24MonthWindowAvailable,
    rawPricesMergedAcrossGameYears: false,
    synthetic: false
  };
  coverageCache = { at: Date.now(), activeGameYear: activeYear, value };
  return value;
}`;
  out = replaceFunctionBlock(
    out,
    "async function globalCoverage(pool, activeGameYear) {",
    "async function cardDailyRows(pool, activeGameYear, eaId) {",
    globalCoverage,
    "globalCoverage"
  );

  const cardDailyRows = String.raw`async function cardDailyRows(pool, activeGameYear, eaId) {
  const activeYear = String(activeGameYear || "26");
  const tables = await availableTables(pool);
  const parts = [];
  const params = [String(eaId)];

  if (tables.archive) {
    parts.push(` + "`" + String.raw`SELECT game_year::text AS game_year, price::int AS price, recorded_at AS at
      FROM fc_historical_price_archive
      WHERE game_year IN (25,26)
        AND platform = '\${HISTORICAL_ARCHIVE_PLATFORM}'
        AND ea_id::text = $1
        AND price > 0
        AND recorded_at >= NOW() - INTERVAL '730 days'
        AND recorded_at <= NOW() + INTERVAL '1 day'` + "`" + String.raw`);
  }
  if (tables.own) {
    parts.push(` + "`" + String.raw`SELECT game_year::text AS game_year, price::int AS price, observed_at AS at
      FROM fc_own_market_price_history
      WHERE game_year IN ('25','26') AND ea_id::text = $1
        AND price > 0 AND observed_at >= NOW() - INTERVAL '730 days'` + "`" + String.raw`);
  }
  if (tables.legacy && activeYear === "26") {
    parts.push(` + "`" + String.raw`SELECT '26'::text AS game_year, price::int AS price, recorded_at AS at
      FROM fc_price_history
      WHERE ea_id::text = $1 AND price > 0 AND recorded_at >= NOW() - INTERVAL '730 days'` + "`" + String.raw`);
  }
  if (!parts.length) return [];

  const result = await pool.query(` + "`" + String.raw`
    WITH combined AS (
      SELECT DISTINCT game_year, price, at FROM (\${parts.join(" UNION ")}) raw
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
  ` + "`" + String.raw`, params);

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
}`;
  out = replaceFunctionBlock(
    out,
    "async function cardDailyRows(pool, activeGameYear, eaId) {",
    "function periodStats(rows, days, currentPrice = null, useCurrent = false) {",
    cardDailyRows,
    "cardDailyRows"
  );

  // Each game year gets its own d730 aggregate. A season reset is never treated
  // as a continuous absolute price curve.
  const d365Anchor = "      d365: periodStats(yearRows, 365, currentPrice, useCurrent)";
  out = requiredReplace(
    out,
    d365Anchor,
    `${d365Anchor},\n      d730: periodStats(yearRows, 730, currentPrice, useCurrent)`,
    "year d730 period"
  );

  const emptyPeriodsAnchor = "    byGameYear: {},\n    monthly: [],";
  out = requiredReplace(
    out,
    emptyPeriodsAnchor,
    `    byGameYear: {},\n    periods: {\n      d730: { requestedDays: 730, observedDays: 0, byGameYear: {}, rawPricesMergedAcrossGameYears: false, synthetic: false }\n    },\n    monthly: [],`,
    "empty d730 context"
  );

  const availableAnchor = "    const available = cardObservedDays > 0;\n    const value = {";
  out = requiredReplace(
    out,
    availableAnchor,
    `    const available = cardObservedDays > 0;\n    const d730ByGameYear = Object.fromEntries(SOURCE_GAME_YEARS.map(year => [year, byGameYear[year]?.periods?.d730 || null]));\n    const d730 = {\n      requestedDays: WINDOW_DAYS,\n      observedDays: cardObservedDays,\n      gameYearsFound: [...cardGameYearsFound],\n      byGameYear: d730ByGameYear,\n      crossSeasonAbsoluteChangePct: null,\n      rawPricesMergedAcrossGameYears: false,\n      synthetic: false\n    };\n    const value = {`,
    "combined d730 context"
  );

  const valueCoverageAnchor = "      globalCoverage: coverage,\n      cardGameYearsFound,";
  out = requiredReplace(
    out,
    valueCoverageAnchor,
    `      globalCoverage: coverage,\n      archiveTableAware: true,\n      archivePlatform: HISTORICAL_ARCHIVE_PLATFORM,\n      periods: { d730 },\n      cardGameYearsFound,`,
    "value archive diagnostics"
  );

  const lastFeedAnchor = "  synthetic: false,\n  loadedAt: null,";
  out = requiredReplace(
    out,
    lastFeedAnchor,
    `  synthetic: false,\n  archiveTableAware: true,\n  archivePlatform: HISTORICAL_ARCHIVE_PLATFORM,\n  loadedAt: null,`,
    "feed archive diagnostics"
  );

  if (!out.includes("fc_historical_price_archive") || !out.includes("d730: periodStats")) {
    throw new Error("[v10.69.9.6.5] two-year archive patch incomplete");
  }
  return out;
}

function historicalTableInfoReplacement() {
  return String.raw`async function historicalTableInfo(pool) {
  const result = await pool.query(` + "`" + String.raw`
    SELECT
      to_regclass('public.fc_historical_price_archive') AS archive_table,
      to_regclass('public.fc_own_market_price_history') AS own_table,
      to_regclass('public.fc_price_history') AS legacy_table
  ` + "`" + String.raw`);
  return {
    archive: Boolean(result.rows?.[0]?.archive_table),
    own: Boolean(result.rows?.[0]?.own_table),
    legacy: Boolean(result.rows?.[0]?.legacy_table)
  };
}`;
}

function timeAwareCycleSamplesReplacement() {
  return String.raw`function historicalCycleSamples(rows) {
  // v10.69.9.6.5 time-aware historical labels. Wayback history can be daily or
  // irregular, so array-index steps must never masquerade as fixed 6h horizons.
  const byCard = new Map();
  for (const row of rows || []) {
    const key = String(row.ea_id);
    if (!byCard.has(key)) byCard.set(key, []);
    const at = iso(row.bucket_at);
    const price = Number(row.price);
    if (!at || !Number.isFinite(price) || price <= 0) continue;
    byCard.get(key).push({ at, ms: Date.parse(at), price });
  }

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const priorTolerance = { h24: 36 * HOUR, d7: 48 * HOUR, d30: 5 * DAY };
  const futureTolerance = { h24: 36 * HOUR, d7: 48 * HOUR };

  function atOrBefore(series, targetMs, toleranceMs) {
    let lo = 0, hi = series.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].ms <= targetMs) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (best < 0) return null;
    const item = series[best];
    return targetMs - item.ms <= toleranceMs ? item : null;
  }

  function atOrAfter(series, targetMs, toleranceMs) {
    let lo = 0, hi = series.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].ms >= targetMs) { best = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    if (best < 0) return null;
    const item = series[best];
    return item.ms - targetMs <= toleranceMs ? item : null;
  }

  function lowerBound(series, targetMs) {
    let lo = 0, hi = series.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].ms < targetMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const samples24h = [];
  const samples7d = [];
  for (const seriesRaw of byCard.values()) {
    const series = seriesRaw.sort((a, b) => a.ms - b.ms);
    for (let i = 0; i < series.length; i++) {
      const point = series[i];
      const cur = point.price;
      const p24 = atOrBefore(series, point.ms - DAY, priorTolerance.h24)?.price ?? null;
      const p7 = atOrBefore(series, point.ms - 7 * DAY, priorTolerance.d7)?.price ?? null;
      const p30 = atOrBefore(series, point.ms - 30 * DAY, priorTolerance.d30)?.price ?? null;
      if (p7 == null) continue;

      const lookbackStart = lowerBound(series, point.ms - DAY);
      const lookback24 = series
        .slice(lookbackStart, i + 1)
        .map(x => x.price)
        .filter(Number.isFinite);
      const low24 = lookback24.length ? Math.min(...lookback24) : cur;
      const high24 = lookback24.length ? Math.max(...lookback24) : cur;
      const distLow = low24 > 0 ? ((cur - low24) / low24) * 100 : 0;
      const distHigh = high24 > 0 ? ((high24 - cur) / high24) * 100 : 0;
      const raw = [
        pctChange(p24, cur) ?? 0,
        pctChange(p7, cur) ?? 0,
        pctChange(p30, cur) ?? 0,
        distLow,
        distHigh
      ];
      const x = raw.map((v, idx) => clamp(v / CYCLE_FEATURE_SCALES[idx], -3, 3));

      const future24 = atOrAfter(series, point.ms + DAY, futureTolerance.h24)?.price ?? null;
      const roi24 = netRoi(cur, future24);
      if (roi24 != null) samples24h.push({ x, y: roi24 > 0, at: point.at });

      const future7 = atOrAfter(series, point.ms + 7 * DAY, futureTolerance.d7)?.price ?? null;
      const roi7 = netRoi(cur, future7);
      if (roi7 != null) samples7d.push({ x, y: roi7 > 0, at: point.at });
    }
  }
  return { samples24h, samples7d };
}`;
}

export function patchPermanentMlArchiveV1069965(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5 time-aware historical labels")) return out;

  out = out.replace(
    'export const PERMANENT_ML_VERSION = "10.69.9.6";',
    'export const PERMANENT_ML_VERSION = "10.69.9.6.5";'
  );

  const windowAnchor = "const LEARNING_WINDOW_DAYS = 730;";
  out = requiredReplace(
    out,
    windowAnchor,
    `${windowAnchor}\nconst ARCHIVE_PLATFORM_RAW = String(process.env.HISTORICAL_ARCHIVE_PLATFORM || "console").trim().toLowerCase();\nconst HISTORICAL_ARCHIVE_PLATFORM = ["console", "pc", "xbox"].includes(ARCHIVE_PLATFORM_RAW)\n  ? ARCHIVE_PLATFORM_RAW\n  : "console";`,
    "ML archive platform"
  );

  out = replaceFunctionBlock(
    out,
    "async function historicalTableInfo(pool) {",
    "async function historicalCoverageForYear(pool, gameYear) {",
    historicalTableInfoReplacement(),
    "ML historicalTableInfo"
  );

  const coverageAnchor = "  const params = [year];\n  if (tables.own) {";
  out = requiredReplace(
    out,
    coverageAnchor,
    `  const params = [year];\n  if (tables.archive) {\n    sources.push(\`SELECT recorded_at AS at, ea_id::text AS ea_id FROM fc_historical_price_archive\n      WHERE game_year = $1::smallint AND platform = '\${HISTORICAL_ARCHIVE_PLATFORM}'\n        AND price > 0\n        AND recorded_at >= NOW() - INTERVAL '730 days'\n        AND recorded_at <= NOW() + INTERVAL '1 day'\`);\n  }\n  if (tables.own) {`,
    "ML archive coverage source"
  );

  const cycleAnchor = "  const sourceYear = String(gameYear);\n  let sourceSql = null;\n  const sources = [];\n  if (tables.own) {";
  out = requiredReplace(
    out,
    cycleAnchor,
    `  const sourceYear = String(gameYear);\n  let sourceSql = null;\n  const sources = [];\n  if (tables.archive) {\n    sources.push(\`SELECT ea_id::text AS ea_id, price::int AS price, recorded_at AS at\n      FROM fc_historical_price_archive\n      WHERE game_year = $1::smallint AND platform = '\${HISTORICAL_ARCHIVE_PLATFORM}'\n        AND price > 0\n        AND recorded_at >= NOW() - INTERVAL '730 days'\n        AND recorded_at <= NOW() + INTERVAL '1 day'\`);\n  }\n  if (tables.own) {`,
    "ML archive cycle source"
  );

  out = out.replace('sourceSql = sources.join(" UNION ALL ");', 'sourceSql = sources.join(" UNION ");');

  out = replaceFunctionBlock(
    out,
    "function historicalCycleSamples(rows) {",
    "async function trainHistoricalCycleModels(pool, gameYear) {",
    timeAwareCycleSamplesReplacement(),
    "time-aware cycle samples"
  );

  const initialStatusAnchor = "  full24MonthWindowAvailable: false,\n  lastTrainStartedAt: null,";
  out = requiredReplace(
    out,
    initialStatusAnchor,
    `  full24MonthWindowAvailable: false,\n  archiveTableAware: true,\n  archivePlatform: HISTORICAL_ARCHIVE_PLATFORM,\n  realObservedDataOnly: true,\n  lastTrainStartedAt: null,`,
    "ML archive status"
  );

  if (!out.includes("fc_historical_price_archive") || !out.includes("time-aware historical labels")) {
    throw new Error("[v10.69.9.6.5] Permanent ML archive patch incomplete");
  }
  return out;
}

export function patchTraderBrainV1069965(source) {
  let out = patchTraderBrainV106996(String(source || ""));
  if (out.includes("730d Saisonkontext getrennt")) return out;

  const coverageLine = '        "Globale reale Abdeckung: " + Number(twoYearHistory.globalCoverage?.combined?.observedCalendarDays || 0) + " Kalendertage, Spanne " + Number(twoYearHistory.globalCoverage?.combined?.spanDays || 0).toFixed(1) + " Tage, full24MonthWindowAvailable=" + (twoYearHistory.full24MonthWindowAvailable === true),';
  if (out.includes(coverageLine)) {
    out = out.replace(
      coverageLine,
      `${coverageLine}\n        "730d Saisonkontext getrennt: FC25 " + Number(twoYearHistory.periods?.d730?.byGameYear?.["25"]?.observedDays || 0) + " Tage / FC26 " + Number(twoYearHistory.periods?.d730?.byGameYear?.["26"]?.observedDays || 0) + " Tage; Cross-Season-Preisänderung: DEAKTIVIERT",`
    );
  }
  return out;
}

export function patchServerV1069965(source) {
  let out = v1069964Test.patchServerV1069964(String(source || ""));
  out = out.replaceAll("10.69.9.6.4", "10.69.9.6.5");

  const healthAnchor = "    twoYearAiFeed: getTwoYearAiFeedStatusV106996(),";
  if (!out.includes("historicalArchiveReader:")) {
    out = requiredReplace(
      out,
      healthAnchor,
      `    historicalArchiveReader: {\n      version: "10.69.9.6.5",\n      configured: true,\n      table: "fc_historical_price_archive",\n      platform: String(process.env.HISTORICAL_ARCHIVE_PLATFORM || "console"),\n      sourceGameYears: ["25", "26"],\n      requestedWindowDays: 730,\n      rawPricesMergedAcrossGameYears: false,\n      synthetic: false\n    },\n${healthAnchor}`,
      "server archive health"
    );
  }

  if (!out.includes("10.69.9.6.5-final") || !out.includes("historicalArchiveReader:")) {
    throw new Error("[v10.69.9.6.5] server archive diagnostics patch incomplete");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/server.js")) {
    try {
      const source = patchServerV1069965(raw);
      console.log("[v10.69.9.6.5] server + 730d archive reader ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.5] server patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/traderBrain.js")) {
    try {
      const source = patchTraderBrainV1069965(raw);
      console.log("[v10.69.9.6.5] Gemini 730d separated-season context ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.5] traderBrain patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/twoYearAiContextV106996.js")) {
    try {
      const source = patchTwoYearArchiveV1069965(raw);
      console.log("[v10.69.9.6.5] fc_historical_price_archive reader ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.5] two-year archive patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      let source = patchPermanentMlV1069961(raw);
      source = patchPermanentMlArchiveV1069965(source);
      console.log("[v10.69.9.6.5] Permanent ML archive + time-aware cycles ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.5] Permanent ML archive patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  return result;
}

export const __test = {
  sourceText,
  patchServerV1069965,
  patchTraderBrainV1069965,
  patchTwoYearArchiveV1069965,
  patchPermanentMlArchiveV1069965,
  replaceFunctionBlock
};
