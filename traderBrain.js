import { GoogleGenAI, Type } from "@google/genai";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.7-flash";
const GEMINI_DAILY_BUDGET = Math.max(0, Number.parseInt(process.env.GEMINI_DAILY_BUDGET || "15", 10) || 15);
const GEMINI_FREE_TIER_MAX = 20;
const GEMINI_CACHE_TTL_MS = 30 * 60_000;

let aiClient = null;
const geminiDecisionCache = new Map();

const quotaState = {
  dailyRequestsCount: 0,
  dailyBudget: GEMINI_DAILY_BUDGET,
  freeTierMax: GEMINI_FREE_TIER_MAX,
  quotaExhaustedToday: false,
  lastResetDate: new Date().toISOString().slice(0, 10)
};

function getAiClient() {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "fc-trader-brain-render"
        }
      }
    });
  }
  return aiClient;
}

function checkAndResetQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (quotaState.lastResetDate !== today) {
    quotaState.dailyRequestsCount = 0;
    quotaState.quotaExhaustedToday = false;
    quotaState.lastResetDate = today;
  }
  return quotaState;
}

export function getGeminiQuotaInfo() {
  const q = checkAndResetQuota();
  return {
    usedToday: q.dailyRequestsCount,
    dailyBudget: q.dailyBudget,
    freeTierMax: q.freeTierMax,
    safetyBuffer: Math.max(0, q.freeTierMax - q.dailyBudget),
    remainingBudget: Math.max(0, q.dailyBudget - q.dailyRequestsCount),
    quotaExhausted: q.quotaExhaustedToday || q.dailyRequestsCount >= q.dailyBudget,
    lastResetDate: q.lastResetDate
  };
}

