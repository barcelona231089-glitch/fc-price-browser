export const PERMANENT_ML_VERSION = "10.69.9.6";
const PRIMARY_HISTORY_YEAR = "26";
const HISTORICAL_SOURCE_YEARS = ["25", "26"];
const LEARNING_WINDOW_DAYS = 730;
const FEATURE_VERSION = "v1-market+leaks+traders";
const CYCLE_FEATURE_VERSION = "v1-price-cycles";
const RETRAIN_MS = Math.max(60, Number(process.env.PERMANENT_ML_RETRAIN_MIN || 360)) * 60_000;
const START_DELAY_MS = Math.max(5, Number(process.env.PERMANENT_ML_START_DELAY_SEC || 45)) * 1000;
const MAX_DECISION_SAMPLES = Math.max(200, Math.min(25_000, Number(process.env.PERMANENT_ML_MAX_DECISION_SAMPLES || 10000)));
const CYCLE_TOP_CARDS = Math.max(20, Math.min(250, Number(process.env.PERMANENT_ML_CYCLE_TOP_CARDS || 100)));
const MIN_TRAIN_SAMPLES = Math.max(30, Number(process.env.PERMANENT_ML_MIN_TRAIN_SAMPLES || 60));
const MIN_VALIDATION_SAMPLES = Math.max(10, Number(process.env.PERMANENT_ML_MIN_VALIDATION_SAMPLES || 20));
const MIN_TRUST_BALANCED_ACCURACY = Math.max(0.50, Math.min(0.75, Number(process.env.PERMANENT_ML_MIN_BALANCED_ACCURACY || 0.54)));
const DECISION_EPOCHS = Math.max(3, Math.min(40, Number(process.env.PERMANENT_ML_DECISION_EPOCHS || 12)));
const CYCLE_EPOCHS = Math.max(3, Math.min(40, Number(process.env.PERMANENT_ML_CYCLE_EPOCHS || 10)));
const LEARNING_RATE = Math.max(0.005, Math.min(0.25, Number(process.env.PERMANENT_ML_LEARNING_RATE || 0.045)));
const L2 = Math.max(0, Math.min(0.1, Number(process.env.PERMANENT_ML_L2 || 0.0015)));

const models = new Map();
let refreshHandle = null;
let busy = false;
let started = false;
let runtimePool = null;
let runtimeGameYear = "26";
let runtimeBusyFn = null;
let retryHandle = null;
let lastStatus = {
  version: PERMANENT_ML_VERSION,
  enabled: true,
  started: false,
  busy: false,
  status: "IDLE",
  activeGameYear: null,
  historicalSourceYears: [...HISTORICAL_SOURCE_YEARS],
  targetMonths: 24,
  learningWindowDays: LEARNING_WINDOW_DAYS,
  modelCount: 0,
  trustedModels: 0,
  decisionSamples: 0,
  cycleSamples: 0,
  cycleObservedCards: 0,
  cycleSpanDays: 0,
  schoolCoverage: {},
  full24MonthWindowAvailable: false,
  lastTrainStartedAt: null,
  lastTrainCompletedAt: null,
  lastError: null,
  nextRefreshAt: null
};

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function sigmoid(z) {
  const x = clamp(Number(z) || 0, -35, 35);
  return 1 / (1 + Math.exp(-x));
}
function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}
function pctChange(from, to) {
  const a = finite(from); const b = finite(to);
  if (a == null || b == null || a <= 0) return null;
  return ((b - a) / a) * 100;
}
function netRoi(from, to) {
  const a = finite(from); const b = finite(to);
  if (a == null || b == null || a <= 0 || b <= 0) return null;
  return ((b * 0.95 - a) / a) * 100;
}
function iso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function daysBetween(a, b) {
  const x = Date.parse(a || ""); const y = Date.parse(b || "");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.max(0, (y - x) / 86_400_000);
}

const DECISION_FEATURE_NAMES = [
  "change1m", "change5m", "change15m", "change1h", "change24h", "change7d", "change30d",
  "distance24hLow", "ratingBreadth", "leakActive", "leakImpact", "leakReaction", "traderSignalLoad",
  "packSupply", "ratingLogic"
];
const DECISION_FEATURE_SCALES = [8, 15, 25, 35, 60, 100, 150, 30, 100, 1, 100, 1, 5, 1, 50];

