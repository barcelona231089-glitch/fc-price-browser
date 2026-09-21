const state = { imports: 0, accepted: 0, rejected: 0, lastImportAt: null, lastError: null };

function positive(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }
function iso(v) { if (!v) return null; const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; }
function normalizeRow(row, gameYear = 27) {
  if (Number(gameYear) !== 27) return null;
  const futbinId = positive(row.futbinId ?? row.futbin_id ?? row.ID ?? row.id);
  const eaId = positive(row.eaId ?? row.ea_id ?? row.Player_Resource ?? row.resource_id);
  const priceConsole = positive(row.priceConsole ?? row.price_console ?? row.LCPrice ?? row.price);
  const pricePc = positive(row.pricePc ?? row.price_pc);
  const observedAt = iso(row.observedAt ?? row.observed_at ?? row.checked);
  if (!futbinId || (!priceConsole && !pricePc) || !observedAt) return null;
  return { futbinId, eaId, priceConsole, pricePc, observedAt, source: "AUTHORIZED_IMPORT", importedAt: new Date().toISOString() };
}
export function parseAuthorizedFutbinImport(payload, options = {}) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
  const normalized = rows.map(r => normalizeRow(r, options.gameYear ?? 27)).filter(Boolean);
  const dedup = new Map();
  for (const row of normalized) {
    const key = String(row.futbinId);
    const old = dedup.get(key);
    if (!old || row.observedAt > old.observedAt) dedup.set(key, row);
  }
  return { rows: [...dedup.values()], rejected: rows.length - normalized.length, received: rows.length };
}
export async function ingestAuthorizedFutbinImport(pool, payload, options = {}) {
  state.imports += 1; state.lastImportAt = new Date().toISOString(); state.lastError = null;
  if (!pool?.query) return { ok: false, reason: "DB_UNAVAILABLE", ...getAuthorizedFutbinImportStatus() };
  const parsed = parseAuthorizedFutbinImport(payload, options);
  if (!parsed.rows.length) { state.rejected += parsed.rejected; return { ok:false, reason:"NO_VALID_ROWS", ...parsed }; }
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS fc_futbin_fc27_snapshots (
      futbin_id BIGINT NOT NULL, observed_at TIMESTAMPTZ NOT NULL, price_console INTEGER,
      price_pc INTEGER, popular_rank INTEGER, source TEXT, imported_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (futbin_id, observed_at)
    )`);
    for (const r of parsed.rows) await pool.query(
      `INSERT INTO fc_futbin_fc27_snapshots(futbin_id,observed_at,price_console,price_pc,source,imported_at)
       VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT (futbin_id,observed_at) DO NOTHING`,
      [r.futbinId,r.observedAt,r.priceConsole,r.pricePc,r.source]
    );
    state.accepted += parsed.rows.length; state.rejected += parsed.rejected;
    return { ok:true, accepted:parsed.rows.length, rejected:parsed.rejected, source:"AUTHORIZED_IMPORT" };
  } catch (e) { state.lastError=String(e?.message||e); return {ok:false,reason:"DB_ERROR",error:state.lastError}; }
}
export function getAuthorizedFutbinImportStatus(){ return {...state, source:"AUTHORIZED_IMPORT", gameYear:27}; }
