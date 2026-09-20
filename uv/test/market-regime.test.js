import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealMarketRegime } from '../src/marketRegime.js';

const rows = (n, pct5, pct15 = pct5, pct60 = pct15) =>
  Array.from({ length: n }, (_, i) => {
    const price = 10000 + i * 10;
    const before = p => Math.round(price / (1 + p / 100));
    return { price, price_5m: before(pct5), price_15m: before(pct15), price_1h: before(pct60) };
  });

test('real regime fails closed below 25 measured cards', () => {
  const r = buildRealMarketRegime(rows(24, -5));
  assert.equal(r.ok, false);
  assert.equal(r.mood, 'insufficient_data');
});

test('real regime detects crash from observed price history', () => {
  const r = buildRealMarketRegime(rows(30, -3, -3));
  assert.equal(r.ok, true);
  assert.equal(r.mood, 'crash');
  assert.equal(r.packSupplyActive, true);
});

test('real regime detects broad rising market', () => {
  const r = buildRealMarketRegime(rows(30, 2, 1));
  assert.equal(r.mood, 'rising');
  assert.equal(r.packSupplyActive, false);
});

test('real regime never fabricates missing windows', () => {
  const r = buildRealMarketRegime(Array.from({ length: 30 }, (_, i) => ({ price: 10000 + i })));
  assert.equal(r.windows.m5.measuredCards, 0);
  assert.equal(r.windows.m15.measuredCards, 0);
  assert.equal(r.windows.h1.measuredCards, 0);
  assert.equal(r.mood, 'insufficient_data');
});
