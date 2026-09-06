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
          image: p.image ?? p.imageUrl ?? p.cardImage ?? p.playerImage ?? null
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
