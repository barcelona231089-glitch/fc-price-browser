export const V10696_BOOTSTRAP_VERSION = "10.69.6-futbin-evidence-adapter";

function patchMarketEvidenceV10696(source) {
  let out = String(source || "");

  const importLine = 'import { collectFutbinEvidenceV10696, getFutbinEvidenceStatusV10696 } from "./futbinEvidenceAdapterV10696.js";';
  if (!out.includes(importLine)) {
    const anchor = 'import crypto from "crypto";';
    if (!out.includes(anchor)) throw new Error("[v10.69.6] market evidence import anchor missing");
    out = out.replace(anchor, anchor + "\n" + importLine);
  }

  out = out.replace('export const MARKET_EVIDENCE_VERSION = "1.1.1";', 'export const MARKET_EVIDENCE_VERSION = "1.2.0";');
  out = out.replace('const BUILD = "10.69.5";', 'const BUILD = "10.69.6";');

  const googleLine = '    const cards = await collectGoogleGroundedEvidence({ liveRows, gameYear });';
  if (out.includes(googleLine) && !out.includes("collectFutbinEvidenceV10696({ liveRows, gameYear")) {
    out = out.replace(googleLine, `    // v10.69.6: prefer the explicit, read-only FUTBIN adapter when the operator
    // has authorized automated access. No proxy/stealth/challenge bypass is used.
    const directResult = await collectFutbinEvidenceV10696({
      liveRows,
      gameYear,
      platform: clean(process.env.MARKET_EVIDENCE_PLATFORM || "ps", 20)
    }).catch(error => ({ ok: false, status: String(error?.message || error), cards: [] }));
    const directCards = Array.isArray(directResult?.cards) ? directResult.cards : [];
    const directModeEnabled = getFutbinEvidenceStatusV10696().authorized === true;
    // When the authorized direct adapter is enabled it owns FUTBIN evidence
    // collection. Gemini is not used as a shadow/fallback collector in that mode.
    const cards = directModeEnabled
      ? directCards
      : await collectGoogleGroundedEvidence({ liveRows, gameYear });
    const usedDirectFutbin = directModeEnabled && directCards.length > 0;`);
  }

  out = out.replace(
    '      lastSource = "FUTBIN_GOOGLE_GROUNDED";',
    '      lastSource = usedDirectFutbin ? "FUTBIN_PUBLIC_AUTHORIZED" : "FUTBIN_GOOGLE_GROUNDED";'
  );
  out = out.replace(
    '      return { ok: true, status: "READY_FUTBIN_GROUNDED", ...saved };',
    '      return { ok: true, status: usedDirectFutbin ? "READY_FUTBIN_DIRECT" : "READY_FUTBIN_GROUNDED", ...saved };'
  );

  if (!out.includes("directAdapter: getFutbinEvidenceStatusV10696()")) {
    const statusAnchor = '    groundedSupplement: {';
    if (!out.includes(statusAnchor)) throw new Error("[v10.69.6] status payload anchor missing");
    out = out.replace(
      statusAnchor,
      '    directAdapter: getFutbinEvidenceStatusV10696(),\n' + statusAnchor
    );
  }

  out = out.replace(
    'directFutbinScrape: false,',
    'directFutbinScrape: getFutbinEvidenceStatusV10696().authorized === true,'
  );
  out = out.replace(
    'gamesStatus: groundedStatus.cardsWithGames > 0 ? "OBSERVED_FROM_GROUNDED_PUBLIC_SOURCE" : "WAITING_FOR_VERIFIED_SOURCE",',
    'gamesStatus: withGames > 0 ? "OBSERVED_FROM_VERIFIED_FUTBIN_EVIDENCE" : "WAITING_FOR_VERIFIED_SOURCE",'
  );
  out = out.replace(
    'sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)) || groundedStatus.configured,',
    'sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)) || getFutbinEvidenceStatusV10696().authorized === true || groundedStatus.configured,'
  );
  out = out.replace(
    'acceptedInputs: ["AUTHORIZED_FEED", "EXPLICIT_INGEST", "PUBLIC_INDEXED_GROUNDED_EVIDENCE"],',
    'acceptedInputs: ["AUTHORIZED_FEED", "EXPLICIT_INGEST", "AUTHORIZED_PUBLIC_FETCH", "PUBLIC_INDEXED_GROUNDED_EVIDENCE"],'
  );

  out = out.replace(
    'note: "FUT.GG bleibt die Preis- und Marktquelle. Zusatzdaten kommen ausschließlich aus FUTBIN-Evidenz. Wenn direkter FUTBIN-Zugriff nicht verfügbar ist, darf Gemini Google Search nur öffentlich indexierte FUTBIN-Seiten auswerten. Games/Sales/Popular bleiben ohne verifizierte FUTBIN-Evidenz null/leer."',
    'note: "FUT.GG bleibt die Preis- und Marktquelle. FUTBIN liefert nur Zusatz-Evidenz: Games, Sales History und Popular Rank. Liquidity wird im Trader Brain aus beobachteten Sales berechnet. Direkter Read-only-Abruf läuft nur mit MARKET_EVIDENCE_FUTBIN_AUTHORIZED=true und ohne Proxy-, Stealth- oder Challenge-Bypass; sonst bleibt der autorisierte Feed/Explicit Ingest/Grounded-Fallback bestehen."'
  );

  const required = [
    'MARKET_EVIDENCE_VERSION = "1.2.0"',
    'const BUILD = "10.69.6"',
    "collectFutbinEvidenceV10696",
    "directAdapter: getFutbinEvidenceStatusV10696()",
    '"READY_FUTBIN_DIRECT"'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error("[v10.69.6] evidence adapter patch incomplete: " + missing.join(", "));

  return out;
}

function patchServerRuntimeV10696(source) {
  let out = String(source || "");
  out = out.replaceAll("10.69.5-final", "10.69.6-final");
  if (!out.includes("10.69.6-final")) throw new Error("[v10.69.6] runtime version label patch failed");
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;

  const raw = typeof result.source === "string"
    ? result.source
    : Buffer.from(result.source).toString("utf8");

  if (url.endsWith("/marketEvidenceV1069.js")) {
    const patched = patchMarketEvidenceV10696(raw);
    console.log("[v10.69.6] FUTBIN Evidence Adapter active: exact matching + Games/Sales/Popular, no bypass.");
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith("/server.js")) {
    const patched = patchServerRuntimeV10696(raw);
    console.log("[v10.69.6] Runtime label patched.");
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}