function markGeminiQuotaExhausted() {
  quotaState.quotaExhaustedToday = true;
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function pct(value) {
  return `${value > 0 ? "+" : ""}${num(value).toFixed(1)}%`;
}

export function analyzeMarketPatterns(input) {
  const currentPrice = num(input.currentPrice);
  const change1m = num(input.change1m);
  const change5m = num(input.change5m);
  const change15m = num(input.change15m);
  const change1h = num(input.change1h);
  const change24h = num(input.change24h);
  const low24h = num(input.low24h, currentPrice);
  const high24h = num(input.high24h, currentPrice);
  const distanceTo24hLow = num(input.distanceTo24hLow);
  const ratingMarketRisingPct = num(input.ratingMarketRisingPct);
  const ratingMarketFallingPct = num(input.ratingMarketFallingPct);
  const ratingMarketTrend = input.ratingMarketTrend || "neutral";
  const marketContext = input.marketContext || {};

  const keyFactors = [];
  const eaTaxBreakEvenPrice = Math.ceil(currentPrice / 0.95);

  const distLowPct = low24h > 0
    ? ((currentPrice - low24h) / low24h) * 100
    : distanceTo24hLow;

  const distHighPct = high24h > 0
    ? ((high24h - currentPrice) / high24h) * 100
    : 50;

  const velocityScore = (change1m * 3) + (change5m * 1.5) + (change15m * 0.8);

  const hadPriorDrop =
    change1h <= -7 ||
    change24h <= -10 ||
    change15m <= -6 ||
    (low24h > 0 && high24h > low24h && ((high24h - low24h) / high24h) >= 0.12) ||
    distHighPct >= 14;

  const isNear24hLow = distLowPct <= 10;
  const is1mNotDumping = change1m >= -1;
  const is5mStableOrPositive = change5m >= -0.5;
  // Für ein echtes Kaufsignal müssen 5m und 15m die Erholung positiv bestätigen.
  // Nur "weniger schlecht als 1h" reicht NICHT aus.
  const is5mRecoveryConfirmed = change5m >= 1.0;
  const is15mConfirming = change15m >= 1.0;
  const noHeavyPackSupply = !marketContext.packSupplyActive;
  const isRatingMarketNotDumping =
    ratingMarketFallingPct < 60 && ratingMarketTrend !== "stark_fallend";
  const isNotOverextended = change5m < 15 && change1m < 8 && distHighPct >= 8;

  const isFallingKnife =
    change1m <= -2.5 ||
    change5m <= -6 ||
    (change1m <= -1.5 && change5m <= -3.5) ||
    velocityScore <= -12;

  const isOverboughtPump = change1m >= 8 || change5m >= 16 || change15m >= 32;
  const isMissedEntry =
    isOverboughtPump ||
    (change5m >= 12 && distLowPct >= 18) ||
    (change15m >= 25 && distLowPct >= 20);

  const isConfirmedRecovery =
    hadPriorDrop &&
    isNear24hLow &&
    is1mNotDumping &&
    is5mStableOrPositive &&
    is5mRecoveryConfirmed &&
    is15mConfirming &&
    noHeavyPackSupply &&
    isRatingMarketNotDumping &&
    isNotOverextended &&
    !isFallingKnife &&
    !isMissedEntry;

  const isEarlyStabilization =
    hadPriorDrop &&
    isNear24hLow &&
    !isFallingKnife &&
    !isMissedEntry &&
    !isConfirmedRecovery &&
    change1m >= -1.8;

  const isTakeProfitZone =
    (change24h >= 20 || change1h >= 15) &&
    distHighPct <= 6;

  const isBroadRatingRally =
    ratingMarketRisingPct >= 70 && ratingMarketFallingPct <= 15;

  const isFodderMarketRun =
    Boolean(marketContext.sbcActive) && isBroadRatingRally;

  const isRatingMarketDumping = ratingMarketFallingPct >= 65;
  const ratingMarketAlignment = isBroadRatingRally
    ? "bullish"
    : isRatingMarketDumping
      ? "bearish"
      : "neutral";

  let suggestedAction = "BEOBACHTEN";
  let baseConfidence = 70;
  let risk = "mittel";
  let marketState = "Neutrale Marktbewegung";
  let primaryReason = "Markt konsolidiert ohne klaren Katalysator.";

  if (isFallingKnife) {
    suggestedAction = "NOCH WARTEN";
    baseConfidence = Math.min(95, Math.max(82, 80 + Math.abs(Math.round(change1m * 2))));
    risk = "hoch";
    marketState = "starker Abverkauf / Panik (Fallendes Messer)";
    primaryReason = `1m (${pct(change1m)}) und 5m (${pct(change5m)}) zeigen weiter akuten Abwärtsdruck. Bodenbildung noch nicht bestätigt.`;
    keyFactors.push("Hohe Abverkaufsgeschwindigkeit in den letzten Minuten");
    keyFactors.push("Gefahr des fallenden Messers ohne Bodenabschluss");
    keyFactors.push("Auf Abflachung der 1m- und 5m-Messungen warten");
  } else if (isMissedEntry) {
    suggestedAction = "NICHT KAUFEN";
    baseConfidence = 88;
    risk = "sehr hoch";
    marketState = "überkaufte Hype-Phase / FOMO-Risiko";
    primaryReason = `Der Einstieg wirkt bereits gelaufen (${pct(change5m)} in 5m, ${pct(change15m)} in 15m). Rücksetzer-Risiko ist hoch.`;
    keyFactors.push("Hype-Spike hat den günstigen Kaufkorridor verlassen");
    keyFactors.push("5% EA-Steuer verschlechtert die verbleibende Marge");
    keyFactors.push("Gewinnmitnahmen früher Käufer möglich");
  } else if (isConfirmedRecovery) {
    suggestedAction = "JETZT KAUFEN";
    baseConfidence = Math.min(95, Math.max(88, 88 + Math.round(Math.max(0, change5m * 0.8))));
    risk = "niedrig";
    marketState = "Bestätigte Bodenbildung & Rebound";
    primaryReason = `Vorheriger Abverkauf ist gestoppt. 1m (${pct(change1m)}), 5m (${pct(change5m)}) und 15m (${pct(change15m)}) bestätigen die Erholung nahe dem 24h-Tief.`;
    keyFactors.push(`Nur ${distLowPct.toFixed(1)}% über dem 24h-Tief`);
    keyFactors.push("1m/5m/15m bestätigen gemeinsam die Trendwende");
    keyFactors.push("Kein aktiver Pack-Supply-Druck und Rating-Markt nicht breit fallend");
    keyFactors.push(`Noch ${Math.max(0, distHighPct).toFixed(0)}% Abstand zum 24h-Hoch`);
  } else if (isEarlyStabilization) {
    suggestedAction = "BEOBACHTEN";
    baseConfidence = 78;
    risk = "mittel";
    marketState = "frühe Bodenbildungsphase (unbestätigt)";
    primaryReason = `Erste Stabilisierung sichtbar (1m ${pct(change1m)}), aber 5m (${pct(change5m)}) oder 15m (${pct(change15m)}) bestätigen die Trendwende noch nicht ausreichend.`;
    keyFactors.push("Verkaufsdruck flacht im Tiefbereich ab");
    keyFactors.push(`Nur ${distLowPct.toFixed(1)}% über dem 24h-Tief`);
    keyFactors.push("Weitere 5m/15m-Bestätigung abwarten");
  } else if (isTakeProfitZone) {
    suggestedAction = "VERKAUF PRÜFEN";
    baseConfidence = 86;
    risk = "niedrig";
    marketState = "Widerstandszone / Gewinnmitnahme";
    primaryReason = `Karte notiert nahe am 24h-Hoch (${Math.round(high24h).toLocaleString("de-DE")} Coins) nach starkem Anstieg. Gewinnmitnahme prüfen.`;
    keyFactors.push("Widerstandslevel am 24h-Hoch erreicht");
    keyFactors.push("Rücksetzer nach starkem Anstieg möglich");
  } else if (isBroadRatingRally) {
    // Eine breite Rating-Rallye allein ist noch KEIN Kaufsignal.
    // Erst ein bestätigter Nachfrage-Katalysator (z.B. echte SBC) darf daraus JETZT KAUFEN machen.
    if (marketContext.sbcActive && distHighPct >= 10) {
      suggestedAction = "JETZT KAUFEN";
      baseConfidence = 85;
      risk = "niedrig";
      marketState = "SBC-Fodder-Rallye im Rating-Markt";
      primaryReason = `${ratingMarketRisingPct.toFixed(0)}% der ${input.rating}er steigen. Aktive SBC-Nachfrage bestätigt die breite Bewegung.`;
      keyFactors.push(`Breite Bewegung im ${input.rating}er-Segment`);
      keyFactors.push("SBC-Katalysator bestätigt die Nachfrage");
    } else if (distHighPct >= 10) {
      suggestedAction = "BEOBACHTEN";
      baseConfidence = 76;
      risk = "mittel";
      marketState = "Breite Rating-Markt-Rallye ohne bestätigten Katalysator";
      primaryReason = `${ratingMarketRisingPct.toFixed(0)}% der ${input.rating}er steigen marktweit. Bewegung ist stark, aber ohne bestätigte SBC-/Content-Ursache noch kein automatischer Einstieg.`;
      keyFactors.push(`Breite Bewegung im ${input.rating}er-Segment`);
      keyFactors.push("Katalysator noch nicht bestätigt");
    } else {
      suggestedAction = "HALTEN";
      baseConfidence = 78;
      risk = "mittel";
      marketState = "Rating-Markt-Peak im Aufbau";
      primaryReason = "Rating-Markt ist stark, die Karte liegt aber bereits nah am 24h-Hoch. Nicht hinterherlaufen.";
    }
  } else if (change24h < -10 && distLowPct <= 6) {
    suggestedAction = "BEOBACHTEN";
    baseConfidence = 74;
    risk = "mittel";
    marketState = "Konsolidierung im Tiefbereich";
    primaryReason = "Karte notiert im unteren Bereich der 24h-Spanne, aber ein klarer Erholungsimpuls fehlt noch.";
  } else {
    suggestedAction = "HALTEN";
    baseConfidence = 72;
    risk = "sehr niedrig";
    marketState = "Stabile Seitwärtsphase";
    primaryReason = "Keine anomale Marktbewegung oder bestätigte Einstiegssituation vorhanden.";
  }

  if (marketContext.packSupplyActive) {
    keyFactors.push("Aktiver Pack-Supply kann zusätzlichen Preisdruck erzeugen");
    if (suggestedAction === "JETZT KAUFEN") {
      risk = "hoch";
      baseConfidence = Math.max(50, baseConfidence - 8);
      primaryReason += " Pack-Supply ist aktiv, deshalb erhöhtes Risiko.";
    }
  }

  if (marketContext.sbcActive) {
    keyFactors.push(`Aktive SBC: ${marketContext.sbcActive}`);
  }

  const sbcContext = marketContext.sbcActive
    ? `SBC-Bedarf aktiv: "${marketContext.sbcActive}".`
    : "Keine bestätigte aktive Squad Building Challenge als Nachfrage-Katalysator hinterlegt.";

  const packSupplyContext = marketContext.packSupplyActive
    ? `Pack-Supply aktiv: ${marketContext.packSupplyDetails || "Store Packs / Rewards"}. Zusätzlicher Marktzustrom kann Preise drücken.`
    : "Kein bestätigter akuter Pack-Supply-Druck hinterlegt.";

  const minEntry = Math.round(low24h > 0 ? Math.min(currentPrice * 0.98, low24h) : currentPrice * 0.97);
  const maxEntry = Math.round(currentPrice * 1.01);
  const conservativeTarget = Math.round(Math.max(currentPrice * 1.08, eaTaxBreakEvenPrice * 1.04));
  const optimisticTarget = Math.round(high24h > currentPrice ? high24h * 0.98 : currentPrice * 1.20);
  const afterTaxProfit = Math.floor(conservativeTarget * 0.95) - currentPrice;

  return {
    suggestedAction,
    baseConfidence: Math.min(95, Math.max(10, baseConfidence)),
    marketState,
    risk,
    primaryReason,
    keyFactors,
    eaTaxBreakEvenPrice,
    entryZone: {
      min: minEntry,
      max: maxEntry,
      note: `Kaufzone ${minEntry.toLocaleString("de-DE")} - ${maxEntry.toLocaleString("de-DE")} Coins`
    },
    targetExitZone: {
      conservative: conservativeTarget,
      optimistic: optimisticTarget,
      afterTaxProfit
    },
    sbcContext,
    packSupplyContext,
    indicators: {
      isFallingKnife,
      isBottomForming: isEarlyStabilization || isConfirmedRecovery,
      isConfirmedRecovery,
      isOverboughtPump,
      isMissedEntry,
      isTakeProfitZone,
      isFodderMarketRun,
      isBroadRatingRally,
      velocityScore,
      ratingMarketAlignment
    }
  };
}

export function evaluateDiscordSignals(signals, marketInput, quant, traderProfiles = {}) {
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      signalCount: 0,
      confirmedSignals: 0,
      confluenceScore: 0,
      confidenceModifier: 0,
      summary: "Keine externen Discord-Trader-Signale aktiv.",
      processedSignals: []
    };
  }

  let totalWeight = 0;
  let confirmedWeight = 0;
  let supportiveWeight = 0;
  let contradictoryWeight = 0;
  let confirmedCount = 0;

  const processedSignals = signals.map(signal => {
    const profile = traderProfiles[String(signal.source || "").toLowerCase()] || null;
    const baseReliability = profile?.overallAccuracy ?? num(signal.sourceReliability, 50);
    const specReliability = profile?.specializationAccuracy?.[signal.category] ?? baseReliability;
    const weight = Math.max(0.1, Math.min(1, specReliability / 100));
    totalWeight += weight;

    let marketConfirmation = false;
    let confirmationDetails = "";

    if (signal.call === "KAUFEN") {
      marketConfirmation =
        quant.indicators.isConfirmedRecovery ||
        quant.indicators.isBottomForming ||
        quant.indicators.isFodderMarketRun;

      if (quant.indicators.isFallingKnife) {
        marketConfirmation = false;
        confirmationDetails = "Widerspruch: Kaufsignal, aber der reale Markt fällt noch deutlich.";
      } else if (quant.indicators.isMissedEntry) {
        marketConfirmation = false;
        confirmationDetails = "Widerspruch: Kaufsignal kommt nach einem bereits starken Pump.";
      } else {
        confirmationDetails = marketConfirmation
          ? "Marktdaten bestätigen Bodenbildung, Erholung oder bestätigten Fodder-Run."
          : "Noch keine klare Bestätigung durch die aktuellen Preisdaten.";
      }
    } else if (signal.call === "VERKAUFEN") {
      marketConfirmation =
        quant.indicators.isTakeProfitZone ||
        quant.indicators.isMissedEntry ||
        num(marketInput.change24h) > 15;
      confirmationDetails = marketConfirmation
        ? "Marktdaten bestätigen Widerstand, Überkauf oder deutlichen vorherigen Anstieg."
        : "Verkaufssignal wird vom aktuellen Markt noch nicht klar bestätigt.";
    } else {
      marketConfirmation =
        quant.indicators.isFallingKnife ||
        quant.suggestedAction === "NOCH WARTEN" ||
        quant.suggestedAction === "BEOBACHTEN";
      confirmationDetails = marketConfirmation
        ? "Warten-Signal passt zur vorsichtigen Marktlage."
        : "Warten-Signal ist neutral und wird nicht als Kauf- oder Verkaufssignal gewertet.";
    }

    if (marketConfirmation) {
      confirmedCount++;
      confirmedWeight += weight;
      supportiveWeight += weight;
    } else {
      contradictoryWeight += weight;
    }

    return {
      ...signal,
      sourceReliability: Math.round(specReliability),
      weightedScore: Math.round(weight * 100),
      marketConfirmation,
      confirmationDetails
    };
  });

  const confirmationRatio = totalWeight > 0 ? confirmedWeight / totalWeight : 0;
  const contradictionRatio = totalWeight > 0 ? contradictoryWeight / totalWeight : 0;
  const confluenceScore = Math.max(0, Math.min(100, Math.round(confirmationRatio * 100)));

  let confidenceModifier = 0;
  let summary = "Gemischte Signallage unter den Trader-Quellen.";

  if (signals.length >= 2 && confirmationRatio >= 0.65) {
    confidenceModifier = 8;
    summary = `Hohe Trader-Konfluenz: ${confirmedCount} von ${signals.length} Signalen werden durch Marktdaten bestätigt.`;
  } else if (confirmedCount > 0 && confirmationRatio >= 0.5) {
    confidenceModifier = 4;
    summary = `Moderate Trader-Bestätigung: ${confirmedCount}/${signals.length} Signale sind marktkonform.`;
  } else if (contradictionRatio >= 0.75) {
    confidenceModifier = -10;
    summary = "Warnung: Die Trader-Signale werden vom realen Markt überwiegend nicht bestätigt.";
  }

  return {
    signalCount: signals.length,
    confirmedSignals: confirmedCount,
    confluenceScore,
    confidenceModifier,
    summary,
    processedSignals
  };
}

