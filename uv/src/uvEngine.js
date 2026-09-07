import { clamp } from './utils.js';
import { targetLearningAdjustment } from './targetLearning.js';
import { scoreObservedSaleTarget } from './futbinEvidence.js';

export function priceStep(price) {
  if (price < 1000) return 50;
  if (price < 10000) return 100;
  if (price < 50000) return 250;
  if (price < 100000) return 500;
  return 1000;
}

export function roundMarketPrice(value, mode = 'nearest') {
  const step = priceStep(value);
  if (mode === 'up') return Math.ceil(value / step) * step;
  if (mode === 'down') return Math.floor(value / step) * step;
  return Math.round(value / step) * step;
}

function maxConservativeMarkupPct(buy) {
  if (buy < 1500) return 0.55;
  if (buy < 5000) return 0.45;
  if (buy < 15000) return 0.30;
  if (buy < 50000) return 0.18;
  if (buy < 100000) return 0.13;
  return 0.09;
}

function targetProfitRange(buy) {
  if (buy < 1500) return { min: 250, max: 700 };
  if (buy < 5000) return { min: 700, max: 1400 };
  if (buy < 15000) return { min: 900, max: 1750 };
  return { min: 1000, max: 2000 };
}

/**
 * Conservative "buy now" ceiling. It never invents a snipe price miles below
 * the observed market. FUT.GG remains the primary anchor; a matching FUTBIN
 * price and our own recent history can only make the ceiling a little safer.
 */
export function buildBuyPlan(card, history = null) {
  const live = Number(card?.price);
  if (!Number.isFinite(live) || live <= 0) return { recommendedBuyPrice: null, buyDiscountPct: 0, buyAnchor: null, buyReason: 'kein Livepreis' };

  let anchor = live;
  const futbin = Number(card?.futbinPrice);
  if (Number.isFinite(futbin) && futbin > 0) {
    const diff = Math.abs((futbin - live) / live) * 100;
    if (diff <= 18) anchor = Math.min(anchor, futbin);
  }

  const recent = Number(history?.avg1h || history?.avg6h || 0);
  if (Number.isFinite(recent) && recent > 0) {
    // History is only allowed to pull the max buy slightly down, never to
    // recommend a fantasy bargain that is not near the live market.
    anchor = Math.min(anchor, Math.max(live * 0.975, recent));
  }

  let discountPct = 0;
  const riskPenalty = Number(card?.riskPenalty || 0);
  const confidence = Number(card?.confidenceScore || 55);
  const popularity = Number(card?.popularityScore || 50);
  const stability = Number(card?.stability || history?.stability || 50);
  const trendPct = Number(card?.historyTrendPct);

  if (Number.isFinite(trendPct) && trendPct < -2.5) discountPct += 0.012;
  if (riskPenalty >= 7) discountPct += 0.006;
  if (riskPenalty >= 14) discountPct += 0.006;
  if (confidence < 58) discountPct += 0.005;
  if (popularity >= 80 && stability >= 70 && riskPenalty === 0) discountPct -= 0.004;
  discountPct = clamp(discountPct, 0, 0.025);

  // Keep the recommendation close enough to the observed BIN to still be a
  // realistic manual buy-now target.
  const raw = Math.max(live * 0.97, anchor * (1 - discountPct));
  const realisticFloor = roundMarketPrice(live * 0.97, 'up');
  const recommendedBuyPrice = Math.max(priceStep(live), realisticFloor, roundMarketPrice(raw, 'down'));
  const actualDiscountPct = Math.max(0, ((live - recommendedBuyPrice) / live) * 100);

  let buyReason = 'Livepreis als Kaufgrenze';
  if (recommendedBuyPrice < live) buyReason = 'leicht unter Livepreis wegen Risiko/Quellen/Verlauf';
  else if (Number.isFinite(futbin) && futbin > 0) buyReason = 'Livepreis durch FUTBIN gegengeprüft';

  return { recommendedBuyPrice, buyDiscountPct: actualDiscountPct, buyAnchor: anchor, buyReason };
}

export function buildPricing(buyPrice, uvScore = 70, longTermScore = 65, options = {}) {
  const buy = roundMarketPrice(buyPrice, 'nearest');
  const range = targetProfitRange(buy);
  const turnover = Number.isFinite(options.turnoverIndex) ? options.turnoverIndex : 60;
  const confidence = Number.isFinite(options.confidenceScore) ? options.confidenceScore : 60;
  const riskPenalty = Number(options.riskPenalty || 0);

  const scoreBoost = clamp((uvScore - 60) * 7 + (longTermScore - 60) * 4, 0, 500);
  // v0.6: prioritize repeatable turnover over stretching the markup. Strong
  // turnover slightly lowers the requested profit, weak turnover never earns a
  // bigger markup (weak candidates are filtered instead).
  const turnoverAdjustment = turnover >= 78 ? -160 : turnover >= 66 ? -80 : turnover >= 55 ? -25 : 0;
  const confidenceBoost = clamp((confidence - 60) * 2.5, -80, 75);
  const riskCut = clamp(riskPenalty * 20, 0, 340);
  const desiredProfit = clamp(range.min + buy * 0.018 + scoreBoost + turnoverAdjustment + confidenceBoost - riskCut, range.min, range.max);
  const desiredSale = (buy + Math.min(desiredProfit, 3000)) / 0.95;
  const markupCapSale = buy * (1 + maxConservativeMarkupPct(buy));
  const sell = Math.max(
    buy + priceStep(buy),
    roundMarketPrice(Math.min(desiredSale, markupCapSale), 'up')
  );
  const tax = Math.floor(sell * 0.05);
  const netAfterTax = sell - tax;
  const profit = netAfterTax - buy;
  const step = priceStep(sell);
  const start = Math.max(buy, roundMarketPrice(sell - step * 2, 'down'));
  return {
    buyPrice: buy,
    startPrice: start,
    sellPrice: sell,
    eaTax: tax,
    netAfterTax,
    netProfit: profit,
    markupPct: buy ? ((sell - buy) / buy) * 100 : 0,
    targetProfitBand: `${range.min}-${range.max}`
  };
}


export function targetProfitCandidates(buy) {
  if (buy < 1500) return [250, 400, 550, 700];
  if (buy < 5000) return [700, 900, 1100, 1400];
  if (buy < 15000) return [900, 1100, 1250, 1500, 1750];
  return [1000, 1250, 1500, 1750, 2000, 2500, 3000];
}

function buildPricingForTargetProfit(buyPrice, targetProfit) {
  const buy = roundMarketPrice(buyPrice, 'nearest');
  const desiredProfit = Math.min(3000, Math.max(0, Number(targetProfit || 0)));
  const desiredSale = (buy + desiredProfit) / 0.95;
  const markupCapSale = buy * (1 + maxConservativeMarkupPct(buy));
  const sell = Math.max(buy + priceStep(buy), roundMarketPrice(Math.min(desiredSale, markupCapSale), 'up'));
  const tax = Math.floor(sell * 0.05);
  const netAfterTax = sell - tax;
  const netProfit = netAfterTax - buy;
  const step = priceStep(sell);
  const start = Math.max(buy, roundMarketPrice(sell - step * 2, 'down'));
  return {
    buyPrice: buy,
    startPrice: start,
    sellPrice: sell,
    eaTax: tax,
    netAfterTax,
    netProfit,
    markupPct: buy ? ((sell - buy) / buy) * 100 : 0,
    requestedTargetProfit: desiredProfit,
    targetProfitBand: `${targetProfitRange(buy).min}-${targetProfitRange(buy).max}`
  };
}

export function buildTraderAwarePricing(card) {
  const buy = Number(card?.recommendedBuyPrice || card?.price);
  if (!Number.isFinite(buy) || buy <= 0) return buildPricing(buy, card?.uvScore, card?.longTermScore, card || {});
  const baseLikelihood = Number.isFinite(card?.saleLikelihoodIndex) ? Number(card.saleLikelihoodIndex) : Number(card?.turnoverIndex || 55);
  const confidence = Number(card?.traderPriorConfidence || card?.confidenceScore || 50);
  const capitalLock = Number(card?.capitalLockRisk || 0);
  const contentRisk = Number(card?.contentRiskScore || 0);
  const candidates = targetProfitCandidates(buy).map(target => {
    const pricing = buildPricingForTargetProfit(buy, target);
    const pQuality = profitQualityScore(pricing.netProfit);
    const learnedProfile = card?.targetLearningProfiles?.[String(target)] || null;
    const learned = targetLearningAdjustment(learnedProfile);
    // Bigger premiums receive a stronger likelihood penalty. The PostgreSQL
    // target-support layer may only nudge this relative index. Observed market
    // support is not a claimed real-world sale probability.
    const stretchAbove2k = Math.max(0, pricing.netProfit - 2000) / 55;
    const markupPressure = Math.max(0, pricing.markupPct - 8) * 0.62;
    const likelihoodIndex = clamp(
      baseLikelihood - stretchAbove2k - markupPressure - capitalLock * 0.10 - contentRisk * 0.06 + (confidence - 50) * 0.05 + learned.adjustment,
      0,
      100
    );
    const capitalEfficiency = clamp(70 - Math.max(0, pricing.markupPct - 10) * 0.8 - capitalLock * 0.24 + likelihoodIndex * 0.25 + learned.adjustment * 0.35, 0, 100);
    const futbinSaleTargetSupportScore = scoreObservedSaleTarget(pricing.sellPrice, card);
    const futbinSaleSamples = Number(card?.futbinSoldSampleCount || 0);
    const empiricalWeight = Number.isFinite(futbinSaleTargetSupportScore) ? Math.min(0.10, futbinSaleSamples / 80) : 0;
    const empiricalAdjustment = Number.isFinite(futbinSaleTargetSupportScore) ? (futbinSaleTargetSupportScore - 50) * empiricalWeight : 0;
    const strategyScore = clamp(likelihoodIndex * 0.46 + pQuality * 0.29 + capitalEfficiency * 0.15 + learned.score * 0.10 + empiricalAdjustment, 0, 100);
    return {
      ...pricing,
      priceLikelihoodIndex: likelihoodIndex,
      pricingStrategyScore: strategyScore,
      futbinSaleTargetSupportScore,
      futbinSaleTargetSupportSamples: futbinSaleSamples,
      pricingProfitQualityScore: pQuality,
      targetSupportScore: learned.score,
      targetSupportSamples: learned.samples,
      reportedFeedbackSamples: learned.feedbackSamples,
      reportedSellRate: learnedProfile?.reportedSellRate ?? null,
      reportedOutcomeScore: learned.outcomeScore ?? learnedProfile?.reportedOutcomeScore ?? 50,
      avgReportedRelists: learnedProfile?.avgReportedRelists ?? null,
      avgReportedNetProfit: learnedProfile?.avgReportedNetProfit ?? null,
      avgRecommendedNetProfit: learnedProfile?.avgRecommendedNetProfit ?? null,
      avgReportedRoiPct: learnedProfile?.avgReportedRoiPct ?? null,
      avgResolutionHours: learnedProfile?.avgResolutionHours ?? null,
      targetLearningProfileKey: learnedProfile?.profileKey || null
    };
  });
  candidates.sort((a, b) => b.pricingStrategyScore - a.pricingStrategyScore || a.netProfit - b.netProfit);
  const chosen = candidates[0] || buildPricing(buy, card?.uvScore, card?.longTermScore, card || {});
  return {
    ...chosen,
    pricingMode: 'trader-prior+target-support+reported-outcome-optimizer',
    futbinRealSaleSupportEnabled: Number(card?.futbinSoldSampleCount || 0) >= 2,
    salesProbability: null,
    pricingCandidates: candidates.map(c => ({
      targetProfit: c.requestedTargetProfit,
      netProfit: c.netProfit,
      sellPrice: c.sellPrice,
      likelihoodIndex: c.priceLikelihoodIndex,
      strategyScore: c.pricingStrategyScore,
      futbinSaleTargetSupportScore: c.futbinSaleTargetSupportScore,
      futbinSaleTargetSupportSamples: c.futbinSaleTargetSupportSamples,
      targetSupportScore: c.targetSupportScore,
      targetSupportSamples: c.targetSupportSamples,
      reportedFeedbackSamples: c.reportedFeedbackSamples,
      reportedSellRate: c.reportedSellRate,
      reportedOutcomeScore: c.reportedOutcomeScore,
      avgReportedRelists: c.avgReportedRelists,
      avgReportedNetProfit: c.avgReportedNetProfit,
      avgReportedRoiPct: c.avgReportedRoiPct,
      avgResolutionHours: c.avgResolutionHours
    }))
  };
}

