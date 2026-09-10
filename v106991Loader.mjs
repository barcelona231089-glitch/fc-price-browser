export const V106991_BOOTSTRAP_VERSION = "10.69.9.1-monitor-watchdog";

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.1] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

function patchServerRuntimeV106991(source) {
  let out = String(source || "");

  // v10.69.9.1 does not alter prices, scoring, signals or FUT.GG/FUTBIN policy.
  // It only adds monitor-cycle telemetry and a final safety watchdog.
  out = out.replaceAll("10.69.8-final", "10.69.9.1-final");

  const stateAnchor = "let lastMonitorError = null;";
  const statePatch = `${stateAnchor}\n\n// v10.69.9.1: monitor-cycle telemetry + fail-safe watchdog.\n// Known cold starts can be long, so the default hard limit is deliberately 12 minutes.\n// A timed-out cycle terminates the process instead of allowing overlapping market cycles;\n// Hostless can then restart the service cleanly.\nconst MONITOR_CYCLE_HARD_TIMEOUT_MS = Math.max(300_000, Math.min(1_800_000, Number(process.env.MONITOR_CYCLE_HARD_TIMEOUT_SECONDS || 720) * 1000));\nlet monitorCycleStartedAt = null;\nlet monitorCyclePhase = \"IDLE\";\nlet monitorCyclePhaseStartedAt = null;\nlet monitorCycleWatchdogHandle = null;\nlet monitorCycleWatchdogTrips = 0;\nlet monitorCycleLastTimedOutPhase = null;\nlet monitorCycleLastTimedOutAt = null;\n\nfunction setMonitorCyclePhase(phase) {\n  monitorCyclePhase = String(phase || \"UNKNOWN\");\n  monitorCyclePhaseStartedAt = new Date().toISOString();\n}\n\nfunction armMonitorCycleWatchdog() {\n  if (monitorCycleWatchdogHandle) clearTimeout(monitorCycleWatchdogHandle);\n  monitorCycleStartedAt = new Date().toISOString();\n  setMonitorCyclePhase(\"STARTING\");\n  monitorCycleWatchdogHandle = setTimeout(() => {\n    monitorCycleWatchdogTrips += 1;\n    monitorCycleLastTimedOutPhase = monitorCyclePhase;\n    monitorCycleLastTimedOutAt = new Date().toISOString();\n    const ageSeconds = Math.round((Date.now() - new Date(monitorCycleStartedAt).getTime()) / 1000);\n    console.error("[v10.69.9.1] MONITOR_WATCHDOG_TIMEOUT phase=" + monitorCyclePhase + " age=" + ageSeconds + "s; terminating process for clean Hostless restart.");\n    process.exit(1);\n  }, MONITOR_CYCLE_HARD_TIMEOUT_MS);\n  monitorCycleWatchdogHandle.unref?.();\n}\n\nfunction disarmMonitorCycleWatchdog() {\n  if (monitorCycleWatchdogHandle) clearTimeout(monitorCycleWatchdogHandle);\n  monitorCycleWatchdogHandle = null;\n  setMonitorCyclePhase(\"IDLE\");\n  monitorCycleStartedAt = null;\n}\n\nfunction monitorCycleTelemetry() {\n  const now = Date.now();\n  const cycleStartMs = monitorCycleStartedAt ? new Date(monitorCycleStartedAt).getTime() : 0;\n  const phaseStartMs = monitorCyclePhaseStartedAt ? new Date(monitorCyclePhaseStartedAt).getTime() : 0;\n  return {\n    phase: monitorCyclePhase,\n    cycleStartedAt: monitorCycleStartedAt,\n    cycleAgeSeconds: cycleStartMs ? Math.max(0, Math.round((now - cycleStartMs) / 1000)) : null,\n    phaseStartedAt: monitorCyclePhaseStartedAt,\n    phaseAgeSeconds: phaseStartMs ? Math.max(0, Math.round((now - phaseStartMs) / 1000)) : null,\n    hardTimeoutSeconds: Math.round(MONITOR_CYCLE_HARD_TIMEOUT_MS / 1000),\n    watchdogTrips: monitorCycleWatchdogTrips,\n    lastTimedOutPhase: monitorCycleLastTimedOutPhase,\n    lastTimedOutAt: monitorCycleLastTimedOutAt\n  };\n}`;
  out = replaceRequired(out, stateAnchor, statePatch, "monitor state");

  const startAnchor = `async function monitorOnce() {\n  if (monitoringBusy) return;\n\n  monitoringBusy = true;`;
  const startPatch = `${startAnchor}\n  armMonitorCycleWatchdog();`;
  out = replaceRequired(out, startAnchor, startPatch, "monitor start");

  const phaseReplacements = [
    ["      [cards, bulk, futbinFeed] = await Promise.all([", "      setMonitorCyclePhase(\"PRIMARY_MARKET_FETCH\");\n      [cards, bulk, futbinFeed] = await Promise.all(["],
    ["        await recordDb(currentRows, at);", "        setMonitorCyclePhase(\"RECORD_DB\");\n        await recordDb(currentRows, at);"],
    ["        await pollPublicLeakSources(false);", "        setMonitorCyclePhase(\"PUBLIC_LEAK_POLL\");\n        await pollPublicLeakSources(false);"],
    ["      const built = await buildTradingRows(futbinFeed);", "      setMonitorCyclePhase(\"BUILD_TRADING_ROWS\");\n      const built = await buildTradingRows(futbinFeed);"],
    ["      await evaluateTraderSignalReliability(latestTradingRows);", "      setMonitorCyclePhase(\"TRADER_SIGNAL_RELIABILITY\");\n      await evaluateTraderSignalReliability(latestTradingRows);"],
    ["      await evaluateTraderMarketImpact(latestTradingRows);", "      setMonitorCyclePhase(\"TRADER_MARKET_IMPACT\");\n      await evaluateTraderMarketImpact(latestTradingRows);"],
    ["      await evaluateMarketKnowledge(latestTradingRows);", "      setMonitorCyclePhase(\"MARKET_KNOWLEDGE\");\n      await evaluateMarketKnowledge(latestTradingRows);"],
    ["      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);", "      setMonitorCyclePhase(\"OPTIONAL_FUTBIN_ENRICH\");\n      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);"],
    ["      await automaticTraderBrain(latestTradingRows, built.brainWork);", "      setMonitorCyclePhase(\"AUTOMATIC_TRADER_BRAIN\");\n      await automaticTraderBrain(latestTradingRows, built.brainWork);"],
    ["      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);", "      setMonitorCyclePhase(\"INTENSIVE_WATCH_ALERTS\");\n      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);"],
    ["      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);", "      setMonitorCyclePhase(\"TRADER_CONFLUENCE_ALERTS\");\n      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);"],
    ["      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);", "      setMonitorCyclePhase(\"BRAIN_STATE_ALERTS\");\n      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);"],
    ["      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);", "      setMonitorCyclePhase(\"DISCORD_ALERTS\");\n      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);"],
    ["      await evaluatePendingDecisions();", "      setMonitorCyclePhase(\"DECISION_EVALUATION\");\n      await evaluatePendingDecisions();"],
    ["      updateProcessingHealthSuccess();", "      setMonitorCyclePhase(\"COMPLETE\");\n      updateProcessingHealthSuccess();"]
  ];

  for (const [search, replacement] of phaseReplacements) {
    out = replaceRequired(out, search, replacement, `phase ${replacement.match(/setMonitorCyclePhase\(\\\"([^\"]+)/)?.[1] || search}`);
  }

  const finallyAnchor = `  } finally {\n    cycleAlertBudget.finishedAt = new Date().toISOString();\n    lastDiscordCycleBudget = { ...cycleAlertBudget };\n    monitoringBusy = false;\n  }`;
  const finallyPatch = `  } finally {\n    cycleAlertBudget.finishedAt = new Date().toISOString();\n    lastDiscordCycleBudget = { ...cycleAlertBudget };\n    disarmMonitorCycleWatchdog();\n    monitoringBusy = false;\n  }`;
  out = replaceRequired(out, finallyAnchor, finallyPatch, "monitor finally");

  const readinessAnchor = `      busy: monitoringBusy\n    },`;
  const readinessPatch = `      busy: monitoringBusy,\n      ...monitorCycleTelemetry()\n    },`;
  out = replaceRequired(out, readinessAnchor, readinessPatch, "readiness telemetry");

  const healthAnchor = `    monitoringBusy,\n    lastMonitorAt,\n    lastMonitorError,`;
  const healthPatch = `    monitoringBusy,\n    lastMonitorAt,\n    lastMonitorError,\n    monitorCycle: monitorCycleTelemetry(),`;
  out = replaceRequired(out, healthAnchor, healthPatch, "health telemetry");

  if (!out.includes("10.69.9.1-final")) {
    throw new Error("[v10.69.9.1] runtime version label patch failed");
  }
  if (!out.includes("MONITOR_WATCHDOG_TIMEOUT") || !out.includes("BUILD_TRADING_ROWS")) {
    throw new Error("[v10.69.9.1] monitor watchdog patch incomplete");
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
    const patched = patchServerRuntimeV106991(raw);
    console.log("[v10.69.9.1] Monitor telemetry/watchdog active; trading logic unchanged.");
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}

export const __test = { patchServerRuntimeV106991 };
