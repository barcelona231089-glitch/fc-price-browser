export const V1069961_BOOTSTRAP_VERSION = "10.69.9.6.1-nonblocking-ml-start";

function requiredReplace(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6.1] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchServerV1069961(source) {
  let out = String(source || "");
  out = out.replaceAll("10.69.9.6-final", "10.69.9.6.1-final");

  const blocking = `    // v10.69.9.6 permanent ML bootstrap. The learned weights live in PostgreSQL.\n    // Heavy retraining runs later and defers while the market monitor is busy.\n    await startPermanentMlBrainV106996({\n      pool: dbEnabled ? pool : null,\n      gameYear: GAME_YEAR,\n      isBusy: () => monitoringBusy\n    });`;

  if (!out.includes("v10.69.9.6.1 non-blocking permanent ML bootstrap")) {
    const nonBlocking = `    // v10.69.9.6.1 non-blocking permanent ML bootstrap.\n    // Hostless health must not wait for PostgreSQL schema/model loading.\n    {\n      const mlBootstrapStartedAt = Date.now();\n      const mlBootstrapPromise = startPermanentMlBrainV106996({\n        pool: dbEnabled ? pool : null,\n        gameYear: GAME_YEAR,\n        isBusy: () => monitoringBusy\n      });\n      void mlBootstrapPromise.then(status => {\n        console.log(\n          \`[v10.69.9.6.1] Permanent ML bootstrap completed in \${Date.now() - mlBootstrapStartedAt}ms: \${status?.status || "UNKNOWN"}.\`\n        );\n      }).catch(error => {\n        console.error(\n          \`[v10.69.9.6.1] Permanent ML bootstrap failed without blocking HTTP startup: \${error?.message || error}\`\n        );\n      });\n    }`;
    out = requiredReplace(out, blocking, nonBlocking, "blocking ML bootstrap");
  }

  if (out.includes("await startPermanentMlBrainV106996({")) {
    throw new Error("[v10.69.9.6.1] blocking permanent ML startup still present");
  }
  if (!out.includes("10.69.9.6.1-final")) {
    throw new Error("[v10.69.9.6.1] runtime label patch missing");
  }
  return out;
}

export function patchPermanentMlV1069961(source) {
  let out = String(source || "");
  if (out.includes("v10.69.9.6.1 resilient startup retry")) return out;

  const startAnchor = 'export async function startPermanentMlBrainV106996({ pool = null, gameYear = "26", isBusy = null } = {}) {';
  const stopAnchor = 'export function stopPermanentMlBrainV106996() {';
  const startIndex = out.indexOf(startAnchor);
  const stopIndex = out.indexOf(stopAnchor);
  if (startIndex < 0 || stopIndex < 0 || stopIndex <= startIndex) {
    throw new Error("[v10.69.9.6.1] permanent ML startup anchors missing");
  }

  const replacement = `export async function startPermanentMlBrainV106996({ pool = null, gameYear = "26", isBusy = null } = {}) {\n  // v10.69.9.6.1 resilient startup retry. A DB/schema error must not permanently\n  // lock the ML runtime in started=true, and retries remain off the HTTP critical path.\n  runtimePool = pool;\n  runtimeGameYear = String(gameYear || "26");\n  runtimeBusyFn = typeof isBusy === "function" ? isBusy : null;\n  if (started) return getPermanentMlStatusV106996();\n  started = true;\n  lastStatus = { ...lastStatus, started: true, activeGameYear: runtimeGameYear, status: pool ? "LOADING" : "NO_DATABASE" };\n  if (!pool) return getPermanentMlStatusV106996();\n\n  try {\n    await ensureSchema(pool);\n    await loadPersistedModels(pool, runtimeGameYear);\n    const all = [...models.values()];\n    lastStatus = {\n      ...lastStatus,\n      status: all.length ? "MODEL_LOADED" : "WAITING_FOR_TRAINING",\n      modelCount: all.length,\n      trustedModels: all.filter(m => m.trusted).length,\n      lastError: null\n    };\n    const startTimer = setTimeout(() => trainAll(pool, runtimeGameYear).catch(() => {}), START_DELAY_MS);\n    startTimer.unref?.();\n    refreshHandle = setInterval(() => trainAll(pool, runtimeGameYear).catch(() => {}), RETRAIN_MS);\n    refreshHandle.unref?.();\n    return getPermanentMlStatusV106996();\n  } catch (error) {\n    started = false;\n    lastStatus = {\n      ...lastStatus,\n      started: false,\n      busy: false,\n      status: "START_RETRY_PENDING",\n      lastError: String(error?.message || error),\n      nextRefreshAt: new Date(Date.now() + 60_000).toISOString()\n    };\n    if (retryHandle) clearTimeout(retryHandle);\n    retryHandle = setTimeout(() => {\n      retryHandle = null;\n      startPermanentMlBrainV106996({\n        pool: runtimePool,\n        gameYear: runtimeGameYear,\n        isBusy: runtimeBusyFn\n      }).catch(() => {});\n    }, 60_000);\n    retryHandle.unref?.();\n    throw error;\n  }\n}\n\n`;

  out = out.slice(0, startIndex) + replacement + out.slice(stopIndex);
  if (!out.includes("v10.69.9.6.1 resilient startup retry")) {
    throw new Error("[v10.69.9.6.1] resilient startup patch missing");
  }
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;
  const raw = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");

  if (url.endsWith('/server.js')) {
    const source = patchServerV1069961(raw);
    console.log('[v10.69.9.6.1] Hostless startup guard active: Permanent ML no longer blocks HTTP health startup.');
    return { format: result.format, source, shortCircuit: true };
  }
  if (url.endsWith('/permanentMlBrainV106996.js')) {
    const source = patchPermanentMlV1069961(raw);
    console.log('[v10.69.9.6.1] Permanent ML resilient DB-start retry active.');
    return { format: result.format, source, shortCircuit: true };
  }
  return result;
}

export const __test = { patchServerV1069961, patchPermanentMlV1069961 };
