import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchPermanentMlWalkForwardGateV1069967 } from '../v1069967WalkForwardGateLoader.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(root, 'v1069965LeakHotfixL7Bootstrap.mjs'), 'utf8');
const memoryLoader = fs.readFileSync(path.join(root, 'v1069968TradeMemoryV11Loader.mjs'), 'utf8');

test('public leak timestamps fail closed when event time is unknown', () => {
  assert.match(server, /skipReason: "UNKNOWN_TIME"/);
  assert.match(server, /cycle\.skippedUnknownTime \+= 1;\s*continue;/);
  assert.doesNotMatch(server, /sourceEventAt\)\) \? Number\(post\.sourceEventAt\) : now/);
});

test('FC27 source health scores main 82+ market and keeps a real-data floor', () => {
  assert.match(server, /GAME_YEAR_NUMBER >= 27[\s\S]*allCards\.filter\(card => Number\(card\?\.overall\) >= MAIN_RATING_MIN\)/);
  assert.match(server, /Math\.max\(100, Math\.min\(SOURCE_HEALTH_MIN_ROWS/);
  assert.match(server, /status = "DEGRADED"/);
});
test('strict BUY guard requires independent recovery evidence', () => {
  assert.match(server, /STRICT_BUY_RECOVERY_CYCLES/);
  assert.match(server, /duplicateShortHorizons/);
  assert.match(server, /brokeConfirmedFloor/);
  assert.match(server, /historicalConfidenceCap/);
  assert.match(server, /FUTBIN-Cross-Check/);
});

test('SELL performance history can only downgrade exits', () => {
  assert.match(server, /PERFORMANCE_LAB_SELL_REVIEW_ACCURACY/);
  assert.match(server, /PERFORMANCE_LAB_SELL_BLOCK_ACCURACY/);
  assert.match(server, /row\.aiAction = "HALTEN"/);
  assert.match(server, /originalAction === "JETZT VERKAUFEN"[\s\S]*row\.aiAction = performanceAction\("JETZT VERKAUFEN"\)/);
});

test('walk-forward loader patches production gate and blocks decision models by default', () => {
  const src = fs.readFileSync(path.join(root, 'permanentMlBrainV106996.js'), 'utf8');
  const out = patchPermanentMlWalkForwardGateV1069967(src);
  assert.match(out, /walkForwardProductionGate: true/);
  assert.match(out, /stableRuntimeFamilies: \["cycle_24h", "cycle_7d"\]/);
  assert.match(out, /PERMANENT_ML_ENABLE_DECISION_MODELS/);
  assert.match(out, /PERMANENT_ML_VERSION = "10\.69\.9\.6\.7"/);
});
test('Trade-Memory v11 is registered with FC-year separation and real-outcome persistence', () => {
  assert.match(bootstrap, /v1069968TradeMemoryV11Loader\.mjs/);
  assert.match(memoryLoader, /TRADE_MEMORY_V11_VERSION = "11\.0\.1"/);
  assert.match(memoryLoader, /fc_trade_memory_v11/);
  assert.match(memoryLoader, /GAME_YEAR, HISTORICAL_LEARNING_MAX_ROWS/);
  assert.match(memoryLoader, /addBrainLearningSample\(\s*regimeRaw,/);
  assert.match(memoryLoader, /memoryAloneCannotTriggerBuy: true/);
  assert.match(memoryLoader, /repeatedBadCardHistoryCanBlockOrDelayBuy: true/);
});


test('decision model label is bounded to PostgreSQL varchar(120) at the DB edge', () => {
  assert.match(server, /String\(decision\.ai_model_used \|\| "Quantitative Core"\)\.slice\(0, 120\)/);
  assert.match(server, /JSON\.stringify\(decision\)/);
});
test('npm test includes the Trader regression directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /test\/\*\.test\.mjs/);
});

test('FC27 season firewall isolates operational live state from FC26 legacy state', () => {
  for (const table of [
    'fc_live_price_history_v2',
    'fc_live_price_state_v2',
    'fc_positions_v2',
    'fc_brain_state_v2',
    'fc_intensive_watchlist_v2',
    'fc_discord_alert_state_v2'
  ]) assert.match(server, new RegExp(table));

  assert.doesNotMatch(server, /FROM fc_price_history\b/);
  assert.doesNotMatch(server, /INSERT INTO fc_price_history\b/);
  assert.doesNotMatch(server, /FROM fc_price_state\b/);
  assert.doesNotMatch(server, /FROM fc_positions\b/);
  assert.doesNotMatch(server, /FROM fc_brain_state\b/);
  assert.doesNotMatch(server, /FROM fc_intensive_watchlist\b/);
  assert.doesNotMatch(server, /FROM fc_discord_alert_state\b/);

  assert.match(server, /COALESCE\(NULLIF\(d\.input_snapshot->>'gameYear',''\), '26'\) = \$2/);
  assert.match(server, /COALESCE\(NULLIF\(input_snapshot->>'gameYear',''\), '26'\) = \$3/);
  assert.match(server, /ON CONFLICT \(game_year, ea_id\)/);
  assert.match(server, /ON CONFLICT \(game_year, alert_key\)/);
});
