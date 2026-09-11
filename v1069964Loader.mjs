import { Buffer } from "node:buffer";
import { patchTraderBrainV106996 } from "./v106996Loader.mjs";
import { patchPermanentMlV1069961 } from "./v1069961Loader.mjs";

export const V1069964_BOOTSTRAP_VERSION = "10.69.9.6.4-24m-runtime-anchor-fix";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function mark(state, key, ok, detail = null) {
  state[key] = { ok: Boolean(ok), detail: detail == null ? null : String(detail) };
}

function patchDeclarationTo730(out, name, envName, state, key) {
  const exact730 = new RegExp(`const\\s+${name}\\s*=\\s*[^;]*${envName}[^;]*\\b730\\b[^;]*;`);
  if (exact730.test(out)) {
    mark(state, key, true, "already-active");
    return out;
  }

  // Match the whole const declaration instead of depending on the exact old
  // Math.max/Math.min formatting. Earlier runtime loaders may have rewritten it.
  const declaration = new RegExp(`const\\s+${name}\\s*=\\s*[^;]*${envName}[^;]*;`);
  if (!declaration.test(out)) {
    mark(state, key, false, "declaration-not-found");
    return out;
  }

  const replacement = `const ${name} = Math.max(30, Number(process.env.${envName} || 730));`;
  out = out.replace(declaration, replacement);
  mark(state, key, true, "patched-flexible-declaration");
  return out;
}

function injectMlStartup(out, state) {
  const marker = "v10.69.9.6.4 non-blocking permanent ML bootstrap";
  if (out.includes(marker)) {
    mark(state, "mlStartup", true, "already-active");
    return out;
  }

  // Scope the search to initializeRuntime so another initDb reference can never
  // be patched accidentally. We only need the stable `await initDb();` statement.
  const fnStart = out.indexOf("async function initializeRuntime()");
  if (fnStart < 0) {
    mark(state, "mlStartup", false, "initializeRuntime-not-found");
    return out;
  }

  const nextFn = out.indexOf("\nfunction ", fnStart + 1);
  const nextAsyncFn = out.indexOf("\nasync function ", fnStart + 1);
  const candidates = [nextFn, nextAsyncFn].filter(i => i > fnStart);
  const fnEnd = candidates.length ? Math.min(...candidates) : out.length;
  const initPos = out.indexOf("await initDb();", fnStart);
  if (initPos < 0 || initPos >= fnEnd) {
    mark(state, "mlStartup", false, "initDb-await-not-found-inside-initializeRuntime");
    return out;
  }

  const insertPos = initPos + "await initDb();".length;
  const startup = `\n\n    // ${marker}\n    {\n      const mlBootstrapStartedAt = Date.now();\n      void startPermanentMlBrainV106996({\n        pool: dbEnabled ? pool : null,\n        gameYear: GAME_YEAR,\n        isBusy: () => monitoringBusy\n      }).then(status => {\n        console.log(\n          \`[v10.69.9.6.4] Permanent ML bootstrap completed in \${Date.now() - mlBootstrapStartedAt}ms: \${status?.status || "UNKNOWN"}.\`\n        );\n      }).catch(error => {\n        console.error(\n          \`[v10.69.9.6.4] Permanent ML bootstrap failed without blocking runtime: \${error?.message || error}\`\n        );\n      });\n    }`;

  out = out.slice(0, insertPos) + startup + out.slice(insertPos);
  mark(state, "mlStartup", true, "patched-after-initDb-await");
  return out;
}

