import { clamp } from './utils.js';

// Public trader experience is treated as a weak prior, never as ground truth.
// The app only strengthens/weakens these priors with its own PostgreSQL price-
// safety outcomes. No sales/day figure or true sale probability is fabricated.
export const TRADER_KNOWLEDGE_SOURCES = Object.freeze([
  {
    id: 'pedsanut',
    name: 'PedsanUT',
    kind: 'methodology-prior',
    focus: ['popular/meta cards', 'broad transfer-list diversity', 'premium vs turnover trade-off']
  },
  {
    id: 'gamingalm',
    name: 'GamingAlm',
    kind: 'methodology-prior',
    focus: ['playable cards', 'conservative profit targets', 'capital turnover']
  },
  {
    id: 'tech-avion',
    name: 'TheDuffsFUT / Tech Avion',
    kind: 'methodology-prior',
    focus: ['special-card liquidity', 'capital lock avoidance', 'relisting discipline']
  },
  {
    id: 'zinhja',
    name: 'Zinhja',
    kind: 'methodology-prior',
    focus: ['supply/demand', 'content risk', 'market regime']
  },
  {
    id: 'bilythegame',
    name: 'BilyTheGame',
    kind: 'methodology-prior',
    focus: ['current-game popular cards', 'budget-aware list building', 'repeatable turnover']
  },
  {
    id: 'swepixtv',
    name: 'SwepixTV',
    kind: 'verified-public-uv-methodology',
    verifiedPublicUv: true,
    playerPicksImported: false,
    focus: ['FC26 overpriced-selling list building', 'budget allocation', 'player selection', 'relisting discipline'],
    evidence: 'Public FC26 videos explicitly cover Overpriced Selling and building a 100k ÜV list.'
  },
  {
    id: 'mm-tv',
    name: 'MM___TV',
    kind: 'verified-public-uv-methodology',
    verifiedPublicUv: true,
    playerPicksImported: false,
    focus: ['low-budget ÜV', 'turnover', 'repeatable list building', 'capital discipline'],
    evidence: 'Public FC26 community/profile references describe MM___TV as an ÜV low-budget trader.'
  },
  {
    id: 'noah-kai',
    name: 'Noah x Kai',
    kind: 'verified-public-uv-methodology',
    verifiedPublicUv: true,
    playerPicksImported: false,
    focus: ['ÜV', 'market updates', 'low-budget trading', 'independent trading education'],
    evidence: 'Their public FC26 page lists ÜV, market updates and low-budget trading; paid player picks are not imported.'
  }
]);

export const VERIFIED_PUBLIC_UV_SOURCE_IDS = Object.freeze(
  TRADER_KNOWLEDGE_SOURCES.filter(source => source.verifiedPublicUv).map(source => source.id)
);

function score(value, fallback = 50) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function marketRisk(marketContext = null) {
  const direction = String(marketContext?.direction || '').toLowerCase();
  const change = Number(marketContext?.changePct);
  const stability = score(marketContext?.stabilityScore, 55);
  let risk = clamp(62 - stability * 0.45, 8, 42);
  if (['down', 'falling', 'bearish', 'crash'].some(x => direction.includes(x))) risk += 14;
  if (Number.isFinite(change) && change < -3) risk += Math.min(18, Math.abs(change) * 2.2);
  if (Number.isFinite(change) && change > 5) risk += Math.min(8, change * 0.7); // pump/FOMO risk
  return clamp(risk, 0, 100);
}

function timePrior(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const weekend = day === 5 || day === 6 || day === 0;
  const evening = hour >= 17 && hour <= 23;
  // Intentionally weak. This is a trader prior, not proven FC26 sales data.
  return {
    weekend,
    evening,
    score: clamp(50 + (weekend ? 4 : 0) + (evening ? 3 : 0), 45, 60)
  };
}

function learnedRuleAdjustment(ruleTags, rulePerformance = new Map()) {
  const rows = [];
  for (const tag of ruleTags) {
    const row = rulePerformance.get(tag);
    if (row && Number(row.samples || 0) > 0) rows.push(row);
  }
  if (!rows.length) return { adjustment: 0, samples: 0, score: 50 };
  const samples = rows.reduce((s, r) => s + Number(r.samples || 0), 0);
  const weighted = rows.reduce((s, r) => s + Number(r.priceSafetyScore || 50) * Number(r.samples || 0), 0) / Math.max(1, samples);
  // Historical price safety may tune trader priors, but only modestly. It is
  // not a substitute for actual sales history.
  return {
    adjustment: clamp((weighted - 50) * 0.20, -8, 8),
    samples,
    score: clamp(weighted, 0, 100)
  };
}

