import { FUTBIN_FC27_EA_TO_ID } from '../../futbinIdMapFc27.js';

const reverseMap = new Map(Object.entries(FUTBIN_FC27_EA_TO_ID).map(([eaId, futbinId]) => [String(futbinId), Number(eaId)]));

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
  card.futbinSoldSampleCount = n('soldSampleCount') ?? 0;
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
  card.futbinSalesHistoryAvailable = card.futbinSoldSampleCount > 0 || card.futbinUnsoldSampleCount > 0;
}

export async function getLiveFutbinCards(pool, platform = 'console', options = {}) {
  if (!pool?.query) throw new Error('FUTBIN-only market requires PostgreSQL snapshot storage.');
  const normalized = platform === 'pc' ? 'pc' : 'console';
  const maxAgeSeconds = Math.max(300, Number(options.maxAgeSeconds || process.env.UV_FUTBIN_MAX_AGE_SECONDS || 5400));
  const result = await pool.query(`SELECT DISTINCT ON (futbin_id)
      futbin_id, observed_at, price_console, price_pc, popular_rank,
      games_played_console, games_played_pc, sales_evidence
    FROM fc_futbin_fc27_snapshots
    WHERE observed_at >= NOW() - ($1::int * INTERVAL '1 second')
    ORDER BY futbin_id, observed_at DESC`, [maxAgeSeconds]);

  const base = [];
  for (const hit of result.rows || []) {
    const eaId = reverseMap.get(String(hit.futbin_id));
    const price = positive(normalized === 'pc' ? hit.price_pc : hit.price_console);
    if (!eaId || !price) continue;
    const games = positive(normalized === 'pc' ? hit.games_played_pc : hit.games_played_console);
    const card = {
      eaId,
      futbinId: Number(hit.futbin_id),
      price,
      futbinPrice: price,
      futbinChecked: true,
      futbinProvider: normalized === 'pc' ? 'FUTBIN_FC27_SNAPSHOT_PC' : 'FUTBIN_FC27_SNAPSHOT_CONSOLE',
      priceSource: 'FUTBIN',
      futbinCheckedAt: hit.observed_at,
      futbinSnapshotFresh: true,
      futbinPopularRank: positive(hit.popular_rank),
      futbinGamesCount: games,
      futbinGamesPlayed: games,
      futbinGamesPlatform: normalized
    };
    applySalesEvidence(card, hit.sales_evidence);
    base.push(card);
  }
  if (!base.length) throw new Error('Keine frischen FUTBIN-FC27-Snapshots verfügbar. Keine FUT.GG-Ausweichquelle erlaubt.');

  const ids = base.map(c => c.eaId);
  let metadata = [];
  try {
    const m = await pool.query(`SELECT ea_id, name, rating, version, card_type, position, club, league
      FROM uv_cards WHERE game_year = 27 AND ea_id = ANY($1::bigint[])`, [ids]);
    metadata = m.rows || [];
  } catch {}
  const byEa = new Map(metadata.map(m => [String(m.ea_id), m]));
  const cards = base.map(card => {
    const m = byEa.get(String(card.eaId)) || {};
    return {
      ...card,
      name: m.name || `EA ${card.eaId}`,
      overall: positive(m.rating),
      rarityName: m.version || m.card_type || null,
      cardType: m.card_type || m.version || 'Unknown',
      position: m.position || null,
      club: m.club || null,
      league: m.league || null,
      url: null
    };
  });
  return {
    cards,
    sourceUrl: 'FUTBIN_FC27_SNAPSHOT',
    updatedAt: new Date().toISOString(),
    live: true,
    futbinOnly: true,
    snapshotAgeSeconds: maxAgeSeconds
  };
}
