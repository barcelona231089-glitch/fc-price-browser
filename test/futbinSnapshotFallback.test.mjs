import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('FC27 FUTBIN sales evidence survives a PostgreSQL outage via runtime fallback', async () => {
  const fallbackFile = path.join(os.tmpdir(), `fc27-futbin-fallback-${process.pid}-${Date.now()}.json`);
  process.env.FUTBIN_SNAPSHOT_FALLBACK_FILE = fallbackFile;
  const ingest = await import('../futbinSnapshotIngestV1.js');
  const reader = await import('../futbinSnapshotReaderV1.js');
  const deadPool = { query: async () => { throw new Error('TEST_DB_DOWN'); } };
  const now = new Date().toISOString();
  try {
    const result = await ingest.ingestFutbinSnapshot(deadPool, [{
      futbinId: 22, observedAt: now, name: 'Evidence Test', rating: 91,
      priceConsole: 69500, pricePc: 71000, popularRank: 12,
      gamesPlayedConsole: 12345, gamesPlayedPc: 9000,
      salesEvidence: {
        rowCount: 20, soldSampleCount: 5, listedSampleCount: 15, unsoldSampleCount: 10,
        soldPriceMedian: 72000, soldPriceP25: 71000, soldPriceP75: 73500,
        soldPriceMin: 70000, soldPriceMax: 75000, soldPriceMode: 72000,
        salesEvidenceScore: 84, soldPremiumPctVsLive: 3.6, latestSoldAt: now
      }
    }]);
    assert.equal(result.storageMode, 'RUNTIME_FALLBACK');
    assert.equal(result.salesEvidencePersisted, 1);

    const cards = [{ eaId: 1, futbinId: 22, price: 69500 }];
    const enriched = await reader.enrichRowsWithSnapshotFutbinBrain(cards, {
      pool: deadPool, gameYear: 27, platform: 'console'
    });
    assert.equal(enriched.salesEvidenceEnriched, 1);
    assert.equal(cards[0].futbinSoldSampleCount, 5);
    assert.equal(cards[0].futbinSoldPriceMedian, 72000);
    assert.equal(cards[0].futbinPopularRank, 12);

    const health = await ingest.futbinSnapshotHealth(deadPool);
    assert.equal(health.databaseReachable, false);
    assert.equal(health.storageMode, 'RUNTIME_FALLBACK');
    assert.ok(health.salesEvidenceRows >= 1);
  } finally {
    fs.rmSync(fallbackFile, { force: true });
  }
});
