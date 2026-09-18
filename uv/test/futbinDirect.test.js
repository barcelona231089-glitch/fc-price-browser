import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchDirectFutbinPrices,
  getDirectFutbinCards,
  getFutbinDirectStatus,
  isDirectFutbinEnabled,
  resetFutbinDirectCachesForTests,
  resolveDirectFutbinIds
} from '../src/futbinDirect.js';

function lookmanRow(price = 10000) {
  return {
    ID: 778,
    Player_Resource: 230899,
    Player_ID: 230899,
    Player_Fullname: 'Ademola Lookman',
    LCPrice: price,
    checked: '2026-09-18 01:24:03'
  };
}

function fakeFetcher(handler) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return { fetcher, calls };
}
test('direct FUTBIN stays disabled unless explicitly enabled', () => {
  assert.equal(isDirectFutbinEnabled({ enabled: false, gameYear: 27 }), false);
});

test('direct FUTBIN is hard-gated to confirmed FC27', () => {
  assert.equal(isDirectFutbinEnabled({ enabled: true, gameYear: 26 }), false);
  assert.equal(isDirectFutbinEnabled({ enabled: true, gameYear: 27 }), true);
});

test('unknown EA resource id maps to FUTBIN id from getFilteredPlayers when discovery is explicitly available', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(url => {
    assert.match(url, /getFilteredPlayers/);
    return { data: [{ ID: 1778, resource_id: 990230899, rating: 83 }], errorcode: '200' };
  });
  const r = await resolveDirectFutbinIds([{ eaId: 990230899, overall: 83 }], 'console', {
    enabled: true, gameYear: 27, fetcher
  });
  assert.equal(r.resolved.get('990230899'), 1778);
  assert.equal(r.missing.length, 0);
  assert.equal(calls.length, 1);
});

test('mapping cache avoids a second rating request', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(() => ({ data: [{ ID: 1778, resource_id: 990230899, rating: 83 }] }));
  const card = [{ eaId: 990230899, overall: 83 }];
  await resolveDirectFutbinIds(card, 'console', { enabled: true, gameYear: 27, fetcher });
  await resolveDirectFutbinIds(card, 'console', { enabled: true, gameYear: 27, fetcher });
  assert.equal(calls.length, 1);
});
test('direct price response uses ID, Player_Resource and LCPrice', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher } = fakeFetcher((url, options) => {
    assert.match(url, /getPlayersPrice/);
    assert.equal(options.headers?.['user-agent'], 'Mozilla/5.0');
    assert.equal(options.headers?.referer, 'https://www.futbin.com/');
    return { data: [lookmanRow(10000)], errorcode: '200', errormsg: 'SUCCESS' };
  });
  const r = await fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher });
  const row = r.prices.get('778');
  assert.equal(row.id, 778);
  assert.equal(row.eaId, 230899);
  assert.equal(row.price, 10000);
  assert.equal(row.name, 'Ademola Lookman');
});

test('LCPrice zero is missing, never a synthetic zero price', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher } = fakeFetcher(() => ({ data: [lookmanRow(0)], errorcode: '200' }));
  const r = await fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher });
  assert.equal(r.prices.get('778').price, null);
});

test('direct price batching never sends more than 11 FUTBIN ids', async () => {
  resetFutbinDirectCachesForTests();
  const seenBatchSizes = [];
  const { fetcher, calls } = fakeFetcher(url => {
    const ids = new URL(url).searchParams.get('player_ids').split(',').map(Number);
    seenBatchSizes.push(ids.length);
    return { data: ids.map(id => ({ ID: id, Player_Resource: 500000 + id, LCPrice: 1000 + id })) };
  });
  const ids = Array.from({ length: 23 }, (_, i) => i + 1);
  const r = await fetchDirectFutbinPrices(ids, 'console', { enabled: true, gameYear: 27, fetcher });
  assert.equal(r.prices.size, 23);
  assert.deepEqual(seenBatchSizes, [11, 11, 1]);
  assert.equal(calls.length, 3);
});
test('price cache serves repeated reads without repeated HTTP', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(() => ({ data: [lookmanRow(10000)] }));
  for (let i = 0; i < 1000; i++) {
    const r = await fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher });
    assert.equal(r.prices.get('778').price, 10000);
  }
  assert.equal(calls.length, 1);
});

