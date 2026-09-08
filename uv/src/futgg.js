import {
  GAME_YEAR,
  META_REFRESH_MS,
  PRICE_REFRESH_MS,
  MAX_PAGES,
  META_CONCURRENCY,
  RATING_MIN,
  RATING_MAX
} from './config.js';
import { fetchJson, mapLimit } from './utils.js';

const cardCache = new Map();
const cardInflight = new Map();
let universe = [];
let universeBuiltAt = 0;
const bulkPriceCache = new Map();
const bulkInflight = new Map();

// v2.10.4: preserve explicit FUT.GG tradeability metadata through the shared
// Trader Brain snapshot. A verifier outage must not turn known market Specials
// into fake untradeable cards, but we still fail closed whenever metadata is
// missing/ambiguous. Safe local evidence now accepts (a) plain base cards with
// a healthy FUT.GG R2 live BIN and (b) Specials only when FUT.GG players/v2
// explicitly reports isSbc=false, isObjective=false and isExtinct=false.
// Generation may scan deeper local candidates, but remote verification is still
// capped and stops immediately after the first failed request.
const marketVerificationCache = new Map();
const MARKET_VERIFY_TTL_MS = Math.max(60_000, Math.min(PRICE_REFRESH_MS, 10 * 60_000));
const MARKET_VERIFY_BATCH_SIZE = 50;
const MARKET_VERIFY_MAX_API_CHECKS = 200;

