import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FUTBIN_FC27_EA_TO_ID } from "./futbinIdMapFc27.js";
import { getFutbinBraveCards } from "./uv/src/futbinBraveAdapter.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(ROOT, "logs");
const STATE_FILE = join(LOG_DIR, "futbin-brave-collector-status.json");
const LOCK_FILE = join(LOG_DIR, "futbin-brave-collector.lock");
const HOST = String(process.env.FUTBIN_COLLECTOR_HOST || "https://fc-trader-brain.hostless.app").replace(/\/$/, "");
const PORT = Math.max(1024, Math.min(65535, Number(process.env.FUTBIN_BRAVE_COLLECTOR_PORT || 9230)));
const MAX_CARDS = Math.max(1, Math.min(12, Number(process.env.FUTBIN_BRAVE_COLLECTOR_MAX_CARDS || 6)));
const SALES_CARDS_PER_CYCLE = Math.max(0, Math.min(2, Number(process.env.FUTBIN_BRAVE_SALES_CARDS_PER_CYCLE || 1)));
const INTERVAL_MS = Math.max(15 * 60_000, Number(process.env.FUTBIN_BRAVE_COLLECTOR_INTERVAL_MS || 30 * 60_000));
const PAGE_WAIT_MS = Math.max(1500, Math.min(20_000, Number(process.env.FUTBIN_BRAVE_PAGE_WAIT_MS || 4500)));
const SPACING_MS = Math.max(1500, Math.min(60_000, Number(process.env.FUTBIN_BRAVE_SPACING_MS || 3000)));
const CLOSE_AFTER_CYCLE = !["0", "false", "no", "off"].includes(String(process.env.FUTBIN_BRAVE_CLOSE_AFTER_CYCLE || "1").trim().toLowerCase());
const TOKEN = String(process.env.FUTBIN_SNAPSHOT_INGEST_TOKEN || "");
const PROFILE_DIR = process.env.FUTBIN_BRAVE_COLLECTOR_PROFILE
  || join(process.env.LOCALAPPDATA || ROOT, "FCTraderBrain", "BraveFutbinCollectorProfile");

