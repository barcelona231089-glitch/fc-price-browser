import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeObservedFutbinEvidence } from '../src/futbin.js';
import { buildCandidatePool } from '../src/uvEngine.js';
import { resolve as loaderResolve } from '../../v1066Loader.mjs';

test('standalone FUTBIN merge preserves collector Games, Listings and Sold evidence', () => {
  const card = {
    futbinGamesPlayed: 40271,
    futbinGamesCount: 40271,
    futbinSalesRowCount: 500,
    futbinListedSampleCount: 500,
    futbinSoldSampleCount: 499,
    futbinUnsoldSampleCount: 1,
    futbinSoldPriceP25: 750,
    futbinSoldPriceMedian: 800,
    futbinSoldPriceMode: 800,
    futbinSoldPriceP75: 800,
    futbinSoldPriceMin: 650,
    futbinSoldPriceMax: 800,
    futbinSalesEvidenceScore: 88.6
  };

  const merged = mergeObservedFutbinEvidence(card, {
    gamesAvailable: false,
    salesHistoryAvailable: false,
    futbinGamesCount: null,
    futbinSalesRowCount: 0,
    futbinListedSampleCount: 0,
    futbinSoldSampleCount: 0,
    futbinSoldPriceMedian: null
  });

  assert.equal(merged.gamesAvailable, true);
  assert.equal(merged.futbinGamesCount, 40271);
  assert.equal(merged.salesHistoryAvailable, true);
  assert.equal(merged.futbinSalesRowCount, 500);
  assert.equal(merged.futbinListedSampleCount, 500);
  assert.equal(merged.futbinSoldSampleCount, 499);
  assert.equal(merged.futbinSoldPriceMedian, 800);
  assert.equal(merged.futbinSoldPriceP25, 750);
  assert.equal(merged.futbinSoldPriceP75, 800);
});

test('standalone FUTBIN merge accepts newer real evidence when it is actually available', () => {
  const merged = mergeObservedFutbinEvidence(
    {
      futbinGamesPlayed: 1000,
      futbinListedSampleCount: 10,
      futbinSoldSampleCount: 5,
      futbinSoldPriceMedian: 1000
    },
    {
      gamesAvailable: true,
      futbinGamesCount: 2000,
      salesHistoryAvailable: true,
      futbinSalesRowCount: 50,
      futbinListedSampleCount: 50,
      futbinSoldSampleCount: 40,
      futbinSoldPriceMedian: 1100,
      futbinSoldPriceP25: 1050,
      futbinSoldPriceP75: 1150
    }
  );

  assert.equal(merged.futbinGamesCount, 2000);
  assert.equal(merged.futbinListedSampleCount, 50);
  assert.equal(merged.futbinSoldSampleCount, 40);
  assert.equal(merged.futbinSoldPriceMedian, 1100);
});

test('standalone runtime bypasses legacy UV loader patches through a propagated graph marker', async () => {
  const loader = readFileSync(new URL('../../v1066Loader.mjs', import.meta.url), 'utf8');
  assert.match(loader, /export async function resolve\(specifier, context, nextResolve\)/);
  assert.match(loader, /searchParams\.set\('uv-standalone', '1'\)/);
  assert.match(loader, /standaloneTagged/);

  const root = await loaderResolve('./uv/uvApp.js', {
    parentURL: 'file:///app/uvStandalone.mjs'
  }, async () => ({ url: 'file:///app/uv/uvApp.js', format: 'module' }));
  assert.match(root.url, /uv-standalone=1/);

  const child = await loaderResolve('./src/futbin.js', {
    parentURL: root.url
  }, async () => ({ url: 'file:///app/uv/src/futbin.js', format: 'module' }));
  assert.match(child.url, /uv-standalone=1/);

  const dependency = await loaderResolve('express', {
    parentURL: 'file:///app/uvStandalone.mjs'
  }, async () => ({ url: 'file:///app/node_modules/express/index.js', format: 'commonjs' }));
  assert.doesNotMatch(dependency.url, /uv-standalone/);
});

test('standalone frontend has no legacy generate fetch interceptor', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /generate-async-v2105\.js/);
  assert.doesNotMatch(html, /unsaved-live-v2108\.js/);
  assert.match(html, /app\.js\?v=2\.15\.22/);
});


test('100k thin FUTBIN pool keeps real affordable cards instead of filtering everything below an 8k slot cap', () => {
  const cards = [
    { eaId: 1, name: 'Litmanen', price: 68000, overall: 88 },
    { eaId: 2, name: 'Zamorano', price: 88500, overall: 88 },
    { eaId: 3, name: 'Nesta', price: 270000, overall: 89 }
  ];
  const built = buildCandidatePool(cards, 100000, 100);
  assert.equal(built.thinPoolRescue, true);
  assert.deepEqual(built.pool.map(card => card.eaId), [1, 2]);
  assert.equal(built.minPrice, 68000);
  assert.equal(built.maxPrice, 88500);
});


test('standalone entry uses a native UV dynamic import and native UV sources contain no legacy FUTBIN DB helpers', () => {
  const standalone = readFileSync(new URL('../../uvStandalone.mjs', import.meta.url), 'utf8');
  const uvApp = readFileSync(new URL('../uvApp.js', import.meta.url), 'utf8');
  const futbin = readFileSync(new URL('../src/futbin.js', import.meta.url), 'utf8');
  const db = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');

  assert.match(standalone, /import\('\.\/uv\/uvApp\.js'\)/);
  assert.doesNotMatch(standalone, /uvApp\.js\?uv-standalone/);
  assert.doesNotMatch(uvApp, /recordFutbinPriceObservations|loadFutbinPriceFeatures/);
  assert.doesNotMatch(futbin, /recordFutbinPriceObservations|loadFutbinPriceFeatures/);
  assert.doesNotMatch(db, /recordFutbinPriceObservations|loadFutbinPriceFeatures/);
});


test('100k thin-pool rescue expands beyond the 8k slot window when fewer than requested slots exist', () => {
  const cheap = Array.from({ length: 8 }, (_, i) => ({
    eaId: i + 1,
    name: `Cheap ${i + 1}`,
    price: 650 + i * 450
  }));
  const kanuLike = { eaId: 999, name: 'Kanu-like', price: 41750 };
  const built = buildCandidatePool([...cheap, kanuLike], 100000, 100);
  assert.equal(built.thinPoolRescue, true);
  assert.equal(built.pool.length, 9);
  assert.ok(built.pool.some(card => card.eaId === 999));
  assert.equal(built.maxPrice, 41750);
});
