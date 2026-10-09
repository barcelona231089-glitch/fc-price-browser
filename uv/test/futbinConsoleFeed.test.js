import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createFutbinConsoleRouter } from '../src/futbinConsoleApi.js';

const now = Date.parse('2026-10-09T03:00:00Z');
const mk = (id, price, time = new Date(now).toISOString()) => ({
  source:'FUTBIN',game:'FC27',playerId:String(id),platform:'console',
  coins:price,capturedAt:time,evidence:'visible-price-box',
  priceType:'visible_listing',salesVerified:false
});
const pack = prices => ({ schemaVersion:1,source:'FUTBIN',prices });
test('auto API delivers genuine console snapshots, rejects PC, and never fabricates trades', async () => {
  let clock = now;
  const app = express();
  const fakeDirect = { ensureRefreshed: () => false, getRows: () => [],
    getStatus: () => ({ hasSuccessfulFetch: false }) };
  app.use(createFutbinConsoleRouter({clock:()=>clock,direct:fakeDirect}));
  const server = app.listen(0, '127.0.0.1');
  await once(server,'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (json, origin = 'http://127.0.0.1:5187') => fetch(base+'/api/uv/futbin-console/sync', {
    method:'POST', headers:{'content-type':'application/json','origin':origin},
    body:JSON.stringify(json)
  });
  const get = () => fetch(base+'/api/uv/futbin-console/players?budget=100000').then(r=>r.json());
  try {
    let result = await get();
    assert.equal(result.freshPlayers,0);
    assert.equal(result.cachedPlayers,0);
    assert.equal(result.directFutbinApiAvailable,false);
    const invalid = await post(pack([mk('6',292000)]), 'https://untrusted.example');
    assert.equal(invalid.status,403);
    result=await get();
    assert.equal(result.cachedPlayers,0);
    const incoming = await post(pack([{...mk('506',54000),playerName:'Testspieler'},mk('6',292000), {...mk('10',1500),platform:'pc'}]));
    assert.equal(incoming.status,200);
    const accepted = await incoming.json();
    assert.equal(accepted.cachedPlayers,2);
    assert.equal(accepted.invalid,1);
    result=await get();
    assert.deepEqual(result.cards.map(c=>c.playerId),['506','6']);
    assert.equal(result.affordableListings,1);
    assert.equal(result.cards[0].playerName,'Testspieler');
    assert.equal(result.recommendationCount,0);
    assert.equal(result.readyForTrading,false);
    assert.ok(result.cards.every(c=>c.platform==='console' && c.buyMax===null && !c.completedSalesVerified));
    assert.equal(result.apiSource,'browser-captured-futbin');
    clock += 31*60000;
    result=await get();
    assert.equal(result.freshPlayers,0);
    assert.equal(result.staleCards.length,2);
    assert.equal(result.recommendations.length,0);
    const replay = await post(pack([mk('506',54000)]));
    assert.equal(replay.status,200);
    result=await get();
    assert.equal(result.freshPlayers,0, 'replayed old timestamp cannot pretend to be live');
    const updated = await post(pack([mk('506',52000,new Date(clock).toISOString())]));
    assert.equal(updated.status,200);
    result=await get();
    assert.equal(result.freshPlayers,1);
    assert.equal(result.cards[0].priceCoins,52000);
    assert.equal(result.staleCards.length,1);
    assert.equal(result.recommendationCount,0);
    const counterfeit = await post(pack([{...mk('9',3000), source:'FUT.GG'}]));
    assert.equal(counterfeit.status,200);
    assert.equal((await counterfeit.json()).invalid,1);
    result=await get();
    assert.equal(result.cachedPlayers,2);
    const bad = await fetch(base+'/api/uv/futbin-console/players?budget=oops');
    assert.equal(bad.status,400);
  } finally {
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
