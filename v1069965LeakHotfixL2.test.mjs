import test from "node:test";
import assert from "node:assert/strict";
import { patchPublicXResilienceV1069965L2 } from "../v1069965LeakHotfixL2Loader.mjs";

const fixture = `
async function fetchPublicXMirror(handle) {
  const errors = [];
  const now = Date.now();
  for (const base of PUBLIC_LEAK_X_MIRROR_BASES) {
    const url = \`${'${base}'}/${'${encodeURIComponent(handle)}'}\`;
    try { return { ok: true, provider: new URL(base).hostname, url, posts: [] }; }
    catch (error) { errors.push(String(error)); }
  }
  throw new Error(errors.join(" | ") || \`Kein X-Mirror fuer ${'${handle}'} erreichbar\`);
}

function publicLeakMatchesGameYear(text) { return true; }
`;

test("adds public X search RSS fallback with snowflake timestamps", () => {
  const out = patchPublicXResilienceV1069965L2(fixture);
  assert.match(out, /bing-public-rss/);
  assert.match(out, /publicXStatusTimestampFromId/);
  assert.match(out, /1288834974657n/);
  assert.match(out, /PUBLIC_LEAK_X_SEARCH_FALLBACK_ENABLED/);
  assert.match(out, /site:x\.com\//);
});
