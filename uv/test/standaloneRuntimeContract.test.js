import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeObservedFutbinEvidence } from '../src/futbin.js';

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

test('standalone runtime bypasses legacy UV loader patches', () => {
  const loader = readFileSync(new URL('../../v1066Loader.mjs', import.meta.url), 'utf8');
  const bypass = loader.indexOf("dedicatedUvRuntime && (normalizedUrl.endsWith('/uv/uvApp.js') || normalizedUrl.includes('/uv/src/'))");
  const legacyDbPatch = loader.indexOf("if (url.endsWith('/uv/src/db.js'))");
  assert.ok(bypass >= 0, 'native standalone bypass marker missing');
  assert.ok(legacyDbPatch > bypass, 'legacy UV patch executes before standalone bypass');
});

test('standalone frontend has no legacy generate fetch interceptor', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /generate-async-v2105\.js/);
  assert.doesNotMatch(html, /unsaved-live-v2108\.js/);
  assert.match(html, /app\.js\?v=2\.15\.18/);
});
