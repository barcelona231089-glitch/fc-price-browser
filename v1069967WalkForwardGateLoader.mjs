import { Buffer } from "node:buffer";
import { patchPermanentMlArchiveParamV1069966 } from "./v1069966ArchiveParamFixLoader.mjs";

export const V1069967_WALK_FORWARD_GATE_VERSION = "10.69.9.6.7-walk-forward-gate";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

export function patchPermanentMlWalkForwardGateV1069967(source) {
  let out = String(source || "");

  // Make this loader safe regardless of loader-hook order.
  if (!out.includes('export const PERMANENT_ML_VERSION = "10.69.9.6.6";')) {
    out = patchPermanentMlArchiveParamV1069966(out);
  }

  // Production audit 2026-09-15:
  // decision_1h = REJECT, decision_6h = REJECT, decision_24h = INSUFFICIENT
  // FC25/FC26 cycle_24h + cycle_7d = STABLE in 4-fold purged walk-forward.
  //
  // Therefore decision models remain trainable/persisted for research, but cannot
  // influence live scoring until explicitly enabled after a future walk-forward pass.
  const oldModelFor = `function modelFor(year, key) {
  return models.get(\`\${String(year)}:\${key}\`) || null;
}`;
  const newModelFor = `function modelFor(year, key) {
  const model = models.get(\`\${String(year)}:\${key}\`) || null;
  const decisionRuntimeEnabled =
    String(process.env.PERMANENT_ML_ENABLE_DECISION_MODELS || "").trim() === "1";
  if (!decisionRuntimeEnabled && String(key || "").startsWith("decision_")) {
    return null;
  }
  return model;
}`;
  if (!out.includes("PERMANENT_ML_ENABLE_DECISION_MODELS")) {
    if (!out.includes(oldModelFor)) {
      throw new Error("[v10.69.9.6.7] modelFor anchor missing");
    }
    out = out.replace(oldModelFor, newModelFor);
  }

  // Publish the launch gate in health/status so it is visible and auditable.
  const policyAnchor = "      twoYearPatternSchool: true,\n      rawPricesNeverMergedAcrossGameYears: true";
  const policyReplacement = `      twoYearPatternSchool: true,
      rawPricesNeverMergedAcrossGameYears: true,
      walkForwardProductionGate: true,
      walkForwardAuditDate: "2026-09-15",
      stableRuntimeFamilies: ["cycle_24h", "cycle_7d"],
      decisionModelsRuntimeEnabled:
        String(process.env.PERMANENT_ML_ENABLE_DECISION_MODELS || "").trim() === "1",
      decisionModelAudit: {
        decision_1h: "REJECT",
        decision_6h: "REJECT",
        decision_24h: "INSUFFICIENT"
      }`;
  if (!out.includes("walkForwardProductionGate: true")) {
    if (!out.includes(policyAnchor)) {
      throw new Error("[v10.69.9.6.7] policy anchor missing");
    }
    out = out.replace(policyAnchor, policyReplacement);
  }

  out = out.replace(
    'export const PERMANENT_ML_VERSION = "10.69.9.6.6";',
    'export const PERMANENT_ML_VERSION = "10.69.9.6.7";'
  );

  if (!out.includes("PERMANENT_ML_ENABLE_DECISION_MODELS") ||
      !out.includes("walkForwardProductionGate: true") ||
      !out.includes('PERMANENT_ML_VERSION = "10.69.9.6.7"')) {
    throw new Error("[v10.69.9.6.7] walk-forward production gate incomplete");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      const source = patchPermanentMlWalkForwardGateV1069967(raw);
      console.log("[v10.69.9.6.7] Walk-forward production gate ACTIVE: cycle models only; decision models research-only.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      console.error(`[v10.69.9.6.7] walk-forward gate disabled: ${error?.stack || error}`);
      return result;
    }
  }
  return result;
}

export const __test = { sourceText, patchPermanentMlWalkForwardGateV1069967 };
