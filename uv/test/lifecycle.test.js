import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendationLifecycle, lifecycleWindowMinutes, recheckRecommendation } from '../src/lifecycle.js';

test('v0.11 stable high-confidence cards get a longer lifecycle than risky supplied cards', () => {
  const stable = lifecycleWindowMinutes({ riskPenalty: 0, supplyPressureScore: 0, stability: 90, confidenceScore: 90, demandDataConfidence: 88, historyTrendPct: 1 });
  const risky = lifecycleWindowMinutes({ riskPenalty: 14, supplyPressureScore: 72, stability: 40, confidenceScore: 55, demandDataConfidence: 45, capitalLockRisk: 60, historyTrendPct: -6 });
  assert.ok(stable.validForMinutes > risky.validForMinutes);
  assert.ok(risky.recheckAfterMinutes <= 20);
  assert.ok(stable.validForMinutes <= 300);
});

test('v0.11 lifecycle exposes explicit recheck and expiry timestamps', () => {
  const out = buildRecommendationLifecycle({ riskPenalty: 0, stability: 80, confidenceScore: 82 }, new Date('2026-09-01T00:00:00Z'));
  assert.equal(out.generatedAt, '2026-09-01T00:00:00.000Z');
  assert.ok(new Date(out.recheckAt) > new Date(out.generatedAt));
  assert.ok(new Date(out.validUntil) > new Date(out.recheckAt));
  assert.equal(out.lifecycleMode, 'price+quality-invalidation-guard');
});

test('v0.11 recheck says WAIT instead of chasing a strong price jump', () => {
  const previous = {
    buyPrice: 10000, sellPrice: 12000, tradeQualityScore: 80, selectionScore: 80,
    recommendationLifecycle: buildRecommendationLifecycle({ riskPenalty: 0, stability: 80, confidenceScore: 80 }, new Date('2026-09-01T00:00:00Z'))
  };
  const fresh = {
    price: 10600, recommendedBuyPrice: 10500, sellPrice: 12500, netProfit: 1375,
    tradeQualityScore: 82, selectionScore: 82, riskPenalty: 0, historyTrendPct: 3,
    qualityEligible: true
  };
  const out = recheckRecommendation(previous, fresh, new Date('2026-09-01T00:30:00Z'));
  assert.equal(out.status, 'WAIT');
  assert.equal(out.actionable, false);
});

test('v0.11 recheck drops a recommendation after a sharp price collapse', () => {
  const previous = { buyPrice: 10000, sellPrice: 12000, tradeQualityScore: 80, selectionScore: 80 };
  const fresh = {
    price: 9100, recommendedBuyPrice: 9000, sellPrice: 10800, netProfit: 1260,
    tradeQualityScore: 70, selectionScore: 68, riskPenalty: 14, historyTrendPct: -9,
    qualityEligible: true
  };
  const out = recheckRecommendation(previous, fresh, new Date('2026-09-01T01:00:00Z'));
  assert.equal(out.status, 'DROP');
  assert.equal(out.actionable, false);
  assert.ok(out.reasons.length > 0);
});

test('v0.11 recheck keeps a recommendation when drift and quality changes are small', () => {
  const previous = { buyPrice: 10000, sellPrice: 12000, tradeQualityScore: 80, selectionScore: 80 };
  const fresh = {
    price: 10100, recommendedBuyPrice: 10000, sellPrice: 12100, netProfit: 1495,
    tradeQualityScore: 82, selectionScore: 81, riskPenalty: 0, historyTrendPct: 1,
    qualityEligible: true
  };
  const out = recheckRecommendation(previous, fresh, new Date('2026-09-01T00:20:00Z'));
  assert.equal(out.status, 'KEEP');
  assert.equal(out.actionable, true);
});
