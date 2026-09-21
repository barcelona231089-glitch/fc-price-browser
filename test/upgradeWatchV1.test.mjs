import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpgradeWatchV1 } from '../adaptiveBrainV1064.js';

test('upgrade watcher stays inactive without upgrade context', () => {
  const r = buildUpgradeWatchV1({}, [{ source: 'Public', text: 'new promo tonight' }], 'PROMO', 0.8);
  assert.equal(r.active, false);
  assert.equal(r.canTriggerBuyAlone, false);
});

test('upgrade watcher marks EVO signal as watch-only before market confirmation', () => {
  const r = buildUpgradeWatchV1({}, [{ source: 'Public', text: 'new evo upgrade objective' }], 'EVO', 0.9);
  assert.equal(r.active, true);
  assert.equal(r.mode, 'WATCH_ONLY');
});

test('upgrade watcher records confirmed market reaction but never standalone buy', () => {
  const row = { aiLeakIntel: { marketReaction: true, topics: ['upgrade'] } };
  const r = buildUpgradeWatchV1(row, [{ source: 'Public', text: 'live card upgrade' }], 'PROMO', 0.7);
  assert.equal(r.mode, 'CONFIRMED_REACTION');
  assert.equal(r.canTriggerBuyAlone, false);
});
