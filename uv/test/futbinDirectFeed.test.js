import test from 'node:test';
import assert from 'node:assert/strict';
import { createFutbinDirectFeed } from '../src/futbinDirectFeed.js';
import { analyzeFutbinConsoleExport } from '../src/futbinConsoleImport.js';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
        ID:start+i, resource_id:500000+start+i, rating:start===1000?82:83,
        playername:'Player '+(start+i), rareTypeName:'Gold Rare',position:'CM',
        ps_LCPrice:1000+i*100,pc_LCPrice:500000
      }));
      return goodResponse(data);
    }
    if(u.pathname.endsWith('/getPlayersPrice')){
      const ids=u.searchParams.get('player_ids').split(',');
      assert.ok(ids.length<=11);
      return goodResponse(ids.map(id=>({ ID:Number(id),Player_Resource:500000+Number(id),LCPrice:Number(id) <2000?1200:1800,
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

test('a short catalog page only exhausts that rating, while version mismatches cannot become prices',async()=>{
  const queries=[];
  const feed=createFutbinDirectFeed({clock:()=>now,delayMs:0,catalogPlan:[['82-82',1],['82-82',2],['83-83',1]],
    fetcher:async url=>{
      const u=new URL(url);queries.push(u);
      if(u.pathname.endsWith('getFilteredPlayers')){
        const id=u.searchParams.get('rating')==='82-82'?1:2;
        return goodResponse([{ID:id,resource_id:100+id,rating:83,rareTypeName:'Gold Rare',ps_LCPrice:800,playername:'Fixture '+id}]);
      }
      return goodResponse([{ID:1,Player_Resource:999,LCPrice:800},{ID:2,Player_Resource:102,LCPrice:800}]);
    }});
  await feed.refresh();
  assert.equal(queries.length,3);
  assert.deepEqual(feed.getRows().map(r=>r.playerId),['2']);
  assert.equal(feed.getStatus().currentPhase,'READY');
});

test('a restart preserves blocked cooldown and a later successful cache does not trigger another request',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'uv-feed-'));
  const cacheFile=path.join(directory,'source.json');let clock=now,calls=0;
  try{
    const blocked=createFutbinDirectFeed({cacheFile,clock:()=>clock,delayMs:0,catalogPlan:[['82-82',1]],
      fetcher:async()=>{calls++;return {ok:false,status:429,headers:new Headers({'retry-after':'7200'})};}});
    await blocked.refresh();
    clock+=70*60000;
    const restored=createFutbinDirectFeed({cacheFile,clock:()=>clock,fetcher:async()=>{calls++;throw Error('Unexpected network');}});
    assert.equal(restored.ensureRefreshed(),false);
    assert.equal(restored.getStatus().lastErrorCode,'HTTP_429');assert.equal(calls,1);
    clock+=60*60000;
    const good=createFutbinDirectFeed({cacheFile,clock:()=>clock,delayMs:0,catalogPlan:[['82-82',1]],
      fetcher:async url=>{calls++;return goodResponse(url.includes('getFilteredPlayers')?
        [{ID:1,resource_id:101,rating:84,rareTypeName:'Gold Rare',ps_LCPrice:800,playername:'Fixture'}]:
        [{ID:1,Player_Resource:101,LCPrice:800}]);}});
    await good.refresh();assert.equal(good.getRows().length,1);
    const cached=createFutbinDirectFeed({cacheFile,clock:()=>clock,fetcher:async()=>{throw Error('Unexpected network');}});
    assert.equal(cached.ensureRefreshed(),false);assert.equal(cached.getRows()[0].coins,800);
    assert.equal(cached.getStatus().lastError,null);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('empty or incomplete price responses cannot be published as a successful full refresh',async()=>{
  let clock=now,fail=false;
  const feed=createFutbinDirectFeed({clock:()=>clock,delayMs:0,catalogPlan:[['82-82',1]],fetcher:async url=>{
    if(url.includes('getFilteredPlayers'))return goodResponse([{ID:1,resource_id:101,rating:84,rareTypeName:'Gold Rare',ps_LCPrice:800}]);
    return goodResponse(fail?[]:[{ID:1,Player_Resource:101,LCPrice:800}]);
  }});
  await feed.refresh();const before=feed.getRows()[0].capturedAt;
  clock+=11*60000;fail=true;await feed.refresh();
  assert.equal(feed.getStatus().lastErrorCode,'EMPTY_PRICES');
  assert.equal(feed.getRows()[0].capturedAt,before,'stale data must not acquire a new timestamp');
});