export function shouldUseGemini(marketData, quant, confluence) {
  const change1m = num(marketData.change1m);
  const change5m = num(marketData.change5m);
  const change15m = num(marketData.change15m);
  const change1h = num(marketData.change1h);
  const rising = num(marketData.ratingMarketRisingPct);
  const falling = num(marketData.ratingMarketFallingPct);
  const trend = marketData.ratingMarketTrend || "neutral";

  if (
    quant.indicators.isFallingKnife ||
    change1m <= -5 ||
    change5m <= -10 ||
    change15m <= -15 ||
    change1h <= -18
  ) {
    return { useGemini: true, triggerReason: "Extremer Preissturz / Panik-Abverkauf" };
  }

  if (quant.suggestedAction === "JETZT KAUFEN" || quant.indicators.isConfirmedRecovery) {
    return { useGemini: true, triggerReason: "Bestätigte Bodenbildung / Kauf-Signal" };
  }

  if (quant.indicators.isOverboughtPump || quant.indicators.isMissedEntry) {
    return { useGemini: true, triggerReason: "Extremer Pump / FOMO-Risiko" };
  }

  if (rising >= 75 || falling >= 70 || trend === "stark_steigend" || trend === "stark_fallend") {
    return { useGemini: true, triggerReason: `Breite Rating-Marktbewegung (${marketData.rating}er)` };
  }

  if (marketData.marketContext?.sbcActive && quant.indicators.isBroadRatingRally) {
    return { useGemini: true, triggerReason: "Bestätigtes SBC-Fodder-Signal" };
  }

  if (quant.suggestedAction === "VERKAUF PRÜFEN") {
    return { useGemini: true, triggerReason: "Verkauf / Gewinnmitnahme prüfen" };
  }

  if (confluence.signalCount >= 2 && (confluence.confluenceScore >= 65 || confluence.confluenceScore <= 30)) {
    return { useGemini: true, triggerReason: "Starke oder widersprüchliche Trader-Signale" };
  }

  return { useGemini: false };
}

