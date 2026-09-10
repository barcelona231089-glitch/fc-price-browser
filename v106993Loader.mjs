export const V106993_BOOTSTRAP_VERSION = "10.69.9.3-monitor-watchdog-anchor-compat";

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.3] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

function replaceOptional(source, search, replacement, label, applied, skipped) {
  if (!source.includes(search)) {
    skipped.push(label);
    return source;
  }
  applied.push(label);
  return source.replace(search, replacement);
}

function patchServerRuntimeV106993(source) {
  let out = String(source || "");

  // v10.69.9.3 only adds monitor telemetry/watchdog behavior.
  // Trading logic, price authority, signals and data-source policy are unchanged.
  out = out.replaceAll("10.69.8-final", "10.69.9.3-final");
  out = out.replaceAll("10.69.9.2-final", "10.69.9.3-final");

  const applied = [];
  const skipped = [];

  const stateAnchor = "let lastMonitorError = null;";
  const statePatch = `${stateAnchor}

// v10.69.9.3: monitor-cycle telemetry + fail-safe watchdog.
const MONITOR_CYCLE_HARD_TIMEOUT_MS = Math.max(
  300_000,
  Math.min(1_800_000, Number(process.env.MONITOR_CYCLE_HARD_TIMEOUT_SECONDS || 480) * 1000)
);
let monitorCycleStartedAt = null;
let monitorCyclePhase = "IDLE";
let monitorCyclePhaseStartedAt = null;
let monitorCycleWatchdogHandle = null;
let monitorCycleWatchdogTrips = 0;
let monitorCycleLastTimedOutPhase = null;
let monitorCycleLastTimedOutAt = null;

function setMonitorCyclePhase(phase) {
  monitorCyclePhase = String(phase || "UNKNOWN");
  monitorCyclePhaseStartedAt = new Date().toISOString();
}

function armMonitorCycleWatchdog() {
  if (monitorCycleWatchdogHandle) clearTimeout(monitorCycleWatchdogHandle);
  monitorCycleStartedAt = new Date().toISOString();
  setMonitorCyclePhase("STARTING");
  monitorCycleWatchdogHandle = setTimeout(() => {
    monitorCycleWatchdogTrips += 1;
    monitorCycleLastTimedOutPhase = monitorCyclePhase;
    monitorCycleLastTimedOutAt = new Date().toISOString();
    const ageSeconds = Math.round(
      (Date.now() - new Date(monitorCycleStartedAt).getTime()) / 1000
    );
    console.error(
      "[v10.69.9.3] MONITOR_WATCHDOG_TIMEOUT phase=" +
      monitorCyclePhase +
      " age=" +
      ageSeconds +
      "s; terminating process for clean Hostless restart."
    );
    process.exit(1);
  }, MONITOR_CYCLE_HARD_TIMEOUT_MS);
  monitorCycleWatchdogHandle.unref?.();
}

function disarmMonitorCycleWatchdog() {
  if (monitorCycleWatchdogHandle) clearTimeout(monitorCycleWatchdogHandle);
  monitorCycleWatchdogHandle = null;
  setMonitorCyclePhase("IDLE");
  monitorCycleStartedAt = null;
}

function monitorCycleTelemetry() {
  const now = Date.now();
  const cycleStartMs = monitorCycleStartedAt
    ? new Date(monitorCycleStartedAt).getTime()
    : 0;
  const phaseStartMs = monitorCyclePhaseStartedAt
    ? new Date(monitorCyclePhaseStartedAt).getTime()
    : 0;
  return {
    phase: monitorCyclePhase,
    cycleStartedAt: monitorCycleStartedAt,
    cycleAgeSeconds: cycleStartMs
      ? Math.max(0, Math.round((now - cycleStartMs) / 1000))
      : null,
    phaseStartedAt: monitorCyclePhaseStartedAt,
    phaseAgeSeconds: phaseStartMs
      ? Math.max(0, Math.round((now - phaseStartMs) / 1000))
      : null,
    hardTimeoutSeconds: Math.round(MONITOR_CYCLE_HARD_TIMEOUT_MS / 1000),
    watchdogTrips: monitorCycleWatchdogTrips,
    lastTimedOutPhase: monitorCycleLastTimedOutPhase,
    lastTimedOutAt: monitorCycleLastTimedOutAt
  };
}`;
  out = replaceRequired(out, stateAnchor, statePatch, "monitor state");

  const startAnchor =
    `  monitoringBusy = true;\n  const cycleAlertBudget = createDiscordCycleBudget();`;
  const startPatch =
    `  monitoringBusy = true;\n  armMonitorCycleWatchdog();\n  const cycleAlertBudget = createDiscordCycleBudget();`;
  out = replaceRequired(out, startAnchor, startPatch, "monitor start");

  const phaseReplacements = [
    ["      [cards, bulk, futbinFeed] = await Promise.all([",
     "      setMonitorCyclePhase(\"PRIMARY_MARKET_FETCH\");\n      [cards, bulk, futbinFeed] = await Promise.all([",
     "PRIMARY_MARKET_FETCH"],
    ["        await recordDb(currentRows, at);",
     "        setMonitorCyclePhase(\"RECORD_DB\");\n        await recordDb(currentRows, at);",
     "RECORD_DB"],
    ["        await pollPublicLeakSources(false);",
     "        setMonitorCyclePhase(\"PUBLIC_LEAK_POLL\");\n        await pollPublicLeakSources(false);",
     "PUBLIC_LEAK_POLL"],
    ["      const built = await buildTradingRows(futbinFeed);",
     "      setMonitorCyclePhase(\"BUILD_TRADING_ROWS\");\n      const built = await buildTradingRows(futbinFeed);",
     "BUILD_TRADING_ROWS"],
    ["      await evaluateTraderSignalReliability(latestTradingRows);",
     "      setMonitorCyclePhase(\"TRADER_SIGNAL_RELIABILITY\");\n      await evaluateTraderSignalReliability(latestTradingRows);",
     "TRADER_SIGNAL_RELIABILITY"],
    ["      await evaluateTraderMarketImpact(latestTradingRows);",
     "      setMonitorCyclePhase(\"TRADER_MARKET_IMPACT\");\n      await evaluateTraderMarketImpact(latestTradingRows);",
     "TRADER_MARKET_IMPACT"],
    ["      await evaluateMarketKnowledge(latestTradingRows);",
     "      setMonitorCyclePhase(\"MARKET_KNOWLEDGE\");\n      await evaluateMarketKnowledge(latestTradingRows);",
     "MARKET_KNOWLEDGE"],
    // Compatibility: older chain keeps enrichImportantRowsWithFutbinParse,
    // current v10.66+ chain replaces it with enrichRowsWithFutbinSafeV1066.
    ["      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);",
     "      setMonitorCyclePhase(\"OPTIONAL_FUTBIN_ENRICH\");\n      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);",
     "OPTIONAL_FUTBIN_ENRICH_LEGACY"],
    ["      await enrichRowsWithFutbinSafeV1066({",
     "      setMonitorCyclePhase(\"OPTIONAL_FUTBIN_ENRICH\");\n      await enrichRowsWithFutbinSafeV1066({",
     "OPTIONAL_FUTBIN_ENRICH_SAFE_BRIDGE"],
    ["      await automaticTraderBrain(latestTradingRows, built.brainWork);",
     "      setMonitorCyclePhase(\"AUTOMATIC_TRADER_BRAIN\");\n      await automaticTraderBrain(latestTradingRows, built.brainWork);",
     "AUTOMATIC_TRADER_BRAIN"],
    ["      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"INTENSIVE_WATCH_ALERTS\");\n      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);",
     "INTENSIVE_WATCH_ALERTS"],
    ["      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"TRADER_CONFLUENCE_ALERTS\");\n      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);",
     "TRADER_CONFLUENCE_ALERTS"],
    ["      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"BRAIN_STATE_ALERTS\");\n      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);",
     "BRAIN_STATE_ALERTS"],
    ["      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"DISCORD_ALERTS\");\n      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);",
     "DISCORD_ALERTS"],
    ["      await evaluatePendingDecisions();",
     "      setMonitorCyclePhase(\"DECISION_EVALUATION\");\n      await evaluatePendingDecisions();",
     "DECISION_EVALUATION"],
    ["      updateProcessingHealthSuccess();",
     "      setMonitorCyclePhase(\"COMPLETE\");\n      updateProcessingHealthSuccess();",
     "COMPLETE"]
  ];

  // Phase markers are diagnostic only. A missing optional marker must never
  // prevent the service from booting.
  let futbinPhaseApplied = false;
  for (const [search, replacement, label] of phaseReplacements) {
    if (label.startsWith("OPTIONAL_FUTBIN_ENRICH_")) {
      if (futbinPhaseApplied) continue;
      if (out.includes(search)) {
        out = out.replace(search, replacement);
        applied.push(label);
        futbinPhaseApplied = true;
      } else {
        skipped.push(label);
      }
      continue;
    }
    out = replaceOptional(out, search, replacement, label, applied, skipped);
  }

  const finallyAnchor =
    `  } finally {\n    cycleAlertBudget.finishedAt = new Date().toISOString();\n    lastDiscordCycleBudget = { ...cycleAlertBudget };\n    monitoringBusy = false;\n  }`;
  const finallyPatch =
    `  } finally {\n    cycleAlertBudget.finishedAt = new Date().toISOString();\n    lastDiscordCycleBudget = { ...cycleAlertBudget };\n    disarmMonitorCycleWatchdog();\n    monitoringBusy = false;\n  }`;
  out = replaceRequired(out, finallyAnchor, finallyPatch, "monitor finally");

  const readinessAnchor =
    `      busy: monitoringBusy\n    },`;
  const readinessPatch =
    `      busy: monitoringBusy,\n      ...monitorCycleTelemetry()\n    },`;
  out = replaceRequired(out, readinessAnchor, readinessPatch, "readiness telemetry");

  if (!out.includes("10.69.9.3-final")) {
    throw new Error("[v10.69.9.3] runtime version label patch failed");
  }
  if (
    !out.includes("MONITOR_WATCHDOG_TIMEOUT") ||
    !out.includes("monitorCycleTelemetry()") ||
    !out.includes("armMonitorCycleWatchdog();") ||
    !out.includes("disarmMonitorCycleWatchdog();")
  ) {
    throw new Error("[v10.69.9.3] monitor watchdog patch incomplete");
  }

  if (skipped.length) {
    console.log(
      "[v10.69.9.3] Optional telemetry anchors skipped: " +
      skipped.join(", ")
    );
  }
  console.log(
    "[v10.69.9.3] Applied telemetry anchors: " +
    (applied.length ? applied.join(", ") : "none")
  );

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;

  const raw = typeof result.source === "string"
    ? result.source
    : Buffer.from(result.source).toString("utf8");

  if (url.endsWith("/server.js")) {
    const patched = patchServerRuntimeV106993(raw);
    console.log(
      "[v10.69.9.3] Monitor telemetry/watchdog active; legacy + safe-bridge compatible."
    );
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}

export const __test = { patchServerRuntimeV106993 };
