import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L5_VERSION = "10.69.9.6.5-L5-x-api-since-id-telemetry";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function replaceBetween(source, startAnchor, endAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`[v10.69.9.6.5-L5] ${label} start anchor missing`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`[v10.69.9.6.5-L5] ${label} end anchor missing`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5-L5] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchOfficialXApiV1069965L5(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L5 official X API since-id telemetry")) return out;

  const helper = String.raw`
// v10.69.9.6.5-L5 official X API since-id telemetry.
// Primary path: official X API v2. Public syndication/mirrors and Telegram stay fallbacks.
// Secrets are read from environment only and are never returned by any status endpoint.
const PUBLIC_LEAK_X_API_BEARER_TOKEN = String(
  process.env.X_BEARER_TOKEN || process.env.PUBLIC_LEAK_X_API_BEARER_TOKEN || ""
).trim();
const PUBLIC_LEAK_X_API_ENABLED =
  Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN) &&
  String(process.env.PUBLIC_LEAK_X_API_ENABLED || "true").trim().toLowerCase() !== "false";
const PUBLIC_LEAK_X_API_MAX_RESULTS = Math.max(
  5,
  Math.min(100, Number(process.env.PUBLIC_LEAK_X_API_MAX_RESULTS || 10))
);
const PUBLIC_LEAK_X_API_MIN_INTERVAL_MS = Math.max(
  PUBLIC_LEAK_POLL_INTERVAL_MS,
  Math.max(1, Number(process.env.PUBLIC_LEAK_X_API_MIN_INTERVAL_MIN || Math.round(PUBLIC_LEAK_POLL_INTERVAL_MS / 60_000))) * 60_000
);

const publicLeakXApiUserCache = new Map();
const publicLeakXApiAccountState = new Map();
let publicLeakXApiLastSuccessAt = null;
let publicLeakXApiLastRateLimit = null;

function publicLeakXApiStateFor(handle) {
  const key = String(handle || "").trim().replace(/^@/, "").toLowerCase();
  if (!publicLeakXApiAccountState.has(key)) {
    publicLeakXApiAccountState.set(key, {
      handle: String(handle || "").trim().replace(/^@/, ""),
      ok: false,
      sinceId: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      nextRetryAt: 0,
      fetched: 0,
      relevant: 0,
      accepted: 0,
      lastError: null,
      lastStatusCode: null,
      rateLimit: null
    });
  }
  return publicLeakXApiAccountState.get(key);
}

function publicLeakXApiErrorText(error) {
  return String(error?.message || error || "X API request failed").slice(0, 500);
}

function publicLeakXApiRateLimitFromHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  const asNumber = value => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const limit = asNumber(headers.get("x-rate-limit-limit"));
  const remaining = asNumber(headers.get("x-rate-limit-remaining"));
  const resetSeconds = asNumber(headers.get("x-rate-limit-reset"));
  const retryAfterRaw = headers.get("retry-after");
  let retryAfterSeconds = asNumber(retryAfterRaw);
  if (retryAfterRaw && retryAfterSeconds == null) {
    const parsed = Date.parse(retryAfterRaw);
    if (Number.isFinite(parsed)) retryAfterSeconds = Math.max(0, Math.ceil((parsed - Date.now()) / 1000));
  }
  if (limit == null && remaining == null && resetSeconds == null && retryAfterSeconds == null) return null;
  return {
    limit,
    remaining,
    resetAt: resetSeconds == null ? null : new Date(resetSeconds * 1000).toISOString(),
    retryAfterSeconds
  };
}

function publicLeakXApiRetryMs(error) {
  const now = Date.now();
  const status = Number(error?.status || 0);
  const rateLimit = error?.rateLimit || null;
  if (rateLimit?.retryAfterSeconds != null) {
    return Math.max(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS, Number(rateLimit.retryAfterSeconds) * 1000);
  }
  if (rateLimit?.resetAt) {
    const resetAt = Date.parse(rateLimit.resetAt);
    if (Number.isFinite(resetAt) && resetAt > now) {
      return Math.max(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS, resetAt - now + 5_000);
    }
  }
  if (status === 429) return Math.max(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS, 15 * 60_000);
  if (status === 401 || status === 403) return Math.max(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS, 30 * 60_000);
  if (status >= 500) return Math.max(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS, 5 * 60_000);
  return PUBLIC_LEAK_X_API_MIN_INTERVAL_MS;
}

function publicLeakXApiCanPoll(handle, now, force = false) {
  if (!PUBLIC_LEAK_X_API_ENABLED) return false;
  if (force) return true;
  const state = publicLeakXApiStateFor(handle);
  return now >= Number(state.nextRetryAt || 0);
}

async function fetchPublicXApiJson(url) {
  if (!PUBLIC_LEAK_X_API_ENABLED) throw new Error("Official X API not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + PUBLIC_LEAK_X_API_BEARER_TOKEN,
        "Accept": "application/json",
        "User-Agent": "FC-Trader-Brain/10.69.9.6.5-L5"
      },
      signal: controller.signal
    });

    const rateLimit = publicLeakXApiRateLimitFromHeaders(response.headers);
    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 1000) }; }

    if (!response.ok) {
      const error = new Error(
        "X API HTTP " + response.status + ": " +
        String(body?.detail || body?.title || body?.error || raw || "request failed").slice(0, 500)
      );
      error.status = response.status;
      error.rateLimit = rateLimit;
      throw error;
    }
    return { body, rateLimit };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolvePublicXApiUser(handle) {
  const cleanHandle = String(handle || "").trim().replace(/^@/, "");
  const key = cleanHandle.toLowerCase();
  const cached = publicLeakXApiUserCache.get(key);
  if (cached?.id) return cached;

  const url = "https://api.x.com/2/users/by/username/" + encodeURIComponent(cleanHandle);
  const result = await fetchPublicXApiJson(url);
  const user = result.body?.data;
  if (!user?.id) throw new Error("X API user lookup returned no id for @" + cleanHandle);

  const resolved = { id: String(user.id), username: String(user.username || cleanHandle) };
  publicLeakXApiUserCache.set(key, resolved);
  return resolved;
}

function publicLeakXApiMaxId(ids) {
  let best = null;
  let bestNumber = null;
  for (const value of ids || []) {
    const id = String(value || "").trim();
    if (!/^\d{1,25}$/.test(id)) continue;
    try {
      const numeric = BigInt(id);
      if (bestNumber == null || numeric > bestNumber) {
        best = id;
        bestNumber = numeric;
      }
    } catch {}
  }
  return best;
}

async function fetchPublicXOfficial(handle) {
  const cleanHandle = String(handle || "").trim().replace(/^@/, "");
  const state = publicLeakXApiStateFor(cleanHandle);
  const attemptAt = Date.now();
  state.lastAttemptAt = new Date(attemptAt).toISOString();

  try {
    const user = await resolvePublicXApiUser(cleanHandle);
    const params = new URLSearchParams({
      max_results: String(PUBLIC_LEAK_X_API_MAX_RESULTS),
      exclude: "replies,retweets",
      "post.fields": "created_at"
    });
    const sinceIdUsed = /^\d{1,19}$/.test(String(state.sinceId || "")) ? String(state.sinceId) : null;
    if (sinceIdUsed) params.set("since_id", sinceIdUsed);

    const url = "https://api.x.com/2/users/" + encodeURIComponent(user.id) + "/tweets?" + params.toString();
    const result = await fetchPublicXApiJson(url);
    const data = Array.isArray(result.body?.data) ? result.body.data : [];
    const posts = data
      .map(post => {
        const postId = String(post?.id || "").trim();
        const text = compactWhitespace(post?.text || "");
        const parsedAt = Date.parse(String(post?.created_at || ""));
        if (!postId || !text || !Number.isFinite(parsedAt)) return null;
        return {
          platform: "x",
          handle: user.username || cleanHandle,
          postId,
          text,
          sourceEventAt: parsedAt,
          publicUrl: "https://x.com/" + encodeURIComponent(user.username || cleanHandle) + "/status/" + encodeURIComponent(postId),
          directSource: cleanHandle.toLowerCase() === "futsheriff" ? "Fut Sheriff" : cleanHandle,
          transport: "official-x-api-v2"
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.sourceEventAt || 0) - Number(b.sourceEventAt || 0))
      .slice(-PUBLIC_LEAK_MAX_POSTS_PER_SOURCE);

    const newestId = publicLeakXApiMaxId(data.map(post => post?.id));
    if (newestId) state.sinceId = newestId;
    state.ok = true;
    state.fetched = posts.length;
    state.lastSuccessAt = new Date().toISOString();
    state.nextRetryAt = Date.now() + PUBLIC_LEAK_X_API_MIN_INTERVAL_MS;
    state.lastError = null;
    state.lastStatusCode = 200;
    state.rateLimit = result.rateLimit || null;
    publicLeakXApiLastSuccessAt = state.lastSuccessAt;
    publicLeakXApiLastRateLimit = state.rateLimit;

    return {
      ok: true,
      provider: "Official X API v2",
      url,
      posts,
      sinceIdUsed,
      rateLimit: state.rateLimit
    };
  } catch (error) {
    state.ok = false;
    state.fetched = 0;
    state.relevant = 0;
    state.accepted = 0;
    state.lastError = publicLeakXApiErrorText(error);
    state.lastStatusCode = Number(error?.status || 0) || null;
    state.rateLimit = error?.rateLimit || null;
    state.nextRetryAt = Date.now() + publicLeakXApiRetryMs(error);
    if (state.rateLimit) publicLeakXApiLastRateLimit = state.rateLimit;
    throw error;
  }
}

function recordPublicXApiConsumption(handle, consumed) {
  const state = publicLeakXApiStateFor(handle);
  state.relevant = Number(consumed?.sourceRelevant || 0);
  state.accepted = Number(consumed?.sourceAccepted || 0);
}

function publicLeakXApiOverallOk() {
  if (!PUBLIC_LEAK_X_API_ENABLED || !PUBLIC_LEAK_X_HANDLES.length) return false;
  return PUBLIC_LEAK_X_HANDLES.every(handle => publicLeakXApiStateFor(handle).ok === true);
}

function publicLeakXApiCurrentError() {
  const failures = PUBLIC_LEAK_X_HANDLES
    .map(handle => publicLeakXApiStateFor(handle))
    .filter(state => state.lastError && state.ok !== true)
    .map(state => "@" + state.handle + ": " + state.lastError);
  return failures.length ? failures.join(" | ").slice(0, 1500) : null;
}

function publicLeakXApiAccountStatus() {
  return PUBLIC_LEAK_X_HANDLES.map(handle => {
    const state = publicLeakXApiStateFor(handle);
    return {
      handle: "@" + handle,
      ok: state.ok === true,
      fetched: Number(state.fetched || 0),
      relevant: Number(state.relevant || 0),
      accepted: Number(state.accepted || 0),
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      nextRetryAt: state.nextRetryAt ? new Date(state.nextRetryAt).toISOString() : null,
      sinceIdActive: Boolean(state.sinceId),
      lastStatusCode: state.lastStatusCode,
      lastError: state.lastError,
      rateLimit: state.rateLimit
    };
  });
}`;

  out = replaceBetween(
    out,
    "// v10.69.9.6.5-L4 official X API.",
    "function parsePublicXSyndication(html, handle) {",
    helper,
    "official X API helper"
  );

  const xLoop = String.raw`
    // L5: official X API is attempted on the leak poll cadence. Public web transports
    // remain conservative fallbacks and keep their existing backoff windows.
    for (const handle of PUBLIC_LEAK_X_HANDLES) {
      const directUrl = "https://syndication.twitter.com/srv/timeline-profile/screen-name/" + encodeURIComponent(handle);
      const statusKey = "x:" + handle;
      const transport = publicLeakXTransportFor(handle);
      const apiState = publicLeakXApiStateFor(handle);
      let apiError = null;

      if (publicLeakXApiCanPoll(handle, now, force)) {
        try {
          const apiResult = await fetchPublicXOfficial(handle);
          const consumed = await consumePublicXPosts(handle, apiResult.posts);
          recordPublicXApiConsumption(handle, consumed);
          cycle.sourceStatus[statusKey] = {
            ok: true,
            direct: true,
            provider: apiResult.provider,
            profile: "https://x.com/" + handle,
            url: apiResult.url,
            xApiConfigured: true,
            xApiOk: true,
            fetched: apiResult.posts.length,
            relevant: consumed.sourceRelevant,
            accepted: consumed.sourceAccepted,
            sinceIdUsed: Boolean(apiResult.sinceIdUsed),
            rateLimit: apiResult.rateLimit || null,
            lastXApiSuccessAt: publicLeakXApiStateFor(handle).lastSuccessAt
          };
          continue;
        } catch (error) {
          apiError = error;
        }
      } else if (PUBLIC_LEAK_X_API_ENABLED && apiState.ok === true) {
        cycle.sourceStatus[statusKey] = {
          ok: true,
          direct: true,
          provider: "Official X API v2",
          profile: "https://x.com/" + handle,
          xApiConfigured: true,
          xApiOk: true,
          pollSkipped: true,
          reason: "Official X API healthy; next poll window not reached yet.",
          fetched: apiState.fetched,
          relevant: apiState.relevant,
          accepted: apiState.accepted,
          lastXApiSuccessAt: apiState.lastSuccessAt,
          nextXApiAttemptAt: apiState.nextRetryAt ? new Date(apiState.nextRetryAt).toISOString() : null,
          rateLimit: apiState.rateLimit || null
        };
        continue;
      }

      let directWorked = false;
      let directError = null;
      let directSkipped = false;
      const directReady = force || (
        now >= Number(transport.directNextRetryAt || 0) &&
        now - Number(transport.directLastAttemptAt || 0) >= PUBLIC_LEAK_X_DIRECT_MIN_INTERVAL_MS
      );
      if (directReady) {
        transport.directLastAttemptAt = now;
        try {
          const html = await fetchText(directUrl);
          const posts = parsePublicXSyndication(html, handle);
          const consumed = await consumePublicXPosts(handle, posts);
          transport.directLastSuccessAt = now;
          transport.directFailureCount = 0;
          transport.directNextRetryAt = now + PUBLIC_LEAK_X_DIRECT_MIN_INTERVAL_MS;
          directWorked = true;
          cycle.sourceStatus[statusKey] = {
            ok: true,
            direct: true,
            provider: "X public syndication",
            profile: "https://x.com/" + handle,
            url: directUrl,
            xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
            xApiOk: false,
            xApiError: apiError ? publicLeakXApiErrorText(apiError) : publicLeakXApiCurrentError(),
            fetched: posts.length,
            relevant: consumed.sourceRelevant,
            accepted: consumed.sourceAccepted,
            nextDirectAttemptAt: new Date(transport.directNextRetryAt).toISOString()
          };
        } catch (error) {
          directError = error;
          transport.directFailureCount += 1;
          const status = Number(error?.status || 0);
          const waitMs = status === 429
            ? publicLeakXBackoffMs(transport.directFailureCount)
            : Math.max(PUBLIC_LEAK_X_DIRECT_MIN_INTERVAL_MS, Math.min(PUBLIC_LEAK_X_BACKOFF_BASE_MS, publicLeakXBackoffMs(transport.directFailureCount)));
          transport.directNextRetryAt = now + waitMs;
        }
      } else {
        directSkipped = true;
      }

      const mirrorReady = PUBLIC_LEAK_X_MIRROR_BASES.length > 0 && (
        force || now - Number(transport.mirrorLastAttemptAt || 0) >= PUBLIC_LEAK_X_MIRROR_INTERVAL_MS
      );
      let mirrorWorked = false;
      let mirrorError = null;
      let mirrorResult = null;
      if (mirrorReady) {
        transport.mirrorLastAttemptAt = now;
        try {
          mirrorResult = await fetchPublicXMirror(handle);
          const consumed = await consumePublicXPosts(handle, mirrorResult.posts);
          transport.mirrorLastSuccessAt = now;
          transport.mirrorProvider = mirrorResult.provider;
          transport.mirrorFailureCount = 0;
          mirrorWorked = true;
          if (!directWorked) {
            cycle.sourceStatus[statusKey] = {
              ok: true,
              direct: true,
              provider: "Public X mirror (" + mirrorResult.provider + ")",
              profile: "https://x.com/" + handle,
              url: mirrorResult.url,
              xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
              xApiOk: false,
              xApiError: apiError ? publicLeakXApiErrorText(apiError) : publicLeakXApiCurrentError(),
              fetched: mirrorResult.posts.length,
              relevant: consumed.sourceRelevant,
              accepted: consumed.sourceAccepted,
              directTransportOk: false,
              directError: directError ? String(directError) : (directSkipped ? "Direct-X waits for next retry window" : null),
              nextDirectAttemptAt: transport.directNextRetryAt ? new Date(transport.directNextRetryAt).toISOString() : null
            };
          } else {
            cycle.sourceStatus[statusKey + ":mirror"] = {
              ok: true,
              provider: "Public X mirror (" + mirrorResult.provider + ")",
              url: mirrorResult.url,
              fetched: mirrorResult.posts.length,
              relevant: consumed.sourceRelevant,
              accepted: consumed.sourceAccepted,
              role: "redundant-fallback"
            };
          }
        } catch (error) {
          mirrorError = error;
          transport.mirrorFailureCount += 1;
        }
      }

      if (!directWorked && !mirrorWorked) {
        const recentMirrorHealthy = Number(transport.mirrorLastSuccessAt || 0) > 0 &&
          now - Number(transport.mirrorLastSuccessAt) <= Math.max(20 * 60_000, PUBLIC_LEAK_X_MIRROR_INTERVAL_MS * 3);
        const recentDirectHealthy = Number(transport.directLastSuccessAt || 0) > 0 &&
          now - Number(transport.directLastSuccessAt) <= PUBLIC_LEAK_X_DIRECT_MIN_INTERVAL_MS + 10 * 60_000;
        if ((recentMirrorHealthy || recentDirectHealthy) && !mirrorError && !directError) {
          cycle.sourceStatus[statusKey] = {
            ok: true,
            direct: true,
            provider: recentMirrorHealthy
              ? "Public X mirror (" + (transport.mirrorProvider || "cached") + ")"
              : "X public syndication",
            profile: "https://x.com/" + handle,
            xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
            xApiOk: false,
            xApiError: apiError ? publicLeakXApiErrorText(apiError) : publicLeakXApiCurrentError(),
            pollSkipped: true,
            reason: "Fallback transport healthy; next allowed fallback poll window not reached.",
            nextDirectAttemptAt: transport.directNextRetryAt ? new Date(transport.directNextRetryAt).toISOString() : null,
            lastDirectSuccessAt: transport.directLastSuccessAt ? new Date(transport.directLastSuccessAt).toISOString() : null,
            lastMirrorSuccessAt: transport.mirrorLastSuccessAt ? new Date(transport.mirrorLastSuccessAt).toISOString() : null
          };
        } else {
          cycle.sourceStatus[statusKey] = {
            ok: false,
            direct: true,
            provider: "Official X API v2 + public fallbacks",
            profile: "https://x.com/" + handle,
            url: directUrl,
            xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
            xApiOk: false,
            xApiError: apiError ? publicLeakXApiErrorText(apiError) : publicLeakXApiCurrentError(),
            xApiStatusCode: publicLeakXApiStateFor(handle).lastStatusCode,
            xApiRateLimit: publicLeakXApiStateFor(handle).rateLimit,
            nextXApiAttemptAt: publicLeakXApiStateFor(handle).nextRetryAt ? new Date(publicLeakXApiStateFor(handle).nextRetryAt).toISOString() : null,
            directSkipped,
            directError: directError ? String(directError) : null,
            mirrorError: mirrorError ? String(mirrorError) : null,
            directFailureCount: transport.directFailureCount,
            nextDirectAttemptAt: transport.directNextRetryAt ? new Date(transport.directNextRetryAt).toISOString() : null,
            lastDirectSuccessAt: transport.directLastSuccessAt ? new Date(transport.directLastSuccessAt).toISOString() : null,
            lastMirrorSuccessAt: transport.mirrorLastSuccessAt ? new Date(transport.mirrorLastSuccessAt).toISOString() : null
          };
        }
      }
    }`;

  out = replaceBetween(
    out,
    "    // Original-X bleibt bevorzugt",
    "    for (const handle of PUBLIC_LEAK_TELEGRAM_CHANNELS) {",
    xLoop,
    "public X polling loop"
  );

  const oldStatus = `      xApi: {\n        configured: PUBLIC_LEAK_X_API_ENABLED,\n        provider: "Official X API v2",\n        bearerTokenExposed: false\n      },\n      xTransport: {`;
  const newStatus = `      xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,\n      xApiOk: publicLeakXApiOverallOk(),\n      xApiLastSuccessAt: publicLeakXApiLastSuccessAt,\n      xApiLastError: publicLeakXApiCurrentError(),\n      xApiRateLimit: publicLeakXApiLastRateLimit,\n      xApi: {\n        configured: PUBLIC_LEAK_X_API_ENABLED,\n        ok: publicLeakXApiOverallOk(),\n        provider: "Official X API v2",\n        pollIntervalMinutes: Math.round(PUBLIC_LEAK_X_API_MIN_INTERVAL_MS / 60_000),\n        lastSuccessfulPollAt: publicLeakXApiLastSuccessAt,\n        lastError: publicLeakXApiCurrentError(),\n        rateLimit: publicLeakXApiLastRateLimit,\n        accounts: publicLeakXApiAccountStatus(),\n        bearerTokenExposed: false\n      },\n      xTransport: {`;
  out = replaceRequired(out, oldStatus, newStatus, "X API status block");

  out = out.replaceAll(
    'transport: "Official X API v2 + syndication + public-mirror fallback"',
    'transport: "Official X API v2 + public fallbacks + Telegram fallback"'
  );

  out = out.replaceAll(
    "Der Brain bevorzugt bei konfiguriertem X_BEARER_TOKEN die offizielle X API v2; Syndication/Mirrors und Telegram bleiben Fallbacks.",
    "Der Brain nutzt bei konfiguriertem X_BEARER_TOKEN die offizielle X API v2 als primaeren Pfad. Seit dem letzten erfolgreichen Poll wird per since_id inkrementell gelesen; oeffentliche Fallbacks und Telegram bleiben aktiv."
  );

  if (!out.includes("v10.69.9.6.5-L5 official X API since-id telemetry") ||
      !out.includes('params.set("since_id", sinceIdUsed)') ||
      !out.includes("xApiConfigured: PUBLIC_LEAK_X_API_ENABLED") ||
      !out.includes("xApiLastSuccessAt: publicLeakXApiLastSuccessAt") ||
      !out.includes("accounts: publicLeakXApiAccountStatus()") ||
      !out.includes("for (const handle of PUBLIC_LEAK_TELEGRAM_CHANNELS) {")) {
    throw new Error("[v10.69.9.6.5-L5] official X API telemetry patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchOfficialXApiV1069965L5(raw);
    console.log("[v10.69.9.6.5-L5] Official X API since_id + telemetry ACTIVE.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L5] official X API telemetry hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