let cursor = 0;
let cycleCount = 0;
 mkdirSync(LOG_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function log(message, extra = null) {
  const line = `[${nowIso()}] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
  appendFileSync(join(LOG_DIR, "futbin-brave-collector.log"), line, "utf8");
}

function writeStatus(status) {
  writeFileSync(STATE_FILE, JSON.stringify({
    version: "1.1.0",
    host: HOST,
    port: PORT,
    intervalMinutes: Math.round(INTERVAL_MS / 60_000),
    maxCards: MAX_CARDS,
    updatedAt: nowIso(),
    ...status
  }, null, 2), "utf8");
}

function readStatus() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const error = new Error(`HTTP_${response.status}`);
      error.status = response.status;
      error.payload = json;
      throw error;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function bravePath() {
  const candidates = [
    process.env.BRAVE_PATH,
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe")
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}
async function debugReady() {
  try {
    const json = await fetchJson(`http://127.0.0.1:${PORT}/json/version`, {}, 2500);
    return Boolean(json?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

async function ensureBrave() {
  if (await debugReady()) return true;
  const exe = bravePath();
  if (!exe) throw new Error("BRAVE_NOT_FOUND");
  mkdirSync(PROFILE_DIR, { recursive: true });
  const shortcut = join(dirname(PROFILE_DIR), `brave-futbin-collector-${PORT}.lnk`);
  const launcher = join(ROOT, "startFutbinBraveBrowser.ps1");
  const launched = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", launcher,
    "-Port", String(PORT),
    "-BravePath", exe,
    "-ProfileDir", PROFILE_DIR,
    "-ShortcutPath", shortcut
  ], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
  if (launched.status !== 0) throw new Error("BRAVE_LAUNCHER_FAILED");
  for (let i = 0; i < 30; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (await debugReady()) return true;
  }
  throw new Error("BRAVE_DEBUG_NOT_READY");
}

async function closeCollectorBrave() {
  if (!CLOSE_AFTER_CYCLE) return;
  let version = null;
  try {
    version = await fetchJson(`http://127.0.0.1:${PORT}/json/version`, {}, 2500);
  } catch {
    return;
  }
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl || typeof WebSocket !== "function") return;

  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 5000);
    try {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        try { ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); }
        catch { finish(); }
      };
      ws.onmessage = finish;
      ws.onclose = finish;
      ws.onerror = finish;
    } catch {
      finish();
    }
  });

  for (let i = 0; i < 20; i += 1) {
    if (!(await debugReady())) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function actionPriority(action) {
  const v = String(action || "").toUpperCase();
  if (v.includes("BUY")) return 900;
  if (v.includes("SELL")) return 700;
  if (v.includes("WAIT") || v.includes("WARTEN")) return 250;
  return 0;
}

function collectorScore(row) {
  return (row?.tracked ? 5000 : 0)
    + (row?.intensiveWatch ? 4500 : 0)
    + actionPriority(row?.aiAction)
    + Math.max(0, Number(row?.aiConfidence || 0)) * 8
    + Math.max(0, Number(row?.overall || row?.rating || 0)) * 12;
}

export function selectCollectorCards(rows = [], options = {}) {
  const maxCards = Math.max(1, Math.min(12, Number(options.maxCards || MAX_CARDS)));
  const startCursor = Math.max(0, Number(options.cursor || 0));
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter(row => Number(row?.price) > 0)
    .filter(row => Number(row?.overall || row?.rating || 0) >= 82)
    .filter(row => Number(FUTBIN_FC27_EA_TO_ID[String(row?.eaId)]) > 0)
    .map(row => ({ ...row, _collectorScore: collectorScore(row) }))
    .sort((a, b) => b._collectorScore - a._collectorScore);

  const pinned = eligible.filter(row => row.tracked || row.intensiveWatch || /BUY|SELL/i.test(String(row.aiAction || ""))).slice(0, Math.min(2, maxCards));
  const pinnedIds = new Set(pinned.map(row => String(row.eaId)));
  const rotatingPool = eligible.filter(row => !pinnedIds.has(String(row.eaId)));
  const needed = Math.max(0, maxCards - pinned.length);
  const rotating = [];
  if (rotatingPool.length && needed > 0) {
    for (let i = 0; i < Math.min(needed, rotatingPool.length); i += 1) {
      rotating.push(rotatingPool[(startCursor + i) % rotatingPool.length]);
    }
  }

  const cards = [...pinned, ...rotating].map(row => ({
    eaId: String(row.eaId),
    futbinId: Number(FUTBIN_FC27_EA_TO_ID[String(row.eaId)]),
    name: row.name || null,
    overall: Number(row.overall || row.rating || 0) || null,
    cardType: row.cardType || row.rarityName || null,
    brainPrice: Number(row.price) || null,
    brainAction: row.aiAction || null,
    brainConfidence: Number(row.aiConfidence) || null
  }));

  const nextCursor = rotatingPool.length
    ? (startCursor + Math.max(1, rotating.length)) % rotatingPool.length
    : 0;

  return { cards, eligibleCount: eligible.length, nextCursor };
}
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const oldPid = Number(readFileSync(LOCK_FILE, "utf8"));
      if (Number.isInteger(oldPid) && oldPid > 0) {
        try {
          process.kill(oldPid, 0);
          throw new Error(`COLLECTOR_ALREADY_RUNNING_${oldPid}`);
        } catch (error) {
          if (String(error?.message || error).startsWith("COLLECTOR_ALREADY_RUNNING_")) throw error;
          try { unlinkSync(LOCK_FILE); } catch {}
        }
      }
    }
    const fd = openSync(LOCK_FILE, "wx");
    writeFileSync(fd, String(process.pid), "utf8");
    closeSync(fd);
  } catch (error) {
    if (String(error?.code || "") === "EEXIST") throw new Error("COLLECTOR_LOCKED");
    throw error;
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_FILE); } catch {}
}