function isRateLimitOrQuotaError(error) {
  const httpStatus = error?.status || error?.statusCode || error?.response?.status || null;
  const msg = `${error?.name || ""} ${error?.message || ""} ${httpStatus || ""}`.toLowerCase();
  return (
    httpStatus === 429 ||
    msg.includes("429") ||
    msg.includes("resource_exhausted") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

async function executeGeminiCall(ai, prompt, timeoutMs = 20_000) {
  const aiPromise = ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            enum: ["JETZT KAUFEN", "NOCH WARTEN", "NICHT KAUFEN", "BEOBACHTEN", "HALTEN", "VERKAUF PRÜFEN"]
          },
          confidence: { type: Type.INTEGER },
          reason: { type: Type.STRING },
          context_breakdown: {
            type: Type.OBJECT,
            properties: {
              sbc_context: { type: Type.STRING },
              pack_supply_context: { type: Type.STRING },
              discord_trader_context: { type: Type.STRING }
            },
            required: ["sbc_context", "pack_supply_context", "discord_trader_context"]
          },
          risk: {
            type: Type.STRING,
            enum: ["sehr niedrig", "niedrig", "mittel", "hoch", "sehr hoch"]
          },
          market_state: { type: Type.STRING },
          key_factors: { type: Type.ARRAY, items: { type: Type.STRING } },
          recommended_horizon: { type: Type.STRING }
        },
        required: ["action", "confidence", "reason", "context_breakdown", "risk", "market_state"]
      }
    }
  });

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Gemini API Timeout (${timeoutMs / 1000}s)`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([aiPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function getCacheKey(input) {
  const priceBucket = Math.round(num(input.currentPrice) / 250) * 250;
  const sbcKey = input.marketContext?.sbcActive || "none";
  const packKey = input.marketContext?.packSupplyActive ? "pack1" : "pack0";
  return [
    input.eaId,
    priceBucket,
    num(input.change1m).toFixed(1),
    num(input.change5m).toFixed(1),
    num(input.change15m).toFixed(1),
    input.ratingMarketTrend,
    Math.round(num(input.ratingMarketRisingPct) / 5) * 5,
    sbcKey,
    packKey
  ].join("|");
}

function quantFallback(quant, confluence, modelBadge = "Quantitative Core") {
  return {
    action: quant.suggestedAction,
    confidence: Math.max(10, Math.min(95, quant.baseConfidence + confluence.confidenceModifier)),
    reason: quant.primaryReason,
    risk: quant.risk,
    market_state: quant.marketState,
    context_breakdown: {
      sbc_context: quant.sbcContext,
      pack_supply_context: quant.packSupplyContext,
      discord_trader_context: confluence.summary
    },
    key_factors: quant.keyFactors,
    entry_zone: quant.entryZone,
    target_exit_zone: quant.targetExitZone,
    trader_signals_confluence: {
      signalCount: confluence.signalCount,
      confirmedSignals: confluence.confirmedSignals,
      confluenceScore: confluence.confluenceScore,
      summary: confluence.summary
    },
    recommended_horizon: quant.suggestedAction === "JETZT KAUFEN" ? "15m - 2h" : "Markt weiter beobachten",
    eaTaxBreakEven: quant.eaTaxBreakEvenPrice,
    ai_model_used: modelBadge
  };
}

export async function generateAiTraderDecision(input, quant, confluence) {
  const quota = getGeminiQuotaInfo();

  if (quota.quotaExhausted) {
    return quantFallback(quant, confluence, "Gemini Tageslimit erreicht – Quantitative Core aktiv");
  }

  const ai = getAiClient();
  if (!ai) {
    return quantFallback(quant, confluence, "Quantitative Core – Gemini nicht konfiguriert");
  }

  const gating = shouldUseGemini(input, quant, confluence);
  if (!gating.useGemini) {
    return quantFallback(quant, confluence, "Quantitative Core (Sparsamer Modus)");
  }

  const cacheKey = getCacheKey(input);
  const cached = geminiDecisionCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.timestamp < GEMINI_CACHE_TTL_MS) {
    return {
      ...cached.decision,
      ai_model_used: "Gemini + Quantitative Core (Cache)"
    };
  }

  const traderText = confluence.processedSignals.length
    ? confluence.processedSignals.map(s => `- ${s.source}: ${s.call}, Zuverlässigkeit ${s.sourceReliability}%, Marktbestätigung ${s.marketConfirmation ? "JA" : "NEIN"}, Grund: ${s.reason || "-"}`).join("\n")
    : "Keine externen Trader-Signale vorhanden.";

  const prompt = `
