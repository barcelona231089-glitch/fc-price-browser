// Strictly isolated FUTBIN-only console service. No legacy trading engine is imported.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFutbinConsoleRouter } from '../uv/src/futbinConsoleApi.js';

const port = Number(process.env.FUTBIN_UV_PORT || 5187);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('FUTBIN_UV_PORT muss ein gültiger Port sein.');
}
const app = express();
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../uv/public');
app.get('/', (_req, res) => res.redirect('/uv/'));
app.use(createFutbinConsoleRouter());
app.use('/uv', express.static(publicDir));
app.get('/uv', (_req, res) => res.sendFile(path.join(publicDir,'index.html')));
app.get('/uv/*', (_req, res) => res.sendFile(path.join(publicDir,'index.html')));
app.listen(port, '127.0.0.1', () => {
  console.log('FC27 FUTBIN-Konsole: http://127.0.0.1:' + port + '/uv/');
  console.log('API: /api/uv/futbin-console/players | Quelle: sichtbare FUTBIN-Browserdaten.');
  console.log('Keine FUT.GG-Abfragen, kein Daten-Fallback und keine automatisierten FUTBIN-Webrequests.');
});
