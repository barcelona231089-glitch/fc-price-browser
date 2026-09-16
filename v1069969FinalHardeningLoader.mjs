import { Buffer } from "node:buffer";

export const V1069969_FINAL_HARDENING_VERSION = "10.69.9.6.9-final-hardening";

function sourceText(source) {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source == null) return null;
  return Buffer.from(source).toString("utf8");
}

function replaceBlock(source, startAnchor, nextAnchor, replacement, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`[6.9] ${label} start anchor missing`);
  const end = source.indexOf(nextAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`[6.9] ${label} end anchor missing`);
  return source.slice(0, start) + replacement.trimEnd() + "\n\n" + source.slice(end);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}
const REGIME_SOURCE = `function brainLearningMarketRegime(input) {
  let data = input || {};
  if (typeof data === "string") {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const c5 = num(data.change5m);
  const c15 = num(data.change15m);
  const c1h = num(data.change1h);
  const c24 = num(data.change24h);
  const distanceLow = Math.max(0, num(data.distanceTo24hLow));
  const rising = Math.max(0, num(data.ratingMarketRisingPct));
  const falling = Math.max(0, num(data.ratingMarketFallingPct));
  const market = data.marketContext || {};
  const leak = market.publicLeaks || {};
  const topics = new Set((Array.isArray(leak.topics) ? leak.topics : []).map(x => String(x).toUpperCase()));
  const evidence = data.marketEvidence || {};
  const liquidityScore = Number(evidence.liquidityScore ?? data.evidenceLiquidityScore);
  const salesPerHour = Number(evidence.salesPerHour24h ?? data.evidenceSalesPerHour24h);

  if (c5 <= -8 || c15 <= -12 || c1h <= -15 || (falling >= 75 && c5 <= -3)) return "CRASH";
  if (c5 >= 8 || c15 >= 12 || c1h >= 15 || (rising >= 75 && c5 >= 3)) return "PUMP";
  if (Number.isFinite(liquidityScore) && liquidityScore < 28 && (!Number.isFinite(salesPerHour) || salesPerHour < 0.2)) return "THIN";
  if (market.packSupplyActive === true) return "SUPPLY";
  if (topics.has("PROMO")) return "PROMO";
  if (topics.has("SBC")) return "SBC";
  if (topics.has("EVO")) return "EVO";
  if (distanceLow <= 5 && ((c5 >= 1 && c15 >= 1.5) || (c1h >= 2 && c24 < 0))) return "RECOVERY";
  if (Math.abs(c5) <= 1 && Math.abs(c15) <= 2 && Math.abs(c1h) <= 3) return "FLAT";
  return "NORMAL";
}`;

const PUBLIC_LEAK_PROFILE_SOURCE = `async function loadPublicLeakSourceProfiles() {
  if (!dbEnabled) return {};
  const result = await pool.query(\`
    WITH per_signal AS (
      SELECT s.source, i.signal_id,
        COUNT(*)::int AS evaluated_points,
        AVG(ABS(i.market_median_change_pct)) AS avg_abs_move,
        MAX(CASE WHEN i.horizon_minutes = 60 THEN ABS(i.market_median_change_pct) END) AS abs_move_1h,
        BOOL_OR(ABS(i.market_median_change_pct) >= 1) AS reacted,
        MIN(CASE WHEN ABS(i.market_median_change_pct) >= 1 THEN i.horizon_minutes END) AS first_reaction_minutes
      FROM fc_trader_market_impacts i
      JOIN fc_discord_signals s ON s.id = i.signal_id
      WHERE s.ingest_origin = 'public_leak_poll'
        AND i.evaluated_at >= NOW() - INTERVAL '120 days'
      GROUP BY s.source, i.signal_id
    )
    SELECT source, COUNT(*)::int AS events,
      SUM(evaluated_points)::int AS evaluated_points,
      ROUND(AVG(avg_abs_move)::numeric, 3) AS avg_abs_move,
      ROUND(AVG(CASE WHEN reacted THEN 100.0 ELSE 0.0 END)::numeric, 2) AS reaction_rate,
      ROUND(AVG(abs_move_1h)::numeric, 3) AS avg_abs_move_1h,
      SUM(CASE WHEN reacted THEN 1 ELSE 0 END)::int AS reacted_events,
      ROUND(AVG(first_reaction_minutes) FILTER (WHERE first_reaction_minutes IS NOT NULL)::numeric, 1) AS avg_first_reaction_minutes
    FROM per_signal GROUP BY source
  \`);
  const profiles = {};
  for (const row of result.rows) {
    const events = Number(row.events || 0);
    const reactedEvents = Number(row.reacted_events || 0);
    const reactionRate = Number(row.reaction_rate || 0);
    const avgAbsMove = Number(row.avg_abs_move || 0);
    const avgAbsMove1h = Number(row.avg_abs_move_1h || 0);
    const avgFirstReactionMinutes = row.avg_first_reaction_minutes == null ? null : Number(row.avg_first_reaction_minutes);
    const mature = events >= PUBLIC_LEAK_PROFILE_MIN_EVENTS;
    const sampleTrust = Math.min(1, events / Math.max(1, PUBLIC_LEAK_PROFILE_MIN_EVENTS));
    const reliabilityScore = ((3 + reactedEvents) / (6 + events)) * 100;
    const leadTimeScore = avgFirstReactionMinutes == null ? 50 : clampBrainScore(100 - avgFirstReactionMinutes / 6, 0, 100);
    const rawScore = reliabilityScore * 0.55 + leadTimeScore * 0.20 + Math.min(100, 35 + avgAbsMove1h * 12) * 0.25;
    const impactScore = Math.round(clampBrainScore(50 + (rawScore - 50) * sampleTrust, 25, 95));
    profiles[String(row.source).toLowerCase()] = {
      source: row.source,
      events,
      reactedEvents,
      evaluatedPoints: Number(row.evaluated_points || 0),
      reactionRatePct: Number(reactionRate.toFixed(2)),
      avgAbsMarketMovePct: Number(avgAbsMove.toFixed(3)),
      avgAbsMarketMove1hPct: Number(avgAbsMove1h.toFixed(3)),
      avgFirstReactionMinutes,
      leadTimeScore: Number(leadTimeScore.toFixed(1)),
      reliabilityScore: Number(reliabilityScore.toFixed(1)),
      mature,
      impactScore
    };
  }
  return profiles;
}

function normalizedLeakTokens(message) {
  return new Set(String(message || "").toLowerCase().replace(/https?:\\/\\/\\S+/g, " ").replace(/[^a-z0-9ÃƒÂ¤ÃƒÂ¶ÃƒÂ¼ÃƒÅ¸]+/gi, " ").split(/\\s+/).filter(x => x.length >= 4));
}
function leakTokenSimilarity(a, b) {
  const aa = normalizedLeakTokens(a);
  const bb = normalizedLeakTokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection += 1;
  return intersection / Math.max(1, new Set([...aa, ...bb]).size);
}

function clusterPublicLeakSignals(signals) {
  const clusters = [];
  for (const signal of signals || []) {
    const match = clusters.find(cluster => cluster.some(existing => leakTokenSimilarity(existing.message, signal.message) >= 0.8));
    if (match) match.push(signal);
    else clusters.push([signal]);
  }
  return clusters;
}`;

