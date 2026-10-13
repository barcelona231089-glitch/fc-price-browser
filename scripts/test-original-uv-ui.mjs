// Optional DOM smoke test: npm install --no-save jsdom, then npm run test:ui.
// Uses only explicit test fixtures. It does not access FUTBIN or saved user lists.
import {JSDOM,VirtualConsole} from 'jsdom';
import express from 'express';
import {once} from 'node:events';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createUvRouter} from '../uv/uvApp.js';
import {createFutbinListStore} from '../uv/src/futbinListStore.js';

const directory=await mkdtemp(path.join(os.tmpdir(),'uv-dom-'));
const now=new Date().toISOString();
let quotes=Array.from({length:140},(_,i)=>({source:'FUTBIN',game:'FC27',platform:'console',
  playerId:String(i+1),resourceId:800001+i,playerName:'<em>Fixture '+i+'</em>',
  rating:84,cardType:'Gold Rare',coins:800,capturedAt:now,
  evidence:'futbin-direct-json',priceType:'lowest_listing',salesVerified:false}));
const feed={ensureRefreshed:()=>false,waitForCurrent:async()=>{},getRows:()=>quotes,
  getStatus:()=>({hasSuccessfulFetch:true,lastSuccessAt:now,currentPhase:'READY',lastError:null})};
const app=express();app.use(createUvRouter({feed,store:createFutbinListStore({directory})}));
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base='http://127.0.0.1:'+server.address().port;
let dom;
try{
  const html=await readFile(new URL('../uv/public/index.html',import.meta.url),'utf8');
  const errors=[],virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>errors.push(error.message));
  dom=new JSDOM(html,{url:base+'/uv/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window,doc=w.document,$=selector=>doc.querySelector(selector);
  w.fetch=(input,init)=>fetch(new URL(typeof input==='string'?input:input.url,base),init);
  w.Response=Response;w.Request=Request;w.Headers=Headers;
  for(const file of ['generate-async-v2105.js','app.js','futbin-source-panel.js'])
    w.eval(await readFile(new URL('../uv/public/'+file,import.meta.url),'utf8'));
  async function until(predicate,label){
    for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}
    throw Error('Timeout: '+label+' / '+$('#notice').textContent);
  }
  async function generate(){
    $('#generateBtn').click();
    for(const id of ['recheckBtn','rebalanceBtn','loadSavedBtn','savedListSelect']) assert.equal($('#'+id).disabled,true,id);
    await until(()=>!$('#generateBtn').disabled,'generation');
    assert.equal($('#rows .error'),null);
  }
  $('#saveListChoice').checked=true;
  await generate();
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,100);
  assert.match($('#summary').textContent,/100 \/ 100/);
  assert.equal(doc.querySelectorAll('#rows em').length,0,'untrusted names are rendered as text');
  assert.equal($('#recheckBtn').disabled,false);
  $('#recheckBtn').click();await until(()=>!$('#recheckBtn').disabled,'recheck');
  assert.match($('#notice').textContent,/Keine Kauf-Freigabe/);
  assert.equal($('#rebalanceBtn').disabled,false);
  $('#rebalanceBtn').click();await until(()=>$('#rebalanceBtn').textContent==='Liste neu ausbalancieren','rebalance');
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,100);
  assert.ok($('#savedListSelect').options.length>=2);
  $('#loadSavedBtn').click();await until(()=>$('#loadSavedBtn').textContent==='Öffnen','reopen');
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,100);
  $('#filter').value='does-not-exist';$('#filter').dispatchEvent(new w.Event('input'));
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,0);
  $('#filter').value='';$('#filter').dispatchEvent(new w.Event('input'));
  $('#rows [data-details]').click();assert.ok($('#rows .detailPanel'));
  assert.match($('#rows .detailPanel').textContent,/Nicht verfügbar/);
  $('#saveListChoice').checked=false;
  for(const field of ['minGames','minSales']){
    $('#'+field).value='1';await generate();
    assert.equal(doc.querySelectorAll('#rows .tradeRow').length,0,field);
    assert.match($('#summary').textContent,/0 \/ 100/);$('#'+field).value='0';
  }
  $('#minPrice').value='900';await generate();
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,0);
  $('#minPrice').value='';await generate();
  assert.equal(doc.querySelectorAll('#rows .tradeRow').length,100);
  quotes=quotes.slice(1);
  $('#recheckBtn').click();await until(()=>!$('#recheckBtn').disabled,'missing quote');
  assert.match($('#notice').textContent,/fehlen Preise/);
  assert.ok(doc.querySelectorAll('#rows .status-missing').length>0);
  assert.deepEqual(errors,[]);
  console.log('PASS: generate, save/reopen, recheck, rebalance, price/Games/Sales filters, details, search, missing quotes, HTML escaping. DOM test with fixtures; no live data or visual browser verification.');
}finally{
  dom?.window.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  await rm(directory,{recursive:true,force:true});
}
