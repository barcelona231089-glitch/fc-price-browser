import express from 'express';
import { uvRouter, initUvBrain, shutdownUvBrain, getUvRuntimeStatus } from './uv/uvApp.js';

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[UV-STANDALONE] .env load warning:', error?.message || error);
  }
}

const app = express();
const port = Number(process.env.PORT || 3000);

app.get('/healthz', (req, res) => {
  const status = getUvRuntimeStatus();
  res.status(status?.ok ? 200 : 503).json({
    ok: Boolean(status?.ok),
    service: 'fc-uv-app',
    role: 'UV_ONLY',
    version: status?.version || null,
    gameYear: status?.gameYear || null,
    runtimeMode: status?.runtimeMode || null
  });
});

app.use(uvRouter);
app.get('/', (req, res) => res.redirect('/uv'));

let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[UV-STANDALONE] shutdown:', signal);
  try { await shutdownUvBrain(); } catch (error) { console.error('[UV-STANDALONE] UV shutdown error:', error); }
  if (server) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
process.once('SIGINT', () => shutdown('SIGINT').catch(console.error));

// Open the HTTP port first so constrained/free hosts can complete their health probe.
// UV initialization continues immediately afterwards; /healthz reports readiness.
server = app.listen(port, '0.0.0.0', () => {
  console.log('[UV-STANDALONE] port-open', { port, host: '0.0.0.0', role: 'UV_ONLY' });
});

try {
  await initUvBrain({ active: true });
} catch (error) {
  console.error('[UV-STANDALONE] init failed:', error?.stack || error?.message || error);
}

if (server) {
  const status = getUvRuntimeStatus();
  console.log('[UV-STANDALONE] listening', {
    port,
    role: 'UV_ONLY',
    version: status?.version,
    gameYear: status?.gameYear,
    runtimeMode: status?.runtimeMode
  });
}
