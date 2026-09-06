import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportedOutcomeScore, outcomeQualityGuard, reportedOutcomeEvidence } from '../src/outcomeLearning.js';

test('v1.0 reported outcome learning is sample damped', () => {
  const tiny = buildReportedOutcomeScore({ reportedFeedbackSamples: 1, reportedSellRate: 1, avgReportedRelists: 0, avgReportedNetProfit: 1800, avgRecommendedNetProfit: 1500, avgResolutionHours: 5 });
  const mature = buildReportedOutcomeScore({ reportedFeedbackSamples: 20, reportedSellRate: 0.85, avgReportedRelists: 1, avgReportedNetProfit: 1600, avgRecommendedNetProfit: 1500, avgResolutionHours: 12 });
  assert.ok(tiny.score < mature.score);
  assert.ok(tiny.score < 60);
  assert.ok(mature.score > 70);
});

test('v1.0 many relists and weak reported outcomes reduce the score', () => {
  const good = buildReportedOutcomeScore({ reportedFeedbackSamples: 20, reportedSellRate: 0.8, avgReportedRelists: 1, avgReportedNetProfit: 1500, avgRecommendedNetProfit: 1500, avgResolutionHours: 12 });
  const weak = buildReportedOutcomeScore({ reportedFeedbackSamples: 20, reportedSellRate: 0.35, avgReportedRelists: 8, avgReportedNetProfit: 700, avgRecommendedNetProfit: 1500, avgResolutionHours: 80 });
  assert.ok(good.score > weak.score);
  assert.ok(weak.adjustment < 0);
});

test('v1.0 outcome guard only hard rejects after enough explicit feedback', () => {
  assert.equal(outcomeQualityGuard({ reportedFeedbackSamples: 3, reportedSellRate: 0.1 }).hardReject, false);
  assert.equal(outcomeQualityGuard({ reportedFeedbackSamples: 12, reportedSellRate: 0.1, avgReportedRelists: 8 }).hardReject, true);
  assert.equal(reportedOutcomeEvidence({ reportedFeedbackSamples: 16 }).evidence, 1);
});
