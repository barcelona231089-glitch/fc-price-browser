import crypto from 'node:crypto';

const TABLE = 'fc_futbin_fc27_snapshots';

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
    source TEXT NOT NULL DEFAULT 'PC_COLLECTOR',
    PRIMARY KEY (futbin_id, observed_at)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${TABLE}_observed_idx ON ${TABLE}(observed_at DESC)`);
}

export function validIngestToken(req) {
  const expected=String(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN||'');
  const got=String(req.get('x-futbin-ingest-token')||'');
  if (!expected || !got || expected.length!==got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(got));
}

export async function ingestFutbinSnapshot(pool, rows=[]) {
  if (!pool) throw new Error('DB_DISABLED');
  const clean=rows.slice(0,500).filter(r=>Number(r.futbinId)>0);
  if (!clean.length) return {inserted:0};
  await ensureFutbinSnapshotTable(pool);
  let inserted=0;
  for (const r of clean) {
    const q=await pool.query(`INSERT INTO ${TABLE}
      (futbin_id,observed_at,name,rating,price_console,price_pc,popular_rank)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[
      Number(r.futbinId), r.observedAt||new Date().toISOString(), String(r.name||'').slice(0,200),
      Number(r.rating)||null, Number(r.priceConsole)||null, Number(r.pricePc)||null, Number(r.popularRank)||null
    ]);
    inserted+=q.rowCount||0;
  }
  return {inserted,received:clean.length};
}

export async function futbinSnapshotHealth(pool) {
  if (!pool) return {configured:false};
  await ensureFutbinSnapshotTable(pool);
  const {rows}=await pool.query(`SELECT MAX(observed_at) latest, COUNT(*)::int total,
    COUNT(*) FILTER (WHERE observed_at > NOW()-INTERVAL '2 hours')::int recent FROM ${TABLE}`);
  const x=rows[0]||{}; const age=x.latest?Math.round((Date.now()-new Date(x.latest).getTime())/1000):null;
  return {configured:true,latestObservedAt:x.latest||null,ageSeconds:age,totalRows:x.total||0,recentRows:x.recent||0,
    fresh:Number.isFinite(age)&&age<=5400};
}
