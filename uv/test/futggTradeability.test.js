import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFutggMarketRow, classifyLocalFutggMarketEvidence, confirmTradeableMarketCards } from '../src/futgg.js';

test('tradeable FUT.GG market row requires positive real price and no reward flags', () => {
  const row = classifyFutggMarketRow({ eaId: 123, price: 9800, isSbc: false, isObjective: false, isExtinct: false });
  assert.equal(row.marketTradeableConfirmed, true);
  assert.equal(row.price, 9800);
});

test('SBC, Objective, Season and extinct remain hard blocked', () => {
  assert.equal(classifyFutggMarketRow({ eaId: 1, price: 9000, isSbc: true }).rejectionReason, 'SBC_REWARD');
  assert.equal(classifyFutggMarketRow({ eaId: 2, price: 9000, isObjective: true }).rejectionReason, 'OBJECTIVE_REWARD');
  assert.equal(classifyFutggMarketRow({ eaId: 3, price: 9000, isObjective: true, premiumSeasonPassLevel: 8 }).rejectionReason, 'SEASON_REWARD');
  assert.equal(classifyFutggMarketRow({ eaId: 4, price: 9000, isExtinct: true }).rejectionReason, 'EXTINCT_NO_LIVE_BIN');
});

test('safe local fallback still accepts plain base card with FUT.GG live status 0', () => {
  const base = classifyLocalFutggMarketEvidence({ eaId: 11, cardType: 'Base Rare', price: 2400, priceStatusCode: 0, priceSource: 'FUT.GG / shared Trader Brain snapshot' });
  assert.equal(base.marketTradeableConfirmed, true);
  assert.equal(base.source, 'FUT.GG R2 BASE LIVE');
});

test('special is accepted locally only with complete explicit FUT.GG market metadata', () => {
  const special = classifyLocalFutggMarketEvidence({
    eaId: 12,
    cardType: 'Special',
    price: 24500,
    priceStatusCode: 0,
    priceSource: 'FUT.GG / shared Trader Brain snapshot',
    isSbc: false,
    isObjective: false,
    isExtinct: false,
    premiumSeasonPassLevel: null,
    standardSeasonPassLevel: null,
    marketMetadataSource: 'FUT.GG players/v2'
  });
  assert.equal(special.marketTradeableConfirmed, true);
  assert.equal(special.source, 'FUT.GG METADATA + R2 SPECIAL LIVE');
});

test('special with missing metadata stays fail-closed', () => {
  const missingFlag = classifyLocalFutggMarketEvidence({
    eaId: 13, cardType: 'Special', price: 25000, priceStatusCode: 0,
    priceSource: 'FUT.GG', isSbc: false, isObjective: false,
    marketMetadataSource: 'FUT.GG players/v2'
  });
  assert.equal(missingFlag.marketTradeableConfirmed, false);
  assert.equal(missingFlag.rejectionReason, 'NEEDS_REMOTE_VERIFICATION');

  const noProvenance = classifyLocalFutggMarketEvidence({
    eaId: 14, cardType: 'Special', price: 25000, priceStatusCode: 0,
    priceSource: 'FUT.GG', isSbc: false, isObjective: false, isExtinct: false
  });
  assert.equal(noProvenance.marketTradeableConfirmed, false);
  assert.equal(noProvenance.rejectionReason, 'NEEDS_REMOTE_VERIFICATION');
});

test('local fallback hard-blocks reward/extinct metadata before any remote verifier', () => {
  const common = { cardType: 'Special', price: 22000, priceStatusCode: 0, priceSource: 'FUT.GG', marketMetadataSource: 'FUT.GG players/v2' };
  assert.equal(classifyLocalFutggMarketEvidence({ ...common, eaId: 20, isSbc: true, isObjective: false, isExtinct: false }).rejectionReason, 'SBC_REWARD');
  assert.equal(classifyLocalFutggMarketEvidence({ ...common, eaId: 21, isSbc: false, isObjective: true, isExtinct: false }).rejectionReason, 'OBJECTIVE_REWARD');
  assert.equal(classifyLocalFutggMarketEvidence({ ...common, eaId: 22, isSbc: false, isObjective: false, isExtinct: false, premiumSeasonPassLevel: 3 }).rejectionReason, 'SEASON_REWARD');
  assert.equal(classifyLocalFutggMarketEvidence({ ...common, eaId: 23, isSbc: false, isObjective: false, isExtinct: true }).rejectionReason, 'EXTINCT_NO_LIVE_BIN');
});

test('verifier outage stops after first batch while safe metadata Specials remain usable', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('simulated verifier outage'); };
  try {
    const safeSpecials = Array.from({ length: 100 }, (_, i) => ({
      eaId: 1000 + i,
      cardType: 'Special',
      price: 15000 + i * 100,
      priceStatusCode: 0,
      priceSource: 'FUT.GG / shared Trader Brain snapshot',
      isSbc: false,
      isObjective: false,
      isExtinct: false,
      premiumSeasonPassLevel: null,
      standardSeasonPassLevel: null,
      marketMetadataSource: 'FUT.GG players/v2'
    }));
    const ambiguous = Array.from({ length: 80 }, (_, i) => ({
      eaId: 5000 + i,
      cardType: 'Special',
      price: 30000 + i * 100,
      priceStatusCode: 0,
      priceSource: 'FUT.GG / shared Trader Brain snapshot'
    }));

    // Put ambiguous cards first to prove we still retain them for one verifier
    // batch, then scan until the requested safe pool is complete.
    const result = await confirmTradeableMarketCards([...ambiguous, ...safeSpecials], 'console', {
      minConfirmed: 100,
      maxChecks: 180,
      maxApiChecks: 200
    });

    assert.equal(calls, 1);
    assert.equal(result.cards.length, 100);
    assert.equal(result.diagnostics.localMetadataSpecialAccepted, 100);
    assert.equal(result.diagnostics.verificationSourceDown, true);
    assert.equal(result.diagnostics.checkedByApi, 50);
    assert.equal(result.diagnostics.apiCalls, 1);
    assert.equal(result.diagnostics.stoppedAfterFirstFailure, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