const PUBLIC_LEAK_CONTEXT_SOURCE = `function buildPublicLeakContext(row, activeSignals, leakProfiles, ratingStat = null) {
  const now = Date.now();
  const recent = (activeSignals || [])
    .filter(signal => publicLeakAppliesToRow(signal, row))
    .filter(signal => now - Number(signal.sourceEventAt || signal.timestamp || 0) <= PUBLIC_LEAK_MAX_AGE_MS);
  if (!recent.length) {
    return { active: false, count: 0, sourceCount: 0, sources: [], topics: [], consensus: 0,
      independentConsensus: 0, copyDuplicateCount: 0, impactScore: 0, marketReaction: false,
      marketReactionStrength: 0, sourceReliabilityScore: 50, sourceLeadTimeScore: 50,
      note: "Kein relevanter oeffentlicher Leak im aktiven Zeitfenster." };
  }
  const distinctSources = [...new Set(recent.map(signal => signal.source).filter(Boolean))];
  const topics = [...new Set(recent.map(signal => classifyPublicLeakText(signal.message).topic).filter(Boolean))];
  const clusters = clusterPublicLeakSignals(recent);
  const independentConsensus = clusters.length;
  const copyDuplicateCount = Math.max(0, recent.length - independentConsensus);
  const sourceProfiles = distinctSources.map(source => leakProfiles?.[String(source).toLowerCase()] || null).filter(Boolean);
  const sourceImpactScores = distinctSources.map(source => leakProfiles?.[String(source).toLowerCase()]?.impactScore ?? 50);
  const avgSourceImpact = sourceImpactScores.length ? sourceImpactScores.reduce((a, b) => a + b, 0) / sourceImpactScores.length : 50;
  const avgReliability = sourceProfiles.length ? sourceProfiles.reduce((a, p) => a + Number(p.reliabilityScore || 50), 0) / sourceProfiles.length : 50;
  const avgLeadTime = sourceProfiles.length ? sourceProfiles.reduce((a, p) => a + Number(p.leadTimeScore || 50), 0) / sourceProfiles.length : 50;
  const matureSources = distinctSources.filter(source => leakProfiles?.[String(source).toLowerCase()]?.mature).length;
  const c5 = Math.abs(Number(ratingStat?.change5m || 0));
  const c15 = Math.abs(Number(ratingStat?.change15m || 0));
  const breadth = Math.max(Number(ratingStat?.risingPct5m || 0), Number(ratingStat?.fallingPct5m || 0));
  const marketReactionStrength = Math.round(clampBrainScore(c5 * 12 + c15 * 5 + Math.max(0, breadth - 50) * 0.6, 0, 100));
  const marketReaction = Boolean(c5 >= 0.75 || c15 >= 1.25 || breadth >= 65);
  let impactScore = 26 + Math.min(24, independentConsensus * 8) + Math.min(15, matureSources * 4);
  impactScore += Math.min(14, Math.max(0, avgSourceImpact - 50) * 0.35);
  impactScore += Math.min(10, Math.max(0, avgReliability - 50) * 0.20);
  impactScore += Math.min(8, Math.max(0, avgLeadTime - 50) * 0.16);
  if (marketReaction) impactScore += Math.min(20, marketReactionStrength * 0.2);
  impactScore = Math.round(clampBrainScore(impactScore, 20, marketReaction ? 92 : 68));
  return {
    active: true, count: recent.length, sourceCount: distinctSources.length,
    sources: distinctSources.slice(0, 6), topics: topics.slice(0, 6),
    consensus: independentConsensus, independentConsensus, copyDuplicateCount, matureSources,
    avgSourceImpact: Number(avgSourceImpact.toFixed(1)), sourceReliabilityScore: Number(avgReliability.toFixed(1)),
    sourceLeadTimeScore: Number(avgLeadTime.toFixed(1)), impactScore, marketReaction, marketReactionStrength,
    newestAgeMinutes: Math.max(0, Math.round((now - Math.max(...recent.map(signal => Number(signal.sourceEventAt || signal.timestamp || 0)))) / 60_000)),
    signalIds: recent.slice(0, 12).map(signal => signal.id),
    sourceGraph: clusters.slice(0, 8).map((cluster, index) => ({ cluster: index + 1, sources: [...new Set(cluster.map(x => x.source).filter(Boolean))], messages: cluster.length })),
    note: marketReaction ? "Leak vorhanden und Preis-/Marktreaktion messbar. Darf Event Catalyst bestaetigen, aber nie alleine kaufen."
      : "Leak vorhanden, aber noch keine belastbare Preisreaktion. Beobachten statt vorweg kaufen."
  };
}`;
const FINAL_HELPERS_SOURCE = `let finalHardeningRealizedTrades = 0;
let finalHardeningOwnTradeError = null;

function finalAnalogueFeatures(input) {
  let data = input || {};
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { data = {}; } }
  const n = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    c5: n(data.change5m) / 8,
    c15: n(data.change15m) / 12,
    c1h: n(data.change1h) / 15,
    c24: n(data.change24h) / 25,
    low: n(data.distanceTo24hLow) / 20,
    rising: n(data.ratingMarketRisingPct) / 100,
    falling: n(data.ratingMarketFallingPct) / 100
  };
}

function finalAnalogueDistance(a, b) {
  const keys = ["c5", "c15", "c1h", "c24", "low", "rising", "falling"];
  return keys.reduce((sum, key) => sum + Math.abs(Number(a?.[key] || 0) - Number(b?.[key] || 0)), 0) / keys.length;
}

function selectHistoricalAnalogues(cache, action, cardType, rating, input) {
  const episodes = Array.isArray(cache?.analogueEpisodes) ? cache.analogueEpisodes : [];
  if (!episodes.length) return null;
  const target = finalAnalogueFeatures(input);
  const ratingBand = brainLearningRatingBand(rating);
  const normalizedAction = action === "JETZT VERKAUFEN" ? "VERKAUF PRÃƒÆ’Ã…â€œFEN" : String(action || "");
  const ranked = episodes.filter(ep => ep.action === normalizedAction).map(ep => {
    let distance = finalAnalogueDistance(target, ep.features);
    if (String(ep.cardType) !== String(cardType)) distance += 0.18;
    if (String(ep.ratingBand) !== String(ratingBand)) distance += 0.12;
    return { ...ep, distance };
  }).sort((a, b) => a.distance - b.distance).slice(0, 15);
  if (ranked.length < 6) return { applied: false, samples: ranked.length, reason: "INSUFFICIENT_NEIGHBORS" };
  let weightSum = 0, wins = 0, outcomeSum = 0;
  for (const ep of ranked) {
    const w = 1 / Math.max(0.15, ep.distance + 0.15);
    weightSum += w;
    wins += w * (ep.wasCorrect ? 1 : 0);
    outcomeSum += w * Number(ep.outcomeScore || 0);
  }
  return {
    applied: true,
    engine: "KNN_REAL_MATURE_OUTCOMES",
    samples: ranked.length,
    weightedAccuracy: Number(((wins / Math.max(weightSum, 0.001)) * 100).toFixed(1)),
    averageOutcomeScore: Number((outcomeSum / Math.max(weightSum, 0.001)).toFixed(2)),
    nearestDistance: Number(ranked[0].distance.toFixed(3)),
    synthetic: false
  };
}

function refreshFinalTradePlan(row) {
  if (!row) return null;
  const current = Number(row.price);
  const maxBuy = Number(row?.aiEntryZone?.max ?? row?.aiIdealEntryHigh);
  const target = Number(row?.aiTargetExitZone?.conservative ?? row?.aiTargetLow ?? row?.aiFairValue);
  const breakEven = Number.isFinite(maxBuy) && maxBuy > 0 ? Math.ceil(maxBuy / 0.95) : null;
  const afterTax = Number.isFinite(target) && target > 0 ? Math.floor(target * 0.95) : null;
  const netProfit = Number.isFinite(afterTax) && Number.isFinite(maxBuy) ? afterTax - maxBuy : null;
  const roiPct = Number.isFinite(netProfit) && Number.isFinite(maxBuy) && maxBuy > 0 ? Number(((netProfit / maxBuy) * 100).toFixed(2)) : null;
  const indicators = row.aiMarketIndicators || {};
  let timingAction = "HOLD";
  let expectedHold = row.aiRecommendedHorizon || "Markt weiter beobachten";
  if (String(row.aiAction) === "JETZT KAUFEN") timingAction = "BUY NOW";
  else if (Number.isFinite(current) && Number.isFinite(maxBuy) && current > maxBuy) timingAction = "BUY BELOW " + Math.round(maxBuy);
  else if (indicators.isMissedEntry) { timingAction = "WAIT 3h"; expectedHold = "3h neu bewerten"; }
  else if (indicators.isBottomForming && !indicators.isConfirmedRecovery) { timingAction = "WAIT 30m"; expectedHold = "30m Boden bestaetigen"; }
  else if (["NOCH WARTEN", "BEOBACHTEN"].includes(String(row.aiAction))) { timingAction = "WAIT 30m"; expectedHold = "30m neu bewerten"; }
  else if (String(row.aiAction).includes("VERKAUF")) timingAction = String(row.aiAction) === "JETZT VERKAUFEN" ? "SELL NOW" : "SELL REVIEW";
  row.aiTimingAction = timingAction;
  row.aiTradePlan = {
    timingAction,
    maxBuy: Number.isFinite(maxBuy) ? Math.round(maxBuy) : null,
    currentPrice: Number.isFinite(current) ? Math.round(current) : null,
    sellTarget: Number.isFinite(target) ? Math.round(target) : null,
    breakEvenAfterTax: Number.isFinite(breakEven) ? Math.round(breakEven) : null,
    netAfterTaxAtTarget: Number.isFinite(afterTax) ? Math.round(afterTax) : null,
    expectedNetProfit: Number.isFinite(netProfit) ? Math.round(netProfit) : null,
    expectedRoiPct: roiPct,
    eaTaxPct: 5,
    expectedHold,
    confidence: Number(row.aiConfidence || 0),
    risk: row.aiRisk || null,
    advisoryOnly: true
  };
  return row.aiTradePlan;
}

function applyFinalEvidenceGuards(row, work = null) {
  if (!row) return;
  const evidence = row.marketEvidence || work?.input?.marketEvidence || null;
  const liquidityTrend = String(row.evidenceLiquidityTrend || evidence?.salesStats?.liquidity?.trend || "INSUFFICIENT_DATA");
  const liquidityScore = Number(row.evidenceLiquidityScore ?? evidence?.salesStats?.liquidity?.score);
  const freshness = String(row.evidenceFreshnessStatus || evidence?.freshness?.freshnessStatus || "UNKNOWN");
  const leak = work?.input?.marketContext?.publicLeaks || {};
  const topics = new Set((Array.isArray(leak.topics) ? leak.topics : []).map(x => String(x).toUpperCase()));
  const reasons = [];

  if (String(row.aiAction) === "JETZT KAUFEN" && liquidityTrend === "FALLING" && Number.isFinite(liquidityScore) && liquidityScore < 40) {
    row.aiAction = "NOCH WARTEN";
    row.aiConfidence = Math.min(Number(row.aiConfidence || 70), 72);
    row.aiRisk = "hoch";
    reasons.push("Liquiditaet verschlechtert sich");
  }
  if (String(row.aiAction) === "JETZT KAUFEN" && row.packSupplyActive === true) {
    row.aiAction = "NOCH WARTEN";
    row.aiConfidence = Math.min(Number(row.aiConfidence || 70), 72);
    reasons.push("aktiver Supply-Druck");
  }
  if (String(row.aiAction) === "JETZT KAUFEN" && leak.active && !leak.marketReaction && (topics.has("PROMO") || topics.has("SUPPLY") || topics.has("EVO"))) {
    row.aiAction = "NOCH WARTEN";
    row.aiConfidence = Math.min(Number(row.aiConfidence || 70), 74);
    reasons.push("Event noch nicht im Markt bestaetigt");
  }
  if (freshness === "STALE" && Number(row.aiConfidence || 0) > 50) {
    row.aiConfidence = Math.max(10, Number(row.aiConfidence || 0) - 3);
    reasons.push("sekundaere Evidence veraltet");
  }
  row.aiFinalHardening = {
    version: "10.69.9.6.9",
    liquidityTrend,
    liquidityScore: Number.isFinite(liquidityScore) ? liquidityScore : null,
    evidenceFreshness: freshness,
    eventTopics: [...topics],
    independentLeakConsensus: Number(leak.independentConsensus ?? leak.consensus ?? 0),
    sourceReliabilityScore: Number(leak.sourceReliabilityScore ?? 50),
    sourceLeadTimeScore: Number(leak.sourceLeadTimeScore ?? 50),
    guardReasons: reasons,
    leakAloneCannotBuy: true
  };
  if (reasons.length) row.aiReason = (String(row.aiReason || "") + " Final-Hardening: " + reasons.join(", ") + ".").slice(0, 1800);
  refreshFinalTradePlan(row);
}

async function ensureOwnTradeLifecycleSchemaFinal() {
  if (!dbEnabled) return false;
  await pool.query(\`
    CREATE TABLE IF NOT EXISTS fc_own_trade_lifecycle_v1 (
      id BIGSERIAL PRIMARY KEY,
      game_year SMALLINT NOT NULL,
      ea_id TEXT NOT NULL,
      buy_price INTEGER NOT NULL,
      sell_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      ea_tax INTEGER NOT NULL,
      net_profit_total INTEGER NOT NULL,
      roi_pct NUMERIC(10,4) NOT NULL,
      held_minutes INTEGER,
      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      note TEXT
    )
  \`);
  await pool.query(\`CREATE INDEX IF NOT EXISTS idx_fc_own_trade_lifecycle_year_card ON fc_own_trade_lifecycle_v1 (game_year, ea_id, closed_at DESC)\`);
  return true;
}`;
function patchMarketEvidenceFinal(source) {
  let out = String(source || "");
  if (out.includes("FINAL_EVIDENCE_HARDENING_VERSION")) return out;
  const buildMatch = out.match(/const BUILD = "[^"]+";/);
  const constantsAnchor = buildMatch?.[0] || null;
  if (!constantsAnchor) throw new Error("[6.9] evidence build anchor missing");
  if (out.includes("EVIDENCE_STALE_MIN") && out.includes("salesPerMinute24h") && out.includes("freshnessStatus")) {
    return out.replace(constantsAnchor, constantsAnchor + '\nconst FINAL_EVIDENCE_HARDENING_VERSION = "1.2.0";');
  }
  out = out.replace(constantsAnchor, constantsAnchor + `
const FINAL_EVIDENCE_HARDENING_VERSION = "1.2.0";
const EVIDENCE_STALE_MIN = Math.max(30, Math.min(1440, Number(process.env.MARKET_EVIDENCE_STALE_MIN || 360)));
function evidenceFreshness(observedAt, fetchedAt) {
  const now = Date.now();
  const observedMs = Date.parse(observedAt || "");
  const fetchedMs = Date.parse(fetchedAt || "");
  const sourceAgeMinutes = Number.isFinite(observedMs) ? Math.max(0, (now - observedMs) / 60000) : null;
  const fetchAgeMinutes = Number.isFinite(fetchedMs) ? Math.max(0, (now - fetchedMs) / 60000) : null;
  const age = sourceAgeMinutes ?? fetchAgeMinutes;
  const freshnessStatus = !Number.isFinite(age) ? "UNKNOWN" : age <= EVIDENCE_STALE_MIN ? "FRESH" : age <= EVIDENCE_STALE_MIN * 2 ? "AGING" : "STALE";
  const freshnessWeight = !Number.isFinite(age) ? 0 : Number(Math.max(0, 1 - Math.min(age, EVIDENCE_STALE_MIN * 2) / (EVIDENCE_STALE_MIN * 2)).toFixed(3));
  return { fetchedAt: fetchedAt || null, sourceAgeMinutes: sourceAgeMinutes == null ? null : Number(sourceAgeMinutes.toFixed(2)), fetchAgeMinutes: fetchAgeMinutes == null ? null : Number(fetchAgeMinutes.toFixed(2)), freshnessStatus, freshnessWeight };
}`);
  out = out.replace(
    '  const observedAt = parseDate(row.observed_at ?? row.observedAt ?? row.updated_at ?? row.updatedAt) || new Date().toISOString();',
    '  const fetchedAt = parseDate(row.fetched_at ?? row.fetchedAt ?? row.retrieved_at ?? row.retrievedAt) || new Date().toISOString();\n  const observedAt = parseDate(row.observed_at ?? row.observedAt ?? row.updated_at ?? row.updatedAt) || fetchedAt;'
  );
  out = out.replace(
    '    sourceUrl: clean(row.source_url ?? row.sourceUrl, 500) || null,\n    observedAt\n  };',
    '    sourceUrl: clean(row.source_url ?? row.sourceUrl, 500) || null,\n    observedAt,\n    fetchedAt\n  };'
  );
  out = out.replace(
    '           games_pc, popular_rank, popularity_count, source, source_url, observed_at\n    FROM fc_market_evidence_cards',
    '           games_pc, popular_rank, popularity_count, source, source_url, observed_at, updated_at\n    FROM fc_market_evidence_cards'
  );
  out = out.replace(
    '      sourceUrl: row.source_url,\n      observedAt: row.observed_at\n    });',
    '      sourceUrl: row.source_url,\n      observedAt: row.observed_at,\n      fetchedAt: row.updated_at\n    });'
  );
  out = out.replace(
    '      sales1h: null, sales6h: null, sales24h: null, sales7d: null,\n      salesPerHour24h: null, medianSaleGapMinutes: null, activeHours24h: null,',
    '      sales1h: null, sales6h: null, sales24h: null, sales7d: null,\n      salesPerHour24h: null, salesPerMinute24h: null, medianSaleGapMinutes: null, activeHours24h: null,'
  );
  out = out.replace(
    '  const salesPerHour24h = h24.length / 24;\n\n  // Independent Trader Brain metric',
    '  const salesPerHour24h = h24.length / 24;\n  const salesPerMinute24h = salesPerHour24h / 60;\n\n  // Independent Trader Brain metric'
  );
  out = out.replace(
    '    salesPerHour24h: Number(salesPerHour24h.toFixed(3)),\n    medianSaleGapMinutes:',
    '    salesPerHour24h: Number(salesPerHour24h.toFixed(3)),\n    salesPerMinute24h: Number(salesPerMinute24h.toFixed(4)),\n    medianSaleGapMinutes:'
  );
  out = out.replace(
    '    const stats = salesStats(sales);\n\n    row.marketEvidence = {',
    '    const stats = salesStats(sales);\n    const freshness = evidenceFreshness(ev.observedAt, ev.fetchedAt);\n\n    row.marketEvidence = {'
  );
  out = out.replace(
    '      salesHistory: sales,\n      salesStats: stats\n    };',
    '      salesHistory: sales,\n      salesStats: stats,\n      freshness\n    };'
  );
  out = out.replace(
    '    row.evidenceSalesPerHour24h = stats.liquidity?.salesPerHour24h ?? null;\n    row.evidenceMinutesSinceLastSale',
    '    row.evidenceSalesPerHour24h = stats.liquidity?.salesPerHour24h ?? null;\n    row.evidenceSalesPerMinute24h = stats.liquidity?.salesPerMinute24h ?? null;\n    row.evidenceFreshnessStatus = freshness.freshnessStatus;\n    row.evidenceFreshnessWeight = freshness.freshnessWeight;\n    row.evidenceMinutesSinceLastSale'
  );
  out = out.replace(
    '        salesPerHour24h: row.evidenceSalesPerHour24h,\n        minutesSinceLastSale:',
    '        salesPerHour24h: row.evidenceSalesPerHour24h,\n        salesPerMinute24h: row.evidenceSalesPerMinute24h,\n        freshness,\n        minutesSinceLastSale:'
  );
  out = out.replace(
    '      liquidityFromSales: true,\n      gamesVelocityFromSnapshots: true',
    '      liquidityFromSales: true,\n      salesPerMinute: true,\n      uniformFreshness: true,\n      gamesVelocityFromSnapshots: true'
  );
  const required = [
    'FINAL_EVIDENCE_HARDENING_VERSION = "1.2.0"',
    'salesPerMinute24h',
    'evidenceFreshnessStatus',
    'uniformFreshness: true'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error(`[6.9] evidence hardening incomplete: ${missing.join(", ")}`);
  return out;
}
function patchServerFinal(source) {
  let out = String(source || "");
  if (out.includes('FINAL_TRADER_HARDENING_VERSION = "10.69.9.6.9"')) return out;
  out = out.replaceAll('10.69.9.6.5-final', '10.69.9.6.9-final');

  out = out.replace(
    'const MARKET_KNOWLEDGE_MIN_SAMPLES = Math.max(6, Math.min(50, Number(process.env.MARKET_KNOWLEDGE_MIN_SAMPLES || 12)));',
    'const MARKET_KNOWLEDGE_MIN_SAMPLES = Math.max(6, Math.min(50, Number(process.env.MARKET_KNOWLEDGE_MIN_SAMPLES || 18)));'
  );

  out = replaceBlock(out, 'function brainLearningMarketRegime(input) {', 'function brainLearningMovePct(', REGIME_SOURCE, 'regime classifier');
  out = replaceBlock(out, 'async function loadPublicLeakSourceProfiles() {', 'function publicLeakAppliesToRow(', PUBLIC_LEAK_PROFILE_SOURCE, 'source reliability/lead-time');
  out = replaceBlock(out, 'function buildPublicLeakContext(row, activeSignals, leakProfiles, ratingStat = null) {', 'function median(values) {', PUBLIC_LEAK_CONTEXT_SOURCE, 'copy-source graph');

  const baseAnchor = 'function baseDecisionFromQuant(quant, confluence) {';
  if (!out.includes(baseAnchor)) throw new Error('[6.9] base decision anchor missing');
  out = out.replace(baseAnchor, `const FINAL_TRADER_HARDENING_VERSION = "10.69.9.6.9";\n\n${FINAL_HELPERS_SOURCE}\n\n${baseAnchor}`);

  out = out.replace(
    '    key_factors: quant.keyFactors,\n    entry_zone: quant.entryZone,',
    '    key_factors: quant.keyFactors,\n    market_indicators: quant.indicators,\n    entry_zone: quant.entryZone,'
  );
  out = out.replace(
    '  row.aiKeyFactors = decision.key_factors || [];\n  row.aiRecommendedHorizon',
    '  row.aiKeyFactors = decision.key_factors || [];\n  row.aiMarketIndicators = decision.market_indicators || row.aiMarketIndicators || null;\n  row.aiRecommendedHorizon'
  );
  out = out.replace(
    '    const cardRegimeRaw = new Map();\n    const cardActionRaw = new Map();\n    const regimeRaw = new Map();',
    '    const cardRegimeRaw = new Map();\n    const cardActionRaw = new Map();\n    const analogueEpisodes = [];\n    const regimeRaw = new Map();'
  );
  out = out.replace(
    '        marketRegime: brainLearningMarketRegime(dbRow.input_snapshot),\n        wasCorrect:',
    '        marketRegime: brainLearningMarketRegime(dbRow.input_snapshot),\n        inputSnapshot: dbRow.input_snapshot,\n        wasCorrect:'
  );
  out = out.replace(
    '      mature += 1;\n\n      // v10.8:',
    `      mature += 1;
      analogueEpisodes.push({
        eaId: row.eaId,
        action: row.action,
        cardType: row.cardType,
        ratingBand: row.ratingBand,
        marketRegime: row.marketRegime,
        wasCorrect: Boolean(row.wasCorrect),
        outcomeScore: Number(row.outcomeScore || 0),
        maxRoi: Number(row.maxRoi || 0),
        features: finalAnalogueFeatures(row.inputSnapshot)
      });

      // v10.8:`
  );
  const finalizeAnchor = '    const cardRegime = new Map([...cardRegimeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));';
  if (!out.includes(finalizeAnchor)) throw new Error('[6.9] v11 cardRegime finalize anchor missing');
  out = out.replace(finalizeAnchor, `    try {
      await ensureOwnTradeLifecycleSchemaFinal();
      const ownTradeResult = await pool.query(\`
        SELECT ea_id, net_profit_total, roi_pct, closed_at
        FROM fc_own_trade_lifecycle_v1
        WHERE game_year = $1::smallint AND closed_at >= NOW() - ($2::int * INTERVAL '1 day')
        ORDER BY closed_at DESC LIMIT 5000
      \`, [GAME_YEAR_NUMBER, BRAIN_LEARNING_WINDOW_DAYS]);
      finalHardeningRealizedTrades = ownTradeResult.rows.length;
      finalHardeningOwnTradeError = null;
      for (const trade of ownTradeResult.rows) {
        const roi = Number(trade.roi_pct || 0);
        const createdAt = new Date(trade.closed_at).getTime();
        const ownRow = {
          eaId: String(trade.ea_id || ""), action: "JETZT KAUFEN", cardType: "OWN_REALIZED_TRADE",
          ratingBand: "*", marketRegime: "*", wasCorrect: Number(trade.net_profit_total || 0) > 0,
          outcomeScore: clamp(roi * 10, -100, 100), maxRoi: roi,
          learningWeight: brainLearningRecencyWeight(createdAt, now)
        };
        if (ownRow.eaId) addBrainLearningSample(cardActionRaw, brainLearningCardActionKey(ownRow.eaId, ownRow.action), ownRow, "cardAction");
      }
    } catch (error) {
      finalHardeningOwnTradeError = String(error?.message || error);
    }

${finalizeAnchor}`);
  out = out.replace(
    '      uniqueLearningEpisodes: mature,\n      cardRegime,',
    '      uniqueLearningEpisodes: mature,\n      analogueEpisodes: analogueEpisodes.slice(0, 3000),\n      cardRegime,'
  );

  const decisionAnchor = '    const decision = applyBrainLearningToDecision(normalizedDecision, learningProfile);\n    applyDecisionToRow(row, decision);';
  if (!out.includes(decisionAnchor)) throw new Error('[6.9] decision/learning anchor missing');
  out = out.replace(decisionAnchor, `    let decision = applyBrainLearningToDecision(normalizedDecision, learningProfile);
    const historicalAnalogue = selectHistoricalAnalogues(brainLearning, normalizedDecision?.action, row.cardType, row.overall, input);
    if (historicalAnalogue?.applied) {
      decision = { ...decision, historical_analogue: historicalAnalogue };
      if (decision.action === "JETZT KAUFEN" && historicalAnalogue.samples >= 8 && historicalAnalogue.weightedAccuracy < 44 && historicalAnalogue.averageOutcomeScore <= 0) {
        decision.action = "NOCH WARTEN";
        decision.confidence = Math.min(Number(decision.confidence || 70), 72);
        decision.reason = (String(decision.reason || "") + " kNN-Historie: aehnliche reife Situationen waren zu schwach, daher kein BUY.").slice(0, 1800);
      }
    }
    applyDecisionToRow(row, decision);`);

  out = out.replace(
    '  row.aiHistoricalLearning = decision.historical_learning || null;\n}',
    '  row.aiHistoricalLearning = decision.historical_learning || null;\n  row.aiHistoricalAnalogue = decision.historical_analogue || null;\n}'
  );
  if (!out.includes('v10.69.9.6.9 final evidence/event/liquidity guard')) {
    const marker = '      // v10.69 attach supplemental evidence: Games + Sales History + Popular Rank.';
    const start = out.indexOf(marker);
    if (start < 0) throw new Error('[6.9] evidence attach marker missing');
    const end = out.indexOf('      });', start);
    if (end < 0) throw new Error('[6.9] evidence attach end missing');
    const insertAt = end + '      });'.length;
    const extra = `
      // v10.69.9.6.9 final evidence/event/liquidity guard.
      for (const finalRow of latestTradingRows) {
        applyFinalEvidenceGuards(finalRow, built.brainWork?.get?.(String(finalRow.eaId)) || null);
      }`;
    out = out.slice(0, insertAt) + extra + out.slice(insertAt);
  }

  const lifecycleRouteAnchor = 'app.get("/api/intensive-watchlist", async (req, res) => {';
  if (!out.includes(lifecycleRouteAnchor)) throw new Error('[6.9] lifecycle route anchor missing');
  const lifecycleRoutes = `app.post("/api/position/:eaId/close", async (req, res) => {
  try {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "DATABASE_REQUIRED" });
    const eaId = Number(req.params.eaId);
    const sellPrice = Number(req.body?.sellPrice);
    const positions = await getPositions();
    const position = positions.get(String(eaId));
    if (!position) return res.status(404).json({ ok: false, error: "POSITION_NOT_FOUND" });
    if (!Number.isInteger(sellPrice) || sellPrice <= 0) return res.status(400).json({ ok: false, error: "SELL_PRICE_INVALID" });
    const requestedQty = Number(req.body?.quantity ?? position.quantity ?? 1);
    const quantity = Math.max(1, Math.min(Number(position.quantity || 1), Math.floor(requestedQty)));
    const saleAfterTax = Math.floor(sellPrice * 0.95);
    const eaTax = sellPrice - saleAfterTax;
    const netProfitPerCard = saleAfterTax - Number(position.buyPrice);
    const netProfitTotal = netProfitPerCard * quantity;
    const roiPct = Number(((netProfitPerCard / Number(position.buyPrice)) * 100).toFixed(4));
    const openedAt = position.createdAt ? new Date(position.createdAt) : null;
    const heldMinutes = openedAt && Number.isFinite(openedAt.getTime()) ? Math.max(0, Math.round((Date.now() - openedAt.getTime()) / 60000)) : null;
`;
  const lifecycleRoutes2 = `    await ensureOwnTradeLifecycleSchemaFinal();
    await pool.query(\`INSERT INTO fc_own_trade_lifecycle_v1
      (game_year, ea_id, buy_price, sell_price, quantity, ea_tax, net_profit_total, roi_pct, held_minutes, opened_at, note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)\`, [GAME_YEAR_NUMBER, String(eaId), Number(position.buyPrice), sellPrice, quantity, eaTax, netProfitTotal, roiPct, heldMinutes, position.createdAt || null, String(req.body?.note ?? position.note ?? "").slice(0,500)]);
    const remaining = Number(position.quantity || 1) - quantity;
    if (remaining > 0) await savePosition(eaId, Number(position.buyPrice), remaining, position.note || "");
    else await deletePosition(eaId);
    brainLearningCache.loadedAt = 0;
    res.json({ ok: true, eaId, quantity, buyPrice: Number(position.buyPrice), sellPrice, eaTax, netProfitPerCard, netProfitTotal, roiPct, heldMinutes, learningQueued: true });
  } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
});

app.get("/api/trades/closed", async (req, res) => {
  try {
    if (!dbEnabled) return res.status(503).json({ ok: false, error: "DATABASE_REQUIRED" });
    await ensureOwnTradeLifecycleSchemaFinal();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
    const result = await pool.query(\`SELECT * FROM fc_own_trade_lifecycle_v1 WHERE game_year=$1::smallint ORDER BY closed_at DESC LIMIT $2\`, [GAME_YEAR_NUMBER, limit]);
    res.json({ ok: true, gameYear: GAME_YEAR, rows: result.rows, realObservedOnly: true, synthetic: false });
  } catch (error) { res.status(500).json({ ok: false, error: String(error?.message || error) }); }
});

`;
  if (!out.includes('/api/position/:eaId/close')) out = out.replace(lifecycleRouteAnchor, lifecycleRoutes + lifecycleRoutes2 + lifecycleRouteAnchor);
  const healthAnchor = '    decisionPerformanceLab: {';
  if (out.includes(healthAnchor) && !out.includes('ownTradeLifecycle: {')) {
    out = out.replace(healthAnchor, `    finalTraderHardening: {
      version: FINAL_TRADER_HARDENING_VERSION,
      marketKnowledgeMinSamples: MARKET_KNOWLEDGE_MIN_SAMPLES,
      regimes: ["NORMAL","FLAT","CRASH","PUMP","RECOVERY","SUPPLY","PROMO","SBC","EVO","THIN"],
      historicalAnalogue: "KNN_REAL_MATURE_OUTCOMES",
      timingActions: ["BUY NOW","BUY BELOW X","WAIT 30m","WAIT 3h","HOLD","SELL REVIEW","SELL NOW"],
      sourceReliability: true,
      leadTimeLearning: true,
      copyDuplicateSourceGraph: true,
      liquidityDeteriorationGuard: true,
      eventSupplyTimingGuard: true,
      advisoryOnly: true,
      leakAloneCannotBuy: true
    },
    ownTradeLifecycle: {
      enabled: dbEnabled,
      gameYear: GAME_YEAR,
      realizedTradesInLearningWindow: finalHardeningRealizedTrades,
      lastError: finalHardeningOwnTradeError,
      endpoint: "POST /api/position/:eaId/close",
      learning: "REALIZED_NET_PROFIT_AND_ROI",
      synthetic: false
    },
${healthAnchor}`);
  }

  const required = [
    'FINAL_TRADER_HARDENING_VERSION = "10.69.9.6.9"',
    'MARKET_KNOWLEDGE_MIN_SAMPLES || 18',
    'return "THIN"', 'return "SUPPLY"', 'return "PROMO"', 'return "SBC"', 'return "EVO"',
    'KNN_REAL_MATURE_OUTCOMES',
    'timingAction = "BUY BELOW "',
    '/api/position/:eaId/close',
    'fc_own_trade_lifecycle_v1',
    'v10.69.9.6.9 final evidence/event/liquidity guard',
    'copyDuplicateCount',
    'avgFirstReactionMinutes',
    'leakAloneCannotBuy: true',
    'finalTraderHardening: {'
  ];
  const missing = required.filter(marker => !out.includes(marker));
  if (missing.length) throw new Error(`[6.9] final hardening incomplete: ${missing.join(", ")}`);
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result?.format !== "module") return result;
  const raw = sourceText(result.source);
  if (raw == null) return result;

  if (url.endsWith('/marketEvidenceV1069.js')) {
    const source = patchMarketEvidenceFinal(raw);
    console.log('[v10.69.9.6.9] Evidence freshness + sales/min hardening ACTIVE.');
    return { ...result, source, shortCircuit: true };
  }
  if (url.endsWith('/server.js')) {
    const source = patchServerFinal(raw);
    console.log('[v10.69.9.6.9] FINAL Trader hardening ACTIVE: regimes + kNN + timing + lifecycle + source intelligence.');
    return { ...result, source, shortCircuit: true };
  }
  return result;
}

export const __test = { patchServerFinal, patchMarketEvidenceFinal, sourceText };
