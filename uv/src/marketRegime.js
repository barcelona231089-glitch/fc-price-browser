import { GAME_YEAR } from './config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (now, before) => Number.isFinite(now) && now > 0 && Number.isFinite(before) && before > 0
  ? ((now - before) / before) * 100 : null;
const median = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
function windowOf(rows, field) {
  const moves = rows.map(r => r[field]).filter(Number.isFinite);
  if (!moves.length) return { measuredCards: 0, medianMove: 0, risingPct: 0, fallingPct: 0 };
  return {
    measuredCards: moves.length,
    medianMove: Number((median(moves) ?? 0).toFixed(2)),
    risingPct: Number((moves.filter(v => v >= .5).length / moves.length * 100).toFixed(1)),
    fallingPct: Number((moves.filter(v => v <= -.5).length / moves.length * 100).toFixed(1))
  };
}
export function buildRealMarketRegime(dbRows = []) {
  const rows = dbRows.map(r => ({
    change5m: pct(Number(r.price), Number(r.price_5m)),
    change15m: pct(Number(r.price), Number(r.price_15m)),
    change1h: pct(Number(r.price), Number(r.price_1h))
  }));
  const w5m = windowOf(rows, 'change5m');
  const w15m = windowOf(rows, 'change15m');
  const w1h = windowOf(rows, 'change1h');
  const packSupplyActive = Boolean(
    (w5m.measuredCards >= 25 && w5m.fallingPct >= 65 && w5m.medianMove <= -1.5) ||
    (w15m.measuredCards >= 25 && w15m.fallingPct >= 70 && w15m.medianMove <= -2.5)
  );
  let mood = 'neutral';
  if (w5m.measuredCards < 25) mood = 'insufficient_data';
  else if (w5m.fallingPct >= 75 && w5m.medianMove <= -2) mood = 'crash';
  else if (packSupplyActive) mood = 'supply_pressure';
  else if (w5m.risingPct >= 55 && w5m.medianMove >= .5 && w15m.medianMove <= -.75) mood = 'recovery';
  else if (w5m.risingPct >= 70 && w5m.medianMove >= 1.5) mood = 'rising';
  else if (w5m.fallingPct >= 60 && w5m.medianMove <= -.75) mood = 'falling';
  else if (Math.abs(w5m.medianMove) < .5 && Math.abs(w15m.medianMove) < 1) mood = 'flat';
  const breadth = Math.max(Math.abs(w5m.risingPct-w5m.fallingPct), Math.abs(w15m.risingPct-w15m.fallingPct));
  const confidence = clamp(Math.round(Math.min(60, rows.length/8) + Math.min(35, breadth*.45)), 0, 95);
  const stabilityScore = clamp(Math.round(
    55 - Math.abs(w5m.medianMove)*3 - Math.abs(w15m.medianMove)*1.5 -
    (mood === 'crash' ? 22 : mood === 'supply_pressure' ? 14 : mood === 'falling' ? 8 : 0)
  ), 10, 90);
  return {
    ok: w5m.measuredCards >= 25, gameYear: GAME_YEAR, source: 'uv-real-price-history',
    mood, direction: mood, packSupplyActive, measuredCards: rows.length, confidence,
    stabilityScore, windows: { m5: w5m, m15: w15m, h1: w1h }
  };
}
