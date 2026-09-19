export const WORLD_MAX_FORECAST_VERSION = "1.0.0";

const state = {
  configured: false,
  enabled: false,
  shadowMode: true,
  productionConfirmed: false,
  mode: "DISABLED",
  calls: 0,
  successes: 0,
  failures: 0,
  rowsForecast: 0,
  evaluations: 0,
  lastCallAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastCycleAt: 0,
  lastPerformanceRefreshAt: 0,
  lastRuntimeConfigRefreshAt: 0,
  runtimeConfig: null,
  runtimeConfigSource: "ENV_ONLY",
  autoPromotionEligible: false,
  autoPromotionReason: "INSUFFICIENT_EVIDENCE",
  performanceProfiles: new Map()
};

const boolEnv = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};
function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function config() {
  const dbCfg = state.runtimeConfig || {};
  const envUrl = String(process.env.WORLD_MAX_ML_WORKER_URL || "").trim();
  const workerUrl = String(envUrl || dbCfg.workerUrl || "").trim().replace(/\/$/, "");
  const envEnabledSet = process.env.WORLD_MAX_ML_ENABLED != null && String(process.env.WORLD_MAX_ML_ENABLED).trim() !== "";
  const enabled = (envEnabledSet ? boolEnv("WORLD_MAX_ML_ENABLED", false) : Boolean(dbCfg.enabled)) && Boolean(workerUrl);
  const envProductionSet = process.env.WORLD_MAX_ML_PRODUCTION_CONFIRMED != null && String(process.env.WORLD_MAX_ML_PRODUCTION_CONFIRMED).trim() !== "";
  const explicitProduction = envProductionSet ? boolEnv("WORLD_MAX_ML_PRODUCTION_CONFIRMED", false) : Boolean(dbCfg.productionConfirmed);
  const productionConfirmed = Boolean(explicitProduction || state.autoPromotionEligible);
  const envShadowSet = process.env.WORLD_MAX_ML_SHADOW != null && String(process.env.WORLD_MAX_ML_SHADOW).trim() !== "";
  const requestedShadow = envShadowSet ? boolEnv("WORLD_MAX_ML_SHADOW", true) : dbCfg.shadowMode !== false;
  const shadowMode = !productionConfirmed || requestedShadow;
  return {
    workerUrl,
    workerToken: String(process.env.WORLD_MAX_ML_WORKER_TOKEN || dbCfg.workerToken || "").trim(),
    enabled,
    productionConfirmed,
    shadowMode,
    configSource: envUrl || envEnabledSet || envProductionSet || envShadowSet ? "ENV" : state.runtimeConfig ? "POSTGRES_RUNTIME_CONFIG" : "NONE",
    timeoutMs: clamp(Number(process.env.WORLD_MAX_ML_TIMEOUT_MS || 8000), 500, 15000),
    maxRows: Math.round(clamp(Number(process.env.WORLD_MAX_ML_MAX_ROWS || 10), 1, 40)),
    minCycleMs: clamp(Number(process.env.WORLD_MAX_ML_MIN_CYCLE_MS || 900000), 60000, 3600000)
  };
}

function regimeFor(row, work) {
  return String(row?.aiAdaptiveV1062?.regime || row?.aiFinalHardening?.marketRegime || work?.input?.marketRegime || "NORMAL").toUpperCase();
}
function requestedModelsFor(cfg) {
  return cfg.productionConfirmed ? ["chronos2"] : ["timesfm3", "chronos2"];
}
function candidateScore(row) {
  let score = 0;
  const action = String(row?.aiAction || "");
  if (action === "JETZT KAUFEN") score += 100;
  else if (action === "NOCH WARTEN" || action === "BEOBACHTEN") score += 55;
  else if (action.includes("VERKAUF")) score += 45;
  if (row?.intensiveWatch === true) score += 40;
  if (row?.aiLeakIntel?.active === true) score += 20;
  score += Math.min(25, Math.abs(Number(row?.change15m || 0)) * 2);
  score += Math.min(20, Math.abs(Number(row?.change1h || 0)));
  score += Math.min(10, Math.max(0, Number(row?.overall || 0) - 82));
  return score;
}

