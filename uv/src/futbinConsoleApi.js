// FUTBIN-only REST feed: direct JSON catalog/prices, plus optional browser captures.
// No FUT.GG, Parse, user credentials, proxy rotation or security-challenge evasion.
import express from 'express';
import { analyzeFutbinConsoleExport } from './futbinConsoleImport.js';
import { createFutbinDirectFeed } from './futbinDirectFeed.js';

const MAX_CAPTURED = 1000;
const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;
const makePacket = prices => ({ schemaVersion: 1, source: 'FUTBIN', prices });
const toRow = card => ({
  source: 'FUTBIN', game: 'FC27', playerId: String(card.playerId),
  playerName: card.playerName || null,
  platform: 'console', coins: card.priceCoins, capturedAt: card.capturedAt,
  evidence: 'visible-price-box', priceType: 'visible_listing', salesVerified: false
});
const parseBudget = input => input === undefined ? 100000 : Number(input);
const allowLocalOrigin = req => {
  const origin = req.get('origin');
  if (!origin) return true;
  return /^http:\/\/(?:127\.0\.0\.1|localhost):5187$/.test(origin);
};

export const originalUvFutbinPriceFeed = createFutbinDirectFeed();

export function createFutbinConsoleRouter({
  clock = Date.now, direct = originalUvFutbinPriceFeed
} = {}) {
  const api = express.Router();
  api.use(express.json({ limit: '512kb' }));
  const byPlayer = new Map();
  let lastSyncAt = null;
  let receivedEvents = 0;

  function snapshot() {
    const now = clock();
    for (const [key, entry] of byPlayer) {
      if (now - Date.parse(entry.capturedAt) > SNAPSHOT_RETENTION_MS) byPlayer.delete(key);
    }
    return makePacket([...byPlayer.values(), ...direct.getRows()]);
  }

  api.get('/api/uv/futbin-console/players', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const budget = parseBudget(req.query.budget);
      if (!Number.isSafeInteger(budget) || budget < 30_000 || budget > 100_000_000) {
        return res.status(400).json({ error: 'Budget ungueltig.' });
      }
      // Initiates a bounded background pull at most every 10 minutes. GET returns promptly.
      direct.ensureRefreshed();
      const result = analyzeFutbinConsoleExport(snapshot(), { budget, now: clock() });
      const directStatus = direct.getStatus();
      return res.json({ ...result,
        apiSource: directStatus.hasSuccessfulFetch
          ? 'futbin-direct-json' : 'browser-captured-futbin',
        autoTransfer: true, directFutbinApiAvailable: directStatus.hasSuccessfulFetch,
        directFutbin: directStatus,
        lastSyncAt, receivedEvents,
        cachedPlayers: new Set([...byPlayer.keys(), ...direct.getRows().map(p => p.playerId)]).size });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error) });
    }
  });

  api.post('/api/uv/futbin-console/sync', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!allowLocalOrigin(req)) return res.status(403).json({ error: 'Nur lokale Browserseite erlaubt.' });
    try {
      const body = req.body;
      const result = analyzeFutbinConsoleExport(body, { now: clock(), budget: 100000 });
      const candidates = [...result.cards, ...result.staleCards];
      let added = 0;
      for (const card of candidates) {
        const key = String(card.playerId), existing = byPlayer.get(key);
        if (existing && Date.parse(existing.capturedAt) >= Date.parse(card.capturedAt)) continue;
        byPlayer.set(key, toRow(card));
        added++;
      }
      snapshot();
      if (byPlayer.size > MAX_CAPTURED) {
        const oldest = [...byPlayer.entries()].sort(
          (a,b) => Date.parse(a[1].capturedAt) - Date.parse(b[1].capturedAt)
        );
        for (const [key] of oldest.slice(0, byPlayer.size - MAX_CAPTURED)) byPlayer.delete(key);
      }
      lastSyncAt = new Date(clock()).toISOString();
      receivedEvents++;
      return res.json({ ok: true, source: 'FUTBIN', platform: 'console',
        added, cachedPlayers: byPlayer.size, lastSyncAt,
        invalid: result.invalidRows, stale: result.staleRows });
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error) });
    }
  });

  // Backward-compatible manual verification for old integrations, not used by automatic UI.
  api.post('/api/uv/futbin-console/analyze', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(analyzeFutbinConsoleExport(req.body?.export,
        { now: clock(), budget: parseBudget(req.body?.budget) }));
    } catch (error) {
      return res.status(400).json({ error: String(error?.message || error) });
    }
  });
  return api;
}
