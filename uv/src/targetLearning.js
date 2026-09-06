import { clamp } from './utils.js';
import { buildReportedOutcomeScore } from './outcomeLearning.js';

export function uvPriceBand(price) {
  const p = Number(price || 0);
  if (p < 1500) return 'P0_1500';
  if (p < 5000) return 'P1500_5000';
  if (p < 15000) return 'P5000_15000';
  if (p < 50000) return 'P15000_50000';
  if (p < 100000) return 'P50000_100000';
  return 'P100000_PLUS';
}

export function uvProfitBand(profit) {
  const p = Number(profit || 0);
  if (p < 700) return 'N0_699';
  if (p < 1000) return 'N700_999';
  if (p < 1250) return 'N1000_1249';
  if (p < 1500) return 'N1250_1499';
  if (p < 2000) return 'N1500_1999';
  if (p < 2500) return 'N2000_2499';
  return 'N2500_3000';
}

export function uvDemandBand(card = {}) {
  const s = Number(card?.saleLikelihoodIndex ?? card?.turnoverIndex ?? card?.demandEvidenceScore ?? 50);
  if (s >= 70) return 'HIGH';
  if (s >= 55) return 'MID';
  return 'LOW';
}

export function uvCardTypeBand(card = {}) {
  return String(card?.cardType || '').toLowerCase() === 'special' ? 'SPECIAL' : 'BASE';
}

export function uvSupplyBand(card = {}) {
  return card?.inPacksHit ? 'IN_PACKS' : 'OUT_OF_PACKS';
}

export function buildTargetProfileKey(card, targetProfit) {
  const buy = Number(card?.recommendedBuyPrice || card?.buyPrice || card?.price || 0);
  return [
    uvPriceBand(buy),
    uvProfitBand(targetProfit),
    uvCardTypeBand(card),
    uvDemandBand(card),
    uvSupplyBand(card)
  ].join('|');
}

export function attachTargetLearningProfiles(card, performanceMap = new Map(), targetProfits = []) {
  const profiles = {};
  for (const target of targetProfits) {
    const key = buildTargetProfileKey(card, target);
    const row = performanceMap?.get?.(key);
    if (!row) continue;
    profiles[String(target)] = {
      profileKey: key,
      marketSamples: Number(row.marketSamples || 0),
      marketSupportRate: Number.isFinite(Number(row.marketSupportRate)) ? Number(row.marketSupportRate) : null,
      avgTargetProximity: Number.isFinite(Number(row.avgTargetProximity)) ? Number(row.avgTargetProximity) : null,
      marketSupportScore: Number.isFinite(Number(row.marketSupportScore)) ? Number(row.marketSupportScore) : 50,
      reportedFeedbackSamples: Number(row.reportedFeedbackSamples || 0),
      reportedSellRate: Number.isFinite(Number(row.reportedSellRate)) ? Number(row.reportedSellRate) : null,
      reportedOutcomeScore: Number.isFinite(Number(row.reportedOutcomeScore)) ? Number(row.reportedOutcomeScore) : null,
      avgReportedRelists: Number.isFinite(Number(row.avgReportedRelists)) ? Number(row.avgReportedRelists) : null,
      avgReportedNetProfit: Number.isFinite(Number(row.avgReportedNetProfit)) ? Number(row.avgReportedNetProfit) : null,
      avgRecommendedNetProfit: Number.isFinite(Number(row.avgRecommendedNetProfit)) ? Number(row.avgRecommendedNetProfit) : null,
      avgReportedRoiPct: Number.isFinite(Number(row.avgReportedRoiPct)) ? Number(row.avgReportedRoiPct) : null,
      avgResolutionHours: Number.isFinite(Number(row.avgResolutionHours)) ? Number(row.avgResolutionHours) : null,
      combinedSupportScore: Number.isFinite(Number(row.combinedSupportScore)) ? Number(row.combinedSupportScore) : 50
    };
  }
  return profiles;
}

export function targetLearningAdjustment(profile = null) {
  if (!profile) return { score: 50, samples: 0, feedbackSamples: 0, outcomeScore: 50, adjustment: 0 };
  const marketSamples = Number(profile.marketSamples || 0);
  const feedbackSamples = Number(profile.reportedFeedbackSamples || 0);
  const outcome = buildReportedOutcomeScore(profile);
  const score = clamp(Number(profile.combinedSupportScore ?? profile.marketSupportScore ?? 50), 0, 100);
  const evidence = clamp(marketSamples / 24 + feedbackSamples / 14, 0, 1);
  const outcomeNudge = feedbackSamples > 0 ? outcome.adjustment * 0.45 : 0;
  return {
    score,
    samples: marketSamples,
    feedbackSamples,
    outcomeScore: outcome.score,
    outcomeEvidence: outcome.evidence,
    adjustment: clamp((score - 50) * 0.15 * evidence + outcomeNudge, -8, 8)
  };
}
