import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFutbinSearchHtml,
  parseFutbinPlayerHtml,
  parseFutbinMarketHtml,
  computeFutbinSalesMetrics
} from '../futbinPublicV1063.js';

test('search parser selects matching FC26 player card', () => {
  const html = `<div class="player">98 CM Summer Stars <a href="/26/player/26235/jude-bellingham">Jude Bellingham</a></div>
  <div class="player">94 CAM Answer The Call <a href="/26/player/24129/jude-bellingham">Jude Bellingham</a></div>`;
  const rows = parseFutbinSearchHtml(html, { name: 'Jude Bellingham', rating: 98, cardType: 'Summer Stars' }, '26');
  assert.equal(rows[0].futbinId, '26235');
});

test('player parser reads games, prices and trend', () => {
  const html = `<html><head><title>Jude Bellingham Answer The Call EA FC 26 - 94 - Rating and Price | FUTBIN</title></head><body>
  <h1>BELLINGHAM - Answer The Call EA FC 26 Prices and Rating</h1>
  Trend: 1.75% (-250) Price Range: 11,500 - 85,000
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
});

test('market parser separates sold and unsold listings', () => {
  const html = `<html><body>Average BIN 476,132 High 595K Low 99.5K Discard Price 11,590 EA Avg. Price 491,084 Trend: 4.2%
  <table><thead><tr><th>Date</th><th>Listed for</th><th>Sold for</th><th>EA Tax</th><th>Net Price</th><th>Type</th></tr></thead>
  <tbody>
   <tr><td>Aug 14, 3:33 PM</td><td>380,000</td><td>380,000</td><td>19,000</td><td>361,000</td><td></td></tr>
   <tr><td>Aug 14, 3:20 PM</td><td>510,000</td><td>0</td><td>0</td><td>0</td><td></td></tr>
   <tr><td>Aug 14, 3:10 PM</td><td>400,000</td><td>400,000</td><td>20,000</td><td>380,000</td><td></td></tr>
  </tbody></table>
  <script type="application/json">{"history":[{"timestamp":"2026-01-01T00:00:00Z","price":100000},{"timestamp":"2026-01-02T00:00:00Z","price":110000}]}</script>
  </body></html>`;
  const m = parseFutbinMarketHtml(html);
  assert.equal(m.sales.length, 3);
  assert.equal(m.sales.filter(x => x.sold).length, 2);
  assert.equal(m.history.length, 2);
  const metrics = computeFutbinSalesMetrics(m.sales);
  assert.equal(metrics.listingsObserved, 3);
  assert.equal(metrics.soldListings, 2);
  assert.equal(metrics.unsoldListings, 1);
  assert.equal(metrics.medianSoldPrice, 390000);
  assert.ok(metrics.sellThroughRate > 66 && metrics.sellThroughRate < 67);
});
