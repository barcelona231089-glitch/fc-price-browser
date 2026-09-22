import { FUTBIN_FC27_EA_TO_ID } from "./futbinIdMapFc27.js";
import { compareFutggFutbin } from "./futbinSecondaryIntelligenceV1.js";

const state = { runs: 0, enriched: 0, salesEvidenceEnriched: 0, lastRunAt: null, lastResult: null };

function resolveMappedFutbinId(row) {
  const eaId = Number(row?.eaId);
  const direct = Number(row?.futbinId || FUTBIN_FC27_EA_TO_ID[String(eaId)]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  if (row?.cardType === "Base Rare" && Number.isSafeInteger(eaId) && eaId >= 16777216) {
    const baseId = eaId % 16777216;
    const mapped = Number(FUTBIN_FC27_EA_TO_ID[String(baseId)]);
    if (Number.isFinite(mapped) && mapped > 0) return mapped;
  }
  return NaN;
}

function applySalesEvidence(row, evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const n = key => Number.isFinite(Number(evidence[key])) ? Number(evidence[key]) : null;
  row.futbinSalesRowCount = n("rowCount") ?? 0;
  row.futbinSoldSampleCount = n("soldSampleCount") ?? 0;
  row.futbinListedSampleCount = n("listedSampleCount") ?? 0;
  row.futbinUnsoldSampleCount = n("unsoldSampleCount") ?? 0;
  row.futbinSoldPriceMedian = n("soldPriceMedian");
  row.futbinSoldPriceP25 = n("soldPriceP25");
  row.futbinSoldPriceP75 = n("soldPriceP75");
  row.futbinSoldPriceMin = n("soldPriceMin");
  row.futbinSoldPriceMax = n("soldPriceMax");
  row.futbinSoldPriceMode = n("soldPriceMode");
  row.futbinSalesEvidenceScore = n("salesEvidenceScore");
  row.futbinSoldPremiumPctVsLive = n("soldPremiumPctVsLive");
  row.futbinLatestSoldAt = evidence.latestSoldAt || null;
  row.futbinSalesHistoryAvailable = row.futbinSoldSampleCount > 0 || row.futbinUnsoldSampleCount > 0;
  return row.futbinSalesHistoryAvailable;
}

export async function enrichRowsWithSnapshotFutbinBrain(rows = [], options = {}) {
  const pool = options.pool;
  const year = Number(options.gameYear || 0);
  state.runs += 1;
  state.lastRunAt = new Date().toISOString();
  if (year !== 27 || !pool?.query || !Array.isArray(rows) || !rows.length) {
    return state.lastResult = { ok: false, reason: "UNAVAILABLE", enriched: 0 };
  }

  const maxAgeSeconds = Math.max(300, Number(options.maxAgeSeconds || 5400));
  const resolvedRowIds = rows.map(resolveMappedFutbinId).filter(Number.isFinite);
  const ids = [...new Set(resolvedRowIds)];
  const resolvedRows = resolvedRowIds.length;
  const unmappedRows = rows.length - resolvedRows;
  if (!ids.length) {
    return state.lastResult = { ok: true, enriched: 0, reason: "NO_FUTBIN_IDS", resolvedIds: 0, resolvedRows: 0, unmapped: rows.length, maxAgeSeconds };
  }

  let result;
  try {
    result = await pool.query(`SELECT DISTINCT ON (futbin_id)
      futbin_id, observed_at, price_console, price_pc, popular_rank, sales_evidence
      FROM fc_futbin_fc27_snapshots
      WHERE futbin_id = ANY($1::bigint[])
        AND observed_at >= NOW() - ($2::int * INTERVAL '1 second')
      ORDER BY futbin_id, observed_at DESC`, [ids, maxAgeSeconds]);
  } catch (error) {
    return state.lastResult = { ok: false, enriched: 0, reason: "DB_ERROR", error: String(error?.message || error), maxAgeSeconds };
  }

  const hits = new Map(result.rows.map(r => [String(r.futbin_id), r]));
  let enriched = 0;
  let skippedExisting = 0;
  let salesEvidenceEnriched = 0;
  for (const row of rows) {
    const mappedId = resolveMappedFutbinId(row);
    const hit = hits.get(String(mappedId));
    if (!hit) continue;
    row.futbinId = mappedId;
    if (hit.popular_rank != null) row.futbinPopularRank = Number(hit.popular_rank);
    if (applySalesEvidence(row, hit.sales_evidence)) salesEvidenceEnriched += 1;

    if (Number(row.futbinPrice) > 0 && row.futbinProvider && row.futbinProvider !== "FUTBIN_FC27_PC_COLLECTOR") {
      skippedExisting += 1;
      continue;
    }
    const price = Number(hit.price_console || 0);
    if (!(price > 0)) continue;
    const base = Number(row.price || 0);
    const diffPct = base > 0 ? Number((((price - base) / base) * 100).toFixed(2)) : null;
    const abs = Number.isFinite(diffPct) ? Math.abs(diffPct) : null;
    const maxDiff = Number(options.maxDiffPct ?? 12);
    const outlier = Number(options.outlierDiffPct ?? 25);
    row.futbinPrice = price;
    row.futbinProvider = "FUTBIN_FC27_PC_COLLECTOR";
    row.futbinCheckedAt = new Date(hit.observed_at).toISOString();
    row.futbinDiffPct = diffPct;
    const agreement = compareFutggFutbin(base, price);
    row.futbinCrossCheck = agreement.ok ? agreement.agreement : (abs == null ? "OBSERVED" : abs >= outlier ? "OUTLIER" : abs >= maxDiff ? "DIVERGENCE" : "MATCH");
    row.futbinTrustMultiplier = agreement.ok ? agreement.trustMultiplier : 1;
    row.futbinMatchConfidence = Math.round(100 * row.futbinTrustMultiplier);
    row.futbinSnapshotFresh = true;
    enriched += 1;
  }

  state.enriched += enriched;
  state.salesEvidenceEnriched += salesEvidenceEnriched;
  return state.lastResult = {
    ok: true, enriched, salesEvidenceEnriched, available: hits.size,
    resolvedIds: ids.length, resolvedRows, unmapped: unmappedRows,
    skippedExisting, maxAgeSeconds
  };
}

export function getSnapshotFutbinBrainStatus() {
  return { ...state, source: "FUTBIN_FC27_PC_COLLECTOR", freshnessSeconds: 5400 };
}