function buildPublicUvMethodConsensus({
  budgetFit, turnover, demand, liquidity, stability, confidence, learning,
  demandConfidence, contentRiskScore, capitalLockRisk, supplyPressure
}) {
  const safeMarket = clamp(100 - contentRiskScore, 0, 100);
  const safeCapital = clamp(100 - capitalLockRisk, 0, 100);
  const safeSupply = clamp(100 - supplyPressure, 0, 100);

  // These are our transparent interpretations of public methodology themes,
  // NOT claims that a named trader currently recommends this specific card.
  const methodologySignals = [
    {
      sourceId: 'swepixtv',
      score: clamp(turnover * 0.25 + demand * 0.20 + budgetFit * 0.18 + liquidity * 0.14 + confidence * 0.10 + safeCapital * 0.08 + safeMarket * 0.05, 0, 100)
    },
    {
      sourceId: 'mm-tv',
      score: clamp(turnover * 0.28 + liquidity * 0.20 + demand * 0.18 + stability * 0.12 + confidence * 0.08 + safeCapital * 0.08 + safeSupply * 0.06, 0, 100)
    },
    {
      sourceId: 'noah-kai',
      score: clamp(demand * 0.21 + turnover * 0.20 + safeMarket * 0.16 + confidence * 0.14 + stability * 0.10 + learning * 0.08 + demandConfidence * 0.06 + safeSupply * 0.05, 0, 100)
    }
  ].map(signal => ({
    ...signal,
    source: TRADER_KNOWLEDGE_SOURCES.find(row => row.id === signal.sourceId)?.name || signal.sourceId,
    interpretation: signal.score >= 66 ? 'FAVORABLE' : signal.score <= 42 ? 'CAUTION' : 'NEUTRAL',
    actualLivePick: false
  }));

  const consensusIndex = methodologySignals.length
    ? methodologySignals.reduce((sum, row) => sum + row.score, 0) / methodologySignals.length
    : 50;
  const favorable = methodologySignals.filter(row => row.interpretation === 'FAVORABLE').length;
  const caution = methodologySignals.filter(row => row.interpretation === 'CAUTION').length;
  const confidenceIndex = clamp(
    38 + methodologySignals.length * 7 + demandConfidence * 0.12 + confidence * 0.08,
    35,
    82
  );
  // Very small nudge only. Live prices, risk, PostgreSQL outcomes and target
  // support remain substantially more important than external methodology.
  const adjustment = clamp((consensusIndex - 50) * 0.07, -3, 3);

  return { methodologySignals, consensusIndex, confidenceIndex, favorable, caution, adjustment };
}

