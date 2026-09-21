import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveEvidenceGate } from '../adaptiveBrainV1064.js';

test('adaptive evidence gate blocks secondary-only support', () => {
  const r = adaptiveEvidenceGate({ secondary: 20, external: 10, history: 8 });
  assert.equal(r.allowed, false);
  assert.equal(r.primary, false);
});

test('adaptive evidence gate blocks primary-only support', () => {
  const r = adaptiveEvidenceGate({ momentum: 4 });
  assert.equal(r.allowed, false);
  assert.equal(r.primary, true);
  assert.equal(r.count, 1);
});

test('adaptive evidence gate allows primary plus independent support', () => {
  const r = adaptiveEvidenceGate({ momentum: 4, secondary: 5 });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.families, ['FUTGG_MARKET', 'SECONDARY']);
});

test('recovery counts as primary market confirmation', () => {
  const r = adaptiveEvidenceGate({ regime: 'RECOVERY', history: 3 });
  assert.equal(r.allowed, true);
});
