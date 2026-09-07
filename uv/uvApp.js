import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GAME_YEAR, HISTORY_SAMPLE_LIMIT, HISTORY_MONITOR_MS, HISTORY_MONITOR_MAX_CARDS, HISTORY_HEARTBEAT_MINUTES, LIVE_RECHECK_BATCH_SIZE, LIVE_RECHECK_BATCH_PAUSE_MS, LIVE_RECHECK_MAX_QUEUE, LIVE_RECHECK_JOB_TTL_MS, GENERATION_SCORE_BATCH_SIZE, GENERATION_BATCH_PAUSE_MS, GENERATION_CPU_WINDOW_WAIT_MS } from './src/config.js';
import { getLiveFutggCards as fetchLiveFutggCards } from './src/futgg.js';
import { crosscheckFutbin, getFutbinMarketTrends, attachMarketMoverSignals, getFutbinExtendedDataStatus } from './src/futbin.js';
import { attachFutggDemandSignals, attachCachedFutggDemandSignals } from './src/demand.js';
import { initDb, configureDbPool, closeDb, isDbEnabled, recordSnapshot, upsertCards, loadHistoryFeatures, loadPerformanceFeatures, loadTraderRulePerformance, loadTargetSupportPerformance, recordTradeFeedback, getTradeFeedbackStatus, saveGeneratedList, saveListRecheck, recordMarketSnapshot, recordDemandSnapshot, loadWatchPlatforms, loadWatchedEaIds, recordSmartSnapshot, evaluateGeneratedLists, getLearningStatus, loadGeneratedList, listGeneratedLists } from './src/db.js';
import { buildCandidatePool, scoreCard, buildBuyPlan, buildTradingEconomics, buildSelectionScore, buildSellabilityScore, buildBudgetTop100Score, buildPublicTraderEndgameScore, buildTraderConsensusScore, buildBudgetTierScore, optimizeList, maxAffordablePortfolioCount, filterConservativeCandidates, buildPortfolioSummary, capitalBandForPrice, targetProfitCandidates, specialTargetRatioForBudget } from './src/uvEngine.js';
import { buildRebalanceSeed, rebalancePortfolio } from './src/rebalance.js';
import { buildTraderKnowledge, TRADER_KNOWLEDGE_SOURCES } from './src/traderKnowledge.js';
import { attachTargetLearningProfiles } from './src/targetLearning.js';
import { buildRecommendationLifecycle, recheckRecommendation } from './src/lifecycle.js';
import { runCandidatePipeline, deriveAdaptiveMarketPolicy, buildHard100SellabilityFallback, buildBudgetAdaptiveSellabilityFallback, buildBudgetSafetyReserveFallback } from './src/candidatePipeline.js';
import { buildReportedOutcomeScore } from './src/outcomeLearning.js';

export const uvRouter = express.Router();
const UV_VERSION = '2.9.3';
let uvActive = true;
const app = uvRouter;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: '1mb' }));
app.use('/uv', express.static(path.join(__dirname, 'public')));


let lastGenerationAt = null;
let lastError = null;
let generationBusy = false;
let lastHistoryMonitorAt = null;
let lastHistoryMonitorError = null;
let lastHistoryMonitorCards = 0;
let historyMonitorBusy = false;
let lastDemandContext = null;
let uvStarted = false;
let sharedMarketProvider = null;
let sharedRuntimeProvider = null;
let historyStartTimeoutHandle = null;
let historyIntervalHandle = null;
let historyRetryTimeoutHandle = null;
let lastHistoryMonitorDeferredAt = null;
let lastHistoryMonitorDeferredReason = null;
let lastHistoryMonitorConsideredCards = 0;

// v2.7.2: live rechecks run as short-lived server-side jobs. This avoids keeping
// one HTTP request open while 100 cards are rescored, which some hosting proxies
// terminate with a browser-level "Failed to fetch" even though Node is still working.
const liveRecheckJobs = new Map();
const liveRecheckJobByList = new Map();
const LIVE_RECHECK_QUEUE = [];
let liveRecheckActiveJobId = null;
let liveRecheckCompleted = 0;
let liveRecheckFailed = 0;
let liveRecheckLastDurationMs = null;

function publicLiveRecheckJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    listId: job.listId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    phase: job.phase || null,
    processed: Number(job.processed || 0),
    total: Number(job.total || 0),
    queuePosition: job.status === 'QUEUED' ? Math.max(1, LIVE_RECHECK_QUEUE.indexOf(job.jobId) + 1) : 0,
    result: job.status === 'DONE' ? job.result : null
  };
}

function scheduleLiveRecheckJobCleanup(job) {
  const timer = setTimeout(() => {
    liveRecheckJobs.delete(job.jobId);
    if (liveRecheckJobByList.get(job.listId) === job.jobId) liveRecheckJobByList.delete(job.listId);
  }, LIVE_RECHECK_JOB_TTL_MS);
  timer.unref?.();
}

async function getLiveFutggCards(platform = 'console', options = {}) {
  const normalized = platform === 'pc' ? 'pc' : 'console';
  if (normalized === 'console' && typeof sharedMarketProvider === 'function') {
    const shared = await sharedMarketProvider(normalized, options);
    if (Array.isArray(shared?.cards) && shared.cards.length >= 100) {
      return {
        cards: shared.cards,
        sourceUrl: shared.sourceUrl || 'shared-trader-brain-snapshot',
        updatedAt: shared.updatedAt || new Date().toISOString(),
        sharedSnapshot: true,
        sharedSnapshotMode: shared.sharedSnapshotMode || 'LIVE',
        live: shared.live !== false,
        requiresLiveRecheck: shared.requiresLiveRecheck === true,
        snapshotAgeSeconds: Number.isFinite(Number(shared.snapshotAgeSeconds)) ? Number(shared.snapshotAgeSeconds) : null
      };
    }
    // On the 512 MB Quaxly deployment we deliberately do not build a second
    // full console FUT.GG universe while the Trader Brain snapshot is warming.
    // The caller can retry after the normal Trader monitoring cycle completes.
    const error = new Error('Shared Trader Brain market snapshot is not ready yet.');
    error.code = 'UV_SHARED_MARKET_NOT_READY';
    throw error;
  }
  return fetchLiveFutggCards(normalized);
}



function uvWriteAllowed() { return uvActive === true; }

function requireUvActive(req, res) {
  if (uvWriteAllowed()) return true;
  res.status(503).json({
    ok: false,
    code: 'HA_STANDBY_READ_ONLY',
    error: 'Diese Instanz ist HA-STANDBY. Generierung, Recheck, Rebalance und Feedback sind nur auf dem aktiven Leader erlaubt.'
  });
  return false;
}


function attachPublicTraderProfile(card = {}, budget, count = 100) {
  const profile = buildPublicTraderEndgameScore(card, { budget, count, gameYear: GAME_YEAR });
  const consensus = buildTraderConsensusScore(card, { budget, count, gameYear: GAME_YEAR });
  const tier = buildBudgetTierScore(card, { budget, count, gameYear: GAME_YEAR });
  return {
    ...card,
    publicTraderEndgameScore: profile.score,
    traderEndgameProfileActive: profile.active === true,
    traderEndgamePhase: profile.phase,
    traderEndgameTags: Array.isArray(profile.tags) ? profile.tags : [],
    traderConsensusScore: consensus.score,
    traderConsensusPhase: consensus.phase,
    traderConsensusTags: Array.isArray(consensus.tags) ? consensus.tags : [],
    traderConsensusComponents: consensus.components || null,
    budgetTierScore: tier.score,
    budgetTierProfile: tier.profileName,
    budgetTierReferenceMode: tier.referenceMode,
    budgetTierBand: tier.band,
    budgetTierPriceRatio: tier.priceRatio,
    budgetTierFit: tier.priceTierFit,
    cardVersionClass: tier.versionClass,
    budgetTierTags: Array.isArray(tier.tags) ? tier.tags : []
  };
}

