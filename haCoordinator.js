const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

export function createHaCoordinator({
  pool,
  enabled = true,
  lockName = 'fc-trader-brain-active',
  instanceId,
  priority = 100,
  leaseSeconds = 75,
  heartbeatSeconds = 20,
  onPromote = async () => {},
  onDemote = async () => {},
  metadataProvider = () => ({}),
  logger = console,
  now = () => Date.now()
} = {}) {
  const id = String(instanceId || '').trim();
  if (enabled && !pool) throw new Error('HA requires a PostgreSQL pool');
  if (enabled && !id) throw new Error('HA requires a stable instanceId');

  const leaseSec = clamp(leaseSeconds, 30, 300);
  const heartbeatSec = clamp(heartbeatSeconds, 5, Math.max(5, leaseSec - 10));
  const prio = Math.round(clamp(priority, 1, 1000));

  let timer = null;
  let tickBusy = false;
  let started = false;
  let leader = enabled ? false : true;
  let leaderId = enabled ? null : id || 'single-instance';
  let leaderPriority = enabled ? null : prio;
  let leaseUntil = enabled ? null : null;
  let acquiredAt = null;
  let heartbeatAt = null;
  let lastDbOkAt = null;
  let lastTickAt = null;
  let lastError = null;
  let transitionAt = null;

  const safeMetadata = () => {
    try {
      const value = metadataProvider?.() || {};
      return JSON.stringify(value);
    } catch {
      return '{}';
    }
  };

  async function ensureTable() {
    if (!enabled) return;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fc_runtime_leader (
        lock_name VARCHAR(120) PRIMARY KEY,
        holder_id VARCHAR(180) NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        lease_until TIMESTAMPTZ NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_fc_runtime_leader_lease
      ON fc_runtime_leader (lease_until)
    `);
  }

  function applyRow(row) {
    if (!row) return;
    leaderId = row.holder_id || null;
    leaderPriority = Number.isFinite(Number(row.priority)) ? Number(row.priority) : null;
    leaseUntil = row.lease_until ? new Date(row.lease_until).toISOString() : null;
    acquiredAt = row.acquired_at ? new Date(row.acquired_at).toISOString() : acquiredAt;
    heartbeatAt = row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : heartbeatAt;
  }

  async function setLeader(next, reason) {
    if (leader === next) return;
    leader = next;
    transitionAt = new Date(now()).toISOString();
    if (next) {
      logger.log?.(`[HA] LEADER acquired by ${id} (${reason}). Lease ${leaseSec}s / heartbeat ${heartbeatSec}s.`);
      await onPromote?.(reason);
    } else {
      logger.warn?.(`[HA] STANDBY on ${id} (${reason}). Current leader: ${leaderId || 'unknown'}.`);
      await onDemote?.(reason);
    }
  }

  function localLeaseStillValid() {
    if (!leader || !leaseUntil) return false;
    const until = Date.parse(leaseUntil);
    return Number.isFinite(until) && now() < until - 2_000;
  }

  async function tick() {
    if (!enabled || tickBusy) return status();
    tickBusy = true;
    lastTickAt = new Date(now()).toISOString();
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
      `, [lockName, id, prio, leaseSec, safeMetadata()]);

      lastDbOkAt = new Date(now()).toISOString();
      lastError = null;

      if (result.rows?.length) {
        applyRow(result.rows[0]);
        await setLeader(true, leader ? 'lease-renewed' : 'lease-acquired');
        return status();
      }

      const current = await pool.query(`
        SELECT holder_id, priority, lease_until, acquired_at, heartbeat_at, metadata
        FROM fc_runtime_leader
        WHERE lock_name = $1
        LIMIT 1
      `, [lockName]);
      lastDbOkAt = new Date(now()).toISOString();
      if (current.rows?.[0]) applyRow(current.rows[0]);
      await setLeader(false, 'lease-held-by-other-instance');
      return status();
    } catch (error) {
      lastError = String(error?.message || error);
      logger.error?.('[HA] lease heartbeat error:', error);
      if (leader && !localLeaseStillValid()) {
        await setLeader(false, 'lease-expired-after-db-error');
      }
      return status();
    } finally {
      tickBusy = false;
    }
  }

  async function start() {
    if (started) return status();
    started = true;
    if (!enabled) return status();
    try {
      await ensureTable();
      lastDbOkAt = new Date(now()).toISOString();
      lastError = null;
    } catch (error) {
      lastError = String(error?.message || error);
      logger.error?.('[HA] init error:', error);
    }
    await tick();
    timer = setInterval(() => {
      tick().catch(error => logger.error?.('[HA] tick error:', error));
    }, heartbeatSec * 1000);
    timer.unref?.();
    return status();
  }

  async function release() {
    if (!enabled || !pool || !id) return;
    try {
      await pool.query(`
        UPDATE fc_runtime_leader
        SET lease_until = NOW(), heartbeat_at = NOW()
        WHERE lock_name = $1 AND holder_id = $2
      `, [lockName, id]);
      lastDbOkAt = new Date(now()).toISOString();
    } catch (error) {
      lastError = String(error?.message || error);
      logger.error?.('[HA] release error:', error);
    }
    if (leader) {
      leaseUntil = new Date(now()).toISOString();
      await setLeader(false, 'lease-released');
    }
  }

  async function stop({ releaseLease = true } = {}) {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    if (releaseLease) await release();
  }

  function isLeader() {
    if (!enabled) return true;
    return leader && localLeaseStillValid();
  }

  function status() {
    const untilMs = leaseUntil ? Date.parse(leaseUntil) : NaN;
    return {
      enabled,
      state: !enabled ? 'SINGLE' : isLeader() ? 'LEADER' : 'STANDBY',
      instanceId: id || null,
      lockName,
      priority: prio,
      leaderId,
      leaderPriority,
      leaseSeconds: leaseSec,
      heartbeatSeconds: heartbeatSec,
      leaseUntil,
      leaseRemainingSeconds: Number.isFinite(untilMs) ? Math.max(0, Math.round((untilMs - now()) / 1000)) : null,
      acquiredAt,
      heartbeatAt,
      lastDbOkAt,
      lastTickAt,
      transitionAt,
      lastError,
      started,
      writeActive: isLeader()
    };
  }

  return { start, stop, tick, release, isLeader, status };
}
