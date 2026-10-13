// FUTBIN JSON feed at futbin.org. No proxy, cookies, stealth headers or 403 bypass.
// Undocumented endpoint: availability is not guaranteed. Enforce limits and backoff.
import { futbinCurlFetch } from './futbinCurlTransport.js';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
const BASE = 'https://www.futbin.org/futbin/api/27';
const CATALOG_PLAN = Object.freeze(Array.from({length:11},(_,i)=>82+i).flatMap(r=>[[`${r}-${r}`,1],[`${r}-${r}`,2]]));
const MAX_PRICE_CANDIDATES = 330;
const BATCH_SIZE = 11;
const BASE_COOLDOWN_MS = 10 * 60_000;
const BLOCKED_COOLDOWN_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const validId = value => /^\d{1,15}$/.test(String(value)) && Number(value) > 0;
const validPrice = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 100 && n <= 15_000_000 ? n : null;
};
const wait = delay => new Promise(resolve => setTimeout(resolve, delay));
const sanitizeName = input => {
  const name = String(input || '').replace(/\s+/g, ' ').trim();
  return name.length >= 2 && name.length <= 90 ? name : null;
};
const parseApiRows = json => {
  if (!json || String(json.errorcode) !== '200' || !Array.isArray(json.data)) {
    throw Object.assign(new Error('FUTBIN lieferte keinen bestätigten JSON-Erfolg.'), { code: 'BAD_RESPONSE' });
  }
  return json.data;
};

