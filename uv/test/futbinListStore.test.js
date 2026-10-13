import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createFutbinListStore} from '../src/futbinListStore.js';
import {SOURCE} from '../src/futbinPortfolio.js';
const portfolio={source:SOURCE,gameYear:27,platform:'console',budget:100000,count:0,cards:[]};

test('saved lists survive a store restart; unsaved lists remain session-only; recheck is durable',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'uv-store-'));
  try{
    const a=createFutbinListStore({directory});
    const transient=await a.put(portfolio,false), saved=await a.put(portfolio,true);
    assert.equal(transient.listId,null);
    assert.equal(transient.saved,false);
    assert.equal((await a.get(transient.recheckListId)).count,0);
    await a.update(saved.listId,{...saved,lastRecheckAt:'2026-10-09T21:00:00Z'});
    const b=createFutbinListStore({directory});
    assert.equal((await b.get(saved.listId)).lastRecheckAt,'2026-10-09T21:00:00Z');
    assert.equal((await b.list()).length,1);
    await assert.rejects(()=>b.get(transient.recheckListId),/nicht gefunden/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('source isolation and temporary expiry prevent legacy or expired lists from entering the new pipeline',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'uv-store-'));
  let clock=0;
  try{
    await writeFile(path.join(directory,'lists.json'),JSON.stringify({schemaVersion:1,lists:[{...portfolio,source:'OTHER_PROVIDER',listId:'old'}]}));
    const store=createFutbinListStore({directory,clock:()=>clock});
    assert.deepEqual(await store.list(),[]);
    const p=await store.put(portfolio);
    clock+=25*60*60000;
    await assert.rejects(()=>store.get(p.recheckListId),/nicht gefunden/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