function deriveHistoryTrend(card, history) {
  if (!history || !card?.price) return { score: 50, pct: null, label: 'unknown' };
  const anchor = history.avg1h || history.avg6h || history.avg24h;
  if (!anchor) return { score: 50, pct: null, label: 'unknown' };
  const pct = ((card.price - anchor) / anchor) * 100;
  let label = 'stable';
  if (pct > 2.5) label = 'rising';
  else if (pct < -2.5) label = 'falling';

  let score = 78;
  if (pct >= -1.5 && pct <= 4.5) score = 92;
  else if (pct > 4.5 && pct <= 9) score = 76;
  else if (pct < -1.5 && pct >= -5) score = 62;
  else if (pct < -5) score = 30;
  else score = 58;
  return { score, pct, label };
}

export function scoreCard(card, history = null, idealPrice = null, marketContext = null) {
  const stability = Number.isFinite(history?.stability) ? history.stability : 52;
  const historyCoverage = history?.samples >= 4 ? 1 : 0;
  const historyTrend = deriveHistoryTrend(card, history);
  const trendScore = historyTrend.score;

  const sourceConfidence = Number.isFinite(card.sourceDiffPct)
    ? clamp(100 - Math.abs(card.sourceDiffPct) * 3.2, 15, 100)
    : 55;
  const budgetFit = idealPrice
    ? clamp(100 - Math.abs(Math.log(Math.max(1, card.price) / Math.max(1, idealPrice))) * 52, 0, 100)
    : 50;

  const priceActivity = Number.isFinite(history?.activityScore) ? history.activityScore : 50;
  const popularity = Number.isFinite(card.popularityScore) ? card.popularityScore : 48;
  const demandEvidence = Number.isFinite(card.demandEvidenceScore) ? card.demandEvidenceScore : popularity;
  let liquidity = Number.isFinite(card.liquidityScore) ? card.liquidityScore : null;
  if (!Number.isFinite(liquidity)) {
    const hasActivity = Number.isFinite(history?.activityScore);
    const hasDemand = Number.isFinite(card.popularityScore);
    if (hasActivity && hasDemand) liquidity = priceActivity * 0.58 + popularity * 0.42;
    else if (hasDemand) liquidity = popularity;
    else liquidity = priceActivity;
  }
  const salesEvidence = Number.isFinite(card.salesEvidenceScore) ? card.salesEvidenceScore : 50;
  const demandConfidence = Number.isFinite(card.demandDataConfidence) ? card.demandDataConfidence : 45;
  const supplyPressure = Number.isFinite(card.supplyPressureScore) ? card.supplyPressureScore : 0;
  const mover = Number.isFinite(card.marketMoverScore) ? card.marketMoverScore : 55;
  const marketStability = Number.isFinite(marketContext?.stabilityScore) ? marketContext.stabilityScore : 55;
  const learningScore = Number.isFinite(card.learning?.performanceScore) ? card.learning.performanceScore : 50;

  const uvScore = clamp(
    stability * 0.14 +
    trendScore * 0.12 +
    sourceConfidence * 0.11 +
    popularity * 0.11 +
    demandEvidence * 0.07 +
    liquidity * 0.17 +
    salesEvidence * 0.05 +
    demandConfidence * 0.04 +
    mover * 0.06 +
    marketStability * 0.04 +
    learningScore * 0.10 -
    supplyPressure * 0.035,
    0,
    100
  );

  const longTermScore = clamp(
    stability * 0.20 +
    sourceConfidence * 0.12 +
    popularity * 0.09 +
    demandEvidence * 0.09 +
    liquidity * 0.20 +
    salesEvidence * 0.07 +
    demandConfidence * 0.05 +
    trendScore * 0.05 +
    mover * 0.02 +
    marketStability * 0.01 +
    learningScore * 0.13 -
    supplyPressure * 0.03,
    0,
    100
  );

  const riskFlags = [];
  if (Number.isFinite(historyTrend.pct) && historyTrend.pct < -5) riskFlags.push('starker Preisrückgang');
  if (Number.isFinite(stability) && history?.samples >= 4 && stability < 35) riskFlags.push('instabiler Preis');
  if (Number.isFinite(card.sourceDiffPct) && Math.abs(card.sourceDiffPct) > 15) riskFlags.push('Quellen weichen stark ab');
  if (Number.isFinite(card.marketMover?.changePct) && card.marketMover.changePct < -7) riskFlags.push('negativer Mover');
  if ((card.learning?.evalCount || 0) >= 3 && (card.learning?.horizonHours || 0) >= 6 && Number(card.learning?.survivalRate) < 0.5) riskFlags.push('schwache historische Preissicherheit');
  if (card.inPacksHit && supplyPressure >= 65 && Number.isFinite(historyTrend.pct) && historyTrend.pct < -2) riskFlags.push('aktuell in Packs + fallender Preis');

  const riskPenalty = Math.min(28, riskFlags.length * 7 + (stability < 25 && history?.samples >= 4 ? 6 : 0));
  const dataCoverage = 2 + historyCoverage + (card.futbinChecked ? 1 : 0) +
    (Number.isFinite(history?.activityScore) ? 1 : 0) +
    (Number.isFinite(card.popularityScore) ? 1 : 0) +
    (Number.isFinite(card.liquidityScore) ? 1 : 0) +
    (Number.isFinite(card.salesEvidenceScore) ? 1 : 0) +
    (Number.isFinite(card.futbinGamesCount) ? 1 : 0) +
    (Number(card.futbinSoldSampleCount || 0) > 0 ? 1 : 0) +
    (Number.isFinite(card.demandEvidenceScore) ? 1 : 0) +
    (Number.isFinite(card.usagePct) ? 1 : 0) +
    (Number.isFinite(card.communityUsagePct) ? 1 : 0) +
    (Number.isFinite(card.proUsagePct) ? 1 : 0) +
    (Number.isFinite(card.demandDataConfidence) ? 1 : 0) +
    (card.momentumHit ? 1 : 0) +
    (card.inPacksHit ? 1 : 0) +
    (card.marketMover ? 1 : 0) +
    ((card.learning?.evalCount || 0) > 0 ? 1 : 0);
  const confidenceScore = clamp(42 + dataCoverage * 7 + Math.max(0, stability - 50) * 0.15 - riskPenalty, 25, 96);

  return {
    uvScore,
    longTermScore,
    stability,
    trendScore,
    historyTrendPct: historyTrend.pct,
    historyTrend: historyTrend.label,
    sourceConfidence,
    budgetFit,
    priceActivityScore: priceActivity,
    popularityScore: popularity,
    demandEvidenceScore: demandEvidence,
    liquidityScore: liquidity,
    demandDataConfidence: demandConfidence,
    supplyPressureScore: supplyPressure,
    learningScore,
    riskFlags,
    riskPenalty,
    confidenceScore,
    dataCoverage
  };
}

export function buildLongTermProjection(card, pricing) {
  const salesPerDay = Number.isFinite(card.expectedSalesPerDay) ? card.expectedSalesPerDay : null;
  if (!Number.isFinite(salesPerDay)) {
    const demand = Number.isFinite(card.popularityScore) ? card.popularityScore : 50;
    const activity = Number.isFinite(card.priceActivityScore) ? card.priceActivityScore : 50;
    const longTerm = Number.isFinite(card.longTermScore) ? card.longTermScore : 50;
    const learning = Number.isFinite(card.learningScore) ? card.learningScore : 50;
    const traderPrior = Number.isFinite(card.traderPriorScore) ? card.traderPriorScore : 50;
    const saleLikelihood = Number.isFinite(card.saleLikelihoodIndex) ? card.saleLikelihoodIndex : 50;
    const capitalLock = Number(card.capitalLockRisk || 0);
    const turnoverIndex = clamp(demand * 0.24 + activity * 0.20 + longTerm * 0.20 + learning * 0.10 + traderPrior * 0.11 + saleLikelihood * 0.15 - capitalLock * 0.08, 0, 100);
    const turnoverBand = turnoverIndex >= 78 ? 'hoch' : turnoverIndex >= 64 ? 'mittel' : turnoverIndex >= 52 ? 'vorsichtig' : 'niedrig';
    return {
      expectedSalesPerDay: null,
      estimatedDailyProfit: null,
      turnoverIndex,
      turnoverBand,
      longTermProfitIndex: Math.round(Math.max(0, pricing.netProfit) * (0.55 + turnoverIndex / 100)),
      longTermMode: Number.isFinite(card.usagePct) || card.momentumHit ? 'demand-backed-proxy' : Number.isFinite(card.priceActivityScore) ? 'activity-proxy' : 'score-only',
      longTermNotice: 'Keine echte Karten-Sales-Frequenz verfügbar. Langfrist-Profit bleibt ein Ranking-Index aus Nachfrage, Preisaktivität, eigener Preissicherheits-Historie und Stabilität, keine erfundene Verkäufe-pro-Tag-Zahl.'
    };
  }
  const salesVelocityScore = clamp(38 + Math.log10(1 + Math.max(0, salesPerDay)) * 31, 38, 100);
  return {
    expectedSalesPerDay: salesPerDay,
    estimatedDailyProfit: Math.round(Math.max(0, pricing.netProfit) * salesPerDay),
    turnoverIndex: salesVelocityScore,
    turnoverBand: salesVelocityScore >= 78 ? 'hoch' : salesVelocityScore >= 64 ? 'mittel' : salesVelocityScore >= 52 ? 'vorsichtig' : 'niedrig',
    longTermProfitIndex: Math.round(Math.max(0, pricing.netProfit) * Math.max(0.35, salesPerDay)),
    longTermMode: 'sales-backed',
    longTermNotice: 'Verkäufe/Tag werden nur verwendet, wenn die strukturierte Quelle diese Kennzahl ausdrücklich liefert; aus einer begrenzten Sales-History-Stichprobe wird keine Tagesrate hochgerechnet.'
  };
}


