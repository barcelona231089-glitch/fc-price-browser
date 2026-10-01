import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUvPortfolioIntegrity, hasValidFutbinTradingEconomics } from '../uv/src/uvEngine.js';

function c(id, buy=10000, sell=12000) {
  const tax=Math.floor(sell*0.05);
  return { eaId:id, buyPrice:buy, sellPrice:sell, eaTax:tax, netProfit:sell-tax-buy };
}

test('v2.14 integrity guard accepts 100 real FC27 slots inside budget', () => {
  const cards=Array.from({length:100},(_,i)=>c(i+1));
  const r=assertUvPortfolioIntegrity(cards,{budget:1_000_000,count:100,gameYear:27});
  assert.equal(r.ok,true);
  assert.equal(r.taxRate,0.05);
});

test('v2.14 integrity guard rejects wrong season, wrong tax, synthetic and >3k profit', () => {
  const cards=Array.from({length:100},(_,i)=>c(i+1));
  assert.throws(()=>assertUvPortfolioIntegrity(cards,{budget:1_000_000,count:100,gameYear:26}),/season guard/);
  const badTax=cards.map(x=>({...x})); badTax[0].eaTax++;
  assert.throws(()=>assertUvPortfolioIntegrity(badTax,{budget:1_000_000,count:100,gameYear:27}),/Steuer-Guard/);
  const synthetic=cards.map(x=>({...x})); synthetic[0].synthetic=true;
  assert.throws(()=>assertUvPortfolioIntegrity(synthetic,{budget:1_000_000,count:100,gameYear:27}),/no-synthetic/);
  const stretch=cards.map(x=>({...x})); stretch[0]=c(1,10000,14000);
  assert.throws(()=>assertUvPortfolioIntegrity(stretch,{budget:1_000_000,count:100,gameYear:27}),/Profit-Cap/);
});


test('v2.15.23 FUTBIN economics gate only accepts observed sold-price economics', () => {
  const valid = {
    eaId: 1,
    buyPrice: 42_000,
    sellPrice: 45_500,
    eaTax: Math.floor(45_500 * 0.05),
    netProfit: 45_500 - Math.floor(45_500 * 0.05) - 42_000,
    sellPriceEvidence: 'FUTBIN_SOLD'
  };
  assert.equal(hasValidFutbinTradingEconomics(valid), true);
  assert.equal(hasValidFutbinTradingEconomics({ ...valid, sellPrice: null, eaTax: null, netProfit: null, sellPriceEvidence: 'MISSING_FUTBIN_SALES' }), false);
  assert.equal(hasValidFutbinTradingEconomics({ ...valid, sellPriceEvidence: 'MODELED' }), false);
  assert.equal(hasValidFutbinTradingEconomics({ ...valid, eaTax: valid.eaTax + 1 }), false);
});
