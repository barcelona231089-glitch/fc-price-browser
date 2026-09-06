import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraderKnowledge, TRADER_KNOWLEDGE_SOURCES } from '../src/traderKnowledge.js';

test('trader source registry is explicit and contains multiple independent schools', () => {
  assert.ok(TRADER_KNOWLEDGE_SOURCES.length >= 5);
  assert.ok(TRADER_KNOWLEDGE_SOURCES.some(s => s.name === 'PedsanUT'));
  assert.ok(TRADER_KNOWLEDGE_SOURCES.some(s => s.name.includes('Zinhja')));
});

test('weekend/time effect stays a weak prior, not a dominant signal', () => {
  const card = { price: 10000, popularityScore: 60, demandEvidenceScore: 60, liquidityScore: 60, stability: 60, confidenceScore: 60, priceActivityScore: 60, learningScore: 60, turnoverIndex: 60 };
  const weekday = buildTraderKnowledge(card, { direction: 'stable', stabilityScore: 60 }, 10000, new Map(), new Date('2026-08-27T12:00:00Z'));
  const weekendEvening = buildTraderKnowledge(card, { direction: 'stable', stabilityScore: 60 }, 10000, new Map(), new Date('2026-08-29T19:00:00Z'));
  assert.ok(weekendEvening.timeDemandScore > weekday.timeDemandScore);
  assert.ok(weekendEvening.traderPriorScore - weekday.traderPriorScore < 2);
});

test('verified public UV sources are added without pretending to import live player picks', () => {
  for (const name of ['SwepixTV', 'MM___TV', 'Noah x Kai']) {
    const source = TRADER_KNOWLEDGE_SOURCES.find(s => s.name === name);
    assert.ok(source, name);
    assert.equal(source.verifiedPublicUv, true);
    assert.equal(source.playerPicksImported, false);
  }
});

test('public UV methodology consensus is a small bounded nudge, not a replacement for live evidence', () => {
  const card = {
    price: 10000, recommendedBuyPrice: 9800, budgetFit: 80,
    popularityScore: 72, demandEvidenceScore: 74, liquidityScore: 76,
    stability: 75, confidenceScore: 78, priceActivityScore: 72,
    learningScore: 65, turnoverIndex: 77, demandDataConfidence: 70,
    supplyPressureScore: 18, riskPenalty: 3
  };
  const result = buildTraderKnowledge(card, { direction: 'stable', stabilityScore: 70 }, 10000, new Map(), new Date('2026-09-01T12:00:00Z'));
  assert.ok(result.traderMethodConsensusIndex >= 0 && result.traderMethodConsensusIndex <= 100);
  assert.ok(Math.abs(result.traderMethodAdjustment) <= 3);
  assert.equal(result.traderKnowledge.publicMethodologySignals.length, 3);
  assert.equal(result.traderKnowledge.publicMethodologySignals.some(s => s.actualLivePick !== false), false);
});
