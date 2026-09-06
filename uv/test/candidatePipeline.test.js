import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidateGate, runCandidatePipeline } from '../src/candidatePipeline.js';

function card(id, overrides = {}) {
  return {
    eaId: id,
    name: `P${id}`,
    price: 3000,
    confidenceScore: 80,
    demandDataConfidence: 75,
    stability: 78,
    tradeQualityScore: 78,
    selectionScore: 76,
    riskPenalty: 4,
    capitalLockRisk: 20,
    supplyPressureScore: 20,
    historyTrendPct: 1,
    targetSupportScore: 70,
    targetSupportSamples: 20,
    reportedFeedbackSamples: 0,
    qualityEligible: true,
    history: { samples: 12 },
    ...overrides
  };
}

test('v1.0 robust candidate gate passes strong evidence', () => {
  const result = evaluateCandidateGate(card(1));
  assert.equal(result.candidateGateDecision, 'PASS');
  assert.ok(result.candidateGateScore >= 58);
});

test('v1.0 robust candidate gate rejects source divergence and crash risk', () => {
  const result = evaluateCandidateGate(card(2, { sourceDiffPct: 31, historyTrendPct: -12 }));
  assert.equal(result.candidateGateDecision, 'REJECT');
  assert.equal(result.candidateHardReject, true);
});

test('v1.0 pipeline never reintroduces hard rejects as fallback', () => {
  const safe = Array.from({ length: 4 }, (_, i) => card(i + 1));
  const hard = Array.from({ length: 20 }, (_, i) => card(100 + i, { sourceDiffPct: 40, riskPenalty: 30 }));
  const result = runCandidatePipeline([...safe, ...hard], 10);
  assert.equal(result.pool.length, 4);
  assert.equal(result.pool.some(c => c.candidateHardReject), false);
  assert.equal(result.diagnostics.hardRejected, 20);
});

test('bronze cards are hard blocked even if all other metrics look strong', () => {
  const result = evaluateCandidateGate(card(500, { overall: 64, rarityName: 'Rare Bronze' }));
  assert.equal(result.bronzeBlocked, true);
  assert.equal(result.candidateGateDecision, 'REJECT');
  assert.equal(result.candidateHardReject, true);
  assert.ok(result.candidateGateReasons.some(reason => reason.includes('Bronze')));
});

test('pipeline diagnostics expose the bronze hard block', () => {
  const safe = [card(1), card(2)];
  const bronze = card(600, { overall: 63, rarityName: 'Bronze' });
  const result = runCandidatePipeline([...safe, bronze], 2);
  assert.equal(result.diagnostics.bronzeHardBlock, true);
  assert.equal(result.diagnostics.bronzeRejected, 1);
  assert.equal(result.pool.some(c => c.bronzeBlocked), false);
});


test('low-rated gold non-rare cards are hard blocked even with otherwise strong metrics', () => {
  const result = evaluateCandidateGate(card(700, { overall: 82, cardType: 'Base Common', rarityName: 'Common' }));
  assert.equal(result.lowNonRareBlocked, true);
  assert.equal(result.candidateGateDecision, 'REJECT');
  assert.equal(result.candidateHardReject, true);
});

test('low-rated base rare is not hit by the non-rare demand gate', () => {
  const result = evaluateCandidateGate(card(701, { overall: 82, cardType: 'Base Rare', rarityName: 'Rare' }));
  assert.equal(result.lowNonRareBlocked, false);
  assert.equal(result.midNonRareDemandBlocked, false);
  assert.notEqual(result.candidateGateDecision, 'REJECT');
});

test('83-84 non-rare needs verified demand evidence', () => {
  const blocked = evaluateCandidateGate(card(702, { overall: 84, cardType: 'Base Common', rarityName: 'Common', popularityScore: 55, demandDataConfidence: 45 }));
  assert.equal(blocked.midNonRareDemandBlocked, true);
  assert.equal(blocked.candidateGateDecision, 'REJECT');

  const allowed = evaluateCandidateGate(card(703, { overall: 84, cardType: 'Base Common', rarityName: 'Common', popularityScore: 78, gameplayDemandScore: 78, demandDataConfidence: 70 }));
  assert.equal(allowed.verifiedDemandEvidence, true);
  assert.equal(allowed.midNonRareDemandBlocked, false);
  assert.notEqual(allowed.candidateGateDecision, 'REJECT');
});

test('real FUTBIN sold samples can rescue a mid-rated non-rare from the demand block', () => {
  const result = evaluateCandidateGate(card(704, { overall: 83, cardType: 'Base Common', rarityName: 'Common', futbinSoldSampleCount: 4, popularityScore: 50, demandDataConfidence: 45 }));
  assert.equal(result.verifiedDemandEvidence, true);
  assert.equal(result.midNonRareDemandBlocked, false);
  assert.notEqual(result.candidateGateDecision, 'REJECT');
});