function summarizeSelectedCards(selected, budget, specialTargetRatio = null) {
  const count = selected.length;
  const avg = key => count ? selected.reduce((sum, c) => sum + Number(c?.[key] || 0), 0) / count : 0;
  const totalBuy = selected.reduce((sum, c) => sum + Number(c.buyPrice || c.recommendedBuyPrice || 0), 0);
  const totalExpectedProfit = selected.reduce((sum, c) => sum + Number(c.netProfit || 0), 0);
  return {
    count,
    uniqueCardCount: new Set(selected.map(c => String(c.eaId))).size,
    repeatedSlots: selected.length - new Set(selected.map(c => String(c.eaId))).size,
    maxExactCopies: selected.reduce((max, c) => { const id=String(c.eaId); const n=selected.filter(x=>String(x.eaId)===id).length; return Math.max(max,n); }, 0),
    totalBuy,
    unusedBudget: Number(budget) - totalBuy,
    budgetUsagePct: Number(budget) > 0 ? (totalBuy / Number(budget)) * 100 : 0,
    totalExpectedProfit,
    avgUvScore: avg('uvScore'),
    avgLongTermScore: avg('longTermScore'),
    avgConfidence: avg('confidenceScore'),
    avgActivity: avg('priceActivityScore'),
    avgPopularity: avg('popularityScore'),
    avgTurnoverIndex: avg('turnoverIndex'),
    avgTradeQuality: avg('tradeQualityScore'),
    avgCapitalEfficiency: avg('capitalEfficiencyScore'),
    avgBudgetTop100Score: avg('budgetTop100Score'),
    avgRepeatability: avg('repeatabilityScore'),
    avgLongTermProfitScore: avg('longTermProfitScore'),
    avgTraderPriorScore: avg('traderPriorScore'),
    avgTraderMethodConsensus: avg('traderMethodConsensusIndex'),
    avgSaleLikelihoodIndex: avg('saleLikelihoodIndex'),
    avgCapitalLockRisk: avg('capitalLockRisk'),
    avgTargetSupportScore: count ? selected.reduce((sum, c) => sum + Number(c.targetSupportScore || 50), 0) / count : 0,
    avgDemandDataConfidence: avg('demandDataConfidence'),
    targetLearningMatches: selected.filter(c => Number(c.targetSupportSamples || 0) > 0).length,
    reportedFeedbackMatches: selected.filter(c => Number(c.reportedFeedbackSamples || 0) > 0).length,
    gradeACount: selected.filter(c => ['A+', 'A'].includes(c.qualityGrade)).length,
    weakQualityCount: selected.filter(c => c.qualityGrade === 'D').length,
    demandMatches: selected.filter(c => Number.isFinite(c.usagePct) || c.momentumHit).length,
    communityUsageMatches: selected.filter(c => Number.isFinite(c.communityUsagePct)).length,
    proUsageMatches: selected.filter(c => Number.isFinite(c.proUsagePct)).length,
    multiPositionUsageMatches: selected.filter(c => Number(c.usagePositionCount || 0) >= 2).length,
    inPacksCount: selected.filter(c => c.inPacksHit).length,
    specialCount: selected.filter(c => String(c.cardType || '').toLowerCase() === 'special').length,
    futtiesCount: selected.filter(c => String(c.cardType || '').toLowerCase() === 'special' && `${c.rarityName || ''} ${c.cardName || ''} ${c.version || ''}`.toLowerCase().includes('futties')).length,
    base82Count: selected.filter(c => String(c.cardType || '').toLowerCase() !== 'special' && Number(c.overall) === 82).length,
    base83Count: selected.filter(c => String(c.cardType || '').toLowerCase() !== 'special' && Number(c.overall) === 83).length,
    base84PlusCount: selected.filter(c => String(c.cardType || '').toLowerCase() !== 'special' && Number(c.overall) >= 84).length,
    avgPublicTraderEndgameScore: avg('publicTraderEndgameScore'),
    avgTraderConsensusScore: avg('traderConsensusScore'),
    avgBudgetTierScore: avg('budgetTierScore'),
    budgetTierProfiles: [...new Set(selected.map(c => c.budgetTierProfile).filter(Boolean))],
    specialVersionCount: selected.filter(c => c.cardVersionClass === 'SPECIAL').length,
    normalVersionCount: selected.filter(c => c.cardVersionClass === 'NORMAL').length,
    specialTargetRatio: Number.isFinite(Number(specialTargetRatio)) ? Number(specialTargetRatio) : specialTargetRatioForBudget(Number(budget), count || 100),
    specialTargetCount: Math.round((Number.isFinite(Number(specialTargetRatio)) ? Number(specialTargetRatio) : specialTargetRatioForBudget(Number(budget), count || 100)) * (count || 100)),
    baseRareCount: selected.filter(c => c.cardType === 'Base Rare').length,
    baseCommonCount: selected.filter(c => c.cardType === 'Base Common').length,
    futbinChecked: selected.filter(c => c.futbinChecked).length,
    futbinGamesMatches: selected.filter(c => Number.isFinite(c.futbinGamesCount)).length,
    futbinSalesHistoryMatches: selected.filter(c => Number(c.futbinSoldSampleCount || 0) > 0).length,
    futbinRealSalePriceMatches: selected.filter(c => Number.isFinite(c.futbinSoldPriceMedian)).length,
    avgFutbinGamesScore: selected.filter(c => Number.isFinite(c.futbinGamesScore)).length ? selected.filter(c => Number.isFinite(c.futbinGamesScore)).reduce((sum,c)=>sum+Number(c.futbinGamesScore),0)/selected.filter(c => Number.isFinite(c.futbinGamesScore)).length : 0,
    avgFutbinSalesEvidence: selected.filter(c => Number.isFinite(c.futbinSalesEvidenceScore)).length ? selected.filter(c => Number.isFinite(c.futbinSalesEvidenceScore)).reduce((sum,c)=>sum+Number(c.futbinSalesEvidenceScore),0)/selected.filter(c => Number.isFinite(c.futbinSalesEvidenceScore)).length : 0,
    moverMatches: selected.filter(c => c.marketMover).length,
    lowRiskCount: selected.filter(c => !c.riskFlags?.length).length,
    learningMatches: selected.filter(c => (c.learning?.evalCount || 0) > 0).length,
    avgLearningScore: count ? selected.reduce((sum, c) => sum + Number(c.learningScore || 50), 0) / count : 0,
    portfolio: buildPortfolioSummary(selected, Number(budget), count || 100)
  };
}

app.get('/api/uv/health', (req, res) => res.json({
  ok: true, service: 'FC ÜV Brain', version: UV_VERSION, gameYear: GAME_YEAR,
  database: isDbEnabled() ? 'PostgreSQL' : 'memory/no-db',
  activeInstance: uvActive,
  runtimeMode: uvActive ? 'ACTIVE' : 'HA_STANDBY_READ_ONLY',
  futbinParseConfigured: Boolean(process.env.FUTBIN_PARSE_API_KEY), lastGenerationAt, lastError,
  historyMonitor: {
    enabled: isDbEnabled(),
    busy: historyMonitorBusy,
    lastAt: lastHistoryMonitorAt,
    lastError: lastHistoryMonitorError,
    cards: lastHistoryMonitorCards,
    consideredCards: lastHistoryMonitorConsideredCards,
    deferredAt: lastHistoryMonitorDeferredAt,
    deferredReason: lastHistoryMonitorDeferredReason
  }
}));

app.get('/api/uv/status', (req, res) => {
  const futbinExtended = getFutbinExtendedDataStatus();
  res.json({
    ok: true, version: UV_VERSION, gameYear: GAME_YEAR,
    activeInstance: uvActive,
    runtimeMode: uvActive ? 'ACTIVE' : 'HA_STANDBY_READ_ONLY',
    databaseConfigured: isDbEnabled(), futbinParseConfigured: Boolean(process.env.FUTBIN_PARSE_API_KEY),
    mode: 'external-analysis-only', automation: 'none',
    futbinExtended,
    currentCapabilities: {
      futggLivePrices: true,
      futbinCrosscheck: Boolean(process.env.FUTBIN_PARSE_API_KEY),
      futbinMarketTrends: Boolean(process.env.FUTBIN_PARSE_API_KEY),
      futbinStructuredEvidenceAdapter: true,
      postgresHistory: isDbEnabled(), budgetOptimizer100: true, eaTax: true,
      conservativeProfit: true, longTermScore: true, priceActivityProxy: isDbEnabled(),
      sourceRiskFilter: true, adaptiveCardMix: true, specialCardPriority: true, specialCardSoftTarget300k100: 'promo-live-market-adaptive', seasonPhaseRatingGuard: false, calendarPhaseContextOnly: true, promoMarketAdaptive: true, promoInPacksAwareness: true, promoMomentumAwareness: true, dynamicMarketPolicy: true, budgetAwareDynamicRating: true, demandGatedRatingRelaxation: true, budgetFeasibilityFallback: true, balancedLiquidityFallback: true, qualityFirstDynamicCount: false, dynamicPortfolioSize: false, hard100Slots: true, sellabilityFirstRanking: true, hard100PortfolioSellabilityFallback: true, adaptiveSpecialMix: true, maxExactCardCopies: 2, futggMostUsedDemand: true, futggMomentumDemand: true,
      backgroundHistoryMonitor: isDbEnabled(), selfLearningPriceSafety: isDbEnabled(), smartBuyCeiling: true, qualityFirstOptimizer: true, budgetTop100Ranking: true, budgetTop100SafetyIsolation: true, budgetSafetyReserveFallback: true, publicTraderEndgameLogic: true, traderConsensusRanker: true, budgetTierAllocator: true, candidatePoolAllocationSeparation: true, budgetTierReferenceMode: 'soft-observed-shape-only', ratingAsSecondaryPortfolioSignal: true, cardVersionClassFromItemRecord: true, traderConsensusSources: ['Futpepi-budget-method','FUT.GG-usage-momentum','PostgreSQL-price-stability','FutStarz-demand-window-method','public-popularity-tiebreak'], endgameLowGoldCaps: true, endgame300kBase82Max: 2, endgame300kBase83OrLessMax: 8, futtiesDemandPriority: true, popularLeagueNationTieBreak: true, savedLists: isDbEnabled(), savedListReopen: isDbEnabled(), persistedLiveRecheck: isDbEnabled(), liveRecheckPost: true, liveRecheckAsyncJob: true, liveRecheckCpuSafeQueue: true, generationCpuSafeBatches: true, generationWaitsForIdleCpuWindow: true, optimizerLinearStateCache: true, liveRecheckDemandCacheOnly: true, liveRecheckBatchSize: LIVE_RECHECK_BATCH_SIZE, liveRecheckBatchPauseMs: LIVE_RECHECK_BATCH_PAUSE_MS, batchedRecheckPersistence: isDbEnabled(), currentBuyPricesVisible: true, capitalEfficiencyScore: true, adaptiveCapitalLadder: true, repeatabilityScore: true, longTermProfitRanker: true, portfolioDiagnostics: true, traderKnowledgePriors: true, verifiedPublicUvMethodConsensus: true, externalTraderPlayerPicksImported: false, bronzeHardBlock: true, normalCardMinimumRating: 82, specialBelow82StrongDemandOnly: true, nonRareDemandGate: true, lowNonRareRatingHardBlockMax: 82, midNonRareDemandGateMin: 83, midNonRareDemandGateMax: 84, traderRulePriceSafetyLearning: isDbEnabled(), saleLikelihoodIndex: true, traderAwarePricingOptimizer: true, empiricalTargetSupportLearning: isDbEnabled(), optionalReportedTradeFeedback: isDbEnabled(), listLifecycleGuard: true, liveStoredListRecheck: isDbEnabled(), portfolioRebalancing: isDbEnabled(), reportedOutcomeLearning: isDbEnabled(), robustCandidatePipeline: true, apiNamespaceUv: true, futggUsageAudienceSplit: true, futggUsagePositionBreadth: true, futggInPacksSupply: true, demandEvidenceConfidence: true,
      playerSalesHistory: Boolean(futbinExtended.salesHistoryObserved),
      pgpGames: Boolean(futbinExtended.gamesObserved),
      popularPlayers: Boolean(futbinExtended.gamesObserved || futbinExtended.popularRankObserved),
      observedSalesPerDay: Boolean(futbinExtended.observedSalesPerDayObserved)
    }
  });
});

function scheduleHistoryMonitorRetry(delayMs = 10_000) {
  if (!uvActive || !isDbEnabled() || historyRetryTimeoutHandle) return;
  historyRetryTimeoutHandle = setTimeout(() => {
    historyRetryTimeoutHandle = null;
    runHistoryMonitorOnce();
  }, delayMs);
  historyRetryTimeoutHandle.unref?.();
}

