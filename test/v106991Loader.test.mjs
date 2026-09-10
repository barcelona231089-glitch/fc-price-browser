import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../v106991Loader.mjs";

const fixture = `
let lastMonitorError = null;
async function monitorOnce() {
  if (monitoringBusy) return;

  monitoringBusy = true;
  const cycleAlertBudget = createDiscordCycleBudget();
  try {
    try {
      [cards, bulk, futbinFeed] = await Promise.all([
      ]);
    } catch (error) {}
    try {
      if (dbEnabled) {
        await recordDb(currentRows, at);
      }
      try {
        await pollPublicLeakSources(false);
      } catch (error) {}
      const built = await buildTradingRows(futbinFeed);
      await evaluateTraderSignalReliability(latestTradingRows);
      await evaluateTraderMarketImpact(latestTradingRows);
      await evaluateMarketKnowledge(latestTradingRows);
      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);
      await automaticTraderBrain(latestTradingRows, built.brainWork);
      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);
      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);
      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);
      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);
      await evaluatePendingDecisions();
      updateProcessingHealthSuccess();
    } catch (error) {}
  } finally {
    cycleAlertBudget.finishedAt = new Date().toISOString();
    lastDiscordCycleBudget = { ...cycleAlertBudget };
    monitoringBusy = false;
  }
}
const checks = {
    monitoringLoop: {
      ok: true,
      busy: monitoringBusy
    },
};
const health = {
    monitoringBusy,
    lastMonitorAt,
    lastMonitorError,
};
const version = "10.69.8-final";
`;

test("adds monitor phase telemetry and watchdog without changing decision calls", () => {
  const out = __test.patchServerRuntimeV106991(fixture);
  assert.match(out, /10\.69\.9\.1-final/);
  assert.match(out, /MONITOR_WATCHDOG_TIMEOUT/);
  assert.match(out, /setMonitorCyclePhase\("BUILD_TRADING_ROWS"\)/);
  assert.match(out, /setMonitorCyclePhase\("AUTOMATIC_TRADER_BRAIN"\)/);
  assert.match(out, /monitorCycleTelemetry\(\)/);
  assert.match(out, /disarmMonitorCycleWatchdog\(\)/);
  assert.match(out, /await automaticTraderBrain\(latestTradingRows, built\.brainWork\)/);
});
