import test from 'node:test';
import assert from 'node:assert/strict';
import { createFutbinDirectFeed } from '../src/futbinDirectFeed.js';
import { analyzeFutbinConsoleExport } from '../src/futbinConsoleImport.js';

const now=Date.parse('2026-10-09T03:20:00Z');
const goodResponse = data => ({
  ok:true, status:200, headers:new Headers({'content-type':'application/json'}),
  async json(){return {data,errorcode:'200',errormsg:'SUCCESS'};}
});

test('FC27 FUTBIN JSON catalog + 11-id price batches produce real console candidate feed without PC', async()=>{
  let clock=now;
  const requests=[];
  const fetcher=async url=>{
    const u=new URL(url);
    requests.push(u);
    assert.equal(u.hostname,'www.futbin.org');
    assert.ok(u.pathname.startsWith('/futbin/api/27/'));
    assert.equal(u.searchParams.get('platform'),'PS');
    if(u.pathname.endsWith('/getFilteredPlayers')){
      const start=u.searchParams.get('rating')==='82-82'?1000:2000;
      const data=Array.from({length:32},(_,i)=>({
        ID:start+i, rating:start===1000?82:83,
        playername:'Player '+(start+i), rareTypeName:'Gold Rare',position:'CM',
        ps_LCPrice:1000+i*100,pc_LCPrice:500000
      }));
      return goodResponse(data);
    }
    if(u.pathname.endsWith('/getPlayersPrice')){
      const ids=u.searchParams.get('player_ids').split(',');
      assert.ok(ids.length<=11);
      return goodResponse(ids.map(id=>({ ID:Number(id),LCPrice:Number(id) <2000?1200:1800,
        Player_Fullname:'Real '+id,checked:'2026-10-09 04:15:00' })));
    }
    throw new Error('Unexpected fetch: '+url);
  };
  const feed=createFutbinDirectFeed({
    fetcher, clock:()=>clock, pause:async()=>{},
    catalogPlan:[['82-82',1],['83-83',1]], delayMs:0, intervalMs:600000
  });
  assert.equal(feed.ensureRefreshed(),true);
  await feed.waitForCurrent();
  const status=feed.getStatus();
  assert.equal(status.currentPhase,'READY');
  assert.equal(status.discoveredPlayers,64);
  assert.equal(status.pricedPlayers,64);
  assert.equal(feed.getRows().length,64);
  assert.ok(requests.some(u=>u.pathname.endsWith('getFilteredPlayers')));
  assert.ok(requests.some(u=>u.pathname.endsWith('getPlayersPrice')));
  assert.equal(requests.length,8);
  assert.ok(feed.getRows().every(r=>r.game==='FC27' && r.source==='FUTBIN' &&
      r.platform==='console' && r.evidence==='futbin-direct-json' &&
      r.salesVerified===false && r.coins<3000));
  const checked=analyzeFutbinConsoleExport({schemaVersion:1,source:'FUTBIN',prices:feed.getRows()},
    {now:clock,budget:100000});
  assert.equal(checked.freshPlayers,64);
  assert.equal(checked.affordableListings,64);
  assert.equal(checked.recommendations.length,0);
  assert.equal(checked.cards[0].buyMax,null);
  assert.ok(checked.cards.every(c=>c.priceType==='lowest_listing' && !c.completedSalesVerified));
  assert.equal(feed.ensureRefreshed(),false,'do not flood remote endpoint');
  assert.equal(requests.length,8);
});

test('actual 403 on JSON feed immediately stops and respects hour cooldown',async()=>{
  let nowMs=now;
  let calls=0;
  const feed=createFutbinDirectFeed({
    clock:()=>nowMs,pause:async()=>{},delayMs:0,catalogPlan:[['82-82',1]],
    fetcher:async()=>{
      calls++;
      return {ok:false,status:403,headers:new Headers({'content-type':'text/html'})};
    }
  });
  feed.ensureRefreshed();await feed.waitForCurrent();
  assert.equal(feed.getStatus().currentPhase,'ERROR');
  assert.equal(feed.getStatus().lastErrorCode,'HTTP_403');
  assert.equal(calls,1);
  nowMs+=40*60_000;
  assert.equal(feed.ensureRefreshed(),false);
  assert.equal(calls,1);
  assert.equal(feed.getRows().length,0);
});

test('429 respects retry-after and fails closed',async()=>{
  const feed=createFutbinDirectFeed({
    clock:()=>now,pause:async()=>{},delayMs:0,catalogPlan:[['82-82',1]],
    fetcher:async()=>({ok:false,status:429,headers:new Headers({'retry-after':'3600'})})
  });
  feed.ensureRefreshed();await feed.waitForCurrent();
  const status=feed.getStatus();
  assert.equal(status.lastErrorCode,'HTTP_429');
  assert.ok(Date.parse(status.nextRefreshAt)>=now+3600*1000);
  assert.equal(feed.getRows().length,0);
});
