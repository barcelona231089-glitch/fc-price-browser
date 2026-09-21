import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = readFileSync(new URL('../uv/src/db.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../uv/uvApp.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../uv/public/app.js', import.meta.url), 'utf8');

test('v2.12 trade journal persists non-terminal trade states separately from outcome learning', () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS uv_trade_journal/);
  assert.match(db, /recordTradeJournalEvent/);
  assert.match(app, /\/api\/uv\/journal/);
  assert.match(ui, /data-journal="bought"/);
  assert.match(ui, /data-journal="listed"/);
  assert.match(ui, /data-journal="relisted"/);
  assert.match(ui, /data-journal="skipped"/);
});

test('terminal outcome learning remains limited to sold unsold expired', () => {
  assert.match(db, /f\.outcome IN \('sold','unsold','expired'\)/);
});