async function loadBrainRows() {
  const transientStatuses = new Set([404, 502, 503, 504]);
  const retryDelaysMs = [0, 1500, 3500];

  // Collector input must stay lightweight. The full trading route serializes
  // the complete Full-Brain payload and can spike the constrained Hostless process.
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
    }

    try {
      const market = await fetchJson(
        `${HOST}/api/market/v1/cards?minRating=82&maxRating=99&limit=100&sort=activity`,
        {},
        20_000
      );
      if (market?.ok && Array.isArray(market?.rows) && market.rows.length) {
        return market.rows.map(row => ({
          ...row,
          overall: Number(row?.overall || row?.rating || 0) || null
        }));
      }
    } catch (error) {
      const status = Number(error?.status);
      if (!transientStatuses.has(status)) throw error;
      log("brain-market-retry", {
        reason: `OWN_MARKET_API_${status || "TRANSIENT"}`,
        attempt: attempt + 1
      });
    }
  }

  throw new Error("BRAIN_INPUT_TEMPORARILY_UNAVAILABLE");
}
export function snapshotRowsFromResults(cards, results) {
  const rows = [];
  for (const card of cards) {
    const result = results?.get?.(String(card.eaId));
    const observedAt = result?.observedAtConsole || result?.observedAtPc || result?.checked || null;
    const priceConsole = Number(result?.priceConsole || 0);
    const pricePc = Number(result?.pricePc || 0);
    if (!(priceConsole > 0 || pricePc > 0) || !observedAt || !(Number(result?.id) > 0)) continue;
    rows.push({
      futbinId: Number(result.id),
      observedAt,
      name: result.name || card.name || "",
      rating: Number(result.rating || card.overall || 0) || null,
      priceConsole: priceConsole > 0 ? priceConsole : null,
      pricePc: pricePc > 0 ? pricePc : null,
      popularRank: Number.isFinite(Number(result.popularRank)) ? Number(result.popularRank) : null,
      gamesPlayedConsole: Number.isFinite(Number(result.gamesPlayedConsole)) ? Number(result.gamesPlayedConsole) : null,
      gamesPlayedPc: Number.isFinite(Number(result.gamesPlayedPc)) ? Number(result.gamesPlayedPc) : null,
      salesEvidence: result?.evidence ? {
        rowCount: result.evidence.futbinSalesRowCount,
        soldSampleCount: result.evidence.futbinSoldSampleCount,
        listedSampleCount: result.evidence.futbinListedSampleCount,
        unsoldSampleCount: result.evidence.futbinUnsoldSampleCount,
        soldPriceMedian: result.evidence.futbinSoldPriceMedian,
        soldPriceP25: result.evidence.futbinSoldPriceP25,
        soldPriceP75: result.evidence.futbinSoldPriceP75,
        soldPriceMin: result.evidence.futbinSoldPriceMin,
        soldPriceMax: result.evidence.futbinSoldPriceMax,
        soldPriceMode: result.evidence.futbinSoldPriceMode,
        salesEvidenceScore: result.evidence.futbinSalesEvidenceScore,
        soldPremiumPctVsLive: result.evidence.futbinSoldPremiumPctVsLive,
        latestSoldAt: result.evidence.futbinLatestSoldAt
      } : null
    });
  }
  return rows;
}

