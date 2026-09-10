import test from 'node:test';
import assert from 'node:assert/strict';
import { __test, getTwoYearAiFeedStatusV106996 } from '../twoYearAiContextV106996.js';

test('period stats do not invent rows', () => {
  const rows = [
    { day: '2025-01-01T00:00:00.000Z', openPrice: 1000, closePrice: 1100, lowPrice: 900, highPrice: 1200, avgPrice: 1050 },
    { day: '2025-01-02T00:00:00.000Z', openPrice: 1100, closePrice: 1300, lowPrice: 1000, highPrice: 1400, avgPrice: 1200 }
  ];
  const stats = __test.periodStats(rows, 30, null, false);
  assert.equal(stats.observedDays, 2);
  assert.equal(stats.low, 900);
  assert.equal(stats.high, 1400);
  assert.equal(stats.changePct, 18.18);
});

test('game-year contexts stay separate across FC25 and FC26', () => {
  const rows = [
    { gameYear: '25', day: '2025-01-01T00:00:00.000Z', openPrice: 1000, closePrice: 1100, lowPrice: 900, highPrice: 1200, avgPrice: 1050 },
    { gameYear: '26', day: '2026-01-01T00:00:00.000Z', openPrice: 5000, closePrice: 5500, lowPrice: 4800, highPrice: 5700, avgPrice: 5200 }
  ];
  const fc25 = __test.buildYearContext(rows, '25', '26', 5600);
  const fc26 = __test.buildYearContext(rows, '26', '26', 5600);
  assert.equal(fc25.observedDays, 1);
  assert.equal(fc26.observedDays, 1);
  assert.notEqual(fc25.periods.d365.low, fc26.periods.d365.low);
  assert.equal(fc25.periods.d365.rangePositionPct, null);
});

test('feed status exposes 24 months / 730 days and no synthetic data', () => {
  const s = getTwoYearAiFeedStatusV106996();
  assert.equal(s.targetMonths, 24);
  assert.equal(s.requestedWindowDays, 730);
  assert.deepEqual(s.sourceGameYears, ['25','26']);
  assert.equal(s.synthetic, false);
});