function patchServerV1069964(raw) {
  let out = String(raw || "");
  const state = {};

  // Imports.
  if (out.includes('./permanentMlBrainV106996.js') && out.includes('./twoYearAiContextV106996.js')) {
    mark(state, "imports", true, "already-active");
  } else {
    const anchor = 'import { createHaCoordinator } from "./haCoordinator.js";';
    if (!out.includes(anchor)) {
      mark(state, "imports", false, "ha-import-anchor-missing");
    } else {
      out = out.replace(
        anchor,
        `${anchor}\nimport { startPermanentMlBrainV106996, scorePermanentMlV106996, getPermanentMlStatusV106996 } from "./permanentMlBrainV106996.js";\nimport { loadTwoYearAiContextV106996, getTwoYearAiFeedStatusV106996 } from "./twoYearAiContextV106996.js";`
      );
      mark(state, "imports", true, "patched");
    }
  }

  // The three hooks that live verification showed as missing in 6.3 are now
  // deliberately format-agnostic.
  out = patchDeclarationTo730(
    out,
    "BRAIN_LEARNING_WINDOW_DAYS",
    "BRAIN_LEARNING_WINDOW_DAYS",
    state,
    "brainWindow730"
  );
  out = patchDeclarationTo730(
    out,
    "PERFORMANCE_LAB_WINDOW_DAYS",
    "PERFORMANCE_LAB_WINDOW_DAYS",
    state,
    "performanceWindow730"
  );

  // Score hook.
  if (out.includes("permanent ML score hook") && out.includes("scorePermanentMlV106996(input)")) {
    mark(state, "scoreHook", true, "already-active");
  } else {
    const anchor = "    const quant = analyzeMarketPatterns(input);";
    if (!out.includes(anchor)) {
      mark(state, "scoreHook", false, "quant-anchor-missing");
    } else {
      out = out.replace(
        anchor,
        `    // v10.69.9.6.4 permanent ML score hook\n    input.gameYear = GAME_YEAR;\n    input.permanentMl = scorePermanentMlV106996(input);\n    row.aiPermanentMl = input.permanentMl;\n    const quant = analyzeMarketPatterns(input);`
      );
      mark(state, "scoreHook", true, "patched");
    }
  }

  // Gemini history hook.
  if (out.includes("two-year Gemini history hook") && out.includes("twoYearHistory730")) {
    mark(state, "geminiHistoryHook", true, "already-active");
  } else {
    const anchor = `      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`;
    if (!out.includes(anchor)) {
      mark(state, "geminiHistoryHook", false, "gemini-decision-anchor-missing");
    } else {
      out = out.replace(
        anchor,
        `      // v10.69.9.6.4 two-year Gemini history hook\n      geminiCandidate.work.input.twoYearHistory730 = await loadTwoYearAiContextV106996({\n        pool: dbEnabled ? pool : null,\n        activeGameYear: GAME_YEAR,\n        eaId: geminiCandidate.work.input.eaId,\n        playerName: geminiCandidate.work.input.playerName,\n        currentPrice: geminiCandidate.work.input.currentPrice\n      }).catch(error => ({\n        available: false,\n        reason: "TWO_YEAR_CONTEXT_ERROR",\n        error: String(error?.message || error),\n        synthetic: false\n      }));\n\n      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`
      );
      mark(state, "geminiHistoryHook", true, "patched");
    }
  }

  out = injectMlStartup(out, state);

  // Health verification. Replace an older ml24Patch field if a previous layer
  // somehow left one behind, otherwise insert after traderBrainAutomatic.
  const healthBlock = `    ml24Patch: ML24_PATCH_STATE_V1069964,\n    twoYearAiFeed: getTwoYearAiFeedStatusV106996(),\n    permanentMl: getPermanentMlStatusV106996(),`;
  if (out.includes("ml24Patch: ML24_PATCH_STATE_V1069964")) {
    mark(state, "healthStatus", true, "already-active");
  } else if (/    ml24Patch: ML24_PATCH_STATE_V106996\d,[\s\S]*?permanentMl: getPermanentMlStatusV106996\(\),/.test(out)) {
    out = out.replace(
      /    ml24Patch: ML24_PATCH_STATE_V106996\d,[\s\S]*?permanentMl: getPermanentMlStatusV106996\(\),/,
      healthBlock
    );
    mark(state, "healthStatus", true, "replaced-older-health-block");
  } else if (out.includes("    traderBrainAutomatic: true,")) {
    out = out.replace("    traderBrainAutomatic: true,", `    traderBrainAutomatic: true,\n${healthBlock}`);
    mark(state, "healthStatus", true, "patched");
  } else {
    mark(state, "healthStatus", false, "health-anchor-missing");
  }

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
  state.criticalOk = {
    ok: criticalOk,
    detail: criticalOk ? "all-critical-server-hooks-active" : "one-or-more-critical-hooks-missing"
  };

  // Remove any stale diagnostic constant from a previous incremental loader.
  out = out.replace(/const ML24_PATCH_STATE_V106996\d = Object\.freeze\([^\n]*\);\n?/g, "");
  const statusAnchor = "const { Pool } = pg;";
  if (out.includes(statusAnchor)) {
    const diagnostic = JSON.stringify({
      version: "10.69.9.6.4",
      targetMonths: 24,
      learningWindowDays: 730,
      sourceGameYears: ["25", "26"],
      syntheticHistory: false,
      ...state
    });
    out = out.replace(statusAnchor, `${statusAnchor}\nconst ML24_PATCH_STATE_V1069964 = Object.freeze(${diagnostic});`);
  }

  const runtimeLabel = criticalOk ? "10.69.9.6.4-final" : "10.69.9.6.4-degraded";
  for (const label of [
    "10.69.9.3-final",
    "10.69.9.6-final",
    "10.69.9.6.1-final",
    "10.69.9.6.2-final",
    "10.69.9.6.3-final",
    "10.69.9.6.3-degraded"
  ]) {
    out = out.replaceAll(label, runtimeLabel);
  }

  console.log(`[v10.69.9.6.4] server patch ${criticalOk ? "ACTIVE" : "DEGRADED"}: ${JSON.stringify(state)}`);
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/server.js")) {
    try {
      const source = patchServerV1069964(raw);
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.4] server patch fatal; keeping v10.69.9.3 base: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/traderBrain.js")) {
    try {
      const source = patchTraderBrainV106996(raw);
      console.log("[v10.69.9.6.4] traderBrain 24m ML calibration + Gemini context ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.4] traderBrain 24m patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      const source = patchPermanentMlV1069961(raw);
      console.log("[v10.69.9.6.4] Permanent ML resilient retry ACTIVE.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.4] Permanent ML resilient patch disabled: ${error?.stack || error}`);
      return result;
    }
  }

  return result;
}

export const __test = {
  patchServerV1069964,
  sourceText,
  patchDeclarationTo730,
  injectMlStartup
};