async function runHistoryMonitorOnce() {
  if (!uvActive || !isDbEnabled() || historyMonitorBusy) return;
  if (generationBusy) {
    lastHistoryMonitorDeferredAt = new Date().toISOString();
    lastHistoryMonitorDeferredReason = 'CPU-SAFE: ÜV-Generierung hat Priorität; History-Monitor wird bis danach verschoben.';
    scheduleHistoryMonitorRetry(Math.max(10_000, GENERATION_BATCH_PAUSE_MS * 100));
    return;
  }
  if (liveRecheckActiveJobId) {
    lastHistoryMonitorDeferredAt = new Date().toISOString();
    lastHistoryMonitorDeferredReason = 'CPU-SAFE: Live-Recheck hat Prioritaet; History-Monitor wird bis danach verschoben.';
    scheduleHistoryMonitorRetry(Math.max(10_000, LIVE_RECHECK_BATCH_PAUSE_MS * 20));
    return;
  }
  historyMonitorBusy = true;
  let totalCards = 0;
  let totalConsideredCards = 0;
  try {
    const platforms = await loadWatchPlatforms();
    for (const platform of platforms) {
      const ids = await loadWatchedEaIds(platform, HISTORY_MONITOR_MAX_CARDS);
      if (!ids.length) continue;
      // History remains strict-live. During the short Trader-Brain recovery
      // quarantine we defer instead of turning an expected transient state
      // into a sticky UV error. Generation has its own RECENT_SAFE fallback;
      // recheck/rebalance/history never write stale prices as fresh history.
      const live = await getLiveFutggCards(platform);
      const wanted = new Set(ids.map(String));
      const watched = live.cards.filter(c => wanted.has(String(c.eaId)));
      const saved = await recordSmartSnapshot(watched, platform, HISTORY_MONITOR_MAX_CARDS, HISTORY_HEARTBEAT_MINUTES);
      totalCards += saved.inserted || 0;
      totalConsideredCards += saved.considered || watched.length || 0;
      await evaluateGeneratedLists(platform).catch(() => ({ inserted: 0 }));
    }
    lastHistoryMonitorAt = new Date().toISOString();
    lastHistoryMonitorCards = totalCards;
    lastHistoryMonitorConsideredCards = totalConsideredCards;
    lastHistoryMonitorError = null;
    lastHistoryMonitorDeferredAt = null;
    lastHistoryMonitorDeferredReason = null;
    if (historyRetryTimeoutHandle) {
      clearTimeout(historyRetryTimeoutHandle);
      historyRetryTimeoutHandle = null;
    }
  } catch (error) {
    if (error?.code === 'UV_SHARED_MARKET_NOT_READY') {
      lastHistoryMonitorError = null;
      lastHistoryMonitorDeferredAt = new Date().toISOString();
      lastHistoryMonitorDeferredReason = String(error?.message || error);
      scheduleHistoryMonitorRetry();
    } else {
      lastHistoryMonitorError = String(error?.message || error);
    }
  } finally {
    historyMonitorBusy = false;
  }
}

function startHistoryMonitor() {
  if (!uvActive || !isDbEnabled() || historyIntervalHandle) return;
  historyStartTimeoutHandle = setTimeout(() => runHistoryMonitorOnce(), 8_000);
  historyStartTimeoutHandle.unref?.();
  historyIntervalHandle = setInterval(() => runHistoryMonitorOnce(), HISTORY_MONITOR_MS);
  historyIntervalHandle.unref?.();
}

function stopHistoryMonitor() {
  if (historyStartTimeoutHandle) clearTimeout(historyStartTimeoutHandle);
  if (historyRetryTimeoutHandle) clearTimeout(historyRetryTimeoutHandle);
  if (historyIntervalHandle) clearInterval(historyIntervalHandle);
  historyStartTimeoutHandle = null;
  historyRetryTimeoutHandle = null;
  historyIntervalHandle = null;
}

app.get('/api/uv/learning/status', async (req, res) => {
  try {
    res.json(await getLearningStatus());
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/uv/history', async (req, res) => {
  try {
    const platform = req.query?.platform === 'pc' ? 'pc' : req.query?.platform === 'console' ? 'console' : null;
    const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 25)));
    const lists = await listGeneratedLists(platform, limit);
    res.json({ ok: true, version: UV_VERSION, platform, count: lists.length, lists });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/uv/list/:listId', async (req, res) => {
  try {
    if (!isDbEnabled()) return res.status(503).json({ error: 'PostgreSQL ist fuer gespeicherte Listen erforderlich.' });
    const stored = await loadGeneratedList(req.params.listId);
    const cards = stored.items.map(item => ({
      ...item.payload,
      eaId: item.eaId,
      buyPrice: item.buyPrice,
      recommendedBuyPrice: item.payload?.recommendedBuyPrice ?? item.buyPrice,
      startPrice: item.startPrice,
      sellPrice: item.sellPrice,
      eaTax: item.eaTax,
      netProfit: item.netProfit,
      uvScore: item.uvScore,
      _recheck: item.lastRecheck || null
    }));
    const fallbackMetrics = summarizeSelectedCards(cards, stored.budget);
    const savedSummary = stored.summaryPayload && typeof stored.summaryPayload === 'object' ? stored.summaryPayload : {};
    res.json({
      ...fallbackMetrics,
      ...savedSummary,
      ok: true,
      version: UV_VERSION,
      gameYear: GAME_YEAR,
      listId: stored.id,
      budget: stored.budget,
      platform: stored.platform,
      count: cards.length,
      cardCount: cards.length,
      createdAt: stored.createdAt,
      lastRecheckAt: stored.lastRecheckAt,
      lastRecheckSummary: stored.lastRecheckSummary,
      persistedLiveRecheck: Boolean(stored.lastRecheckAt),
      cards
    });
  } catch (error) {
    res.status(404).json({ error: String(error?.message || error) });
  }
});

