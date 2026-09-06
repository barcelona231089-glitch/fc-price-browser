import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uvRoot = path.resolve(here, '..');
const projectRoot = path.resolve(uvRoot, '..');
const uvApp = fs.readFileSync(path.join(uvRoot, 'uvApp.js'), 'utf8');
const ui = fs.readFileSync(path.join(uvRoot, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(uvRoot, 'public', 'index.html'), 'utf8');
const trader = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');

test('combined build exposes only namespaced UV API routes', () => {
  for (const route of [
    '/api/uv/status', '/api/uv/generate', '/api/uv/history', '/api/uv/feedback',
    '/api/uv/target-learning/status', '/api/uv/list/:listId', '/api/uv/recheck/:listId', '/api/uv/recheck-job/:jobId', '/api/uv/rebalance/:listId'
  ]) assert.ok(uvApp.includes(route), route);
  assert.equal(/app\.(?:get|post|delete|put|patch)\('\/api\/(?!uv\/)/.test(uvApp), false);
});

test('UV browser UI uses the production /api/uv namespace and /uv assets', () => {
  assert.ok(ui.includes("fetch('/api/uv/status')"));
  assert.ok(ui.includes("fetch('/api/uv/generate'"));
  assert.equal(ui.includes("fetch('/api/status')"), false);
  assert.ok(html.includes('href="/uv/styles.css"'));
  assert.ok(html.includes('src="/uv/app.js"'));
});

test('compact UV UI exposes status filters, essential columns and recheck-aware pricing', () => {
  for (const status of ['KEEP','REPRICE','WAIT','DROP','MISSING']) assert.ok(html.includes(`data-status=\"${status}\"`), status);
  for (const label of ['Spieler / Version','Kaufen max','Start','Sofortkauf','Netto-Profit','Marktpreis','Qualität / Risiko']) assert.ok(html.includes(label), label);
  assert.ok(ui.includes('fresh.recommendedBuyPrice'));
  assert.ok(ui.includes('fresh.startPrice'));
  assert.ok(ui.includes('fresh.sellPrice'));
  assert.ok(ui.includes("['WAIT','DROP','MISSING'].includes(status)"));
  assert.ok(ui.includes("lastCheckedListId=lastListId"));
});

test('Trader Brain mounts UV and shares the existing PostgreSQL pool', () => {
  assert.ok(trader.includes('app.use(uvRouter);'));
  assert.ok(trader.includes('sharedPool: pool'));
  assert.ok(trader.includes('marketProvider: getSharedMarketForUv'));
  assert.ok(trader.includes('await shutdownUvBrain()'));
});

test('console UV uses the shared Trader snapshot, with recent-safe recovery only for generation', () => {
  assert.ok(uvApp.includes("error.code = 'UV_SHARED_MARKET_NOT_READY'"));
  assert.ok(uvApp.includes("allowRecentSafeSnapshot: true"));
  assert.ok(trader.includes('source?.status === "RECOVERING"'));
  assert.ok(trader.includes('UV_SHARED_SAFE_SNAPSHOT_MAX_AGE_MS = 5 * 60_000'));
  assert.ok(trader.includes('requiresLiveRecheck: !liveAllowed'));
  const sharedBranch = uvApp.slice(uvApp.indexOf("if (normalized === 'console'"), uvApp.indexOf('return fetchLiveFutggCards(normalized);') + 40);
  assert.ok(sharedBranch.includes("throw error"));
});

test('v2.3.6 background history defers transient shared-snapshot recovery without weakening strict-live writes', () => {
  assert.ok(uvApp.includes("error?.code === 'UV_SHARED_MARKET_NOT_READY'"));
  assert.ok(uvApp.includes('scheduleHistoryMonitorRetry()'));
  assert.ok(uvApp.includes('lastHistoryMonitorDeferredReason'));
  assert.ok(uvApp.includes('consideredCards: lastHistoryMonitorConsideredCards'));
  const historyStart = uvApp.indexOf('async function runHistoryMonitorOnce()');
  const historyEnd = uvApp.indexOf('function startHistoryMonitor()', historyStart);
  const historyBlock = uvApp.slice(historyStart, historyEnd);
  assert.ok(historyBlock.includes('getLiveFutggCards(platform);'));
  assert.equal(historyBlock.includes('allowRecentSafeSnapshot: true'), false);
});

test('Trader v10.61 core routes and startup identity remain present', () => {
  for (const route of ['/api/readiness', '/api/trading', '/api/trader-brain/status', '/api/discord/status']) {
    assert.ok(trader.includes(route), route);
  }
  assert.ok(trader.includes('FC Trading Intelligence v10.61 AI Direction Consensus + Sheriff Multi-Source'));
});

test('UV production status keeps external trader picks disabled and Bronze hard-blocked', () => {
  assert.ok(uvApp.includes('verifiedPublicUvMethodConsensus: true'));
  assert.ok(uvApp.includes('externalTraderPlayerPicksImported: false'));
  assert.ok(uvApp.includes('bronzeHardBlock: true'));
  assert.ok(uvApp.includes('normalCardMinimumRating: 82'));
  assert.ok(uvApp.includes('specialBelow82StrongDemandOnly: true'));
  assert.ok(uvApp.includes('nonRareDemandGate: true'));
  assert.ok(uvApp.includes('lowNonRareRatingHardBlockMax: 82'));
  assert.ok(ui.includes('NR≤82'));
  assert.ok(uvApp.includes('paidPlayerPicksImported: false'));
  assert.ok(ui.includes("Bronze ${s.currentCapabilities.bronzeHardBlock?'BLOCK':'?'}"));
});

test('v2.3 production status enforces hard 100 slots and sellability-first live evidence', () => {
  assert.match(uvApp, /seasonPhaseRatingGuard:\s*false/);
  assert.match(uvApp, /calendarPhaseContextOnly:\s*true/);
  assert.match(uvApp, /promoMarketAdaptive:\s*true/);
  assert.match(uvApp, /promoInPacksAwareness:\s*true/);
  assert.match(uvApp, /maxExactCardCopies:\s*2/);
  assert.match(uvApp, /dynamicMarketPolicy:\s*true/);
  assert.match(uvApp, /adaptiveSpecialMix:\s*true/);
  assert.match(uvApp, /budgetAwareDynamicRating:\s*true/);
  assert.match(uvApp, /demandGatedRatingRelaxation:\s*true/);
  assert.match(uvApp, /hard100Slots:\s*true/);
  assert.match(uvApp, /sellabilityFirstRanking:\s*true/);
  assert.match(uvApp, /qualityFirstDynamicCount:\s*false/);
  assert.match(uvApp, /dynamicPortfolioSize:\s*false/);
  assert.match(uvApp, /const UV_VERSION = '2\.9\.0'/);
  assert.ok(ui.includes('PROMO + LIVE MARKET'));
  assert.ok(ui.includes('Markt-Regime'));
  assert.ok(ui.includes('Promo-Heat'));
  assert.ok(ui.includes("metric('Slots'"));
  assert.ok(html.includes('Top 100 fürs Budget'));
});


test('v2.2 focus mode keeps header compact and hides deep analytics behind disclosure', () => {
  assert.ok(html.includes('class="topbar"'));
  assert.equal(html.includes('class="hero"'), false);
  assert.ok(html.includes('class="generator panel compactGenerator"'));
  assert.ok(ui.includes('class="summaryPrimary"'));
  assert.ok(ui.includes('class="summaryMore"'));
  assert.ok(ui.includes('<summary>Mehr Analyse</summary>'));
  for (const label of ['Budget','Einkauf','Slots','Specials','Profit 1×']) assert.ok(ui.includes(`metric('${label}'`), label);
});


test('v2.4 saved lists are reopenable and persist the last live recheck', () => {
  const db = fs.readFileSync(path.join(uvRoot, 'src', 'db.js'), 'utf8');
  assert.ok(html.includes('id="savedListSelect"'));
  assert.ok(html.includes('id="loadSavedBtn"'));
  assert.ok(ui.includes("fetch(`/api/uv/history?platform="));
  assert.ok(ui.includes("fetch(`/api/uv/list/${encodeURIComponent(listId)}`"));
  assert.ok(uvApp.includes("app.get('/api/uv/list/:listId'"));
  assert.ok(uvApp.includes('await saveListRecheck(stored.id, rows, recheckSummary, checkedAt)'));
  assert.ok(db.includes('summary_payload JSONB'));
  assert.ok(db.includes('last_recheck_summary JSONB'));
  assert.ok(db.includes('last_recheck JSONB'));
  assert.ok(db.includes('export async function saveListRecheck'));
});

test('v2.4 exposes budget Top-100 ranking without weakening hard 100 or rating floor', () => {
  assert.ok(uvApp.includes('budgetTop100Ranking: true'));
  assert.ok(uvApp.includes('budgetTop100SafetyIsolation: true'));
  assert.ok(uvApp.includes('budgetTop100Score, selectionScore: baseSelectionScore'));
  assert.ok(!uvApp.includes('baseSelectionScore * 0.58 + budgetTop100Score * 0.42'));
  assert.ok(uvApp.includes('savedLists: isDbEnabled()'));
  assert.ok(uvApp.includes('buildBudgetTop100Score'));
  assert.ok(uvApp.includes('normalCardMinimumRating: 82'));
  assert.ok(uvApp.includes('hard100Slots: true'));
  assert.ok(ui.includes("metric('Top-100 Budget-Score'"));
});


test('v2.7.2 live recheck uses proxy-safe async job polling and batched DB persistence', () => {
  const db = fs.readFileSync(path.join(uvRoot, 'src', 'db.js'), 'utf8');
  assert.ok(uvApp.includes("app.post('/api/uv/recheck/:listId', handleLiveRecheckStart)"));
  assert.ok(uvApp.includes("app.get('/api/uv/recheck-job/:jobId'"));
  assert.ok(uvApp.includes('performLiveRecheck(job.listId, job)'));
  assert.ok(uvApp.includes('liveRecheckAsyncJob: true'));
  assert.ok(ui.includes('startLiveRecheckJob'));
  assert.ok(ui.includes('waitForLiveRecheckJob'));
  assert.ok(ui.includes('/api/uv/recheck-job/'));
  assert.ok(ui.includes('transientFetchErrors < 5'));
  assert.equal(ui.includes('setTimeout(()=>controller.abort(),90000)'), false);
  assert.ok(db.includes('jsonb_to_recordset($2::jsonb)'));
  const saveStart = db.indexOf('export async function saveListRecheck');
  const saveEnd = db.indexOf('export async function loadGeneratedList', saveStart);
  const saveBlock = db.slice(saveStart, saveEnd);
  assert.equal(saveBlock.includes('for (const row'), false);
});


test('v2.7 trader consensus + budget tier allocator combine demand, stability, promo and budget shape', () => {
  assert.ok(uvApp.includes('publicTraderEndgameLogic: true'));
  assert.ok(uvApp.includes('traderConsensusRanker: true'));
  assert.ok(uvApp.includes('endgameLowGoldCaps: true'));
  assert.ok(uvApp.includes('endgame300kBase82Max: 2'));
  assert.ok(uvApp.includes('endgame300kBase83OrLessMax: 8'));
  assert.ok(uvApp.includes('futtiesDemandPriority: true'));
  assert.ok(uvApp.includes('buildTraderConsensusScore'));
  assert.ok(uvApp.includes('budget-top100-v2.7-budget-tier-allocator+trader-consensus'));
  assert.ok(uvApp.includes('budgetTierAllocator: true'));
  assert.ok(uvApp.includes('candidatePoolAllocationSeparation: true'));
  assert.ok(uvApp.includes('buildBudgetTierScore'));
  assert.ok(ui.includes('Ø Budget-Tier'));
  assert.ok(ui.includes('Karten-Version'));
  assert.ok(ui.includes('Ø Trader-Consensus'));
  assert.ok(ui.includes('Consensus-Tags'));
});


test('v2.9 CPU-safe live recheck serializes heavy work and reuses demand cache', () => {
  assert.ok(uvApp.includes('LIVE_RECHECK_QUEUE'));
  assert.ok(uvApp.includes('liveRecheckActiveJobId'));
  assert.ok(uvApp.includes('LIVE_RECHECK_BATCH_SIZE'));
  assert.ok(uvApp.includes('LIVE_RECHECK_BATCH_PAUSE_MS'));
  assert.ok(uvApp.includes('attachCachedFutggDemandSignals'));
  assert.ok(uvApp.includes("job.phase = 'CPU_SAFE_SCORING'"));
  assert.ok(uvApp.includes('await cpuSafePause()'));
  assert.ok(uvApp.includes('if (liveRecheckActiveJobId)'));
  assert.ok(uvApp.includes('liveRecheckCpuSafeQueue: true'));
  assert.ok(ui.includes("data.status === 'QUEUED'"));
  assert.ok(ui.includes('data.processed'));
});

test('v2.9 preserves rating-first manual player-list plan lock', () => {
  assert.ok(uvApp.includes('externalTraderPlayerPicksImported: false'));
  assert.ok(trader.includes('const DISCORD_NAMED_TRADE_OFFERS = false;'));
});
