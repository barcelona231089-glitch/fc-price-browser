import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['scripts/dev.mjs', '--production'], {
  cwd: root,
  env: { ...process.env, API_PORT: '6184', UI_PORT: '6183', HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk.toString()).slice(-4000); });
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch('http://127.0.0.1:6183/api/healthz', { signal: AbortSignal.timeout(1500) });
      if (response.status === 200 && (await response.json()).status === 'ok') { ready = true; break; }
    } catch { /* The two servers are still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(ready, 'Built project did not start successfully.\n' + log);
  const page = await fetch('http://127.0.0.1:6183/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script[^>]+src=/);
  const health = await fetch('http://127.0.0.1:6184/api/healthz');
  assert.equal(health.status, 200);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/startup.json'), JSON.stringify({
    passed: true, executedAt: new Date().toISOString(),
    checks: ['Built project starts both servers, serves the production UI and proxies /api to the backend'],
    uiHttpStatus: page.status, backendHttpStatus: health.status, mode: 'production',
  }, null, 2) + '\n');
  console.log('PASS Production starter, built UI, backend and /api proxy');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
}
