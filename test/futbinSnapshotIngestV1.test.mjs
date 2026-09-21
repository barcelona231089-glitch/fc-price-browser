import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFutbinSnapshotRows, ingestFutbinSnapshot } from '../futbinSnapshotIngestV1.js';

test('snapshot ingest normalization rejects invalid ids and timestamps and nulls invalid prices', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  const rows = normalizeFutbinSnapshotRows([
    { futbinId: 778, observedAt: '2026-09-20T23:59:00Z', name: 'Lookman', rating: 87, priceConsole: 10000, pricePc: -5, popularRank: 2 },
    { futbinId: 0, observedAt: '2026-09-20T23:59:00Z' },
    { futbinId: 779, observedAt: 'not-a-date' },
    { futbinId: 780, observedAt: '2026-09-21T01:00:00Z' },
    { futbinId: 781, priceConsole: 5000 },
  ], now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].futbinId, 778);
  assert.equal(rows[0].priceConsole, 10000);
  assert.equal(rows[0].pricePc, null);
});

test('snapshot ingest uses one batch insert for accepted rows', async () => {
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('INSERT INTO fc_futbin_fc27_snapshots')) return { rowCount: 2 };
    return { rows: [] };
  }};
  const ts = new Date().toISOString();
  const out = await ingestFutbinSnapshot(pool, [
    { futbinId: 778, observedAt: ts, name: 'A', rating: 87, priceConsole: 10000 },
    { futbinId: 779, observedAt: ts, name: 'B', rating: 86, priceConsole: 9000 },
  ]);
  const inserts = calls.filter(x => x.sql.startsWith('INSERT INTO fc_futbin_fc27_snapshots'));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].values.length, 14);
  assert.deepEqual(out, { inserted: 2, received: 2 });
});