test('300k / 100 portfolio hard blocks rating 79 and 80 regardless of rarity', () => {
  const r79 = evaluateCandidateGate(card(800, { overall: 79, cardType: 'Base Rare', rarityName: 'Rare' }), { budget: 300000, portfolioCount: 100 });
  const r80 = evaluateCandidateGate(card(801, { overall: 80, cardType: 'Special', rarityName: 'Special' }), { budget: 300000, portfolioCount: 100 });
  assert.equal(r79.ratingFloor, 82);
  assert.equal(r79.budgetRatingBlocked, true);
  assert.equal(r79.candidateGateDecision, 'REJECT');
  assert.equal(r80.budgetRatingBlocked, true);
  assert.equal(r80.candidateGateDecision, 'REJECT');
});

test('300k / 100 portfolio still allows rating 82 when other quality gates pass', () => {
  const result = evaluateCandidateGate(card(802, { overall: 82, cardType: 'Base Rare', rarityName: 'Rare' }), { budget: 300000, portfolioCount: 100 });
  assert.equal(result.ratingFloor, 82);
  assert.equal(result.budgetRatingBlocked, false);
  assert.notEqual(result.candidateGateDecision, 'REJECT');
});

test('budget rating floor adapts with portfolio budget', async () => {
  const { minimumRatingForBudget } = await import('../src/candidatePipeline.js');
  assert.equal(minimumRatingForBudget(50000, 100), 78);
  assert.equal(minimumRatingForBudget(100000, 100), 80);
  assert.equal(minimumRatingForBudget(200000, 100), 81);
  assert.equal(minimumRatingForBudget(300000, 100), 82);
  assert.equal(minimumRatingForBudget(600000, 100), 83);
  assert.equal(minimumRatingForBudget(1200000, 100), 84);
});

test('pipeline diagnostics report budget rating rejects', () => {
  const safe = Array.from({ length: 3 }, (_, i) => card(900 + i, { overall: 82, cardType: 'Base Rare', rarityName: 'Rare' }));
  const low = card(910, { overall: 80, cardType: 'Base Rare', rarityName: 'Rare' });
  const result = runCandidatePipeline([...safe, low], 3, { budget: 300000, portfolioCount: 100 });
  assert.equal(result.diagnostics.minimumRating, 82);
  assert.equal(result.diagnostics.budgetRatingGuard, true);
  assert.equal(result.diagnostics.budgetRatingRejected, 1);
  assert.equal(result.pool.some(c => Number(c.overall) < 82), false);
});

test('v1.6 FC26 endgame raises 300k/100 floor to 85 for normal cards', () => {
  const result = evaluateCandidateGate(card(1001, { overall: 84, cardType: 'Base Rare', rarityName: 'Rare' }), {
    budget: 300000,
    portfolioCount: 100,
    gameYear: 26,
    now: '2026-09-01T12:00:00Z'
  });
  assert.equal(result.seasonPhase, 'ENDGAME');
  assert.equal(result.ratingFloor, 85);
  assert.equal(result.seasonRatingBlocked, true);
  assert.equal(result.candidateGateDecision, 'REJECT');
});

test('v1.6 FC26 endgame allows rating 84 Special only with strong verified demand', () => {
  const weak = evaluateCandidateGate(card(1002, {
    overall: 84,
    cardType: 'Special',
    rarityName: 'Promo',
    popularityScore: 70,
    demandDataConfidence: 55
  }), {
    budget: 300000,
    portfolioCount: 100,
    gameYear: 26,
    now: '2026-09-01T12:00:00Z'
  });
  const strong = evaluateCandidateGate(card(1003, {
    overall: 84,
    cardType: 'Special',
    rarityName: 'Promo',
    futbinGamesCount: 1500000
  }), {
    budget: 300000,
    portfolioCount: 100,
    gameYear: 26,
    now: '2026-09-01T12:00:00Z'
  });
  assert.equal(weak.specialDemandException, false);
  assert.equal(weak.candidateGateDecision, 'REJECT');
  assert.equal(strong.specialDemandException, true);
  assert.equal(strong.seasonRatingBlocked, false);
  assert.notEqual(strong.candidateGateDecision, 'REJECT');
});

test('v1.6 FC27 early cycle automatically relaxes back to the budget floor', () => {
  const result = evaluateCandidateGate(card(1004, { overall: 82, cardType: 'Base Rare', rarityName: 'Rare' }), {
    budget: 300000,
    portfolioCount: 100,
    gameYear: 27,
    now: '2026-09-01T12:00:00Z'
  });
  assert.equal(result.seasonPhase, 'EARLY');
  assert.equal(result.ratingFloor, 82);
  assert.equal(result.seasonRatingBlocked, false);
  assert.notEqual(result.candidateGateDecision, 'REJECT');
});

test('v1.6 pipeline diagnostics expose season phase and special exceptions', () => {
  const cards = [
    card(1010, { overall: 85, cardType: 'Base Rare', rarityName: 'Rare' }),
    card(1011, { overall: 84, cardType: 'Special', rarityName: 'Promo', futbinGamesCount: 1500000 }),
    card(1012, { overall: 83, cardType: 'Base Rare', rarityName: 'Rare' })
  ];
  const out = runCandidatePipeline(cards, 2, {
    budget: 300000,
    portfolioCount: 100,
    gameYear: 26,
    now: '2026-09-01T12:00:00Z'
  });
  assert.equal(out.diagnostics.seasonPhase, 'ENDGAME');
  assert.equal(out.diagnostics.minimumRating, 85);
  assert.equal(out.diagnostics.special84DemandExceptions, 1);
  assert.equal(out.diagnostics.seasonRatingRejected, 1);
});


