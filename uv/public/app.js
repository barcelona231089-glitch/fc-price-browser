const $ = s => document.querySelector(s);
const btn = $('#generateBtn');
const loading = $('#loading');
const rows = $('#rows');
const summary = $('#summary');
const notice = $('#notice');
const filter = $('#filter');
const recheckBtn = $('#recheckBtn');
const rebalanceBtn = $('#rebalanceBtn');
const savedListSelect = $('#savedListSelect');
const loadSavedBtn = $('#loadSavedBtn');
const saveListChoice = $('#saveListChoice');
const budgetPresetButtons = [...document.querySelectorAll('.budgetPreset')];
const statusFilters = [...document.querySelectorAll('.statusFilter')];
let lastCards = [];
let lastListId = null;
let lastCheckedListId = null;
let activeStatusFilter = 'ALL';
const expandedRows = new Set();

const coins = n => new Intl.NumberFormat('de-DE').format(Math.round(Number(n || 0)));
const pct = n => `${Number(n || 0).toFixed(1)} %`;
const trendLabel = v => v === 'rising' ? '📈 steigend' : v === 'falling' ? '📉 fallend' : v === 'stable' ? '➖ stabil' : '❔ unbekannt';
const finite = v => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v));

async function loadStatus(){
  try{
    const r = await fetch('/api/uv/status'); const s = await r.json();
    const badge = $('#statusBadge');
    const fullStatus = `FC${s.gameYear} • FUT.GG ${s.currentCapabilities.futggLivePrices?'✓':'×'} • Nachfrage ${s.currentCapabilities.futggMostUsedDemand?'✓':'×'} • DB ${s.databaseConfigured?'✓':'×'} • Lernen ${s.currentCapabilities.selfLearningPriceSafety?'✓':'–'} • Bronze ${s.currentCapabilities.bronzeHardBlock?'BLOCK':'?'} • Normal<82 ${s.currentCapabilities.normalCardMinimumRating===82?'BLOCK':'?'} • NR≤82 ${s.currentCapabilities.nonRareDemandGate?'BLOCK':'?'} • Special ${s.currentCapabilities.specialCardPriority?'PRIO':'?'} • Dynamik ${s.currentCapabilities.dynamicMarketPolicy?'✓':'?'} • Promo/Markt ${s.currentCapabilities.promoMarketAdaptive?'✓':'?'} • Trader-Consensus ${s.currentCapabilities.traderConsensusRanker?'✓':'–'} • Budget-Tier ${s.currentCapabilities.budgetTierAllocator?'✓':'–'} • Max× ${s.currentCapabilities.maxExactCardCopies||'?'} • FUTBIN ${s.futbinParseConfigured?'✓':'–'} • Games ${s.currentCapabilities.pgpGames?'✓':'–'} • Sales ${s.currentCapabilities.playerSalesHistory?'✓':'–'} • v${s.version}`;
    badge.textContent = `FC${s.gameYear} • FUT.GG ${s.currentCapabilities.futggLivePrices?'✓':'×'} • DB ${s.databaseConfigured?'✓':'×'} • Promo/Markt ${s.currentCapabilities.promoMarketAdaptive?'✓':'?'} • Consensus ${s.currentCapabilities.traderConsensusRanker?'✓':'–'} • Tier ${s.currentCapabilities.budgetTierAllocator?'✓':'–'} • Dynamik ${s.currentCapabilities.dynamicMarketPolicy?'✓':'?'} • v${s.version}`;
    badge.title = fullStatus;
    badge.classList.add('good');
  }catch{ $('#statusBadge').textContent='Status nicht erreichbar'; }
}

function metric(label,value,green=false){return `<div class="metric"><span>${label}</span><strong class="${green?'green':''}">${value}</strong></div>`}

