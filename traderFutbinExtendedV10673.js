const state = {
  version: '10.67.5',
  configured: false,
  status: 'IDLE',
  provider: 'Parse FUTBIN API',
  sourcePolicy: 'PUBLIC_OR_AUTHORIZED_STRUCTURED_DATA_ONLY',
  calls: 0,
  successes: 0,
  failures: 0,
  gamesObserved: false,
  salesHistoryObserved: false,
  popularRankObserved: false,
  observedSalesPerDayObserved: false,
  lastObservedAt: null,
  lastCallAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  sameBaseEndpointMissing: false,
  autoProvision: true,
  provisionStatus: 'IDLE',
  provisionTaskId: null,
  providerBaseUrl: null,
  providerEndpoint: null,
  providerMethod: null
};

const cache = new Map();
let discoveredProvider = null;
let discoveryAt = 0;
let discoveryPromise = null;
let provisionPromise = null;
let lastProvisionAttemptAt = 0;

const CACHE_MS = 60 * 60_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const PROVISION_COOLDOWN_MS = 12 * 60 * 60_000;
const PARSE_ROOT = 'https://api.parse.bot';
const ENDPOINT = 'get_trading_evidence_fc26';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSales(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, 100).map(row => {
    if (!row || typeof row !== 'object') return null;
    return {
      date: row.date ?? row.sold_at ?? row.soldAt ?? row.time ?? row.timestamp ?? null,
      listedFor: finite(row.listed_for ?? row.listedFor ?? row.list_price ?? row.listPrice),
      soldFor: finite(row.sold_for ?? row.soldFor ?? row.sale_price ?? row.salePrice ?? row.price),
      eaTax: finite(row.ea_tax ?? row.eaTax ?? row.tax),
      netPrice: finite(row.net_price ?? row.netPrice),
      status: String(row.status ?? row.state ?? '').trim() || null
    };
  }).filter(Boolean);
}

function observedSalesPerDay(sales) {
  const now = Date.now();
  let count = 0;
  let timestamped = 0;
  for (const sale of sales) {
    const t = sale?.date ? new Date(sale.date).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    timestamped += 1;
    if (now - t >= 0 && now - t <= 24 * 60 * 60_000) count += 1;
  }
  return timestamped ? count : null;
}

function parseEvidence(payload) {
  const root = payload?.data && typeof payload.data === 'object' ? payload.data : (payload || {});
  const games = finite(root.games ?? root.pgp_games ?? root.total_games ?? root.games_total);
  const gamesConsole = finite(root.games_console ?? root.console_games ?? root.games_ps ?? root.ps_games ?? games);
  const gamesPc = finite(root.games_pc ?? root.pc_games);
  const popularRank = finite(root.popular_rank ?? root.popularity_rank ?? root.popular_position ?? root.rank);
  const popularityCount = finite(root.popularity_count ?? root.popular_count ?? root.likes ?? root.votes);
  const sales = normalizeSales(root.sales_history ?? root.salesHistory ?? root.player_sales_history ?? root.sales);
  const salesPerDay = observedSalesPerDay(sales);

  const evidence = {
    playerId: String(root.player_id ?? root.playerId ?? root.id ?? ''),
    games,
    gamesConsole,
    gamesPc,
    popularRank,
    popularityCount,
    salesHistory: sales,
    soldSampleCount: sales.length,
    observedSalesPerDay: salesPerDay,
    gamesAvailable: Number.isFinite(games) || Number.isFinite(gamesConsole) || Number.isFinite(gamesPc),
    salesHistoryAvailable: sales.length > 0,
    popularRankAvailable: Number.isFinite(popularRank),
    observedAt: new Date().toISOString(),
    source: String(root.source || 'FUTBIN_VIA_PARSE')
  };

  if (evidence.gamesAvailable) state.gamesObserved = true;
  if (evidence.salesHistoryAvailable) state.salesHistoryObserved = true;
  if (evidence.popularRankAvailable) state.popularRankObserved = true;
  if (Number.isFinite(salesPerDay)) state.observedSalesPerDayObserved = true;
  if (evidence.gamesAvailable || evidence.salesHistoryAvailable || evidence.popularRankAvailable) {
    state.lastObservedAt = evidence.observedAt;
  }
  return evidence;
}