function profitQualityScore(netProfit) {
  const p = Number(netProfit || 0);
  if (p <= 0) return 0;
  if (p < 400) return 20;
  if (p < 700) return 42;
  if (p < 1000) return 62;
  if (p <= 2000) return clamp(82 + (p - 1000) / 125, 82, 90);
  if (p <= 2500) return 86;
  if (p <= 3000) return 78;
  return 35;
}

export function buildTradingEconomics(card) {
  const firstPricing = buildPricing(card.recommendedBuyPrice || card.price, card.uvScore, card.longTermScore, {
    confidenceScore: card.confidenceScore,
    riskPenalty: card.riskPenalty
  });
  const firstProjection = buildLongTermProjection(card, firstPricing);
  const pricing = Number.isFinite(card.traderPriorScore) || Number.isFinite(card.saleLikelihoodIndex)
    ? buildTraderAwarePricing({ ...card, turnoverIndex: firstProjection.turnoverIndex })
    : buildPricing(card.recommendedBuyPrice || card.price, card.uvScore, card.longTermScore, {
        confidenceScore: card.confidenceScore,
        riskPenalty: card.riskPenalty,
        turnoverIndex: firstProjection.turnoverIndex
      });
  const projection = buildLongTermProjection(card, pricing);
  const roiPct = pricing.buyPrice > 0 ? (pricing.netProfit / pricing.buyPrice) * 100 : 0;
  const profitScore = profitQualityScore(pricing.netProfit);
  // ROI is useful, but capped so a 1k card cannot beat a liquid 20k card only
  // because its percentage looks enormous.
  const roiScore = clamp(48 + Math.min(24, Math.max(0, roiPct) * 1.15), 35, 72);
  const turnover = Number(projection.turnoverIndex || 0);
  const confidence = Number(card.confidenceScore || 50);
  const longTerm = Number(card.longTermScore || 50);
  const uv = Number(card.uvScore || 50);
  const learning = Number(card.learningScore || 50);
  const traderPrior = Number(card.traderPriorScore || 50);
  const saleLikelihood = Number(card.saleLikelihoodIndex || 50);
  const capitalLock = Number(card.capitalLockRisk || 0);
  const targetSupport = Number(pricing.targetSupportScore || 50);
  const reportedOutcome = Number(pricing.reportedOutcomeScore || 50);
  const risk = Number(card.riskPenalty || 0);

  const capitalEfficiencyScore = clamp(
    roiScore * 0.28 +
    profitScore * 0.23 +
    turnover * 0.29 +
    confidence * 0.10 +
    learning * 0.06 +
    traderPrior * 0.06 +
    saleLikelihood * 0.04 +
    targetSupport * 0.04 +
    reportedOutcome * 0.025 -
    capitalLock * 0.10 -
    risk * 0.65,
    0,
    100
  );

  // v0.7: a separate repeatability/long-term-profit layer. This is still a
  // ranking proxy, not a fabricated sales-per-day prediction. It rewards
  // cards that combine demand/turnover, stable history, data confidence and
  // sensible per-sale profit instead of chasing the biggest single markup.
  const demand = Number(card.demandEvidenceScore || card.popularityScore || 50);
  const stability = Number(card.stability || 50);
  const repeatabilityScore = clamp(
    turnover * 0.30 +
    longTerm * 0.20 +
    demand * 0.15 +
    stability * 0.10 +
    learning * 0.10 +
    confidence * 0.09 +
    traderPrior * 0.09 +
    saleLikelihood * 0.07 +
    targetSupport * 0.05 +
    reportedOutcome * 0.03 -
    capitalLock * 0.08 -
    risk * 0.55,
    0,
    100
  );

  const longTermProfitScore = clamp(
    repeatabilityScore * 0.42 +
    profitScore * 0.24 +
    capitalEfficiencyScore * 0.16 +
    longTerm * 0.10 +
    confidence * 0.06 +
    targetSupport * 0.04 +
    reportedOutcome * 0.025 -
    risk * 0.45,
    0,
    100
  );

  const tradeQualityScore = clamp(
    turnover * 0.20 +
    longTerm * 0.18 +
    uv * 0.14 +
    profitScore * 0.11 +
    capitalEfficiencyScore * 0.10 +
    repeatabilityScore * 0.12 +
    longTermProfitScore * 0.08 +
    confidence * 0.06 +
    traderPrior * 0.05 +
    saleLikelihood * 0.05 -
    capitalLock * 0.07 -
    risk * 0.55,
    0,
    100
  );

  const qualityGrade = tradeQualityScore >= 82 ? 'A+' : tradeQualityScore >= 74 ? 'A' : tradeQualityScore >= 64 ? 'B' : tradeQualityScore >= 54 ? 'C' : 'D';
  const weakReasons = [];
  if (pricing.netProfit < 400) weakReasons.push('zu wenig Netto-Profit');
  if (turnover < 45) weakReasons.push('schwacher Turnover-Proxy');
  if (longTerm < 48) weakReasons.push('schwacher Langfrist-Score');
  if (confidence < 44) weakReasons.push('zu wenig Datensicherheit');
  if (risk >= 20) weakReasons.push('zu hohes Risiko');
  if (capitalLock >= 68) weakReasons.push('zu hohes Kapitalbindungsrisiko');

  return {
    ...pricing,
    ...projection,
    roiPct,
    profitQualityScore: profitScore,
    capitalEfficiencyScore,
    repeatabilityScore,
    longTermProfitScore,
    tradeQualityScore,
    qualityGrade,
    qualityEligible: weakReasons.length === 0,
    weakReasons
  };
}

export function buildSellabilityScore(card = {}) {
  const gameplay = Number.isFinite(Number(card.gameplayDemandScore)) ? Number(card.gameplayDemandScore) : Number(card.popularityScore || 50);
  const saleLikelihood = Number(card.saleLikelihoodIndex || 50);
  const turnover = Number(card.turnoverIndex || 50);
  const games = Number.isFinite(Number(card.futbinGamesScore)) ? Number(card.futbinGamesScore) : 50;
  const sales = Number.isFinite(Number(card.futbinSalesEvidenceScore)) ? Number(card.futbinSalesEvidenceScore) : Number(card.salesEvidenceScore || 50);
  const activity = Number(card.priceActivityScore || 50);
  const trend = Number(card.trendScore || 50);
  const stability = Number(card.stability || 50);
  const demandConfidence = Number(card.demandDataConfidence || 45);
  const outcome = Number(card.reportedOutcomeScore || card.learningScore || 50);
  const promo = Number(card.promoMarketScore || 50);
  const risk = Number(card.riskPenalty || 0);
  const capitalLock = Number(card.capitalLockRisk || 0);
  const supply = Number(card.supplyPressureScore || 0);
  const rank = Number(card.futbinPopularRank);
  const rankBoost = Number.isFinite(rank) && rank > 0
    ? rank <= 100 ? 8 : rank <= 250 ? 5 : rank <= 500 ? 3 : 0
    : 0;
  const usageBoost = (Number(card.communityUsagePct || 0) > 0 ? 3 : 0) + (Number(card.proUsagePct || 0) > 0 ? 3 : 0) + (card.momentumHit === true ? 5 : 0);
  return clamp(
    gameplay * 0.16 +
    saleLikelihood * 0.17 +
    turnover * 0.10 +
    games * 0.10 +
    sales * 0.10 +
    activity * 0.08 +
    trend * 0.06 +
    stability * 0.05 +
    demandConfidence * 0.06 +
    outcome * 0.05 +
    promo * 0.07 +
    rankBoost + usageBoost -
    risk * 0.60 -
    capitalLock * 0.06 -
    Math.max(0, supply - 55) * 0.04,
    0,
    100
  );
}

export function buildSelectionScore(card) {
  const overall = Number(card.overall || 0);
  const cardType = String(card.cardType || '').toLowerCase();
  const rarityPreference = cardType === 'special'
    ? 7
    : cardType === 'base rare'
      ? 3
      : cardType === 'base common'
        ? (overall >= 85 ? -3 : overall >= 83 ? -7 : -12)
        : 0;
  const sellability = Number.isFinite(Number(card.sellabilityScore)) ? Number(card.sellabilityScore) : buildSellabilityScore(card);
  return clamp(
    sellability * 0.31 +
    Number(card.tradeQualityScore || 50) * 0.15 +
    Number(card.longTermProfitScore || 50) * 0.09 +
    Number(card.repeatabilityScore || 50) * 0.07 +
    Number(card.longTermScore || 50) * 0.06 +
    Number(card.uvScore || 50) * 0.055 +
    Number(card.capitalEfficiencyScore || 50) * 0.055 +
    Number(card.traderPriorScore || 50) * 0.05 +
    Number(card.promoMarketScore || 50) * 0.035 +
    Number(card.demandDataConfidence || 45) * 0.03 +
    Number(card.targetSupportScore || 50) * 0.025 +
    Number(card.reportedOutcomeScore || 50) * 0.025 +
    Number(card.budgetFit || 50) * 0.045 +
    Number(card.learningScore || 50) * 0.025 +
    (Number(card.budgetTierScore || 50) - 50) * 0.12 +
    rarityPreference -
    Number(card.capitalLockRisk || 0) * 0.08 -
    Number(card.contentRiskScore || 0) * 0.04 -
    Number(card.supplyPressureScore || 0) * 0.02 -
    Number(card.riskPenalty || 0) * 0.62,
    0,
    100
  );
}


function traderSeasonPhaseForGameYear(gameYear, now = new Date()) {
  const gy = Number(gameYear);
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(gy) || Number.isNaN(date.getTime())) return 'UNKNOWN';
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

function traderText(card = {}) {
  return `${card?.rarityName || ''} ${card?.rarityGroupName || ''} ${card?.cardName || ''} ${card?.version || ''}`.toLowerCase();
}

function isPublicTraderSpecial(card = {}) {
  return String(card?.cardType || '').toLowerCase() === 'special';
}

function isFuttiesCard(card = {}) {
  return traderText(card).includes('futties');
}

function normalizedLeague(card = {}) {
  return String(card?.league || '').toLowerCase();
}

function normalizedNation(card = {}) {
  return String(card?.nation || '').toLowerCase();
}

/**
 * v2.7 Budget Tier profile.
 *
 * The observed FutStarz 500k / 1m / 3m / 12m lists are used only as a soft
 * portfolio-shape prior. They are NOT a live price source, not copied player
 * picks and never override FUT.GG, PostgreSQL history, risk gates or the total
 * budget. The profile keeps our historical requirement: exactly 100 actual
 * portfolio slots when the market can safely support them.
 */
