import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRelistLadder, buildRecommendationLifecycle } from '../uv/src/lifecycle.js';

test('relist ladder keeps every stage at or above break-even', () => {
  const ladder = buildRelistLadder({ buyPrice: 10000, price: 11000, sellPrice: 12500 });
  assert.equal(ladder.taxRate, 0.05);
  assert.equal(ladder.stages.length, 3);
  assert.ok(ladder.stages.every(x => x.price >= ladder.breakEven));
  assert.deepEqual(ladder.stages.map(x => x.afterHours), [0, 6, 24]);
});

test('recommendation lifecycle includes relist ladder', () => {
  const life = buildRecommendationLifecycle({ buyPrice: 10000, price: 11000, sellPrice: 12500 });
  assert.ok(life.relistLadder);
  assert.equal(life.relistLadder.neverBelowBreakEven, true);
});
