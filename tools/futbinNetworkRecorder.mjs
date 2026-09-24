import { mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.env.BRAVE_DEBUG_PORT || 9230);
const out = process.env.FUTBIN_NET_LOG || join(process.cwd(), "logs", "futbin-network.jsonl");
const registryPath = process.env.FUTBIN_ENDPOINT_REGISTRY || join(process.cwd(), "logs", "futbin-endpoints.json");
mkdirSync(join(process.cwd(), "logs"), { recursive: true });

const allowedHost = host => /(^|\.)futbin\.com$/i.test(host);
const tabs = await fetch("http://127.0.0.1:" + port + "/json").then(r => r.json());
const tab = tabs.find(x => {
  try { return x.type === "page" && allowedHost(new URL(x.url || "").hostname); } catch { return false; }
});
if (!tab?.webSocketDebuggerUrl) throw new Error("Open FUTBIN in the collector Brave session first.");

let registry = { version: 1, active: null, candidates: {} };
try { registry = { ...registry, ...JSON.parse(readFileSync(registryPath, "utf8")) }; } catch {}

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise(resolve => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const persist = () => writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

ws.onopen = async () => {
  await send("Network.enable");
  console.log("Recording public FUTBIN first-party requests. Ctrl+C to stop.");
};

ws.onmessage = async e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const resolve = pending.get(m.id); pending.delete(m.id); resolve(m); return;
  }
  if (m.method !== "Network.responseReceived") return;
  const r = m.params?.response;
  const rawUrl = String(r?.url || "");
  let url;
  try { url = new URL(rawUrl); } catch { return; }
  if (!allowedHost(url.hostname) || !/xhr|fetch/i.test(m.params?.type || "")) return;

  const row = { at: new Date().toISOString(), status: Number(r?.status || 0), mime: r?.mimeType || null, url: rawUrl };
  appendFileSync(out, JSON.stringify(row) + "\n");

  if (row.status < 200 || row.status >= 300 || !/json/i.test(row.mime || "")) return;
  const bodyReply = await send("Network.getResponseBody", { requestId: m.params.requestId });
  const body = bodyReply?.result?.body || "";
  let parsed;
  try { parsed = JSON.parse(body); } catch { return; }
  const bodyText = JSON.stringify(parsed).toLowerCase();
  const looksUseful = /(price|lcprice|player_resource|player_id|sales|games|popular)/.test(bodyText);
  if (!looksUseful) return;

  const key = url.origin + url.pathname;
  const previous = registry.candidates[key] || {};
  const queryKeys = new Set(Object.keys(previous.observedQueryKeys || {}));
  for (const k of url.searchParams.keys()) queryKeys.add(k);
  registry.candidates[key] = {
    firstSeenAt: previous.firstSeenAt || row.at,
    lastSeenAt: row.at,
    lastStatus: row.status,
    hits: Number(previous.hits || 0) + 1,
    observedQueryKeys: Object.fromEntries([...queryKeys].map(k => [k, true])),
    evidence: {
      price: /price|lcprice/.test(bodyText),
      playerId: /player_resource|player_id/.test(bodyText),
      sales: /sales|sold_for|listed_for/.test(bodyText),
      games: /games|gamesplayed/.test(bodyText),
      popularity: /popular/.test(bodyText)
    }
  };

  const c = registry.candidates[key];
  const score = Object.values(c.evidence).filter(Boolean).length;
  const active = registry.active && registry.candidates[registry.active];
  const activeScore = active ? Object.values(active.evidence || {}).filter(Boolean).length : -1;
  if (!registry.active || score > activeScore || (score === activeScore && c.hits > Number(active?.hits || 0))) registry.active = key;
  persist();
  console.log("FUTBIN candidate", score + "/5", key);
};