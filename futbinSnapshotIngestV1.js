import crypto from 'node:crypto';

const TABLE = 'fc_futbin_fc27_snapshots';
const MAX_ROWS = 500;
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

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
    sales_evidence JSONB,
    source TEXT NOT NULL DEFAULT 'PC_COLLECTOR',
    PRIMARY KEY (futbin_id, observed_at)
  )`);
  await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS sales_evidence JSONB`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_observed_idx ON ${TABLE}(observed_at DESC)`);
}

export function validIngestToken(req) {
  const expected = String(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN || '');
  const got = String(req.get('x-futbin-ingest-token') || '');
  if (!expected || !got || expected.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got));
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
      salesEvidence: normalizeSalesEvidence(row?.salesEvidence, nowMs),
    });
  }
  return clean;
}

export async function ingestFutbinSnapshot(pool, rows = []) {
  if (!pool) throw new Error('DB_DISABLED');
  const clean = normalizeFutbinSnapshotRows(rows);
  if (!clean.length) return { inserted: 0, received: 0, salesEvidenceReceived: 0, salesEvidencePersisted: 0 };
  await ensureFutbinSnapshotTable(pool);

  const values = [];
  const tuples = clean.map((row, index) => {
    const base = index * 8;
    values.push(row.futbinId, row.observedAt, row.name, row.rating, row.priceConsole, row.pricePc, row.popularRank, row.salesEvidence);
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
  });

  const result = await pool.query(`INSERT INTO ${TABLE}
    (futbin_id,observed_at,name,rating,price_console,price_pc,popular_rank,sales_evidence)
    VALUES ${tuples.join(',')}
    ON CONFLICT (futbin_id, observed_at) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, ${TABLE}.name),
      rating = COALESCE(EXCLUDED.rating, ${TABLE}.rating),
      price_console = COALESCE(EXCLUDED.price_console, ${TABLE}.price_console),
      price_pc = COALESCE(EXCLUDED.price_pc, ${TABLE}.price_pc),
      popular_rank = COALESCE(EXCLUDED.popular_rank, ${TABLE}.popular_rank),
      sales_evidence = COALESCE(EXCLUDED.sales_evidence, ${TABLE}.sales_evidence)`, values);

  const salesEvidenceReceived = clean.filter(row => row.salesEvidence != null).length;
  return {
    inserted: result.rowCount || 0,
    received: clean.length,
    salesEvidenceReceived,
    salesEvidencePersisted: salesEvidenceReceived
  };
}

export async function futbinSnapshotHealth(pool) {
  if (!pool) return { configured: false };
  await ensureFutbinSnapshotTable(pool);
  const { rows } = await pool.query(`SELECT MAX(observed_at) latest, COUNT(*)::int total,
    COUNT(*) FILTER (WHERE observed_at > NOW()-INTERVAL '2 hours')::int recent,
    COUNT(*) FILTER (WHERE sales_evidence IS NOT NULL)::int evidence_total,
    COUNT(*) FILTER (WHERE sales_evidence IS NOT NULL AND observed_at > NOW()-INTERVAL '2 hours')::int evidence_recent
    FROM ${TABLE}`);
  const x = rows[0] || {};
  const age = x.latest ? Math.round((Date.now() - new Date(x.latest).getTime()) / 1000) : null;
  return {
    configured: true,
    latestObservedAt: x.latest || null,
    ageSeconds: age,
    totalRows: x.total || 0,
    recentRows: x.recent || 0,
    salesEvidenceRows: x.evidence_total || 0,
    recentSalesEvidenceRows: x.evidence_recent || 0,
    fresh: Number.isFinite(age) && age <= 5400,
  };
}
