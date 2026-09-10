export const V106992_BOOTSTRAP_VERSION = "10.69.9.2-monitor-watchdog-anchor-fix";

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.2] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

function patchServerRuntimeV106992(source) {
  let out = String(source || "");

  // v10.69.9.2 only adds telemetry/watchdog behavior.
  // Prices, scoring, trading rules and source authority stay unchanged.
  out = out.replaceAll("10.69.8-final", "10.69.9.2-final");

  const stateAnchor = "let lastMonitorError = null;";
  const statePatch = `${stateAnchor}

// v10.69.9.2: monitor-cycle telemetry + fail-safe watchdog.
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
      "[v10.69.9.2] MONITOR_WATCHDOG_TIMEOUT phase=" +
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

  // v10.69.9.1 expected the older monitorOnce() header and failed on the
  // current HA/ÜV CPU-safe prechecks. Anchor only on the stable body lines.
  const startAnchor =
    `  monitoringBusy = true;\n  const cycleAlertBudget = createDiscordCycleBudget();`;
  const startPatch =
    `  monitoringBusy = true;\n  armMonitorCycleWatchdog();\n  const cycleAlertBudget = createDiscordCycleBudget();`;
  out = replaceRequired(out, startAnchor, startPatch, "monitor start");

  const phaseReplacements = [
    ["      [cards, bulk, futbinFeed] = await Promise.all([",
     "      setMonitorCyclePhase(\"PRIMARY_MARKET_FETCH\");\n      [cards, bulk, futbinFeed] = await Promise.all(["],
    ["        await recordDb(currentRows, at);",
     "        setMonitorCyclePhase(\"RECORD_DB\");\n        await recordDb(currentRows, at);"],
    ["        await pollPublicLeakSources(false);",
     "        setMonitorCyclePhase(\"PUBLIC_LEAK_POLL\");\n        await pollPublicLeakSources(false);"],
    ["      const built = await buildTradingRows(futbinFeed);",
     "      setMonitorCyclePhase(\"BUILD_TRADING_ROWS\");\n      const built = await buildTradingRows(futbinFeed);"],
    ["      await evaluateTraderSignalReliability(latestTradingRows);",
     "      setMonitorCyclePhase(\"TRADER_SIGNAL_RELIABILITY\");\n      await evaluateTraderSignalReliability(latestTradingRows);"],
    ["      await evaluateTraderMarketImpact(latestTradingRows);",
     "      setMonitorCyclePhase(\"TRADER_MARKET_IMPACT\");\n      await evaluateTraderMarketImpact(latestTradingRows);"],
    ["      await evaluateMarketKnowledge(latestTradingRows);",
     "      setMonitorCyclePhase(\"MARKET_KNOWLEDGE\");\n      await evaluateMarketKnowledge(latestTradingRows);"],
    ["      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);",
     "      setMonitorCyclePhase(\"OPTIONAL_FUTBIN_ENRICH\");\n      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);"],
    ["      await automaticTraderBrain(latestTradingRows, built.brainWork);",
     "      setMonitorCyclePhase(\"AUTOMATIC_TRADER_BRAIN\");\n      await automaticTraderBrain(latestTradingRows, built.brainWork);"],
    ["      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"INTENSIVE_WATCH_ALERTS\");\n      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);"],
    ["      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"TRADER_CONFLUENCE_ALERTS\");\n      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);"],
    ["      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"BRAIN_STATE_ALERTS\");\n      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);"],
    ["      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);",
     "      setMonitorCyclePhase(\"DISCORD_ALERTS\");\n      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);"],
    ["      await evaluatePendingDecisions();",
     "      setMonitorCyclePhase(\"DECISION_EVALUATION\");\n      await evaluatePendingDecisions();"],
    ["      updateProcessingHealthSuccess();",
     "      setMonitorCyclePhase(\"COMPLETE\");\n      updateProcessingHealthSuccess();"]
  ];

  for (const [search, replacement] of phaseReplacements) {
    out = replaceRequired(out, search, replacement, `phase ${search}`);
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

  if (!out.includes("10.69.9.2-final")) {
    throw new Error("[v10.69.9.2] runtime version label patch failed");
  }
  if (
    !out.includes("MONITOR_WATCHDOG_TIMEOUT") ||
    !out.includes("BUILD_TRADING_ROWS") ||
    !out.includes("monitorCycleTelemetry()")
  ) {
    throw new Error("[v10.69.9.2] monitor watchdog patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;

  const raw = typeof result.source === "string"
    ? result.source
    : Buffer.from(result.source).toString("utf8");

  if (url.endsWith("/server.js")) {
    const patched = patchServerRuntimeV106992(raw);
    console.log(
      "[v10.69.9.2] Monitor telemetry/watchdog active; HA/ÜV-safe anchor; trading logic unchanged."
    );
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}

export const __test = { patchServerRuntimeV106992 };
