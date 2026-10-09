import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

process.env.UV_PRICE_SOURCE = 'FUTBIN_ONLY';
process.env.GAME_YEAR = '27';
const { uvRouter } = await import('../uvApp.js');
const { mapFutbinQuoteToUvCard, isFutbinOnlyUvMode } = await import('../src/futbinOriginalSource.js');
const { originalUvFutbinPriceFeed } = await import('../src/futbinConsoleApi.js');

test('maps only real FUTBIN console listing to ORIGINAL UV card schema',()=>{
  const input={ source:'FUTBIN',game:'FC27',playerId:'506',
    resourceId:261855,playerName:'Francisca Nazareth',cardType:'Gold Rare',
    rating:85,position:'CAM',platform:'console',
    coins:54000,capturedAt:'2026-10-09T03:00:00.000Z',
    sourceCheckedAt:'2026-10-09 04:25:11',
    evidence:'futbin-direct-json',priceType:'lowest_listing',salesVerified:false };
  const card=mapFutbinQuoteToUvCard(input);
  assert.ok(isFutbinOnlyUvMode());
  assert.equal(card.eaId,261855);
  assert.equal(card.price,54000);
  assert.equal(card.futbinPrice,54000);
  assert.equal(card.priceSource,'FUTBIN_JSON_FC27_PS');
  assert.equal(card.cardType,'Base Rare');
  assert.equal(card.marketTradeableConfirmed,false);
  assert.equal(card.priceStatusCode,null);
  assert.equal(card.saleVerified,false);
  assert.equal(card.salesProbability,null);
  assert.equal(mapFutbinQuoteToUvCard({...input,platform:'pc'}),null);
  assert.equal(mapFutbinQuoteToUvCard({...input,source:'FUT.GG'}),null);
  assert.equal(mapFutbinQuoteToUvCard({...input,game:'FC26'}),null);
  assert.equal(mapFutbinQuoteToUvCard({...input,salesVerified:true}),null);
  assert.equal(mapFutbinQuoteToUvCard({...input,coins:0}),null);
  assert.equal(mapFutbinQuoteToUvCard({...input,resourceId:null}),null);
});

test('original UV page is preserved; FUTBIN_ONLY disables LEGACY mixed-source trade endpoints',async()=>{
  // Prevent this isolated API test from performing a network fetch.
  const originalRefresh = originalUvFutbinPriceFeed.ensureRefreshed;
  originalUvFutbinPriceFeed.ensureRefreshed=()=>false;
  const app=express();app.use(uvRouter);
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const page=await fetch(base+'/uv/'),html=await page.text();
    assert.equal(page.status,200);
    for(const part of ['id="generateBtn"','id="recheckBtn"','id="rebalanceBtn"',
      'id="futbinSourcePanel"','futbin-source-panel.js','/uv/app.js?v=2.10.12-feasibility2']){
      assert.ok(html.includes(part),part);
    }
    const status=await(await fetch(base+'/api/uv/status')).json();
    assert.equal(status.priceSourceMode,'FUTBIN_ONLY');
    assert.equal(status.primaryPriceSource,'FUTBIN_JSON_FC27_PS');
    assert.equal(status.gameYear,27);
    assert.equal(status.currentCapabilities.futggLivePrices,false);
    for(const [method,url,payload] of [
      ['POST','/api/uv/generate',{budget:100000,platform:'console'}],
      ['POST','/api/uv/rebalance/test',{budget:100000}],
      ['GET','/api/uv/recheck/test',null]
    ]){
      const opts={method,headers:{'content-type':'application/json'}};
      if(payload)opts.body=JSON.stringify(payload);
      const response=await fetch(base+url,opts);
      assert.equal(response.status,409,url);
      const json=await response.json();
      assert.equal(json.code,'FUTBIN_ONLY_LISTINGS_NOT_SALES');
    }
  }finally{
    originalUvFutbinPriceFeed.ensureRefreshed=originalRefresh;
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
