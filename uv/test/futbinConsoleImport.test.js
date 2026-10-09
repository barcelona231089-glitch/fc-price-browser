import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFutbinConsoleExport } from '../src/futbinConsoleImport.js';

const baseTime = Date.parse('2026-10-09T01:20:00Z');
const good = (playerId = '506', price = 54000, capturedAt = '2026-10-09T01:14:00.279Z') => ({
  source: 'FUTBIN', game: 'FC27', playerId, platform: 'console',
  coins: price, capturedAt, evidence: 'visible-price-box',
  priceType: 'visible_listing', salesVerified: false
});
const packet = prices => ({ schemaVersion: 1, source: 'FUTBIN', prices });
const check = prices => analyzeFutbinConsoleExport(packet(prices), { now: baseTime, budget: 100000 });

test('actual 4-row screenshot export: console only, no buying despite positive prices', () => {
  const result = check([
    good('506',54000,'2026-10-09T01:14:00.279Z'),
    good('6',292000,'2026-10-09T01:14:50.737Z'),
    good('23164',2600000,'2026-10-09T01:15:00.222Z'),
    good('5',925000,'2026-10-09T01:16:33.222Z')
  ]);
  assert.equal(result.freshPlayers,4);
  assert.equal(result.missingForTarget,96);
  assert.equal(result.recommendationCount,0);
  assert.equal(result.readyForTrading,false);
  assert.ok(result.cards.every(c=>c.buyMax===null && c.completedSalesVerified===false));
  assert.deepEqual(result.cards.map(c=>c.priceCoins),[54000,292000,925000,2600000]);
});

test('PC or wrong game or other providers cannot enter market',()=>{
  const result=check([good(), {...good('99'), platform:'pc'},
    {...good('100'),game:'FC26'}, {...good('101'),source:'FUT.GG'},
    {...good('102'),salesVerified:true}, {...good('103'),priceType:'completed_sale'}]);
  assert.equal(result.freshPlayers,1);
  assert.equal(result.invalidRows,5);
});

test('stale price is excluded after 30 min and future dates are rejected',()=>{
  const result=analyzeFutbinConsoleExport(packet([good(),good('99',1000,'2026-10-09T02:00:00Z')]),
    {now:Date.parse('2026-10-09T01:50:01Z'),budget:100000});
  assert.equal(result.freshPlayers,0);
  assert.equal(result.staleRows,1);
  assert.equal(result.invalidRows,1);
});

test('latest capture wins for duplicate player',()=>{
  const result=check([good('506',54000,'2026-10-09T01:12:00Z'),
    good('506',55000,'2026-10-09T01:18:00Z')]);
  assert.equal(result.freshPlayers,1);
  assert.equal(result.cards[0].priceCoins,55000);
});

test('malformed exports and budgets fail closed',()=>{
  assert.throws(()=>analyzeFutbinConsoleExport(packet([]),{now:baseTime,budget:1000}),/Budget/);
  assert.throws(()=>analyzeFutbinConsoleExport({schemaVersion:1,source:'FUT.GG',prices:[]}),/Ungültiger/);
  assert.equal(check([{...good(),coins:'54000'}]).invalidRows,1);
});
