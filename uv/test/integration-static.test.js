import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

test('active UV import graph cannot reach the retired provider, paid clients or shared Trader market',()=>{
  const seen=new Set();
  function walk(file){
    if(seen.has(file))return;seen.add(file);
    const code=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(code,/fut[._]?gg|api\.parse\.bot|api\.anakin\.io|getSharedMarketForUv/i,file);
    for(const m of code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){
      const child=path.resolve(path.dirname(file),m[1]);
      if(child.endsWith('.js'))walk(child);
    }
  }
  walk(path.join(root,'uvApp.js'));
  assert.ok(seen.size>5);
});

test('original UI keeps budget presets, save/recheck/rebalance, original styles and explicit unknown data labels',()=>{
  const html=read('public/index.html'),ui=read('public/app.js');
  for(const id of ['budget','generateBtn','recheckBtn','rebalanceBtn','savedListSelect','saveListChoice','minPrice','maxPrice','minGames','minSales'])
    assert.ok(html.includes('id="'+id+'"'),id);
  for(const value of ['100000','300000','500000','1000000','3000000','12000000'])
    assert.ok(html.includes('data-budget="'+value+'"'));
  assert.ok(html.includes('href="/uv/styles.css"'));
  assert.ok(html.includes('class="topbar"'));
  assert.ok(html.includes('class="generator panel compactGenerator"'));
  assert.ok(html.includes('Games/Sales derzeit nicht verfügbar'));
  assert.ok(ui.includes('Zielgewinn (rechnerisch)'));
  assert.doesNotMatch(html,/unsaved-live-v2108\.js|fut[._]?gg/i);
});
