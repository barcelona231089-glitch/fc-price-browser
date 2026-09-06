import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCompactNumber,
  extractFutbinStructuredEvidence,
  buildSalesEvidence,
  scoreObservedSaleTarget,
  gamesDemandScore
} from '../src/futbinEvidence.js';
import { buildTraderAwarePricing } from '../src/uvEngine.js';

test('v1.1 parses FUTBIN Games counters without losing thousands separators', () => {
  assert.equal(parseCompactNumber('20,052,388'), 20_052_388);
  assert.equal(parseCompactNumber('18.3M'), 18_300_000);
  assert.ok(gamesDemandScore(20_052_388) > gamesDemandScore(100_000));
});

test('v1.1 extracts structured Games and real sold-price samples only when Parse returns them', () => {
  const evidence = extractFutbinStructuredEvidence({
    games: '20,052,388',
    popularity_rank: 3,
    sales_history: [
      { status: 'sold', listed_for: '5,900', sold_for: '5,800' },
      { status: 'sold', listed_for: '5,800', sold_for: '5,700' },
      { status: 'sold', listed_for: '6,000', sold_for: '5,900' },
      { status: 'expired', listed_for: '6,100' }
    ]
  }, 4_500);

  assert.equal(evidence.gamesAvailable, true);
  assert.equal(evidence.futbinGamesCount, 20_052_388);
  assert.equal(evidence.futbinPopularRank, 3);
  assert.equal(evidence.salesHistoryAvailable, true);
  assert.equal(evidence.futbinSoldSampleCount, 3);
  assert.equal(evidence.futbinSoldPriceMedian, 5_800);
  assert.ok(evidence.futbinSalesEvidenceScore > 50);
});

test('v1.1 does not turn active or expired listings into fake sales', () => {
  const sales = buildSalesEvidence([
    { status: 'active', listed_for: 6_000, price: 6_000 },
    { status: 'expired', listed_for: 5_900, price: 5_900 },
    { status: 'unsold', listed_for: 5_800, price: 5_800 }
  ], 4_500);
  assert.equal(sales.available, false);
  assert.equal(sales.soldSampleCount, 0);
});

test('v1.1 real-sale target support rewards observed range and penalizes prices above observed max', () => {
  const evidence = {
    futbinSoldSampleCount: 8,
    futbinSoldPriceP25: 5_600,
    futbinSoldPriceMedian: 5_800,
    futbinSoldPriceP75: 6_000,
    futbinSoldPriceMax: 6_200
  };
  assert.ok(scoreObservedSaleTarget(5_800, evidence) > scoreObservedSaleTarget(6_800, evidence));
  assert.ok(scoreObservedSaleTarget(6_800, evidence) < 50);
});

test('v1.1 trader-aware pricing can use real sold-price support without claiming sales probability', () => {
  const card = {
    recommendedBuyPrice: 4_400,
    price: 4_500,
    uvScore: 84,
    longTermScore: 82,
    saleLikelihoodIndex: 78,
    traderPriorConfidence: 80,
    capitalLockRisk: 5,
    contentRiskScore: 0,
    futbinSoldSampleCount: 12,
    futbinSoldPriceP25: 5_500,
    futbinSoldPriceMedian: 5_700,
    futbinSoldPriceP75: 5_900,
    futbinSoldPriceMax: 6_000
  };
  const pricing = buildTraderAwarePricing(card);
  assert.equal(pricing.salesProbability, null);
  assert.equal(pricing.futbinRealSaleSupportEnabled, true);
  assert.ok(Number.isFinite(pricing.futbinSaleTargetSupportScore));
  assert.ok(pricing.sellPrice <= 6_000);
});

test('v1.1 explicit sales-per-day drives a graded turnover score instead of automatic 100', async () => {
  const { buildLongTermProjection } = await import('../src/uvEngine.js');
  const slow = buildLongTermProjection({ expectedSalesPerDay: 0.5 }, { netProfit: 1000 });
  const fast = buildLongTermProjection({ expectedSalesPerDay: 8 }, { netProfit: 1000 });
  assert.equal(slow.longTermMode, 'sales-backed');
  assert.equal(fast.longTermMode, 'sales-backed');
  assert.ok(slow.turnoverIndex < fast.turnoverIndex);
  assert.ok(fast.turnoverIndex <= 100);
});