function trueFlag(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function explicitBooleanFlag(value) {
  if (value === true || value === 1 || String(value).toLowerCase() === 'true') return true;
  if (value === false || value === 0 || String(value).toLowerCase() === 'false') return false;
  return null;
}

function hardMarketBlockReason(card = {}) {
  const isSbc = trueFlag(card?.isSbc) || trueFlag(card?.marketVerificationIsSbc);
  const isObjective = trueFlag(card?.isObjective) || trueFlag(card?.marketVerificationIsObjective);
  const isExtinct = trueFlag(card?.isExtinct) || trueFlag(card?.marketVerificationIsExtinct);
  const seasonPass = card?.premiumSeasonPassLevel != null || card?.standardSeasonPassLevel != null || card?.marketVerificationSeasonPass === true;
  if (isSbc) return 'SBC_REWARD';
  if (seasonPass) return 'SEASON_REWARD';
  if (isObjective) return 'OBJECTIVE_REWARD';
  if (isExtinct) return 'EXTINCT_NO_LIVE_BIN';
  return null;
}

function isPlainBaseCard(card = {}) {
  const type = String(card?.cardType || '').trim().toLowerCase();
  return type === 'base rare' || type === 'base common';
}

function isFutggLiveSource(card = {}) {
  const source = String(card?.priceSource || '').toLowerCase();
  return source.includes('fut.gg') || source.includes('futgg');
}

/**
 * Local evidence that is safe enough to use without the optional verifier.
 *
 * Base cards: positive FUT.GG live price + R2 statusCode 0 is sufficient.
 * Special cards: the same live evidence PLUS explicit FUT.GG players/v2
 * metadata with all three market flags present and false. Missing metadata is
 * never interpreted as false, so ambiguous Specials remain fail-closed.
 */
export function classifyLocalFutggMarketEvidence(card = {}) {
  const hardBlock = hardMarketBlockReason(card);
  if (hardBlock) return { marketTradeableConfirmed: false, rejectionReason: hardBlock, source: 'LOCAL_HARD_BLOCK' };

  const price = Number(card?.price);
  if (!Number.isFinite(price) || price <= 0 || price === -1) {
    return { marketTradeableConfirmed: false, rejectionReason: 'NO_CONFIRMED_LIVE_BIN', source: 'LOCAL_EVIDENCE' };
  }

  if (!isFutggLiveSource(card)) {
    return { marketTradeableConfirmed: false, rejectionReason: 'NON_FUTGG_PRICE_SOURCE', source: 'LOCAL_EVIDENCE' };
  }

  if (Number(card?.priceStatusCode) !== 0) {
    return { marketTradeableConfirmed: false, rejectionReason: 'NON_LIVE_OR_AMBIGUOUS_STATUS', source: 'LOCAL_EVIDENCE' };
  }

  if (isPlainBaseCard(card)) {
    return {
      eaId: Number.isFinite(Number(card?.eaId)) ? Number(card.eaId) : null,
      price,
      isSbc: false,
      isObjective: false,
      isExtinct: false,
      seasonPass: false,
      marketTradeableConfirmed: true,
      rejectionReason: null,
      source: 'FUT.GG R2 BASE LIVE'
    };
  }

  const isSbc = explicitBooleanFlag(card?.isSbc);
  const isObjective = explicitBooleanFlag(card?.isObjective);
  const isExtinct = explicitBooleanFlag(card?.isExtinct);
  const metadataSource = String(card?.marketMetadataSource || '').toLowerCase();
  const metadataComplete = isSbc !== null && isObjective !== null && isExtinct !== null;
  const metadataFromFutgg = metadataSource.includes('fut.gg') || metadataSource.includes('futgg');

  if (!metadataComplete || !metadataFromFutgg) {
    return {
      marketTradeableConfirmed: false,
      rejectionReason: 'NEEDS_REMOTE_VERIFICATION',
      source: 'LOCAL_EVIDENCE'
    };
  }

  // hardMarketBlockReason already rejected every true/reward/extinct flag.
  return {
    eaId: Number.isFinite(Number(card?.eaId)) ? Number(card.eaId) : null,
    price,
    isSbc: false,
    isObjective: false,
    isExtinct: false,
    seasonPass: false,
    marketTradeableConfirmed: true,
    rejectionReason: null,
    source: 'FUT.GG METADATA + R2 SPECIAL LIVE'
  };
}

export function classifyFutggMarketRow(row = {}) {
  const eaId = Number(row?.eaId);
  const rawPrice = Number(row?.price);
  const price = Number.isFinite(rawPrice) && rawPrice > 0 && rawPrice !== -1 ? rawPrice : null;
  const isSbc = trueFlag(row?.isSbc);
  const isObjective = trueFlag(row?.isObjective);
  const isExtinct = trueFlag(row?.isExtinct);
  const seasonPass = row?.premiumSeasonPassLevel != null || row?.standardSeasonPassLevel != null;

  let rejectionReason = null;
  if (isSbc) rejectionReason = 'SBC_REWARD';
  else if (isObjective && seasonPass) rejectionReason = 'SEASON_REWARD';
  else if (isObjective) rejectionReason = 'OBJECTIVE_REWARD';
  else if (isExtinct) rejectionReason = 'EXTINCT_NO_LIVE_BIN';
  else if (price == null) rejectionReason = 'NO_CONFIRMED_LIVE_BIN';

  return {
    eaId: Number.isFinite(eaId) ? eaId : null,
    price,
    isSbc,
    isObjective,
    isExtinct,
    seasonPass,
    premiumSeasonPassLevel: row?.premiumSeasonPassLevel ?? null,
    standardSeasonPassLevel: row?.standardSeasonPassLevel ?? null,
    marketTradeableConfirmed: rejectionReason == null,
    rejectionReason
  };
}

async function fetchFutggMarketVerificationBatch(ids, platform = 'console') {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))];
  if (!unique.length) return [];
  const params = unique.join(',');
  const platformPart = platform === 'pc' ? '&platform=pc' : '';
  const url = `https://www.fut.gg/api/fut/player-prices/${GAME_YEAR}/?ids=${encodeURIComponent(params)}${platformPart}`;
  const json = await fetchJson(url);
  if (!Array.isArray(json?.data)) throw new Error('Unexpected FUT.GG player-prices verification format');
  return json.data;
}

/**
 * Confirm that candidates have transferable market evidence.
 *
 * v2.10.4 uses three layers:
 * 1) fresh successful verification cache,
 * 2) safe local FUT.GG metadata + R2 evidence for known market cards,
 * 3) player-prices verification only for ambiguous/Special cards.
 *
 * On the first verifier outage we stop making requests. Unverified ambiguous
 * cards stay blocked; we never fail-open Specials or reward-like cards.
 */
