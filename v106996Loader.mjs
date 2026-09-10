export const V106996_BOOTSTRAP_VERSION = "10.69.9.6-24m-permanent-ml";

function requiredReplace(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`[v10.69.9.6] ${label} anchor missing`);
  }
  return source.replace(search, replacement);
}

export function patchServerV106996(source) {
  let out = String(source || "");
  out = out.replaceAll("10.69.9.3-final", "10.69.9.6-final");

  if (!out.includes('./permanentMlBrainV106996.js')) {
    const anchor = 'import { createHaCoordinator } from "./haCoordinator.js";';
    out = requiredReplace(
      out,
      anchor,
      `${anchor}\nimport { startPermanentMlBrainV106996, scorePermanentMlV106996, getPermanentMlStatusV106996 } from "./permanentMlBrainV106996.js";\nimport { loadTwoYearAiContextV106996, getTwoYearAiFeedStatusV106996 } from "./twoYearAiContextV106996.js";`,
      "24m ML imports"
    );
  }

  // Existing Brain Learning and Performance Lab become 24-month windows.
  out = out.replace(
    'const BRAIN_LEARNING_WINDOW_DAYS = Math.max(30, Number(process.env.BRAIN_LEARNING_WINDOW_DAYS || 90));',
    'const BRAIN_LEARNING_WINDOW_DAYS = Math.max(30, Number(process.env.BRAIN_LEARNING_WINDOW_DAYS || 730));'
  );
  out = out.replace(
    'const PERFORMANCE_LAB_WINDOW_DAYS = Math.max(30, Number(process.env.PERFORMANCE_LAB_WINDOW_DAYS || 90));',
    'const PERFORMANCE_LAB_WINDOW_DAYS = Math.max(30, Number(process.env.PERFORMANCE_LAB_WINDOW_DAYS || 730));'
  );

  if (!out.includes('v10.69.9.6: 24-month permanent ML score')) {
    const anchor = '    const quant = analyzeMarketPatterns(input);';
    const patch = `    // v10.69.9.6: 24-month permanent ML score. Pure in-memory scoring;\n    // no per-card SQL wait inside the full market scan.\n    input.gameYear = GAME_YEAR;\n    input.permanentMl = scorePermanentMlV106996(input);\n    row.aiPermanentMl = input.permanentMl;\n    const quant = analyzeMarketPatterns(input);`;
    out = requiredReplace(out, anchor, patch, "24m ML scoring hook");
  }

  if (!out.includes('v10.69.9.6: feed real FC25+FC26 history')) {
    const anchor = `      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`;
    const patch = `      // v10.69.9.6: feed real FC25 + FC26 history to Gemini.\n      // Game years stay separate; no raw-price continuity is invented across resets.\n      geminiCandidate.work.input.twoYearHistory730 = await loadTwoYearAiContextV106996({\n        pool: dbEnabled ? pool : null,\n        activeGameYear: GAME_YEAR,\n        eaId: geminiCandidate.work.input.eaId,\n        playerName: geminiCandidate.work.input.playerName,\n        currentPrice: geminiCandidate.work.input.currentPrice\n      });\n\n      const rawDecision = await generateAiTraderDecision(\n        geminiCandidate.work.input,\n        geminiCandidate.work.quant,\n        geminiCandidate.work.confluence\n      );`;
    out = requiredReplace(out, anchor, patch, "24m Gemini history feed");
  }

  if (!out.includes('v10.69.9.6 permanent ML bootstrap')) {
    const anchor = '    await initDb();';
    const patch = `    await initDb();\n    // v10.69.9.6 permanent ML bootstrap. The learned weights live in PostgreSQL.\n    // Heavy retraining runs later and defers while the market monitor is busy.\n    await startPermanentMlBrainV106996({\n      pool: dbEnabled ? pool : null,\n      gameYear: GAME_YEAR,\n      isBusy: () => monitoringBusy\n    });`;
    out = requiredReplace(out, anchor, patch, "24m ML startup");
  }

  if (!out.includes('twoYearAiFeed: getTwoYearAiFeedStatusV106996()')) {
    const anchor = '    ratingStats: latestRatingStats';
    out = requiredReplace(
      out,
      anchor,
      `    twoYearAiFeed: getTwoYearAiFeedStatusV106996(),\n    permanentMl: getPermanentMlStatusV106996(),\n${anchor}`,
      "Trader status 24m fields"
    );
  }

  const required = [
    '10.69.9.6-final',
    './permanentMlBrainV106996.js',
    './twoYearAiContextV106996.js',
    'BRAIN_LEARNING_WINDOW_DAYS || 730',
    'PERFORMANCE_LAB_WINDOW_DAYS || 730',
    'input.permanentMl = scorePermanentMlV106996(input);',
    'twoYearHistory730 = await loadTwoYearAiContextV106996',
    'await startPermanentMlBrainV106996({',
    'twoYearAiFeed: getTwoYearAiFeedStatusV106996()',
    'permanentMl: getPermanentMlStatusV106996()'
  ];
  const missing = required.filter(x => !out.includes(x));
  if (missing.length) throw new Error(`[v10.69.9.6] server patch incomplete: ${missing.join(', ')}`);
  return out;
}

