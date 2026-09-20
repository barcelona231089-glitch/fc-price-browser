export async function enrichRowsWithSnapshotFutbinBrain(rows = [], options = {}) {
  const pool = options.pool;
  const year = Number(options.gameYear || 0);
  if (year !== 27 || !pool?.query || !Array.isArray(rows) || !rows.length) return { ok:false, reason:"UNAVAILABLE", enriched:0 };
  const maxAgeSeconds = Math.max(300, Number(options.maxAgeSeconds || 5400));
  const ids = [...new Set(rows.map(r => Number(r.futbinId)).filter(Number.isFinite))];
  if (!ids.length) return { ok:true, enriched:0, reason:"NO_FUTBIN_IDS" };
  const result = await pool.query(`SELECT DISTINCT ON (futbin_id) futbin_id, observed_at, price_console, price_pc, popular_rank FROM fc_futbin_fc27_snapshots WHERE futbin_id = ANY($1::bigint[]) AND observed_at >= NOW() - ($2::int * INTERVAL '1 second') ORDER BY futbin_id, observed_at DESC`, [ids, maxAgeSeconds]);
  const hits = new Map(result.rows.map(r => [String(r.futbin_id), r]));
  let enriched=0;
  for (const row of rows) {
    const hit=hits.get(String(row.futbinId)); if (!hit) continue;
    const price=Number(hit.price_console || 0); if (!(price>0)) continue;
    const base=Number(row.price || 0); const diffPct=base>0 ? Number((((price-base)/base)*100).toFixed(2)) : null;
    const abs=Number.isFinite(diffPct) ? Math.abs(diffPct) : null;
    const maxDiff=Number(options.maxDiffPct ?? 12), outlier=Number(options.outlierDiffPct ?? 25);
    row.futbinPrice=price; row.futbinProvider="FUTBIN_FC27_PC_COLLECTOR"; row.futbinCheckedAt=new Date(hit.observed_at).toISOString(); row.futbinPopularRank=hit.popular_rank == null ? row.futbinPopularRank : Number(hit.popular_rank);
    row.futbinDiffPct=diffPct; row.futbinCrossCheck=abs==null ? "OBSERVED" : abs>=outlier ? "OUTLIER" : abs>=maxDiff ? "DIVERGENCE" : "MATCH"; row.futbinMatchConfidence=100; row.futbinSnapshotFresh=true; enriched++;
  }
  return {ok:true,enriched,available:hits.size,maxAgeSeconds};
}
