import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuyPlan, buildPricing, optimizeList, optimizeListWithSeed, maxAffordablePortfolioCount, scoreCard, filterConservativeCandidates, buildLongTermProjection, buildSelectionScore, buildSellabilityScore, buildBudgetTop100Score, buildPublicTraderEndgameScore, buildTraderConsensusScore, buildBudgetTierProfile, buildBudgetTierScore } from '../src/uvEngine.js';

test('5% tax and conservative profit are calculated', () => {
  const p = buildPricing(20_000, 80, 80);
  assert.equal(p.eaTax, Math.floor(p.sellPrice * 0.05));
  assert.equal(p.netProfit, p.sellPrice - p.eaTax - p.buyPrice);
  assert.ok(p.netProfit <= 3000);
  assert.ok(p.netProfit >= 0);
});

test('smart buy ceiling stays realistic and never exceeds live market', () => {
  const plan = buildBuyPlan(
    { price: 20_000, futbinPrice: 19_750, riskPenalty: 14, confidenceScore: 55, popularityScore: 60, stability: 55, historyTrendPct: -4 },
    { avg1h: 19_800, stability: 55 }
  );
  assert.ok(plan.recommendedBuyPrice <= 20_000);
  assert.ok(plan.recommendedBuyPrice >= 19_400);
  assert.ok(plan.buyDiscountPct <= 3.1);
});

test('300k optimizer builds 100 cards without exceeding budget using recommended buy prices', () => {
  const cards = Array.from({ length: 260 }, (_, i) => ({
    eaId: i + 1,
    name: `Player ${i + 1}`,
    price: i < 100 ? 3200 : 1900 + ((i % 31) * 100),
    recommendedBuyPrice: i < 100 ? 3000 : 1800 + ((i % 31) * 100),
    uvScore: 70 + (i % 20),
    longTermScore: 65 + (i % 25),
    selectionScore: 72 + (i % 18),
    riskPenalty: i % 17 === 0 ? 7 : 0,
    rarityName: i % 4 === 0 ? 'Special Promo' : 'Gold',
    cardType: i % 4 === 0 ? 'Special' : 'Base Rare'
  }));
  const out = optimizeList(cards, 300_000, 100);
  assert.equal(out.selected.length, 100);
  const total = out.selected.reduce((sum, c) => sum + c.recommendedBuyPrice, 0);
  assert.ok(total <= 300_000);
  assert.equal(out.total, total);
  assert.equal(new Set(out.selected.map(c => c.eaId)).size, 100);
});

test('long term score rewards stable and active history', () => {
  const card = { price: 10000, sourceDiffPct: 1, marketMoverScore: 70 };
  const strong = scoreCard(card, { avg24h: 10000, avg1h: 10100, stability: 95, activityScore: 90, samples: 8 }, 10000, { stabilityScore: 80 });
  const weak = scoreCard(card, { avg24h: 10000, avg1h: 10100, stability: 30, activityScore: 25, samples: 8 }, 10000, { stabilityScore: 80 });
  assert.ok(strong.longTermScore > weak.longTermScore);
  assert.ok(strong.uvScore > weak.uvScore);
});

test('self-learning price safety improves ranking when evidence is strong', () => {
  const history = { avg24h: 10000, avg1h: 10000, stability: 80, activityScore: 72, samples: 8 };
  const market = { stabilityScore: 80 };
  const weak = scoreCard({ price: 10000, learning: { performanceScore: 35, evalCount: 6, horizonHours: 24, survivalRate: 0.4 } }, history, 10000, market);
  const strong = scoreCard({ price: 10000, learning: { performanceScore: 90, evalCount: 6, horizonHours: 24, survivalRate: 0.95 } }, history, 10000, market);
  assert.ok(strong.uvScore > weak.uvScore);
  assert.ok(strong.longTermScore > weak.longTermScore);
});

test('hard negative trend creates risk flag', () => {
  const card = { price: 9000, marketMoverScore: 45 };
  const out = scoreCard(card, { avg24h: 10500, avg1h: 10000, stability: 80, activityScore: 70, samples: 10 }, 9000, { stabilityScore: 80 });
  assert.ok(out.riskFlags.includes('starker Preisrückgang'));
  assert.ok(out.riskPenalty > 0);
});

test('conservative filter removes high-risk cards when enough safe cards exist', () => {
  const safe = Array.from({ length: 180 }, (_, i) => ({ eaId: i + 1, riskPenalty: 0, stability: 80, history: { samples: 5 }, historyTrendPct: 0 }));
  const risky = Array.from({ length: 30 }, (_, i) => ({ eaId: 1000 + i, riskPenalty: 24, stability: 15, history: { samples: 8 }, historyTrendPct: -12 }));
  const out = filterConservativeCandidates([...safe, ...risky], 100);
  assert.equal(out.length, 180);
  assert.ok(out.every(c => c.riskPenalty < 20));
});

test('real demand score raises UV and long-term ranking without inventing sales/day', () => {
  const history = { avg24h: 10000, avg1h: 10000, stability: 85, activityScore: 70, samples: 8 };
  const market = { stabilityScore: 80 };
  const base = scoreCard({ price: 10000, marketMoverScore: 60 }, history, 10000, market);
  const demanded = scoreCard({ price: 10000, marketMoverScore: 60, popularityScore: 90, demandEvidenceScore: 92, usagePct: 11 }, history, 10000, market);
  assert.ok(demanded.uvScore > base.uvScore);
  assert.ok(demanded.longTermScore > base.longTermScore);
  const projection = buildLongTermProjection({ ...demanded, usagePct: 11 }, buildPricing(10000, demanded.uvScore, demanded.longTermScore));
  assert.equal(projection.expectedSalesPerDay, null);
  assert.equal(projection.estimatedDailyProfit, null);
  assert.equal(projection.longTermMode, 'demand-backed-proxy');
  assert.ok(projection.turnoverIndex > 0);
});

