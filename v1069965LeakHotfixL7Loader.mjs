import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L7_VERSION = "10.69.9.6.5-L7-free-trader-expansion";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5-L7] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchFreeTraderExpansionV1069965L7(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L7 free trader expansion")) return out;

  const oldTelegramBlock = `const PUBLIC_LEAK_TELEGRAM_CHANNELS = String(\n  process.env.PUBLIC_LEAK_TELEGRAM_CHANNELS || \"EAFC_PRIME,FIFA_TIPS,EASPORTSFCIT\"\n)\n  .split(/[;,\\n]+/)\n  .map(value => String(value || \"\").trim().replace(/^@/, \"\"))\n  .filter(value => /^[A-Za-z0-9_]{4,64}$/.test(value));`;

  const newTelegramBlock = `// v10.69.9.6.5-L7 free trader expansion.\n// These five public Telegram preview feeds are always present in Free Mode.\n// Custom PUBLIC_LEAK_TELEGRAM_CHANNELS values are merged, never allowed to\n// accidentally remove the core zero-cost sources.\nconst PUBLIC_LEAK_REQUIRED_FREE_CHANNELS = [\n  \"EAFC_PRIME\",\n  \"FIFA_TIPS\",\n  \"EASPORTSFCIT\",\n  \"EAFCFORECAST\",\n  \"FIFATRADECHANN1\"\n];\nconst PUBLIC_LEAK_TELEGRAM_CHANNELS = [...new Set([\n  ...String(process.env.PUBLIC_LEAK_TELEGRAM_CHANNELS || \"\")\n    .split(/[;,\\n]+/)\n    .map(value => String(value || \"\").trim().replace(/^@/, \"\"))\n    .filter(value => /^[A-Za-z0-9_]{4,64}$/.test(value)),\n  ...PUBLIC_LEAK_REQUIRED_FREE_CHANNELS\n])];`;

  out = replaceRequired(out, oldTelegramBlock, newTelegramBlock, "free Telegram source expansion");

  out = out.replace(
    "Free Mode ist standardmaessig aktiv: keine kostenpflichtige X-API-Nutzung. Der Brain nutzt frei oeffentliche X-Syndication/Mirrors und oeffentliche Telegram-Preview-Feeds; bezahlte X API ist nur bei PUBLIC_LEAK_FREE_MODE=false explizit aktivierbar.",
    "Free Mode ist standardmaessig aktiv: keine kostenpflichtige X-API-Nutzung. Der Brain nutzt frei oeffentliche X-Syndication/Mirrors und mindestens fuenf oeffentliche Telegram-Preview-Feeds (EAFC_PRIME, FIFA_TIPS, EASPORTSFCIT, EAFCFORECAST, FIFATRADECHANN1); bezahlte X API ist nur bei PUBLIC_LEAK_FREE_MODE=false explizit aktivierbar."
  );

  if (!out.includes("v10.69.9.6.5-L7 free trader expansion") ||
      !out.includes('"EAFCFORECAST"') ||
      !out.includes('"FIFATRADECHANN1"') ||
      !out.includes("PUBLIC_LEAK_REQUIRED_FREE_CHANNELS")) {
    throw new Error("[v10.69.9.6.5-L7] free trader expansion patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchFreeTraderExpansionV1069965L7(raw);
    console.log("[v10.69.9.6.5-L7] FREE trader expansion ACTIVE: EAFCFORECAST + FIFATRADECHANN1 added.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L7] free trader expansion hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
