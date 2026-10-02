import { FUTBIN_FC27_EA_TO_ID } from '../../futbinIdMapFc27.js';
import { latestFutbinSnapshots } from '../../futbinSnapshotIngestV1.js';

const reverseMap = new Map(
  Object.entries(FUTBIN_FC27_EA_TO_ID).map(([eaId, futbinId]) => [String(futbinId), Number(eaId)])
);

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function applySalesEvidence(card, raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const n = key => {
    const v = Number(e[key]);
    return Number.isFinite(v) ? v : null;
  };
  card.futbinSalesRowCount = n('rowCount') ?? 0;
  card.futbinSoldSampleCount = n('soldSampleCount') ?? 0;
  card.futbinListedSampleCount = n('listedSampleCount') ?? 0;
  card.futbinUnsoldSampleCount = n('unsoldSampleCount') ?? 0;
  card.futbinSoldPriceMedian = n('soldPriceMedian');
  card.futbinSoldPriceP25 = n('soldPriceP25');
  card.futbinSoldPriceP75 = n('soldPriceP75');
  card.futbinSoldPriceMin = n('soldPriceMin');
  card.futbinSoldPriceMax = n('soldPriceMax');
  card.futbinSoldPriceMode = n('soldPriceMode');
  card.futbinSalesEvidenceScore = n('salesEvidenceScore');
  card.futbinObservedSalesPerDay = n('observedSalesPerDay');
  card.futbinLatestSoldAt = e.latestSoldAt || null;
  card.futbinSalesEvidenceObservedAt = e.evidenceObservedAt || null;
  card.futbinSalesHistoryAvailable = card.futbinSoldSampleCount > 0 || card.futbinUnsoldSampleCount > 0;
}

export async function getLiveFutbinCards(pool, platform = 'console', options = {}) {
  const normalized = platform === 'pc' ? 'pc' : 'console';
  const maxAgeSeconds = Math.max(
    300,
    Number(options.maxAgeSeconds || process.env.UV_FUTBIN_MAX_AGE_SECONDS || 5400)
  );
  const maxEvidenceAgeSeconds = Math.max(
    3600,
    Math.min(24 * 3600, Number(options.maxEvidenceAgeSeconds || process.env.UV_FUTBIN_EVIDENCE_MAX_AGE_SECONDS || 18 * 3600))
  );
  const latest = await latestFutbinSnapshots(pool, { limit: 500, evidenceOnly: false });
  const cutoff = Date.now() - maxAgeSeconds * 1000;
  const cards = [];

  for (const hit of latest) {
    const observedAt = hit?.observedAt || null;
    const observedMs = Date.parse(observedAt || '');
    if (!Number.isFinite(observedMs) || observedMs < cutoff) continue;

    const evidenceObservedAt = hit?.salesEvidence?.evidenceObservedAt || observedAt;
    const evidenceMs = Date.parse(evidenceObservedAt || '');
    if (hit?.salesEvidence && (!Number.isFinite(evidenceMs) || evidenceMs < Date.now() - maxEvidenceAgeSeconds * 1000)) continue;

    const eaId = reverseMap.get(String(hit?.futbinId));
    const price = positive(normalized === 'pc' ? hit?.pricePc : hit?.priceConsole);
    if (!eaId || !price) continue;

    const games = positive(normalized === 'pc' ? hit?.gamesPlayedPc : hit?.gamesPlayedConsole);
    const card = {
      eaId,
      futbinId: Number(hit.futbinId),
      name: hit?.name || `EA ${eaId}`,
      overall: positive(hit?.rating),
      rarityName: null,
      cardType: 'Unknown',
      position: null,
      club: null,
      league: null,
      url: null,
      price,
      futbinPrice: price,
      futbinChecked: true,
      futbinProvider: normalized === 'pc' ? 'FUTBIN_FC27_SNAPSHOT_PC' : 'FUTBIN_FC27_SNAPSHOT_CONSOLE',
      priceSource: 'FUTBIN',
      futbinCheckedAt: observedAt,
      futbinSnapshotFresh: true,
      futbinSalesEvidenceFresh: !hit?.salesEvidence || (Number.isFinite(evidenceMs) && evidenceMs >= Date.now() - maxEvidenceAgeSeconds * 1000),
      futbinPopularRank: positive(hit?.popularRank),
      futbinGamesCount: games,
      futbinGamesPlayed: games,
      futbinGamesPlatform: normalized
    };
    applySalesEvidence(card, hit?.salesEvidence);
    cards.push(card);
  }

  if (!cards.length) {
    throw new Error('Keine frischen FUTBIN-FC27-Snapshots verfügbar.');
  }

  return {
    cards,
    sourceUrl: 'FUTBIN_FC27_SNAPSHOT',
    updatedAt: new Date().toISOString(),
    live: true,
    futbinOnly: true,
    snapshotAgeSeconds: maxAgeSeconds
  };
}
