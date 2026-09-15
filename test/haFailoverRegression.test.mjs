import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaCoordinator } from '../haCoordinator.js';

process.env.FC_HA_DEDICATED_HEARTBEAT = 'false';

function fakeLeasePool(now) {
  let row = null;
  return {
    async query(sql, params = []) {
      if (/CREATE TABLE|CREATE INDEX/i.test(sql)) return { rows: [] };
      if (/INSERT INTO fc_runtime_leader/i.test(sql)) {
        const [lock, holder, priority, leaseSeconds] = params;
        const canOwn = !row || row.lock_name !== lock || row.holder_id === holder || Date.parse(row.lease_until) <= now();
        if (!canOwn) return { rows: [] };
        const same = row?.holder_id === holder;
        row = { lock_name: lock, holder_id: holder, priority, lease_until: new Date(now()+leaseSeconds*1000).toISOString(), acquired_at: same ? row.acquired_at : new Date(now()).toISOString(), heartbeat_at: new Date(now()).toISOString(), metadata: {} };
        return { rows: [{ ...row }] };
      }
      if (/SELECT holder_id/i.test(sql)) return { rows: row ? [{ ...row }] : [] };
      if (/UPDATE fc_runtime_leader/i.test(sql)) {
        if (row && row.holder_id === params[1]) row = { ...row, lease_until: new Date(now()).toISOString(), heartbeat_at: new Date(now()).toISOString() };
        return { rows: [] };
      }
      throw new Error('Unexpected SQL in fake HA pool');
    }
  };
}
test('HA fails over without preemption and fails back cleanly', async () => {
  let nowMs = Date.parse('2026-09-15T20:00:00Z');
  const pool = fakeLeasePool(() => nowMs);
  const events = [];
  const a = createHaCoordinator({ pool, instanceId: 'primary', leaseSeconds: 75, heartbeatSeconds: 20, now: () => nowMs, onPromote: async r => events.push(`A+${r}`), onDemote: async r => events.push(`A-${r}`) });
  const b = createHaCoordinator({ pool, instanceId: 'backup', leaseSeconds: 75, heartbeatSeconds: 20, now: () => nowMs, onPromote: async r => events.push(`B+${r}`), onDemote: async r => events.push(`B-${r}`) });

  await a.start();
  await b.start();
  assert.equal(a.status().state, 'LEADER');
  assert.equal(b.status().state, 'STANDBY');
  assert.equal(a.status().writeActive, true);
  assert.equal(b.status().writeActive, false);

  await a.stop({ releaseLease: true });
  await b.tick();
  assert.equal(b.status().state, 'LEADER');
  assert.equal(b.status().writeActive, true);

  await a.start();
  assert.equal(a.status().state, 'STANDBY');
  assert.equal(a.status().leaderId, 'backup');

  await b.stop({ releaseLease: true });
  await a.tick();
  assert.equal(a.status().state, 'LEADER');
  assert.equal(a.status().writeActive, true);
  assert.ok(events.some(x => x.startsWith('B+')));
  await a.stop({ releaseLease: true });
});
