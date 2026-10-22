import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFc27GoldBase, verifiedHistoricalPgp, rankFc27ByGames } from '../src/futbinGamesFirst.js';

const row = ({ id = 506, rating = 83, games = 4_072_089, coins = 22_000, ...rest } = {}) => ({
  source:'FUTBIN', game:'FC27', platform:'console', evidence:'futbin-direct-json',
  priceType:'lowest_listing', salesVerified:false, playerId:String(id), resourceId:261855,
  playerName:'Francisca Ramos Nazareth Sousa', rating, cardType:'Gold Non Rare', coins,
  pgpEvidence:{futbinId:String(id),gameYear:27,platform:'console',rating,
    futbinGamesCount:games, futbinGamesObservedAt:'2026-10-09T20:00:00Z', source:'FUTBIN_PGP_HAR_SNAPSHOT'},
  ...rest
});

test('FC27 Gold no longer has official Common/Rare tiers', () => {
  for (const name of ['Gold','Gold Rare','Gold Non Rare','Gold Common']) {
    assert.equal(classifyFc27GoldBase({gameYear:27,rareTypeName:name}),'Gold');
  }
  assert.equal(classifyFc27GoldBase({gameYear:26,rareTypeName:'Gold Non Rare'}),null);
  assert.equal(classifyFc27GoldBase({gameYear:27,rareTypeName:'Team of the Week'}),null);
  assert.equal(classifyFc27GoldBase({gameYear:27,raretype:0}),null);
  assert.equal(classifyFc27GoldBase({gameYear:27,rareTypeName:'Gold Reward'}),null);
});
test('FC27 PGP accepts exact archived games and labels them historical', () => {
  const e=verifiedHistoricalPgp(row());
  assert.equal(e.games,4_072_089);
  assert.equal(e.live,false);
  assert.equal(e.historical,true);
  assert.equal(e.completedSalesVerified,false);
  assert.equal(e.buyAuthorized,false);
});
test('PGP mismatching item, rating, platform, year, source or values fails closed', () => {
  const good=row();
  for (const bad of [
    {...good,playerId:'507'}, {...good,rating:84},
    {...good,platform:'pc'}, {...good,game:'FC26'},
    {...good,pgpEvidence:{...good.pgpEvidence,gameYear:26}},
    {...good,pgpEvidence:{...good.pgpEvidence,futbinId:'999'}},
    {...good,pgpEvidence:{...good.pgpEvidence,source:'UNKNOWN'}},
    {...good,pgpEvidence:{...good.pgpEvidence,futbinGamesCount:null}},
    {...good,pgpEvidence:{...good.pgpEvidence,futbinGamesCount:0}},
    {...good,pgpEvidence:{...good.pgpEvidence,futbinGamesCount:1.5}},
    {...good,pgpEvidence:null}
  ]) assert.equal(verifiedHistoricalPgp(bad),null);
});
test('8M games beats 1M games despite higher purchase price', () => {
  const expensive=row({id:1,games:8_000_000,coins:25_000});
  const cheap=row({id:2,games:1_000_000,coins:700});
  const result=rankFc27ByGames([cheap,expensive],{budget:300_000});
  assert.deepEqual(result.candidates.map(x=>x.playerId),['1','2']);
  assert.equal(result.readyForTrading,false);
  assert.equal(result.candidates[0].tradeEligible,false);
});
test('missing PGP never gets replaced with cheap-price filler', () => {
  const unknown=row({id:11,coins:100,pgpEvidence:null});
  const result=rankFc27ByGames([unknown],{budget:300_000});
  assert.equal(result.candidates.length,0);
  assert.equal(result.excluded.missingOrMismatchedPgp,1);
  assert.equal(result.missingDataDoesNotPass,true);
});
test('threshold, budget and completed-sales guard', () => {
  const low=row({id:1,games:100,coins:500});
  const good=row({id:2,games:100_000,coins:1600});
  const costly=row({id:3,games:9_000_000,coins:500_000});
  const res=rankFc27ByGames([low,good,costly],{budget:300_000,minGames:10_000});
  assert.deepEqual(res.candidates.map(c=>c.playerId),['2']);
  assert.equal(res.excluded.belowGamesThreshold,1);
  assert.equal(res.excluded.invalidPrice,1);
  assert.equal(res.verifiedCompletedSales,0);
});
test('duplicate exact item is not counted twice',()=>{
  const source=row({id:777,games:50_000,coins:2200});
  const result=rankFc27ByGames([source,{...source,coins:2100}],{budget:300_000});
  assert.equal(result.candidates.length,1);
  assert.equal(result.candidates[0].coins,2100);
  assert.equal(result.excluded.duplicateItem,1);
  assert.equal(result.candidates[0].buyAuthorized,false);
});
test('claimed completed sales and non-FUTBIN sources cannot pass',()=>{
  const original=row({id:7,games:9_000_000,coins:600});
  const result=rankFc27ByGames([
    {...original,salesVerified:true},
    {...original,source:'FUT.GG'},
    {...original,evidence:'synthetic'}
  ],{budget:300000});
  assert.equal(result.candidates.length,0);
  assert.equal(result.excluded.invalidPrice,3);
});
test('invalid constraints rejected',()=>{
  assert.throws(()=>rankFc27ByGames([], {minGames:0}),/Invalid/);
  assert.throws(()=>rankFc27ByGames([], {budget:-1}),/Invalid/);
  assert.throws(()=>rankFc27ByGames([], {maxPrice:15000001}),/Invalid/);
});
