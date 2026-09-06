import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetProfileKey, attachTargetLearningProfiles, targetLearningAdjustment } from '../src/targetLearning.js';
import { buildTraderAwarePricing } from '../src/uvEngine.js';

test('v0.10 target profile key separates price, profit, type, demand and supply', () => {
  const key = buildTargetProfileKey({ recommendedBuyPrice: 12000, cardType: 'Special', saleLikelihoodIndex: 76, inPacksHit: false }, 1500);
  assert.equal(key, 'P5000_15000|N1500_1999|SPECIAL|HIGH|OUT_OF_PACKS');
});

test('v0.10 target learning profiles attach only matching empirical rows', () => {
  const card = { recommendedBuyPrice: 12000, cardType: 'Special', saleLikelihoodIndex: 76, inPacksHit: false };
  const key = buildTargetProfileKey(card, 1500);
  const map = new Map([[key, { marketSamples: 18, marketSupportScore: 82, combinedSupportScore: 84, reportedFeedbackSamples: 3, reportedSellRate: 2/3 }]]);
  const profiles = attachTargetLearningProfiles(card, map, [1000, 1500, 2000]);
  assert.equal(Object.keys(profiles).length, 1);
  assert.equal(profiles['1500'].marketSamples, 18);
  assert.equal(profiles['1500'].reportedFeedbackSamples, 3);
});

test('v0.10 target learning nudge stays bounded and does not pretend to be probability', () => {
  const strong = targetLearningAdjustment({ combinedSupportScore: 95, marketSamples: 100, reportedFeedbackSamples: 20 });
  const weak = targetLearningAdjustment({ combinedSupportScore: 5, marketSamples: 100, reportedFeedbackSamples: 20 });
  assert.ok(strong.adjustment <= 7);
  assert.ok(weak.adjustment >= -7);
  assert.equal(targetLearningAdjustment(null).score, 50);
});

test('v0.10 empirical target support can steer pricing away from unsupported stretched targets', () => {
  const pricing = buildTraderAwarePricing({
    price: 20000,
    recommendedBuyPrice: 20000,
    uvScore: 84,
    longTermScore: 86,
    saleLikelihoodIndex: 78,
    traderPriorConfidence: 84,
    capitalLockRisk: 16,
    contentRiskScore: 12,
    targetLearningProfiles: {
      '1000': { combinedSupportScore: 62, marketSamples: 24, reportedFeedbackSamples: 0 },
      '1250': { combinedSupportScore: 78, marketSamples: 24, reportedFeedbackSamples: 2, reportedSellRate: 0.5 },
      '1500': { combinedSupportScore: 92, marketSamples: 30, reportedFeedbackSamples: 4, reportedSellRate: 0.75 },
      '1750': { combinedSupportScore: 70, marketSamples: 24, reportedFeedbackSamples: 0 },
      '2000': { combinedSupportScore: 48, marketSamples: 24, reportedFeedbackSamples: 0 },
      '2500': { combinedSupportScore: 28, marketSamples: 24, reportedFeedbackSamples: 0 },
      '3000': { combinedSupportScore: 18, marketSamples: 24, reportedFeedbackSamples: 0 }
    }
  });
  assert.ok(pricing.requestedTargetProfit <= 1750);
  assert.ok(pricing.targetSupportScore >= 70);
  assert.ok(pricing.targetSupportSamples > 0);
  assert.equal(pricing.salesProbability, null);
});
