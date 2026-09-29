import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ÜV market reads FUTBIN runtime snapshots without PostgreSQL or FUT.GG', async () => {
  const fallbackFile = path.join(os.tmpdir(), `fc27-futbin-market-${process.pid}-${Date.now()}.json`);
  process.env.FUTBIN_SNAPSHOT_FALLBACK_FILE = fallbackFile;

  const ingest = await import('../futbinSnapshotIngestV1.js');
  const market = await import('../uv/src/futbinMarket.js');
  const deadPool = { query: async () => { throw new Error('TEST_DB_DOWN'); } };
  const now = new Date().toISOString();

  try {
    const pushed = await ingest.ingestFutbinSnapshot(deadPool, [{
      futbinId: 22,
      observedAt: now,
      name: 'Messi',
      rating: 88,
      priceConsole: 69500,
      pricePc: 71000,
      popularRank: 3,
      gamesPlayedConsole: 12345,
      gamesPlayedPc: 9000,
      salesEvidence: {
        soldSampleCount: 5,
        unsoldSampleCount: 2,
        soldPriceMedian: 72000,
        soldPriceP25: 71000,
        soldPriceP75: 73500,
        soldPriceMode: 72000,
        salesEvidenceScore: 84,
        latestSoldAt: now
      }
    }]);

    assert.equal(pushed.storageMode, 'RUNTIME_FALLBACK');

    const live = await market.getLiveFutbinCards(deadPool, 'console');
    assert.equal(live.futbinOnly, true);
    assert.equal(live.cards.length, 1);
    assert.equal(live.cards[0].eaId, 158023);
    assert.equal(live.cards[0].name, 'Messi');
    assert.equal(live.cards[0].overall, 88);
    assert.equal(live.cards[0].priceSource, 'FUTBIN');
    assert.equal(live.cards[0].futbinSoldSampleCount, 5);
    assert.equal(live.cards[0].futbinPopularRank, 3);
  } finally {
    fs.rmSync(fallbackFile, { force: true });
  }
});
