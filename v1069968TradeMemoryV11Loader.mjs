import { Buffer } from "node:buffer";

export const V1069968_TRADE_MEMORY_VERSION = "10.69.9.6.8-v11-trade-memory";

const TRADE_MEMORY_HELPERS_SOURCE = "async function ensureTradeMemorySchemaV11() {\n  if (!dbEnabled) return;\n  await pool.query(`\n    CREATE TABLE IF NOT EXISTS fc_trade_memory_v11 (\n      game_year VARCHAR(2) NOT NULL,\n      memory_key TEXT NOT NULL,\n      scope VARCHAR(32) NOT NULL,\n      ea_id VARCHAR(32),\n      action VARCHAR(32) NOT NULL,\n      card_type VARCHAR(96),\n      rating_band VARCHAR(24),\n      market_regime VARCHAR(32),\n      samples INTEGER NOT NULL DEFAULT 0,\n      effective_samples DOUBLE PRECISION NOT NULL DEFAULT 0,\n      wins INTEGER NOT NULL DEFAULT 0,\n      weighted_wins DOUBLE PRECISION NOT NULL DEFAULT 0,\n      smoothed_accuracy DOUBLE PRECISION NOT NULL DEFAULT 50,\n      average_outcome_score DOUBLE PRECISION,\n      average_max_roi DOUBLE PRECISION,\n      confidence_adjustment INTEGER NOT NULL DEFAULT 0,\n      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      PRIMARY KEY (game_year, memory_key)\n    )\n  `);\n  await pool.query(`\n    CREATE INDEX IF NOT EXISTS idx_fc_trade_memory_v11_ea_action\n    ON fc_trade_memory_v11 (game_year, ea_id, action, updated_at DESC)\n  `);\n}\n\nasync function persistTradeMemoryProfilesV11(profiles) {\n  if (!dbEnabled) return;\n  const rows = (profiles || []).map(profile => {\n    const parts = String(profile.key || \"\").split(\"|\");\n    const cardSpecific = [\"cardRegime\", \"cardAction\"].includes(String(profile.scope || \"\"));\n    return {\n      memory_key: String(profile.key || \"\"),\n      scope: String(profile.scope || \"unknown\"),\n      ea_id: cardSpecific ? String(parts[0] || \"\") : null,\n      action: String(profile.action || \"UNKNOWN\"),\n      card_type: profile.cardType == null ? null : String(profile.cardType),\n      rating_band: profile.ratingBand == null ? null : String(profile.ratingBand),\n      market_regime: profile.marketRegime == null ? null : String(profile.marketRegime),\n      samples: Number(profile.samples || 0),\n      effective_samples: Number(profile.effectiveSamples || 0),\n      wins: Number(profile.wins || 0),\n      weighted_wins: Number(profile.weightedWins || 0),\n      smoothed_accuracy: Number(profile.smoothedAccuracy || 50),\n      average_outcome_score: Number.isFinite(Number(profile.averageOutcomeScore)) ? Number(profile.averageOutcomeScore) : null,\n      average_max_roi: Number.isFinite(Number(profile.averageMaxRoi)) ? Number(profile.averageMaxRoi) : null,\n      confidence_adjustment: Number(profile.confidenceAdjustment || 0)\n    };\n  }).filter(row => row.memory_key);\n\n  try {\n    await ensureTradeMemorySchemaV11();\n    if (rows.length) {\n      await pool.query(`\n        INSERT INTO fc_trade_memory_v11 (\n          game_year, memory_key, scope, ea_id, action, card_type, rating_band,\n          market_regime, samples, effective_samples, wins, weighted_wins,\n          smoothed_accuracy, average_outcome_score, average_max_roi,\n          confidence_adjustment, updated_at\n        )\n        SELECT\n          $1::varchar(2), x.memory_key, x.scope, NULLIF(x.ea_id, ''), x.action,\n          NULLIF(x.card_type, ''), NULLIF(x.rating_band, ''), NULLIF(x.market_regime, ''),\n          x.samples, x.effective_samples, x.wins, x.weighted_wins, x.smoothed_accuracy,\n          x.average_outcome_score, x.average_max_roi, x.confidence_adjustment, NOW()\n        FROM jsonb_to_recordset($2::jsonb) AS x(\n          memory_key text, scope text, ea_id text, action text, card_type text,\n          rating_band text, market_regime text, samples int, effective_samples double precision,\n          wins int, weighted_wins double precision, smoothed_accuracy double precision,\n          average_outcome_score double precision, average_max_roi double precision,\n          confidence_adjustment int\n        )\n        ON CONFLICT (game_year, memory_key) DO UPDATE SET\n          scope = EXCLUDED.scope,\n          ea_id = EXCLUDED.ea_id,\n          action = EXCLUDED.action,\n          card_type = EXCLUDED.card_type,\n          rating_band = EXCLUDED.rating_band,\n          market_regime = EXCLUDED.market_regime,\n          samples = EXCLUDED.samples,\n          effective_samples = EXCLUDED.effective_samples,\n          wins = EXCLUDED.wins,\n          weighted_wins = EXCLUDED.weighted_wins,\n          smoothed_accuracy = EXCLUDED.smoothed_accuracy,\n          average_outcome_score = EXCLUDED.average_outcome_score,\n          average_max_roi = EXCLUDED.average_max_roi,\n          confidence_adjustment = EXCLUDED.confidence_adjustment,\n          updated_at = NOW()\n      `, [GAME_YEAR, JSON.stringify(rows)]);\n    }\n    tradeMemoryPersistedProfilesV11 = rows.length;\n    tradeMemoryLastPersistedAtV11 = new Date().toISOString();\n    tradeMemoryLastErrorV11 = null;\n  } catch (error) {\n    tradeMemoryLastErrorV11 = String(error?.message || error);\n    console.error(\"[v11 Trade Memory] persist error:\", error);\n  }\n}";
const APPLY_BRAIN_LEARNING_V11_SOURCE = "function applyBrainLearningToDecision(decision, profile) {\n  if (!decision) return decision;\n\n  if (!profile) {\n    return {\n      ...decision,\n      historical_learning: {\n        applied: false,\n        tradeMemoryVersion: TRADE_MEMORY_V11_VERSION,\n        reason: \"Noch nicht genug ausgewertete Ã¤hnliche Entscheidungen.\"\n      }\n    };\n  }\n\n  const cardSpecific = [\"cardRegime\", \"cardAction\"].includes(String(profile.scope || \"\"));\n  const rawModifier = Number(profile.confidenceAdjustment || 0);\n  const modifier = cardSpecific && rawModifier > 0 ? Math.min(4, rawModifier) : rawModifier;\n  const oldConfidence = Number(decision.confidence || 50);\n  let confidence = Math.max(10, Math.min(95, oldConfidence + modifier));\n  let action = decision.action;\n  let memoryGuard = null;\n\n  const samples = Number(profile.samples || 0);\n  const effectiveSamples = Number(profile.effectiveSamples || 0);\n  const accuracy = Number(profile.smoothedAccuracy || 50);\n  const avgOutcome = Number(profile.averageOutcomeScore || 0);\n\n  if (\n    cardSpecific &&\n    action === \"JETZT KAUFEN\" &&\n    samples >= TRADE_MEMORY_CARD_MIN_SAMPLES &&\n    effectiveSamples >= TRADE_MEMORY_CARD_MIN_EFFECTIVE\n  ) {\n    if (accuracy < TRADE_MEMORY_BUY_BLOCK_ACCURACY && avgOutcome <= -15) {\n      action = \"NICHT KAUFEN\";\n      confidence = Math.min(confidence, 70);\n      memoryGuard = \"CARD_HISTORY_BLOCK\";\n    } else if (accuracy < TRADE_MEMORY_BUY_WAIT_ACCURACY) {\n      action = \"NOCH WARTEN\";\n      confidence = Math.min(confidence, 76);\n      memoryGuard = \"CARD_HISTORY_WAIT\";\n    }\n  }\n\n  const signed = modifier > 0 ? \"+\" + modifier : String(modifier);\n  const effectiveText = Number.isFinite(profile.effectiveSamples)\n    ? \" (\" + profile.effectiveSamples.toFixed(1) + \" effektiv)\"\n    : \"\";\n  const regimeText = profile.marketRegime && profile.marketRegime !== \"*\"\n    ? \", Marktlage \" + profile.marketRegime\n    : \"\";\n  const cardText = cardSpecific ? \" Kartenspezifisches Trade-Memory.\" : \"\";\n  const guardText = memoryGuard === \"CARD_HISTORY_BLOCK\"\n    ? \" Wiederholt schwache reife Outcomes dieser Karte blockieren den Einstieg.\"\n    : memoryGuard === \"CARD_HISTORY_WAIT\"\n      ? \" Kartenspezifische Historie verlangt weitere BestÃ¤tigung.\"\n      : \"\";\n  const learningFactor =\n    \"Historie: \" + profile.samples + \" unabhÃ¤ngige FÃ¤lle\" + effectiveText + regimeText +\n    \", \" + profile.smoothedAccuracy.toFixed(1) + \"% geglÃ¤ttete Trefferquote, Confidence \" +\n    signed + \".\" + cardText + guardText;\n\n  return {\n    ...decision,\n    action,\n    confidence,\n    reason: modifier === 0 && !memoryGuard\n      ? decision.reason\n      : (String(decision.reason || \"\") + \" \" + learningFactor).slice(0, 1800),\n    key_factors: [\n      ...(Array.isArray(decision.key_factors) ? decision.key_factors : []),\n      learningFactor\n    ].slice(0, 12),\n    historical_learning: {\n      applied: true,\n      tradeMemoryVersion: TRADE_MEMORY_V11_VERSION,\n      feedbackLoop: true,\n      cardSpecific,\n      memoryGuard,\n      scope: profile.scope,\n      memoryKey: profile.key,\n      marketRegime: profile.marketRegime || \"*\",\n      samples: profile.samples,\n      effectiveSamples: profile.effectiveSamples,\n      wins: profile.wins,\n      weightedWins: profile.weightedWins,\n      rawAccuracy: profile.rawAccuracy,\n      smoothedAccuracy: profile.smoothedAccuracy,\n      averageOutcomeScore: profile.averageOutcomeScore,\n      averageMaxRoi: profile.averageMaxRoi,\n      accuracyAdjustment: profile.accuracyAdjustment ?? profile.confidenceAdjustment,\n      severityAdjustment: profile.severityAdjustment ?? 0,\n      confidenceBefore: oldConfidence,\n      confidenceModifier: modifier,\n      confidenceAfter: confidence,\n      actionBefore: decision.action,\n      actionAfter: action\n    },\n    ai_model_used: modifier === 0 && !memoryGuard\n      ? (decision.ai_model_used || \"Quantitative Core\")\n      : (decision.ai_model_used || \"Quantitative Core\") + \" + Trade-Memory-v11\"\n  };\n}";
const REGIME_KEY_ANCHOR = "function brainLearningRegimeKey(action, cardType, ratingBand, marketRegime) {\n  return `${brainLearningGroupKey(action, cardType, ratingBand)}|${String(marketRegime || \"NORMAL\")}`;\n}";
const BRAIN_CACHE_ANCHOR = "let brainLearningCache = {\n  loadedAt: 0,\n  updatedAt: null,\n  totalMatureDecisions: 0,\n  rawMatureDecisions: 0,\n  uniqueLearningEpisodes: 0,\n  regimeExact: new Map(),\n  exact: new Map(),\n  cardType: new Map(),\n  action: new Map(),\n  profiles: []\n};";
const HEALTH_BRAIN_ANCHOR = "    brainLearning: {\n      totalMatureDecisions: brainLearningCache.totalMatureDecisions,\n      rawMatureDecisions: brainLearningCache.rawMatureDecisions,\n      uniqueLearningEpisodes: brainLearningCache.uniqueLearningEpisodes,\n      updatedAt: brainLearningCache.updatedAt,\n      lastError: lastBrainLearningError\n    },";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function requiredReplace(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`[v10.69.9.6.8] ${label} anchor missing`);
  return source.replace(search, replacement);
}