export async function confirmTradeableMarketCards(cards = [], platform = 'console', options = {}) {
  const input = Array.isArray(cards) ? cards : [];
  const minConfirmed = Math.max(0, Number(options.minConfirmed || 0));
  const maxChecks = Math.max(MARKET_VERIFY_BATCH_SIZE, Number(options.maxChecks || input.length || MARKET_VERIFY_BATCH_SIZE));
  const maxApiChecks = Math.max(
    MARKET_VERIFY_BATCH_SIZE,
    Math.min(maxChecks, Number(options.maxApiChecks || MARKET_VERIFY_MAX_API_CHECKS))
  );
  const normalizedPlatform = platform === 'pc' ? 'pc' : 'console';
  const now = Date.now();
  const ordered = [];
  const seen = new Set();
  for (const card of input) {
    const id = Number(card?.eaId);
    if (!Number.isFinite(id) || seen.has(String(id))) continue;
    seen.add(String(id));
    ordered.push(card);
    if (ordered.length >= maxChecks) break;
  }

  const confirmedById = new Map();
  const rejectedById = new Map();
  const needsRemoteVerification = [];
  let checked = 0;
  let cacheHits = 0;
  let localEvidenceAccepted = 0;
  let localMetadataSpecialAccepted = 0;
  let apiCalls = 0;
  let failedBatches = 0;
  let verificationSourceDown = false;
  let verificationSourceError = null;

  const consumeRow = (id, rawRow) => {
    const classified = classifyFutggMarketRow(rawRow || { eaId: id });
    const key = `${normalizedPlatform}:${id}`;
    marketVerificationCache.set(key, { savedAt: Date.now(), raw: rawRow || null, classified });
    if (classified.marketTradeableConfirmed) confirmedById.set(String(id), { ...classified, source: 'FUT.GG player-prices' });
    else rejectedById.set(String(id), classified.rejectionReason || 'UNVERIFIED');
  };

  // Layer 1 + 2: cached verifier evidence and safe local base-market evidence.
  for (const card of ordered) {
    const id = Number(card.eaId);
    const key = `${normalizedPlatform}:${id}`;
    const cached = marketVerificationCache.get(key);
    if (cached && now - cached.savedAt <= MARKET_VERIFY_TTL_MS) {
      cacheHits += 1;
      if (cached.classified?.marketTradeableConfirmed) {
        confirmedById.set(String(id), { ...cached.classified, source: 'FUT.GG player-prices cache' });
        if (minConfirmed > 0 && confirmedById.size >= minConfirmed) break;
      } else {
        rejectedById.set(String(id), cached.classified?.rejectionReason || 'UNVERIFIED');
      }
      continue;
    }

    const local = classifyLocalFutggMarketEvidence(card);
    if (local.marketTradeableConfirmed) {
      confirmedById.set(String(id), local);
      localEvidenceAccepted += 1;
      if (local.source === 'FUT.GG METADATA + R2 SPECIAL LIVE') localMetadataSpecialAccepted += 1;
      if (minConfirmed > 0 && confirmedById.size >= minConfirmed) break;
      continue;
    }

    if (local.rejectionReason !== 'NEEDS_REMOTE_VERIFICATION') {
      rejectedById.set(String(id), local.rejectionReason || 'UNVERIFIED');
      continue;
    }

    needsRemoteVerification.push(card);
  }

  // Layer 3: only ambiguous/Special cards hit player-prices. Cap healthy-source
  // work, and after the very first request failure stop immediately.
  let cursor = 0;
  while (cursor < needsRemoteVerification.length && checked < maxApiChecks) {
    // If we already have the requested safety pool, still verify one priority
    // batch of ambiguous cards so strong Specials can enter the optimizer.
    if (confirmedById.size >= minConfirmed && apiCalls >= 1) break;

    const remainingApiBudget = maxApiChecks - checked;
    const batchCards = needsRemoteVerification.slice(
      cursor,
      cursor + Math.min(MARKET_VERIFY_BATCH_SIZE, remainingApiBudget)
    );
    cursor += batchCards.length;
    if (!batchCards.length) break;

    checked += batchCards.length;
    apiCalls += 1;
    try {
      const rows = await fetchFutggMarketVerificationBatch(batchCards.map(c => c.eaId), normalizedPlatform);
      const rowById = new Map(rows.map(row => [String(row?.eaId), row]));
      for (const card of batchCards) {
        const id = Number(card.eaId);
        const raw = rowById.get(String(id));
        if (raw) consumeRow(id, raw);
        else rejectedById.set(String(id), 'NO_VERIFICATION_ROW');
      }
    } catch (error) {
      failedBatches += 1;
      verificationSourceDown = true;
      verificationSourceError = String(error?.message || error || 'FUT.GG verification request failed');
      for (const card of batchCards) rejectedById.set(String(card.eaId), 'VERIFICATION SOURCE DOWN');
      break;
    }
  }

  if (verificationSourceDown) {
    // Do not make another request. Every still-ambiguous card stays fail-closed.
    for (let i = cursor; i < needsRemoteVerification.length; i++) {
      const id = String(needsRemoteVerification[i].eaId);
      if (!confirmedById.has(id) && !rejectedById.has(id)) rejectedById.set(id, 'VERIFICATION SOURCE DOWN');
    }
  } else {
    // Healthy source but API work is intentionally capped. Anything not checked
    // remains blocked rather than silently entering the list.
    for (let i = cursor; i < needsRemoteVerification.length; i++) {
      const id = String(needsRemoteVerification[i].eaId);
      if (!confirmedById.has(id) && !rejectedById.has(id)) rejectedById.set(id, 'REMOTE_VERIFICATION_NOT_NEEDED_OR_CAPPED');
    }
  }

  const out = [];
  for (const card of ordered) {
    const id = String(card.eaId);
    const verified = confirmedById.get(id);
    if (!verified) continue;
    const localFallback = verified.source === 'FUT.GG R2 BASE LIVE';
    out.push({
      ...card,
      price: verified.price,
      priceSource: localFallback ? card.priceSource : 'FUT.GG player-prices VERIFIED MARKET',
      marketTradeableConfirmed: true,
      marketVerificationSource: verified.source || 'FUT.GG player-prices',
      marketVerificationAt: new Date().toISOString(),
      marketVerificationFallback: localFallback,
      marketVerificationIsSbc: false,
      marketVerificationIsObjective: false,
      marketVerificationIsExtinct: false
    });
  }

  const rejectedReasons = {};
  for (const reason of rejectedById.values()) rejectedReasons[reason] = (rejectedReasons[reason] || 0) + 1;
  return {
    cards: out,
    diagnostics: {
      inputCandidates: input.length,
      priorityCandidates: ordered.length,
      confirmedTradeable: out.length,
      rejected: rejectedById.size,
      rejectedReasons,
      cacheHits,
      localEvidenceAccepted,
      localMetadataSpecialAccepted,
      ambiguousCandidates: needsRemoteVerification.length,
      checkedByApi: checked,
      maxApiChecks,
      apiCalls,
      failedBatches,
      verificationSourceDown,
      verificationSourceStatus: verificationSourceDown ? 'DOWN' : 'UP_OR_NOT_REQUIRED',
      verificationSourceError,
      stoppedAfterFirstFailure: verificationSourceDown && apiCalls === 1,
      safeFallbackUsed: localEvidenceAccepted > 0,
      minConfirmed,
      maxChecks,
      failClosed: true,
      source: verificationSourceDown
        ? 'FUT.GG metadata+R2 safe fallback + player-prices DOWN'
        : 'FUT.GG metadata+R2 safe evidence + player-prices verifier'
    }
  };
}

