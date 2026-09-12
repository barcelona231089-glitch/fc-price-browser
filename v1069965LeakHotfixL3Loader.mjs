import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L3_VERSION = "10.69.9.6.5-L3-fast-leak-horizons";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5-L3] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchFastLeakHorizonsV1069965L3(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L3 fast leak horizons")) return out;

  out = replaceRequired(
    out,
    "const TRADER_MARKET_IMPACT_HORIZONS = [15, 60, 360, 1440];",
    `// v10.69.9.6.5-L3 fast leak horizons
const TRADER_MARKET_IMPACT_HORIZONS = [2, 5, 15, 60, 360, 1440];`,
    "trader market impact horizons"
  );

  out = replaceRequired(
    out,
    "const MARKET_KNOWLEDGE_HORIZONS = [15, 60, 360, 1440];",
    "const MARKET_KNOWLEDGE_HORIZONS = [2, 5, 15, 60, 360, 1440];",
    "market knowledge horizons"
  );

  // Original default 12 represented about three events across four horizons.
  // With six horizons use 18 so adding 2m/5m does not make knowledge mature
  // merely because there are more checkpoints. An explicit env override still wins.
  out = out.replace(
    "Number(process.env.MARKET_KNOWLEDGE_MIN_SAMPLES || 12)",
    "Number(process.env.MARKET_KNOWLEDGE_MIN_SAMPLES || 18)"
  );

  out = out
    .replaceAll("15m/1h/6h/24h", "2m/5m/15m/1h/6h/24h")
    .replaceAll("15m / 1h / 6h / 24h", "2m / 5m / 15m / 1h / 6h / 24h");

  if (!out.includes("const TRADER_MARKET_IMPACT_HORIZONS = [2, 5, 15, 60, 360, 1440];")) {
    throw new Error("[v10.69.9.6.5-L3] trader impact horizons patch incomplete");
  }
  if (!out.includes("const MARKET_KNOWLEDGE_HORIZONS = [2, 5, 15, 60, 360, 1440];")) {
    throw new Error("[v10.69.9.6.5-L3] knowledge horizons patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchFastLeakHorizonsV1069965L3(raw);
    console.log("[v10.69.9.6.5-L3] Leak reaction horizons 2m/5m/15m/1h/6h/24h ACTIVE.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L3] fast leak horizons hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
