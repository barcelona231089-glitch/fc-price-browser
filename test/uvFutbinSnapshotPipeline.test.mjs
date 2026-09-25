import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const uv = readFileSync(new URL('../uv/uvApp.js', import.meta.url), 'utf8');

test('UV attaches current-season platform snapshot evidence before final scoring', () => {
  assert.match(uv, /enrichRowsWithSnapshotFutbinBrain/);
  assert.match(uv, /gameYear: GAME_YEAR, platform/);
  const snapshot = uv.indexOf('await enrichRowsWithSnapshotFutbinBrain(scored');
  const crosscheck = uv.indexOf('scored = await crosscheckFutbin(scored', snapshot);
  const finalScore = uv.indexOf('scored = await generationCpuSafeMap(scored', crosscheck);
  assert.ok(snapshot >= 0 && crosscheck > snapshot && finalScore > crosscheck);
});
