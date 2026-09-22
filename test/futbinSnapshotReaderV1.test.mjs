import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichRowsWithSnapshotFutbinBrain } from '../futbinSnapshotReaderV1.js';

test('snapshot reader fails soft on DB error', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const rows = [{ eaId: 230899, price: 10000 }];
  const out = await enrichRowsWithSnapshotFutbinBrain(rows, { pool, gameYear: 27 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'DB_ERROR');
  assert.equal(out.enriched, 0);
});

test('snapshot reader preserves stronger existing FUTBIN evidence', async () => {
  const pool = { query: async () => ({ rows: [{ futbin_id: 778, observed_at: new Date().toISOString(), price_console: 10500, price_pc: null, popular_rank: 10 }] }) };
  const rows = [{ eaId: 230899, price: 10000, futbinPrice: 9900, futbinProvider: 'FUTBIN_DIRECT_FC27' }];
  const out = await enrichRowsWithSnapshotFutbinBrain(rows, { pool, gameYear: 27 });
  assert.equal(out.ok, true);
  assert.equal(out.enriched, 0);
  assert.equal(out.skippedExisting, 1);
  assert.equal(rows[0].futbinPrice, 9900);
  assert.equal(rows[0].futbinProvider, 'FUTBIN_DIRECT_FC27');
});

test('snapshot reader reports exact row coverage and enriches mapped card', async () => {
  const pool = { query: async () => ({ rows: [{ futbin_id: 778, observed_at: new Date().toISOString(), price_console: 10000, price_pc: null, popular_rank: 7,
    sales_evidence: { rowCount: 500, soldSampleCount: 474, listedSampleCount: 500, unsoldSampleCount: 26, soldPriceMedian: 12250, soldPriceP25: 12250, soldPriceP75: 12750, salesEvidenceScore: 70.04 } }] }) };
  const rows = [{ eaId: 230899, price: 10000 }, { eaId: 999999999, price: 5000 }];
  const out = await enrichRowsWithSnapshotFutbinBrain(rows, { pool, gameYear: 27 });
  assert.equal(out.ok, true);
  assert.equal(out.resolvedIds, 1);
  assert.equal(out.resolvedRows, 1);
  assert.equal(out.unmapped, 1);
  assert.equal(out.enriched, 1);
  assert.equal(rows[0].futbinProvider, 'FUTBIN_FC27_PC_COLLECTOR');
  assert.equal(rows[0].futbinCrossCheck, 'MATCH');
  assert.equal(rows[0].futbinMatchConfidence, 100);
  assert.equal(rows[0].futbinSalesHistoryAvailable, true);
  assert.equal(rows[0].futbinSoldSampleCount, 474);
  assert.equal(rows[0].futbinUnsoldSampleCount, 26);
  assert.equal(rows[0].futbinSoldPriceMedian, 12250);
  assert.equal(out.salesEvidenceEnriched, 1);
});

test('snapshot reader resolves encoded EA base rare resource ids through verified base id', async () => {
  const pool = { query: async () => ({ rows: [{ futbin_id: 2076, observed_at: new Date().toISOString(), price_console: 1200, price_pc: null, popular_rank: 50 }] }) };
  const rows = [{ eaId: 50591793, price: 1200, cardType: 'Base Rare' }];
  const out = await enrichRowsWithSnapshotFutbinBrain(rows, { pool, gameYear: 27 });
  assert.equal(out.ok, true);
  assert.equal(out.resolvedRows, 1);
  assert.equal(out.unmapped, 0);
  assert.equal(rows[0].futbinId, 2076);
});
