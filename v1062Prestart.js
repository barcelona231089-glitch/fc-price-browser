import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const V1062_BOOTSTRAP_VERSION = '10.62-bootstrap-1';

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, 'server.js');

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, before, after) {
  if (before === after) return false;
  fs.writeFileSync(file, after, 'utf8');
  return true;
}

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

function patchServer(source) {
  const original = source;

  if (!source.includes('./adaptiveBrainV1062.js')) {
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
} from "./adaptiveBrainV1062.js";`
    );
  }

  source = patchMetadataBridge(source);

  // Give the adaptive layer all FUT.GG dimensions already present in the universe.
  if (!source.includes('v10.62 FUT.GG trading dimensions')) {
    source = source.replace(
      `      position: card.position,
      club: card.club,
      url: card.url,
      price: card.price,`,
      `      position: card.position,
      club: card.club,
      // v10.62 FUT.GG trading dimensions
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
  if (!source.includes('v10.62 adaptive cycle')) {
    source = source.replace(
      `  await persistDiscordSignalMarketConfirmations(rows, brainWork);`,
      `  await persistDiscordSignalMarketConfirmations(rows, brainWork);

  // v10.62 adaptive cycle: market regime + catalyst graph + source learning +
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
  if (!source.includes('v10.62 Gemini final recalibration')) {
    source = source.replace(
      `      applyDecisionPerformanceCalibration(geminiCandidate.row, decisionPerformanceCache);`,
      `      applyDecisionPerformanceCalibration(geminiCandidate.row, decisionPerformanceCache);
      // v10.62 Gemini final recalibration
      await adaptiveV1062RecalibrateRow(geminiCandidate.row, geminiCandidate.work, {
        gameYear: GAME_YEAR,
        pool: dbEnabled ? pool : null,
        marketContext: latestMarketContext
      });`
    );
  }

  // After FUTBIN enrichment + old strict guards, v10.62 is the final public decision.
  if (!source.includes('v10.62 final per-row decision')) {
    source = source.replace(
      `      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        calibrateStrictBuyDecision(row, work);
        applyAlertSanityGuard(row);`,
      `      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        calibrateStrictBuyDecision(row, work);
        applyAlertSanityGuard(row);
        // v10.62 final per-row decision
        adaptiveV1062RecalibrateCachedRow(row, work, {
          gameYear: GAME_YEAR,
          marketContext: latestMarketContext
        });`
    );
  }

  // FUTBIN Parse remains quota-aware: only relevant cards get a deep dive.
  if (!source.includes('v10.62 adaptive FUTBIN deep-dive')) {
    source = source.replace(
      `  if (row.tracked && confidence >= 75) return true;`,
      `  // v10.62 adaptive FUTBIN deep-dive
  if (adaptiveV1062NeedsFutbinDeepDive(row)) return true;
  if (row.tracked && confidence >= 75) return true;`
    );
  }

  // New FUTBIN evidence must be re-read before automaticTraderBrain persists a call.
  if (!source.includes('v10.62 FUTBIN-aware recalibration before persist')) {
    source = source.replace(
      `      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);
      await automaticTraderBrain(latestTradingRows, built.brainWork);`,
      `      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);
      // v10.62 FUTBIN-aware recalibration before persist
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
  if (!source.includes('v10.62 CPU governor market gate')) {
    source = source.replace(
      `async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (monitoringBusy) return;`,
      `async function monitorOnce() {
  if (HA_ENABLED && !haIsLeader()) return;
  if (monitoringBusy) return;
  // v10.62 CPU governor market gate
  if (!adaptiveV1062CpuAllows('market')) {
    lastMonitorError = null;
    return;
  }`
    );
  }

  if (!source.includes('v10.62 CPU governor metadata gate')) {
    source = source.replace(
      `    () => {
      ensureUniverse(true).catch(`,
      `    () => {
      // v10.62 CPU governor metadata gate
      if (!adaptiveV1062CpuAllows('metadata')) return;
      ensureUniverse(true).catch(`
    );
  }

  // Public Discord trading output: KAUFEN / VERKAUFEN only.
  if (!source.includes('v10.62 BUY/SELL-only Discord gate')) {
    source = source.replace(
      `async function sendDiscordPayload(payload) {
  if (HA_ENABLED && !haIsLeader()) throw new Error("HA_STANDBY: Discord send blocked on passive instance");`,
      `async function sendDiscordPayload(payload) {
  // v10.62 BUY/SELL-only Discord gate. Operational health notices stay allowed.
  if (!adaptiveV1062DiscordPayloadAllowed(payload)) return { ok: false, skipped: "v10.62_buy_sell_only" };
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

  // Monitoring endpoints for the new brain and FC26/27 memory.
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
    res.status(500).json({ ok: false, version: "10.62-adaptive-market-intelligence", error: String(error) });
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
  source = source.replaceAll('10.56-public-leak-learning-brain', '10.62-adaptive-market-intelligence');
  source = source.replace(
    'FC Trading Intelligence v10.61 AI Direction Consensus + Sheriff Multi-Source (FC${GAME_YEAR}) running on ${port}',
    'FC Trading Intelligence v10.62 Adaptive Market Intelligence + FC26/27 Memory (FC${GAME_YEAR}) running on ${port}'
  );

  // Root endpoint list gets the new status endpoint if the exact anchor exists.
  if (!source.includes('adaptiveBrainStatus: "GET /api/adaptive-brain/status"')) {
    source = source.replace(
      `      traderBrainStatus: "GET /api/trader-brain/status",`,
      `      traderBrainStatus: "GET /api/trader-brain/status",
      adaptiveBrainStatus: "GET /api/adaptive-brain/status",
      adaptiveMemoryImport: "POST /api/adaptive-brain/memory/import",`
    );
  }

  return { source, changed: source !== original };
}

function run() {
  if (!fs.existsSync(serverPath)) {
    console.warn('[v10.62] server.js nicht gefunden; Bootstrap uebersprungen.');
    return;
  }

  try {
    const before = readText(serverPath);
    const result = patchServer(before);
    const changed = writeIfChanged(serverPath, before, result.source);

    if (changed) {
      console.log('[v10.62] server.js auf Adaptive Market Intelligence gepatcht. Bitte Server EINMAL NOCH neu starten.');
    } else if (result.source.includes('./adaptiveBrainV1062.js')) {
      console.log('[v10.62] Bootstrap bereit; server.js ist bereits gepatcht.');
    } else {
      console.warn('[v10.62] Bootstrap konnte server.js nicht vollstaendig patchen.');
    }
  } catch (error) {
    console.warn(`[v10.62] Bootstrap-Fehler: ${String(error?.message || error)}`);
  }
}

run();
