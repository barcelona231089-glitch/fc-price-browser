export const V10698_BOOTSTRAP_VERSION = "10.69.8-parse-evidence-adapter";

function patchMarketEvidenceV10698(source) {
  let out = String(source || "");

  const importLine =
    'import { collectFutbinParseEvidenceV10698, getFutbinParseEvidenceStatusV10698 } from "./futbinParseEvidenceAdapterV10698.js";';

  if (!out.includes(importLine)) {
    const anchor =
      'import { collectFutbinEvidenceV10696, getFutbinEvidenceStatusV10696 } from "./futbinEvidenceAdapterV10696.js";';
    if (!out.includes(anchor)) {
      throw new Error("[v10.69.8] v10.69.6 evidence import anchor missing");
    }
    out = out.replace(anchor, anchor + "\n" + importLine);
  }

  out = out.replace(
    'export const MARKET_EVIDENCE_VERSION = "1.2.0";',
    'export const MARKET_EVIDENCE_VERSION = "1.3.0";'
  );
  out = out.replace(
    'const BUILD = "10.69.6";',
    'const BUILD = "10.69.8";'
  );

  const blockRe =
    /    \/\/ v10\.69\.6: prefer the explicit, read-only FUTBIN adapter[\s\S]*?    const usedDirectFutbin = directModeEnabled && directCards\.length > 0;/;

  if (!blockRe.test(out)) {
    throw new Error("[v10.69.8] v10.69.6 collector block anchor missing");
  }

  out = out.replace(blockRe, `    // v10.69.8: Parse managed API becomes the preferred supplemental
    // FUTBIN evidence transport when FUTBIN_PARSE_API_KEY is configured.
    // FUT.GG remains the sole live price authority.
    const parseResult = await collectFutbinParseEvidenceV10698({
      liveRows,
      gameYear,
      platform: clean(process.env.MARKET_EVIDENCE_PLATFORM || "ps", 20)
    }).catch(error => ({
      ok: false,
      status: String(error?.message || error),
      cards: []
    }));
    const parseCards = Array.isArray(parseResult?.cards) ? parseResult.cards : [];
    const parseModeEnabled = getFutbinParseEvidenceStatusV10698().configured === true;

    // Keep the old direct collector only as a disabled compatibility path.
    // When Parse is configured we never call FUTBIN directly from Hostless.
    const directResult = parseModeEnabled
      ? { ok: false, status: "DISABLED_BY_PARSE_MODE", cards: [] }
      : await collectFutbinEvidenceV10696({
          liveRows,
          gameYear,
          platform: clean(process.env.MARKET_EVIDENCE_PLATFORM || "ps", 20)
        }).catch(error => ({
          ok: false,
          status: String(error?.message || error),
          cards: []
        }));

    const directCards = Array.isArray(directResult?.cards) ? directResult.cards : [];
    const directModeEnabled =
      !parseModeEnabled && getFutbinEvidenceStatusV10696().authorized === true;

    // Parse owns the supplemental path whenever its API key is configured.
    // This prevents accidental fallback to direct FUTBIN requests or Gemini.
    const cards = parseModeEnabled
      ? parseCards
      : directModeEnabled
        ? directCards
        : await collectGoogleGroundedEvidence({ liveRows, gameYear });

    const usedParseFutbin = parseModeEnabled && parseCards.length > 0;
    const usedDirectFutbin = directModeEnabled && directCards.length > 0;`);

  out = out.replace(
    '      lastSource = usedDirectFutbin ? "FUTBIN_PUBLIC_AUTHORIZED" : "FUTBIN_GOOGLE_GROUNDED";',
    '      lastSource = usedParseFutbin ? "FUTBIN_PARSE_MANAGED_API" : (usedDirectFutbin ? "FUTBIN_PUBLIC_AUTHORIZED" : "FUTBIN_GOOGLE_GROUNDED");'
  );

  out = out.replace(
    '      return { ok: true, status: usedDirectFutbin ? "READY_FUTBIN_DIRECT" : "READY_FUTBIN_GROUNDED", ...saved };',
    '      return { ok: true, status: usedParseFutbin ? "READY_FUTBIN_PARSE" : (usedDirectFutbin ? "READY_FUTBIN_DIRECT" : "READY_FUTBIN_GROUNDED"), ...saved };'
  );

  if (!out.includes("parseAdapter: getFutbinParseEvidenceStatusV10698()")) {
    const anchor = "    directAdapter: getFutbinEvidenceStatusV10696(),";
    if (!out.includes(anchor)) {
      throw new Error("[v10.69.8] status directAdapter anchor missing");
    }
    out = out.replace(
      anchor,
      '    parseAdapter: getFutbinParseEvidenceStatusV10698(),\n' + anchor
    );
  }

  out = out.replace(
    'directFutbinScrape: getFutbinEvidenceStatusV10696().authorized === true,',
    'managedParseApi: getFutbinParseEvidenceStatusV10698().configured === true,\n      directFutbinScrape: getFutbinEvidenceStatusV10696().authorized === true,'
  );

  out = out.replace(
    'acceptedInputs: ["AUTHORIZED_FEED", "EXPLICIT_INGEST", "AUTHORIZED_PUBLIC_FETCH", "PUBLIC_INDEXED_GROUNDED_EVIDENCE"],',
    'acceptedInputs: ["AUTHORIZED_FEED", "EXPLICIT_INGEST", "PARSE_MANAGED_API", "AUTHORIZED_PUBLIC_FETCH", "PUBLIC_INDEXED_GROUNDED_EVIDENCE"],'
  );

  out = out.replace(
    'sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)) || getFutbinEvidenceStatusV10696().authorized === true || groundedStatus.configured,',
    'sourceConfigured: Boolean(clean(process.env.MARKET_EVIDENCE_FEED_URL, 1000)) || getFutbinParseEvidenceStatusV10698().configured === true || getFutbinEvidenceStatusV10696().authorized === true || groundedStatus.configured,'
  );

  out = out.replace(
    'note: "FUT.GG bleibt die Preis- und Marktquelle. FUTBIN liefert nur Zusatz-Evidenz: Games, Sales History und Popular Rank. Liquidity wird im Trader Brain aus beobachteten Sales berechnet. Direkter Read-only-Abruf läuft nur mit MARKET_EVIDENCE_FUTBIN_AUTHORIZED=true und ohne Proxy-, Stealth- oder Challenge-Bypass; sonst bleibt der autorisierte Feed/Explicit Ingest/Grounded-Fallback bestehen."',
    'note: "FUT.GG bleibt die Preis- und Marktquelle. v10.69.8 bevorzugt bei gesetztem FUTBIN_PARSE_API_KEY die verwaltete Parse-API für FUTBIN-Zusatz-Evidenz. Verwendet werden ausschließlich Games, Sales History und Popular Rank; Parse-Preisfelder werden nicht in die Preislogik übernommen. Liquidity wird im Trader Brain aus beobachteten Sales berechnet. Der direkte Hostless->FUTBIN-Abruf bleibt bei MARKET_EVIDENCE_FUTBIN_AUTHORIZED=false deaktiviert."'
  );

  const required = [
    'MARKET_EVIDENCE_VERSION = "1.3.0"',
    'const BUILD = "10.69.8"',
    "collectFutbinParseEvidenceV10698",
    "parseAdapter: getFutbinParseEvidenceStatusV10698()",
    '"READY_FUTBIN_PARSE"',
    '"PARSE_MANAGED_API"'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) {
    throw new Error(
      "[v10.69.8] Parse evidence patch incomplete: " + missing.join(", ")
    );
  }

  return out;
}

function patchServerRuntimeV10698(source) {
  let out = String(source || "");
  out = out.replaceAll("10.69.6-final", "10.69.8-final");
  if (!out.includes("10.69.8-final")) {
    throw new Error("[v10.69.8] runtime version label patch failed");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;

  const raw = typeof result.source === "string"
    ? result.source
    : Buffer.from(result.source).toString("utf8");

  if (url.endsWith("/marketEvidenceV1069.js")) {
    const patched = patchMarketEvidenceV10698(raw);
    console.log(
      "[v10.69.8] Parse FUTBIN Evidence active: managed API, exact match, no Parse prices in price authority."
    );
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith("/server.js")) {
    const patched = patchServerRuntimeV10698(raw);
    console.log("[v10.69.8] Runtime label patched.");
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}

export const __test = {
  patchMarketEvidenceV10698,
  patchServerRuntimeV10698
};
