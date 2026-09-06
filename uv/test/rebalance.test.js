import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRebalanceSeed, rebalancePortfolio } from '../src/rebalance.js';

function card(id, price, name = `Player ${id}`, score = 75) {
  return {
    eaId: id, name, price, recommendedBuyPrice: price, buyPrice: price,
    selectionScore: score, tradeQualityScore: score, uvScore: score,
    longTermScore: score, longTermProfitScore: score, repeatabilityScore: score,
    riskPenalty: 0, cardType: id % 4 === 0 ? 'Special' : 'Base Rare', rarityName: 'Gold'
  };
}

test('v0.12 seed keeps KEEP/REPRICE and blocks WAIT/DROP/MISSING', () => {
  const stored = [1,2,3,4,5].map((id, i) => ({ slot: i + 1, eaId: id, payload: { name: `P${id}` } }));
  const rows = ['KEEP','REPRICE','WAIT','DROP','MISSING'].map((status, i) => ({ slot: i + 1, eaId: i + 1, status }));
  const current = new Map([['1', card(1, 1000)], ['2', card(2, 1100)], ['3', card(3, 1200)], ['4', card(4, 1300)]]);
  const out = buildRebalanceSeed(stored, rows, current);
  assert.deepEqual(out.retained.map(c => c.eaId), [1,2]);
  assert.deepEqual([...out.blockedIds].sort(), ['3','4','5']);
  assert.equal(out.dropped.length, 3);
});

test('v0.12 rebalance restores full list within budget and preserves retained cards', () => {
  const retained = [card(1, 3000, 'Keep A', 90), card(2, 3000, 'Keep B', 88)].map(c => ({ ...c, _recheck: { status: 'KEEP' } }));
  const candidates = Array.from({ length: 30 }, (_, i) => card(100 + i, 2500 + (i % 5) * 100, `New ${i}`, 70 + (i % 15)));
  const out = rebalancePortfolio({ retained, candidates, budget: 30_000, count: 10 });
  assert.equal(out.selected.length, 10);
  assert.ok(out.total <= 30_000);
  assert.ok(out.selected.some(c => c.eaId === 1));
  assert.ok(out.selected.some(c => c.eaId === 2));
  assert.equal(out.retainedCount, 2);
  assert.equal(out.replacementCount, 8);
});

test('v0.12 optimizer respects maximum three versions of the same player with retained seed', () => {
  const retained = [card(1, 2000, 'Same Guy', 90), card(2, 2000, 'Same Guy', 88)].map(c => ({ ...c, _recheck: { status: 'KEEP' } }));
  const same = Array.from({ length: 8 }, (_, i) => card(100 + i, 1800 + i * 50, 'Same Guy', 95));
  const other = Array.from({ length: 30 }, (_, i) => card(200 + i, 1800 + (i % 6) * 50, `Other ${i}`, 75));
  const out = rebalancePortfolio({ retained, candidates: [...same, ...other], budget: 20_000, count: 10 });
  assert.ok(out.selected.filter(c => c.name === 'Same Guy').length <= 3);
});

test('v0.12 feasibility fallback can release weakest repriced retained position', () => {
  const retained = [
    { ...card(1, 9000, 'Expensive Reprice', 40), _recheck: { status: 'REPRICE' } },
    { ...card(2, 1000, 'Strong Keep', 95), _recheck: { status: 'KEEP' } }
  ];
  const candidates = Array.from({ length: 20 }, (_, i) => card(100 + i, 1000, `Replacement ${i}`, 80));
  const out = rebalancePortfolio({ retained, candidates, budget: 10_000, count: 10 });
  assert.equal(out.selected.length, 10);
  assert.ok(out.total <= 10_000);
  assert.ok(out.released.some(x => x.eaId === 1));
  assert.ok(out.selected.some(c => c.eaId === 2));
});

test('rebalance seed releases retained cards below the active rating floor', () => {
  const stored = [{ slot: 1, eaId: 1, payload: { name: 'Low Rare', overall: 80 } }];
  const rows = [{ slot: 1, eaId: 1, status: 'KEEP', name: 'Low Rare', reasons: [] }];
  const current = new Map([['1', { eaId: 1, name: 'Low Rare', overall: 80, buyPrice: 2000, selectionScore: 90 }]]);
  const result = buildRebalanceSeed(stored, rows, current, { minRating: 82 });
  assert.equal(result.retained.length, 0);
  assert.equal(result.blockedIds.has('1'), true);
  assert.match(result.dropped[0].reason, /Rating 80/);
});

test('v1.6 rebalance releases an 84 normal card during FC26 endgame', () => {
  const stored = [{ slot: 1, eaId: 1, payload: { name: 'Old 84', overall: 84, cardType: 'Base Rare', rarityName: 'Rare' } }];
  const rows = [{ slot: 1, eaId: 1, status: 'KEEP', name: 'Old 84', reasons: [] }];
  const current = new Map([['1', { ...card(1, 2500, 'Old 84', 90), overall: 84, cardType: 'Base Rare', rarityName: 'Rare' }]]);
  const result = buildRebalanceSeed(stored, rows, current, {
    ratingOptions: { budget: 300000, portfolioCount: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' }
  });
  assert.equal(result.retained.length, 0);
  assert.equal(result.blockedIds.has('1'), true);
  assert.match(result.dropped[0].reason, /85/);
});

test('v1.6 rebalance may retain an 84 Special with strong demand during FC26 endgame', () => {
  const payload = { name: 'Demand Special', overall: 84, cardType: 'Special', rarityName: 'Promo', futbinGamesCount: 2000000 };
  const stored = [{ slot: 1, eaId: 1, payload }];
  const rows = [{ slot: 1, eaId: 1, status: 'KEEP', name: 'Demand Special', reasons: [] }];
  const current = new Map([['1', { ...card(1, 2500, 'Demand Special', 90), ...payload }]]);
  const result = buildRebalanceSeed(stored, rows, current, {
    ratingOptions: { budget: 300000, portfolioCount: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' }
  });
  assert.equal(result.retained.length, 1);
  assert.equal(result.blockedIds.size, 0);
});

test('v1.6 rebalance seed keeps at most two copies of the same exact card', () => {
  const stored = [1, 2, 3].map(slot => ({ slot, eaId: 77, payload: { name: 'Same Exact', overall: 85, cardType: 'Base Rare', rarityName: 'Rare' } }));
  const rows = [1, 2, 3].map(slot => ({ slot, eaId: 77, status: 'KEEP', name: 'Same Exact', reasons: [] }));
  const currentCard = { ...card(77, 2500, 'Same Exact', 90), overall: 85, cardType: 'Base Rare', rarityName: 'Rare' };
  const current = new Map([['77', currentCard]]);
  const result = buildRebalanceSeed(stored, rows, current, {
    ratingOptions: { budget: 300000, portfolioCount: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' }
  });
  assert.equal(result.retained.length, 2);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /Maximal 2 Exemplare/);
});
