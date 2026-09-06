import { clamp } from './utils.js';
import { outcomeQualityGuard } from './outcomeLearning.js';
import { maxAffordablePortfolioCount } from './uvEngine.js';

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function historyEvidence(card = {}) {
  const samples = Math.max(0, finite(card?.history?.samples, 0));
  return clamp(samples / 12, 0, 1) * 100;
}


function isBaseCommon(card = {}) {
  const cardType = String(card?.cardType || '').toLowerCase();
  const rarity = `${card?.rarityName || ''} ${card?.rarityGroupName || ''}`.toLowerCase();
  return cardType === 'base common' || rarity.includes('non-rare') || rarity.includes('common');
}

function hasVerifiedDemandEvidence(card = {}) {
  const games = finite(card?.futbinGamesCount, null);
  const popularRank = finite(card?.futbinPopularRank, null);
  const soldSamples = Math.max(0, finite(card?.futbinSoldSampleCount, 0));
  const communityUsage = finite(card?.communityUsagePct, null);
  const proUsage = finite(card?.proUsagePct, null);
  const usagePct = finite(card?.usagePct, null);
  const popularity = finite(card?.gameplayDemandScore, finite(card?.popularityScore, null));
  const demandConfidence = finite(card?.demandDataConfidence, 0);
  const feedbackSamples = Math.max(0, finite(card?.reportedFeedbackSamples, 0));
  const sellRate = finite(card?.reportedSellRate, null);

  return Boolean(
    (games != null && games >= 250000) ||
    (popularRank != null && popularRank > 0 && popularRank <= 500) ||
    soldSamples >= 3 ||
    (communityUsage != null && communityUsage > 0) ||
    (proUsage != null && proUsage > 0) ||
    (usagePct != null && usagePct > 0) ||
    card?.momentumHit === true ||
    (popularity != null && popularity >= 72 && demandConfidence >= 55) ||
    (feedbackSamples >= 4 && sellRate != null && sellRate >= 0.60)
  );
}


export function minimumRatingForBudget(budget, count = 100) {
  const total = Number(budget);
  const slots = Math.max(1, Number(count) || 100);
  if (!Number.isFinite(total) || total <= 0) return null;
  const ideal = total / slots;
  if (ideal < 800) return 78;
  if (ideal < 1500) return 80;
  if (ideal < 2500) return 81;
  if (ideal < 5000) return 82;
  if (ideal < 10000) return 83;
  return 84;
}

export function seasonPhaseForGameYear(gameYear, now = new Date()) {
  const gy = Number(gameYear);
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(gy) || Number.isNaN(date.getTime())) return 'UNKNOWN';

  // FCxx launches in the previous calendar year and runs into the calendar
  // year represented by xx. Example: FC26 runs Sep 2025 -> Sep 2026.
  const cycleEndYear = 2000 + gy;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  if (year < cycleEndYear) return 'EARLY';
  if (year > cycleEndYear) return 'ENDGAME';
  if (month <= 2) return 'MID';
  if (month <= 5) return 'MATURE';
  if (month <= 7) return 'LATE';
  return 'ENDGAME';
}

function isSpecialCard(card = {}) {
  return String(card?.cardType || '').toLowerCase() === 'special';
}

function hasStrongVerifiedDemandEvidence(card = {}) {
  const games = finite(card?.futbinGamesCount, null);
  const popularRank = finite(card?.futbinPopularRank, null);
  const soldSamples = Math.max(0, finite(card?.futbinSoldSampleCount, 0));
  const communityUsage = finite(card?.communityUsagePct, null);
  const proUsage = finite(card?.proUsagePct, null);
  const usagePct = finite(card?.usagePct, null);
  const popularity = finite(card?.gameplayDemandScore, finite(card?.popularityScore, null));
  const demandConfidence = finite(card?.demandDataConfidence, 0);
  const feedbackSamples = Math.max(0, finite(card?.reportedFeedbackSamples, 0));
  const sellRate = finite(card?.reportedSellRate, null);

  return Boolean(
    (games != null && games >= 1_000_000) ||
    (popularRank != null && popularRank > 0 && popularRank <= 200) ||
    soldSamples >= 5 ||
    (communityUsage != null && communityUsage >= 2.5) ||
    (proUsage != null && proUsage >= 1) ||
    (usagePct != null && usagePct >= 3) ||
    (card?.momentumHit === true && popularity != null && popularity >= 78) ||
    (popularity != null && popularity >= 82 && demandConfidence >= 65) ||
    (feedbackSamples >= 6 && sellRate != null && sellRate >= 0.65)
  );
}


function passesNormalRatingFloor(card = {}) {
  const overall = finite(card?.overall, null);
  if (overall == null || overall >= 82) return true;
  // v2.3.5: normal/base cards below 82 never enter ÜV just because they are
  // cheap. A sub-82 Special is an exception only with strong verified demand.
  return isSpecialCard(card) && hasStrongVerifiedDemandEvidence(card);
}

