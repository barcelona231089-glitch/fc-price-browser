import { clamp } from './utils.js';

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function lifecycleWindowMinutes(card = {}) {
  const risk = finite(card.riskPenalty, 0);
  const supply = finite(card.supplyPressureScore, 0);
  const stability = finite(card.stability, 50);
  const confidence = finite(card.confidenceScore, 50);
  const demandConfidence = finite(card.demandDataConfidence, 45);
  const capitalLock = finite(card.capitalLockRisk, 0);
  const trend = finite(card.historyTrendPct, 0);

  // High-risk or fast-moving cards expire sooner. Stable, well-supported cards
  // can remain useful longer, but no generated list is treated as timeless.
  let validFor = 180;
  validFor -= risk * 3.0;
  validFor -= supply * 0.55;
  validFor -= capitalLock * 0.55;
  validFor -= Math.max(0, Math.abs(trend) - 2) * 8;
  validFor += Math.max(0, stability - 60) * 1.2;
  validFor += Math.max(0, confidence - 65) * 0.8;
  validFor += Math.max(0, demandConfidence - 60) * 0.45;
  validFor = Math.round(clamp(validFor, 45, 300));

  let recheckAfter = Math.round(validFor / 3);
  if (risk >= 14 || supply >= 65 || Math.abs(trend) >= 5) recheckAfter = Math.min(recheckAfter, 20);
  else if (risk >= 7 || Math.abs(trend) >= 3) recheckAfter = Math.min(recheckAfter, 30);
  recheckAfter = Math.round(clamp(recheckAfter, 15, 90));

  return { validForMinutes: validFor, recheckAfterMinutes: recheckAfter };
}

export function buildRecommendationLifecycle(card = {}, now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  const { validForMinutes, recheckAfterMinutes } = lifecycleWindowMinutes(card);
  const generatedAt = at.toISOString();
  const recheckAt = new Date(at.getTime() + recheckAfterMinutes * 60_000).toISOString();
  const validUntil = new Date(at.getTime() + validForMinutes * 60_000).toISOString();
  const risk = finite(card.riskPenalty, 0);
  const confidence = finite(card.confidenceScore, 50);
  const stability = finite(card.stability, 50);

  return {
    generatedAt,
    recheckAt,
    validUntil,
    validForMinutes,
    recheckAfterMinutes,
    lifecycleMode: 'price+quality-invalidation-guard',
    invalidationThresholds: {
      dropPricePct: risk >= 14 ? -4 : risk >= 7 ? -5 : -6,
      chasePricePct: confidence >= 78 && stability >= 70 ? 4.5 : 3.0,
      maxRiskPenalty: 20,
      minTradeQualityScore: 43,
      minSelectionScore: 42
    }
  };
}