function renderSummary(data){
  const primary = [
    metric('Budget',`${coins(data.budget)} 🪙`),
    metric('Einkauf',`${coins(data.totalBuy)} 🪙`,true),
    metric('Slots',`${data.count}${data.dynamicCountReduced?' • dynamisch':''}`,true),
    metric('Specials',`${data.specialCount||0} / ${data.count}`),
    metric('Profit 1×',`${coins(data.totalExpectedProfit)} 🪙`,true)
  ].join('');

  const details = [
    metric('Ziel-Slots',`${data.requestedCount||data.count}`),
    metric('Unterschiedliche Karten',`${data.uniqueCardCount||data.count} / ${data.count}`),
    metric('Wiederholungs-Slots',`${data.repeatedSlots||0} / ${data.count}`),
    metric('Budget genutzt',pct(data.budgetUsagePct)),
    metric('Ø Langfrist-Score',`${Number(data.avgLongTermScore).toFixed(1)}/100`),
    metric('Ø Daten-Sicherheit',`${Number(data.avgConfidence).toFixed(0)}/100`),
    metric('Ø Preisaktivität',`${Number(data.avgActivity).toFixed(0)}/100`),
    metric('Ø Nachfrage',`${Number(data.avgPopularity).toFixed(0)}/100`),
    metric('Nachfrage-Treffer',`${data.demandMatches} / ${data.count}`),
    metric('Community-Usage',`${data.communityUsageMatches||0} / ${data.count}`),
    metric('Pro-Usage',`${data.proUsageMatches||0} / ${data.count}`),
    metric('Multi-Position Usage',`${data.multiPositionUsageMatches||0} / ${data.count}`),
    metric('In Packs',`${data.inPacksCount||0} / ${data.count}`),
    metric('FUTTIES',`${data.futtiesCount||0} / ${data.count}`,true),
    metric('Normal 82',`${data.base82Count||0} / ${data.count}`),
    metric('Normal 83',`${data.base83Count||0} / ${data.count}`),
    metric('Normal 84+',`${data.base84PlusCount||0} / ${data.count}`,true),
    metric('Ø Trader-Endgame',`${Number(data.avgPublicTraderEndgameScore||50).toFixed(0)}/100`),
    metric('Ø Trader-Consensus',`${Number(data.avgTraderConsensusScore||50).toFixed(0)}/100`,true),
    metric('Ø Budget-Tier',`${Number(data.avgBudgetTierScore||50).toFixed(0)}/100`,true),
    metric('Budget-Tier-Profil',`${data.budgetTierProfile||data.candidatePriceRange?.tierProfile||'–'}`),
    metric('Special-Versionen',`${data.specialVersionCount??data.specialCount??0} / ${data.count}`),
    metric('Normal-Versionen',`${data.normalVersionCount??Math.max(0,(data.count||0)-(data.specialCount||0))} / ${data.count}`),
    metric('82-Max (Endgame)',`${data.traderMixPolicy?.active?data.traderMixPolicy.maxBase82:'–'}`),
    metric('≤83-Max (Endgame)',`${data.traderMixPolicy?.active?data.traderMixPolicy.maxBase83OrLess:'–'}`),
    metric('≤84 Normal-Max (1M+)',`${data.traderMixPolicy?.premiumBudgetGuard?data.traderMixPolicy.maxBase84OrLess:'–'}`),
    metric('≤86 Normal-Max (1M+)',`${data.traderMixPolicy?.premiumBudgetGuard?data.traderMixPolicy.maxBase86OrLess:'–'}`),
    metric('Ø Nachfrage-Datenqualität',`${Number(data.avgDemandDataConfidence||0).toFixed(0)}/100`),
    metric('FUTBIN Games-Daten',`${data.futbinGamesMatches||0} / ${data.count}`),
    metric('FUTBIN echte Sales',`${data.futbinSalesHistoryMatches||0} / ${data.count}`),
    metric('FUTBIN Realpreis-Median',`${data.futbinRealSalePriceMatches||0} / ${data.count}`),
    metric('Ø Games-Signal',`${Number(data.avgFutbinGamesScore||0).toFixed(0)}/100`),
    metric('Ø Sales-Evidence',`${Number(data.avgFutbinSalesEvidence||0).toFixed(0)}/100`),
    metric('Ø Trade-Qualität',`${Number(data.avgTradeQuality).toFixed(0)}/100`,true),
    metric('A/A+ Karten',`${data.gradeACount} / ${data.count}`),
    metric('Ø Kapital-Effizienz',`${Number(data.avgCapitalEfficiency).toFixed(0)}/100`),
    metric('Ø Wiederholbarkeit',`${Number(data.avgRepeatability).toFixed(0)}/100`),
    metric('Ø Langfrist-Profit',`${Number(data.avgLongTermProfitScore).toFixed(0)}/100`,true),
    metric('Ø Trader-Wissen',`${Number(data.avgTraderPriorScore||0).toFixed(0)}/100`,true),
    metric('Ø ÜV-Methoden-Consensus',`${Number(data.avgTraderMethodConsensus||50).toFixed(0)}/100`),
    metric('Ø Sale-Likelihood-Index',`${Number(data.avgSaleLikelihoodIndex||0).toFixed(0)}/100`),
    metric('Ø Kapitalbindungsrisiko',`${Number(data.avgCapitalLockRisk||0).toFixed(0)}/100`),
    metric('Ø Ziel-Support',`${Number(data.avgTargetSupportScore||50).toFixed(0)}/100`,true),
    metric('Ziel-Lernhistorie',`${data.targetLearningMatches||0} / ${data.count}`),
    metric('Gemeldete echte Outcomes',`${data.reportedFeedbackMatches||0} / ${data.count}`),
    metric('Pipeline PASS',`${data.candidatePipeline?.pass||0}`),
    metric('Pipeline CAUTION',`${data.candidatePipeline?.caution||0}`),
    metric('Pipeline hart raus',`${data.candidatePipeline?.hardRejected||0}`),
    metric('Strategie',`${String(data.candidatePipeline?.ratingPolicyMode||'').includes('PROMO_MARKET')?'PROMO + LIVE MARKET':'DYNAMIC MARKET'}`,true),
    metric('Markt-Regime',`${data.candidatePipeline?.promoMarketRegime||'–'}`,true),
    metric('Promo-Heat',`${finite(data.candidatePipeline?.promoHeatScore)?Number(data.candidatePipeline.promoHeatScore).toFixed(0)+'/100':'–'}`),
    metric('Promo in Packs',`${data.candidatePipeline?.promoInPacksSpecials||0}`),
    metric('Promo mit Momentum',`${data.candidatePipeline?.promoMomentumSpecials||0}`),
    metric('Aktive Promo-Versionen',`${Array.isArray(data.candidatePipeline?.activePromoVersions)&&data.candidatePipeline.activePromoVersions.length?data.candidatePipeline.activePromoVersions.slice(0,3).join(' • '):'–'}`),
    metric('Kalenderphase (nur Info)',`${data.candidatePipeline?.seasonPhase||'–'}`),
    metric('Qualitätsziel Rating',`${data.candidatePipeline?.preferredMinimumRating||data.candidatePipeline?.minimumRating||'–'}+`,true),
    metric('Aktive Rating-Untergrenze',`${data.candidatePipeline?.minimumRating||'–'}+`),
    metric('Budget-Lockerung',`${data.candidatePipeline?.adaptiveBudgetRelaxed?'JA • '+(data.candidatePipeline?.adaptiveRelaxationDemandMode||'Demand'):'NEIN'}`),
    metric('Budget-Feasibility',`${data.dynamicCountReduced?'✓ über Slot-Anzahl':data.candidatePipeline?.adaptiveBudgetFeasible===true?'✓ 100 machbar':data.candidatePipeline?.adaptiveBudgetFeasible===false?'⚠ 100 nicht machbar':'–'}`),
    metric('Qualitätsmodus',`${data.dynamicCountReduced?'QUALITY-FIRST • Slots reduziert':'100-SLOT'}`,true),
    metric('Geschätztes Mindestbudget',`${finite(data.candidatePipeline?.adaptiveEstimatedMinimumCost)?coins(data.candidatePipeline.adaptiveEstimatedMinimumCost):'–'}`),
    metric('Demand-Lockerung erlaubt',`${data.candidatePipeline?.demandRelaxationCandidates||0}`),
    metric('Demand-Lockerung raus',`${data.candidatePipeline?.demandRelaxationRejected||0}`),
    metric('Live Demand Q25 Rating',`${finite(data.candidatePipeline?.adaptiveMarketQ25Rating)?Number(data.candidatePipeline.adaptiveMarketQ25Rating).toFixed(1):'–'}`),
    metric('Live Demand Median Rating',`${finite(data.candidatePipeline?.adaptiveMarketMedianRating)?Number(data.candidatePipeline.adaptiveMarketMedianRating).toFixed(1):'–'}`),
    metric('Adaptive Sample',`${data.candidatePipeline?.adaptiveSampleSize||0}`),
    metric('Live-Markt-Rating raus',`${data.candidatePipeline?.marketRatingRejected||0}`),
    metric('84er Special-Ausnahmen',`${data.candidatePipeline?.special84DemandExceptions||0}`),
    metric('Low Non-Rare raus',`${data.candidatePipeline?.lowNonRareRejected||0}`),
    metric('83–84 NR ohne Demand',`${data.candidatePipeline?.midNonRareDemandRejected||0}`),
    metric('Portfolio-Score',`${Number(data.portfolio?.portfolioScore||0).toFixed(0)}/100`,true),
    metric('Top-100 Budget-Score',`${Number(data.avgBudgetTop100Score||0).toFixed(0)}/100`,true),
    metric('Top-10 Kapital',pct(data.portfolio?.top10SpendPct||0)),
    metric('Premium-Karten',`${data.portfolio?.bands?.Premium?.count||0} / ${data.count}`),
    metric('Ø Turnover-Index',`${Number(data.avgTurnoverIndex).toFixed(0)}/100`),
    metric('Niedriges Risiko',`${data.lowRiskCount} / ${data.count}`),
    metric('Mit Lernhistorie',`${data.learningMatches} / ${data.count}`),
    metric('Ø Preissicherheit',`${Number(data.avgLearningScore).toFixed(0)}/100`),
    metric('Special-Ziel (dynamisch)',`${data.specialTargetCount||0} / ${data.count}`),
    metric('Markt',trendLabel(data.marketContext?.direction))
  ].join('');

  summary.innerHTML = `<div class="summaryPrimary">${primary}</div><details class="summaryMore"><summary>Mehr Analyse</summary><div class="summaryGrid">${details}</div></details>`;
  summary.classList.remove('hidden');
}


