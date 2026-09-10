export const V10695_BOOTSTRAP_VERSION = '10.69.5-evidence-timeout-hotfix';

function patchMarketEvidenceV10695(source) {
  let out = String(source || '');

  out = out.replace('export const MARKET_EVIDENCE_VERSION = "1.1.0";', 'export const MARKET_EVIDENCE_VERSION = "1.1.1";');
  out = out.replace('const BUILD = "10.69.4";', 'const BUILD = "10.69.5";');

  if (!out.includes('EVIDENCE_DB_TIMEOUT_MS')) {
    // Route every query in this evidence module through a bounded node-postgres
    // query_timeout. This keeps a lock or saturated pool from freezing HTTP and
    // the Trader Brain processing loop indefinitely.
    out = out.replaceAll('pool.query(', 'dbQuery(pool, ');

    const helperAnchor = 'const salesCache = new Map();';
    const helper = `const salesCache = new Map();\n\n// v10.69.5: evidence DB work must fail closed instead of hanging forever.\nconst EVIDENCE_DB_TIMEOUT_MS = Math.max(1000, Math.min(15000, Number(process.env.MARKET_EVIDENCE_DB_TIMEOUT_MS || 5000)));\n\nfunction dbQuery(pool, text, values = []) {\n  if (!pool?.query) return Promise.reject(new Error("NO_DATABASE"));\n  return pool.query({\n    text: String(text),\n    values: Array.isArray(values) ? values : [],\n    query_timeout: EVIDENCE_DB_TIMEOUT_MS\n  });\n}\n\nfunction evidenceDbError(error) {\n  const message = String(error?.message || error || "EVIDENCE_DB_ERROR");\n  if (/timeout|timed out|query read timeout|canceling statement/i.test(message)) return "DB_TIMEOUT";\n  return message;\n}`;
    if (!out.includes(helperAnchor)) throw new Error('[v10.69.5] market evidence helper anchor missing');
    out = out.replace(helperAnchor, helper);
  }

  const statusOld = `  router.get("/status", async (req, res) => {\n    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);\n    res.json(statusPayload());\n  });`;
  const statusNew = `  router.get("/status", (req, res) => {\n    // v10.69.5: diagnostics are non-blocking. Refresh continues in background.\n    void refreshMarketEvidenceV1069({ pool, gameYear }).catch(error => {\n      lastRefreshFailureAt = new Date().toISOString();\n      lastRefreshError = evidenceDbError(error);\n    });\n    res.set("Cache-Control", "no-store");\n    res.json({\n      ...statusPayload(),\n      endpointMode: "NON_BLOCKING_STATUS",\n      dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS\n    });\n  });`;
  if (!out.includes('endpointMode: "NON_BLOCKING_STATUS"')) {
    if (!out.includes(statusOld)) throw new Error('[v10.69.5] evidence status route anchor missing');
    out = out.replace(statusOld, statusNew);
  }

  const usageOld = `  router.get("/cards/:eaId/usage", async (req, res) => {\n    const eaId = String(req.params.eaId || "");\n    const velocity = await usageVelocityFor(pool, gameYear, eaId);\n    res.json({ ok: true, eaId, gameYear: String(gameYear), velocity });\n  });`;
  const usageNew = `  router.get("/cards/:eaId/usage", async (req, res) => {\n    const eaId = String(req.params.eaId || "");\n    try {\n      const velocity = await usageVelocityFor(pool, gameYear, eaId);\n      res.json({ ok: true, eaId, gameYear: String(gameYear), velocity, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS });\n    } catch (error) {\n      const detail = evidenceDbError(error);\n      res.status(detail === "DB_TIMEOUT" ? 504 : 503).json({\n        ok: false, eaId, gameYear: String(gameYear), error: detail, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS\n      });\n    }\n  });`;
  if (!out.includes('velocity, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS')) {
    if (!out.includes(usageOld)) throw new Error('[v10.69.5] evidence usage route anchor missing');
    out = out.replace(usageOld, usageNew);
  }

  const salesOld = `  router.get("/cards/:eaId/sales", async (req, res) => {\n    const eaId = String(req.params.eaId || "");\n    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));\n    const sales = await salesFor(pool, gameYear, eaId, limit);\n    res.json({ ok: true, eaId, stats: salesStats(sales), rows: sales });\n  });`;
  const salesNew = `  router.get("/cards/:eaId/sales", async (req, res) => {\n    const eaId = String(req.params.eaId || "");\n    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));\n    try {\n      const sales = await salesFor(pool, gameYear, eaId, limit);\n      res.json({ ok: true, eaId, stats: salesStats(sales), rows: sales, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS });\n    } catch (error) {\n      const detail = evidenceDbError(error);\n      res.status(detail === "DB_TIMEOUT" ? 504 : 503).json({\n        ok: false, eaId, error: detail, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS\n      });\n    }\n  });`;
  if (!out.includes('rows: sales, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS')) {
    if (!out.includes(salesOld)) throw new Error('[v10.69.5] evidence sales route anchor missing');
    out = out.replace(salesOld, salesNew);
  }

  // Evidence must never be able to stop the core market-processing loop.
  out = out.replace(
    '    const sales = await salesFor(pool, gameYear, row.eaId, 60);',
    '    const sales = await salesFor(pool, gameYear, row.eaId, 60).catch(error => { lastRefreshError = evidenceDbError(error); return []; });'
  );
  out = out.replace(
    '    const sales = await salesFor(pool, gameYear, eaId, 100);',
    '    const sales = await salesFor(pool, gameYear, eaId, 100).catch(error => { lastRefreshError = evidenceDbError(error); return []; });'
  );

  // Cache-backed GETs should never wait for a Google/Gemini refresh before
  // returning. Their existing DB reads are now bounded by dbQuery().
  out = out.replace(
    `  router.get("/cards/:eaId", async (req, res) => {\n    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`,
    `  router.get("/cards/:eaId", async (req, res) => {\n    void refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`
  );
  out = out.replace(
    `  router.get("/cards/:eaId/games", async (req, res) => {\n    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`,
    `  router.get("/cards/:eaId/games", async (req, res) => {\n    void refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`
  );
  out = out.replace(
    `  router.get("/popular", async (req, res) => {\n    await refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`,
    `  router.get("/popular", async (req, res) => {\n    void refreshMarketEvidenceV1069({ pool, gameYear }).catch(() => null);`
  );

  const required = [
    'MARKET_EVIDENCE_VERSION = "1.1.1"',
    'const BUILD = "10.69.5"',
    'EVIDENCE_DB_TIMEOUT_MS',
    'query_timeout: EVIDENCE_DB_TIMEOUT_MS',
    'endpointMode: "NON_BLOCKING_STATUS"',
    'velocity, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS',
    'rows: sales, dbTimeoutMs: EVIDENCE_DB_TIMEOUT_MS'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error('[v10.69.5] evidence hotfix incomplete: ' + missing.join(', '));

  return out;
}

function patchServerRuntimeV10695(source) {
  let out = String(source || '');

  // v10.69.4 was active but the root page retained the v10.65 display label.
  out = out.replaceAll('10.65-final-rating-only', '10.69.5-final');
  out = out.replaceAll('10.69.4-final', '10.69.5-final');

  const endpointAnchor = 'ownMarketApi: "GET /api/market/v1/status",';
  if (out.includes(endpointAnchor) && !out.includes('marketEvidenceApi: "GET /api/market/v1/evidence/status"')) {
    out = out.replace(
      endpointAnchor,
      endpointAnchor + '\n      marketEvidenceApi: "GET /api/market/v1/evidence/status",'
    );
  }
  const evidenceEndpointAnchor = 'marketEvidenceApi: "GET /api/market/v1/evidence/status",';
  if (out.includes(evidenceEndpointAnchor) && !out.includes('marketHistory365Api: "GET /api/market/v1/history365/status"')) {
    out = out.replace(
      evidenceEndpointAnchor,
      evidenceEndpointAnchor + '\n      marketHistory365Api: "GET /api/market/v1/history365/status",'
    );
  }

  if (!out.includes('10.69.5-final')) throw new Error('[v10.69.5] runtime version label patch failed');
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== 'module') return result;

  const raw = typeof result.source === 'string'
    ? result.source
    : Buffer.from(result.source).toString('utf8');

  if (url.endsWith('/marketEvidenceV1069.js')) {
    const patched = patchMarketEvidenceV10695(raw);
    console.log('[v10.69.5] Evidence hotfix active: bounded DB queries + non-blocking status.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  if (url.endsWith('/server.js')) {
    const patched = patchServerRuntimeV10695(raw);
    console.log('[v10.69.5] Runtime label/endpoints patched.');
    return { format: result.format, source: patched, shortCircuit: true };
  }

  return result;
}
