import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFutbinSearchHtml,
  parseFutbinPlayerHtml,
  parseFutbinMarketHtml,
  computeFutbinSalesMetrics,
  computeHistoryWindows,
  computeListingStructure,
  parseFutbinMarketOverviewHtml
} from '../futbinMarketV1064.js';

test('v10.64 search parser keeps version and position candidates', () => {
  const html = `
    <div>98 CM Summer Stars <a href="/26/player/26235/jude-bellingham">Jude Bellingham</a></div>
    <div>94 CAM Answer The Call <a href="/26/player/24129/jude-bellingham">Jude Bellingham</a></div>`;
  const rows = parseFutbinSearchHtml(html, { name: 'Jude Bellingham', rating: 98, cardType: 'Summer Stars' }, '26');
  assert.equal(rows[0].futbinId, '26235');
  assert.equal(rows[0].cardVersion, 'Summer Stars');
  assert.equal(rows[0].primaryPosition, 'CM');
});

test('v10.64 player parser reads trading metadata', () => {
  const html = `<html><head><title>Jude Bellingham Answer The Call EA FC 26 - 94 - Rating and Price | FUTBIN</title></head><body>
  <h1>BELLINGHAM - Answer The Call EA FC 26 Prices and Rating</h1>
  Nation: England  League: LALIGA EA SPORTS  Club: Real Madrid  Position: CAM  Alternate Positions: CM ST
  Popularity: 1234  Likes: 900  Dislikes: 50  PRP: 44.5%
  Price Updated: 7 mins ago Price Range: 11,500 - 85,000 Trend: 1.75% (-250)
  Jude Bellingham has been used in 130,079 games with a GPG (goals per game) of 0.419.
  He has been used in 17,746 games with a GPG (goals per game) of 0.398.
  His current price on FUT is 14,000 on PlayStation, 14,000 on Xbox, and 22,500 on PC.
  Player card added: 20-03-2026
  </body></html>`;
  const p = parseFutbinPlayerHtml(html);
  assert.equal(p.rating, 94);
  assert.equal(p.gamesPlayedConsole, 130079);
  assert.equal(p.gamesPlayedPc, 17746);
  assert.equal(p.pricePlayStation, 14000);
  assert.equal(p.pricePc, 22500);
  assert.equal(p.trendConsolePct, 1.75);
  assert.equal(p.primaryPosition, 'CAM');
  assert.ok(p.alternatePositions.includes('CM'));
  assert.equal(p.prpPct, 44.5);
  assert.ok(p.priceUpdatedAtConsole);
});

test('v10.64 market parser and metrics distinguish sold/unsold, undercuts and relists', () => {
  const html = `<html><body>Average BIN 476,132 High 595K Low 99.5K Discard Price 11,590 EA Avg. Price 491,084 Trend: 4.2% PRP: 55%
  <table><thead><tr><th>Date</th><th>Listed for</th><th>Sold for</th><th>EA Tax</th><th>Net Price</th><th>Type</th></tr></thead>
  <tbody>
   <tr><td>Aug 14 2026 3:10 PM UTC</td><td>510,000</td><td>0</td><td>0</td><td>0</td><td>BIN</td></tr>
   <tr><td>Aug 14 2026 3:20 PM UTC</td><td>500,000</td><td>0</td><td>0</td><td>0</td><td>BIN</td></tr>
   <tr><td>Aug 14 2026 3:30 PM UTC</td><td>500,000</td><td>500,000</td><td>25,000</td><td>475,000</td><td>BIN</td></tr>
   <tr><td>Aug 14 2026 3:40 PM UTC</td><td>490,000</td><td>490,000</td><td>24,500</td><td>465,500</td><td>BIN</td></tr>
  </tbody></table>
  <script type="application/json">{"history":[
    {"timestamp":"2026-08-13T15:40:00Z","price":450000},
    {"timestamp":"2026-08-14T14:40:00Z","price":480000},
    {"timestamp":"2026-08-14T15:35:00Z","price":495000}
  ]}</script>
  </body></html>`;
  const m = parseFutbinMarketHtml(html);
  assert.equal(m.sales.length, 4);
  assert.equal(m.sales.filter(x => x.sold).length, 2);
  assert.equal(m.prpPct, 55);
  const metrics = computeFutbinSalesMetrics(m.sales);
  assert.equal(metrics.soldListings, 2);
  assert.equal(metrics.unsoldListings, 2);
  assert.equal(metrics.medianSoldPrice, 495000);
  assert.ok(metrics.undercutRatePct > 0);
  assert.ok(metrics.estimatedRelistCount >= 1);
  assert.equal(metrics.medianEaTax, 24750);
  const structure = computeListingStructure(m.sales);
  assert.ok(structure.undercutCount >= 1);
});

test('v10.64 history windows calculate multiple horizons', () => {
  const now = Date.parse('2026-08-14T16:00:00Z');
  const history = [
    { observedAt: '2026-07-10T16:00:00Z', price: 300000 },
    { observedAt: '2026-08-07T16:00:00Z', price: 350000 },
    { observedAt: '2026-08-13T16:00:00Z', price: 400000 },
    { observedAt: '2026-08-14T15:00:00Z', price: 450000 },
    { observedAt: '2026-08-14T15:45:00Z', price: 480000 }
  ];
  const w = computeHistoryWindows(history, 500000, now);
  assert.ok(w.m15);
  assert.ok(w.h1);
  assert.ok(w.h24);
  assert.ok(w.d7);
  assert.ok(w.d30);
  assert.ok(w.h24.changePct > 0);
});


test('v10.64 market overview parser reads indices and momentum', () => {
  const html = `<html><body>
    Index100 101.25 2.5% 99.10 1.2%
    Index86 110.00 3.0%
    IndexIcons 88.75 -1.5%
    Open: 98.1 Lowest: 96.4 Highest: 103.2
    Market Momentum 67 Positive
  </body></html>`;
  const o = parseFutbinMarketOverviewHtml(html);
  assert.equal(o.indices['100'].consoleChangePct, 2.5);
  assert.equal(o.indices['86'].consoleValue, 110);
  assert.equal(o.indices.ICONS.consoleChangePct, -1.5);
  assert.equal(o.marketMomentum, 67);
  assert.equal(o.marketMood, 'POSITIVE');
  assert.equal(o.index100Ohlc.high, 103.2);
});