test('supplied FUTBIN id bypasses automatic mapping request', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(url => {
    assert.match(url, /getPlayersPrice/);
    return { data: [lookmanRow(10000)] };
  });
  const r = await getDirectFutbinCards([
    { eaId: 230899, futbinId: 778, overall: 83, name: 'Ademola Lookman' }
  ], 'console', { enabled: true, gameYear: 27, fetcher });
  assert.equal(r.results.get('230899').id, 778);
  assert.equal(r.results.get('230899').price, 10000);
  assert.equal(calls.length, 1);
});

test('combined direct adapter maps an unknown EA id then batches real price', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(url => {
    if (url.includes('getFilteredPlayers')) return { data: [{ ID: 1778, resource_id: 990230899, rating: 83 }] };
    if (url.includes('getPlayersPrice')) return { data: [{ ID: 1778, Player_Resource: 990230899, Player_ID: 990230899, Player_Fullname: 'Test Player', LCPrice: 10000 }] };
    throw new Error('unexpected url');
  });
  const r = await getDirectFutbinCards([
    { eaId: 990230899, overall: 83, name: 'Test Player', cardType: 'Base Rare', position: 'ST' }
  ], 'console', { enabled: true, gameYear: 27, fetcher });
  const row = r.results.get('990230899');
  assert.equal(row.ok, true);
  assert.equal(row.id, 1778);
  assert.equal(row.price, 10000);
  assert.equal(row.source, 'FUTBIN_DIRECT_FC27');
  assert.equal(calls.length, 2);
});
test('failed direct request is counted and remains an error', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher } = fakeFetcher(() => { throw new Error('HTTP 403'); });
  await assert.rejects(
    fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher }),
    /HTTP 403/
  );
  const status = getFutbinDirectStatus();
  assert.equal(status.failures, 1);
  assert.match(status.lastError, /HTTP 403/);
});

test('confirmed Lookman FC27 map resolves EA resource 230899 to FUTBIN 778 without discovery HTTP', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(() => { throw new Error('should not fetch'); });
  const r = await resolveDirectFutbinIds([{ eaId: 230899, overall: 83 }], 'console', {
    enabled: true, gameYear: 27, discoveryEnabled: false, fetcher
  });
  assert.equal(r.resolved.get('230899'), 778);
  assert.equal(r.missing.length, 0);
  assert.equal(calls.length, 0);
});

test('unknown FC27 id fails closed when production discovery is disabled', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(() => { throw new Error('should not fetch'); });
  const r = await resolveDirectFutbinIds([{ eaId: 999999999, overall: 84 }], 'console', {
    enabled: true, gameYear: 27, discoveryEnabled: false, fetcher
  });
  assert.equal(r.resolved.size, 0);
  assert.deepEqual(r.missing, [999999999]);
  assert.equal(calls.length, 0);
});
test('HTTP 403 activates one-hour style backoff and suppresses repeat HTTP', async () => {
  resetFutbinDirectCachesForTests();
  const { fetcher, calls } = fakeFetcher(() => { throw new Error('HTTP 403'); });
  await assert.rejects(
    fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher }),
    /HTTP 403/
  );
  const first = getFutbinDirectStatus();
  assert.equal(first.lastBlocked, true);
  assert.equal(first.backoffActive, true);
  assert.ok(first.lastBackoffMs >= 60 * 60_000);

  await assert.rejects(
    fetchDirectFutbinPrices([778], 'console', { enabled: true, gameYear: 27, fetcher }),
    /backoff until/
  );
  assert.equal(calls.length, 1);
});
