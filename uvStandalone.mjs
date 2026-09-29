import express from 'express';
import { uvRouter, initUvBrain, shutdownUvBrain, getUvRuntimeStatus } from './uv/uvApp.js?uv-standalone';
import { pool as dbPool } from './uv/src/db.js';
import { ensureUniverse as ensureFutggUniverse } from './uv/src/futgg.js';
import { FUTBIN_FC27_EA_TO_ID } from './futbinIdMapFc27.js';
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
    ingestTokenConfigured: Boolean(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN)
  });
});

app.get('/api/futbin-fc27-collector-targets', async (req, res) => {
  const minRating = Math.max(1, Math.min(99, Number(req.query?.minRating || 82)));
  const maxRating = Math.max(minRating, Math.min(99, Number(req.query?.maxRating || 99)));
  const limit = Math.max(1, Math.min(2000, Number(req.query?.limit || 1000)));
  const offset = Math.max(0, Number(req.query?.offset || 0));

  if (dbPool?.query) {
    try {
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
      if (rows.length) return res.json({ ok: true, source: 'UV_METADATA', gameYear: 27, count: rows.length, rows });
    } catch (error) {
      console.warn('[UV-STANDALONE] collector targets DB degraded:', error?.code || error?.message || error);
    }
  }

  try {
    const universe = await ensureFutggUniverse(false);
    const eligible = (Array.isArray(universe) ? universe : [])
      .filter(card => Number(card?.overall || 0) >= minRating && Number(card?.overall || 0) <= maxRating)
      .filter(card => Number(FUTBIN_FC27_EA_TO_ID[String(card?.eaId)]) > 0)
      .sort((a, b) => Number(b?.overall || 0) - Number(a?.overall || 0) || Number(a?.eaId || 0) - Number(b?.eaId || 0));

    const rows = eligible.slice(offset, offset + limit).map(card => ({
      eaId: String(card.eaId),
      name: card.name || card.cardName || null,
      overall: Number(card.overall || 0) || null,
      rating: Number(card.overall || 0) || null,
      rarityName: card.rarityName || card.rarityGroupName || card.cardType || null,
      cardType: card.cardType || null,
      futbinId: Number(FUTBIN_FC27_EA_TO_ID[String(card.eaId)]) || null
    }));
    return res.json({
      ok: true,
      source: 'FUTGG_METADATA_FALLBACK',
      gameYear: 27,
      count: rows.length,
      totalEligible: eligible.length,
      databaseReachable: false,
      rows
    });
  } catch (error) {
    return res.status(503).json({ ok: false, error: 'COLLECTOR_TARGETS_UNAVAILABLE' });
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
