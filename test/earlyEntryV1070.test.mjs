import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { earlyEntrySignalV1, adaptiveEvidenceGate, liveConfluenceSignalV1, leakWeightV1 } from '../adaptiveBrainV1064.js';

test('early entry opens on broad, confirmed, not-yet-overheated demand', () => {
  const signal = earlyEntrySignalV1({
    price: 10000, high24h: 12000,
    change5m: 0.8, change15m: 1.8, change1h: 1.2,
    ratingMarketRisingPct: 68, ratingMarketFallingPct: 18
  });
  assert.equal(signal.allowed, true);
  assert.equal(signal.strong, true);
  assert.equal(signal.overheated, false);
  assert.ok(signal.scoreBoost >= 10);
});

test('no-chase blocks a late pump near the 24h high', () => {
  const signal = earlyEntrySignalV1({
    price: 11900, high24h: 12000,
    change5m: 3, change15m: 10.5, change1h: 18,
    ratingMarketRisingPct: 82, ratingMarketFallingPct: 8
  });
  assert.equal(signal.allowed, false);
  assert.equal(signal.overheated, true);
  assert.ok(signal.scoreBoost < 0);
});

test('early market signal still needs a second independent evidence family', () => {
  const alone = adaptiveEvidenceGate({ earlyEntry: true, momentum: 0 });
  assert.equal(alone.allowed, false);
  const confirmed = adaptiveEvidenceGate({ earlyEntry: true, momentum: 0, secondary: 4 });
  assert.equal(confirmed.allowed, true);
  assert.deepEqual(confirmed.families, ['FUTGG_MARKET', 'SECONDARY']);
});

test('server alert sanity no longer treats waiting during a pump as a contradiction', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(source.includes("(derivedRegime === 'PUMP' && saysSelloff)"));
  assert.equal(source.includes("(derivedRegime === 'PUMP' && (row?.aiAction === 'NOCH WARTEN' || saysSelloff))"), false);
});

test('rating intelligence includes early buy zone and late no-chase protection', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(source.includes('v10.70 early-entry'));
  assert.ok(source.includes('w5m.risingPct >= 58'));
  assert.ok(source.includes('w15m.medianMove <= 7'));
  assert.ok(source.includes('nearHighPct < 35'));
  assert.ok(source.includes('marketAdvice = "JETZT KAUFEN"'));
  assert.ok(source.includes('marketAdvice = "NICHT HINTERHERKAUFEN"'));
});


test('strong live confluence can confirm BUY without FUTBIN when market demand and history agree', () => {
  const evidence = adaptiveEvidenceGate({ momentum: 5, demand: 5, history: 3 });
  const signal = liveConfluenceSignalV1({ momentum: 5, demand: 5, history: 3, evidence, futbinStatus: 'NO_DATA' });
  assert.equal(evidence.allowed, true);
  assert.deepEqual(evidence.families, ['FUTGG_MARKET','FUTGG_DEMAND','HISTORY']);
  assert.equal(signal.allowed, true);
  assert.equal(signal.strong, true);
  assert.equal(signal.canTriggerBuyAlone, false);
});

test('live confluence fails closed on FUTBIN divergence or overheated move', () => {
  const evidence = adaptiveEvidenceGate({ momentum: 5, demand: 5, history: 3 });
  assert.equal(liveConfluenceSignalV1({ momentum: 5, demand: 5, history: 3, evidence, futbinStatus: 'DIVERGENCE' }).allowed, false);
  assert.equal(liveConfluenceSignalV1({ momentum: 5, demand: 5, history: 3, evidence, overheated: true }).allowed, false);
});


test('confirmed relevant leak gets materially more weight but can never trigger BUY alone', () => {
  const weak = leakWeightV1({ active: true, marketReaction: false, relevance: 0.8, sourceCount: 2, reliableCount: 1 });
  const strong = leakWeightV1({ active: true, marketReaction: true, relevance: 0.8, sourceCount: 2, reliableCount: 1 });
  assert.ok(strong.score > weak.score);
  assert.ok(strong.external > weak.external);
  assert.equal(strong.canTriggerBuyAlone, false);
  assert.ok(strong.score <= 16);
  assert.ok(strong.external <= 11);
});

test('inactive leak has zero influence', () => {
  assert.deepEqual(leakWeightV1({ active: false, marketReaction: true, relevance: 1, sourceCount: 3, reliableCount: 3 }), {
    score: 0, external: 0, confirmed: false, canTriggerBuyAlone: false
  });
});
