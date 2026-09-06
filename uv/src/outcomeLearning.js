import { clamp } from './utils.js';

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function reportedOutcomeEvidence(profile = null) {
  if (!profile) return { samples: 0, evidence: 0 };
  const samples = Math.max(0, finite(profile.reportedFeedbackSamples, 0));
  return { samples, evidence: clamp(samples / 16, 0, 1) };
}

export function buildReportedOutcomeScore(profile = null) {
  if (!profile) {
    return {
      score: 50,
      samples: 0,
      evidence: 0,
      reportedSellRate: null,
      avgRelists: null,
      avgReportedNetProfit: null,
      avgReportedRoiPct: null,
      avgResolutionHours: null,
      relistEfficiencyScore: 50,
      profitRealizationScore: 50,
      resolutionSpeedScore: 50,
      adjustment: 0
    };
  }

  const { samples, evidence } = reportedOutcomeEvidence(profile);
  const sellRate = finite(profile.reportedSellRate, null);
  const avgRelists = finite(profile.avgReportedRelists, null);
  const avgNetProfit = finite(profile.avgReportedNetProfit, null);
  const avgRecommendedProfit = finite(profile.avgRecommendedNetProfit, null);
  const avgRoiPct = finite(profile.avgReportedRoiPct, null);
  const avgResolutionHours = finite(profile.avgResolutionHours, null);

  const sellScore = sellRate == null ? 50 : clamp(sellRate * 100, 0, 100);
  const relistEfficiencyScore = avgRelists == null ? 50 : clamp(100 - avgRelists * 11, 15, 100);
  const profitRatio = avgNetProfit != null && avgRecommendedProfit != null && avgRecommendedProfit > 0
    ? avgNetProfit / avgRecommendedProfit
    : null;
  const profitRealizationScore = profitRatio == null
    ? (avgRoiPct == null ? 50 : clamp(50 + avgRoiPct * 1.4, 20, 90))
    : clamp(50 + (profitRatio - 1) * 45, 15, 95);
  const resolutionSpeedScore = avgResolutionHours == null
    ? 50
    : avgResolutionHours <= 6 ? 92
    : avgResolutionHours <= 12 ? 84
    : avgResolutionHours <= 24 ? 72
    : avgResolutionHours <= 48 ? 58
    : avgResolutionHours <= 72 ? 46
    : 34;

  const raw = clamp(
    sellScore * 0.52 +
    relistEfficiencyScore * 0.20 +
    profitRealizationScore * 0.18 +
    resolutionSpeedScore * 0.10,
    0,
    100
  );
  const score = clamp(50 * (1 - evidence) + raw * evidence, 10, 95);

  return {
    score,
    samples,
    evidence,
    reportedSellRate: sellRate,
    avgRelists,
    avgReportedNetProfit: avgNetProfit,
    avgRecommendedNetProfit: avgRecommendedProfit,
    avgReportedRoiPct: avgRoiPct,
    avgResolutionHours,
    relistEfficiencyScore,
    profitRealizationScore,
    resolutionSpeedScore,
    adjustment: clamp((score - 50) * 0.16 * evidence, -8, 8)
  };
}

export function outcomeQualityGuard(profile = null) {
  const learned = buildReportedOutcomeScore(profile);
  if (learned.samples < 6) return { ...learned, decision: 'INSUFFICIENT_DATA', hardReject: false };
  const hardReject = learned.samples >= 10 && (
    (learned.reportedSellRate != null && learned.reportedSellRate < 0.22) ||
    learned.score < 30
  );
  const decision = hardReject ? 'AVOID' : learned.score >= 68 ? 'FAVOR' : learned.score < 42 ? 'CAUTION' : 'NEUTRAL';
  return { ...learned, decision, hardReject };
}
