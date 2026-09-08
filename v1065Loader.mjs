import { patchServer as patchServerV1064 } from './v1064Loader.mjs';

export const V1065_BOOTSTRAP_VERSION = '10.65-final-rating-only-lock';

export function patchRatingOnly(source) {
  const original = String(source || '');
  let out = original;

  // Public Discord is FINAL RATING ONLY. All card/player-specific alert pipelines
  // remain internal for learning, but they no longer consume the public alert budget.
  out = out.replace(
    '      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);',
    '      // v10.65 RATING-ONLY: intensive player alerts remain internal.'
  );
  out = out.replace(
    '      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);',
    '      // v10.65 RATING-ONLY: trader confluence remains an internal brain input.'
  );
  out = out.replace(
    '      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);',
    '      // v10.65 RATING-ONLY: player state-change alerts remain internal.'
  );

  // Health/source recovery remains tracked internally, but never consumes a Discord
  // slot or creates public noise. Preserve previousSourceHealthStatus first.
  if (!out.includes('v10.65 source-health Discord disabled')) {
    out = out.replace(
      '  previousSourceHealthStatus = current;',
      '  previousSourceHealthStatus = current;\n  // v10.65 source-health Discord disabled; internal transition state is preserved.\n  return false;'
    );
  }

  // processDiscordAlerts may still build player-card candidates. Stop those before
  // send/budget/state handling. Rating candidates continue normally.
  if (!out.includes('v10.65 hard player-card public block')) {
    out = out.replace(
      '      if (item.kind === "card") {',
      '      if (item.kind === "card") {\n        // v10.65 hard player-card public block.\n        continue;'
    );
  }

  // Mark the only allowed automatic public payload: the aggregate rating alert.
  if (!out.includes('__v1065RatingOnly')) {
    out = out.replace(
      '        await sendDiscordPayload(buildRatingDiscordPayload(stat));',
      '        await sendDiscordPayload({\n' +
        '          ...buildRatingDiscordPayload(stat),\n' +
        '          __v1065RatingOnly: true,\n' +
        '          __v1065Rating: Number(stat.rating),\n' +
        '          __v1065Action: (() => {\n' +
        '            const a = String(stat.marketAdvice || "").toUpperCase();\n' +
        '            const m = String(stat.marketSignal || "").toUpperCase();\n' +
        '            if ((a.includes("KAUF") && !a.includes("NICHT")) || m === "KAUFZONE") return "KAUFEN";\n' +
        '            if (a.includes("VERKAUF") || m === "VERKAUFSZONE") return "VERKAUFEN";\n' +
        '            return "";\n' +
        '          })()\n' +
        '        });'
    );
  }

  // Final choke point. Even if any old/new code path tries to send a player,
  // health, HA, source, startup, WAIT, NO_CALL or system payload, it is rejected.
  // The aggregate rating payload is normalized to exactly KAUFEN/VERKAUFEN.
  if (!out.includes('v10.65 FINAL RATING-ONLY Discord choke point')) {
    out = out.replace(
      'async function sendDiscordPayload(payload) {',
      'async function sendDiscordPayload(payload) {\n' +
        '  // v10.65 FINAL RATING-ONLY Discord choke point.\n' +
        '  if (payload?.__v1065RatingOnly !== true) {\n' +
        '    return { ok: false, skipped: "v10.65_rating_only_non_rating_payload" };\n' +
        '  }\n' +
        '  const __v1065Rating = Number(payload.__v1065Rating);\n' +
        '  const __v1065ActionText = String(payload.__v1065Action || "").toUpperCase();\n' +
        '  const __v1065Buy = __v1065ActionText.includes("KAUF") && !__v1065ActionText.includes("NICHT");\n' +
        '  const __v1065Sell = __v1065ActionText.includes("VERKAUF");\n' +
        '  if (!Number.isFinite(__v1065Rating) || __v1065Rating < 1 || (!__v1065Buy && !__v1065Sell)) {\n' +
        '    return { ok: false, skipped: "v10.65_rating_only_no_final_trade_action" };\n' +
        '  }\n' +
        '  const __v1065Embed = Array.isArray(payload.embeds) ? payload.embeds[0] : null;\n' +
        '  if (!__v1065Embed) {\n' +
        '    return { ok: false, skipped: "v10.65_rating_only_missing_embed" };\n' +
        '  }\n' +
        '  payload = {\n' +
        '    ...payload,\n' +
        '    embeds: [{\n' +
        '      ...__v1065Embed,\n' +
        '      title: (__v1065Buy ? "🟢 KAUFEN: " : "🔴 VERKAUFEN: ") + Math.round(__v1065Rating) + " RATING",\n' +
        '      url: undefined\n' +
        '    }]\n' +
        '  };\n' +
        '  delete payload.__v1065RatingOnly;\n' +
        '  delete payload.__v1065Rating;\n' +
        '  delete payload.__v1065Action;'
    );
  }

  // Runtime labels make it obvious which final lock is active.
  out = out.replaceAll('10.64-complete-market-memory', '10.65-final-rating-only');
  out = out.replaceAll('FC Trading Intelligence v10.64 FINAL Market Intelligence + FUTBIN Complete Gap-Fill + FC26 Season Brain', 'FC Trading Intelligence v10.65 FINAL Rating-Only + FUTBIN Complete + FC26 Season Brain');

  return { source: out, changed: out !== original };
}

export async function load(url, context, defaultLoad) {
  const result = await defaultLoad(url, context, defaultLoad);
  if (!url.endsWith('/server.js') || result.format !== 'module') return result;

  const raw = typeof result.source === 'string'
    ? result.source
    : Buffer.from(result.source).toString('utf8');

  const base = patchServerV1064(raw);
  if (!base?.source || typeof base.source !== 'string') {
    throw new Error('[v10.65] v10.64 base patch returned no server source.');
  }

  const final = patchRatingOnly(base.source);
  if (!final?.source || typeof final.source !== 'string') {
    throw new Error('[v10.65] rating-only patch returned no server source.');
  }

  const required = [
    'v10.65 FINAL RATING-ONLY Discord choke point',
    '__v1065RatingOnly',
    'v10.65 hard player-card public block',
    'v10.65 source-health Discord disabled'
  ];
  const missing = required.filter(marker => !final.source.includes(marker));
  if (missing.length) {
    throw new Error('[v10.65] final patch incomplete: ' + missing.join(', '));
  }

  console.log('[v10.65] FINAL patch active: Rating-only Discord + v10.64 Market/FUTBIN/FC26 base.');

  return {
    format: result.format,
    source: final.source,
    shortCircuit: true
  };
}
