import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const apiDir = path.join(root, 'artifacts/api-server');
const uiDir = path.join(root, 'artifacts/api-traffic-finder');
const processes = new Set();
function run(script, args, cwd, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  processes.add(child);
  child.once('exit', () => processes.delete(child));
  return child;
}
const built = run(path.join(apiDir, 'build.mjs'), [], apiDir, {});
await new Promise((resolve, reject) => {
  built.once('error', reject);
  built.once('exit', code => code === 0 ? resolve() : reject(new Error('Backend-Build fehlgeschlagen.')));
});
const apiPort = process.env.API_PORT ?? '5174';
const uiPort = process.env.UI_PORT ?? process.env.PORT ?? '5173';
const host = process.env.HOST ?? (production || process.env.REPL_ID ? '0.0.0.0' : '127.0.0.1');
const api = run(path.join(apiDir, 'dist/index.mjs'), [], apiDir, { PORT: apiPort, HOST: host, NODE_ENV: production ? 'production' : 'development' });
const ui = run(path.join(uiDir, 'node_modules/vite/bin/vite.js'), [production ? 'preview' : '--config', ...(production ? [] : ['vite.config.ts']), '--host', host, '--port', uiPort, ...(process.argv.includes('--open') ? ['--open'] : [])], uiDir, { PORT: uiPort, BASE_PATH: process.env.BASE_PATH ?? '/', API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, NODE_ENV: production ? 'production' : 'development' });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}
for (const child of [api, ui]) {
  child.once('error', () => stop(1));
  child.once('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(`API Traffic Finder: http://localhost:${process.env.UI_PORT ?? '5173'} — zum Beenden Strg+C.`);
