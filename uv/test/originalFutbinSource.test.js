import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createUvRouter,setUvBrainActive} from '../uvApp.js';
import {createFutbinListStore} from '../src/futbinListStore.js';
import {mapFutbinQuoteToUvCard,isFutbinOnlyUvMode} from '../src/futbinOriginalSource.js';

test('source mapping retains precise FC27 item identity without turning listings into sales',()=>{
  const row={source:'FUTBIN',game:'FC27',playerId:'506',resourceId:261855,
    playerName:'Fixture',cardType:'Gold Rare',rating:85,platform:'console',coins:20500,
    capturedAt:new Date().toISOString(),evidence:'futbin-direct-json',priceType:'lowest_listing',salesVerified:false};
  const c=mapFutbinQuoteToUvCard(row);
  assert.equal(isFutbinOnlyUvMode(),true);
  assert.equal(c.eaId,261855);assert.equal(c.futbinId,506);assert.equal(c.price,20500);
  assert.equal(c.saleVerified,false);assert.equal(c.priceStatusCode,null);
  assert.equal(c.salesHistoryAvailable,false);assert.equal(c.futbinGamesCount,null);
  for(const bad of [{platform:'pc'},{game:'FC26'},{source:'OTHER_PROVIDER'},{resourceId:null},{salesVerified:true}])
    assert.equal(mapFutbinQuoteToUvCard({...row,...bad}),null);
});

test('original app HTTP workflow: validate, generate, save, reopen, recheck, rebalance and fail closed',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'uv-api-'));
  let calls=0, state={hasSuccessfulFetch:true,lastSuccessAt:new Date().toISOString(),currentPhase:'READY',lastError:null};
  let quotes=Array.from({length:140},(_,i)=>({source:'FUTBIN',game:'FC27',platform:'console',
    playerId:String(i+1),resourceId:800001+i,playerName:'Fixture '+i,rating:84,cardType:'Gold Rare',
    coins:800,capturedAt:new Date().toISOString(),evidence:'futbin-direct-json',priceType:'lowest_listing',salesVerified:false}));
  const feed={ensureRefreshed:()=>{calls++;},waitForCurrent:async()=>{},getStatus:()=>state,getRows:()=>quotes};
  const app=express();app.use(createUvRouter({feed,store:createFutbinListStore({directory})}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  const post=(url,body={},headers={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const poll=async id=>{
    for(let n=0;n<100;n++){
      const j=await(await fetch(base+'/api/uv/job/'+id)).json();
      if(j.status==='DONE'||j.status==='FAILED')return j;
      await new Promise(r=>setTimeout(r,10));
    }throw Error('Job never finished');
  };
  try{
    const html=await(await fetch(base+'/uv/')).text();
    for(const id of ['budget','generateBtn','recheckBtn','rebalanceBtn','savedListSelect','minPrice','maxPrice','minGames','minSales'])
      assert.ok(html.includes('id="'+id+'"'),id);
    const status=await(await fetch(base+'/api/uv/status')).json();
    assert.equal(status.priceSourceMode,'FUTBIN_ONLY');assert.equal(status.currentCapabilities.pgpGames,false);
    for(const body of [{budget:0},{budget:100000,platform:'pc'},{budget:100000,filters:{minSales:-1}}])
      assert.equal((await post('/api/uv/generate',body)).status,400);
    assert.equal(calls,0,'invalid inputs must not fetch remote data');
    assert.equal((await post('/api/uv/generate',{budget:100000},{origin:'https://untrusted.example'})).status,403);
    const response=await post('/api/uv/generate-async',{budget:100000,platform:'console',saveList:true});
    assert.equal(response.status,202);
    const job=await poll((await response.json()).jobId);
    assert.equal(job.status,'DONE');const p=job.result;
    assert.equal(p.count,100);assert.equal(p.totalBuy,80000);assert.equal(p.saved,true);
    assert.ok(p.cards.every(c=>c.buyAuthorized===false&&c.buyMax===null));
    assert.equal((await(await fetch(base+'/api/uv/history')).json()).lists.length,1);
    assert.equal((await(await fetch(base+'/api/uv/list/'+p.listId)).json()).count,100);
    quotes=quotes.map(c=>({...c,coins:1500}));
    const check=await post('/api/uv/recheck/'+p.listId);
    const checked=await poll((await check.json()).jobId);
    assert.equal(checked.status,'DONE');assert.equal(checked.result.portfolio.overBudget,true);
    assert.equal(checked.result.portfolio.totalBuy,150000);
    const balanced=await(await post('/api/uv/rebalance/'+p.listId)).json();
    assert.ok(balanced.count>0&&balanced.count<100);assert.ok(balanced.totalBuy<=100000);
    assert.equal(balanced.saved,false);assert.equal(balanced.listId,null);
    for(const filters of [{minGames:1},{minSales:1}]){
      const empty=await(await post('/api/uv/generate',{budget:100000,filters})).json();
      assert.equal(empty.count,0);
    }
    state={...state,lastError:'FUTBIN-JSON HTTP 403'};
    assert.equal((await post('/api/uv/generate',{budget:100000})).status,503);
    state={...state,lastError:null,lastSuccessAt:new Date(Date.now()-31*60000).toISOString()};
    assert.equal((await post('/api/uv/generate',{budget:100000})).status,503);
    assert.equal((await fetch(base+'/api/uv/recheck/'+p.listId)).status,405);
    await setUvBrainActive(false);
    assert.equal((await post('/api/uv/generate',{budget:100000})).status,503);
  }finally{
    await setUvBrainActive(true);
    server.closeAllConnections();await new Promise(r=>server.close(r));
    await rm(directory,{recursive:true,force:true});
  }
});