export function recheckRecommendation(previous = {}, fresh = null, now = new Date()) {
  const oldBuy = finite(previous.buyPrice ?? previous.recommendedBuyPrice ?? previous.price, null);
  const oldSell = finite(previous.sellPrice, null);
  const oldQuality = finite(previous.tradeQualityScore, 50);
  const oldSelection = finite(previous.selectionScore, 50);
  const lifecycle = previous.recommendationLifecycle || buildRecommendationLifecycle(previous, now);

  if (!fresh || !Number.isFinite(Number(fresh.price))) {
    return {
      status: 'MISSING',
      actionable: false,
      reasons: ['Kein aktueller FUT.GG-Preis für diese Kartenposition verfügbar.'],
      previousBuyPrice: oldBuy,
      previousSellPrice: oldSell,
      currentPrice: null,
      recommendationLifecycle: lifecycle
    };
  }

  const live = Number(fresh.price);
  const newBuy = finite(fresh.buyPrice ?? fresh.recommendedBuyPrice ?? live, live);
  const newSell = finite(fresh.sellPrice, null);
  const newProfit = finite(fresh.netProfit, null);
  const newQuality = finite(fresh.tradeQualityScore, 50);
  const newSelection = finite(fresh.selectionScore, 50);
  const risk = finite(fresh.riskPenalty, 0);
  const trend = finite(fresh.historyTrendPct, 0);
  const sourceDiff = finite(fresh.sourceDiffPct, null);
  const thresholds = lifecycle.invalidationThresholds || buildRecommendationLifecycle(previous, now).invalidationThresholds;
  const priceDriftPct = oldBuy > 0 ? ((live - oldBuy) / oldBuy) * 100 : 0;
  const sellDriftPct = oldSell > 0 && newSell > 0 ? ((newSell - oldSell) / oldSell) * 100 : null;
  const qualityDelta = newQuality - oldQuality;
  const selectionDelta = newSelection - oldSelection;
  const reasons = [];

  const hardDrop =
    risk >= Number(thresholds.maxRiskPenalty ?? 20) ||
    fresh.qualityEligible === false ||
    newQuality < Number(thresholds.minTradeQualityScore ?? 43) ||
    newSelection < Number(thresholds.minSelectionScore ?? 42) ||
    trend < -8 ||
    (Number.isFinite(sourceDiff) && Math.abs(sourceDiff) > 22) ||
    priceDriftPct <= Number(thresholds.dropPricePct ?? -6);

  if (hardDrop) {
    if (risk >= Number(thresholds.maxRiskPenalty ?? 20)) reasons.push('Risiko ist über die konservative Grenze gestiegen.');
    if (fresh.qualityEligible === false || newQuality < Number(thresholds.minTradeQualityScore ?? 43)) reasons.push('Trade-Qualität ist nicht mehr ausreichend.');
    if (newSelection < Number(thresholds.minSelectionScore ?? 42)) reasons.push('Gesamtranking ist zu schwach geworden.');
    if (trend < -8) reasons.push('Aktueller Preisverlauf fällt zu stark.');
    if (Number.isFinite(sourceDiff) && Math.abs(sourceDiff) > 22) reasons.push('Quellenabweichung ist zu groß.');
    if (priceDriftPct <= Number(thresholds.dropPricePct ?? -6)) reasons.push('Marktpreis ist deutlich unter die alte Kaufbasis gefallen.');
    return {
      status: 'DROP', actionable: false, reasons,
      previousBuyPrice: oldBuy, previousSellPrice: oldSell,
      currentPrice: live, freshBuyPrice: newBuy, freshSellPrice: newSell, freshNetProfit: newProfit,
      priceDriftPct, sellDriftPct, qualityDelta, selectionDelta,
      recommendationLifecycle: buildRecommendationLifecycle(fresh, now)
    };
  }

  if (priceDriftPct >= Number(thresholds.chasePricePct ?? 3)) {
    reasons.push('Marktpreis liegt klar über der alten Kaufgrenze. Nicht hinterherkaufen.');
    if (newBuy > oldBuy) reasons.push('Eine neue Kaufgrenze wäre höher als die ursprüngliche Empfehlung.');
    return {
      status: 'WAIT', actionable: false, reasons,
      previousBuyPrice: oldBuy, previousSellPrice: oldSell,
      currentPrice: live, freshBuyPrice: newBuy, freshSellPrice: newSell, freshNetProfit: newProfit,
      priceDriftPct, sellDriftPct, qualityDelta, selectionDelta,
      recommendationLifecycle: buildRecommendationLifecycle(fresh, now)
    };
  }

  const materialReprice =
    Math.abs(priceDriftPct) >= 2.0 ||
    (Number.isFinite(sellDriftPct) && Math.abs(sellDriftPct) >= 2.0) ||
    Math.abs(qualityDelta) >= 8 ||
    Math.abs(selectionDelta) >= 8;

  if (materialReprice) {
    reasons.push('Preis oder Qualitätsprofil hat sich seit der Generierung relevant verändert.');
    return {
      status: 'REPRICE', actionable: true, reasons,
      previousBuyPrice: oldBuy, previousSellPrice: oldSell,
      currentPrice: live, freshBuyPrice: newBuy, freshSellPrice: newSell, freshNetProfit: newProfit,
      priceDriftPct, sellDriftPct, qualityDelta, selectionDelta,
      recommendationLifecycle: buildRecommendationLifecycle(fresh, now)
    };
  }

  reasons.push('Preis und Qualitätsprofil liegen weiter nahe an der ursprünglichen Empfehlung.');
  return {
    status: 'KEEP', actionable: true, reasons,
    previousBuyPrice: oldBuy, previousSellPrice: oldSell,
    currentPrice: live, freshBuyPrice: newBuy, freshSellPrice: newSell, freshNetProfit: newProfit,
    priceDriftPct, sellDriftPct, qualityDelta, selectionDelta,
    recommendationLifecycle: buildRecommendationLifecycle(fresh, now)
  };
}