async function pushSnapshot(rows) {
  if (!TOKEN) throw new Error("FUTBIN_SNAPSHOT_INGEST_TOKEN_MISSING");
  if (!rows.length) return { ok: true, inserted: 0, received: 0 };
  return await fetchJson(`${HOST}/api/futbin-fc27-snapshot`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-futbin-ingest-token": TOKEN
    },
    body: JSON.stringify({ rows })
  }, 20_000);
}
export async function runCollectorCycle() {
  cycleCount += 1;
  const startedAt = nowIso();
  try {
    const brainRows = await loadBrainRows();
    const selection = selectCollectorCards(brainRows, { maxCards: MAX_CARDS, cursor });
    cursor = selection.nextCursor;

    if (!selection.cards.length) {
      const status = { ok: true, cycleCount, startedAt, finishedAt: nowIso(), eligibleCount: selection.eligibleCount, selected: 0, inserted: 0, nextCursor: cursor, browserClosedAfterCycle: CLOSE_AFTER_CYCLE, reason: "NO_ELIGIBLE_CARDS" };
      writeStatus(status);
      log("cycle-no-eligible", status);
      return status;
    }

    await closeCollectorBrave();
    await ensureBrave();

    const collect = () => getFutbinBraveCards(selection.cards, "console", {
      force: true,
      gameYear: 27,
      port: PORT,
      maxCards: MAX_CARDS,
      pageWaitMs: PAGE_WAIT_MS,
      spacingMs: SPACING_MS,
      includeSalesHistory: true
    });
    let brave = await collect();
    const retryableBrowserError = /terminated|BRAVE_DEBUG|ECONNREFUSED|fetch failed|WEBSOCKET/i.test(String(brave?.reason || ""));
    const blocked = /BLOCK|HTTP_40[13]|HTTP_429|CAPTCHA/i.test(String(brave?.reason || ""));
    if (!brave?.ok && retryableBrowserError && !blocked) {
      await ensureBrave();
      brave = await collect();
    }
    if (!brave?.ok && !brave?.results?.size) throw new Error(brave?.reason || "BRAVE_COLLECTOR_FAILED");

    let salesEvidenceCards = 0;
    let salesEvidenceRows = 0;
    let unsoldEvidenceRows = 0;
    if (SALES_CARDS_PER_CYCLE > 0 && brave?.results?.size) {
      const salesCards = selection.cards.slice(-SALES_CARDS_PER_CYCLE);
      try {
        const salesPass = await getFutbinBraveCards(salesCards, "console", {
          force: true,
          gameYear: 27,
          port: PORT,
          maxCards: salesCards.length,
          pageWaitMs: PAGE_WAIT_MS,
          spacingMs: SPACING_MS,
          includeSalesHistory: true
        });
        for (const card of salesCards) {
          const salesValue = salesPass?.results?.get?.(String(card.eaId));
          if (!salesValue?.evidence || !(Number(salesValue.evidence.futbinSalesRowCount) > 0)) continue;
          const baseValue = brave.results.get(String(card.eaId)) || {};
          brave.results.set(String(card.eaId), { ...baseValue, ...salesValue });
          salesEvidenceCards += 1;
          salesEvidenceRows += Number(salesValue.evidence.futbinSalesRowCount || 0);
          unsoldEvidenceRows += Number(salesValue.evidence.futbinUnsoldSampleCount || 0);
        }
      } catch (error) {
        log("sales-evidence-soft-fail", { error: String(error?.message || error) });
      }
    }

    const rows = snapshotRowsFromResults(selection.cards, brave.results);
    const pushed = await pushSnapshot(rows);
    const status = {
      ok: true,
      cycleCount,
      startedAt,
      finishedAt: nowIso(),
      eligibleCount: selection.eligibleCount,
      selected: selection.cards.length,
      observedRows: rows.length,
      inserted: Number(pushed?.inserted || 0),
      received: Number(pushed?.received || 0),
      salesEvidenceCards,
      salesEvidenceRows,
      unsoldEvidenceRows,
      salesEvidencePersisted: Number(pushed?.salesEvidencePersisted || 0),
      salesEvidencePersistenceVerified:
        salesEvidenceCards === 0 || Number(pushed?.salesEvidencePersisted || 0) >= salesEvidenceCards,
      nextCursor: cursor,
      browserClosedAfterCycle: CLOSE_AFTER_CYCLE,
      lastCards: rows.map(row => ({ futbinId: row.futbinId, name: row.name, priceConsole: row.priceConsole, observedAt: row.observedAt }))
    };
    writeStatus(status);
    log("cycle-ok", { selected: status.selected, observedRows: status.observedRows, inserted: status.inserted });
    return status;
  } catch (error) {
    const status = {
      ok: false,
      cycleCount,
      startedAt,
      finishedAt: nowIso(),
      error: String(error?.message || error)
    };
    writeStatus(status);
    log("cycle-error", { error: status.error });
    return status;
  } finally {
    await closeCollectorBrave();
  }
}
function enabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.FUTBIN_BRAVE_COLLECTOR_ENABLED || "").trim().toLowerCase());
}

export function getCollectorStatus() {
  return readStatus();
}

async function sleep(ms) {
  return await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const once = process.argv.includes("--once");
  acquireLock();
  const previous = readStatus();
  cursor = Math.max(0, Number(previous?.nextCursor || 0));

  const cleanup = () => {
    releaseLock();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  if (!once && !enabled()) {
    writeStatus({ ok: false, disabled: true, reason: "FUTBIN_BRAVE_COLLECTOR_DISABLED" });
    releaseLock();
    return;
  }
  if (!TOKEN) {
    writeStatus({ ok: false, reason: "FUTBIN_SNAPSHOT_INGEST_TOKEN_MISSING" });
    releaseLock();
    if (once) process.exitCode = 1;
    return;
  }

  if (once) {
    const result = await runCollectorCycle();
    releaseLock();
    if (!result.ok) process.exitCode = 1;
    return;
  }

  log("collector-start", { pid: process.pid, intervalMinutes: Math.round(INTERVAL_MS / 60_000), maxCards: MAX_CARDS });
  while (true) {
    const result = await runCollectorCycle();
    await sleep(result.ok ? INTERVAL_MS : Math.min(INTERVAL_MS, 5 * 60_000));
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invoked && import.meta.url === invoked) {
  main().catch(error => {
    writeStatus({ ok: false, fatal: true, error: String(error?.message || error) });
    log("collector-fatal", { error: String(error?.message || error) });
    releaseLock();
    process.exitCode = 1;
  });
}

