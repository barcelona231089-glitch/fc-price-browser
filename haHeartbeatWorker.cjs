const { parentPort, workerData } = require('node:worker_threads');
const pg = require('pg');

const { Pool } = pg;

const {
  lockName,
  instanceId,
  priority,
  leaseSeconds,
  heartbeatSeconds,
  metadataJson = '{}'
} = workerData || {};

const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!parentPort) {
  throw new Error('HA heartbeat worker requires parentPort');
}
if (!databaseUrl) {
  parentPort.postMessage({ type: 'fatal', error: 'DATABASE_URL is not configured' });
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 10_000
});

let metadata = metadataJson;
let busy = false;
let stopping = false;
let timer = null;

function post(message) {
  try {
    parentPort.postMessage(message);
  } catch {}
}

async function beat() {
  if (stopping || busy) return;
  busy = true;
  try {
    const result = await pool.query(`
      INSERT INTO fc_runtime_leader
        (lock_name, holder_id, priority, lease_until, acquired_at, heartbeat_at, metadata)
      VALUES
        ($1, $2, $3, NOW() + ($4 * INTERVAL '1 second'), NOW(), NOW(), $5::jsonb)
      ON CONFLICT (lock_name) DO UPDATE SET
        holder_id = EXCLUDED.holder_id,
        priority = EXCLUDED.priority,
        lease_until = EXCLUDED.lease_until,
        acquired_at = CASE
          WHEN fc_runtime_leader.holder_id = EXCLUDED.holder_id THEN fc_runtime_leader.acquired_at
          ELSE NOW()
        END,
        heartbeat_at = NOW(),
        metadata = EXCLUDED.metadata
      WHERE
        fc_runtime_leader.holder_id = EXCLUDED.holder_id
        OR fc_runtime_leader.lease_until <= NOW()
      RETURNING holder_id, priority, lease_until, acquired_at, heartbeat_at, metadata
    `, [lockName, instanceId, priority, leaseSeconds, metadata]);

    if (result.rows?.length) {
      post({
        type: 'heartbeat',
        ok: true,
        owned: true,
        row: result.rows[0],
        at: new Date().toISOString()
      });
      return;
    }

    const current = await pool.query(`
      SELECT holder_id, priority, lease_until, acquired_at, heartbeat_at, metadata
      FROM fc_runtime_leader
      WHERE lock_name = $1
      LIMIT 1
    `, [lockName]);

    post({
      type: 'heartbeat',
      ok: true,
      owned: false,
      row: current.rows?.[0] || null,
      at: new Date().toISOString()
    });
  } catch (error) {
    post({
      type: 'heartbeat',
      ok: false,
      error: String(error?.message || error),
      at: new Date().toISOString()
    });
  } finally {
    busy = false;
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  try {
    await pool.end();
  } catch {}
  process.exit(0);
}

parentPort.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'metadata') {
    metadata = String(message.metadataJson || '{}');
  } else if (message.type === 'beat-now') {
    beat().catch(() => {});
  } else if (message.type === 'stop') {
    shutdown().catch(() => process.exit(0));
  }
});

parentPort.on('close', () => {
  shutdown().catch(() => process.exit(0));
});

post({ type: 'ready', at: new Date().toISOString() });
beat().catch(() => {});
timer = setInterval(() => {
  beat().catch(() => {});
}, Math.max(5, Number(heartbeatSeconds) || 20) * 1000);
timer.unref?.();
