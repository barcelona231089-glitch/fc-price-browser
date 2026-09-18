import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, getPermanentMlStatusV106996 } from '../permanentMlBrainV106996.js';

test('decision features keep leak/trader evidence bounded', () => {
  const x = __test.decisionFeatures({
    change1m: 2, change5m: 5, change15m: 10, change1h: 14, change24h: 18,
    change7d: 30, change30d: 50, distanceTo24hLow: 3,
    ratingMarketRisingPct: 75, ratingMarketFallingPct: 15, ratingMarketLogicScore: 68,
    marketContext: { publicLeaks: { active: true, impactScore: 80, marketReaction: true }, packSupplyActive: false },
    discordSignals: [{}, {}]
  });
  assert.equal(x.length, 15);
  assert.ok(x.every(v => Number.isFinite(v) && v >= -3 && v <= 3));
  assert.equal(x[9], 1);
  assert.equal(x[11], 1);
});

test('walk-forward logistic learner learns separable outcome pattern', () => {
  const samples = [];
  for (let i = 0; i < 320; i++) {
    const positive = i % 2 === 0;
    samples.push({ x: [positive ? 1.2 : -1.2, positive ? 0.7 : -0.7], y: positive });
  }
  const model = __test.trainLogistic(samples, ['a','b'], { epochs: 16, lr: 0.06 });
  assert.ok(model);
  assert.ok(model.metrics.balancedAccuracy > 0.9);
  assert.equal(model.trusted, true);
  assert.ok(__test.predict(model, [1.2, 0.7]) > 0.8);
  assert.ok(__test.predict(model, [-1.2, -0.7]) < 0.2);
});

test('cycle learner derives samples only from supplied observed rows', () => {
  const rows = [];
  const start = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < 900; i++) {
    rows.push({ ea_id: '123', bucket_at: new Date(start + i * 6 * 3600_000).toISOString(), price: 10000 + Math.round(Math.sin(i / 20) * 500) + i });
  }
  const result = __test.historicalCycleSamples(rows);
  assert.ok(result.samples24h.length > 0);
  assert.ok(result.samples7d.length > 0);
  assert.ok(result.samples24h.every(s => s.x.length === 5));
});

test('status advertises a strict 24-month / 730-day target', () => {
  const status = getPermanentMlStatusV106996();
  assert.equal(status.learningWindowDays, 730);
  assert.equal(status.performanceWindowDays, 730);
  assert.equal(status.targetMonths, 24);
  assert.deepEqual(status.historicalSourceYears, ['25','26']);
  assert.equal(status.policy.rawPricesNeverMergedAcrossGameYears, true);
  assert.equal(status.policy.noSyntheticBackfill, true);
  assert.equal(status.autonomousArchitecture.architectureFrozen, true);
  assert.equal(status.autonomousArchitecture.operationalTargetMonths, 12);
  assert.equal(status.autonomousArchitecture.championChallenger, true);
  assert.equal(status.autonomousArchitecture.driftDetection, true);
  assert.equal(status.autonomousArchitecture.manualIntelligenceUpgradeExpected, false);
});

test('trained models retain feature baselines for drift detection', () => {
  const samples = [];
  for (let i = 0; i < 320; i++) {
    const positive = i % 2 === 0;
    samples.push({ x: [positive ? 1.1 : -1.1, positive ? 0.6 : -0.6], y: positive });
  }
  const model = __test.trainLogistic(samples, ['a','b'], { epochs: 14, lr: 0.06 });
  assert.ok(Array.isArray(model.metrics.featureStats));
  assert.equal(model.metrics.featureStats.length, 2);
  const normal = __test.modelFeatureDrift(model, [1.0, 0.5]);
  const extreme = __test.modelFeatureDrift(model, [3, 3]);
  assert.ok(['NORMAL','ELEVATED','HIGH'].includes(normal.status));
  assert.equal(extreme.status, 'EXTREME');
  assert.ok(extreme.weightFactor < normal.weightFactor);
});

test('champion challenger rejects regression and promotes measurable improvement', () => {
  const champion = {
    trusted: true,
    metrics: { balancedAccuracy: 0.61, brier: 0.19, featureStats: [{ name: 'a', mean: 0, std: 1 }] },
    trainedTo: '2026-09-01T00:00:00Z'
  };
  const worse = {
    trusted: true,
    metrics: { balancedAccuracy: 0.57, brier: 0.23, featureStats: [{ name: 'a', mean: 0, std: 1 }] }
  };
  const better = {
    trusted: true,
    metrics: { balancedAccuracy: 0.62, brier: 0.18, featureStats: [{ name: 'a', mean: 0, std: 1 }] }
  };
  assert.equal(__test.compareChampionChallenger(champion, worse, '2026-09-10T00:00:00Z').promote, false);
  assert.equal(__test.compareChampionChallenger(champion, better, '2026-09-10T00:00:00Z').promote, true);
});