function classifyCard(card) {
  const rarity = String(card.rarityName || '').toLowerCase();
  const group = String(card.rarityGroupName || '').toLowerCase();
  if (rarity === 'rare' || group === 'rare') return 'Base Rare';
  if (rarity.includes('common') || group.includes('common') || rarity === 'non-rare') return 'Base Common';
  return 'Special';
}

async function collectAllCardsForRating(rating, force = false) {
  const cached = cardCache.get(rating);
  if (!force && cached && Date.now() - cached.savedAt < META_REFRESH_MS) return cached.data;
  if (cardInflight.has(rating)) return cardInflight.get(rating);

  const promise = (async () => {
    const cards = [];
    const seen = new Set();
    let pagesRead = 0;
    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const pagePart = pageNumber === 1 ? '' : `&page=${pageNumber}`;
      const url = `https://www.fut.gg/api/fut/players/v2/${GAME_YEAR}/?overall__gte=${rating}&overall__lte=${rating}&sorts=current_price${pagePart}`;
      let json;
      try { json = await fetchJson(url); }
      catch (error) {
        if (pageNumber > 1 && error?.status === 404) break;
        throw error;
      }
      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) break;
      let added = 0;
      for (const p of rows) {
        const key = p.eaId ?? p.id ?? p.url;
        if (key == null || seen.has(String(key))) continue;
        seen.add(String(key));
        added++;
        const card = {
          id: Number.isFinite(p.id) ? p.id : null,
          eaId: Number.isFinite(p.eaId) ? p.eaId : null,
          itemId: Number.isFinite(p.itemId) ? p.itemId : null,
          overall: Number.isFinite(p.overall) ? p.overall : rating,
          name: p.commonName || p.cardName || [p.firstName, p.lastName].filter(Boolean).join(' ') || null,
          cardName: p.cardName ?? null,
          rarityName: p.rarityName ?? null,
          rarityGroupName: p.rarityGroupName ?? null,
          position: p.position ?? null,
          club: p.club?.name ?? p.uniqueClub?.name ?? null,
          nation: p.nation?.name ?? null,
          league: p.league?.name ?? null,
          url: p.url ? new URL(p.url, 'https://www.fut.gg').href : null,
          slug: p.slug ?? null,
          image: p.image ?? p.imageUrl ?? p.cardImage ?? p.playerImage ?? null,
          isSbc: p.isSbc ?? null,
          isObjective: p.isObjective ?? null,
          isExtinct: p.isExtinct ?? null,
          premiumSeasonPassLevel: p.premiumSeasonPassLevel ?? null,
          standardSeasonPassLevel: p.standardSeasonPassLevel ?? null,
          marketMetadataSource: 'FUT.GG players/v2'
        };
        card.cardType = classifyCard(card);
        cards.push(card);
      }
      pagesRead++;
      if (added === 0) break;
    }
    const data = { rating, pagesRead, cards };
    cardCache.set(rating, { savedAt: Date.now(), data });
    return data;
  })();

  cardInflight.set(rating, promise);
  try { return await promise; }
  finally { cardInflight.delete(rating); }
}

