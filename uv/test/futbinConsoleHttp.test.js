import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { uvRouter } from '../uvApp.js';

test('FUTBIN-only console endpoint serves public UI and safely analyzes exports', async () => {
  const app = express();
  app.use(uvRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base + '/uv/');
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /FUTBIN FC27/);
    assert.match(html, /futbin-console\.js/);
    assert.doesNotMatch(html, /<script src="\/uv\/app\.js/);
    const script = await fetch(base + '/uv/futbin-console.js');
    assert.equal(script.status, 200);

    const price = { source:'FUTBIN', game:'FC27', platform:'console', playerId:'506',
      coins:54000, capturedAt:new Date().toISOString(), evidence:'visible-price-box',
      priceType:'visible_listing', salesVerified:false };
    const analyze = async data => fetch(base+'/api/uv/futbin-console/analyze', {
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)
    });
    const response = await analyze({budget:100000,export:{
      schemaVersion:1,source:'FUTBIN',prices:[price,{...price,playerId:'999',platform:'pc'}]
    }});
    assert.equal(response.status,200);
    const result = await response.json();
    assert.equal(result.mode,'FUTBIN_FC27_CONSOLE_ONLY');
    assert.equal(result.freshPlayers,1);
    assert.equal(result.affordableListings,1);
    assert.equal(result.invalidRows,1);
    assert.equal(result.recommendationCount,0);
    assert.equal(result.cards[0].buyMax,null);
    assert.equal(result.confirmedSales,0);
    assert.equal(response.headers.get('cache-control'),'no-store');

    const invalid = await analyze({budget:100000,export:{source:'FUT.GG',prices:[]}});
    assert.equal(invalid.status,400);
  } finally {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