function hasCurrentRecheck(c){
  return Boolean(lastListId && lastCheckedListId === lastListId && c?._recheck);
}

function cardStatus(c){
  if(!hasCurrentRecheck(c)) return 'UNCHECKED';
  return String(c._recheck?.status || 'UNCHECKED').toUpperCase();
}

function statusMeta(status){
  switch(status){
    case 'KEEP': return {label:'KEEP', hint:'KAUFEN OK', hintClass:'buyable'};
    case 'REPRICE': return {label:'REPRICE', hint:'NEUE PREISE', hintClass:'reprice'};
    case 'WAIT': return {label:'WAIT', hint:'NICHT KAUFEN', hintClass:'blocked'};
    case 'DROP': return {label:'DROP', hint:'NICHT KAUFEN', hintClass:'blocked'};
    case 'MISSING': return {label:'MISSING', hint:'NICHT KAUFEN', hintClass:'blocked'};
    default: return {label:'PRÜFEN', hint:'ERST LIVE PRÜFEN', hintClass:''};
  }
}

function effectivePricing(c){
  const r = hasCurrentRecheck(c) ? c._recheck : null;
  const status = cardStatus(c);
  const actionable = status === 'KEEP' || status === 'REPRICE';
  const fresh = r?.fresh || {};
  const buy = actionable && finite(fresh.recommendedBuyPrice ?? r?.freshBuyPrice) ? Number(fresh.recommendedBuyPrice ?? r.freshBuyPrice) : Number(c.buyPrice || 0);
  const start = actionable && finite(fresh.startPrice) ? Number(fresh.startPrice) : Number(c.startPrice || 0);
  const sell = actionable && finite(fresh.sellPrice ?? r?.freshSellPrice) ? Number(fresh.sellPrice ?? r.freshSellPrice) : Number(c.sellPrice || 0);
  const profit = actionable && finite(fresh.netProfit ?? r?.freshNetProfit) ? Number(fresh.netProfit ?? r.freshNetProfit) : Number(c.netProfit || 0);
  const market = r && finite(r.currentPrice ?? fresh.price) ? Number(r.currentPrice ?? fresh.price) : Number(c.price || 0);
  const tax = Math.floor(Math.max(0, sell) * 0.05);
  return {buy,start,sell,profit,market,tax,actionable};
}

function currentQuality(c){
  const fresh = hasCurrentRecheck(c) ? c._recheck?.fresh : null;
  const score = finite(fresh?.tradeQualityScore) ? Number(fresh.tradeQualityScore) : Number(c.tradeQualityScore || 0);
  const flags = Array.isArray(fresh?.riskFlags) ? fresh.riskFlags : (Array.isArray(c.riskFlags) ? c.riskFlags : []);
  return {score,flags};
}