export async function ensureUniverse(force = false) {
  if (!force && universe.length && Date.now() - universeBuiltAt < META_REFRESH_MS) return universe;
  const ratings = Array.from({ length: RATING_MAX - RATING_MIN + 1 }, (_, i) => RATING_MIN + i);
  const results = await mapLimit(ratings, META_CONCURRENCY, rating => collectAllCardsForRating(rating, force));
  const all = [];
  for (const result of results) if (result?.cards) all.push(...result.cards);
  const seen = new Set();
  universe = all.filter(card => {
    if (!Number.isFinite(card.eaId)) return false;
    const key = String(card.eaId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  universeBuiltAt = Date.now();
  return universe;
}

function buildIds(priceData) {
  if (!Number.isFinite(priceData?.id0) || !Array.isArray(priceData?.d)) throw new Error('Unexpected FUT.GG bulk-price format');
  const ids = [priceData.id0];
  let current = priceData.id0;
  for (const delta of priceData.d) {
    if (!Number.isFinite(delta)) continue;
    current += delta;
    ids.push(current);
  }
  return ids;
}

export async function loadBulkPrices(platform = 'console', force = false) {
  platform = platform === 'pc' ? 'pc' : 'console';
  const cached = bulkPriceCache.get(platform);
  if (!force && cached && Date.now() - cached.savedAt < PRICE_REFRESH_MS) return cached;
  if (bulkInflight.has(platform)) return bulkInflight.get(platform);

  const promise = (async () => {
    const manifest = await fetchJson(`https://r2.fut.gg/${GAME_YEAR}/manifest.json`);
    const manifestKey = platform === 'pc' ? 'player-prices-pc' : 'player-prices-ps5';
    const fileKey = platform === 'pc' ? 'player-prices-pc' : 'player-prices-ps5';
    const hash = manifest[manifestKey];
    if (!hash) throw new Error(`${manifestKey} missing from FUT.GG manifest`);
    const url = `https://r2.fut.gg/${GAME_YEAR}/${fileKey}.v1.${hash}.json`;
    const data = await fetchJson(url);
    if (!Array.isArray(data?.p)) throw new Error('FUT.GG bulk-price array missing');
    const ids = buildIds(data);
    if (ids.length !== data.p.length) throw new Error(`Price mapping length mismatch: ids=${ids.length}, prices=${data.p.length}`);
    const map = new Map();
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], {
        price: Number.isFinite(data.p[i]) && data.p[i] > 0 ? data.p[i] : null,
        statusCode: Array.isArray(data.s) ? data.s[i] ?? null : null
      });
    }
    const out = { savedAt: Date.now(), map, totalValues: data.p.length, sourceUrl: url, platform };
    bulkPriceCache.set(platform, out);
    return out;
  })();
  bulkInflight.set(platform, promise);
  try { return await promise; }
  finally { bulkInflight.delete(platform); }
}

export function currentPricedCards(cards, bulk) {
  const rows = [];
  for (const card of cards) {
    const priceRow = bulk.map.get(card.eaId);
    if (!priceRow || !Number.isFinite(priceRow.price)) continue;
    rows.push({ ...card, price: priceRow.price, priceStatusCode: priceRow.statusCode, priceSource: 'FUT.GG' });
  }
  return rows;
}

export async function getLiveFutggCards(platform = 'console') {
  const [cards, bulk] = await Promise.all([ensureUniverse(false), loadBulkPrices(platform, false)]);
  return { cards: currentPricedCards(cards, bulk), sourceUrl: bulk.sourceUrl, updatedAt: new Date(bulk.savedAt).toISOString() };
}
