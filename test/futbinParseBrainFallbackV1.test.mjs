import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichImportantRowsWithParseFutbinBrain,
  getParseFutbinBrainFallbackStatus,
  resetParseFutbinBrainFallbackForTests
} from '../futbinParseBrainFallbackV1.js';

test('Parse 429 records provider reason and honors Retry-After', async () => {
  resetParseFutbinBrainFallbackForTests();
  const rows = [{ eaId: 20801, name: 'Mapped Test Card', overall: 84, price: 10000, tracked: true, cardType: 'Base Rare' }];
  const fetcher = async () => ({
    ok: false,
    status: 429,
    headers: { get: name => name.toLowerCase() === 'retry-after' ? '120' : null },
    text: async () => JSON.stringify({ code: 'rate_limit', message: 'Too many requests' })
  });
  await enrichImportantRowsWithParseFutbinBrain(rows, new Map(), { gameYear: 27, apiKey: 'test', fetcher });
  const status = getParseFutbinBrainFallbackStatus({ apiKey: 'test' });
  assert.equal(status.lastHttpStatus, 429);
  assert.equal(status.lastRetryAfterSeconds, 120);
  assert.equal(status.lastProviderCode, 'rate_limit');
  assert.equal(status.lastProviderMessage, 'Too many requests');
  assert.equal(status.circuitReason, 'RATE_LIMITED');
  assert.ok(Date.parse(status.disabledUntil) > Date.now());
});