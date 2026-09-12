import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L2_VERSION = "10.69.9.6.5-L2-public-x-resilience";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function replaceFunctionBlock(source, startAnchor, nextAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`[v10.69.9.6.5-L2] ${label} start anchor missing`);
  const end = source.indexOf(nextAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`[v10.69.9.6.5-L2] ${label} end anchor missing`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

export function patchPublicXResilienceV1069965L2(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L2 public X resilience")) return out;

  const replacement = String.raw`
// v10.69.9.6.5-L2 public X resilience.
// Direct X syndication stays first choice. Existing public mirrors remain second.
// If both are unavailable/stale, use Bing's public RSS search index only to
// discover public x.com status URLs. Tweet time is derived from the public X
// snowflake id, so search-engine crawl time is never used as event time.
const PUBLIC_LEAK_X_SEARCH_FALLBACK_ENABLED = String(
  process.env.PUBLIC_LEAK_X_SEARCH_FALLBACK_ENABLED || "true"
).trim().toLowerCase() !== "false";

function publicXStatusTimestampFromId(id) {
  try {
    const snowflake = BigInt(String(id || "").trim());
    if (snowflake <= 0n) return null;
    const epoch = 1288834974657n;
    const ms = Number((snowflake >> 22n) + epoch);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function escapePublicRegex(value) {
  return String(value || "").replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

function publicXmlValue(chunk, tag) {
  const escaped = escapePublicRegex(tag);
  const match = String(chunk || "").match(new RegExp(
    "<" + escaped + "[^>]*>([\\s\\S]*?)<\\/" + escaped + ">",
    "i"
  ));
  if (!match) return "";
  return decodePublicHtmlEntities(
    String(match[1] || "")
      .replace(/^<!\[CDATA\[/i, "")
      .replace(/\]\]>$/i, "")
  ).trim();
}

function parsePublicXSearchRss(xml, handle, searchUrl) {
  const raw = String(xml || "");
  const cleanHandle = String(handle || "").trim().replace(/^@/, "");
  if (!raw || !cleanHandle) return [];

  const posts = [];
  const seen = new Set();
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch;

  while ((itemMatch = itemRe.exec(raw))) {
    const chunk = itemMatch[1];
    const title = publicXmlValue(chunk, "title");
    const description = publicXmlValue(chunk, "description");
    const link = publicXmlValue(chunk, "link");
    const candidate = (link + " " + title + " " + description).trim();
    const statusMatch = candidate.match(/https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([^\s/?#<>]+)\/status\/(\d{10,25})/i);
    if (!statusMatch) continue;

    const author = String(statusMatch[1] || "").replace(/^@/, "");
    const postId = String(statusMatch[2] || "");
    if (!author || author.toLowerCase() !== cleanHandle.toLowerCase() || seen.has(postId)) continue;

    const sourceEventAt = publicXStatusTimestampFromId(postId);
    if (!Number.isFinite(sourceEventAt)) continue;

    let text = compactWhitespace(title + " " + description)
      .replace(new RegExp("^" + escapePublicRegex(cleanHandle) + "\\s+on\\s+X\\s*:?", "i"), "")
      .replace(/\s+\/\s+X\s*$/i, "")
      .replace(/\s+Log in or sign up for X[\s\S]*$/i, "")
      .replace(/\s+See what's happening and join the conversation[\s\S]*$/i, "")
      .trim();
    if (!text || text.length < 4) text = title || description;
    if (!text || text.length < 4) continue;

    seen.add(postId);
    posts.push({
      platform: "x",
      handle: cleanHandle,
      postId,
      text: text.slice(0, 3000),
      sourceEventAt,
      publicUrl: "https://x.com/" + encodeURIComponent(cleanHandle) + "/status/" + encodeURIComponent(postId),
      directSource: cleanHandle.toLowerCase() === "futsheriff" ? "Fut Sheriff" : cleanHandle,
      transport: "public-x-search-rss",
      searchUrl
    });
  }

  return posts
    .sort((a, b) => Number(a.sourceEventAt || 0) - Number(b.sourceEventAt || 0))
    .slice(-PUBLIC_LEAK_MAX_POSTS_PER_SOURCE);
}

async function fetchPublicXSearchFallback(handle) {
  if (!PUBLIC_LEAK_X_SEARCH_FALLBACK_ENABLED) {
    throw new Error("Public X search fallback deaktiviert");
  }

  const cleanHandle = String(handle || "").trim().replace(/^@/, "");
  const query = "site:x.com/" + cleanHandle + "/status";
  const url = "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(query);
  const xml = await fetchText(url);
  const posts = parsePublicXSearchRss(xml, cleanHandle, url);
  if (!posts.length) throw new Error(url + " -> keine parsebaren X-Status-Treffer");

  const now = Date.now();
  const recentPosts = posts.filter(post =>
    Number.isFinite(Number(post.sourceEventAt)) &&
    now - Number(post.sourceEventAt) <= PUBLIC_LEAK_MAX_AGE_MS &&
    Number(post.sourceEventAt) <= now + 5 * 60_000
  );
  if (!recentPosts.length) {
    throw new Error(url + " -> keine frischen X-Treffer im " + Math.round(PUBLIC_LEAK_MAX_AGE_MS / 3_600_000) + "h-Fenster");
  }

  return { ok: true, provider: "bing-public-rss", url, posts: recentPosts };
}

async function fetchPublicXMirror(handle) {
  const errors = [];
  const now = Date.now();
  for (const base of PUBLIC_LEAK_X_MIRROR_BASES) {
    const url = base + "/" + encodeURIComponent(handle);
    try {
      const html = await fetchText(url);
      const posts = parsePublicXMirror(html, handle, url, now);
      if (!posts.length) throw new Error(url + " -> keine parsebaren Posts");

      const recentPosts = posts.filter(post =>
        Number.isFinite(Number(post.sourceEventAt)) &&
        now - Number(post.sourceEventAt) <= PUBLIC_LEAK_MAX_AGE_MS &&
        Number(post.sourceEventAt) <= now + 5 * 60_000
      );
      if (!recentPosts.length) throw new Error(url + " -> keine frischen Posts im " + Math.round(PUBLIC_LEAK_MAX_AGE_MS / 3_600_000) + "h-Fenster");

      return { ok: true, provider: new URL(base).hostname, url, posts: recentPosts };
    } catch (error) {
      errors.push(String(error));
    }
  }

  try {
    return await fetchPublicXSearchFallback(handle);
  } catch (error) {
    errors.push(String(error));
  }

  throw new Error(errors.join(" | ") || "Kein oeffentlicher X-Fallback fuer " + handle + " erreichbar");
}`;

  out = replaceFunctionBlock(
    out,
    "async function fetchPublicXMirror(handle) {",
    "function publicLeakMatchesGameYear(text) {",
    replacement,
    "fetchPublicXMirror"
  );

  if (!out.includes("bing-public-rss") || !out.includes("publicXStatusTimestampFromId") ||
      !out.includes("PUBLIC_LEAK_X_SEARCH_FALLBACK_ENABLED")) {
    throw new Error("[v10.69.9.6.5-L2] public X resilience patch incomplete");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchPublicXResilienceV1069965L2(raw);
    console.log("[v10.69.9.6.5-L2] Public X direct/mirror/search-RSS resilience ACTIVE.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L2] X resilience hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
