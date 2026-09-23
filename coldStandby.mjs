import pg from 'pg';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createHaCoordinator } from './haCoordinator.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[COLD] .env load warning:', error?.message || error);
  }
}

function repairLegacyBackslashPaths(root = process.cwd()) {
  let repaired = 0;
  for (const name of readdirSync(root)) {
    if (!name.includes('\\')) continue;
    const target = join(root, ...name.split('\\'));
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(root, name), target);
    repaired += 1;
  }
  return repaired;
}

const repairedLegacyPaths = repairLegacyBackslashPaths();
if (repairedLegacyPaths > 0) console.log(`[COLD] repaired ${repairedLegacyPaths} legacy flat path(s).`);

const { Pool } = pg;
const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) throw new Error('Cold standby requires DATABASE_URL');

const instanceId = String(process.env.FC_INSTANCE_ID || process.env.HOSTNAME || 'cold-standby').trim();
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
let brain = null;
let shuttingDown = false;
let handingOff = false;

const ha = createHaCoordinator({
  pool, enabled: true, instanceId,
  priority: Number(process.env.FC_HA_PRIORITY || 50),
  leaseSeconds: Number(process.env.FC_HA_LEASE_SECONDS || 75),
  heartbeatSeconds: Number(process.env.FC_HA_HEARTBEAT_SECONDS || 20),
  metadataProvider: () => ({ mode: 'COLD_STANDBY', fullBrainRunning: Boolean(brain) }),
  onPromote: async reason => {
    if (brain || shuttingDown || handingOff) return;
    handingOff = true;
    console.log('[COLD] lease acquired; handing ownership to full Brain:', reason);
    setImmediate(() => handoffToBrain(reason).catch(error => {
      console.error('[COLD] handoff failed:', error);
      handingOff = false;
      if (!shuttingDown) ha.start().catch(console.error);
    }));
  },
  onDemote: async reason => console.warn('[COLD] standby:', reason)
});

async function handoffToBrain(reason) {
  await ha.stop({ releaseLease: false });
  if (shuttingDown) return;
  brain = spawn(process.execPath, ['./v1069965LeakHotfixL7Bootstrap.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, FC_HA_ENABLED: 'true', FC_INSTANCE_ID: instanceId, FC_COLD_PROMOTED: 'true' }
  });
  console.log('[COLD] full Brain started after lease handoff:', reason, 'pid=', brain.pid);
  brain.once('exit', (code, signal) => {
    console.log('[COLD] full Brain exited', { code, signal });
    brain = null;
    handingOff = false;
    if (!shuttingDown) ha.start().catch(error => console.error('[COLD] HA restart failed:', error));
  });
}

await ha.start();
console.log('[COLD] coordinator started', ha.status());

const statusTimer = setInterval(() => {
  if (!brain) {
    const s = ha.status();
    console.log('[COLD]', s.state, 'leader=', s.leaderId, 'lease=', s.leaseRemainingSeconds);
  }
}, 30000);
statusTimer.unref?.();

// Keep the cold coordinator alive even if the promoted Brain exits and HA must restart.
const keepAliveTimer = setInterval(() => {}, 60000);

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(statusTimer);
  clearInterval(keepAliveTimer);
  if (brain) brain.kill('SIGTERM');
  await ha.stop({ releaseLease: !brain });
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