async function requestJson(url, { apiKey, method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || 20000)));
  try {
    const headers = {
      accept: 'application/json',
      'X-API-Key': apiKey,
      'user-agent': 'FC-Trader-Brain/10.67.5'
    };
    const opts = { method, signal: controller.signal, headers };
    if (body != null) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const response = await fetch(url, opts);
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function scraperIdFromBase(baseUrl) {
  const match = String(baseUrl || '').match(/\/scraper\/([^/]+)/i);
  return match ? match[1] : null;
}

function providerFromTask(task) {
  const generated = task?.generated_api || null;
  const endpoints = Array.isArray(generated?.endpoints) ? generated.endpoints : [];
  const endpoint = endpoints.find(item => String(item?.endpoint_name || '').toLowerCase() === ENDPOINT);
  if (!generated?.execution_base_url || !endpoint) return null;
  return {
    taskId: String(task?.id || ''),
    scraperId: String(generated?.scraper_id || task?.result_scraper_id || ''),
    baseUrl: String(generated.execution_base_url).replace(/\/+$/, ''),
    endpoint: String(endpoint.endpoint_name),
    method: String(endpoint.method || 'POST').toUpperCase()
  };
}

async function listTasks(apiKey, timeoutMs) {
  return requestJson(`${PARSE_ROOT}/dispatch/tasks?limit=100`, { apiKey, timeoutMs });
}

async function discoverProvider(apiKey, timeoutMs, force = false) {
  const now = Date.now();
  if (!force && discoveredProvider) return discoveredProvider;
  if (!force && discoveryAt && now - discoveryAt < DISCOVERY_TTL_MS) return null;
  if (discoveryPromise) return discoveryPromise;

  discoveryPromise = (async () => {
    discoveryAt = Date.now();
    try {
      const payload = await listTasks(apiKey, timeoutMs);
      const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
      for (const task of tasks) {
        const provider = providerFromTask(task);
        if (!provider) continue;
        discoveredProvider = provider;
        state.providerBaseUrl = provider.baseUrl;
        state.providerEndpoint = provider.endpoint;
        state.providerMethod = provider.method;
        state.provisionStatus = 'PROVIDER_DISCOVERED';
        return provider;
      }
      return null;
    } finally {
      discoveryPromise = null;
    }
  })();

  return discoveryPromise;
}

async function pollRevision(taskId, apiKey, timeoutMs) {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const task = await requestJson(`${PARSE_ROOT}/dispatch/tasks/${encodeURIComponent(taskId)}`, { apiKey, timeoutMs });
    const provider = providerFromTask(task);
    if (provider) return provider;
    const status = String(task?.status || '').toLowerCase();
    if (status === 'needs_input') throw new Error('PARSE_REVISION_NEEDS_INPUT');
    if (status === 'failed') throw new Error(`PARSE_REVISION_FAILED: ${String(task?.error || 'unknown')}`);
  }
  throw new Error('PARSE_REVISION_TIMEOUT');
}

async function provisionProvider({ apiKey, parseBaseUrl, playerId, timeoutMs }) {
  if (provisionPromise) return provisionPromise;
  const now = Date.now();
  if (lastProvisionAttemptAt && now - lastProvisionAttemptAt < PROVISION_COOLDOWN_MS) return null;
  lastProvisionAttemptAt = now;

  provisionPromise = (async () => {
    state.provisionStatus = 'PROVISIONING';
    try {
      const existing = await discoverProvider(apiKey, timeoutMs, true);
      if (existing) return existing;

      const payload = await listTasks(apiKey, timeoutMs);
      const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
      const baseScraperId = scraperIdFromBase(parseBaseUrl);
      const baseTask = tasks.find(task => {
        const id = String(task?.generated_api?.scraper_id || task?.result_scraper_id || '');
        return baseScraperId && id === baseScraperId;
      });

      const revision =
        'FC_TRADER_BRAIN_FUTBIN_EXTENDED_V1. Add endpoint get_trading_evidence_fc26 with input player_id for exact EA FC 26 FUTBIN card/version. ' +
        'Use only publicly accessible FUTBIN pages. Return real PGP Games, real public Player Sales History rows, and exact-card Popular Players rank when present. ' +
        'Return player_id, games, games_console, games_pc, popular_rank, popularity_count, sales_history[]. ' +
        'Missing evidence must be null or []. Never infer sales from price-history points. Never invent Games, rank, dates, or prices. ' +
        'Do not log in and do not bypass CAPTCHA, paywalls, anti-bot protections, rate limits, or access controls.';

      let created;
      if (baseTask?.id) {
        created = await requestJson(`${PARSE_ROOT}/dispatch/tasks/${encodeURIComponent(String(baseTask.id))}/revise`, {
          apiKey,
          method: 'POST',
          body: { revision },
          timeoutMs
        });
      } else {
        const seed = String(playerId || '').replace(/\D/g, '') || '2560';
        created = await requestJson(`${PARSE_ROOT}/dispatch`, {
          apiKey,
          method: 'POST',
          body: {
            url: `https://www.futbin.com/26/pgp?pid=${seed}`,
            task: revision,
            force_new: true
          },
          timeoutMs
        });
      }

      const taskId = String(created?.task_id || '');
      if (!taskId) throw new Error('PARSE_REVISION_NO_TASK_ID');
      state.provisionTaskId = taskId;
      const provider = await pollRevision(taskId, apiKey, timeoutMs);
      discoveredProvider = provider;
      discoveryAt = Date.now();
      state.providerBaseUrl = provider.baseUrl;
      state.providerEndpoint = provider.endpoint;
      state.providerMethod = provider.method;
      state.provisionStatus = 'ACTIVE';
      return provider;
    } catch (error) {
      state.provisionStatus = 'FAILED';
      state.lastError = String(error?.message || error);
      return null;
    } finally {
      provisionPromise = null;
    }
  })();

  return provisionPromise;
}

