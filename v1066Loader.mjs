import { patchServer as patchServerV1064 } from './v1064Loader.mjs';
import { patchRatingOnly } from './v1065Loader.mjs';

export const V1066_BOOTSTRAP_VERSION = '10.66-futbin-authorized-bridge-final';

export function patchFutbinBridgeV1066(source) {
  const original = String(source || '');
  let out = original;

  if (!out.includes('./futbinBridgeV1066.js')) {
    out = out.replace(
      '} from "./futbinMarketV1064.js";',
      '} from "./futbinMarketV1064.js";\nimport {\n  enrichRowsWithFutbinSafeV1066,\n  startFutbinBridgeBootstrapV1066,\n  createFutbinBridgeRouterV1066,\n  futbinBridgeV1066Status\n} from "./futbinBridgeV1066.js";'
    );
  }

  // Replace the direct Hostless scraper in the live cycle. The v10.66 wrapper uses
  // an authorized feed/import cache first and only uses direct FUTBIN when explicitly enabled.
  out = out.replace(
    'await enrichRowsWithFutbinPublicGapFill({',
    'await enrichRowsWithFutbinSafeV1066({' 
  );

  // Disable the automatic direct FUTBIN backfill that repeatedly hit 403 on Hostless.
  out = out.replace(
    /startFc26Backfill\(\{ rows: latestTradingRows, pool, gameYear: "26", limit: 500 \}\)/g,
    'startFutbinBridgeBootstrapV1066({ pool, gameYear: "26" })'
  );
  out = out.replaceAll('[v10.64] FC26 FUTBIN backfill gestartet:', '[v10.66] FUTBIN authorized bridge bootstrap:');
  out = out.replaceAll('[v10.64] FC26 FUTBIN backfill start error:', '[v10.66] FUTBIN bridge bootstrap error:');

  // Manual backfill endpoint now refreshes the authorized bridge instead of hammering a blocked origin.
  out = out.replace(
    /const result = await startFc26Backfill\(\{\s*rows: latestTradingRows,\s*pool,\s*gameYear: "26",\s*limit: Number\(req\.body\?\.limit \|\| 500\)\s*\}\);\s*res\.status\(result\.ok \? 202 : 409\)\.json\(result\);/m,
    'const result = await startFutbinBridgeBootstrapV1066({ pool, gameYear: "26" });\n    res.status(result.ok ? 202 : 409).json(result);'
  );

  if (!out.includes('v10.66 FUTBIN bridge router')) {
    out = out.replace(
      'app.use(uvRouter);',
      'app.use(uvRouter);\n// v10.66 FUTBIN bridge router\napp.use("/api/futbin-bridge", createFutbinBridgeRouterV1066({ pool: dbEnabled ? pool : null, gameYear: GAME_YEAR }));'
    );
  }

  // Final status now reports the actual runtime patch and both FUTBIN layers.
  out = out.replace(
    'const [adaptive, futbin] = await Promise.all([',
    'const [adaptive, futbin, futbinBridge] = await Promise.all(['
  );
  out = out.replace(
    'futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);',
    'futbinPublicStatus({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR }),\n      futbinBridgeV1066Status({ pool: dbEnabled ? pool : null, gameYear: String(GAME_YEAR) === "27" ? "26" : GAME_YEAR })\n    ]);'
  );
  out = out.replaceAll('version: "10.64-final"', 'version: "10.66-final"');
  out = out.replaceAll('outputMode: "BUY_SELL_ONLY"', 'outputMode: "RATING_ONLY_BUY_SELL"');
  out = out.replace(
    '      futbin,\n      checklist:',
    '      futbin: { direct: futbin, bridge: futbinBridge, effectiveMode: futbinBridge?.authorizedFeedConfigured || Number(futbinBridge?.db?.cards || 0) > 0 ? "AUTHORIZED_BRIDGE_ACTIVE" : "FUTGG_ONLY_UNTIL_FUTBIN_FEED" },\n      checklist:'
  );
  out = out.replace(
    '        futbinGapFill: true,',
    '        futbinGapFill: true,\n        futbinAuthorizedBridge: true,\n        futbinDirect403LoopRemoved: true,'
  );

  out = out.replaceAll('FC Trading Intelligence v10.65 FINAL Rating-Only + FUTBIN Complete + FC26 Season Brain', 'FC Trading Intelligence v10.66 FINAL Rating-Only + Authorized FUTBIN Bridge + FC26 Season Brain');

  return { source: out, changed: out !== original };
}

export async function load(url, context, defaultLoad) {
  const result = await defaultLoad(url, context, defaultLoad);
  if (!url.endsWith('/server.js') || result.format !== 'module') return result;

  const raw = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const base64 = patchServerV1064(raw);
  if (!base64?.source) throw new Error('[v10.66] v10.64 base patch failed.');
  const rating = patchRatingOnly(base64.source);
  if (!rating?.source) throw new Error('[v10.66] v10.65 rating patch failed.');
  const final = patchFutbinBridgeV1066(rating.source);
  if (!final?.source) throw new Error('[v10.66] FUTBIN bridge patch failed.');

  const required = [
    './futbinBridgeV1066.js',
    'enrichRowsWithFutbinSafeV1066',
    'v10.66 FUTBIN bridge router',
    'RATING_ONLY_BUY_SELL',
    '10.66-final'
  ];
  const missing = required.filter(marker => !final.source.includes(marker));
  if (missing.length) throw new Error('[v10.66] patch incomplete: ' + missing.join(', '));

  console.log('[v10.66] FINAL patch active: Rating-only + authorized FUTBIN bridge + FC26 memory. Direct FUTBIN is opt-in only.');
  return { format: result.format, source: final.source, shortCircuit: true };
}
