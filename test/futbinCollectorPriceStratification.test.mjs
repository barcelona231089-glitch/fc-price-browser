import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCollectorCards } from '../futbinBraveCollectorV1.js';

test('collector v1.4 selects across the full live-price range instead of one rating neighborhood', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    eaId: String(100000 + i),
    futbinId: 5000 + i,
    name: 'Card ' + i,
    overall: 82 + (i % 8),
    rating: 82 + (i % 8),
    cardType: 'Test',
    futbinOnlyTarget: true,
    livePrice: (i + 1) * 1000
  }));

  const result = selectCollectorCards(rows, { maxCards: 12, cursor: 0 });
  assert.equal(result.cards.length, 12);
  assert.equal(result.cards[0].targetPriceConsole, 1000);
  assert.equal(result.cards[result.cards.length - 1].targetPriceConsole, 24000);
  assert.ok(result.ratingCoverage.length >= 4);
  assert.equal(result.priceMin, 1000);
  assert.equal(result.priceMax, 24000);
});

test('collector v1.4 rotates within price slices without losing low/high budget coverage', () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({
    eaId: String(200000 + i),
    futbinId: 6000 + i,
    name: 'Card ' + i,
    overall: 82 + (i % 10),
    futbinOnlyTarget: true,
    livePrice: (i + 1) * 2500
  }));

  const a = selectCollectorCards(rows, { maxCards: 12, cursor: 0 });
  const b = selectCollectorCards(rows, { maxCards: 12, cursor: 1 });
  assert.equal(a.cards.length, 12);
  assert.equal(b.cards.length, 12);
  assert.notDeepEqual(a.cards.map(x => x.futbinId), b.cards.map(x => x.futbinId));
  assert.ok(Math.min(...a.cards.map(x => x.targetPriceConsole)) <= 7500);
  assert.ok(Math.min(...b.cards.map(x => x.targetPriceConsole)) <= 7500);
  assert.ok(Math.max(...a.cards.map(x => x.targetPriceConsole)) >= 85000);
  assert.ok(Math.max(...b.cards.map(x => x.targetPriceConsole)) >= 85000);
});
