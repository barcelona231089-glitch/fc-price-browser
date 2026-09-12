import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L4_VERSION = "10.69.9.6.5-L4-official-x-api";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function insertBeforeRequired(source, anchor, insertion, label) {
  const index = source.indexOf(anchor);
  if (index < 0) throw new Error(`[v10.69.9.6.5-L4] ${label} anchor missing`);
  return source.slice(0, index) + insertion.trimEnd() + "\n\n" + source.slice(index);
}

export function patchOfficialXApiV1069965L4(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L4 official X API")) return out;

  const helper = String.raw`
// v10.69.9.6.5-L4 official X API.
// Preferred path when X_BEARER_TOKEN is configured:
//   X API v2 -> public syndication -> public mirrors/search -> Telegram.
// The token is read only from the server environment and is never returned by status APIs.
const PUBLIC_LEAK_X_API_BEARER_TOKEN = String(
  process.env.X_BEARER_TOKEN || process.env.PUBLIC_LEAK_X_API_BEARER_TOKEN || ""
).trim();
const PUBLIC_LEAK_X_API_ENABLED =
  Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN) &&
  String(process.env.PUBLIC_LEAK_X_API_ENABLED || "true").trim().toLowerCase() !== "false";
const PUBLIC_LEAK_X_API_MAX_RESULTS = Math.max(
  5,
  Math.min(20, Number(process.env.PUBLIC_LEAK_X_API_MAX_RESULTS || 10))
);
const publicLeakXApiUserCache = new Map();

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
        "User-Agent": "FC-Trader-Brain/10.69.9.6.5-L4"
      },
      signal: controller.signal
    });

    const raw = await response.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 1000) }; }

    if (!response.ok) {
      const error = new Error(
        "X API HTTP " + response.status + ": " +
        String(body?.detail || body?.title || body?.error || raw || "request failed").slice(0, 500)
      );
      error.status = response.status;
      throw error;
    }
    return body;
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
  const body = await fetchPublicXApiJson(url);
  const user = body?.data;
  if (!user?.id) throw new Error("X API user lookup returned no id for @" + cleanHandle);

  const resolved = { id: String(user.id), username: String(user.username || cleanHandle) };
  publicLeakXApiUserCache.set(key, resolved);
  return resolved;
}

async function fetchPublicXOfficial(handle) {
  const cleanHandle = String(handle || "").trim().replace(/^@/, "");
  const user = await resolvePublicXApiUser(cleanHandle);

  const params = new URLSearchParams({
    max_results: String(PUBLIC_LEAK_X_API_MAX_RESULTS),
    exclude: "replies,retweets",
    "post.fields": "created_at"
  });
  const url = "https://api.x.com/2/users/" + encodeURIComponent(user.id) + "/tweets?" + params.toString();
  const body = await fetchPublicXApiJson(url);
  const data = Array.isArray(body?.data) ? body.data : [];

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
        publicUrl: "https://x.com/" + encodeURIComponent(user.username || cleanHandle) +
          "/status/" + encodeURIComponent(postId),
        directSource: cleanHandle.toLowerCase() === "futsheriff" ? "Fut Sheriff" : cleanHandle,
        transport: "official-x-api-v2"
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(a.sourceEventAt || 0) - Number(b.sourceEventAt || 0))
    .slice(-PUBLIC_LEAK_MAX_POSTS_PER_SOURCE);

  return {
    ok: true,
    provider: "Official X API v2",
    url,
    posts
  };
}

async function fetchPublicXPrimary(handle, syndicationUrl) {
  let officialApiError = null;

  if (PUBLIC_LEAK_X_API_ENABLED) {
    try {
      const result = await fetchPublicXOfficial(handle);
      return {
        ...result,
        officialApiConfigured: true,
        officialApiOk: true,
        officialApiError: null
      };
    } catch (error) {
      officialApiError = error;
    }
  }

  // Graceful fallback. A token/billing/rate-limit issue must not kill leak intake.
  const html = await fetchText(syndicationUrl);
  const posts = parsePublicXSyndication(html, handle);
  return {
    ok: true,
    provider: "X public syndication",
    url: syndicationUrl,
    posts,
    officialApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
    officialApiOk: false,
    officialApiError: officialApiError ? String(officialApiError) : null
  };
}`;

  out = insertBeforeRequired(
    out,
    "function parsePublicXSyndication(html, handle) {",
    helper,
    "official X API helper"
  );

  const primaryPattern = /const html = await fetchText\(directUrl\);\s*const posts = parsePublicXSyndication\(html, handle\);/;
  if (!primaryPattern.test(out)) {
    throw new Error("[v10.69.9.6.5-L4] direct X fetch anchor missing");
  }
  out = out.replace(
    primaryPattern,
    `const primaryResult = await fetchPublicXPrimary(handle, directUrl);
          const posts = primaryResult.posts;`
  );

  const statusPattern =
    /provider:\s*"X public syndication",\s*profile:\s*`https:\/\/x\.com\/\$\{handle\}`,\s*url:\s*directUrl,\s*fetched:\s*posts\.length,/;
  if (!statusPattern.test(out)) {
    throw new Error("[v10.69.9.6.5-L4] direct X status anchor missing");
  }
  out = out.replace(
    statusPattern,
    `provider: primaryResult.provider,
            profile: \`https://x.com/\${handle}\`,
            url: primaryResult.url,
            officialApiConfigured: PUBLIC_LEAK_X_API_ENABLED,
            officialApiOk: primaryResult.officialApiOk === true,
            officialApiError: primaryResult.officialApiError || null,
            fetched: posts.length,`
  );

  out = out.replaceAll(
    'transport: "X syndication + multi-public-mirror fallback"',
    'transport: "Official X API v2 + syndication + public-mirror fallback"'
  );

  // Expose configuration state, never the token itself.
  out = out.replace(
    "xTransport: {",
    `xApi: {
        configured: PUBLIC_LEAK_X_API_ENABLED,
        provider: "Official X API v2",
        bearerTokenExposed: false
      },
      xTransport: {`
  );

  out = out.replaceAll(
    "Der Brain bevorzugt Fut Sheriff direkt ueber die oeffentliche X-Profil-Syndication.",
    "Der Brain bevorzugt bei konfiguriertem X_BEARER_TOKEN die offizielle X API v2; Syndication/Mirrors und Telegram bleiben Fallbacks."
  );

  if (!out.includes("fetchPublicXOfficial(handle)") ||
      !out.includes("Official X API v2") ||
      !out.includes("officialApiConfigured: PUBLIC_LEAK_X_API_ENABLED")) {
    throw new Error("[v10.69.9.6.5-L4] official X API patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchOfficialXApiV1069965L4(raw);
    console.log("[v10.69.9.6.5-L4] Official X API v2 primary leak transport ACTIVE.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L4] official X API hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