function signalText(c){
  const out=[];
  if(Number.isFinite(c.communityUsagePct)) out.push(`Community ${Number(c.communityUsagePct).toFixed(0)}%`);
  if(Number.isFinite(c.proUsagePct)) out.push(`Pros ${Number(c.proUsagePct).toFixed(0)}%`);
  if(Number.isFinite(c.usagePct) && !Number.isFinite(c.communityUsagePct) && !Number.isFinite(c.proUsagePct)) out.push(`FUT.GG Nutzung ${Number(c.usagePct).toFixed(0)}%${c.usageVersionMatched?' ✓':''}`);
  if(Number(c.usagePositionCount||0)>=2) out.push(`${c.usagePositionCount} Usage-Positionen`);
  if(c.momentumHit) out.push('Momentum ✓');
  if(c.inPacksHit) out.push('In Packs ⚠ Supply');
  if(Number.isFinite(c.demandDataConfidence)) out.push(`Demand-Daten ${Number(c.demandDataConfidence).toFixed(0)}/100`);
  if(c.marketMover) out.push(`Mover ${Number.isFinite(c.marketMover.changePct)?`${c.marketMover.changePct>0?'+':''}${Number(c.marketMover.changePct).toFixed(1)}%`:'✓'}`);
  if(c.history?.samples>=4) out.push(`Historie ${c.history.samples}`);
  if(Number.isFinite(c.priceActivityScore)) out.push(`Aktivität ${Number(c.priceActivityScore).toFixed(0)}`);
  if(c.futbinPrice) out.push('2 Quellen');
  if(finite(c.futbinGamesCount)) out.push(`FUTBIN Games ${coins(c.futbinGamesCount)}`);
  if(finite(c.futbinPopularRank)) out.push(`FUTBIN Popular #${coins(c.futbinPopularRank)}`);
  if(Number(c.futbinSoldSampleCount||0)>0) out.push(`FUTBIN Sold n=${c.futbinSoldSampleCount}${finite(c.futbinSoldPriceMedian)?` • Median ${coins(c.futbinSoldPriceMedian)}`:''}`);
  if(finite(c.futbinSaleTargetSupportScore)) out.push(`Realpreis-Support ${Number(c.futbinSaleTargetSupportScore).toFixed(0)}/100`);
  if((c.learning?.evalCount||0)>0) out.push(`Lernen ${Number(c.learningScore||50).toFixed(0)}/100 • ${c.learning.horizonHours}h n=${c.learning.evalCount}`);
  if(Number(c.buyDiscountPct)>0.05) out.push(`Kaufgrenze ${Number(c.buyDiscountPct).toFixed(1)}% unter Live`);
  if(Number.isFinite(c.roiPct)) out.push(`ROI ${Number(c.roiPct).toFixed(1)}%`);
  if(Number.isFinite(c.repeatabilityScore)) out.push(`Wiederholbar ${Number(c.repeatabilityScore).toFixed(0)}`);
  if(Number.isFinite(c.longTermProfitScore)) out.push(`LTP ${Number(c.longTermProfitScore).toFixed(0)}`);
  if(Number.isFinite(c.traderPriorScore)) out.push(`Trader ${Number(c.traderPriorScore).toFixed(0)}`);
  if(Number.isFinite(c.traderMethodConsensusIndex)) out.push(`ÜV-Methoden ${Number(c.traderMethodConsensusIndex).toFixed(0)}/100 • ${Number(c.traderMethodFavorableCount||0)}/3 positiv`);
  if(Number.isFinite(c.saleLikelihoodIndex)) out.push(`Sale-Index ${Number(c.saleLikelihoodIndex).toFixed(0)}`);
  if(Number.isFinite(c.requestedTargetProfit)) out.push(`Ziel +${coins(c.requestedTargetProfit)}`);
  if(Number(c.targetSupportSamples||0)>0) out.push(`Ziel-Support ${Number(c.targetSupportScore||50).toFixed(0)}/100 • n=${c.targetSupportSamples}`);
  if(Number(c.reportedFeedbackSamples||0)>0 && Number.isFinite(c.reportedSellRate)) out.push(`gemeldet verkauft ${(Number(c.reportedSellRate)*100).toFixed(0)}% • n=${c.reportedFeedbackSamples}`);
  if(Number(c.reportedFeedbackSamples||0)>0 && Number.isFinite(c.reportedOutcomeScore)) out.push(`Outcome ${Number(c.reportedOutcomeScore).toFixed(0)}/100`);
  if(Number.isFinite(c.avgReportedRelists)) out.push(`Ø Relists ${Number(c.avgReportedRelists).toFixed(1)}`);
  if(c.candidateGateDecision) out.push(`Gate ${c.candidateGateDecision} ${Number(c.candidateGateScore||0).toFixed(0)}/100`);
  if(c.knowledgeSignals?.length) out.push(c.knowledgeSignals[0]);
  if(c.weakReasons?.length) out.push(`Qualität: ${c.weakReasons[0]}`);
  if(c.recommendationLifecycle?.recheckAfterMinutes) out.push(`Recheck ≤ ${c.recommendationLifecycle.recheckAfterMinutes}m`);
  if(hasCurrentRecheck(c) && c._recheck?.status) out.push(`Live ${c._recheck.status}${Number.isFinite(c._recheck.priceDriftPct)?` ${c._recheck.priceDriftPct>0?'+':''}${Number(c._recheck.priceDriftPct).toFixed(1)}%`:''}`);
  if(c._rebalanceOrigin==='retained') out.push('Rebalance: behalten');
  if(c._rebalanceOrigin==='replacement') out.push('Rebalance: Ersatz');
  if(c.riskFlags?.length) out.push(`⚠ ${c.riskFlags[0]}`);
  return out.length?out.join(' • '):'Basisdaten';
}

