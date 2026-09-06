import { DEMAND_REFRESH_MS, FUTGG_MOST_USED_URL, FUTGG_MOMENTUM_URL, FUTGG_IN_PACKS_URL } from './config.js';
import { clamp, fetchText, normalizeName } from './utils.js';

let cache = null;

const POSITION_LABELS = Object.freeze([
  ['st', 'striker'], ['lw', 'left winger'], ['rw', 'right winger'],
  ['lm', 'left midfielder'], ['rm', 'right midfielder'], ['cam', 'attacking midfielder'],
  ['cm', 'central midfielder'], ['cdm', 'defensive midfielder'], ['lb', 'left back'],
  ['cb', 'centre back'], ['rb', 'right back'], ['gk', 'goalkeeper']
]);

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function htmlToSearchText(html) {
  return decodeEntities(String(html || ''))
    .replace(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function allIndices(haystack, needle, limit = 24) {
  const out = [];
  if (!needle || needle.length < 3) return out;
  let from = 0;
  while (out.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out.push(at);
    from = at + Math.max(1, needle.length);
  }
  return out;
}

function audienceBefore(text, at) {
  const before = text.slice(Math.max(0, at - 900), at);
  const pro = before.lastIndexOf('what the pros use');
  const community = before.lastIndexOf('what the community uses');
  return pro > community ? 'pros' : community > pro ? 'community' : 'unknown';
}

function positionBefore(text, at) {
  const start = Math.max(0, at - 1800);
  const before = text.slice(start, at);
  let best = null;
  let bestAt = -1;
  for (const [code, label] of POSITION_LABELS) {
    for (const marker of [` ${code} ${label} `, ` ${code} ${label}`, `${code} ${label} `, `${code} ${label}`, ` ${code} `]) {
      const i = before.lastIndexOf(marker);
      if (i > bestAt) { bestAt = i; best = code.toUpperCase(); }
    }
  }
  return best;
}

function rankNear(text, at) {
  const before = text.slice(Math.max(0, at - 55), at);
  const matches = [...before.matchAll(/#\s*(\d{1,2})/g)];
  if (!matches.length) return null;
  const rank = Number(matches.at(-1)[1]);
  return Number.isFinite(rank) && rank > 0 && rank <= 50 ? rank : null;
}

function percentNear(text, at, nameLen) {
  const before = text.slice(Math.max(0, at - 55), at);
  const after = text.slice(at + nameLen, Math.min(text.length, at + nameLen + 55));
  const beforeMatches = [...before.matchAll(/(?:#\s*\d+\s*)?(\d{1,2}(?:\.\d+)?)\s*%/g)];
  if (beforeMatches.length) return Number(beforeMatches.at(-1)[1]);
  const afterMatch = after.match(/^(?:\s*#?\d+\s*)?(\d{1,2}(?:\.\d+)?)\s*%/);
  return afterMatch ? Number(afterMatch[1]) : null;
}

function versionTokens(card) {
  const raw = normalizeName(card.rarityName || card.cardName || '');
  const ignored = new Set(['rare', 'common', 'special', 'gold', 'silver', 'bronze', 'non']);
  return raw.split(' ').filter(t => t.length >= 3 && !ignored.has(t)).slice(0, 7);
}

function versionMatchForSnippet(card, snippet) {
  const tokens = versionTokens(card);
  if (!tokens.length) return { versionMatched: null, tokenMatches: 0, tokenCount: 0 };
  const tokenMatches = tokens.filter(t => snippet.includes(t)).length;
  const required = tokens.length <= 2 ? 1 : 2;
  return { versionMatched: tokenMatches >= required, tokenMatches, tokenCount: tokens.length };
}

export function extractMostUsedSignals(html, cards) {
  const text = htmlToSearchText(html);
  const unique = new Map();
  for (const card of cards || []) {
    const name = normalizeName(card.name);
    if (name.length >= 4 && !unique.has(name)) unique.set(name, []);
    if (name.length >= 4) unique.get(name).push(card);
  }

  const byName = new Map();
  for (const [name, versions] of unique) {
    const hits = [];
    for (const at of allIndices(text, name)) {
      const pct = percentNear(text, at, name.length);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
      const snippet = text.slice(Math.max(0, at - 100), Math.min(text.length, at + name.length + 230));
      hits.push({
        pct,
        audience: audienceBefore(text, at),
        position: positionBefore(text, at),
        rank: rankNear(text, at),
        snippet
      });
    }
    if (!hits.length) continue;
    byName.set(name, { hits, versions });
  }
  return byName;
}

export function extractNamedVersionSignals(html, cards, { requireVersionForSpecial = true } = {}) {
  const text = htmlToSearchText(html);
  const byCardId = new Map();
  for (const card of cards || []) {
    const name = normalizeName(card.name);
    if (name.length < 4) continue;
    const cardId = String(card.eaId ?? card.id ?? `${name}|${card.overall}|${card.rarityName}`);
    const special = String(card.cardType || '').toLowerCase() === 'special';
    let best = null;
    for (const at of allIndices(text, name)) {
      const snippet = text.slice(Math.max(0, at - 90), Math.min(text.length, at + name.length + 260));
      const vm = versionMatchForSnippet(card, snippet);
      if (requireVersionForSpecial && special && vm.tokenCount > 0 && vm.versionMatched !== true) continue;
      const quality = (vm.versionMatched === true ? 3 : vm.versionMatched === null ? 1 : 0) + vm.tokenMatches * 0.2;
      if (!best || quality > best.quality) best = { hit: true, snippet, quality, ...vm };
    }
    if (best) byCardId.set(cardId, best);
  }
  return byCardId;
}

function cardUsageSignal(card, record) {
  if (!record?.hits?.length) return null;
  const candidates = record.hits.map(hit => ({ ...hit, ...versionMatchForSnippet(card, hit.snippet) }));
  const exact = candidates.filter(h => h.versionMatched === true);
  const usable = exact.length ? exact : candidates;
  const audiencePriority = hit => hit.audience === 'community' ? 2 : hit.audience === 'pros' ? 1 : 0;
  usable.sort((a, b) => Number(b.versionMatched === true) - Number(a.versionMatched === true) || audiencePriority(b) - audiencePriority(a) || b.pct - a.pct);
  const best = usable[0];

  const pros = usable.filter(h => h.audience === 'pros');
  const community = usable.filter(h => h.audience === 'community');
  const maxPct = rows => rows.length ? Math.max(...rows.map(h => h.pct)) : null;
  const communityUsagePct = maxPct(community);
  const proUsagePct = maxPct(pros);
  const positions = [...new Set(usable.map(h => h.position).filter(Boolean))];
  const ranks = usable.map(h => h.rank).filter(Number.isFinite);
  const usageBestRank = ranks.length ? Math.min(...ranks) : null;
  const usagePct = Number.isFinite(communityUsagePct) ? communityUsagePct : Number.isFinite(proUsagePct) ? proUsagePct : best.pct;

  const communityComponent = Number.isFinite(communityUsagePct) ? Math.min(27, communityUsagePct * 1.7) : 0;
  const proComponent = Number.isFinite(proUsagePct) ? Math.min(19, proUsagePct * 1.35) : 0;
  const breadthComponent = Math.min(10, positions.length * 2.5);
  const rankComponent = usageBestRank === 1 ? 6 : usageBestRank === 2 ? 4 : usageBestRank === 3 ? 2.5 : 0;
  const exactVersion = exact.length > 0;
  const matchPenalty = versionTokens(card).length && !exactVersion ? 7 : 0;
  const popularityScore = clamp(43 + communityComponent + proComponent + breadthComponent + rankComponent - matchPenalty, 42, 98);

  return {
    usagePct,
    usageAudience: best.audience,
    usageVersionMatched: exactVersion || best.versionMatched === null,
    usageHitCount: usable.length,
    communityUsagePct,
    proUsagePct,
    usagePositionCount: positions.length,
    usagePositions: positions,
    usageBestRank,
    popularityScore,
    usageEvidenceQuality: exactVersion ? 'exact-version' : versionTokens(card).length ? 'name-level' : 'generic-card'
  };
}

function cardSignalId(card) {
  return String(card.eaId ?? card.id ?? `${normalizeName(card.name)}|${card.overall}|${card.rarityName}`);
}

export async function getFutggDemandContext(cards) {
  if (cache && Date.now() - cache.at < DEMAND_REFRESH_MS) return cache.value;
  const context = {
    ok: false,
    mostUsedOk: false,
    momentumOk: false,
    inPacksOk: false,
    mostUsedMatches: 0,
    momentumMatches: 0,
    inPacksMatches: 0,
    sources: [],
    errors: []
  };
  const results = await Promise.allSettled([
    fetchText(FUTGG_MOST_USED_URL),
    fetchText(FUTGG_MOMENTUM_URL),
    fetchText(FUTGG_IN_PACKS_URL)
  ]);

  let mostUsedHtml = '';
  let momentumHtml = '';
  let inPacksHtml = '';
  if (results[0].status === 'fulfilled') {
    mostUsedHtml = results[0].value;
    context.mostUsedOk = true;
    context.sources.push('FUT.GG Most Used Players');
  } else context.errors.push(`Most Used: ${String(results[0].reason)}`);
  if (results[1].status === 'fulfilled') {
    momentumHtml = results[1].value;
    context.momentumOk = true;
    context.sources.push('FUT.GG Momentum');
  } else context.errors.push(`Momentum: ${String(results[1].reason)}`);
  if (results[2].status === 'fulfilled') {
    inPacksHtml = results[2].value;
    context.inPacksOk = true;
    context.sources.push('FUT.GG In Packs');
  } else context.errors.push(`In Packs: ${String(results[2].reason)}`);

  const mostUsed = mostUsedHtml ? extractMostUsedSignals(mostUsedHtml, cards) : new Map();
  const momentumByCard = momentumHtml ? extractNamedVersionSignals(momentumHtml, cards, { requireVersionForSpecial: true }) : new Map();
  const inPacksByCard = inPacksHtml ? extractNamedVersionSignals(inPacksHtml, cards, { requireVersionForSpecial: true }) : new Map();
  context.mostUsedMatches = mostUsed.size;
  context.momentumMatches = momentumByCard.size;
  context.inPacksMatches = inPacksByCard.size;
  context.ok = context.mostUsedOk || context.momentumOk || context.inPacksOk;

  const value = { context, mostUsed, momentumByCard, inPacksByCard };
  cache = { at: Date.now(), value };
  return value;
}


export function buildPromoMarketScore(card = {}, { usage = null, momentumHit = false, inPacksHit = false, supplyPressureScore = 0 } = {}) {
  const special = String(card?.cardType || '').toLowerCase() === 'special';
  const popularity = Number.isFinite(Number(usage?.popularityScore)) ? Number(usage.popularityScore) : 50;
  const usagePct = Number.isFinite(Number(usage?.usagePct)) ? Number(usage.usagePct) : 0;
  let score = 48;
  if (special) score += 4;
  if (inPacksHit && special) score += 10;
  else if (inPacksHit) score += 2;
  if (momentumHit) score += 12;
  if (usage) score += Math.min(15, Math.max(0, popularity - 50) * 0.32 + Math.min(6, usagePct * 0.7));
  // Being in packs is not automatically bullish. New supply without demand is
  // explicitly penalised so a current promo card must still prove liquidity.
  if (inPacksHit && special && !momentumHit && !usage) score -= 10;
  score -= Math.max(0, Number(supplyPressureScore || 0) - 45) * 0.16;
  return clamp(score, 0, 100);
}

export function promoMarketState(card = {}) {
  const score = Number(card?.promoMarketScore || 0);
  if (String(card?.cardType || '').toLowerCase() === 'special' && card?.inPacksHit === true && score >= 68) return 'PROMO_HOT';
  if (String(card?.cardType || '').toLowerCase() === 'special' && card?.inPacksHit === true && score >= 56) return 'PROMO_LIQUID';
  if (card?.inPacksHit === true && score < 50) return 'SUPPLY_ONLY';
  if (card?.momentumHit === true || score >= 62) return 'LIVE_DEMAND';
  return 'NEUTRAL';
}

function attachDemandFromContext(cards, demand) {
  const out = (cards || []).map(card => {
    const key = normalizeName(card.name);
    const usage = cardUsageSignal(card, demand.mostUsed.get(key));
    const id = cardSignalId(card);
    const momentumSignal = demand.momentumByCard.get(id) || null;
    const inPacksSignal = demand.inPacksByCard.get(id) || null;
    const momentumHit = Boolean(momentumSignal);
    const inPacksHit = Boolean(inPacksSignal);

    let popularityScore = usage?.popularityScore ?? null;
    if (momentumHit) popularityScore = Number.isFinite(popularityScore) ? clamp(popularityScore + 6, 0, 98) : 70;

    const breadth = Number(usage?.usagePositionCount || 0);
    const pro = Number(usage?.proUsagePct);
    const community = Number(usage?.communityUsagePct);
    const realUsageEvidence = (Number.isFinite(pro) ? 1 : 0) + (Number.isFinite(community) ? 1 : 0) + (breadth > 0 ? 1 : 0);
    const demandEvidenceScore = Number.isFinite(popularityScore)
      ? clamp(popularityScore + (momentumHit ? 4 : 0) + Math.min(5, breadth * 1.2), 0, 98)
      : momentumHit ? 72 : null;

    const supplyPressureScore = inPacksHit
      ? clamp(String(card.cardType || '').toLowerCase() === 'special' ? 72 : 60, 0, 100)
      : 0;
    const demandDataConfidence = clamp(
      30 + realUsageEvidence * 12 + (usage?.usageVersionMatched ? 12 : 0) + (momentumHit ? 8 : 0) + (demand.context.inPacksOk ? 5 : 0),
      25,
      94
    );
    const promoMarketScore = buildPromoMarketScore(card, { usage, momentumHit, inPacksHit, supplyPressureScore });

    return {
      ...card,
      ...(usage || {}),
      momentumHit,
      momentumVersionMatched: momentumSignal?.versionMatched ?? null,
      inPacksHit,
      inPacksVersionMatched: inPacksSignal?.versionMatched ?? null,
      supplyPressureScore,
      popularityScore,
      demandEvidenceScore,
      demandDataConfidence,
      demandEvidenceType: usage ? (momentumHit ? 'most-used+momentum' : 'most-used') : momentumHit ? 'momentum' : 'none',
      demandSource: usage || momentumHit || inPacksHit ? 'FUT.GG' : null,
      promoMarketScore,
      promoMarketState: promoMarketState({ ...card, inPacksHit, momentumHit, promoMarketScore })
    };
  });

  const context = { ...(demand.context || {}) };
  const promoRows = out.filter(card => String(card.cardType || '').toLowerCase() === 'special' && card.inPacksHit === true);
  const promoVersionCounts = new Map();
  for (const card of promoRows) {
    const label = String(card.rarityName || card.cardName || card.version || 'Special').trim() || 'Special';
    promoVersionCounts.set(label, (promoVersionCounts.get(label) || 0) + 1);
  }
  context.promoSpecialMatches = promoRows.length;
  context.promoMomentumMatches = promoRows.filter(card => card.momentumHit === true).length;
  context.promoHotMatches = promoRows.filter(card => Number(card.promoMarketScore || 0) >= 68).length;
  context.activePromoVersions = [...promoVersionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([name, cards]) => ({ name, cards }));
  return { cards: out, context };
}

export function attachCachedFutggDemandSignals(cards) {
  if (!cache?.value) {
    return {
      cards: Array.isArray(cards) ? cards : [],
      context: {
        ok: false,
        cachedOnly: true,
        cacheAvailable: false,
        sourceAgeSeconds: null,
        sources: [],
        errors: ['Kein FUT.GG-Nachfragecache vorhanden; Live-Recheck aktualisiert nur Preis/History.']
      }
    };
  }
  const attached = attachDemandFromContext(cards, cache.value);
  attached.context = {
    ...attached.context,
    cachedOnly: true,
    cacheAvailable: true,
    sourceAgeSeconds: Math.max(0, Math.round((Date.now() - cache.at) / 1000))
  };
  return attached;
}

export async function attachFutggDemandSignals(cards) {
  const demand = await getFutggDemandContext(cards);
  return attachDemandFromContext(cards, demand);
}