function scheduleProvision(opts) {
  if (provisionPromise) return;
  void provisionProvider(opts);
}

async function callProvider(provider, playerId, apiKey, timeoutMs) {
  const base = `${String(provider.baseUrl).replace(/\/+$/, '')}/${encodeURIComponent(provider.endpoint)}`;
  if (String(provider.method || 'POST').toUpperCase() === 'GET') {
    return requestJson(`${base}?player_id=${encodeURIComponent(String(playerId))}`, { apiKey, timeoutMs });
  }
  return requestJson(base, {
    apiKey,
    method: 'POST',
    body: { player_id: String(playerId) },
    timeoutMs
  });
}

async function trySameBase(parseBaseUrl, playerId, apiKey, timeoutMs) {
  const base = `${String(parseBaseUrl || '').replace(/\/+$/, '')}/${ENDPOINT}`;
  try {
    return await requestJson(`${base}?player_id=${encodeURIComponent(String(playerId))}`, { apiKey, timeoutMs });
  } catch (error) {
    if (error?.status === 404) throw error;
    if (![400, 405, 422].includes(Number(error?.status))) throw error;
  }
  return requestJson(base, {
    apiKey,
    method: 'POST',
    body: { player_id: String(playerId) },
    timeoutMs
  });
}

export async function enrichTraderFutbinMatchV10673({
  apiKey,
  parseBaseUrl,
  gameYear = '26',
  playerId,
  timeoutMs = 20000
} = {}) {
  state.configured = Boolean(apiKey);
  state.autoProvision = true;
  if (!apiKey || String(gameYear) !== '26' || !playerId) return null;

  const key = String(playerId);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  state.calls += 1;
  state.lastCallAt = new Date().toISOString();
  state.status = 'FETCHING';

  try {
    let payload = null;

    if (!state.sameBaseEndpointMissing) {
      try {
        payload = await trySameBase(parseBaseUrl, playerId, apiKey, timeoutMs);
      } catch (error) {
        if (error?.status === 404) {
          state.sameBaseEndpointMissing = true;
        } else {
          throw error;
        }
      }
    }

    if (!payload) {
      const provider = discoveredProvider || await discoverProvider(apiKey, timeoutMs).catch(() => null);
      if (provider) {
        payload = await callProvider(provider, playerId, apiKey, timeoutMs);
      } else {
        state.status = 'PROVISIONING';
        scheduleProvision({ apiKey, parseBaseUrl, playerId, timeoutMs });
        return null;
      }
    }

    const evidence = parseEvidence(payload);
    cache.set(key, { at: Date.now(), value: evidence });
    state.successes += 1;
    state.status = 'ACTIVE';
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    return evidence;
  } catch (error) {
    state.failures += 1;
    state.lastFailureAt = new Date().toISOString();
    state.lastError = String(error?.message || error);

    if (error?.status === 404) {
      state.status = 'PROVISIONING';
      discoveredProvider = null;
      discoveryAt = 0;
      scheduleProvision({ apiKey, parseBaseUrl, playerId, timeoutMs });
    } else if (error?.status === 429) {
      state.status = 'RATE_LIMITED';
    } else if (/captcha|datadome|anti.?bot|blocked/i.test(state.lastError)) {
      state.status = 'SOURCE_BLOCKED_NO_BYPASS';
    } else {
      state.status = 'ERROR';
    }
    return null;
  }
}

export function traderFutbinExtendedStatusV10673() {
  return {
    ...state,
    providerActive: Boolean(discoveredProvider?.baseUrl),
    endpoint: ENDPOINT,
    cacheEntries: cache.size
  };
}
