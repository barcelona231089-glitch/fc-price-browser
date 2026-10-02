import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCollectorCards, selectPriorityRefreshFutbinIds, buildCarriedEvidenceRows } from '../futbinBraveCollectorV1.js';

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


test('collector reserves refresh slots for previously profitable FUTBIN sold-price opportunities', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    eaId: String(300000 + i),
    futbinId: 7000 + i,
    name: 'Card ' + i,
    overall: 82 + (i % 8),
    futbinOnlyTarget: true,
    livePrice: (i + 1) * 2000
  }));

  const result = selectCollectorCards(rows, {
    maxCards: 12,
    cursor: 0,
    priorityFutbinIds: [7011, 7017],
    prioritySlots: 4
  });

  assert.equal(result.cards.length, 12);
  assert.equal(result.priorityRefreshSelected, 2);
  assert.deepEqual(result.cards.slice(0, 2).map(card => card.futbinId), [7011, 7017]);
  assert.ok(result.cards.slice(0, 2).every(card => card.priorityRefresh === true));
});

test('priority refresh picks only sold-price-backed profit windows and prefers older evidence', () => {
  const oldEnough = '2026-10-01T20:00:00.000Z';
  const newer = '2026-10-01T21:00:00.000Z';
  const ids = selectPriorityRefreshFutbinIds([
    {
      futbinId: 21673,
      observedAt: oldEnough,
      priceConsole: 41750,
      salesEvidence: {
        soldPriceP25: 43250,
        soldPriceMedian: 44500,
        soldPriceMode: 46000,
        soldPriceP75: 45500
      }
    },
    {
      futbinId: 22,
      observedAt: newer,
      priceConsole: 24250,
      salesEvidence: {
        soldPriceP25: 24750,
        soldPriceMedian: 25000,
        soldPriceMode: 25000,
        soldPriceP75: 25750
      }
    },
    {
      futbinId: 999,
      observedAt: newer,
      priceConsole: 40000,
      salesEvidence: {
        soldPriceP25: 42000,
        soldPriceMedian: 43000,
        soldPriceMode: 43000,
        soldPriceP75: 44000
      }
    }
  ], 4);

  assert.ok(ids.includes(21673));
  assert.ok(ids.includes(999));
  assert.equal(ids.includes(22), false);
  assert.equal(ids[0], 21673);
});


test('collector can refresh a profitable priority card even when it is missing from the ordinary rating page', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    eaId: String(400000 + i),
    futbinId: 8000 + i,
    name: 'Slice ' + i,
    overall: 84,
    futbinOnlyTarget: true,
    livePrice: 1000 + i * 1000
  }));
  const priorityCard = {
    eaId: '84106820',
    futbinId: 21673,
    name: 'Nwankwo Kanu',
    overall: 86,
    futbinOnlyTarget: true,
    livePrice: 41750,
    priceConsole: 41750
  };

  const result = selectCollectorCards(rows, {
    maxCards: 12,
    cursor: 0,
    priorityCards: [priorityCard],
    prioritySlots: 4
  });

  assert.equal(result.cards.length, 12);
  assert.equal(result.cards[0].futbinId, 21673);
  assert.equal(result.cards[0].priorityRefresh, true);
});


test('priority refresh carries current filtered price timestamp and previous Games fallback', () => {
  const result = selectCollectorCards([
    {
      eaId: '5679',
      futbinId: 21673,
      name: 'Nwankwo Kanu',
      overall: 86,
      futbinOnlyTarget: true,
      livePrice: 40750,
      targetObservedAt: '2026-10-02T04:00:00.000Z'
    }
  ], {
    maxCards: 1,
    cursor: 0,
    priorityCards: [{
      eaId: '5679',
      futbinId: 21673,
      name: 'Nwankwo Kanu',
      overall: 86,
      livePrice: 41750,
      gamesPlayedConsole: 18613
    }],
    prioritySlots: 1
  });

  assert.equal(result.cards[0].futbinId, 21673);
  assert.equal(result.cards[0].targetPriceConsole, 40750);
  assert.equal(result.cards[0].targetObservedAt, '2026-10-02T04:00:00.000Z');
  assert.equal(result.cards[0].fallbackGamesPlayedConsole, 18613);
});


test('collector v1.4.8 uses 20 slots and concentrates evidence on low-cost cards for 100k portfolios', () => {
  const rows = [
    ...Array.from({ length: 80 }, (_, i) => ({
      eaId: String(500000 + i),
      futbinId: 9000 + i,
      name: 'Cheap ' + i,
      overall: 82 + (i % 5),
      futbinOnlyTarget: true,
      livePrice: 650 + (i % 20) * 100
    })),
    ...Array.from({ length: 40 }, (_, i) => ({
      eaId: String(600000 + i),
      futbinId: 10000 + i,
      name: 'Premium ' + i,
      overall: 86 + (i % 5),
      futbinOnlyTarget: true,
      livePrice: 10000 + i * 25000
    }))
  ];

  const result = selectCollectorCards(rows, { maxCards: 20, cursor: 0 });
  assert.equal(result.cards.length, 20);
  assert.ok(result.cards.filter(card => Number(card.targetPriceConsole) <= 2500).length >= 12);
  assert.ok(result.cards.some(card => Number(card.targetPriceConsole) > 2500));
});


test('collector v1.4.9 carries recent real sales evidence onto a fresh filtered FUTBIN price', () => {
  const now = Date.parse('2026-10-02T18:00:00.000Z');
  const targets = [{
    eaId: '123',
    futbinId: 9001,
    name: 'Cheap Target',
    overall: 83,
    livePrice: 700,
    targetObservedAt: '2026-10-02T17:59:00.000Z'
  }];
  const snapshots = [{
    futbinId: 9001,
    observedAt: '2026-10-02T08:00:00.000Z',
    name: 'Cheap Target',
    rating: 83,
    priceConsole: 750,
    gamesPlayedConsole: 12000,
    salesEvidence: {
      listedSampleCount: 500,
      soldSampleCount: 450,
      soldPriceMedian: 800,
      soldPriceP25: 750,
      soldPriceP75: 800,
      soldPriceMode: 800
    }
  }];

  const rows = buildCarriedEvidenceRows(targets, snapshots, { nowMs: now, maxEvidenceAgeMs: 18 * 60 * 60_000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceConsole, 700);
  assert.equal(rows[0].gamesPlayedConsole, 12000);
  assert.equal(rows[0].salesEvidence.soldPriceMedian, 800);
  assert.equal(rows[0].salesEvidence.evidenceObservedAt, '2026-10-02T08:00:00.000Z');
});

test('collector v1.4.9 refuses to carry sales evidence older than the bounded evidence window', () => {
  const rows = buildCarriedEvidenceRows([{
    eaId: '123', futbinId: 9001, name: 'Old Target', overall: 83,
    livePrice: 700, targetObservedAt: '2026-10-02T17:59:00.000Z'
  }], [{
    futbinId: 9001, observedAt: '2026-10-01T20:00:00.000Z',
    gamesPlayedConsole: 12000,
    salesEvidence: { listedSampleCount: 500, soldSampleCount: 450, soldPriceMedian: 800 }
  }], {
    nowMs: Date.parse('2026-10-02T18:00:00.000Z'),
    maxEvidenceAgeMs: 18 * 60 * 60_000
  });
  assert.equal(rows.length, 0);
});
