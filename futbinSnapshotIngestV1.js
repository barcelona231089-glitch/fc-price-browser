import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TABLE = 'fc_futbin_fc27_snapshots';
const MAX_ROWS = 500;
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const RUNTIME_MAX_ROWS = 1000;
const FALLBACK_FILE = String(process.env.FUTBIN_SNAPSHOT_FALLBACK_FILE
  || path.join(process.cwd(), 'data', 'futbin-fc27-runtime-snapshots.json'));
const runtimeStore = {
  loaded: false, rows: new Map(), lastIngestAt: null,
  fallbackFilePersisted: false, fallbackFileError: null,
  databaseReachable: null, databaseError: null
};

function safeError(error) {
  return String(error?.message || error || 'UNKNOWN').slice(0, 500);
}

function loadRuntimeFallback() {
  if (runtimeStore.loaded) return;
  runtimeStore.loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(FALLBACK_FILE, 'utf8'));
    const now = Date.now();
    for (const row of Array.isArray(parsed?.rows) ? parsed.rows : []) {
      const id = positiveInt(row?.futbinId);
      const ms = Date.parse(row?.observedAt || '');
      if (!id || !Number.isFinite(ms) || ms < now - MAX_AGE_MS || ms > now + MAX_FUTURE_MS) continue;
      runtimeStore.rows.set(String(id), row);
    }
    runtimeStore.fallbackFilePersisted = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') runtimeStore.fallbackFileError = safeError(error);
  }
}

export async function ensureFutbinSnapshotTable(pool) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    futbin_id BIGINT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    name TEXT,
    rating INTEGER,
    price_console BIGINT,
    price_pc BIGINT,
    popular_rank INTEGER,
    games_played_console BIGINT,
    games_played_pc BIGINT,
    sales_evidence JSONB,
    source TEXT NOT NULL DEFAULT 'PC_COLLECTOR',
    PRIMARY KEY (futbin_id, observed_at)
  )`);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS sales_evidence JSONB`);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS games_played_console BIGINT`);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS games_played_pc BIGINT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_observed_idx ON ${TABLE}(observed_at DESC)`);
}

const PINNED_COLLECTOR_KEY_SHA256 = 'fe90fc6012c9814347eda2194a4c7a4f7b917ee275a807a3b9999760e170ce8c';

export function validIngestToken(req) {
  const expected = String(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN || '');
  const got = String(req.get('x-futbin-ingest-token') || '');
  if (!got) return false;

  if (expected && expected.length === got.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) return true;
    } catch {}
  }

  const gotHash = crypto.createHash('sha256').update(got).digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(PINNED_COLLECTOR_KEY_SHA256, 'hex'),
    Buffer.from(gotHash, 'hex')
  );
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function nullablePositiveInt(value) {
  if (value == null || value === '') return null;
  return positiveInt(value);
}

function nonNegativeInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSalesEvidence(value, nowMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const latestSoldAt = cleanObservedAt(value.latestSoldAt, nowMs);
  const out = {
    rowCount: nonNegativeInt(value.rowCount),
    soldSampleCount: nonNegativeInt(value.soldSampleCount),
    listedSampleCount: nonNegativeInt(value.listedSampleCount),
    unsoldSampleCount: nonNegativeInt(value.unsoldSampleCount),
    soldPriceMedian: nullablePositiveInt(value.soldPriceMedian),
    soldPriceP25: nullablePositiveInt(value.soldPriceP25),
    soldPriceP75: nullablePositiveInt(value.soldPriceP75),
    soldPriceMin: nullablePositiveInt(value.soldPriceMin),
    soldPriceMax: nullablePositiveInt(value.soldPriceMax),
    soldPriceMode: nullablePositiveInt(value.soldPriceMode),
    salesEvidenceScore: finiteNumber(value.salesEvidenceScore),
    soldPremiumPctVsLive: finiteNumber(value.soldPremiumPctVsLive),
    latestSoldAt
  };
  return Object.values(out).some(v => v != null) ? out : null;
}

function cleanObservedAt(value, nowMs) {
  if (!value) return null;
  const raw = value;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (ms > nowMs + MAX_FUTURE_MS || ms < nowMs - MAX_AGE_MS) return null;
  return new Date(ms).toISOString();
}