export function buildBudgetTierProfile(budget, count = 100) {
  const total = Math.max(1, Number(budget) || 1);
  const slots = Math.max(1, Number(count) || 100);
  const ideal = total / slots;

  let name = 'SMALL_BUDGET';
  let targetPriceRatios = [0.48, 0.74, 1.03, 1.55, 2.45];
  let targetSlotShares = [0.18, 0.30, 0.30, 0.16, 0.06];
  let candidateMinRatio = 0.10;
  let candidateMaxRatio = 5.0;
  let softMaxPositionPct = 0.055;

  if (total >= 400_000 && total < 750_000) {
    name = 'FUTSTARZ_500K_SHAPE';
    targetPriceRatios = [0.55, 0.80, 1.04, 1.55, 2.60];
    targetSlotShares = [0.18, 0.30, 0.30, 0.16, 0.06];
    candidateMinRatio = 0.18;
    candidateMaxRatio = 4.2;
    softMaxPositionPct = 0.050;
  } else if (total >= 750_000 && total < 1_750_000) {
    name = 'FUTSTARZ_1M_SHAPE';
    // The observed 1m tier was unusually concentrated around a low-cost
    // special band. Keep the core tighter, but normalize the final 100-slot
    // ladder back to the user's real total budget.
    targetPriceRatios = [0.72, 0.92, 1.06, 1.32, 1.78];
    targetSlotShares = [0.10, 0.25, 0.40, 0.20, 0.05];
    candidateMinRatio = 0.20;
    candidateMaxRatio = 3.6;
    softMaxPositionPct = 0.045;
  } else if (total >= 1_750_000 && total < 6_000_000) {
    name = 'FUTSTARZ_3M_SHAPE';
    targetPriceRatios = [0.40, 0.72, 1.05, 1.55, 2.20];
    targetSlotShares = [0.16, 0.28, 0.30, 0.19, 0.07];
    candidateMinRatio = 0.16;
    candidateMaxRatio = 4.0;
    softMaxPositionPct = 0.042;
  } else if (total >= 6_000_000) {
    name = 'FUTSTARZ_12M_SHAPE';
    targetPriceRatios = [0.32, 0.62, 1.00, 1.65, 2.85];
    targetSlotShares = [0.14, 0.27, 0.29, 0.21, 0.09];
    candidateMinRatio = 0.14;
    candidateMaxRatio = 4.4;
    softMaxPositionPct = 0.040;
  }

  let specialTargetRatio;
  if (ideal < 1200) specialTargetRatio = 0.15;
  else if (ideal < 2500) specialTargetRatio = 0.24;
  else if (total < 400_000) specialTargetRatio = 0.38;
  else if (total < 750_000) specialTargetRatio = 0.44;
  else if (total < 1_750_000) specialTargetRatio = 0.58;
  else if (total < 6_000_000) specialTargetRatio = 0.68;
  else specialTargetRatio = 0.74;

  return {
    name,
    budget: total,
    count: slots,
    idealPrice: ideal,
    targetPriceRatios,
    targetSlotShares,
    candidateMinRatio,
    candidateMaxRatio,
    softMaxPositionPct,
    specialTargetRatio,
    referenceMode: name.startsWith('FUTSTARZ_') ? 'observed-shape-soft-prior' : 'internal-budget-shape',
    livePriceSource: 'FUT.GG'
  };
}

function budgetTierBandForRatio(ratio) {
  if (ratio <= 0.65) return 'Budget';
  if (ratio <= 1.10) return 'Core';
  if (ratio <= 1.80) return 'Upper';
  if (ratio <= 3.20) return 'Premium';
  return 'High-Premium';
}

export function buildBudgetTierScore(card = {}, { budget = null, count = 100, gameYear = null, now = new Date() } = {}) {
  const total = Math.max(1, Number(budget) || 1);
  const slots = Math.max(1, Number(count) || 100);
  const profile = buildBudgetTierProfile(total, slots);
  const price = Number(card?.recommendedBuyPrice ?? card?.buyPrice ?? card?.price ?? 0);
  const ratio = price > 0 ? price / Math.max(1, profile.idealPrice) : 1;
  const special = isPublicTraderSpecial(card);
  const versionClass = special ? 'SPECIAL' : 'NORMAL';
  const overall = Number(card?.overall || 0);
  const gameplay = clamp(Number(card?.gameplayDemandScore ?? card?.popularityScore ?? 50), 0, 100);
  const sale = clamp(Number(card?.saleLikelihoodIndex ?? 50), 0, 100);
  const turnover = clamp(Number(card?.turnoverIndex ?? 50), 0, 100);
  const activity = clamp(Number(card?.priceActivityScore ?? 50), 0, 100);
  const stability = clamp(Number(card?.stability ?? 50), 0, 100);
  const confidence = clamp(Number(card?.demandDataConfidence ?? card?.confidenceScore ?? 45), 0, 100);
  const usage = Math.max(0, Number(card?.usagePct || 0), Number(card?.communityUsagePct || 0), Number(card?.proUsagePct || 0));
  const profit = profitQualityScore(Number(card?.netProfit || 0));
  const risk = Number(card?.riskPenalty || 0);
  const lock = Number(card?.capitalLockRisk || 0);

  const nearestDistance = Math.min(...profile.targetPriceRatios.map(anchor => Math.abs(Math.log(Math.max(0.01, ratio) / Math.max(0.01, anchor)))));
  const priceTierFit = clamp(100 - nearestDistance * 72, 0, 100);
  const demand = clamp(gameplay * 0.34 + sale * 0.28 + turnover * 0.18 + activity * 0.10 + confidence * 0.10, 0, 100);
  let score = priceTierFit * 0.30 + demand * 0.38 + stability * 0.12 + profit * 0.10 + confidence * 0.10;
  const tags = [versionClass === 'SPECIAL' ? 'SPECIAL_VERSION' : 'NORMAL_VERSION'];

  const demandBacked = demand >= 62 || sale >= 64 || usage > 0 || card?.momentumHit === true;
  if (special) {
    // Rating is deliberately not a gate for Specials. An 84 special with real
    // demand can outrank a higher-rated normal card. Version identity comes from
    // the card record / EA item id, not from artwork or rating assumptions.
    if (demandBacked) {
      const boost = profile.specialTargetRatio >= 0.68 ? 8 : profile.specialTargetRatio >= 0.50 ? 6 : 4;
      score += boost;
      tags.push('SPECIAL_DEMAND_BACKED');
    } else {
      score -= 3;
      tags.push('SPECIAL_NEEDS_DEMAND');
    }
    if (overall > 0 && overall <= 84) tags.push('LOW_RATED_SPECIAL_NOT_BASE_FILLER');
  } else {
    // Normal-card rating remains only a small quality signal here. Hard normal
    // floors/caps stay in the existing safety pipeline and endgame mix guard.
    if (overall >= 87) score += 3;
    else if (overall >= 84) score += 1;
    else if (overall > 0 && overall <= 83) score -= 2;
  }

  const positionPct = price > 0 ? price / total : 0;
  if (positionPct > profile.softMaxPositionPct) {
    const over = (positionPct - profile.softMaxPositionPct) / profile.softMaxPositionPct;
    const concentrationPenalty = demand >= 80 ? Math.min(5, over * 3) : Math.min(14, over * 8);
    score -= concentrationPenalty;
    tags.push('POSITION_SIZE_PENALTY');
  }
  if (ratio >= 0.75 && ratio <= 1.65) tags.push('CORE_PRICE_TIER');
  if (usage > 0) tags.push('FUTGG_USAGE');
  if (card?.momentumHit === true) tags.push('MOMENTUM');

  score -= risk * 0.34;
  score -= lock * 0.06;

  return {
    score: clamp(score, 0, 100),
    profileName: profile.name,
    referenceMode: profile.referenceMode,
    priceRatio: ratio,
    priceTierFit,
    band: budgetTierBandForRatio(ratio),
    versionClass,
    specialTargetRatio: profile.specialTargetRatio,
    tags,
    phase: gameYear == null ? 'UNKNOWN' : traderSeasonPhaseForGameYear(gameYear, now)
  };
}

export function buildPublicTraderEndgameScore(card = {}, { budget = null, count = 100, gameYear = null, now = new Date() } = {}) {
  const phase = gameYear == null ? 'UNKNOWN' : traderSeasonPhaseForGameYear(gameYear, now);
  if (phase !== 'ENDGAME') {
    return { score: 50, active: false, phase, tags: [] };
  }

  const overall = Number(card?.overall || 0);
  const special = isPublicTraderSpecial(card);
  const futties = isFuttiesCard(card);
  const gameplay = Number(card?.gameplayDemandScore ?? card?.popularityScore ?? 50);
  const sale = Number(card?.saleLikelihoodIndex ?? 50);
  const activity = Number(card?.priceActivityScore ?? 50);
  const trend = Number(card?.trendScore ?? 50);
  const confidence = Number(card?.demandDataConfidence ?? 40);
  const usage = Math.max(0, Number(card?.usagePct || 0), Number(card?.communityUsagePct || 0), Number(card?.proUsagePct || 0));
  const risk = Number(card?.riskPenalty || 0);
  const price = Number(card?.recommendedBuyPrice ?? card?.buyPrice ?? card?.price ?? 0);
  const ideal = Number.isFinite(Number(budget)) && Number(budget) > 0
    ? Number(budget) / Math.max(1, Number(count) || 100)
    : Math.max(1, price || 1);

  let score = 50;
  const tags = [];

  // Public ÜV trader consensus: endgame lists should prefer cards people
  // actively search for, higher-rated/liquid names and specials rather than
  // filling a 100-slot list with cheap low-rated golds.
  if (special) { score += 7; tags.push('SPECIAL_PRIORITY'); }
  const futtiesDemandBacked = futties && (gameplay >= 65 || sale >= 60 || card?.momentumHit === true || usage > 0);
  if (futtiesDemandBacked) { score += 9; tags.push('FUTTIES_PRIORITY'); }
  else if (futties) { score += 2; tags.push('FUTTIES_NEEDS_DEMAND'); }
  if (card?.momentumHit === true) { score += 6; tags.push('MOMENTUM'); }
  if (usage > 0) { score += Math.min(8, 2 + usage * 0.8); tags.push('USAGE'); }
  if (gameplay >= 82) { score += 7; tags.push('HIGH_GAMEPLAY_DEMAND'); }
  else if (gameplay >= 70) score += 4;
  else if (gameplay < 48) score -= 5;
  if (sale >= 72) score += 5;
  else if (sale < 45) score -= 4;
  if (activity >= 68) score += 3;
  if (trend >= 60) score += 2;
  if (confidence >= 65) score += 2;

  if (!special) {
    if (overall <= 82) { score -= 18; tags.push('ENDGAME_82_PENALTY'); }
    else if (overall === 83) { score -= 10; tags.push('ENDGAME_83_PENALTY'); }
    else if (overall === 84) score -= 2;
    else if (overall === 85) score += 3;
    else if (overall === 86) score += 5;
    else if (overall >= 87) { score += 7; tags.push('HIGH_RATED_BASE'); }
  }

  // Old but repeatedly documented manual ÜV practice uses popular leagues and
  // nations as a tie-breaker. Keep this deliberately small; live FUT.GG demand
  // remains far more important than static league/nation priors.
  const league = normalizedLeague(card);
  if (['premier league', 'laliga', 'la liga', 'serie a', 'bundesliga', 'ligue 1'].some(x => league.includes(x))) {
    score += 2;
    tags.push('POPULAR_LEAGUE_TIEBREAK');
  }
  const nation = normalizedNation(card);
  if (['england', 'england', 'germany', 'deutschland', 'italy', 'italien', 'spain', 'spanien', 'france', 'frankreich', 'brazil', 'brasilien', 'argentina', 'argentinien', 'portugal'].some(x => nation.includes(x))) {
    score += 1.5;
  }

  // Do not let a premium card consume several normal slots unless the live
  // demand evidence justifies it.
  const priceRatio = ideal > 0 && price > 0 ? price / ideal : 1;
  if (priceRatio > 3.2 && gameplay < 75 && sale < 70) score -= 7;
  else if (priceRatio <= 2.2 && (special || gameplay >= 72)) score += 2;

  score -= risk * 0.28;
  return { score: clamp(score, 0, 100), active: true, phase, tags };
}


