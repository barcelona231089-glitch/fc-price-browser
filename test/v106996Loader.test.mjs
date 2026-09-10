import test from 'node:test';
import assert from 'node:assert/strict';
import { patchServerV106996, patchTraderBrainV106996 } from '../v106996Loader.mjs';

test('server patch wires 730-day learning directly on top of v10.69.9.3', () => {
  const src = `
import { createHaCoordinator } from "./haCoordinator.js";
const BRAIN_LEARNING_WINDOW_DAYS = Math.max(30, Number(process.env.BRAIN_LEARNING_WINDOW_DAYS || 90));
const PERFORMANCE_LAB_WINDOW_DAYS = Math.max(30, Number(process.env.PERFORMANCE_LAB_WINDOW_DAYS || 90));
const version = "10.69.9.3-final";
async function build(){
  const input = {}; const row = {};
    const quant = analyzeMarketPatterns(input);
}
async function ai(){
      const rawDecision = await generateAiTraderDecision(
        geminiCandidate.work.input,
        geminiCandidate.work.quant,
        geminiCandidate.work.confluence
      );
}
async function start(){
    await initDb();
}
function status(){ return {
    ratingStats: latestRatingStats
};}`;
  const out = patchServerV106996(src);
  assert.match(out, /10\.69\.9\.6-final/);
  assert.match(out, /BRAIN_LEARNING_WINDOW_DAYS \|\| 730/);
  assert.match(out, /PERFORMANCE_LAB_WINDOW_DAYS \|\| 730/);
  assert.match(out, /scorePermanentMlV106996/);
  assert.match(out, /loadTwoYearAiContextV106996/);
  assert.match(out, /startPermanentMlBrainV106996/);
  assert.match(out, /twoYearAiFeed/);
});

test('traderBrain patch adds 24-month memory and ML confirmation/veto', () => {
  const src = `
function analyze(input){
  const marketContext = input.marketContext || {};
  let suggestedAction = "BEOBACHTEN"; let baseConfidence=70; let risk="mittel"; let marketState="x"; let primaryReason="x";
  const keyFactors=[]; const isEarlyStabilization=false;
  if (marketContext.packSupplyActive) {}
}
function gate(marketData, confluence){
  if (confluence.signalCount >= 2 && (confluence.confluenceScore >= 65 || confluence.confluenceScore <= 30)) {}
}
function generate(input, confluence){
  const traderText = confluence.processedSignals.length
    ? confluence.processedSignals.map(s => \`- \${s.source}: \${s.call}, Zuverlässigkeit \${s.sourceReliability}%, Marktbestätigung \${s.marketConfirmation ? "JA" : "NEIN"}, Grund: \${s.reason || "-"}\`).join("\\n")
    : "Keine externen Trader-Signale vorhanden.";
  const prompt = \`
30d: \${pct(input.change30d)}
Regeln:
- 5% EA-Steuer berücksichtigen.
Trader-Signale:
\${traderText}
\`;
}`;
  const out = patchTraderBrainV106996(src);
  assert.match(out, /24-Monats-Marktgedächtnis/);
  assert.match(out, /Permanent-ML-24M-Chance\/Widerspruch/);
  assert.match(out, /FC25 und FC26 niemals als eine durchgehende absolute Preiskurve behandeln/);
  assert.match(out, /v10\.69\.9\.6 permanent ML calibration/);
});
