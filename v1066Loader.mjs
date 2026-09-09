import { patchServer as patchServerV1064 } from './v1064Loader.mjs';
import { patchRatingOnly } from './v1065Loader.mjs';

export const V1066_BOOTSTRAP_VERSION = '10.67.5-trader-brain-futbin-warmup-order-fix';

export function patchFutbinBridgeV1066(source) {
  const original = String(source || '');
  let out = original;

  if (!out.includes('./futbinBridgeV1066.js')) {
    out = out.replace(
      '} from "./futbinMarketV1064.js";',
      '} from "./futbinMarketV1064.js";\nimport {\n  enrichRowsWithFutbinSafeV1066,\n  startFutbinBridgeBootstrapV1066,\n  createFutbinBridgeRouterV1066,\n  futbinBridgeV1066Status\n} from "./futbinBridgeV1066.js";'
    );
  }

  // Authorized FUTBIN bridge replaces the direct blocked Hostless path.
  out = out.replace(
    'await enrichRowsWithFutbinPublicGapFill({',
    'await enrichRowsWithFutbinSafeV1066({'
  );

  out = out.replace(
    /startFc26Backfill\(\{ rows: latestTradingRows, pool, gameYear: "26", limit: 500 \}\)/g,
    'startFutbinBridgeBootstrapV1066({ pool, gameYear: "26" })'
  );
  out = out.replaceAll('[v10.64] FC26 FUTBIN backfill gestartet:', '[v10.66] FUTBIN authorized bridge bootstrap:');
  out = out.replaceAll('[v10.64] FC26 FUTBIN backfill start error:', '[v10.66] FUTBIN bridge bootstrap error:');

  out = out.replace(
    /const result = await startFc26Backfill\(\{\s*rows: latestTradingRows,\s*pool,\s*gameYear: "26",\s*limit: Number\(req\.body\?\.limit \|\| 500\)\s*\}\);\s*res\.status\(result\.ok \? 202 : 409\)\.json\(result\);/m,
    'const result = await startFutbinBridgeBootstrapV1066({ pool, gameYear: "26" });\n    res.status(result.ok ? 202 : 409).json(result);'
  );

  if (!out.includes('v10.66 FUTBIN bridge router')) {
    out = out.replace(
      'app.use(uvRouter);',
      'app.use(uvRouter);\n// v10.66 FUTBIN bridge router\napp.use("/api/futbin-bridge", createFutbinBridgeRouterV1066({ pool: dbEnabled ? pool : null, gameYear: GAME_YEAR }));'
    );
  }

  // Add bridge status to the final project endpoint.
  out = out.replace(
    'const [adaptive, futbin] = await Promise.all([',
    'const [adaptive, futbin, futbinBridge] = await Promise.all(['
  );
  out = out.replace(
    'futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);',
    'futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),\n      futbinBridgeV1066Status({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);'
  );

  out = out.replaceAll('version: "10.64-final"', 'version: "10.67.5-final"');
  out = out.replaceAll('outputMode: "BUY_SELL_ONLY"', 'outputMode: "RATING_ONLY_BUY_SELL"');

  out = out.replace(
    '      futbin,\n      checklist:',
    '      futbin: { direct: futbin, bridge: futbinBridge, effectiveMode: futbinBridge?.authorizedFeedConfigured || Number(futbinBridge?.db?.cards || 0) > 0 ? "AUTHORIZED_BRIDGE_ACTIVE" : "FUTGG_ONLY_UNTIL_FUTBIN_FEED" },\n      checklist:'
  );
  out = out.replace(
    '        futbinGapFill: true,',
    '        futbinGapFill: true,\n        futbinAuthorizedBridge: true,\n        futbinDirect403LoopRemoved: true,'
  );

  out = out.replaceAll(
    'FC Trading Intelligence v10.65 FINAL Rating-Only + FUTBIN Complete + FC26 Season Brain',
    'FC Trading Intelligence v10.66 FINAL Rating-Only + Authorized FUTBIN Bridge + FC26 Season Brain'
  );

  // v10.66.1: FUTBIN status must not block the final status on DB counts.
  out = out.replace(
    'futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),\n      futbinBridgeV1066Status({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);',
    'futbinPublicStatus({ pool: null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),\n      futbinBridgeV1066Status({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);'
  );

  // v10.66.2: the remaining 524 was adaptiveV1062Status doing schema/learning/COUNT
  // queries on PostgreSQL. Final-project status is diagnostic only, so use its
  // in-memory snapshot and never block Cloudflare waiting for DB status work.
  out = out.replace(
    'const [adaptive, futbin, futbinBridge] = await Promise.all([\n      adaptiveV1062Status({ pool: dbEnabled ? pool : null, gameYear: GAME_YEAR }),\n      futbinPublicStatus({ pool: null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),',
    'const [adaptive, futbin, futbinBridge] = await Promise.all([\n      adaptiveV1062Status({ pool: null, gameYear: GAME_YEAR }),\n      futbinPublicStatus({ pool: null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),'
  );

  // v10.66.3 / ÜV 2.10.5: proxy-safe async generation job.
  if (!out.includes('./uvGenerateAsyncV2105.js')) {
    out = out.replace(
      'import { uvRouter, initUvBrain, shutdownUvBrain, getUvRuntimeStatus, setUvBrainActive } from "./uv/uvApp.js";',
      'import { uvRouter, initUvBrain, shutdownUvBrain, getUvRuntimeStatus, setUvBrainActive } from "./uv/uvApp.js";\nimport { createUvGenerateAsyncRouterV2105 } from "./uvGenerateAsyncV2105.js";'
    );
  }
  if (!out.includes('v2.10.5 async generation router')) {
    out = out.replace(
      'app.use(uvRouter);',
      '// v2.10.5 async generation router\napp.use(createUvGenerateAsyncRouterV2105({ port }));\napp.use(uvRouter);'
    );
  }

  // v10.66.4: a long full-market processing pass must not poison FUT.GG
  // source health merely because the 3-minute freshness clock expires while
  // monitoringBusy is still true. Processing health remains the separate guard.
  out = out.replace(
    'if (lastSuccessMs && staleForMs > SOURCE_HEALTH_STALE_MS) {',
    `const sourceBusyGrace = monitoringBusy === true && staleForMs != null && staleForMs <= 10 * 60_000;
  if (lastSuccessMs && staleForMs > SOURCE_HEALTH_STALE_MS && !sourceBusyGrace) {`
  );

  // v10.66.4: manual ÜV generation may use the last successful shared snapshot
  // for up to 10 minutes while the Trader Brain is actively processing a long
  // cycle. Such a snapshot is explicitly RECENT_SAFE and requires live recheck.
  out = out.replace(
    `const recentSafeAllowed = options?.allowRecentSafeSnapshot === true &&
    source?.status === "RECOVERING" &&
    processing?.healthy === true &&
    snapshotAgeMs <= UV_SHARED_SAFE_SNAPSHOT_MAX_AGE_MS;

  if (!liveAllowed && !recentSafeAllowed) return null;`,
    `const recentSafeAllowed = options?.allowRecentSafeSnapshot === true &&
    source?.status === "RECOVERING" &&
    processing?.healthy === true &&
    snapshotAgeMs <= UV_SHARED_SAFE_SNAPSHOT_MAX_AGE_MS;
  const busySafeAllowed = options?.allowRecentSafeSnapshot === true &&
    monitoringBusy === true &&
    Array.isArray(latestTradingRows) &&
    latestTradingRows.length >= 100 &&
    snapshotAgeMs <= 10 * 60_000 &&
    !source?.lastError;

  if (!liveAllowed && !recentSafeAllowed && !busySafeAllowed) return null;`
  );

  return { source: out, changed: out !== original };
}