test('trade quality rewards repeatable long-term profile over weak turnover', async () => {
  const strong = {
    price: 10000, recommendedBuyPrice: 9900, uvScore: 82, longTermScore: 86,
    confidenceScore: 84, riskPenalty: 0, popularityScore: 88, priceActivityScore: 84,
    learningScore: 82, usagePct: 9
  };
  const weak = {
    price: 10000, recommendedBuyPrice: 9900, uvScore: 62, longTermScore: 48,
    confidenceScore: 50, riskPenalty: 7, popularityScore: 35, priceActivityScore: 32,
    learningScore: 45
  };
  const { buildTradingEconomics } = await import('../src/uvEngine.js');
  const a = buildTradingEconomics(strong);
  const b = buildTradingEconomics(weak);
  assert.ok(a.tradeQualityScore > b.tradeQualityScore);
  assert.ok(a.capitalEfficiencyScore > b.capitalEfficiencyScore);
  assert.ok(['A+', 'A', 'B'].includes(a.qualityGrade));
  assert.ok(a.netProfit <= 3000);
});

test('selection score favors better trade quality when budget fit is similar', async () => {
  const { buildSelectionScore } = await import('../src/uvEngine.js');
  const shared = { longTermScore: 70, uvScore: 70, turnoverIndex: 65, capitalEfficiencyScore: 65, budgetFit: 90, popularityScore: 65, demandEvidenceScore: 65, learningScore: 60, riskPenalty: 0 };
  const high = buildSelectionScore({ ...shared, tradeQualityScore: 88 });
  const low = buildSelectionScore({ ...shared, tradeQualityScore: 52 });
  assert.ok(high > low);
});

test('v0.7 long-term-profit score rewards repeatable cards', async () => {
  const { buildTradingEconomics } = await import('../src/uvEngine.js');
  const repeatable = buildTradingEconomics({
    price: 12000, recommendedBuyPrice: 11800, uvScore: 84, longTermScore: 88,
    confidenceScore: 88, riskPenalty: 0, popularityScore: 90, demandEvidenceScore: 92,
    priceActivityScore: 86, learningScore: 84, stability: 88, usagePct: 12
  });
  const fragile = buildTradingEconomics({
    price: 12000, recommendedBuyPrice: 11800, uvScore: 68, longTermScore: 52,
    confidenceScore: 52, riskPenalty: 14, popularityScore: 40, demandEvidenceScore: 38,
    priceActivityScore: 35, learningScore: 42, stability: 38
  });
  assert.ok(repeatable.repeatabilityScore > fragile.repeatabilityScore);
  assert.ok(repeatable.longTermProfitScore > fragile.longTermProfitScore);
  assert.ok(repeatable.netProfit <= 3000);
});

test('v0.7 portfolio summary exposes adaptive capital bands', async () => {
  const { buildPortfolioSummary, capitalBandForPrice } = await import('../src/uvEngine.js');
  assert.equal(capitalBandForPrice(1000, 300000, 100), 'Budget');
  assert.equal(capitalBandForPrice(3000, 300000, 100), 'Core');
  assert.equal(capitalBandForPrice(5000, 300000, 100), 'Upper');
  assert.equal(capitalBandForPrice(8000, 300000, 100), 'Premium');
  const cards = [
    { recommendedBuyPrice: 1000, cardType: 'Base Rare', repeatabilityScore: 70, longTermProfitScore: 72 },
    { recommendedBuyPrice: 3000, cardType: 'Special', repeatabilityScore: 80, longTermProfitScore: 82 },
    { recommendedBuyPrice: 5000, cardType: 'Special', repeatabilityScore: 78, longTermProfitScore: 80 },
    { recommendedBuyPrice: 8000, cardType: 'Base Rare', repeatabilityScore: 74, longTermProfitScore: 76 }
  ];
  const p = buildPortfolioSummary(cards, 300000, 100);
  assert.equal(p.bands.Budget.count, 1);
  assert.equal(p.bands.Core.count, 1);
  assert.equal(p.bands.Upper.count, 1);
  assert.equal(p.bands.Premium.count, 1);
  assert.ok(p.portfolioScore > 0);
});

test('v0.7 higher budgets naturally allow a more expensive selected tail', () => {
  const cards = Array.from({ length: 600 }, (_, i) => {
    const price = i < 220 ? 500 + (i % 20) * 100 : 3000 + (i % 80) * 1000;
    return {
      eaId: i + 1, name: `Budget Player ${i + 1}`, price, recommendedBuyPrice: price,
      uvScore: 78, longTermScore: 78, selectionScore: 80, tradeQualityScore: 80,
      longTermProfitScore: 80, repeatabilityScore: 80, riskPenalty: 0,
      rarityName: i % 5 === 0 ? 'Promo' : 'Gold', cardType: i % 5 === 0 ? 'Special' : 'Base Rare'
    };
  });
  const low = optimizeList(cards, 300000, 100).selected.map(c => c.recommendedBuyPrice).sort((a,b)=>a-b);
  const high = optimizeList(cards, 1000000, 100).selected.map(c => c.recommendedBuyPrice).sort((a,b)=>a-b);
  const lowP90 = low[Math.floor(low.length * .9)];
  const highP90 = high[Math.floor(high.length * .9)];
  assert.ok(highP90 > lowP90);
});