app.get('/api/uv/outcome-learning/status', async (req, res) => {
  try {
    const platform = req.query?.platform === 'pc' ? 'pc' : 'console';
    const [profiles, feedback] = await Promise.all([
      loadTargetSupportPerformance(platform),
      getTradeFeedbackStatus(platform)
    ]);
    const learned = [...profiles.values()]
      .filter(row => Number(row.reportedFeedbackSamples || 0) > 0)
      .map(row => ({ ...row, outcome: buildReportedOutcomeScore(row) }))
      .sort((a, b) => Number(b.reportedFeedbackSamples || 0) - Number(a.reportedFeedbackSamples || 0));
    res.json({
      ok: true,
      version: UV_VERSION,
      platform,
      feedback,
      profileCount: learned.length,
      profiles: learned.slice(0, 100),
      semantics: {
        reportedSellRate: 'Nur aus explizit gemeldeten sold/unsold/expired Outcomes; keine allgemeine Markt-Verkaufswahrscheinlichkeit.',
        reportedOutcomeScore: 'Sample-gedaempfter Lernscore aus gemeldeter Verkaufsquote, Relists, realisiertem Netto-Profit und Zeit bis zur Rueckmeldung.',
        salesPerDay: null
      }
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/uv/demand/status', (req, res) => res.json({
  ok: true,
  version: UV_VERSION,
  mode: 'FUT.GG real-usage-demand + momentum + in-packs-supply',
  context: lastDemandContext,
  semantics: {
    usagePercentages: 'real FUT.GG Most Used percentages when matched',
    saleProbability: null,
    salesPerDay: null,
    supplyPressure: 'ordinal risk index from verified In Packs presence, not a sales forecast'
  }
}));

app.get('/api/uv/trader-knowledge/status', async (req, res) => {
  try {
    const platform = req.query?.platform === 'pc' ? 'pc' : 'console';
    const learned = await loadTraderRulePerformance(platform);
    res.json({
      ok: true,
      version: UV_VERSION,
      mode: 'public-trader-priors+verified-public-uv-method-consensus+postgres-price-safety+target-support-learning',
      sources: TRADER_KNOWLEDGE_SOURCES,
      learnedRules: [...learned.values()],
      guarantees: { salesPerDayInvented: false, salesProbabilityInvented: false, directTraderAutomation: false, paidPlayerPicksImported: false, bronzeHardBlocked: true, lowRatedNonRareBlocked: true }
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});


app.get('/api/uv/target-learning/status', async (req, res) => {
  try {
    const platform = req.query?.platform === 'pc' ? 'pc' : 'console';
    const [profiles, feedback] = await Promise.all([
      loadTargetSupportPerformance(platform),
      getTradeFeedbackStatus(platform)
    ]);
    const rows = [...profiles.values()].sort((a, b) => (b.marketSamples + b.reportedFeedbackSamples) - (a.marketSamples + a.reportedFeedbackSamples));
    res.json({
      ok: true,
      version: UV_VERSION,
      platform,
      mode: 'empirical-market-target-support + sample-damped-reported-outcome-learning',
      profileCount: rows.length,
      profiles: rows.slice(0, 100),
      feedback,
      semantics: {
        marketSupportScore: 'Lernt nur, wie gut ein empfohlenes Preisziel spaeter vom beobachteten Markt gestuetzt wurde.',
        reportedSellRate: 'Nur aus explizit gemeldeten echten Ergebnissen; keine allgemeine Verkaufswahrscheinlichkeit.',
        salesProbability: null
      }
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post('/api/uv/feedback', async (req, res) => {
  if (!requireUvActive(req, res)) return;
  try {
    const saved = await recordTradeFeedback({
      listId: req.body?.listId,
      slot: req.body?.slot,
      outcome: req.body?.outcome,
      soldPrice: req.body?.soldPrice,
      relists: req.body?.relists,
      note: req.body?.note
    });
    res.json(saved);
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

const LIVE_RECHECK_DEMAND_KEYS = Object.freeze([
  'usagePct', 'usageAudience', 'usageVersionMatched', 'usageHitCount',
  'communityUsagePct', 'proUsagePct', 'usagePositionCount', 'usagePositions',
  'usageBestRank', 'popularityScore', 'demandEvidenceScore', 'demandDataConfidence',
  'demandEvidenceType', 'demandSource', 'momentumHit', 'momentumVersionMatched',
  'inPacksHit', 'inPacksVersionMatched', 'supplyPressureScore', 'promoMarketScore',
  'promoMarketState'
]);

function carryPreviousDemand(previous = {}) {
  const out = {};
  for (const key of LIVE_RECHECK_DEMAND_KEYS) {
    if (previous?.[key] !== undefined) out[key] = previous[key];
  }
  return out;
}

function cpuSafePause(ms = LIVE_RECHECK_BATCH_PAUSE_MS) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
}


async function generationCpuSafeMap(rows, mapper) {
  const input = Array.isArray(rows) ? rows : [];
  const out = new Array(input.length);
  for (let offset = 0; offset < input.length; offset += GENERATION_SCORE_BATCH_SIZE) {
    const end = Math.min(input.length, offset + GENERATION_SCORE_BATCH_SIZE);
    for (let i = offset; i < end; i++) out[i] = mapper(input[i], i);
    if (end < input.length) await cpuSafePause(GENERATION_BATCH_PAUSE_MS);
  }
  return out;
}

async function waitForGenerationCpuWindow() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < GENERATION_CPU_WINDOW_WAIT_MS) {
    const sharedRuntime = typeof sharedRuntimeProvider === 'function' ? sharedRuntimeProvider() : null;
    const sharedBusy = sharedRuntime?.monitoringBusy === true;
    if (!sharedBusy && !historyMonitorBusy && !liveRecheckActiveJobId) return true;
    await cpuSafePause(300);
  }
  return false;
}

async function performLiveRecheck(listId, job = null) {
  if (!isDbEnabled()) throw new Error('PostgreSQL ist fuer gespeicherte Listen-Rechecks erforderlich.');
  if (!uvWriteAllowed()) throw new Error('HA-STANDBY: Live-Recheck darf nur auf dem aktiven Leader laufen.');

  const runStartedAt = Date.now();
  if (job) job.phase = 'LOAD_LIST';
  const stored = await loadGeneratedList(listId);
  const platform = stored.platform === 'pc' ? 'pc' : 'console';
  const previousPayloadById = new Map(stored.items.map(item => [String(item.eaId), item.payload || {}]));

  if (job) { job.total = stored.items.length; job.processed = 0; job.phase = 'LIVE_MARKET'; }
  const live = await getLiveFutggCards(platform);
  const wanted = new Set(stored.items.map(i => String(i.eaId)));
  let current = live.cards.filter(c => wanted.has(String(c.eaId)));

  // CPU-SAFE v2.9.0: A live recheck must refresh live prices, but it does not
  // need to re-parse three large FUT.GG HTML pages. Reuse the existing demand
  // cache when available and otherwise carry the list's previous demand fields.
  // This removes the main bursty parser work from the manual 100-card recheck.
  if (job) job.phase = 'DEMAND_CACHE';
  const demandAttached = attachCachedFutggDemandSignals(current);
  current = demandAttached.cards.map(card => ({
    ...carryPreviousDemand(previousPayloadById.get(String(card.eaId)) || {}),
    ...card
  }));

  if (job) job.phase = 'MARKET_CONTEXT';
  const marketContext = await getFutbinMarketTrends(platform);
  current = attachMarketMoverSignals(current, marketContext);
  const liveById = new Map(current.map(c => [String(c.eaId), c]));
  const ids = stored.items.map(i => i.eaId);

  if (job) job.phase = 'POSTGRES_FEATURES';
  const [historyMap, performanceMap, traderRulePerformance, targetSupportPerformance] = await Promise.all([
    loadHistoryFeatures(ids, platform),
    loadPerformanceFeatures(ids, platform),
    loadTraderRulePerformance(platform),
    loadTargetSupportPerformance(platform)
  ]);

  const ideal = stored.budget / Math.max(1, stored.cardCount || stored.items.length || 100);
  const checkedAt = new Date();
  const rows = [];
  const items = Array.isArray(stored.items) ? stored.items : [];

  if (job) job.phase = 'CPU_SAFE_SCORING';
  for (let offset = 0; offset < items.length; offset += LIVE_RECHECK_BATCH_SIZE) {
    if (!uvWriteAllowed()) throw new Error('HA-Lease waehrend des Live-Rechecks verloren. Ergebnis wurde verworfen.');
    const batch = items.slice(offset, offset + LIVE_RECHECK_BATCH_SIZE);

    for (const item of batch) {
      const previous = { ...item.payload, buyPrice: item.buyPrice, startPrice: item.startPrice, sellPrice: item.sellPrice, netProfit: item.netProfit };
      const liveCard = liveById.get(String(item.eaId));
      if (!liveCard) {
        rows.push({ slot: item.slot, eaId: item.eaId, name: previous.name || null, ...recheckRecommendation(previous, null, checkedAt) });
        continue;
      }

      const history = historyMap.get(String(item.eaId)) || null;
      const learning = performanceMap.get(String(item.eaId)) || null;
      const merged = {
        ...liveCard,
        learning,
        futbinPrice: previous.futbinPrice ?? null,
        futbinChecked: Boolean(previous.futbinChecked),
        futbinMatch: Boolean(previous.futbinMatch),
        sourceDiffPct: previous.sourceDiffPct ?? null,
        ...Object.fromEntries(Object.entries(liveCard).filter(([,v]) => v !== undefined))
      };
      const score = scoreCard(merged, history, ideal, marketContext);
      const withScore = { ...merged, ...score, history };
      const withBuy = { ...withScore, ...buildBuyPlan(withScore, history) };
      const withTrader = { ...withBuy, ...buildTraderKnowledge(withBuy, marketContext, ideal, traderRulePerformance) };
      const targetLearningProfiles = attachTargetLearningProfiles(
        withTrader,
        targetSupportPerformance,
        targetProfitCandidates(withTrader.recommendedBuyPrice || withTrader.price)
      );
      const withTarget = { ...withTrader, targetLearningProfiles };
      const economics = buildTradingEconomics(withTarget);
      const freshBase = { ...withTarget, ...economics };
      const sellabilityScore = buildSellabilityScore(freshBase);
      const traderProfiled = attachPublicTraderProfile({ ...freshBase, sellabilityScore }, stored.budget, stored.cardCount || stored.items.length || 100);
      const budgetTop100Score = buildBudgetTop100Score(traderProfiled, ideal);
      const baseSelectionScore = buildSelectionScore(traderProfiled);
      const fresh = { ...traderProfiled, budgetTop100Score, selectionScore: baseSelectionScore };
      const state = recheckRecommendation(previous, fresh, checkedAt);
      rows.push({
        slot: item.slot,
        eaId: item.eaId,
        name: fresh.name || previous.name || null,
        cardType: fresh.cardType || previous.cardType || null,
        ...state,
        fresh: {
          price: fresh.price,
          recommendedBuyPrice: fresh.recommendedBuyPrice,
          startPrice: fresh.startPrice,
          sellPrice: fresh.sellPrice,
          netProfit: fresh.netProfit,
          uvScore: fresh.uvScore,
          longTermScore: fresh.longTermScore,
          tradeQualityScore: fresh.tradeQualityScore,
          selectionScore: fresh.selectionScore,
          riskPenalty: fresh.riskPenalty,
          riskFlags: fresh.riskFlags,
          historyTrendPct: fresh.historyTrendPct,
          demandDataConfidence: fresh.demandDataConfidence,
          saleLikelihoodIndex: fresh.saleLikelihoodIndex,
          salesProbability: null
        }
      });
    }

    if (job) job.processed = Math.min(items.length, offset + batch.length);
    if (offset + batch.length < items.length) await cpuSafePause();
  }

  const counts = rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
  const actionable = rows.filter(r => r.actionable).length;
  const recheckSummary = {
    total: rows.length,
    actionable,
    counts,
    cpuSafe: true,
    batchSize: LIVE_RECHECK_BATCH_SIZE,
    batchPauseMs: LIVE_RECHECK_BATCH_PAUSE_MS,
    demandMode: demandAttached.context?.cacheAvailable ? 'CACHED_FUTGG_DEMAND' : 'PREVIOUS_LIST_DEMAND'
  };

  if (!uvWriteAllowed()) throw new Error('HA-Lease waehrend des Live-Rechecks verloren. Ergebnis wurde nicht als frisch gespeichert.');
  if (job) job.phase = 'PERSIST';
  await saveListRecheck(stored.id, rows, recheckSummary, checkedAt);
  const durationMs = Math.max(0, Date.now() - runStartedAt);
  liveRecheckLastDurationMs = durationMs;

  return {
    ok: true,
    version: UV_VERSION,
    listId: stored.id,
    platform,
    createdAt: stored.createdAt,
    checkedAt: checkedAt.toISOString(),
    durationMs,
    cpuSafe: {
      enabled: true,
      batchSize: LIVE_RECHECK_BATCH_SIZE,
      batchPauseMs: LIVE_RECHECK_BATCH_PAUSE_MS,
      demandMode: recheckSummary.demandMode
    },
    ageMinutes: Math.max(0, Math.round((checkedAt.getTime() - new Date(stored.createdAt).getTime()) / 60000)),
    summary: recheckSummary,
    semantics: {
      KEEP: 'alte Empfehlung liegt noch nahe am aktuellen Preis-/Qualitaetsprofil',
      REPRICE: 'Karte bleibt brauchbar, aber Kauf-/Verkaufspreise sollten aktualisiert werden',
      WAIT: 'Qualitaet kann gut bleiben, aktueller Preis liegt aber zu weit ueber der alten Kaufgrenze',
      DROP: 'konservative Sicherheits-/Qualitaetsgrenze wurde verletzt',
      MISSING: 'kein aktueller FUT.GG-Preis vorhanden'
    },
    marketContext: { direction: marketContext?.direction || 'unknown', changePct: marketContext?.changePct ?? null, stabilityScore: marketContext?.stabilityScore ?? 55 },
    demandContext: demandAttached.context,
    cards: rows
  };
}

async function pumpLiveRecheckQueue() {
  if (liveRecheckActiveJobId || !LIVE_RECHECK_QUEUE.length) return;
  const nextId = LIVE_RECHECK_QUEUE.shift();
  const job = liveRecheckJobs.get(nextId);
  if (!job || job.status !== 'QUEUED') return pumpLiveRecheckQueue();

  const sharedRuntime = typeof sharedRuntimeProvider === 'function' ? sharedRuntimeProvider() : null;
  if (sharedRuntime?.monitoringBusy === true) {
    job.phase = 'WAIT_MARKET_IDLE';
    LIVE_RECHECK_QUEUE.unshift(job.jobId);
    const timer = setTimeout(() => pumpLiveRecheckQueue(), 750);
    timer.unref?.();
    return;
  }

  liveRecheckActiveJobId = job.jobId;
  job.status = 'RUNNING';
  job.startedAt = new Date().toISOString();
  job.phase = 'STARTING';
  try {
    if (!uvWriteAllowed()) throw new Error('HA-STANDBY: Recheck-Job kann auf dieser Instanz nicht gestartet werden.');
    job.result = await performLiveRecheck(job.listId, job);
    job.status = 'DONE';
    job.phase = 'DONE';
    liveRecheckCompleted += 1;
  } catch (error) {
    job.status = 'FAILED';
    job.phase = 'FAILED';
    job.error = String(error?.message || error);
    liveRecheckFailed += 1;
  } finally {
    job.finishedAt = new Date().toISOString();
    if (liveRecheckJobByList.get(job.listId) === job.jobId) liveRecheckJobByList.delete(job.listId);
    liveRecheckActiveJobId = null;
    scheduleLiveRecheckJobCleanup(job);
    setImmediate(() => pumpLiveRecheckQueue());
  }
}

function startLiveRecheckJob(listId) {
  const listKey = String(listId);
  const existingId = liveRecheckJobByList.get(listKey);
  const existing = existingId ? liveRecheckJobs.get(existingId) : null;
  if (existing && ['RUNNING', 'QUEUED'].includes(existing.status)) return { job: existing, reused: true };

  const pendingCount = LIVE_RECHECK_QUEUE.length + (liveRecheckActiveJobId ? 1 : 0);
  if (pendingCount >= LIVE_RECHECK_MAX_QUEUE) {
    const error = new Error(`CPU-SAFE: Maximal ${LIVE_RECHECK_MAX_QUEUE} Live-Rechecks gleichzeitig/queued. Bitte laufenden Check abwarten.`);
    error.code = 'LIVE_RECHECK_QUEUE_FULL';
    throw error;
  }

  const jobId = `${listKey}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    listId: listKey,
    status: 'QUEUED',
    enqueuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    phase: 'QUEUED',
    processed: 0,
    total: 0,
    error: null,
    result: null
  };
  liveRecheckJobs.set(jobId, job);
  liveRecheckJobByList.set(listKey, jobId);
  LIVE_RECHECK_QUEUE.push(jobId);
  setImmediate(() => pumpLiveRecheckQueue());
  return { job, reused: false };
}

function handleLiveRecheckStart(req, res) {
  if (!requireUvActive(req, res)) return;
  if (!isDbEnabled()) return res.status(503).json({ error: 'PostgreSQL ist fuer gespeicherte Listen-Rechecks erforderlich.' });
  try {
    const { job, reused } = startLiveRecheckJob(req.params.listId);
    res.status(202).json({
      ok: true,
      accepted: true,
      reused,
      jobId: job.jobId,
      listId: job.listId,
      status: job.status,
      startedAt: job.startedAt,
      enqueuedAt: job.enqueuedAt,
      pollUrl: `/api/uv/recheck-job/${encodeURIComponent(job.jobId)}`
    });
  } catch (error) {
    const status = error?.code === 'LIVE_RECHECK_QUEUE_FULL' ? 429 : 500;
    res.status(status).json({ ok: false, error: String(error?.message || error), code: error?.code || null });
  }
}

// v2.9.0: proxy-safe async job + one global CPU-safe queue. The 100-card
// scoring pass is chunked with short pauses and reuses cached demand evidence.
app.post('/api/uv/recheck/:listId', handleLiveRecheckStart);
app.get('/api/uv/recheck/:listId', handleLiveRecheckStart);
app.get('/api/uv/recheck-job/:jobId', (req, res) => {
  const job = liveRecheckJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ ok: false, status: 'MISSING', error: 'Live-Recheck-Job nicht gefunden oder bereits abgelaufen.' });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ...publicLiveRecheckJob(job) });
});

app.post('/api/uv/rebalance/:listId', async (req, res) => {
  if (!requireUvActive(req, res)) return;
  if (generationBusy) return res.status(429).json({ error: 'Eine Generierung oder ein Rebalance läuft gerade. Bitte kurz warten.' });
  generationBusy = true;
  try {
    if (!isDbEnabled()) return res.status(503).json({ error: 'PostgreSQL ist fuer gespeicherte Portfolio-Rebalances erforderlich.' });
    const stored = await loadGeneratedList(req.params.listId);
    const platform = stored.platform === 'pc' ? 'pc' : 'console';
    const budget = Number(stored.budget);
    const count = Number(stored.cardCount || stored.items.length || 100);

    const [live, marketContext] = await Promise.all([
      getLiveFutggCards(platform),
      getFutbinMarketTrends(platform)
    ]);
    const { pool: rawPool, ideal, minPrice, maxPrice, tierProfile } = buildCandidatePool(live.cards, budget, count);
    const oldIds = new Set(stored.items.map(item => String(item.eaId)));
    const rawIds = new Set(rawPool.map(card => String(card.eaId)));
    const storedLive = live.cards.filter(card => oldIds.has(String(card.eaId)) && !rawIds.has(String(card.eaId)));
    const analysisInput = [...rawPool, ...storedLive];

    let demandContext = { ok: false, mostUsedOk: false, momentumOk: false, inPacksOk: false, mostUsedMatches: 0, momentumMatches: 0, inPacksMatches: 0, sources: [], errors: [] };
    let demandCards = analysisInput;
    try {
      const demand = await attachFutggDemandSignals(analysisInput);
      demandCards = demand.cards;
      demandContext = demand.context;
      lastDemandContext = demand.context;
    } catch (error) {
      demandContext.errors = [String(error?.message || error)];
    }
    let pool = attachMarketMoverSignals(demandCards, marketContext);

    const previousById = new Map(stored.items.map(item => [String(item.eaId), item.payload || {}]));
    pool = pool.map(card => {
      const previous = previousById.get(String(card.eaId));
      if (!previous) return card;
      return {
        ...card,
        futbinPrice: previous.futbinPrice ?? null,
        futbinChecked: Boolean(previous.futbinChecked),
        futbinMatch: Boolean(previous.futbinMatch),
        sourceDiffPct: previous.sourceDiffPct ?? null
      };
    });

    const priority = [...pool].sort((a, b) => {
      const oldA = oldIds.has(String(a.eaId)) ? 0 : 1;
      const oldB = oldIds.has(String(b.eaId)) ? 0 : 1;
      if (oldA !== oldB) return oldA - oldB;
      return Math.abs(a.price - ideal) - Math.abs(b.price - ideal);
    }).slice(0, HISTORY_SAMPLE_LIMIT);
    await Promise.allSettled([
      recordSnapshot(priority, platform, HISTORY_SAMPLE_LIMIT),
      upsertCards(priority),
      recordMarketSnapshot(marketContext, platform),
      recordDemandSnapshot(demandContext, platform)
    ]);
    const learningIds = priority.map(c => c.eaId);
    const [historyMap, performanceMap, traderRulePerformance, targetSupportPerformance] = await Promise.all([
      loadHistoryFeatures(learningIds, platform),
      loadPerformanceFeatures(learningIds, platform),
      loadTraderRulePerformance(platform),
      loadTargetSupportPerformance(platform)
    ]);

    const enriched = pool.map(card => {
      const history = historyMap.get(String(card.eaId)) || null;
      const learning = performanceMap.get(String(card.eaId)) || null;
      const base = { ...card, learning };
      const score = scoreCard(base, history, ideal, marketContext);
      const withScore = { ...base, ...score, history };
      const withBuy = { ...withScore, ...buildBuyPlan(withScore, history) };
      const withTrader = { ...withBuy, ...buildTraderKnowledge(withBuy, marketContext, ideal, traderRulePerformance) };
      const targetLearningProfiles = attachTargetLearningProfiles(
        withTrader,
        targetSupportPerformance,
        targetProfitCandidates(withTrader.recommendedBuyPrice || withTrader.price)
      );
      const withTarget = { ...withTrader, targetLearningProfiles };
      const economics = buildTradingEconomics(withTarget);
      const fresh = { ...withTarget, ...economics };
      const sellabilityScore = buildSellabilityScore(fresh);
      const traderProfiled = attachPublicTraderProfile({ ...fresh, sellabilityScore }, budget, count);
      const budgetTop100Score = buildBudgetTop100Score(traderProfiled, ideal);
      const baseSelectionScore = buildSelectionScore(traderProfiled);
      return { ...traderProfiled, budgetTop100Score, selectionScore: baseSelectionScore };
    });

    const adaptiveMarketPolicy = deriveAdaptiveMarketPolicy(enriched, { budget, count, gameYear: GAME_YEAR });
    const currentById = new Map(enriched.map(card => [String(card.eaId), card]));
    const checkedAt = new Date();
    const recheckRows = stored.items.map(item => {
      const previous = { ...item.payload, buyPrice: item.buyPrice, startPrice: item.startPrice, sellPrice: item.sellPrice, netProfit: item.netProfit };
      const fresh = currentById.get(String(item.eaId));
      return {
        slot: item.slot,
        eaId: item.eaId,
        name: fresh?.name || previous.name || null,
        ...recheckRecommendation(previous, fresh || null, checkedAt)
      };
    });

    const seedInfo = buildRebalanceSeed(stored.items, recheckRows, currentById, {
      ratingOptions: { budget, portfolioCount: count, gameYear: GAME_YEAR, adaptivePolicy: adaptiveMarketPolicy }
    });
    const rawCandidateIds = new Set(rawPool.map(card => String(card.eaId)));
    const replacementNeed = Math.max(1, count - seedInfo.retained.length);
    const replacementPipeline = runCandidatePipeline(
      enriched.filter(card => rawCandidateIds.has(String(card.eaId))),
      replacementNeed,
      { budget, portfolioCount: count, gameYear: GAME_YEAR, adaptivePolicy: adaptiveMarketPolicy }
    );
    const replacementPool = filterConservativeCandidates(
      replacementPipeline.pool,
      replacementNeed,
      { budget, portfolioCount: count }
    );
    const balanced = rebalancePortfolio({
      retained: seedInfo.retained,
      candidates: replacementPool,
      blockedIds: seedInfo.blockedIds,
      budget,
      count
    });

    let selected = balanced.selected.map(card => ({
      ...card,
      recommendationMode: 'conservative-demand+reported-outcome-learning+lifecycle+portfolio-rebalance+candidate-gate-v2.1+promo-live-market-adaptive+hard-100-slots+demand-sellability-budget-relax+hard100-sellability-ladder-v2.3.5+budget-adaptive-rating-floor+budget-top100-v2.7-budget-tier-allocator+trader-consensus+budget-safe-reserve+adaptive-special-mix+budget-rating-guard+max-two-exact-copies+nonrare-demand-gate+futbin-structured-evidence',
      capitalBand: capitalBandForPrice(card.buyPrice, budget, effectiveCount),
      recommendationLifecycle: buildRecommendationLifecycle(card, checkedAt),
      rebalanceFromListId: stored.id,
      salesProbability: null
    }));
    selected.sort((a, b) => b.selectionScore - a.selectionScore || b.longTermScore - a.longTermScore);

    const metrics = summarizeSelectedCards(selected, budget, balanced.specialTargetRatio);
    const savePayload = {
      budget,
      platform,
      cards: selected,
      totalBuy: metrics.totalBuy,
      totalExpectedProfit: metrics.totalExpectedProfit,
      avgUvScore: metrics.avgUvScore
    };
    const newListId = await saveGeneratedList(savePayload);
    const recheckCounts = recheckRows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});

    res.json({
      ok: true,
      version: UV_VERSION,
      gameYear: GAME_YEAR,
      platform,
      budget,
      listId: newListId,
      rebalanceFromListId: stored.id,
      checkedAt: checkedAt.toISOString(),
      ...metrics,
      traderMixPolicy: balanced.traderMixPolicy || null,
      adaptiveMarketPolicy,
      candidatePoolSize: replacementPool.length,
      rawCandidatePoolSize: rawPool.length,
      candidatePipeline: replacementPipeline.diagnostics,
      candidatePriceRange: { min: Math.round(minPrice), max: Math.round(maxPrice), ideal: Math.round(ideal), tierProfile: tierProfile?.name || null, referenceMode: tierProfile?.referenceMode || null },
      marketSnapshot: {
        shared: live.sharedSnapshot === true,
        mode: live.sharedSnapshotMode || (live.sharedSnapshot === true ? 'LIVE' : 'DIRECT'),
        updatedAt: live.updatedAt || null,
        ageSeconds: Number.isFinite(Number(live.snapshotAgeSeconds)) ? Number(live.snapshotAgeSeconds) : null,
        requiresLiveRecheck: live.requiresLiveRecheck === true
      },
      marketContext: {
        source: marketContext?.ok ? 'FUTBIN/Parse market trends' : 'neutral fallback',
        direction: marketContext?.direction || 'unknown',
        changePct: marketContext?.changePct ?? null,
        stabilityScore: marketContext?.stabilityScore ?? 55
      },
      demandContext,
      rebalance: {
        retainedCount: balanced.retainedCount,
        replacementCount: balanced.replacementCount,
        releasedForFeasibility: balanced.released,
        invalidated: seedInfo.dropped,
        previousStatusCounts: recheckCounts,
        semantics: {
          retained: 'KEEP/REPRICE Positionen bleiben bevorzugt im Portfolio und werden auf aktuelle Preise neu gerechnet.',
          replacement: 'WAIT/DROP/MISSING Positionen werden nicht blind weitergekauft, sondern durch neue konservative Kandidaten ersetzt.',
          releasedForFeasibility: 'Nur wenn ein vollständiges 100er-Portfolio sonst nicht innerhalb des Gesamtbudgets möglich ist.'
        }
      },
      dataNotice: 'v2.1 PROMO+LIVE-MARKET: Rebalance hält die Größe der gespeicherten Liste stabil, nutzt den aktuellen Live-Markt-/Promo-Floor und weiterhin maximal 2 exakte Kopien. Für eine neu berechnete dynamische Slot-Anzahl bitte eine neue Liste generieren.',
      cards: selected
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  } finally {
    generationBusy = false;
  }
});

app.post('/api/uv/generate', async (req, res) => {
  if (!requireUvActive(req, res)) return;
  if (generationBusy) return res.status(429).json({ error: 'Eine Liste wird gerade berechnet. Bitte kurz warten.' });
  generationBusy = true;
  try {
    const budget = Math.floor(Number(req.body?.budget));
    const platform = req.body?.platform === 'pc' ? 'pc' : 'console';
    const count = 100;
    if (!Number.isFinite(budget) || budget < 30_000) return res.status(400).json({ error: 'Für eine 100-Karten-Liste bitte mindestens 30.000 Coins eingeben.' });

    // CPU-SAFE v2.9.2: do not stack a manual 100-card build on top of the
    // Trader market loop, History monitor or Live-Recheck. Wait briefly for an
    // idle window instead of pushing constrained hosts over their CPU cap.
    await waitForGenerationCpuWindow();

    const [live, marketContext] = await Promise.all([
      getLiveFutggCards(platform, { allowRecentSafeSnapshot: true }),
      getFutbinMarketTrends(platform)
    ]);

    const { pool: rawPool, ideal, minPrice, maxPrice, tierProfile } = buildCandidatePool(live.cards, budget, count);
    if (rawPool.length < count) throw new Error(`Nur ${rawPool.length} Karten im passenden Preisbereich gefunden.`);

    let demandContext = { ok: false, mostUsedOk: false, momentumOk: false, inPacksOk: false, mostUsedMatches: 0, momentumMatches: 0, inPacksMatches: 0, sources: [], errors: [] };
    let demandCards = rawPool;
    try {
      const demand = await attachFutggDemandSignals(rawPool);
      demandCards = demand.cards;
      demandContext = demand.context;
      lastDemandContext = demand.context;
    } catch (error) {
      demandContext.errors = [String(error?.message || error)];
    }
    let pool = attachMarketMoverSignals(demandCards, marketContext);

    const sampleForHistory = [...pool]
      .sort((a, b) => Math.abs(a.price - ideal) - Math.abs(b.price - ideal))
      .slice(0, HISTORY_SAMPLE_LIMIT);
    await Promise.allSettled([
      recordSnapshot(sampleForHistory, platform, HISTORY_SAMPLE_LIMIT),
      upsertCards(sampleForHistory),
      recordMarketSnapshot(marketContext, platform),
      recordDemandSnapshot(demandContext, platform)
    ]);
    const idsForLearning = sampleForHistory.map(c => c.eaId);
    const [historyMap, performanceMap, traderRulePerformance, targetSupportPerformance] = await Promise.all([
      loadHistoryFeatures(idsForLearning, platform),
      loadPerformanceFeatures(idsForLearning, platform),
      loadTraderRulePerformance(platform),
      loadTargetSupportPerformance(platform)
    ]);

    let scored = await generationCpuSafeMap(pool, card => {
      const history = historyMap.get(String(card.eaId)) || null;
      const learning = performanceMap.get(String(card.eaId)) || null;
      const base = { ...card, learning };
      const score = scoreCard(base, history, ideal, marketContext);
      const enriched = { ...base, ...score, history };
      return {
        ...enriched,
        selectionScore: enriched.uvScore * 0.32 + enriched.longTermScore * 0.23 + enriched.budgetFit * 0.10 + enriched.priceActivityScore * 0.08 + enriched.popularityScore * 0.09 + enriched.demandEvidenceScore * 0.06 + enriched.learningScore * 0.12 - enriched.riskPenalty
      };
    });

    // FUTBIN cross-check happens BEFORE the final 100-card optimizer,
    // so confirmed source agreement can influence which cards make the list.
    scored = await crosscheckFutbin(scored, platform);
    scored = await generationCpuSafeMap(scored, card => {
      const history = historyMap.get(String(card.eaId)) || null;
      const learning = performanceMap.get(String(card.eaId)) || card.learning || null;
      const base = { ...card, learning };
      const score = scoreCard(base, history, ideal, marketContext);
      const withScore = {
        ...base,
        ...score,
        history
      };
      const withBuy = { ...withScore, ...buildBuyPlan(withScore, history) };
      const withTraderKnowledge = { ...withBuy, ...buildTraderKnowledge(withBuy, marketContext, ideal, traderRulePerformance) };
      const targetLearningProfiles = attachTargetLearningProfiles(
        withTraderKnowledge,
        targetSupportPerformance,
        targetProfitCandidates(withTraderKnowledge.recommendedBuyPrice || withTraderKnowledge.price)
      );
      const withTargetLearning = { ...withTraderKnowledge, targetLearningProfiles };
      const economics = buildTradingEconomics(withTargetLearning);
      const enriched = { ...withTargetLearning, ...economics };
      const sellabilityScore = buildSellabilityScore(enriched);
      const withSellability = { ...enriched, sellabilityScore };
      const traderProfiled = attachPublicTraderProfile(withSellability, budget, count);
      const budgetTop100Score = buildBudgetTop100Score(traderProfiled, ideal);
      const baseSelectionScore = buildSelectionScore(traderProfiled);
      return { ...traderProfiled, budgetTop100Score, selectionScore: baseSelectionScore };
    });

    const adaptiveMarketPolicy = deriveAdaptiveMarketPolicy(scored, { budget, count, gameYear: GAME_YEAR });
    const pipelineResult = runCandidatePipeline(scored, count, { budget, portfolioCount: count, gameYear: GAME_YEAR, adaptivePolicy: adaptiveMarketPolicy });
    pool = filterConservativeCandidates(pipelineResult.pool, count);
    if (!pool.length) {
      throw new Error('Robuste Kandidaten-Pipeline hat aktuell keine ausreichend sichere Karte freigegeben.');
    }

    let affordability = maxAffordablePortfolioCount(pool, budget, count);
    let hard100SellabilityFallback = null;
    let budgetAdaptiveFallback = null;
    let budgetSafetyReserveFallback = null;
    if (Number(affordability.count || 0) < count) {
      // v2.3.3: first expand from the already-scored full universe using the
      // sellability ladder. It may ignore the dynamic rating proxy, but it never
      // bypasses the real safety blocks.
      hard100SellabilityFallback = buildHard100SellabilityFallback(pipelineResult.cards, { budget, count });
      const merged = new Map();
      for (const card of pool) merged.set(String(card.eaId), card);
      for (const card of hard100SellabilityFallback.pool) {
        const key = String(card.eaId);
        const current = merged.get(key);
        if (!current || Number(card.selectionScore || 0) > Number(current.selectionScore || 0)) merged.set(key, card);
      }
      pool = [...merged.values()];
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      // v2.3.5: if the ordinary sellability ladder still prices the 100-card
      // universe far above the user's capital, switch to a budget-per-slot
      // sellability ladder. Cheap cards can bypass rating/selection proxies only
      // when several independent live-demand/liquidity signals agree.
      budgetAdaptiveFallback = buildBudgetAdaptiveSellabilityFallback(pipelineResult.cards, { budget, count });
      const merged = new Map();
      for (const card of pool) merged.set(String(card.eaId), card);
      for (const card of budgetAdaptiveFallback.pool) {
        const key = String(card.eaId);
        const current = merged.get(key);
        const currentAdaptive = Number(current?.budgetAdaptiveSellabilityScore || -1);
        const nextAdaptive = Number(card?.budgetAdaptiveSellabilityScore || -1);
        if (!current || nextAdaptive > currentAdaptive) merged.set(key, card);
      }
      pool = [...merged.values()];
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      // v2.4.2: final reserve separates hard safety from ranking. This is not
      // a sub-82/fodder escape hatch: the 82+ normal floor, Bronze block,
      // Non-Rare gates, crash/source-risk guards and rejected outcomes remain
      // hard. It only prevents average-but-safe 82+ Rares from being discarded
      // before the Top-100 budget ranker can compare them.
      budgetSafetyReserveFallback = buildBudgetSafetyReserveFallback(pipelineResult.cards, { budget, count });
      const merged = new Map();
      for (const card of pool) merged.set(String(card.eaId), card);
      for (const card of budgetSafetyReserveFallback.pool) {
        const key = String(card.eaId);
        const current = merged.get(key);
        const currentScore = Number(current?.budgetTop100Score ?? current?.selectionScore ?? -1);
        const nextScore = Number(card?.budgetTop100Score ?? card?.selectionScore ?? -1);
        if (!current || nextScore > currentScore) merged.set(key, card);
      }
      pool = [...merged.values()];
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      const fallbackText = hard100SellabilityFallback
        ? ` Sellability-Fallback ${hard100SellabilityFallback.stage || 'n/a'}: ${hard100SellabilityFallback.slots || 0}/${count} strukturelle Slots${Number.isFinite(hard100SellabilityFallback.allocatorSlots) ? `, ${hard100SellabilityFallback.allocatorSlots}/${count} nach Endgame-Mix` : ''}, ${hard100SellabilityFallback.uniqueCards || 0} unterschiedliche Karten${Number.isFinite(hard100SellabilityFallback.minimumCost) ? `, billigste zulässige 100 ca. ${Number(hard100SellabilityFallback.minimumCost).toLocaleString('de-DE')} Coins` : ''}.`
        : '';
      const adaptiveText = budgetAdaptiveFallback
        ? ` Budget-Adaptive ${budgetAdaptiveFallback.stage || 'n/a'} bei ca. ${Number(budgetAdaptiveFallback.idealSlotPrice || 0).toLocaleString('de-DE')} Coins/Slot: ${budgetAdaptiveFallback.slots || 0}/${count} strukturelle Slots${Number.isFinite(budgetAdaptiveFallback.allocatorSlots) ? `, ${budgetAdaptiveFallback.allocatorSlots}/${count} nach Endgame-Mix` : ''}, ${budgetAdaptiveFallback.uniqueCards || 0} unterschiedliche Karten${Number.isFinite(budgetAdaptiveFallback.minimumCost) ? `, billigste sichere 100 ca. ${Number(budgetAdaptiveFallback.minimumCost).toLocaleString('de-DE')} Coins` : ''}.`
        : '';
      const reserveText = budgetSafetyReserveFallback
        ? ` Safety-Reserve ${budgetSafetyReserveFallback.stage || 'n/a'}: ${budgetSafetyReserveFallback.slots || 0}/${count} strukturelle Slots${Number.isFinite(budgetSafetyReserveFallback.allocatorSlots) ? `, ${budgetSafetyReserveFallback.allocatorSlots}/${count} nach Endgame-Mix` : ''}, ${budgetSafetyReserveFallback.uniqueCards || 0} unterschiedliche Karten${Number.isFinite(budgetSafetyReserveFallback.minimumCost) ? `, billigste sichere 100 ca. ${Number(budgetSafetyReserveFallback.minimumCost).toLocaleString('de-DE')} Coins` : ''}.`
        : '';
      throw new Error(`100-Slot-Guard: Auch nach Sellability-Ladder und 82+-Safety-Reserve sind aktuell nur ${Number(affordability.count || 0)}/${count} sichere Positionen innerhalb des Budgets möglich.${fallbackText}${adaptiveText}${reserveText} Unter 82 normale Karten und tote Füllkarten bleiben gesperrt.`);
    }
    const dynamicCountReduced = false;
    const effectiveCount = count;
    const optimized = optimizeList(pool, budget, count);

    let selected = optimized.selected.map(card => ({
      ...card,
      recommendationMode: 'conservative-demand+reported-outcome-learning+lifecycle+portfolio-rebalance+candidate-gate-v2.1+promo-live-market-adaptive+hard-100-slots+demand-sellability-budget-relax+hard100-sellability-ladder-v2.3.5+budget-adaptive-rating-floor+budget-top100-v2.7-budget-tier-allocator+trader-consensus+budget-safe-reserve+adaptive-special-mix+budget-rating-guard+max-two-exact-copies+nonrare-demand-gate+futbin-structured-evidence',
      capitalBand: capitalBandForPrice(card.buyPrice, budget, count),
      recommendationLifecycle: buildRecommendationLifecycle(card),
      salesProbability: null
    }));

    selected.sort((a, b) => b.selectionScore - a.selectionScore || b.longTermScore - a.longTermScore);
    const totalBuy = selected.reduce((sum, c) => sum + c.buyPrice, 0);
    const totalExpectedProfit = selected.reduce((sum, c) => sum + c.netProfit, 0);
    const avgUvScore = selected.reduce((sum, c) => sum + c.uvScore, 0) / selected.length;
    const avgLongTermScore = selected.reduce((sum, c) => sum + c.longTermScore, 0) / selected.length;
    const avgConfidence = selected.reduce((sum, c) => sum + c.confidenceScore, 0) / selected.length;
    const avgActivity = selected.reduce((sum, c) => sum + c.priceActivityScore, 0) / selected.length;
    const avgPopularity = selected.reduce((sum, c) => sum + (c.popularityScore || 0), 0) / selected.length;
    const avgTurnoverIndex = selected.reduce((sum, c) => sum + (c.turnoverIndex || 0), 0) / selected.length;
    const avgTradeQuality = selected.reduce((sum, c) => sum + (c.tradeQualityScore || 0), 0) / selected.length;
    const avgCapitalEfficiency = selected.reduce((sum, c) => sum + (c.capitalEfficiencyScore || 0), 0) / selected.length;
    const avgRepeatability = selected.reduce((sum, c) => sum + (c.repeatabilityScore || 0), 0) / selected.length;
    const avgLongTermProfitScore = selected.reduce((sum, c) => sum + (c.longTermProfitScore || 0), 0) / selected.length;
    const avgTraderPriorScore = selected.reduce((sum, c) => sum + (c.traderPriorScore || 0), 0) / selected.length;
    const avgTraderMethodConsensus = selected.reduce((sum, c) => sum + Number(c.traderMethodConsensusIndex || 50), 0) / selected.length;
    const avgSaleLikelihoodIndex = selected.reduce((sum, c) => sum + (c.saleLikelihoodIndex || 0), 0) / selected.length;
    const avgCapitalLockRisk = selected.reduce((sum, c) => sum + (c.capitalLockRisk || 0), 0) / selected.length;
    const avgTargetSupportScore = selected.reduce((sum, c) => sum + Number(c.targetSupportScore || 50), 0) / selected.length;
    const targetLearningMatches = selected.filter(c => Number(c.targetSupportSamples || 0) > 0).length;
    const reportedFeedbackMatches = selected.filter(c => Number(c.reportedFeedbackSamples || 0) > 0).length;
    const traderRuleLearningSamples = [...traderRulePerformance.values()].reduce((sum, r) => sum + Number(r.samples || 0), 0);
    const portfolio = buildPortfolioSummary(selected, budget, count);
    const gradeACount = selected.filter(c => ['A+', 'A'].includes(c.qualityGrade)).length;
    const weakQualityCount = selected.filter(c => c.qualityGrade === 'D').length;
    const demandMatches = selected.filter(c => Number.isFinite(c.usagePct) || c.momentumHit).length;
    const communityUsageMatches = selected.filter(c => Number.isFinite(c.communityUsagePct)).length;
    const proUsageMatches = selected.filter(c => Number.isFinite(c.proUsagePct)).length;
    const multiPositionUsageMatches = selected.filter(c => Number(c.usagePositionCount || 0) >= 2).length;
    const inPacksCount = selected.filter(c => c.inPacksHit).length;
    const avgDemandDataConfidence = selected.reduce((sum, c) => sum + Number(c.demandDataConfidence || 0), 0) / selected.length;
    const specialCount = selected.filter(c => c.cardType === 'Special').length;
    const futbinChecked = selected.filter(c => c.futbinChecked).length;
    const futbinGamesMatches = selected.filter(c => Number.isFinite(c.futbinGamesCount)).length;
    const futbinSalesHistoryMatches = selected.filter(c => Number(c.futbinSoldSampleCount || 0) > 0).length;
    const futbinRealSalePriceMatches = selected.filter(c => Number.isFinite(c.futbinSoldPriceMedian)).length;
    const gameScoreRows = selected.filter(c => Number.isFinite(c.futbinGamesScore));
    const salesScoreRows = selected.filter(c => Number.isFinite(c.futbinSalesEvidenceScore));
    const avgFutbinGamesScore = gameScoreRows.length ? gameScoreRows.reduce((sum,c)=>sum+Number(c.futbinGamesScore),0)/gameScoreRows.length : 0;
    const avgFutbinSalesEvidence = salesScoreRows.length ? salesScoreRows.reduce((sum,c)=>sum+Number(c.futbinSalesEvidenceScore),0)/salesScoreRows.length : 0;
    const moverMatches = selected.filter(c => c.marketMover).length;
    const lowRiskCount = selected.filter(c => !c.riskFlags?.length).length;
    const learningMatches = selected.filter(c => (c.learning?.evalCount || 0) > 0).length;
    const avgLearningScore = selected.reduce((sum, c) => sum + (c.learningScore || 50), 0) / selected.length;
    const avgBudgetTop100Score = selected.reduce((sum, c) => sum + Number(c.budgetTop100Score || 0), 0) / selected.length;
    const futtiesCount = selected.filter(c => c.cardType === 'Special' && `${c.rarityName || ''} ${c.cardName || ''} ${c.version || ''}`.toLowerCase().includes('futties')).length;
    const base82Count = selected.filter(c => c.cardType !== 'Special' && Number(c.overall) === 82).length;
    const base83Count = selected.filter(c => c.cardType !== 'Special' && Number(c.overall) === 83).length;
    const base84PlusCount = selected.filter(c => c.cardType !== 'Special' && Number(c.overall) >= 84).length;
    const avgPublicTraderEndgameScore = selected.reduce((sum, c) => sum + Number(c.publicTraderEndgameScore || 50), 0) / selected.length;
    const avgTraderConsensusScore = selected.reduce((sum, c) => sum + Number(c.traderConsensusScore || 50), 0) / selected.length;
    const avgBudgetTierScore = selected.reduce((sum, c) => sum + Number(c.budgetTierScore || 50), 0) / selected.length;
    const specialVersionCount = selected.filter(c => c.cardVersionClass === 'SPECIAL').length;
    const normalVersionCount = selected.filter(c => c.cardVersionClass === 'NORMAL').length;

    const result = {
      ok: true, version: UV_VERSION, gameYear: GAME_YEAR, platform, budget,
      requestedCount: count,
      count: selected.length,
      generatedCount: selected.length,
      dynamicCountReduced,
      affordableCountEstimate: effectiveCount,
      affordability,
      totalBuy, unusedBudget: budget - totalBuy,
      budgetUsagePct: (totalBuy / budget) * 100, totalExpectedProfit,
      avgUvScore, avgLongTermScore, avgConfidence, avgActivity, avgPopularity, avgTurnoverIndex, avgTradeQuality, avgCapitalEfficiency, avgRepeatability, avgLongTermProfitScore, avgTraderPriorScore, avgTraderMethodConsensus, avgSaleLikelihoodIndex, avgCapitalLockRisk, avgTargetSupportScore, targetLearningMatches, reportedFeedbackMatches, avgDemandDataConfidence, traderRuleLearningSamples, portfolio, gradeACount, weakQualityCount, demandMatches, communityUsageMatches, proUsageMatches, multiPositionUsageMatches, inPacksCount,
      specialCount, futtiesCount, base82Count, base83Count, base84PlusCount, avgPublicTraderEndgameScore, avgTraderConsensusScore, avgBudgetTierScore, specialVersionCount, normalVersionCount,
      budgetTierProfile: tierProfile?.name || null,
      budgetTierReferenceMode: tierProfile?.referenceMode || null,
      traderMixPolicy: optimized.traderMixPolicy || null,
      specialTargetRatio: optimized.specialTargetRatio,
      specialTargetCount: Math.round(Number(optimized.specialTargetRatio || 0) * selected.length),
      adaptiveMarketPolicy,
      futbinChecked, futbinGamesMatches, futbinSalesHistoryMatches, futbinRealSalePriceMatches, avgFutbinGamesScore, avgFutbinSalesEvidence, moverMatches, lowRiskCount, learningMatches, avgLearningScore, avgBudgetTop100Score,
      candidatePoolSize: pool.length,
      rawCandidatePoolSize: rawPool.length,
      candidatePipeline: pipelineResult.diagnostics,
      candidatePriceRange: { min: Math.round(minPrice), max: Math.round(maxPrice), ideal: Math.round(ideal), tierProfile: tierProfile?.name || null, referenceMode: tierProfile?.referenceMode || null },
      marketSnapshot: {
        shared: live.sharedSnapshot === true,
        mode: live.sharedSnapshotMode || (live.sharedSnapshot === true ? 'LIVE' : 'DIRECT'),
        updatedAt: live.updatedAt || null,
        ageSeconds: Number.isFinite(Number(live.snapshotAgeSeconds)) ? Number(live.snapshotAgeSeconds) : null,
        requiresLiveRecheck: live.requiresLiveRecheck === true
      },
      marketContext: {
        source: marketContext?.ok ? 'FUTBIN/Parse market trends' : 'neutral fallback',
        direction: marketContext?.direction || 'unknown',
        changePct: marketContext?.changePct ?? null,
        stabilityScore: marketContext?.stabilityScore ?? 55,
        moversSeen: Array.isArray(marketContext?.movers) ? marketContext.movers.length : 0
      },
      demandContext: {
        source: demandContext?.ok ? 'FUT.GG Most Used / Momentum / In Packs' : 'fallback',
        mostUsedOk: Boolean(demandContext?.mostUsedOk),
        momentumOk: Boolean(demandContext?.momentumOk),
        inPacksOk: Boolean(demandContext?.inPacksOk),
        mostUsedMatches: Number(demandContext?.mostUsedMatches || 0),
        momentumMatches: Number(demandContext?.momentumMatches || 0),
        inPacksMatches: Number(demandContext?.inPacksMatches || 0),
        promoSpecialMatches: Number(demandContext?.promoSpecialMatches || 0),
        promoMomentumMatches: Number(demandContext?.promoMomentumMatches || 0),
        promoHotMatches: Number(demandContext?.promoHotMatches || 0),
        activePromoVersions: Array.isArray(demandContext?.activePromoVersions) ? demandContext.activePromoVersions : [],
        errors: Array.isArray(demandContext?.errors) ? demandContext.errors.slice(0, 2) : []
      },
      sources: {
        primary: 'FUT.GG',
        secondary: process.env.FUTBIN_PARSE_API_KEY ? 'FUTBIN via Parse API' : 'not configured',
        history: isDbEnabled() ? 'PostgreSQL' : 'not configured',
        traderKnowledge: TRADER_KNOWLEDGE_SOURCES.map(s => s.name)
      },
      dataNotice: (dynamicCountReduced ? `v2.8.1 BUDGET-TIER-ALLOCATOR+TRADER-CONSENSUS: ${adaptiveMarketPolicy.promoMarketRegime}. Kandidatenpool und echte 100-Slot-Allokation sind getrennt; Rating ist nur ein Sekundärsignal, Karten-Version und Live-Nachfrage entscheiden stärker.` : `v2.8.1 BUDGET-TIER-ALLOCATOR+TRADER-CONSENSUS: ${count} Karten sind im Budget machbar. ${tierProfile?.name || 'Budget-Profil'} formt nur weiche Preis-Tiers; FUT.GG Livepreise/Nachfrage, PostgreSQL-Stabilität, Netto-Profit und Safety-Gates entscheiden. Niedrig geratete Specials werden nicht mit normalen Low-Golds verwechselt.`) + ' Externe FutStarz-Beobachtungen dienen nur als weiche Portfolio-Form, niemals als Live-Preisquelle oder kopierte Kartenliste.' + (live.requiresLiveRecheck === true ? ' Die Liste wurde während der FUT.GG-Recovery aus dem letzten höchstens 5 Minuten alten sicheren Trader-Snapshot erzeugt. Vor jedem Kauf ist der Live-Recheck Pflicht.' : ' Vor jedem Kauf bleibt der Live-Recheck Pflicht.'),
      cards: selected
    };

    const listId = await saveGeneratedList(result).catch(() => null);
    result.listId = listId;
    lastGenerationAt = new Date().toISOString();
    lastError = null;
    res.json(result);
  } catch (error) {
    lastError = String(error);
    res.status(500).json({ error: String(error?.message || error) });
  } finally { generationBusy = false; }
});

app.get('/uv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get(/^\/uv(?:\/.*)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));



export async function initUvBrain({ sharedPool = null, marketProvider = null, runtimeProvider = null, active = true } = {}) {
  if (sharedPool) configureDbPool(sharedPool);
  if (typeof marketProvider === 'function') sharedMarketProvider = marketProvider;
  if (typeof runtimeProvider === 'function') sharedRuntimeProvider = runtimeProvider;
  uvActive = active !== false;
  if (uvStarted) {
    if (uvActive) startHistoryMonitor(); else stopHistoryMonitor();
    return getUvRuntimeStatus();
  }
  await initDb();
  if (uvActive) startHistoryMonitor();
  uvStarted = true;
  return getUvRuntimeStatus();
}

function failQueuedLiveRechecks(reason = 'HA-STANDBY') {
  while (LIVE_RECHECK_QUEUE.length) {
    const jobId = LIVE_RECHECK_QUEUE.shift();
    const job = liveRecheckJobs.get(jobId);
    if (!job || job.status !== 'QUEUED') continue;
    job.status = 'FAILED';
    job.phase = 'FAILED';
    job.error = String(reason);
    job.finishedAt = new Date().toISOString();
    liveRecheckFailed += 1;
    if (liveRecheckJobByList.get(job.listId) === job.jobId) liveRecheckJobByList.delete(job.listId);
    scheduleLiveRecheckJobCleanup(job);
  }
}

export async function setUvBrainActive(active) {
  uvActive = active === true;
  if (!uvActive) failQueuedLiveRechecks('HA-STANDBY: queued Live-Recheck verworfen; nur der aktive Leader darf schreiben.');
  if (!uvStarted) return getUvRuntimeStatus();
  if (uvActive) startHistoryMonitor();
  else stopHistoryMonitor();
  return getUvRuntimeStatus();
}

export async function shutdownUvBrain() {
  stopHistoryMonitor();
  await closeDb();
  uvStarted = false;
  uvActive = false;
}

export function getUvRuntimeStatus() {
  return {
    ok: true,
    started: uvStarted,
    activeInstance: uvActive,
    runtimeMode: uvActive ? 'ACTIVE' : 'HA_STANDBY_READ_ONLY',
    version: UV_VERSION,
    gameYear: GAME_YEAR,
    database: isDbEnabled() ? 'PostgreSQL/shared-pool' : 'memory/no-db',
    sharedConsoleMarket: typeof sharedMarketProvider === 'function',
    sharedRuntimeGate: typeof sharedRuntimeProvider === 'function',
    lastGenerationAt,
    lastError,
    historyMonitor: {
      enabled: isDbEnabled(),
      busy: historyMonitorBusy,
      lastAt: lastHistoryMonitorAt,
      lastError: lastHistoryMonitorError,
      cards: lastHistoryMonitorCards,
      consideredCards: lastHistoryMonitorConsideredCards,
      deferredAt: lastHistoryMonitorDeferredAt,
      deferredReason: lastHistoryMonitorDeferredReason
    },
    generationCpuSafe: {
      busy: generationBusy,
      batchSize: GENERATION_SCORE_BATCH_SIZE,
      batchPauseMs: GENERATION_BATCH_PAUSE_MS,
      cpuWindowWaitMs: GENERATION_CPU_WINDOW_WAIT_MS,
      optimizerMode: 'INCREMENTAL_STATE_CACHE'
    },
    liveRecheckCpuSafe: {
      activeJobId: liveRecheckActiveJobId,
      queued: LIVE_RECHECK_QUEUE.length,
      completed: liveRecheckCompleted,
      failed: liveRecheckFailed,
      lastDurationMs: liveRecheckLastDurationMs,
      batchSize: LIVE_RECHECK_BATCH_SIZE,
      batchPauseMs: LIVE_RECHECK_BATCH_PAUSE_MS,
      maxQueue: LIVE_RECHECK_MAX_QUEUE
    }
  };
}