test('v2.1 promo/live-market policy raises floor when the liquid market is higher rated', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const market = Array.from({ length: 180 }, (_, i) => card(2000 + i, {
    overall: i < 140 ? 87 + (i % 3) : 85,
    cardType: i % 2 ? 'Special' : 'Base Rare',
    rarityName: i % 2 ? 'Promo' : 'Rare',
    gameplayDemandScore: 84,
    popularityScore: 84,
    saleLikelihoodIndex: 82,
    tradeQualityScore: 84,
    selectionScore: 83,
    demandDataConfidence: 80,
    communityUsagePct: 3
  }));
  const policy = deriveAdaptiveMarketPolicy(market, { budget: 300000, count: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' });
  assert.equal(policy.mode, 'PROMO_MARKET_ADAPTIVE_100');
  assert.ok(policy.minimumRating >= 86);
  assert.ok(policy.marketMedianRating >= 87);
  assert.equal(policy.calendarPhaseContextOnly, true);
});

test('v2.1 calendar endgame no longer hard-forces 85 when live liquid market sits lower', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const market = Array.from({ length: 160 }, (_, i) => card(2300 + i, {
    overall: 82 + (i % 3),
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 76,
    popularityScore: 76,
    saleLikelihoodIndex: 72,
    tradeQualityScore: 70,
    selectionScore: 70,
    demandDataConfidence: 58,
    repeatabilityScore: 62,
    communityUsagePct: 2
  }));
  const policy = deriveAdaptiveMarketPolicy(market, { budget: 300000, count: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' });
  assert.equal(policy.seasonPhase, 'ENDGAME');
  assert.equal(policy.calendarPhaseContextOnly, true);
  assert.ok(policy.minimumRating >= 82 && policy.minimumRating <= 84);
  assert.notEqual(policy.minimumRating, policy.seasonPriorFloor);
});

test('v2.1 supplied promo-market floor applies to every rarity', () => {
  const adaptivePolicy = { mode: 'PROMO_MARKET_ADAPTIVE', minimumRating: 86, preferredMinimumRating: 86, specialDemandExceptionRating: 85, marketQ25Rating: 86, marketMedianRating: 88, sampleSize: 120 };
  const low = evaluateCandidateGate(card(2500, { overall: 85, cardType: 'Base Rare', rarityName: 'Rare' }), {
    budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy
  });
  const high = evaluateCandidateGate(card(2501, { overall: 86, cardType: 'Base Rare', rarityName: 'Rare' }), {
    budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy
  });
  assert.equal(low.ratingPolicyMode, 'PROMO_MARKET_ADAPTIVE');
  assert.equal(low.ratingFloor, 86);
  assert.equal(low.marketRatingBlocked, true);
  assert.equal(low.candidateGateDecision, 'REJECT');
  assert.notEqual(high.candidateGateDecision, 'REJECT');
});

test('v2.1 detects hot promo market and allows only a one-rating in-packs promo exception with strong demand', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const market = Array.from({ length: 140 }, (_, i) => card(3000 + i, {
    overall: 86 + (i % 2),
    price: 4500,
    buyPrice: 4300,
    cardType: i < 90 ? 'Special' : 'Base Rare',
    rarityName: i < 90 ? 'Current Promo' : 'Rare',
    inPacksHit: i < 90,
    momentumHit: i < 65,
    promoMarketScore: i < 65 ? 78 : i < 90 ? 64 : 52,
    gameplayDemandScore: 84,
    popularityScore: 84,
    saleLikelihoodIndex: 80,
    tradeQualityScore: 80,
    selectionScore: 80,
    demandDataConfidence: 78,
    communityUsagePct: 3
  }));
  const policy = deriveAdaptiveMarketPolicy(market, { budget: 300000, count: 100, gameYear: 26 });
  assert.ok(['PROMO_ACTIVE', 'PROMO_HOT'].includes(policy.promoMarketRegime));
  assert.ok(policy.promoHeatScore >= 32);
  assert.ok(policy.promoInPacksSpecials > 0);

  const exception = card(3998, {
    overall: policy.specialDemandExceptionRating,
    cardType: 'Special',
    rarityName: 'Current Promo',
    inPacksHit: true,
    momentumHit: true,
    promoMarketScore: 82,
    futbinGamesCount: 1500000
  });
  const gate = evaluateCandidateGate(exception, { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  assert.equal(gate.specialDemandException, true);
  assert.notEqual(gate.candidateGateDecision, 'REJECT');
});

test('v2.1 low-rated 77 cannot enter a high live market just because it is a promo card', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const market = Array.from({ length: 150 }, (_, i) => card(4100 + i, {
    overall: 85 + (i % 3),
    cardType: i % 2 ? 'Special' : 'Base Rare',
    rarityName: i % 2 ? 'Current Promo' : 'Rare',
    inPacksHit: i % 2 === 1,
    momentumHit: true,
    promoMarketScore: 76,
    gameplayDemandScore: 82,
    popularityScore: 82,
    saleLikelihoodIndex: 80,
    tradeQualityScore: 80,
    selectionScore: 80,
    demandDataConfidence: 75,
    communityUsagePct: 3
  }));
  const policy = deriveAdaptiveMarketPolicy(market, { budget: 300000, count: 100, gameYear: 26 });
  assert.ok(policy.minimumRating >= 84);
  const lowPromo = card(4999, {
    overall: 77,
    cardType: 'Special',
    rarityName: 'Current Promo',
    inPacksHit: true,
    momentumHit: true,
    promoMarketScore: 95,
    futbinGamesCount: 5000000
  });
  const gate = evaluateCandidateGate(lowPromo, { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  assert.equal(gate.candidateGateDecision, 'REJECT');
  assert.equal(gate.marketRatingBlocked, true);
});

test('v2.3 impossible junk-only budget does not emit a shortened list or admit dead filler', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const high = Array.from({ length: 55 }, (_, i) => card(5000 + i, {
    overall: 86,
    price: 9000,
    buyPrice: 8500,
    cardType: i % 3 === 0 ? 'Special' : 'Base Rare',
    rarityName: i % 3 === 0 ? 'Current Promo' : 'Rare',
    inPacksHit: i % 3 === 0,
    promoMarketScore: 70,
    gameplayDemandScore: 84,
    saleLikelihoodIndex: 82,
    tradeQualityScore: 84,
    selectionScore: 83,
    demandDataConfidence: 80,
    communityUsagePct: 3
  }));
  const cheapDead = Array.from({ length: 120 }, (_, i) => card(5200 + i, {
    overall: 77 + (i % 4),
    price: 1000,
    buyPrice: 1000,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 42,
    popularityScore: 42,
    saleLikelihoodIndex: 45,
    tradeQualityScore: 60,
    selectionScore: 55,
    demandDataConfidence: 30,
    repeatabilityScore: 45
  }));
  const policy = deriveAdaptiveMarketPolicy([...high, ...cheapDead], { budget: 300000, count: 100, gameYear: 26 });
  assert.equal(policy.dynamicCountMode, false);
  assert.equal(policy.hardPortfolioCount, true);
  assert.equal(policy.budgetFeasible, false);
  assert.ok(policy.minimumRating >= 78);
  const gate = evaluateCandidateGate(cheapDead[0], { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  assert.equal(gate.candidateGateDecision, 'REJECT');
});

test('v2.3 demand-backed relaxation makes a hard 100-slot 300k portfolio feasible without dead filler', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const { optimizeList, maxAffordablePortfolioCount } = await import('../src/uvEngine.js');
  const expensive = Array.from({ length: 60 }, (_, i) => card(5700 + i, {
    overall: 88,
    price: 8500,
    buyPrice: 8000,
    recommendedBuyPrice: 8000,
    cardType: i % 3 === 0 ? 'Special' : 'Base Rare',
    rarityName: i % 3 === 0 ? 'Current Promo' : 'Rare',
    gameplayDemandScore: 88,
    popularityScore: 88,
    saleLikelihoodIndex: 86,
    tradeQualityScore: 84,
    selectionScore: 84,
    repeatabilityScore: 80,
    demandDataConfidence: 82,
    communityUsagePct: 4,
    futbinGamesScore: 86,
    futbinSalesEvidenceScore: 80
  }));
  const liquidBudget = Array.from({ length: 150 }, (_, i) => card(6000 + i, {
    overall: i % 3 === 0 ? 81 : 82,
    price: 2100 + (i % 8) * 100,
    buyPrice: 2000 + (i % 8) * 100,
    recommendedBuyPrice: 2000 + (i % 8) * 100,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 78,
    popularityScore: 78,
    saleLikelihoodIndex: 76,
    tradeQualityScore: 72,
    selectionScore: 72,
    repeatabilityScore: 68,
    demandDataConfidence: 66,
    communityUsagePct: 2,
    futbinGamesScore: 72,
    futbinSalesEvidenceScore: 68,
    priceActivityScore: 74,
    trendScore: 82
  }));
  const all = [...expensive, ...liquidBudget];
  const policy = deriveAdaptiveMarketPolicy(all, { budget: 300000, count: 100, gameYear: 26, now: '2026-09-03T12:00:00Z' });
  assert.equal(policy.hardPortfolioCount, true);
  assert.equal(policy.dynamicCountMode, false);
  assert.equal(policy.budgetFeasible, true);
  assert.ok(policy.minimumRating <= policy.preferredMinimumRating);
  const pipeline = runCandidatePipeline(all, 100, { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  const affordable = maxAffordablePortfolioCount(pipeline.pool, 300000, 100);
  assert.equal(affordable.count, 100);
  const out = optimizeList(pipeline.pool, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  assert.equal(out.selected.some(c => Number(c.overall) < 81), false);
});

test('v2.1 current live market can legitimately allow 84s even when calendar says endgame', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const market = Array.from({ length: 160 }, (_, i) => card(6000 + i, {
    overall: i % 4 === 0 ? 85 : 84,
    price: 2800,
    buyPrice: 2700,
    cardType: i % 5 === 0 ? 'Special' : 'Base Rare',
    rarityName: i % 5 === 0 ? 'Live Promo' : 'Rare',
    inPacksHit: i % 5 === 0,
    momentumHit: i % 6 === 0,
    promoMarketScore: i % 5 === 0 ? 68 : 55,
    gameplayDemandScore: 80,
    popularityScore: 80,
    saleLikelihoodIndex: 76,
    tradeQualityScore: 76,
    selectionScore: 76,
    demandDataConfidence: 70,
    communityUsagePct: 2.5
  }));
  const policy = deriveAdaptiveMarketPolicy(market, { budget: 300000, count: 100, gameYear: 26, now: '2026-09-01T12:00:00Z' });
  assert.equal(policy.seasonPhase, 'ENDGAME');
  assert.equal(policy.minimumRating, 84);
  assert.equal(policy.budgetFeasible, true);
});

test('v2.3.5 DEMAND_SELLABILITY_100 keeps estimator and gate aligned at the 82+ normal-card floor', async () => {
  const market = Array.from({ length: 120 }, (_, i) => card(9000 + i, {
    overall: 82,
    price: 2200,
    buyPrice: 2100,
    recommendedBuyPrice: 2100,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 72,
    popularityScore: 72,
    saleLikelihoodIndex: 68,
    tradeQualityScore: 62,
    selectionScore: 72,
    repeatabilityScore: 58,
    demandDataConfidence: 48,
    confidenceScore: 90,
    riskPenalty: 0,
    capitalLockRisk: 5,
    futbinGamesScore: 70,
    futbinSalesEvidenceScore: 70,
    priceActivityScore: 80,
    trendScore: 80
  }));
  const policy = {
    mode: 'PROMO_MARKET_ADAPTIVE_100',
    minimumRating: 82,
    preferredMinimumRating: 85,
    budgetFloor: 82,
    budgetRelaxed: true,
    budgetFeasible: true,
    relaxationDemandMode: 'DEMAND_SELLABILITY_100',
    specialDemandExceptionRating: 84
  };
  const pipeline = runCandidatePipeline(market, 100, { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  const { maxAffordablePortfolioCount } = await import('../src/uvEngine.js');
  assert.equal(maxAffordablePortfolioCount(pipeline.pool, 300000, 100).count, 100);
});

test('v2.3.5 staged sellability ladder can reach 100 affordable 82+ rare cards without dead filler', async () => {
  const { deriveAdaptiveMarketPolicy } = await import('../src/candidatePipeline.js');
  const { maxAffordablePortfolioCount } = await import('../src/uvEngine.js');
  const expensive = Array.from({ length: 45 }, (_, i) => card(9300 + i, {
    overall: 88,
    price: 9000,
    buyPrice: 8500,
    recommendedBuyPrice: 8500,
    cardType: 'Special',
    rarityName: 'Current Promo',
    gameplayDemandScore: 86,
    popularityScore: 86,
    saleLikelihoodIndex: 84,
    tradeQualityScore: 82,
    selectionScore: 82,
    repeatabilityScore: 76,
    demandDataConfidence: 78,
    momentumHit: true
  }));
  const liquidCheap = Array.from({ length: 170 }, (_, i) => card(9500 + i, {
    overall: 82 + (i % 4),
    price: 1900 + (i % 7) * 100,
    buyPrice: 1800 + (i % 7) * 100,
    recommendedBuyPrice: 1800 + (i % 7) * 100,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 62,
    popularityScore: 62,
    saleLikelihoodIndex: 58,
    tradeQualityScore: 54,
    selectionScore: 64,
    repeatabilityScore: 50,
    demandDataConfidence: 32,
    priceActivityScore: 70,
    trendScore: 72,
    historyTrendPct: 1
  }));
  const all = [...expensive, ...liquidCheap];
  const policy = deriveAdaptiveMarketPolicy(all, { budget: 300000, count: 100, gameYear: 26, now: '2026-09-04T00:00:00Z' });
  assert.equal(policy.hardPortfolioCount, true);
  assert.equal(policy.budgetFeasible, true);
  assert.ok(policy.minimumRating >= 82);
  assert.ok(['BALANCED', 'FEASIBILITY'].includes(policy.relaxationDemandMode));
  const pipeline = runCandidatePipeline(all, 100, { budget: 300000, portfolioCount: 100, gameYear: 26, adaptivePolicy: policy });
  assert.equal(maxAffordablePortfolioCount(pipeline.pool, 300000, 100).count, 100);
});

test('v2.3.5 hard-100 sellability fallback can bypass higher rating proxies but never the 82 normal-card floor', async () => {
  const { buildHard100SellabilityFallback } = await import('../src/candidatePipeline.js');
  const { maxAffordablePortfolioCount, optimizeList } = await import('../src/uvEngine.js');
  const liquid = Array.from({ length: 70 }, (_, i) => card(11000 + i, {
    overall: 82 + (i % 3),
    price: 2200 + (i % 6) * 100,
    buyPrice: 2100 + (i % 6) * 100,
    recommendedBuyPrice: 2100 + (i % 6) * 100,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 62,
    popularityScore: 64,
    saleLikelihoodIndex: 58,
    sellabilityScore: 58,
    tradeQualityScore: 54,
    selectionScore: 60,
    repeatabilityScore: 50,
    demandDataConfidence: 34,
    priceActivityScore: 70,
    trendScore: 70,
    historyTrendPct: 1,
    riskPenalty: 3,
    qualityEligible: true
  }));
  const fallback = buildHard100SellabilityFallback(liquid, { budget: 300000, count: 100 });
  assert.equal(fallback.budgetFeasible, true);
  assert.ok(fallback.uniqueCards >= 50);
  assert.equal(maxAffordablePortfolioCount(fallback.pool, 300000, 100).count, 100);
  const out = optimizeList(fallback.pool, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  assert.ok(out.selected.every(c => Number(c.overall) >= 82));
});

test('v2.3.2 hard-100 fallback still blocks bronze, low non-rare and dead cheap filler', async () => {
  const { buildHard100SellabilityFallback } = await import('../src/candidatePipeline.js');
  const good = Array.from({ length: 30 }, (_, i) => card(12000 + i, {
    overall: 82,
    price: 2300,
    recommendedBuyPrice: 2200,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 64,
    popularityScore: 64,
    saleLikelihoodIndex: 58,
    sellabilityScore: 58,
    tradeQualityScore: 55,
    selectionScore: 60,
    repeatabilityScore: 50,
    demandDataConfidence: 34,
    priceActivityScore: 68,
    trendScore: 68
  }));
  const bronze = card(13001, { overall: 64, price: 400, recommendedBuyPrice: 400, rarityName: 'Bronze Rare', cardType: 'Base Rare', sellabilityScore: 90 });
  const nonRare = card(13002, { overall: 82, price: 800, recommendedBuyPrice: 800, rarityName: 'Common', cardType: 'Base Common', sellabilityScore: 90 });
  const dead = card(13003, {
    overall: 80, price: 700, recommendedBuyPrice: 700, rarityName: 'Rare', cardType: 'Base Rare',
    gameplayDemandScore: 35, popularityScore: 35, saleLikelihoodIndex: 40, sellabilityScore: 38,
    tradeQualityScore: 44, selectionScore: 45, repeatabilityScore: 42, demandDataConfidence: 20,
    priceActivityScore: 40, trendScore: 40
  });
  const fallback = buildHard100SellabilityFallback([...good, bronze, nonRare, dead], { budget: 300000, count: 100 });
  const ids = new Set(fallback.pool.map(c => Number(c.eaId)));
  assert.equal(ids.has(13001), false);
  assert.equal(ids.has(13002), false);
  assert.equal(ids.has(13003), false);
});


test('v2.3.5 budget-adaptive fallback reaches 100 at 300k with sellable 82+ rares while keeping the normal-card floor', async () => {
  const { buildHard100SellabilityFallback, buildBudgetAdaptiveSellabilityFallback } = await import('../src/candidatePipeline.js');
  const { maxAffordablePortfolioCount, optimizeList } = await import('../src/uvEngine.js');

  const expensive = Array.from({ length: 65 }, (_, i) => card(14000 + i, {
    overall: 90,
    price: 9800 + (i % 5) * 300,
    buyPrice: 9500 + (i % 5) * 300,
    recommendedBuyPrice: 9500 + (i % 5) * 300,
    cardType: 'Special',
    rarityName: 'Endgame Promo',
    gameplayDemandScore: 82,
    popularityScore: 82,
    saleLikelihoodIndex: 78,
    sellabilityScore: 76,
    tradeQualityScore: 72,
    selectionScore: 74,
    repeatabilityScore: 68,
    demandDataConfidence: 70,
    priceActivityScore: 68,
    trendScore: 62,
    historyTrendPct: 1
  }));

  // These are the cards v2.3.3 missed in the live case: affordable Base Rares
  // with coherent demand/activity, but a late-cycle rating/selection proxy that
  // pushes their ordinary candidate score below the old absolute floor.
  const cheapSellable = Array.from({ length: 70 }, (_, i) => card(15000 + i, {
    overall: 82 + (i % 4),
    price: 2200 + (i % 6) * 100,
    buyPrice: 2100 + (i % 6) * 100,
    recommendedBuyPrice: 2100 + (i % 6) * 100,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 53,
    popularityScore: 54,
    saleLikelihoodIndex: 50,
    sellabilityScore: 48,
    tradeQualityScore: 39,
    selectionScore: 34,
    repeatabilityScore: 42,
    demandDataConfidence: 30,
    confidenceScore: 58,
    priceActivityScore: 52,
    trendScore: 48,
    historyTrendPct: 0.5,
    riskPenalty: 4,
    qualityEligible: false
  }));

  const universe = [...expensive, ...cheapSellable];
  const oldFallback = buildHard100SellabilityFallback(universe, { budget: 300000, count: 100 });
  assert.equal(oldFallback.budgetFeasible, false);

  const adaptive = buildBudgetAdaptiveSellabilityFallback(universe, { budget: 300000, count: 100 });
  assert.equal(adaptive.budgetFeasible, true);
  assert.equal(adaptive.idealSlotPrice, 3000);
  assert.equal(maxAffordablePortfolioCount(adaptive.pool, 300000, 100).count, 100);

  const out = optimizeList(adaptive.pool, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  assert.ok(out.selected.every(c => String(c.cardType || '').toLowerCase() === 'special' || Number(c.overall) >= 82));
  assert.ok(out.selected.every(c => String(c.rarityName || '').toLowerCase().includes('bronze') === false));
});

test('v2.3.5 budget-adaptive fallback refuses dead filler, sub-82 normal cards and low-rated Non-Rare', async () => {
  const { buildBudgetAdaptiveSellabilityFallback } = await import('../src/candidatePipeline.js');
  const good = Array.from({ length: 40 }, (_, i) => card(16000 + i, {
    overall: 82,
    price: 2400,
    recommendedBuyPrice: 2300,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 55,
    popularityScore: 56,
    saleLikelihoodIndex: 51,
    sellabilityScore: 49,
    tradeQualityScore: 40,
    selectionScore: 36,
    repeatabilityScore: 42,
    demandDataConfidence: 32,
    priceActivityScore: 52,
    trendScore: 48,
    qualityEligible: false
  }));
  const dead = card(17001, {
    overall: 80, price: 900, recommendedBuyPrice: 900, cardType: 'Base Rare', rarityName: 'Rare',
    gameplayDemandScore: 25, popularityScore: 25, saleLikelihoodIndex: 35, sellabilityScore: 30,
    tradeQualityScore: 38, selectionScore: 30, repeatabilityScore: 32, demandDataConfidence: 15,
    priceActivityScore: 30, trendScore: 30
  });
  const nonRare = card(17002, {
    overall: 82, price: 900, recommendedBuyPrice: 900, cardType: 'Base Common', rarityName: 'Common',
    gameplayDemandScore: 90, saleLikelihoodIndex: 90, sellabilityScore: 90, tradeQualityScore: 90,
    repeatabilityScore: 90, priceActivityScore: 90, trendScore: 90
  });
  const bronze = card(17003, {
    overall: 64, price: 400, recommendedBuyPrice: 400, cardType: 'Base Rare', rarityName: 'Bronze Rare',
    gameplayDemandScore: 90, saleLikelihoodIndex: 90, sellabilityScore: 90, tradeQualityScore: 90,
    repeatabilityScore: 90, priceActivityScore: 90, trendScore: 90
  });
  const adaptive = buildBudgetAdaptiveSellabilityFallback([...good, dead, nonRare, bronze], { budget: 300000, count: 100 });
  const ids = new Set(adaptive.pool.map(c => Number(c.eaId)));
  assert.equal(ids.has(17001), false);
  assert.equal(ids.has(17002), false);
  assert.equal(ids.has(17003), false);
});


test('v2.3.5 hard floor blocks a 75 normal Rare but allows a strongly demanded sub-82 Special', async () => {
  const { buildBudgetAdaptiveSellabilityFallback } = await import('../src/candidatePipeline.js');
  const commonSignals = {
    price: 2200, recommendedBuyPrice: 2100,
    gameplayDemandScore: 88, popularityScore: 88, saleLikelihoodIndex: 80, sellabilityScore: 82,
    tradeQualityScore: 74, selectionScore: 72, repeatabilityScore: 70, demandDataConfidence: 78,
    priceActivityScore: 72, trendScore: 68, historyTrendPct: 1, qualityEligible: true
  };
  const lowNormal = card(18001, { ...commonSignals, overall: 75, cardType: 'Base Rare', rarityName: 'Rare' });
  const weakSpecial = card(18002, { ...commonSignals, overall: 81, cardType: 'Special', rarityName: 'Promo', gameplayDemandScore: 65, popularityScore: 65, demandDataConfidence: 50 });
  const strongSpecial = card(18003, { ...commonSignals, overall: 81, cardType: 'Special', rarityName: 'Promo', futbinGamesCount: 1_200_000 });
  const normal82 = card(18004, { ...commonSignals, overall: 82, cardType: 'Base Rare', rarityName: 'Rare' });
  const adaptive = buildBudgetAdaptiveSellabilityFallback([lowNormal, weakSpecial, strongSpecial, normal82], { budget: 300000, count: 100 });
  const ids = new Set(adaptive.pool.map(c => Number(c.eaId)));
  assert.equal(ids.has(18001), false);
  assert.equal(ids.has(18002), false);
  assert.equal(ids.has(18003), true);
  assert.equal(ids.has(18004), true);
});

test('v2.4.2 safety reserve reaches 100 unique affordable 82+ rares when ranking ladders are too strict', async () => {
  const { buildHard100SellabilityFallback, buildBudgetAdaptiveSellabilityFallback, buildBudgetSafetyReserveFallback } = await import('../src/candidatePipeline.js');
  const { maxAffordablePortfolioCount, optimizeList } = await import('../src/uvEngine.js');

  const moderate82Plus = Array.from({ length: 110 }, (_, i) => card(19000 + i, {
    name: `Reserve${i}`,
    overall: 82 + (i % 4),
    price: 2200 + (i % 5) * 50,
    buyPrice: 2100 + (i % 5) * 50,
    recommendedBuyPrice: 2100 + (i % 5) * 50,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 49,
    popularityScore: 49,
    saleLikelihoodIndex: 40,
    sellabilityScore: 38,
    tradeQualityScore: 35,
    selectionScore: 35,
    budgetTop100Score: 55 + (i % 10),
    repeatabilityScore: 40,
    demandDataConfidence: 30,
    confidenceScore: 58,
    priceActivityScore: 36,
    trendScore: 32,
    historyTrendPct: 0,
    riskPenalty: 4,
    qualityEligible: true
  }));

  const oldHard = buildHard100SellabilityFallback(moderate82Plus, { budget: 300000, count: 100 });
  const oldAdaptive = buildBudgetAdaptiveSellabilityFallback(moderate82Plus, { budget: 300000, count: 100 });
  assert.equal(oldHard.budgetFeasible, false);
  assert.equal(oldAdaptive.budgetFeasible, false);

  const reserve = buildBudgetSafetyReserveFallback(moderate82Plus, { budget: 300000, count: 100 });
  assert.equal(reserve.budgetFeasible, true);
  assert.ok(reserve.uniqueCards >= 100);
  assert.equal(maxAffordablePortfolioCount(reserve.pool, 300000, 100).count, 100);

  const out = optimizeList(reserve.pool, 300000, 100);
  assert.equal(out.selected.length, 100);
  assert.ok(out.total <= 300000);
  assert.equal(new Set(out.selected.map(c => String(c.eaId))).size, 100);
  assert.ok(out.selected.every(c => Number(c.overall) >= 82));
});


test('v2.7.1 safety reserve does not stop at structural 100 when endgame mix can only allocate 66', async () => {
  const { buildBudgetSafetyReserveFallback } = await import('../src/candidatePipeline.js');

  const balanced = Array.from({ length: 52 }, (_, i) => card(27000 + i, {
    name: `MixBalanced${i}`,
    overall: i < 29 ? 84 : 83,
    price: 1300,
    buyPrice: 1250,
    recommendedBuyPrice: 1250,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 49,
    popularityScore: 49,
    saleLikelihoodIndex: 42,
    sellabilityScore: 40,
    tradeQualityScore: 36,
    selectionScore: 50,
    budgetTop100Score: 58,
    repeatabilityScore: 40,
    demandDataConfidence: 30,
    confidenceScore: 58,
    priceActivityScore: 38,
    trendScore: 34,
    historyTrendPct: 0,
    riskPenalty: 4,
    qualityEligible: true,
    traderEndgameProfileActive: true
  }));

  const budgetStageHigh = Array.from({ length: 21 }, (_, i) => card(27100 + i, {
    name: `MixBudget${i}`,
    overall: 84,
    price: 1350,
    buyPrice: 1300,
    recommendedBuyPrice: 1300,
    cardType: 'Base Rare',
    rarityName: 'Rare',
    gameplayDemandScore: 49,
    popularityScore: 49,
    saleLikelihoodIndex: 40,
    sellabilityScore: 38,
    tradeQualityScore: 35,
    selectionScore: 49,
    budgetTop100Score: 56,
    repeatabilityScore: 39,
    demandDataConfidence: 30,
    confidenceScore: 56,
    priceActivityScore: 36,
    trendScore: 32,
    historyTrendPct: 0,
    riskPenalty: 4,
    qualityEligible: true,
    traderEndgameProfileActive: true
  }));

  const reserve = buildBudgetSafetyReserveFallback([...balanced, ...budgetStageHigh], { budget: 300000, count: 100 });
  assert.ok(reserve.diagnostics.length >= 2);
  assert.equal(reserve.diagnostics[0].slots, 100);
  assert.equal(reserve.diagnostics[0].allocatorSlots, 66);
  assert.equal(reserve.allocatorSlots, 100);
  assert.equal(reserve.budgetFeasible, true);
});

test('v2.4.2 safety reserve still hard-blocks bronze, sub-82 normal and weak 82 Non-Rare filler', async () => {
  const { buildBudgetSafetyReserveFallback } = await import('../src/candidatePipeline.js');
  const safe = card(20000, {
    overall: 82, price: 2200, recommendedBuyPrice: 2100, cardType: 'Base Rare', rarityName: 'Rare',
    gameplayDemandScore: 50, saleLikelihoodIndex: 42, sellabilityScore: 40, tradeQualityScore: 36,
    repeatabilityScore: 40, priceActivityScore: 38, trendScore: 34, budgetTop100Score: 55
  });
  const lowNormal = card(20001, { ...safe, eaId: 20001, overall: 81, cardType: 'Base Rare', rarityName: 'Rare' });
  const bronze = card(20002, { ...safe, eaId: 20002, overall: 64, cardType: 'Base Rare', rarityName: 'Bronze Rare' });
  const weakNonRare = card(20003, { ...safe, eaId: 20003, overall: 82, cardType: 'Base Common', rarityName: 'Common' });
  const reserve = buildBudgetSafetyReserveFallback([safe, lowNormal, bronze, weakNonRare], { budget: 300000, count: 100 });
  const ids = new Set(reserve.pool.map(c => Number(c.eaId)));
  assert.equal(ids.has(20000), true);
  assert.equal(ids.has(20001), false);
  assert.equal(ids.has(20002), false);
  assert.equal(ids.has(20003), false);
});