/**
 * v2.6 Trader Consensus score.
 *
 * This deliberately does not scrape or depend on private/premium trader feeds.
 * It translates the strongest publicly observable trading ideas into one score:
 * - Futpepi-style budget suitability / complete portfolio fit
 * - FUT.GG usage + momentum as real demand evidence
 * - FUTZIP-style price stability/volatility thinking, implemented with our own
 *   PostgreSQL history, trend and price-activity features
 * - FutStarz-style demand-window/promo awareness
 * - popular-player evidence only as a tie-breaker, never as a hard truth
 *
 * Live safety gates remain outside this score and always win.
 */
export function buildTraderConsensusScore(card = {}, { budget = null, count = 100, gameYear = null, now = new Date() } = {}) {
  const phase = gameYear == null ? 'UNKNOWN' : traderSeasonPhaseForGameYear(gameYear, now);
  const overall = Number(card?.overall || 0);
  const special = isPublicTraderSpecial(card);
  const futties = isFuttiesCard(card);
  const price = Number(card?.recommendedBuyPrice ?? card?.buyPrice ?? card?.price ?? 0);
  const ideal = Number.isFinite(Number(budget)) && Number(budget) > 0
    ? Number(budget) / Math.max(1, Number(count) || 100)
    : Math.max(1, price || 1);

  const gameplay = clamp(Number(card?.gameplayDemandScore ?? card?.popularityScore ?? 50), 0, 100);
  const sale = clamp(Number(card?.saleLikelihoodIndex ?? 50), 0, 100);
  const turnover = clamp(Number(card?.turnoverIndex ?? 50), 0, 100);
  const activity = clamp(Number(card?.priceActivityScore ?? 50), 0, 100);
  const trend = clamp(Number(card?.trendScore ?? 50), 0, 100);
  const stability = clamp(Number(card?.stability ?? 50), 0, 100);
  const confidence = clamp(Number(card?.demandDataConfidence ?? card?.confidenceScore ?? 45), 0, 100);
  const priceFit = Number.isFinite(Number(card?.budgetFit))
    ? clamp(Number(card.budgetFit), 0, 100)
    : clamp(100 - Math.abs(Math.log(Math.max(1, price) / Math.max(1, ideal))) * 52, 0, 100);
  const profit = profitQualityScore(Number(card?.netProfit || 0));
  const promo = clamp(Number(card?.promoMarketScore ?? 50), 0, 100);
  const risk = Number(card?.riskPenalty || 0);
  const capitalLock = Number(card?.capitalLockRisk || 0);
  const supply = Number(card?.supplyPressureScore || 0);
  const usage = Math.max(0, Number(card?.usagePct || 0), Number(card?.communityUsagePct || 0), Number(card?.proUsagePct || 0));

  // Demand is intentionally the heaviest component. A cheap card that nobody
  // wants must not outrank a genuinely searched card simply because it fits the budget.
  const demandComponent = clamp(
    gameplay * 0.46 + sale * 0.25 + turnover * 0.16 + Math.min(100, 50 + usage * 5) * 0.13,
    0, 100
  );

  // Our own observed history stands in for the useful part of market-volatility
  // tools: reward stable, active cards and punish collapsing/erratic ones.
  const marketComponent = clamp(
    stability * 0.42 + activity * 0.28 + trend * 0.22 + confidence * 0.08 - Math.max(0, supply - 60) * 0.10,
    0, 100
  );

  const promoComponent = clamp(
    promo * 0.55 + gameplay * 0.20 + sale * 0.15 + (card?.momentumHit === true ? 10 : 0),
    0, 100
  );

  let score =
    demandComponent * 0.34 +
    marketComponent * 0.20 +
    sale * 0.10 +
    priceFit * 0.12 +
    profit * 0.08 +
    confidence * 0.07 +
    promoComponent * 0.09;

  const tags = [];
  if (usage > 0) tags.push('FUTGG_USAGE');
  if (card?.momentumHit === true) tags.push('DEMAND_SPIKE');
  if (stability >= 70 && activity >= 60) tags.push('STABLE_ACTIVE_MARKET');
  if (sale >= 70) tags.push('SELLABILITY');

  // Endgame portfolio preference. This is a ranking layer, not a safety bypass.
  if (phase === 'ENDGAME') {
    if (special) {
      const demandBacked = demandComponent >= 62 || sale >= 62 || usage > 0 || card?.momentumHit === true;
      if (demandBacked) { score += 6; tags.push('SPECIAL_DEMAND_BACKED'); }
      if (futties && demandBacked) { score += 6; tags.push('FUTTIES_DEMAND_BACKED'); }
      else if (futties) score -= 2;
    } else {
      if (overall <= 82) { score -= 19; tags.push('ENDGAME_LOW82'); }
      else if (overall === 83) { score -= 11; tags.push('ENDGAME_LOW83'); }
      else if (overall === 84) score -= 1;
      else if (overall === 85) score += 3;
      else if (overall === 86) score += 5;
      else if (overall >= 87) { score += 7; tags.push('ENDGAME_HIGH_BASE'); }
    }
  }

  // Expensive cards need stronger demand evidence to justify consuming several
  // average portfolio slots.
  const priceRatio = ideal > 0 && price > 0 ? price / ideal : 1;
  if (priceRatio > 3 && demandComponent < 68) score -= 8;
  else if (priceRatio <= 2.25 && demandComponent >= 68) score += 3;

  score -= risk * 0.36;
  score -= capitalLock * 0.07;

  return {
    score: clamp(score, 0, 100),
    phase,
    tags,
    components: {
      demand: demandComponent,
      market: marketComponent,
      promo: promoComponent,
      budgetFit: priceFit,
      profit,
      confidence
    }
  };
}


export function buildBudgetTop100Score(card = {}, idealPrice = null) {
  const cost = Number(budgetPrice(card) || card.price || 0);
  const ideal = Number.isFinite(Number(idealPrice)) && Number(idealPrice) > 0
    ? Number(idealPrice)
    : Math.max(1, cost || 1);
  const priceFit = Number.isFinite(Number(card.budgetFit))
    ? Number(card.budgetFit)
    : clamp(100 - Math.abs(Math.log(Math.max(1, cost) / Math.max(1, ideal))) * 52, 0, 100);
  const sellability = Number.isFinite(Number(card.sellabilityScore))
    ? Number(card.sellabilityScore)
    : buildSellabilityScore(card);
  const tradeQuality = Number(card.tradeQualityScore || 50);
  const stability = Number(card.stability || 50);
  const confidence = clamp(
    Number(card.confidenceScore || 50) * 0.58 + Number(card.demandDataConfidence || 45) * 0.42,
    0,
    100
  );
  const popularity = Number.isFinite(Number(card.gameplayDemandScore))
    ? Number(card.gameplayDemandScore)
    : Number(card.popularityScore || 50);
  const netProfit = Math.max(0, Number(card.netProfit || 0));
  // The preferred everyday ÜV window is roughly 1k-2k net. More profit can be
  // useful, but it must not dominate sellability or tempt the optimizer into a
  // slow card merely because its theoretical margin is large.
  const profitScore = clamp(netProfit <= 1800 ? (netProfit / 1800) * 100 : 100 - Math.min(25, (netProfit - 1800) / 120), 0, 100);
  const capitalEfficiency = Number(card.capitalEfficiencyScore || 50);
  const risk = Number(card.riskPenalty || 0);
  const capitalLock = Number(card.capitalLockRisk || 0);

  const baseScore =
    sellability * 0.22 +
    tradeQuality * 0.13 +
    stability * 0.10 +
    profitScore * 0.14 +
    confidence * 0.12 +
    popularity * 0.10 +
    priceFit * 0.14 +
    capitalEfficiency * 0.05 -
    risk * 0.40 -
    capitalLock * 0.06;
  const traderConsensusScore = Number(card.traderConsensusScore);
  const budgetTierScore = Number(card.budgetTierScore);
  if (Number.isFinite(traderConsensusScore) && Number.isFinite(budgetTierScore)) {
    // v2.7: sellability/safety remain the majority. Trader Consensus supplies
    // demand/market quality, while Budget Tier adds portfolio-shape fit without
    // turning rating or an external tier list into a hard rule.
    return clamp(baseScore * 0.60 + traderConsensusScore * 0.22 + budgetTierScore * 0.18, 0, 100);
  }
  if (Number.isFinite(traderConsensusScore)) {
    return clamp(baseScore * 0.72 + traderConsensusScore * 0.28, 0, 100);
  }
  if (Number.isFinite(budgetTierScore)) {
    return clamp(baseScore * 0.82 + budgetTierScore * 0.18, 0, 100);
  }
  const traderEndgameScore = Number(card.publicTraderEndgameScore);
  const endgameNudge = card.traderEndgameProfileActive === true && Number.isFinite(traderEndgameScore)
    ? (traderEndgameScore - 50) * 0.34
    : 0;
  return clamp(baseScore + endgameNudge, 0, 100);
}

function targetMultipliers(count, idealPrice = 3000) {
  // v2.7: candidate pool and actual allocation are separate. The ladder below
  // only shapes the 100 actual slots after quality/safety filtering. Budget-tier
  // profiles are soft references and are normalized so the total target spend
  // remains exactly the user's budget rather than copying any external list.
  const profile = buildBudgetTierProfile(Math.max(1, idealPrice) * Math.max(1, count), count);
  const anchors = profile.targetPriceRatios;
  const shares = profile.targetSlotShares;
  const cumulative = [];
  let running = 0;
  for (const share of shares) {
    running += share;
    cumulative.push(running);
  }

  const base = [];
  for (let i = 0; i < count; i++) {
    const q = (i + 0.5) / Math.max(1, count);
    let idx = cumulative.findIndex(limit => q <= limit + 1e-9);
    if (idx < 0) idx = anchors.length - 1;
    base.push(anchors[Math.min(idx, anchors.length - 1)]);
  }
  const mean = base.reduce((a, b) => a + b, 0) / Math.max(1, base.length);
  return base.map(v => v / Math.max(0.0001, mean)).sort((a, b) => a - b);
}

export function specialTargetRatioForBudget(budget, count = 100) {
  return buildBudgetTierProfile(budget, count).specialTargetRatio;
}