export function createFutbinDirectFeed({
  fetcher = futbinCurlFetch, clock = Date.now, pause = wait,
  intervalMs = BASE_COOLDOWN_MS, delayMs = 1400,
  catalogPlan = CATALOG_PLAN, maxCandidates = MAX_PRICE_CANDIDATES, cacheFile = null
} = {}) {
  const rows = new Map();
  const state = {
    source: 'FUTBIN_JSON_FC27', sourceUrl: BASE, platform: 'PS',
    active: false, lastError: null, lastErrorCode: null,
    lastSuccessAt: null, lastAttemptAt: null,
    nextRefreshAt: null, currentPhase: 'WAITING', catalogRows: 0,
    discoveredPlayers: 0, pricedPlayers: 0, requests: 0
  };
  let running = null, nextAllowedMs = 0;

  function saveCache() {
    if(!cacheFile) return;
    try {
      mkdirSync(path.dirname(cacheFile),{recursive:true});
      writeFileSync(cacheFile+'.tmp',JSON.stringify({schemaVersion:1,state,rows:[...rows.values()],nextAllowedMs}),'utf8');
      renameSync(cacheFile+'.tmp',cacheFile);
    } catch(e) { state.cacheError=String(e.message); }
  }
  if(cacheFile) {
    try {
      const cache=JSON.parse(readFileSync(cacheFile,'utf8'));
      if(cache.schemaVersion===1 && cache.state?.source==='FUTBIN_JSON_FC27' && cache.state?.platform==='PS' && Array.isArray(cache.rows)) {
        for(const row of cache.rows) if(row.source==='FUTBIN' && row.game==='FC27' && row.platform==='console' && row.salesVerified===false && validPrice(row.coins) && Date.parse(row.capturedAt)<=clock()+60000) rows.set(String(row.playerId),row);
        for(const key of ['lastSuccessAt','lastAttemptAt','lastError','lastErrorCode','catalogRows','discoveredPlayers','pricedPlayers','requests']) if(cache.state[key]!==undefined) state[key]=cache.state[key];
        nextAllowedMs=Math.min(Number(cache.nextAllowedMs)||0,clock()+6*60*60000);
        state.nextRefreshAt=new Date(nextAllowedMs).toISOString();
        state.currentPhase=rows.size?'CACHED':state.lastError?'ERROR':'WAITING';
      }
    } catch(e) { if(e.code!=='ENOENT') state.cacheError=String(e.message); }
  }

  async function getJson(path) {
    if (state.requests > 0 && delayMs > 0) await pause(delayMs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetcher(BASE + path, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'follow'
      });
      state.requests++;
      if (!response.ok) {
        const err = new Error('FUTBIN-JSON HTTP ' + response.status);
        err.status = response.status;
        err.code = 'HTTP_' + response.status;
        const retry = Number(response.headers?.get?.('retry-after'));
        if (Number.isFinite(retry) && retry > 0) err.retryMs = Math.min(6 * 60 * 60_000, retry * 1000);
        throw err;
      }
      const type = response.headers?.get?.('content-type') || '';
      if (!/\bapplication\/json\b/i.test(type)) {
        throw Object.assign(new Error('FUTBIN antwortet ohne JSON.'), { code: 'NON_JSON' });
      }
      return parseApiRows(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refresh() {
    const now = clock();
    if (running || now < nextAllowedMs) return;
    state.active = true;
    state.lastAttemptAt = new Date(now).toISOString();
    state.lastError = null;
    state.lastErrorCode = null;
    state.requests = 0;
    state.catalogRows = 0;
    state.discoveredPlayers = 0;
    state.pricedPlayers = 0;
    state.currentPhase = 'DISCOVERING';

    running = (async () => {
      try {
        const catalogue = new Map();
        const exhausted = new Set();
        for (const [range, page] of catalogPlan) {
          if(exhausted.has(range)) continue;
          const params = new URLSearchParams({
            platform: 'PS', rating: range, sort: 'rating',
            order: 'desc', page: String(page)
          });
          const batch = await getJson('/getFilteredPlayers?' + params);
          state.catalogRows += batch.length;
          for (const player of batch) {
            if (!validId(player?.ID) || !validId(player?.resource_id)) continue;
            if (/non rare|common|bronze|silver|sbc|objective|reward|evolution|loan|unknown|unbekannt/i.test(String(player.rareTypeName || ''))) continue;
            const price = validPrice(player?.ps_LCPrice);
            // Prefer price-bearing candidate cards; independent price call follows.
            if (!price) continue;
            catalogue.set(String(player.ID), {
              playerId: String(player.ID),
              resourceId: Number(player.resource_id),
              name: sanitizeName(player.playername || player.name),
              overall: Number(player.rating) || null,
              cardType: sanitizeName(player.rareTypeName) || 'Unbekannt',
              position: sanitizeName(player.position),
              club: sanitizeName(player.club_name), nation: sanitizeName(player.nation_name),
              league: sanitizeName(player.league_name),
              catalogPrice: price
            });
          }
          if (batch.length < 32) exhausted.add(range);
        }
        const candidates = [...catalogue.values()].sort(
          (a,b) => a.catalogPrice - b.catalogPrice
        ).slice(0, Math.max(1, Math.min(500, maxCandidates)));
        state.discoveredPlayers = candidates.length;
        state.currentPhase = 'PRICING';
        const byId = new Map(candidates.map(c => [c.playerId, c]));
        const verified = new Map();
        for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
          const ids = candidates.slice(i, i + BATCH_SIZE).map(c => c.playerId);
          const params = new URLSearchParams({ player_ids: ids.join(','), platform: 'PS' });
          const prices = await getJson('/getPlayersPrice?' + params);
          const returnedAt = new Date(clock()).toISOString();
          for (const entry of prices) {
            const id = String(entry?.ID || '');
            if (!ids.includes(id)) continue;
            const price = validPrice(entry.LCPrice);
            if (!price) continue;
            const item = byId.get(id);
            if (!validId(entry.Player_Resource) || Number(entry.Player_Resource)!==item?.resourceId) continue;
            verified.set(id, {
              source: 'FUTBIN', game: 'FC27', playerId: id,
              playerName: sanitizeName(entry.Player_Fullname) || item?.name || null,
              resourceId: Number(entry.Player_Resource),
              club: item?.club || null, nation: item?.nation || null,
              league: item?.league || null,
              platform: 'console', coins: price, capturedAt: returnedAt,
              sourceCheckedAt: typeof entry.checked === 'string' ? entry.checked : null,
              rating: item?.overall ?? null, position: item?.position || null,
              cardType: item?.cardType || null,
              evidence: 'futbin-direct-json', priceType: 'lowest_listing',
              salesVerified: false
            });
          }
          state.pricedPlayers = verified.size;
        }
        // Only publish a complete refresh. Never mask a partial outage as a full update.
        if(!verified.size) throw Object.assign(new Error('FUTBIN lieferte keine gültigen Preise.'),{code:'EMPTY_PRICES'});
        rows.clear();
        for (const [key, value] of verified) rows.set(key,value);
        state.lastSuccessAt = new Date(clock()).toISOString();
        state.currentPhase = 'READY';
        nextAllowedMs = clock() + Math.max(BASE_COOLDOWN_MS,intervalMs);
      } catch (error) {
        state.lastError = String(error?.message || error).slice(0,250);
        state.lastErrorCode = error?.code || 'FETCH_FAILED';
        state.currentPhase = 'ERROR';
        const backoff = [401, 403, 429].includes(error?.status)
          ? BLOCKED_COOLDOWN_MS : BASE_COOLDOWN_MS;
        nextAllowedMs = clock() + Math.max(backoff, error?.retryMs || 0);
      } finally {
        state.active = false;
        state.nextRefreshAt = new Date(nextAllowedMs).toISOString();
        running = null;
        saveCache();
      }
    })();
    return running;
  }

  function ensureRefreshed() {
    if (running || clock() < nextAllowedMs) return false;
    void refresh();
    return true;
  }

  return {
    ensureRefreshed, refresh,
    getRows: () => [...rows.values()],
    getStatus: () => ({ ...state, cachedPlayers: rows.size,
      hasSuccessfulFetch: Boolean(state.lastSuccessAt),
      nextRefreshAt: state.nextRefreshAt }),
    waitForCurrent: async () => { if (running) await running; }
  };
}
