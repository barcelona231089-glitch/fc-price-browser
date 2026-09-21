import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldMaxDecisionLayer } from '../worldMaxForecastV1.js';

function row(action, edge) {
  return { aiAction: action, aiConfidence: 80, aiReason: '', aiWorldMaxForecast: {
    shadow: false, productionConfirmed: true,
    ensemble: { horizons: [{ horizonMinutes: 360, quality: 90, edgePct: edge }] }
  }};
}

test('World-Max never creates a buy from waiting state', () => {
  const r = row('NOCH WARTEN', 8);
  applyWorldMaxDecisionLayer(r);
  assert.equal(r.aiAction, 'NOCH WARTEN');
});

test('World-Max may veto an existing buy', () => {
  const r = row('JETZT KAUFEN', -3);
  applyWorldMaxDecisionLayer(r);
  assert.equal(r.aiAction, 'NOCH WARTEN');
});