Du bist FC Trader Brain, ein Entscheidungsassistent für EA FC Ultimate Team Trading.
Du kaufst oder verkaufst niemals selbst. Du gibst nur eine Empfehlung.

Regeln:
- Stark gefallen bedeutet NICHT automatisch kaufen.
- Bei weiter fallenden 1m/5m-Werten: NOCH WARTEN.
- JETZT KAUFEN nur bei bestätigter Bodenbildung und Erholung.
- Nach starkem Pump oder FOMO: NICHT KAUFEN.
- Trader-Signale dürfen nur bestätigen, niemals allein einen Kauf auslösen.
- SBC-Kontext und Pack-Supply strikt trennen. Lightning Rounds/Store Packs/Rewards sind KEINE SBCs.
- Confidence maximal 95.
- 5% EA-Steuer berücksichtigen.

Spieler: ${input.playerName}
EA-ID: ${input.eaId}
Rating: ${input.rating}
Kartentyp: ${input.cardType}
Preis: ${Math.round(input.currentPrice)}
1m: ${pct(input.change1m)}
5m: ${pct(input.change5m)}
15m: ${pct(input.change15m)}
1h: ${pct(input.change1h)}
24h: ${pct(input.change24h)}
7d: ${pct(input.change7d)}
30d: ${pct(input.change30d)}
24h Tief: ${Math.round(input.low24h || 0)}
24h Hoch: ${Math.round(input.high24h || 0)}
Abstand zum 24h Tief: ${num(input.distanceTo24hLow).toFixed(2)}%
Rating-Markt: ${input.ratingMarketTrend}, ${num(input.ratingMarketRisingPct).toFixed(0)}% steigen, ${num(input.ratingMarketFallingPct).toFixed(0)}% fallen
SBC: ${input.marketContext?.sbcActive || "keine bestätigte SBC"}
Pack-Supply: ${input.marketContext?.packSupplyActive ? (input.marketContext?.packSupplyDetails || "aktiv") : "kein bestätigter akuter Supply-Druck"}
Promo: ${input.marketContext?.promoActive || "kein Kontext hinterlegt"}

