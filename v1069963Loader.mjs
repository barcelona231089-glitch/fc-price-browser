import { Buffer } from "node:buffer";
import { patchTraderBrainV106996 } from "./v106996Loader.mjs";
import { patchPermanentMlV1069961 } from "./v1069961Loader.mjs";

export const V1069963_BOOTSTRAP_VERSION = "10.69.9.6.3-24m-incremental-runtime";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function mark(state, key, ok, detail = null) {
  state[key] = { ok: Boolean(ok), detail: detail == null ? null : String(detail) };
}

function replaceExact(out, search, replacement, state, key) {
  if (out.includes(replacement)) {
    mark(state, key, true, "already-active");
    return out;
  }
  if (!out.includes(search)) {
    mark(state, key, false, "anchor-missing");
    return out;
  }
  mark(state, key, true, "patched");
  return out.replace(search, replacement);
}

function patchServerV1069963(raw) {
  let out = String(raw || "");
  const state = {};

  // 1) Imports. This anchor is part of the known-good v10.69.9.3 base chain.
  if (out.includes('./permanentMlBrainV106996.js') && out.includes('./twoYearAiContextV106996.js')) {
    mark(state, "imports", true, "already-active");
  } else {
    const anchor = 'import { createHaCoordinator } from "./haCoordinator.js";';
    const replacement = `${anchor}\nimport { startPermanentMlBrainV106996, scorePermanentMlV106996, getPermanentMlStatusV106996 } from "./permanentMlBrainV106996.js";\nimport { loadTwoYearAiContextV106996, getTwoYearAiFeedStatusV106996 } from "./twoYearAiContextV106996.js";`;
    out = replaceExact(out, anchor, replacement, state, "imports");
  }

  // 2) 730-day windows. Accept any older numeric default (90/365/etc.) so
  // an older loader cannot invalidate this patch merely by changing the prior value.
  const brainWindowRe = /const BRAIN_LEARNING_WINDOW_DAYS = Math\.max\(30, Number\(process\.env\.BRAIN_LEARNING_WINDOW_DAYS \|\| \d+\)\);/;
  if (/BRAIN_LEARNING_WINDOW_DAYS \|\| 730/.test(out)) {
    mark(state, "brainWindow730", true, "already-active");
  } else if (brainWindowRe.test(out)) {
    out = out.replace(brainWindowRe, 'const BRAIN_LEARNING_WINDOW_DAYS = Math.max(30, Number(process.env.BRAIN_LEARNING_WINDOW_DAYS || 730));');
    mark(state, "brainWindow730", true, "patched");
  } else {
    mark(state, "brainWindow730", false, "anchor-missing");
  }

  const perfWindowRe = /const PERFORMANCE_LAB_WINDOW_DAYS = Math\.max\(30, Number\(process\.env\.PERFORMANCE_LAB_WINDOW_DAYS \|\| \d+\)\);/;
  if (/PERFORMANCE_LAB_WINDOW_DAYS \|\| 730/.test(out)) {
    mark(state, "performanceWindow730", true, "already-active");
  } else if (perfWindowRe.test(out)) {
    out = out.replace(perfWindowRe, 'const PERFORMANCE_LAB_WINDOW_DAYS = Math.max(30, Number(process.env.PERFORMANCE_LAB_WINDOW_DAYS || 730));');
    mark(state, "performanceWindow730", true, "patched");
  } else {
    mark(state, "performanceWindow730", false, "anchor-missing");
  }

  // 3) Score every trading row from the in-memory permanent model.
  if (out.includes('v10.69.9.6.3 permanent ML score hook')) {
    mark(state, "scoreHook", true, "already-active");
  } else {
    const anchor = '    const quant = analyzeMarketPatterns(input);';
    const replacement = `    // v10.69.9.6.3 permanent ML score hook\n    input.gameYear = GAME_YEAR;\n    input.permanentMl = scorePermanentMlV106996(input);\n    row.aiPermanentMl = input.permanentMl;\n    const quant = analyzeMarketPatterns(input);`;
    out = replaceExact(out, anchor, replacement, state, "scoreHook");
  }

  // 4) Feed the real two-year context only to the sparse Gemini candidates.
  if (out.includes('v10.69.9.6.3 two-year Gemini history hook')) {
    mark(state, "geminiHistoryHook", true, "already-active");
  } else {
    const anchor = `      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`;
    const replacement = `      // v10.69.9.6.3 two-year Gemini history hook\n      geminiCandidate.work.input.twoYearHistory730 = await loadTwoYearAiContextV106996({\n        pool: dbEnabled ? pool : null,\n        activeGameYear: GAME_YEAR,\n        eaId: geminiCandidate.work.input.eaId,\n        playerName: geminiCandidate.work.input.playerName,\n        currentPrice: geminiCandidate.work.input.currentPrice\n      }).catch(error => ({\n        available: false,\n        reason: \"TWO_YEAR_CONTEXT_ERROR\",\n        error: String(error?.message || error),\n        synthetic: false\n      }));\n\n      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`;
    out = replaceExact(out, anchor, replacement, state, "geminiHistoryHook");
  }

  // 5) Start ML after DB init, but never await it on the runtime critical path.
  if (out.includes('v10.69.9.6.3 non-blocking permanent ML bootstrap')) {
    mark(state, "mlStartup", true, "already-active");
  } else {
    const anchor = `  try {\n    await initDb();\n  } catch (error) {\n    console.error(\"DB init error:\", error);\n    lastMonitorError = \"DB init: \" + String(error);\n  }`;
    const replacement = `${anchor}\n\n  // v10.69.9.6.3 non-blocking permanent ML bootstrap\n  {\n    const mlBootstrapStartedAt = Date.now();\n    void startPermanentMlBrainV106996({\n      pool: dbEnabled ? pool : null,\n      gameYear: GAME_YEAR,\n      isBusy: () => monitoringBusy\n    }).then(status => {\n      console.log(\n        \`[v10.69.9.6.3] Permanent ML bootstrap completed in \${Date.now() - mlBootstrapStartedAt}ms: \${status?.status || \"UNKNOWN\"}.\`\n      );\n    }).catch(error => {\n      console.error(\n        \`[v10.69.9.6.3] Permanent ML bootstrap failed without blocking runtime: \${error?.message || error}\`\n      );\n    });\n  }`;
    out = replaceExact(out, anchor, replacement, state, "mlStartup");
  }

  // 6) Surface the 24-month status on /health so verification does not depend
  // on a full market cycle becoming READY.
  if (out.includes('ml24Patch: ML24_PATCH_STATE_V1069963')) {
    mark(state, "healthStatus", true, "already-active");
  } else {
    const anchor = '    traderBrainAutomatic: true,';
    const replacement = `${anchor}\n    ml24Patch: ML24_PATCH_STATE_V1069963,\n    twoYearAiFeed: getTwoYearAiFeedStatusV106996(),\n    permanentMl: getPermanentMlStatusV106996(),`;
    out = replaceExact(out, anchor, replacement, state, "healthStatus");
  }

  // Determine whether every server-side component required for the 24m runtime
  // is actually attached. Do not claim FINAL if a critical piece is missing.
  const criticalKeys = [
    "imports",
    "brainWindow730",
    "performanceWindow730",
    "scoreHook",
    "geminiHistoryHook",
    "mlStartup",
    "healthStatus"
  ];
  const criticalOk = criticalKeys.every(key => state[key]?.ok === true);
  state.criticalOk = { ok: criticalOk, detail: criticalOk ? "all-critical-server-hooks-active" : "one-or-more-critical-hooks-missing" };

  // Inject a static diagnostics object. It is visible from /health immediately.
  const statusAnchor = 'const { Pool } = pg;';
  if (!out.includes('const ML24_PATCH_STATE_V1069963 = Object.freeze(') && out.includes(statusAnchor)) {
    const diagnostic = JSON.stringify({
      version: "10.69.9.6.3",
      targetMonths: 24,
      learningWindowDays: 730,
      sourceGameYears: ["25", "26"],
      syntheticHistory: false,
      ...state
    });
    out = out.replace(statusAnchor, `${statusAnchor}\nconst ML24_PATCH_STATE_V1069963 = Object.freeze(${diagnostic});`);
  }

  const runtimeLabel = criticalOk ? "10.69.9.6.3-final" : "10.69.9.6.3-degraded";
  out = out.replaceAll("10.69.9.3-final", runtimeLabel);
  out = out.replaceAll("10.69.9.6.2-final", runtimeLabel);
  out = out.replaceAll("10.69.9.6.1-final", runtimeLabel);
  out = out.replaceAll("10.69.9.6-final", runtimeLabel);

  console.log(`[v10.69.9.6.3] server patch ${criticalOk ? "ACTIVE" : "DEGRADED"}: ${JSON.stringify(state)}`);
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/server.js")) {
    try {
      const source = patchServerV1069963(raw);
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.3] server patch fatal; keeping v10.69.9.3 base: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/traderBrain.js")) {
    try {
      const source = patchTraderBrainV106996(raw);
      console.log("[v10.69.9.6.3] traderBrain 24m ML calibration + Gemini context ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.3] traderBrain 24m patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      const source = patchPermanentMlV1069961(raw);
      console.log("[v10.69.9.6.3] Permanent ML resilient retry ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.3] Permanent ML resilient patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  return result;
}

export const __test = { patchServerV1069963, sourceText };
