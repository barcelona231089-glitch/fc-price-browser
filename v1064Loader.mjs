
export const V1064_BOOTSTRAP_VERSION = '10.64-bootstrap-final';

function stripOwnerMetadataBlocks(source, owner, metadataLiteral = false) {
  const esc = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sourceExpr = metadataLiteral
    ? `["']FUT\\.GG players\\/v2["']`
    : `${esc}\\.marketMetadataSource\\s*\\?\\?\\s*null`;

  const block = new RegExp(
    `[ \\t]*isSbc:\\s*${esc}\\.isSbc\\s*\\?\\?\\s*null,[ \\t]*\\r?\\n` +
    `[ \\t]*isObjective:\\s*${esc}\\.isObjective\\s*\\?\\?\\s*null,[ \\t]*\\r?\\n` +
    `[ \\t]*isExtinct:\\s*${esc}\\.isExtinct\\s*\\?\\?\\s*null,[ \\t]*\\r?\\n` +
    `[ \\t]*premiumSeasonPassLevel:\\s*${esc}\\.premiumSeasonPassLevel\\s*\\?\\?\\s*null,[ \\t]*\\r?\\n` +
    `[ \\t]*standardSeasonPassLevel:\\s*${esc}\\.standardSeasonPassLevel\\s*\\?\\?\\s*null,[ \\t]*\\r?\\n` +
    `[ \\t]*marketMetadataSource:\\s*${sourceExpr},[ \\t]*\\r?\\n`,
    'g'
  );
  return source.replace(block, '');
}

