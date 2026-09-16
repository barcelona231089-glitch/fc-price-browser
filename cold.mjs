import pg from 'pg';
import http from 'node:http';
import { spawn } from 'node:child_process';

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
const instanceId = String(process.env.FC_INSTANCE_ID || 'blitz-standby-1').trim();
const lockName = String(process.env.FC_HA_LOCK_NAME || 'fc-trader-brain-active').trim();
const pollSeconds = Math.max(10, Number(process.env.FC_COLD_POLL_SECONDS || 20));
const startDelaySeconds = Math.max(60, Number(process.env.FC_COLD_STANDBY_DELAY_SECONDS || 300));
const port = Math.max(1, Number(process.env.PORT || 8080));
const fullBootstrap = new URL('./v1069965LeakHotfixL7Bootstrap.mjs', import.meta.url);

const pool = databaseUrl ? new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  query_timeout: 10000
}) : null;

let child = null;
let stopping = false;
let candidateSince = 0;
let otherLeaderChecks = 0;
let lastLease = { valid: false, holderId: null, leaseUntil: null, priority: null };
let warnedMissingDb = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    mode: child ? 'FULL_BRAIN' : 'COLD_STANDBY',
    instanceId,
    leaderId: lastLease.holderId,
    leaseValid: lastLease.valid,
    databaseConfigured: Boolean(databaseUrl)
  }));
});
healthServer.listen(port, '0.0.0.0', () => {
  console.log(`[COLD] Health listener active on port ${port}.`);
});

async function readLease() {
  if (!pool) {
    if (!warnedMissingDb) {
      console.log('[COLD] DATABASE_URL not configured; staying cold.');
      warnedMissingDb = true;
    }
    return { valid: false, holderId: null, leaseUntil: null, priority: null };
  }

  const result = await pool.query(`
    SELECT holder_id, priority, lease_until, heartbeat_at,
           (lease_until > NOW()) AS lease_valid
    FROM fc_runtime_leader
    WHERE lock_name = $1
    LIMIT 1
  `, [lockName]);

  const row = result.rows?.[0] || null;
  if (!row) return { valid: false, holderId: null, leaseUntil: null, priority: null };

  return {
    valid: row.lease_valid === true,
    holderId: row.holder_id || null,
    leaseUntil: row.lease_until || null,
    priority: Number(row.priority) || null
  };
}

function launchFullBrain() {
  if (child || stopping || !pool) return;
  console.log(`[COLD] No valid leader. Launching full brain for ${instanceId}.`);
  child = spawn(process.execPath, [fullBootstrap.pathname], {
    cwd: new URL('.', import.meta.url),
    env: process.env,
    stdio: 'inherit'
  });
  otherLeaderChecks = 0;
  child.once('exit', (code, signal) => {
    console.log(`[COLD] Full brain exited code=${code ?? 'null'} signal=${signal ?? 'null'}. Returning to cold watch.`);
    child = null;
    candidateSince = 0;
    otherLeaderChecks = 0;
  });
}

async function stopFullBrain(reason) {
  if (!child) return;
  console.log(`[COLD] Stopping full brain (${reason}); another valid leader owns the lease.`);
  const proc = child;
  child = null;
  try { proc.kill('SIGTERM'); } catch {}
  await sleep(3000);
  try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
  candidateSince = 0;
  otherLeaderChecks = 0;
}

async function cycle() {
  if (stopping) return;
  try {
    const lease = await readLease();
    lastLease = lease;

    if (child) {
      if (lease.valid && lease.holderId === instanceId) {
        otherLeaderChecks = 0;
        return;
      }
      if (lease.valid && lease.holderId && lease.holderId !== instanceId) {
        otherLeaderChecks += 1;
        if (otherLeaderChecks >= 2) await stopFullBrain(`leader=${lease.holderId}`);
      } else {
        otherLeaderChecks = 0;
      }
      return;
    }

    if (lease.valid) {
      candidateSince = 0;
      console.log(`[COLD] Standby idle. Leader=${lease.holderId}; lease valid.`);
      return;
    }

    if (!pool) return;
    if (!candidateSince) candidateSince = Date.now();
    const waited = (Date.now() - candidateSince) / 1000;
    if (waited >= startDelaySeconds) launchFullBrain();
    else console.log(`[COLD] No valid leader; waiting ${Math.ceil(startDelaySeconds - waited)}s failover delay.`);
  } catch (error) {
    candidateSince = 0;
    console.error('[COLD] Lease check failed; staying cold:', error?.message || error);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (child) {
    try { child.kill('SIGTERM'); } catch {}
    await sleep(1500);
  }
  try { healthServer.close(); } catch {}
  try { if (pool) await pool.end(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
console.log(`[COLD] CPU-safe standby active for ${instanceId}. Poll=${pollSeconds}s delay=${startDelaySeconds}s.`);
await cycle();
while (!stopping) {
  await sleep(pollSeconds * 1000);
  await cycle();
}