export function buildTraderKnowledge(card, marketContext = null, idealPrice = null, rulePerformance = new Map(), now = new Date()) {
  const popularity = score(card?.popularityScore, 48);
  const demand = score(card?.demandEvidenceScore, popularity);
  const liquidity = score(card?.liquidityScore, 50);
  const stability = score(card?.stability, 52);
  const confidence = score(card?.confidenceScore, 50);
  const activity = score(card?.priceActivityScore, 50);
  const learning = score(card?.learningScore, 50);
  const turnover = score(card?.turnoverIndex, demand * 0.40 + activity * 0.30 + stability * 0.30);
  const riskPenalty = score(card?.riskPenalty, 0);
  const buyPrice = score(card?.recommendedBuyPrice || card?.price, 0);
  const ideal = Number.isFinite(idealPrice) && idealPrice > 0 ? idealPrice : buyPrice || 1;
  const usage = Number(card?.usagePct);
  const momentum = Boolean(card?.momentumHit);
  const demandConfidence = score(card?.demandDataConfidence, 45);
  const supplyPressure = score(card?.supplyPressureScore, 0);
  const usageBreadth = score(card?.usagePositionCount, 0);
  const special = String(card?.cardType || '').toLowerCase() === 'special';

  const gameplayDemandScore = clamp(
    demand * 0.38 + popularity * 0.22 + liquidity * 0.16 + (Number.isFinite(usage) ? clamp(55 + usage * 2.1, 50, 96) : 50) * 0.10 + demandConfidence * 0.08 + Math.min(6, usageBreadth * 1.5) + (momentum ? 4 : 0),
    0,
    100
  );

  const conveniencePremiumScore = clamp(
    gameplayDemandScore * 0.36 + liquidity * 0.24 + stability * 0.18 + confidence * 0.12 + activity * 0.10,
    0,
    100
  );

  const specialLiquidityScore = special
    ? clamp(liquidity * 0.34 + gameplayDemandScore * 0.30 + stability * 0.16 + confidence * 0.12 + learning * 0.08, 0, 100)
    : clamp(liquidity * 0.42 + gameplayDemandScore * 0.30 + stability * 0.18 + confidence * 0.10, 0, 100);

  const time = timePrior(now);
  const contentRiskScore = clamp(marketRisk(marketContext) + riskPenalty * 1.25, 0, 100);
  const budgetFit = score(card?.budgetFit, clamp(100 - Math.abs(Math.log(Math.max(1, buyPrice || ideal) / Math.max(1, ideal))) * 52, 0, 100));
  const priceStretch = buyPrice > 0 && ideal > 0 ? Math.max(0, Math.log(Math.max(1, buyPrice) / Math.max(1, ideal))) : 0;
  const capitalLockRisk = clamp(
    (100 - turnover) * 0.39 +
    (100 - gameplayDemandScore) * 0.22 +
    (100 - confidence) * 0.12 +
    contentRiskScore * 0.12 +
    supplyPressure * 0.10 +
    Math.min(22, priceStretch * 18) +
    riskPenalty * 0.55,
    0,
    100
  );

  const ruleTags = [];
  if (gameplayDemandScore >= 68) ruleTags.push('POPULAR_GAMEPLAY');
  if (turnover >= 66) ruleTags.push('HIGH_TURNOVER');
  if (special && specialLiquidityScore >= 64) ruleTags.push('SPECIAL_LIQUIDITY');
  if (time.weekend) ruleTags.push('WEEKEND_DEMAND_PRIOR');
  if (time.evening) ruleTags.push('EVENING_DEMAND_PRIOR');
  if (contentRiskScore >= 45) ruleTags.push('CONTENT_RISK_GUARD');
  if (capitalLockRisk >= 45) ruleTags.push('CAPITAL_LOCK_GUARD');
  if (card?.inPacksHit) ruleTags.push('IN_PACKS_SUPPLY_GUARD');
  if (Number.isFinite(card?.communityUsagePct)) ruleTags.push('COMMUNITY_USAGE_EVIDENCE');
  if (Number.isFinite(card?.proUsagePct)) ruleTags.push('PRO_USAGE_EVIDENCE');
  ruleTags.push('CONSERVATIVE_PREMIUM');

  const learningAdj = learnedRuleAdjustment(ruleTags, rulePerformance);
  const publicUvConsensus = buildPublicUvMethodConsensus({
    budgetFit, turnover, demand, liquidity, stability, confidence, learning,
    demandConfidence, contentRiskScore, capitalLockRisk, supplyPressure
  });
  const rawTraderPriorScore = clamp(
    gameplayDemandScore * 0.24 +
    conveniencePremiumScore * 0.19 +
    specialLiquidityScore * 0.12 +
    turnover * 0.18 +
    stability * 0.09 +
    confidence * 0.08 +
    learning * 0.05 +
    demandConfidence * 0.05 +
    time.score * 0.04 -
    contentRiskScore * 0.07 -
    supplyPressure * 0.04 -
    capitalLockRisk * 0.10,
    0,
    100
  );
  const traderPriorScore = clamp(rawTraderPriorScore + learningAdj.adjustment + publicUvConsensus.adjustment, 0, 100);

  const measurableEvidence = [
    Number.isFinite(card?.popularityScore), Number.isFinite(card?.demandEvidenceScore),
    Number.isFinite(card?.liquidityScore), Number.isFinite(card?.priceActivityScore),
    Number.isFinite(card?.usagePct), Number.isFinite(card?.communityUsagePct), Number.isFinite(card?.proUsagePct),
    Number.isFinite(card?.demandDataConfidence), Boolean(card?.momentumHit), Boolean(card?.inPacksHit), Number.isFinite(card?.stability),
    Number.isFinite(card?.confidenceScore), Number(card?.learning?.evalCount || 0) > 0
  ].filter(Boolean).length;
  const traderPriorConfidence = clamp(38 + measurableEvidence * 6 + Math.min(10, learningAdj.samples / 2), 35, 92);

  // Deliberately an ordinal index, NOT a probability percentage.
  const saleLikelihoodIndex = clamp(
    gameplayDemandScore * 0.28 +
    turnover * 0.25 +
    conveniencePremiumScore * 0.15 +
    stability * 0.11 +
    confidence * 0.08 +
    traderPriorScore * 0.13 -
    capitalLockRisk * 0.12 -
    contentRiskScore * 0.07,
    0,
    100
  );

  const knowledgeSignals = [];
  if (gameplayDemandScore >= 75) knowledgeSignals.push('starke Gameplay-/Popularitätsnachfrage');
  if (turnover >= 72) knowledgeSignals.push('guter Turnover-Proxy');
  if (special && specialLiquidityScore >= 70) knowledgeSignals.push('liquide Spezialkarte');
  if (capitalLockRisk >= 55) knowledgeSignals.push('Kapitalbindungsrisiko');
  if (contentRiskScore >= 50) knowledgeSignals.push('Content-/Marktrisiko');
  if (card?.inPacksHit) knowledgeSignals.push('aktuell in Packs: zusaetzlicher Supply-Druck');
  if ((card?.usagePositionCount || 0) >= 2) knowledgeSignals.push(`Most-Used-Nachfrage auf ${card.usagePositionCount} Positionen`);
  if (learningAdj.samples >= 5) knowledgeSignals.push(`Trader-Regeln mit ${learningAdj.samples} Preis-Sicherheitsauswertungen abgeglichen`);
  if (publicUvConsensus.favorable >= 2) knowledgeSignals.push(`öffentliche ÜV-Methoden passen ${publicUvConsensus.favorable}/3-fach zum Profil (keine Live-Picks)`);
  if (publicUvConsensus.caution >= 2) knowledgeSignals.push(`öffentliche ÜV-Methoden mahnen ${publicUvConsensus.caution}/3-fach zur Vorsicht`);

  return {
    traderKnowledge: {
      mode: learningAdj.samples > 0 ? 'public-trader-priors+postgres-price-safety-learning' : 'public-trader-priors',
      ruleTags,
      sources: TRADER_KNOWLEDGE_SOURCES.map(s => s.name),
      notice: 'Trader-Regeln sind nur schwache Priors. SwepixTV, MM___TV und Noah x Kai werden ausschließlich als öffentliche Methoden-Proxies verwendet; keine bezahlten oder nicht verifizierten Player-Picks werden importiert. Eigene PostgreSQL-Auswertungen dürfen Priors moderat hoch/runter gewichten. Ohne echte Sales-History werden weder Verkäufe/Tag noch echte Verkaufswahrscheinlichkeiten erfunden.',
      verifiedPublicUvSources: VERIFIED_PUBLIC_UV_SOURCE_IDS,
      publicMethodologySignals: publicUvConsensus.methodologySignals
    },
    gameplayDemandScore,
    conveniencePremiumScore,
    specialLiquidityScore,
    timeDemandScore: time.score,
    contentRiskScore,
    supplyPressureScore: supplyPressure,
    demandDataConfidence: demandConfidence,
    capitalLockRisk,
    traderPriorScore,
    traderPriorConfidence,
    traderRuleLearningScore: learningAdj.score,
    traderRuleLearningSamples: learningAdj.samples,
    traderMethodConsensusIndex: publicUvConsensus.consensusIndex,
    traderMethodConsensusConfidence: publicUvConsensus.confidenceIndex,
    traderMethodFavorableCount: publicUvConsensus.favorable,
    traderMethodCautionCount: publicUvConsensus.caution,
    traderMethodAdjustment: publicUvConsensus.adjustment,
    saleLikelihoodIndex,
    salesProbability: null,
    chemStylePremiumScore: null,
    chemStyleEvidence: false,
    knowledgeSignals
  };
}
