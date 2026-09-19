import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { __test, applyWorldMaxDecisionLayer, getWorldMaxForecastStatus } from '../worldMaxForecastV1.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

test('World-Max layer is disabled safely when no worker is configured', () => {
  const oldUrl = process.env.WORLD_MAX_ML_WORKER_URL;
  const oldEnabled = process.env.WORLD_MAX_ML_ENABLED;
  delete process.env.WORLD_MAX_ML_WORKER_URL;
  delete process.env.WORLD_MAX_ML_ENABLED;
  const status = getWorldMaxForecastStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.mode, 'DISABLED');
  assert.equal(status.policy.noSyntheticPrices, true);
  if (oldUrl == null) delete process.env.WORLD_MAX_ML_WORKER_URL; else process.env.WORLD_MAX_ML_WORKER_URL = oldUrl;
  if (oldEnabled == null) delete process.env.WORLD_MAX_ML_ENABLED; else process.env.WORLD_MAX_ML_ENABLED = oldEnabled;
});
test('forecast normalization and ensemble use only positive real forecasts', () => {
  const a = __test.normalizeForecast({ model: 'timesfm3', horizonMinutes: 360, p10: 9800, p50: 10400, p90: 11000 }, 10000);
  const b = __test.normalizeForecast({ model: 'chronos2', horizonMinutes: 360, p10: 9700, p50: 10300, p90: 11200 }, 10000);
  const bad = __test.normalizeForecast({ model: 'x', horizonMinutes: 360, p50: 0 }, 10000);
  assert.ok(a);
  assert.ok(b);
  assert.equal(bad, null);
  const ensemble = __test.ensembleForecast([a, b], 'NORMAL');
  assert.equal(ensemble.horizons.length, 1);
  assert.ok(ensemble.horizons[0].p50 > 10000);
  assert.ok(ensemble.horizons[0].quality > 0);
});

test('production decision layer can veto an existing entry but never invent one', () => {
  const forecast = {
    shadow: false,
    productionConfirmed: true,
    ensemble: { horizons: [{ horizonMinutes: 360, edgePct: -3, quality: 85 }] }
  };
  const buyRow = { aiAction: 'JETZT KAUFEN', aiConfidence: 88, aiWorldMaxForecast: forecast, aiReason: '' };
  applyWorldMaxDecisionLayer(buyRow);
  assert.equal(buyRow.aiAction, 'NOCH WARTEN');

  const observeRow = { aiAction: 'BEOBACHTEN', aiConfidence: 60, aiWorldMaxForecast: forecast, aiReason: '' };
  applyWorldMaxDecisionLayer(observeRow);
  assert.equal(observeRow.aiAction, 'BEOBACHTEN');
});
test('final loader wires World-Max shadow ensemble into the production brain', () => {
  const loader = fs.readFileSync(path.join(root, 'v1069969FinalHardeningLoader.mjs'), 'utf8');
  for (const marker of [
    './worldMaxForecastV1.js',
    'enrichRowsWithWorldMaxForecast',
    'applyWorldMaxDecisionLayer',
    'worldMaxForecast: getWorldMaxForecastStatus()',
    'World-Max ensemble layer'
  ]) {
    assert.ok(loader.includes(marker), marker);
  }
});
test('Chronos worker normalizes only the timestamp grid and never interpolates prices', () => {
  const worker = fs.readFileSync(path.join(root, 'world-max-worker', 'server.py'), 'utf8');
  for (const marker of [
    'pd.date_range(',
    'freq=freq',
    'timestampGridNormalized',
    'No synthetic prices or interpolated values'
  ]) {
    assert.ok(worker.includes(marker), marker);
  }
  assert.equal(worker.includes('.interpolate('), false);
  assert.equal(worker.includes('.ffill('), false);
  assert.equal(worker.includes('.bfill('), false);
});

test('forecast input uses only explicitly supplied observed price points', () => {
  const observed = [
    { at: '2026-09-18T20:00:00Z', price: 10000 },
    { at: '2026-09-18T21:00:00Z', price: 10100 }
  ];
  const input = __test.buildForecastInput(
    { eaId: '123', name: 'Test', overall: 85, cardType: 'Base Rare', price: 10100, change24h: 99 },
    { input: {} },
    '27',
    observed
  );
  assert.deepEqual(input.series, observed.map(x => ({ at: new Date(x.at).toISOString(), price: x.price })));
  assert.equal(input.stepMinutes, 60);
  assert.equal(input.series.length, 2);
});