export function normalizeFutbinSnapshotRows(rows = [], nowMs = Date.now()) {
  const clean = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, MAX_ROWS) : []) {
    const futbinId = positiveInt(row?.futbinId);
    const observedAt = cleanObservedAt(row?.observedAt, nowMs);
    if (!futbinId || !observedAt) continue;

    const ratingRaw = row?.rating == null || row.rating === '' ? null : Number(row.rating);
    const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 99 ? ratingRaw : null;
    const popularRaw = row?.popularRank == null || row.popularRank === '' ? null : Number(row.popularRank);
    const popularRank = Number.isInteger(popularRaw) && popularRaw >= 0 ? popularRaw : null;

    clean.push({
      futbinId,
      observedAt,
      name: String(row?.name || '').slice(0, 200),
      rating,
      priceConsole: nullablePositiveInt(row?.priceConsole),
      pricePc: nullablePositiveInt(row?.pricePc),
      popularRank,
      gamesPlayedConsole: nullablePositiveInt(row?.gamesPlayedConsole),
      gamesPlayedPc: nullablePositiveInt(row?.gamesPlayedPc),
      salesEvidence: normalizeSalesEvidence(row?.salesEvidence, nowMs),
    });
  }
  return clean;
}

function runtimePublicRow(row) {
  return {
    futbinId: Number(row.futbinId), observedAt: row.observedAt, name: row.name || null,
    rating: row.rating ?? null, priceConsole: Number(row.priceConsole) || null,
    pricePc: Number(row.pricePc) || null, popularRank: row.popularRank ?? null,
    gamesPlayedConsole: Number(row.gamesPlayedConsole) || null,
    gamesPlayedPc: Number(row.gamesPlayedPc) || null,
    salesEvidence: row.salesEvidence || null,
    source: row.source || 'PC_COLLECTOR_RUNTIME_FALLBACK'
  };
}

function persistRuntimeFallback() {
  try {
    fs.mkdirSync(path.dirname(FALLBACK_FILE), { recursive: true });
    const rows = [...runtimeStore.rows.values()]
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, RUNTIME_MAX_ROWS);
    fs.writeFileSync(FALLBACK_FILE, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), rows }), 'utf8');
    runtimeStore.fallbackFilePersisted = true;
    runtimeStore.fallbackFileError = null;
    return true;
  } catch (error) {
    runtimeStore.fallbackFilePersisted = false;
    runtimeStore.fallbackFileError = safeError(error);
    return false;
  }
}

function rememberRuntimeSnapshots(clean = []) {
  loadRuntimeFallback();
  for (const row of clean) {
    const key = String(row.futbinId);
    const previous = runtimeStore.rows.get(key);
    if (!previous || Date.parse(row.observedAt) >= Date.parse(previous.observedAt || 0)) {
      runtimeStore.rows.set(key, { ...row, source: 'PC_COLLECTOR_RUNTIME_FALLBACK' });
    }
  }
  if (runtimeStore.rows.size > RUNTIME_MAX_ROWS) {
    const keep = [...runtimeStore.rows.values()]
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
      .slice(0, RUNTIME_MAX_ROWS);
    runtimeStore.rows = new Map(keep.map(row => [String(row.futbinId), row]));
  }
  runtimeStore.lastIngestAt = new Date().toISOString();
  return persistRuntimeFallback();
}

function runtimeRows({ limit = 250, evidenceOnly = false, ids = null, maxAgeSeconds = null } = {}) {
  loadRuntimeFallback();
  const safeLimit = Math.max(1, Math.min(RUNTIME_MAX_ROWS, Number(limit) || 250));
  const idSet = ids ? new Set([...ids].map(String)) : null;
  const minMs = maxAgeSeconds == null ? null : (Number.isFinite(Number(maxAgeSeconds)) ? Date.now() - Number(maxAgeSeconds) * 1000 : null);
  return [...runtimeStore.rows.values()]
    .filter(row => (!evidenceOnly || row.salesEvidence != null)
      && (!idSet || idSet.has(String(row.futbinId)))
      && (minMs == null || Date.parse(row.observedAt) >= minMs))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, safeLimit)
    .map(runtimePublicRow);
}

function mapDbRow(row) {
  return {
    futbinId: Number(row.futbin_id), observedAt: row.observed_at, name: row.name,
    rating: row.rating, priceConsole: Number(row.price_console) || null,
    pricePc: Number(row.price_pc) || null, popularRank: row.popular_rank,
    gamesPlayedConsole: Number(row.games_played_console) || null,
    gamesPlayedPc: Number(row.games_played_pc) || null,
    salesEvidence: row.sales_evidence || null, source: row.source || 'PC_COLLECTOR'
  };
}

