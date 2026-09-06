import { optimizeListWithSeed } from './uvEngine.js';
import { evaluateRatingEligibility } from './candidatePipeline.js';

function cost(card) {
  const n = Number(card?.buyPrice ?? card?.recommendedBuyPrice ?? card?.price);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function score(card) {
  const n = Number(card?.selectionScore ?? card?.tradeQualityScore ?? card?.uvScore ?? 50);
  return Number.isFinite(n) ? n : 50;
}


function endgameMixCaps(options = {}) {
  const ro = options?.ratingOptions || {};
  const gy = Number(ro?.gameYear);
  const now = ro?.now ? new Date(ro.now) : new Date();
  if (!Number.isFinite(gy) || Number.isNaN(now.getTime())) return null;
  const endYear = 2000 + gy;
  const endgame = now.getUTCFullYear() > endYear || (now.getUTCFullYear() === endYear && now.getUTCMonth() + 1 >= 8);
  if (!endgame) return null;
  const budget = Number(ro?.budget ?? options?.budget);
  const count = Math.max(1, Number(ro?.portfolioCount ?? options?.count ?? 100));
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const ideal = budget / count;
  if (ideal >= 2500) return { max82: Math.max(2, Math.round(count * 0.04)), max83OrLess: Math.max(8, Math.round(count * 0.12)) };
  if (ideal >= 1500) return { max82: Math.max(5, Math.round(count * 0.08)), max83OrLess: Math.max(12, Math.round(count * 0.20)) };
  if (ideal >= 900) return { max82: Math.max(10, Math.round(count * 0.16)), max83OrLess: Math.max(20, Math.round(count * 0.35)) };
  return { max82: Math.max(15, Math.round(count * 0.30)), max83OrLess: Math.max(30, Math.round(count * 0.55)) };
}

function isNormalLow(card = {}, max = 83) {
  return String(card?.cardType || '').toLowerCase() !== 'special' && Number(card?.overall || 0) <= max;
}

export function buildRebalanceSeed(storedItems = [], recheckRows = [], currentById = new Map(), options = {}) {
  const rowBySlot = new Map(recheckRows.map(row => [Number(row.slot), row]));
  const retained = [];
  const blockedIds = new Set();
  const dropped = [];
  const retainedExactCounts = new Map();
  const minRating = Number.isFinite(Number(options?.minRating)) ? Number(options.minRating) : null;
  const ratingOptions = options?.ratingOptions || (minRating != null ? { minRating } : null);
  const traderCaps = endgameMixCaps(options);
  let retained82 = 0;
  let retained83OrLess = 0;

  for (const item of storedItems) {
    const row = rowBySlot.get(Number(item.slot));
    const status = String(row?.status || 'MISSING').toUpperCase();
    const id = String(item.eaId);
    const current = currentById.get(id);

    const overall = Number(current?.overall ?? item?.payload?.overall);
    const ratingEligibility = ratingOptions
      ? evaluateRatingEligibility({ ...(item?.payload || {}), ...(current || {}) }, ratingOptions)
      : null;
    const belowRatingFloor = ratingEligibility ? !ratingEligibility.allowed : (minRating != null && Number.isFinite(overall) && overall < minRating);
    const duplicateLimitBlocked = (retainedExactCounts.get(id) || 0) >= 2;
    const traderMixBlocked = Boolean(traderCaps && current && (
      (isNormalLow(current, 82) && retained82 >= traderCaps.max82) ||
      (isNormalLow(current, 83) && retained83OrLess >= traderCaps.max83OrLess)
    ));

    if ((status === 'KEEP' || status === 'REPRICE') && current && Number.isFinite(cost(current)) && !belowRatingFloor && !duplicateLimitBlocked && !traderMixBlocked) {
      retained.push({
        ...current,
        _rebalanceOrigin: 'retained',
        _rebalanceFromSlot: Number(item.slot),
        _recheck: row || null
      });
      retainedExactCounts.set(id, (retainedExactCounts.get(id) || 0) + 1);
      if (isNormalLow(current, 82)) retained82 += 1;
      if (isNormalLow(current, 83)) retained83OrLess += 1;
      continue;
    }

    blockedIds.add(id);
    dropped.push({
      slot: Number(item.slot),
      eaId: Number(item.eaId),
      name: item.payload?.name || row?.name || null,
      status,
      reason: belowRatingFloor
        ? (ratingEligibility?.reason || `Rating ${overall} liegt unter der aktuellen Portfolio-Untergrenze ${minRating}.`)
        : traderMixBlocked
          ? 'Endgame-Trader-Mix: zu viele normale 82/83er in der alten Liste; diese Position wird durch eine höher priorisierte Karte ersetzt.'
          : duplicateLimitBlocked
            ? 'Maximal 2 Exemplare derselben exakten Karte im Portfolio.'
            : row?.reasons?.[0] || (status === 'WAIT' ? 'Nicht hinterherkaufen.' : 'Position wird im Rebalance ersetzt.')
    });
  }

  return { retained, blockedIds, dropped };
}

export function rebalancePortfolio({ retained = [], candidates = [], blockedIds = new Set(), budget, count = 100 }) {
  if (!Number.isFinite(Number(budget)) || Number(budget) <= 0) throw new Error('Budget muss größer als 0 sein.');
  if (!Number.isInteger(count) || count <= 0) throw new Error('count muss größer als 0 sein.');

  let seed = [...retained]
    .filter(card => Number.isFinite(cost(card)))
    .sort((a, b) => {
      const statusA = String(a?._recheck?.status || 'KEEP');
      const statusB = String(b?._recheck?.status || 'KEEP');
      if (statusA !== statusB) return statusA === 'KEEP' ? -1 : 1;
      return score(b) - score(a);
    });

  const released = [];
  const dynamicallyBlocked = new Set([...blockedIds].map(String));

  for (;;) {
    const pool = candidates.filter(card => !dynamicallyBlocked.has(String(card.eaId)));
    try {
      const optimized = optimizeListWithSeed(pool, Number(budget), count, seed);
      const retainedIds = new Set(seed.map(card => String(card.eaId)));
      const selected = optimized.selected.map(card => ({
        ...card,
        _rebalanceOrigin: retainedIds.has(String(card.eaId)) ? 'retained' : 'replacement'
      }));
      return {
        selected,
        total: optimized.total,
        unusedBudget: Number(budget) - optimized.total,
        retainedCount: selected.filter(c => c._rebalanceOrigin === 'retained').length,
        replacementCount: selected.filter(c => c._rebalanceOrigin === 'replacement').length,
        specialTargetRatio: optimized.specialTargetRatio,
        traderMixPolicy: optimized.traderMixPolicy || null,
        released
      };
    } catch (error) {
      if (!seed.length) throw error;
      // Release the weakest retained card first. REPRICE cards are less sticky
      // than KEEP cards. This is only a feasibility fallback when the current
      // repriced seed would otherwise make a full 100-card list impossible.
      const releaseOrder = [...seed].sort((a, b) => {
        const sa = String(a?._recheck?.status || 'KEEP') === 'REPRICE' ? 0 : 1;
        const sb = String(b?._recheck?.status || 'KEEP') === 'REPRICE' ? 0 : 1;
        if (sa !== sb) return sa - sb;
        if (score(a) !== score(b)) return score(a) - score(b);
        return cost(b) - cost(a);
      });
      const victim = releaseOrder[0];
      seed = seed.filter(card => String(card.eaId) !== String(victim.eaId));
      dynamicallyBlocked.add(String(victim.eaId));
      released.push({
        eaId: Number(victim.eaId),
        name: victim.name || null,
        previousStatus: String(victim?._recheck?.status || 'KEEP'),
        reason: 'Retained-Position musste für ein vollständiges budgetkonformes Portfolio freigegeben werden.'
      });
    }
  }
}
