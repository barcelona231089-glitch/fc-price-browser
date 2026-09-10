import test from 'node:test';
import assert from 'node:assert/strict';
import { patchServerV1069961, patchPermanentMlV1069961 } from '../v1069961Loader.mjs';

test('server startup becomes non-blocking and keeps 24m runtime', () => {
  const src = `
const version = "10.69.9.6-final";
async function start(){
    await initDb();
    // v10.69.9.6 permanent ML bootstrap. The learned weights live in PostgreSQL.
    // Heavy retraining runs later and defers while the market monitor is busy.
    await startPermanentMlBrainV106996({
      pool: dbEnabled ? pool : null,
      gameYear: GAME_YEAR,
      isBusy: () => monitoringBusy
    });
    serverListen();
}`;
  const out = patchServerV1069961(src);
  assert.match(out, /10\.69\.9\.6\.1-final/);
  assert.match(out, /non-blocking permanent ML bootstrap/);
  assert.doesNotMatch(out, /await startPermanentMlBrainV106996\(\{/);
  assert.match(out, /serverListen\(\)/);
});

test('permanent ML startup resets and schedules retry on DB startup failure', () => {
  const src = `
let runtimePool, runtimeGameYear, runtimeBusyFn, started=false, lastStatus={}, retryHandle, refreshHandle;
const models=new Map(); const START_DELAY_MS=1; const RETRAIN_MS=1000;
async function ensureSchema(){} async function loadPersistedModels(){} async function trainAll(){}
function getPermanentMlStatusV106996(){return lastStatus;}
export async function startPermanentMlBrainV106996({ pool = null, gameYear = "26", isBusy = null } = {}) {
  runtimePool = pool;
  runtimeGameYear = String(gameYear || "26");
  runtimeBusyFn = typeof isBusy === "function" ? isBusy : null;
  if (started) return getPermanentMlStatusV106996();
  started = true;
  lastStatus = { ...lastStatus, started: true, activeGameYear: runtimeGameYear, status: pool ? "LOADING" : "NO_DATABASE" };
  if (!pool) return getPermanentMlStatusV106996();
  await ensureSchema(pool);
  await loadPersistedModels(pool, runtimeGameYear);
  const all = [...models.values()];
  lastStatus = {
    ...lastStatus,
    status: all.length ? "MODEL_LOADED" : "WAITING_FOR_TRAINING",
    modelCount: all.length,
    trustedModels: all.filter(m => m.trusted).length
  };
  const startTimer = setTimeout(() => trainAll(pool, runtimeGameYear).catch(() => {}), START_DELAY_MS);
  startTimer.unref?.();
  refreshHandle = setInterval(() => trainAll(pool, runtimeGameYear).catch(() => {}), RETRAIN_MS);
  refreshHandle.unref?.();
  return getPermanentMlStatusV106996();
}

export function stopPermanentMlBrainV106996() { started=false; }
`;
  const out = patchPermanentMlV1069961(src);
  assert.match(out, /resilient startup retry/);
  assert.match(out, /START_RETRY_PENDING/);
  assert.match(out, /started = false/);
  assert.match(out, /60_000/);
});
