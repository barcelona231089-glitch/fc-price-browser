import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const uv = readFileSync(new URL('../uv/uvApp.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../uv/public/app.js', import.meta.url), 'utf8');

test('UV 2.15.3 keeps async generate jobs process-wide and avoids self-HTTP', () => {
  assert.match(uv, /const UV_VERSION = '2\.15\.3'/);
  assert.match(uv, /app\.post\('\/api\/uv\/generate-job'/);
  assert.match(uv, /app\.get\('\/api\/uv\/generate-job\/:jobId'/);
  assert.match(uv, /Symbol\.for\('fc-trader-brain\.uv-generation-runtime\.v1'\)/);
  assert.match(uv, /invokeGenerateRouteInternal\(payload\)/);
  assert.doesNotMatch(uv, /127\.0\.0\.1:\$\{internalPort\}\/api\/uv\/generate/);
  assert.match(uv, /app\.post\('\/api\/uv\/generate'/);
  assert.match(uv, /GENERATION_JOB_BUSY/);
});

test('UV frontend polls generate job instead of holding one long HTTP request open', () => {
  assert.match(app, /startGenerateJob\(\{budget,platform,saveList\}\)/);
  assert.match(app, /waitForGenerateJob\(started\.jobId\)/);
  assert.match(app, /\/api\/uv\/generate-job/);
  assert.doesNotMatch(app, /fetch\('\/api\/uv\/generate',/);
});