function detailMetric(label,value){
  return `<div class="detailMetric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderDetail(c, pricing, status, quality){
  const r = hasCurrentRecheck(c) ? c._recheck : null;
  const reason = r?.reasons?.[0] || c.weakReasons?.[0] || c.riskFlags?.[0] || 'Keine zusätzliche Warnung.';
  const liveDrift = finite(r?.priceDriftPct) ? `${Number(r.priceDriftPct)>0?'+':''}${Number(r.priceDriftPct).toFixed(1)} %` : '–';
  const marketSource = c.futbinPrice ? `FUT.GG ${coins(pricing.market)} • FUTBIN ${coins(c.futbinPrice)}` : `FUT.GG ${coins(pricing.market)}`;
  const riskPenalty = finite(r?.fresh?.riskPenalty) ? Number(r.fresh.riskPenalty).toFixed(0) : Number(c.riskPenalty||0).toFixed(0);
  const traderMethodSources = Array.isArray(c.traderKnowledge?.publicMethodologySignals)
    ? c.traderKnowledge.publicMethodologySignals.map(x=>x.source).filter(Boolean).join(', ')
    : 'SwepixTV, MM___TV, Noah x Kai';
  return `<div class="detailPanel">
    <div class="detailGrid">
      ${detailMetric('Kartentyp',c.rarityName||c.cardType||'-')}
      ${detailMetric('Kapitalband',c.capitalBand||'-')}
      ${detailMetric('EA-Steuer 5 %',`${coins(pricing.tax)} 🪙`)}
      ${detailMetric('UV-Score',`${Number(c.uvScore||0).toFixed(0)}/100`)}
      ${detailMetric('Top-100 Budget-Score',finite(c.budgetTop100Score)?`${Number(c.budgetTop100Score).toFixed(0)}/100`:'–')}
      ${detailMetric('Trader-Endgame',finite(c.publicTraderEndgameScore)?`${Number(c.publicTraderEndgameScore).toFixed(0)}/100`:'–')}
      ${detailMetric('Trader-Consensus',finite(c.traderConsensusScore)?`${Number(c.traderConsensusScore).toFixed(0)}/100`:'–')}
      ${detailMetric('Budget-Tier',finite(c.budgetTierScore)?`${Number(c.budgetTierScore).toFixed(0)}/100 • ${c.budgetTierBand||'–'}`:'–')}
      ${detailMetric('Tier-Profil',c.budgetTierProfile||'–')}
      ${detailMetric('Karten-Version',c.cardVersionClass||'–')}
      ${detailMetric('Tier-Tags',Array.isArray(c.budgetTierTags)&&c.budgetTierTags.length?c.budgetTierTags.slice(0,4).join(' • '):'–')}
      ${detailMetric('Consensus-Tags',Array.isArray(c.traderConsensusTags)&&c.traderConsensusTags.length?c.traderConsensusTags.slice(0,4).join(' • '):'–')}
      ${detailMetric('Trader-Tags',Array.isArray(c.traderEndgameTags)&&c.traderEndgameTags.length?c.traderEndgameTags.slice(0,3).join(' • '):'–')}
      ${detailMetric('ÜV-Methoden',finite(c.traderMethodConsensusIndex)?`${Number(c.traderMethodConsensusIndex).toFixed(0)}/100 • ${Number(c.traderMethodFavorableCount||0)}/3 positiv`:'–')}
      ${detailMetric('ÜV-Quellen',traderMethodSources)}
      ${detailMetric('Nachfrage',`${Number(c.popularityScore||0).toFixed(0)}/100`)}
      ${detailMetric('Langfrist',`${Number(c.longTermScore||0).toFixed(0)}/100`)}
      ${detailMetric('Turnover',`${Number(c.turnoverIndex||0).toFixed(0)}/100`)}
      ${detailMetric('Preissicherheit',`${Number(c.learningScore||50).toFixed(0)}/100`)}
      ${detailMetric('ROI',finite(c.roiPct)?`${Number(c.roiPct).toFixed(1)} %`:'–')}
      ${detailMetric('Live-Drift',liveDrift)}
      ${detailMetric('Risiko-Penalty',`${riskPenalty}/100`)}
      ${detailMetric('FUTBIN Games',finite(c.futbinGamesCount)?coins(c.futbinGamesCount):'–')}
      ${detailMetric('FUTBIN Popular-Rank',finite(c.futbinPopularRank)?`#${coins(c.futbinPopularRank)}`:'–')}
      ${detailMetric('FUTBIN Sold-Sample',Number(c.futbinSoldSampleCount||0)>0?`n=${c.futbinSoldSampleCount}`:'–')}
      ${detailMetric('Sold-Median',finite(c.futbinSoldPriceMedian)?`${coins(c.futbinSoldPriceMedian)} 🪙`:'–')}
      ${detailMetric('Sold P25–P75',finite(c.futbinSoldPriceP25)&&finite(c.futbinSoldPriceP75)?`${coins(c.futbinSoldPriceP25)}–${coins(c.futbinSoldPriceP75)} 🪙`:'–')}
      ${detailMetric('Realpreis-Support',finite(c.futbinSaleTargetSupportScore)?`${Number(c.futbinSaleTargetSupportScore).toFixed(0)}/100`:'–')}
      ${detailMetric('Marktquellen',marketSource)}
    </div>
    <p class="detailReason"><strong>${status === 'KEEP' || status === 'REPRICE' ? 'Hinweis' : 'Sicherheitsgrund'}:</strong> ${reason}</p>
    <p class="coverage">${signalText(c)}</p>
  </div>`;
}

function statusCounts(){
  const counts = {ALL:lastCards.length,KEEP:0,REPRICE:0,WAIT:0,DROP:0,MISSING:0,UNCHECKED:0};
  for(const card of lastCards){
    const s = cardStatus(card);
    counts[s] = (counts[s]||0)+1;
  }
  return counts;
}

function updateStatusFilters(){
  const counts = statusCounts();
  for(const button of statusFilters){
    const status = button.dataset.status;
    const counter = button.querySelector('[data-count]');
    if(counter) counter.textContent = counts[status] || 0;
    button.classList.toggle('active',status === activeStatusFilter);
  }
}

function visibleCards(){
  const q = filter.value.toLowerCase().trim();
  return lastCards.filter(c => {
    const matchesStatus = activeStatusFilter === 'ALL' || cardStatus(c) === activeStatusFilter;
    const haystack = `${c.name||''} ${c.club||''} ${c.rarityName||''} ${c.cardType||''} ${c.position||''}`.toLowerCase();
    return matchesStatus && (!q || haystack.includes(q));
  });
}

function renderRows(cards){
  updateStatusFilters();
  if(!cards.length){
    rows.innerHTML='<tr><td colspan="9" class="empty">Für diesen Filter wurden keine Karten gefunden.</td></tr>';
    return;
  }
  const indexById = new Map(lastCards.map((c,i)=>[String(c.eaId),i+1]));
  rows.innerHTML = cards.map(c=>{
    const status = cardStatus(c);
    const meta = statusMeta(status);
    const pricing = effectivePricing(c);
    const quality = currentQuality(c);
    const typeClass = c.cardType==='Special'?'special':'';
    const qualityClass = ['A+','A'].includes(c.qualityGrade)?'high':c.qualityGrade==='B'?'mid':'';
    const reason = hasCurrentRecheck(c) ? c._recheck?.reasons?.[0] : null;
    const blocked = ['WAIT','DROP','MISSING'].includes(status);
    const riskClass = blocked ? 'blocked' : quality.flags.length ? 'risky' : '';
    const riskText = blocked ? '⛔ gesperrt' : quality.flags.length ? `⚠ ${quality.flags.length} Risiko${quality.flags.length===1?'':'s'}` : '✓ niedrig';
    const drift = hasCurrentRecheck(c) && finite(c._recheck?.priceDriftPct) ? `${Number(c._recheck.priceDriftPct)>0?'+':''}${Number(c._recheck.priceDriftPct).toFixed(1)} %` : '';
    const key = String(c.eaId);
    const expanded = expandedRows.has(key);
    const slot = indexById.get(key) || '';
    const version = c.rarityName||c.cardType||'-';
    const repriceHint = status === 'REPRICE' ? 'live aktualisiert' : status === 'KEEP' ? 'live bestätigt' : status === 'UNCHECKED' ? 'vor Kauf prüfen' : 'nicht verwenden';
    const main = `<tr class="tradeRow status-${status.toLowerCase()}">
      <td class="playerCell" data-label="Spieler / Version">
        <div class="player">
          ${c.image?`<img class="avatar" src="${c.image}" alt="" loading="lazy">`:`<div class="rating">${c.overall??'?'}</div>`}
          <div class="playerText">
            <div class="playerName"><span class="slot">#${slot}</span><span class="playerNameText">${c.name||'Unbekannt'}</span><span class="ratingChip">${c.overall??'?'}</span></div>
            <div class="sub"><span class="pill ${typeClass}">${version}</span> • ${c.position||'-'} • ${c.club||'-'}</div>
          </div>
        </div>
      </td>
      <td class="statusCell" data-label="Status"><span class="statusBadge ${status.toLowerCase()}">${meta.label}</span><span class="statusHint ${meta.hintClass}">${meta.hint}</span>${drift?`<span class="drift">Drift ${drift}</span>`:''}</td>
      <td data-label="Kaufen max"><span class="priceValue">${blocked?'–':coins(pricing.buy)}</span><span class="priceHint">${blocked?'nicht kaufen':repriceHint}</span></td>
      <td data-label="Start"><span class="priceValue">${blocked?'–':coins(pricing.start)}</span><span class="priceHint">${blocked?'gesperrt':'Listenpreis'}</span></td>
      <td data-label="Sofortkauf"><span class="priceValue">${blocked?'–':coins(pricing.sell)}</span><span class="priceHint">${blocked?'gesperrt':status==='REPRICE'?'live aktualisiert':'Listenpreis'}</span></td>
      <td data-label="Netto-Profit"><span class="priceValue profit">${blocked?'–':`+${coins(pricing.profit)}`}</span><span class="priceHint">nach 5 % Steuer</span></td>
      <td data-label="Marktpreis"><span class="priceValue marketFresh">${coins(pricing.market)}</span><span class="marketSource">${hasCurrentRecheck(c)?'FUT.GG live':'FUT.GG Liste'}</span></td>
      <td class="qualityCell" data-label="Qualität / Risiko"><div class="qualityLine"><span class="qualityGrade ${qualityClass}">${c.qualityGrade||'-'}</span><span class="qualityScore">${quality.score.toFixed(0)}/100</span></div><div class="riskLine ${riskClass}">${riskText}</div>${reason?`<span class="reasonMini">${reason}</span>`:''}</td>
      <td class="detailsCell" data-label="Details"><button class="detailToggle" type="button" data-details="${key}" aria-expanded="${expanded?'true':'false'}" aria-label="Details für ${c.name||'Karte'} ${expanded?'schließen':'öffnen'}">${expanded?'−':'+'}</button></td>
    </tr>`;
    const detail = expanded ? `<tr class="detailRow"><td colspan="9">${renderDetail(c,pricing,status,quality)}</td></tr>` : '';
    return main + detail;
  }).join('');
}

function renderCurrentRows(){
  renderRows(visibleCards());
}

function resetListUiState(){
  activeStatusFilter='ALL';
  expandedRows.clear();
  filter.value='';
  updateStatusFilters();
}

function savedListLabel(item){
  const date = item.createdAt ? new Date(item.createdAt).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
  const checked = item.lastRecheckAt ? ' • live geprüft' : '';
  return `#${item.id} • ${coins(item.budget)} • ${item.platform==='pc'?'PC':'Konsole'} • ${date}${checked}`;
}

