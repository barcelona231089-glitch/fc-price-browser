import pg from 'pg';
import { spawn } from 'node:child_process';
import { createHaCoordinator } from './haCoordinator.js';

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('Cold standby requires DATABASE_URL');

const instanceId = String(process.env.FC_INSTANCE_ID || process.env.HOSTNAME || 'cold-standby').trim();
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
let brain = null;
let shuttingDown = false;

function startBrain(reason) {
  if (brain || shuttingDown) return;
  console.log('[COLD] LEADER acquired; starting full Brain:', reason);
  brain = spawn(process.execPath, ['./v1069965LeakHotfixL7Bootstrap.mjs'], {
    stdio: 'inherit', env: { ...process.env, FC_COLD_PROMOTED: 'true' }
  });
  brain.once('exit', (code, signal) => {
    console.log('[COLD] full Brain exited', { code, signal });
    brain = null;
  });
}

async function stopBrain(reason) {
  if (!brain) return;
  console.warn('[COLD] leadership lost; stopping full Brain:', reason);
  brain.kill('SIGTERM');
  brain = null;
}

const ha = createHaCoordinator({
  pool, enabled: true, instanceId,
  priority: Number(process.env.FC_HA_PRIORITY || 50),
  leaseSeconds: Number(process.env.FC_HA_LEASE_SECONDS || 75),
  heartbeatSeconds: Number(process.env.FC_HA_HEARTBEAT_SECONDS || 20),
  onPromote: startBrain, onDemote: stopBrain,
  metadataProvider: () => ({ mode: 'COLD_STANDBY', fullBrainRunning: Boolean(brain) })
});

await ha.start();
console.log('[COLD] coordinator started', ha.status());

const statusTimer = setInterval(() => {
  const s = ha.status();
  console.log('[COLD]', s.state, 'leader=', s.leaderId, 'lease=', s.leaseRemainingSeconds, 'brain=', Boolean(brain));
}, 30000);
statusTimer.unref?.();

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[COLD] shutdown', signal);
  clearInterval(statusTimer);
  await stopBrain(signal);
  await ha.stop({ releaseLease: true });
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Keep the cold coordinator alive while its timers/workers remain unref'ed.
await new Promise(() => {});
