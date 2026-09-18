import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFutbinParseBackoffForTests,
  getFutbinParseBackoffStatus,
  resetFutbinParseBackoffForTests,
  searchFutbinCard
} from '../src/futbin.js';

test('Parse HTTP 429 honors retry_after and activates global backoff', () => {
  resetFutbinParseBackoffForTests();
  const applied = applyFutbinParseBackoffForTests(new Error('HTTP 429: {"error":"Daily limit exceeded","retry_after":3600}'));
  assert.equal(applied, true);
  const s = getFutbinParseBackoffStatus();
  assert.equal(s.active, true);
  assert.equal(s.reason, 'RATE_LIMITED');
  assert.equal(s.retryAfterSeconds, 3600);
  assert.ok(s.until);
  resetFutbinParseBackoffForTests();
});

test('non-rate-limit error does not activate Parse backoff', () => {
  resetFutbinParseBackoffForTests();
  assert.equal(applyFutbinParseBackoffForTests(new Error('HTTP 500')), false);
  assert.equal(getFutbinParseBackoffStatus().active, false);
});

test('Parse card lookup fails closed during active rate-limit backoff without HTTP', async () => {
  resetFutbinParseBackoffForTests();
  const previousKey = process.env.FUTBIN_PARSE_API_KEY;
  process.env.FUTBIN_PARSE_API_KEY = 'test-only';
  applyFutbinParseBackoffForTests(new Error('HTTP 429: {"retry_after":120}'));
  try {
    const result = await searchFutbinCard({ name: 'Backoff Test', overall: 83, cardType: 'Base Rare' }, 'console');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'FUTBIN_PARSE_RATE_LIMIT_BACKOFF');
  } finally {
    if (previousKey === undefined) delete process.env.FUTBIN_PARSE_API_KEY;
    else process.env.FUTBIN_PARSE_API_KEY = previousKey;
    resetFutbinParseBackoffForTests();
  }
});