async function loadSavedLists(selectId = null){
  if(!savedListSelect) return;
  try{
    const platform = $('#platform').value;
    const r = await fetch(`/api/uv/history?platform=${encodeURIComponent(platform)}&limit=30`);
    const data = await r.json();
    if(!r.ok) throw new Error(data.error||'Gespeicherte Listen konnten nicht geladen werden.');
    const previous = selectId ? String(selectId) : savedListSelect.value;
    savedListSelect.innerHTML = '<option value="">Gespeicherte Listen…</option>' + (data.lists||[]).map(item=>`<option value="${item.id}">${savedListLabel(item)}</option>`).join('');
    if(previous && [...savedListSelect.options].some(o=>o.value===previous)) savedListSelect.value=previous;
    loadSavedBtn.disabled=!savedListSelect.value;
  }catch{
    savedListSelect.innerHTML='<option value="">Gespeicherte Listen nicht verfügbar</option>';
    loadSavedBtn.disabled=true;
  }
}

async function openSavedList(listId){
  if(!listId) return;
  loadSavedBtn.disabled=true;
  const oldText=loadSavedBtn.textContent;
  loadSavedBtn.textContent='Öffne…';
  try{
    const r=await fetch(`/api/uv/list/${encodeURIComponent(listId)}`);
    const data=await r.json(); if(!r.ok) throw new Error(data.error||'Liste konnte nicht geöffnet werden.');
    $('#budget').value=data.budget;
    syncBudgetPresetState();
    $('#platform').value=data.platform;
    lastCards=data.cards||[];
    lastListId=data.listId||Number(listId);
    lastCheckedListId=data.persistedLiveRecheck?lastListId:null;
    resetListUiState();
    renderSummary(data);
    renderCurrentRows();
    filter.disabled=false;
    recheckBtn.disabled=!lastListId;
    rebalanceBtn.disabled=!data.persistedLiveRecheck;
    const checkText=data.lastRecheckAt?` • letzter Live-Check ${new Date(data.lastRecheckAt).toLocaleString('de-DE')}`:' • vor dem Kaufen live prüfen';
    $('#tableSub').textContent=`Gespeicherte Liste #${lastListId} • ${data.count} Karten • ${coins(data.totalBuy)} / ${coins(data.budget)}${checkText}`;
    notice.textContent=`Liste #${lastListId} aus PostgreSQL geöffnet. Kauf-, Start- und Sofortkaufpreise sind gespeichert. Vor neuen Käufen den Live-Check verwenden.`;
    notice.classList.remove('hidden');
    await loadSavedLists(lastListId);
  }catch(e){notice.textContent=e.message;notice.classList.remove('hidden')}
  finally{loadSavedBtn.textContent=oldText;loadSavedBtn.disabled=!savedListSelect.value}
}

