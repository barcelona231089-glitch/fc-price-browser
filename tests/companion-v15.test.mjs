import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../browser-companion');
const manifest = JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));

test('companion v1.5 automatically bridges local FC27 application', () => {
  assert.equal(manifest.version,'1.5.0');
  const bridge = manifest.content_scripts.find(s => s.js.includes('bridge.js'));
  assert.ok(bridge.matches.includes('http://127.0.0.1:5187/*'));
  const player = manifest.content_scripts.find(s => s.js.includes('futbin-prices.js'));
  assert.ok(player.matches.includes('https://*.futbin.com/27/player/*'));
});

test('visible FUTBIN console and PC prices are captured with evidence, no duplicate scans', async () => {
  const source = fs.readFileSync(path.join(folder,'futbin-prices.js'),'utf8');
  const captures = [];
  const boxes = { ps: '54K', pc: '66K' };
  let observer;
  const document = {
    documentElement: {},
    querySelector(selector) {
      if (selector === 'h1') return {textContent:' Testspieler '};
      const platform = selector.endsWith('platform-ps-only') ? 'ps' :
        selector.endsWith('platform-pc-only') ? 'pc' : null;
      return platform ? { querySelector() {return {textContent:boxes[platform]};} } : null;
    }
  };
  class FakeObserver {
    constructor(cb) { this.callback=cb;observer=this; }
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(source, {
    location:{pathname:'/27/player/506',hostname:'www.futbin.com'},
    chrome:{runtime:{sendMessage(message,callback) {captures.push(message);callback?.();},lastError:null}},
    document, MutationObserver:FakeObserver, window:{addEventListener(){}},
    setTimeout, clearTimeout, Date, JSON, Number, String
  });
  assert.equal(captures.length,1);
  assert.equal(captures[0].payload.playerId,'506');
  assert.equal(captures[0].payload.playerName,'Testspieler');
  assert.equal(captures[0].payload.prices[0].price,54000);
  assert.equal(captures[0].payload.prices[1].price,66000);
  observer.callback();
  await new Promise(resolve=>setTimeout(resolve,380));
  assert.equal(captures.length,1, 'unchanged DOM must not update freshness');
  boxes.ps='55K';
  observer.callback();
  await new Promise(resolve=>setTimeout(resolve,380));
  assert.equal(captures.length,2);
  assert.equal(captures[1].payload.prices[0].price,55000);
});
