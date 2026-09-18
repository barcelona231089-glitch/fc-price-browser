import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchServer as patchServerV1064 } from '../v1064Loader.mjs';
import { patchRatingOnly } from '../v1065Loader.mjs';

test('v10.65 combined loader is syntactically valid and hard-locks Discord to Full-Brain final rating BUY/SELL', () => {
  const source = `
import { createHaCoordinator } from "./haCoordinator.js";
const GAME_YEAR = "26";
const app = { get(){}, post(){} };
const dbEnabled = false;
const pool = null;
const HA_ENABLED = false;
const latestTradingRows = [];
const latestRatingStats = {};
const latestSourceHealth = {};
const latestProcessingHealth = {};
const discordClientReady = false;
const discordResolvedChannelName = null;
const traderSignalResolvedChannelName = null;
const built = { brainWork: new Map() };
const cycleAlertBudget = {};
const item = { kind: "rating" };
const stat = { rating: 86, marketAdvice: "JETZT KAUFEN", marketSignal: "KAUFZONE", fullBrainFinalAction: null };
globalThis.__discordDelivered = null;
function haIsLeader(){ return true; }
function getUvRuntimeStatus(){ return {}; }
function getGeminiQuotaInfo(){ return {}; }
function buildRatingDiscordPayload(){ return { embeds: [{ title: "86ER KAUFZONE" }] }; }
async function processIntensiveWatchAlerts(){}
async function processTraderConfluenceAlerts(){}
async function processBrainStateChangeAlerts(){}
async function processDiscordAlerts(){}
async function initDb(){}
async function initializeRuntime() { try { await initDb(); } catch (error) {} }
async function enrichImportantRowsWithFutbinParse(rows, brainWork) { if (!rows) return 0; return 1; }
let previousSourceHealthStatus = "STARTING";
async function notifySourceHealthTransition(snapshot, alertBudget = null) {
  const current = String(snapshot?.status || "UNKNOWN");
  const previous = previousSourceHealthStatus;
  previousSourceHealthStatus = current;
  if (current === previous) return;
  return true;
}
async function sendDiscordPayload(payload) {
  if (HA_ENABLED && !haIsLeader()) throw new Error("HA_STANDBY: Discord send blocked on passive instance");
  globalThis.__discordDelivered = payload;
  return payload;
}
async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (false) return;
      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);
      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);
      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);
      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);
}
async function alertLoop(){
  globalThis.__discordDelivered = null;
  for (const item of [{ kind: "card" }, { kind: "rating" }]) {
      if (item.kind === "card") { console.log('card'); }
  }
        await sendDiscordPayload(buildRatingDiscordPayload(stat));
  return globalThis.__discordDelivered;
}
const geminiQuota = { geminiQuota: getGeminiQuotaInfo(), };
app.get("/api/trader-brain/status", (req, res) => { res.json?.({ geminiQuota: getGeminiQuotaInfo() }); });
const endpoints = { traderBrainStatus: "GET /api/trader-brain/status", };
console.log(\`FC Trading Intelligence v10.61 AI Direction Consensus + Sheriff Multi-Source (FC\${GAME_YEAR}) running on \${8000}\`);

const __blocked = await alertLoop();
stat.fullBrainFinalAction = "KAUFEN";
const __allowed = await alertLoop();
console.log("V1065_REGRESSION:" + JSON.stringify({ blocked: __blocked, allowed: __allowed }));
`;

  const base = patchServerV1064(source).source;
  const patched = patchRatingOnly(base).source;

  assert.match(patched, /v10\.65 FINAL RATING-ONLY Discord choke point/);
  assert.match(patched, /__v1065RatingOnly: true/);
  assert.match(patched, /v10\.65 hard player-card public block/);
  assert.match(patched, /v10\.65 source-health Discord disabled/);
  assert.match(patched, /previousSourceHealthStatus = current;\n  \/\/ v10\.65 source-health Discord disabled/);
  assert.doesNotMatch(patched, /await processIntensiveWatchAlerts\(latestTradingRows/);
  assert.doesNotMatch(patched, /await processTraderConfluenceAlerts\(latestTradingRows/);
  assert.doesNotMatch(patched, /await processBrainStateChangeAlerts\(latestTradingRows/);
  assert.match(patched, /🟢 KAUFEN:/);
  assert.match(patched, /🔴 VERKAUFEN:/);
  assert.match(patched, /const f = String\(stat\.fullBrainFinalAction \|\| ""\)\.toUpperCase\(\)/);
  assert.doesNotMatch(patched, /const a = String\(stat\.marketAdvice/);
  assert.doesNotMatch(patched, /m === "KAUFZONE"/);
  assert.doesNotMatch(patched, /m === "VERKAUFSZONE"/);

  const fixturePath = join(tmpdir(), 'v1065-patched-fixture.mjs');
  writeFileSync(fixturePath, patched);
  const check = spawnSync(process.execPath, ['--check', fixturePath], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  try {
    const actionMatch = patched.match(/__v1065Action:\s*\(\(\)\s*=>\s*\{([\s\S]*?)\}\)\(\)/);
    assert.ok(actionMatch, 'Injected Full-Brain Discord action resolver missing');
    const resolveAction = new Function('stat', actionMatch[1]);

    // Core regression: market advice/signal alone must never become a Discord trade action.
    assert.equal(resolveAction({
      marketAdvice: 'JETZT KAUFEN',
      marketSignal: 'KAUFZONE',
      fullBrainFinalAction: null
    }), '');

    // Only the explicit Full-Brain final action may pass.
    assert.equal(resolveAction({ fullBrainFinalAction: 'KAUFEN' }), 'KAUFEN');
    assert.equal(resolveAction({ fullBrainFinalAction: 'VERKAUFEN' }), 'VERKAUFEN');

    // Final choke point consumes only the normalized injected action.
    assert.match(patched, /const __v1065Buy = __v1065ActionText === "KAUFEN"/);
    assert.match(patched, /const __v1065Sell = __v1065ActionText === "VERKAUFEN"/);
  } finally {
    try { unlinkSync(fixturePath); } catch {}
  }
});