function patchTraderBrainFutbinV10673(source) {
  let out = String(source || '');

  if (!out.includes('./traderFutbinExtendedV10673.js')) {
    out = out.replace(
      'import { createHaCoordinator } from "./haCoordinator.js";',
      'import { createHaCoordinator } from "./haCoordinator.js";\nimport { enrichTraderFutbinMatchV10673, traderFutbinExtendedStatusV10673 } from "./traderFutbinExtendedV10673.js";'
    );
  }

  // The Trader Brain must not wait for an 84%-confidence AI event before FUTBIN
  // ever gets sampled. Passive 82+ market rows are eligible, while the existing
  // 4-hour interval and 6/day budget still cap public price checks.
  out = out.replace(
    '  if (row.aiAction === "NOCH WARTEN" && confidence >= 90 && movement >= 10) return true;\n  return false;\n}',
    '  if (row.aiAction === "NOCH WARTEN" && confidence >= 90 && movement >= 10) return true;\n  if (Number(row.overall || 0) >= 82 && Number(row.price || 0) > 0) return true;\n  return false;\n}'
  );

  // Pull Games / Sales / Popular Rank for the exact FUTBIN card id returned by
  // the normal search endpoint. This is Parse-only and never direct FUTBIN scraping.
  out = out.replace(
    '    const match = futbinParseMatchForRow(row, futbinParseRows(payload));\n    if (!match) throw new Error("Kein eindeutig passender FUTBIN-Kartentreffer gefunden");\n\n    const value = {\n      ...match,\n      provider: "PARSE_PUBLIC_API",',
    '    const match = futbinParseMatchForRow(row, futbinParseRows(payload));\n    if (!match) throw new Error("Kein eindeutig passender FUTBIN-Kartentreffer gefunden");\n    const extendedEvidence = match.futbinId\n      ? await enrichTraderFutbinMatchV10673({ apiKey: FUTBIN_PARSE_API_KEY, parseBaseUrl: FUTBIN_PARSE_BASE_URL, gameYear: GAME_YEAR, playerId: match.futbinId, timeoutMs: FETCH_TIMEOUT_MS }).catch(() => null)\n      : null;\n\n    const value = {\n      ...match,\n      extendedEvidence,\n      provider: "PARSE_PUBLIC_API",'
  );

  out = out.replace(
    '  row.futbinVersion = match.version;\n  row.futbinCheckedAt = match.checkedAt;',
    '  row.futbinVersion = match.version;\n  row.futbinCheckedAt = match.checkedAt;\n  const extended = match.extendedEvidence || null;\n  row.futbinGames = Number.isFinite(Number(extended?.games)) ? Number(extended.games) : (Number.isFinite(Number(extended?.gamesConsole)) ? Number(extended.gamesConsole) : null);\n  row.futbinGamesConsole = Number.isFinite(Number(extended?.gamesConsole)) ? Number(extended.gamesConsole) : null;\n  row.futbinGamesPc = Number.isFinite(Number(extended?.gamesPc)) ? Number(extended.gamesPc) : null;\n  row.futbinPopularRank = Number.isFinite(Number(extended?.popularRank)) ? Number(extended.popularRank) : null;\n  row.futbinPopularityCount = Number.isFinite(Number(extended?.popularityCount)) ? Number(extended.popularityCount) : null;\n  row.futbinSalesHistory = Array.isArray(extended?.salesHistory) ? extended.salesHistory : [];\n  row.futbinObservedSalesPerDay = Number.isFinite(Number(extended?.observedSalesPerDay)) ? Number(extended.observedSalesPerDay) : null;'
  );

  out = out.replace(
    '      matchConfidence: match.matchConfidence,\n      checkedAt: match.checkedAt\n    };',
    '      matchConfidence: match.matchConfidence,\n      checkedAt: match.checkedAt,\n      games: row.futbinGames,\n      gamesConsole: row.futbinGamesConsole,\n      gamesPc: row.futbinGamesPc,\n      popularRank: row.futbinPopularRank,\n      popularityCount: row.futbinPopularityCount,\n      salesHistory: row.futbinSalesHistory,\n      observedSalesPerDay: row.futbinObservedSalesPerDay\n    };'
  );

  // Reuse cached Parse data BEFORE the quantitative/Gemini input is constructed,
  // so FUTBIN evidence belongs to the Trader Brain itself instead of only the UI.
  out = out.replace(
    '    Object.assign(row, futbinCrossCheckFields(card.eaId, card.price, futbinFeed));\n    row.dataSource = "FUT.GG";',
    '    Object.assign(row, futbinCrossCheckFields(card.eaId, card.price, futbinFeed));\n    const cachedParse = futbinParseCardCache.get(String(card.eaId));\n    if (cachedParse && Date.now() - cachedParse.savedAt < FUTBIN_PARSE_CARD_COOLDOWN_MS) {\n      applyFutbinParseCrossCheck(row, cachedParse.value, null);\n    }\n    row.dataSource = "FUT.GG";'
  );

  out = out.replace(
    '      discordSignals: signals\n    };',
    '      discordSignals: signals,\n      futbinCrossCheck: Number.isFinite(Number(row.futbinPrice)) ? {\n        provider: row.futbinProvider || null,\n        price: Number(row.futbinPrice),\n        diffPct: Number.isFinite(Number(row.futbinDiffPct)) ? Number(row.futbinDiffPct) : null,\n        status: row.futbinCrossCheck || "NO_DATA",\n        matchConfidence: Number.isFinite(Number(row.futbinMatchConfidence)) ? Number(row.futbinMatchConfidence) : null,\n        games: row.futbinGames ?? null,\n        gamesConsole: row.futbinGamesConsole ?? null,\n        gamesPc: row.futbinGamesPc ?? null,\n        popularRank: row.futbinPopularRank ?? null,\n        popularityCount: row.futbinPopularityCount ?? null,\n        salesHistory: Array.isArray(row.futbinSalesHistory) ? row.futbinSalesHistory : [],\n        observedSalesPerDay: row.futbinObservedSalesPerDay ?? null\n      } : null\n    };'
  );

  // v10.67.5: insert the sparse Trader-Brain FUTBIN sampler at the
  // ACTUAL post-v10.64 location. v10.64 has already replaced the old
  // enrichImportantRowsWithFutbinParse(...) call with the safe bridge call.
  const warmupAnchor = `      // v10.64 public FUTBIN gap fill
      await enrichRowsWithFutbinSafeV1066({`;
  const warmupCode = `      // v10.67.5: guaranteed sparse FUTBIN sample for the TRADER BRAIN.
      // Existing daily budget + global minimum interval still cap Parse usage.
      if (FUTBIN_PARSE_API_KEY) {
        const budget = refreshFutbinParseDailyBudget();
        const intervalReady = !futbinParseLastCallAt || Date.now() - futbinParseLastCallAt >= FUTBIN_PARSE_MIN_INTERVAL_MS;
        if (budget.remaining > 0 && intervalReady) {
          const warmupRow = latestTradingRows
            .filter(row => Number(row?.overall || 0) >= 82 && Number(row?.price || 0) > 0 && row?.name)
            .filter(row => {
              const last = futbinParseCardLastCheck.get(String(row.eaId)) || 0;
              return !last || Date.now() - last >= FUTBIN_PARSE_CARD_COOLDOWN_MS;
            })
            .sort((a, b) => Number(b.overall || 0) - Number(a.overall || 0) || Number(b.price || 0) - Number(a.price || 0))[0] || null;

          if (warmupRow) {
            const warmupMatch = await fetchFutbinParseCrossCheck(warmupRow);
            if (warmupMatch) applyFutbinParseCrossCheck(warmupRow, warmupMatch, built.brainWork);
          }
        }
      }

`;
  if (!out.includes('v10.67.5: guaranteed sparse FUTBIN sample for the TRADER BRAIN')) {
    if (!out.includes(warmupAnchor)) {
      throw new Error('[v10.67.5] warmup anchor missing after v10.64/v10.66 patches');
    }
    out = out.replace(warmupAnchor, warmupCode + warmupAnchor);
  }

  // Expose the real Trader Brain FUTBIN extended state in both status endpoints.
  const futbinStatusStart = out.indexOf('app.get("/api/futbin/status"');
  if (futbinStatusStart >= 0) {
    const policyAt = out.indexOf('    policy: {', futbinStatusStart);
    if (policyAt >= 0) {
      out = out.slice(0, policyAt) +
        '    extendedEvidence: traderFutbinExtendedStatusV10673(),\n' +
        out.slice(policyAt);
    }
  }

  const brainStatusStart = out.indexOf('app.get("/api/trader-brain/status"');
  if (brainStatusStart >= 0) {
    const ratingAt = out.indexOf('    ratingStats: latestRatingStats', brainStatusStart);
    if (ratingAt >= 0) {
      out = out.slice(0, ratingAt) +
        '    futbin: { publicApi: latestFutbinParseStatus, extendedEvidence: traderFutbinExtendedStatusV10673() },\n' +
        out.slice(ratingAt);
    }
  }

  const required = [
    './traderFutbinExtendedV10673.js',
    'enrichTraderFutbinMatchV10673',
    'futbinGames',
    'futbinPopularRank',
    'futbinSalesHistory',
    'v10.67.5: guaranteed sparse FUTBIN sample for the TRADER BRAIN',
    'const warmupMatch = await fetchFutbinParseCrossCheck(warmupRow)',
    'const extendedEvidence = match.futbinId',
    'extendedEvidence: traderFutbinExtendedStatusV10673()',
    'futbin: { publicApi: latestFutbinParseStatus, extendedEvidence: traderFutbinExtendedStatusV10673() }'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error('[v10.67.5] Trader Brain FUTBIN extended patch failed: ' + missing.join(', '));
  return { source: out, changed: out !== source };
}

function patchUvAppV2105(source) {
  let out = String(source || '');
  out = out.replace("const UV_VERSION = '2.10.4';", "const UV_VERSION = '2.10.12';");
  out = out.replace(
    'generationCpuSafeBatches: true,',
    'generationCpuSafeBatches: true, generationAsyncProxyJob: true, allocatorConsistentHard100Fallback: true, playerCapAwareHard100Mix: true, unsavedLiveRecheck: true, transientRecheckState: true, saveRequiredForLiveCheck: false, futbinParseLivePriceMemory: true, futbinBasicDataStatusAccurate: true, futbinExtendedEvidenceAdapter: true, futbinGamesEvidenceReady: true, futbinSalesEvidenceReady: true, futbinPopularRankEvidenceReady: true, futbinParseAutoRevision: true, futbinRegexTemplateEscapeHotfix: true,'
  );

  // v2.10.12: saving is optional. Unsaved lists get a hidden short-lived
  // PostgreSQL backing row only so the existing CPU-safe live-recheck/rebalance
  // pipeline can address the exact 100 cards. It is excluded from saved-list
  // history and automatically removed later.
  out = out.replace(
    "loadGeneratedList, listGeneratedLists } from './src/db.js';",
    "loadGeneratedList, listGeneratedLists, pool as uvDbPool } from './src/db.js';"
  );

  if (!out.includes('scheduleTransientRecheckCleanup')) {
    out = out.replace(
      'let sharedRuntimeProvider = null;',
      `let sharedRuntimeProvider = null;
const UV_TRANSIENT_RECHECK_TTL_MS = 45 * 60_000;

function scheduleTransientRecheckCleanup(listId) {
  const id = Number(listId);
  if (!Number.isInteger(id) || id <= 0) return;
  const timer = setTimeout(() => {
    Promise.resolve(
      uvDbPool?.query(
        "DELETE FROM uv_generated_lists WHERE id=$1 AND COALESCE((summary_payload->>'transientRecheckOnly')::boolean, false)=true",
        [id]
      )
    ).catch(() => {});
  }, UV_TRANSIENT_RECHECK_TTL_MS);
  timer.unref?.();
}

async function cleanupExpiredTransientRechecks() {
  try {
    await uvDbPool?.query(
      "DELETE FROM uv_generated_lists WHERE COALESCE((summary_payload->>'transientRecheckOnly')::boolean, false)=true AND created_at < NOW() - INTERVAL '2 hours'"
    );
  } catch {}
}`
    );
  }

  const generationPersistOld = `    const listId = saveListRequested ? await saveGeneratedList(result).catch(() => null) : null;
    result.listId = listId;
    result.saved = Boolean(listId);
    result.saveRequested = saveListRequested;`;

  const generationPersistNew = `    await cleanupExpiredTransientRechecks();
    const transientRecheckOnly = !saveListRequested && isDbEnabled();
    const persistencePayload = transientRecheckOnly
      ? { ...result, transientRecheckOnly: true }
      : result;
    const persistedListId = (saveListRequested || transientRecheckOnly)
      ? await saveGeneratedList(persistencePayload).catch(() => null)
      : null;
    if (transientRecheckOnly && persistedListId) scheduleTransientRecheckCleanup(persistedListId);
    const listId = saveListRequested ? persistedListId : null;
    result.listId = listId;
    result.recheckListId = persistedListId;
    result.saved = Boolean(listId);
    result.transientRecheckOnly = Boolean(transientRecheckOnly && persistedListId);
    result.saveRequested = saveListRequested;`;

  out = out.replace(generationPersistOld, generationPersistNew);

  const rebalancePersistOld = `    const newListId = saveListRequested ? await saveGeneratedList(savePayload) : null;
    const recheckCounts = recheckRows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});`;

  const rebalancePersistNew = `    await cleanupExpiredTransientRechecks();
    const transientRecheckOnly = !saveListRequested && isDbEnabled();
    const persistedSavePayload = transientRecheckOnly
      ? { ...savePayload, transientRecheckOnly: true }
      : savePayload;
    const persistedNewListId = (saveListRequested || transientRecheckOnly)
      ? await saveGeneratedList(persistedSavePayload)
      : null;
    if (transientRecheckOnly && persistedNewListId) scheduleTransientRecheckCleanup(persistedNewListId);
    const newListId = saveListRequested ? persistedNewListId : null;
    const recheckCounts = recheckRows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});`;

  out = out.replace(rebalancePersistOld, rebalancePersistNew);

  out = out.replace(
    `      listId: newListId,
      saved: Boolean(newListId),
      saveRequested: saveListRequested,`,
    `      listId: newListId,
      recheckListId: persistedNewListId,
      saved: Boolean(newListId),
      transientRecheckOnly: Boolean(transientRecheckOnly && persistedNewListId),
      saveRequested: saveListRequested,`
  );

  if (!out.includes('recheckListId = persistedListId') || !out.includes('persistedNewListId')) {
    throw new Error('[ÜV v2.10.12] unsaved live-recheck persistence patch failed.');
  }

  // v2.10.12: when a fallback has already proven 100/100 with the REAL allocator,
  // do not merge unrelated expensive candidates back in before the second
  // affordability check. That merge can recompute a stricter supply-aware
  // Endgame mix and invalidate the exact pool that was already proven feasible.
  const adaptiveOld = `      pool = [...merged.values()];
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      // v2.4.2: final reserve separates hard safety from ranking.`;

  const adaptiveNew = `      const mergedBudgetAdaptivePool = [...merged.values()];
      const adaptiveAllocatorProved =
        budgetAdaptiveFallback?.budgetFeasible === true &&
        Number(budgetAdaptiveFallback?.allocatorSlots || 0) >= count;
      pool = adaptiveAllocatorProved ? budgetAdaptiveFallback.pool : mergedBudgetAdaptivePool;
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      // v2.4.2: final reserve separates hard safety from ranking.`;

  out = out.replace(adaptiveOld, adaptiveNew);

  const reserveOld = `      pool = [...merged.values()];
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      const fallbackText = hard100SellabilityFallback`;

  const reserveNew = `      const mergedSafetyReservePool = [...merged.values()];
      const reserveAllocatorProved =
        budgetSafetyReserveFallback?.budgetFeasible === true &&
        Number(budgetSafetyReserveFallback?.allocatorSlots || 0) >= count;
      pool = reserveAllocatorProved ? budgetSafetyReserveFallback.pool : mergedSafetyReservePool;
      affordability = maxAffordablePortfolioCount(pool, budget, count);
    }
    if (Number(affordability.count || 0) < count) {
      const fallbackText = hard100SellabilityFallback`;

  out = out.replace(reserveOld, reserveNew);

  if (!out.includes('adaptiveAllocatorProved') || !out.includes('reserveAllocatorProved')) {
    throw new Error('[ÜV v2.10.12] allocator-consistency patch failed.');
  }
  return out;
}


function patchUvDbV2108(source) {
  let out = String(source || '');

  // v2.10.12: keep FUTBIN Parse observations in a dedicated table. Never mix
  // them into the FUT.GG primary history used by existing safety learning.
  if (!out.includes('uv_futbin_price_history')) {
    out = out.replace(
      `  await pool.query(` + "`" + `CREATE INDEX IF NOT EXISTS idx_uv_price_history_card_time ON uv_price_history (ea_id, platform, recorded_at DESC)` + "`" + `);`,
      `  await pool.query(` + "`" + `CREATE INDEX IF NOT EXISTS idx_uv_price_history_card_time ON uv_price_history (ea_id, platform, recorded_at DESC)` + "`" + `);
  await pool.query(` + "`" + `
    CREATE TABLE IF NOT EXISTS uv_futbin_price_history (
      ea_id BIGINT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      price INTEGER NOT NULL,
      source VARCHAR(40) NOT NULL DEFAULT 'FUTBIN_PARSE',
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  ` + "`" + `);
  await pool.query(` + "`" + `CREATE INDEX IF NOT EXISTS idx_uv_futbin_price_history_card_time ON uv_futbin_price_history (ea_id, platform, recorded_at DESC)` + "`" + `);`
    );
  }

  if (!out.includes('export async function recordFutbinPriceObservations')) {
    out += `

export async function recordFutbinPriceObservations(rows = [], platform = 'console') {
  if (!pool || !Array.isArray(rows) || !rows.length) return { inserted: 0 };
  const safePlatform = platform === 'pc' ? 'pc' : 'console';
  const clean = rows
    .map(row => ({ eaId: Number(row?.eaId), price: Math.round(Number(row?.price || 0)) }))
    .filter(row => Number.isFinite(row.eaId) && row.eaId > 0 && Number.isFinite(row.price) && row.price > 0)
    .slice(0, 100);
  if (!clean.length) return { inserted: 0 };
  const values = [];
  const placeholders = [];
  let i = 1;
  for (const row of clean) {
    placeholders.push(\`($\${i++}, $\${i++}, $\${i++}, 'FUTBIN_PARSE', NOW())\`);
    values.push(row.eaId, safePlatform, row.price);
  }
  await pool.query(\`INSERT INTO uv_futbin_price_history (ea_id, platform, price, source, recorded_at) VALUES \${placeholders.join(',')}\`, values);
  return { inserted: clean.length };
}

export async function loadFutbinPriceFeatures(eaIds = [], platform = 'console') {
  const map = new Map();
  if (!pool || !Array.isArray(eaIds) || !eaIds.length) return map;
  const ids = [...new Set(eaIds.map(Number).filter(Number.isFinite))].slice(0, 100);
  if (!ids.length) return map;
  const safePlatform = platform === 'pc' ? 'pc' : 'console';
  const result = await pool.query(\`
    SELECT ea_id,
      COUNT(*)::int AS samples,
      AVG(price)::numeric AS avg_price,
      MIN(price)::int AS min_price,
      MAX(price)::int AS max_price,
      (array_agg(price ORDER BY recorded_at ASC))[1]::int AS first_price,
      (array_agg(price ORDER BY recorded_at DESC))[1]::int AS last_price,
      MIN(recorded_at) AS first_at,
      MAX(recorded_at) AS last_at
    FROM uv_futbin_price_history
    WHERE platform=$1 AND ea_id = ANY($2::bigint[]) AND recorded_at > NOW() - INTERVAL '24 hours'
    GROUP BY ea_id
  \`, [safePlatform, ids]);
  for (const row of result.rows || []) {
    const first = Number(row.first_price || 0);
    const last = Number(row.last_price || 0);
    map.set(String(row.ea_id), {
      samples: Number(row.samples || 0),
      avg24h: Number(row.avg_price || 0) || null,
      min24h: Number(row.min_price || 0) || null,
      max24h: Number(row.max_price || 0) || null,
      firstPrice: first || null,
      lastPrice: last || null,
      trendPct24h: first > 0 && last > 0 ? ((last - first) / first) * 100 : null,
      firstAt: row.first_at || null,
      lastAt: row.last_at || null
    });
  }
  return map;
}
`;
  }

  out = out.replace(
    `  let where = '';
  if (platform) { values.push(platform); where = 'WHERE gl.platform=$1'; }`,
    `  let where = "WHERE COALESCE((gl.summary_payload->>'transientRecheckOnly')::boolean, false) = false";
  if (platform) { values.push(platform); where += ' AND gl.platform=$1'; }`
  );

  out = out.replace(
    `    FROM uv_generated_lists
    WHERE created_at > NOW() - INTERVAL '14 days'`,
    `    FROM uv_generated_lists
    WHERE COALESCE((summary_payload->>'transientRecheckOnly')::boolean, false) = false
      AND created_at > NOW() - INTERVAL '14 days'`
  );

  out = out.replace(
    `      WHERE gl.platform=$1 AND gl.created_at > NOW() - INTERVAL '14 days'`,
    `      WHERE COALESCE((gl.summary_payload->>'transientRecheckOnly')::boolean, false) = false
        AND gl.platform=$1 AND gl.created_at > NOW() - INTERVAL '14 days'`
  );

  return out;
}


function patchUvFutbinV2109(source) {
  let out = String(source || '');

  out = out.replace(
    "import { extractFutbinStructuredEvidence } from './futbinEvidence.js';",
    "import { extractFutbinStructuredEvidence } from './futbinEvidence.js';\nimport { recordFutbinPriceObservations, loadFutbinPriceFeatures } from './db.js';"
  );

  out = out.replace(
    `const extendedDataState = {
  gamesObserved: false,
  salesHistoryObserved: false,
  popularRankObserved: false,
  observedSalesPerDayObserved: false,
  lastObservedAt: null
};`,
    `const extendedDataState = {
  gamesObserved: false,
  salesHistoryObserved: false,
  popularRankObserved: false,
  observedSalesPerDayObserved: false,
  lastObservedAt: null,
  currentPriceObserved: false,
  marketTrendObserved: false,
  priceObservationCount: 0,
  parseCalls: 0,
  parseSuccesses: 0,
  parseFailures: 0,
  lastCallAt: null,
  lastSuccessAt: null,
  lastError: null,
  extendedEvidenceEndpoint: String(process.env.FUTBIN_EXTENDED_EVIDENCE_ENDPOINT || 'get_trading_evidence_fc26').trim(),
  extendedEvidenceStatus: 'IDLE',
  extendedEvidenceCalls: 0,
  extendedEvidenceSuccesses: 0,
  extendedEvidenceFailures: 0,
  extendedEvidenceLastAt: null,
  extendedEvidenceLastError: null,
  extendedEvidenceUnavailableUntil: null
};

const FUTBIN_EXTENDED_EVIDENCE_CACHE_MS = Math.max(5, Math.min(180, Number(process.env.FUTBIN_EXTENDED_EVIDENCE_CACHE_MIN || 30))) * 60_000;
const FUTBIN_EXTENDED_EVIDENCE_BACKOFF_MS = Math.max(5, Math.min(180, Number(process.env.FUTBIN_EXTENDED_EVIDENCE_BACKOFF_MIN || 30))) * 60_000;
const futbinExtendedEvidenceCache = new Map();
let futbinExtendedEvidenceBlockedUntil = 0;

const FUTBIN_EXTENDED_AUTO_PROVISION = String(process.env.FUTBIN_EXTENDED_AUTO_PROVISION || 'true').trim().toLowerCase() !== 'false';
const FUTBIN_EXTENDED_PROVIDER_BASE_URL = String(process.env.FUTBIN_EXTENDED_EVIDENCE_BASE_URL || '').replace(/\\/+$/, '');
const PARSE_API_ROOT = 'https://api.parse.bot';
const PARSE_PROVIDER_DISCOVERY_TTL_MS = 10 * 60_000;
const PARSE_PROVIDER_PROVISION_COOLDOWN_MS = 12 * 60 * 60_000;
let sameScraperExtendedEndpointMissing = false;
let parseExtendedProvider = null;
let parseProviderDiscoveryAt = 0;
let parseProviderDiscoveryPromise = null;
let parseProviderProvisionPromise = null;
let parseProviderLastProvisionAt = 0;

function parseScraperIdFromBase(baseUrl) {
  const m = String(baseUrl || '').match(/\\/scraper\\/([^/]+)/i);
  return m ? m[1] : null;
}

function normalizeParseProvider(task) {
  const generated = task?.generated_api || null;
  const endpoints = Array.isArray(generated?.endpoints) ? generated.endpoints : [];
  const exact = endpoints.find(e => String(e?.endpoint_name || '').toLowerCase() === 'get_trading_evidence_fc26');
  if (!generated?.execution_base_url || !exact) return null;
  return {
    taskId: String(task?.id || ''),
    scraperId: String(generated?.scraper_id || task?.result_scraper_id || ''),
    baseUrl: String(generated.execution_base_url).replace(/\\/+$/, ''),
    endpoint: String(exact.endpoint_name),
    method: String(exact.method || 'GET').toUpperCase()
  };
}

async function listParseTasks(apiKey) {
  return await fetchJson(PARSE_API_ROOT + '/dispatch/tasks?limit=100', {
    headers: { 'X-API-Key': apiKey }
  });
}

async function discoverParseExtendedProvider(apiKey, force = false) {
  if (FUTBIN_EXTENDED_PROVIDER_BASE_URL) {
    return {
      taskId: null,
      scraperId: parseScraperIdFromBase(FUTBIN_EXTENDED_PROVIDER_BASE_URL),
      baseUrl: FUTBIN_EXTENDED_PROVIDER_BASE_URL,
      endpoint: extendedDataState.extendedEvidenceEndpoint,
      method: String(process.env.FUTBIN_EXTENDED_EVIDENCE_METHOD || 'GET').toUpperCase()
    };
  }

  const now = Date.now();
  if (!force && parseExtendedProvider) return parseExtendedProvider;
  if (!force && parseProviderDiscoveryAt && now - parseProviderDiscoveryAt < PARSE_PROVIDER_DISCOVERY_TTL_MS) return null;
  if (parseProviderDiscoveryPromise) return parseProviderDiscoveryPromise;

  parseProviderDiscoveryPromise = (async () => {
    parseProviderDiscoveryAt = Date.now();
    try {
      const data = await listParseTasks(apiKey);
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      for (const task of tasks) {
        const provider = normalizeParseProvider(task);
        if (provider) {
          parseExtendedProvider = provider;
          extendedDataState.extendedEvidenceStatus = 'PROVIDER_DISCOVERED';
          return provider;
        }
      }
      return null;
    } finally {
      parseProviderDiscoveryPromise = null;
    }
  })();

  return parseProviderDiscoveryPromise;
}

async function pollParseRevisionTask(taskId, apiKey) {
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    const task = await fetchJson(PARSE_API_ROOT + '/dispatch/tasks/' + encodeURIComponent(taskId), {
      headers: { 'X-API-Key': apiKey }
    });
    const status = String(task?.status || '').toLowerCase();
    const provider = normalizeParseProvider(task);
    if (provider) return provider;
    if (status === 'needs_input') throw new Error('PARSE_REVISION_NEEDS_INPUT');
    if (status === 'failed') throw new Error('PARSE_REVISION_FAILED: ' + String(task?.error || 'unknown'));
  }
  throw new Error('PARSE_REVISION_TIMEOUT');
}

async function provisionParseExtendedProvider(seedPlayerId, apiKey) {
  if (!FUTBIN_EXTENDED_AUTO_PROVISION) return null;
  if (parseProviderProvisionPromise) return parseProviderProvisionPromise;
  const now = Date.now();
  if (parseProviderLastProvisionAt && now - parseProviderLastProvisionAt < PARSE_PROVIDER_PROVISION_COOLDOWN_MS) return null;

  parseProviderLastProvisionAt = now;
  parseProviderProvisionPromise = (async () => {
    extendedDataState.extendedEvidenceStatus = 'PROVISIONING_PARSE_ENDPOINT';
    try {
      const existing = await discoverParseExtendedProvider(apiKey, true);
      if (existing) return existing;

      const tasksData = await listParseTasks(apiKey);
      const tasks = Array.isArray(tasksData?.tasks) ? tasksData.tasks : [];
      const baseScraperId = parseScraperIdFromBase(FUTBIN_PARSE_API_BASE);
      const baseTask = tasks.find(task => {
        const generatedId = String(task?.generated_api?.scraper_id || task?.result_scraper_id || '');
        return baseScraperId && generatedId === baseScraperId;
      });

      const revisionText =
        'FC_TRADER_FUTBIN_EXTENDED_EVIDENCE_V1. Add an endpoint named get_trading_evidence_fc26 with input player_id. ' +
        'Use only publicly accessible EA FC 26 FUTBIN pages and exact card/version matching. ' +
        'Return real PGP Games values from /26/pgp?pid={player_id}; real Player Sales History rows for the exact card from its public market/sales page; ' +
        'and the exact card popular_rank from the public /popular list when present. ' +
        'Return structured fields: player_id, games, games_console, games_pc, popular_rank, popularity_count, sales_history[]. ' +
        'Each sales_history row may contain date, listed_for, sold_for, ea_tax, net_price, status. ' +
        'Missing evidence must be null or empty array. Never infer or invent Games, rank, sales, dates, or prices. ' +
        'Do not log in and do not bypass CAPTCHA, paywalls, anti-bot protections, rate limits, or access controls.';

      let created;
      if (baseTask?.id) {
        created = await fetchJson(
          PARSE_API_ROOT + '/dispatch/tasks/' + encodeURIComponent(String(baseTask.id)) + '/revise',
          {
            method: 'POST',
            headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ revision: revisionText })
          }
        );
      } else {
        const seed = String(seedPlayerId || '').replace(/\\D/g, '') || '2560';
        created = await fetchJson(PARSE_API_ROOT + '/dispatch', {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: 'https://www.futbin.com/26/pgp?pid=' + seed,
            task: revisionText,
            force_new: true
          })
        });
      }

      const taskId = String(created?.task_id || '');
      if (!taskId) throw new Error('PARSE_REVISION_NO_TASK_ID');
      const provider = await pollParseRevisionTask(taskId, apiKey);
      parseExtendedProvider = provider;
      parseProviderDiscoveryAt = Date.now();
      extendedDataState.extendedEvidenceStatus = 'ACTIVE';
      extendedDataState.extendedEvidenceLastError = null;
      return provider;
    } catch (error) {
      extendedDataState.extendedEvidenceStatus = 'PROVISION_FAILED';
      extendedDataState.extendedEvidenceLastError = String(error?.message || error);
      return null;
    } finally {
      parseProviderProvisionPromise = null;
    }
  })();

  return parseProviderProvisionPromise;
}

function scheduleParseExtendedProvision(seedPlayerId, apiKey) {
  if (!FUTBIN_EXTENDED_AUTO_PROVISION || parseProviderProvisionPromise) return;
  void provisionParseExtendedProvider(seedPlayerId, apiKey);
}

async function callParseExtendedProvider(provider, playerId, apiKey) {
  if (!provider?.baseUrl || !provider?.endpoint) return null;
  const method = String(provider.method || 'GET').toUpperCase();
  const base = String(provider.baseUrl).replace(/\\/+$/, '') + '/' + encodeURIComponent(provider.endpoint);
  if (method === 'POST') {
    return await fetchJson(base, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_id: String(playerId) })
    });
  }
  return await fetchJson(base + '?player_id=' + encodeURIComponent(String(playerId)), {
    headers: { 'X-API-Key': apiKey }
  });
}

function mergeStructuredEvidence(primary = {}, secondary = {}) {
  const merged = { ...primary };
  for (const [key, value] of Object.entries(secondary || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean') {
      merged[key] = Boolean(merged[key]) || value;
      continue;
    }
    if (Number.isFinite(Number(value))) {
      const n = Number(value);
      if (!Number.isFinite(Number(merged[key])) || Number(merged[key]) <= 0 || n > 0) merged[key] = n;
      continue;
    }
    if (Array.isArray(value) && value.length) merged[key] = value;
    else if (typeof value === 'string' && value.trim()) merged[key] = value;
  }
  merged.gamesAvailable = Boolean(merged.gamesAvailable || Number(merged.futbinGamesCount) > 0);
  merged.salesHistoryAvailable = Boolean(merged.salesHistoryAvailable || Number(merged.futbinSoldSampleCount) > 0);
  return merged;
}

async function fetchFutbinExtendedEvidence(playerId, livePrice = null) {
  const endpoint = String(extendedDataState.extendedEvidenceEndpoint || '').trim();
  const apiKey = String(process.env.FUTBIN_PARSE_API_KEY || '').trim();
  const id = String(playerId || '').trim();
  if (!endpoint || !apiKey || !/^\\d+$/.test(id)) return null;

  const now = Date.now();
  const cached = futbinExtendedEvidenceCache.get(id);
  if (cached && now - cached.at < FUTBIN_EXTENDED_EVIDENCE_CACHE_MS) return cached.value;

  extendedDataState.extendedEvidenceCalls += 1;
  extendedDataState.extendedEvidenceLastAt = new Date().toISOString();
  extendedDataState.extendedEvidenceStatus = 'FETCHING';

  try {
    let json = null;

    if (!sameScraperExtendedEndpointMissing) {
      try {
        const url = FUTBIN_PARSE_API_BASE + '/' + encodeURIComponent(endpoint) + '?player_id=' + encodeURIComponent(id);
        json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
      } catch (primaryError) {
        const primaryMessage = String(primaryError?.message || primaryError);
        if (/HTTP 404|not found|unknown endpoint|endpoint.*exist/i.test(primaryMessage)) {
          sameScraperExtendedEndpointMissing = true;
        } else {
          throw primaryError;
        }
      }
    }

    if (!json) {
      const provider = parseExtendedProvider || await discoverParseExtendedProvider(apiKey).catch(() => null);
      if (provider) {
        json = await callParseExtendedProvider(provider, id, apiKey);
      } else {
        extendedDataState.extendedEvidenceStatus = FUTBIN_EXTENDED_AUTO_PROVISION ? 'PROVISIONING_PARSE_ENDPOINT' : 'ENDPOINT_NOT_INSTALLED';
        scheduleParseExtendedProvision(id, apiKey);
        return null;
      }
    }

    const payload = json?.data && typeof json.data === 'object' ? json.data : json;
    const evidence = extractFutbinStructuredEvidence(payload, livePrice);
    observeExtendedEvidence(evidence);
    extendedDataState.extendedEvidenceSuccesses += 1;
    extendedDataState.extendedEvidenceStatus = 'ACTIVE';
    extendedDataState.extendedEvidenceLastError = null;
    extendedDataState.extendedEvidenceUnavailableUntil = null;
    futbinExtendedEvidenceCache.set(id, { at: now, value: evidence });
    return evidence;
  } catch (error) {
    const message = String(error?.message || error);
    extendedDataState.extendedEvidenceFailures += 1;
    extendedDataState.extendedEvidenceLastError = message;
    if (/HTTP 404|not found|unknown endpoint|endpoint.*exist/i.test(message)) {
      parseExtendedProvider = null;
      parseProviderDiscoveryAt = 0;
      extendedDataState.extendedEvidenceStatus = FUTBIN_EXTENDED_AUTO_PROVISION ? 'PROVISIONING_PARSE_ENDPOINT' : 'ENDPOINT_NOT_INSTALLED';
      scheduleParseExtendedProvision(id, apiKey);
    } else if (/HTTP 429|rate limit/i.test(message)) {
      extendedDataState.extendedEvidenceStatus = 'RATE_LIMITED';
    } else if (/blocked|captcha|datadome|anti.?bot/i.test(message)) {
      extendedDataState.extendedEvidenceStatus = 'SOURCE_BLOCKED_NO_BYPASS';
    } else {
      extendedDataState.extendedEvidenceStatus = 'ERROR';
    }
    return null;
  }
}

function markParseCall({ ok = false, price = null, marketTrend = false, error = null } = {}) {
  extendedDataState.parseCalls += 1;
  extendedDataState.lastCallAt = new Date().toISOString();
  if (ok) {
    extendedDataState.parseSuccesses += 1;
    extendedDataState.lastSuccessAt = extendedDataState.lastCallAt;
    extendedDataState.lastError = null;
    if (Number.isFinite(Number(price)) && Number(price) > 0) {
      extendedDataState.currentPriceObserved = true;
      extendedDataState.priceObservationCount += 1;
    }
    if (marketTrend) extendedDataState.marketTrendObserved = true;
  } else {
    extendedDataState.parseFailures += 1;
    extendedDataState.lastError = String(error || 'PARSE_API_ERROR');
  }
}`
  );

  out = out.replace(
    `    directFutbinScrape: false
  };`,
    `    directFutbinScrape: false,
    currentPriceObserved: extendedDataState.currentPriceObserved,
    marketTrendObserved: extendedDataState.marketTrendObserved,
    priceObservationCount: extendedDataState.priceObservationCount,
    parseCalls: extendedDataState.parseCalls,
    parseSuccesses: extendedDataState.parseSuccesses,
    parseFailures: extendedDataState.parseFailures,
    lastCallAt: extendedDataState.lastCallAt,
    lastSuccessAt: extendedDataState.lastSuccessAt,
    lastError: extendedDataState.lastError,
    basicDataActive: extendedDataState.currentPriceObserved || extendedDataState.marketTrendObserved,
    extendedFieldsAvailable: {
      games: extendedDataState.gamesObserved,
      salesHistory: extendedDataState.salesHistoryObserved,
      popularRank: extendedDataState.popularRankObserved,
      observedSalesPerDay: extendedDataState.observedSalesPerDayObserved
    },
    extendedEvidenceEndpoint: extendedDataState.extendedEvidenceEndpoint || null,
    extendedEvidenceStatus: extendedDataState.extendedEvidenceStatus,
    extendedEvidenceCalls: extendedDataState.extendedEvidenceCalls,
    extendedEvidenceSuccesses: extendedDataState.extendedEvidenceSuccesses,
    extendedEvidenceFailures: extendedDataState.extendedEvidenceFailures,
    extendedEvidenceLastAt: extendedDataState.extendedEvidenceLastAt,
    extendedEvidenceLastError: extendedDataState.extendedEvidenceLastError,
    extendedEvidenceUnavailableUntil: extendedDataState.extendedEvidenceUnavailableUntil,
    extendedEvidencePolicy: 'PUBLIC_OR_AUTHORIZED_STRUCTURED_DATA_ONLY',
    extendedAutoProvision: FUTBIN_EXTENDED_AUTO_PROVISION,
    extendedProviderActive: Boolean(parseExtendedProvider?.baseUrl),
    extendedProviderBaseUrl: parseExtendedProvider?.baseUrl || FUTBIN_EXTENDED_PROVIDER_BASE_URL || null,
    extendedProviderEndpoint: parseExtendedProvider?.endpoint || null,
    extendedProviderTaskId: parseExtendedProvider?.taskId || null,
    sameScraperExtendedEndpointMissing
  };`
  );

  out = out.replace(
    `    const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
    const value = buildMarketContext(json, platform);
    marketCache = { at: Date.now(), platform, value };`,
    `    const json = await fetchJson(url, { headers: { 'X-API-Key': apiKey } });
    const value = buildMarketContext(json, platform);
    markParseCall({ ok: true, marketTrend: true });
    marketCache = { at: Date.now(), platform, value };`
  );
  out = out.replace(
    `  } catch (error) {
    const value = { ok: false, reason: String(error), direction: 'unknown', changePct: null, stabilityScore: 55, movers: [] };
    marketCache = { at: Date.now(), platform, value };`,
    `  } catch (error) {
    markParseCall({ ok: false, error });
    const value = { ok: false, reason: String(error), direction: 'unknown', changePct: null, stabilityScore: 55, movers: [] };
    marketCache = { at: Date.now(), platform, value };`
  );

  out = out.replace(
    `    const evidence = best ? extractFutbinStructuredEvidence(best, price || card.price) : { gamesAvailable: false, salesHistoryAvailable: false };
    observeExtendedEvidence(evidence);`,
    `    const searchEvidence = best ? extractFutbinStructuredEvidence(best, price || card.price) : { gamesAvailable: false, salesHistoryAvailable: false };
    const extendedEvidence = best?.id ? await fetchFutbinExtendedEvidence(best.id, price || card.price) : null;
    const evidence = mergeStructuredEvidence(searchEvidence, extendedEvidence || {});
    observeExtendedEvidence(evidence);
    markParseCall({ ok: true, price });`
  );
  out = out.replace(
    `  } catch (error) {
    const value = { ok: false, reason: String(error) };
    cache.set(cacheKey, { at: Date.now(), value });`,
    `  } catch (error) {
    markParseCall({ ok: false, error });
    const value = { ok: false, reason: String(error) };
    cache.set(cacheKey, { at: Date.now(), value });`
  );

  out = out.replace(
    `  for (const item of results) if (item?.card) byId.set(String(item.card.eaId), item.result);

  return cards.map(card => {`,
    `  for (const item of results) if (item?.card) byId.set(String(item.card.eaId), item.result);

  // v2.10.12: persist only actual Parse/FUTBIN current-price observations in a
  // dedicated table, then derive our own 24h trend memory without touching the
  // FUT.GG primary history or adding any extra Parse API calls.
  const futbinObservations = results
    .filter(item => item?.card && Number.isFinite(Number(item?.result?.price)) && Number(item.result.price) > 0)
    .map(item => ({ eaId: Number(item.card.eaId), price: Number(item.result.price) }));
  await recordFutbinPriceObservations(futbinObservations, platform).catch(() => ({ inserted: 0 }));
  const futbinHistory = await loadFutbinPriceFeatures(futbinObservations.map(x => x.eaId), platform).catch(() => new Map());

  return cards.map(card => {`
  );

  out = out.replace(
    `    const evidence = result?.evidence || {};

    let popularityScore`,
    `    const evidence = result?.evidence || {};
    const futbinOwnHistory = futbinHistory.get(String(card.eaId)) || null;

    let popularityScore`
  );

  out = out.replace(
    `      expectedSalesPerDay: Number.isFinite(evidence.futbinObservedSalesPerDay) ? Number(evidence.futbinObservedSalesPerDay) : card.expectedSalesPerDay ?? null
    };`,
    `      expectedSalesPerDay: Number.isFinite(evidence.futbinObservedSalesPerDay) ? Number(evidence.futbinObservedSalesPerDay) : card.expectedSalesPerDay ?? null,
      futbinOwnHistorySamples: Number(futbinOwnHistory?.samples || 0),
      futbinOwnAvg24h: Number.isFinite(Number(futbinOwnHistory?.avg24h)) ? Number(futbinOwnHistory.avg24h) : null,
      futbinOwnTrendPct24h: Number.isFinite(Number(futbinOwnHistory?.trendPct24h)) ? Number(futbinOwnHistory.trendPct24h) : null,
      futbinOwnHistoryLastAt: futbinOwnHistory?.lastAt || null
    };`
  );

  const required = ['markParseCall', 'currentPriceObserved', 'marketTrendObserved', 'recordFutbinPriceObservations', 'futbinOwnTrendPct24h'];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error('[ÜV v2.10.12] FUTBIN Parse real-data patch failed: ' + missing.join(', '));
  return out;
}


function patchUvFutbinEvidenceV21010(source) {
  let out = String(source || '');
  out = out.replace(
    "'pgp_games', 'pgpgames', 'matches_played', 'matchesplayed'",
    "'pgp_games', 'pgpgames', 'matches_played', 'matchesplayed', 'games_console', 'console_games', 'games_ps', 'ps_games', 'games_playstation'"
  );
  out = out.replace(
    "'usage_rank', 'usagerank', 'games_rank', 'gamesrank'",
    "'usage_rank', 'usagerank', 'games_rank', 'gamesrank', 'popular_position', 'popularposition', 'popularity_position', 'popularityposition'"
  );
  if (!out.includes("'games_console'") || !out.includes("'popular_position'")) {
    throw new Error('[ÜV v2.10.12] FUTBIN extended evidence parser patch failed.');
  }
  return out;
}

function patchUvEngineV2105(source) {
  let out = String(source || '');

  const supplyAwareBlock = (threshold, min82, min83, preferred) => `if (ideal >= ${threshold}) {
    // v2.10.12: count HIGH-tier capacity with the SAME per-player cap used by
    // maxAffordablePortfolioCount(). Raw row counts can overstate supply when
    // several versions belong to the same footballer, which previously caused
    // "100 structural / 98 after Endgame-Mix" false negatives.
    const usableHighSlots = minOverall => {
      const playerCounts = new Map();
      let usable = 0;
      for (const card of rows) {
        if (!isPublicTraderSpecial(card) && Number(card?.overall || 0) < minOverall) continue;
        const playerKey = optimizerPlayerKey(card);
        if ((playerCounts.get(playerKey) || 0) >= 3) continue;
        playerCounts.set(playerKey, (playerCounts.get(playerKey) || 0) + 1);
        usable += 1;
        if (usable >= targetCount) break;
      }
      return usable;
    };
    const high83PlusOrSpecial = usableHighSlots(83);
    const high84PlusOrSpecial = usableHighSlots(84);
    const required82OrLess = Math.max(0, targetCount - high83PlusOrSpecial);
    const required83OrLess = Math.max(0, targetCount - high84PlusOrSpecial);
    // Small feasibility slack prevents cheap lower-tier versions from consuming
    // player-cap slots needed by higher versions during the cheapest-first pass.
    // These are MAXIMUMS, not targets. Ranking still prefers stronger cards.
    const mixSlack = Math.max(2, Math.ceil(targetCount * 0.04));
    return {
      active: true,
      maxBase82: Math.min(targetCount, Math.max(${min82}, required82OrLess + mixSlack)),
      maxBase83OrLess: Math.min(targetCount, Math.max(${min83}, required83OrLess + mixSlack)),
      maxBase84OrLess: Infinity,
      maxBase86OrLess: Infinity,
      preferredBaseMin: ${preferred},
      supplyAwareHard100: true,
      playerCapAwareHard100: true,
      mixSlack
    };
  }`;

  out = out.replace(
    /if \(ideal >= 2500\) return \{\s*active: true,\s*maxBase82: Math\.max\(1, Math\.round\(targetCount \* 0\.02\)\),\s*maxBase83OrLess: Math\.max\(6, Math\.round\(targetCount \* 0\.08\)\),\s*maxBase84OrLess: Infinity,\s*maxBase86OrLess: Infinity,\s*preferredBaseMin: 84\s*\};/m,
    supplyAwareBlock(2500, "Math.max(1, Math.round(targetCount * 0.02))", "Math.max(6, Math.round(targetCount * 0.08))", 84)
  );

  out = out.replace(
    /if \(ideal >= 1500\) return \{\s*active: true,\s*maxBase82: Math\.max\(3, Math\.round\(targetCount \* 0\.05\)\),\s*maxBase83OrLess: Math\.max\(10, Math\.round\(targetCount \* 0\.16\)\),\s*maxBase84OrLess: Infinity,\s*maxBase86OrLess: Infinity,\s*preferredBaseMin: 84\s*\};/m,
    supplyAwareBlock(1500, "Math.max(3, Math.round(targetCount * 0.05))", "Math.max(10, Math.round(targetCount * 0.16))", 84)
  );

  out = out.replace(
    /if \(ideal >= 900\) return \{\s*active: true,\s*maxBase82: Math\.max\(7, Math\.round\(targetCount \* 0\.12\)\),\s*maxBase83OrLess: Math\.max\(18, Math\.round\(targetCount \* 0\.28\)\),\s*maxBase84OrLess: Infinity,\s*maxBase86OrLess: Infinity,\s*preferredBaseMin: 83\s*\};/m,
    supplyAwareBlock(900, "Math.max(7, Math.round(targetCount * 0.12))", "Math.max(18, Math.round(targetCount * 0.28))", 83)
  );

  return out;
}

export async function load(url, context, defaultLoad) {
  const result = await defaultLoad(url, context, defaultLoad);
  if (result.format !== 'module') return result;

  const raw = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');

  if (url.endsWith('/uv/uvApp.js')) {
    const patched = patchUvAppV2105(raw);
    console.log('[ÜV] v2.10.12 runtime patch active: hard-100 + unsaved live-recheck + FUTBIN Parse memory/status.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/db.js')) {
    const patched = patchUvDbV2108(raw);
    if (!patched.includes("transientRecheckOnly") || !patched.includes('uv_futbin_price_history') || !patched.includes('recordFutbinPriceObservations')) throw new Error('[ÜV v2.10.12] transient DB/FUTBIN history patch failed.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/futbin.js')) {
    const patched = patchUvFutbinV2109(raw);
    console.log('[ÜV] v2.10.12 FUTBIN active: prices/trends + auto Parse revision for real Games/Sales/Popular-Rank.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/futbinEvidence.js')) {
    const patched = patchUvFutbinEvidenceV21010(raw);
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/uvEngine.js')) {
    const patched = patchUvEngineV2105(raw);
    if (!patched.includes('supplyAwareHard100') || !patched.includes('playerCapAwareHard100')) throw new Error('[ÜV v2.10.12] player-cap-aware hard-100 patch failed.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (!url.endsWith('/server.js')) return result;

  const base64 = patchServerV1064(raw);
  if (!base64?.source) throw new Error('[v10.67.5] v10.64 base patch failed.');

  const rating = patchRatingOnly(base64.source);
  if (!rating?.source) throw new Error('[v10.67.5] v10.65 rating patch failed.');

  const bridge = patchFutbinBridgeV1066(rating.source);
  if (!bridge?.source) throw new Error('[v10.67.5] FUTBIN bridge patch failed.');

  const final = patchTraderBrainFutbinV10673(bridge.source);
  if (!final?.source) throw new Error('[v10.67.5] Trader Brain FUTBIN extended patch failed.');

  const required = [
    './futbinBridgeV1066.js',
    'enrichRowsWithFutbinSafeV1066',
    'v10.66 FUTBIN bridge router',
    'RATING_ONLY_BUY_SELL',
    '10.67.5-final',
    'adaptiveV1062Status({ pool: null, gameYear: GAME_YEAR })',
    './uvGenerateAsyncV2105.js',
    'createUvGenerateAsyncRouterV2105',
    'sourceBusyGrace',
    'busySafeAllowed',
    './traderFutbinExtendedV10673.js',
    'traderFutbinExtendedStatusV10673',
    'futbinGames',
    'futbinPopularRank',
    'futbinSalesHistory'
  ];
  const missing = required.filter(marker => !final.source.includes(marker));
  if (missing.length) throw new Error('[v10.67.5] patch incomplete: ' + missing.join(', '));

  console.log('[v10.67.5] FINAL patch active: Trader Brain FUTBIN warmup-order fix + Games + Sales + Popular-Rank.');
  return { format: result.format, source: final.source, shortCircuit: true };
}