function patchMetadataBridge(source) {
  // Normalize old/manual v2.10.4 edits first, then place the bridge only where
  // the data is born, carried into priced rows, and exposed to the UV snapshot.
  source = stripOwnerMetadataBlocks(source, 'card', false);
  source = stripOwnerMetadataBlocks(source, 'row', false);

  source = source.replace(
    /[ \t]*isSbc:\s*p(?:\?)?\.isSbc\s*\?\?\s*null,[ \t]*\r?\n[ \t]*isObjective:\s*p(?:\?)?\.isObjective\s*\?\?\s*null,[ \t]*\r?\n[ \t]*isExtinct:\s*p(?:\?)?\.isExtinct\s*\?\?\s*null,[ \t]*\r?\n[ \t]*premiumSeasonPassLevel:\s*p(?:\?)?\.premiumSeasonPassLevel\s*\?\?\s*null,[ \t]*\r?\n[ \t]*standardSeasonPassLevel:\s*p(?:\?)?\.standardSeasonPassLevel\s*\?\?\s*null,[ \t]*\r?\n[ \t]*marketMetadataSource:\s*["']FUT\.GG players\/v2["'],[ \t]*\r?\n/g,
    ''
  );

  // Every FUT.GG players/v2 mapper gets explicit market metadata.
  source = source.replace(
    /^([ \t]*)slug:\s*(p(?:\?)?\.slug)\s*\?\?\s*null,?[ \t]*$/gm,
    (full, indent, expr) => `${indent}slug: ${expr} ?? null,\n` +
      `${indent}isSbc: p?.isSbc ?? null,\n` +
      `${indent}isObjective: p?.isObjective ?? null,\n` +
      `${indent}isExtinct: p?.isExtinct ?? null,\n` +
      `${indent}premiumSeasonPassLevel: p?.premiumSeasonPassLevel ?? null,\n` +
      `${indent}standardSeasonPassLevel: p?.standardSeasonPassLevel ?? null,\n` +
      `${indent}marketMetadataSource: "FUT.GG players/v2",`
  );

  // Priced market rows preserve the metadata.
  source = source.replace(
    /^([ \t]*)priceLookupId:\s*priceKey,?[ \t]*$/gm,
    (full, indent) => `${indent}priceLookupId: priceKey,\n` +
      `${indent}isSbc: card.isSbc ?? null,\n` +
      `${indent}isObjective: card.isObjective ?? null,\n` +
      `${indent}isExtinct: card.isExtinct ?? null,\n` +
      `${indent}premiumSeasonPassLevel: card.premiumSeasonPassLevel ?? null,\n` +
      `${indent}standardSeasonPassLevel: card.standardSeasonPassLevel ?? null,\n` +
      `${indent}marketMetadataSource: card.marketMetadataSource ?? null,`
  );

  // Shared Trader Brain -> UV snapshot preserves the same metadata.
  source = source.replace(
    /^([ \t]*)priceSource:\s*["']FUT\.GG \/ shared Trader Brain snapshot["'],?[ \t]*$/gm,
    (full, indent) => `${indent}priceSource: "FUT.GG / shared Trader Brain snapshot",\n` +
      `${indent}isSbc: row.isSbc ?? null,\n` +
      `${indent}isObjective: row.isObjective ?? null,\n` +
      `${indent}isExtinct: row.isExtinct ?? null,\n` +
      `${indent}premiumSeasonPassLevel: row.premiumSeasonPassLevel ?? null,\n` +
      `${indent}standardSeasonPassLevel: row.standardSeasonPassLevel ?? null,\n` +
      `${indent}marketMetadataSource: row.marketMetadataSource ?? null,`
  );

  return source;
}

export function patchServer(source) {
  const original = source;

  if (!source.includes('./adaptiveBrainV1064.js')) {
    source = source.replace(
      'import { createHaCoordinator } from "./haCoordinator.js";',
      `import { createHaCoordinator } from "./haCoordinator.js";
import {
  adaptiveV1062ApplyCycle,
  adaptiveV1062RecalibrateRow,
  adaptiveV1062RecalibrateCachedRow,
  adaptiveV1062NeedsFutbinDeepDive,
  adaptiveV1062DiscordPayloadAllowed,
  adaptiveV1062CpuAllows,
  adaptiveV1062CpuSnapshot,
  adaptiveV1062Status,
  adaptiveV1062ImportSeasonMemory
} from "./adaptiveBrainV1064.js";
import {
  enrichRowsWithFutbinPublicGapFill,
  bootstrapFc26SeasonMemory,
  attachSeasonMemoryToRows,
  startFc26Backfill,
  futbinPublicStatus,
  refreshFutbinMarketOverview
} from "./futbinMarketV1064.js";`
    );
  }

  source = patchMetadataBridge(source);

  // Give the adaptive layer all FUT.GG dimensions already present in the universe.
  if (!source.includes('v10.64 FUT.GG trading dimensions')) {
    source = source.replace(
      `      position: card.position,
      club: card.club,
      url: card.url,
      price: card.price,`,
      `      position: card.position,
      club: card.club,
      // v10.64 FUT.GG trading dimensions
      nation: card.nation ?? null,
      league: card.league ?? null,
      rarityGroupName: card.rarityGroupName ?? null,
      slug: card.slug ?? null,
      isSbc: card.isSbc ?? null,
      isObjective: card.isObjective ?? null,
      isExtinct: card.isExtinct ?? null,
      premiumSeasonPassLevel: card.premiumSeasonPassLevel ?? null,
      standardSeasonPassLevel: card.standardSeasonPassLevel ?? null,
      marketMetadataSource: card.marketMetadataSource ?? null,
      url: card.url,
      price: card.price,`
    );
  }

  // Apply adaptive intelligence after the existing quantitative/leak/source layers
  // have built their evidence for the cycle.
  if (!source.includes('v10.64 adaptive cycle')) {
    source = source.replace(
      `  await persistDiscordSignalMarketConfirmations(rows, brainWork);`,
      `  await persistDiscordSignalMarketConfirmations(rows, brainWork);

  // v10.64 adaptive cycle: market regime + catalyst graph + source learning +
  // card/pattern/season memory. This mutates rows and keeps NO_CALL internal.
  await adaptiveV1062ApplyCycle({
    rows,
    brainWork,
    marketContext: globalMarketContext,
    ratingStats,
    activeSignals,
    gameYear: GAME_YEAR,
    pool: dbEnabled ? pool : null
  });`
    );
  }

  // A Gemini refinement is still passed through the same learned risk/calibration layer.
  if (!source.includes('v10.64 Gemini final recalibration')) {
    source = source.replace(
      `      applyDecisionPerformanceCalibration(geminiCandidate.row, decisionPerformanceCache);`,
      `      applyDecisionPerformanceCalibration(geminiCandidate.row, decisionPerformanceCache);
      // v10.64 Gemini final recalibration
      await adaptiveV1062RecalibrateRow(geminiCandidate.row, geminiCandidate.work, {
        gameYear: GAME_YEAR,
        pool: dbEnabled ? pool : null,
        marketContext: latestMarketContext
      });`
    );
  }

  // After FUTBIN enrichment + old strict guards, v10.64 is the final public decision.
  if (!source.includes('v10.64 final per-row decision')) {
    source = source.replace(
      `      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        calibrateStrictBuyDecision(row, work);
        applyAlertSanityGuard(row);`,
      `      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        calibrateStrictBuyDecision(row, work);
        applyAlertSanityGuard(row);
        // v10.64 final per-row decision
        adaptiveV1062RecalibrateCachedRow(row, work, {
          gameYear: GAME_YEAR,
          marketContext: latestMarketContext
        });`
    );
  }

  // FUTBIN Parse remains quota-aware: only relevant cards get a deep dive.
  if (!source.includes('v10.64 adaptive FUTBIN deep-dive')) {
    source = source.replace(
      `  if (row.tracked && confidence >= 75) return true;`,
      `  // v10.64 adaptive FUTBIN deep-dive
  if (adaptiveV1062NeedsFutbinDeepDive(row)) return true;
  if (row.tracked && confidence >= 75) return true;`
    );
  }

  // v10.64 Parse provider disabled defensively. The old helper stays in server.js
  // for compatibility, but it can no longer make provider calls.
  if (!source.includes('v10.64 Parse provider disabled')) {
    source = source.replace(
      `async function enrichImportantRowsWithFutbinParse(rows, brainWork) {`,
      `async function enrichImportantRowsWithFutbinParse(rows, brainWork) {
  // v10.64 Parse provider disabled
  return 0;`
    );
  }

  // v10.64 FUT.GG-first FUTBIN gap-fill. Replace the Parse call itself so
  // whitespace/layout changes in server.js do not bring the 402 path back.
  if (!source.includes('v10.64 public FUTBIN gap fill')) {
    source = source.replace(
      'await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);',
      `// v10.64 public FUTBIN gap fill
      await enrichRowsWithFutbinPublicGapFill({
        rows: latestTradingRows,
        brainWork: built.brainWork,
        gameYear: GAME_YEAR,
        pool: dbEnabled ? pool : null
      });
      await attachSeasonMemoryToRows({
        rows: latestTradingRows,
        pool: dbEnabled ? pool : null,
        gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR
      });`
    );
  }

  // Final recalibration after public FUTBIN sales/games/trend + season memory.
  if (!source.includes('v10.64 FUTBIN + FC26 recalibration')) {
    source = source.replace(
      'await automaticTraderBrain(latestTradingRows, built.brainWork);',
      `// v10.64 FUTBIN + FC26 recalibration
      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        adaptiveV1062RecalibrateCachedRow(row, work, {
          gameYear: GAME_YEAR,
          marketContext: latestMarketContext
        });
      }
      await automaticTraderBrain(latestTradingRows, built.brainWork);`
    );
  }

  // CPU governor: protect Wispbyte from the host's CPU stop threshold.
  if (!source.includes('v10.64 CPU governor market gate')) {
    source = source.replace(
      `async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (monitoringBusy) return;`,
      `async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (monitoringBusy) return;
  // v10.64 CPU governor market gate
  if (!adaptiveV1062CpuAllows('market')) {
    lastMonitorError = null;
    return;
  }`
    );
  }

  if (!source.includes('v10.64 CPU governor metadata gate')) {
    source = source.replace(
      `    () => {
      ensureUniverse(true).catch(`,
      `    () => {
      // v10.64 CPU governor metadata gate
      if (!adaptiveV1062CpuAllows('metadata')) return;
      ensureUniverse(true).catch(`
    );
  }

  // Public Discord trading output: KAUFEN / VERKAUFEN only.
  if (!source.includes('v10.64 BUY/SELL-only Discord gate')) {
    source = source.replace(
      `async function sendDiscordPayload(payload) {
  if (HA_ENABLED && !haIsLeader()) throw new Error("HA_STANDBY: Discord send blocked on passive instance");`,
      `async function sendDiscordPayload(payload) {
  // v10.64 BUY/SELL-only Discord gate. No health/HA/system notices are public.
  if (!adaptiveV1062DiscordPayloadAllowed(payload)) return { ok: false, skipped: "v10.64_buy_sell_only" };
  if (HA_ENABLED && !haIsLeader()) throw new Error("HA_STANDBY: Discord send blocked on passive instance");`
    );
  }

  source = source.replace(
    `const emoji = type === "buy" ? "🟢" : type === "sell" ? "💰" : type === "data" ? "⚠️" : "🚨";`,
    `const emoji = type === "buy" ? "🟢" : type === "sell" ? "🔴" : type === "data" ? "⚠️" : "🚨";`
  );
  source = source.replace(
    `const titleAction = type === "buy" ? "TRADER-ANGEBOT" : type === "crash" ? "NOCH WARTEN" : type === "data" ? "DATEN PRÜFEN" : row.aiAction;`,
    `const titleAction = type === "buy" ? "KAUFEN" : type === "sell" ? "VERKAUFEN" : type === "crash" ? "NOCH WARTEN" : type === "data" ? "DATEN PRÜFEN" : row.aiAction;`
  );

  // Public leaks are lightweight and important for catalysts. Poll every 2 minutes;
  // direct X remains separately rate-limited/backed off by the existing code.
  source = source.replace(
    `Number(process.env.PUBLIC_LEAK_POLL_INTERVAL_MIN || 5)`,
    `Number(process.env.PUBLIC_LEAK_POLL_INTERVAL_MIN || 2)`
  );

  // v10.64 automatic low-rate FC26 FUTBIN backfill after the first healthy market snapshot.
  if (!source.includes('v10.64 automatic FC26 backfill')) {
    source = source.replace(
      /(latestTradingRows\s*=\s*built\.rows;\s*\n\s*latestFutbinFallbackRows\s*=\s*\[\];)/,
      `$1
      // v10.64 automatic FC26 backfill
      if (dbEnabled && !globalThis.__fcV1063BackfillStarted && latestTradingRows.length >= 100) {
        globalThis.__fcV1063BackfillStarted = true;
        startFc26Backfill({ rows: latestTradingRows, pool, gameYear: "26", limit: 500 })
          .then(result => console.log(\`[v10.64] FC26 FUTBIN backfill gestartet: \${JSON.stringify(result)}\`))
          .catch(error => console.error("[v10.64] FC26 FUTBIN backfill start error:", error));
      }`
    );
  }

  // v10.64: build the FC26 season-memory summary from every historical
  // PostgreSQL price point already available. Runs in background, never blocks boot.
  if (!source.includes('v10.64 FC26 season bootstrap')) {
    source = source.replace(
      `    await initDb();
  } catch (error) {`,
      `    await initDb();
    // v10.64 FC26 season bootstrap
    if (dbEnabled) {
      bootstrapFc26SeasonMemory({ pool, gameYear: "26" })
        .then(result => console.log(\`[v10.64] FC26 Season Memory bootstrap: \${JSON.stringify(result)}\`))
        .catch(error => console.error("[v10.64] FC26 Season Memory bootstrap error:", error));
    }
  } catch (error) {`
    );
  }

  // Monitoring endpoints for the final brain, FUTBIN intelligence and FC26 memory.
  if (!source.includes('/api/adaptive-brain/status')) {
    source = source.replace(
      `app.get("/api/trader-brain/status", (req, res) => {`,
      `app.get("/api/adaptive-brain/status", async (req, res) => {
  try {
    const status = await adaptiveV1062Status({
      pool: dbEnabled ? pool : null,
      gameYear: GAME_YEAR
    });
    res.json(status);
  } catch (error) {
    res.status(500).json({ ok: false, version: "10.64-complete-market-memory", error: String(error) });
  }
});

app.post("/api/adaptive-brain/memory/import", async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "PostgreSQL ist fuer Season Memory erforderlich." });
  try {
    const result = await adaptiveV1062ImportSeasonMemory({
      pool,
      gameYear: String(req.body?.gameYear || "26"),
      records: Array.isArray(req.body?.records) ? req.body.records : []
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.get("/api/final-project/status", async (req, res) => {
  try {
    const [adaptive, futbin] = await Promise.all([
      adaptiveV1062Status({ pool: dbEnabled ? pool : null, gameYear: GAME_YEAR }),
      futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })
    ]);
    res.json({
      ok: true,
      version: "10.64-final",
      gameYear: GAME_YEAR,
      runtime: {
        leader: HA_ENABLED ? haIsLeader() : true,
        haEnabled: HA_ENABLED,
        tradingRows: latestTradingRows.length,
        sourceHealth: latestSourceHealth,
        processingHealth: latestProcessingHealth,
        discord: {
          connected: discordClientReady,
          alertChannel: discordResolvedChannelName,
          traderSignalChannel: traderSignalResolvedChannelName,
          outputMode: "BUY_SELL_ONLY"
        },
        uv: getUvRuntimeStatus()
      },
      adaptive,
      futbin,
      checklist: {
        futggPrimary: true,
        futbinGapFill: true,
        futbinGamesTrendSales: true,
        soldVsUnsold: true,
        historyWindows: true,
        futbinMarketIndices: true,
        futbinMarketMomentum: true,
        sourceFreshness: true,
        fc26SeasonMemory: true,
        fc26EventMemory: true,
        fc26RegimeCalendar: true,
        fc27TransferLearning: true,
        discordBuySellOnly: true,
        parse402CriticalPathRemoved: true
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, version: "10.64-final", error: String(error) });
  }
});

app.get("/api/market-intelligence/player/:eaId", async (req, res) => {
  const id = String(req.params.eaId || "");
  const row = latestTradingRows.find(x => String(x.eaId) === id);
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  res.json({
    ok: true,
    eaId: id,
    name: row.name,
    price: row.price,
    action: row.aiAction,
    confidence: row.aiConfidence,
    adaptive: row.aiAdaptiveV1064 || row.aiAdaptiveV1062 || null,
    futgg: {
      demandEvidenceScore: row.demandEvidenceScore ?? null,
      popularityScore: row.popularityScore ?? null,
      inPacksHit: row.inPacksHit ?? null,
      supplyPressureScore: row.supplyPressureScore ?? null
    },
    futbin: row.futbinPublic || null,
    fc26SeasonMemory: row.fc26SeasonMemory || null,
    fc26GlobalMemory: row.fc26GlobalMemory || null
  });
});

app.post("/api/fc26-memory/rebuild", async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "PostgreSQL ist fuer FC26 Memory erforderlich." });
  try {
    const result = await bootstrapFc26SeasonMemory({ pool, gameYear: "26" });
    await attachSeasonMemoryToRows({ rows: latestTradingRows, pool, gameYear: "26" });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-brain/status", (req, res) => {`
    );
  }

  // v10.64 FUTBIN-public + FC26 backfill/status endpoints.
  if (!source.includes('/api/futbin-public/status')) {
    source = source.replace(
      `app.get("/api/trader-brain/status", (req, res) => {`,
      `app.get("/api/futbin-public/status", async (req, res) => {
  try {
    res.json(await futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: GAME_YEAR }));
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/api/fc26-memory/backfill", async (req, res) => {
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "PostgreSQL ist fuer FC26 Memory erforderlich." });
  try {
    const result = await startFc26Backfill({
      rows: latestTradingRows,
      pool,
      gameYear: "26",
      limit: Number(req.body?.limit || 500)
    });
    res.status(result.ok ? 202 : 409).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/fc26-memory/status", async (req, res) => {
  try {
    const status = await futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: "26" });
    res.json({ ok: true, season: "FC26", futbin: status });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-brain/status", (req, res) => {`
    );
  }

  // v10.64 unified read-only FC Market API. FUT.GG stays primary;
  // FUTBIN fills missing market intelligence and PostgreSQL supplies memory/history.
  if (!source.includes('/api/market/source-health')) {
    source = source.replace(
      `app.get("/api/trader-brain/status", (req, res) => {`,
      `function fcMarketApiAllowed(req) {
  const token = String(process.env.FC_MARKET_API_TOKEN || "").trim();
  if (!token) return true;
  const auth = String(req.headers.authorization || "");
  const bearer = auth.replace(/^Bearer\\s+/i, "").trim();
  const apiKey = String(req.headers["x-api-key"] || "").trim();
  return bearer === token || apiKey === token;
}

function fcMarketView(row) {
  if (!row) return null;
  return {
    eaId: String(row.eaId || ""),
    name: row.name || null,
    rating: row.rating ?? row.overall ?? null,
    position: row.position ?? null,
    alternatePositions: row.alternatePositions ?? [],
    nation: row.nation ?? null,
    league: row.league ?? null,
    club: row.club ?? null,
    cardType: row.cardType ?? null,
    rarityName: row.rarityName ?? null,
    tradeability: {
      isSbc: row.isSbc ?? null,
      isObjective: row.isObjective ?? null,
      isExtinct: row.isExtinct ?? null,
      premiumSeasonPassLevel: row.premiumSeasonPassLevel ?? null,
      standardSeasonPassLevel: row.standardSeasonPassLevel ?? null
    },
    prices: {
      futgg: Number(row.price) > 0 ? Number(row.price) : null,
      futbin: Number(row.futbinPrice) > 0 ? Number(row.futbinPrice) : null,
      medianActualSale: Number(row.futbinMedianSoldPrice) > 0 ? Number(row.futbinMedianSoldPrice) : null,
      lastActualSale: Number(row.futbinLastSalePrice) > 0 ? Number(row.futbinLastSalePrice) : null,
      lastActualSaleAt: row.futbinLastSaleAt ?? null,
      comparison: row.futbinPriceComparison ?? null
    },
    movement: {
      m1: row.change1m ?? null,
      m5: row.change5m ?? null,
      m15: row.change15m ?? null,
      h1: row.change1h ?? null,
      h24: row.change24h ?? null,
      futbin: row.futbinHistoryWindows ?? null
    },
    demand: {
      demandEvidenceScore: row.demandEvidenceScore ?? null,
      demandDataConfidence: row.demandDataConfidence ?? null,
      popularityScore: row.popularityScore ?? null,
      usagePct: row.usagePct ?? null,
      communityUsagePct: row.communityUsagePct ?? null,
      proUsagePct: row.proUsagePct ?? null,
      inPacksHit: row.inPacksHit ?? null,
      supplyPressureScore: row.supplyPressureScore ?? null,
      gamesPlayedConsole: row.futbinGamesPlayedConsole ?? null,
      gamesPlayedPc: row.futbinGamesPlayedPc ?? null,
      liquidityScore: row.futbinLiquidityScore ?? null,
      sellThroughRate: row.futbinSellThroughRate ?? null,
      saleVelocityPerHour: row.futbinSaleVelocityPerHour ?? null
    },
    futbin: row.futbinPublic ?? null,
    seasonMemory: row.fc26SeasonMemory ?? null,
    globalMemory: row.fc26GlobalMemory ?? null,
    decision: {
      action: row.aiAction ?? null,
      confidence: row.aiConfidence ?? null,
      publicCall: row.adaptivePublicCall ?? null,
      marketState: row.aiMarketState ?? null,
      reason: row.aiReason ?? null,
      adaptive: row.aiAdaptiveV1064 ?? row.aiAdaptiveV1062 ?? null
    }
  };
}

app.get("/api/market/player/:eaId", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const row = latestTradingRows.find(x => String(x.eaId) === String(req.params.eaId));
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  res.json({ ok: true, data: fcMarketView(row) });
});

app.get("/api/market/prices/:eaId", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const row = latestTradingRows.find(x => String(x.eaId) === String(req.params.eaId));
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  const view = fcMarketView(row);
  res.json({ ok: true, eaId: view.eaId, name: view.name, prices: view.prices, sales: row.futbinPublic?.salesMetrics ?? null });
});

app.get("/api/market/sales/:eaId", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "POSTGRES_REQUIRED" });
  const id = String(req.params.eaId || "");
  const limit = Math.max(10, Math.min(1000, Number(req.query.limit || 300)));
  try {
    const result = await pool.query('SELECT observed_at AS "observedAt", listed_price AS "listedPrice", sold_price AS "soldPrice", ea_tax AS "eaTax", net_price AS "netPrice", payload FROM fc_futbin_public_sales WHERE ea_id=$1 ORDER BY observed_at DESC NULLS LAST LIMIT $2', [id, limit]);
    res.json({ ok: true, eaId: id, rows: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/market/versions/:eaId", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const row = latestTradingRows.find(x => String(x.eaId) === String(req.params.eaId));
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  res.json({ ok: true, eaId: String(row.eaId), name: row.name, current: row.futbinPromoName ?? row.rarityName ?? null, versions: row.futbinAvailableVersions ?? row.futbinPublic?.availableVersions ?? [] });
});

app.get("/api/market/memory/:eaId", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const row = latestTradingRows.find(x => String(x.eaId) === String(req.params.eaId));
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  res.json({ ok: true, eaId: String(row.eaId), name: row.name, season: row.fc26SeasonMemory ?? null, global: row.fc26GlobalMemory ?? null, decisionMemory: row.aiAdaptiveV1064 ?? row.aiAdaptiveV1062 ?? null });
});

app.get("/api/market/history/:eaId", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "POSTGRES_REQUIRED" });
  const id = String(req.params.eaId || "");
  const limit = Math.max(10, Math.min(5000, Number(req.query.limit || 2000)));
  try {
    const [futgg, futbin, daily] = await Promise.all([
      pool.query('SELECT recorded_at AS "observedAt", price FROM fc_price_history WHERE ea_id::text=$1 ORDER BY recorded_at DESC LIMIT $2', [id, limit]),
      pool.query('SELECT observed_at AS "observedAt", price FROM fc_futbin_public_history WHERE ea_id=$1 ORDER BY observed_at DESC LIMIT $2', [id, limit]),
      pool.query('SELECT day, open_price AS "open", close_price AS "close", low_price AS "low", high_price AS "high", average_price AS "average", observations, source FROM fc_v1063_season_daily WHERE ea_id=$1 ORDER BY day DESC LIMIT 500', [id])
    ]);
    res.json({ ok: true, eaId: id, futgg: futgg.rows, futbin: futbin.rows, daily: daily.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/market/demand/:eaId", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const row = latestTradingRows.find(x => String(x.eaId) === String(req.params.eaId));
  if (!row) return res.status(404).json({ ok: false, error: "EA_ID_NOT_IN_CURRENT_SNAPSHOT" });
  res.json({ ok: true, eaId: String(row.eaId), name: row.name, demand: fcMarketView(row).demand });
});

app.get("/api/market/trends", (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  const allowed = { "1m":"change1m", "5m":"change5m", "15m":"change15m", "1h":"change1h", "24h":"change24h", "futbin":"futbinTrendPct" };
  const window = String(req.query.window || "15m");
  const field = allowed[window] || "change15m";
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
  const direction = String(req.query.direction || "rising").toLowerCase() === "falling" ? "falling" : "rising";
  const rows = latestTradingRows
    .filter(x => Number.isFinite(Number(x[field])))
    .sort((a,b) => direction === "falling" ? Number(a[field]) - Number(b[field]) : Number(b[field]) - Number(a[field]))
    .slice(0, limit)
    .map(x => ({ eaId:String(x.eaId), name:x.name, rating:x.rating ?? x.overall ?? null, price:x.price, change:Number(x[field]), action:x.aiAction, confidence:x.aiConfidence }));
  res.json({ ok: true, window, field, direction, rows });
});

app.get("/api/market/overview", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    const overview = await refreshFutbinMarketOverview({
      pool: dbEnabled ? pool : null,
      gameYear: GAME_YEAR,
      force: String(req.query.force || "").toLowerCase() === "true"
    });
    res.json({ ok: true, gameYear: GAME_YEAR, overview });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/market/events", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "POSTGRES_REQUIRED" });
  const gameYear = String(req.query.gameYear || (String(GAME_YEAR) === "27" ? "26" : GAME_YEAR)).replace(/\D/g, "").slice(-2);
  const type = String(req.query.type || "").trim().toUpperCase();
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
  try {
    const params = [gameYear, limit];
    let where = "game_year=$1";
    if (type) { params.push(type); where += " AND event_type=$3"; }
    const result = await pool.query(
      'SELECT event_id AS "eventId", event_type AS "eventType", source, event_at AS "eventAt", message, target, call, ' +
      'impact_15m AS "impact15m", impact_1h AS "impact1h", impact_6h AS "impact6h", impact_24h AS "impact24h", payload ' +
      'FROM fc_v1064_event_memory WHERE ' + where + ' ORDER BY event_at DESC NULLS LAST LIMIT $2',
      params
    );
    res.json({ ok: true, gameYear, type: type || null, rows: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/market/regimes", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  if (!dbEnabled) return res.status(503).json({ ok: false, error: "POSTGRES_REQUIRED" });
  const gameYear = String(req.query.gameYear || (String(GAME_YEAR) === "27" ? "26" : GAME_YEAR)).replace(/\D/g, "").slice(-2);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 400)));
  try {
    const result = await pool.query(
      'SELECT day, regime, median_change_pct AS "medianChangePct", rising_pct AS "risingPct", ' +
      'falling_pct AS "fallingPct", median_abs_change_pct AS "medianAbsChangePct", cards, payload ' +
      'FROM fc_v1064_regime_daily WHERE game_year=$1 ORDER BY day DESC LIMIT $2',
      [gameYear, limit]
    );
    res.json({ ok: true, gameYear, rows: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/market/source-health", async (req, res) => {
  if (!fcMarketApiAllowed(req)) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
  try {
    const futbin = await futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR });
    res.json({ ok: true, futgg: latestSourceHealth, processing: latestProcessingHealth, futbin, cpu: adaptiveV1062CpuSnapshot() });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-brain/status", (req, res) => {`
    );
  }

  // Surface CPU protection in health/readiness metadata without changing HA semantics.
  if (!source.includes('adaptiveCpuGovernor: adaptiveV1062CpuSnapshot()')) {
    source = source.replace(
      `    geminiQuota: getGeminiQuotaInfo(),`,
      `    geminiQuota: getGeminiQuotaInfo(),
    adaptiveCpuGovernor: adaptiveV1062CpuSnapshot(),`
    );
  }

  // Version labels.
  source = source.replaceAll('10.56-public-leak-learning-brain', '10.64-complete-market-memory');
  source = source.replace(
    'FC Trading Intelligence v10.61 AI Direction Consensus + Sheriff Multi-Source (FC${GAME_YEAR}) running on ${port}',
    'FC Trading Intelligence v10.64 FINAL Market Intelligence + FUTBIN Complete Gap-Fill + FC26 Season Brain (FC${GAME_YEAR}) running on ${port}'
  );

  // Root endpoint list gets the final diagnostic endpoints if the exact anchor exists.
  if (!source.includes('adaptiveBrainStatus: "GET /api/adaptive-brain/status"')) {
    source = source.replace(
      `      traderBrainStatus: "GET /api/trader-brain/status",`,
      `      traderBrainStatus: "GET /api/trader-brain/status",
      finalProjectStatus: "GET /api/final-project/status",
      marketIntelligencePlayer: "GET /api/market-intelligence/player/:eaId",
      fc26MemoryRebuild: "POST /api/fc26-memory/rebuild",
      adaptiveBrainStatus: "GET /api/adaptive-brain/status",
      adaptiveMemoryImport: "POST /api/adaptive-brain/memory/import",
      futbinPublicStatus: "GET /api/futbin-public/status",
      fc26MemoryBackfill: "POST /api/fc26-memory/backfill",
      fc26MemoryStatus: "GET /api/fc26-memory/status",
      marketPlayer: "GET /api/market/player/:eaId",
      marketPrices: "GET /api/market/prices/:eaId",
      marketSales: "GET /api/market/sales/:eaId",
      marketVersions: "GET /api/market/versions/:eaId",
      marketMemory: "GET /api/market/memory/:eaId",
      marketHistory: "GET /api/market/history/:eaId",
      marketDemand: "GET /api/market/demand/:eaId",
      marketTrends: "GET /api/market/trends",
      marketOverview: "GET /api/market/overview",
      marketEvents: "GET /api/market/events",
      marketRegimes: "GET /api/market/regimes",
      marketSourceHealth: "GET /api/market/source-health",`
    );
  }

  return { source, changed: source !== original };
}


export async function load(url, context, defaultLoad) {
  const result = await defaultLoad(url, context, defaultLoad);

  if (!url.endsWith('/server.js') || result.format !== 'module') {
    return result;
  }

  const raw = typeof result.source === 'string'
    ? result.source
    : Buffer.from(result.source).toString('utf8');

  const patched = patchServer(raw);
  if (!patched?.source || typeof patched.source !== 'string') {
    throw new Error('[v10.64] In-memory patch returned no server source.');
  }

  console.log(
    patched.changed
      ? '[v10.64] server.js in-memory gepatcht: FUTBIN Complete Gap-Fill + FC26 Season Brain + BUY/SELL only.'
      : '[v10.64] server.js bereits kompatibel; in-memory Loader aktiv.'
  );

  return {
    format: result.format,
    source: patched.source,
    shortCircuit: true
  };
}