export function patchTraderBrainV106996(source) {
  let out = String(source || "");

  if (!out.includes('const permanentMl = input.permanentMl || null;')) {
    const anchor = '  const marketContext = input.marketContext || {};';
    out = requiredReplace(out, anchor, `${anchor}\n  const permanentMl = input.permanentMl || null;`, "ML quant context");
  }

  if (!out.includes('v10.69.9.6 permanent ML calibration')) {
    const anchor = '  if (marketContext.packSupplyActive) {';
    const block = `  // v10.69.9.6 permanent ML calibration. A validated historical model may\n  // confirm or veto an existing setup, but it cannot manufacture a BUY alone.\n  if (permanentMl?.available) {\n    const p6 = Number(permanentMl.probabilityNetPositive6h);\n    const p24 = Number(permanentMl.probabilityNetPositive24h);\n    const mlConf = Number(permanentMl.confidence || 0);\n    const strongBull = permanentMl.signal === "BULLISH" && mlConf >= 24;\n    const strongBear = permanentMl.signal === "BEARISH" && mlConf >= 24;\n\n    if (suggestedAction === "JETZT KAUFEN" && strongBear && (Number.isFinite(p6) || Number.isFinite(p24))) {\n      suggestedAction = "BEOBACHTEN";\n      baseConfidence = Math.max(68, Math.min(baseConfidence, 82));\n      risk = risk === "sehr hoch" ? risk : "hoch";\n      marketState = marketState + " / ML-Widerspruch";\n      primaryReason += " Das persistente 24-Monats-Outcome-Modell widerspricht dem Einstieg; Kaufsignal wird bis zur neuen Marktbestätigung zurückgestuft.";\n      keyFactors.push("Permanent-ML veto: historische Outcome-Muster sprechen gegen einen sofortigen Einstieg");\n    } else if (suggestedAction === "JETZT KAUFEN" && strongBull) {\n      baseConfidence = Math.min(95, baseConfidence + 4);\n      keyFactors.push("Permanent-ML bestätigt das bestehende Kaufsignal mit validiertem historischem Outcome-Muster");\n    } else if (suggestedAction === "VERKAUF PRÜFEN" && strongBear) {\n      baseConfidence = Math.min(95, baseConfidence + 4);\n      keyFactors.push("Permanent-ML bestätigt erhöhtes Exit-Risiko");\n    } else if (isEarlyStabilization && strongBull) {\n      baseConfidence = Math.min(88, baseConfidence + 3);\n      keyFactors.push("Permanent-ML erkennt ein frühes historisches Chancenmuster; Live-Bestätigung bleibt Pflicht");\n    }\n  }\n\n  // v10.69.9.6 permanent ML calibration\n${anchor}`;
    out = requiredReplace(out, anchor, block, "ML calibration");
  }

  if (!out.includes('Permanent-ML-24M-Chance/Widerspruch')) {
    const anchor = '  if (confluence.signalCount >= 2 && (confluence.confluenceScore >= 65 || confluence.confluenceScore <= 30)) {';
    const gate = `  const ml = marketData.permanentMl || null;\n  if (ml?.available && ml.signal !== "NEUTRAL" && Number(ml.confidence || 0) >= 24) {\n    return { useGemini: true, triggerReason: "Permanent-ML-24M-Chance/Widerspruch" };\n  }\n\n${anchor}`;
    out = requiredReplace(out, anchor, gate, "Gemini 24m ML gate");
  }

  const traderTextAnchor = `  const traderText = confluence.processedSignals.length\n    ? confluence.processedSignals.map(s => \`- \${s.source}: \${s.call}, Zuverlässigkeit \${s.sourceReliability}%, Marktbestätigung \${s.marketConfirmation ? "JA" : "NEIN"}, Grund: \${s.reason || "-"}\`).join("\\n")\n    : "Keine externen Trader-Signale vorhanden.";`;

  if (!out.includes('const twoYearHistory = input.twoYearHistory730 || null;')) {
    const builders = `${traderTextAnchor}\n\n  const twoYearHistory = input.twoYearHistory730 || null;\n  const fmtHistoryNumber = value => Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString("de-DE") : "?";\n  const historyYearText = year => {\n    const y = twoYearHistory?.byGameYear?.[String(year)] || null;\n    if (!y?.available) return "FC" + year + ": keine passende Kartenhistorie";\n    const d365 = y.periods?.d365 || null;\n    return "FC" + year + ": " + Number(y.observedDays || 0) + " beobachtete Tage / Spanne " + Number(y.spanDays || 0).toFixed(1) + "d; " +\n      "365d Low " + fmtHistoryNumber(d365?.low) + ", High " + fmtHistoryNumber(d365?.high) + ", Avg " + fmtHistoryNumber(d365?.avg) + ", Change " + (d365?.changePct ?? "?") + "%";\n  };\n  const twoYearMonthlyText = Array.isArray(twoYearHistory?.monthly) && twoYearHistory.monthly.length\n    ? twoYearHistory.monthly.map(month => {\n        const moveValue = Number(month?.changePct);\n        const move = Number.isFinite(moveValue) ? (moveValue > 0 ? "+" : "") + moveValue.toFixed(1) + "%" : "?";\n        return "FC" + month.gameYear + " " + month.month + ": O " + fmtHistoryNumber(month.open) + " / C " + fmtHistoryNumber(month.close) + " / L " + fmtHistoryNumber(month.low) + " / H " + fmtHistoryNumber(month.high) + " / " + move;\n      }).join(" | ")\n    : "keine Monatsdaten";\n  const twoYearText = twoYearHistory?.available\n    ? [\n        "Ziel 24 Monate / 730 Tage; Quellen FC25 + FC26; synthetisch: NEIN",\n        "Globale reale Abdeckung: " + Number(twoYearHistory.globalCoverage?.combined?.observedCalendarDays || 0) + " Kalendertage, Spanne " + Number(twoYearHistory.globalCoverage?.combined?.spanDays || 0).toFixed(1) + " Tage, full24MonthWindowAvailable=" + (twoYearHistory.full24MonthWindowAvailable === true),\n        historyYearText("25"),\n        historyYearText("26"),\n        "Monatsprofile (max 24, Spieljahre getrennt): " + twoYearMonthlyText\n      ].join("\\n")\n    : "Keine passende echte 24-Monats-Kartenhistorie verfügbar. Grund: " + (twoYearHistory?.reason || "NO_DATA") + ". Keine fehlenden Daten erfinden.";\n\n  const ml = input.permanentMl || null;\n  const permanentMlText = ml?.available\n    ? [\n        "Signal " + ml.signal + ", ML-Confidence " + Number(ml.confidence || 0) + "%",\n        "Netto-positiv nach 5% EA-Steuer: 1h " + (ml.probabilityNetPositive1h ?? "?") + "%, 6h " + (ml.probabilityNetPositive6h ?? "?") + "%, 24h " + (ml.probabilityNetPositive24h ?? "?") + "%, 7d " + (ml.probabilityNetPositive7d ?? "?") + "%",\n        "Gelernte Spieljahre " + (Array.isArray(ml.sourceYearsUsed) ? ml.sourceYearsUsed.join(",") : "?") + "; trusted models " + Number(ml.trustedModels || 0) + "; Samples " + Number(ml.sourceSamples || 0),\n        "Historischer Prior aktiv: " + (ml.historicalPriorUsed ? "JA" : "NEIN")\n      ].join("\\n")\n    : "Noch kein ausreichend validiertes permanentes ML-Modell verfügbar.";`;
    out = requiredReplace(out, traderTextAnchor, builders, "24m Gemini text builders");
  }

  const rulesAnchor = '- 5% EA-Steuer berücksichtigen.';
  if (!out.includes('- FC25 und FC26 niemals als eine durchgehende absolute Preiskurve behandeln.')) {
    out = requiredReplace(
      out,
      rulesAnchor,
      `${rulesAnchor}\n- FC25 und FC26 niemals als eine durchgehende absolute Preiskurve behandeln. Spieljahre haben getrennte Marktökonomien.\n- 24-Monats-Historie dient als Muster-/Priorwissen; full24MonthWindowAvailable=false bedeutet Teilhistorie. Nichts erfinden.\n- Permanent-ML darf ein bestehendes Signal bestätigen oder vetoen, aber niemals alleine JETZT KAUFEN erzeugen.\n- Historische ML-Wahrscheinlichkeiten sind Schätzungen aus validierten Outcomes, keine Gewinngarantie.`,
      "24m AI rules"
    );
  }

  const promptAnchor = '30d: ${pct(input.change30d)}';
  if (!out.includes('24-Monats-Marktgedächtnis (FC25 + FC26, echte DB-Daten):')) {
    out = requiredReplace(
      out,
      promptAnchor,
      `${promptAnchor}\n24-Monats-Marktgedächtnis (FC25 + FC26, echte DB-Daten):\n\${twoYearText}\n\nPermanentes ML (PostgreSQL, Walk-Forward validiert):\n\${permanentMlText}`,
      "24m Gemini prompt"
    );
  }

  const required = [
    'const permanentMl = input.permanentMl || null;',
    'v10.69.9.6 permanent ML calibration',
    'Permanent-ML-24M-Chance/Widerspruch',
    'const twoYearHistory = input.twoYearHistory730 || null;',
    '24-Monats-Marktgedächtnis (FC25 + FC26, echte DB-Daten):',
    'Permanentes ML (PostgreSQL, Walk-Forward validiert):',
    'FC25 und FC26 niemals als eine durchgehende absolute Preiskurve behandeln.'
  ];
  const missing = required.filter(x => !out.includes(x));
  if (missing.length) throw new Error(`[v10.69.9.6] traderBrain patch incomplete: ${missing.join(', ')}`);
  return out;
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context, nextLoad);
  if (result.format !== "module") return result;
  const raw = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");

  if (url.endsWith('/server.js')) {
    const source = patchServerV106996(raw);
    console.log('[v10.69.9.6] 24-month FC25+FC26 permanent ML active: 730d target, separate game-year models, no synthetic rows.');
    return { format: result.format, source, shortCircuit: true };
  }
  if (url.endsWith('/traderBrain.js')) {
    const source = patchTraderBrainV106996(raw);
    console.log('[v10.69.9.6] Quant/Gemini receive 24-month market memory + persistent ML context.');
    return { format: result.format, source, shortCircuit: true };
  }
  return result;
}

export const __test = { patchServerV106996, patchTraderBrainV106996 };