function decisionFeatures(input = {}) {
  const leaks = input?.marketContext?.publicLeaks || {};
  const signals = Array.isArray(input?.discordSignals) ? input.discordSignals : [];
  const breadth = (Number(input.ratingMarketRisingPct || 0) - Number(input.ratingMarketFallingPct || 0));
  const values = [
    finite(input.change1m) ?? 0,
    finite(input.change5m) ?? 0,
    finite(input.change15m) ?? 0,
    finite(input.change1h) ?? 0,
    finite(input.change24h) ?? 0,
    finite(input.change7d) ?? 0,
    finite(input.change30d) ?? 0,
    finite(input.distanceTo24hLow) ?? 0,
    breadth,
    leaks.active ? 1 : 0,
    finite(leaks.impactScore) ?? 0,
    leaks.marketReaction ? 1 : 0,
    Math.min(5, signals.length),
    input?.marketContext?.packSupplyActive ? 1 : 0,
    (finite(input.ratingMarketLogicScore) ?? 50) - 50
  ];
  return values.map((v, i) => clamp(v / DECISION_FEATURE_SCALES[i], -3, 3));
}

const CYCLE_FEATURE_NAMES = ["change24h", "change7d", "change30d", "distance24hLow", "distance24hHigh"];
const CYCLE_FEATURE_SCALES = [60, 100, 150, 30, 30];
function cycleFeaturesFromLive(input = {}) {
  const price = finite(input.currentPrice);
  const low = finite(input.low24h);
  const high = finite(input.high24h);
  let distLow = finite(input.distanceTo24hLow);
  if (distLow == null && price != null && low != null && low > 0) distLow = ((price - low) / low) * 100;
  let distHigh = 0;
  if (price != null && high != null && high > 0) distHigh = ((high - price) / high) * 100;
  const values = [
    finite(input.change24h) ?? 0,
    finite(input.change7d) ?? 0,
    finite(input.change30d) ?? 0,
    distLow ?? 0,
    distHigh
  ];
  return values.map((v, i) => clamp(v / CYCLE_FEATURE_SCALES[i], -3, 3));
}

function trainLogistic(samples, featureNames, { epochs = 10, lr = LEARNING_RATE } = {}) {
  if (!Array.isArray(samples) || samples.length < MIN_TRAIN_SAMPLES) return null;
  const split = Math.max(1, Math.floor(samples.length * 0.8));
  const train = samples.slice(0, split);
  const validation = samples.slice(split);
  if (validation.length < MIN_VALIDATION_SAMPLES) return null;
  const dims = featureNames.length;
  const weights = new Array(dims).fill(0);
  let bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const eta = lr / (1 + epoch * 0.12);
    for (const sample of train) {
      const x = sample.x;
      const y = sample.y ? 1 : 0;
      let z = bias;
      for (let j = 0; j < dims; j++) z += weights[j] * (Number(x[j]) || 0);
      const p = sigmoid(z);
      const err = p - y;
      for (let j = 0; j < dims; j++) {
        weights[j] -= eta * (err * (Number(x[j]) || 0) + L2 * weights[j]);
      }
      bias -= eta * err;
    }
  }
  let tp = 0, tn = 0, fp = 0, fn = 0, brier = 0;
  for (const sample of validation) {
    let z = bias;
    for (let j = 0; j < dims; j++) z += weights[j] * (Number(sample.x[j]) || 0);
    const p = sigmoid(z);
    const pred = p >= 0.5;
    if (pred && sample.y) tp++; else if (pred && !sample.y) fp++; else if (!pred && sample.y) fn++; else tn++;
    brier += (p - (sample.y ? 1 : 0)) ** 2;
  }
  const tpr = tp + fn ? tp / (tp + fn) : 0.5;
  const tnr = tn + fp ? tn / (tn + fp) : 0.5;
  const balancedAccuracy = (tpr + tnr) / 2;
  const accuracy = validation.length ? (tp + tn) / validation.length : 0;
  const positives = samples.filter(s => s.y).length;
  return {
    featureNames,
    weights,
    bias,
    samples: samples.length,
    positives,
    negatives: samples.length - positives,
    validationSamples: validation.length,
    metrics: {
      accuracy: Number(accuracy.toFixed(4)),
      balancedAccuracy: Number(balancedAccuracy.toFixed(4)),
      brier: Number((brier / Math.max(1, validation.length)).toFixed(4)),
      tpr: Number(tpr.toFixed(4)),
      tnr: Number(tnr.toFixed(4))
    },
    trusted: samples.length >= MIN_TRAIN_SAMPLES && validation.length >= MIN_VALIDATION_SAMPLES && balancedAccuracy >= MIN_TRUST_BALANCED_ACCURACY
  };
}