function replaceFunctionBlock(source, startAnchor, nextAnchor, mutate, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`[v10.69.9.6.8] ${label} start anchor missing`);
  const end = source.indexOf(nextAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`[v10.69.9.6.8] ${label} end anchor missing`);
  const before = source.slice(start, end);
  const after = mutate(before);
  if (!after || after === before) throw new Error(`[v10.69.9.6.8] ${label} mutation did not apply`);
  return source.slice(0, start) + after.trimEnd() + "\n\n" + source.slice(end);
}

export function patchServerTradeMemoryV1069968(source) {
  let out = String(source || "");
  if (out.includes('TRADE_MEMORY_V11_VERSION = "11.0.1"')) return out;

  const constantsAnchor = "const BRAIN_LEARNING_ACTION_MIN_EFFECTIVE = 8;";
  out = requiredReplace(
    out,
    constantsAnchor,
    constantsAnchor + `
const TRADE_MEMORY_V11_VERSION = "11.0.1";
const TRADE_MEMORY_CARD_REGIME_MIN_SAMPLES = Math.max(2, Number(process.env.TRADE_MEMORY_CARD_REGIME_MIN_SAMPLES || 3));
const TRADE_MEMORY_CARD_MIN_SAMPLES = Math.max(3, Number(process.env.TRADE_MEMORY_CARD_MIN_SAMPLES || 4));
const TRADE_MEMORY_CARD_REGIME_MIN_EFFECTIVE = Math.max(1.5, Number(process.env.TRADE_MEMORY_CARD_REGIME_MIN_EFFECTIVE || 2));
const TRADE_MEMORY_CARD_MIN_EFFECTIVE = Math.max(2, Number(process.env.TRADE_MEMORY_CARD_MIN_EFFECTIVE || 3));
const TRADE_MEMORY_BUY_WAIT_ACCURACY = Math.max(35, Math.min(55, Number(process.env.TRADE_MEMORY_BUY_WAIT_ACCURACY || 46)));
const TRADE_MEMORY_BUY_BLOCK_ACCURACY = Math.max(25, Math.min(TRADE_MEMORY_BUY_WAIT_ACCURACY, Number(process.env.TRADE_MEMORY_BUY_BLOCK_ACCURACY || 38)));
let tradeMemoryPersistedProfilesV11 = 0;
let tradeMemoryLastPersistedAtV11 = null;
let tradeMemoryLastErrorV11 = null;`,
    "trade-memory constants"
  );

  out = requiredReplace(
    out,
    BRAIN_CACHE_ANCHOR,
    `let brainLearningCache = {
  loadedAt: 0,
  updatedAt: null,
  totalMatureDecisions: 0,
  rawMatureDecisions: 0,
  uniqueLearningEpisodes: 0,
  cardRegime: new Map(),
  cardAction: new Map(),
  regimeExact: new Map(),
  exact: new Map(),
  cardType: new Map(),
  action: new Map(),
  profiles: []
};`,
    "brain-learning cache"
  );

  out = requiredReplace(
    out,
    REGIME_KEY_ANCHOR,
    REGIME_KEY_ANCHOR + `

function brainLearningCardRegimeKey(eaId, action, marketRegime) {
  return String(eaId || "") + "|" + String(action || "UNKNOWN") + "|" + String(marketRegime || "NORMAL");
}

function brainLearningCardActionKey(eaId, action) {
  return String(eaId || "") + "|" + String(action || "UNKNOWN") + "|*";
}`,
    "card memory keys"
  );

  out = requiredReplace(
    out,
    'marketRegime: scope === "regimeExact" ? row.marketRegime : "*",',
    'marketRegime: ["regimeExact", "cardRegime"].includes(scope) ? row.marketRegime : "*",',
    "card regime metadata"
  );

  const helperAnchor = "async function loadBrainLearningProfiles(force = false) {";
  out = requiredReplace(out, helperAnchor, TRADE_MEMORY_HELPERS_SOURCE + "\n\n" + helperAnchor, "trade-memory helpers");

  out = replaceFunctionBlock(
    out,
    "async function loadBrainLearningProfiles(force = false) {",
    "function selectBrainLearningProfile(cache, action, cardType, rating, input = null) {",
    block => {
      let b = block;
      b = requiredReplace(
        b,
        "      WHERE d.created_at >= NOW() - ($1::int * INTERVAL '1 day')\n        AND e.was_correct IS NOT NULL",
        "      WHERE d.created_at >= NOW() - ($1::int * INTERVAL '1 day')\n        AND COALESCE(NULLIF(d.input_snapshot->>'gameYear',''), '26') = $2\n        AND e.was_correct IS NOT NULL",
        "game-year separated memory query"
      );
      b = requiredReplace(
        b,
        "      LIMIT $2\n    `, [BRAIN_LEARNING_WINDOW_DAYS, HISTORICAL_LEARNING_MAX_ROWS]);",
        "      LIMIT $3\n    `, [BRAIN_LEARNING_WINDOW_DAYS, GAME_YEAR, HISTORICAL_LEARNING_MAX_ROWS]);",
        "memory query params"
      );
      b = requiredReplace(
        b,
        "    const regimeRaw = new Map();",
        "    const cardRegimeRaw = new Map();\n    const cardActionRaw = new Map();\n    const regimeRaw = new Map();",
        "card memory maps"
      );
      b = requiredReplace(
        b,
        "      addBrainLearningSample(\n        regimeRaw,",
        `      // v11.0.1 Trade-Memory: same-card memory first, real mature outcomes only.
      if (row.eaId) {
        addBrainLearningSample(
          cardRegimeRaw,
          brainLearningCardRegimeKey(row.eaId, row.action, row.marketRegime),
          row,
          "cardRegime"
        );
        addBrainLearningSample(
          cardActionRaw,
          brainLearningCardActionKey(row.eaId, row.action),
          row,
          "cardAction"
        );
      }

      addBrainLearningSample(
        regimeRaw,`,
        "card memory samples"
      );
      b = requiredReplace(
        b,
        "    const regimeExact = new Map([...regimeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));",
        `    const cardRegime = new Map([...cardRegimeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));
    const cardAction = new Map([...cardActionRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));
    const regimeExact = new Map([...regimeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));`,
        "card memory finalized"
      );
      b = requiredReplace(
        b,
        "    const profiles = [\n      ...regimeExact.values(),",
        "    const profiles = [\n      ...cardRegime.values(),\n      ...cardAction.values(),\n      ...regimeExact.values(),",
        "card memory profiles"
      );
      b = requiredReplace(
        b,
        "      uniqueLearningEpisodes: mature,\n      regimeExact,",
        "      uniqueLearningEpisodes: mature,\n      cardRegime,\n      cardAction,\n      regimeExact,",
        "card memory cache"
      );
      b = requiredReplace(
        b,
        "    lastBrainLearningRefreshAt = now;\n    lastBrainLearningError = null;",
        "    await persistTradeMemoryProfilesV11(profiles);\n    lastBrainLearningRefreshAt = now;\n    lastBrainLearningError = null;",
        "persist trade memory"
      );
      return b;
    },
    "loadBrainLearningProfiles"
  );

  out = replaceFunctionBlock(
    out,
    "function selectBrainLearningProfile(cache, action, cardType, rating, input = null) {",
    "function applyBrainLearningToDecision(decision, profile) {",
    block => {
      let b = block;
      b = requiredReplace(
        b,
        "  const ratingBand = brainLearningRatingBand(rating);\n  const marketRegime = brainLearningMarketRegime(input);",
        `  const ratingBand = brainLearningRatingBand(rating);
  const marketRegime = brainLearningMarketRegime(input);
  const eaId = String(input?.eaId || "");

  if (eaId) {
    const byCardRegime = cache.cardRegime?.get(
      brainLearningCardRegimeKey(eaId, action, marketRegime)
    );
    if (
      byCardRegime &&
      byCardRegime.samples >= TRADE_MEMORY_CARD_REGIME_MIN_SAMPLES &&
      byCardRegime.effectiveSamples >= TRADE_MEMORY_CARD_REGIME_MIN_EFFECTIVE
    ) return byCardRegime;

    const byCardAction = cache.cardAction?.get(
      brainLearningCardActionKey(eaId, action)
    );
    if (
      byCardAction &&
      byCardAction.samples >= TRADE_MEMORY_CARD_MIN_SAMPLES &&
      byCardAction.effectiveSamples >= TRADE_MEMORY_CARD_MIN_EFFECTIVE
    ) return byCardAction;
  }`,
        "card memory selection"
      );
      return b;
    },
    "selectBrainLearningProfile"
  );

  out = replaceFunctionBlock(
    out,
    "function applyBrainLearningToDecision(decision, profile) {",
    "function baseDecisionFromQuant(quant, confluence) {",
    () => APPLY_BRAIN_LEARNING_V11_SOURCE,
    "applyBrainLearningToDecision"
  );

  out = requiredReplace(
    out,
    "  lastEvaluationSweepAt = Date.now();",
    `  lastEvaluationSweepAt = Date.now();
  // v11.0.1: next decision cycle reloads newly matured real outcomes.
  brainLearningCache.loadedAt = 0;`,
    "feedback loop invalidation"
  );

  out = requiredReplace(
    out,
    HEALTH_BRAIN_ANCHOR,
    HEALTH_BRAIN_ANCHOR + `
    tradeMemoryV11: {
      version: TRADE_MEMORY_V11_VERSION,
      enabled: dbEnabled,
      gameYear: GAME_YEAR,
      feedbackLoopActive: true,
      source: "fc_trader_brain_decisions + fc_decision_evaluations",
      targetTable: "fc_trade_memory_v11",
      cardRegimeProfiles: brainLearningCache.cardRegime?.size || 0,
      cardActionProfiles: brainLearningCache.cardAction?.size || 0,
      persistedProfiles: tradeMemoryPersistedProfilesV11,
      lastPersistedAt: tradeMemoryLastPersistedAtV11,
      lastError: tradeMemoryLastErrorV11,
      policy: {
        realMatureOutcomesOnly: true,
        episodeDeduplication: true,
        recencyWeighted: true,
        qualityWeighted: true,
        gameYearsSeparated: true,
        memoryAloneCannotTriggerBuy: true,
        repeatedBadCardHistoryCanBlockOrDelayBuy: true
      }
    },`,
    "health trade-memory"
  );

  const required = [
    'TRADE_MEMORY_V11_VERSION = "11.0.1"',
    "fc_trade_memory_v11",
    "cardRegime: new Map()",
    "cardAction: new Map()",
    "brainLearningCardRegimeKey",
    "brainLearningCardActionKey",
    "persistTradeMemoryProfilesV11",
    "AND COALESCE(NULLIF(d.input_snapshot->>'gameYear',''), '26') = $2",
    "TRADE_MEMORY_BUY_BLOCK_ACCURACY",
    "feedbackLoopActive: true",
    "brainLearningCache.loadedAt = 0;"
  ];
  const missing = required.filter(item => !out.includes(item));
  if (missing.length) throw new Error(`[v10.69.9.6.8] trade-memory patch incomplete: ${missing.join(", ")}`);
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/server.js")) {
    try {
      const source = patchServerTradeMemoryV1069968(raw);
      console.log("[v10.69.9.6.8] v11 Trade-Memory + real outcome feedback loop ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.8] Trade-Memory patch disabled: ${error?.stack || error}`);
      return result;
    }
  }
  return result;
}

export const __test = { sourceText, patchServerTradeMemoryV1069968 };
