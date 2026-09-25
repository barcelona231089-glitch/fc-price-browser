import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cold = readFileSync(new URL('../coldStandby.mjs', import.meta.url), 'utf8');

test('cold standby pins both UV backend and v1066 loader to verified FUTBIN runtime revision', () => {
  assert.match(cold, /PINNED_RUNTIME_REVISION = '9c43310736e616d74869ce0a87d52bc831db6786'/);
  assert.match(cold, /path: 'uv\/uvApp\.js'/);
  assert.match(cold, /path: 'v1066Loader\.mjs'/);
  assert.match(cold, /enrichRowsWithSnapshotFutbinBrain/);
  assert.match(cold, /futbinOwnHistorySamples/);
  assert.match(cold, /await ensurePinnedRuntimeFile\(spec\)/);
});
