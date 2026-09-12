import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_L6_VERSION = "10.69.9.6.5-L6-free-public-leak-mode";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5-L6] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchFreePublicLeakModeV1069965L6(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L6 zero-cost public leak mode")) return out;

  // Free mode is ON by default. It hard-disables the paid X API even when a token
  // remains configured in Hostless, so no X credits can be consumed accidentally.
  const oldApiConfig = `const PUBLIC_LEAK_X_API_BEARER_TOKEN = String(\n  process.env.X_BEARER_TOKEN || process.env.PUBLIC_LEAK_X_API_BEARER_TOKEN || \"\"\n).trim();\nconst PUBLIC_LEAK_X_API_ENABLED =\n  Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN) &&\n  String(process.env.PUBLIC_LEAK_X_API_ENABLED || \"true\").trim().toLowerCase() !== \"false\";`;

  const newApiConfig = `// v10.69.9.6.5-L6 zero-cost public leak mode.\n// Default: paid X API OFF. Public syndication/mirrors + public Telegram previews stay ON.\nconst PUBLIC_LEAK_FREE_MODE = String(process.env.PUBLIC_LEAK_FREE_MODE || \"true\").trim().toLowerCase() !== \"false\";\nconst PUBLIC_LEAK_X_API_BEARER_TOKEN = String(\n  process.env.X_BEARER_TOKEN || process.env.PUBLIC_LEAK_X_API_BEARER_TOKEN || \"\"\n).trim();\nconst PUBLIC_LEAK_X_API_ENABLED =\n  !PUBLIC_LEAK_FREE_MODE &&\n  Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN) &&\n  String(process.env.PUBLIC_LEAK_X_API_ENABLED || \"true\").trim().toLowerCase() !== \"false\";`;

  out = replaceRequired(out, oldApiConfig, newApiConfig, "free-mode X API gate");

  // Add a verified public Telegram aggregator that republishes FutSheriff and
  // Criminal__x with source attribution. Existing EAFC_PRIME/FIFA_TIPS remain.
  out = replaceRequired(
    out,
    'process.env.PUBLIC_LEAK_TELEGRAM_CHANNELS || "EAFC_PRIME,FIFA_TIPS"',
    'process.env.PUBLIC_LEAK_TELEGRAM_CHANNELS || "EAFC_PRIME,FIFA_TIPS,EASPORTSFCIT"',
    "free Telegram defaults"
  );

  const oldStatus = `      xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,\n      xApiOk: publicLeakXApiOverallOk(),\n      xApiLastSuccessAt: publicLeakXApiLastSuccessAt,\n      xApiLastError: publicLeakXApiCurrentError(),\n      xApiRateLimit: publicLeakXApiLastRateLimit,\n      xApi: {\n        configured: PUBLIC_LEAK_X_API_ENABLED,\n        ok: publicLeakXApiOverallOk(),\n        provider: \"Official X API v2\",`;

  const newStatus = `      freeMode: PUBLIC_LEAK_FREE_MODE,\n      paidXApiDisabledByFreeMode: PUBLIC_LEAK_FREE_MODE,\n      xApiCredentialPresent: Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN),\n      xApiConfigured: PUBLIC_LEAK_X_API_ENABLED,\n      xApiOk: publicLeakXApiOverallOk(),\n      xApiLastSuccessAt: publicLeakXApiLastSuccessAt,\n      xApiLastError: publicLeakXApiCurrentError(),\n      xApiRateLimit: publicLeakXApiLastRateLimit,\n      xApi: {\n        configured: PUBLIC_LEAK_X_API_ENABLED,\n        ok: publicLeakXApiOverallOk(),\n        disabledByFreeMode: PUBLIC_LEAK_FREE_MODE,\n        credentialPresent: Boolean(PUBLIC_LEAK_X_API_BEARER_TOKEN),\n        provider: \"Official X API v2\",`;

  out = replaceRequired(out, oldStatus, newStatus, "free-mode status telemetry");

  out = out.replaceAll(
    'transport: "Official X API v2 + public fallbacks + Telegram fallback"',
    'transport: PUBLIC_LEAK_FREE_MODE ? "FREE: public X syndication + public mirrors + Telegram" : "Official X API v2 + public fallbacks + Telegram fallback"'
  );

  out = out.replaceAll(
    'provider: "Official X API v2 + public fallbacks",',
    'provider: PUBLIC_LEAK_FREE_MODE ? "FREE public X fallbacks" : "Official X API v2 + public fallbacks",'
  );

  out = out.replaceAll(
    "Der Brain nutzt bei konfiguriertem X_BEARER_TOKEN die offizielle X API v2 als primaeren Pfad. Seit dem letzten erfolgreichen Poll wird per since_id inkrementell gelesen; oeffentliche Fallbacks und Telegram bleiben aktiv.",
    "Free Mode ist standardmaessig aktiv: keine kostenpflichtige X-API-Nutzung. Der Brain nutzt frei oeffentliche X-Syndication/Mirrors und oeffentliche Telegram-Preview-Feeds; bezahlte X API ist nur bei PUBLIC_LEAK_FREE_MODE=false explizit aktivierbar."
  );

  if (!out.includes("v10.69.9.6.5-L6 zero-cost public leak mode") ||
      !out.includes("!PUBLIC_LEAK_FREE_MODE &&") ||
      !out.includes('EAFC_PRIME,FIFA_TIPS,EASPORTSFCIT') ||
      !out.includes("paidXApiDisabledByFreeMode: PUBLIC_LEAK_FREE_MODE") ||
      !out.includes('FREE: public X syndication + public mirrors + Telegram')) {
    throw new Error("[v10.69.9.6.5-L6] free public leak mode patch incomplete");
  }

  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchFreePublicLeakModeV1069965L6(raw);
    console.log("[v10.69.9.6.5-L6] ZERO-COST public leak mode ACTIVE; paid X API disabled by default.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L6] free public leak mode hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