btn.addEventListener('click', async()=>{
  const budget = Number($('#budget').value); const platform=$('#platform').value;
  const saveList = Boolean(saveListChoice?.checked);
  btn.disabled=true;loading.classList.remove('hidden');summary.classList.add('hidden');notice.classList.add('hidden');
  rows.innerHTML='<tr><td colspan="9" class="empty">Live-Marktdaten, Nachfrage, Outcome-Lernen und robuste Kandidaten-Gates werden geprüft; danach werden bis zu 100 hochwertige Karten innerhalb des Budgets optimiert…</td></tr>';
  try{
    const r=await fetch('/api/uv/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({budget,platform,saveList})});
    const text=await r.text();
    let data;
    try{data=JSON.parse(text)}catch{throw new Error(`Server lieferte keine JSON-Antwort (HTTP ${r.status}).`)}
    if(!r.ok) throw new Error(data.error||'Fehler');
    lastCards=data.cards; lastListId=data.listId||null; lastCheckedListId=null; resetListUiState(); renderSummary(data); renderCurrentRows(); filter.disabled=false; recheckBtn.disabled=!lastListId; rebalanceBtn.disabled=true;
    $('#tableSub').textContent=`${data.count} Karten • Pool ${data.candidatePoolSize} • Budget übrig ${coins(data.unusedBudget)}${lastListId?' • Vor dem Kaufen: Liste live prüfen':' • Nicht gespeichert'}`;
    notice.textContent=lastListId
      ? `Liste #${lastListId} gespeichert. Vor dem Kaufen zuerst „Liste live prüfen“ verwenden. ${data.dataNotice||''}`
      : `Liste nur angezeigt und NICHT gespeichert. Wenn du eine Liste für später behalten, live prüfen oder neu ausbalancieren willst, aktiviere vor der nächsten Generierung „Liste speichern“. ${data.dataNotice||''}`;
    notice.classList.remove('hidden');
    await loadSavedLists(data.listId||null);
  }catch(e){rows.innerHTML=`<tr><td colspan="9" class="empty error">${e.message}</td></tr>`}
  finally{btn.disabled=false;loading.classList.add('hidden')}
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startLiveRecheckJob(listId) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`/api/uv/recheck/${encodeURIComponent(listId)}`, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:'{}',
        cache:'no-store'
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Recheck konnte nicht gestartet werden');
      if (!data.jobId) throw new Error('Recheck-Job-ID fehlt');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(1200);
    }
  }
  throw lastError || new Error('Recheck konnte nicht gestartet werden');
}

async function waitForLiveRecheckJob(jobId, listId) {
  const startedPollingAt = Date.now();
  let transientFetchErrors = 0;
  while (true) {
    await sleep(2000);
    try {
      const r = await fetch(`/api/uv/recheck-job/${encodeURIComponent(jobId)}?t=${Date.now()}`, { cache:'no-store' });
      const text = await r.text();
      let data;
      try{data=JSON.parse(text)}catch{throw new Error(`Recheck-Status war keine JSON-Antwort (HTTP ${r.status}).`)}
      if (!r.ok) throw new Error(data.error || 'Recheck-Status nicht abrufbar');
      transientFetchErrors = 0;
      if (data.status === 'DONE') return data.result;
      if (data.status === 'FAILED') throw new Error(data.error || 'Live-Recheck fehlgeschlagen');
      if (data.status === 'QUEUED') {
        $('#tableSub').textContent=`Live-Recheck für Liste #${listId} wartet CPU-sicher in der Queue${data.queuePosition?` • Position ${data.queuePosition}`:''}…`;
        continue;
      }
      const seconds = Math.max(1, Math.round((Date.now() - new Date(data.startedAt || startedPollingAt).getTime()) / 1000));
      const progress = Number(data.total) > 0 ? ` • ${Number(data.processed||0)}/${Number(data.total)}` : '';
      const phase = data.phase ? ` • ${String(data.phase).replaceAll('_',' ')}` : '';
      const longRun = seconds >= 300 ? ' • läuft weiter, nicht fehlgeschlagen' : '';
      $('#tableSub').textContent=`Live-Recheck für Liste #${listId} läuft CPU-sicher… ${seconds}s${progress}${phase}${longRun}`;
      if(seconds >= 300){
        notice.textContent='Live-Prüfung dauert länger als 5 Minuten, läuft serverseitig aber weiter. Die Oberfläche wartet auf DONE oder einen echten FAILED-Status.';
        notice.classList.remove('hidden');
      }
    } catch (error) {
      const transient = error instanceof TypeError || /failed to fetch|network|keine json-antwort/i.test(String(error?.message || ''));
      if (transient && transientFetchErrors < 15) {
        transientFetchErrors++;
        $('#tableSub').textContent=`Live-Recheck läuft vermutlich weiter… Verbindung wird erneut geprüft (${transientFetchErrors}/15)`;
        continue;
      }
      throw error;
    }
  }
}

