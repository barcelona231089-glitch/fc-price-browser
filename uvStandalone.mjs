import express from 'express';
import { uvRouter, initUvBrain, shutdownUvBrain, getUvRuntimeStatus } from './uv/uvApp.js';
import { pool as dbPool } from './uv/src/db.js';
import { validIngestToken, ingestFutbinSnapshot, latestFutbinSnapshots, futbinSnapshotHealth } from './futbinSnapshotIngestV1.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[UV-STANDALONE] .env load warning:', error?.message || error);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (req, res) => {
  const status = getUvRuntimeStatus();
  res.status(status?.ok ? 200 : 503).json({
    ok: Boolean(status?.ok),
    service: 'fc-uv-app',
    role: 'UV_ONLY',
    version: status?.version || null,
    gameYear: status?.gameYear || null,
    runtimeMode: status?.runtimeMode || null,
    generationMode: 'DIRECT',
    sourceMode: 'NATIVE_UV',
    legacyUvLoaderPatches: false,
    ingestTokenConfigured: Boolean(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN)
  });
});

app.get('/api/futbin-fc27-collector-targets', async (req, res) => {
  try {
    if (!dbPool?.query) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
    const minRating = Math.max(1, Math.min(99, Number(req.query?.minRating || 82)));
    const maxRating = Math.max(minRating, Math.min(99, Number(req.query?.maxRating || 99)));
    const limit = Math.max(1, Math.min(2000, Number(req.query?.limit || 1000)));
    const offset = Math.max(0, Number(req.query?.offset || 0));
    const result = await dbPool.query(`
      SELECT ea_id::text AS ea_id, name, rating, version, card_type
      FROM uv_cards
      WHERE game_year = 27
        AND rating BETWEEN $1 AND $2
      ORDER BY rating DESC, ea_id ASC
      LIMIT $3 OFFSET $4
    `, [minRating, maxRating, limit, offset]);
    const rows = (result.rows || []).map(row => ({
      eaId: row.ea_id,
      name: row.name || null,
      overall: Number(row.rating || 0) || null,
      rating: Number(row.rating || 0) || null,
      rarityName: row.version || row.card_type || null,
      cardType: row.card_type || row.version || null
    }));
    return res.json({ ok: true, source: 'UV_METADATA', gameYear: 27, count: rows.length, rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post('/api/futbin-fc27-snapshot', async (req, res) => {
  if (!validIngestToken(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  try {
    const result = await ingestFutbinSnapshot(dbPool, Array.isArray(req.body?.rows) ? req.body.rows : []);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/futbin-fc27-snapshot-health', async (req, res) => {
  try {
    return res.json({ ok: true, ...await futbinSnapshotHealth(dbPool) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});


app.get('/api/futbin-fc27-latest', async (req, res) => {
  try {
    const rows = await latestFutbinSnapshots(dbPool, {
      limit: req.query?.limit,
      evidenceOnly: String(req.query?.evidenceOnly || '').toLowerCase() === 'true'
    });
    const health = await futbinSnapshotHealth(dbPool);
    return res.json({
      ok: true,
      gameYear: 27,
      count: rows.length,
      storageMode: health.storageMode || null,
      databaseReachable: health.databaseReachable ?? null,
      rows
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/uv/preflight', async (req, res) => {
  try {
    const platform = String(req.query?.platform || 'console').toLowerCase() === 'pc' ? 'pc' : 'console';
    const rows = await latestFutbinSnapshots(dbPool, { limit: 100, evidenceOnly: true });
    const usable = rows.filter(row => {
      const price = Number(platform === 'pc' ? row?.pricePc : row?.priceConsole);
      const games = Number(platform === 'pc' ? row?.gamesPlayedPc : row?.gamesPlayedConsole);
      const sales = row?.salesEvidence || {};
      const listings = Number(sales?.listedSampleCount || 0);
      const sold = Number(sales?.soldSampleCount || 0);
      const soldPriceObserved = [sales?.soldPriceP25, sales?.soldPriceMedian, sales?.soldPriceMode, sales?.soldPriceP75]
        .some(value => Number(value) > 0);
      return price > 0 && games > 0 && listings > 0 && sold >= 2 && soldPriceObserved;
    });
    return res.json({
      ok: true,
      ready: usable.length > 0,
      gameYear: 27,
      platform,
      generationMode: 'DIRECT',
      sourceMode: 'NATIVE_UV',
      legacyUvLoaderPatches: false,
      totalEvidenceRows: rows.length,
      usableThreeSignalRows: usable.length
    });
  } catch (error) {
    return res.status(500).json({ ok: false, ready: false, error: String(error?.message || error) });
  }
});

app.use(uvRouter);
app.get('/', (req, res) => res.redirect('/uv'));

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[UV-STANDALONE] shutdown:', signal);
  try { await shutdownUvBrain(); } catch (error) { console.error('[UV-STANDALONE] UV shutdown error:', error); }
  if (server) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
process.once('SIGINT', () => shutdown('SIGINT').catch(console.error));

// Open the HTTP port first so constrained/free hosts can complete their health probe.
// UV initialization continues immediately afterwards; /healthz reports readiness.
server = app.listen(port, '0.0.0.0', () => {
  console.log('[UV-STANDALONE] port-open', { port, host: '0.0.0.0', role: 'UV_ONLY' });
});

try {
  await initUvBrain({ active: true });
  const snapshotHealth = await futbinSnapshotHealth(dbPool);
  console.log('[UV-STANDALONE] FUTBIN snapshot health', snapshotHealth);
} catch (error) {
  console.error('[UV-STANDALONE] init failed:', error?.stack || error?.message || error);
}

if (server) {
  const status = getUvRuntimeStatus();
  console.log('[UV-STANDALONE] listening', {
    port,
    role: 'UV_ONLY',
    version: status?.version,
    gameYear: status?.gameYear,
    runtimeMode: status?.runtimeMode
  });
}
