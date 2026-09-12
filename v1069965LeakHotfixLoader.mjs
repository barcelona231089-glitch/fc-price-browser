import { Buffer } from "node:buffer";

export const V1069965_LEAK_HOTFIX_VERSION = "10.69.9.6.5-L1-public-leaks";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  try { return Buffer.from(source).toString("utf8"); } catch { return null; }
}

function requiredReplace(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.5-L1] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchPublicLeaksV1069965L1(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.5-L1 public leak multi-source hotfix")) return out;

  const handlesOld = `const PUBLIC_LEAK_X_HANDLES = String(\n  process.env.PUBLIC_LEAK_X_HANDLES || "FutSheriff"\n)`;
  const handlesNew = `// v10.69.9.6.5-L1 public leak multi-source hotfix.\n// Public sources only. No login, paywall or private-channel access.\nconst PUBLIC_LEAK_X_HANDLES = String(\n  process.env.PUBLIC_LEAK_X_HANDLES || "FutSheriff,FutPoliceLeaks,Criminal__x,Futdonk"\n)`;
  out = requiredReplace(out, handlesOld, handlesNew, "PUBLIC_LEAK_X_HANDLES");

  const matchOld = `function publicLeakMatchesGameYear(text) {\n  const matches = [...String(text || "").matchAll(/\\b(?:EA\\s*SPORTS\\s*)?FC\\s*(2[67])\\b/gi)]\n    .map(item => item[1]);\n  if (!matches.length) return true;\n  return matches.includes(GAME_YEAR);\n}`;

  const matchNew = `function publicLeakMatchesGameYear(text) {\n  const matches = [...String(text || "").matchAll(/\\b(?:EA\\s*SPORTS\\s*)?FC\\s*(2[67])\\b/gi)]\n    .map(item => item[1]);\n  if (!matches.length) return true;\n  if (matches.includes(GAME_YEAR)) return true;\n\n  // Five days before a new title launches, the active runtime can still be FC26\n  // while useful public market/content leaks already talk about FC27. Accept the\n  // immediately following game year by default, while keeping an env kill switch.\n  const acceptNextGameYear = String(process.env.PUBLIC_LEAK_ACCEPT_NEXT_GAME_YEAR || "true")\n    .trim()\n    .toLowerCase() !== "false";\n  if (!acceptNextGameYear) return false;\n\n  const current = Number(GAME_YEAR);\n  const nextGameYear = Number.isFinite(current) ? String(current + 1).padStart(2, "0") : null;\n  return Boolean(nextGameYear && matches.includes(nextGameYear));\n}`;

  out = requiredReplace(out, matchOld, matchNew, "publicLeakMatchesGameYear");

  if (!out.includes("FutPoliceLeaks") || !out.includes("Criminal__x") || !out.includes("Futdonk") ||
      !out.includes("PUBLIC_LEAK_ACCEPT_NEXT_GAME_YEAR")) {
    throw new Error("[v10.69.9.6.5-L1] public leak hotfix incomplete");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module" || !url.endsWith("/server.js")) return result;

  const raw = sourceText(result.source);
  if (raw == null) return result;

  try {
    const source = patchPublicLeaksV1069965L1(raw);
    console.log("[v10.69.9.6.5-L1] Public leak multi-source + FC27 prelaunch intake ACTIVE.");
    return { ...result, source, shortCircuit: true };
  } catch (error) {
    console.error(`[v10.69.9.6.5-L1] leak hotfix disabled: ${error?.stack || error}`);
    return result;
  }
}
