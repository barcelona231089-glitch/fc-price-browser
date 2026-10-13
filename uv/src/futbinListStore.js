import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SOURCE, portfolioError } from './futbinPortfolio.js';

export function createFutbinListStore({ directory, clock = Date.now } = {}) {
  const temporary = new Map();
  const file = path.join(directory, 'lists.json');
  let loaded, queue = Promise.resolve();
  async function saved() {
    if (!loaded) loaded = (async()=> {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.lists)) throw new Error('Unbekanntes Listenformat.');
        return parsed.lists.filter(p=>p.source===SOURCE && p.gameYear===27 && p.platform==='console');
      } catch (e) { if(e.code==='ENOENT') return []; throw e; }
    })();
    return loaded;
  }
  function cleanup() {
    for (const [id, value] of temporary) if (clock()-value.at > 24*60*60000) temporary.delete(id);
    while(temporary.size>50) temporary.delete(temporary.keys().next().value);
  }
  async function persist(lists) {
    await mkdir(directory, { recursive: true });
    await writeFile(file+'.tmp', JSON.stringify({schemaVersion:1, lists}), 'utf8');
    await rename(file+'.tmp', file);
    loaded=Promise.resolve(lists);
  }
  function serial(fn) { const next=queue.then(fn); queue=next.catch(()=>{}); return next; }
  return {
    async put(portfolio, durable=false) {
      cleanup();
      const id=randomUUID();
      const value={...portfolio, listId:durable?id:null, recheckListId:id, saved:durable,
        saveRequested:durable, transientRecheckOnly:!durable, createdAt:new Date(clock()).toISOString()};
      if(durable) await serial(async()=>{ await persist([value,...await saved()]); });
      else temporary.set(id, {at:clock(), value});
      return value;
    },
    async get(id) {
      cleanup();
      const value=temporary.get(id)?.value || (await saved()).find(p=>p.listId===id);
      if(!value) throw portfolioError('Liste nicht gefunden oder temporäre Liste abgelaufen.', 'LIST_NOT_FOUND', 404);
      return structuredClone(value);
    },
    async update(id, value) {
      if(temporary.has(id)) { temporary.set(id,{at:clock(),value}); return; }
      await serial(async()=>{
        const lists=[...await saved()], index=lists.findIndex(p=>p.listId===id);
        if(index<0) throw portfolioError('Liste nicht gefunden.', 'LIST_NOT_FOUND', 404);
        lists[index]=value; await persist(lists);
      });
    },
    async list(limit=30) { return (await saved()).slice(0,limit).map(p=>({
      id:p.listId, budget:p.budget, platform:p.platform, count:p.count,
      createdAt:p.createdAt, lastRecheckAt:p.lastRecheckAt||null
    })); }
  };
}