function percentile(values = [], q = 0.5) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const pos = Math.max(0, Math.min(rows.length - 1, (rows.length - 1) * q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return rows[lo];
  const w = pos - lo;
  return rows[lo] * (1 - w) + rows[hi] * w;
}

function adaptiveLiquidityScore(card = {}) {
  const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
  const sale = finite(card?.saleLikelihoodIndex, 50);
  const trade = finite(card?.tradeQualityScore, 50);
  const demandConfidence = finite(card?.demandDataConfidence, 40);
  const confidence = finite(card?.confidenceScore, 45);
  const games = finite(card?.futbinGamesScore, 50);
  const sales = finite(card?.futbinSalesEvidenceScore, 50);
  const outcome = finite(card?.reportedOutcomeScore, 50);
  const repeatability = finite(card?.repeatabilityScore, 50);
  const activity = finite(card?.priceActivityScore, 50);
  const trend = finite(card?.trendScore, 50);
  const risk = finite(card?.riskPenalty, 0);
  const capitalLock = finite(card?.capitalLockRisk, 0);
  const popularRank = finite(card?.futbinPopularRank, null);
  const popularRankBoost = popularRank != null && popularRank > 0
    ? (popularRank <= 100 ? 7 : popularRank <= 250 ? 5 : popularRank <= 500 ? 3 : 0)
    : 0;
  const momentumBoost = card?.momentumHit === true ? 5 : 0;
  return clamp(
    gameplay * 0.17 +
    sale * 0.16 +
    trade * 0.13 +
    repeatability * 0.07 +
    demandConfidence * 0.055 +
    confidence * 0.04 +
    games * 0.10 +
    sales * 0.10 +
    outcome * 0.055 +
    activity * 0.05 +
    trend * 0.035 +
    finite(card?.promoMarketScore, 50) * 0.045 +
    popularRankBoost + momentumBoost -
    risk * 0.58 -
    capitalLock * 0.055,
    0,
    100
  );
}

function adaptiveBudgetPrice(card = {}) {
  return finite(card?.buyPrice, finite(card?.recommendedBuyPrice, finite(card?.price, null)));
}

function hasAdaptiveRelaxationEvidence(card = {}, ratingGap = 1, mode = 'STRICT') {
  const liquid = adaptiveLiquidityScore(card);
  const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
  const sale = finite(card?.saleLikelihoodIndex, 50);
  const trade = finite(card?.tradeQualityScore, 50);
  const demandConfidence = finite(card?.demandDataConfidence, 40);
  const repeatability = finite(card?.repeatabilityScore, 50);
  const selection = finite(card?.selectionScore, 50);
  const activity = finite(card?.priceActivityScore, 50);
  const trend = finite(card?.trendScore, 50);
  const verified = hasVerifiedDemandEvidence(card);
  const strong = hasStrongVerifiedDemandEvidence(card);
  const normalizedMode = String(mode || 'STRICT').toUpperCase();
  // v2.3.1: the adaptive policy used BALANCED thresholds while the final gate
  // later received the label DEMAND_SELLABILITY_100 and silently fell back to
  // STRICT. That estimator/gate mismatch could say 100 slots were feasible but
  // leave only ~half of them after the real candidate gate. Treat the live
  // sellability mode as BALANCED, and reserve FEASIBILITY for a deeper but still
  // demand/liquidity-gated fallback.
  const balancedMode = normalizedMode === 'BALANCED' || normalizedMode === 'DEMAND_SELLABILITY_100';
  const feasibilityMode = normalizedMode === 'FEASIBILITY' || normalizedMode === 'SELLABILITY_FEASIBILITY';

  if (strong) return true;
  if (verified && liquid >= (feasibilityMode ? 54 : balancedMode ? 62 : 68)) return true;

  // FUTBIN Games/Sales are optional. When those structured fields are missing,
  // live FUT.GG demand + sale-likelihood + trade-quality + repeatability may
  // still prove that a cheaper card is liquid enough for a 100-slot portfolio.
  if (feasibilityMode) {
    // Live-market fallback for hosts where FUTBIN is not configured: require a
    // coherent combination of gameplay/popularity, sale-likelihood, trade
    // quality, selection score, price activity and non-negative trend. This is
    // deliberately stricter than a plain rating fill and still rejects dead
    // low-demand cards.
    const liveComposite = gameplay >= 58 && sale >= 55 && trade >= 50 && selection >= 60 && activity >= 60 && trend >= 50 && repeatability >= 47;
    if (liveComposite) return true;
    if (ratingGap <= 2) {
      return gameplay >= 58 && sale >= 56 && trade >= 52 && liquid >= 56 && demandConfidence >= 28 && repeatability >= 47;
    }
    return gameplay >= 60 && sale >= 56 && trade >= 52 && liquid >= 57 && demandConfidence >= 30 && repeatability >= 48;
  }

  if (balancedMode) {
    if (ratingGap <= 1) {
      return gameplay >= 64 && sale >= 62 && trade >= 56 && liquid >= 62 && demandConfidence >= 38 && repeatability >= 52;
    }
    return gameplay >= 70 && sale >= 66 && trade >= 60 && liquid >= 66 && demandConfidence >= 42 && repeatability >= 55;
  }

  if (ratingGap <= 1) {
    return gameplay >= 72 && sale >= 68 && trade >= 62 && liquid >= 68 && demandConfidence >= 48 && repeatability >= 56;
  }
  return gameplay >= 78 && sale >= 72 && trade >= 66 && liquid >= 72 && demandConfidence >= 52 && repeatability >= 60;
}

function roughAdaptiveSafety(card = {}) {
  const price = adaptiveBudgetPrice(card);
  const risk = finite(card?.riskPenalty, 0);
  const trend = finite(card?.historyTrendPct, 0);
  const sourceDiff = finite(card?.sourceDiffPct, null);
  const tradeQuality = finite(card?.tradeQualityScore, 50);
  const selection = finite(card?.selectionScore, 50);
  if (price == null || price <= 0) return false;
  if (isBronzeCard(card)) return false;
  if (!passesNormalRatingFloor(card)) return false;
  if (risk >= 24 || trend < -10 || tradeQuality < 42 || selection < 39) return false;
  if (sourceDiff != null && Math.abs(sourceDiff) > 25) return false;
  if (card?.qualityEligible === false && tradeQuality < 47) return false;
  const overall = finite(card?.overall, null);
  if (isBaseCommon(card) && overall != null && overall <= 82) return false;
  if (isBaseCommon(card) && overall != null && overall >= 83 && overall <= 84 && !hasVerifiedDemandEvidence(card)) return false;
  return true;
}


function allocatorAwareFeasibility(cards = [], budget, count = 100) {
  const structural = estimateAffordablePortfolio(cards, count, 2, 3);
  const allocator = maxAffordablePortfolioCount(cards, Number(budget), count);
  return {
    ...structural,
    allocatorSlots: Number(allocator?.count || 0),
    allocatorMinimumSpend: Number(allocator?.minimumSpend || 0),
    allocatorRepeatMode: Boolean(allocator?.repeatMode),
    allocatorFeasible: Number(allocator?.count || 0) >= count
  };
}

/**
 * v2.3.2 hard-100 portfolio fallback.
 *
 * The normal candidate gate remains the first choice. If that gate leaves too
 * few affordable cards, this ladder may re-admit cards that were blocked ONLY
 * by the dynamic rating/demand floor, provided the live sellability evidence is
 * still coherent. It never bypasses the true safety blocks: Bronze, weak
 * low-rated Non-Rare, severe risk, price-source divergence, price crashes, weak
 * trade quality or clearly bad reported outcomes.
 *
 * This matters for 300k / 100 portfolios late in the FC cycle: rating is no
 * longer a useful proxy for liquidity by itself. A cheap 82+ Rare with strong
 * FUT.GG usage/popularity, healthy price activity/trend and sale-likelihood can
 * be a better manual ÜV card than an expensive 90+ that consumes four slots of
 * budget.
 */
export function buildHard100SellabilityFallback(cards = [], { budget, count = 100 } = {}) {
  const totalBudget = Number(budget);
  const targetCount = Math.max(1, Math.floor(Number(count) || 100));
  const ideal = Number.isFinite(totalBudget) && totalBudget > 0 ? totalBudget / targetCount : 3000;
  const source = Array.isArray(cards) ? cards : [];

  const hardSafetyEligible = card => {
    const price = adaptiveBudgetPrice(card);
    const risk = finite(card?.riskPenalty, 0);
    const historyTrend = finite(card?.historyTrendPct, 0);
    const sourceDiff = finite(card?.sourceDiffPct, null);
    const trade = finite(card?.tradeQualityScore, 50);
    const selection = finite(card?.selectionScore, 50);
    const overall = finite(card?.overall, null);
    const outcomeDecision = String(card?.reportedOutcomeDecision || '').toUpperCase();
    if (price == null || price <= 0) return false;
    if (isBronzeCard(card)) return false;
    if (!passesNormalRatingFloor(card)) return false;
    if (isBaseCommon(card) && overall != null && overall <= 82) return false;
    if (isBaseCommon(card) && overall != null && overall >= 83 && overall <= 84 && !hasVerifiedDemandEvidence(card)) return false;
    if (risk >= 24 || historyTrend < -10 || trade < 42 || selection < 39) return false;
    if (sourceDiff != null && Math.abs(sourceDiff) > 25) return false;
    if (card?.qualityEligible === false && trade < 47) return false;
    if (outcomeDecision === 'REJECT') return false;
    return true;
  };

  const stages = [
    {
      name: 'SELLABILITY_STRICT',
      pass: card => {
        const sell = finite(card?.sellabilityScore, adaptiveLiquidityScore(card));
        const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
        const sale = finite(card?.saleLikelihoodIndex, 50);
        const trade = finite(card?.tradeQualityScore, 50);
        const repeat = finite(card?.repeatabilityScore, 50);
        const activity = finite(card?.priceActivityScore, 50);
        const trend = finite(card?.trendScore, 50);
        const selection = finite(card?.selectionScore, 50);
        return (hasVerifiedDemandEvidence(card) || gameplay >= 66 || card?.momentumHit === true) &&
          sell >= 58 && sale >= 55 && trade >= 48 && repeat >= 48 && activity >= 52 && trend >= 47 && selection >= 47;
      }
    },
    {
      name: 'SELLABILITY_BALANCED',
      pass: card => {
        const sell = finite(card?.sellabilityScore, adaptiveLiquidityScore(card));
        const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
        const sale = finite(card?.saleLikelihoodIndex, 50);
        const trade = finite(card?.tradeQualityScore, 50);
        const repeat = finite(card?.repeatabilityScore, 50);
        const activity = finite(card?.priceActivityScore, 50);
        const trend = finite(card?.trendScore, 50);
        const selection = finite(card?.selectionScore, 50);
        const coherentLiveDemand = gameplay >= 58 && sale >= 52 && activity >= 50 && trend >= 44;
        return (hasVerifiedDemandEvidence(card) || coherentLiveDemand || card?.momentumHit === true) &&
          sell >= 53 && trade >= 45 && repeat >= 45 && selection >= 43;
      }
    },
    {
      name: 'SELLABILITY_BUDGET_FILL',
      pass: card => {
        const sell = finite(card?.sellabilityScore, adaptiveLiquidityScore(card));
        const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
        const sale = finite(card?.saleLikelihoodIndex, 50);
        const trade = finite(card?.tradeQualityScore, 50);
        const repeat = finite(card?.repeatabilityScore, 50);
        const activity = finite(card?.priceActivityScore, 50);
        const trend = finite(card?.trendScore, 50);
        const selection = finite(card?.selectionScore, 50);
        const confidence = finite(card?.demandDataConfidence, 40);
        // Final fill still needs a coherent market story. No dead fodder: at
        // least demand/popularity + sale-likelihood + active/non-negative market.
        const liveDemand = gameplay >= 54 && sale >= 50 && activity >= 47 && trend >= 42 && confidence >= 24;
        return (hasVerifiedDemandEvidence(card) || liveDemand || (card?.momentumHit === true && gameplay >= 52)) &&
          sell >= 49 && trade >= 42 && repeat >= 43 && selection >= 40;
      }
    }
  ];

  let accumulated = [];
  let chosenStage = null;
  let estimate = { slots: 0, minimumCost: null, uniqueCards: 0 };
  const diagnostics = [];
  const seen = new Set();

  for (const stage of stages) {
    const additions = source
      .filter(hardSafetyEligible)
      .filter(stage.pass)
      // The optimizer may still use expensive liquid cards, but the fallback
      // should preferentially deepen the affordable half of the universe.
      .sort((a, b) => {
        const aCost = adaptiveBudgetPrice(a) || ideal;
        const bCost = adaptiveBudgetPrice(b) || ideal;
        const aSell = finite(a?.sellabilityScore, adaptiveLiquidityScore(a));
        const bSell = finite(b?.sellabilityScore, adaptiveLiquidityScore(b));
        const aValue = aSell - Math.max(0, Math.log(Math.max(1, aCost) / Math.max(1, ideal))) * 7;
        const bValue = bSell - Math.max(0, Math.log(Math.max(1, bCost) / Math.max(1, ideal))) * 7;
        return bValue - aValue || aCost - bCost;
      });

    for (const card of additions) {
      const key = String(card?.eaId ?? `${card?.name || 'unknown'}|${card?.overall || ''}|${card?.version || ''}`);
      if (seen.has(key)) continue;
      seen.add(key);
      accumulated.push({ ...card, hard100FallbackStage: stage.name, hard100RatingBypass: Boolean(card?.budgetRatingBlocked || card?.marketRatingBlocked || card?.demandRelaxationBlocked) });
    }

    estimate = allocatorAwareFeasibility(accumulated, totalBudget, targetCount);
    diagnostics.push({ stage: stage.name, uniqueCards: estimate.uniqueCards, slots: estimate.slots, minimumCost: estimate.minimumCost, allocatorSlots: estimate.allocatorSlots, allocatorMinimumSpend: estimate.allocatorMinimumSpend });
    chosenStage = stage.name;
    // v2.7.1: structural 100 is not enough. The reserve/fallback may contain
    // many cheap 82/83 normals that the endgame portfolio mix correctly caps.
    // Continue widening until the REAL allocator can also form 100 slots.
    if (estimate.allocatorFeasible && (!Number.isFinite(totalBudget) || estimate.allocatorMinimumSpend <= totalBudget)) break;
  }

  return {
    pool: accumulated,
    stage: chosenStage,
    slots: estimate.slots,
    minimumCost: estimate.minimumCost,
    uniqueCards: estimate.uniqueCards,
    allocatorSlots: Number(estimate.allocatorSlots || 0),
    allocatorMinimumSpend: Number(estimate.allocatorMinimumSpend || 0),
    budgetFeasible: Boolean(estimate.allocatorFeasible) && Number.isFinite(totalBudget) && Number(estimate.allocatorMinimumSpend || 0) <= totalBudget,
    diagnostics
  };
}


/**
 * v2.3.5 budget-adaptive hard-100 fallback with normal-card 82 floor.
 *
 * The previous sellability ladder could still leave a mathematically impossible
 * 300k/100 pool because its absolute quality thresholds were tuned around the
 * expensive endgame market. This second fallback starts from the user's capital
 * per slot (budget / count) and asks a different question: which cheaper cards
 * still have a coherent live-market resale story?
 *
 * Rating and the ordinary selection score are allowed to become secondary here,
 * because they can be depressed by the late-cycle rating proxy itself. Safety is
 * not optional: Bronze, weak low-rated Non-Rare, severe risk/source divergence,
 * price crashes and clearly bad reported outcomes remain blocked. The final
 * stages still require multiple demand/liquidity signals, so this is not a fodder
 * filler mode.
 */
export function buildBudgetAdaptiveSellabilityFallback(cards = [], { budget, count = 100 } = {}) {
  const totalBudget = Number(budget);
  const targetCount = Math.max(1, Math.floor(Number(count) || 100));
  const ideal = Number.isFinite(totalBudget) && totalBudget > 0 ? totalBudget / targetCount : 3000;
  const source = Array.isArray(cards) ? cards : [];

  const evidence = card => {
    const price = adaptiveBudgetPrice(card);
    const sell = finite(card?.sellabilityScore, adaptiveLiquidityScore(card));
    const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
    const sale = finite(card?.saleLikelihoodIndex, 50);
    const trade = finite(card?.tradeQualityScore, 50);
    const repeat = finite(card?.repeatabilityScore, 50);
    const activity = finite(card?.priceActivityScore, 50);
    const trend = finite(card?.trendScore, 50);
    const demandConfidence = finite(card?.demandDataConfidence, 40);
    const confidence = finite(card?.confidenceScore, 45);
    const outcome = finite(card?.reportedOutcomeScore, 50);
    const popularRank = finite(card?.futbinPopularRank, null);
    const games = finite(card?.futbinGamesCount, null);
    const soldSamples = Math.max(0, finite(card?.futbinSoldSampleCount, 0));
    const usage = Math.max(
      0,
      finite(card?.usagePct, 0),
      finite(card?.communityUsagePct, 0),
      finite(card?.proUsagePct, 0)
    );
    const verified = hasVerifiedDemandEvidence(card);
    const strong = hasStrongVerifiedDemandEvidence(card);
    const priceRatio = Number.isFinite(price) && ideal > 0 ? price / ideal : Infinity;
    const priceFit = Number.isFinite(priceRatio) && priceRatio > 0
      ? clamp(100 - Math.abs(Math.log(priceRatio)) * 42, 0, 100)
      : 0;

    let liveSignals = 0;
    if (verified) liveSignals += 2;
    if (gameplay >= 50) liveSignals += 1;
    if (sale >= 48) liveSignals += 1;
    if (activity >= 46) liveSignals += 1;
    if (trend >= 42) liveSignals += 1;
    if (repeat >= 40) liveSignals += 1;
    if (card?.momentumHit === true) liveSignals += 2;
    if (usage > 0) liveSignals += 2;
    if (popularRank != null && popularRank > 0 && popularRank <= 750) liveSignals += 2;
    if (games != null && games >= 100000) liveSignals += 2;
    if (soldSamples >= 2) liveSignals += 2;

    const score = clamp(
      sell * 0.18 +
      gameplay * 0.15 +
      sale * 0.16 +
      trade * 0.12 +
      repeat * 0.075 +
      activity * 0.10 +
      trend * 0.07 +
      demandConfidence * 0.055 +
      confidence * 0.035 +
      outcome * 0.035 +
      priceFit * 0.095 +
      Math.min(12, liveSignals * 1.35),
      0,
      100
    );

    return {
      price, priceRatio, priceFit, sell, gameplay, sale, trade, repeat, activity, trend,
      demandConfidence, confidence, outcome, popularRank, games, soldSamples, usage,
      verified, strong, liveSignals, score
    };
  };

  const hardSafetyEligible = card => {
    const e = evidence(card);
    const risk = finite(card?.riskPenalty, 0);
    const historyTrend = finite(card?.historyTrendPct, 0);
    const sourceDiff = finite(card?.sourceDiffPct, null);
    const overall = finite(card?.overall, null);
    const outcomeDecision = String(card?.reportedOutcomeDecision || '').toUpperCase();
    if (!Number.isFinite(e.price) || e.price <= 0) return false;
    if (isBronzeCard(card)) return false;
    if (!passesNormalRatingFloor(card)) return false;
    if (isBaseCommon(card) && overall != null && overall <= 82) return false;
    if (isBaseCommon(card) && overall != null && overall >= 83 && overall <= 84 && !e.verified) return false;
    if (risk >= 24 || historyTrend < -10) return false;
    if (sourceDiff != null && Math.abs(sourceDiff) > 25) return false;
    if (outcomeDecision === 'REJECT') return false;
    // Selection can be low merely because the rating proxy rejected the card.
    // Trade quality and independent live sellability therefore carry the hard
    // floor in this budget-specific mode.
    if (e.trade < 36 || e.sell < 40) return false;
    if (card?.qualityEligible === false && e.trade < 39 && !e.verified) return false;
    return true;
  };

  const stages = [
    {
      name: 'BUDGET_CORE',
      maxRatio: 1.30,
      pass: e => e.score >= 58 && e.sell >= 49 && e.sale >= 49 && e.trade >= 42 && e.repeat >= 41 && e.activity >= 46 && e.trend >= 40 && e.liveSignals >= 3
    },
    {
      name: 'BUDGET_BALANCED',
      maxRatio: 1.65,
      pass: e => e.score >= 53 && e.sell >= 46 && e.sale >= 47 && e.trade >= 40 && e.repeat >= 39 && e.activity >= 44 && e.trend >= 38 && e.liveSignals >= 3
    },
    {
      // Most useful for 300k/100. Cheap cards are allowed to compensate for a
      // lower rating/selection proxy, but only when several independent live
      // demand indicators agree.
      name: 'BUDGET_CHEAP_DEMAND',
      maxRatio: 1.12,
      pass: e => e.score >= 48 && e.sell >= 43 && e.sale >= 45 && e.trade >= 38 && e.repeat >= 37 && e.activity >= 42 && e.trend >= 36 && e.liveSignals >= 4
    },
    {
      name: 'BUDGET_FEASIBILITY',
      maxRatio: 2.20,
      pass: e => e.score >= 47 && e.sell >= 42 && e.sale >= 44 && e.trade >= 38 && e.repeat >= 36 && e.activity >= 41 && e.trend >= 35 && e.liveSignals >= 4
    },
    {
      name: 'BUDGET_LAST_SAFE',
      maxRatio: 3.25,
      pass: e => e.score >= 45 && e.sell >= 41 && e.sale >= 43 && e.trade >= 36 && e.repeat >= 35 && e.activity >= 40 && e.trend >= 34 && e.liveSignals >= 5
    }
  ];

  let accumulated = [];
  let chosenStage = null;
  let estimate = { slots: 0, minimumCost: null, uniqueCards: 0 };
  const diagnostics = [];
  const seen = new Set();

  for (const stage of stages) {
    const additions = source
      .filter(hardSafetyEligible)
      .map(card => ({ card, e: evidence(card) }))
      .filter(({ e }) => e.priceRatio <= stage.maxRatio && stage.pass(e))
      .sort((a, b) => b.e.score - a.e.score || a.e.price - b.e.price);

    for (const { card, e } of additions) {
      const key = String(card?.eaId ?? `${card?.name || 'unknown'}|${card?.overall || ''}|${card?.version || ''}`);
      if (seen.has(key)) continue;
      seen.add(key);
      accumulated.push({
        ...card,
        budgetAdaptiveFallbackStage: stage.name,
        budgetAdaptiveSellabilityScore: e.score,
        budgetAdaptivePriceFit: e.priceFit,
        budgetAdaptiveLiveSignals: e.liveSignals,
        budgetAdaptiveRatingBypass: Boolean(card?.budgetRatingBlocked || card?.marketRatingBlocked || card?.demandRelaxationBlocked)
      });
    }

    estimate = allocatorAwareFeasibility(accumulated, totalBudget, targetCount);
    diagnostics.push({
      stage: stage.name,
      maxPriceRatio: stage.maxRatio,
      uniqueCards: estimate.uniqueCards,
      slots: estimate.slots,
      minimumCost: estimate.minimumCost,
      allocatorSlots: estimate.allocatorSlots,
      allocatorMinimumSpend: estimate.allocatorMinimumSpend
    });
    chosenStage = stage.name;
    if (estimate.allocatorFeasible && (!Number.isFinite(totalBudget) || estimate.allocatorMinimumSpend <= totalBudget)) break;
  }

  return {
    pool: accumulated,
    stage: chosenStage,
    idealSlotPrice: ideal,
    slots: estimate.slots,
    minimumCost: estimate.minimumCost,
    uniqueCards: estimate.uniqueCards,
    allocatorSlots: Number(estimate.allocatorSlots || 0),
    allocatorMinimumSpend: Number(estimate.allocatorMinimumSpend || 0),
    budgetFeasible: Boolean(estimate.allocatorFeasible) && Number.isFinite(totalBudget) && Number(estimate.allocatorMinimumSpend || 0) <= totalBudget,
    diagnostics
  };
}


/**
 * v2.4.2 final hard-safety reserve for hard-100 budget portfolios.
 *
 * The normal candidate pipeline and both sellability ladders remain preferred.
 * If those ranking-oriented gates still leave fewer than 100 affordable slots,
 * this reserve separates HARD SAFETY from RANKING: it may admit an 82+ normal
 * Rare that is merely average on demand, but never a Bronze, sub-82 normal,
 * weak low-rated Non-Rare, severe crash/source-divergence card or a card with a
 * rejected reported outcome. The budgetTop100Score then ranks the admitted
 * reserve so weak cards are used only when they are genuinely needed for the
 * requested 100-slot budget.
 */
export function buildBudgetSafetyReserveFallback(cards = [], { budget, count = 100 } = {}) {
  const totalBudget = Number(budget);
  const targetCount = Math.max(1, Math.floor(Number(count) || 100));
  const ideal = Number.isFinite(totalBudget) && totalBudget > 0 ? totalBudget / targetCount : 3000;
  const source = Array.isArray(cards) ? cards : [];

  const evidence = card => {
    const price = adaptiveBudgetPrice(card);
    const sell = finite(card?.sellabilityScore, adaptiveLiquidityScore(card));
    const gameplay = finite(card?.gameplayDemandScore, finite(card?.popularityScore, 50));
    const sale = finite(card?.saleLikelihoodIndex, 50);
    const trade = finite(card?.tradeQualityScore, 50);
    const repeat = finite(card?.repeatabilityScore, 50);
    const activity = finite(card?.priceActivityScore, 50);
    const trend = finite(card?.trendScore, 50);
    const confidence = finite(card?.confidenceScore, 45);
    const demandConfidence = finite(card?.demandDataConfidence, 40);
    const verified = hasVerifiedDemandEvidence(card);
    const strong = hasStrongVerifiedDemandEvidence(card);
    const usage = Math.max(0, finite(card?.usagePct, 0), finite(card?.communityUsagePct, 0), finite(card?.proUsagePct, 0));
    const popularRank = finite(card?.futbinPopularRank, null);
    const games = finite(card?.futbinGamesCount, null);
    const soldSamples = Math.max(0, finite(card?.futbinSoldSampleCount, 0));
    let liveSignals = 0;
    if (verified) liveSignals += 2;
    if (gameplay >= 48) liveSignals += 1;
    if (sale >= 42) liveSignals += 1;
    if (activity >= 38) liveSignals += 1;
    if (trend >= 34) liveSignals += 1;
    if (repeat >= 38) liveSignals += 1;
    if (card?.momentumHit === true) liveSignals += 2;
    if (usage > 0) liveSignals += 2;
    if (popularRank != null && popularRank > 0 && popularRank <= 1000) liveSignals += 1;
    if (games != null && games >= 50000) liveSignals += 1;
    if (soldSamples >= 1) liveSignals += 1;
    const priceRatio = Number.isFinite(price) && ideal > 0 ? price / ideal : Infinity;
    const budgetRank = finite(card?.budgetTop100Score, finite(card?.selectionScore, 50));
    return { price, sell, gameplay, sale, trade, repeat, activity, trend, confidence, demandConfidence, verified, strong, liveSignals, priceRatio, budgetRank };
  };

  const hardSafetyEligible = card => {
    const e = evidence(card);
    const risk = finite(card?.riskPenalty, 0);
    const historyTrend = finite(card?.historyTrendPct, 0);
    const sourceDiff = finite(card?.sourceDiffPct, null);
    const overall = finite(card?.overall, null);
    const outcomeDecision = String(card?.reportedOutcomeDecision || '').toUpperCase();
    if (!Number.isFinite(e.price) || e.price <= 0) return false;
    if (isBronzeCard(card)) return false;
    if (!passesNormalRatingFloor(card)) return false;
    if (isBaseCommon(card) && overall != null && overall <= 82) return false;
    if (isBaseCommon(card) && overall != null && overall >= 83 && overall <= 84 && !e.verified) return false;
    if (risk >= 24 || historyTrend < -10) return false;
    if (sourceDiff != null && Math.abs(sourceDiff) > 25) return false;
    if (outcomeDecision === 'REJECT') return false;
    if (e.trade < 32 || e.sell < 34 || e.sale < 36) return false;
    if (card?.qualityEligible === false && e.trade < 36 && !e.verified) return false;
    return true;
  };

  const stages = [
    {
      name: 'SAFE_RESERVE_BALANCED',
      maxRatio: 1.75,
      pass: e => e.sell >= 40 && e.sale >= 42 && e.trade >= 36 && e.activity >= 38 && e.trend >= 34 && e.liveSignals >= 2
    },
    {
      name: 'SAFE_RESERVE_BUDGET',
      maxRatio: 1.35,
      pass: e => e.sell >= 37 && e.sale >= 39 && e.trade >= 34 && e.activity >= 35 && e.trend >= 31 && e.liveSignals >= 1
    },
    {
      name: 'SAFE_RESERVE_LAST',
      maxRatio: 2.25,
      pass: e => e.sell >= 34 && e.sale >= 36 && e.trade >= 32 && e.activity >= 32 && e.trend >= 28 && (e.liveSignals >= 1 || e.budgetRank >= 48)
    }
  ];

  let accumulated = [];
  let chosenStage = null;
  let estimate = { slots: 0, minimumCost: null, uniqueCards: 0 };
  const diagnostics = [];
  const seen = new Set();

  for (const stage of stages) {
    const additions = source
      .filter(hardSafetyEligible)
      .map(card => ({ card, e: evidence(card) }))
      .filter(({ e }) => e.priceRatio <= stage.maxRatio && stage.pass(e))
      .sort((a, b) => {
        const aValue = a.e.budgetRank + a.e.sell * 0.12 + a.e.liveSignals * 1.5 - Math.max(0, a.e.priceRatio - 1) * 7;
        const bValue = b.e.budgetRank + b.e.sell * 0.12 + b.e.liveSignals * 1.5 - Math.max(0, b.e.priceRatio - 1) * 7;
        return bValue - aValue || a.e.price - b.e.price;
      });

    for (const { card, e } of additions) {
      const key = String(card?.eaId ?? `${card?.name || 'unknown'}|${card?.overall || ''}|${card?.version || ''}`);
      if (seen.has(key)) continue;
      seen.add(key);
      accumulated.push({
        ...card,
        budgetSafetyReserveStage: stage.name,
        budgetSafetyReserveScore: e.budgetRank,
        budgetSafetyReserveLiveSignals: e.liveSignals
      });
    }

    estimate = allocatorAwareFeasibility(accumulated, totalBudget, targetCount);
    diagnostics.push({ stage: stage.name, maxPriceRatio: stage.maxRatio, uniqueCards: estimate.uniqueCards, slots: estimate.slots, minimumCost: estimate.minimumCost, allocatorSlots: estimate.allocatorSlots, allocatorMinimumSpend: estimate.allocatorMinimumSpend });
    chosenStage = stage.name;
    // v2.7.1 regression fix: 100 structural repeat slots can still collapse to
    // e.g. 66/100 after the 82/83 endgame caps. Do not stop the reserve early.
    if (estimate.allocatorFeasible && (!Number.isFinite(totalBudget) || estimate.allocatorMinimumSpend <= totalBudget)) break;
  }

  return {
    pool: accumulated,
    stage: chosenStage,
    idealSlotPrice: ideal,
    slots: estimate.slots,
    minimumCost: estimate.minimumCost,
    uniqueCards: estimate.uniqueCards,
    allocatorSlots: Number(estimate.allocatorSlots || 0),
    allocatorMinimumSpend: Number(estimate.allocatorMinimumSpend || 0),
    budgetFeasible: Boolean(estimate.allocatorFeasible) && Number.isFinite(totalBudget) && Number(estimate.allocatorMinimumSpend || 0) <= totalBudget,
    diagnostics
  };
}

function estimateAffordablePortfolio(cards = [], count = 100, maxExactCopies = 2, maxPlayerCopies = 3) {
  const rowsByExact = new Map();
  for (const card of cards) {
    const cost = adaptiveBudgetPrice(card);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const key = String(card?.eaId ?? `${card?.name || 'unknown'}|${card?.overall || ''}|${card?.version || ''}`);
    const prev = rowsByExact.get(key);
    if (!prev || cost < prev.cost) rowsByExact.set(key, { card, cost, key });
  }
  const expanded = [];
  for (const row of rowsByExact.values()) {
    for (let copy = 1; copy <= maxExactCopies; copy++) expanded.push({ ...row, copy });
  }
  expanded.sort((a, b) => a.cost - b.cost || Number(b.card?._adaptiveLiquidityScore || 0) - Number(a.card?._adaptiveLiquidityScore || 0));
  const exactCounts = new Map();
  const playerCounts = new Map();
  const picked = [];
  for (const row of expanded) {
    if (picked.length >= count) break;
    const exact = row.key;
    const player = String(row.card?.name || exact).toLowerCase();
    if ((exactCounts.get(exact) || 0) >= maxExactCopies) continue;
    if ((playerCounts.get(player) || 0) >= maxPlayerCopies) continue;
    exactCounts.set(exact, (exactCounts.get(exact) || 0) + 1);
    playerCounts.set(player, (playerCounts.get(player) || 0) + 1);
    picked.push(row);
  }
  return {
    slots: picked.length,
    minimumCost: picked.length >= count ? picked.slice(0, count).reduce((sum, row) => sum + row.cost, 0) : null,
    uniqueCards: rowsByExact.size
  };
}

function endgameRelaxationFloor(season = {}) {
  const budgetFloor = Number(season?.budgetFloor || 0);
  if (season?.phase === 'ENDGAME') return Math.max(budgetFloor, 83);
  if (season?.phase === 'LATE') return Math.max(budgetFloor, 82);
  return budgetFloor;
}

export function deriveAdaptiveMarketPolicy(cards = [], { budget, count = 100, gameYear = null, now = new Date() } = {}) {
  const season = seasonRatingPolicy({ budget, count, gameYear, now });
  const budgetFloor = Number(season.budgetFloor || minimumRatingForBudget(budget, count) || 0);
  const rows = (Array.isArray(cards) ? cards : [])
    .filter(card => Number.isFinite(Number(card?.overall)) && Number.isFinite(Number(adaptiveBudgetPrice(card))))
    .map(card => ({ ...card, _adaptiveLiquidityScore: adaptiveLiquidityScore(card) }));

  const sampleDepth = Math.min(rows.length, Math.max(80, Math.min(360, Math.ceil(Number(count || 100) * 3.2))));
  const liquidSample = [...rows]
    .filter(card => roughAdaptiveSafety(card))
    .sort((a, b) => b._adaptiveLiquidityScore - a._adaptiveLiquidityScore || Number(b.selectionScore || 0) - Number(a.selectionScore || 0))
    .slice(0, sampleDepth);

  // v2.3: rating is context, sellability is the decision. We still derive a
  // preferred live-market rating band, but if 100 slots are not feasible the
  // floor relaxes one rating at a time ONLY for cards with verified demand.
  const marketEvidence = liquidSample.filter(card =>
    hasVerifiedDemandEvidence(card) ||
    Number(card._adaptiveLiquidityScore || 0) >= 63 ||
    Number(card.promoMarketScore || 0) >= 62
  );
  const ratingSample = marketEvidence.length >= Math.min(24, Math.max(12, Math.ceil(Number(count || 100) * 0.22)))
    ? marketEvidence
    : liquidSample;
  const ratings = ratingSample.map(card => Number(card.overall)).filter(Number.isFinite);
  const marketQ25Rating = percentile(ratings, 0.25);
  const marketMedianRating = percentile(ratings, 0.50);
  const marketQ75Rating = percentile(ratings, 0.75);

  const q25Anchor = marketQ25Rating == null ? budgetFloor : Math.floor(marketQ25Rating);
  const medianAnchor = marketMedianRating == null ? budgetFloor : Math.floor(marketMedianRating - 2);
  let preferredMinimumRating = Math.max(budgetFloor, q25Anchor, medianAnchor);
  preferredMinimumRating = Math.max(budgetFloor, Math.min(90, preferredMinimumRating));

  const promoRows = liquidSample.filter(card => isSpecialCard(card) && card?.inPacksHit === true);
  const promoLiquidRows = promoRows.filter(card =>
    hasVerifiedDemandEvidence(card) ||
    Number(card.promoMarketScore || 0) >= 58 ||
    Number(card._adaptiveLiquidityScore || 0) >= 64
  );
  const promoMomentumRows = promoRows.filter(card => card?.momentumHit === true);
  const avgPromoScore = promoRows.length
    ? promoRows.reduce((sum, card) => sum + Number(card.promoMarketScore || 50), 0) / promoRows.length
    : 0;
  const promoSharePct = liquidSample.length ? (promoRows.length / liquidSample.length) * 100 : 0;
  const promoLiquidSharePct = promoRows.length ? (promoLiquidRows.length / promoRows.length) * 100 : 0;
  const promoMomentumSharePct = promoRows.length ? (promoMomentumRows.length / promoRows.length) * 100 : 0;
  const promoHeatScore = clamp(
    promoSharePct * 0.45 +
    promoLiquidSharePct * 0.28 +
    promoMomentumSharePct * 0.17 +
    avgPromoScore * 0.10,
    0,
    100
  );
  const promoMarketRegime = promoHeatScore >= 58
    ? 'PROMO_HOT'
    : promoHeatScore >= 32
      ? 'PROMO_ACTIVE'
      : marketEvidence.length >= 20
        ? 'LIVE_MARKET'
        : 'THIN_MARKET';

  const specialDemandExceptionRating = preferredMinimumRating > budgetFloor
    ? preferredMinimumRating - 1
    : null;

  // v2.3.1: walk farther down the rating ladder when the total budget requires
  // it, but keep every relaxed card behind live sellability evidence. The old
  // build stopped at budgetFloor-1, which was too shallow for real 300k/100 FC26
  // data. We first try BALANCED evidence and only then FEASIBILITY evidence.
  // Bronze and low Gold Non-Rare hard blocks still apply later in the real gate.
  const lowestDemandFloor = Math.max(78, budgetFloor - 4);
  const feasibility = [];
  let chosenFloor = preferredMinimumRating;
  let chosenRows = [];
  let chosenEstimate = { slots: 0, minimumCost: null, uniqueCards: 0 };
  let chosenRelaxationMode = 'LIVE_MARKET';

  const relaxationModes = ['BALANCED', 'FEASIBILITY'];
  outer: for (const relaxationMode of relaxationModes) {
    for (let floor = preferredMinimumRating; floor >= lowestDemandFloor; floor--) {
      const qualityRows = rows.filter(card => {
        const overall = finite(card?.overall, null);
        if (overall == null || !roughAdaptiveSafety(card)) return false;
        if (overall >= preferredMinimumRating) return true;
        if (
          specialDemandExceptionRating != null &&
          overall === specialDemandExceptionRating &&
          isSpecialCard(card) &&
          card?.inPacksHit === true &&
          (hasStrongVerifiedDemandEvidence(card) || Number(card.promoMarketScore || 0) >= 70)
        ) return true;
        if (overall < floor) return false;
        const gap = Math.max(1, preferredMinimumRating - overall);
        return hasAdaptiveRelaxationEvidence(card, gap, relaxationMode);
      });
      const estimate = estimateAffordablePortfolio(qualityRows, count, 2, 3);
      feasibility.push({ floor, mode: floor === preferredMinimumRating ? 'PROMO_MARKET' : relaxationMode, slots: estimate.slots, minimumCost: estimate.minimumCost, uniqueCards: estimate.uniqueCards });
      chosenFloor = floor;
      chosenRows = qualityRows;
      chosenEstimate = estimate;
      chosenRelaxationMode = floor < preferredMinimumRating ? relaxationMode : 'LIVE_MARKET';
      if (estimate.slots >= count && Number.isFinite(estimate.minimumCost) && estimate.minimumCost <= Number(budget)) break outer;
    }
  }

  const budgetFeasible = chosenEstimate.slots >= count && Number.isFinite(chosenEstimate.minimumCost) && chosenEstimate.minimumCost <= Number(budget);
  const budgetRelaxed = chosenFloor < preferredMinimumRating;
  const estimatedMinimumCost = Number.isFinite(chosenEstimate?.minimumCost) ? Math.round(chosenEstimate.minimumCost) : null;

  const strongDemandSharePct = liquidSample.length
    ? (liquidSample.filter(card => hasStrongVerifiedDemandEvidence(card) || card._adaptiveLiquidityScore >= 72).length / liquidSample.length) * 100
    : 0;
  const specialSharePct = liquidSample.length
    ? (liquidSample.filter(card => isSpecialCard(card)).length / liquidSample.length) * 100
    : 0;
  const activePromoVersions = [...new Map(
    promoRows.map(card => [String(card.rarityName || card.cardName || card.version || 'Special').trim() || 'Special', 0])
  ).keys()].slice(0, 6);

  return {
    mode: 'PROMO_MARKET_ADAPTIVE_100',
    budgetFloor,
    seasonPhase: season.phase,
    seasonPriorFloor: season.minimumRating,
    calendarPhaseContextOnly: true,
    preferredMinimumRating,
    minimumRating: chosenFloor,
    relaxationFloor: chosenFloor,
    budgetRelaxed,
    budgetFeasible,
    dynamicCountMode: false,
    hardPortfolioCount: true,
    relaxationDemandMode: budgetRelaxed ? chosenRelaxationMode : 'LIVE_MARKET',
    estimatedMinimumCost,
    estimatedAffordableSlots: Number(chosenEstimate?.slots || 0),
    feasibility,
    marketQ25Rating: marketQ25Rating == null ? null : Number(marketQ25Rating.toFixed(2)),
    marketMedianRating: marketMedianRating == null ? null : Number(marketMedianRating.toFixed(2)),
    marketQ75Rating: marketQ75Rating == null ? null : Number(marketQ75Rating.toFixed(2)),
    sampleSize: ratingSample.length,
    liquidSampleSize: liquidSample.length,
    strongDemandSharePct: Number(strongDemandSharePct.toFixed(1)),
    specialSharePct: Number(specialSharePct.toFixed(1)),
    promoMarketRegime,
    promoHeatScore: Number(promoHeatScore.toFixed(1)),
    promoInPacksSpecials: promoRows.length,
    promoLiquidSpecials: promoLiquidRows.length,
    promoMomentumSpecials: promoMomentumRows.length,
    activePromoVersions,
    demandGateBelowRating: budgetRelaxed ? preferredMinimumRating : null,
    specialDemandExceptionRating,
    reason: budgetRelaxed
      ? `Live-Markt ${promoMarketRegime}: bevorzugt ${preferredMinimumRating}+, für exakt ${count} Slots wird bis ${chosenFloor} gelockert. Unter dem bevorzugten Floor kommen nur demand-belegte Karten durch (FUT.GG Usage/Momentum, FUTBIN Games/Sales, Popularität, Trend/Performance).`
      : `Live-Markt ${promoMarketRegime}: ${count} Slots sind mit dem bevorzugten ${preferredMinimumRating}+-Band im Budget machbar.`
  };
}

export function seasonRatingPolicy({ budget, count = 100, gameYear = null, now = new Date(), minRating = null } = {}) {
  const hasExplicitMinRating = minRating !== null && minRating !== undefined && minRating !== '' && Number.isFinite(Number(minRating));
  const hasGameYear = gameYear !== null && gameYear !== undefined && gameYear !== '' && Number.isFinite(Number(gameYear));
  const budgetFloor = hasExplicitMinRating
    ? Number(minRating)
    : minimumRatingForBudget(budget, count);
  const phase = hasGameYear ? seasonPhaseForGameYear(gameYear, now) : 'BUDGET_ONLY';
  let phaseFloor = budgetFloor;
  if (phase === 'MID') phaseFloor = Math.max(Number(budgetFloor || 0), 82);
  else if (phase === 'MATURE') phaseFloor = Math.max(Number(budgetFloor || 0), 83);
  else if (phase === 'LATE') phaseFloor = Math.max(Number(budgetFloor || 0), 84);
  else if (phase === 'ENDGAME') phaseFloor = Math.max(Number(budgetFloor || 0), 85);

  return {
    phase,
    budgetFloor,
    minimumRating: phaseFloor,
    specialDemandExceptionRating: phase === 'ENDGAME' && phaseFloor >= 85 ? 84 : null
  };
}

export function evaluateRatingEligibility(card = {}, options = {}) {
  const overall = finite(card?.overall, null);
  const seasonPolicy = seasonRatingPolicy({
    budget: options?.budget,
    count: options?.portfolioCount ?? options?.count ?? 100,
    gameYear: options?.gameYear,
    now: options?.now,
    minRating: options?.minRating
  });
  const adaptive = options?.adaptivePolicy && Number.isFinite(Number(options.adaptivePolicy.minimumRating))
    ? options.adaptivePolicy
    : null;
  const policy = adaptive
    ? {
        ...seasonPolicy,
        minimumRating: Number(adaptive.minimumRating),
        preferredMinimumRating: Number.isFinite(Number(adaptive.preferredMinimumRating))
          ? Number(adaptive.preferredMinimumRating)
          : Number(adaptive.minimumRating),
        specialDemandExceptionRating: Number.isFinite(Number(adaptive.specialDemandExceptionRating))
          ? Number(adaptive.specialDemandExceptionRating)
          : null
      }
    : { ...seasonPolicy, preferredMinimumRating: seasonPolicy.minimumRating };

  const strongDemandEvidence = hasStrongVerifiedDemandEvidence(card);
  const relaxationGap = adaptive ? Math.max(0, Number(policy.preferredMinimumRating || policy.minimumRating || 0) - Number(overall || 0)) : 0;
  const adaptiveRelaxationEvidence = hasAdaptiveRelaxationEvidence(card, relaxationGap, adaptive?.relaxationDemandMode || 'STRICT');
  const demandGatedRelaxation = Boolean(
    adaptive &&
    adaptive?.budgetRelaxed === true &&
    overall != null &&
    overall >= policy.minimumRating &&
    overall < policy.preferredMinimumRating
  );
  const demandRelaxationBlocked = demandGatedRelaxation && !adaptiveRelaxationEvidence;
  const specialDemandException = Boolean(
    isSpecialCard(card) &&
    policy.specialDemandExceptionRating != null &&
    overall === policy.specialDemandExceptionRating &&
    (
      adaptive
        ? (card?.inPacksHit === true && (strongDemandEvidence || Number(card?.promoMarketScore || 0) >= 70))
        : strongDemandEvidence
    )
  );
  const belowHardFloor = policy.minimumRating != null && overall != null && overall < policy.minimumRating && !specialDemandException;
  const blocked = belowHardFloor || demandRelaxationBlocked;

  let reason = null;
  if (demandRelaxationBlocked) {
    reason = `Rating ${overall} liegt unter dem bevorzugten ${policy.preferredMinimumRating}+-Ziel und braucht für die Budget-Lockerung belegten Demand (Usage/Games/echte Sales/Outcomes).`;
  } else if (belowHardFloor) {
    if (isSpecialCard(card) && policy.specialDemandExceptionRating != null && overall === policy.specialDemandExceptionRating) {
      reason = `Rating ${overall} Special braucht unter dem dynamischen ${policy.minimumRating}+-Guard starken belegten Demand (Games/Usage/echte Sales/Outcomes).`;
    } else {
      reason = adaptive ? `Rating ${overall} liegt unter der aktuellen Live-Markt-Untergrenze ${policy.minimumRating}.` : `Rating ${overall} liegt unter der aktuellen ${policy.phase === 'BUDGET_ONLY' ? 'Budget' : `${policy.phase}-Season`}-Untergrenze ${policy.minimumRating}.`;
    }
  }
  return {
    allowed: !blocked,
    blocked,
    overall,
    ratingFloor: policy.minimumRating,
    preferredRatingFloor: policy.preferredMinimumRating,
    budgetRatingFloor: policy.budgetFloor,
    seasonPhase: seasonPolicy.phase,
    ratingPolicyMode: adaptive ? String(adaptive.mode || 'PROMO_MARKET_ADAPTIVE') : 'SEASON_BUDGET',
    adaptiveMarketQ25Rating: adaptive?.marketQ25Rating ?? null,
    adaptiveMarketMedianRating: adaptive?.marketMedianRating ?? null,
    adaptiveSampleSize: adaptive?.sampleSize ?? 0,
    adaptiveBudgetRelaxed: Boolean(adaptive?.budgetRelaxed),
    adaptiveBudgetFeasible: adaptive?.budgetFeasible ?? null,
    adaptiveDynamicCountMode: Boolean(adaptive?.dynamicCountMode),
    adaptiveRelaxationDemandMode: adaptive?.relaxationDemandMode || null,
    adaptiveEstimatedMinimumCost: adaptive?.estimatedMinimumCost ?? null,
    adaptivePromoMarketRegime: adaptive?.promoMarketRegime ?? null,
    adaptivePromoHeatScore: adaptive?.promoHeatScore ?? null,
    adaptivePromoInPacksSpecials: adaptive?.promoInPacksSpecials ?? 0,
    adaptivePromoLiquidSpecials: adaptive?.promoLiquidSpecials ?? 0,
    adaptivePromoMomentumSpecials: adaptive?.promoMomentumSpecials ?? 0,
    adaptiveActivePromoVersions: Array.isArray(adaptive?.activePromoVersions) ? adaptive.activePromoVersions : [],
    demandGatedRelaxation,
    demandRelaxationBlocked,
    adaptiveRelaxationEvidence,
    specialDemandException,
    strongDemandEvidence,
    reason
  };
}

function isBronzeCard(card = {}) {
  const rarity = `${card?.rarityName || ''} ${card?.rarityGroupName || ''} ${card?.cardName || ''}`.toLowerCase();
  const overall = finite(card?.overall, null);
  return rarity.includes('bronze') || (overall != null && overall <= 64);
}

export function evaluateCandidateGate(card = {}, options = {}) {
  const price = finite(card.price, null);
  const confidence = finite(card.confidenceScore, 45);
  const demandConfidence = finite(card.demandDataConfidence, 40);
  const stability = finite(card.stability, 50);
  const tradeQuality = finite(card.tradeQualityScore, 50);
  const selection = finite(card.selectionScore, 50);
  const risk = finite(card.riskPenalty, 0);
  const capitalLock = finite(card.capitalLockRisk, 0);
  const supply = finite(card.supplyPressureScore, 0);
  const trend = finite(card.historyTrendPct, 0);
  const sourceDiff = finite(card.sourceDiffPct, null);
  const targetSupport = finite(card.targetSupportScore, 50);
  const targetSamples = Math.max(0, finite(card.targetSupportSamples, 0));
  const outcome = outcomeQualityGuard({
    reportedFeedbackSamples: card.reportedFeedbackSamples,
    reportedSellRate: card.reportedSellRate,
    reportedOutcomeScore: card.reportedOutcomeScore,
    avgReportedRelists: card.avgReportedRelists,
    avgReportedNetProfit: card.avgReportedNetProfit,
    avgRecommendedNetProfit: card.avgRecommendedNetProfit,
    avgReportedRoiPct: card.avgReportedRoiPct,
    avgResolutionHours: card.avgResolutionHours
  });

  const evidenceScore = clamp(
    confidence * 0.32 +
    demandConfidence * 0.22 +
    historyEvidence(card) * 0.18 +
    targetSupport * Math.min(0.18, targetSamples / 100) +
    outcome.score * Math.min(0.10, outcome.samples / 120) +
    18,
    0,
    100
  );

  const safetyScore = clamp(
    90 - risk * 2.2 - capitalLock * 0.32 - supply * 0.15 - Math.max(0, -trend - 2) * 3.2 -
    (sourceDiff == null ? 0 : Math.max(0, Math.abs(sourceDiff) - 8) * 1.8),
    0,
    100
  );

  const gateScore = clamp(
    tradeQuality * 0.31 +
    selection * 0.26 +
    evidenceScore * 0.18 +
    safetyScore * 0.17 +
    stability * 0.08,
    0,
    100
  );

  const hardReasons = [];
  const cautionReasons = [];
  const bronzeBlocked = isBronzeCard(card);
  const baseCommon = isBaseCommon(card);
  const overall = finite(card?.overall, null);
  const verifiedDemandEvidence = hasVerifiedDemandEvidence(card);
  const normalBelow82Blocked = overall != null && overall < 82 && !isSpecialCard(card);
  const specialBelow82Blocked = overall != null && overall < 82 && isSpecialCard(card) && !hasStrongVerifiedDemandEvidence(card);
  const ratingEligibility = evaluateRatingEligibility(card, options);
  const ratingFloor = ratingEligibility.ratingFloor;
  const budgetRatingBlocked = ratingEligibility.blocked;
  const lowNonRareBlocked = baseCommon && overall != null && overall <= 82;
  const midNonRareDemandBlocked = baseCommon && overall != null && overall >= 83 && overall <= 84 && !verifiedDemandEvidence;
  if (bronzeBlocked) hardReasons.push('Bronze-Karten sind per Sicherheitsregel hart gesperrt');
  if (normalBelow82Blocked) hardReasons.push('Normale Karten unter Rating 82 sind für ÜV hart gesperrt');
  if (specialBelow82Blocked) hardReasons.push('Spezialkarten unter Rating 82 benötigen starken belegten Demand');
  if (budgetRatingBlocked) hardReasons.push(ratingEligibility.reason || `Rating ${overall} liegt unter der aktuellen Rating-Untergrenze ${ratingFloor}`);
  if (lowNonRareBlocked) hardReasons.push('Gold Non-Rare bis Rating 82 wird wegen zu schwacher typischer Gameplay-Nachfrage nicht für ÜV genutzt');
  if (midNonRareDemandBlocked) hardReasons.push('Gold Non-Rare Rating 83-84 benötigt belegte Nachfrage durch Usage, Games, echte Sales oder eigene Outcomes');
  if (price == null || price <= 0) hardReasons.push('kein valider Marktpreis');
  if (risk >= 24) hardReasons.push('Risiko deutlich über konservativer Grenze');
  if (trend < -10) hardReasons.push('zu starker negativer Preisverlauf');
  if (sourceDiff != null && Math.abs(sourceDiff) > 25) hardReasons.push('zu große Preisquellen-Abweichung');
  if (tradeQuality < 42) hardReasons.push('Trade-Qualität zu schwach');
  if (selection < 39) hardReasons.push('Gesamtranking zu schwach');
  if (card.qualityEligible === false && tradeQuality < 47) hardReasons.push('bestehender Quality-Guard nicht bestanden');
  if (outcome.hardReject) hardReasons.push('ausreichend gemeldete Outcomes sprechen klar gegen dieses Profil');

  if (confidence < 45) cautionReasons.push('geringe Datensicherheit');
  if (demandConfidence < 40) cautionReasons.push('geringe Demand-Datentiefe');
  if (stability < 42) cautionReasons.push('geringe Preisstabilität');
  if (capitalLock >= 65) cautionReasons.push('hohes Kapitalbindungsrisiko');
  if (supply >= 68) cautionReasons.push('erhöhter Supply-Druck');
  if (outcome.samples >= 6 && outcome.score < 45) cautionReasons.push('gemeldete Outcomes unterdurchschnittlich');
  if (baseCommon && overall != null && overall >= 85 && !verifiedDemandEvidence) cautionReasons.push('Non-Rare ohne belegte Gameplay-/Sales-Nachfrage wird gegenüber Rare/Spezial zurückgestuft');

  let decision = 'PASS';
  if (hardReasons.length) decision = 'REJECT';
  else if (gateScore < 58 || cautionReasons.length >= 2) decision = 'CAUTION';
  if (gateScore < 48) decision = 'REJECT';

  return {
    candidateGateDecision: decision,
    candidateGateScore: gateScore,
    candidateEvidenceScore: evidenceScore,
    candidateSafetyScore: safetyScore,
    candidateGateReasons: [...hardReasons, ...cautionReasons],
    candidateHardReject: hardReasons.length > 0,
    bronzeBlocked,
    normalBelow82Blocked,
    specialBelow82Blocked,
    ratingFloor,
    preferredRatingFloor: ratingEligibility.preferredRatingFloor,
    budgetRatingFloor: ratingEligibility.budgetRatingFloor,
    seasonPhase: ratingEligibility.seasonPhase,
    ratingPolicyMode: ratingEligibility.ratingPolicyMode,
    adaptiveMarketQ25Rating: ratingEligibility.adaptiveMarketQ25Rating,
    adaptiveMarketMedianRating: ratingEligibility.adaptiveMarketMedianRating,
    adaptiveSampleSize: ratingEligibility.adaptiveSampleSize,
    adaptiveBudgetRelaxed: ratingEligibility.adaptiveBudgetRelaxed,
    adaptiveBudgetFeasible: ratingEligibility.adaptiveBudgetFeasible,
    adaptiveDynamicCountMode: ratingEligibility.adaptiveDynamicCountMode,
    adaptiveRelaxationDemandMode: ratingEligibility.adaptiveRelaxationDemandMode,
    adaptiveEstimatedMinimumCost: ratingEligibility.adaptiveEstimatedMinimumCost,
    demandGatedRelaxation: ratingEligibility.demandGatedRelaxation,
    demandRelaxationBlocked: ratingEligibility.demandRelaxationBlocked,
    adaptiveRelaxationEvidence: ratingEligibility.adaptiveRelaxationEvidence,
    seasonRatingBlocked: ratingEligibility.blocked && ratingEligibility.ratingPolicyMode === 'SEASON_BUDGET' && ratingEligibility.seasonPhase !== 'BUDGET_ONLY',
    marketRatingBlocked: ratingEligibility.blocked && String(ratingEligibility.ratingPolicyMode || '').includes('PROMO_MARKET'),
    specialDemandException: ratingEligibility.specialDemandException,
    strongDemandEvidence: ratingEligibility.strongDemandEvidence,
    budgetRatingBlocked,
    baseCommon,
    verifiedDemandEvidence,
    lowNonRareBlocked,
    midNonRareDemandBlocked,
    reportedOutcomeDecision: outcome.decision
  };
}

export function runCandidatePipeline(cards = [], count = 100, options = {}) {
  const gateOptions = { ...options, count, portfolioCount: options?.portfolioCount ?? count };
  const enriched = cards.map(card => ({ ...card, ...evaluateCandidateGate(card, gateOptions) }));
  const pass = enriched.filter(c => c.candidateGateDecision === 'PASS');
  const caution = enriched.filter(c => c.candidateGateDecision === 'CAUTION');
  const rejected = enriched.filter(c => c.candidateGateDecision === 'REJECT');
  const targetDepth = Math.max(count, Math.ceil(count * 1.35));
  const selectedPool = [...pass];
  const sortedCaution = [...caution].sort((a, b) => b.candidateGateScore - a.candidateGateScore || b.selectionScore - a.selectionScore);
  for (const card of sortedCaution) {
    if (selectedPool.length >= targetDepth) break;
    selectedPool.push(card);
  }

  // If the market is unusually thin, allow only soft rejects as a last-resort
  // feasibility fallback. Hard source/risk rejects are never reintroduced.
  let fallbackAdded = 0;
  if (selectedPool.length < count) {
    const softRejected = rejected
      .filter(c => !c.candidateHardReject)
      .sort((a, b) => b.candidateGateScore - a.candidateGateScore || b.selectionScore - a.selectionScore);
    for (const card of softRejected) {
      if (selectedPool.length >= count) break;
      selectedPool.push({ ...card, candidateGateDecision: 'FALLBACK' });
      fallbackAdded += 1;
    }
  }
  return {
    cards: enriched,
    pool: selectedPool,
    diagnostics: {
      total: enriched.length,
      pass: pass.length,
      caution: caution.length,
      rejected: rejected.length,
      usable: selectedPool.length,
      fallbackAdded,
      hardRejected: rejected.filter(c => c.candidateHardReject).length,
      bronzeRejected: rejected.filter(c => c.bronzeBlocked).length,
      bronzeHardBlock: true,
      minimumRating: enriched[0]?.ratingFloor ?? minimumRatingForBudget(options?.budget, options?.portfolioCount ?? count),
      preferredMinimumRating: enriched[0]?.preferredRatingFloor ?? enriched[0]?.ratingFloor ?? minimumRatingForBudget(options?.budget, options?.portfolioCount ?? count),
      budgetMinimumRating: enriched[0]?.budgetRatingFloor ?? minimumRatingForBudget(options?.budget, options?.portfolioCount ?? count),
      seasonPhase: enriched[0]?.seasonPhase || 'BUDGET_ONLY',
      ratingPolicyMode: enriched[0]?.ratingPolicyMode || 'SEASON_BUDGET',
      adaptiveMarketQ25Rating: enriched[0]?.adaptiveMarketQ25Rating ?? null,
      adaptiveMarketMedianRating: enriched[0]?.adaptiveMarketMedianRating ?? null,
      adaptiveSampleSize: enriched[0]?.adaptiveSampleSize || 0,
      adaptiveBudgetRelaxed: Boolean(enriched[0]?.adaptiveBudgetRelaxed),
      adaptiveBudgetFeasible: enriched[0]?.adaptiveBudgetFeasible ?? null,
      adaptiveDynamicCountMode: Boolean(enriched[0]?.adaptiveDynamicCountMode),
      adaptiveRelaxationDemandMode: enriched[0]?.adaptiveRelaxationDemandMode ?? null,
      adaptiveEstimatedMinimumCost: enriched[0]?.adaptiveEstimatedMinimumCost ?? null,
      promoMarketRegime: enriched[0]?.adaptivePromoMarketRegime ?? null,
      promoHeatScore: enriched[0]?.adaptivePromoHeatScore ?? null,
      promoInPacksSpecials: enriched[0]?.adaptivePromoInPacksSpecials ?? 0,
      promoLiquidSpecials: enriched[0]?.adaptivePromoLiquidSpecials ?? 0,
      promoMomentumSpecials: enriched[0]?.adaptivePromoMomentumSpecials ?? 0,
      activePromoVersions: enriched[0]?.adaptiveActivePromoVersions ?? [],
      demandRelaxationCandidates: enriched.filter(c => c.demandGatedRelaxation && !c.demandRelaxationBlocked).length,
      demandRelaxationRejected: rejected.filter(c => c.demandRelaxationBlocked).length,
      seasonRatingRejected: rejected.filter(c => c.seasonRatingBlocked).length,
      marketRatingRejected: rejected.filter(c => c.marketRatingBlocked).length,
      special84DemandExceptions: enriched.filter(c => c.specialDemandException).length,
      budgetRatingRejected: rejected.filter(c => c.budgetRatingBlocked).length,
      budgetRatingGuard: true,
      seasonPhaseRatingGuard: options?.gameYear !== null && options?.gameYear !== undefined && options?.gameYear !== '' && Number.isFinite(Number(options?.gameYear)),
      lowNonRareRejected: rejected.filter(c => c.lowNonRareBlocked).length,
      midNonRareDemandRejected: rejected.filter(c => c.midNonRareDemandBlocked).length,
      nonRareDemandGate: true,
      mode: 'evidence+safety+quality-gated+bronze-hard-block+promo-live-market-rating+quality-first-dynamic-slots+budget-rating-guard+nonrare-demand-gate'
    }
  };
}
