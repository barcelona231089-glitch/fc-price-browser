import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { patchServer } from '../v1064Loader.mjs';

test('v10.64 loader produces syntactically valid patched server around production anchors', () => {
  const source = `
import { createHaCoordinator } from "./haCoordinator.js";
const GAME_YEAR = "26";
const app = { get(){}, post(){} };
const dbEnabled = false;
const pool = null;
const HA_ENABLED = false;
const latestTradingRows = [];
const latestSourceHealth = {};
const latestProcessingHealth = {};
const discordClientReady = false;
const discordResolvedChannelName = null;
const traderSignalResolvedChannelName = null;
function haIsLeader(){ return true; }
function getUvRuntimeStatus(){ return {}; }
function getGeminiQuotaInfo(){ return {}; }
async function initDb(){}
async function initializeRuntime() {
  try {
    await initDb();
  } catch (error) {}
}
async function enrichImportantRowsWithFutbinParse(rows, brainWork) {
  if (!rows) return 0;
  return 1;
}
async function sendDiscordPayload(payload) {
  if (HA_ENABLED && !haIsLeader()) throw new Error("HA_STANDBY: Discord send blocked on passive instance");
  return {};
}
async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (false) return;
}
const geminiQuota = { geminiQuota: getGeminiQuotaInfo(), };
app.get("/api/trader-brain/status", (req, res) => {
  res.json?.({ geminiQuota: getGeminiQuotaInfo() });
});
const endpoints = {
      traderBrainStatus: "GET /api/trader-brain/status",
};
console.log(\`FC Trading Intelligence v10.61 AI Direction Consensus + Sheriff Multi-Source (FC\${GAME_YEAR}) running on \${8000}\`);
`;
  const patched = patchServer(source);
  assert.equal(patched.changed, true);
  assert.match(patched.source, /adaptiveBrainV1064/);
  assert.match(patched.source, /futbinMarketV1064/);
  assert.match(patched.source, /api\/final-project\/status/);
  assert.match(patched.source, /api\/market\/source-health/);
  assert.match(patched.source, /api\/market\/overview/);
  assert.match(patched.source, /api\/market\/events/);
  assert.match(patched.source, /api\/market\/regimes/);
  assert.match(patched.source, /v10\.64 Parse provider disabled/);
  const path = '/tmp/v1064-patched-fixture.mjs';
  writeFileSync(path, patched.source);
  const check = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  try {
    assert.equal(check.status, 0, check.stderr || check.stdout);
  } finally {
    try { unlinkSync(path); } catch {}
  }
});