export function adaptiveSpecialTargetRatioForMarket(candidates = [], budget, count = 100) {
  const base = specialTargetRatioForBudget(budget, count);
  const ideal = Math.max(1, Number(budget || 0) / Math.max(1, Number(count || 100)));
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter(card => Number.isFinite(budgetPrice(card)))
    .sort((a, b) => Number(b.selectionScore || b.tradeQualityScore || 50) - Number(a.selectionScore || a.tradeQualityScore || 50));
  const sample = rows.slice(0, Math.min(rows.length, Math.max(80, Number(count || 100) * 2)));
  if (!sample.length) return base;
  const special = sample.filter(card => String(card.cardType || '').toLowerCase() === 'special');
  const observed = special.length / sample.length;
  const affordable = sample.filter(card => budgetPrice(card) <= ideal * 2.25);
  const affordableSpecial = affordable.length
    ? affordable.filter(card => String(card.cardType || '').toLowerCase() === 'special').length / affordable.length
    : observed;
  const promoRelevant = special.filter(card =>
    card?.inPacksHit === true &&
    (Number(card.promoMarketScore || 0) >= 58 || card?.momentumHit === true || Number(card.gameplayDemandScore || card.popularityScore || 0) >= 72)
  );
  const promoRelevantShare = sample.length ? promoRelevant.length / sample.length : 0;
  const promoHotShare = special.length
    ? special.filter(card => Number(card.promoMarketScore || 0) >= 68).length / special.length
    : 0;

  // v2.1: promo mix follows the actual live promo footprint. A large supply of
  // specials with no demand does not inflate the target; only promo-relevant,
  // liquid cards add weight.
  const marketAdjusted =
    base * 0.52 +
    observed * 0.18 +
    affordableSpecial * 0.15 +
    promoRelevantShare * 0.10 +
    promoHotShare * 0.05;
  return clamp(
    marketAdjusted,
    Math.max(0.10, base - 0.14),
    Math.min(0.82, base + 0.10)
  );
}

function diversityBonus(card, selected, specialTargetRatio = 0.25) {
  const rarity = String(card.rarityName || card.cardName || card.cardType || 'Unknown');
  const player = String(card.name || '').toLowerCase();
  const usedRarity = selected.filter(c => String(c.rarityName || c.cardName || c.cardType || 'Unknown') === rarity).length;
  const usedPlayer = selected.filter(c => String(c.name || '').toLowerCase() === player).length;
  const specialCount = selected.filter(c => String(c.cardType || '').toLowerCase() === 'special').length;
  const specialRatio = selected.length ? specialCount / selected.length : 0;
  let bonus = 0;
  if (usedRarity === 0) bonus += 0.10;
  else if (usedRarity <= 2) bonus += 0.04;
  else if (usedRarity >= 12) bonus -= 0.08;
  if (usedPlayer >= 2) bonus -= 0.10;

  // v1.5: special cards are a deliberate portfolio component, not an accidental
  // tie-break. This remains a SOFT preference: price fit, risk and reserve
  // feasibility still win, so an expensive promo is never forced into the list.
  const isSpecial = String(card.cardType || '').toLowerCase() === 'special';
  if (isSpecial && specialRatio < specialTargetRatio) {
    const deficit = Math.max(0, specialTargetRatio - specialRatio);
    bonus += 0.08 + Math.min(0.10, deficit * 0.35);
  } else if (isSpecial && specialRatio > specialTargetRatio + 0.06) {
    // Keep the requested mix intelligent rather than turning the list into an
    // all-promo portfolio merely because many specials have similar scores.
    bonus -= 0.08;
  } else if (!isSpecial && specialRatio > specialTargetRatio + 0.06) {
    bonus += 0.035;
  }
  return bonus;
}

function budgetPrice(card) {
  return Number.isFinite(card.recommendedBuyPrice) ? card.recommendedBuyPrice : card.price;
}


function optimizerKey(card) {
  if (card?._optimizerKey) return String(card._optimizerKey);
  return `${String(card?.eaId)}#${Number(card?._portfolioCopyIndex || 1)}`;
}

function estimateUniqueFeasibility(base, budget, count) {
  const sorted = [...base].sort((a, b) =>
    budgetPrice(a) - budgetPrice(b) ||
    Number(b.selectionScore || 0) - Number(a.selectionScore || 0)
  );
  const playerCounts = new Map();
  let spend = 0;
  let selected = 0;
  for (const card of sorted) {
    if (selected >= count) break;
    const cost = budgetPrice(card);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const playerKey = String(card?.name || card?.eaId || '').toLowerCase();
    if ((playerCounts.get(playerKey) || 0) >= 3) continue;
    if (spend + cost > budget) continue;
    playerCounts.set(playerKey, (playerCounts.get(playerKey) || 0) + 1);
    spend += cost;
    selected += 1;
  }
  return { count: selected, spend };
}

function buildOptimizationPool(candidates, budget, count) {
  const base = candidates.map(card => ({
    ...card,
    _portfolioCopyIndex: Number(card?._portfolioCopyIndex || 1),
    _optimizerKey: card?._optimizerKey || `${String(card.eaId)}#1`
  }));
  const uniqueMinimum = [...base]
    .sort((a, b) => budgetPrice(a) - budgetPrice(b))
    .slice(0, Math.min(count, base.length))
    .reduce((sum, card) => sum + budgetPrice(card), 0);

  // v2.3.3: raw candidate count + the 100 cheapest prices are not enough to
  // prove that a unique portfolio is feasible. The real optimizer also caps a
  // footballer at three portfolio slots. A market can therefore contain 100+
  // cheap card versions while only ~60 unique slots survive the player cap.
  // Check the same diversity constraint before deciding that repeat fallback is
  // unnecessary. This keeps unique-first behavior, but enables the already
  // approved second exact copy when unique-only cannot actually reach 100.
  const uniqueFeasibility = estimateUniqueFeasibility(base, Number(budget), Number(count));
  if (uniqueFeasibility.count >= count) {
    return {
      pool: base,
      repeatMode: false,
      uniqueMinimum: uniqueFeasibility.spend,
      repeatedMinimum: uniqueFeasibility.spend,
      uniqueFeasibleCount: uniqueFeasibility.count
    };
  }

  // Quality-preserving feasibility fallback: never lower the rating/risk gates just
  // to fill the 100 slots. Instead allow at most one extra copy of an already
  // approved exact card. The ordinary player-diversity cap still applies, so one
  // footballer cannot dominate the portfolio.
  const repeatCopies = base.map(card => ({
    ...card,
    _portfolioCopyIndex: 2,
    _optimizerKey: `${String(card.eaId)}#2`,
    portfolioRepeatFallback: true
  }));
  let pool = [...base, ...repeatCopies];
  let repeatedMinimum = [...pool]
    .sort((a, b) => budgetPrice(a) - budgetPrice(b))
    .slice(0, Math.min(count, pool.length))
    .reduce((sum, card) => sum + budgetPrice(card), 0);

  // v1.6: never create a third copy of the exact same card. If two approved
  // copies still cannot make the portfolio feasible, fail honestly instead of
  // concentrating the list further or relaxing the active rating guard.
  return {
    pool,
    repeatMode: true,
    uniqueMinimum,
    repeatedMinimum,
    uniqueFeasibleCount: uniqueFeasibility.count
  };
}

export function maxAffordablePortfolioCount(candidates, budget, requestedCount = 100) {
  if (!Number.isFinite(Number(budget)) || Number(budget) <= 0) {
    return { count: 0, minimumSpend: 0, requestedCount, repeatMode: false, uniqueMinimumCost: null };
  }
  const target = Math.max(1, Math.floor(Number(requestedCount) || 100));
  const prepared = buildOptimizationPool(Array.isArray(candidates) ? candidates : [], Number(budget), target);
  const sorted = [...prepared.pool].sort((a, b) =>
    budgetPrice(a) - budgetPrice(b) ||
    Number(b.selectionScore || 0) - Number(a.selectionScore || 0)
  );

  const selectedKeys = new Set();
  const exactCounts = new Map();
  const playerCounts = new Map();
  const selectedCards = [];
  const traderMixPolicy = buildEndgameTraderMixPolicy(prepared.pool, Number(budget), target);
  let spend = 0;
  let count = 0;

  for (const card of sorted) {
    if (count >= target) break;
    const cost = budgetPrice(card);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    if (spend + cost > Number(budget)) continue;

    const key = optimizerKey(card);
    if (selectedKeys.has(key)) continue;
    const exactId = String(card?.eaId);
    const playerKey = String(card?.name || exactId).toLowerCase();
    if ((exactCounts.get(exactId) || 0) >= 2) continue;
    if ((playerCounts.get(playerKey) || 0) >= 3) continue;
    if (!passesEndgameTraderMix(card, selectedCards, traderMixPolicy)) continue;

    selectedKeys.add(key);
    exactCounts.set(exactId, (exactCounts.get(exactId) || 0) + 1);
    playerCounts.set(playerKey, (playerCounts.get(playerKey) || 0) + 1);
    selectedCards.push(card);
    spend += cost;
    count += 1;
  }

  return {
    count,
    minimumSpend: spend,
    requestedCount: target,
    repeatMode: prepared.repeatMode,
    uniqueMinimumCost: prepared.uniqueMinimum,
    repeatedMinimumCost: prepared.repeatedMinimum
  };
}


function buildEndgameTraderMixPolicy(candidates = [], budget, count = 100) {
  const active = (Array.isArray(candidates) ? candidates : []).some(card => card?.traderEndgameProfileActive === true);
  if (!active) return { active: false, maxBase82: Infinity, maxBase83OrLess: Infinity, preferredBaseMin: null };
  const ideal = Number(budget) / Math.max(1, Number(count) || 100);
  if (ideal >= 2500) return { active: true, maxBase82: Math.max(1, Math.round(count * 0.02)), maxBase83OrLess: Math.max(6, Math.round(count * 0.08)), preferredBaseMin: 84 };
  if (ideal >= 1500) return { active: true, maxBase82: Math.max(3, Math.round(count * 0.05)), maxBase83OrLess: Math.max(10, Math.round(count * 0.16)), preferredBaseMin: 84 };
  if (ideal >= 900) return { active: true, maxBase82: Math.max(7, Math.round(count * 0.12)), maxBase83OrLess: Math.max(18, Math.round(count * 0.28)), preferredBaseMin: 83 };
  return { active: true, maxBase82: Math.max(15, Math.round(count * 0.30)), maxBase83OrLess: Math.max(30, Math.round(count * 0.55)), preferredBaseMin: 82 };
}

function isLowEndgameBase(card = {}, maxOverall = 83) {
  return !isPublicTraderSpecial(card) && Number(card?.overall || 0) <= maxOverall;
}

function passesEndgameTraderMix(card, selectedCards = [], policy = null) {
  if (!policy?.active || isPublicTraderSpecial(card)) return true;
  const overall = Number(card?.overall || 0);
  if (!Number.isFinite(overall) || overall <= 0) return true;
  if (overall <= 82) {
    const n82 = selectedCards.filter(x => isLowEndgameBase(x, 82)).length;
    if (n82 >= policy.maxBase82) return false;
  }
  if (overall <= 83) {
    const n83 = selectedCards.filter(x => isLowEndgameBase(x, 83)).length;
    if (n83 >= policy.maxBase83OrLess) return false;
  }
  return true;
}

function optimizerPlayerKey(card = {}) {
  return String(card?.name || card?.eaId || '').toLowerCase();
}

function optimizerRarityKey(card = {}) {
  return String(card?.rarityName || card?.cardName || card?.cardType || 'Unknown');
}

function createOptimizerState(selectedCards = []) {
  const state = {
    playerCounts: new Map(),
    rarityCounts: new Map(),
    specialCount: 0,
    low82Count: 0,
    low83Count: 0,
    size: 0
  };
  for (const card of selectedCards) optimizerStateAdd(state, card);
  return state;
}

function cloneOptimizerState(state) {
  return {
    playerCounts: new Map(state.playerCounts),
    rarityCounts: new Map(state.rarityCounts),
    specialCount: state.specialCount,
    low82Count: state.low82Count,
    low83Count: state.low83Count,
    size: state.size
  };
}