function normalizeObservedSeries(points = []) {
  return (Array.isArray(points) ? points : [])
    .map(point => {
      const rawAt = point?.at || point?.observed_at || point?.observedAt || null;
      const ms = Date.parse(rawAt || "");
      const price = Math.round(Number(point?.price));
      if (!Number.isFinite(ms) || !Number.isFinite(price) || price <= 0) return null;
      return { at: new Date(ms).toISOString(), price };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

async function loadObservedSeries(pool, gameYear, eaIds = []) {
  if (!pool || !eaIds.length) return new Map();
  const result = await pool.query(`
    WITH hourly AS (
      SELECT DISTINCT ON (ea_id, date_trunc('hour', observed_at))
        ea_id::text AS ea_id,
        date_trunc('hour', observed_at) AS observed_at,
        price::int AS price
      FROM fc_own_market_price_history
      WHERE game_year::text = $1
        AND ea_id::text = ANY($2::text[])
        AND observed_at >= NOW() - INTERVAL '90 days'
        AND price > 0
      ORDER BY ea_id, date_trunc('hour', observed_at), observed_at DESC
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY ea_id ORDER BY observed_at DESC) AS rn
      FROM hourly
    )
    SELECT ea_id, observed_at, price
    FROM ranked
    WHERE rn <= 2048
    ORDER BY ea_id, observed_at ASC
  `, [String(gameYear), eaIds.map(String)]);

  const map = new Map();
  for (const row of result.rows || []) {
    const key = String(row.ea_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ at: row.observed_at, price: Number(row.price) });
  }
  return map;
}

function buildForecastInput(row, work, gameYear, observedSeries = []) {
  const input = work?.input || {};
  const publicSignals = input?.marketContext?.publicLeaks || row?.aiLeakIntel || {};
  return {
    gameYear: String(gameYear),
    eaId: String(row?.eaId || ""),
    name: String(row?.name || ""),
    rating: finite(row?.overall),
    cardType: String(row?.cardType || ""),
    currentPrice: finite(row?.price),
    stepMinutes: 60,
    series: normalizeObservedSeries(observedSeries),
    covariates: {
      change1m: finite(row?.change1m),
      change5m: finite(row?.change5m),
      change15m: finite(row?.change15m),
      change1h: finite(row?.change1h),
      change24h: finite(row?.change24h),
      change7d: finite(row?.change7d),
      distanceTo24hLow: finite(row?.distanceTo24hLow),
      ratingRisingPct: finite(input?.ratingMarketRisingPct),
      ratingFallingPct: finite(input?.ratingMarketFallingPct),
      liquidityScore: finite(row?.evidenceLiquidityScore),
      turnover24h: finite(row?.evidenceSalesPerHour24h),
      packSupplyActive: Boolean(input?.marketContext?.packSupplyActive),
      publicSignalActive: Boolean(publicSignals?.active),
      publicSignalImpact: finite(publicSignals?.impactScore),
      publicSignalReaction: Boolean(publicSignals?.marketReaction),
      regime: regimeFor(row, work)
    }
  };
}
function normalizeForecast(raw, currentPrice) {
  const model = String(raw?.model || raw?.modelKey || "").trim();
  const horizonMinutes = Math.round(Number(raw?.horizonMinutes || 0));
  const p50 = finite(raw?.p50 ?? raw?.median ?? raw?.forecast);
  if (!model || !Number.isFinite(horizonMinutes) || horizonMinutes <= 0 || p50 == null || p50 <= 0) return null;

  let p10 = finite(raw?.p10 ?? raw?.q10);
  let p90 = finite(raw?.p90 ?? raw?.q90);
  if (p10 != null && p90 != null && p10 > p90) [p10, p90] = [p90, p10];
  const probabilityUp = finite(raw?.probabilityUp);

  return {
    model,
    horizonMinutes,
    p10: p10 != null && p10 > 0 ? p10 : null,
    p50,
    p90: p90 != null && p90 > 0 ? p90 : null,
    probabilityUp: probabilityUp == null ? null : clamp(probabilityUp, 0, 1),
    currentPrice,
    metadata: raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
  };
}
function perfKey(model, horizonMinutes, regime) {
  return `${String(model).toLowerCase()}|${Number(horizonMinutes)}|${String(regime || "NORMAL").toUpperCase()}`;
}

function performanceWeight(model, horizonMinutes, regime) {
  const p = state.performanceProfiles.get(perfKey(model, horizonMinutes, regime));
  if (!p) return 0.75;

  const sampleTrust = Math.min(1, Number(p.samples || 0) / 80);
  const direction = clamp(Number(p.directionAccuracy || 0.5), 0.35, 0.8);
  const mae = Math.max(0, Number(p.maePct || 12));
  const quality = direction * 0.72 + (1 / (1 + mae / 8)) * 0.28;

  return clamp(0.55 + sampleTrust * (quality - 0.5) * 2.2, 0.25, 1.5);
}
function ensembleForecast(forecasts, regime) {
  if (!forecasts.length) return null;
  const grouped = new Map();

  for (const f of forecasts) {
    if (!grouped.has(f.horizonMinutes)) grouped.set(f.horizonMinutes, []);
    grouped.get(f.horizonMinutes).push(f);
  }

  const horizons = [];
  for (const [horizonMinutes, list] of grouped) {
    let weightSum = 0, p50Sum = 0;
    let p10Sum = 0, p10Weight = 0;
    let p90Sum = 0, p90Weight = 0;
    let upVotes = 0, directionalModels = 0;

    for (const f of list) {
      const w = performanceWeight(f.model, horizonMinutes, regime);
      weightSum += w;
      p50Sum += f.p50 * w;
      if (f.p10 != null) { p10Sum += f.p10 * w; p10Weight += w; }
      if (f.p90 != null) { p90Sum += f.p90 * w; p90Weight += w; }
      if (f.currentPrice > 0) {
        directionalModels += 1;
        if (f.p50 > f.currentPrice) upVotes += 1;
      }
    }

    const p50 = p50Sum / Math.max(weightSum, 0.001);
    const current = list[0]?.currentPrice || null;
    const edgePct = current > 0 ? ((p50 - current) / current) * 100 : null;
    const consensusPct = directionalModels
      ? Math.max(upVotes, directionalModels - upVotes) / directionalModels * 100
      : 50;
    const p10 = p10Weight ? p10Sum / p10Weight : null;
    const p90 = p90Weight ? p90Sum / p90Weight : null;
    const uncertaintyPct = current > 0 && p10 != null && p90 != null
      ? ((p90 - p10) / current) * 100
      : null;
    const quality = Math.round(clamp(
      consensusPct * 0.65 + (uncertaintyPct == null ? 12 : Math.max(0, 35 - uncertaintyPct)) * 0.75,
      0,
      95
    ));

    horizons.push({
      horizonMinutes,
      p10,
      p50,
      p90,
      edgePct,
      consensusPct,
      uncertaintyPct,
      quality,
      models: list.map(x => x.model)
    });
  }

  horizons.sort((a, b) => a.horizonMinutes - b.horizonMinutes);
  return { regime, horizons, models: [...new Set(forecasts.map(x => x.model))] };
}
async function ensureSchema(pool) {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_world_max_forecasts_v1 (
      id BIGSERIAL PRIMARY KEY,
      game_year VARCHAR(2) NOT NULL,
      ea_id TEXT NOT NULL,
      model_key VARCHAR(80) NOT NULL,
      regime VARCHAR(32) NOT NULL,
      horizon_minutes INTEGER NOT NULL,
      current_price INTEGER NOT NULL,
      p10 DOUBLE PRECISION,
      p50 DOUBLE PRECISION NOT NULL,
      p90 DOUBLE PRECISION,
      predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      target_at TIMESTAMPTZ NOT NULL,
      actual_price INTEGER,
      direction_correct BOOLEAN,
      abs_error_pct DOUBLE PRECISION,
      evaluated_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_world_max_eval_v1
    ON fc_world_max_forecasts_v1 (game_year, evaluated_at, target_at)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_world_max_perf_v1
    ON fc_world_max_forecasts_v1 (game_year, model_key, horizon_minutes, regime, evaluated_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_world_max_runtime_config_v1 (
      game_year VARCHAR(2) PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      worker_url TEXT,
      worker_token TEXT,
      shadow_mode BOOLEAN NOT NULL DEFAULT TRUE,
      production_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function refreshRuntimeConfig(pool, gameYear) {
  if (!pool || Date.now() - state.lastRuntimeConfigRefreshAt < 60_000) return;
  try {
    const result = await pool.query(`
      SELECT enabled, worker_url, worker_token, shadow_mode, production_confirmed, updated_at
      FROM fc_world_max_runtime_config_v1
      WHERE game_year = $1
      LIMIT 1
    `, [String(gameYear)]);
    const row = result.rows?.[0] || null;
    state.runtimeConfig = row ? {
      enabled: Boolean(row.enabled),
      workerUrl: String(row.worker_url || "").trim(),
      workerToken: String(row.worker_token || "").trim(),
      shadowMode: row.shadow_mode !== false,
      productionConfirmed: Boolean(row.production_confirmed),
      updatedAt: row.updated_at || null
    } : null;
    state.runtimeConfigSource = row ? "POSTGRES_RUNTIME_CONFIG" : "ENV_ONLY";
    state.lastRuntimeConfigRefreshAt = Date.now();
  } catch (error) {
    state.lastError = `runtime-config: ${String(error?.message || error)}`;
  }
}

function refreshAutoPromotionEligibility() {
  const profiles = [...state.performanceProfiles.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .filter(row => row.key.startsWith("chronos2|") && Number(row.samples || 0) >= 40);
  const critical = profiles.filter(row => row.key.includes("|360|") || row.key.includes("|1440|"));
  const totalSamples = critical.reduce((sum, row) => sum + Number(row.samples || 0), 0);
  if (critical.length < 2 || totalSamples < 200) {
    state.autoPromotionEligible = false;
    state.autoPromotionReason = "INSUFFICIENT_EVIDENCE";
    return;
  }
  const weightedDirection = critical.reduce((sum, row) => sum + Number(row.directionAccuracy || 0) * Number(row.samples || 0), 0) / Math.max(1, totalSamples);
  const weightedMae = critical.reduce((sum, row) => sum + Number(row.maePct || 0) * Number(row.samples || 0), 0) / Math.max(1, totalSamples);
  state.autoPromotionEligible = weightedDirection >= 0.58 && weightedMae <= 8;
  state.autoPromotionReason = state.autoPromotionEligible
    ? `AUTO_GATED_${Math.round(weightedDirection * 100)}PCT_DIR_${weightedMae.toFixed(2)}PCT_MAE`
    : `QUALITY_GATE_NOT_MET_${Math.round(weightedDirection * 100)}PCT_DIR_${weightedMae.toFixed(2)}PCT_MAE`;
}

async function evaluateMatured(pool, gameYear) {
  if (!pool) return 0;
  try {
    const result = await pool.query(`
      WITH candidates AS (
        SELECT f.id, f.current_price, f.p50,
          (SELECT h.price::int
             FROM fc_own_market_price_history h
            WHERE h.game_year::text = f.game_year::text
              AND h.ea_id::text = f.ea_id
              AND h.observed_at >= f.target_at
              AND h.observed_at <= f.target_at + INTERVAL '2 hours'
            ORDER BY h.observed_at ASC LIMIT 1) AS actual_price
        FROM fc_world_max_forecasts_v1 f
        WHERE f.game_year = $1
          AND f.actual_price IS NULL
          AND f.target_at <= NOW()
        ORDER BY f.target_at ASC
        LIMIT 500
      )
      UPDATE fc_world_max_forecasts_v1 f
         SET actual_price = c.actual_price,
             direction_correct = CASE
               WHEN c.actual_price IS NULL THEN NULL
               ELSE ((f.p50 - f.current_price) * (c.actual_price - f.current_price) >= 0)
             END,
             abs_error_pct = CASE
               WHEN c.actual_price IS NULL OR f.current_price <= 0 THEN NULL
               ELSE ABS(c.actual_price - f.p50) / f.current_price * 100
             END,
             evaluated_at = CASE WHEN c.actual_price IS NULL THEN NULL ELSE NOW() END
        FROM candidates c
       WHERE f.id = c.id
         AND c.actual_price IS NOT NULL
      RETURNING f.id
    `, [String(gameYear)]);

    const count = result.rowCount || 0;
    state.evaluations += count;
    return count;
  } catch (error) {
    state.lastError = `evaluation: ${String(error?.message || error)}`;
    return 0;
  }
}

async function refreshPerformance(pool, gameYear) {
  if (!pool || Date.now() - state.lastPerformanceRefreshAt < 10 * 60_000) return;
  try {
    const result = await pool.query(`
      SELECT model_key, horizon_minutes, regime,
             COUNT(*)::int AS samples,
             AVG(CASE WHEN direction_correct THEN 1.0 ELSE 0.0 END) AS direction_accuracy,
             AVG(abs_error_pct) AS mae_pct
        FROM fc_world_max_forecasts_v1
       WHERE game_year = $1
         AND evaluated_at >= NOW() - INTERVAL '180 days'
       GROUP BY model_key, horizon_minutes, regime
    `, [String(gameYear)]);

    const next = new Map();
    for (const row of result.rows || []) {
      next.set(perfKey(row.model_key, row.horizon_minutes, row.regime), {
        samples: Number(row.samples || 0),
        directionAccuracy: Number(row.direction_accuracy || 0.5),
        maePct: Number(row.mae_pct || 0)
      });
    }

    state.performanceProfiles = next;
    refreshAutoPromotionEligibility();
    state.lastPerformanceRefreshAt = Date.now();
  } catch (error) {
    state.lastError = `performance: ${String(error?.message || error)}`;
  }
}

async function persistForecasts(pool, gameYear, row, regime, forecasts) {
  if (!pool || !forecasts.length) return;
  for (const f of forecasts) {
    await pool.query(`
      INSERT INTO fc_world_max_forecasts_v1
        (game_year, ea_id, model_key, regime, horizon_minutes, current_price, p10, p50, p90, target_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW() + ($5::int * INTERVAL '1 minute'))
    `, [
      String(gameYear),
      String(row.eaId),
      String(f.model).slice(0, 80),
      String(regime).slice(0, 32),
      f.horizonMinutes,
      Math.round(Number(row.price)),
      f.p10,
      f.p50,
      f.p90
    ]);
  }
}
async function callWorker(workerUrl, timeoutMs, payload, workerToken = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const headers = { "content-type": "application/json" };
    const token = String(workerToken || "").trim();
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${workerUrl}/v1/forecast/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
export async function enrichRowsWithWorldMaxForecast({
  rows = [],
  brainWork = null,
  pool = null,
  gameYear = "27"
} = {}) {
  if (pool) {
    await ensureSchema(pool).catch(error => {
      state.lastError = `schema: ${String(error?.message || error)}`;
    });
    await refreshRuntimeConfig(pool, gameYear);
    await evaluateMatured(pool, gameYear);
    await refreshPerformance(pool, gameYear);
  }

  const cfg = config();
  state.configured = Boolean(cfg.workerUrl);
  state.enabled = cfg.enabled;
  state.shadowMode = cfg.shadowMode;
  state.productionConfirmed = cfg.productionConfirmed;
  state.runtimeConfigSource = cfg.configSource;
  state.mode = !cfg.enabled ? "DISABLED" : cfg.shadowMode ? "SHADOW" : "PRODUCTION_GUARDED";

  if (!cfg.enabled || !Array.isArray(rows) || !rows.length) {
    return { ok: true, skipped: true, reason: "NOT_ENABLED" };
  }
  if (Date.now() - state.lastCycleAt < cfg.minCycleMs) {
    return { ok: true, skipped: true, reason: "CYCLE_THROTTLED" };
  }
  state.lastCycleAt = Date.now();

  const selected = [...rows]
    .filter(row => Number(row?.price) > 0 && /^\d+$/.test(String(row?.eaId || "")))
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, cfg.maxRows);

  if (!selected.length) {
    return { ok: true, skipped: true, reason: "NO_CANDIDATES" };
  }

  if (!pool) {
    return { ok: true, skipped: true, reason: "REAL_HISTORY_DATABASE_REQUIRED" };
  }
  const observedSeries = await loadObservedSeries(pool, gameYear, selected.map(row => String(row.eaId))).catch(error => {
    state.lastError = `history: ${String(error?.message || error)}`;
    return new Map();
  });
  const forecastable = selected.filter(row => (observedSeries.get(String(row.eaId)) || []).length >= 32);
  if (!forecastable.length) {
    return { ok: true, skipped: true, reason: "INSUFFICIENT_REAL_HISTORY" };
  }

  const items = forecastable.map(row =>
    buildForecastInput(
      row,
      brainWork?.get?.(String(row.eaId)),
      gameYear,
      observedSeries.get(String(row.eaId)) || []
    )
  );
  state.calls += 1;
  state.lastCallAt = new Date().toISOString();

  try {
    const body = await callWorker(cfg.workerUrl, cfg.timeoutMs, {
      version: WORLD_MAX_FORECAST_VERSION,
      gameYear: String(gameYear),
      requestedModels: requestedModelsFor(cfg),
      horizonsMinutes: [60, 360, 1440, 10080],
      quantiles: [0.1, 0.5, 0.9],
      items
    }, cfg.workerToken);

    const byEaId = new Map(
      (Array.isArray(body?.items) ? body.items : [])
        .map(item => [String(item?.eaId || ""), item])
    );

    for (const row of forecastable) {
      const item = byEaId.get(String(row.eaId));
      const forecasts = (Array.isArray(item?.forecasts) ? item.forecasts : [])
        .map(raw => normalizeForecast(raw, Number(row.price)))
        .filter(Boolean);

      if (!forecasts.length) continue;

      const work = brainWork?.get?.(String(row.eaId));
      const regime = regimeFor(row, work);
      const ensemble = ensembleForecast(forecasts, regime);

      row.aiWorldMaxForecast = {
        version: WORLD_MAX_FORECAST_VERSION,
        mode: state.mode,
        shadow: cfg.shadowMode,
        productionConfirmed: cfg.productionConfirmed,
        ensemble,
        modelForecasts: forecasts.map(f => ({
          model: f.model,
          horizonMinutes: f.horizonMinutes,
          p10: f.p10,
          p50: f.p50,
          p90: f.p90,
          probabilityUp: f.probabilityUp
        })),
        advisoryOnly: true,
        synthetic: false,
        generatedAt: new Date().toISOString()
      };

      state.rowsForecast += 1;
      await persistForecasts(pool, gameYear, row, regime, forecasts).catch(error => {
        state.lastError = `persist: ${String(error?.message || error)}`;
      });
    }

    state.successes += 1;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return { ok: true, selected: forecastable.length };
  } catch (error) {
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = String(error?.message || error);
    return { ok: false, error: state.lastError };
  }
}
export function applyWorldMaxDecisionLayer(row) {
  const forecast = row?.aiWorldMaxForecast;
  if (!forecast?.ensemble?.horizons?.length) return row;
  if (forecast.shadow || !forecast.productionConfirmed) return row;

  const horizon =
    forecast.ensemble.horizons.find(x => x.horizonMinutes === 360) ||
    forecast.ensemble.horizons.find(x => x.horizonMinutes === 1440) ||
    forecast.ensemble.horizons[0];

  if (!horizon || Number(horizon.quality || 0) < 65) return row;

  const action = String(row.aiAction || "");
  const edge = Number(horizon.edgePct || 0);
  if (action === "JETZT KAUFEN" && edge <= -1.25) {
    row.aiAction = "NOCH WARTEN";
    row.aiConfidence = Math.min(Number(row.aiConfidence || 70), 72);
    row.aiReason = (
      String(row.aiReason || "") +
      " World-Max Ensemble widerspricht dem Einstieg; sicherer Veto."
    ).slice(0, 1800);
  } else if (action === "JETZT KAUFEN" && edge >= 1.25) {
    row.aiConfidence = Math.min(
      95,
      Number(row.aiConfidence || 0) +
        Math.min(4, Math.round(Number(horizon.quality || 0) / 25))
    );
  }

  row.aiWorldMaxDecision = {
    mode: state.mode,
    horizonMinutes: horizon.horizonMinutes,
    edgePct: Number(edge.toFixed(2)),
    quality: Number(horizon.quality || 0),
    advisoryOnly: true
  };
  return row;
}
export function getWorldMaxForecastStatus() {
  const cfg = config();
  return {
    version: WORLD_MAX_FORECAST_VERSION,
    configured: Boolean(cfg.workerUrl),
    enabled: cfg.enabled,
    mode: !cfg.enabled ? "DISABLED" : cfg.shadowMode ? "SHADOW" : "PRODUCTION_GUARDED",
    shadowMode: cfg.shadowMode,
    productionConfirmed: cfg.productionConfirmed,
    configSource: cfg.configSource,
    runtimeConfigUpdatedAt: state.runtimeConfig?.updatedAt || null,
    autoPromotionEligible: state.autoPromotionEligible,
    autoPromotionReason: state.autoPromotionReason,
    requestedModels: requestedModelsFor(cfg),
    timesfm3ResearchShadowOnly: true,
    localSpecialistOutsideWorker: true,
    horizonsMinutes: [60, 360, 1440, 10080],
    quantiles: [0.1, 0.5, 0.9],
    calls: state.calls,
    successes: state.successes,
    failures: state.failures,
    rowsForecast: state.rowsForecast,
    evaluations: state.evaluations,
    performanceProfiles: state.performanceProfiles.size,
    lastCallAt: state.lastCallAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
    policy: {
      advisoryModelsOnly: true,
      shadowBeforePromotion: true,
      performanceWeightedEnsemble: true,
      regimeSpecificCalibration: true,
      probabilisticQuantiles: true,
      automaticMaturedOutcomeEvaluation: true,
      automaticShadowToProductionGate: true,
      postgresRuntimeConfigFallback: true,
      fcYearsSeparated: true,
      realObservedOutcomesOnly: true,
      noSyntheticPrices: true
    }
  };
}

export const __test = {
  normalizeForecast,
  ensembleForecast,
  buildForecastInput,
  candidateScore,
  performanceWeight
};
