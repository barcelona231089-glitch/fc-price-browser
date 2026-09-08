import { attachFutggDemandSignals } from './uv/src/demand.js';

export const ADAPTIVE_BRAIN_VERSION = '10.62-adaptive-market-intelligence';

const BUY_SELL_ONLY = String(process.env.FC_V1062_BUY_SELL_ONLY || 'true').trim().toLowerCase() !== 'false';
const MIN_PUBLIC_BUY_CONFIDENCE = clamp(Number(process.env.FC_V1062_MIN_BUY_CONFIDENCE || 76), 60, 95);
const MIN_PUBLIC_SELL_CONFIDENCE = clamp(Number(process.env.FC_V1062_MIN_SELL_CONFIDENCE || 75), 60, 95);
const BUY_SCORE_THRESHOLD = clamp(Number(process.env.FC_V1062_BUY_SCORE || 72), 55, 95);
const SELL_SCORE_THRESHOLD = clamp(Number(process.env.FC_V1062_SELL_SCORE || 70), 55, 95);

const LEARNING_REFRESH_MS = clamp(Number(process.env.FC_V1062_LEARNING_REFRESH_MIN || 15), 5, 180) * 60_000;
const DEMAND_REFRESH_MS = clamp(Number(process.env.FC_V1062_FUTGG_DEMAND_REFRESH_MIN || 10), 5, 60) * 60_000;
const DEMAND_CANDIDATE_LIMIT = Math.round(clamp(Number(process.env.FC_V1062_FUTGG_DEMAND_CARDS || 220), 40, 500));
const MEMORY_PERSIST_MS = clamp(Number(process.env.FC_V1062_MEMORY_PERSIST_MIN || 15), 5, 120) * 60_000;

const CPU_SAMPLE_MS = clamp(Number(process.env.FC_V1062_CPU_SAMPLE_MS || 5000), 2000, 30000);
const CPU_BUSY_PCT = clamp(Number(process.env.FC_V1062_CPU_BUSY_PCT || 8), 2, 95);
const CPU_PROTECT_PCT = Math.max(CPU_BUSY_PCT + 1, clamp(Number(process.env.FC_V1062_CPU_PROTECT_PCT || 12), 3, 100));
const CPU_RECOVER_PCT = Math.min(CPU_BUSY_PCT - 0.5, clamp(Number(process.env.FC_V1062_CPU_RECOVER_PCT || 6), 1, 90));

const FC26_START_TRANSFER_WEIGHT = clamp(Number(process.env.FC_V1062_FC26_START_WEIGHT || 0.70), 0.1, 1);
const FC26_MIN_TRANSFER_WEIGHT = clamp(Number(process.env.FC_V1062_FC26_MIN_WEIGHT || 0.25), 0.05, FC26_START_TRANSFER_WEIGHT);
const FC26_TRANSFER_DECAY_PER_DAY = clamp(Number(process.env.FC_V1062_FC26_DECAY_PER_DAY || 0.015), 0, 0.1);

const SOURCE_PRIOR_WINS = 5;
const SOURCE_PRIOR_LOSSES = 5;
const PATTERN_PRIOR_WINS = 6;
const PATTERN_PRIOR_LOSSES = 6;

const REGIME_LABELS = Object.freeze({
  CRASH: 'CRASH',
  RECOVERY: 'RECOVERY',
  SUPPLY_WAVE: 'SUPPLY-WELLE',
  SBC_FODDER_PUSH: 'SBC-FODDER-PUSH',
  PROMO_HYPE: 'PROMO-HYPE',
  CALM: 'RUHIGER MARKT',
  NORMAL: 'NORMAL'
});

const DEMAND_FIELDS = Object.freeze([
  'usagePct', 'usageAudience', 'usageVersionMatched', 'usageHitCount',
  'communityUsagePct', 'proUsagePct', 'usagePositionCount', 'usagePositions',
  'usageBestRank', 'popularityScore', 'demandEvidenceScore', 'demandDataConfidence',
  'demandEvidenceType', 'demandSource', 'momentumHit', 'momentumVersionMatched',
  'inPacksHit', 'inPacksVersionMatched', 'supplyPressureScore', 'promoMarketScore',
  'promoMarketState'
]);

let lastLearningRefreshAt = 0;
let learningInflight = null;
let lastLearningError = null;
let lastDemandRefreshAt = 0;
let demandInflight = null;
let lastDemandError = null;
let lastMemoryPersistAt = 0;
let schemaReady = false;

const sourceProfiles = new Map();
const patternProfiles = new Map();
const cardProfiles = new Map();
let learningSummary = {
  decisions: 0,
  sourceProfiles: 0,
  patternProfiles: 0,
  cardProfiles: 0,
  firstCurrentSeasonAt: null,
  currentSeasonSamples: 0,
  previousSeasonSamples: 0,
  updatedAt: null
};

const demandCache = new Map();
let demandContext = null;
let lastCycleStatus = null;

let cpuState = {
  mode: 'NORMAL',
  instantaneousPct: 0,
  ewmaPct: 0,
  busyStreak: 0,
  protectStreak: 0,
  recoverStreak: 0,
  updatedAt: new Date().toISOString()
};
let previousCpu = process.cpuUsage();
let previousCpuAt = process.hrtime.bigint();