function mapCountBump(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function optimizerStateAdd(state, card) {
  mapCountBump(state.playerCounts, optimizerPlayerKey(card), 1);
  mapCountBump(state.rarityCounts, optimizerRarityKey(card), 1);
  const special = isPublicTraderSpecial(card);
  if (special) state.specialCount += 1;
  else {
    const overall = Number(card?.overall || 0);
    if (Number.isFinite(overall) && overall > 0 && overall <= 82) state.low82Count += 1;
    if (Number.isFinite(overall) && overall > 0 && overall <= 83) state.low83Count += 1;
  }
  state.size += 1;
}

function optimizerStateRemove(state, card) {
  mapCountBump(state.playerCounts, optimizerPlayerKey(card), -1);
  mapCountBump(state.rarityCounts, optimizerRarityKey(card), -1);
  const special = isPublicTraderSpecial(card);
  if (special) state.specialCount = Math.max(0, state.specialCount - 1);
  else {
    const overall = Number(card?.overall || 0);
    if (Number.isFinite(overall) && overall > 0 && overall <= 82) state.low82Count = Math.max(0, state.low82Count - 1);
    if (Number.isFinite(overall) && overall > 0 && overall <= 83) state.low83Count = Math.max(0, state.low83Count - 1);
  }
  state.size = Math.max(0, state.size - 1);
}

function passesEndgameTraderMixState(card, state, policy = null) {
  if (!policy?.active || isPublicTraderSpecial(card)) return true;
  const overall = Number(card?.overall || 0);
  if (!Number.isFinite(overall) || overall <= 0) return true;
  if (overall <= 82 && state.low82Count >= policy.maxBase82) return false;
  if (overall <= 83 && state.low83Count >= policy.maxBase83OrLess) return false;
  return true;
}

function diversityBonusState(card, state, specialTargetRatio = 0.25) {
  const usedRarity = state.rarityCounts.get(optimizerRarityKey(card)) || 0;
  const usedPlayer = state.playerCounts.get(optimizerPlayerKey(card)) || 0;
  const specialRatio = state.size ? state.specialCount / state.size : 0;
  let bonus = 0;
  if (usedRarity === 0) bonus += 0.10;
  else if (usedRarity <= 2) bonus += 0.04;
  else if (usedRarity >= 12) bonus -= 0.08;
  if (usedPlayer >= 2) bonus -= 0.10;

  const isSpecial = isPublicTraderSpecial(card);
  if (isSpecial && specialRatio < specialTargetRatio) {
    const deficit = Math.max(0, specialTargetRatio - specialRatio);
    bonus += 0.08 + Math.min(0.10, deficit * 0.35);
  } else if (isSpecial && specialRatio > specialTargetRatio + 0.06) {
    bonus -= 0.08;
  } else if (!isSpecial && specialRatio > specialTargetRatio + 0.06) {
    bonus += 0.035;
  }
  return bonus;
}

function constrainedCheapestRows(candidates = [], count = 100, policy = null) {
  const sorted = [...candidates].sort((a, b) => budgetPrice(a) - budgetPrice(b) || Number(b.budgetTop100Score || b.selectionScore || 0) - Number(a.budgetTop100Score || a.selectionScore || 0));
  const selected = [];
  const state = createOptimizerState();
  for (const card of sorted) {
    if (selected.length >= count) break;
    const playerKey = optimizerPlayerKey(card);
    if ((state.playerCounts.get(playerKey) || 0) >= 3) continue;
    if (!passesEndgameTraderMixState(card, state, policy)) continue;
    selected.push(card);
    optimizerStateAdd(state, card);
  }
  return selected;
}

// v2.9.2 CPU-SAFE: same greedy portfolio logic as before, but all player/rarity/
// endgame counts are maintained incrementally. The old implementation repeatedly
// filtered the whole selected array inside both the reserve scan and every
// candidate comparison, turning a 5k-card pool into tens/hundreds of millions
// of JS operations on constrained hosts.
function chooseClosestCpuSafe(candidates, target, selectedIds, state, remaining, slotsLeft, cheapestSorted, specialTargetRatio = 0.25, traderMixPolicy = null) {
  const reserveList = [];
  const reserveState = cloneOptimizerState(state);
  for (const c of cheapestSorted) {
    if (selectedIds.has(optimizerKey(c))) continue;
    const playerKey = optimizerPlayerKey(c);
    if ((reserveState.playerCounts.get(playerKey) || 0) >= 3) continue;
    if (!passesEndgameTraderMixState(c, reserveState, traderMixPolicy)) continue;
    reserveList.push(c);
    optimizerStateAdd(reserveState, c);
    if (reserveList.length >= slotsLeft) break;
  }
  if (reserveList.length < slotsLeft) return null;

  const reserveSumAll = reserveList.reduce((sum, c) => sum + budgetPrice(c), 0);
  const reserveIds = new Set(reserveList.map(c => optimizerKey(c)));
  const highestReserved = budgetPrice(reserveList[reserveList.length - 1]) || 0;

  let best = null;
  let bestValue = Infinity;
  for (const c of candidates) {
    const id = optimizerKey(c);
    if (selectedIds.has(id)) continue;
    if ((state.playerCounts.get(optimizerPlayerKey(c)) || 0) >= 3) continue;
    if (!passesEndgameTraderMixState(c, state, traderMixPolicy)) continue;
    const cost = budgetPrice(c);
    const reserveAfterChoice = reserveIds.has(id) ? reserveSumAll - cost : reserveSumAll - highestReserved;
    if (cost + reserveAfterChoice > remaining) continue;

    const distance = Math.abs(Math.log(Math.max(1, cost) / Math.max(1, target)));
    const qualityPenalty = (100 - (c.budgetTop100Score ?? c.selectionScore ?? c.tradeQualityScore ?? c.uvScore ?? 50)) / 132;
    const riskPenalty = (c.riskPenalty || 0) / 150;
    const diversity = diversityBonusState(c, state, specialTargetRatio);
    const value = distance * 0.70 + qualityPenalty + riskPenalty - diversity;
    if (value < bestValue) { best = c; bestValue = value; }
  }
  return best;
}

function chooseClosest(candidates, target, selectedIds, selectedCards, remaining, slotsLeft, cheapestSorted, specialTargetRatio = 0.25, traderMixPolicy = null) {
  return chooseClosestCpuSafe(
    candidates,
    target,
    selectedIds,
    createOptimizerState(selectedCards),
    remaining,
    slotsLeft,
    cheapestSorted,
    specialTargetRatio,
    traderMixPolicy
  );
}

function improveBudgetCpuSafe(selected, candidates, budget, protectedIds = new Set(), specialTargetRatio = 0.25, traderMixPolicy = null) {
  let total = selected.reduce((sum, c) => sum + budgetPrice(c), 0);
  const selectedIds = new Set(selected.map(c => optimizerKey(c)));
  const unselected = candidates.filter(c => !selectedIds.has(optimizerKey(c))).sort((a, b) => budgetPrice(a) - budgetPrice(b));
  const state = createOptimizerState(selected);

  // Keep the original 16-pass ceiling, but each comparison is now O(1) for
  // diversity/player/endgame checks instead of rebuilding 100-card arrays.
  for (let round = 0; round < 16; round++) {
    let improved = false;
    if (budget - total <= 0) break;
    for (let i = 0; i < selected.length; i++) {
      const gap = budget - total;
      if (gap <= 0) break;
      const old = selected[i];
      if (protectedIds.has(String(old.eaId))) continue;

      optimizerStateRemove(state, old);
      let best = null;
      let bestGap = gap;
      const currentSpecialRatio = selected.length ? (state.specialCount + (isPublicTraderSpecial(old) ? 1 : 0)) / selected.length : 0;

      for (const cand of unselected) {
        if (selectedIds.has(optimizerKey(cand))) continue;
        if ((state.playerCounts.get(optimizerPlayerKey(cand)) || 0) >= 3) continue;
        if (!passesEndgameTraderMixState(cand, state, traderMixPolicy)) continue;
        const delta = budgetPrice(cand) - budgetPrice(old);
        if (delta <= 0 || delta > gap) continue;
        const newGap = gap - delta;
        const qualityLoss = (old.selectionScore ?? 50) - (cand.selectionScore ?? 50);
        if (qualityLoss > 10) continue;
        if ((cand.riskPenalty || 0) > (old.riskPenalty || 0) + 8) continue;
        const oldSpecial = isPublicTraderSpecial(old);
        const candSpecial = isPublicTraderSpecial(cand);
        if (oldSpecial && !candSpecial && currentSpecialRatio <= specialTargetRatio + 0.02) continue;
        if (newGap < bestGap) { best = cand; bestGap = newGap; if (newGap === 0) break; }
      }

      if (best) {
        selectedIds.delete(optimizerKey(old));
        selectedIds.add(optimizerKey(best));
        selected[i] = best;
        total += budgetPrice(best) - budgetPrice(old);
        optimizerStateAdd(state, best);
        improved = true;
        if (total === budget) return { selected, total };
      } else {
        optimizerStateAdd(state, old);
      }
    }
    if (!improved) break;
  }
  return { selected, total };
}

function improveBudget(selected, candidates, budget, protectedIds = new Set(), specialTargetRatio = 0.25, traderMixPolicy = null) {
  return improveBudgetCpuSafe(selected, candidates, budget, protectedIds, specialTargetRatio, traderMixPolicy);
}

export function optimizeList(candidates, budget, count = 100) {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Budget muss größer als 0 sein.');

  const prepared = buildOptimizationPool(candidates, budget, count);
  const optimizationCandidates = prepared.pool;
  if (optimizationCandidates.length < count) throw new Error(`Nicht genug passende Karten gefunden (${optimizationCandidates.length}/${count}).`);

  const cheapestSorted = [...optimizationCandidates].sort((a, b) => budgetPrice(a) - budgetPrice(b));
  const traderMixPolicy = buildEndgameTraderMixPolicy(optimizationCandidates, budget, count);
  const constrainedMinimumRows = constrainedCheapestRows(optimizationCandidates, count, traderMixPolicy);
  if (constrainedMinimumRows.length < count) {
    throw new Error(`Trader-Endgame-Mix findet nur ${constrainedMinimumRows.length}/${count} zulässige Slots. Zu viele 82/83-Füllkarten wären nötig.`);
  }
  const minimumCost = constrainedMinimumRows.reduce((sum, c) => sum + budgetPrice(c), 0);
  if (minimumCost > budget) {
    const uniqueText = Number.isFinite(prepared.uniqueMinimum) ? ` Unterschiedliche Karten: ${prepared.uniqueMinimum} Coins.` : '';
    throw new Error(`Budget zu klein für ${count} geeignete Karten bei maximal 2 Exemplaren pro exakter Karte. Minimum aktuell: ${minimumCost} Coins.${uniqueText}`);
  }

  const multipliers = targetMultipliers(count, budget / count);
  const specialTargetRatio = adaptiveSpecialTargetRatioForMarket(optimizationCandidates, budget, count);
  const selected = [];
  const ids = new Set();
  const selectionState = createOptimizerState();
  const multiplierSuffix = new Array(multipliers.length + 1).fill(0);
  for (let i = multipliers.length - 1; i >= 0; i--) multiplierSuffix[i] = multiplierSuffix[i + 1] + multipliers[i];
  let remaining = budget;

  for (let i = 0; i < count; i++) {
    const slotsLeft = count - i;
    const remainingMultiplierSum = multiplierSuffix[i];
    const target = remaining * (multipliers[i] / Math.max(0.0001, remainingMultiplierSum));
    const choice = chooseClosestCpuSafe(optimizationCandidates, target, ids, selectionState, remaining, slotsLeft, cheapestSorted, specialTargetRatio, traderMixPolicy);
    if (!choice) break;
    selected.push(choice);
    ids.add(optimizerKey(choice));
    optimizerStateAdd(selectionState, choice);
    remaining -= budgetPrice(choice);
  }

  // v2.9.1: hard-100 allocator rescue. The affordability guard above already
  // proved that a valid 100-slot portfolio exists. The tier-aware greedy pass
  // must therefore never turn that proven-feasible pool into a partial list.
  // If the greedy path paints itself into a corner because of player-diversity
  // or endgame-mix interactions, restart from the already validated cheapest
  // constrained 100-slot baseline and then improve it toward the user's budget.
  let allocationRescueUsed = false;
  let allocationBase = selected;
  if (selected.length < count) {
    allocationRescueUsed = true;
    allocationBase = constrainedMinimumRows.slice(0, count).map(card => ({
      ...card,
      portfolioFeasibilityRescue: true
    }));
  }

  if (allocationBase.length < count) {
    throw new Error(`Allocator-Rescue konnte nur ${allocationBase.length}/${count} Karten zusammenstellen, obwohl die Vorprüfung das Portfolio als machbar markiert hatte.`);
  }

  const improved = improveBudgetCpuSafe(allocationBase, optimizationCandidates, budget, new Set(), specialTargetRatio, traderMixPolicy);
  return {
    ...improved,
    repeatMode: prepared.repeatMode,
    repeatedSlots: improved.selected.filter(card => Number(card?._portfolioCopyIndex || 1) > 1).length,
    uniqueMinimumCost: prepared.uniqueMinimum,
    specialTargetRatio,
    traderMixPolicy,
    allocationRescueUsed
  };
}


export function optimizeListWithSeed(candidates, budget, count = 100, seed = []) {
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('Budget muss größer als 0 sein.');
  if (!Number.isInteger(count) || count <= 0) throw new Error('count muss größer als 0 sein.');

  const prepared = buildOptimizationPool(candidates, budget, count);
  const optimizationCandidates = prepared.pool;
  const selected = [];
  const ids = new Set();
  const playerCounts = new Map();
  const exactCounts = new Map();

  for (const rawCard of Array.isArray(seed) ? seed : []) {
    if (!rawCard || !Number.isFinite(budgetPrice(rawCard))) continue;
    const exactId = String(rawCard.eaId);
    const nextCopy = (exactCounts.get(exactId) || 0) + 1;
    if (nextCopy > 2) continue;
    const card = {
      ...rawCard,
      _portfolioCopyIndex: Number(rawCard?._portfolioCopyIndex || nextCopy),
      _optimizerKey: rawCard?._optimizerKey || `${exactId}#${nextCopy}`
    };
    const key = optimizerKey(card);
    if (ids.has(key)) continue;
    const playerKey = String(card.name || '').toLowerCase();
    if ((playerCounts.get(playerKey) || 0) >= 3) continue;
    selected.push(card);
    ids.add(key);
    exactCounts.set(exactId, nextCopy);
    playerCounts.set(playerKey, (playerCounts.get(playerKey) || 0) + 1);
    if (selected.length >= count) break;
  }

  let remaining = budget - selected.reduce((sum, c) => sum + budgetPrice(c), 0);
  if (remaining < 0) throw new Error('Fixierte Karten überschreiten das Gesamtbudget.');
  const slotsNeeded = count - selected.length;
  if (slotsNeeded === 0) return { selected, total: budget - remaining, repeatMode: prepared.repeatMode };

  const available = optimizationCandidates.filter(c => !ids.has(optimizerKey(c)));
  if (available.length < slotsNeeded) throw new Error(`Nicht genug Ersatzkarten gefunden (${available.length}/${slotsNeeded}).`);
  const cheapestSorted = [...available].sort((a, b) => budgetPrice(a) - budgetPrice(b));
  const traderMixPolicy = buildEndgameTraderMixPolicy(optimizationCandidates, budget, count);
  const constrainedMinimumRows = [];
  const provisionalSelected = [...selected];
  for (const card of cheapestSorted) {
    if (constrainedMinimumRows.length >= slotsNeeded) break;
    if (!passesEndgameTraderMix(card, [...provisionalSelected, ...constrainedMinimumRows], traderMixPolicy)) continue;
    constrainedMinimumRows.push(card);
  }
  if (constrainedMinimumRows.length < slotsNeeded) throw new Error(`Trader-Endgame-Mix findet nur ${constrainedMinimumRows.length}/${slotsNeeded} passende Ersatzpositionen.`);
  const minimumCost = constrainedMinimumRows.reduce((sum, c) => sum + budgetPrice(c), 0);
  if (minimumCost > remaining) throw new Error(`Budget zu klein für die ${slotsNeeded} Ersatzpositionen. Minimum aktuell: ${minimumCost} Coins.`);
  const multipliers = targetMultipliers(slotsNeeded, remaining / Math.max(1, slotsNeeded));
  const specialTargetRatio = adaptiveSpecialTargetRatioForMarket(optimizationCandidates, budget, count);

  for (let i = 0; i < slotsNeeded; i++) {
    const slotsLeft = slotsNeeded - i;
    const remainingMultiplierSum = multipliers.slice(i).reduce((a, b) => a + b, 0);
    const target = remaining * (multipliers[i] / Math.max(0.0001, remainingMultiplierSum));
    const choice = chooseClosest(available, target, ids, selected, remaining, slotsLeft, cheapestSorted, specialTargetRatio, traderMixPolicy);
    if (!choice) break;
    selected.push(choice);
    ids.add(optimizerKey(choice));
    remaining -= budgetPrice(choice);
  }

  if (selected.length < count) throw new Error(`Konnte nur ${selected.length}/${count} Karten mit den fixierten Positionen innerhalb des Budgets zusammenstellen.`);
  const protectedIds = new Set((Array.isArray(seed) ? seed : []).map(c => String(c.eaId)));
  const improved = improveBudget(selected, optimizationCandidates, budget, protectedIds, specialTargetRatio, traderMixPolicy);
  return {
    ...improved,
    repeatMode: prepared.repeatMode,
    repeatedSlots: improved.selected.filter(card => Number(card?._portfolioCopyIndex || 1) > 1).length,
    uniqueMinimumCost: prepared.uniqueMinimum,
    specialTargetRatio,
    traderMixPolicy
  };
}


export function capitalBandForPrice(price, budget, count = 100) {
  const ideal = Math.max(1, budget / count);
  const ratio = Number(price || 0) / ideal;
  if (ratio <= 0.65) return 'Budget';
  if (ratio <= 1.10) return 'Core';
  if (ratio <= 1.80) return 'Upper';
  return 'Premium';
}

export function buildPortfolioSummary(cards, budget, count = 100) {
  const list = Array.isArray(cards) ? cards : [];
  const bands = { Budget: { count: 0, spend: 0 }, Core: { count: 0, spend: 0 }, Upper: { count: 0, spend: 0 }, Premium: { count: 0, spend: 0 } };
  const costs = [];
  let specialSpend = 0;
  let total = 0;
  for (const card of list) {
    const cost = budgetPrice(card);
    const band = capitalBandForPrice(cost, budget, count);
    bands[band].count += 1;
    bands[band].spend += cost;
    costs.push(cost);
    total += cost;
    if (card.cardType === 'Special') specialSpend += cost;
  }
  costs.sort((a, b) => a - b);
  const medianBuy = costs.length ? (costs.length % 2 ? costs[(costs.length - 1) / 2] : (costs[costs.length / 2 - 1] + costs[costs.length / 2]) / 2) : 0;
  const top10Spend = [...costs].sort((a, b) => b - a).slice(0, Math.min(10, costs.length)).reduce((a, b) => a + b, 0);
  const top10SpendPct = total ? (top10Spend / total) * 100 : 0;
  const specialSpendPct = total ? (specialSpend / total) * 100 : 0;
  const avgRepeatability = list.length ? list.reduce((s, c) => s + Number(c.repeatabilityScore || 50), 0) / list.length : 0;
  const avgLongTermProfit = list.length ? list.reduce((s, c) => s + Number(c.longTermProfitScore || 50), 0) / list.length : 0;
  const avgRisk = list.length ? list.reduce((s, c) => s + Number(c.riskPenalty || 0), 0) / list.length : 0;
  const diversificationScore = clamp(100 - Math.max(0, top10SpendPct - 28) * 1.6, 45, 100);
  const portfolioScore = clamp(avgLongTermProfit * 0.45 + avgRepeatability * 0.30 + diversificationScore * 0.15 + (100 - Math.min(100, avgRisk * 4)) * 0.10, 0, 100);
  return {
    bands,
    totalSpend: total,
    averageBuy: list.length ? total / list.length : 0,
    medianBuy,
    top10SpendPct,
    specialSpendPct,
    diversificationScore,
    avgRepeatability,
    avgLongTermProfit,
    portfolioScore
  };
}

export function buildCandidatePool(cards, budget, count = 100) {
  const ideal = budget / count;
  const tierProfile = buildBudgetTierProfile(budget, count);
  let minPrice = Math.max(150, ideal * tierProfile.candidateMinRatio);
  let maxPrice = Math.min(budget * 0.075, ideal * tierProfile.candidateMaxRatio);
  let pool = cards.filter(c => Number.isFinite(c.price) && c.price >= minPrice && c.price <= maxPrice);
  if (pool.length < count * 3) {
    // Safety/quality pool first, allocation second. Widen only the candidate
    // universe when needed; do not lower the normal-card safety floors here.
    minPrice = Math.max(150, ideal * 0.05);
    maxPrice = Math.min(budget * 0.12, ideal * 8.0);
    pool = cards.filter(c => Number.isFinite(c.price) && c.price >= minPrice && c.price <= maxPrice);
  }
  return { pool, ideal, minPrice, maxPrice, tierProfile };
}

export function filterConservativeCandidates(cards, count = 100) {
  const safe = cards.filter(c => {
    if ((c.riskPenalty || 0) >= 20) return false;
    if (c.history?.samples >= 5 && c.stability < 22) return false;
    if (Number.isFinite(c.historyTrendPct) && c.historyTrendPct < -8) return false;
    if ((c.learning?.evalCount || 0) >= 4 && (c.learning?.horizonHours || 0) >= 6 && Number(c.learning?.survivalRate) < 0.4) return false;
    if (c.qualityEligible === false) return false;
    if (Number.isFinite(c.tradeQualityScore) && c.tradeQualityScore < 48) return false;
    return true;
  });
  // Quality first when the data universe is large enough. If the market is
  // temporarily thin, fall back gradually rather than failing the user.
  if (safe.length >= count * 1.45) return safe;
  const medium = cards.filter(c => (c.riskPenalty || 0) < 20 && (!Number.isFinite(c.tradeQualityScore) || c.tradeQualityScore >= 43));
  return medium.length >= count * 1.25 ? medium : cards;
}
