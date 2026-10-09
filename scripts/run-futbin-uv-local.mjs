// Independent local-only FUTBIN console UI. No Trader Brain init or market crawlers.
import express from 'express';
import { uvRouter } from '../uv/uvApp.js';
const port = Number(process.env.FUTBIN_UV_PORT || 5187);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
  throw new Error('FUTBIN_UV_PORT muss ein gültiger lokaler Port sein.');
}
const app = express();
app.get('/', (_req, res) => res.redirect('/uv/'));
app.use(uvRouter);
app.listen(port, '127.0.0.1', () => {
  console.log(`FUTBIN FC27 Konsole läuft lokal: http://127.0.0.1:${port}/uv/`);
  console.log('Keine externen Quellen, keine Trader-Startprozesse, keine Käufe.');
});