function predict(model, x) {
  if (!model || !Array.isArray(model.weights) || !Array.isArray(x)) return null;
  let z = Number(model.bias || 0);
  const n = Math.min(model.weights.length, x.length);
  for (let i = 0; i < n; i++) z += Number(model.weights[i] || 0) * Number(x[i] || 0);
  return sigmoid(z);
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_permanent_ml_models_v106996 (
      game_year VARCHAR(2) NOT NULL,
      model_key VARCHAR(64) NOT NULL,
      model_version VARCHAR(32) NOT NULL,
      feature_version VARCHAR(64) NOT NULL,
      feature_names JSONB NOT NULL,
      weights JSONB NOT NULL,
      bias DOUBLE PRECISION NOT NULL,
      samples INTEGER NOT NULL,
      positives INTEGER NOT NULL,
      negatives INTEGER NOT NULL,
      validation_samples INTEGER NOT NULL,
      trusted BOOLEAN NOT NULL DEFAULT FALSE,
      metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
      trained_from TIMESTAMPTZ,
      trained_to TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (game_year, model_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_permanent_ml_models_updated_v106996
    ON fc_permanent_ml_models_v106996 (updated_at DESC)
  `);
}

async function loadPersistedModels(pool, gameYear) {
  const years = [...new Set([String(gameYear || "26"), ...HISTORICAL_SOURCE_YEARS])];
  const result = await pool.query(`
    SELECT * FROM fc_permanent_ml_models_v106996
    WHERE game_year::text = ANY($1::text[])
  `, [years]);
  for (const row of result.rows || []) {
    models.set(`${row.game_year}:${row.model_key}`, {
      gameYear: String(row.game_year),
      modelKey: row.model_key,
      modelVersion: row.model_version,
      featureVersion: row.feature_version,
      featureNames: safeJson(row.feature_names, []),
      weights: safeJson(row.weights, []),
      bias: Number(row.bias || 0),
      samples: Number(row.samples || 0),
      positives: Number(row.positives || 0),
      negatives: Number(row.negatives || 0),
      validationSamples: Number(row.validation_samples || 0),
      trusted: Boolean(row.trusted),
      metrics: safeJson(row.metrics, {}),
      trainedFrom: iso(row.trained_from),
      trainedTo: iso(row.trained_to),
      updatedAt: iso(row.updated_at)
    });
  }
}

async function persistModel(pool, gameYear, modelKey, featureVersion, model, trainedFrom, trainedTo) {
  if (!model) return;
  await pool.query(`
    INSERT INTO fc_permanent_ml_models_v106996 (
      game_year, model_key, model_version, feature_version, feature_names,
      weights, bias, samples, positives, negatives, validation_samples,
      trusted, metrics, trained_from, trained_to, updated_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,NOW())
    ON CONFLICT (game_year, model_key) DO UPDATE SET
      model_version = EXCLUDED.model_version,
      feature_version = EXCLUDED.feature_version,
      feature_names = EXCLUDED.feature_names,
      weights = EXCLUDED.weights,
      bias = EXCLUDED.bias,
      samples = EXCLUDED.samples,
      positives = EXCLUDED.positives,
      negatives = EXCLUDED.negatives,
      validation_samples = EXCLUDED.validation_samples,
      trusted = EXCLUDED.trusted,
      metrics = EXCLUDED.metrics,
      trained_from = EXCLUDED.trained_from,
      trained_to = EXCLUDED.trained_to,
      updated_at = NOW()
  `, [
    String(gameYear), modelKey, PERMANENT_ML_VERSION, featureVersion,
    JSON.stringify(model.featureNames || []), JSON.stringify(model.weights || []), Number(model.bias || 0),
    Number(model.samples || 0), Number(model.positives || 0), Number(model.negatives || 0), Number(model.validationSamples || 0),
    Boolean(model.trusted), JSON.stringify(model.metrics || {}), trainedFrom || null, trainedTo || null
  ]);
  models.set(`${String(gameYear)}:${modelKey}`, {
    ...model,
    gameYear: String(gameYear),
    modelKey,
    modelVersion: PERMANENT_ML_VERSION,
    featureVersion,
    trainedFrom,
    trainedTo,
    updatedAt: new Date().toISOString()
  });
}

function decisionLabelForHorizon(row, horizon) {
  const value = finite(row?.[`roi_${horizon}`]);
  if (value == null) return null;
  return value > 0;
}

async function trainDecisionModels(pool, gameYear) {
  const result = await pool.query(`
    SELECT * FROM (
      SELECT
        d.input_snapshot,
        d.created_at,
        e.roi_1h,
        e.roi_6h,
        e.roi_24h
      FROM fc_trader_brain_decisions d
      JOIN fc_decision_evaluations e ON e.decision_id = d.id
      WHERE d.created_at >= NOW() - INTERVAL '730 days'
        AND COALESCE(NULLIF(d.input_snapshot->>'gameYear',''), '26') = $1
        AND (e.roi_1h IS NOT NULL OR e.roi_6h IS NOT NULL OR e.roi_24h IS NOT NULL)
      ORDER BY d.created_at DESC
      LIMIT $2
    ) recent
    ORDER BY created_at ASC
  `, [String(gameYear), MAX_DECISION_SAMPLES]);

  const rows = result.rows || [];
  const horizonMap = { "1h": [], "6h": [], "24h": [] };
  let trainedFrom = null, trainedTo = null;
  for (const row of rows) {
    const input = safeJson(row.input_snapshot, null);
    if (!input) continue;
    const x = decisionFeatures(input);
    const at = iso(row.created_at);
    if (at && (!trainedFrom || at < trainedFrom)) trainedFrom = at;
    if (at && (!trainedTo || at > trainedTo)) trainedTo = at;
    for (const horizon of Object.keys(horizonMap)) {
      const y = decisionLabelForHorizon(row, horizon);
      if (y == null) continue;
      horizonMap[horizon].push({ x, y, at });
    }
  }

  for (const [horizon, samples] of Object.entries(horizonMap)) {
    const model = trainLogistic(samples, DECISION_FEATURE_NAMES, { epochs: DECISION_EPOCHS });
    if (model) await persistModel(pool, gameYear, `decision_${horizon}`, FEATURE_VERSION, model, trainedFrom, trainedTo);
  }
  return rows.length;
}

async function historicalTableInfo(pool) {
  const result = await pool.query(`
    SELECT
      to_regclass('public.fc_own_market_price_history') AS own_table,
      to_regclass('public.fc_price_history') AS legacy_table
  `);
  return {
    own: Boolean(result.rows?.[0]?.own_table),
    legacy: Boolean(result.rows?.[0]?.legacy_table)
  };
}

async function historicalCoverageForYear(pool, gameYear) {
  const tables = await historicalTableInfo(pool);
  const year = String(gameYear);
  const sources = [];
  const params = [year];
  if (tables.own) {
    sources.push(`SELECT observed_at AS at, ea_id::text AS ea_id FROM fc_own_market_price_history
      WHERE game_year = $1 AND observed_at >= NOW() - INTERVAL '730 days'`);
  }
  if (tables.legacy && year === PRIMARY_HISTORY_YEAR && String(runtimeGameYear) === PRIMARY_HISTORY_YEAR) {
    sources.push(`SELECT recorded_at AS at, ea_id::text AS ea_id FROM fc_price_history
      WHERE recorded_at >= NOW() - INTERVAL '730 days' AND $1::text = '26'`);
  }
  if (!sources.length) return { gameYear: year, observations: 0, cards: 0, observedCalendarDays: 0, earliestAt: null, latestAt: null, spanDays: 0 };
  const result = await pool.query(`
    WITH source AS (${sources.join(" UNION ALL ")})
    SELECT MIN(at) AS earliest_at, MAX(at) AS latest_at,
           COUNT(*)::bigint AS observations,
           COUNT(DISTINCT ea_id)::bigint AS cards,
           COUNT(DISTINCT (at AT TIME ZONE 'UTC')::date)::int AS observed_days
    FROM source
  `, params);
  const row = result.rows?.[0] || {};
  const earliestAt = iso(row.earliest_at);
  const latestAt = iso(row.latest_at);
  return {
    gameYear: year,
    observations: Number(row.observations || 0),
    cards: Number(row.cards || 0),
    observedCalendarDays: Number(row.observed_days || 0),
    earliestAt,
    latestAt,
    spanDays: earliestAt && latestAt ? Number(daysBetween(earliestAt, latestAt).toFixed(2)) : 0
  };
}

function summarizeSchoolCoverage(coverageByYear) {
  const rows = Object.values(coverageByYear || {}).filter(x => Number(x?.observations || 0) > 0);
  const dates = rows.flatMap(x => [x.earliestAt, x.latestAt]).filter(Boolean).sort();
  const earliestAt = dates[0] || null;
  const latestAt = dates.at(-1) || null;
  const spanDays = earliestAt && latestAt ? Number(daysBetween(earliestAt, latestAt).toFixed(2)) : 0;
  const observedCalendarDays = rows.reduce((sum, x) => sum + Number(x.observedCalendarDays || 0), 0);
  const full24MonthWindowAvailable = spanDays >= 729 && observedCalendarDays >= 700;
  return {
    targetDays: LEARNING_WINDOW_DAYS,
    targetMonths: 24,
    earliestAt,
    latestAt,
    spanDays,
    observedCalendarDays,
    full24MonthWindowAvailable,
    realObservedDataOnly: true,
    synthetic: false
  };
}

function sixHourBucketExpr(column) {
  return `(date_trunc('day', ${column}) + floor(extract(hour from ${column}) / 6) * interval '6 hours')`;
}

async function loadHistoricalCycleRows(pool, gameYear) {
  const tables = await historicalTableInfo(pool);
  const sourceYear = String(gameYear);
  let sourceSql = null;
  const sources = [];
  if (tables.own) {
    sources.push(`SELECT ea_id::text AS ea_id, price::int AS price, observed_at AS at
      FROM fc_own_market_price_history
      WHERE game_year = $1 AND observed_at >= NOW() - INTERVAL '730 days'`);
  }
  // Legacy history has no game_year. It is safe as FC26 evidence only while FC26
  // is the active runtime. After the game-year switch we stop reading legacy rows
  // for the FC26 prior so new FC27 observations can never leak into the old model.
  if (tables.legacy && sourceYear === PRIMARY_HISTORY_YEAR && String(runtimeGameYear) === PRIMARY_HISTORY_YEAR) {
    sources.push(`SELECT ea_id::text AS ea_id, price::int AS price, recorded_at AS at
      FROM fc_price_history
      WHERE recorded_at >= NOW() - INTERVAL '730 days' AND $1::text = '26'`);
  }
  if (!sources.length) {
    return { rows: [], cards: 0, spanDays: 0, from: null, to: null };
  }
  sourceSql = sources.join(" UNION ALL ");
  const bucket = sixHourBucketExpr("at");
  const result = await pool.query(`
    WITH source AS (${sourceSql}),
    ranked AS (
      SELECT ea_id, COUNT(*) AS n
      FROM source
      GROUP BY ea_id
      ORDER BY n DESC
      LIMIT $2
    ),
    bucketed AS (
      SELECT DISTINCT ON (s.ea_id, ${bucket})
        s.ea_id,
        ${bucket} AS bucket_at,
        s.price
      FROM source s
      JOIN ranked r ON r.ea_id = s.ea_id
      ORDER BY s.ea_id, ${bucket}, s.at DESC
    )
    SELECT ea_id, bucket_at, price
    FROM bucketed
    ORDER BY ea_id, bucket_at ASC
  `, [sourceYear, CYCLE_TOP_CARDS]);
  const rows = result.rows || [];
  const times = rows.map(r => iso(r.bucket_at)).filter(Boolean).sort();
  const from = times.length ? times[0] : null;
  const to = times.length ? times.at(-1) : null;
  return {
    rows,
    cards: new Set(rows.map(r => String(r.ea_id))).size,
    spanDays: from && to ? daysBetween(from, to) : 0,
    from,
    to
  };
}

function historicalCycleSamples(rows) {
  const byCard = new Map();
  for (const row of rows || []) {
    const key = String(row.ea_id);
    if (!byCard.has(key)) byCard.set(key, []);
    byCard.get(key).push({ at: iso(row.bucket_at), price: Number(row.price) });
  }
  const samples24h = [];
  const samples7d = [];
  const step24 = 4;
  const step7d = 28;
  const step30d = 120;
  for (const series of byCard.values()) {
    for (let i = step7d; i < series.length - step24; i++) {
      const cur = series[i]?.price;
      if (!Number.isFinite(cur) || cur <= 0) continue;
      const p24 = series[i - step24]?.price;
      const p7 = series[i - step7d]?.price;
      const p30 = i >= step30d ? series[i - step30d]?.price : null;
      const lookback24 = series.slice(Math.max(0, i - step24), i + 1).map(x => x.price).filter(Number.isFinite);
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
      const future24 = series[i + step24]?.price;
      const roi24 = netRoi(cur, future24);
      if (roi24 != null) samples24h.push({ x, y: roi24 > 0, at: series[i].at });
      const future7 = series[i + step7d]?.price;
      const roi7 = netRoi(cur, future7);
      if (roi7 != null) samples7d.push({ x, y: roi7 > 0, at: series[i].at });
    }
  }
  return { samples24h, samples7d };
}

async function trainHistoricalCycleModels(pool, gameYear) {
  const loaded = await loadHistoricalCycleRows(pool, gameYear);
  const { samples24h, samples7d } = historicalCycleSamples(loaded.rows);
  const model24 = trainLogistic(samples24h, CYCLE_FEATURE_NAMES, { epochs: CYCLE_EPOCHS });
  const model7 = trainLogistic(samples7d, CYCLE_FEATURE_NAMES, { epochs: CYCLE_EPOCHS });
  if (model24) await persistModel(pool, gameYear, "cycle_24h", CYCLE_FEATURE_VERSION, model24, loaded.from, loaded.to);
  if (model7) await persistModel(pool, gameYear, "cycle_7d", CYCLE_FEATURE_VERSION, model7, loaded.from, loaded.to);
  return {
    sampleCount: samples24h.length + samples7d.length,
    cards: loaded.cards,
    spanDays: Number(loaded.spanDays.toFixed(2))
  };
}

function modelFor(year, key) {
  return models.get(`${String(year)}:${key}`) || null;
}
function weightedProbability(parts) {
  const valid = parts.filter(p => Number.isFinite(p?.prob) && Number(p?.weight) > 0);
  if (!valid.length) return null;
  const weight = valid.reduce((s, p) => s + p.weight, 0);
  return valid.reduce((s, p) => s + p.prob * p.weight, 0) / weight;
}
function modelWeight(model) {
  if (!model?.trusted) return 0;
  const acc = Number(model.metrics?.balancedAccuracy || 0.5);
  const size = Math.min(1, Number(model.samples || 0) / 500);
  return Math.max(0.1, (acc - 0.5) * 4 + 0.2) * (0.35 + size * 0.65);
}

export function scorePermanentMlV106996(input = {}) {
  const activeYear = String(input.gameYear || runtimeGameYear || "26");
  const decisionX = decisionFeatures(input);
  const cycleX = cycleFeaturesFromLive(input);

  const sourceYears = [...new Set([activeYear, ...HISTORICAL_SOURCE_YEARS])];
  const recencyWeight = year => {
    if (String(year) === activeYear) return 1.0;
    if (String(year) === "26") return Number(activeYear) >= 27 ? 0.30 : 0.22;
    if (String(year) === "25") return Number(activeYear) >= 27 ? 0.14 : 0.18;
    return 0.10;
  };

  const decisionParts = horizon => sourceYears.map(year => {
    const model = modelFor(year, `decision_${horizon}`);
    return { year, model, prob: model?.trusted ? predict(model, decisionX) : null, weight: modelWeight(model) * recencyWeight(year) };
  });
  const cycleParts = horizon => sourceYears.map(year => {
    const model = modelFor(year, `cycle_${horizon}`);
    return { year, model, prob: model?.trusted ? predict(model, cycleX) : null, weight: modelWeight(model) * recencyWeight(year) };
  });

  const d1 = decisionParts("1h");
  const d6 = decisionParts("6h");
  const d24 = decisionParts("24h");
  const c24 = cycleParts("24h");
  const c7 = cycleParts("7d");

  const p1 = weightedProbability(d1);
  const p6 = weightedProbability(d6);
  const p24 = weightedProbability([
    ...d24.map(p => ({ ...p, weight: p.weight * 0.65 })),
    ...c24.map(p => ({ ...p, weight: p.weight * 0.35 }))
  ]);
  const p7d = weightedProbability(c7);

  const trustedModels = [...d1, ...d6, ...d24, ...c24, ...c7]
    .map(p => p.model)
    .filter((m, i, arr) => m?.trusted && arr.indexOf(m) === i);
  const probs = [p1, p6, p24, p7d].filter(Number.isFinite);
  if (!probs.length || !trustedModels.length) {
    return {
      available: false,
      version: PERMANENT_ML_VERSION,
      activeGameYear: activeYear,
      historicalSourceYears: [...HISTORICAL_SOURCE_YEARS],
      reason: "NO_TRUSTED_MODEL_YET",
      trustedModels: trustedModels.length,
      synthetic: false
    };
  }

  const primary = Number.isFinite(p6) ? p6 : Number.isFinite(p24) ? p24 : probs.reduce((a, b) => a + b, 0) / probs.length;
  const confidence = Math.round(clamp(Math.abs(primary - 0.5) * 200, 0, 95));
  let signal = "NEUTRAL";
  if ((Number.isFinite(p6) && p6 >= 0.64) || (Number.isFinite(p24) && p24 >= 0.66)) signal = "BULLISH";
  if ((Number.isFinite(p6) && p6 <= 0.36) && (!Number.isFinite(p24) || p24 <= 0.44)) signal = "BEARISH";

  const sourceSamples = trustedModels.reduce((sum, m) => sum + Number(m.samples || 0), 0);
  const sourceYearsUsed = [...new Set(trustedModels.map(m => String(m.gameYear)))].sort();
  return {
    available: true,
    version: PERMANENT_ML_VERSION,
    activeGameYear: activeYear,
    historicalSourceYears: [...HISTORICAL_SOURCE_YEARS],
    sourceYearsUsed,
    targetLearningDays: LEARNING_WINDOW_DAYS,
    targetLearningMonths: 24,
    signal,
    confidence,
    probabilityNetPositive1h: Number.isFinite(p1) ? Number((p1 * 100).toFixed(1)) : null,
    probabilityNetPositive6h: Number.isFinite(p6) ? Number((p6 * 100).toFixed(1)) : null,
    probabilityNetPositive24h: Number.isFinite(p24) ? Number((p24 * 100).toFixed(1)) : null,
    probabilityNetPositive7d: Number.isFinite(p7d) ? Number((p7d * 100).toFixed(1)) : null,
    trustedModels: trustedModels.length,
    sourceSamples,
    historicalPriorUsed: sourceYearsUsed.some(year => year !== activeYear),
    policy: {
      netPositiveMeansAfterEaTax: true,
      mlAloneCannotTriggerBuy: true,
      canVetoWeakBuy: true,
      activeGameYearPreferred: true,
      olderGameYearsDownweighted: true,
      gameYearsNeverMergedAsRawPrices: true,
      synthetic: false
    }
  };
}

async function trainAll(pool, gameYear) {
  if (!pool || busy) return;
  if (typeof runtimeBusyFn === "function" && runtimeBusyFn()) {
    lastStatus = { ...lastStatus, status: "DEFERRED_MONITOR_BUSY", busy: false, nextRefreshAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    if (!retryHandle) {
      retryHandle = setTimeout(() => {
        retryHandle = null;
        trainAll(pool, gameYear).catch(() => {});
      }, 5 * 60_000);
      retryHandle.unref?.();
    }
    return;
  }
  busy = true;
  lastStatus = { ...lastStatus, busy: true, status: "TRAINING", lastTrainStartedAt: new Date().toISOString(), lastError: null };
  try {
    await ensureSchema(pool);
    await loadPersistedModels(pool, gameYear);

    const yearsToTrain = [...new Set([String(gameYear || "26"), ...HISTORICAL_SOURCE_YEARS])];
    const decisionSamplesByYear = {};
    const cycleByYear = {};
    const coverageByYear = {};

    for (const year of yearsToTrain) {
      decisionSamplesByYear[year] = await trainDecisionModels(pool, year).catch(() => 0);
      // Legacy ungrouped history is admitted only while FC26 is active. Own
      // game-year history remains safe for every year.
      cycleByYear[year] = await trainHistoricalCycleModels(pool, year).catch(() => ({ sampleCount: 0, cards: 0, spanDays: 0 }));
      coverageByYear[year] = await historicalCoverageForYear(pool, year).catch(() => ({ gameYear: year, observations: 0, cards: 0, observedCalendarDays: 0, earliestAt: null, latestAt: null, spanDays: 0 }));
    }

    const schoolCoverage = summarizeSchoolCoverage(Object.fromEntries(
      HISTORICAL_SOURCE_YEARS.map(year => [year, coverageByYear[year] || {}])
    ));
    const all = [...models.values()];
    const decisionSamples = Object.values(decisionSamplesByYear).reduce((sum, n) => sum + Number(n || 0), 0);
    const cycleSamples = Object.values(cycleByYear).reduce((sum, item) => sum + Number(item?.sampleCount || 0), 0);
    const cycleObservedCards = Object.values(cycleByYear).reduce((sum, item) => sum + Number(item?.cards || 0), 0);
    const cycleSpanDays = Math.max(0, ...Object.values(cycleByYear).map(item => Number(item?.spanDays || 0)));

    lastStatus = {
      ...lastStatus,
      busy: false,
      status: "READY",
      activeGameYear: String(gameYear),
      historicalSourceYears: [...HISTORICAL_SOURCE_YEARS],
      targetMonths: 24,
      learningWindowDays: LEARNING_WINDOW_DAYS,
      modelCount: all.length,
      trustedModels: all.filter(m => m.trusted).length,
      decisionSamples,
      decisionSamplesByYear,
      cycleSamples,
      cycleByYear,
      cycleObservedCards,
      cycleSpanDays,
      schoolCoverage: { ...schoolCoverage, byGameYear: Object.fromEntries(HISTORICAL_SOURCE_YEARS.map(y => [y, coverageByYear[y] || null])) },
      full24MonthWindowAvailable: Boolean(schoolCoverage.full24MonthWindowAvailable),
      lastTrainCompletedAt: new Date().toISOString(),
      lastError: null,
      nextRefreshAt: new Date(Date.now() + RETRAIN_MS).toISOString()
    };
  } catch (error) {
    lastStatus = {
      ...lastStatus,
      busy: false,
      status: "ERROR",
      lastError: String(error?.message || error),
      lastTrainCompletedAt: new Date().toISOString(),
      nextRefreshAt: new Date(Date.now() + RETRAIN_MS).toISOString()
    };
  } finally {
    busy = false;
  }
}

export async function startPermanentMlBrainV106996({ pool = null, gameYear = "26", isBusy = null } = {}) {
  runtimePool = pool;
  runtimeGameYear = String(gameYear || "26");
  runtimeBusyFn = typeof isBusy === "function" ? isBusy : null;
  if (started) return getPermanentMlStatusV106996();
  started = true;
  lastStatus = { ...lastStatus, started: true, activeGameYear: runtimeGameYear, status: pool ? "LOADING" : "NO_DATABASE" };
  if (!pool) return getPermanentMlStatusV106996();
  await ensureSchema(pool);
  await loadPersistedModels(pool, runtimeGameYear);
  const all = [...models.values()];
  lastStatus = {
    ...lastStatus,
    status: all.length ? "MODEL_LOADED" : "WAITING_FOR_TRAINING",
    modelCount: all.length,
    trustedModels: all.filter(m => m.trusted).length
  };
  const startTimer = setTimeout(() => trainAll(pool, runtimeGameYear).catch(() => {}), START_DELAY_MS);
  startTimer.unref?.();
  refreshHandle = setInterval(() => trainAll(pool, runtimeGameYear).catch(() => {}), RETRAIN_MS);
  refreshHandle.unref?.();
  return getPermanentMlStatusV106996();
}

export function stopPermanentMlBrainV106996() {
  if (refreshHandle) clearInterval(refreshHandle);
  if (retryHandle) clearTimeout(retryHandle);
  refreshHandle = null;
  retryHandle = null;
  started = false;
  lastStatus = { ...lastStatus, started: false, busy: false, status: "STOPPED" };
}

export function getPermanentMlStatusV106996() {
  const list = [...models.values()].map(m => ({
    gameYear: m.gameYear,
    modelKey: m.modelKey,
    trusted: Boolean(m.trusted),
    samples: Number(m.samples || 0),
    balancedAccuracy: Number(m.metrics?.balancedAccuracy || 0),
    brier: Number(m.metrics?.brier || 0),
    trainedFrom: m.trainedFrom || null,
    trainedTo: m.trainedTo || null,
    updatedAt: m.updatedAt || null
  }));
  return {
    ...lastStatus,
    modelCount: list.length,
    trustedModels: list.filter(m => m.trusted).length,
    retrainMinutes: Math.round(RETRAIN_MS / 60_000),
    featureVersion: FEATURE_VERSION,
    cycleFeatureVersion: CYCLE_FEATURE_VERSION,
    learningWindowDays: LEARNING_WINDOW_DAYS,
    targetMonths: 24,
    historicalSourceYears: [...HISTORICAL_SOURCE_YEARS],
    performanceWindowDays: LEARNING_WINDOW_DAYS,
    policy: {
      realObservedDataOnly: true,
      noSyntheticBackfill: true,
      walkForwardValidation: true,
      persistentPostgresWeights: true,
      evaluatedDecisionsBecomeFutureTrainingData: true,
      publicLeakAndTraderSignalsLearnedFromInputSnapshots: true,
      mlAloneCannotTriggerBuy: true,
      fc25Fc26Fc27Separated: true,
      twoYearPatternSchool: true,
      rawPricesNeverMergedAcrossGameYears: true
    },
    models: list
  };
}

export const __test = {
  decisionFeatures,
  cycleFeaturesFromLive,
  trainLogistic,
  predict,
  historicalCycleSamples
};
