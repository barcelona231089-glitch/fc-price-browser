import { Buffer } from "node:buffer";
import { patchServerV106996, patchTraderBrainV106996 } from "./v106996Loader.mjs";
import { patchServerV1069961, patchPermanentMlV1069961 } from "./v1069961Loader.mjs";

export const V1069962_BOOTSTRAP_VERSION = "10.69.9.6.2-flattened-failsafe";

const patchState = {
  server: "PENDING",
  traderBrain: "PENDING",
  permanentMl: "PENDING",
  errors: []
};

function rawText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function logPatchError(target, error) {
  const message = String(error?.stack || error?.message || error);
  patchState[target] = "FALLBACK_9_3";
  patchState.errors.push({ target, message: String(error?.message || error), at: new Date().toISOString() });
  console.error(`[v10.69.9.6.2] ${target} 24m patch disabled; known-good v10.69.9.3 source continues. ${message}`);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = rawText(result.source);
  if (raw == null) return result;

  if (url.endsWith("/server.js")) {
    try {
      let source = patchServerV106996(raw);
      source = patchServerV1069961(source);
      source = source.replaceAll("10.69.9.6.1-final", "10.69.9.6.2-final");
      if (!source.includes("10.69.9.6.2-final")) {
        throw new Error("runtime label 10.69.9.6.2-final missing after patch");
      }
      patchState.server = "ACTIVE_24M";
      console.log("[v10.69.9.6.2] server 24m patch active; startup remains non-blocking.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      logPatchError("server", error);
      return result;
    }
  }

  if (url.endsWith("/traderBrain.js")) {
    try {
      const source = patchTraderBrainV106996(raw);
      patchState.traderBrain = "ACTIVE_24M";
      console.log("[v10.69.9.6.2] traderBrain 24m ML/Gemini context patch active.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      logPatchError("traderBrain", error);
      return result;
    }
  }

  if (url.endsWith("/permanentMlBrainV106996.js")) {
    try {
      const source = patchPermanentMlV1069961(raw);
      patchState.permanentMl = "ACTIVE_RESILIENT";
      console.log("[v10.69.9.6.2] Permanent ML resilient startup patch active.");
      return { ...result, source, shortCircuit: true };
    } catch (error) {
      logPatchError("permanentMl", error);
      return result;
    }
  }

  return result;
}

export const __test = { rawText, patchState };
