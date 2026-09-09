import { patchServer as patchServerV1064 } from './v1064Loader.mjs';
import { patchRatingOnly } from './v1065Loader.mjs';

export const V1066_BOOTSTRAP_VERSION = '10.66.8-unsaved-live-recheck';

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

  out = out.replaceAll('version: "10.64-final"', 'version: "10.66.8-final"');
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

function patchUvAppV2105(source) {
  let out = String(source || '');
  out = out.replace("const UV_VERSION = '2.10.4';", "const UV_VERSION = '2.10.7';");
  out = out.replace(
    'generationCpuSafeBatches: true,',
    'generationCpuSafeBatches: true, generationAsyncProxyJob: true, allocatorConsistentHard100Fallback: true, playerCapAwareHard100Mix: true, unsavedLiveRecheck: true, transientRecheckState: true, saveRequiredForLiveCheck: false,'
  );

  // v2.10.8: saving is optional. Unsaved lists get a hidden short-lived
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
    throw new Error('[ÜV v2.10.8] unsaved live-recheck persistence patch failed.');
  }

  // v2.10.8: when a fallback has already proven 100/100 with the REAL allocator,
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
    throw new Error('[ÜV v2.10.8] allocator-consistency patch failed.');
  }
  return out;
}


function patchUvDbV2108(source) {
  let out = String(source || '');

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

function patchUvEngineV2105(source) {
  let out = String(source || '');

  const supplyAwareBlock = (threshold, min82, min83, preferred) => `if (ideal >= ${threshold}) {
    // v2.10.8: count HIGH-tier capacity with the SAME per-player cap used by
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
    console.log('[ÜV] v2.10.8 runtime patch active: hard-100 + unsaved live-recheck/rebalance.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/db.js')) {
    const patched = patchUvDbV2108(raw);
    if (!patched.includes("transientRecheckOnly")) throw new Error('[ÜV v2.10.8] transient DB filter patch failed.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/uv/src/uvEngine.js')) {
    const patched = patchUvEngineV2105(raw);
    if (!patched.includes('supplyAwareHard100') || !patched.includes('playerCapAwareHard100')) throw new Error('[ÜV v2.10.8] player-cap-aware hard-100 patch failed.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (!url.endsWith('/server.js')) return result;

  const base64 = patchServerV1064(raw);
  if (!base64?.source) throw new Error('[v10.66.8] v10.64 base patch failed.');

  const rating = patchRatingOnly(base64.source);
  if (!rating?.source) throw new Error('[v10.66.8] v10.65 rating patch failed.');

  const final = patchFutbinBridgeV1066(rating.source);
  if (!final?.source) throw new Error('[v10.66.8] FUTBIN bridge patch failed.');

  const required = [
    './futbinBridgeV1066.js',
    'enrichRowsWithFutbinSafeV1066',
    'v10.66 FUTBIN bridge router',
    'RATING_ONLY_BUY_SELL',
    '10.66.8-final',
    'adaptiveV1062Status({ pool: null, gameYear: GAME_YEAR })',
    './uvGenerateAsyncV2105.js',
    'createUvGenerateAsyncRouterV2105',
    'sourceBusyGrace',
    'busySafeAllowed'
  ];
  const missing = required.filter(marker => !final.source.includes(marker));
  if (missing.length) throw new Error('[v10.66.8] patch incomplete: ' + missing.join(', '));

  console.log('[v10.66.8] FINAL patch active: Rating-only + FUTBIN bridge + monitor busy grace + ÜV 2.10.7 player-cap-aware hard-100.');
  return { format: result.format, source: final.source, shortCircuit: true };
}
