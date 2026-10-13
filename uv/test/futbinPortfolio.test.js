import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFutbinPortfolio, quoteCandidates, recheckFutbinPortfolio, normalizeFilters, targetScenario } from '../src/futbinPortfolio.js';

const now=Date.parse('2026-10-09T21:00:00Z');
const quote=(id,coins=800)=>({source:'FUTBIN',game:'FC27',platform:'console',
  playerId:String(id),resourceId:900000+id,playerName:'Fixture Player '+id,rating:84,
  cardType:'Gold Rare',position:'CM',club:'Fixture Club '+id%8,league:'Fixture League '+id%5,
  coins,capturedAt:new Date(now).toISOString(),sourceCheckedAt:'2026-10-09 21:50:00',
  evidence:'futbin-direct-json',priceType:'lowest_listing',salesVerified:false});
const pool=()=>Array.from({length:150},(_,i)=>quote(i+1,800+(i%5)*50));

test('original allocator stays within three budgets, 100 slots and exact-copy cap; no sales or buy authority invented',()=>{
  for(const budget of [95000,100000,300000]){
    const p=buildFutbinPortfolio(pool(),{budget,now});
    assert.equal(p.count,100);
    assert.ok(p.totalBuy<=budget);
    assert.equal(p.totalBuy,p.cards.reduce((s,c)=>s+c.price,0));
    assert.equal(p.unusedBudget,budget-p.totalBuy);
    assert.equal(p.totalExpectedProfit,null);
    const counts=new Map();
    for(const c of p.cards){
      counts.set(c.eaId,(counts.get(c.eaId)||0)+1);
      assert.equal(c.buyAuthorized,false);
      assert.equal(c.recommendedBuyPrice,null);
      assert.equal(c.buyMax,null);
      assert.equal(c.salesProbability,null);
      assert.equal(c.futbinGamesCount,null);
      assert.equal(c.salesHistoryAvailable,false);
      assert.equal(c.saleVerified,false);
      assert.equal(c.expectedProfit,null);
      assert.equal(c.netProfit,c.sellPrice-Math.floor(c.sellPrice*.05)-c.price);
      assert.ok(c.netProfit>=1000&&c.netProfit<=3000);
    }
    assert.ok([...counts.values()].every(n=>n<=2));
  }
});

test('price range excludes out-of-range quotes; unknown Games/Sales cannot pass positive filters',()=>{
  const result=buildFutbinPortfolio(pool(),{budget:100000,now,filters:{minPrice:850,maxPrice:900}});
  assert.ok(result.count>0&&result.count<=100);
  assert.ok(result.cards.every(c=>c.price>=850&&c.price<=900));
  for(const filters of [{minGames:1},{minSales:1},{minPrice:1500}]){
    const p=buildFutbinPortfolio(pool(),{budget:100000,now,filters});
    assert.equal(p.count,0);
    assert.equal(p.totalBuy,0);
    assert.equal(p.unusedBudget,100000);
  }
});

test('small budgets or small pools produce partial lists without exceeding the available plan',()=>{
  const p=buildFutbinPortfolio(pool(),{budget:30000,now});
  assert.ok(p.count>0&&p.count<100);
  assert.ok(p.totalBuy<=30000);
  const small=buildFutbinPortfolio(pool().slice(0,8),{budget:100000,now});
  assert.ok(small.count<=8);
  assert.equal(small.dynamicCountReduced,true);
});

test('wrong source, PC, older game, stale data, future data, ambiguous item IDs and untradeable versions are excluded',()=>{
  const cases=[
    {source:'OTHER_PROVIDER'},{game:'FC26'},{platform:'pc'},{resourceId:null},
    {cardType:'SBC Reward'},{cardType:'Gold Non Rare'},{cardType:'Unbekannt'},
    {coins:855},{rating:81},{capturedAt:new Date(now-31*60000).toISOString()},
    {capturedAt:new Date(now+5*60000).toISOString()},{salesVerified:true}
  ];
  for(const bad of cases) assert.equal(quoteCandidates([{...quote(1),...bad}],{now}).cards.length,0,JSON.stringify(bad));
  assert.equal(quoteCandidates([quote(1),{...quote(2),resourceId:900001}],{now}).cards.length,0);
});

test('recheck matches exact versions; missing quotes never retain a current price or purchase authorization',()=>{
  const p=buildFutbinPortfolio(pool().slice(0,4),{budget:100000,now});
  const changed=pool().slice(0,4).map(c=>({...c,coins:900}));
  changed.splice(1,1);
  const result=recheckFutbinPortfolio(p,changed,{now});
  assert.equal(result.summary.counts.MISSING,1);
  assert.equal(result.summary.counts.WATCH,3);
  assert.ok(result.cards.every(c=>c.buyAuthorized===false));
  assert.equal(result.cards.find(c=>c.status==='MISSING').currentPrice,null);
  assert.equal(result.cards.find(c=>c.status==='MISSING').fresh,null);
  assert.ok(result.cards.filter(c=>c.fresh).every(c=>c.fresh.buyPrice===900));
  assert.throws(()=>recheckFutbinPortfolio({...p,source:'OTHER_PROVIDER'},changed,{now}),/Quelle/);
});

test('invalid inputs fail explicitly; scenario calculations handle the market ceiling',()=>{
  for(const budget of [0,29999,100000001,NaN,30000.5])
    assert.throws(()=>buildFutbinPortfolio(pool(),{budget,now}),/Budget/);
  for(const filters of [{minPrice:2000,maxPrice:1000},{minGames:-1},{minSales:1.2},{maxPrice:'no'}])
    assert.throws(()=>normalizeFilters(filters),/Filter|Preis/);
  assert.equal(targetScenario(15000000).sellPrice,null);
});