test('v0.8 trader knowledge rewards popular stable liquid cards without inventing sales probability', async () => {
  const { buildTraderKnowledge } = await import('../src/traderKnowledge.js');
  const strong = buildTraderKnowledge({
    price: 12000, recommendedBuyPrice: 11800, popularityScore: 92, demandEvidenceScore: 94,
    liquidityScore: 88, stability: 90, confidenceScore: 88, priceActivityScore: 84,
    learningScore: 82, turnoverIndex: 86, usagePct: 12, cardType: 'Special', riskPenalty: 0
  }, { direction: 'stable', changePct: 0.5, stabilityScore: 82 }, 12000, new Map(), new Date('2026-08-29T19:00:00Z'));
  const weak = buildTraderKnowledge({
    price: 12000, recommendedBuyPrice: 11800, popularityScore: 35, demandEvidenceScore: 32,
    liquidityScore: 38, stability: 40, confidenceScore: 45, priceActivityScore: 35,
    learningScore: 42, turnoverIndex: 38, cardType: 'Special', riskPenalty: 14
  }, { direction: 'falling', changePct: -5, stabilityScore: 35 }, 12000, new Map(), new Date('2026-08-29T19:00:00Z'));
  assert.ok(strong.traderPriorScore > weak.traderPriorScore);
  assert.ok(strong.saleLikelihoodIndex > weak.saleLikelihoodIndex);
  assert.equal(strong.salesProbability, null);
  assert.equal(strong.chemStylePremiumScore, null);
});

test('v0.8 trader rule learning only nudges priors and uses price-safety evidence', async () => {
  const { buildTraderKnowledge } = await import('../src/traderKnowledge.js');
  const card = {
    price: 10000, recommendedBuyPrice: 9900, popularityScore: 88, demandEvidenceScore: 90,
    liquidityScore: 82, stability: 84, confidenceScore: 82, priceActivityScore: 80,
    learningScore: 76, turnoverIndex: 82, usagePct: 9, riskPenalty: 0
  };
  const neutral = buildTraderKnowledge(card, { direction: 'stable', stabilityScore: 80 }, 10000, new Map(), new Date('2026-08-27T12:00:00Z'));
  const learned = new Map([
    ['POPULAR_GAMEPLAY', { samples: 20, priceSafetyScore: 90 }],
    ['HIGH_TURNOVER', { samples: 20, priceSafetyScore: 88 }],
    ['CONSERVATIVE_PREMIUM', { samples: 20, priceSafetyScore: 86 }]
  ]);
  const tuned = buildTraderKnowledge(card, { direction: 'stable', stabilityScore: 80 }, 10000, learned, new Date('2026-08-27T12:00:00Z'));
  assert.ok(tuned.traderPriorScore > neutral.traderPriorScore);
  assert.ok(tuned.traderPriorScore - neutral.traderPriorScore <= 8.1);
  assert.ok(tuned.traderRuleLearningSamples >= 60);
});

test('v0.8 trader-aware pricing favors repeatable conservative profit over blind 3000 stretch', async () => {
  const { buildTraderAwarePricing } = await import('../src/uvEngine.js');
  const pricing = buildTraderAwarePricing({
    price: 20000, recommendedBuyPrice: 20000, uvScore: 82, longTermScore: 84,
    saleLikelihoodIndex: 76, traderPriorConfidence: 82, capitalLockRisk: 18, contentRiskScore: 15
  });
  assert.ok(pricing.netProfit > 0);
  assert.ok(pricing.netProfit <= 3000);
  assert.ok(pricing.requestedTargetProfit <= 2000);
  assert.equal(pricing.pricingMode, 'trader-prior+target-support+reported-outcome-optimizer');
  assert.ok(Array.isArray(pricing.pricingCandidates));
  assert.ok(pricing.pricingCandidates.length >= 5);
});

test('v0.9 in-packs supply pressure lowers ranking and flags falling supplied cards', () => {
  const history = { avg24h: 10500, avg1h: 10250, stability: 76, activityScore: 75, samples: 10 };
  const market = { stabilityScore: 70 };
  const clean = scoreCard({
    price: 10000, popularityScore: 84, demandEvidenceScore: 86, demandDataConfidence: 82,
    marketMoverScore: 62, supplyPressureScore: 0, inPacksHit: false
  }, history, 10000, market);
  const supplied = scoreCard({
    price: 10000, popularityScore: 84, demandEvidenceScore: 86, demandDataConfidence: 82,
    marketMoverScore: 62, supplyPressureScore: 72, inPacksHit: true
  }, history, 10000, market);
  assert.ok(clean.uvScore > supplied.uvScore);
  assert.ok(clean.longTermScore > supplied.longTermScore);
  assert.ok(supplied.riskFlags.includes('aktuell in Packs + fallender Preis'));
});

test('v0.9 richer real demand evidence raises confidence without creating fake sales fields', async () => {
  const { buildTraderKnowledge } = await import('../src/traderKnowledge.js');
  const out = buildTraderKnowledge({
    price: 15000, recommendedBuyPrice: 14800, popularityScore: 91, demandEvidenceScore: 93,
    demandDataConfidence: 90, communityUsagePct: 14, proUsagePct: 8, usagePositionCount: 3,
    liquidityScore: 84, stability: 86, confidenceScore: 84, priceActivityScore: 80,
    learningScore: 78, turnoverIndex: 82, cardType: 'Special', riskPenalty: 0,
    inPacksHit: false, supplyPressureScore: 0
  }, { direction: 'stable', changePct: 0.4, stabilityScore: 80 }, 15000, new Map(), new Date('2026-08-31T18:00:00Z'));
  assert.ok(out.gameplayDemandScore >= 75);
  assert.ok(out.traderPriorConfidence >= 70);
  assert.equal(out.salesProbability, null);
  assert.ok(out.traderKnowledge.ruleTags.includes('COMMUNITY_USAGE_EVIDENCE'));
  assert.ok(out.traderKnowledge.ruleTags.includes('PRO_USAGE_EVIDENCE'));
});