recheckBtn.addEventListener('click', async()=>{
  if(!lastListId) return;
  recheckBtn.disabled=true;
  rebalanceBtn.disabled=true;
  const oldText=recheckBtn.textContent;
  recheckBtn.textContent='Prüfe live…';
  notice.textContent=`Live-Prüfung für Liste #${lastListId} startet… FUT.GG, FUTBIN, Nachfrage, Markttrend, PostgreSQL-Historie, Risiko und Profit werden neu bewertet.`;
  notice.classList.remove('hidden');
  $('#tableSub').textContent=`Live-Recheck für Liste #${lastListId} startet…`;
  try{
    const started = await startLiveRecheckJob(lastListId);
    const data = await waitForLiveRecheckJob(started.jobId, lastListId);
    const byId=new Map((data.cards||[]).map(x=>[String(x.eaId),x]));
    lastCards=lastCards.map(c=>{
      const liveRow=byId.get(String(c.eaId))||null;
      return liveRow?.fresh ? {...c,...liveRow.fresh,_recheck:liveRow} : {...c,_recheck:liveRow};
    });
    lastCheckedListId=lastListId;
    renderCurrentRows();
    const c=data.summary?.counts||{};
    $('#tableSub').textContent=`Live-Recheck • KEEP ${c.KEEP||0} • REPRICE ${c.REPRICE||0} • WAIT ${c.WAIT||0} • DROP ${c.DROP||0} • MISSING ${c.MISSING||0}`;
    notice.textContent=`Liste #${lastListId} live geprüft. Kaufen nur bei KEEP oder REPRICE und niemals über KAUFEN MAX. REPRICE zeigt die frischen Kauf-/Start-/Sofortkauf-Werte. WAIT/DROP/MISSING nicht kaufen.`;
    notice.classList.remove('hidden');
    rebalanceBtn.disabled=false;
    loadSavedLists(lastListId).catch(()=>{});
  }catch(e){
    const message=e?.message||'Recheck fehlgeschlagen';
    notice.textContent=message;
    notice.classList.remove('hidden');
    $('#tableSub').textContent=`Live-Recheck fehlgeschlagen • Liste #${lastListId}`;
  }
  finally{recheckBtn.disabled=false;recheckBtn.textContent=oldText}
});

rebalanceBtn.addEventListener('click', async()=>{
  if(!lastListId) return;
  rebalanceBtn.disabled=true; recheckBtn.disabled=true;
  const oldText=rebalanceBtn.textContent;
  rebalanceBtn.textContent='Balanciere neu…';
  try{
    const oldListId=lastListId;
    const saveList=Boolean(saveListChoice?.checked);
    const r=await fetch(`/api/uv/rebalance/${lastListId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({saveList})});
    const text=await r.text();
    let data;
    try{data=JSON.parse(text)}catch{throw new Error(`Server lieferte keine JSON-Antwort (HTTP ${r.status}).`)}
    if(!r.ok) throw new Error(data.error||'Rebalance fehlgeschlagen');
    lastCards=data.cards||[]; lastListId=data.listId||null; lastCheckedListId=null; activeStatusFilter='ALL'; expandedRows.clear();
    renderSummary(data); renderCurrentRows();
    const rb=data.rebalance||{};
    $('#tableSub').textContent=lastListId
      ? `Rebalance #${oldListId} → #${lastListId} • behalten ${rb.retainedCount||0} • ersetzt ${rb.replacementCount||0} • Vor dem Kaufen wieder live prüfen`
      : `Rebalance von #${oldListId} nur angezeigt • behalten ${rb.retainedCount||0} • ersetzt ${rb.replacementCount||0} • Nicht gespeichert`;
    notice.textContent=lastListId
      ? `Neue ${data.count||lastCards.length}er-Liste #${lastListId} gespeichert. Die neue Liste gilt wieder als ungeprüft. Vor dem Kaufen zuerst „Liste live prüfen“ drücken.`
      : `Neu ausbalancierte Liste wurde NICHT gespeichert. Aktiviere „Liste speichern“, wenn du die nächste erzeugte oder ausbalancierte Liste behalten möchtest.`;
    notice.classList.remove('hidden');
    recheckBtn.disabled=!lastListId;
    rebalanceBtn.disabled=true;
    await loadSavedLists(lastListId||null);
  }catch(e){notice.textContent=e.message;notice.classList.remove('hidden');rebalanceBtn.disabled=false}
  finally{recheckBtn.disabled=!lastListId;rebalanceBtn.disabled=!lastListId;rebalanceBtn.textContent=oldText}
});

savedListSelect?.addEventListener('change',()=>{ loadSavedBtn.disabled=!savedListSelect.value; });
loadSavedBtn?.addEventListener('click',()=>openSavedList(savedListSelect.value));
$('#platform')?.addEventListener('change',()=>loadSavedLists());

function syncBudgetPresetState(){
  const value=Number($('#budget')?.value||0);
  for(const button of budgetPresetButtons) button.classList.toggle('active',Number(button.dataset.budget)===value);
}
for(const button of budgetPresetButtons){
  button.addEventListener('click',()=>{
    $('#budget').value=button.dataset.budget;
    syncBudgetPresetState();
  });
}
$('#budget')?.addEventListener('input',syncBudgetPresetState);
syncBudgetPresetState();

filter.addEventListener('input',renderCurrentRows);

for(const button of statusFilters){
  button.addEventListener('click',()=>{
    activeStatusFilter=button.dataset.status||'ALL';
    renderCurrentRows();
  });
}

rows.addEventListener('click',event=>{
  const button=event.target.closest('[data-details]');
  if(!button) return;
  const key=String(button.dataset.details||'');
  if(expandedRows.has(key)) expandedRows.delete(key); else expandedRows.add(key);
  renderCurrentRows();
});

updateStatusFilters();
loadStatus();
loadSavedLists();
