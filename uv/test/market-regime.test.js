import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRealMarketRegime } from '../src/marketRegime.js';

const rows = (n, pct5, pct15 = pct5, pct60 = pct15) =>
  Array.from({ length: n }, (_, i) => {
    const price = 10000 + i * 10;
    const before = p => Math.round(price / (1 + p / 100));
    return { ea_id: i + 1, price, price_5m: before(pct5), price_15m: before(pct15), price_1h: before(pct60) };
  });
const live = n => Array.from({ length: n }, (_, i) => ({ eaId: i + 1, overall: 82, cardType: 'Base Rare' }));

test('real regime fails closed below 25 measured cards', () => {
  const r = buildRealMarketRegime(rows(24, -5), live(24));
  assert.equal(r.ok, false);
  assert.equal(r.mood, 'insufficient_data');
});

test('real regime detects crash from observed price history', () => {
  const r = buildRealMarketRegime(rows(30, -3, -3), live(30));
  assert.equal(r.ok, true);
  assert.equal(r.mood, 'crash');
  assert.equal(r.packSupplyActive, true);
});

test('real regime detects broad rising market', () => {
  const r = buildRealMarketRegime(rows(30, 2, 1), live(30));
  assert.equal(r.mood, 'rising');
  assert.equal(r.packSupplyActive, false);
});

test('real regime never fabricates missing windows', () => {
  const r = buildRealMarketRegime(Array.from({ length: 30 }, (_, i) => ({ ea_id: i + 1, price: 10000 + i })), live(30));
  assert.equal(r.windows.m5.measuredCards, 0);
  assert.equal(r.windows.m15.measuredCards, 0);
  assert.equal(r.windows.h1.measuredCards, 0);
  assert.equal(r.mood, 'insufficient_data');
});

test('real regime excludes specials and applies the season-aware rating floor', () => {
  const data = rows(30, -3);
  const cards = live(30).map((c, i) => i < 10 ? { ...c, cardType: 'Special' } : i < 20 ? { ...c, overall: 81 } : c);
  const r = buildRealMarketRegime(data, cards);
  assert.equal(r.measuredCards, 10);
  assert.equal(r.ok, false);
  assert.equal(r.mood, 'insufficient_data');
});

test('real regime reports pack supply inference only from eligible observed cards', () => {
  const r = buildRealMarketRegime(rows(30, -1.8, -1.8), live(30));
  assert.equal(r.mood, 'supply_pressure');
  assert.equal(r.packSupplyActive, true);
  assert.match(r.packSupplyInference, /Base Rare/);
});