function clamp(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizeText(...parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function actionFamily(action) {
  const text = String(action || '').toUpperCase();
  if (text.includes('VERKAUF')) return 'SELL';
  if (text.includes('KAUF') && !text.includes('NICHT')) return 'BUY';
  return 'NO_CALL';
}

function ratingBand(rating) {
  const r = Number(rating);
  if (!Number.isFinite(r)) return 'UNK';
  if (r <= 81) return '75-81';
  if (r <= 84) return '82-84';
  if (r <= 87) return '85-87';
  if (r <= 90) return '88-90';
  return '91+';
}

function cardGroup(cardType) {
  const text = String(cardType || '').toLowerCase();
  if (text.includes('special')) return 'SPECIAL';
  if (text.includes('rare')) return 'BASE_RARE';
  if (text.includes('common')) return 'BASE_COMMON';
  return 'OTHER';
}

function signalText(signal = {}) {
  return normalizeText(
    signal.source,
    signal.sourceChannel,
    signal.sourceChannelType,
    signal.category,
    signal.action,
    signal.message,
    signal.reason,
    signal.text
  ).toLowerCase();
}

function detectCatalyst(signals = [], row = null) {
  const leak = row?.aiLeakIntel || null;
  const text = normalizeText(
    ...signals.map(signalText),
    ...(Array.isArray(leak?.topics) ? leak.topics : [])
  ).toLowerCase();

  if (/(marquee[\s-]*match|top[\s-]*partien|topspiel|big[\s-]*match|derby|marquee)/i.test(text)) return 'MARQUEE_MATCHUPS';
  if (/\b(sbc|squad building|icon sbc|hero sbc|challenge)\b/i.test(text)) return 'SBC';
  if (/\b(evo|evolution|evolutions)\b/i.test(text)) return 'EVO';
  if (/\b(reward|rewards|rivals|champions|wl rewards|squad battles)\b/i.test(text)) return 'REWARDS';
  if (/\b(out[\s-]*of[\s-]*packs?|oop|leaves packs?|leaving packs?)\b/i.test(text)) return 'OUT_OF_PACKS';
  if (/\b(pack supply|lightning rounds?|store packs?|pack weight|supply)\b/i.test(text)) return 'PACK_SUPPLY';
  if (/\b(promo|futties|toty|tots|totw|future stars|fantasy|road to|rttf|rttk|shapeshifter|birthday)\b/i.test(text)) return 'PROMO';
  if (signals.length || leak?.active) return 'LEAK_OR_TRADER';
  return 'NONE';
}

function eventRelevance(row, signals = [], catalyst = 'NONE') {
  if (catalyst === 'NONE') return 0;
  const text = signals.map(signalText).join(' ');
  const dimensions = [
    row?.name, row?.club, row?.league, row?.nation, row?.rarityName
  ].filter(Boolean).map(value => String(value).toLowerCase());

  const direct = dimensions.filter(value => value.length >= 3 && text.includes(value)).length;
  if (direct >= 2) return 1;
  if (direct === 1) return 0.75;

  // Marquee Matchups should be club/league/nation specific, not a blind market-wide fodder pump.
  if (catalyst === 'MARQUEE_MATCHUPS') return 0.08;
  if (catalyst === 'SBC' && cardGroup(row?.cardType) === 'BASE_RARE' && Number(row?.overall) >= 82) return 0.45;
  if (['PROMO', 'EVO', 'OUT_OF_PACKS'].includes(catalyst) && cardGroup(row?.cardType) === 'SPECIAL') return 0.45;
  return 0.2;
}

function relevantGlobalSignalsForRow(row, activeSignals = []) {
  const out = [];
  const seen = new Set();
  for (const signal of Array.isArray(activeSignals) ? activeSignals : []) {
    const catalyst = detectCatalyst([signal], row);
    if (catalyst === 'NONE') continue;
    const relevance = eventRelevance(row, [signal], catalyst);
    const broadRelevant =
      (catalyst === 'SBC' && relevance >= 0.40) ||
      (['PROMO', 'EVO', 'OUT_OF_PACKS'].includes(catalyst) && relevance >= 0.40) ||
      (['PACK_SUPPLY', 'REWARDS'].includes(catalyst) && relevance >= 0.20);
    const specificRelevant = catalyst === 'MARQUEE_MATCHUPS' && relevance >= 0.70;
    if (!broadRelevant && !specificRelevant && relevance < 0.70) continue;
    const key = String(signal?.id || `${sourceName(signal)}|${signalText(signal)}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(signal);
  }
  return out.slice(0, 20);
}

function classifyRegime(row, marketContext = {}, signals = []) {
  const catalyst = detectCatalyst(signals, row);
  const global5 = numberOr(marketContext?.windows?.m5?.medianMove, 0);
  const global15 = numberOr(marketContext?.windows?.m15?.medianMove, 0);
  const falling = numberOr(marketContext?.windows?.m5?.fallingPct, 0);
  const rising = numberOr(marketContext?.windows?.m5?.risingPct, 0);
  const c5 = numberOr(row?.change5m, 0);
  const c15 = numberOr(row?.change15m, 0);
  const c1h = numberOr(row?.change1h, 0);
  const c24 = numberOr(row?.change24h, 0);

  if (
    (c15 <= -8 && c1h <= -6) ||
    c1h <= -12 ||
    (falling >= 72 && global15 < -2)
  ) return { regime: 'CRASH', catalyst };

  const recovery =
    (c5 > 0.5 && c15 > 0.5 && (c1h < -1.5 || c24 < -5)) ||
    (global5 > 0 && global15 > 0 && falling < 45 && c1h < 0 && c15 > 1);
  if (recovery) return { regime: 'RECOVERY', catalyst };

  if (catalyst === 'PACK_SUPPLY' || marketContext?.packSupplyActive === true) {
    return { regime: 'SUPPLY_WAVE', catalyst };
  }

  if (
    ['SBC', 'MARQUEE_MATCHUPS'].includes(catalyst) &&
    cardGroup(row?.cardType) !== 'SPECIAL' &&
    Number(row?.overall) >= 82
  ) return { regime: 'SBC_FODDER_PUSH', catalyst };

  if (
    ['PROMO', 'EVO', 'OUT_OF_PACKS'].includes(catalyst) &&
    (cardGroup(row?.cardType) === 'SPECIAL' || rising >= 58)
  ) return { regime: 'PROMO_HYPE', catalyst };

  const calm =
    Math.abs(c5) < 1 &&
    Math.abs(c15) < 2 &&
    Math.abs(c1h) < 3 &&
    Math.abs(global5) < 0.8 &&
    Math.abs(global15) < 1.5;
  return { regime: calm ? 'CALM' : 'NORMAL', catalyst };
}

function topicForSignal(signal = {}) {
  const text = signalText(signal);
  if (/marquee|top[\s-]*partien|topspiel|derby/.test(text)) return 'MARQUEE_MATCHUPS';
  if (/\bsbc\b|squad building/.test(text)) return 'SBC';
  if (/\bevo|evolution/.test(text)) return 'EVO';
  if (/promo|futties|toty|tots|totw/.test(text)) return 'PROMO';
  if (/reward|rivals|champions/.test(text)) return 'REWARDS';
  if (/pack|supply/.test(text)) return 'SUPPLY';
  if (/sell|verkauf/.test(text)) return 'SELL_CALL';
  if (/buy|kauf|invest/.test(text)) return 'BUY_CALL';
  return 'GENERAL';
}

function sourceName(signal = {}) {
  return normalizeText(signal.source, signal.author, signal.username) || 'UNKNOWN';
}

function signalDirection(signal = {}) {
  const text = signalText(signal);
  if (/\b(sell|verkauf|cash out|auscash)\b/.test(text)) return -1;
  if (/\b(buy|kauf|invest|investment|flip|entry)\b/.test(text)) return 1;
  return 0;
}

function profileAccumulator(scope, key, season) {
  return {
    scope,
    key,
    season,
    samples: 0,
    wins: 0,
    weightedWins: 0,
    weightedSamples: 0,
    outcomeTotal: 0,
    netTotal: 0,
    netCount: 0,
    firstAt: null,
    lastAt: null
  };
}

function addProfileSample(map, key, season, sample, scope) {
  const fullKey = `${season}|${key}`;
  let profile = map.get(fullKey);
  if (!profile) {
    profile = profileAccumulator(scope, key, season);
    map.set(fullKey, profile);
  }
  const weight = clamp(sample.weight ?? 1, 0.2, 3);
  profile.samples += 1;
  profile.wins += sample.win ? 1 : 0;
  profile.weightedSamples += weight;
  profile.weightedWins += sample.win ? weight : 0;
  profile.outcomeTotal += numberOr(sample.outcomeScore, 0) * weight;
  if (Number.isFinite(Number(sample.netRoi))) {
    profile.netTotal += Number(sample.netRoi) * weight;
    profile.netCount += weight;
  }
  profile.firstAt = profile.firstAt == null ? sample.at : Math.min(profile.firstAt, sample.at);
  profile.lastAt = profile.lastAt == null ? sample.at : Math.max(profile.lastAt, sample.at);
}

function finalizeProfile(profile, priorWins, priorLosses) {
  const weightedSamples = Math.max(0, numberOr(profile?.weightedSamples, 0));
  const weightedWins = Math.max(0, numberOr(profile?.weightedWins, 0));
  const posterior = (weightedWins + priorWins) / Math.max(1, weightedSamples + priorWins + priorLosses);
  return {
    ...profile,
    accuracy: Number((posterior * 100).toFixed(2)),
    rawAccuracy: profile.samples ? Number(((profile.wins / profile.samples) * 100).toFixed(2)) : 50,
    averageOutcomeScore: weightedSamples ? Number((profile.outcomeTotal / weightedSamples).toFixed(2)) : 0,
    averageNetRoi: profile.netCount ? Number((profile.netTotal / profile.netCount).toFixed(2)) : null
  };
}

function deriveLegacyRegime(input = {}) {
  const context = input?.marketContext || {};
  const c15 = numberOr(input?.change15m, 0);
  const c1h = numberOr(input?.change1h, 0);
  const c24 = numberOr(input?.change24h, 0);
  if (c1h <= -10 || c24 <= -15) return 'CRASH';
  if (c15 > 1 && c1h < -2) return 'RECOVERY';
  if (context?.packSupplyActive === true) return 'SUPPLY_WAVE';
  if (Math.abs(c15) < 2 && Math.abs(c1h) < 3) return 'CALM';
  return 'NORMAL';
}

function recordSeasonForDecision(input, fallback = '26') {
  const adaptive = input?.adaptiveV1062 || input?.adaptive || {};
  const gameYear = String(adaptive.gameYear || input?.gameYear || '').replace(/\D/g, '');
  return /^\d{2}$/.test(gameYear) ? gameYear : fallback;
}

function outcomeNetRoi(record = {}) {
  const candidates = [
    record.net_roi_1h,
    record.net_roi_6h,
    record.net_roi_24h,
    record.best_net_roi
  ].map(Number).filter(Number.isFinite);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

async function refreshLearning(pool, currentGameYear = '26', force = false) {
  if (!pool || !adaptiveV1062CpuAllows('learning')) return;
  const now = Date.now();
  if (!force && lastLearningRefreshAt && now - lastLearningRefreshAt < LEARNING_REFRESH_MS) return;
  if (learningInflight) return learningInflight;

  learningInflight = (async () => {
    const result = await pool.query(`
      SELECT
        d.ea_id::text AS ea_id,
        d.action,
        d.card_type,
        d.rating,
        d.created_at,
        d.input_snapshot,
        e.was_correct,
        e.outcome_score,
        e.net_roi_1h,
        e.net_roi_6h,
        e.net_roi_24h,
        e.best_net_roi
      FROM fc_trader_brain_decisions d
      JOIN fc_decision_evaluations e ON e.decision_id = d.id
      WHERE e.was_correct IS NOT NULL
        AND d.created_at >= NOW() - INTERVAL '390 days'
      ORDER BY d.created_at DESC
      LIMIT 5000
    `);

    sourceProfiles.clear();
    patternProfiles.clear();
    cardProfiles.clear();

    let firstCurrentSeasonAt = null;
    let currentSeasonSamples = 0;
    let previousSeasonSamples = 0;

    for (const record of result.rows) {
      const input = safeJson(record.input_snapshot, {});
      const adaptive = input?.adaptiveV1062 || input?.adaptive || {};
      const action = actionFamily(record.action);
      if (action === 'NO_CALL') continue;

      const season = recordSeasonForDecision(input, '26');
      const at = new Date(record.created_at).getTime();
      if (season === String(currentGameYear)) {
        currentSeasonSamples += 1;
        firstCurrentSeasonAt = firstCurrentSeasonAt == null ? at : Math.min(firstCurrentSeasonAt, at);
      } else {
        previousSeasonSamples += 1;
      }

      const signals = Array.isArray(input?.discordSignals) ? input.discordSignals : [];
      const regime = String(adaptive.regime || deriveLegacyRegime(input));
      const catalyst = String(adaptive.catalyst || detectCatalyst(signals));
      const group = cardGroup(record.card_type);
      const band = ratingBand(record.rating);
      const patternKey = `${action}|${regime}|${catalyst}|${group}|${band}`;
      const cardKey = `${action}|${record.ea_id}`;
      const outcomeScore = numberOr(record.outcome_score, 0);
      const win = record.was_correct === true;
      const severityWeight = clamp(0.75 + Math.abs(outcomeScore) / 120, 0.75, 1.75);
      const sample = {
        win,
        outcomeScore,
        netRoi: outcomeNetRoi(record),
        weight: severityWeight,
        at
      };

      addProfileSample(patternProfiles, patternKey, season, sample, 'PATTERN');
      addProfileSample(cardProfiles, cardKey, season, sample, 'CARD');

      for (const signal of signals) {
        const source = sourceName(signal);
        if (!source || source === 'UNKNOWN') continue;
        const topic = topicForSignal(signal);
        addProfileSample(sourceProfiles, `${source}|${topic}`, season, sample, 'SOURCE');
        addProfileSample(sourceProfiles, `${source}|*`, season, sample, 'SOURCE');
      }
    }

    for (const [key, value] of [...sourceProfiles]) sourceProfiles.set(key, finalizeProfile(value, SOURCE_PRIOR_WINS, SOURCE_PRIOR_LOSSES));
    for (const [key, value] of [...patternProfiles]) patternProfiles.set(key, finalizeProfile(value, PATTERN_PRIOR_WINS, PATTERN_PRIOR_LOSSES));
    for (const [key, value] of [...cardProfiles]) cardProfiles.set(key, finalizeProfile(value, PATTERN_PRIOR_WINS, PATTERN_PRIOR_LOSSES));

    learningSummary = {
      decisions: result.rowCount,
      sourceProfiles: sourceProfiles.size,
      patternProfiles: patternProfiles.size,
      cardProfiles: cardProfiles.size,
      firstCurrentSeasonAt: firstCurrentSeasonAt ? new Date(firstCurrentSeasonAt).toISOString() : null,
      currentSeasonSamples,
      previousSeasonSamples,
      updatedAt: new Date().toISOString()
    };
    lastLearningRefreshAt = now;
    lastLearningError = null;
  })().catch(error => {
    lastLearningError = String(error?.message || error);
  }).finally(() => {
    learningInflight = null;
  });

  return learningInflight;
}

function previousSeasonWeight(currentGameYear = '26') {
  if (String(currentGameYear) !== '27') return 1;
  const first = learningSummary.firstCurrentSeasonAt ? Date.parse(learningSummary.firstCurrentSeasonAt) : NaN;
  const days = Number.isFinite(first) ? Math.max(0, (Date.now() - first) / 86_400_000) : 0;
  return Number(Math.max(
    FC26_MIN_TRANSFER_WEIGHT,
    FC26_START_TRANSFER_WEIGHT - days * FC26_TRANSFER_DECAY_PER_DAY
  ).toFixed(3));
}

function combineSeasonProfiles(map, key, currentGameYear = '26') {
  const current = map.get(`${currentGameYear}|${key}`) || null;
  const previousSeason = String(currentGameYear) === '27' ? '26' : null;
  const previous = previousSeason ? map.get(`${previousSeason}|${key}`) || null : null;
  if (!current && !previous) return null;

  const oldWeight = previousSeasonWeight(currentGameYear);
  const entries = [
    current ? { profile: current, weight: 1 } : null,
    previous ? { profile: previous, weight: oldWeight } : null
  ].filter(Boolean);

  let weightedSamples = 0;
  let weightedAccuracy = 0;
  let weightedOutcome = 0;
  let totalBase = 0;
  for (const entry of entries) {
    const samples = Math.max(1, numberOr(entry.profile.weightedSamples, entry.profile.samples));
    const effective = samples * entry.weight;
    weightedSamples += effective;
    weightedAccuracy += numberOr(entry.profile.accuracy, 50) * effective;
    weightedOutcome += numberOr(entry.profile.averageOutcomeScore, 0) * effective;
    totalBase += numberOr(entry.profile.samples, 0) * entry.weight;
  }

  return {
    samples: Number(totalBase.toFixed(2)),
    effectiveSamples: Number(weightedSamples.toFixed(2)),
    accuracy: weightedSamples ? Number((weightedAccuracy / weightedSamples).toFixed(2)) : 50,
    averageOutcomeScore: weightedSamples ? Number((weightedOutcome / weightedSamples).toFixed(2)) : 0,
    currentSamples: current?.samples || 0,
    previousSamples: previous?.samples || 0,
    previousSeasonWeight: previous ? oldWeight : 0
  };
}

function sourceEvidence(signals = [], currentGameYear = '26') {
  let directional = 0;
  let weightTotal = 0;
  let reliableCount = 0;
  const used = [];

  for (const signal of signals) {
    const source = sourceName(signal);
    if (!source || source === 'UNKNOWN') continue;
    const topic = topicForSignal(signal);
    const topicProfile = combineSeasonProfiles(sourceProfiles, `${source}|${topic}`, currentGameYear);
    const generalProfile = combineSeasonProfiles(sourceProfiles, `${source}|*`, currentGameYear);
    const profile = topicProfile?.effectiveSamples >= 2 ? topicProfile : generalProfile;
    const accuracy = profile?.accuracy ?? 50;
    const samples = profile?.effectiveSamples ?? 0;
    const reliability = clamp(0.55 + (accuracy - 50) / 55, 0.3, 1.45);
    const direction = signalDirection(signal);
    directional += direction * reliability;
    weightTotal += reliability;
    if (samples >= 3 && accuracy >= 58) reliableCount += 1;
    used.push({
      source,
      topic,
      direction,
      reliability: Number(reliability.toFixed(2)),
      accuracy: Number(accuracy.toFixed(1)),
      samples: Number(samples.toFixed(1))
    });
  }

  return {
    netDirection: weightTotal ? directional / weightTotal : 0,
    reliableCount,
    sourceCount: used.length,
    sources: used.slice(0, 8)
  };
}

function patternEvidence(row, regime, catalyst, currentGameYear = '26', action = 'BUY') {
  const key = `${action}|${regime}|${catalyst}|${cardGroup(row?.cardType)}|${ratingBand(row?.overall)}`;
  return combineSeasonProfiles(patternProfiles, key, currentGameYear);
}

function cardMemoryEvidence(row, currentGameYear = '26', action = 'BUY') {
  return combineSeasonProfiles(cardProfiles, `${action}|${row?.eaId}`, currentGameYear);
}

function copyDemandFields(target, source) {
  for (const key of DEMAND_FIELDS) {
    if (source?.[key] !== undefined) target[key] = source[key];
  }
  return target;
}

function rowInterestScore(row = {}) {
  let score = numberOr(row.aiConfidence, 50);
  if (['JETZT KAUFEN', 'JETZT VERKAUFEN', 'VERKAUF PRÜFEN'].includes(row.aiAction)) score += 25;
  if (row.tracked) score += 18;
  score += Math.min(20, Math.abs(numberOr(row.change15m, 0)));
  if (row.aiLeakIntel?.active) score += 12;
  return score;
}

async function refreshFutggDemand(rows = []) {
  if (!adaptiveV1062CpuAllows('demand')) return;
  const now = Date.now();
  if (lastDemandRefreshAt && now - lastDemandRefreshAt < DEMAND_REFRESH_MS) return;
  if (demandInflight) return demandInflight;

  const candidates = [...rows]
    .sort((a, b) => rowInterestScore(b) - rowInterestScore(a))
    .slice(0, DEMAND_CANDIDATE_LIMIT);

  if (!candidates.length) return;

  demandInflight = (async () => {
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('FUT.GG demand refresh timeout')), 15_000);
      timer.unref?.();
    });
    const response = await Promise.race([attachFutggDemandSignals(candidates), timeout]);
    if (!Array.isArray(response?.cards)) return;

    for (const card of response.cards) {
      const key = String(card?.eaId ?? '');
      if (!key) continue;
      const data = {};
      copyDemandFields(data, card);
      demandCache.set(key, { savedAt: Date.now(), data });
    }
    demandContext = response.context || null;
    lastDemandRefreshAt = Date.now();
    lastDemandError = null;
  })().catch(error => {
    lastDemandError = String(error?.message || error);
  }).finally(() => {
    demandInflight = null;
  });

  return demandInflight;
}

function mergeDemandCache(row) {
  const cached = demandCache.get(String(row?.eaId));
  if (!cached) return row;
  if (Date.now() - cached.savedAt > Math.max(DEMAND_REFRESH_MS * 3, 45 * 60_000)) return row;
  copyDemandFields(row, cached.data);
  return row;
}

function contradictionSnapshot(row, regime) {
  const reasons = [];
  const c5 = numberOr(row?.change5m, 0);
  const c15 = numberOr(row?.change15m, 0);
  const c1h = numberOr(row?.change1h, 0);

  if (Math.abs(c5) >= 2 && Math.abs(c1h) >= 3 && Math.sign(c5) !== Math.sign(c1h)) {
    reasons.push('5m und 1h laufen gegeneinander');
  }
  if (Math.abs(c15) >= 3 && Math.abs(c1h) >= 3 && Math.sign(c15) !== Math.sign(c1h)) {
    reasons.push('15m und 1h widersprechen sich');
  }
  if (['DIVERGENCE', 'OUTLIER'].includes(String(row?.futbinCrossCheck || ''))) {
    reasons.push(`FUTBIN ${row.futbinCrossCheck}`);
  }
  if (regime === 'SUPPLY_WAVE' && c15 > 4) {
    reasons.push('kurzer Pump trotz Supply-Welle');
  }

  return {
    count: reasons.length,
    severe: String(row?.futbinCrossCheck || '') === 'OUTLIER' || reasons.length >= 3,
    reasons
  };
}

function tradeabilityBlock(row) {
  if (!Number.isFinite(Number(row?.price)) || Number(row.price) <= 0) return 'kein positiver Live-Preis';
  if (Number.isFinite(Number(row?.priceStatusCode)) && Number(row.priceStatusCode) !== 0) return `FUT.GG Status ${row.priceStatusCode}`;
  if (row?.isSbc === true) return 'SBC-Reward';
  if (row?.isObjective === true) return 'Objective-Reward';
  if (row?.isExtinct === true) return 'extinct';
  if (row?.premiumSeasonPassLevel != null || row?.standardSeasonPassLevel != null) return 'Season-Reward';
  return null;
}

function demandScore(row) {
  const evidence = numberOr(row?.demandEvidenceScore, numberOr(row?.popularityScore, 50));
  const confidence = clamp(numberOr(row?.demandDataConfidence, 50), 0, 100);
  const centered = (evidence - 50) * (confidence / 100);
  let score = clamp(centered / 5, -8, 8);
  if (row?.momentumHit) score += 3;
  return clamp(score, -10, 12);
}

function futbinScore(row) {
  const status = String(row?.futbinCrossCheck || '');
  if (status === 'MATCH' || status === 'CONFIRMED') return 5;
  if (status === 'DIVERGENCE') return -9;
  if (status === 'OUTLIER') return -20;
  if (Number.isFinite(Number(row?.futbinPrice)) && Number(row.futbinPrice) > 0) return 1.5;
  return 0;
}

function momentumScore(row) {
  const raw =
    numberOr(row?.change1m, 0) * 0.08 +
    numberOr(row?.change5m, 0) * 0.20 +
    numberOr(row?.change15m, 0) * 0.32 +
    numberOr(row?.change1h, 0) * 0.28 +
    numberOr(row?.change24h, 0) * 0.12;
  return clamp(raw * 1.6, -16, 16);
}

function regimeBuyAdjustment(regime, row, relevance) {
  if (regime === 'CRASH') return -18;
  if (regime === 'RECOVERY') return 10;
  if (regime === 'SUPPLY_WAVE') return -10;
  if (regime === 'SBC_FODDER_PUSH') return cardGroup(row?.cardType) === 'BASE_RARE' ? 7 + relevance * 6 : 1;
  if (regime === 'PROMO_HYPE') return cardGroup(row?.cardType) === 'SPECIAL' ? 5 + relevance * 5 : 1;
  if (regime === 'CALM') return -2;
  return 0;
}

function regimeSellAdjustment(regime, row) {
  if (regime === 'CRASH') return 12;
  if (regime === 'SUPPLY_WAVE') return 8;
  if (regime === 'RECOVERY') return -6;
  if (regime === 'SBC_FODDER_PUSH' && cardGroup(row?.cardType) === 'BASE_RARE') return -5;
  if (regime === 'PROMO_HYPE' && cardGroup(row?.cardType) === 'SPECIAL') return -4;
  return 0;
}

function historyAdjustment(profile, maxAbs = 12) {
  if (!profile || profile.effectiveSamples < 2) return 0;
  const accuracyAdj = (profile.accuracy - 50) * 0.35;
  const outcomeAdj = clamp(profile.averageOutcomeScore / 20, -4, 4);
  return clamp(accuracyAdj + outcomeAdj, -maxAbs, maxAbs);
}

function evidenceConfidence(score, historyProfiles, source, contradictions) {
  const history = historyProfiles.filter(Boolean);
  const samples = history.reduce((sum, p) => sum + numberOr(p.effectiveSamples, 0), 0);
  const weightedAccuracy = history.length
    ? history.reduce((sum, p) => sum + numberOr(p.accuracy, 50) * Math.max(1, numberOr(p.effectiveSamples, 1)), 0) /
      history.reduce((sum, p) => sum + Math.max(1, numberOr(p.effectiveSamples, 1)), 0)
    : 50;

  let confidence = clamp(50 + (score - 50) * 0.78, 50, 95);
  confidence += clamp((weightedAccuracy - 50) * 0.18, -7, 7);
  confidence += Math.min(5, source.reliableCount * 1.5);
  confidence -= contradictions.count * 5;

  // 90+ is earned, never cosmetic.
  if (samples < 3) confidence = Math.min(confidence, 80);
  else if (samples < 8) confidence = Math.min(confidence, 85);
  else if (weightedAccuracy < 62) confidence = Math.min(confidence, 86);
  else if (weightedAccuracy < 68) confidence = Math.min(confidence, 89);

  if (contradictions.severe) confidence = Math.min(confidence, 72);
  return {
    confidence: Math.round(clamp(confidence, 50, 95)),
    historicalSamples: Number(samples.toFixed(1)),
    historicalAccuracy: Number(weightedAccuracy.toFixed(1))
  };
}

function chooseDataNeeds(row, regime, catalyst) {
  const futgg = new Set(['liveBin', 'priceStatus', '1m', '5m', '15m', '1h', '24h', 'cardVersion', 'tradeability']);
  const futbin = new Set(['currentPrice', 'priceHistory', 'sourceCrossCheck']);

  if (['SBC_FODDER_PUSH', 'SUPPLY_WAVE'].includes(regime) || ['SBC', 'MARQUEE_MATCHUPS', 'REWARDS'].includes(catalyst)) {
    ['inPacks', 'supply', 'rating', 'club', 'league', 'nation', 'momentum'].forEach(x => futgg.add(x));
    ['salesHistory', 'soldPriceMedian', 'marketActivity', 'priceHistory'].forEach(x => futbin.add(x));
  }
  if (['PROMO_HYPE', 'RECOVERY', 'CRASH'].includes(regime) || ['PROMO', 'EVO', 'OUT_OF_PACKS'].includes(catalyst)) {
    ['mostUsed', 'communityUsage', 'proUsage', 'inPacks', 'momentum', 'popularity'].forEach(x => futgg.add(x));
    ['games', 'popularity', 'salesHistory', 'soldPriceMedian', 'marketActivity', 'priceHistory'].forEach(x => futbin.add(x));
  }

  return {
    futgg: [...futgg],
    futbin: [...futbin],
    futbinDeepDive: row?.tracked === true || catalyst !== 'NONE' || ['CRASH', 'RECOVERY', 'PROMO_HYPE', 'SBC_FODDER_PUSH'].includes(regime)
  };
}

function enrichReason(row, decision) {
  const parts = [
    `v10.62 ${REGIME_LABELS[decision.regime] || decision.regime}.`,
    decision.catalyst !== 'NONE' ? `Katalysator ${decision.catalyst}.` : null,
    decision.source.sourceCount ? `${decision.source.sourceCount} Leak/Trader-Quelle(n), ${decision.source.reliableCount} historisch belastbar.` : null,
    decision.pattern?.effectiveSamples >= 2
      ? `Ähnliche Setups ${decision.pattern.accuracy.toFixed(1)}% geglättete Trefferquote (${decision.pattern.effectiveSamples.toFixed(1)} effektiv).`
      : 'Ähnliche Setups noch mit wenig Historie.',
    decision.cardMemory?.effectiveSamples >= 2
      ? `Karten-Gedächtnis ${decision.cardMemory.accuracy.toFixed(1)}%.`
      : null,
    row?.futbinCrossCheck ? `FUTBIN ${row.futbinCrossCheck}.` : null,
    row?.demandEvidenceScore != null ? `FUT.GG Demand ${Math.round(numberOr(row.demandEvidenceScore, 50))}/100.` : null,
    decision.contradictions.count ? `Widerspruch: ${decision.contradictions.reasons.join('; ')}.` : null,
    decision.hardBlock ? `Block: ${decision.hardBlock}.` : null,
    decision.legacyBuyGuardBlock ? 'Vorheriger Strict-Buy-Guard blockiert einen öffentlichen Kauf-Call.' : null,
    decision.legacySanityBlock ? 'Alert-Sanity-Guard ist nicht sauber bestätigt.' : null
  ].filter(Boolean);

  return normalizeText(...parts).slice(0, 1800);
}

function applyDecision(row, work, context) {
  mergeDemandCache(row);
  const rowSignals = Array.isArray(work?.input?.discordSignals) ? work.input.discordSignals : [];
  const globalSignals = relevantGlobalSignalsForRow(row, context.activeSignals || []);
  const combined = [...rowSignals, ...globalSignals];
  const seenSignals = new Set();
  const signals = combined.filter(signal => {
    const key = String(signal?.id || `${sourceName(signal)}|${signalText(signal)}`);
    if (seenSignals.has(key)) return false;
    seenSignals.add(key);
    return true;
  }).slice(0, 25);
  if (work?.input && typeof work.input === 'object' && signals.length) {
    // Persist the relevant global catalyst/trader evidence with the decision snapshot.
    // This lets source reliability and FC26->FC27 pattern learning evaluate what the
    // Brain actually knew at decision time.
    work.input.discordSignals = signals;
  }
  const { regime, catalyst } = classifyRegime(row, context.marketContext, signals);
  const relevance = eventRelevance(row, signals, catalyst);
  const source = sourceEvidence(signals, context.gameYear);
  const contradictions = contradictionSnapshot(row, regime);
  const hardBlock = tradeabilityBlock(row);
  const legacyBuyGuardBlock = row?.aiBuyGuard?.blocked === true;
  const legacySanityBlock = row?.aiAlertSanity?.blocked === true || row?.aiAlertSanity?.invalidated === true;
  const patternBuy = patternEvidence(row, regime, catalyst, context.gameYear, 'BUY');
  const patternSell = patternEvidence(row, regime, catalyst, context.gameYear, 'SELL');
  const cardBuy = cardMemoryEvidence(row, context.gameYear, 'BUY');
  const cardSell = cardMemoryEvidence(row, context.gameYear, 'SELL');

  const existingAction = String(row?.aiAction || '');
  let buyScore = 50;
  buyScore += existingAction === 'JETZT KAUFEN' ? 14 : existingAction === 'NOCH WARTEN' ? 2 : existingAction === 'NICHT KAUFEN' ? -10 : existingAction.includes('VERKAUF') ? -16 : 0;
  buyScore += momentumScore(row);
  buyScore += demandScore(row);
  buyScore += regimeBuyAdjustment(regime, row, relevance);
  buyScore += clamp(source.netDirection * 10, -10, 10);
  buyScore += futbinScore(row);
  buyScore += historyAdjustment(patternBuy, 12);
  buyScore += historyAdjustment(cardBuy, 8);
  if (row?.aiLeakIntel?.active) buyScore += row.aiLeakIntel.marketReaction ? 5 * relevance : 1.5 * relevance;
  buyScore -= contradictions.count * 6;
  if (hardBlock) buyScore -= 40;
  if (legacyBuyGuardBlock) buyScore -= 24;
  if (legacySanityBlock) buyScore -= 18;
  buyScore = clamp(buyScore, 0, 100);

  let sellScore = row?.tracked ? 45 : 0;
  if (row?.tracked) {
    sellScore += existingAction === 'JETZT VERKAUFEN' ? 20 : existingAction === 'VERKAUF PRÜFEN' ? 10 : existingAction === 'JETZT KAUFEN' ? -15 : 0;
    const profit = numberOr(row?.profitPercent, 0);
    if (profit >= 15) sellScore += 14;
    else if (profit >= 8) sellScore += 8;
    else if (profit < 0) sellScore -= 4;
    if (numberOr(row?.change1m, 0) < 0 && numberOr(row?.change5m, 0) <= numberOr(row?.change15m, 0) - 1.5) sellScore += 8;
    if (Number.isFinite(Number(row?.high24h)) && Number(row.high24h) > 0 && Number(row.price) >= Number(row.high24h) * 0.97) sellScore += 7;
    sellScore += regimeSellAdjustment(regime, row);
    sellScore += clamp(-source.netDirection * 9, -9, 9);
    sellScore += historyAdjustment(patternSell, 10);
    sellScore += historyAdjustment(cardSell, 7);
    if (String(row?.futbinCrossCheck || '') === 'OUTLIER') sellScore -= 6;
    sellScore -= contradictions.count * 2;
  }
  sellScore = clamp(sellScore, 0, 100);

  const buyConf = evidenceConfidence(buyScore, [patternBuy, cardBuy], source, contradictions);
  const sellConf = evidenceConfidence(sellScore, [patternSell, cardSell], source, contradictions);
  const dataNeeds = chooseDataNeeds(row, regime, catalyst);

  let publicCall = null;
  let finalConfidence = Math.max(buyConf.confidence, sellConf.confidence);

  if (!hardBlock && !legacyBuyGuardBlock && !legacySanityBlock && buyScore >= BUY_SCORE_THRESHOLD && buyConf.confidence >= MIN_PUBLIC_BUY_CONFIDENCE && !contradictions.severe) {
    publicCall = 'BUY';
    finalConfidence = buyConf.confidence;
    row.aiAction = 'JETZT KAUFEN';
  }

  if (
    row?.tracked &&
    sellScore >= SELL_SCORE_THRESHOLD &&
    sellConf.confidence >= MIN_PUBLIC_SELL_CONFIDENCE &&
    !contradictions.severe &&
    !legacySanityBlock &&
    (publicCall !== 'BUY' || sellScore >= buyScore + 8)
  ) {
    publicCall = 'SELL';
    finalConfidence = sellConf.confidence;
    row.aiAction = 'JETZT VERKAUFEN';
  }

  if (!publicCall) {
    row.aiAction = row?.tracked ? 'HALTEN' : 'NOCH WARTEN';
    finalConfidence = Math.max(55, Math.min(82, Math.max(buyConf.confidence, sellConf.confidence)));
  }

  const selectedPattern = publicCall === 'SELL' ? patternSell : patternBuy;
  const selectedCard = publicCall === 'SELL' ? cardSell : cardBuy;
  const decision = {
    version: ADAPTIVE_BRAIN_VERSION,
    gameYear: String(context.gameYear),
    regime,
    regimeLabel: REGIME_LABELS[regime] || regime,
    catalyst,
    eventRelevance: Number(relevance.toFixed(2)),
    buyScore: Math.round(buyScore),
    sellScore: Math.round(sellScore),
    publicCall,
    publicCallAllowed: Boolean(publicCall),
    confidence: finalConfidence,
    source,
    pattern: selectedPattern,
    cardMemory: selectedCard,
    contradictions,
    hardBlock,
    legacyBuyGuardBlock,
    legacySanityBlock,
    dataNeeds,
    previousSeasonWeight: previousSeasonWeight(context.gameYear),
    cpuMode: cpuState.mode,
    evaluatedAt: new Date().toISOString()
  };

  row.aiConfidence = finalConfidence;
  row.aiMarketState = decision.regimeLabel;
  row.aiReason = enrichReason(row, decision);
  row.aiModelUsed = `${String(row.aiModelUsed || 'Quantitative Core')} + v10.62 Adaptive`;
  row.aiAdaptiveV1062 = decision;
  row.adaptivePublicCall = publicCall;
  row.adaptiveDataNeeds = dataNeeds;

  if (work?.input && typeof work.input === 'object') {
    work.input.gameYear = String(context.gameYear);
    work.input.adaptiveV1062 = {
      gameYear: String(context.gameYear),
      regime,
      catalyst,
      buyScore: decision.buyScore,
      sellScore: decision.sellScore,
      publicCall,
      sourceReliability: source.sources,
      patternAccuracy: selectedPattern?.accuracy ?? null,
      patternSamples: selectedPattern?.effectiveSamples ?? 0,
      previousSeasonWeight: decision.previousSeasonWeight,
      contradictions: contradictions.reasons,
      dataNeeds
    };
  }

  return decision;
}

async function ensureSchema(pool) {
  if (!pool || schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_v1062_cycle_memory (
      bucket_at TIMESTAMPTZ NOT NULL,
      game_year VARCHAR(2) NOT NULL,
      regime VARCHAR(64) NOT NULL,
      catalyst VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bucket_at, game_year)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_v1062_external_memory (
      id BIGSERIAL PRIMARY KEY,
      game_year VARCHAR(2) NOT NULL,
      ea_id VARCHAR(32),
      observed_at TIMESTAMPTZ NOT NULL,
      event_type VARCHAR(80),
      price INTEGER,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_v1062_external_memory_year_time
    ON fc_v1062_external_memory (game_year, observed_at DESC)
  `);
  schemaReady = true;
}

async function persistCycleMemory(pool, rows, gameYear, marketContext) {
  if (!pool || !adaptiveV1062CpuAllows('memory')) return;
  if (Date.now() - lastMemoryPersistAt < MEMORY_PERSIST_MS) return;
  lastMemoryPersistAt = Date.now();

  const counts = {};
  const catalysts = {};
  for (const row of rows) {
    const regime = row?.aiAdaptiveV1062?.regime || 'NORMAL';
    const catalyst = row?.aiAdaptiveV1062?.catalyst || 'NONE';
    counts[regime] = (counts[regime] || 0) + 1;
    catalysts[catalyst] = (catalysts[catalyst] || 0) + 1;
  }
  const regime = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'NORMAL';
  const catalyst = Object.entries(catalysts).filter(([key]) => key !== 'NONE').sort((a, b) => b[1] - a[1])[0]?.[0] || 'NONE';
  const bucket = new Date(Math.floor(Date.now() / MEMORY_PERSIST_MS) * MEMORY_PERSIST_MS);

  await pool.query(`
    INSERT INTO fc_v1062_cycle_memory (bucket_at, game_year, regime, catalyst, payload)
    VALUES ($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (bucket_at, game_year)
    DO UPDATE SET regime = EXCLUDED.regime, catalyst = EXCLUDED.catalyst, payload = EXCLUDED.payload
  `, [
    bucket.toISOString(),
    String(gameYear),
    regime,
    catalyst,
    JSON.stringify({
      regimeCounts: counts,
      catalystCounts: catalysts,
      marketContext: {
        mood: marketContext?.mood ?? null,
        packSupplyActive: marketContext?.packSupplyActive === true,
        confidence: marketContext?.confidence ?? null,
        windows: marketContext?.windows ?? null
      },
      publicCalls: {
        buy: rows.filter(row => row.adaptivePublicCall === 'BUY').length,
        sell: rows.filter(row => row.adaptivePublicCall === 'SELL').length
      },
      cpu: adaptiveV1062CpuSnapshot()
    })
  ]);
}

export async function adaptiveV1062ApplyCycle({
  rows = [],
  brainWork = new Map(),
  marketContext = {},
  ratingStats = {},
  activeSignals = [],
  gameYear = '26',
  pool = null
} = {}) {
  const startedAt = Date.now();
  const cleanRows = Array.isArray(rows) ? rows : [];

  try {
    if (pool) await ensureSchema(pool);
    await Promise.allSettled([
      refreshLearning(pool, String(gameYear), false),
      refreshFutggDemand(cleanRows)
    ]);

    for (let index = 0; index < cleanRows.length; index++) {
      const row = cleanRows[index];
      const work = brainWork?.get?.(String(row?.eaId)) || { input: { discordSignals: [] } };
      applyDecision(row, work, { gameYear: String(gameYear), marketContext, ratingStats, activeSignals });

      // Yield often enough for the CPU sampler/HA heartbeat to breathe on small hosts.
      if (index > 0 && index % 250 === 0) {
        await new Promise(resolve => setImmediate(resolve));
        if (!adaptiveV1062CpuAllows('market')) {
          for (let rest = index + 1; rest < cleanRows.length; rest++) {
            cleanRows[rest].adaptivePublicCall = null;
            cleanRows[rest].aiAction = cleanRows[rest]?.tracked ? 'HALTEN' : 'NOCH WARTEN';
            cleanRows[rest].aiReason = 'v10.62 CPU-PROTECT: Hintergrundanalyse dieses Zyklus gedrosselt; kein öffentlicher Trade-Call ohne vollständige Prüfung.';
          }
          break;
        }
      }
    }

    if (pool) {
      persistCycleMemory(pool, cleanRows, String(gameYear), marketContext).catch(() => {});
    }

    const regimeCounts = {};
    for (const row of cleanRows) {
      const regime = row?.aiAdaptiveV1062?.regime || 'NORMAL';
      regimeCounts[regime] = (regimeCounts[regime] || 0) + 1;
    }

    lastCycleStatus = {
      ok: true,
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      rows: cleanRows.length,
      publicBuy: cleanRows.filter(row => row.adaptivePublicCall === 'BUY').length,
      publicSell: cleanRows.filter(row => row.adaptivePublicCall === 'SELL').length,
      internalNoCall: cleanRows.filter(row => !row.adaptivePublicCall).length,
      regimeCounts,
      cpuMode: cpuState.mode
    };
    return lastCycleStatus;
  } catch (error) {
    lastCycleStatus = {
      ok: false,
      at: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: String(error?.message || error)
    };
    return lastCycleStatus;
  }
}


export function adaptiveV1062RecalibrateCachedRow(row, work, {
  gameYear = '26',
  marketContext = {}
} = {}) {
  try {
    return applyDecision(row, work || { input: { discordSignals: [] } }, {
      gameYear: String(gameYear),
      marketContext
    });
  } catch {
    return null;
  }
}

export async function adaptiveV1062RecalibrateRow(row, work, {
  gameYear = '26',
  pool = null,
  marketContext = {}
} = {}) {
  try {
    await refreshLearning(pool, String(gameYear), false);
    return applyDecision(row, work || { input: { discordSignals: [] } }, {
      gameYear: String(gameYear),
      marketContext
    });
  } catch {
    return null;
  }
}

export function adaptiveV1062NeedsFutbinDeepDive(row) {
  if (!row) return false;
  if (row?.adaptiveDataNeeds?.futbinDeepDive === true) return true;
  if (row?.tracked === true) return true;
  const score = Math.max(numberOr(row?.aiAdaptiveV1062?.buyScore, 0), numberOr(row?.aiAdaptiveV1062?.sellScore, 0));
  return score >= 64 || row?.aiLeakIntel?.active === true;
}

export function adaptiveV1062DiscordPayloadAllowed(payload) {
  if (!BUY_SELL_ONLY) return true;
  const embed = Array.isArray(payload?.embeds) ? payload.embeds[0] : null;
  const title = String(embed?.title || '');
  const description = String(embed?.description || '');
  const text = `${title} ${description}`;

  // Final public trade calls.
  if (/^🟢\s*KAUFEN\b/i.test(title)) return true;
  if (/^🔴\s*VERKAUFEN\b/i.test(title)) return true;

  // Discord is intentionally strict: only final BUY / SELL calls are public.
  // Health, HA, source, startup and error notices remain internal in Hostless logs.
  return false;
}

export function adaptiveV1062CpuAllows(task = 'market') {
  const kind = String(task || 'market').toLowerCase();
  if (['ha', 'discord', 'leaks', 'health'].includes(kind)) return true;
  if (cpuState.mode === 'PROTECT') return false;
  if (cpuState.mode === 'BUSY' && ['metadata', 'learning', 'memory', 'demand', 'archive'].includes(kind)) return false;
  return true;
}

export function adaptiveV1062CpuSnapshot() {
  return {
    ...cpuState,
    thresholds: {
      busyPct: CPU_BUSY_PCT,
      protectPct: CPU_PROTECT_PCT,
      recoverPct: CPU_RECOVER_PCT,
      sampleMs: CPU_SAMPLE_MS
    }
  };
}

function sampleCpu() {
  const nowUsage = process.cpuUsage();
  const nowAt = process.hrtime.bigint();
  const wallMicros = Number(nowAt - previousCpuAt) / 1000;
  const usedMicros =
    Math.max(0, nowUsage.user - previousCpu.user) +
    Math.max(0, nowUsage.system - previousCpu.system);
  previousCpu = nowUsage;
  previousCpuAt = nowAt;
  if (!Number.isFinite(wallMicros) || wallMicros <= 0) return;

  const pct = clamp((usedMicros / wallMicros) * 100, 0, 400);
  const ewma = cpuState.updatedAt ? cpuState.ewmaPct * 0.72 + pct * 0.28 : pct;

  let busyStreak = pct >= CPU_BUSY_PCT ? cpuState.busyStreak + 1 : 0;
  let protectStreak = pct >= CPU_PROTECT_PCT ? cpuState.protectStreak + 1 : 0;
  let recoverStreak = pct <= CPU_RECOVER_PCT ? cpuState.recoverStreak + 1 : 0;
  let mode = cpuState.mode;

  if (protectStreak >= 2 || ewma >= CPU_PROTECT_PCT) mode = 'PROTECT';
  else if (busyStreak >= 2 || ewma >= CPU_BUSY_PCT) mode = 'BUSY';
  else if (recoverStreak >= 3 || ewma < CPU_BUSY_PCT * 0.75) mode = 'NORMAL';

  cpuState = {
    mode,
    instantaneousPct: Number(pct.toFixed(2)),
    ewmaPct: Number(ewma.toFixed(2)),
    busyStreak,
    protectStreak,
    recoverStreak,
    updatedAt: new Date().toISOString()
  };
}

const cpuTimer = setInterval(sampleCpu, CPU_SAMPLE_MS);
cpuTimer.unref?.();

export async function adaptiveV1062ImportSeasonMemory({
  pool,
  gameYear = '26',
  records = []
} = {}) {
  if (!pool) throw new Error('PostgreSQL ist fuer Season Memory erforderlich.');
  await ensureSchema(pool);
  const clean = Array.isArray(records) ? records.slice(0, 5000) : [];
  if (!clean.length) return { ok: true, inserted: 0 };

  let inserted = 0;
  for (let offset = 0; offset < clean.length; offset += 250) {
    const batch = clean.slice(offset, offset + 250);
    const values = [];
    const params = [];
    let p = 1;
    for (const record of batch) {
      const at = new Date(record?.observedAt || record?.timestamp || record?.at || Date.now());
      if (!Number.isFinite(at.getTime())) continue;
      const price = Number(record?.price);
      params.push(
        String(record?.gameYear || gameYear).replace(/\D/g, '').slice(-2) || '26',
        record?.eaId == null ? null : String(record.eaId),
        at.toISOString(),
        String(record?.eventType || record?.type || 'MARKET').slice(0, 80),
        Number.isFinite(price) && price > 0 ? Math.round(price) : null,
        JSON.stringify(record?.payload && typeof record.payload === 'object' ? record.payload : record)
      );
      values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++}::jsonb)`);
    }
    if (!values.length) continue;
    const result = await pool.query(`
      INSERT INTO fc_v1062_external_memory
        (game_year, ea_id, observed_at, event_type, price, payload)
      VALUES ${values.join(',')}
    `, params);
    inserted += result.rowCount || 0;
    if (!adaptiveV1062CpuAllows('archive')) break;
  }

  return { ok: true, inserted, requested: clean.length };
}

export async function adaptiveV1062Status({ pool = null, gameYear = '26' } = {}) {
  if (pool) {
    try {
      await ensureSchema(pool);
      await refreshLearning(pool, String(gameYear), false);
    } catch {}
  }

  let externalMemoryCount = null;
  let cycleMemoryCount = null;
  if (pool) {
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM fc_v1062_external_memory) AS external_count,
          (SELECT COUNT(*)::int FROM fc_v1062_cycle_memory) AS cycle_count
      `);
      externalMemoryCount = result.rows?.[0]?.external_count ?? null;
      cycleMemoryCount = result.rows?.[0]?.cycle_count ?? null;
    } catch {}
  }

  const topSources = [...sourceProfiles.values()]
    .filter(profile => profile.samples >= 2)
    .sort((a, b) => b.samples - a.samples || b.accuracy - a.accuracy)
    .slice(0, 20)
    .map(profile => ({
      season: profile.season,
      key: profile.key,
      samples: profile.samples,
      accuracy: profile.accuracy,
      averageOutcomeScore: profile.averageOutcomeScore
    }));

  return {
    ok: true,
    version: ADAPTIVE_BRAIN_VERSION,
    gameYear: String(gameYear),
    outputMode: BUY_SELL_ONLY ? 'PUBLIC_BUY_SELL_ONLY_INTERNAL_NO_CALL' : 'LEGACY_MIXED',
    marketRegimes: Object.values(REGIME_LABELS),
    cpuGovernor: adaptiveV1062CpuSnapshot(),
    learning: {
      ...learningSummary,
      lastError: lastLearningError,
      previousSeasonWeight: previousSeasonWeight(String(gameYear)),
      fc26TransferLearning: true,
      sourceReliabilityLearning: true,
      cardMemory: true,
      patternMemory: true
    },
    dataIntelligence: {
      futggDemandRefreshMinutes: Math.round(DEMAND_REFRESH_MS / 60_000),
      futggDemandCacheCards: demandCache.size,
      futggDemandContext: demandContext,
      futggDemandLastError: lastDemandError,
      futbinDeepDiveAdaptive: true,
      authorizedDataOnly: true
    },
    seasonMemory: {
      externalMemoryCount,
      cycleMemoryCount,
      note: 'Bestehende PostgreSQL-Historie wird genutzt. Fehlende alte FC26-Snapshots werden nicht erfunden; ein autorisiertes Archiv kann ueber den Import-Endpunkt nachgeladen werden.'
    },
    topSourceProfiles: topSources,
    lastCycle: lastCycleStatus
  };
}