function mergeLatestRows(primary = [], fallback = [], limit = 250) {
  const merged = new Map();
  for (const row of [...fallback, ...primary]) {
    const key = String(row.futbinId);
    const previous = merged.get(key);
    if (!previous || Date.parse(row.observedAt) >= Date.parse(previous.observedAt)) merged.set(key, row);
  }
  return [...merged.values()]
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .slice(0, limit);
}

export async function ingestFutbinSnapshot(pool, rows = []) {
  const clean = normalizeFutbinSnapshotRows(rows);
  if (!clean.length) return {
    inserted: 0, received: 0, salesEvidenceReceived: 0, salesEvidencePersisted: 0,
    storageMode: 'NONE'
  };

  const runtimeFilePersisted = rememberRuntimeSnapshots(clean);
  const salesEvidenceReceived = clean.filter(row => row.salesEvidence != null).length;
  let dbInserted = 0;
  let dbPersisted = false;

  if (pool?.query) {
    try {
      await ensureFutbinSnapshotTable(pool);
      const values = [];
      const tuples = clean.map((row, index) => {
        const base = index * 10;
        values.push(row.futbinId, row.observedAt, row.name, row.rating, row.priceConsole, row.pricePc,
          row.popularRank, row.gamesPlayedConsole, row.gamesPlayedPc, row.salesEvidence);
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`;
      });
      const result = await pool.query(`INSERT INTO ${TABLE}
        (futbin_id,observed_at,name,rating,price_console,price_pc,popular_rank,games_played_console,games_played_pc,sales_evidence)
        VALUES ${tuples.join(',')}
        ON CONFLICT (futbin_id, observed_at) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, ${TABLE}.name),
          rating = COALESCE(EXCLUDED.rating, ${TABLE}.rating),
          price_console = COALESCE(EXCLUDED.price_console, ${TABLE}.price_console),
          price_pc = COALESCE(EXCLUDED.price_pc, ${TABLE}.price_pc),
          popular_rank = COALESCE(EXCLUDED.popular_rank, ${TABLE}.popular_rank),
          games_played_console = COALESCE(EXCLUDED.games_played_console, ${TABLE}.games_played_console),
          games_played_pc = COALESCE(EXCLUDED.games_played_pc, ${TABLE}.games_played_pc),
          sales_evidence = COALESCE(EXCLUDED.sales_evidence, ${TABLE}.sales_evidence)`, values);
      dbInserted = result.rowCount || 0;
      dbPersisted = true;
      runtimeStore.databaseReachable = true;
      runtimeStore.databaseError = null;
    } catch (error) {
      runtimeStore.databaseReachable = false;
      runtimeStore.databaseError = safeError(error);
    }
  }

  const durableEvidence = dbPersisted || runtimeFilePersisted ? salesEvidenceReceived : 0;
  return {
    inserted: dbPersisted ? dbInserted : (runtimeFilePersisted ? clean.length : 0),
    received: clean.length,
    salesEvidenceReceived,
    salesEvidencePersisted: durableEvidence,
    dbInserted,
    dbPersisted,
    runtimeStored: clean.length,
    runtimeFilePersisted,
    storageMode: dbPersisted ? 'POSTGRES+RUNTIME_FALLBACK' : 'RUNTIME_FALLBACK',
    databaseError: dbPersisted ? null : runtimeStore.databaseError
  };
}

export async function latestFutbinSnapshots(pool, { limit = 250, evidenceOnly = false } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 250));
  const fallback = runtimeRows({ limit: safeLimit, evidenceOnly });
  if (!pool?.query) return fallback;

  try {
    await ensureFutbinSnapshotTable(pool);
    const where = evidenceOnly ? 'WHERE sales_evidence IS NOT NULL' : '';
    const { rows } = await pool.query(`SELECT * FROM (
      SELECT DISTINCT ON (futbin_id)
        futbin_id, observed_at, name, rating, price_console, price_pc, popular_rank,
        games_played_console, games_played_pc, sales_evidence, source
      FROM ${TABLE} ${where}
      ORDER BY futbin_id, observed_at DESC
    ) latest ORDER BY observed_at DESC LIMIT $1`, [safeLimit]);
    runtimeStore.databaseReachable = true;
    runtimeStore.databaseError = null;
    return mergeLatestRows(rows.map(mapDbRow), fallback, safeLimit);
  } catch (error) {
    runtimeStore.databaseReachable = false;
    runtimeStore.databaseError = safeError(error);
    return fallback;
  }
}

export async function latestFutbinSnapshotsForIds(pool, ids = [], { maxAgeSeconds = 5400 } = {}) {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map(positiveInt).filter(Boolean))].slice(0, 500);
  if (!cleanIds.length) return [];
  const fallback = runtimeRows({ limit: cleanIds.length, ids: cleanIds, maxAgeSeconds });
  if (!pool?.query) return fallback;

  try {
    await ensureFutbinSnapshotTable(pool);
    const { rows } = await pool.query(`SELECT DISTINCT ON (futbin_id)
      futbin_id, observed_at, name, rating, price_console, price_pc, popular_rank,
      games_played_console, games_played_pc, sales_evidence, source
      FROM ${TABLE}
      WHERE futbin_id = ANY($1::bigint[])
        AND observed_at >= NOW() - ($2::int * INTERVAL '1 second')
      ORDER BY futbin_id, observed_at DESC`, [cleanIds, Math.max(300, Number(maxAgeSeconds) || 5400)]);
    runtimeStore.databaseReachable = true;
    runtimeStore.databaseError = null;
    return mergeLatestRows(rows.map(mapDbRow), fallback, cleanIds.length);
  } catch (error) {
    runtimeStore.databaseReachable = false;
    runtimeStore.databaseError = safeError(error);
    return fallback;
  }
}

export async function futbinSnapshotHealth(pool) {
  const fallback = runtimeRows({ limit: RUNTIME_MAX_ROWS });
  const now = Date.now();
  const runtimeRecent = fallback.filter(row => Date.parse(row.observedAt) > now - 2 * 60 * 60_000);
  const runtimeEvidence = fallback.filter(row => row.salesEvidence != null);
  const runtimeRecentEvidence = runtimeRecent.filter(row => row.salesEvidence != null);
  const runtimeLatest = fallback[0]?.observedAt || null;

  if (pool?.query) {
    try {
      await ensureFutbinSnapshotTable(pool);
      const { rows } = await pool.query(`SELECT MAX(observed_at) latest, COUNT(*)::int total,
        COUNT(*) FILTER (WHERE observed_at > NOW()-INTERVAL '2 hours')::int recent,
        COUNT(*) FILTER (WHERE sales_evidence IS NOT NULL)::int evidence_total,
        COUNT(*) FILTER (WHERE sales_evidence IS NOT NULL AND observed_at > NOW()-INTERVAL '2 hours')::int evidence_recent
        FROM ${TABLE}`);
      const x = rows[0] || {};
      const latest = [x.latest, runtimeLatest].filter(Boolean)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
      const age = latest ? Math.round((Date.now() - new Date(latest).getTime()) / 1000) : null;
      runtimeStore.databaseReachable = true;
      runtimeStore.databaseError = null;
      return {
        configured: true, databaseConfigured: true, databaseReachable: true,
        storageMode: 'POSTGRES+RUNTIME_FALLBACK',
        latestObservedAt: latest, ageSeconds: age,
        totalRows: x.total || 0, recentRows: x.recent || 0,
        salesEvidenceRows: x.evidence_total || 0, recentSalesEvidenceRows: x.evidence_recent || 0,
        runtimeRows: fallback.length, runtimeRecentRows: runtimeRecent.length,
        runtimeSalesEvidenceRows: runtimeEvidence.length,
        runtimeRecentSalesEvidenceRows: runtimeRecentEvidence.length,
        runtimeFilePersisted: runtimeStore.fallbackFilePersisted,
        runtimeFileError: runtimeStore.fallbackFileError,
        fresh: Number.isFinite(age) && age <= 5400
      };
    } catch (error) {
      runtimeStore.databaseReachable = false;
      runtimeStore.databaseError = safeError(error);
    }
  }

  const age = runtimeLatest ? Math.round((Date.now() - Date.parse(runtimeLatest)) / 1000) : null;
  return {
    configured: Boolean(pool?.query) || fallback.length > 0,
    databaseConfigured: Boolean(pool?.query),
    databaseReachable: false,
    databaseError: runtimeStore.databaseError,
    storageMode: 'RUNTIME_FALLBACK',
    latestObservedAt: runtimeLatest,
    ageSeconds: age,
    totalRows: fallback.length,
    recentRows: runtimeRecent.length,
    salesEvidenceRows: runtimeEvidence.length,
    recentSalesEvidenceRows: runtimeRecentEvidence.length,
    runtimeRows: fallback.length,
    runtimeRecentRows: runtimeRecent.length,
    runtimeSalesEvidenceRows: runtimeEvidence.length,
    runtimeRecentSalesEvidenceRows: runtimeRecentEvidence.length,
    runtimeFilePersisted: runtimeStore.fallbackFilePersisted,
    runtimeFileError: runtimeStore.fallbackFileError,
    fresh: Number.isFinite(age) && age <= 5400
  };
}
