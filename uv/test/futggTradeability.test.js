import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFutggMarketRow } from '../src/futgg.js';

test('tradeable FUT.GG market row requires positive real price and no reward flags', () => {
  const row = classifyFutggMarketRow({ eaId: 123, price: 9800, isSbc: false, isObjective: false, isExtinct: false, premiumSeasonPassLevel: null, standardSeasonPassLevel: null });
  assert.equal(row.marketTradeableConfirmed, true);
  assert.equal(row.price, 9800);
  assert.equal(row.rejectionReason, null);
});

test('SBC reward is hard blocked even when FUT.GG exposes a numeric cost', () => {
  const row = classifyFutggMarketRow({ eaId: 50601330, price: 7950, isSbc: true, isObjective: false, isExtinct: false });
  assert.equal(row.marketTradeableConfirmed, false);
  assert.equal(row.rejectionReason, 'SBC_REWARD');
});

test('Objective and Season rewards are hard blocked', () => {
  const objective = classifyFutggMarketRow({ eaId: 1, price: 7000, isObjective: true });
  const season = classifyFutggMarketRow({ eaId: 2, price: 12000, isObjective: true, premiumSeasonPassLevel: 10 });
  assert.equal(objective.rejectionReason, 'OBJECTIVE_REWARD');
  assert.equal(season.rejectionReason, 'SEASON_REWARD');
});

test('extinct or missing live BIN is not accepted as a buy candidate', () => {
  const extinct = classifyFutggMarketRow({ eaId: 3, price: 15000000, isExtinct: true });
  const missing = classifyFutggMarketRow({ eaId: 4, price: null, isExtinct: false });
  assert.equal(extinct.rejectionReason, 'EXTINCT_NO_LIVE_BIN');
  assert.equal(missing.rejectionReason, 'NO_CONFIRMED_LIVE_BIN');
});
