import { parseFutbinPlayerHtml, parseFutbinSearchHtml } from "../../futbinMarketV1064.js";

const SOURCE = "FUTBIN_BRAVE_PUBLIC_FC27";
const cache = new Map();
const state = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  blockedUntil: 0,
  calls: 0,
  cacheHits: 0
};

function truthy(v) {
  return ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());
}

function numberEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function isFutbinBraveEnabled() {
  return truthy(process.env.FUTBIN_BRAVE_ENABLED)
    && truthy(process.env.FUTBIN_BRAVE_ACTIVATION_CONFIRMED);
}

function config(options = {}) {
  return {
    port: Number(options.port || numberEnv("FUTBIN_BRAVE_PORT", 9225, 1024, 65535)),
    cacheMs: Number(options.cacheMs || numberEnv("FUTBIN_BRAVE_CACHE_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000)),
    spacingMs: Number(options.spacingMs || numberEnv("FUTBIN_BRAVE_SPACING_MS", 2500, 1000, 60_000)),
    maxCards: Number(options.maxCards || numberEnv("FUTBIN_BRAVE_MAX_CARDS", 5, 1, 20)),
    pageWaitMs: Number(options.pageWaitMs || numberEnv("FUTBIN_BRAVE_PAGE_WAIT_MS", 4500, 1000, 20_000)),
    blockBackoffMs: Number(options.blockBackoffMs || numberEnv("FUTBIN_BRAVE_BLOCK_BACKOFF_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000))
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSlug(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function cacheKey(card, platform) {
  return [platform, card?.eaId || "", card?.futbinId || "", card?.name || "", card?.overall || card?.rating || ""].join("|");
}

function blockText(text) {
  return /verify you are human|access denied|forbidden|temporarily blocked|too many requests/i.test(String(text || ""));
}

async function getTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  if (!response.ok) throw new Error(`BRAVE_DEBUG_HTTP_${response.status}`);
  return await response.json();
}
async function openSession(port) {
  const targets = await getTargets(port);
  const target = targets.find(x => x.type === "page" && /futbin\.com\/27\//.test(x.url))
    || targets.find(x => x.type === "page" && /^https?:\/\//.test(x.url));
  if (!target?.webSocketDebuggerUrl) throw new Error("BRAVE_FUTBIN_PAGE_NOT_FOUND");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();

  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "CDP_ERROR"));
    else waiter.resolve(message.result);
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("BRAVE_DEBUG_WEBSOCKET_FAILED"));
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await call("Page.enable");
  await call("Runtime.enable");
  async function evaluate(expression) {
    const out = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return out?.result?.value;
  }

  async function navigate(url, waitMs) {
    await call("Page.navigate", { url });
    await sleep(waitMs);
    const meta = await evaluate('({title:document.title,url:location.href,text:(document.body?.innerText||"").slice(0,5000)})');
    if (blockText(meta?.text)) {
      const error = new Error("FUTBIN_BROWSER_BLOCK_PAGE");
      error.code = "BLOCK_PAGE";
      throw error;
    }
    return meta;
  }

  return {
    navigate,
    evaluate,
    html: () => evaluate("document.documentElement.outerHTML"),
    close: () => {
      try { ws.close(); } catch {}
    }
  };
}

function choosePrice(parsed, platform) {
  const value = platform === "pc"
    ? Number(parsed?.pricePc ?? parsed?.pricePC)
    : Number(parsed?.pricePlayStation);
  return Number.isFinite(value) && value > 0 ? value : null;
}
async function resolvePlayerUrl(session, card, cfg) {
  if (card?.futbinId) {
    const slug = normalizeSlug(card?.slug || card?.name || "");
    return `https://www.futbin.com/27/player/${encodeURIComponent(String(card.futbinId))}${slug ? `/${slug}` : ""}`;
  }

  const name = String(card?.name || "").trim();
  if (!name) return null;
  await session.navigate(`https://www.futbin.com/27/players?search=${encodeURIComponent(name)}`, cfg.pageWaitMs);
  const html = await session.html();
  const candidates = parseFutbinSearchHtml(html, card, "27");
  const best = candidates?.[0];
  if (!best?.href) return null;
  return /^https?:\/\//i.test(best.href) ? best.href : `https://www.futbin.com${best.href}`;
}

function resultFromParsed(card, parsed, url, platform) {
  const price = choosePrice(parsed, platform);
  const urlId = String(url || "").match(/\/27\/player\/(\d+)/)?.[1] || null;
  return {
    ok: Boolean(price),
    price,
    id: parsed?.futbinId ?? card?.futbinId ?? (urlId ? Number(urlId) : null),
    name: parsed?.name ?? card?.name ?? null,
    source: SOURCE,
    checked: parsed?.priceUpdatedAtConsole ?? parsed?.priceUpdatedAtPc ?? null,
    retrievedAt: new Date().toISOString(),
    url,
    reason: price ? null : "NO_VISIBLE_PRICE"
  };
}

export function getFutbinBraveStatus() {
  return {
    enabled: isFutbinBraveEnabled(),
    source: SOURCE,
    localDebugOnly: true,
    readsCookies: false,
    solvesChallenges: false,
    bypasses403or429: false,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorAt: state.lastErrorAt,
    lastError: state.lastError,
    blockedUntil: state.blockedUntil > Date.now() ? new Date(state.blockedUntil).toISOString() : null,
    calls: state.calls,
    cacheHits: state.cacheHits
  };
}

export async function getFutbinBraveCards(cards = [], platform = "console", options = {}) {
  const cfg = config(options);
  const results = new Map();
  const year = Number(options.gameYear || 27);

  if (year !== 27) return { ok: false, year, results, reason: "FC27_ONLY" };
  if (!options.force && !isFutbinBraveEnabled()) {
    return { ok: false, year, results, reason: "FUTBIN_BRAVE_DISABLED" };
  }
  if (state.blockedUntil > Date.now()) {
    return { ok: false, year, results, reason: "FUTBIN_BRAVE_BLOCK_BACKOFF" };
  }

  let session;
  try {
    session = await openSession(cfg.port);
    for (const card of cards.slice(0, cfg.maxCards)) {
      const key = cacheKey(card, platform);
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < cfg.cacheMs) {
        state.cacheHits += 1;
        results.set(String(card.eaId), cached.value);
        continue;
      }
      const url = await resolvePlayerUrl(session, card, cfg);
      if (!url) {
        results.set(String(card.eaId), {
          ok: false, price: null, id: card?.futbinId ?? null,
          name: card?.name ?? null, source: SOURCE, reason: "PLAYER_URL_NOT_FOUND"
        });
        continue;
      }

      await session.navigate(url, cfg.pageWaitMs);
      const html = await session.html();
      const parsed = parseFutbinPlayerHtml(html);
      const value = resultFromParsed(card, parsed, url, platform);
      cache.set(key, { at: Date.now(), value });
      results.set(String(card.eaId), value);
      state.calls += 1;
      if (value.ok) state.lastSuccessAt = new Date().toISOString();
      await sleep(cfg.spacingMs);
    }
    return { ok: true, year, results };
  } catch (error) {
    const message = String(error?.message || error);
    state.lastErrorAt = new Date().toISOString();
    state.lastError = message;
    if (/BLOCK_PAGE|HTTP_403|HTTP_429/i.test(message)) {
      state.blockedUntil = Date.now() + cfg.blockBackoffMs;
    }
    return { ok: false, year, results, reason: message };
  } finally {
    session?.close?.();
  }
}

export function resetFutbinBraveStateForTests() {
  cache.clear();
  state.lastSuccessAt = null;
  state.lastErrorAt = null;
  state.lastError = null;
  state.blockedUntil = 0;
  state.calls = 0;
  state.cacheHits = 0;
}