Quantitative Voranalyse:
Aktion: ${quant.suggestedAction}
Confidence: ${quant.baseConfidence}%
Zustand: ${quant.marketState}
Risiko: ${quant.risk}
Grund: ${quant.primaryReason}

Trader-Signale:
${traderText}

Gib nur das strukturierte JSON gemäß Schema zurück.`;

  try {
    let response;
    try {
      response = await executeGeminiCall(ai, prompt, 20_000);
      quotaState.dailyRequestsCount++;
    } catch (error) {
      if (isRateLimitOrQuotaError(error)) {
        markGeminiQuotaExhausted();
        return quantFallback(quant, confluence, "Gemini Tageslimit erreicht – Quantitative Core aktiv");
      }

      if (error?.name === "TimeoutError") {
        return quantFallback(quant, confluence, "Quantitative Core – Gemini Timeout");
      }

      response = await executeGeminiCall(ai, prompt, 20_000);
      quotaState.dailyRequestsCount++;
    }

    const parsed = JSON.parse(response?.text || "{}");
    const decision = {
      action: parsed.action || quant.suggestedAction,
      confidence: Math.max(0, Math.min(95, parsed.confidence ?? quant.baseConfidence)),
      reason: parsed.reason || quant.primaryReason,
      risk: parsed.risk || quant.risk,
      market_state: parsed.market_state || quant.marketState,
      context_breakdown: {
        sbc_context: parsed.context_breakdown?.sbc_context || quant.sbcContext,
        pack_supply_context: parsed.context_breakdown?.pack_supply_context || quant.packSupplyContext,
        discord_trader_context: parsed.context_breakdown?.discord_trader_context || confluence.summary
      },
      key_factors: Array.isArray(parsed.key_factors) && parsed.key_factors.length ? parsed.key_factors : quant.keyFactors,
      entry_zone: quant.entryZone,
      target_exit_zone: quant.targetExitZone,
      trader_signals_confluence: {
        signalCount: confluence.signalCount,
        confirmedSignals: confluence.confirmedSignals,
        confluenceScore: confluence.confluenceScore,
        summary: confluence.summary
      },
      recommended_horizon: parsed.recommended_horizon || "15m - 2h",
      eaTaxBreakEven: quant.eaTaxBreakEvenPrice,
      ai_model_used: "Gemini + Quantitative Core"
    };

    geminiDecisionCache.set(cacheKey, { decision, timestamp: Date.now() });
    return decision;
  } catch (error) {
    if (isRateLimitOrQuotaError(error)) {
      markGeminiQuotaExhausted();
      return quantFallback(quant, confluence, "Gemini Tageslimit erreicht – Quantitative Core aktiv");
    }
    return quantFallback(quant, confluence, "Quantitative Core Fallback");
  }
}

export async function checkGeminiHealth() {
  const apiKeyPresent = Boolean(process.env.GEMINI_API_KEY?.trim());
  const quotaInfo = getGeminiQuotaInfo();

  if (!apiKeyPresent) {
    return {
      apiKeyPresent: false,
      envVarName: "GEMINI_API_KEY",
      configuredModel: GEMINI_MODEL,
      requestStarted: false,
      httpStatus: null,
      responseTimeMs: 0,
      status: "GEMINI_API_KEY_FEHLT",
      errorClass: "MissingApiKeyError",
      errorMessage: "GEMINI_API_KEY ist nicht gesetzt.",
      quotaInfo
    };
  }

  if (quotaInfo.quotaExhausted) {
    return {
      apiKeyPresent: true,
      envVarName: "GEMINI_API_KEY",
      configuredModel: GEMINI_MODEL,
      requestStarted: false,
      httpStatus: 429,
      responseTimeMs: 0,
      status: "RATE_LIMIT",
      errorClass: "QuotaGuard",
      errorMessage: "Lokales Tagesbudget erreicht oder Quota bereits als erschöpft markiert.",
      quotaInfo
    };
  }

  const ai = getAiClient();
  const started = Date.now();
  try {
    const response = await Promise.race([
      ai.models.generateContent({ model: GEMINI_MODEL, contents: "Antworte ausschließlich mit OK" }),
      new Promise((_, reject) => setTimeout(() => {
        const error = new Error("Gemini Verbindungstest Timeout (15s)");
        error.name = "TimeoutError";
        reject(error);
      }, 15_000))
    ]);
    quotaState.dailyRequestsCount++;
    return {
      apiKeyPresent: true,
      envVarName: "GEMINI_API_KEY",
      configuredModel: GEMINI_MODEL,
      requestStarted: true,
      httpStatus: 200,
      responseTimeMs: Date.now() - started,
      status: "OK",
      errorClass: null,
      errorMessage: null,
      rawResponse: String(response?.text || "").trim(),
      quotaInfo: getGeminiQuotaInfo()
    };
  } catch (error) {
    const statusCode = error?.status || error?.statusCode || error?.response?.status || null;
    let status = "FEHLER";
    if (isRateLimitOrQuotaError(error)) {
      status = "RATE_LIMIT";
      markGeminiQuotaExhausted();
    } else if (error?.name === "TimeoutError") {
      status = "TIMEOUT";
    } else if (statusCode === 401 || statusCode === 403) {
      status = "NICHT_AUTORISIERT";
    } else if (statusCode === 404) {
      status = "MODELL_NICHT_VERFUEGBAR";
    }
    return {
      apiKeyPresent: true,
      envVarName: "GEMINI_API_KEY",
      configuredModel: GEMINI_MODEL,
      requestStarted: true,
      httpStatus: statusCode,
      responseTimeMs: Date.now() - started,
      status,
      errorClass: error?.name || "Error",
      errorMessage: error?.message || String(error),
      quotaInfo: getGeminiQuotaInfo()
    };
  }
}

export function calculateNetRoi(buyPrice, sellPrice) {
  if (!Number.isFinite(buyPrice) || buyPrice <= 0 || !Number.isFinite(sellPrice) || sellPrice <= 0) return null;
  const afterTaxReturn = Math.floor(sellPrice * 0.95);
  return Number((((afterTaxReturn - buyPrice) / buyPrice) * 100).toFixed(2));
}

export function evaluateTrackedDecision(action, initialPrice, trackedPrices) {
  const roi5m = calculateNetRoi(initialPrice, trackedPrices.after5m);
  const roi15m = calculateNetRoi(initialPrice, trackedPrices.after15m);
  const roi1h = calculateNetRoi(initialPrice, trackedPrices.after1h);
  const roi6h = calculateNetRoi(initialPrice, trackedPrices.after6h);
  const roi24h = calculateNetRoi(initialPrice, trackedPrices.after24h);

  let wasCorrect = null;
  let outcomeScore = 0;
  let notes = "Noch nicht genügend Folgedaten.";

  if (action === "JETZT KAUFEN") {
    const relevant = [roi15m, roi1h, roi6h].filter(Number.isFinite);
    if (relevant.length) {
      const maxRoi = Math.max(...relevant);
      if (maxRoi >= 3) {
        wasCorrect = true;
        outcomeScore = Math.min(100, Math.round(maxRoi * 5));
        notes = `Kaufsignal erfolgreich: maximal ${maxRoi.toFixed(2)}% Netto-ROI innerhalb 15m-6h.`;
      } else if (maxRoi > 0) {
        wasCorrect = true;
        outcomeScore = 50;
        notes = `Kaufsignal leicht positiv: ${maxRoi.toFixed(2)}% Netto-ROI.`;
      } else {
        wasCorrect = false;
        outcomeScore = -70;
        notes = `Kaufsignal war zu früh: bester Netto-ROI innerhalb 15m-6h ${maxRoi.toFixed(2)}%.`;
      }
    }
  } else if (action === "NOCH WARTEN") {
    const prices = [trackedPrices.after5m, trackedPrices.after15m].filter(Number.isFinite);
    if (prices.length) {
      const lowest = Math.min(...prices);
      const dropPct = ((initialPrice - lowest) / initialPrice) * 100;
      if (dropPct >= 2) {
        wasCorrect = true;
        outcomeScore = 90;
        notes = `Warten war richtig: Preis fiel noch weitere ${dropPct.toFixed(1)}%.`;
      } else if (lowest <= initialPrice) {
        wasCorrect = true;
        outcomeScore = 65;
        notes = "Warten war vertretbar: kein unmittelbarer Ausbruch nach oben.";
      } else {
        wasCorrect = false;
        outcomeScore = -40;
        notes = "Warten war zu lange: Preis stieg direkt nach der Empfehlung.";
      }
    }
  } else if (action === "NICHT KAUFEN") {
    const relevant = [roi1h, roi6h].filter(Number.isFinite);
    if (relevant.length) {
      const best = Math.max(...relevant);
      if (best <= 0) {
        wasCorrect = true;
        outcomeScore = 85;
        notes = `Nicht-Kaufen schützte vor einer unprofitablen Position. Bester Netto-ROI wäre ${best.toFixed(2)}% gewesen.`;
      } else if (best >= 5) {
        wasCorrect = false;
        outcomeScore = -40;
        notes = `Zu konservativ: Nach dem Signal wären noch ${best.toFixed(2)}% Netto-ROI möglich gewesen.`;
      } else {
        wasCorrect = true;
        outcomeScore = 45;
        notes = `Nicht-Kaufen war defensiv vertretbar. Maximaler entgangener Netto-ROI ${best.toFixed(2)}%.`;
      }
    }
  } else if (action === "VERKAUF PRÜFEN") {
    const later = Number.isFinite(trackedPrices.after1h) ? trackedPrices.after1h : trackedPrices.after6h;
    if (Number.isFinite(later)) {
      const move = ((later - initialPrice) / initialPrice) * 100;
      if (move <= 2) {
        wasCorrect = true;
        outcomeScore = 90;
        notes = `Verkauf prüfen war gut: danach nur ${move.toFixed(2)}% Bewegung gegenüber dem Signalpreis.`;
      } else if (move >= 5) {
        wasCorrect = false;
        outcomeScore = -50;
        notes = `Verkaufssignal kam zu früh: Preis stieg danach noch ${move.toFixed(2)}%.`;
      } else {
        wasCorrect = true;
        outcomeScore = 55;
        notes = `Gewinnmitnahme war vertretbar, Restanstieg ${move.toFixed(2)}%.`;
      }
    }
  } else if (action === "HALTEN" || action === "BEOBACHTEN") {
    wasCorrect = null;
    outcomeScore = 0;
    notes = "Neutrale Empfehlung wird nicht hart als richtig/falsch gewertet.";
  }

  const allRois = [roi5m, roi15m, roi1h, roi6h, roi24h].filter(Number.isFinite);
  return {
    wasCorrect,
    outcomeScore,
    roi5m,
    roi15m,
    roi1h,
    roi6h,
    roi24h,
    maxRoi: allRois.length ? Math.max(...allRois) : null,
    notes
  };
}