test('v1.2 selection score prefers Rare/Special over equal low-demand Base Common profiles', () => {
  const base = {
    overall: 85,
    tradeQualityScore: 75,
    longTermProfitScore: 72,
    repeatabilityScore: 70,
    longTermScore: 70,
    uvScore: 72,
    turnoverIndex: 68,
    capitalEfficiencyScore: 70,
    traderPriorScore: 68,
    saleLikelihoodIndex: 68,
    popularityScore: 60,
    demandDataConfidence: 55,
    targetSupportScore: 60,
    reportedOutcomeScore: 50,
    budgetFit: 75,
    learningScore: 50,
    capitalLockRisk: 15,
    contentRiskScore: 0,
    supplyPressureScore: 15,
    riskPenalty: 2
  };
  const common = buildSelectionScore({ ...base, cardType: 'Base Common' });
  const rare = buildSelectionScore({ ...base, cardType: 'Base Rare' });
  const special = buildSelectionScore({ ...base, cardType: 'Special' });
  assert.ok(rare > common);
  assert.ok(special > common);
});

test('v1.4 keeps the rating-quality pool and uses controlled repeats only when unique cards are too expensive', () => {
  const cards = Array.from({ length: 100 }, (_, i) => ({
    eaId: i + 1,
    name: `Quality ${i + 1}`,
    overall: 82 + (i % 5),
    price: 2500 + i * 20,
    recommendedBuyPrice: 2500 + i * 20,
    uvScore: 80,
    longTermScore: 80,
    selectionScore: 82,
    tradeQualityScore: 82,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  // 100 unique cards cost 349k, but allowing one second copy of approved cards
  // makes a 299k 100-slot portfolio feasible without lowering quality gates.
  const out = optimizeList(cards, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  assert.equal(out.repeatMode, true);
  const counts = new Map();
  for (const card of out.selected) counts.set(String(card.eaId), (counts.get(String(card.eaId)) || 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 3);
  assert.ok(out.repeatedSlots > 0);
});

test('v1.4 still keeps all cards unique when the budget is feasible without repeats', () => {
  const cards = Array.from({ length: 120 }, (_, i) => ({
    eaId: i + 1,
    name: `Unique ${i + 1}`,
    price: 2500,
    recommendedBuyPrice: 2500,
    uvScore: 80,
    longTermScore: 80,
    selectionScore: 82,
    tradeQualityScore: 82,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  const out = optimizeList(cards, 300000, 100);
  assert.equal(out.repeatMode, false);
  assert.equal(new Set(out.selected.map(c => c.eaId)).size, 100);
});

test('v2.7 300k portfolio has a soft 38% special-card target when comparable specials are affordable', async () => {
  const { specialTargetRatioForBudget } = await import('../src/uvEngine.js');
  assert.equal(specialTargetRatioForBudget(300000, 100), 0.38);
  const cards = Array.from({ length: 220 }, (_, i) => ({
    eaId: i + 1,
    name: `Mix ${i + 1}`,
    overall: 82 + (i % 6),
    price: 3000,
    recommendedBuyPrice: 3000,
    uvScore: 80,
    longTermScore: 80,
    selectionScore: 82,
    tradeQualityScore: 82,
    riskPenalty: 0,
    cardType: i < 70 ? 'Special' : 'Base Rare',
    rarityName: i < 70 ? 'Promo' : 'Rare'
  }));
  const out = optimizeList(cards, 300000, 100);
  const specials = out.selected.filter(c => c.cardType === 'Special').length;
  assert.ok(specials >= 34, `expected at least 34 specials, got ${specials}`);
  assert.ok(specials <= 48, `soft target should remain a mix, got ${specials}`);
  assert.ok(out.total <= 300000);
});

test('v1.5 special priority never forces expensive promos that would break the budget', () => {
  const specials = Array.from({ length: 80 }, (_, i) => ({
    eaId: i + 1,
    name: `Expensive Special ${i + 1}`,
    overall: 86,
    price: 10000,
    recommendedBuyPrice: 10000,
    uvScore: 82,
    longTermScore: 82,
    selectionScore: 86,
    tradeQualityScore: 84,
    riskPenalty: 0,
    cardType: 'Special',
    rarityName: 'Promo'
  }));
  const rares = Array.from({ length: 180 }, (_, i) => ({
    eaId: 1000 + i,
    name: `Affordable Rare ${i + 1}`,
    overall: 82 + (i % 5),
    price: 2500,
    recommendedBuyPrice: 2500,
    uvScore: 80,
    longTermScore: 80,
    selectionScore: 82,
    tradeQualityScore: 82,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  const out = optimizeList([...specials, ...rares], 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  const specialCount = out.selected.filter(c => c.cardType === 'Special').length;
  assert.ok(specialCount <= 9, `expensive specials must stay budget constrained, got ${specialCount}`);
});

test('v1.6 repeat fallback never creates a third exact copy', () => {
  const cards = Array.from({ length: 60 }, (_, i) => ({
    eaId: i + 1,
    name: `Endgame ${i + 1}`,
    overall: 85 + (i % 5),
    price: 2400 + (i % 6) * 100,
    recommendedBuyPrice: 2400 + (i % 6) * 100,
    uvScore: 82,
    longTermScore: 82,
    selectionScore: 84,
    tradeQualityScore: 84,
    riskPenalty: 0,
    cardType: i % 4 === 0 ? 'Special' : 'Base Rare',
    rarityName: i % 4 === 0 ? 'Promo' : 'Rare'
  }));
  const out = optimizeList(cards, 300000, 100);
  const counts = new Map();
  for (const card of out.selected) counts.set(String(card.eaId), (counts.get(String(card.eaId)) || 0) + 1);
  assert.ok(Math.max(...counts.values()) <= 2);
  assert.equal(out.selected.length, 100);
});

test('v1.6 fails honestly when even two copies cannot fit the requested budget', () => {
  const cards = Array.from({ length: 55 }, (_, i) => ({
    eaId: i + 1,
    name: `Pricy ${i + 1}`,
    overall: 85,
    price: 4000,
    recommendedBuyPrice: 4000,
    uvScore: 82,
    longTermScore: 82,
    selectionScore: 84,
    tradeQualityScore: 84,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  assert.throws(() => optimizeList(cards, 300000, 100), /maximal 2 Exemplaren/);
});

test('v1.6 seeded optimizer silently caps legacy third exact copy at two', () => {
  const candidates = Array.from({ length: 120 }, (_, i) => ({
    eaId: 1000 + i,
    name: `Replacement ${i}`,
    overall: 85,
    price: 2500,
    recommendedBuyPrice: 2500,
    uvScore: 82,
    longTermScore: 82,
    selectionScore: 84,
    tradeQualityScore: 84,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  const legacy = [1,2,3].map(() => ({
    eaId: 77,
    name: 'Legacy Triple',
    overall: 85,
    price: 2500,
    recommendedBuyPrice: 2500,
    uvScore: 90,
    longTermScore: 90,
    selectionScore: 90,
    tradeQualityScore: 90,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  const out = optimizeListWithSeed(candidates, 300000, 100, legacy);
  assert.equal(out.selected.filter(c => c.eaId === 77).length, 2);
});


test('v1.7 special target adapts to the qualified market mix instead of staying fixed', async () => {
  const { adaptiveSpecialTargetRatioForMarket } = await import('../src/uvEngine.js');
  const mk = (id, special) => ({
    eaId: id, name: `M${id}`, overall: 86, cardType: special ? 'Special' : 'Base Rare',
    price: 3000, recommendedBuyPrice: 3000, selectionScore: 80, tradeQualityScore: 80
  });
  const promoHeavy = Array.from({ length: 100 }, (_, i) => mk(3000 + i, i < 70));
  const promoLight = Array.from({ length: 100 }, (_, i) => mk(3200 + i, i < 10));
  const heavy = adaptiveSpecialTargetRatioForMarket(promoHeavy, 300000, 100);
  const light = adaptiveSpecialTargetRatioForMarket(promoLight, 300000, 100);
  assert.ok(heavy > light);
  assert.ok(heavy <= 0.45);
  assert.ok(light >= 0.12);
});


test('v2.0 affordable-count estimator reduces slots instead of forcing an impossible 100-card portfolio', () => {
  const cards = Array.from({ length: 70 }, (_, i) => ({
    eaId: i + 1,
    name: `Quality ${i + 1}`,
    overall: 86,
    price: 7000,
    recommendedBuyPrice: 7000,
    uvScore: 82,
    longTermScore: 82,
    selectionScore: 84,
    tradeQualityScore: 84,
    riskPenalty: 0,
    cardType: i % 4 === 0 ? 'Special' : 'Base Rare',
    rarityName: i % 4 === 0 ? 'Promo' : 'Rare'
  }));
  const estimate = maxAffordablePortfolioCount(cards, 300000, 100);
  assert.ok(estimate.count > 0);
  assert.ok(estimate.count < 100);
  assert.ok(estimate.minimumSpend <= 300000);
  const out = optimizeList(cards, 300000, estimate.count);
  assert.equal(out.selected.length, estimate.count);
  assert.ok(out.total <= 300000);
});


test('v2.1 special target rises for genuinely hot in-packs promos, not supply-only specials', async () => {
  const { adaptiveSpecialTargetRatioForMarket } = await import('../src/uvEngine.js');
  const mk = (id, hot) => ({
    eaId: id, name: `Promo${id}`, overall: 86, cardType: 'Special', rarityName: 'Current Promo',
    price: 3000, recommendedBuyPrice: 3000, selectionScore: 82, tradeQualityScore: 80,
    inPacksHit: true, momentumHit: hot, promoMarketScore: hot ? 80 : 42,
    gameplayDemandScore: hot ? 82 : 50, popularityScore: hot ? 82 : 50
  });
  const rares = Array.from({ length: 50 }, (_, i) => ({
    eaId: 9000 + i, name: `Rare${i}`, overall: 86, cardType: 'Base Rare', rarityName: 'Rare',
    price: 3000, recommendedBuyPrice: 3000, selectionScore: 78, tradeQualityScore: 78
  }));
  const hotMarket = [...Array.from({ length: 50 }, (_, i) => mk(8000 + i, true)), ...rares];
  const supplyOnly = [...Array.from({ length: 50 }, (_, i) => mk(8500 + i, false)), ...rares];
  const hotRatio = adaptiveSpecialTargetRatioForMarket(hotMarket, 300000, 100);
  const coldRatio = adaptiveSpecialTargetRatioForMarket(supplyOnly, 300000, 100);
  assert.ok(hotRatio > coldRatio);
  assert.ok(hotRatio <= 0.52);
  assert.ok(coldRatio >= 0.10);
});


test('v2.3 sellability score rewards FUT.GG/FUTBIN games, sales, popularity and healthy trend', () => {
  const base = {
    gameplayDemandScore: 60, popularityScore: 60, saleLikelihoodIndex: 60, turnoverIndex: 60,
    tradeQualityScore: 70, repeatabilityScore: 65, demandDataConfidence: 55, confidenceScore: 65,
    priceActivityScore: 60, trendScore: 60, stability: 70, reportedOutcomeScore: 55,
    promoMarketScore: 50, riskPenalty: 2, capitalLockRisk: 20, supplyPressureScore: 30
  };
  const weak = buildSellabilityScore({ ...base, futbinGamesScore: 40, futbinSalesEvidenceScore: 40 });
  const strong = buildSellabilityScore({
    ...base,
    gameplayDemandScore: 84,
    saleLikelihoodIndex: 82,
    turnoverIndex: 80,
    futbinGamesScore: 90,
    futbinSalesEvidenceScore: 86,
    futbinPopularRank: 85,
    communityUsagePct: 3.2,
    momentumHit: true,
    priceActivityScore: 82,
    trendScore: 88,
    reportedOutcomeScore: 78
  });
  assert.ok(strong > weak + 15);
});


test('v2.3.3 enables second-copy fallback when 100+ unique versions look cheap but player diversity makes unique-only infeasible', () => {
  const cards = [];
  let eaId = 50_000;

  // 60 liquid cards from 60 distinct players.
  for (let i = 0; i < 60; i++) {
    cards.push({
      eaId: eaId++,
      name: `Core Player ${i}`,
      price: 2100,
      recommendedBuyPrice: 2000,
      selectionScore: 72,
      tradeQualityScore: 68,
      riskPenalty: 0,
      cardType: 'Base Rare',
      rarityName: 'Rare'
    });
  }

  // 50 extra cheap versions concentrated on only ten of those players. Raw
  // unique-card count is now >100 and the naive 100-cheapest sum is below
  // 300k, but the max-three-slots-per-player rule makes unique-only impossible.
  for (let i = 0; i < 50; i++) {
    cards.push({
      eaId: eaId++,
      name: `Core Player ${i % 10}`,
      price: 2200,
      recommendedBuyPrice: 2100,
      selectionScore: 70,
      tradeQualityScore: 66,
      riskPenalty: 0,
      cardType: 'Special',
      rarityName: 'Promo'
    });
  }

  const affordable = maxAffordablePortfolioCount(cards, 300_000, 100);
  assert.equal(affordable.count, 100);
  assert.equal(affordable.repeatMode, true);

  const out = optimizeList(cards, 300_000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300_000);
  assert.equal(out.repeatMode, true);
  assert.ok(out.repeatedSlots > 0);
  const exactCounts = new Map();
  const playerCounts = new Map();
  for (const card of out.selected) {
    exactCounts.set(String(card.eaId), (exactCounts.get(String(card.eaId)) || 0) + 1);
    const player = String(card.name).toLowerCase();
    playerCounts.set(player, (playerCounts.get(player) || 0) + 1);
  }
  assert.ok([...exactCounts.values()].every(n => n <= 2));
  assert.ok([...playerCounts.values()].every(n => n <= 3));
});


test('v2.4 budget Top-100 score prefers sellable stable profitable cards at similar budget fit', () => {
  const common = {
    price: 3000, recommendedBuyPrice: 2900, budgetFit: 92, tradeQualityScore: 78,
    confidenceScore: 80, demandDataConfidence: 80, capitalEfficiencyScore: 75,
    riskPenalty: 0, capitalLockRisk: 10, netProfit: 1300
  };
  const strong = buildBudgetTop100Score({
    ...common, sellabilityScore: 88, stability: 86, gameplayDemandScore: 90, popularityScore: 88
  }, 3000);
  const weak = buildBudgetTop100Score({
    ...common, sellabilityScore: 48, stability: 45, gameplayDemandScore: 38, popularityScore: 40,
    confidenceScore: 52, demandDataConfidence: 45, netProfit: 450, capitalLockRisk: 45
  }, 3000);
  assert.ok(strong > weak);
  assert.ok(strong >= 70);
});

test('v2.4 optimizer can use budgetTop100Score while still respecting the total budget', () => {
  const cards = Array.from({ length: 220 }, (_, i) => ({
    eaId: i + 1,
    name: `Top100 ${i + 1}`,
    price: 2800 + (i % 9) * 50,
    recommendedBuyPrice: 2700 + (i % 9) * 50,
    selectionScore: 70,
    budgetTop100Score: i < 110 ? 90 : 45,
    tradeQualityScore: 75,
    uvScore: 75,
    longTermScore: 75,
    riskPenalty: 0,
    cardType: 'Base Rare',
    rarityName: 'Rare'
  }));
  const out = optimizeList(cards, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.selected.reduce((sum,c)=>sum+c.recommendedBuyPrice,0) <= 300000);
  const avgTop = out.selected.reduce((sum,c)=>sum+c.budgetTop100Score,0)/out.selected.length;
  assert.ok(avgTop > 60);
});


test('v2.5 public trader endgame score strongly prefers demanded FUTTIES and high-rated base over 82 filler', () => {
  const opts = { budget: 300000, count: 100, gameYear: 26, now: new Date('2026-09-06T00:00:00Z') };
  const low = buildPublicTraderEndgameScore({ overall: 82, cardType: 'Base Rare', league: 'Premier League', nation: 'England', gameplayDemandScore: 55, saleLikelihoodIndex: 55, priceActivityScore: 55, trendScore: 50, demandDataConfidence: 45, recommendedBuyPrice: 1000 }, opts);
  const high = buildPublicTraderEndgameScore({ overall: 87, cardType: 'Base Rare', league: 'Premier League', nation: 'England', gameplayDemandScore: 72, saleLikelihoodIndex: 70, priceActivityScore: 65, trendScore: 58, demandDataConfidence: 60, recommendedBuyPrice: 2800 }, opts);
  const futties = buildPublicTraderEndgameScore({ overall: 97, cardType: 'Special', rarityName: 'Futties', league: 'Premier League', nation: 'England', gameplayDemandScore: 88, saleLikelihoodIndex: 82, priceActivityScore: 75, trendScore: 65, demandDataConfidence: 75, usagePct: 6, momentumHit: true, recommendedBuyPrice: 9000 }, opts);
  assert.equal(low.active, true);
  assert.ok(high.score > low.score);
  assert.ok(futties.score > high.score);
  assert.ok(low.tags.includes('ENDGAME_82_PENALTY'));
  assert.ok(futties.tags.includes('FUTTIES_PRIORITY'));
});

test('v2.6 300k endgame optimizer caps normal 82s at 2 and all normal <=83 at 8', () => {
  const cards = [];
  let id = 1;
  for (let i = 0; i < 60; i++) cards.push({ eaId:id++, name:`Low82 ${i}`, overall:82, cardType:'Base Rare', recommendedBuyPrice:1500, price:1500, budgetTop100Score:96, selectionScore:90, tradeQualityScore:80, uvScore:80, riskPenalty:0, traderEndgameProfileActive:true });
  for (let i = 0; i < 60; i++) cards.push({ eaId:id++, name:`Low83 ${i}`, overall:83, cardType:'Base Rare', recommendedBuyPrice:2000, price:2000, budgetTop100Score:94, selectionScore:88, tradeQualityScore:80, uvScore:80, riskPenalty:0, traderEndgameProfileActive:true });
  for (let i = 0; i < 140; i++) cards.push({ eaId:id++, name:`High ${i}`, overall:84 + (i % 5), cardType:i % 7 === 0 ? 'Special' : 'Base Rare', rarityName:i % 7 === 0 ? 'Futties' : 'Rare', recommendedBuyPrice:3000, price:3000, budgetTop100Score:76, selectionScore:78, tradeQualityScore:78, uvScore:78, riskPenalty:0, traderEndgameProfileActive:true });
  const out = optimizeList(cards, 300000, 100);
  const base82 = out.selected.filter(c => c.cardType !== 'Special' && c.overall === 82).length;
  const base83OrLess = out.selected.filter(c => c.cardType !== 'Special' && c.overall <= 83).length;
  assert.equal(out.selected.length, 100);
  assert.ok(base82 <= 2, `base82=${base82}`);
  assert.ok(base83OrLess <= 8, `base<=83=${base83OrLess}`);
  assert.ok(out.total <= 300000);
});


test('v2.6 trader consensus prefers strong live demand and stable market over cheap 82 filler', () => {
  const opts = { budget: 300000, count: 100, gameYear: 26, now: new Date('2026-09-06T00:00:00Z') };
  const filler = buildTraderConsensusScore({
    overall: 82, cardType: 'Base Rare', recommendedBuyPrice: 900, budgetFit: 95,
    gameplayDemandScore: 45, saleLikelihoodIndex: 48, turnoverIndex: 46,
    priceActivityScore: 48, trendScore: 45, stability: 50, demandDataConfidence: 45,
    netProfit: 1100, riskPenalty: 0
  }, opts);
  const liquid = buildTraderConsensusScore({
    overall: 86, cardType: 'Base Rare', recommendedBuyPrice: 2800, budgetFit: 96,
    gameplayDemandScore: 78, saleLikelihoodIndex: 76, turnoverIndex: 74,
    priceActivityScore: 72, trendScore: 64, stability: 78, demandDataConfidence: 72,
    communityUsagePct: 4, netProfit: 1300, riskPenalty: 0
  }, opts);
  const futties = buildTraderConsensusScore({
    overall: 97, cardType: 'Special', rarityName: 'Futties', recommendedBuyPrice: 7000, budgetFit: 70,
    gameplayDemandScore: 90, saleLikelihoodIndex: 84, turnoverIndex: 82,
    priceActivityScore: 76, trendScore: 70, stability: 74, demandDataConfidence: 80,
    communityUsagePct: 6, momentumHit: true, promoMarketScore: 84, netProfit: 1600, riskPenalty: 0
  }, opts);
  assert.ok(liquid.score > filler.score, `liquid=${liquid.score} filler=${filler.score}`);
  assert.ok(futties.score > liquid.score, `futties=${futties.score} liquid=${liquid.score}`);
  assert.ok(filler.tags.includes('ENDGAME_LOW82'));
  assert.ok(futties.tags.includes('FUTTIES_DEMAND_BACKED'));
  assert.ok(futties.tags.includes('DEMAND_SPIKE'));
});


test('v2.7 budget tier profiles change portfolio shape by total budget, not rating', () => {
  const p500 = buildBudgetTierProfile(500000, 100);
  const p1m = buildBudgetTierProfile(1000000, 100);
  const p3m = buildBudgetTierProfile(3000000, 100);
  const p12m = buildBudgetTierProfile(12000000, 100);
  assert.equal(p500.name, 'FUTSTARZ_500K_SHAPE');
  assert.equal(p1m.name, 'FUTSTARZ_1M_SHAPE');
  assert.equal(p3m.name, 'FUTSTARZ_3M_SHAPE');
  assert.equal(p12m.name, 'FUTSTARZ_12M_SHAPE');
  assert.ok(p500.specialTargetRatio < p1m.specialTargetRatio);
  assert.ok(p1m.specialTargetRatio < p3m.specialTargetRatio);
  assert.ok(p3m.specialTargetRatio < p12m.specialTargetRatio);
  assert.equal(p12m.livePriceSource, 'FUT.GG');
  assert.equal(p12m.referenceMode, 'observed-shape-soft-prior');
});

test('v2.7 low-rated demanded special is not treated like low-rated normal filler', () => {
  const opts = { budget: 3000000, count: 100, gameYear: 26, now: new Date('2026-09-06T00:00:00Z') };
  const special = buildBudgetTierScore({
    overall: 84, cardType: 'Special', recommendedBuyPrice: 42000,
    gameplayDemandScore: 84, saleLikelihoodIndex: 80, turnoverIndex: 78,
    priceActivityScore: 74, stability: 76, demandDataConfidence: 78,
    usagePct: 4, momentumHit: true, netProfit: 1700, riskPenalty: 0
  }, opts);
  const normal = buildBudgetTierScore({
    overall: 84, cardType: 'Base Rare', recommendedBuyPrice: 42000,
    gameplayDemandScore: 50, saleLikelihoodIndex: 50, turnoverIndex: 50,
    priceActivityScore: 52, stability: 70, demandDataConfidence: 55,
    netProfit: 1700, riskPenalty: 0
  }, opts);
  assert.equal(special.versionClass, 'SPECIAL');
  assert.equal(normal.versionClass, 'NORMAL');
  assert.ok(special.tags.includes('LOW_RATED_SPECIAL_NOT_BASE_FILLER'));
  assert.ok(special.score > normal.score, `special=${special.score} normal=${normal.score}`);
});

test('v2.7 weak oversized position receives a concentration penalty but strong demand can soften it', () => {
  const opts = { budget: 12000000, count: 100, gameYear: 26, now: new Date('2026-09-06T00:00:00Z') };
  const weak = buildBudgetTierScore({
    overall: 97, cardType: 'Special', recommendedBuyPrice: 900000,
    gameplayDemandScore: 55, saleLikelihoodIndex: 52, turnoverIndex: 50,
    priceActivityScore: 55, stability: 70, demandDataConfidence: 55,
    netProfit: 2000, riskPenalty: 0
  }, opts);
  const strong = buildBudgetTierScore({
    overall: 97, cardType: 'Special', recommendedBuyPrice: 900000,
    gameplayDemandScore: 92, saleLikelihoodIndex: 88, turnoverIndex: 86,
    priceActivityScore: 82, stability: 80, demandDataConfidence: 84,
    usagePct: 8, momentumHit: true, netProfit: 2000, riskPenalty: 0
  }, opts);
  assert.ok(weak.tags.includes('POSITION_SIZE_PENALTY'));
  assert.ok(strong.tags.includes('POSITION_SIZE_PENALTY'));
  assert.ok(strong.score > weak.score);
});

test('v2.7 high-budget allocator keeps exactly 100 slots and raises special mix when comparable', () => {
  const cards = Array.from({ length: 260 }, (_, i) => ({
    eaId: i + 1,
    name: `Tier ${i + 1}`,
    overall: i < 170 ? 84 + (i % 15) : 86 + (i % 8),
    cardType: i < 170 ? 'Special' : 'Base Rare',
    rarityName: i < 170 ? 'Promo' : 'Rare',
    price: 30000,
    recommendedBuyPrice: 30000,
    uvScore: 80,
    longTermScore: 80,
    selectionScore: 82,
    budgetTop100Score: 82,
    tradeQualityScore: 82,
    riskPenalty: 0,
    traderEndgameProfileActive: true
  }));
  const out = optimizeList(cards, 3000000, 100);
  const specials = out.selected.filter(c => c.cardType === 'Special').length;
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 3000000);
  assert.ok(specials >= 58, `specials=${specials}`);
});


test('v2.9.1 allocator rescue returns the full portfolio when greedy tier selection dead-ends after feasibility was proven', () => {
  const cards = [
    {eaId:1,name:'P0',overall:83,cardType:'Special',recommendedBuyPrice:6000,price:6000,budgetTop100Score:87.48,selectionScore:65.88,tradeQualityScore:88.75,uvScore:85.99,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:2,name:'P1',overall:82,cardType:'Base Rare',recommendedBuyPrice:9300,price:9300,budgetTop100Score:93.84,selectionScore:60.62,tradeQualityScore:80.87,uvScore:70.10,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:3,name:'P2',overall:86,cardType:'Special',recommendedBuyPrice:11900,price:11900,budgetTop100Score:89.20,selectionScore:72.11,tradeQualityScore:93.39,uvScore:78.62,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:4,name:'P3',overall:86,cardType:'Special',recommendedBuyPrice:10800,price:10800,budgetTop100Score:61.67,selectionScore:56.71,tradeQualityScore:90.86,uvScore:63.77,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:5,name:'P3',overall:83,cardType:'Base Rare',recommendedBuyPrice:11900,price:11900,budgetTop100Score:79.02,selectionScore:50.27,tradeQualityScore:81.60,uvScore:80.17,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:6,name:'P3',overall:82,cardType:'Base Rare',recommendedBuyPrice:2200,price:2200,budgetTop100Score:91.47,selectionScore:74.31,tradeQualityScore:76.45,uvScore:90.11,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:7,name:'P4',overall:83,cardType:'Base Rare',recommendedBuyPrice:5900,price:5900,budgetTop100Score:92.64,selectionScore:62.98,tradeQualityScore:76.55,uvScore:94.15,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:8,name:'P5',overall:82,cardType:'Special',recommendedBuyPrice:8500,price:8500,budgetTop100Score:66.61,selectionScore:95.96,tradeQualityScore:78.59,uvScore:87.37,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:9,name:'P6',overall:85,cardType:'Base Rare',recommendedBuyPrice:12500,price:12500,budgetTop100Score:75.20,selectionScore:60.09,tradeQualityScore:72.04,uvScore:75.15,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:10,name:'P7',overall:82,cardType:'Base Rare',recommendedBuyPrice:2800,price:2800,budgetTop100Score:89.80,selectionScore:77.46,tradeQualityScore:81.54,uvScore:63.66,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:11,name:'P7',overall:83,cardType:'Special',recommendedBuyPrice:12900,price:12900,budgetTop100Score:98.30,selectionScore:97.30,tradeQualityScore:82.96,uvScore:66.57,riskPenalty:0,traderEndgameProfileActive:true},
    {eaId:12,name:'P7',overall:86,cardType:'Base Rare',recommendedBuyPrice:12700,price:12700,budgetTop100Score:95.13,selectionScore:86.00,tradeQualityScore:92.70,uvScore:80.37,riskPenalty:0,traderEndgameProfileActive:true}
  ];

  const affordability = maxAffordablePortfolioCount(cards, 100_000, 10);
  assert.equal(affordability.count, 10);

  const out = optimizeList(cards, 100_000, 10);
  assert.equal(out.selected.length, 10);
  assert.ok(out.total <= 100_000);
  assert.equal(out.allocationRescueUsed, true);
});
