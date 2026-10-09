// Standalone ÜV import adapter. FUTBIN FC27 console listings only; never fabricate sales.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function importConsolePrices(input, { now = Date.now(), maxAgeMs = 30 * 60_000 } = {}) {
  if (!input || input.schemaVersion !== 1 || input.source !== 'FUTBIN' || !Array.isArray(input.prices)) {
    throw new Error('Ungültiger FUTBIN-Export (Schema/Quelle).');
  }
  const byPlayer = new Map();
  let rejected = 0, stale = 0;
  for (const p of input.prices) {
    if (p?.source !== 'FUTBIN' || p.game !== 'FC27' || p.platform !== 'console' ||
      !/^\d+$/.test(String(p.playerId)) || !Number.isSafeInteger(p.coins) ||
      p.coins < 100 || p.coins > 15_000_000 || p.evidence !== 'visible-price-box' ||
      p.priceType !== 'visible_listing' || p.salesVerified !== false) { rejected++; continue; }
    const at = Date.parse(p.capturedAt);
    if (!Number.isFinite(at) || at > now + 60_000) { rejected++; continue; }
    if (now - at > maxAgeMs) { stale++; continue; }
    const id = String(p.playerId), old = byPlayer.get(id);
    if (!old || Date.parse(old.capturedAt) < at) byPlayer.set(id, {
      playerId: id, platform: 'console', priceCoins: p.coins,
      capturedAt: p.capturedAt, source: 'FUTBIN', evidence: 'visible_listing',
      completedSalesVerified: false
    });
  }
  return { schemaVersion: 1, source: 'FUTBIN', game: 'FC27',
    market: 'console', generatedAt: new Date(now).toISOString(),
    prices: [...byPlayer.values()], rejected, stale,
    warning: 'Angebotspreise, keine bestätigten Verkäufe. Abgelaufene Daten werden verworfen.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , source, destination] = process.argv;
  if (!source || !destination) {
    console.error('Verwendung: node scripts/uv-futbin-console-import.mjs input.json output.json');
    process.exitCode = 2;
  } else {
    const result = importConsolePrices(JSON.parse(readFileSync(source, 'utf8')));
    writeFileSync(destination, JSON.stringify(result, null, 2));
    console.log('Importiert:', result.prices.length, 'Abgelaufen:', result.stale, 'Ungültig:', result.rejected);
  }
}
