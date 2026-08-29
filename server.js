import express from "express";
import crypto from "crypto";
import pg from "pg";
import { Client, GatewayIntentBits, Events } from "discord.js";
import {
  analyzeMarketPatterns,
  evaluateDiscordSignals,
  shouldUseGemini,
  generateAiTraderDecision,
  getGeminiQuotaInfo,
  checkGeminiHealth,
  evaluateTrackedDecision
} from "./traderBrain.js";

const { Pool } = pg;

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;

const RAW_GAME_YEAR = String(process.env.GAME_YEAR || "26").trim();
const GAME_YEAR = /^\d{2}$/.test(RAW_GAME_YEAR) ? RAW_GAME_YEAR : "26";

const RATING_MIN = 75;
const RATING_MAX = 99;
const GAME_YEAR_NUMBER = Number(GAME_YEAR);
const DEFAULT_MAIN_RATING_MIN = GAME_YEAR_NUMBER >= 27 ? 82 : RATING_MIN;
const MAIN_RATING_MIN = Math.max(
  RATING_MIN,
  Math.min(RATING_MAX, Number(process.env.MAIN_RATING_MIN || DEFAULT_MAIN_RATING_MIN))
);
const LOW_RATING_ALERT_MOVE_PCT = Math.max(
  5,
  Math.min(40, Number(process.env.LOW_RATING_ALERT_MOVE_PCT || 15))
);

function isLowWatchRating(rating) {
  return GAME_YEAR_NUMBER >= 27 && Number(rating) < MAIN_RATING_MIN;
}

function marketProfile() {
  return {
    gameYear: GAME_YEAR,
    monitoredRatings: [RATING_MIN, RATING_MAX],
    mainRatingMin: MAIN_RATING_MIN,
    mainRatingMax: RATING_MAX,
    lowWatchMin: GAME_YEAR_NUMBER >= 27 ? RATING_MIN : null,
    lowWatchMax: GAME_YEAR_NUMBER >= 27 ? MAIN_RATING_MIN - 1 : null,
    lowRatingAlertMovePct: LOW_RATING_ALERT_MOVE_PCT,
    mode: GAME_YEAR_NUMBER >= 27 ? "FC27_PROFILE" : "FC26_PROFILE",
    note: GAME_YEAR_NUMBER >= 27
      ? `Ratings ${MAIN_RATING_MIN}-${RATING_MAX} sind Hauptmarkt. ${RATING_MIN}-${MAIN_RATING_MIN - 1} bleiben vollständig überwacht, erzeugen aber nur bei ungewöhnlich starken Bewegungen ab ${LOW_RATING_ALERT_MOVE_PCT}% besondere Alerts.`
      : `FC26-Profil: Ratings ${RATING_MIN}-${RATING_MAX} werden normal überwacht und bewertet.`
  };
}

const PRICE_REFRESH_MS = 60_000;
const META_REFRESH_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_PAGES = 60;
const META_CONCURRENCY = 3;

const SOURCE_HEALTH_MIN_ROWS = Math.max(50, Number(process.env.SOURCE_HEALTH_MIN_ROWS || 250));
const SOURCE_HEALTH_MIN_COVERAGE = Math.max(0.05, Math.min(0.8, Number(process.env.SOURCE_HEALTH_MIN_COVERAGE || 0.15)));
const SOURCE_HEALTH_DEGRADED_COVERAGE = Math.max(
  SOURCE_HEALTH_MIN_COVERAGE,
  Math.min(0.9, Number(process.env.SOURCE_HEALTH_DEGRADED_COVERAGE || 0.30))
);
const SOURCE_HEALTH_STALE_MS = Math.max(2, Number(process.env.SOURCE_HEALTH_STALE_MIN || 3)) * 60_000;
const SOURCE_RECOVERY_REQUIRED_CYCLES = Math.max(2, Math.min(10, Number(process.env.SOURCE_RECOVERY_REQUIRED_CYCLES || 3)));

// FUTBIN remains a secondary source. We support either an authorized/licensed
// bulk JSON feed or the public Parse REST wrapper. We never scrape futbin.com
// directly from this service.
const FUTBIN_AUTHORIZED_FEED_URL = String(process.env.FUTBIN_AUTHORIZED_FEED_URL || "").trim();
const FUTBIN_AUTHORIZED_FEED_TOKEN = String(process.env.FUTBIN_AUTHORIZED_FEED_TOKEN || "").trim();
const FUTBIN_PARSE_API_KEY = String(process.env.FUTBIN_PARSE_API_KEY || "").trim();
const FUTBIN_PARSE_BASE_URL = String(
  process.env.FUTBIN_PARSE_BASE_URL ||
  "https://api.parse.bot/scraper/21963078-8a17-40ff-a896-9b0b0ec3e828"
).replace(/\/+$/, "");
const FUTBIN_PARSE_DAILY_BUDGET = Math.max(1, Math.min(500, Number(process.env.FUTBIN_PARSE_DAILY_BUDGET || 6)));
const FUTBIN_PARSE_MIN_INTERVAL_MS = Math.max(5, Number(process.env.FUTBIN_PARSE_MIN_INTERVAL_MIN || 240)) * 60_000;
const FUTBIN_PARSE_CARD_COOLDOWN_MS = Math.max(30, Number(process.env.FUTBIN_PARSE_CARD_COOLDOWN_MIN || 360)) * 60_000;
const FUTBIN_PARSE_MIN_AI_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.FUTBIN_PARSE_MIN_AI_CONFIDENCE || 84)));
const FUTBIN_REFRESH_MS = Math.max(5, Number(process.env.FUTBIN_REFRESH_MIN || 15)) * 60_000;
const FUTBIN_MAX_DIFF_PCT = Math.max(3, Math.min(35, Number(process.env.FUTBIN_MAX_DIFF_PCT || 12)));
const FUTBIN_OUTLIER_DIFF_PCT = Math.max(
  FUTBIN_MAX_DIFF_PCT + 3,
  Math.min(60, Number(process.env.FUTBIN_OUTLIER_DIFF_PCT || 25))
);
const FUTBIN_FALLBACK_MIN_MATCHES = Math.max(10, Number(process.env.FUTBIN_FALLBACK_MIN_MATCHES || 50));
const FUTBIN_TRUST_MIN_MATCHES = Math.max(10, Number(process.env.FUTBIN_TRUST_MIN_MATCHES || 40));
const FUTBIN_MAX_DIVERGENT_SHARE = Math.max(0.05, Math.min(0.9, Number(process.env.FUTBIN_MAX_DIVERGENT_SHARE || 0.35)));
const FUTBIN_MAX_OUTLIER_SHARE = Math.max(0.02, Math.min(0.6, Number(process.env.FUTBIN_MAX_OUTLIER_SHARE || 0.12)));
const FUTBIN_TRUST_TTL_MS = Math.max(5, Number(process.env.FUTBIN_TRUST_TTL_MIN || 30)) * 60_000;

// v10.37: Lauren-James calibration guard. A recovery is not a buy merely because
// several overlapping horizons show the same first green tick.
const STRICT_BUY_RECOVERY_CYCLES = Math.max(2, Math.min(5, Number(process.env.STRICT_BUY_RECOVERY_CYCLES || 3)));
const STRICT_BUY_CYCLE_MIN_GAP_MS = Math.max(30, Math.min(90, Number(process.env.STRICT_BUY_CYCLE_MIN_GAP_SEC || 45))) * 1000;
const STRICT_BUY_DUPLICATE_HORIZON_EPS = Math.max(0.05, Math.min(1.5, Number(process.env.STRICT_BUY_DUPLICATE_HORIZON_EPS || 0.35)));
const STRICT_BUY_SPECIAL_MIN_15M = Number(process.env.STRICT_BUY_SPECIAL_MIN_15M || 0.75);
const STRICT_BUY_SPECIAL_MIN_1H = Number(process.env.STRICT_BUY_SPECIAL_MIN_1H || -1);
const STRICT_BUY_INVALIDATION_DROP_PCT = Math.max(0.5, Math.min(5, Number(process.env.STRICT_BUY_INVALIDATION_DROP_PCT || 1)));

// v10.42: Discord alert sanity guard. Contradictory horizons and a materially
// changed live FUT.GG price must not produce a high-confidence directional alert.
const ALERT_SANITY_RECHECK_DIFF_PCT = Math.max(2, Math.min(25, Number(process.env.ALERT_SANITY_RECHECK_DIFF_PCT || 7)));
const ALERT_SANITY_RECHECK_MIN_MOVE_PCT = Math.max(5, Math.min(40, Number(process.env.ALERT_SANITY_RECHECK_MIN_MOVE_PCT || 10)));
const ALERT_SANITY_OPPOSING_MOVE_PCT = Math.max(3, Math.min(20, Number(process.env.ALERT_SANITY_OPPOSING_MOVE_PCT || 5)));

const cardCache = new Map();
const cardInflight = new Map();

let universe = [];
let universeBuiltAt = 0;

let bulkPriceCache = null;
let bulkPriceInflight = null;

let monitoringStarted = false;
let monitoringBusy = false;
let monitorIntervalHandle = null;
let metadataIntervalHandle = null;
let httpServer = null;
let shuttingDown = false;
let shutdownStartedAt = null;
let shutdownReason = null;
let lastMonitorAt = null;
let lastMonitorError = null;
let latestProcessingHealth = {
  status: "STARTING",
  healthy: false,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  updatedAt: null
};
let latestTradingRows = [];
let latestRatingStats = {};
let latestMarketContext = {
  mood: "neutral",
  packSupplyActive: false,
  source: "market-inference",
  measuredCards: 0,
  confidence: 0,
  updatedAt: null
};
let latestSourceHealth = {
  status: "STARTING",
  healthy: false,
  usable: false,
  reason: "Noch kein erfolgreicher FUT.GG-Marktcheck.",
  universeCards: 0,
  pricedCards: 0,
  coveragePct: 0,
  bulkValues: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  consecutiveFailures: 0,
  updatedAt: null
};
let previousSourceHealthStatus = "STARTING";
let lastSourceHealthDiscordAlertAt = 0;
let sourceRecoveryPending = false;
let sourceRecoveryHealthyCycles = 0;
let futbinFeedCache = null;
let futbinFeedInflight = null;
let latestFutbinFallbackRows = [];
let latestFutbinStatus = {
  configured: Boolean(FUTBIN_AUTHORIZED_FEED_URL),
  status: FUTBIN_AUTHORIZED_FEED_URL ? "STARTING" : "NOT_CONFIGURED",
  usable: false,
  reason: FUTBIN_AUTHORIZED_FEED_URL
    ? "Autorisierter FUTBIN-Feed ist konfiguriert, aber noch nicht geladen."
    : "Kein autorisierter FUTBIN-Feed konfiguriert. Direkter FUTBIN-Web-Scraper bleibt deaktiviert.",
  values: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  updatedAt: null
};
let latestFutbinCrossCheckHealth = {
  status: FUTBIN_AUTHORIZED_FEED_URL ? "STARTING" : "NOT_CONFIGURED",
  trusted: false,
  fallbackEligible: false,
  comparedCards: 0,
  matchCards: 0,
  divergentCards: 0,
  outlierCards: 0,
  divergentShare: 0,
  outlierShare: 0,
  medianAbsDiffPct: null,
  reason: FUTBIN_AUTHORIZED_FEED_URL
    ? "Noch kein belastbarer FUT.GG/FUTBIN-Cross-Check vorhanden."
    : "Kein autorisierter FUTBIN-Feed konfiguriert.",
  lastHealthyAt: null,
  updatedAt: null
};
const futbinParseCardCache = new Map();
const futbinParseCardLastCheck = new Map();
let futbinParseCallsDate = "";
let futbinParseCallsToday = 0;
let futbinParseLastCallAt = 0;
let latestFutbinParseStatus = {
  configured: Boolean(FUTBIN_PARSE_API_KEY),
  status: FUTBIN_PARSE_API_KEY ? "IDLE" : "NOT_CONFIGURED",
  usable: Boolean(FUTBIN_PARSE_API_KEY),
  provider: "Parse FUTBIN API",
  reason: FUTBIN_PARSE_API_KEY
    ? "Öffentliche FUTBIN-API ist konfiguriert und wartet auf einen relevanten Karten-Cross-Check."
    : "FUTBIN_PARSE_API_KEY ist nicht gesetzt.",
  callsToday: 0,
  dailyBudget: FUTBIN_PARSE_DAILY_BUDGET,
  lastCallAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  lastPlayer: null,
  updatedAt: null
};
let lastBrainRunAt = null;
let lastBrainError = null;
let lastGeminiCandidate = null;
let lastGeminiAttemptAt = 0;
let lastEvaluationSweepAt = 0;
let lastBrainLearningRefreshAt = 0;
let lastBrainLearningError = null;
const lastGeminiByCard = new Map();

const BRAIN_LEARNING_REFRESH_MS = Math.max(5, Number(process.env.BRAIN_LEARNING_REFRESH_MIN || 15)) * 60_000;
const BRAIN_LEARNING_PRIOR_ACCURACY = 50;
const BRAIN_LEARNING_PRIOR_STRENGTH = 12;
const BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT = 8;
const BRAIN_LEARNING_WAIT_POSITIVE_CAP = 4;
const BRAIN_LEARNING_EPISODE_MS = 6 * 60 * 60_000;
const BRAIN_LEARNING_WINDOW_DAYS = Math.max(30, Number(process.env.BRAIN_LEARNING_WINDOW_DAYS || 90));
const BRAIN_LEARNING_RECENCY_HALF_LIFE_DAYS = Math.max(3, Number(process.env.BRAIN_LEARNING_RECENCY_HALF_LIFE_DAYS || 14));
const BRAIN_LEARNING_RECENCY_MIN_WEIGHT = Math.max(0.05, Math.min(0.5, Number(process.env.BRAIN_LEARNING_RECENCY_MIN_WEIGHT || 0.2)));
const BRAIN_LEARNING_SEVERITY_MIN_EFFECTIVE = Math.max(3, Number(process.env.BRAIN_LEARNING_SEVERITY_MIN_EFFECTIVE || 6));
const BRAIN_LEARNING_SEVERITY_MAX_ADJUSTMENT = Math.max(1, Math.min(3, Number(process.env.BRAIN_LEARNING_SEVERITY_MAX_ADJUSTMENT || 2)));
const BRAIN_LEARNING_REGIME_MIN_SAMPLES = 4;
const BRAIN_LEARNING_EXACT_MIN_SAMPLES = 4;
const BRAIN_LEARNING_CARDTYPE_MIN_SAMPLES = 6;
const BRAIN_LEARNING_ACTION_MIN_SAMPLES = 10;
const BRAIN_LEARNING_REGIME_MIN_EFFECTIVE = 3;
const BRAIN_LEARNING_EXACT_MIN_EFFECTIVE = 3;
const BRAIN_LEARNING_CARDTYPE_MIN_EFFECTIVE = 5;
const BRAIN_LEARNING_ACTION_MIN_EFFECTIVE = 8;

// v10.47 Decision Performance Lab
// Ziel: nicht nur Signale erzeugen, sondern jede eigenständige Entscheidung
// messbar machen und Confidence nur dann hoch lassen, wenn echte Outcomes sie tragen.
const PERFORMANCE_LAB_WINDOW_DAYS = Math.max(30, Number(process.env.PERFORMANCE_LAB_WINDOW_DAYS || 90));
const PERFORMANCE_LAB_REFRESH_MS = Math.max(5, Number(process.env.PERFORMANCE_LAB_REFRESH_MIN || 10)) * 60_000;
const PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES = Math.max(12, Number(process.env.PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES || 20));
const PERFORMANCE_LAB_MIN_ABSTAIN_SAMPLES = Math.max(
  PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES,
  Number(process.env.PERFORMANCE_LAB_MIN_ABSTAIN_SAMPLES || 24)
);
const PERFORMANCE_LAB_CONFIDENCE_BUFFER = Math.max(2, Math.min(12, Number(process.env.PERFORMANCE_LAB_CONFIDENCE_BUFFER || 7)));
const PERFORMANCE_LAB_MISSED_ENTRY_NET_ROI = Math.max(2, Number(process.env.PERFORMANCE_LAB_MISSED_ENTRY_NET_ROI || 5));
const PERFORMANCE_LAB_FALSE_BUY_MAX_NET_ROI = Number(process.env.PERFORMANCE_LAB_FALSE_BUY_MAX_NET_ROI || 0);
const PERFORMANCE_LAB_BUY_ABSTAIN_ACCURACY = Math.max(35, Math.min(65, Number(process.env.PERFORMANCE_LAB_BUY_ABSTAIN_ACCURACY || 52)));
const PERFORMANCE_LAB_BUY_BLOCK_ACCURACY = Math.max(25, Math.min(
  PERFORMANCE_LAB_BUY_ABSTAIN_ACCURACY,
  Number(process.env.PERFORMANCE_LAB_BUY_BLOCK_ACCURACY || 43)
));

let decisionPerformanceCache = {
  loadedAt: 0,
  updatedAt: null,
  totalMature: 0,
  profiles: new Map(),
  profileList: []
};

let brainLearningCache = {
  loadedAt: 0,
  updatedAt: null,
  totalMatureDecisions: 0,
  rawMatureDecisions: 0,
  uniqueLearningEpisodes: 0,
  regimeExact: new Map(),
  exact: new Map(),
  cardType: new Map(),
  action: new Map(),
  profiles: []
};

const GEMINI_MIN_INTERVAL_MS = Math.max(5, Number(process.env.GEMINI_MIN_INTERVAL_MIN || 30)) * 60_000;
const GEMINI_CARD_COOLDOWN_MS = Math.max(30, Number(process.env.GEMINI_CARD_COOLDOWN_MIN || 120)) * 60_000;

const DISCORD_BOT_TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const DISCORD_ALERT_CHANNEL_ID = String(process.env.DISCORD_ALERT_CHANNEL_ID || "").trim();
const TRADER_SIGNAL_CHANNEL_ID = String(process.env.TRADER_SIGNAL_CHANNEL_ID || "").trim();
// Optionaler, explizit autorisierter Eingang fuer externe Trader-Feeds/Forwarder.
// Ohne Token bleibt der HTTP-Ingest komplett geschlossen.
const TRADER_FEED_INGEST_TOKEN = String(process.env.TRADER_FEED_INGEST_TOKEN || "").trim();
const TRADER_FEED_INGEST_CONFIGURED = Boolean(TRADER_FEED_INGEST_TOKEN);
const TRADER_FEED_MAX_REQUESTS_PER_MIN = Math.max(5, Math.min(300, Number(process.env.TRADER_FEED_MAX_REQUESTS_PER_MIN || 60)));
const TRADER_FEED_MAX_EVENT_AGE_MS = Math.max(1, Math.min(1440, Number(process.env.TRADER_FEED_MAX_EVENT_AGE_MIN || 30))) * 60_000;
const TRADER_FEED_MAX_FUTURE_SKEW_MS = Math.max(1, Math.min(30, Number(process.env.TRADER_FEED_MAX_FUTURE_SKEW_MIN || 3))) * 60_000;
const TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST = String(process.env.TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST || "true").trim().toLowerCase() !== "false";
const TRADER_FEED_ALLOWED_SOURCES = String(process.env.TRADER_FEED_ALLOWED_SOURCES || "")
  .split(/[;,\n]+/)
  .map(value => compactWhitespace(value).slice(0, 120))
  .filter(Boolean);
const TRADER_FEED_ALLOWED_SOURCE_MAP = new Map(
  TRADER_FEED_ALLOWED_SOURCES.map(source => [traderFeedSourceIdentityKey(source), source])
);

// v10.36: kuratierte kostenlose Trader-/Content-Quellen.
// Diese Registry liest KEINE fremden Discord-Server automatisch aus. Sie
// normalisiert nur weitergeleitete oder explizit autorisierte Signale.
const CURATED_TRADER_SOURCES = [
  { id: "john_fut_universe", displayName: "John FUT Universe", aliases: ["john fut universe", "john fut", "fut universe", "johnfut"], channels: [
    { name: "investments", type: "INVESTMENT", category: "SHORT_TERM_FLIPS", defaultCall: "KAUFEN" },
    { name: "sell-time", type: "SELL", category: "SHORT_TERM_FLIPS", defaultCall: "VERKAUFEN" },
    { name: "low-budget", type: "INVESTMENT", category: "SHORT_TERM_FLIPS", defaultCall: "KAUFEN" },
    { name: "flipping", type: "FLIP", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "marquee-matchups", type: "SBC_CONTENT", category: "SBC_FODDER", defaultCall: "BEOBACHTEN" },
    { name: "news", type: "NEWS_LEAK", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" }
  ]},
  { id: "rickth21", displayName: "Rickth21", aliases: ["rickth21", "rick th21", "rickth"], channels: [
    { name: "free-tips", type: "TRADER_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "sells", type: "SELL", category: "SHORT_TERM_FLIPS", defaultCall: "VERKAUFEN" },
    { name: "leaks", type: "LEAK", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "6pm-content", type: "CONTENT", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "evo-sbc-expires", type: "EXPIRY", category: "SBC_FODDER", defaultCall: "BEOBACHTEN" },
    { name: "evolutions", type: "EVO_CONTENT", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" }
  ]},
  { id: "fifa_beat", displayName: "FIFA BEAT", aliases: ["fifa beat", "fifabeat"], channels: [
    { name: "leaks", type: "LEAK", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "sbc-reminder", type: "SBC_CONTENT", category: "SBC_FODDER", defaultCall: "BEOBACHTEN" },
    { name: "packs", type: "SUPPLY", category: "PROMO_CARDS", defaultCall: "BEOBACHTEN" },
    { name: "evolution", type: "EVO_CONTENT", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "trading-bot", type: "TRADER_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "community-calls", type: "COMMUNITY_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null, weight: 0.5 }
  ]},
  { id: "trade_to_glory", displayName: "Trade To Glory", aliases: ["trade to glory", "trade-to-glory", "tradetoglory", "ttg"], channels: [
    { name: "tips-of-the-day", type: "TRADER_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "live-trading", type: "LIVE_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "leaks", type: "LEAK", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "new-packs", type: "SUPPLY", category: "PROMO_CARDS", defaultCall: "BEOBACHTEN" },
    { name: "sbc-updates", type: "SBC_CONTENT", category: "SBC_FODDER", defaultCall: "BEOBACHTEN" },
    { name: "objective-updates", type: "CONTENT", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" }
  ]},
  { id: "birke", displayName: "BIRKE", aliases: ["birke", "birke trading"], channels: [
    { name: "probe-vip-tipp", type: "TRADER_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null },
    { name: "auscashbenachrichtigung", type: "SELL", category: "SHORT_TERM_FLIPS", defaultCall: "VERKAUFEN" },
    { name: "leaks", type: "LEAK", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "neuer-content", type: "CONTENT", category: "LEAKS_CONTENT", defaultCall: "BEOBACHTEN" },
    { name: "community-trading-ideen", type: "COMMUNITY_CALL", category: "SHORT_TERM_FLIPS", defaultCall: null, weight: 0.5 }
  ]}
];

const CURATED_TRADER_ALIAS_MAP = new Map();
for (const source of CURATED_TRADER_SOURCES) {
  for (const alias of [source.displayName, source.id, ...(source.aliases || [])]) {
    CURATED_TRADER_ALIAS_MAP.set(traderFeedSourceIdentityKey(alias), source);
  }
}

const TRADER_MARKET_IMPACT_HORIZONS = [15, 60, 360, 1440];

// v10.46: Strict Rating Feed. Normale automatische Spieler-Alerts aller Kartentypen bleiben stumm; öffentliche Alerts laufen über Ratings. Einzelspieler nur bei eigener Position oder expliziter Intensiv-Watch.
// Keeps v10.38 Market Knowledge Learning and all previous features. Öffentliche Trading-Grundsätze werden
// nicht als Wahrheit behandelt. Lernbare Regeln starten als Hypothesen und
// dürfen erst nach genügend echten FC26-Beobachtungen die Entscheidung leicht
// beeinflussen. Keine Wissensregel darf alleine ein JETZT KAUFEN erzeugen.
const MARKET_KNOWLEDGE_HORIZONS = [15, 60, 360, 1440];
const MARKET_KNOWLEDGE_MIN_SAMPLES = Math.max(6, Math.min(50, Number(process.env.MARKET_KNOWLEDGE_MIN_SAMPLES || 12)));
const MARKET_KNOWLEDGE_MIN_SUPPORT = Math.max(55, Math.min(90, Number(process.env.MARKET_KNOWLEDGE_MIN_SUPPORT || 65)));
const MARKET_KNOWLEDGE_PRIOR_STRENGTH = Math.max(2, Math.min(30, Number(process.env.MARKET_KNOWLEDGE_PRIOR_STRENGTH || 8)));
const FODDER_KNOWLEDGE_RATINGS = Array.from({ length: 9 }, (_, index) => 83 + index);

const MARKET_KNOWLEDGE_RULES = [
  {
    id: "sbc_fodder_demand",
    name: "SBC-Fodder-Nachfrage",
    kind: "LEARNABLE",
    expected: "RISING",
    preferredHorizonMinutes: 60,
    minMovePct: 0.75,
    scope: "FODDER",
    directInfluence: true,
    hypothesis: "Attraktive SBCs können die tatsächlich benötigten Fodder-Ratings durch zusätzliche Nachfrage anheben."
  },
  {
    id: "pack_supply_pressure",
    name: "Pack-/Reward-Supply-Druck",
    kind: "LEARNABLE",
    expected: "FALLING",
    preferredHorizonMinutes: 60,
    minMovePct: 0.75,
    scope: "MARKET",
    directInfluence: true,
    hypothesis: "Viele gleichzeitig geöffnete Packs oder Rewards können kurzfristig zusätzlichen Supply und Preisdruck erzeugen."
  },
  {
    id: "fodder_expiry_cooldown",
    name: "Fodder nach SBC-Ablauf",
    kind: "LEARNABLE",
    expected: "FALLING",
    preferredHorizonMinutes: 60,
    minMovePct: 0.65,
    scope: "FODDER",
    directInfluence: true,
    hypothesis: "Wenn relevante SBC-Nachfrage ausläuft, kann die betroffene Fodder-Nachfrage kurzfristig nachlassen."
  },
  {
    id: "out_of_packs_scarcity",
    name: "Out-of-Packs-Knappheit",
    kind: "LEARNABLE",
    expected: "RISING",
    preferredHorizonMinutes: 360,
    minMovePct: 1.25,
    scope: "TARGET",
    directInfluence: true,
    hypothesis: "Sinkender zukünftiger Supply kann eine konkrete Karte stützen, sofern echte Nachfrage bestehen bleibt."
  },
  {
    id: "leak_market_reaction",
    name: "Leak-Marktreaktion",
    kind: "LEARNABLE",
    expected: "VOLATILITY",
    preferredHorizonMinutes: 60,
    minMovePct: 1.0,
    scope: "MARKET",
    directInfluence: false,
    hypothesis: "Leaks können Erwartungen bereits vor dem eigentlichen Content in den Markt einpreisen. Die Richtung ist nicht vorgegeben."
  },
  {
    id: "promo_price_discovery",
    name: "Promo-Preisfindung",
    kind: "LEARNABLE",
    expected: "VOLATILITY",
    preferredHorizonMinutes: 60,
    minMovePct: 1.25,
    scope: "MARKET",
    directInfluence: false,
    hypothesis: "Neue Promo-/Pack-Phasen können zunächst erhöhte Preisfindungs-Volatilität erzeugen."
  },
  {
    id: "panic_sell_requires_bottom",
    name: "Panic Sell braucht Bodenbestätigung",
    kind: "POLICY",
    expected: "WAIT_FOR_STABILIZATION",
    preferredHorizonMinutes: null,
    minMovePct: null,
    scope: "MARKET",
    directInfluence: true,
    implementation: "v10.37 Strict Buy Guard",
    hypothesis: "Ein starker Preissturz ist allein kein Kaufsignal. Erst Boden und Recovery bestätigen."
  },
  {
    id: "leak_never_buys_alone",
    name: "Leak ist kein Kaufbefehl",
    kind: "POLICY",
    expected: "OBSERVE_FIRST",
    preferredHorizonMinutes: null,
    minMovePct: null,
    scope: "MARKET",
    directInfluence: true,
    implementation: "Trader Market Event Guard",
    hypothesis: "Ein Leak startet Beobachtung und Lernen, aber niemals alleine einen Kauf."
  },
  {
    id: "complementary_goods",
    name: "Komplementäre Karten / Chemistry",
    kind: "SHADOW",
    expected: "MIXED",
    preferredHorizonMinutes: 360,
    minMovePct: 1.0,
    scope: "LINKED_CARDS",
    directInfluence: false,
    hypothesis: "Neue SBC-/Promo-Karten können passende Links stützen und ähnliche Ersatzkarten gleichzeitig unter Druck setzen.",
    limitation: "Noch kein belastbarer Chemistry-/Substitutionsgraph vorhanden. Daher nur als Wissensregel dokumentiert."
  },
  {
    id: "diversification_risk_control",
    name: "Diversifikation / Risikokontrolle",
    kind: "POLICY",
    expected: "RISK_CONTROL",
    preferredHorizonMinutes: null,
    minMovePct: null,
    scope: "PORTFOLIO",
    directInfluence: false,
    hypothesis: "Kapital nicht blind auf eine einzige Karte oder einen einzigen Investment-Typ konzentrieren."
  }
];
const DISCORD_CONFIGURED = Boolean(DISCORD_BOT_TOKEN);
const DISCORD_ALERT_COOLDOWN_MS = Math.max(5, Number(process.env.DISCORD_ALERT_COOLDOWN_MIN || 30)) * 60_000;
const DISCORD_MAX_ALERTS_PER_CYCLE = Math.max(1, Math.min(10, Number(process.env.DISCORD_MAX_ALERTS_PER_CYCLE || 5)));
const DISCORD_MIN_BUY_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_MIN_BUY_CONFIDENCE || 90)));
const DISCORD_MIN_SELL_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_MIN_SELL_CONFIDENCE || 84)));
const DISCORD_MIN_RATING_CONFIDENCE = Math.max(60, Math.min(95, Number(process.env.DISCORD_MIN_RATING_CONFIDENCE || 75)));
// v10.44 Rating-first: normale Base-Karten werden im Discord nach Rating gebündelt; Namen nur per ausklappbarer Liste.
// Einzelne Base-Spielernamen erscheinen nicht als eigener Alarm. Nur bis zu drei
// klar teurere Ausnahmen werden kompakt innerhalb des Rating-Alarms genannt.
const DISCORD_RATING_FIRST_BASE_ALERTS = String(process.env.DISCORD_RATING_FIRST_BASE_ALERTS || "true").toLowerCase() !== "false";
const RATING_PRICE_EXCEPTION_PCT = Math.max(5, Math.min(50, Number(process.env.RATING_PRICE_EXCEPTION_PCT || 12)));
const RATING_PRICE_EXCEPTION_MAX_NAMES = Math.max(1, Math.min(3, Number(process.env.RATING_PRICE_EXCEPTION_MAX_NAMES || 3)));
const DISCORD_TRANSITION_MIN_BUY_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_TRANSITION_MIN_BUY_CONFIDENCE || 84)));
const DISCORD_TRANSITION_MIN_SELL_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_TRANSITION_MIN_SELL_CONFIDENCE || 82)));
const DISCORD_TRADER_CONFLUENCE_MIN_CONFIDENCE = Math.max(70, Math.min(95, Number(process.env.DISCORD_TRADER_CONFLUENCE_MIN_CONFIDENCE || 82)));
const DISCORD_TRADER_CONFLUENCE_MIN_RATING_CONFIDENCE = Math.max(60, Math.min(95, Number(process.env.DISCORD_TRADER_CONFLUENCE_MIN_RATING_CONFIDENCE || 75)));
const DISCORD_TRADER_CONFLUENCE_MIN_RELIABILITY = Math.max(20, Math.min(80, Number(process.env.DISCORD_TRADER_CONFLUENCE_MIN_RELIABILITY || 35)));
const INTENSIVE_WATCH_MOVE_PCT = Math.max(1, Math.min(15, Number(process.env.INTENSIVE_WATCH_MOVE_PCT || 3)));
const INTENSIVE_WATCH_MIN_ALERT_GAP_MS = Math.max(1, Number(process.env.INTENSIVE_WATCH_MIN_ALERT_GAP_MIN || 5)) * 60_000;
const INTENSIVE_WATCH_MAX_ALERTS_PER_CYCLE = Math.max(1, Math.min(5, Number(process.env.INTENSIVE_WATCH_MAX_ALERTS_PER_CYCLE || 2)));

let lastDiscordSendAt = null;
let lastDiscordError = null;
let discordAlertsSent = 0;
let lastDiscordCycleBudget = {
  limit: DISCORD_MAX_ALERTS_PER_CYCLE,
  used: 0,
  blocked: 0,
  startedAt: null,
  finishedAt: null
};
let discordClientReady = false;
let discordResolvedChannelId = null;
let discordResolvedChannelName = null;
let traderSignalResolvedChannelId = null;
let traderSignalResolvedChannelName = null;
let traderSignalsReceived = 0;
let traderSignalsAccepted = 0;
let traderSignalsIgnored = 0;
let lastTraderSignalAt = null;
let lastTraderSignalError = null;
let authorizedTraderFeedReceived = 0;
let authorizedTraderFeedAccepted = 0;
let authorizedTraderFeedIgnored = 0;
let authorizedTraderFeedRateLimited = 0;
let authorizedTraderFeedReplayRejected = 0;
let authorizedTraderFeedSourceRejected = 0;
let traderFeedRateWindowStartedAt = Date.now();
let traderFeedRateWindowCount = 0;
let lastAuthorizedTraderFeedAt = null;
let lastAuthorizedTraderFeedSource = null;
let lastAuthorizedTraderFeedError = null;
let traderConfluenceAlertsSent = 0;
let traderConfluenceInvalidationsSent = 0;
let traderConfluenceExpirationsSent = 0;
let lastTraderConfluenceAlertAt = null;
let lastTraderConfluenceInvalidationAt = null;
let lastTraderConfluenceExpirationAt = null;
let lastTraderConfluenceAlertError = null;
let lastTraderConfluenceGate = null;
const traderConfluenceSuppressedSignals = new Set();
let discordBotTag = null;
let discordGuildCount = 0;
let discordClient = null;
let discordLoginPromise = null;
const memoryDiscordAlertState = new Map();
const memoryBrainState = new Map();
const memoryTraderSignals = [];
const memoryIntensiveWatchlist = new Map();
let intensiveWatchAlertsSent = 0;
let lastIntensiveWatchAlertAt = null;
let lastIntensiveWatchError = null;

const memoryHistory = new Map();
const lastMemoryPrice = new Map();
const memoryPositions = new Map();

// Per-cycle price path used only for bottom/recovery confirmation. Unlike the
// normal price history, equal prices are intentionally kept because "held for
// three cycles" is meaningful even without a new price tick.
const strictBuyCycleHistory = new Map();
let strictBuyGuardStats = {
  evaluatedBuyCandidates: 0,
  allowedBuyCandidates: 0,
  blockedBuyCandidates: 0,
  confidenceCapped: 0,
  duplicateHorizonBlocks: 0,
  recoveryBlocks: 0,
  historicalBlocks: 0,
  futbinBlocks: 0,
  lastDecision: null,
  updatedAt: null
};

const dbEnabled = Boolean(process.env.DATABASE_URL);

const pool = dbEnabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: false },
      max: 4
    })
  : null;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      const error = new Error(`${url} -> HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;

      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        results[i] = { ok: false, error: String(error), input: items[i] };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function classifyCard(card) {
  const rarity = String(card.rarityName || "").toLowerCase();
  const group = String(card.rarityGroupName || "").toLowerCase();

  if (rarity === "rare" || group === "rare") return "Base Rare";

  if (
    rarity.includes("common") ||
    group.includes("common") ||
    rarity === "non-rare"
  ) {
    return "Base Common";
  }

  return "Special";
}

function futggItemIdFromUrl(value) {
  const url = String(value || "");
  // FUT.GG card URLs end in /<gameYear>-<itemId>/ .
  // Transferkarten können denselben Spieler haben, aber eine neue Item-ID.
  const match = url.match(/\/\d{2}-(\d+)\/?(?:[?#].*)?$/);
  const itemId = match ? Number(match[1]) : NaN;
  return Number.isFinite(itemId) && itemId > 0 ? itemId : null;
}

async function collectAllCardsForRating(rating, force = false) {
  const cached = cardCache.get(rating);

  if (
    !force &&
    cached &&
    Date.now() - cached.savedAt < META_REFRESH_MS
  ) {
    return cached.data;
  }

  if (cardInflight.has(rating)) {
    return cardInflight.get(rating);
  }

  const promise = (async () => {
    const cards = [];
    const seen = new Set();
    let pagesRead = 0;

    for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
      const pagePart = pageNumber === 1 ? "" : `&page=${pageNumber}`;

      const url =
        `https://www.fut.gg/api/fut/players/v2/${GAME_YEAR}/` +
        `?overall__gte=${rating}&overall__lte=${rating}` +
        `&sorts=current_price${pagePart}`;

      let json;

      try {
        json = await fetchJson(url);
      } catch (error) {
        if (pageNumber > 1 && error?.status === 404) break;
        throw error;
      }

      const rows = Array.isArray(json?.data) ? json.data : [];
      if (!rows.length) break;

      let added = 0;

      for (const p of rows) {
        const absoluteUrl = p.url ? new URL(p.url, "https://www.fut.gg").href : null;
        const urlItemId = futggItemIdFromUrl(absoluteUrl);

        // WICHTIG: nicht nur nach Spieler-ID deduplizieren.
        // Nach Transfers kann derselbe Spieler zwei handelbare Rare-Items besitzen
        // (z.B. alter Verein + neuer Verein). FUT.GG trennt sie über die Item-ID
        // im Karten-URL.
        const uniqueItemId =
          urlItemId ??
          (Number.isFinite(Number(p.itemId)) ? Number(p.itemId) : null) ??
          (Number.isFinite(Number(p.resourceId)) ? Number(p.resourceId) : null) ??
          (Number.isFinite(Number(p.eaId)) ? Number(p.eaId) : null) ??
          (Number.isFinite(Number(p.id)) ? Number(p.id) : null);

        const key = uniqueItemId ?? absoluteUrl;
        if (key == null || seen.has(String(key))) continue;

        seen.add(String(key));
        added++;

        const card = {
          id: Number.isFinite(Number(p.id)) ? Number(p.id) : null,
          // eaId bleibt im restlichen Brain die eindeutige Markt-/Item-ID.
          // Bei Transferkarten bevorzugen wir deshalb die ID aus dem FUT.GG-URL.
          eaId: Number.isFinite(Number(uniqueItemId)) ? Number(uniqueItemId) : null,
          sourceEaId: Number.isFinite(Number(p.eaId)) ? Number(p.eaId) : null,
          itemId: Number.isFinite(Number(uniqueItemId)) ? Number(uniqueItemId) : null,
          overall: Number.isFinite(Number(p.overall)) ? Number(p.overall) : rating,
          name:
            p.commonName ||
            p.cardName ||
            [p.firstName, p.lastName].filter(Boolean).join(" ") ||
            null,
          cardName: p.cardName ?? null,
          rarityName:
            p.rarityName ??
            p.rarity?.name ??
            p.rarity?.label ??
            null,
          rarityGroupName:
            p.rarityGroupName ??
            p.rarityGroup?.name ??
            p.rarity?.groupName ??
            null,
          gender:
            p.gender?.name ??
            p.genderName ??
            p.gender ??
            null,
          position: p.position ?? null,
          club: p.club?.name ?? p.uniqueClub?.name ?? null,
          nation: p.nation?.name ?? null,
          league: p.league?.name ?? null,
          url: absoluteUrl,
          slug: p.slug ?? null
        };

        card.cardType = classifyCard(card);
        cards.push(card);
      }

      pagesRead++;

      if (added === 0) break;
    }

    const data = {
      rating,
      pagesRead,
      cards
    };

    cardCache.set(rating, {
      savedAt: Date.now(),
      data
    });

    return data;
  })();

  cardInflight.set(rating, promise);

  try {
    return await promise;
  } finally {
    cardInflight.delete(rating);
  }
}


async function collectRatingGenderSupplements(rating) {
  const targetRating = Number(rating);
  if (!Number.isFinite(targetRating)) return [];

  // FUT.GG exposes gender as a filter in its player UI. The exact API value has
  // changed before, so the manual rating-list lookup tries a few harmless variants
  // and merges whatever FUT.GG accepts. Unknown query parameters simply yield the
  // normal result and are deduplicated below.
  const genderVariants = [
    "gender=female",
    "gender=women",
    "gender=1",
    "gender=2"
  ];

  const results = await mapLimit(genderVariants, 2, async variant => {
    const url =
      `https://www.fut.gg/api/fut/players/v2/${GAME_YEAR}/` +
      `?overall__gte=${targetRating}&overall__lte=${targetRating}` +
      `&sorts=current_price&${variant}`;

    try {
      const json = await fetchJson(url);
      return Array.isArray(json?.data) ? json.data : [];
    } catch (error) {
      return [];
    }
  });

  const cards = [];
  const seen = new Set();

  for (const rows of results) {
    for (const p of rows || []) {
      const absoluteUrl = p.url ? new URL(p.url, "https://www.fut.gg").href : null;
      const urlItemId = futggItemIdFromUrl(absoluteUrl);
      const uniqueItemId =
        urlItemId ??
        (Number.isFinite(Number(p.itemId)) ? Number(p.itemId) : null) ??
        (Number.isFinite(Number(p.resourceId)) ? Number(p.resourceId) : null) ??
        (Number.isFinite(Number(p.eaId)) ? Number(p.eaId) : null) ??
        (Number.isFinite(Number(p.id)) ? Number(p.id) : null);

      if (!Number.isFinite(Number(uniqueItemId))) continue;
      const key = String(uniqueItemId);
      if (seen.has(key)) continue;
      seen.add(key);

      const card = {
        id: Number.isFinite(Number(p.id)) ? Number(p.id) : null,
        eaId: Number(uniqueItemId),
        sourceEaId: Number.isFinite(Number(p.eaId)) ? Number(p.eaId) : null,
        itemId: Number(uniqueItemId),
        overall: Number.isFinite(Number(p.overall)) ? Number(p.overall) : targetRating,
        name:
          p.commonName ||
          p.cardName ||
          [p.firstName, p.lastName].filter(Boolean).join(" ") ||
          null,
        cardName: p.cardName ?? null,
        rarityName:
          p.rarityName ??
          p.rarity?.name ??
          p.rarity?.label ??
          null,
        rarityGroupName:
          p.rarityGroupName ??
          p.rarityGroup?.name ??
          p.rarity?.groupName ??
          null,
        position: p.position ?? null,
        club: p.club?.name ?? p.uniqueClub?.name ?? null,
        nation: p.nation?.name ?? null,
        league: p.league?.name ?? null,
        gender: p.gender?.name ?? p.genderName ?? p.gender ?? null,
        url: absoluteUrl,
        slug: p.slug ?? null
      };

      card.cardType = classifyCard(card);
      cards.push(card);
    }
  }

  return cards;
}

async function ensureUniverse(force = false) {
  if (
    !force &&
    universe.length &&
    Date.now() - universeBuiltAt < META_REFRESH_MS
  ) {
    return universe;
  }

  const ratings = [];
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating++) {
    ratings.push(rating);
  }

  const results = await mapLimit(
    ratings,
    META_CONCURRENCY,
    rating => collectAllCardsForRating(rating, force)
  );

  const all = [];

  for (const result of results) {
    if (result?.cards) all.push(...result.cards);
  }

  const deduped = [];
  const seen = new Set();

  for (const card of all) {
    const uniqueId =
      (Number.isFinite(Number(card.itemId)) ? Number(card.itemId) : null) ??
      futggItemIdFromUrl(card.url) ??
      (Number.isFinite(Number(card.eaId)) ? Number(card.eaId) : null);

    if (!Number.isFinite(Number(uniqueId))) continue;

    const key = String(uniqueId);
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push({
      ...card,
      eaId: Number(uniqueId),
      itemId: Number(uniqueId)
    });
  }

  universe = deduped;
  universeBuiltAt = Date.now();

  return universe;
}

function buildIds(priceData) {
  if (!Number.isFinite(priceData?.id0) || !Array.isArray(priceData?.d)) {
    throw new Error("Unexpected FUT.GG PS5 bulk-price format");
  }

  const ids = [priceData.id0];
  let current = priceData.id0;

  for (const delta of priceData.d) {
    if (!Number.isFinite(delta)) continue;
    current += delta;
    ids.push(current);
  }

  return ids;
}

async function loadBulkPs5Prices(force = false) {
  if (
    !force &&
    bulkPriceCache &&
    Date.now() - bulkPriceCache.savedAt < PRICE_REFRESH_MS
  ) {
    return bulkPriceCache;
  }

  if (bulkPriceInflight) {
    return bulkPriceInflight;
  }

  bulkPriceInflight = (async () => {
    const manifest = await fetchJson(`https://r2.fut.gg/${GAME_YEAR}/manifest.json`);
    const hash = manifest["player-prices-ps5"];

    if (!hash) {
      throw new Error("player-prices-ps5 missing from FUT.GG manifest");
    }

    const url =
      `https://r2.fut.gg/${GAME_YEAR}/player-prices-ps5.v1.${hash}.json`;

    const data = await fetchJson(url);

    if (!Array.isArray(data?.p)) {
      throw new Error("FUT.GG PS5 bulk-price array missing");
    }

    const ids = buildIds(data);

    if (ids.length !== data.p.length) {
      throw new Error(
        `Price mapping length mismatch: ids=${ids.length}, prices=${data.p.length}`
      );
    }

    const map = new Map();

    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], {
        price:
          Number.isFinite(data.p[i]) && data.p[i] > 0
            ? data.p[i]
            : null,
        statusCode:
          Array.isArray(data.s)
            ? data.s[i] ?? null
            : null
      });
    }

    bulkPriceCache = {
      savedAt: Date.now(),
      map,
      totalValues: data.p.length,
      sourceUrl: url
    };

    return bulkPriceCache;
  })();

  try {
    return await bulkPriceInflight;
  } finally {
    bulkPriceInflight = null;
  }
}

function currentPricedCards(cards, bulk) {
  const rows = [];

  for (const card of cards) {
    const candidates = [
      Number(card.itemId),
      Number(card.eaId),
      Number(card.sourceEaId),
      Number(card.id)
    ].filter(value => Number.isFinite(value) && value > 0);

    let priceRow = null;
    let priceKey = null;
    for (const candidate of [...new Set(candidates)]) {
      const hit = bulk.map.get(candidate);
      if (hit && Number.isFinite(hit.price)) {
        priceRow = hit;
        priceKey = candidate;
        break;
      }
    }

    if (!priceRow || !Number.isFinite(priceRow.price)) continue;

    rows.push({
      ...card,
      price: priceRow.price,
      priceStatusCode: priceRow.statusCode,
      priceLookupId: priceKey
    });
  }

  return rows;
}

function normalizeAuthorizedFutbinFeed(payload) {
  const map = new Map();
  let rows = [];

  if (Array.isArray(payload)) {
    rows = payload;
  } else if (Array.isArray(payload?.prices)) {
    rows = payload.prices;
  } else if (Array.isArray(payload?.items)) {
    rows = payload.items;
  } else if (Array.isArray(payload?.data)) {
    rows = payload.data;
  } else if (payload?.prices && typeof payload.prices === "object") {
    rows = Object.entries(payload.prices).map(([eaId, value]) => {
      if (value && typeof value === "object") return { eaId, ...value };
      return { eaId, price: value };
    });
  } else if (payload?.data && typeof payload.data === "object") {
    rows = Object.entries(payload.data).map(([eaId, value]) => {
      if (value && typeof value === "object") return { eaId, ...value };
      return { eaId, price: value };
    });
  }

  for (const item of rows) {
    const eaId = Number(item?.eaId ?? item?.ea_id ?? item?.resourceId ?? item?.resource_id);
    const price = Number(
      item?.price ??
      item?.currentPrice ??
      item?.current_price ??
      item?.consolePrice ??
      item?.console_price ??
      item?.psPrice ??
      item?.ps_price
    );

    if (!Number.isFinite(eaId) || eaId <= 0) continue;
    if (!Number.isFinite(price) || price <= 0) continue;

    map.set(eaId, {
      price: Math.round(price),
      updatedAt: item?.updatedAt ?? item?.updated_at ?? payload?.updatedAt ?? payload?.updated_at ?? null
    });
  }

  return map;
}

async function loadAuthorizedFutbinFeed(force = false) {
  if (!FUTBIN_AUTHORIZED_FEED_URL) {
    latestFutbinStatus = {
      ...latestFutbinStatus,
      configured: false,
      status: "NOT_CONFIGURED",
      usable: false,
      reason: "Kein autorisierter FUTBIN-Feed konfiguriert. Direkter FUTBIN-Web-Scraper bleibt deaktiviert.",
      updatedAt: new Date().toISOString()
    };
    return null;
  }

  if (
    !force &&
    futbinFeedCache &&
    Date.now() - futbinFeedCache.savedAt < FUTBIN_REFRESH_MS
  ) {
    return futbinFeedCache;
  }

  if (futbinFeedInflight) return futbinFeedInflight;

  futbinFeedInflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const headers = {
        accept: "application/json",
        "user-agent": "FC-Trader-Brain/10.33"
      };
      if (FUTBIN_AUTHORIZED_FEED_TOKEN) {
        headers.authorization = `Bearer ${FUTBIN_AUTHORIZED_FEED_TOKEN}`;
      }

      const response = await fetch(FUTBIN_AUTHORIZED_FEED_URL, {
        signal: controller.signal,
        headers
      });

      if (!response.ok) {
        throw new Error(`Authorized FUTBIN feed -> HTTP ${response.status}`);
      }

      const payload = await response.json();
      const map = normalizeAuthorizedFutbinFeed(payload);
      if (!map.size) throw new Error("Authorized FUTBIN feed enthält keine eaId/price-Werte");

      futbinFeedCache = {
        savedAt: Date.now(),
        map,
        values: map.size,
        sourceUrl: FUTBIN_AUTHORIZED_FEED_URL
      };

      latestFutbinStatus = {
        configured: true,
        status: "READY",
        usable: true,
        reason: `${map.size} autorisierte FUTBIN-Preiswerte geladen.`,
        values: map.size,
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: latestFutbinStatus.lastFailureAt || null,
        lastError: null,
        updatedAt: new Date().toISOString()
      };

      return futbinFeedCache;
    } catch (error) {
      latestFutbinStatus = {
        ...latestFutbinStatus,
        configured: true,
        status: "ERROR",
        usable: false,
        reason: "Autorisierter FUTBIN-Feed konnte nicht geladen werden.",
        lastFailureAt: new Date().toISOString(),
        lastError: String(error?.message || error),
        updatedAt: new Date().toISOString()
      };
      throw error;
    } finally {
      clearTimeout(timer);
    }
  })();

  try {
    return await futbinFeedInflight;
  } finally {
    futbinFeedInflight = null;
  }
}

async function loadAuthorizedFutbinFeedSafe(force = false) {
  try {
    return await loadAuthorizedFutbinFeed(force);
  } catch (error) {
    console.warn("FUTBIN authorized feed error:", error?.message || error);
    return null;
  }
}

function futbinParseDateKey() {
  return new Date().toISOString().slice(0, 10);
}

function refreshFutbinParseDailyBudget() {
  const key = futbinParseDateKey();
  if (futbinParseCallsDate !== key) {
    futbinParseCallsDate = key;
    futbinParseCallsToday = 0;
  }
  latestFutbinParseStatus.callsToday = futbinParseCallsToday;
  latestFutbinParseStatus.dailyBudget = FUTBIN_PARSE_DAILY_BUDGET;
  return {
    used: futbinParseCallsToday,
    budget: FUTBIN_PARSE_DAILY_BUDGET,
    remaining: Math.max(0, FUTBIN_PARSE_DAILY_BUDGET - futbinParseCallsToday)
  };
}

function parseFutbinCoinValue(value) {
  if (Number.isFinite(value)) return Math.round(Number(value));
  const raw = String(value ?? "").trim().toUpperCase().replace(/[,\s]/g, "");
  if (!raw || ["0", "-", "N/A", "NA", "UNAVAILABLE", "NULL"].includes(raw)) return null;
  const match = raw.match(/^([0-9]+(?:\.[0-9]+)?)([KMB])?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base) || base <= 0) return null;
  const factor = match[2] === "B" ? 1_000_000_000 : match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1;
  return Math.round(base * factor);
}

function futbinComparableText(value) {
  return compactWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function futbinParseRows(payload) {
  const root = payload?.data ?? payload ?? {};
  const candidates = [
    root?.players,
    root?.results,
    root?.items,
    payload?.players,
    payload?.results,
    payload?.items,
    Array.isArray(root) ? root : null,
    Array.isArray(payload) ? payload : null
  ];
  return candidates.find(Array.isArray) || [];
}

function futbinParseMatchForRow(row, items) {
  const wantedName = futbinComparableText(row?.name);
  const wantedRating = Number(row?.overall);
  const wantedPosition = futbinComparableText(row?.position).split(" ")[0] || "";
  const wantedVersion = futbinComparableText(`${row?.rarityName || ""} ${row?.cardType || ""}`);

  const scored = [];
  for (const item of Array.isArray(items) ? items : []) {
    const price = parseFutbinCoinValue(
      item?.price_ps ?? item?.pricePS ?? item?.prices?.ps ?? item?.prices?.console ?? item?.price_console
    );
    if (!Number.isFinite(price) || price <= 0) continue;

    const itemName = futbinComparableText(item?.name ?? item?.full_name ?? item?.player_name);
    const itemRating = Number(item?.rating ?? item?.overall);
    if (!wantedName || !itemName) continue;
    if (!(itemName === wantedName || itemName.includes(wantedName) || wantedName.includes(itemName))) continue;
    if (Number.isFinite(wantedRating) && Number.isFinite(itemRating) && itemRating !== wantedRating) continue;

    let score = itemName === wantedName ? 60 : 40;
    if (Number.isFinite(wantedRating) && itemRating === wantedRating) score += 25;

    const itemPosition = futbinComparableText(item?.position);
    if (wantedPosition && itemPosition.includes(wantedPosition)) score += 5;

    const itemVersion = futbinComparableText(item?.version ?? item?.rarity ?? item?.card_type);
    if (wantedVersion && itemVersion) {
      const wantedTokens = new Set(wantedVersion.split(" ").filter(token => token.length >= 3));
      const itemTokens = new Set(itemVersion.split(" ").filter(token => token.length >= 3));
      let overlap = 0;
      for (const token of wantedTokens) if (itemTokens.has(token)) overlap++;
      if (overlap > 0) score += Math.min(15, overlap * 5);
    }

    if (Number.isFinite(row?.price) && row.price > 0) {
      const absDiff = Math.abs((price - row.price) / row.price) * 100;
      if (absDiff <= 5) score += 5;
      else if (absDiff <= 15) score += 2;
    }

    scored.push({ item, price, score });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < 70) return null;

  if (scored.length > 1 && scored[1].score === scored[0].score) {
    const a = scored[0].price;
    const b = scored[1].price;
    const spread = Math.abs(a - b) / Math.max(1, Math.min(a, b)) * 100;
    if (spread > 5) return null;
  }

  const best = scored[0];
  return {
    price: best.price,
    matchConfidence: Math.max(70, Math.min(99, best.score)),
    futbinId: best.item?.id ?? best.item?.player_id ?? null,
    futbinUrl: best.item?.url ?? null,
    version: best.item?.version ?? best.item?.rarity ?? null
  };
}

function futbinParseCandidate(row) {
  if (!FUTBIN_PARSE_API_KEY) return false;
  if (!row || Number.isFinite(row.futbinPrice)) return false;
  const confidence = Number(row.aiConfidence || 0);
  const movement = Math.max(
    Math.abs(Number(row.change1m || 0)),
    Math.abs(Number(row.change5m || 0)),
    Math.abs(Number(row.change15m || 0))
  );
  const guardedStrongBuy =
    row?.aiBuyGuard?.originalAction === "JETZT KAUFEN" &&
    Number(row?.aiBuyGuard?.originalConfidence || 0) >= Math.max(78, FUTBIN_PARSE_MIN_AI_CONFIDENCE - 6);

  if (row.tracked && confidence >= 75) return true;
  if (guardedStrongBuy) return true;
  if (["JETZT KAUFEN", "VERKAUF PRÜFEN", "JETZT VERKAUFEN"].includes(row.aiAction) && confidence >= FUTBIN_PARSE_MIN_AI_CONFIDENCE) return true;
  if (row.aiAction === "NOCH WARTEN" && confidence >= 90 && movement >= 10) return true;
  return false;
}

async function fetchFutbinParseCrossCheck(row) {
  if (!FUTBIN_PARSE_API_KEY || !row?.eaId || !row?.name) return null;
  const key = String(row.eaId);
  const now = Date.now();
  const cached = futbinParseCardCache.get(key);
  if (cached && now - cached.savedAt < FUTBIN_PARSE_CARD_COOLDOWN_MS) return cached.value;

  const lastCheck = futbinParseCardLastCheck.get(key) || 0;
  if (now - lastCheck < FUTBIN_PARSE_CARD_COOLDOWN_MS) return null;
  const budget = refreshFutbinParseDailyBudget();
  if (budget.remaining <= 0) {
    latestFutbinParseStatus = {
      ...latestFutbinParseStatus,
      configured: true,
      usable: true,
      status: "DAILY_BUDGET_REACHED",
      reason: `Tagesbudget ${FUTBIN_PARSE_DAILY_BUDGET}/${FUTBIN_PARSE_DAILY_BUDGET} erreicht.`,
      callsToday: futbinParseCallsToday,
      updatedAt: new Date().toISOString()
    };
    return null;
  }
  if (now - futbinParseLastCallAt < FUTBIN_PARSE_MIN_INTERVAL_MS) return null;

  const endpoint = GAME_YEAR === "26" ? "search_players_fc26" : "search_players";
  const params = new URLSearchParams({ query: row.name });
  if (GAME_YEAR === "26" && endpoint === "search_players") params.set("fc26_only", "true");
  const url = `${FUTBIN_PARSE_BASE_URL}/${endpoint}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  futbinParseCardLastCheck.set(key, now);
  futbinParseLastCallAt = now;
  futbinParseCallsToday += 1;
  refreshFutbinParseDailyBudget();
  latestFutbinParseStatus = {
    ...latestFutbinParseStatus,
    configured: true,
    usable: true,
    status: "CHECKING",
    lastCallAt: new Date(now).toISOString(),
    lastPlayer: row.name,
    callsToday: futbinParseCallsToday,
    updatedAt: new Date().toISOString()
  };

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "X-API-Key": FUTBIN_PARSE_API_KEY,
        "user-agent": "FC-Trader-Brain/10.33"
      }
    });
    if (!response.ok) throw new Error(`Parse FUTBIN API -> HTTP ${response.status}`);
    const payload = await response.json();
    const match = futbinParseMatchForRow(row, futbinParseRows(payload));
    if (!match) throw new Error("Kein eindeutig passender FUTBIN-Kartentreffer gefunden");

    const value = {
      ...match,
      provider: "PARSE_PUBLIC_API",
      checkedAt: new Date().toISOString()
    };
    futbinParseCardCache.set(key, { savedAt: Date.now(), value });
    latestFutbinParseStatus = {
      ...latestFutbinParseStatus,
      configured: true,
      usable: true,
      status: "READY",
      reason: `FUTBIN-Cross-Check für ${row.name} erfolgreich.`,
      callsToday: futbinParseCallsToday,
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      updatedAt: new Date().toISOString()
    };
    return value;
  } catch (error) {
    latestFutbinParseStatus = {
      ...latestFutbinParseStatus,
      configured: true,
      usable: true,
      status: "ERROR",
      reason: "Öffentliche FUTBIN-API konnte den Kandidaten nicht sicher prüfen.",
      callsToday: futbinParseCallsToday,
      lastFailureAt: new Date().toISOString(),
      lastError: String(error?.message || error),
      updatedAt: new Date().toISOString()
    };
    console.warn("FUTBIN Parse API error:", error?.message || error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function applyFutbinParseCrossCheck(row, match, brainWork) {
  if (!row || !match || !Number.isFinite(match.price) || !Number.isFinite(row.price) || row.price <= 0) return false;
  const diffPct = Number((((match.price - row.price) / row.price) * 100).toFixed(2));
  const absDiff = Math.abs(diffPct);
  row.futbinPrice = match.price;
  row.futbinDiffPct = diffPct;
  row.futbinCrossCheck = absDiff >= FUTBIN_OUTLIER_DIFF_PCT
    ? "OUTLIER"
    : absDiff >= FUTBIN_MAX_DIFF_PCT
    ? "DIVERGENCE"
    : "MATCH";
  row.futbinProvider = match.provider;
  row.futbinMatchConfidence = match.matchConfidence;
  row.futbinUrl = match.futbinUrl;
  row.futbinVersion = match.version;
  row.futbinCheckedAt = match.checkedAt;

  const work = brainWork?.get?.(String(row.eaId));
  if (work?.input) {
    work.input.futbinCrossCheck = {
      provider: match.provider,
      price: match.price,
      diffPct,
      status: row.futbinCrossCheck,
      matchConfidence: match.matchConfidence,
      checkedAt: match.checkedAt
    };
  }
  return true;
}

async function enrichImportantRowsWithFutbinParse(rows, brainWork) {
  if (!FUTBIN_PARSE_API_KEY || !Array.isArray(rows) || !rows.length) return 0;
  refreshFutbinParseDailyBudget();
  const priority = { "JETZT VERKAUFEN": 110, "JETZT KAUFEN": 100, "VERKAUF PRÜFEN": 95, "NOCH WARTEN": 80, "NICHT KAUFEN": 50, "BEOBACHTEN": 20, "HALTEN": 10 };
  const candidates = rows
    .filter(futbinParseCandidate)
    .sort((a, b) => {
      if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
      const priorityFor = row =>
        row?.aiBuyGuard?.originalAction === "JETZT KAUFEN"
          ? Math.max(98, priority[row.aiAction] || 0)
          : (priority[row.aiAction] || 0);
      const actionDiff = priorityFor(b) - priorityFor(a);
      if (actionDiff) return actionDiff;
      const confidenceFor = row => Math.max(Number(row.aiConfidence || 0), Number(row?.aiBuyGuard?.originalConfidence || 0));
      return confidenceFor(b) - confidenceFor(a);
    });

  let applied = 0;
  const now = Date.now();
  const uncached = [];

  // Bereits geprüfte Karten sofort wieder anreichern, ohne neue API-Credits.
  for (const row of candidates) {
    const cached = futbinParseCardCache.get(String(row.eaId));
    if (cached && now - cached.savedAt < FUTBIN_PARSE_CARD_COOLDOWN_MS) {
      if (applyFutbinParseCrossCheck(row, cached.value, brainWork)) applied++;
    } else {
      uncached.push(row);
    }
  }

  // Pro Intervall höchstens einen neuen relevanten Kandidaten abfragen.
  for (const row of uncached) {
    const match = await fetchFutbinParseCrossCheck(row);
    if (!match) continue;
    if (applyFutbinParseCrossCheck(row, match, brainWork)) applied++;
    break;
  }

  return applied;
}

function futbinCrossCheckFields(eaId, futggPrice, feed) {
  const item = feed?.map?.get(Number(eaId));
  if (!item || !Number.isFinite(item.price) || !Number.isFinite(futggPrice) || futggPrice <= 0) {
    return {
      futbinPrice: null,
      futbinDiffPct: null,
      futbinCrossCheck: "NO_DATA"
    };
  }

  const diffPct = Number((((item.price - futggPrice) / futggPrice) * 100).toFixed(2));
  const absDiff = Math.abs(diffPct);
  const status = absDiff >= FUTBIN_OUTLIER_DIFF_PCT
    ? "OUTLIER"
    : absDiff >= FUTBIN_MAX_DIFF_PCT
    ? "DIVERGENCE"
    : "MATCH";

  return {
    futbinPrice: item.price,
    futbinDiffPct: diffPct,
    futbinCrossCheck: status,
    futbinProvider: "AUTHORIZED_JSON_FEED"
  };
}


function updateFutbinCrossCheckHealth(rows) {
  const previousLastHealthyAt = latestFutbinCrossCheckHealth?.lastHealthyAt || null;

  if (!FUTBIN_AUTHORIZED_FEED_URL) {
    latestFutbinCrossCheckHealth = {
      status: "NOT_CONFIGURED",
      trusted: false,
      fallbackEligible: false,
      comparedCards: 0,
      matchCards: 0,
      divergentCards: 0,
      outlierCards: 0,
      divergentShare: 0,
      outlierShare: 0,
      medianAbsDiffPct: null,
      reason: "Kein autorisierter FUTBIN-Feed konfiguriert.",
      lastHealthyAt: null,
      updatedAt: new Date().toISOString()
    };
    return latestFutbinCrossCheckHealth;
  }

  const compared = (Array.isArray(rows) ? rows : [])
    .filter(row => Number.isFinite(row?.futbinPrice) && Number.isFinite(row?.futbinDiffPct));
  const matchCards = compared.filter(row => row.futbinCrossCheck === "MATCH").length;
  const divergentOnly = compared.filter(row => row.futbinCrossCheck === "DIVERGENCE").length;
  const outlierCards = compared.filter(row => row.futbinCrossCheck === "OUTLIER").length;
  const divergentCards = divergentOnly + outlierCards;
  const comparedCards = compared.length;
  const divergentShare = comparedCards ? divergentCards / comparedCards : 0;
  const outlierShare = comparedCards ? outlierCards / comparedCards : 0;
  const medianAbsDiffPct = median(compared.map(row => Math.abs(Number(row.futbinDiffPct))));

  let status = "HEALTHY";
  let trusted = true;
  let fallbackEligible = true;
  let reason = `Cross-Check stabil: ${matchCards}/${comparedCards} Preise innerhalb der Toleranz.`;

  if (comparedCards < FUTBIN_TRUST_MIN_MATCHES) {
    status = "INSUFFICIENT_DATA";
    trusted = false;
    fallbackEligible = false;
    reason = `Zu wenig gemeinsame Preise für einen belastbaren Cross-Check: ${comparedCards}/${FUTBIN_TRUST_MIN_MATCHES}.`;
  } else if (
    divergentShare > FUTBIN_MAX_DIVERGENT_SHARE ||
    outlierShare > FUTBIN_MAX_OUTLIER_SHARE
  ) {
    status = "UNTRUSTED";
    trusted = false;
    fallbackEligible = false;
    reason = `FUTBIN-Cross-Check unplausibel: ${(divergentShare * 100).toFixed(1)}% abweichend, ${(outlierShare * 100).toFixed(1)}% Ausreißer.`;
  } else if (
    divergentShare > FUTBIN_MAX_DIVERGENT_SHARE * 0.5 ||
    outlierShare > FUTBIN_MAX_OUTLIER_SHARE * 0.5
  ) {
    status = "DEGRADED";
    trusted = true;
    fallbackEligible = false;
    reason = `FUTBIN-Cross-Check noch nutzbar, aber auffällig: ${(divergentShare * 100).toFixed(1)}% abweichend, ${(outlierShare * 100).toFixed(1)}% Ausreißer.`;
  }

  const nowIso = new Date().toISOString();
  latestFutbinCrossCheckHealth = {
    status,
    trusted,
    fallbackEligible,
    comparedCards,
    matchCards,
    divergentCards,
    outlierCards,
    divergentShare: Number((divergentShare * 100).toFixed(2)),
    outlierShare: Number((outlierShare * 100).toFixed(2)),
    medianAbsDiffPct: Number.isFinite(medianAbsDiffPct) ? Number(medianAbsDiffPct.toFixed(2)) : null,
    reason,
    lastHealthyAt: status === "HEALTHY" ? nowIso : previousLastHealthyAt,
    updatedAt: nowIso
  };

  return latestFutbinCrossCheckHealth;
}

function futbinCrossCheckCanInfluenceAlerts(row = null) {
  if (
    row?.futbinProvider === "PARSE_PUBLIC_API" &&
    Number(row?.futbinMatchConfidence || 0) >= 80 &&
    latestFutbinParseStatus?.usable === true
  ) {
    return true;
  }
  return latestFutbinCrossCheckHealth?.trusted === true &&
    ["HEALTHY", "DEGRADED"].includes(latestFutbinCrossCheckHealth?.status);
}

function futbinFallbackAllowed() {
  if (latestFutbinCrossCheckHealth?.fallbackEligible !== true) return false;
  const lastHealthyAt = latestFutbinCrossCheckHealth?.lastHealthyAt
    ? new Date(latestFutbinCrossCheckHealth.lastHealthyAt).getTime()
    : 0;
  return Boolean(lastHealthyAt) && Date.now() - lastHealthyAt <= FUTBIN_TRUST_TTL_MS;
}

function buildFutbinFallbackRows(safeRows, feed) {
  if (!Array.isArray(safeRows) || !safeRows.length || !feed?.map?.size) return [];

  let matches = 0;
  const rows = safeRows.map(row => {
    const item = feed.map.get(Number(row.eaId));
    if (!item || !Number.isFinite(item.price)) {
      return {
        ...row,
        dataSource: "FUT.GG_LAST_SAFE",
        fallbackDisplayOnly: true,
        futbinPrice: null,
        futbinCrossCheck: "NO_DATA"
      };
    }

    matches++;
    const previousSafePrice = row.price;
    const copy = {
      ...row,
      price: item.price,
      dataSource: "FUTBIN_AUTHORIZED_FALLBACK",
      fallbackDisplayOnly: true,
      futggLastSafePrice: previousSafePrice,
      futbinPrice: item.price,
      futbinDiffPct: Number((((item.price - previousSafePrice) / previousSafePrice) * 100).toFixed(2)),
      futbinCrossCheck: "FALLBACK",
      aiAction: "BEOBACHTEN",
      aiConfidence: 0,
      aiReason: "FUTBIN-Fallback zeigt nur den aktuellen autorisierten Ersatzpreis. Brain, Historie, Lernen und Trading-Alerts bleiben bis zur stabilen FUT.GG-Rückkehr blockiert.",
      aiModelUsed: "Fallback Display Only"
    };

    Object.assign(copy, profitInfo(item.price, row.buyPrice ? {
      buyPrice: row.buyPrice,
      quantity: row.quantity || 1
    } : null));

    return copy;
  });

  if (matches < FUTBIN_FALLBACK_MIN_MATCHES) return [];
  return rows;
}

function sourceHealthSnapshot() {
  const snapshot = { ...latestSourceHealth };
  const lastSuccessMs = snapshot.lastSuccessAt ? new Date(snapshot.lastSuccessAt).getTime() : 0;
  const staleForMs = lastSuccessMs ? Math.max(0, Date.now() - lastSuccessMs) : null;

  snapshot.staleForSeconds = staleForMs == null ? null : Math.round(staleForMs / 1000);
  snapshot.staleAfterSeconds = Math.round(SOURCE_HEALTH_STALE_MS / 1000);
  snapshot.baseStatus = snapshot.status;
  snapshot.recoveryPending = sourceRecoveryPending;
  snapshot.recoveryHealthyCycles = sourceRecoveryHealthyCycles;
  snapshot.recoveryRequiredCycles = SOURCE_RECOVERY_REQUIRED_CYCLES;

  if (lastSuccessMs && staleForMs > SOURCE_HEALTH_STALE_MS) {
    snapshot.status = "UNHEALTHY";
    snapshot.baseStatus = "UNHEALTHY";
    snapshot.healthy = false;
    snapshot.usable = false;
    snapshot.reason = `FUT.GG-Daten sind seit ${Math.round(staleForMs / 1000)} Sekunden nicht erfolgreich aktualisiert worden.`;
    sourceRecoveryPending = true;
    sourceRecoveryHealthyCycles = 0;
    snapshot.recoveryPending = true;
    snapshot.recoveryHealthyCycles = 0;
  } else if (sourceRecoveryPending && snapshot.status !== "UNHEALTHY") {
    snapshot.status = "RECOVERING";
    snapshot.healthy = false;
    snapshot.usable = false;
    snapshot.reason = `FUT.GG antwortet wieder. Sicherheits-Quarantäne: ${sourceRecoveryHealthyCycles}/${SOURCE_RECOVERY_REQUIRED_CYCLES} aufeinanderfolgende gesunde Marktchecks bestätigt.`;
  }

  snapshot.tradingAllowed = snapshot.usable === true && !sourceRecoveryPending;
  return snapshot;
}

function updateSourceHealthSuccess(cards, bulk, pricedRows) {
  const universeCards = Array.isArray(cards) ? cards.length : 0;
  const pricedCards = Array.isArray(pricedRows) ? pricedRows.length : 0;
  const coverage = universeCards > 0 ? pricedCards / universeCards : 0;
  const coveragePct = Number((coverage * 100).toFixed(2));
  const bulkValues = Number(bulk?.totalValues || bulk?.map?.size || 0);

  let status = "HEALTHY";
  let reason = `FUT.GG liefert ${pricedCards}/${universeCards} bepreiste Karten (${coveragePct}%).`;

  if (pricedCards < SOURCE_HEALTH_MIN_ROWS || coverage < SOURCE_HEALTH_MIN_COVERAGE) {
    status = "UNHEALTHY";
    reason = `Zu wenig verwertbare FUT.GG-Preisdaten: ${pricedCards}/${universeCards} Karten (${coveragePct}%).`;
  } else if (coverage < SOURCE_HEALTH_DEGRADED_COVERAGE) {
    status = "DEGRADED";
    reason = `FUT.GG-Abdeckung ist reduziert: ${pricedCards}/${universeCards} Karten (${coveragePct}%).`;
  }

  if (status === "UNHEALTHY") {
    sourceRecoveryPending = true;
    sourceRecoveryHealthyCycles = 0;
  } else if (sourceRecoveryPending) {
    if (status === "HEALTHY") {
      sourceRecoveryHealthyCycles += 1;
      if (sourceRecoveryHealthyCycles >= SOURCE_RECOVERY_REQUIRED_CYCLES) {
        sourceRecoveryPending = false;
        sourceRecoveryHealthyCycles = SOURCE_RECOVERY_REQUIRED_CYCLES;
      }
    } else {
      sourceRecoveryHealthyCycles = 0;
    }
  }

  latestSourceHealth = {
    status,
    healthy: status === "HEALTHY",
    usable: status !== "UNHEALTHY",
    reason,
    universeCards,
    pricedCards,
    coveragePct,
    bulkValues,
    sourceUrl: bulk?.sourceUrl || null,
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: latestSourceHealth.lastFailureAt || null,
    lastError: null,
    consecutiveFailures: 0,
    thresholds: {
      minRows: SOURCE_HEALTH_MIN_ROWS,
      minCoveragePct: Number((SOURCE_HEALTH_MIN_COVERAGE * 100).toFixed(2)),
      degradedCoveragePct: Number((SOURCE_HEALTH_DEGRADED_COVERAGE * 100).toFixed(2))
    },
    updatedAt: new Date().toISOString()
  };

  return sourceHealthSnapshot();
}

function updateSourceHealthFailure(error) {
  const failures = Number(latestSourceHealth.consecutiveFailures || 0) + 1;
  const previousSuccess = latestSourceHealth.lastSuccessAt || null;
  const status = failures >= 2 || !previousSuccess ? "UNHEALTHY" : "DEGRADED";

  if (status === "UNHEALTHY") {
    sourceRecoveryPending = true;
    sourceRecoveryHealthyCycles = 0;
  }

  latestSourceHealth = {
    ...latestSourceHealth,
    status,
    healthy: false,
    usable: status !== "UNHEALTHY",
    reason: `FUT.GG-Marktcheck fehlgeschlagen (${failures}x in Folge).`,
    lastFailureAt: new Date().toISOString(),
    lastError: String(error?.message || error),
    consecutiveFailures: failures,
    updatedAt: new Date().toISOString()
  };

  return sourceHealthSnapshot();
}

function sourceHealthAllowsTradingCycle() {
  return sourceHealthSnapshot().tradingAllowed === true;
}

function processingHealthSnapshot() {
  const snapshot = { ...latestProcessingHealth };
  const lastSuccessMs = snapshot.lastSuccessAt ? new Date(snapshot.lastSuccessAt).getTime() : 0;
  const staleAfterMs = Math.max(PRICE_REFRESH_MS * 5, 5 * 60_000);
  const staleForMs = lastSuccessMs ? Math.max(0, Date.now() - lastSuccessMs) : null;

  snapshot.staleForSeconds = staleForMs == null ? null : Math.round(staleForMs / 1000);
  snapshot.staleAfterSeconds = Math.round(staleAfterMs / 1000);

  if (lastSuccessMs && staleForMs > staleAfterMs) {
    snapshot.status = "UNHEALTHY";
    snapshot.healthy = false;
    snapshot.reason = `Verarbeitungspipeline seit ${Math.round(staleForMs / 1000)} Sekunden ohne erfolgreichen Abschluss.`;
  } else if (!lastSuccessMs) {
    snapshot.reason = "Noch kein erfolgreicher kompletter Verarbeitungszyklus.";
  } else if (snapshot.healthy) {
    snapshot.reason = "Marktdaten wurden erfolgreich verarbeitet, gespeichert und durch den Trader Brain geführt.";
  } else {
    snapshot.reason = `Verarbeitungspipeline meldet ${snapshot.consecutiveFailures || 0} Fehler in Folge.`;
  }

  return snapshot;
}

function updateProcessingHealthSuccess() {
  const now = new Date().toISOString();
  latestProcessingHealth = {
    status: "HEALTHY",
    healthy: true,
    lastSuccessAt: now,
    lastFailureAt: latestProcessingHealth.lastFailureAt || null,
    lastError: null,
    consecutiveFailures: 0,
    updatedAt: now
  };
  return processingHealthSnapshot();
}

function updateProcessingHealthFailure(error) {
  const failures = Number(latestProcessingHealth.consecutiveFailures || 0) + 1;
  const now = new Date().toISOString();
  latestProcessingHealth = {
    ...latestProcessingHealth,
    status: failures >= 2 ? "UNHEALTHY" : "DEGRADED",
    healthy: false,
    lastFailureAt: now,
    lastError: String(error?.message || error),
    consecutiveFailures: failures,
    updatedAt: now
  };
  return processingHealthSnapshot();
}

function createDiscordCycleBudget() {
  return {
    limit: DISCORD_MAX_ALERTS_PER_CYCLE,
    used: 0,
    blocked: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null
  };
}

function discordCycleHasRoom(budget) {
  return !budget || Number(budget.used || 0) < Number(budget.limit || DISCORD_MAX_ALERTS_PER_CYCLE);
}

function discordCycleHasRoomWithReserve(budget, reserveSlots = 0) {
  if (!budget) return true;

  const limit = Number(budget.limit || DISCORD_MAX_ALERTS_PER_CYCLE);
  const reserve = Math.max(0, Math.min(Math.max(0, limit - 1), Number(reserveSlots || 0)));
  return Number(budget.used || 0) < Math.max(1, limit - reserve);
}

function discordCycleConsume(budget) {
  if (!budget) return;
  budget.used = Number(budget.used || 0) + 1;
}

function discordCycleBlock(budget) {
  if (!budget) return;
  budget.blocked = Number(budget.blocked || 0) + 1;
}

async function notifySourceHealthTransition(snapshot, alertBudget = null) {
  const current = String(snapshot?.status || "UNKNOWN");
  const previous = previousSourceHealthStatus;
  previousSourceHealthStatus = current;

  if (!DISCORD_CONFIGURED || current === previous) return;

  const now = Date.now();
  const becameUnhealthy = current === "UNHEALTHY";
  const recovered = ["UNHEALTHY", "RECOVERING"].includes(previous) && current === "HEALTHY";

  if (!becameUnhealthy && !recovered) return false;
  if (becameUnhealthy && now - lastSourceHealthDiscordAlertAt < 30 * 60_000) return false;

  if (!discordCycleHasRoom(alertBudget)) {
    discordCycleBlock(alertBudget);
    return false;
  }

  try {
    await sendDiscordPayload({
      embeds: [{
        title: becameUnhealthy
          ? "⚠️ FUT.GG Datenquelle nicht sicher"
          : "✅ FUT.GG Datenquelle wieder stabil",
        description: String(snapshot.reason || "Source-Health-Status geändert."),
        fields: [
          { name: "Status", value: current, inline: true },
          { name: "Abdeckung", value: `${Number(snapshot.coveragePct || 0).toFixed(2)}%`, inline: true },
          { name: "Karten", value: `${snapshot.pricedCards || 0}/${snapshot.universeCards || 0}`, inline: true }
        ],
        footer: { text: "FC Trader Brain • Source Health Guard" },
        timestamp: new Date().toISOString()
      }]
    });
    discordCycleConsume(alertBudget);
    lastSourceHealthDiscordAlertAt = now;
    return true;
  } catch (error) {
    console.error("Source health Discord alert error:", error);
    return false;
  }
}

async function initDb() {
  if (!dbEnabled) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_price_history (
      ea_id BIGINT NOT NULL,
      price INTEGER NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_price_history_ea_time
    ON fc_price_history (ea_id, recorded_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_price_state (
      ea_id BIGINT PRIMARY KEY,
      price INTEGER NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_positions (
      ea_id BIGINT PRIMARY KEY,
      buy_price INTEGER NOT NULL CHECK (buy_price > 0),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_brain_decisions (
      id VARCHAR(120) PRIMARY KEY,
      ea_id BIGINT NOT NULL,
      player_name VARCHAR(180) NOT NULL,
      rating SMALLINT NOT NULL,
      card_type VARCHAR(100) NOT NULL,
      initial_price INTEGER NOT NULL,
      action VARCHAR(50) NOT NULL,
      confidence SMALLINT NOT NULL CHECK (confidence >= 0 AND confidence <= 95),
      reason TEXT NOT NULL,
      risk VARCHAR(30) NOT NULL,
      market_state VARCHAR(160) NOT NULL,
      ea_tax_break_even INTEGER,
      ai_model_used VARCHAR(120),
      input_snapshot JSONB NOT NULL,
      decision_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_brain_decisions_ea_time
    ON fc_trader_brain_decisions (ea_id, created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_brain_decisions_action_time
    ON fc_trader_brain_decisions (action, created_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_decision_evaluations (
      decision_id VARCHAR(120) PRIMARY KEY REFERENCES fc_trader_brain_decisions(id) ON DELETE CASCADE,
      price_after_5m INTEGER,
      price_after_15m INTEGER,
      price_after_1h INTEGER,
      price_after_6h INTEGER,
      price_after_24h INTEGER,
      roi_5m NUMERIC(8,2),
      roi_15m NUMERIC(8,2),
      roi_1h NUMERIC(8,2),
      roi_6h NUMERIC(8,2),
      roi_24h NUMERIC(8,2),
      max_roi NUMERIC(8,2),
      was_correct BOOLEAN,
      outcome_score SMALLINT,
      notes TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v10.47: zusaetzliche Horizonte + Performance-Metriken.
  // ALTER TABLE ist absichtlich idempotent, damit bestehende FC26-Daten erhalten bleiben.
  await pool.query(`
    ALTER TABLE fc_decision_evaluations
      ADD COLUMN IF NOT EXISTS price_after_30m INTEGER,
      ADD COLUMN IF NOT EXISTS price_after_3h INTEGER,
      ADD COLUMN IF NOT EXISTS roi_30m NUMERIC(8,2),
      ADD COLUMN IF NOT EXISTS roi_3h NUMERIC(8,2),
      ADD COLUMN IF NOT EXISTS net_roi_5m NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_15m NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_30m NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_1h NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_3h NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_6h NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS net_roi_24h NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS best_net_roi NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS worst_move_pct NUMERIC(9,3),
      ADD COLUMN IF NOT EXISTS missed_entry BOOLEAN,
      ADD COLUMN IF NOT EXISTS false_buy BOOLEAN,
      ADD COLUMN IF NOT EXISTS sell_timing_score SMALLINT,
      ADD COLUMN IF NOT EXISTS outcome_class VARCHAR(60),
      ADD COLUMN IF NOT EXISTS confidence_error NUMERIC(9,3)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_decision_evaluations_outcome
    ON fc_decision_evaluations (outcome_class, evaluated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_discord_signals (
      id VARCHAR(120) PRIMARY KEY,
      source VARCHAR(120) NOT NULL,
      message TEXT NOT NULL,
      player_or_rating VARCHAR(140) NOT NULL,
      call VARCHAR(20) NOT NULL,
      reason TEXT,
      expected_timeframe VARCHAR(120),
      source_reliability SMALLINT DEFAULT 50,
      category VARCHAR(50),
      market_confirmed BOOLEAN DEFAULT FALSE,
      confirmation_details TEXT,
      target_ea_id BIGINT,
      initial_reference_price INTEGER,
      initial_reference_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v10.6-v10.6.2: bestehende Datenbanken ohne Datenverlust erweitern.
  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS target_ea_id BIGINT
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS initial_reference_price INTEGER
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS initial_reference_at TIMESTAMPTZ
  `);

  // v10.28: echte Signalzeit und Empfangszeit getrennt speichern.
  // Das verhindert, dass verzögert weitergeleitete Trader-Calls so bewertet werden,
  // als wären sie erst beim HTTP-/Discord-Eingang entstanden.
  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS ingest_origin VARCHAR(30) DEFAULT 'legacy'
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS source_event_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS external_event_id VARCHAR(180)
  `);

  await pool.query(`
    UPDATE fc_discord_signals
    SET
      ingest_origin = COALESCE(NULLIF(ingest_origin, ''), 'legacy'),
      source_event_at = COALESCE(source_event_at, created_at),
      received_at = COALESCE(received_at, created_at)
    WHERE
      ingest_origin IS NULL OR ingest_origin = '' OR
      source_event_at IS NULL OR received_at IS NULL
  `);

  // v10.36: Quelle/Kanaltyp getrennt speichern.
  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS source_channel VARCHAR(120)
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS signal_kind VARCHAR(40) DEFAULT 'TRADER_CALL'
  `);

  await pool.query(`
    ALTER TABLE fc_discord_signals
      ADD COLUMN IF NOT EXISTS source_channel_weight NUMERIC(5,2) DEFAULT 1.00
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_discord_signals_source_event_time
    ON fc_discord_signals (source_event_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_market_impacts (
      signal_id VARCHAR(120) NOT NULL REFERENCES fc_discord_signals(id) ON DELETE CASCADE,
      horizon_minutes SMALLINT NOT NULL,
      market_median_change_pct NUMERIC(10,4),
      strongest_rating SMALLINT,
      strongest_rating_change_pct NUMERIC(10,4),
      affected_ratings JSONB,
      direction VARCHAR(20),
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (signal_id, horizon_minutes)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_trader_market_impacts_time
    ON fc_trader_market_impacts (evaluated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_market_knowledge_evaluations (
      signal_id VARCHAR(120) NOT NULL REFERENCES fc_discord_signals(id) ON DELETE CASCADE,
      rule_id VARCHAR(80) NOT NULL,
      horizon_minutes SMALLINT NOT NULL,
      target_scope VARCHAR(80),
      observed_change_pct NUMERIC(10,4),
      expected_mode VARCHAR(30) NOT NULL,
      support_score SMALLINT NOT NULL CHECK (support_score >= 0 AND support_score <= 100),
      was_supported BOOLEAN NOT NULL,
      details JSONB,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (signal_id, rule_id, horizon_minutes)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_market_knowledge_eval_rule_time
    ON fc_market_knowledge_evaluations (rule_id, evaluated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_signal_outcomes (
      signal_id VARCHAR(120) NOT NULL REFERENCES fc_discord_signals(id) ON DELETE CASCADE,
      horizon_minutes SMALLINT NOT NULL,
      initial_price INTEGER NOT NULL,
      observed_price INTEGER NOT NULL,
      gross_change_pct NUMERIC(10,4) NOT NULL,
      net_roi_after_tax_pct NUMERIC(10,4) NOT NULL,
      was_correct BOOLEAN NOT NULL,
      evaluation_reason TEXT,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (signal_id, horizon_minutes)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_fc_trader_signal_outcomes_time
    ON fc_trader_signal_outcomes (evaluated_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_trader_profiles (
      id VARCHAR(120) PRIMARY KEY,
      source VARCHAR(120) UNIQUE NOT NULL,
      display_name VARCHAR(180) NOT NULL,
      overall_accuracy NUMERIC(5,2) DEFAULT 50.00,
      total_signals INTEGER DEFAULT 0,
      accuracy_sbc_fodder NUMERIC(5,2) DEFAULT 50.00,
      accuracy_promo_cards NUMERIC(5,2) DEFAULT 50.00,
      accuracy_short_flips NUMERIC(5,2) DEFAULT 50.00,
      accuracy_leaks NUMERIC(5,2) DEFAULT 50.00,
      reputation_badge VARCHAR(50) DEFAULT 'Unbewiesen',
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_discord_alert_state (
      alert_key VARCHAR(180) PRIMARY KEY,
      alert_type VARCHAR(50) NOT NULL,
      last_action VARCHAR(100) NOT NULL,
      last_price INTEGER,
      last_confidence SMALLINT,
      last_fingerprint VARCHAR(250),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v10.9: letzter Brain-Zustand pro Karte für echte Signalwechsel-Alerts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_brain_state (
      ea_id BIGINT PRIMARY KEY,
      last_action VARCHAR(50) NOT NULL,
      last_price INTEGER,
      last_confidence SMALLINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // v10.34: Discord-Favorit / intensive Einzelkarten-Ueberwachung.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fc_intensive_watchlist (
      ea_id BIGINT PRIMARY KEY,
      player_name VARCHAR(180),
      start_price INTEGER NOT NULL CHECK (start_price > 0),
      requested_by VARCHAR(80),
      last_action VARCHAR(50),
      last_price INTEGER,
      last_confidence SMALLINT,
      last_alert_price INTEGER,
      last_alert_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function recordMemory(rows, at) {
  const cutoff = at - 31 * 24 * 60 * 60_000;

  for (const row of rows) {
    const oldPrice = lastMemoryPrice.get(row.eaId);

    if (oldPrice !== row.price) {
      const list = memoryHistory.get(row.eaId) || [];
      list.push({ t: at, price: row.price });

      while (list.length && list[0].t < cutoff) {
        list.shift();
      }

      memoryHistory.set(row.eaId, list);
      lastMemoryPrice.set(row.eaId, row.price);
    }
  }
}

async function recordDb(rows, at) {
  if (!dbEnabled || !rows.length) return;

  const ids = rows.map(row => String(row.eaId));
  const prices = rows.map(row => row.price);

  const previous = await pool.query(
    `
      SELECT ea_id::text AS ea_id, price
      FROM fc_price_state
      WHERE ea_id = ANY($1::bigint[])
    `,
    [ids]
  );

  const old = new Map(
    previous.rows.map(row => [
      row.ea_id,
      Number(row.price)
    ])
  );

  const changedIds = [];
  const changedPrices = [];

  for (let i = 0; i < ids.length; i++) {
    if (old.get(ids[i]) !== prices[i]) {
      changedIds.push(ids[i]);
      changedPrices.push(prices[i]);
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (changedIds.length) {
      await client.query(
        `
          INSERT INTO fc_price_history (ea_id, price, recorded_at)
          SELECT *
          FROM UNNEST(
            $1::bigint[],
            $2::int[],
            $3::timestamptz[]
          )
        `,
        [
          changedIds,
          changedPrices,
          changedIds.map(() => new Date(at).toISOString())
        ]
      );
    }

    await client.query(
      `
        INSERT INTO fc_price_state (ea_id, price, recorded_at)
        SELECT *
        FROM UNNEST(
          $1::bigint[],
          $2::int[],
          $3::timestamptz[]
        )
        ON CONFLICT (ea_id)
        DO UPDATE
        SET
          price = EXCLUDED.price,
          recorded_at = EXCLUDED.recorded_at
      `,
      [
        ids,
        prices,
        ids.map(() => new Date(at).toISOString())
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function discordNumber(value) {
  return Number.isFinite(value)
    ? Math.round(value).toLocaleString("de-DE")
    : "-";
}

function discordPct(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}%`;
}

function intensiveWatchAddComponents(row) {
  if (!row || !Number.isFinite(Number(row.eaId))) return [];
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 3,
      label: "⭐ Intensiv überwachen",
      custom_id: `watch:add:${row.eaId}`
    }]
  }];
}

function intensiveWatchStopComponents(row) {
  if (!row || !Number.isFinite(Number(row.eaId))) return [];
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 4,
      label: "🛑 Überwachung beenden",
      custom_id: `watch:remove:${row.eaId}`
    }]
  }];
}

const RATING_LIST_PAGE_SIZE = 20;

function ratingPlayerListOpenComponents(stat) {
  const rating = Number(stat?.rating);
  if (!Number.isFinite(rating)) return [];
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 2,
      label: "👥 Spieler anzeigen",
      custom_id: `rating:open:${rating}`
    }]
  }];
}

async function ratingPlayerListRows(rating) {
  const targetRating = Number(rating);

  // Die private Liste soll vollständiger sein als der öffentliche Alert-Snapshot.
  // Deshalb mehrere Quellen zusammenführen statt nur dann zu fallen backen, wenn
  // latestTradingRows komplett leer ist. Das behebt z.B. fehlende Liga-F-Karten.
  const merged = new Map();

  const addRows = rows => {
    for (const row of rows || []) {
      if (
        row?.cardType !== "Base Rare" ||
        Number(row.overall) !== targetRating ||
        !Number.isFinite(Number(row.price)) ||
        Number(row.price) <= 0
      ) {
        continue;
      }

      const itemId =
        (Number.isFinite(Number(row.itemId)) ? Number(row.itemId) : null) ??
        futggItemIdFromUrl(row.url) ??
        (Number.isFinite(Number(row.eaId)) ? Number(row.eaId) : null);

      if (!Number.isFinite(Number(itemId))) continue;

      merged.set(String(itemId), {
        ...row,
        eaId: Number(itemId),
        itemId: Number(itemId)
      });
    }
  };

  addRows(latestTradingRows || []);

  try {
    const [cards, supplements, bulk] = await Promise.all([
      ensureUniverse(false),
      collectRatingGenderSupplements(targetRating),
      loadBulkPs5Prices(false)
    ]);

    addRows(currentPricedCards(cards, bulk));
    addRows(currentPricedCards(supplements, bulk));
  } catch (error) {
    console.error("Rating player list merged fallback error:", error);
  }

  const intensiveWatches = await getIntensiveWatchlist().catch(() => new Map());

  return Array.from(merged.values())
    .map(row => ({
      ...row,
      intensiveWatch: intensiveWatches.has(String(row.eaId))
    }))
    .sort((a, b) =>
      Number(a.price) - Number(b.price) ||
      String(a.name || "").localeCompare(String(b.name || ""), "de")
    );
}

async function buildRatingPlayerListPayload(rating, page = 0) {
  const rows = await ratingPlayerListRows(rating);
  const totalPages = Math.max(1, Math.ceil(rows.length / RATING_LIST_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, Number(page) || 0));
  const start = safePage * RATING_LIST_PAGE_SIZE;
  const slice = rows.slice(start, start + RATING_LIST_PAGE_SIZE);
  const stat = latestRatingStats?.[rating] || latestRatingStats?.[String(rating)] || null;
  const referencePrice = Number(stat?.ratingReferencePrice ?? stat?.medianPrice);

  const description = slice.length
    ? slice.map((row, index) => {
        const baseName = String(row.name || `EA ${row.eaId}`);
        const duplicateName = rows.filter(item => String(item.name || "") === String(row.name || "")).length > 1;
        const name = duplicateName && row.club ? `${baseName} (${row.club})` : baseName;
        const label = row.url ? `[${name}](${row.url})` : name;
        const watch = row.intensiveWatch ? " ⭐ **INTENSIV**" : "";
        return `${start + index + 1}. ${label} • **${discordNumber(Number(row.price))} Coins**${watch}`;
      }).join("\n").slice(0, 3900)
    : "Aktuell sind keine Base-Rare-Spieler dieses Ratings mit gültigem FUT.GG-Preis verfügbar.";

  const components = [];

  // Discord String-Select: aus der Rating-Liste direkt einen konkreten Spieler
  // für die intensive Überwachung auswählen, ohne Einzelspieler-Spam im Feed.
  if (slice.length) {
    components.push({
      type: 1,
      components: [{
        type: 3,
        custom_id: `rating:watch:${rating}:${safePage}`,
        placeholder: "⭐ Spieler intensiv überwachen",
        min_values: 1,
        max_values: 1,
        options: [
          {
            label: `⭐ ALLE ${rating}er intensiv überwachen`.slice(0, 100),
            value: "__ALL__",
            description: `Alle ${rows.length} Spieler dieses Ratings überwachen`.slice(0, 100)
          },
          ...slice.slice(0, 24).map(row => {
            const baseName = String(row.name || `EA ${row.eaId}`);
            const duplicateName = rows.filter(item => String(item.name || "") === String(row.name || "")).length > 1;
            const label = duplicateName && row.club ? `${baseName} (${row.club})` : baseName;
            return {
              label: label.slice(0, 100),
              value: String(row.eaId),
              description: `${discordNumber(Number(row.price))} Coins${row.intensiveWatch ? " • bereits intensiv" : ""}`.slice(0, 100)
            };
          })
        ]
      }]
    });
  }

  const nav = [];
  if (safePage > 0) {
    nav.push({ type: 2, style: 2, label: "◀ Zurück", custom_id: `rating:page:${rating}:${safePage - 1}` });
  }
  if (safePage < totalPages - 1) {
    nav.push({ type: 2, style: 2, label: "Weiter ▶", custom_id: `rating:page:${rating}:${safePage + 1}` });
  }
  nav.push({ type: 2, style: 4, label: "✖ Schließen", custom_id: `rating:close:${rating}` });
  components.push({ type: 1, components: nav.slice(0, 5) });

  return {
    embeds: [{
      title: `👥 ${rating}ER Spieler-Liste`,
      description,
      fields: [
        { name: "Rating-Preis", value: Number.isFinite(referencePrice) ? `${discordNumber(referencePrice)} Coins` : "-", inline: true },
        { name: "Spieler", value: String(rows.length), inline: true },
        { name: "Seite", value: `${safePage + 1}/${totalPages}`, inline: true },
        { name: "Intensiv", value: "Einzelnen Spieler oder ⭐ ALLE auswählen. ⭐ markiert bereits überwachte Karten.", inline: false }
      ],
      footer: { text: `FC Trader Brain • nur für dich sichtbar • FC${GAME_YEAR}` },
      timestamp: new Date().toISOString()
    }],
    components
  };
}


function compactWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function secureTokenEquals(provided, expected) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function traderFeedTokenFromRequest(req) {
  const auth = String(req.get("authorization") || "").trim();
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return String(req.get("x-trader-feed-token") || "").trim();
}

function traderFeedSourceIdentityKey(value) {
  return compactWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 120);
}

function traderFeedAllowedSource(value) {
  const key = traderFeedSourceIdentityKey(value);
  if (!key) return null;
  return TRADER_FEED_ALLOWED_SOURCE_MAP.get(key) || null;
}

function traderFeedSafeKey(value, fallback = "event") {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 45);
  return clean || fallback;
}

function traderFeedRateLimitCheck() {
  const now = Date.now();
  if (now - traderFeedRateWindowStartedAt >= 60_000) {
    traderFeedRateWindowStartedAt = now;
    traderFeedRateWindowCount = 0;
  }
  traderFeedRateWindowCount++;
  return {
    allowed: traderFeedRateWindowCount <= TRADER_FEED_MAX_REQUESTS_PER_MIN,
    count: traderFeedRateWindowCount,
    limit: TRADER_FEED_MAX_REQUESTS_PER_MIN,
    resetAt: new Date(traderFeedRateWindowStartedAt + 60_000).toISOString()
  };
}

function parseTraderFeedEventTime(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function traderFeedFallbackEventKey(source, text, eventTime) {
  const timePart = eventTime ? String(eventTime.getTime()) : String(Math.floor(Date.now() / 300_000));
  return crypto
    .createHash("sha256")
    .update(`${source}\n${text}\n${timePart}`)
    .digest("hex")
    .slice(0, 32);
}

function discordSourceEventTimestamp(message) {
  let timestamp = Number(message?.createdTimestamp) || Date.now();
  try {
    const snapshots = message?.messageSnapshots;
    const values = snapshots?.values ? Array.from(snapshots.values()) : [];
    const candidates = values
      .map(snapshot => Number(snapshot?.createdTimestamp || snapshot?.createdAt?.getTime?.() || 0))
      .filter(value => Number.isFinite(value) && value > 0);
    if (candidates.length) timestamp = Math.min(...candidates);
  } catch {
    // Forward-Metadaten sind optional. Empfangszeit bleibt sicherer Fallback.
  }
  return timestamp;
}

function collectDiscordText(message) {
  const parts = [];

  if (message?.content) parts.push(message.content);

  for (const embed of message?.embeds || []) {
    if (embed?.title) parts.push(embed.title);
    if (embed?.description) parts.push(embed.description);
    for (const field of embed?.fields || []) {
      if (field?.name) parts.push(field.name);
      if (field?.value) parts.push(field.value);
    }
  }

  // Discord Forwarded Messages / Message Snapshots, wenn vom Client unterstützt.
  try {
    const snapshots = message?.messageSnapshots;
    const values = snapshots?.values ? Array.from(snapshots.values()) : [];
    for (const snapshot of values) {
      if (snapshot?.author?.username) parts.push(`ForwardedAuthor: ${snapshot.author.username}`);
      if (snapshot?.author?.globalName) parts.push(`ForwardedAuthorName: ${snapshot.author.globalName}`);
      if (snapshot?.guildName) parts.push(`ForwardedGuild: ${snapshot.guildName}`);
      if (snapshot?.channelName) parts.push(`ForwardedChannel: #${snapshot.channelName}`);
      if (snapshot?.content) parts.push(snapshot.content);
      for (const embed of snapshot?.embeds || []) {
        if (embed?.title) parts.push(embed.title);
        if (embed?.description) parts.push(embed.description);
        for (const field of embed?.fields || []) {
          if (field?.name) parts.push(field.name);
          if (field?.value) parts.push(field.value);
        }
      }
    }
  } catch {
    // Snapshot-Unterstützung ist optional. Normale Nachrichten funktionieren weiterhin.
  }

  return compactWhitespace(parts.join("\n"));
}

function detectTraderCall(text) {
  const lower = String(text || "").toLowerCase();

  const waitPatterns = [
    /\bwait\b/, /\bwarten\b/, /\bnoch warten\b/, /\bavoid\b/,
    /\bdon['’]?t buy\b/, /\bdo not buy\b/, /\bno buy\b/,
    /\bnicht kaufen\b/, /\bhold off\b/, /\bstand by\b/
  ];
  if (waitPatterns.some(pattern => pattern.test(lower))) return "WARTEN";

  const sellPatterns = [
    /\bsell\b/, /\bverkaufen\b/, /\bverkauf\b/, /\btake profit\b/,
    /\bprofit take\b/, /\bcash out\b/, /\bexit\b/, /\bdump\b/,
    /\bwill fall\b/, /\bgoing down\b/, /\bcrash incoming\b/
  ];
  if (sellPatterns.some(pattern => pattern.test(lower))) return "VERKAUFEN";

  const buyPatterns = [
    /\bbuy\b/, /\bkaufen\b/, /\binvest\b/, /\binvestment\b/,
    /\bsnipe\b/, /\baccumulate\b/, /\bstock up\b/, /\bload up\b/,
    /\bwill rise\b/, /\bgoing up\b/, /\bwill go up\b/, /\bsteigen\b/,
    /\brise soon\b/, /\bboom soon\b/
  ];
  if (buyPatterns.some(pattern => pattern.test(lower))) return "KAUFEN";

  return null;
}

function detectTraderCategory(text) {
  const lower = String(text || "").toLowerCase();
  if (/\bsbc\b|fodder|icon upgrade|upgrade sbc|potm|squad building/.test(lower)) return "SBC_FODDER";
  if (/leak|leaked|tomorrow content|content leak|evo leak|evolution leak/.test(lower)) return "LEAKS_CONTENT";
  if (/promo|toty|tots|futties|trailblazer|road to|rttf|future stars|team of the week|totw/.test(lower)) return "PROMO_CARDS";
  return "SHORT_TERM_FLIPS";
}

function detectExpectedTimeframe(text) {
  const raw = String(text || "");
  const patterns = [
    /\b(?:in\s+)?\d{1,2}\s*(?:min|mins|minute|minutes|m)\b/i,
    /\b(?:in\s+)?\d{1,2}\s*(?:h|hr|hrs|hour|hours|stunde|stunden)\b/i,
    /\b(?:today|heute|tonight|heute abend|tomorrow|morgen)\b/i,
    /\b(?:at\s*)?\d{1,2}(?::\d{2})?\s*(?:pm|am)?\b/i
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) return compactWhitespace(match[0]);
  }
  return "nicht angegeben";
}

function curatedTraderSourceFor(value) {
  const raw = compactWhitespace(value || "");
  if (!raw) return null;
  const direct = CURATED_TRADER_ALIAS_MAP.get(traderFeedSourceIdentityKey(raw));
  if (direct) return direct;
  const normalized = ` ${traderFeedSourceIdentityKey(raw).replace(/_/g, " ")} `;
  for (const source of CURATED_TRADER_SOURCES) {
    for (const alias of [source.displayName, source.id, ...(source.aliases || [])]) {
      const needle = traderFeedSourceIdentityKey(alias).replace(/_/g, " ");
      if (needle && normalized.includes(` ${needle} `)) return source;
    }
  }
  return null;
}

function canonicalTraderSourceName(value) {
  const source = curatedTraderSourceFor(value);
  return source?.displayName || compactWhitespace(value || "discord_signal") || "discord_signal";
}

function detectKnownTraderChannel(text, sourceName = null) {
  const raw = String(text || "").toLowerCase();
  const source = curatedTraderSourceFor(sourceName) || curatedTraderSourceFor(raw);
  if (!source) return null;
  for (const channel of source.channels || []) {
    const name = String(channel.name || "").toLowerCase();
    if (!name) continue;
    const markers = [
      `#${name}`,
      `kanal: ${name}`,
      `kanal: #${name}`,
      `channel: ${name}`,
      `channel: #${name}`,
      `forwardedchannel: #${name}`
    ];
    if (markers.some(value => raw.includes(value))) {
      return { sourceId: source.id, source: source.displayName, channel: channel.name, type: channel.type || "TRADER_CALL", category: channel.category || "SHORT_TERM_FLIPS", defaultCall: channel.defaultCall || null, weight: Number.isFinite(Number(channel.weight)) ? Number(channel.weight) : 1 };
    }
  }
  return { sourceId: source.id, source: source.displayName, channel: null, type: "UNKNOWN", category: null, defaultCall: null, weight: 1 };
}

function detectSignalSource(message, text) {
  const raw = String(text || "");
  const explicit = raw.match(/(?:source|quelle|trader)\s*[:\-]\s*@?([^\n|]{2,80})/i);
  if (explicit) return canonicalTraderSourceName(explicit[1]);
  const curatedFromText = curatedTraderSourceFor(raw);
  if (curatedFromText) return curatedFromText.displayName;
  const forwardedAuthor = raw.match(/ForwardedAuthor(?:Name)?\s*:\s*([^\n|]{2,80})/i);
  if (forwardedAuthor) return canonicalTraderSourceName(forwardedAuthor[1]);
  const atName = raw.match(/@([a-z0-9_.\-]{3,50})/i);
  if (atName) return canonicalTraderSourceName(atName[1]);
  return canonicalTraderSourceName(message?.author?.username || message?.author?.tag || "discord_signal");
}

function detectSignalTarget(text) {
  const raw = compactWhitespace(text);
  const lower = raw.toLowerCase();

  // Spieler aus unserer aktuell geladenen FUT.GG-Kartenliste erkennen.
  const candidates = latestTradingRows
    .filter(row => row?.name)
    .map(row => ({
      name: String(row.name),
      lower: String(row.name).toLowerCase(),
      eaId: String(row.eaId)
    }))
    .sort((a, b) => b.lower.length - a.lower.length);

  for (const card of candidates) {
    if (card.lower.length >= 4 && lower.includes(card.lower)) {
      return { target: card.name, eaId: card.eaId, kind: "player" };
    }
  }

  // Wenn nur der Nachname genannt wird, nur eindeutige Treffer akzeptieren.
  const surnameMatches = new Map();
  for (const card of candidates) {
    const tokens = card.lower.split(/[^a-zà-ÿ0-9]+/i).filter(Boolean);
    const surname = tokens.at(-1);
    if (!surname || surname.length < 4 || !lower.match(new RegExp(`\\b${surname.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i"))) continue;
    if (!surnameMatches.has(surname)) surnameMatches.set(surname, []);
    surnameMatches.get(surname).push(card);
  }
  for (const matches of surnameMatches.values()) {
    if (matches.length === 1) {
      return { target: matches[0].name, eaId: matches[0].eaId, kind: "player" };
    }
  }

  // Rating-Signale, z.B. "83er", "88s" oder "88 fodder".
  const ratingMatch = lower.match(/\b(7[5-9]|8\d|9\d)(?:er|s)?\b/);
  if (ratingMatch) {
    const rating = Number(ratingMatch[1]);
    if (rating >= 75 && rating <= 99) {
      return { target: String(rating), rating, kind: "rating" };
    }
  }

  return null;
}

function parseTraderSignalMessage(message) {
  const text = collectDiscordText(message);
  if (!text || text.length < 3) return { ok: false, reason: "Keine auswertbare Nachricht" };
  const source = detectSignalSource(message, text);
  const channelMeta = detectKnownTraderChannel(text, source);
  const category = channelMeta?.category || detectTraderCategory(text);
  const observationOnlyTypes = new Set(["LEAK", "NEWS_LEAK", "CONTENT", "SBC_CONTENT", "SUPPLY", "EVO_CONTENT", "EXPIRY"]);
  const call = observationOnlyTypes.has(channelMeta?.type)
    ? "BEOBACHTEN"
    : (detectTraderCall(text) || channelMeta?.defaultCall || (category === "LEAKS_CONTENT" ? "BEOBACHTEN" : null));
  if (!call) return { ok: false, reason: "Keine klare Aktion oder beobachtbares Leak/Content-Event erkannt" };
  let targetInfo = detectSignalTarget(text);
  if (!targetInfo && call === "BEOBACHTEN") targetInfo = { target: "MARKT", eaId: null, kind: "market" };
  if (!targetInfo) return { ok: false, reason: "Kein eindeutiger FUT.GG-Spieler oder Rating erkannt" };
  const expectedTimeframe = detectExpectedTimeframe(text);
  const signalKind = call === "BEOBACHTEN" ? "MARKET_EVENT" : "TRADER_CALL";
  return { ok: true, signal: {
    id: `discord_${message.id}`, source, sourceChannel: channelMeta?.channel || null, sourceChannelType: channelMeta?.type || null,
    sourceChannelWeight: Number(channelMeta?.weight || 1), signalKind, message: text.slice(0, 3000),
    playerOrRating: targetInfo.target, eaId: targetInfo.eaId || null, call, reason: text.slice(0, 1200), expectedTimeframe,
    sourceReliability: 50, category, timestamp: Date.now()
  }};
}

function currentReferenceForTraderSignal(signal) {
  const target = String(signal?.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;

  if (Number.isFinite(rating) && rating >= 75 && rating <= 99) {
    const prices = latestTradingRows
      .filter(row => row.overall === rating && row.cardType === "Base Rare" && Number.isFinite(row.price))
      .map(row => row.price);
    return median(prices);
  }

  if (signal?.eaId != null) {
    const row = latestTradingRows.find(item => String(item.eaId) === String(signal.eaId));
    if (Number.isFinite(row?.price)) return row.price;
  }

  const lower = target.toLowerCase();
  const exact = latestTradingRows.filter(row => String(row.name || "").toLowerCase() === lower && Number.isFinite(row.price));
  return exact.length ? median(exact.map(row => row.price)) : null;
}

async function saveIncomingTraderSignal(signal) {
  if (!signal) return false;

  const sourceEventAtMs =
    Number.isFinite(Number(signal.sourceEventAt)) && Number(signal.sourceEventAt) > 0
      ? Number(signal.sourceEventAt)
      : Number.isFinite(Number(signal.timestamp)) && Number(signal.timestamp) > 0
        ? Number(signal.timestamp)
        : Date.now();

  const sourceEventAtIso = new Date(sourceEventAtMs).toISOString();
  const ingestOrigin = compactWhitespace(signal.ingestOrigin || "discord_channel").slice(0, 30) || "discord_channel";
  const externalEventId = compactWhitespace(signal.externalEventId || "").slice(0, 180) || null;

  signal.sourceEventAt = sourceEventAtMs;
  signal.timestamp = sourceEventAtMs;
  signal.ingestOrigin = ingestOrigin;
  signal.externalEventId = externalEventId;

  if (!dbEnabled) {
    if (memoryTraderSignals.some(item => String(item?.id) === String(signal.id))) {
      return false;
    }
    memoryTraderSignals.unshift(signal);
    if (memoryTraderSignals.length > 500) memoryTraderSignals.length = 500;
    return true;
  }

  // Referenzpreis zur echten Signalzeit rekonstruieren. Für ganz neue Signale darf
  // traderSignalReferencePriceAt() auf den aktuellen Marktpreis zurückfallen.
  const initialReferencePrice = await traderSignalReferencePriceAt(
    signal,
    latestTradingRows,
    sourceEventAtMs
  );

  const inserted = await pool.query(
    `
      INSERT INTO fc_discord_signals (
        id,
        source,
        message,
        player_or_rating,
        call,
        reason,
        expected_timeframe,
        source_reliability,
        category,
        target_ea_id,
        initial_reference_price,
        initial_reference_at,
        ingest_origin,
        source_event_at,
        received_at,
        external_event_id,
        source_channel,
        signal_kind,
        source_channel_weight,
        created_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        CASE WHEN $11::integer IS NULL THEN NULL ELSE $12::timestamptz END,
        $13,$12::timestamptz,NOW(),$14,$15,$16,$17,$12::timestamptz
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `,
    [
      signal.id,
      signal.source,
      signal.message,
      signal.playerOrRating,
      signal.call,
      signal.reason,
      signal.expectedTimeframe,
      signal.sourceReliability,
      signal.category,
      signal.eaId ? String(signal.eaId) : null,
      Number.isFinite(initialReferencePrice) ? Math.round(initialReferencePrice) : null,
      sourceEventAtIso,
      ingestOrigin,
      externalEventId,
      compactWhitespace(signal.sourceChannel || "").slice(0, 120) || null,
      compactWhitespace(signal.signalKind || (signal.call === "BEOBACHTEN" ? "MARKET_EVENT" : "TRADER_CALL")).slice(0, 40),
      Number.isFinite(Number(signal.sourceChannelWeight)) ? Number(signal.sourceChannelWeight) : 1
    ]
  );

  // Forwarder duerfen bei Netzwerk-Retries dasselbe Event erneut schicken.
  // Ein bereits gespeichertes Event zaehlt nicht ein zweites Mal zur Trader-Historie.
  if (!inserted.rowCount) return false;

  const profileId = `trader_${String(signal.source).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 80)}`;
  await pool.query(
    `
      INSERT INTO fc_trader_profiles (
        id, source, display_name, overall_accuracy, total_signals,
        reputation_badge, notes, updated_at
      )
      VALUES ($1,$2,$3,50,1,'Unbewiesen','Automatisch aus Trader-Signal-Ingest angelegt',NOW())
      ON CONFLICT (source)
      DO UPDATE SET
        total_signals = fc_trader_profiles.total_signals + 1,
        updated_at = NOW()
    `,
    [profileId, signal.source, signal.source]
  );

  return true;
}

async function resolveTraderSignalChannel() {
  if (!discordClientReady || !discordClient?.isReady()) return null;

  if (TRADER_SIGNAL_CHANNEL_ID) {
    try {
      const configured = await discordClient.channels.fetch(TRADER_SIGNAL_CHANNEL_ID);
      if (configured?.isTextBased?.()) {
        traderSignalResolvedChannelId = configured.id;
        traderSignalResolvedChannelName = configured.name || "trader-signals";
        return configured;
      }
    } catch (error) {
      console.warn(
        `Trader-Signal Channel-ID ${TRADER_SIGNAL_CHANNEL_ID} nicht direkt erreichbar. Suche automatisch nach #trader-signals...`,
        error?.message || error
      );
    }
  }

  for (const guild of discordClient.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      const found = channels.find(channel =>
        channel && channel.name === "trader-signals" && channel.isTextBased?.()
      );
      if (found) {
        traderSignalResolvedChannelId = found.id;
        traderSignalResolvedChannelName = found.name;
        console.log(
          `Trader-Signal-Kanal automatisch gefunden: Guild "${guild.name}", #${found.name}, ID ${found.id}`
        );
        return found;
      }
    } catch (error) {
      console.warn(`Trader-Signal-Kanalsuche in "${guild.name}" fehlgeschlagen:`, error?.message || error);
    }
  }

  lastTraderSignalError = "#trader-signals wurde nicht gefunden oder ist für den Bot nicht sichtbar.";
  return null;
}

async function handleTraderSignalMessage(message) {
  try {
    if (!message || message.author?.bot) return;

    const channelId = String(message.channelId || "");
    const targetChannel = traderSignalResolvedChannelId || TRADER_SIGNAL_CHANNEL_ID;
    if (!targetChannel || channelId !== String(targetChannel)) return;

    traderSignalsReceived++;
    lastTraderSignalAt = new Date().toISOString();

    const parsed = parseTraderSignalMessage(message);
    if (!parsed.ok) {
      traderSignalsIgnored++;
      lastTraderSignalError = parsed.reason;
      await message.reply({
        content: `⚪ Signal nicht übernommen: ${parsed.reason}. Schreibe z. B. **"BUY Harry Kane, 89er Fodder steigt wegen SBC morgen"**.`,
        allowedMentions: { repliedUser: false, parse: [] }
      }).catch(() => {});
      return;
    }

    parsed.signal.sourceEventAt = discordSourceEventTimestamp(message);
    parsed.signal.timestamp = parsed.signal.sourceEventAt;
    parsed.signal.ingestOrigin = "discord_channel";
    parsed.signal.externalEventId = compactWhitespace(message.id || "").slice(0, 180) || null;

    const inserted = await saveIncomingTraderSignal(parsed.signal);
    if (!inserted) {
      traderSignalsIgnored++;
      lastTraderSignalError = "Doppeltes Signal-Event wurde ignoriert.";
      return;
    }

    traderSignalsAccepted++;
    lastTraderSignalError = null;

    await message.reply({
      content:
        `📥 **${parsed.signal.signalKind === "MARKET_EVENT" ? "Markt-Event" : "Trader-Signal"} gespeichert** | ${parsed.signal.call} | ` +
        `**${parsed.signal.playerOrRating}** | Quelle: **${parsed.signal.source}**` +
        `${parsed.signal.sourceChannel ? ` • #${parsed.signal.sourceChannel}` : ""} | ` +
        `Kategorie: ${parsed.signal.category}. Wird ab dem nächsten 60-Sekunden-Marktcheck gegen FUT.GG geprüft.`,
      allowedMentions: { repliedUser: false, parse: [] }
    }).catch(() => {});
  } catch (error) {
    traderSignalsIgnored++;
    lastTraderSignalError = String(error);
    console.error("Trader signal ingest error:", error);
  }
}

async function resolveIntensiveWatchRow(eaId) {
  const key = String(eaId || "");
  if (!/^\d+$/.test(key)) return null;

  const liveRow = latestTradingRows.find(item => String(item.eaId) === key);
  if (liveRow) return { row: liveRow, source: "live" };

  if (dbEnabled) {
    try {
      const result = await pool.query(`
        SELECT
          COALESCE(ps.price, d.initial_price)::int AS price,
          d.player_name,
          d.rating,
          d.card_type,
          d.action,
          d.confidence,
          ps.recorded_at AS price_recorded_at,
          d.created_at AS decision_created_at
        FROM (SELECT $1::bigint AS ea_id) x
        LEFT JOIN fc_price_state ps ON ps.ea_id = x.ea_id
        LEFT JOIN LATERAL (
          SELECT player_name, rating, card_type, initial_price, action, confidence, created_at
          FROM fc_trader_brain_decisions
          WHERE ea_id = x.ea_id
          ORDER BY created_at DESC
          LIMIT 1
        ) d ON TRUE
        WHERE ps.price IS NOT NULL OR d.initial_price IS NOT NULL
        LIMIT 1
      `, [key]);

      const saved = result.rows[0];
      const price = Number(saved?.price);
      if (saved && Number.isFinite(price) && price > 0) {
        return {
          source: "stored",
          row: {
            eaId: Number(key),
            name: saved.player_name || `EA ${key}`,
            overall: saved.rating == null ? null : Number(saved.rating),
            cardType: saved.card_type || null,
            type: saved.card_type || null,
            price,
            aiAction: saved.action || "BEOBACHTEN",
            aiConfidence: saved.confidence == null ? null : Number(saved.confidence),
            watchFallback: true,
            watchPriceRecordedAt: saved.price_recorded_at || saved.decision_created_at || null
          }
        };
      }
    } catch (error) {
      console.error("Intensive watch fallback lookup error:", error);
    }
  }

  const previous = memoryBrainState.get(key);
  const memoryPrice = Number(previous?.lastPrice);
  if (previous && Number.isFinite(memoryPrice) && memoryPrice > 0) {
    return {
      source: "memory",
      row: {
        eaId: Number(key),
        name: `EA ${key}`,
        price: memoryPrice,
        aiAction: previous.lastAction || "BEOBACHTEN",
        aiConfidence: Number.isFinite(Number(previous.lastConfidence)) ? Number(previous.lastConfidence) : null,
        watchFallback: true
      }
    };
  }

  return null;
}

async function handleDiscordButtonInteraction(interaction) {
  const isButton = interaction?.isButton?.() === true;
  const isStringSelect = interaction?.isStringSelectMenu?.() === true;
  if (!isButton && !isStringSelect) return;

  const customId = String(interaction.customId || "");

  const ratingOpen = customId.match(/^rating:open:(\d{2})$/);
  if (ratingOpen) {
    try {
      await interaction.deferReply({ flags: 64 });
      await interaction.editReply(await buildRatingPlayerListPayload(Number(ratingOpen[1]), 0));
    } catch (error) {
      console.error("Discord rating list open error:", error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `⚠️ Spieler-Liste konnte nicht geöffnet werden: ${String(error?.message || error).slice(0, 250)}`, embeds: [], components: [] }).catch(() => {});
      }
    }
    return;
  }

  const ratingPage = customId.match(/^rating:page:(\d{2}):(\d+)$/);
  if (ratingPage) {
    try {
      await interaction.deferUpdate();
      await interaction.editReply(await buildRatingPlayerListPayload(Number(ratingPage[1]), Number(ratingPage[2])));
    } catch (error) {
      console.error("Discord rating list page error:", error);
    }
    return;
  }

  const ratingWatch = customId.match(/^rating:watch:(\d{2}):(\d+)$/);
  if (ratingWatch && isStringSelect) {
    const rating = Number(ratingWatch[1]);
    const page = Number(ratingWatch[2]);
    const eaId = String(interaction.values?.[0] || "");

    try {
      // Sofort bestaetigen, dann DB/Watch speichern.
      await interaction.deferUpdate();

      if (eaId === "__ALL__") {
        const allRows = await ratingPlayerListRows(rating);
        if (!allRows.length) {
          await interaction.followUp({
            content: `⚠️ Für ${rating}er sind gerade keine gültigen Marktpreise verfügbar.`,
            flags: 64
          }).catch(() => {});
          return;
        }

        const before = await getIntensiveWatchlist();
        let added = 0;
        let already = 0;
        let failed = 0;

        await mapLimit(allRows, 4, async row => {
          try {
            const key = String(row.eaId);
            if (before.has(key)) {
              already += 1;
              return;
            }
            await saveIntensiveWatch(row, interaction.user?.id || null);
            added += 1;
          } catch (error) {
            failed += 1;
          }
        });

        await interaction.editReply(
          await buildRatingPlayerListPayload(rating, page)
        ).catch(() => {});

        await interaction.followUp({
          content:
            `⭐ **${rating}ER KOMPLETT INTENSIV** • ${added} neu aktiviert` +
            `${already ? ` • ${already} bereits aktiv` : ""}` +
            `${failed ? ` • ${failed} konnten nicht aktiviert werden` : ""}.`,
          flags: 64
        }).catch(() => {});
        return;
      }

      if (!/^\d+$/.test(eaId)) {
        await interaction.followUp({
          content: "⚠️ Dieser Spieler konnte nicht eindeutig erkannt werden.",
          flags: 64
        }).catch(() => {});
        return;
      }

      const resolved = await resolveIntensiveWatchRow(eaId);
      if (!resolved?.row) {
        await interaction.followUp({
          content: "⚠️ Für diesen Spieler ist gerade kein gültiger Marktpreis verfügbar.",
          flags: 64
        }).catch(() => {});
        return;
      }

      const before = await getIntensiveWatchlist();
      const already = before.has(eaId);
      const watch = await saveIntensiveWatch(
        resolved.row,
        interaction.user?.id || null
      );

      // Die private Rating-Liste direkt aktualisieren, damit ⭐ sofort sichtbar ist.
      await interaction.editReply(
        await buildRatingPlayerListPayload(rating, page)
      ).catch(() => {});

      await interaction.followUp({
        content: already
          ? `⭐ **${resolved.row.name}** wird bereits intensiv überwacht.`
          : `⭐ **${resolved.row.name}** wird jetzt intensiv überwacht. Referenzpreis: **${discordNumber(watch?.startPrice || resolved.row.price)} Coins**.`,
        flags: 64
      }).catch(() => {});
    } catch (error) {
      lastIntensiveWatchError = String(error);
      console.error("Discord rating-list intensive watch error:", error);
      await interaction.followUp({
        content: `⚠️ Intensive Überwachung konnte nicht aktiviert werden: ${String(error?.message || error).slice(0, 250)}`,
        flags: 64
      }).catch(() => {});
    }
    return;
  }

  const ratingClose = customId.match(/^rating:close:(\d{2})$/);
  if (ratingClose) {
    try {
      await interaction.deferUpdate();
      await interaction.deleteReply();
    } catch (error) {
      await interaction.editReply({ content: "Spieler-Liste geschlossen.", embeds: [], components: [] }).catch(() => {});
    }
    return;
  }

  const match = customId.match(/^watch:(add|remove):(\d+)$/);
  if (!match) return;

  const mode = match[1];
  const eaId = match[2];

  try {
    // Discord interactions must be acknowledged within roughly 3 seconds.
    // A database or Render cold/slow path must therefore never happen before
    // the acknowledgement. The real result is written with editReply below.
    await interaction.deferReply({ flags: 64 });

    if (mode === "remove") {
      await deleteIntensiveWatch(eaId);

      if (interaction.message) {
        const title = String(interaction.message.embeds?.[0]?.title || "");
        const isPersonalWatchUpdate = title.includes("INTENSIV:");
        if (isPersonalWatchUpdate) {
          const deleted = await interaction.message.delete().then(() => true).catch(() => false);
          if (!deleted) await interaction.message.edit({ components: [] }).catch(() => {});
        } else {
          // Auf dem ursprünglichen Markt-Alert den roten Stop-Button wieder in
          // den grünen Start-Button zurücksetzen, statt den ganzen Alert zu löschen.
          await interaction.message.edit({ components: intensiveWatchAddComponents({ eaId: Number(eaId) }) }).catch(() => {});
        }
      }

      await interaction.editReply({
        content: `🛑 Intensive Überwachung für **EA ${eaId}** beendet.`
      });
      return;
    }

    const resolved = await resolveIntensiveWatchRow(eaId);
    if (!resolved?.row) {
      await interaction.editReply({
        content: "⚠️ Zu dieser Karte ist weder ein aktueller noch ein gespeicherter Marktpreis vorhanden. Beim nächsten Alert erneut versuchen."
      });
      return;
    }

    const row = resolved.row;
    const before = await getIntensiveWatchlist();
    const already = before.has(String(eaId));
    const watch = await saveIntensiveWatch(row, interaction.user?.id || null);

    // Der gedrückte grüne Button muss sofort sichtbar in STOP wechseln.
    if (interaction.message) {
      await interaction.message.edit({ components: intensiveWatchStopComponents(row) }).catch(() => {});
    }

    const fallbackNote = resolved.source === "live"
      ? ""
      : " Die Karte ist gerade nicht im aktuellen sicheren Snapshot; die Überwachung ist trotzdem vorgemerkt und greift automatisch wieder, sobald sie im Markt-Snapshot auftaucht.";

    await interaction.editReply({
      content: already
        ? `⭐ **${row.name}** wird bereits intensiv überwacht.${fallbackNote}`
        : `⭐ **${row.name}** wird jetzt intensiv überwacht. Referenzpreis: **${discordNumber(watch?.startPrice || row.price)} Coins**.${fallbackNote} Ab jetzt bekommst du engere Folge-Updates nur für diese aktivierte Karte.`
    });
  } catch (error) {
    lastIntensiveWatchError = String(error);
    console.error("Discord intensive watch interaction error:", error);

    const errorText = `⚠️ Überwachung konnte nicht geändert werden: ${String(error?.message || error).slice(0, 300)}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorText }).catch(() => {});
    } else {
      await interaction.reply({ content: errorText, flags: 64 }).catch(() => {});
    }
  }
}

async function initDiscordBot() {
  if (!DISCORD_CONFIGURED) {
    lastDiscordError = "DISCORD_BOT_TOKEN fehlt";
    return false;
  }

  if (discordClientReady && discordClient?.isReady()) {
    return true;
  }

  if (discordLoginPromise) {
    return discordLoginPromise;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  discordClient.on("error", error => {
    lastDiscordError = `Discord Client: ${String(error)}`;
    console.error("Discord client error:", error);
  });

  discordClient.on("warn", warning => {
    console.warn("Discord client warning:", warning);
  });

  discordClient.on(Events.MessageCreate, message => {
    handleTraderSignalMessage(message).catch(error => {
      lastTraderSignalError = String(error);
      console.error("Trader signal message handler error:", error);
    });
  });

  discordClient.on(Events.InteractionCreate, interaction => {
    handleDiscordButtonInteraction(interaction).catch(error => {
      lastIntensiveWatchError = String(error);
      console.error("Discord button interaction handler error:", error);
    });
  });

  discordLoginPromise = new Promise(async resolve => {
    const timeout = setTimeout(() => {
      lastDiscordError = "Discord Gateway Login Timeout";
      console.error("Discord Gateway Login Timeout");
      resolve(false);
    }, 25_000);

    discordClient.once(Events.ClientReady, async () => {
      clearTimeout(timeout);
      discordClientReady = true;
      discordBotTag = discordClient.user?.tag || discordClient.user?.username || "Bot";
      discordGuildCount = discordClient.guilds.cache.size;
      lastDiscordError = null;

      console.log(
        `Discord Gateway verbunden als ${discordBotTag} • Guilds: ${discordGuildCount}`
      );

      const channel = await resolveDiscordAlertChannel();
      if (channel) {
        console.log(
          `Discord Alert-Kanal gefunden: #${discordResolvedChannelName} (${discordResolvedChannelId})`
        );
      }

      const traderChannel = await resolveTraderSignalChannel();
      if (traderChannel) {
        console.log(
          `Discord Trader-Signal-Kanal gefunden: #${traderSignalResolvedChannelName} (${traderSignalResolvedChannelId})`
        );
      }

      resolve(true);
    });

    try {
      await discordClient.login(DISCORD_BOT_TOKEN);
    } catch (error) {
      clearTimeout(timeout);
      discordClientReady = false;
      lastDiscordError = `Discord Login fehlgeschlagen: ${String(error)}`;
      console.error("Discord login error:", error);
      resolve(false);
    }
  });

  return discordLoginPromise;
}

async function resolveDiscordAlertChannel() {
  if (!discordClientReady || !discordClient?.isReady()) return null;

  // 1) Bevorzugt die in Render konfigurierte Channel-ID.
  if (DISCORD_ALERT_CHANNEL_ID) {
    try {
      const configured = await discordClient.channels.fetch(DISCORD_ALERT_CHANNEL_ID);
      if (configured?.isTextBased?.() && typeof configured.send === "function") {
        discordResolvedChannelId = configured.id;
        discordResolvedChannelName = configured.name || "trading-alerts";
        return configured;
      }
    } catch (error) {
      console.warn(
        `Discord Channel-ID ${DISCORD_ALERT_CHANNEL_ID} nicht direkt erreichbar. Suche automatisch nach #trading-alerts...`,
        error?.message || error
      );
    }
  }

  // 2) Fallback: im/den Server(n), in denen der Bot Mitglied ist, nach #trading-alerts suchen.
  for (const guild of discordClient.guilds.cache.values()) {
    try {
      const channels = await guild.channels.fetch();
      const found = channels.find(channel =>
        channel &&
        channel.name === "trading-alerts" &&
        channel.isTextBased?.() &&
        typeof channel.send === "function"
      );

      if (found) {
        discordResolvedChannelId = found.id;
        discordResolvedChannelName = found.name;
        console.warn(
          `Discord Alert-Kanal automatisch gefunden: Guild "${guild.name}", #${found.name}, ID ${found.id}`
        );
        return found;
      }
    } catch (error) {
      console.warn(
        `Discord Kanäle von Guild "${guild.name}" konnten nicht gelesen werden:`,
        error?.message || error
      );
    }
  }

  lastDiscordError =
    "Discord Bot ist verbunden, aber #trading-alerts wurde nicht gefunden oder ist für den Bot nicht sichtbar.";
  return null;
}

async function sendDiscordPayload(payload) {
  if (!DISCORD_CONFIGURED) return { ok: false, skipped: "not_configured" };

  const ready = await initDiscordBot();
  if (!ready) {
    throw new Error(lastDiscordError || "Discord Bot konnte nicht verbunden werden");
  }

  const channel = await resolveDiscordAlertChannel();
  if (!channel) {
    throw new Error(lastDiscordError || "Discord Alert-Kanal nicht gefunden");
  }

  try {
    await channel.send({
      ...payload,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    lastDiscordError = `Discord send failed: ${String(error)}`;
    throw error;
  }

  lastDiscordSendAt = new Date().toISOString();
  lastDiscordError = null;
  discordAlertsSent++;
  return { ok: true };
}

async function getDiscordAlertState(alertKey) {
  if (dbEnabled) {
    const result = await pool.query(`
      SELECT alert_key, alert_type, last_action, last_price, last_confidence,
             last_fingerprint, last_sent_at
      FROM fc_discord_alert_state
      WHERE alert_key = $1
      LIMIT 1
    `, [alertKey]);

    if (!result.rowCount) return null;
    const row = result.rows[0];
    return {
      alertKey: row.alert_key,
      alertType: row.alert_type,
      lastAction: row.last_action,
      lastPrice: row.last_price == null ? null : Number(row.last_price),
      lastConfidence: row.last_confidence == null ? null : Number(row.last_confidence),
      lastFingerprint: row.last_fingerprint,
      lastSentAt: new Date(row.last_sent_at).getTime()
    };
  }

  return memoryDiscordAlertState.get(alertKey) || null;
}

async function saveDiscordAlertState({ alertKey, alertType, action, price = null, confidence = null, fingerprint = "" }) {
  const state = {
    alertKey,
    alertType,
    lastAction: action,
    lastPrice: Number.isFinite(price) ? Math.round(price) : null,
    lastConfidence: Number.isFinite(confidence) ? Math.round(confidence) : null,
    lastFingerprint: fingerprint,
    lastSentAt: Date.now()
  };

  if (dbEnabled) {
    await pool.query(`
      INSERT INTO fc_discord_alert_state (
        alert_key, alert_type, last_action, last_price,
        last_confidence, last_fingerprint, last_sent_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (alert_key)
      DO UPDATE SET
        alert_type = EXCLUDED.alert_type,
        last_action = EXCLUDED.last_action,
        last_price = EXCLUDED.last_price,
        last_confidence = EXCLUDED.last_confidence,
        last_fingerprint = EXCLUDED.last_fingerprint,
        last_sent_at = NOW()
    `, [
      state.alertKey,
      state.alertType,
      state.lastAction,
      state.lastPrice,
      state.lastConfidence,
      state.lastFingerprint
    ]);
  } else {
    memoryDiscordAlertState.set(alertKey, state);
  }

  return state;
}

function discordAlertShouldSend(state, action, price, confidence, fingerprint) {
  if (!state) return true;
  if (state.lastAction !== action) return true;

  const age = Date.now() - state.lastSentAt;
  if (state.lastFingerprint !== fingerprint && age >= 5 * 60_000) return true;
  if (age < DISCORD_ALERT_COOLDOWN_MS) return false;

  const priceMove =
    Number.isFinite(price) && Number.isFinite(state.lastPrice) && state.lastPrice > 0
      ? Math.abs((price - state.lastPrice) / state.lastPrice) * 100
      : 0;

  const confidenceMove =
    Number.isFinite(confidence) && Number.isFinite(state.lastConfidence)
      ? Math.abs(confidence - state.lastConfidence)
      : 0;

  if (priceMove >= 3 || confidenceMove >= 5) return true;
  return age >= 2 * 60 * 60_000;
}

function alertSanityNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function alertSanitySnapshot(row) {
  const c1 = alertSanityNumber(row?.change1m);
  const c5 = alertSanityNumber(row?.change5m);
  const c15 = alertSanityNumber(row?.change15m);
  const c1h = alertSanityNumber(row?.change1h);
  const c24 = alertSanityNumber(row?.change24h);
  const opposite = ALERT_SANITY_OPPOSING_MOVE_PCT;
  const values = [c1, c5, c15];
  const hasPositive = values.some(value => value >= opposite);
  const hasNegative = values.some(value => value <= -opposite);
  const spread = Math.max(...values) - Math.min(...values);
  const mixedDirection = hasPositive && hasNegative;
  const opposingHorizons = Boolean(
    (c1 <= -7 && c5 >= opposite) ||
    (c1 >= opposite && c5 <= -10) ||
    (c5 <= -10 && c15 >= opposite) ||
    (c5 >= 10 && c15 <= -opposite) ||
    (mixedDirection && spread >= 35)
  );

  const derivedRegime = brainLearningMarketRegime({
    change5m: c5,
    change15m: c15,
    change1h: c1h,
    change24h: c24,
    distanceTo24hLow: row?.distanceFrom24hLow,
    ratingMarketRisingPct: row?.ratingMarketRisingPct,
    ratingMarketFallingPct: row?.ratingMarketFallingPct
  });

  const reasonText = String(row?.aiReason || '').toLowerCase();
  const saysSelloff = /abverkauf|abwärtsdruck|crash|falling knife/.test(reasonText);
  const saysPump = /pump|fomo|stark steig/.test(reasonText);
  const pumpVsCrash = Boolean(
    (derivedRegime === 'PUMP' && (row?.aiAction === 'NOCH WARTEN' || saysSelloff)) ||
    (derivedRegime === 'CRASH' && ['JETZT KAUFEN', 'JETZT VERKAUFEN'].includes(String(row?.aiAction || '')) && saysPump)
  );

  const median = Number(row?.ratingMarketMedianPrice);
  const price = Number(row?.price);
  const ratingRatio = Number.isFinite(median) && median > 0 && Number.isFinite(price) && price > 0
    ? price / median
    : null;
  const ratingSpikeSuspect = Boolean(
    String(row?.cardType || '') === 'Base Rare' &&
    Number.isFinite(ratingRatio) &&
    ratingRatio >= 2.5 &&
    (Math.abs(c1) >= 8 || Math.abs(c5) >= 20) &&
    mixedDirection
  );

  const reasons = [];
  if (opposingHorizons) reasons.push(`Kurzfristige Horizonte widersprechen sich (${c1.toFixed(2)}% / ${c5.toFixed(2)}% / ${c15.toFixed(2)}%).`);
  if (pumpVsCrash) reasons.push(`Marktregime ${derivedRegime} widerspricht der aktuellen Richtungsbegründung.`);
  if (ratingSpikeSuspect) reasons.push(`Preis liegt auffällig weit vom ${row?.overall}er-Ratingmedian entfernt und die kurzen Horizonte sind instabil.`);

  return {
    blocked: reasons.length > 0,
    reasons,
    opposingHorizons,
    pumpVsCrash,
    ratingSpikeSuspect,
    derivedRegime,
    mixedDirection,
    spread: Number(spread.toFixed(2)),
    checkedAt: new Date().toISOString()
  };
}

function applyAlertSanityGuard(row) {
  if (!row) return row;
  const sanity = alertSanitySnapshot(row);
  const old = row.aiAlertSanity || {};
  row.aiAlertSanity = { ...old, ...sanity, version: '10.42' };

  if (!sanity.blocked) return row;

  // Directional high-confidence states are unsafe while the horizons disagree.
  if (['JETZT KAUFEN', 'NOCH WARTEN', 'VERKAUF PRÜFEN', 'JETZT VERKAUFEN'].includes(String(row.aiAction || ''))) {
    row.aiAlertSanity.originalAction = row.aiAction;
    row.aiAlertSanity.originalConfidence = row.aiConfidence;
    row.aiAction = 'BEOBACHTEN';
    row.aiConfidence = Math.min(Number(row.aiConfidence || 60), 60);
    row.aiRisk = 'mittel';
    row.aiMarketState = 'DATEN PRÜFEN';
    row.aiRecommendedHorizon = 'Nächsten sauberen 60-Sekunden-Zyklus abwarten';
    row.aiReason = `v10.42 Alert-Sanity: ${sanity.reasons.join(' ')} Kein Richtungs-Call, bis die Daten wieder konsistent sind.`.slice(0, 1800);
  }

  return row;
}

function discordAlertPrice(row) {
  const rechecked = Number(row?.aiAlertSanity?.recheckPrice);
  if (Number.isFinite(rechecked) && rechecked > 0) return rechecked;
  return Number(row?.price);
}

function discordAlertNeedsLiveRecheck(row, type) {
  if (!row) return false;
  if (type === 'data') return true;
  if (['buy', 'sell', 'crash'].includes(type)) {
    const movement = Math.max(
      Math.abs(alertSanityNumber(row.change1m)),
      Math.abs(alertSanityNumber(row.change5m)),
      Math.abs(alertSanityNumber(row.change15m))
    );
    return movement >= ALERT_SANITY_RECHECK_MIN_MOVE_PCT;
  }
  return false;
}

function markDiscordLivePriceRecheck(row, freshPrice) {
  const analyzedPrice = Number(row?.price);
  const latestPrice = Number(freshPrice);
  if (!Number.isFinite(analyzedPrice) || analyzedPrice <= 0 || !Number.isFinite(latestPrice) || latestPrice <= 0) return false;
  const diffPct = Number((((latestPrice - analyzedPrice) / analyzedPrice) * 100).toFixed(2));
  row.aiAlertSanity = {
    ...(row.aiAlertSanity || {}),
    version: '10.42',
    recheckPrice: latestPrice,
    recheckDiffPct: diffPct,
    recheckedAt: new Date().toISOString()
  };

  if (Math.abs(diffPct) < ALERT_SANITY_RECHECK_DIFF_PCT) return false;

  const extra = `Live-FUT.GG-Recheck: Analysepreis ${discordNumber(analyzedPrice)} → aktuell ${discordNumber(latestPrice)} Coins (${discordPct(diffPct)}).`;
  row.aiAlertSanity.blocked = true;
  row.aiAlertSanity.livePriceChanged = true;
  row.aiAlertSanity.reasons = [...(row.aiAlertSanity.reasons || []), extra];
  row.aiAlertSanity.originalAction = row.aiAlertSanity.originalAction || row.aiAction;
  row.aiAlertSanity.originalConfidence = row.aiAlertSanity.originalConfidence ?? row.aiConfidence;
  row.aiAction = 'BEOBACHTEN';
  row.aiConfidence = Math.min(Number(row.aiConfidence || 60), 60);
  row.aiRisk = 'mittel';
  row.aiMarketState = 'DATEN PRÜFEN';
  row.aiRecommendedHorizon = 'Preis im nächsten Marktzyklus erneut bestätigen';
  row.aiReason = `v10.42 Alert-Sanity: ${extra} Richtungsalarm unterdrückt, weil der Preis sich seit der Analyse materiell geändert hat.`.slice(0, 1800);
  return true;
}

function cardDiscordAlertCandidate(row) {
  if (row?.aiAlertSanity?.blocked) {
    const magnitude = Math.max(Math.abs(alertSanityNumber(row.change1m)), Math.abs(alertSanityNumber(row.change5m)), Math.abs(alertSanityNumber(row.change15m)));
    if (magnitude >= ALERT_SANITY_RECHECK_MIN_MOVE_PCT || row?.aiAlertSanity?.livePriceChanged) {
      return { type: "data", priority: 115 + Math.min(30, magnitude) };
    }
    return null;
  }

  // Nur ein als belastbar eingestufter FUTBIN-Cross-Check darf Kaufalarme blockieren.
  // Bei marktweit unplausiblen Zweitquellen-Daten ignorieren wir den Einzel-Ausreißer.
  if (
    row?.aiAction === "JETZT KAUFEN" &&
    row?.futbinCrossCheck === "OUTLIER" &&
    futbinCrossCheckCanInfluenceAlerts(row)
  ) {
    return null;
  }

  // FC27 Low-Watch: 75-81 werden weiter analysiert, erzeugen aber nur bei
  // ungewöhnlich starken Bewegungen überhaupt individuelle Alerts.
  if (isLowWatchRating(row?.overall) && !lowRatingCardUnusualMove(row)) {
    return null;
  }

  if (row.aiAction === "JETZT KAUFEN" && row.aiConfidence >= DISCORD_MIN_BUY_CONFIDENCE) {
    return { type: "buy", priority: 100 + row.aiConfidence };
  }

  if (row.aiAction === "JETZT VERKAUFEN" && row.aiConfidence >= DISCORD_MIN_SELL_CONFIDENCE) {
    return { type: "sell", priority: 130 + row.aiConfidence };
  }

  if (row.aiAction === "VERKAUF PRÜFEN" && row.aiConfidence >= DISCORD_MIN_SELL_CONFIDENCE) {
    return { type: "sell", priority: 110 + row.aiConfidence };
  }

  const crash =
    row.aiAction === "NOCH WARTEN" &&
    row.aiConfidence >= 90 &&
    !row?.aiAlertSanity?.blocked &&
    (
      (Number.isFinite(row.change1m) && row.change1m <= -7 && Number.isFinite(row.change5m) && row.change5m <= -5) ||
      (Number.isFinite(row.change5m) && row.change5m <= -10 && Number.isFinite(row.change15m) && row.change15m <= -2)
    );

  if (crash) return { type: "crash", priority: 90 + row.aiConfidence };
  return null;
}

function buildCardDiscordPayload(row, type) {
  const emoji = type === "buy" ? "🟢" : type === "sell" ? "💰" : type === "data" ? "⚠️" : "🚨";
  const titleAction = type === "crash" ? "NOCH WARTEN" : type === "data" ? "DATEN PRÜFEN" : row.aiAction;
  const title = `${emoji} ${titleAction}: ${row.name || `EA ${row.eaId}`} (${row.overall})`;

  const fields = [
    { name: "Preis", value: `${discordNumber(discordAlertPrice(row))} Coins`, inline: true },
    { name: "KI-Sicherheit", value: `${row.aiConfidence}%`, inline: true },
    { name: "Kartentyp", value: String(row.cardType || "-"), inline: true },
    { name: "1m / 5m / 15m", value: `${discordPct(row.change1m)} / ${discordPct(row.change5m)} / ${discordPct(row.change15m)}`, inline: false },
    { name: "24h Tief / Hoch", value: `${discordNumber(row.low24h)} / ${discordNumber(row.high24h)}`, inline: true },
    { name: "Rating-Markt", value: `${row.overall}er: ${String(row.ratingMarketTrend || "neutral").replaceAll("_", " ")}`, inline: true },
    { name: "Gesamtmarkt", value: `${String(row.globalMarketMood || "neutral").replaceAll("_", " ")} • ${row.packSupplyActive ? "Angebotsdruck erkannt" : "kein Angebotsdruck"}`, inline: false }
  ];

  if (type === "sell" && row.tracked) {
    fields.push({
      name: "Deine Position",
      value:
        `Kauf ${discordNumber(row.buyPrice)} × ${discordNumber(row.quantity || 1)} | ` +
        `Netto ${discordNumber(row.netProfitTotal)} Coins | ${discordPct(row.profitPercent)}`,
      inline: false
    });
  }

  if (Number.isFinite(row.futbinPrice)) {
    fields.push({
      name: "FUTBIN Cross-Check",
      value: `${discordNumber(row.futbinPrice)} Coins • ${row.futbinCrossCheck} • ${discordPct(row.futbinDiffPct)}${row.futbinProvider ? ` • ${row.futbinProvider}` : ""}`,
      inline: false
    });
  }

  fields.push({
    name: "KI-Grund",
    value: String(row.aiReason || "Keine Begründung verfügbar.").slice(0, 1000),
    inline: false
  });

  return {
    embeds: [{
      title,
      url: row.url || undefined,
      description:
        type === "buy"
          ? "Trader Brain sieht eine bestätigte Kauf-Trendwende."
          : type === "sell"
          ? "Eigener Bestand erreicht eine relevante Gewinn-/Ausstiegszone."
          : type === "data"
          ? "Kurzfristige Marktdaten oder der Live-Preis widersprechen sich. Kein Richtungs-Call, bis der nächste saubere Marktcheck bestätigt."
          : "Starker Abverkauf erkannt. Nicht blind in den Fall kaufen.",
      fields,
      footer: { text: "FC Trader Brain • automatische 60-Sekunden-Analyse" },
      timestamp: new Date().toISOString()
    }],
    components: intensiveWatchAddComponents(row)
  };
}

function ratingPriceBucket(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return null;
  const step = price < 1_000 ? 50 : price < 10_000 ? 100 : price < 50_000 ? 500 : price < 250_000 ? 1_000 : 5_000;
  return Math.max(step, Math.round(price / step) * step);
}

function ratingPriceProfile(cards) {
  const valid = (cards || []).filter(card => Number.isFinite(Number(card?.price)) && Number(card.price) > 0);
  if (!valid.length) {
    return {
      referencePrice: null,
      dominantPrice: null,
      dominantSharePct: 0,
      exceptionCount: 0,
      namedExceptions: []
    };
  }

  const counts = new Map();
  for (const card of valid) {
    const bucket = ratingPriceBucket(card.price);
    if (!Number.isFinite(bucket)) continue;
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }

  let dominantPrice = null;
  let dominantCount = -1;
  for (const [bucket, count] of counts.entries()) {
    if (count > dominantCount || (count === dominantCount && (dominantPrice == null || bucket < dominantPrice))) {
      dominantPrice = bucket;
      dominantCount = count;
    }
  }

  const med = median(valid.map(card => Number(card.price)));
  const medianBucket = ratingPriceBucket(med);
  const dominantSharePct = valid.length && dominantCount > 0 ? Number(((dominantCount / valid.length) * 100).toFixed(1)) : 0;

  // Wenn es einen klaren Fodder-Preiscluster gibt, ist dieser die Referenz.
  // Bei verstreuten Preisen ist der gerundete Median robuster.
  const referencePrice = dominantSharePct >= 35 && Number.isFinite(dominantPrice)
    ? dominantPrice
    : medianBucket;

  const minimumGap = Number.isFinite(referencePrice)
    ? Math.max(referencePrice < 2_000 ? 150 : referencePrice < 10_000 ? 250 : 500, referencePrice * (RATING_PRICE_EXCEPTION_PCT / 100))
    : Infinity;
  const threshold = Number.isFinite(referencePrice) ? referencePrice + minimumGap : Infinity;

  const expensive = valid
    .filter(card => Number(card.price) >= threshold)
    .sort((a, b) => Number(b.price) - Number(a.price));

  const namedExceptions = expensive.length >= 1 && expensive.length <= RATING_PRICE_EXCEPTION_MAX_NAMES
    ? expensive.map(card => ({
        eaId: Number(card.eaId),
        name: String(card.name || `EA ${card.eaId}`),
        price: Number(card.price),
        url: card.url || null
      }))
    : [];

  return {
    referencePrice,
    dominantPrice,
    dominantSharePct,
    exceptionCount: expensive.length,
    namedExceptions
  };
}

function isBaseRatingCard(row) {
  const type = String(row?.cardType || row?.type || "");
  return type === "Base Rare" || type === "Base Common";
}

function suppressNormalPlayerDiscord(row) {
  if (!DISCORD_RATING_FIRST_BASE_ALERTS) return false;
  // v10.46: Der normale öffentliche Feed ist strikt Rating-first.
  // Das gilt jetzt für ALLE Kartentypen, nicht nur Base Rare/Common.
  // Namentliche Einzelkarten sind nur persönliche Ausnahmen:
  // eigene gespeicherte Käufe oder bewusst per Button intensiv überwachte Karten.
  return !row?.tracked && !row?.intensiveWatch;
}

function ratingUnusualMoveValue(stat) {
  if (!stat) return 0;
  const values = [stat.change5m, stat.change15m, stat.change1h]
    .map(value => Number(value))
    .filter(Number.isFinite);
  if (!values.length) return 0;
  return values.reduce((strongest, value) =>
    Math.abs(value) > Math.abs(strongest) ? value : strongest
  , values[0]);
}

function ratingUnusualMoveMagnitude(stat) {
  return Math.abs(ratingUnusualMoveValue(stat));
}

function lowRatingUnusualMove(stat) {
  return Boolean(
    stat &&
    isLowWatchRating(stat.rating) &&
    ratingUnusualMoveMagnitude(stat) >= LOW_RATING_ALERT_MOVE_PCT
  );
}

function lowRatingCardUnusualMove(row) {
  if (!row || !isLowWatchRating(row.overall)) return false;
  const magnitude = Math.max(
    Math.abs(Number(row.change5m || 0)),
    Math.abs(Number(row.change15m || 0)),
    Math.abs(Number(row.change1h || 0))
  );
  return magnitude >= LOW_RATING_ALERT_MOVE_PCT;
}

function ratingDiscordAlertCandidate(stat) {
  if (!stat) return false;

  // FC27: 75-81 bleiben im Monitoring, aber normale Rating-Alarme werden unterdrückt.
  // Nur wirklich ungewöhnliche Bewegungen dürfen als Low-Watch-Alarm aufs Handy.
  if (isLowWatchRating(stat.rating)) {
    return lowRatingUnusualMove(stat) && Number(stat.measuredCards || 0) >= 5;
  }

  if (stat.confidence < DISCORD_MIN_RATING_CONFIDENCE) return false;
  return ["KAUFZONE", "VERKAUFSZONE", "STARK STEIGEND", "STARK FALLEND"].includes(stat.marketSignal);
}

function buildRatingDiscordPayload(stat) {
  const lowWatch = isLowWatchRating(stat.rating);
  const unusualMove = ratingUnusualMoveValue(stat);
  const advice = String(stat.marketAdvice || "BEOBACHTEN");

  let emoji = "📊";
  if (lowWatch) emoji = "⚡";
  else if (advice === "JETZT KAUFEN") emoji = "🟢";
  else if (advice === "JETZT VERKAUFEN") emoji = "💰";
  else if (advice.includes("WARTEN")) emoji = "⏳";
  else if (advice.includes("NICHT")) emoji = "🚫";
  else if (stat.marketSignal === "STARK STEIGEND") emoji = "🚀";
  else if (stat.marketSignal === "STARK FALLEND") emoji = "🔻";

  const ratingPrice = Number(stat.ratingReferencePrice ?? stat.medianPrice);
  const priceText = Number.isFinite(ratingPrice) ? `${discordNumber(ratingPrice)} Coins` : "-";
  const actionTitle = lowWatch
    ? `${emoji} ${stat.rating}ER • ${priceText} • ${discordPct(unusualMove)}`
    : `${emoji} ${stat.rating}ER • ${priceText} • ${advice}`;

  return {
    embeds: [{
      title: actionTitle,
      description: lowWatch
        ? `FC${GAME_YEAR} Low-Rating-Watch: ungewöhnlich starke Bewegung erkannt. Normale Bewegungen unter ${MAIN_RATING_MIN} werden nicht alarmiert.`
        : String(stat.reason || "Rating-Markt-Signal erkannt."),
      fields: [
        { name: "Klare Aktion", value: advice, inline: true },
        { name: "Marktsignal", value: String(stat.marketSignal || "NEUTRAL"), inline: true },
        { name: "Sicherheit", value: `${stat.confidence}%`, inline: true },
        { name: "Rating-Preis", value: `${discordNumber(ratingPrice)} Coins`, inline: true },
        { name: "Spieler im Rating", value: `${Number(stat.cardCount || 0)} • Namen nur auf Wunsch`, inline: true },
        { name: "1m / 5m / 15m / 1h", value: `${discordPct(stat.change1m)} / ${discordPct(stat.change5m)} / ${discordPct(stat.change15m)} / ${discordPct(stat.change1h)}`, inline: false },
        { name: "Steigen / Fallen (5m)", value: `${Number(stat.risingPct5m || 0).toFixed(1)}% / ${Number(stat.fallingPct5m || 0).toFixed(1)}%`, inline: true },
        { name: "Nahe 24h-Tief / Hoch", value: `${Number(stat.near24hLowPct || 0).toFixed(1)}% / ${Number(stat.near24hHighPct || 0).toFixed(1)}%`, inline: true },
        ...(lowWatch
          ? [{
              name: "FC27 Low-Watch-Regel",
              value: `Alarm erst ab ${LOW_RATING_ALERT_MOVE_PCT}% Bewegung • Hauptmarkt ab ${MAIN_RATING_MIN}`,
              inline: false
            }]
          : [])
      ],
      footer: { text: `FC Trader Brain • Rating Buy/Sell Intelligence • FC${GAME_YEAR}` },
      timestamp: new Date().toISOString()
    }],
    components: ratingPlayerListOpenComponents(stat)
  };
}


function traderSignalRating(signal) {
  const target = String(signal?.playerOrRating || "").trim();
  if (!/^\d{2}$/.test(target)) return null;
  const rating = Number(target);
  return rating >= RATING_MIN && rating <= RATING_MAX ? rating : null;
}

function traderSignalMatchingRows(signal, rows) {
  if (!signal || !Array.isArray(rows)) return [];
  return rows.filter(row => matchingSignalsForRow(row, [signal]).length > 0);
}

function traderConfluenceReliabilityGate(signal, profile) {
  const overall = Math.max(0, Math.min(100, Number(
    profile?.overallAccuracy ?? signal?.sourceReliability ?? 50
  )));

  const category = String(signal?.category || "SHORT_TERM_FLIPS");
  const categoryAccuracy = Number(profile?.specializationAccuracy?.[category]);
  const totalSignals = Math.max(0, Number(profile?.totalSignals || 0));

  // Bei ganz neuen Quellen bleibt der geglättete Overall-Wert maßgeblich.
  // Sobald etwas Historie vorhanden ist, zählt die passende Kategorie stärker.
  const effectiveReliability = Number((
    totalSignals >= 3 && Number.isFinite(categoryAccuracy)
      ? overall * 0.4 + categoryAccuracy * 0.6
      : overall
  ).toFixed(2));

  let confidenceAdjustment = 0;
  if (effectiveReliability >= 75) confidenceAdjustment = -4;
  else if (effectiveReliability >= 65) confidenceAdjustment = -2;
  else if (effectiveReliability >= 50) confidenceAdjustment = 0;
  else if (effectiveReliability >= 40) confidenceAdjustment = 3;
  else confidenceAdjustment = 6;

  const requiredCardConfidence = Math.max(
    70,
    Math.min(95, DISCORD_TRADER_CONFLUENCE_MIN_CONFIDENCE + confidenceAdjustment)
  );

  const requiredRatingConfidence = Math.max(
    60,
    Math.min(95, DISCORD_TRADER_CONFLUENCE_MIN_RATING_CONFIDENCE + confidenceAdjustment)
  );

  return {
    allowed: effectiveReliability >= DISCORD_TRADER_CONFLUENCE_MIN_RELIABILITY,
    overallReliability: Number(overall.toFixed(2)),
    categoryReliability: Number.isFinite(categoryAccuracy)
      ? Number(categoryAccuracy.toFixed(2))
      : null,
    effectiveReliability,
    totalSignals,
    confidenceAdjustment,
    requiredCardConfidence,
    requiredRatingConfidence,
    category
  };
}

function traderSignalBrainAgreement(signal, rows, ratingStats, brainWork, gate = null) {
  const call = String(signal?.call || "").toUpperCase();
  const rating = traderSignalRating(signal);
  const requiredCardConfidence = gate?.requiredCardConfidence ?? DISCORD_TRADER_CONFLUENCE_MIN_CONFIDENCE;
  const requiredRatingConfidence = gate?.requiredRatingConfidence ?? DISCORD_TRADER_CONFLUENCE_MIN_RATING_CONFIDENCE;

  if (rating != null) {
    const stat = ratingStats?.[rating] || null;
    if (!stat || !Number.isFinite(stat.confidence)) return null;

    // FC27 Low-Watch-Ratings dürfen auch bei einem Trader-Call nicht durch
    // normale Bewegung zur mobilen Konfluenz werden. Erst der ungewöhnliche
    // Move schaltet diese Ratings für einen Alarm frei.
    if (isLowWatchRating(rating) && !lowRatingUnusualMove(stat)) return null;

    let agrees = false;
    if (call === "KAUFEN") {
      agrees = stat.marketSignal === "KAUFZONE" && stat.confidence >= requiredRatingConfidence;
    } else if (call === "VERKAUFEN") {
      agrees = ["STARK FALLEND", "FÄLLT"].includes(stat.marketSignal) && stat.confidence >= requiredRatingConfidence;
    } else if (call === "WARTEN") {
      agrees = ["STARK FALLEND", "FÄLLT"].includes(stat.marketSignal) && stat.confidence >= requiredRatingConfidence;
    }

    if (!agrees) return null;

    return {
      kind: "rating",
      rating,
      stat,
      confidence: stat.confidence,
      requiredConfidence: requiredRatingConfidence,
      summary: `${rating}er Markt: ${stat.marketSignal} • ${stat.marketAdvice}`,
      reason: stat.reason || "Rating-Markt bestätigt den Trader-Call."
    };
  }

  const candidates = traderSignalMatchingRows(signal, rows)
    .filter(row => Number.isFinite(row.aiConfidence))
    // v10.46 strict feed: Trader-Konfluenz darf keine normalen Einzelspieler-
    // Alerts mehr in #trading-alerts einschleusen. Öffentlicher Weg bleibt
    // Rating-Alert -> "Spieler anzeigen".
    .filter(row => !suppressNormalPlayerDiscord(row))
    .filter(row => {
      const quantAction = brainWork?.get(String(row.eaId))?.quant?.suggestedAction;

      // Wichtig: Der externe Trader darf den eigenen Brain nicht zirkulär "bestätigen".
      // Deshalb muss zusätzlich der unabhängige Quantitative Core dieselbe Richtung sehen.
      if (call === "KAUFEN") {
        return row.aiAction === "JETZT KAUFEN" && quantAction === "JETZT KAUFEN";
      }
      if (call === "VERKAUFEN") {
        return ["VERKAUF PRÜFEN", "JETZT VERKAUFEN"].includes(row.aiAction) && quantAction === "VERKAUF PRÜFEN";
      }
      if (call === "WARTEN") {
        return ["NOCH WARTEN", "NICHT KAUFEN"].includes(row.aiAction) &&
          ["NOCH WARTEN", "NICHT KAUFEN"].includes(quantAction);
      }
      return false;
    })
    .filter(row => row.aiConfidence >= requiredCardConfidence)
    .sort((a, b) => b.aiConfidence - a.aiConfidence);

  const row = candidates[0];
  if (!row) return null;

  return {
    kind: "card",
    row,
    confidence: row.aiConfidence,
    requiredConfidence: requiredCardConfidence,
    summary: `${row.aiAction} • ${row.name || `EA ${row.eaId}`} (${row.overall})`,
    reason: row.aiReason || "Trader Brain bestätigt den Trader-Call."
  };
}

function buildTraderConfluencePayload(signal, agreement, gate) {
  const call = String(signal?.call || "").toUpperCase();
  const emoji = call === "KAUFEN" ? "🧠🟢" : call === "VERKAUFEN" ? "🧠💰" : "🧠⏳";
  const target = String(signal?.playerOrRating || "-");
  const details = String(signal?.confirmationDetails || "Marktbestätigung aktiv.").slice(0, 900);
  const brainReason = String(agreement?.reason || "Eigene Marktlogik bestätigt den Call.").slice(0, 900);

  const fields = [
    { name: "Trader-Call", value: `${call} • ${target}`, inline: true },
    { name: "Quelle", value: String(signal?.source || "-").slice(0, 100), inline: true },
    { name: "Trader-Zuverlässigkeit", value: `${Number(gate?.effectiveReliability ?? signal?.sourceReliability ?? 50).toFixed(1)}%`, inline: true },
    { name: "Reliability-Gate", value: `Brain-Schwelle ${agreement?.requiredConfidence ?? "-"}% • Anpassung ${Number(gate?.confidenceAdjustment || 0) >= 0 ? "+" : ""}${gate?.confidenceAdjustment || 0}`, inline: true },
    { name: "Kategorie / Zeitraum", value: `${signal?.category || "-"} • ${signal?.expectedTimeframe || "nicht angegeben"}`, inline: false },
    { name: "Eigener Brain", value: agreement?.summary || "bestätigt", inline: false },
    { name: "FUT.GG Marktcheck", value: details, inline: false },
    { name: "Warum Alarm?", value: brainReason, inline: false }
  ];

  const url = agreement?.kind === "card" ? agreement.row?.url || undefined : undefined;

  return {
    embeds: [{
      title: `${emoji} TRADER + MARKT + BRAIN BESTÄTIGT`,
      url,
      description: `Externer Trader-Call wurde **nicht blind übernommen**. FUT.GG, eigener Quant Core, Trader Brain und Reliability-Gate stimmen aktuell überein.`,
      fields,
      footer: { text: "FC Trader Brain • Reliability-Aware Confluence" },
      timestamp: new Date().toISOString()
    }],
    components: agreement?.kind === "card" ? intensiveWatchAddComponents(agreement.row) : []
  };
}


function traderSignalLifecycleWindowMs(signal) {
  const preferredMinutes = preferredTraderSignalHorizon(signal);
  const preferredMs = Math.max(5, Number(preferredMinutes || 60)) * 60_000;
  const graceMs = 30 * 60_000;

  // Mindestens 90 Minuten aktiv, maximal 26 Stunden.
  // Die zusätzliche Grace-Zeit verhindert, dass ein "morgen"-/24h-Call
  // kurz vor seiner finalen 24h-Auswertung aus dem System fällt.
  return Math.min(
    26 * 60 * 60_000,
    Math.max(90 * 60_000, preferredMs + graceMs)
  );
}

function traderSignalIsActive(signal, now = Date.now()) {
  const timestamp = Number(signal?.timestamp || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;

  const ageMs = now - timestamp;
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;

  return ageMs <= traderSignalLifecycleWindowMs(signal);
}

function traderConfluenceInvalidationReason(signal, kind) {
  if (kind === "MARKET_LOST") {
    return String(signal?.confirmationDetails || "FUT.GG bestätigt den Trader-Call aktuell nicht mehr.").slice(0, 1000);
  }

  if (kind === "BRAIN_LOST") {
    return "FUT.GG kann den Call noch stützen, aber Quant Core / Trader Brain erfüllen die Bestätigungsbedingungen aktuell nicht mehr.";
  }

  return "Die frühere Konfluenz-Bestätigung ist aktuell nicht mehr gültig.";
}

function buildTraderConfluenceInvalidationPayload(signal, kind, gate) {
  const call = String(signal?.call || "-").toUpperCase();
  const target = String(signal?.playerOrRating || "-");
  const reason = traderConfluenceInvalidationReason(signal, kind);
  const reliability = Number(gate?.effectiveReliability ?? signal?.sourceReliability ?? 50);

  return {
    embeds: [{
      title: `⚠️ TRADER-SIGNAL NICHT MEHR BESTÄTIGT`,
      description:
        "Eine zuvor bestätigte Konfluenz ist weggefallen. Der alte Call wird deshalb nicht mehr als aktuell bestätigt behandelt.",
      fields: [
        { name: "Trader-Call", value: `${call} • ${target}`, inline: true },
        { name: "Quelle", value: String(signal?.source || "-").slice(0, 100), inline: true },
        { name: "Trader-Zuverlässigkeit", value: `${reliability.toFixed(1)}%`, inline: true },
        { name: "Status", value: kind === "MARKET_LOST" ? "FUT.GG-Marktbestätigung verloren" : "Brain-Bestätigung verloren", inline: false },
        { name: "Grund", value: reason, inline: false }
      ],
      footer: { text: "FC Trader Brain • Long-Horizon Lifecycle" },
      timestamp: new Date().toISOString()
    }]
  };
}

function buildTraderConfluenceExpirationPayload(signal, gate, lifecycleWindowMs) {
  const call = String(signal?.call || "-").toUpperCase();
  const target = String(signal?.playerOrRating || "-");
  const reliability = Number(gate?.effectiveReliability ?? signal?.sourceReliability ?? 50);
  const activeMinutes = Math.round(Number(lifecycleWindowMs || 0) / 60_000);

  return {
    embeds: [{
      title: "⌛ TRADER-SIGNAL ABGELAUFEN",
      description:
        "Der erwartete Zeitraum dieses Trader-Calls ist vorbei. Das Signal wird ab jetzt nicht mehr zur aktuellen Brain-Konfluenz gezählt.",
      fields: [
        { name: "Trader-Call", value: `${call} • ${target}`, inline: true },
        { name: "Quelle", value: String(signal?.source || "-").slice(0, 100), inline: true },
        { name: "Trader-Zuverlässigkeit", value: `${reliability.toFixed(1)}%`, inline: true },
        { name: "Erwarteter Zeitraum", value: String(signal?.expectedTimeframe || "nicht angegeben"), inline: true },
        { name: "Aktiv-Fenster", value: `${activeMinutes} Minuten`, inline: true },
        { name: "Status", value: "Nicht mehr aktiv für neue Kauf-/Verkaufsbestätigungen", inline: false }
      ],
      footer: { text: "FC Trader Brain • Long-Horizon Lifecycle" },
      timestamp: new Date().toISOString()
    }]
  };
}

async function expireTraderConfluenceSignal(signal, state, gate, lifecycleWindowMs, alertBudget = null) {
  const call = String(signal?.call || "").toUpperCase();
  const expiredAction = `EXPIRED:${call}`;

  // Nur ein zuvor wirklich bestätigtes Signal braucht eine mobile Ablaufmeldung.
  // Unbestätigte/unterdrückte Calls verschwinden still aus der aktiven Konfluenz.
  if (!state || !String(state.lastAction || "").startsWith("CONFIRMED:")) {
    return false;
  }

  if (!discordCycleHasRoom(alertBudget)) {
    discordCycleBlock(alertBudget);
    return false;
  }

  await sendDiscordPayload(
    buildTraderConfluenceExpirationPayload(signal, gate, lifecycleWindowMs)
  );
  discordCycleConsume(alertBudget);

  await saveDiscordAlertState({
    alertKey: `trader-confluence:${signal.id}`,
    alertType: "trader_confluence_expired",
    action: expiredAction,
    confidence: Number.isFinite(gate?.effectiveReliability)
      ? Math.round(gate.effectiveReliability)
      : null,
    fingerprint: `${signal.id}|expired|${Math.round(Number(lifecycleWindowMs || 0) / 60_000)}`.slice(0, 240)
  });

  traderConfluenceExpirationsSent += 1;
  lastTraderConfluenceExpirationAt = new Date().toISOString();
  lastTraderConfluenceGate = {
    signalId: signal.id,
    source: signal.source,
    result: "EXPIRED",
    effectiveReliability: gate?.effectiveReliability ?? signal?.sourceReliability ?? 50,
    lifecycleWindowMinutes: Math.round(Number(lifecycleWindowMs || 0) / 60_000),
    at: lastTraderConfluenceExpirationAt
  };

  return true;
}

async function invalidateTraderConfluenceSignal(signal, state, kind, gate, alertBudget = null) {
  const call = String(signal?.call || "").toUpperCase();
  const invalidAction = `INVALIDATED:${call}`;

  if (!state || !String(state.lastAction || "").startsWith("CONFIRMED:")) {
    return false;
  }

  if (!discordCycleHasRoom(alertBudget)) {
    discordCycleBlock(alertBudget);
    return false;
  }

  await sendDiscordPayload(buildTraderConfluenceInvalidationPayload(signal, kind, gate));
  discordCycleConsume(alertBudget);

  await saveDiscordAlertState({
    alertKey: `trader-confluence:${signal.id}`,
    alertType: "trader_confluence_invalidated",
    action: invalidAction,
    confidence: Number.isFinite(gate?.effectiveReliability) ? Math.round(gate.effectiveReliability) : null,
    fingerprint: `${signal.id}|${kind}|${signal.confirmationDetails || ""}`.slice(0, 240)
  });

  traderConfluenceInvalidationsSent += 1;
  lastTraderConfluenceInvalidationAt = new Date().toISOString();
  lastTraderConfluenceGate = {
    signalId: signal.id,
    source: signal.source,
    result: kind,
    effectiveReliability: gate?.effectiveReliability ?? signal?.sourceReliability ?? 50,
    at: lastTraderConfluenceInvalidationAt
  };

  return true;
}

async function processTraderConfluenceAlerts(rows, ratingStats, brainWork, alertBudget = null) {
  if (!DISCORD_CONFIGURED || !dbEnabled || !rows?.length) return;

  try {
    const [signals, profiles] = await Promise.all([
      loadRecentDiscordSignals(),
      loadTraderProfiles()
    ]);

    const candidates = [];

    for (const signal of signals) {
      if (signal.signalKind === "MARKET_EVENT" || String(signal.call || "").toUpperCase() === "BEOBACHTEN") continue;

      // v10.46: Im öffentlichen #trading-alerts-Feed dürfen Trader-Konfluenz-
      // Meldungen ebenfalls nur noch ratingbasiert erscheinen. Spielerbezogene
      // Trader-Calls werden intern weiter gelernt, aber nicht namentlich gepusht.
      if (traderSignalRating(signal) == null) continue;
      const profile = profiles[String(signal.source || "").toLowerCase()];
      const gate = traderConfluenceReliabilityGate(signal, profile);
      const ageMs = Date.now() - Number(signal.timestamp || 0);
      const lifecycleWindowMs = traderSignalLifecycleWindowMs(signal);
      const alertKey = `trader-confluence:${signal.id}`;
      const state = await getDiscordAlertState(alertKey);

      if (!Number.isFinite(ageMs) || ageMs < 0) continue;

      if (ageMs > lifecycleWindowMs) {
        await expireTraderConfluenceSignal(signal, state, gate, lifecycleWindowMs, alertBudget);
        continue;
      }

      if (signal.marketConfirmed !== true) {
        await invalidateTraderConfluenceSignal(signal, state, "MARKET_LOST", gate, alertBudget);
        continue;
      }

      if (!gate.allowed) {
        traderConfluenceSuppressedSignals.add(String(signal.id));
        lastTraderConfluenceGate = {
          signalId: signal.id,
          source: signal.source,
          result: "SUPPRESSED_LOW_RELIABILITY",
          effectiveReliability: gate.effectiveReliability,
          minimumReliability: DISCORD_TRADER_CONFLUENCE_MIN_RELIABILITY,
          lifecycleWindowMinutes: Math.round(lifecycleWindowMs / 60_000),
          at: new Date().toISOString()
        };
        continue;
      }

      const agreement = traderSignalBrainAgreement(signal, rows, ratingStats, brainWork, gate);
      if (!agreement) {
        const invalidated = await invalidateTraderConfluenceSignal(signal, state, "BRAIN_LOST", gate, alertBudget);

        if (!invalidated) {
          lastTraderConfluenceGate = {
            signalId: signal.id,
            source: signal.source,
            result: "WAITING_FOR_STRONGER_BRAIN_CONFIRMATION",
            effectiveReliability: gate.effectiveReliability,
            requiredCardConfidence: gate.requiredCardConfidence,
            requiredRatingConfidence: gate.requiredRatingConfidence,
            lifecycleWindowMinutes: Math.round(lifecycleWindowMs / 60_000),
            at: new Date().toISOString()
          };
        }
        continue;
      }

      candidates.push({ signal, agreement, gate, state, lifecycleWindowMs });
    }

    candidates.sort((a, b) => {
      const conf = (b.agreement.confidence || 0) - (a.agreement.confidence || 0);
      if (conf !== 0) return conf;
      return b.gate.effectiveReliability - a.gate.effectiveReliability;
    });

    for (const item of candidates) {
      // Trader-Confluence darf den kompletten Zyklus nicht auffressen.
      // Bei normalem 5er-Budget bleiben bis zu 2 Slots für interne
      // Signalwechsel und die stärksten Karten-/Rating-Alarme reserviert.
      if (!discordCycleHasRoomWithReserve(alertBudget, 2)) {
        discordCycleBlock(alertBudget);
        break;
      }

      const { signal, agreement, gate, state, lifecycleWindowMs } = item;
      const alertKey = `trader-confluence:${signal.id}`;
      const action = `CONFIRMED:${String(signal.call || "").toUpperCase()}`;

      if (state?.lastAction === action) continue;

      // Nach einer Invalidierung mindestens 15 Minuten Stabilität verlangen,
      // bevor derselbe Call erneut als bestätigt gemeldet wird.
      if (
        String(state?.lastAction || "").startsWith("INVALIDATED:") &&
        Number.isFinite(state?.lastSentAt) &&
        Date.now() - state.lastSentAt < 15 * 60_000
      ) {
        continue;
      }

      await sendDiscordPayload(buildTraderConfluencePayload(signal, agreement, gate));
      discordCycleConsume(alertBudget);

      await saveDiscordAlertState({
        alertKey,
        alertType: "trader_confluence",
        action,
        price: agreement.kind === "card" ? agreement.row?.price : agreement.stat?.medianPrice,
        confidence: agreement.confidence,
        fingerprint: `${signal.id}|${agreement.summary}|rel:${gate.effectiveReliability}`.slice(0, 240)
      });

      if (agreement.kind === "card" && agreement.row) {
        const row = agreement.row;
        await saveDiscordAlertState({
          alertKey: `card:${row.eaId}`,
          alertType: "trader_confluence_guard",
          action: row.aiAction,
          price: row.price,
          confidence: row.aiConfidence,
          fingerprint: `trader-confluence:${signal.id}`
        });
      } else if (agreement.kind === "rating" && agreement.stat) {
        const stat = agreement.stat;
        await saveDiscordAlertState({
          alertKey: `rating:${stat.rating}`,
          alertType: "trader_confluence_guard",
          action: stat.marketSignal,
          price: stat.medianPrice,
          confidence: stat.confidence,
          fingerprint: `trader-confluence:${signal.id}`
        });
      }

      traderConfluenceAlertsSent += 1;
      lastTraderConfluenceAlertAt = new Date().toISOString();
      lastTraderConfluenceAlertError = null;
      lastTraderConfluenceGate = {
        signalId: signal.id,
        source: signal.source,
        result: state && String(state.lastAction || "").startsWith("INVALIDATED:") ? "RECONFIRMED" : "ALERT_SENT",
        effectiveReliability: gate.effectiveReliability,
        requiredConfidence: agreement.requiredConfidence,
        actualConfidence: agreement.confidence,
        lifecycleWindowMinutes: Math.round(lifecycleWindowMs / 60_000),
        at: lastTraderConfluenceAlertAt
      };
    }
  } catch (error) {
    lastTraderConfluenceAlertError = String(error);
    lastDiscordError = String(error);
    console.error("Trader confluence alert error:", error);
  }
}

function brainTransitionKind(previousAction, nextAction, row = null, previousState = null) {
  const from = String(previousAction || "");
  const to = String(nextAction || "");

  const previousPrice = Number(previousState?.price);
  const currentPrice = Number(row?.price);
  if (
    from === "JETZT KAUFEN" &&
    ["NOCH WARTEN", "NICHT KAUFEN", "BEOBACHTEN", "HALTEN", "VERKAUF PRÜFEN", "JETZT VERKAUFEN"].includes(to) &&
    Number.isFinite(previousPrice) && previousPrice > 0 &&
    Number.isFinite(currentPrice) && currentPrice < previousPrice
  ) {
    return "buy_failed";
  }

  if (
    to === "JETZT KAUFEN" &&
    ["NOCH WARTEN", "BEOBACHTEN", "NICHT KAUFEN"].includes(from)
  ) {
    return "buy";
  }

  if (
    to === "JETZT VERKAUFEN" &&
    ["VERKAUF PRÜFEN", "HALTEN", "JETZT KAUFEN", "BEOBACHTEN"].includes(from)
  ) {
    return "sell";
  }

  if (
    to === "VERKAUF PRÜFEN" &&
    ["HALTEN", "JETZT KAUFEN", "BEOBACHTEN"].includes(from)
  ) {
    return "sell";
  }

  return null;
}

function buildBrainTransitionPayload(row, previousAction, kind, previousState = null) {
  if (kind === "buy_failed") {
    const previousPrice = Number(previousState?.price);
    const dropPct = Number.isFinite(previousPrice) && previousPrice > 0
      ? Number((((Number(row.price) - previousPrice) / previousPrice) * 100).toFixed(2))
      : null;
    const ownedAction = row.tracked
      ? (["JETZT VERKAUFEN", "VERKAUF PRÜFEN"].includes(row.aiAction) ? row.aiAction : "AUSSTIEG PRÜFEN")
      : "NICHT KAUFEN";

    return {
      embeds: [{
        title: `🔴 KAUFSIGNAL GESCHEITERT • ${row.name || `EA ${row.eaId}`}`,
        url: row.url || undefined,
        description: row.tracked
          ? `Das frühere JETZT-KAUFEN-Setup wurde invalidiert. **Eigener Bestand: ${ownedAction}.**`
          : `Das frühere JETZT-KAUFEN-Setup wurde invalidiert. **Aktuell: NICHT KAUFEN.**`,
        fields: [
          { name: "Kaufsignal bei", value: Number.isFinite(previousPrice) ? `${discordNumber(previousPrice)} Coins` : "-", inline: true },
          { name: "Aktueller Preis", value: `${discordNumber(row.price)} Coins`, inline: true },
          { name: "Seit Signal", value: dropPct == null ? "-" : discordPct(dropPct), inline: true },
          { name: "Brain jetzt", value: `${row.aiAction} • ${row.aiConfidence}%`, inline: true },
          { name: "Aktion", value: ownedAction, inline: true },
          { name: "Warum invalidiert?", value: String(row.aiReason || "Der bestätigte Boden hat nicht gehalten.").slice(0, 1000), inline: false }
        ],
        footer: { text: "FC Trader Brain • v10.37 Buy-Signal Invalidation" },
        timestamp: new Date().toISOString()
      }],
      components: intensiveWatchAddComponents(row)
    };
  }

  const emoji = kind === "buy" ? "🟢" : "💰";
  const title = `${emoji} SIGNALWECHSEL: ${row.aiAction} • ${row.name || `EA ${row.eaId}`}`;

  return {
    embeds: [{
      title,
      url: row.url || undefined,
      description: `**${previousAction} → ${row.aiAction}**`,
      fields: [
        { name: "Preis", value: `${discordNumber(row.price)} Coins`, inline: true },
        { name: "KI-Sicherheit", value: `${row.aiConfidence}%`, inline: true },
        { name: "Rating / Typ", value: `${row.overall} • ${row.cardType || "-"}`, inline: true },
        { name: "1m / 5m / 15m", value: `${discordPct(row.change1m)} / ${discordPct(row.change5m)} / ${discordPct(row.change15m)}`, inline: false },
        { name: "Warum jetzt?", value: String(row.aiReason || "Signalzustand hat sich geändert.").slice(0, 1000), inline: false }
      ],
      footer: { text: "FC Trader Brain • relevanter Zustandswechsel" },
      timestamp: new Date().toISOString()
    }],
    components: intensiveWatchAddComponents(row)
  };
}

async function loadBrainStates(rows) {
  const ids = rows.map(row => String(row.eaId)).filter(Boolean);
  if (!ids.length) return new Map();

  if (!dbEnabled) {
    return new Map(ids.map(id => [id, memoryBrainState.get(id)]).filter(([, state]) => state));
  }

  const result = await pool.query(`
    SELECT ea_id::text AS ea_id, last_action, last_price, last_confidence, updated_at
    FROM fc_brain_state
    WHERE ea_id = ANY($1::bigint[])
  `, [ids]);

  return new Map(result.rows.map(state => [
    state.ea_id,
    {
      action: state.last_action,
      price: state.last_price == null ? null : Number(state.last_price),
      confidence: state.last_confidence == null ? null : Number(state.last_confidence),
      updatedAt: state.updated_at ? new Date(state.updated_at).getTime() : null
    }
  ]));
}

async function saveBrainStates(rows, excludedIds = new Set()) {
  const clean = rows.filter(row =>
    row &&
    Number.isFinite(Number(row.eaId)) &&
    row.aiAction &&
    !excludedIds.has(String(row.eaId))
  );

  if (!clean.length) return;

  if (!dbEnabled) {
    for (const row of clean) {
      memoryBrainState.set(String(row.eaId), {
        action: row.aiAction,
        price: Number.isFinite(row.price) ? Math.round(row.price) : null,
        confidence: Number.isFinite(row.aiConfidence) ? Math.round(row.aiConfidence) : null,
        updatedAt: Date.now()
      });
    }
    return;
  }

  await pool.query(`
    INSERT INTO fc_brain_state (ea_id, last_action, last_price, last_confidence, updated_at)
    SELECT *
    FROM UNNEST(
      $1::bigint[],
      $2::varchar[],
      $3::int[],
      $4::smallint[],
      $5::timestamptz[]
    )
    ON CONFLICT (ea_id)
    DO UPDATE SET
      last_action = EXCLUDED.last_action,
      last_price = EXCLUDED.last_price,
      last_confidence = EXCLUDED.last_confidence,
      updated_at = EXCLUDED.updated_at
  `, [
    clean.map(row => String(row.eaId)),
    clean.map(row => String(row.aiAction)),
    clean.map(row => Number.isFinite(row.price) ? Math.round(row.price) : null),
    clean.map(row => Number.isFinite(row.aiConfidence) ? Math.round(row.aiConfidence) : null),
    clean.map(() => new Date().toISOString())
  ]);
}

async function processBrainStateChangeAlerts(rows, alertBudget = null) {
  if (!rows?.length) return;

  const previousStates = await loadBrainStates(rows);
  const candidates = [];

  for (const row of rows) {
    if (row?.aiAlertSanity?.blocked) continue;
    if (suppressNormalPlayerDiscord(row)) continue;
    const previous = previousStates.get(String(row.eaId));
    if (!previous?.action || previous.action === row.aiAction) continue;

    const kind = brainTransitionKind(previous.action, row.aiAction, row, previous);
    if (!kind) continue;
    if (row.intensiveWatch && kind !== "buy_failed") continue;

    const minConfidence = kind === "buy_failed"
      ? 0
      : kind === "buy"
      ? DISCORD_TRANSITION_MIN_BUY_CONFIDENCE
      : DISCORD_TRANSITION_MIN_SELL_CONFIDENCE;

    if (!Number.isFinite(row.aiConfidence) || row.aiConfidence < minConfidence) continue;

    candidates.push({ row, previous, kind });
  }

  candidates.sort((a, b) => b.row.aiConfidence - a.row.aiConfidence);
  const retryIds = new Set();

  if (DISCORD_CONFIGURED) {
    for (const item of candidates) {
      if (!discordCycleHasRoomWithReserve(alertBudget, 1)) {
        // Einen letzten Slot für den stärksten normalen Karten-/Rating-Alarm
        // freihalten. Nicht gesendete Übergänge bleiben für den nächsten
        // 60-Sekunden-Lauf offen, statt durch den Brain-State verloren zu gehen.
        retryIds.add(String(item.row.eaId));
        discordCycleBlock(alertBudget);
        continue;
      }

      const { row, previous, kind } = item;
      const transitionAction = `${previous.action}->${row.aiAction}`;
      const transitionKey = `transition:${row.eaId}`;
      const fingerprint = `${transitionAction}|${Math.round((row.change5m ?? 0) * 10)}|${Math.round((row.change15m ?? 0) * 10)}`;

      try {
        const alertState = await getDiscordAlertState(transitionKey);
        if (!discordAlertShouldSend(alertState, transitionAction, row.price, row.aiConfidence, fingerprint)) {
          continue;
        }

        await sendDiscordPayload(buildBrainTransitionPayload(row, previous.action, kind, previous));
        discordCycleConsume(alertBudget);

        await saveDiscordAlertState({
          alertKey: transitionKey,
          alertType: "transition",
          action: transitionAction,
          price: row.price,
          confidence: row.aiConfidence,
          fingerprint
        });

        // Unterdrückt denselben BUY/SELL-Alarm direkt danach im normalen Alert-Lauf.
        await saveDiscordAlertState({
          alertKey: `card:${row.eaId}`,
          alertType: kind === "buy_failed" ? "buy_invalidation" : kind,
          action: row.aiAction,
          price: row.price,
          confidence: row.aiConfidence,
          fingerprint: `transition:${fingerprint}`
        });

      } catch (error) {
        retryIds.add(String(row.eaId));
        lastDiscordError = String(error);
        console.error("Discord transition alert error:", error);
      }
    }
  }

  // Fehlgeschlagene, limitierte oder durch den v10.42-Daten-Sanity-Guard blockierte
  // Übergänge bleiben offen. Ein widersprüchlicher Snapshot darf den Brain-State
  // nicht als neue Wahrheit speichern.
  for (const row of rows) {
    if (row?.aiAlertSanity?.blocked) retryIds.add(String(row.eaId));
  }
  await saveBrainStates(rows, retryIds);
}

function intensiveWatchNetPct(row, watch) {
  const start = Number(watch?.startPrice);
  const current = Number(row?.price);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(current) || current <= 0) return null;
  return Number((((current * 0.95 - start) / start) * 100).toFixed(2));
}

function intensiveWatchPriority(row) {
  const action = String(row?.aiAction || "");
  const actionPriority = {
    "JETZT VERKAUFEN": 500,
    "VERKAUF PRÜFEN": 450,
    "JETZT KAUFEN": 400,
    "NOCH WARTEN": 330,
    "NICHT KAUFEN": 300,
    "HALTEN": 250,
    "BEOBACHTEN": 200
  }[action] || 100;
  return actionPriority + Number(row?.aiConfidence || 0);
}

function buildIntensiveWatchPayload(row, watch, trigger, movePct) {
  const netPct = intensiveWatchNetPct(row, watch);
  const action = String(row.aiAction || "BEOBACHTEN");
  const emoji = action === "JETZT VERKAUFEN" ? "💰" : action === "VERKAUF PRÜFEN" ? "🟠" : action === "JETZT KAUFEN" ? "🟢" : "👁️";
  const triggerText = trigger === "ACTION_CHANGE"
    ? `Brain-Zustand geändert: **${watch.lastAction || "-"} → ${action}**`
    : `Preis seit dem letzten Intensiv-Update: **${discordPct(movePct)}**`;

  const fields = [
    { name: "Aktueller Preis", value: `${discordNumber(row.price)} Coins`, inline: true },
    { name: "Überwachung gestartet bei", value: `${discordNumber(watch.startPrice)} Coins`, inline: true },
    { name: "KI-Sicherheit", value: `${row.aiConfidence}%`, inline: true },
    { name: "1m / 5m / 15m", value: `${discordPct(row.change1m)} / ${discordPct(row.change5m)} / ${discordPct(row.change15m)}`, inline: false },
    { name: "Seit Überwachungsstart", value: netPct == null ? "-" : `${discordPct(netPct)} nach 5% EA-Steuer (Referenz, kein bestätigter Kaufpreis)`, inline: false },
    { name: "Warum Update?", value: triggerText, inline: false },
    { name: "Brain", value: String(row.aiReason || "Keine Begründung verfügbar.").slice(0, 900), inline: false }
  ];

  if (row.tracked) {
    fields.push({
      name: "Deine gespeicherte Position",
      value: `Kauf ${discordNumber(row.buyPrice)} × ${discordNumber(row.quantity || 1)} | Netto ${discordNumber(row.netProfitTotal)} Coins | ${discordPct(row.profitPercent)}`,
      inline: false
    });
  }

  return {
    embeds: [{
      title: `${emoji} INTENSIV: ${row.name || `EA ${row.eaId}`} • ${action}`,
      url: row.url || undefined,
      description: "Diese Karte wird nur deshalb enger verfolgt, weil du **Intensiv überwachen** gedrückt hast.",
      fields,
      footer: { text: "FC Trader Brain • persönliche Intensiv-Watchlist" },
      timestamp: new Date().toISOString()
    }],
    components: intensiveWatchStopComponents(row)
  };
}

async function processIntensiveWatchAlerts(rows, alertBudget = null) {
  const watches = await getIntensiveWatchlist();
  if (!watches.size || !rows?.length) return;

  const rowMap = new Map(rows.map(row => [String(row.eaId), row]));
  const candidates = [];
  const noAlertUpdates = [];
  const now = Date.now();

  for (const [eaId, watch] of watches.entries()) {
    const row = rowMap.get(String(eaId));
    if (!row) continue;
    row.intensiveWatch = true;

    const previousAction = String(watch.lastAction || "");
    const actionChanged = Boolean(previousAction && previousAction !== String(row.aiAction || ""));
    const baseline = Number(watch.lastAlertPrice || watch.startPrice);
    const movePct = changePct(row.price, baseline);
    const gapOkay = !watch.lastAlertAt || now - Number(watch.lastAlertAt) >= INTENSIVE_WATCH_MIN_ALERT_GAP_MS;
    const meaningfulMove = gapOkay && Number.isFinite(movePct) && Math.abs(movePct) >= INTENSIVE_WATCH_MOVE_PCT;

    if (actionChanged || meaningfulMove) {
      candidates.push({
        row, watch,
        trigger: actionChanged ? "ACTION_CHANGE" : "PRICE_MOVE",
        movePct,
        priority: intensiveWatchPriority(row) + (actionChanged ? 50 : 0)
      });
    } else {
      noAlertUpdates.push({ row, watch });
    }
  }

  // Zustandsdaten ohne Alarm normal fortschreiben. Dadurch erzeugt eine Karte
  // nicht wegen jeder 60-Sekunden-Abfrage eine neue Nachricht.
  for (const item of noAlertUpdates) {
    await updateIntensiveWatchState(item.row, item.watch, { alertSent: false });
  }

  if (!DISCORD_CONFIGURED || !candidates.length) return;

  candidates.sort((a, b) => b.priority - a.priority);
  let sent = 0;

  for (const item of candidates) {
    if (sent >= INTENSIVE_WATCH_MAX_ALERTS_PER_CYCLE || !discordCycleHasRoom(alertBudget)) {
      discordCycleBlock(alertBudget);
      // Nicht fortschreiben: der relevante Wechsel bleibt bis zum nächsten Zyklus offen.
      continue;
    }

    try {
      await sendDiscordPayload(buildIntensiveWatchPayload(item.row, item.watch, item.trigger, item.movePct));
      discordCycleConsume(alertBudget);
      sent += 1;
      intensiveWatchAlertsSent += 1;
      lastIntensiveWatchAlertAt = new Date().toISOString();
      lastIntensiveWatchError = null;
      await updateIntensiveWatchState(item.row, item.watch, { alertSent: true });
    } catch (error) {
      lastIntensiveWatchError = String(error);
      lastDiscordError = String(error);
      console.error("Intensive watch Discord alert error:", error);
      // Zustand absichtlich nicht fortschreiben, damit der Alert erneut versucht wird.
    }
  }
}

async function processDiscordAlerts(rows, ratingStats, alertBudget = null) {
  if (!DISCORD_CONFIGURED) return;

  try {
    const candidates = [];

    for (const row of rows) {
      if (row.intensiveWatch) continue;
      // v10.46 Strict Rating Feed: normale automatische Einzelspieler-Alarme aller
      // Kartentypen werden unterdrückt. Nur eigene Positionen und bewusst intensiv
      // überwachte Karten bleiben namentliche persönliche Ausnahmen.
      if (suppressNormalPlayerDiscord(row)) continue;
      const candidate = cardDiscordAlertCandidate(row);
      if (candidate) candidates.push({ kind: "card", row, ...candidate });
    }

    // Volatile Directional-Alerts werden direkt vor Discord einmal gegen einen
    // frischen FUT.GG-Bulk-Snapshot gegengeprüft. Wenn der Preis seit der Analyse
    // materiell weitergesprungen ist, senden wir DATEN PRÜFEN statt einer alten
    // Kauf-/Verkauf-/Crash-Aussage.
    const needsRecheck = candidates.filter(item => item.kind === "card" && discordAlertNeedsLiveRecheck(item.row, item.type));
    if (needsRecheck.length) {
      try {
        const freshBulk = await loadBulkPs5Prices(true);
        for (const item of needsRecheck) {
          const fresh = freshBulk?.map?.get(Number(item.row.eaId))?.price;
          if (!Number.isFinite(fresh) || fresh <= 0) continue;
          if (markDiscordLivePriceRecheck(item.row, fresh)) {
            item.type = "data";
            item.priority = Math.max(item.priority || 0, 125);
          }
        }
      } catch (error) {
        console.warn("v10.42 Discord live price recheck skipped:", String(error));
      }
    }

    for (const stat of Object.values(ratingStats || {})) {
      if (ratingDiscordAlertCandidate(stat)) {
        candidates.push({ kind: "rating", stat, type: "rating", priority: 120 + stat.confidence });
      }
    }

    candidates.sort((a, b) => b.priority - a.priority);

    for (const item of candidates) {
      if (!discordCycleHasRoom(alertBudget)) {
        discordCycleBlock(alertBudget);
        break;
      }

      if (item.kind === "card") {
        const row = item.row;
        const alertKey = `card:${row.eaId}`;
        const alertPrice = discordAlertPrice(row);
        const fingerprint = `${item.type}|${row.aiAction}|${Math.round((row.change5m ?? 0) * 10)}|${Math.round((row.change15m ?? 0) * 10)}|${Math.round(Number(row?.aiAlertSanity?.recheckDiffPct || 0) * 10)}`;
        const state = await getDiscordAlertState(alertKey);
        if (!discordAlertShouldSend(state, item.type === "data" ? "DATEN PRÜFEN" : row.aiAction, alertPrice, row.aiConfidence, fingerprint)) continue;

        await sendDiscordPayload(buildCardDiscordPayload(row, item.type));
        discordCycleConsume(alertBudget);
        await saveDiscordAlertState({
          alertKey,
          alertType: item.type,
          action: item.type === "data" ? "DATEN PRÜFEN" : row.aiAction,
          price: alertPrice,
          confidence: row.aiConfidence,
          fingerprint
        });
      } else {
        const stat = item.stat;
        const alertKey = `rating:${stat.rating}`;
        const ratingAlertPrice = Number(stat.ratingReferencePrice ?? stat.medianPrice);
        // Namen/Einzelausnahmen dürfen keinen neuen öffentlichen Rating-Alarm
        // auslösen. Sie sind nur hinter dem Button "Spieler anzeigen" sichtbar.
        const fingerprint = `${stat.marketSignal}|${stat.marketAdvice}|${Math.round((stat.change5m ?? 0) * 10)}|${Math.round(ratingAlertPrice || 0)}`;
        const state = await getDiscordAlertState(alertKey);
        if (!discordAlertShouldSend(state, stat.marketSignal, ratingAlertPrice, stat.confidence, fingerprint)) continue;

        await sendDiscordPayload(buildRatingDiscordPayload(stat));
        discordCycleConsume(alertBudget);
        await saveDiscordAlertState({
          alertKey,
          alertType: "rating",
          action: stat.marketSignal,
          price: ratingAlertPrice,
          confidence: stat.confidence,
          fingerprint
        });
      }
    }
  } catch (error) {
    lastDiscordError = String(error);
    console.error("Discord alerts error:", error);
  }
}

async function sendDiscordStartupMessage() {
  if (!DISCORD_CONFIGURED) return;

  try {
    const alertKey = "system:discord-connected";
    const state = await getDiscordAlertState(alertKey);
    const now = Date.now();
    if (state && now - state.lastSentAt < 12 * 60 * 60_000) return;

    await sendDiscordPayload({
      embeds: [{
        title: "✅ FC Trader Brain verbunden",
        description: "Automatische Trading-Alerts sind aktiv. Decision Performance Lab bewertet eigenständige KI-Calls automatisch im Hintergrund.",
        fields: [
          { name: "Markt-Check", value: "alle 60 Sekunden", inline: true },
          { name: "Kaufalarm ab", value: `${DISCORD_MIN_BUY_CONFIDENCE}% KI-Sicherheit`, inline: true },
          { name: "Spam-Schutz", value: `${Math.round(DISCORD_ALERT_COOLDOWN_MS / 60_000)} Min. Cooldown`, inline: true }
        ],
        footer: { text: "FC Trading Intelligence v10.47" },
        timestamp: new Date().toISOString()
      }]
    });

    await saveDiscordAlertState({
      alertKey,
      alertType: "system",
      action: "CONNECTED",
      fingerprint: "v10.50"
    });
  } catch (error) {
    lastDiscordError = String(error);
    console.error("Discord startup message error:", error);
  }
}

async function monitorOnce() {
  if (monitoringBusy) return;

  monitoringBusy = true;
  const cycleAlertBudget = createDiscordCycleBudget();

  try {
    let cards;
    let bulk;
    let futbinFeed;
    let currentRows;
    const at = Date.now();

    // v10.31: Failure-Domain-Isolation bleibt aktiv; Deploys fahren den Dienst jetzt zusätzlich sauber herunter.
    // Fehler aus DB, Brain oder Discord gehören in eine getrennte Failure Domain.
    try {
      [cards, bulk, futbinFeed] = await Promise.all([
        ensureUniverse(false),
        loadBulkPs5Prices(true),
        loadAuthorizedFutbinFeedSafe(false)
      ]);

      currentRows = currentPricedCards(cards, bulk);
      updateSourceHealthSuccess(cards, bulk, currentRows);
    } catch (error) {
      const sourceHealth = updateSourceHealthFailure(error);
      try {
        await notifySourceHealthTransition(sourceHealth, cycleAlertBudget);
      } catch (notifyError) {
        console.error("source health Discord notification error:", notifyError);
      }

      const fallbackFeed = await loadAuthorizedFutbinFeedSafe(false);
      latestFutbinFallbackRows = futbinFallbackAllowed()
        ? buildFutbinFallbackRows(latestTradingRows, fallbackFeed)
        : [];

      lastMonitorError = `FUT.GG source: ${String(error)}`;
      console.error("FUT.GG source error:", error);
      return;
    }

    const sourceHealth = sourceHealthSnapshot();
    try {
      await notifySourceHealthTransition(sourceHealth, cycleAlertBudget);
    } catch (notifyError) {
      console.error("source health Discord notification error:", notifyError);
    }
    if (!sourceHealthAllowsTradingCycle()) {
      latestFutbinFallbackRows = futbinFallbackAllowed()
        ? buildFutbinFallbackRows(latestTradingRows, futbinFeed)
        : [];
      lastMonitorAt = new Date(at).toISOString();
      lastMonitorError = `Source Health Guard: ${sourceHealth.reason}`;
      console.warn(lastMonitorError);
      return;
    }

    try {
      recordMemory(currentRows, at);

      if (dbEnabled) {
        await recordDb(currentRows, at);
      }

      const built = await buildTradingRows(futbinFeed);
      latestTradingRows = built.rows;
      latestFutbinFallbackRows = [];
      latestRatingStats = built.ratingStats;
      updateFutbinCrossCheckHealth(latestTradingRows);

      await evaluateTraderSignalReliability(latestTradingRows);
      await evaluateTraderMarketImpact(latestTradingRows);
      await evaluateMarketKnowledge(latestTradingRows);
      await enrichImportantRowsWithFutbinParse(latestTradingRows, built.brainWork);
      await automaticTraderBrain(latestTradingRows, built.brainWork);
      for (const row of latestTradingRows) {
        const work = built.brainWork.get(String(row.eaId));
        calibrateStrictBuyDecision(row, work);
        applyAlertSanityGuard(row);
        recordStrictBuyGuardOutcome(row);
      }
      await processIntensiveWatchAlerts(latestTradingRows, cycleAlertBudget);
      await processTraderConfluenceAlerts(latestTradingRows, latestRatingStats, built.brainWork, cycleAlertBudget);
      await processBrainStateChangeAlerts(latestTradingRows, cycleAlertBudget);
      await processDiscordAlerts(latestTradingRows, latestRatingStats, cycleAlertBudget);
      await evaluatePendingDecisions();

      updateProcessingHealthSuccess();
      lastMonitorAt = new Date(at).toISOString();
      lastMonitorError = null;
    } catch (error) {
      updateProcessingHealthFailure(error);
      lastMonitorError = `Processing pipeline: ${String(error)}`;
      console.error("processing pipeline error:", error);
      // Wichtig: FUT.GG bleibt gesund, wenn nur DB/Brain/Discord fehlschlägt.
      // Dadurch startet keine falsche Source-Recovery-Quarantäne.
    }
  } finally {
    cycleAlertBudget.finishedAt = new Date().toISOString();
    lastDiscordCycleBudget = { ...cycleAlertBudget };
    monitoringBusy = false;
  }
}

function lookupMemory(eaId, threshold) {
  const list = memoryHistory.get(eaId) || [];
  let result = null;

  for (const point of list) {
    if (point.t <= threshold) {
      result = point;
    } else {
      break;
    }
  }

  return result?.price ?? null;
}

function rangeMemory(eaId, start) {
  const list = memoryHistory.get(eaId) || [];
  const values = list
    .filter(point => point.t >= start)
    .map(point => point.price);

  if (!values.length) {
    return {
      low: null,
      high: null
    };
  }

  return {
    low: Math.min(...values),
    high: Math.max(...values)
  };
}

async function lookupDb(ids, threshold) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `
      SELECT DISTINCT ON (ea_id)
        ea_id::text AS ea_id,
        price
      FROM fc_price_history
      WHERE ea_id = ANY($1::bigint[])
        AND recorded_at <= $2
      ORDER BY ea_id, recorded_at DESC
    `,
    [
      ids.map(String),
      new Date(threshold).toISOString()
    ]
  );

  return new Map(
    result.rows.map(row => [
      row.ea_id,
      Number(row.price)
    ])
  );
}

async function rangeDb(ids, start) {
  if (!dbEnabled || !ids.length) return new Map();

  const result = await pool.query(
    `
      SELECT
        ea_id::text AS ea_id,
        MIN(price)::int AS low,
        MAX(price)::int AS high
      FROM fc_price_history
      WHERE ea_id = ANY($1::bigint[])
        AND recorded_at >= $2
      GROUP BY ea_id
    `,
    [
      ids.map(String),
      new Date(start).toISOString()
    ]
  );

  return new Map(
    result.rows.map(row => [
      row.ea_id,
      {
        low: Number(row.low),
        high: Number(row.high)
      }
    ])
  );
}

async function getPositions() {
  if (dbEnabled) {
    const result = await pool.query(`
      SELECT
        ea_id::text AS ea_id,
        buy_price,
        quantity,
        note,
        created_at,
        updated_at
      FROM fc_positions
    `);

    return new Map(
      result.rows.map(row => [
        row.ea_id,
        {
          buyPrice: Number(row.buy_price),
          quantity: Number(row.quantity),
          note: row.note ?? "",
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      ])
    );
  }

  return new Map(
    [...memoryPositions.entries()].map(([eaId, value]) => [
      String(eaId),
      value
    ])
  );
}

async function savePosition(eaId, buyPrice, quantity = 1, note = "") {
  if (dbEnabled) {
    await pool.query(
      `
        INSERT INTO fc_positions (
          ea_id,
          buy_price,
          quantity,
          note,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (ea_id)
        DO UPDATE
        SET
          buy_price = EXCLUDED.buy_price,
          quantity = EXCLUDED.quantity,
          note = EXCLUDED.note,
          updated_at = NOW()
      `,
      [
        String(eaId),
        buyPrice,
        quantity,
        note
      ]
    );

    return;
  }

  memoryPositions.set(String(eaId), {
    buyPrice,
    quantity,
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function deletePosition(eaId) {
  if (dbEnabled) {
    await pool.query(
      `
        DELETE FROM fc_positions
        WHERE ea_id = $1
      `,
      [String(eaId)]
    );

    return;
  }

  memoryPositions.delete(String(eaId));
}

async function getIntensiveWatchlist() {
  if (dbEnabled) {
    const result = await pool.query(`
      SELECT
        ea_id::text AS ea_id, player_name, start_price, requested_by,
        last_action, last_price, last_confidence, last_alert_price,
        last_alert_at, started_at, updated_at
      FROM fc_intensive_watchlist
      ORDER BY started_at DESC
    `);

    return new Map(result.rows.map(row => [
      row.ea_id,
      {
        eaId: row.ea_id,
        playerName: row.player_name || `EA ${row.ea_id}`,
        startPrice: Number(row.start_price),
        requestedBy: row.requested_by || null,
        lastAction: row.last_action || null,
        lastPrice: row.last_price == null ? null : Number(row.last_price),
        lastConfidence: row.last_confidence == null ? null : Number(row.last_confidence),
        lastAlertPrice: row.last_alert_price == null ? null : Number(row.last_alert_price),
        lastAlertAt: row.last_alert_at ? new Date(row.last_alert_at).getTime() : null,
        startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
      }
    ]));
  }

  return new Map([...memoryIntensiveWatchlist.entries()].map(([eaId, value]) => [String(eaId), { ...value }]));
}

async function saveIntensiveWatch(row, requestedBy = null) {
  const eaId = String(row?.eaId || "");
  const price = Number(row?.price);
  if (!/^\d+$/.test(eaId) || !Number.isFinite(price) || price <= 0) {
    throw new Error("Karte hat keinen gültigen Marktpreis für die intensive Überwachung.");
  }

  if (dbEnabled) {
    await pool.query(`
      INSERT INTO fc_intensive_watchlist (
        ea_id, player_name, start_price, requested_by,
        last_action, last_price, last_confidence, last_alert_price, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (ea_id)
      DO UPDATE SET
        player_name = EXCLUDED.player_name,
        requested_by = COALESCE(EXCLUDED.requested_by, fc_intensive_watchlist.requested_by),
        updated_at = NOW()
    `, [
      eaId,
      String(row.name || `EA ${eaId}`).slice(0, 180),
      Math.round(price),
      requestedBy ? String(requestedBy).slice(0, 80) : null,
      row.aiAction || null,
      Math.round(price),
      Number.isFinite(row.aiConfidence) ? Math.round(row.aiConfidence) : null,
      Math.round(price)
    ]);
  } else if (!memoryIntensiveWatchlist.has(eaId)) {
    memoryIntensiveWatchlist.set(eaId, {
      eaId,
      playerName: row.name || `EA ${eaId}`,
      startPrice: Math.round(price),
      requestedBy: requestedBy || null,
      lastAction: row.aiAction || null,
      lastPrice: Math.round(price),
      lastConfidence: Number.isFinite(row.aiConfidence) ? Math.round(row.aiConfidence) : null,
      lastAlertPrice: Math.round(price),
      lastAlertAt: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  row.intensiveWatch = true;
  const watches = await getIntensiveWatchlist();
  return watches.get(eaId) || null;
}

async function deleteIntensiveWatch(eaId) {
  const key = String(eaId);
  if (dbEnabled) {
    await pool.query(`DELETE FROM fc_intensive_watchlist WHERE ea_id = $1`, [key]);
  } else {
    memoryIntensiveWatchlist.delete(key);
  }

  const row = latestTradingRows.find(item => String(item.eaId) === key);
  if (row) row.intensiveWatch = false;
}

async function updateIntensiveWatchState(row, watch, { alertSent = false } = {}) {
  const eaId = String(row.eaId);
  const price = Number.isFinite(row.price) ? Math.round(row.price) : null;
  const confidence = Number.isFinite(row.aiConfidence) ? Math.round(row.aiConfidence) : null;
  const nowIso = new Date().toISOString();

  if (dbEnabled) {
    await pool.query(`
      UPDATE fc_intensive_watchlist
      SET
        player_name = $2,
        last_action = $3,
        last_price = $4,
        last_confidence = $5,
        last_alert_price = CASE WHEN $6::boolean THEN $4 ELSE last_alert_price END,
        last_alert_at = CASE WHEN $6::boolean THEN NOW() ELSE last_alert_at END,
        updated_at = NOW()
      WHERE ea_id = $1
    `, [eaId, String(row.name || `EA ${eaId}`).slice(0, 180), row.aiAction || null, price, confidence, alertSent]);
    return;
  }

  const current = memoryIntensiveWatchlist.get(eaId) || watch || {};
  memoryIntensiveWatchlist.set(eaId, {
    ...current,
    eaId,
    playerName: row.name || current.playerName || `EA ${eaId}`,
    lastAction: row.aiAction || null,
    lastPrice: price,
    lastConfidence: confidence,
    lastAlertPrice: alertSent ? price : current.lastAlertPrice,
    lastAlertAt: alertSent ? Date.now() : current.lastAlertAt,
    updatedAt: nowIso
  });
}

function changePct(current, old) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(old) ||
    old <= 0
  ) {
    return null;
  }

  return Number(
    (((current - old) / old) * 100).toFixed(2)
  );
}

function distancePct(current, target) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(target) ||
    target <= 0
  ) {
    return null;
  }

  return Number(
    (((current - target) / target) * 100).toFixed(2)
  );
}

function signalFor(row) {
  const nearLow =
    Number.isFinite(row.low24h) &&
    row.low24h > 0 &&
    row.price <= row.low24h * 1.035;

  const nearHigh =
    Number.isFinite(row.high24h) &&
    row.high24h > 0 &&
    row.price >= row.high24h * 0.97;

  const drop24 =
    Number.isFinite(row.change24h) &&
    row.change24h <= -5;

  const drop7d =
    Number.isFinite(row.change7d) &&
    row.change7d <= -8;

  const recover1h =
    Number.isFinite(row.change1h) &&
    row.change1h >= 1;

  const rising24 =
    Number.isFinite(row.change24h) &&
    row.change24h >= 5;

  const falling1h =
    Number.isFinite(row.change1h) &&
    row.change1h <= -2;

  let score = 0;
  let signal = "HALTEN";

  if (nearLow) score += 28;
  if (drop24) score += 24;
  if (drop7d) score += 18;
  if (recover1h) score += 24;
  if (falling1h) score -= 18;

  if (nearLow && (drop24 || drop7d) && recover1h) {
    signal = "KAUFEN";
    score += 25;
  } else if (nearLow && (drop24 || drop7d)) {
    signal = "BEOBACHTEN";
    score += 12;
  } else if (nearHigh && rising24) {
    signal = "VERKAUF PRÜFEN";
    score += 16;
  } else if (recover1h && drop24) {
    signal = "ERHOLUNG";
    score += 15;
  } else if (falling1h) {
    signal = "FÄLLT";
  }

  return {
    signal,
    score:
      Math.max(
        0,
        Math.min(100, Math.round(score))
      )
  };
}


function profitInfo(currentPrice, position) {
  if (
    !position ||
    !Number.isFinite(position.buyPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return {
      buyPrice: null,
      quantity: null,
      saleAfterTax: null,
      tax: null,
      netProfitPerCard: null,
      netProfitTotal: null,
      profitPercent: null
    };
  }

  const quantity =
    Number.isFinite(position.quantity) &&
    position.quantity > 0
      ? position.quantity
      : 1;

  const saleAfterTax = Math.floor(currentPrice * 0.95);
  const tax = currentPrice - saleAfterTax;
  const netProfitPerCard = saleAfterTax - position.buyPrice;
  const netProfitTotal = netProfitPerCard * quantity;
  const profitPercent =
    position.buyPrice > 0
      ? Number(
          (
            (netProfitPerCard / position.buyPrice) *
            100
          ).toFixed(2)
        )
      : null;

  return {
    buyPrice: position.buyPrice,
    quantity,
    saleAfterTax,
    tax,
    netProfitPerCard,
    netProfitTotal,
    profitPercent
  };
}

async function loadRecentDiscordSignals() {
  // Bis zu 30 Stunden laden, damit 24h-/"morgen"-Signale ihren gesamten
  // Lebenszyklus inklusive 24h-Auswertung durchlaufen können. Ob ein Signal
  // den aktuellen Brain noch beeinflussen darf, entscheidet separat der
  // Lifecycle-Filter.
  if (!dbEnabled) return memoryTraderSignals.filter(signal => Date.now() - Number(signal.timestamp || 0) <= 30 * 60 * 60_000);

  const result = await pool.query(`
    SELECT
      id,
      source,
      message,
      player_or_rating,
      call,
      reason,
      expected_timeframe,
      source_reliability,
      category,
      market_confirmed,
      confirmation_details,
      target_ea_id,
      initial_reference_price,
      initial_reference_at,
      ingest_origin,
      source_event_at,
      received_at,
      external_event_id,
      source_channel,
      signal_kind,
      source_channel_weight,
      created_at
    FROM fc_discord_signals
    WHERE created_at >= NOW() - INTERVAL '30 hours'
    ORDER BY created_at DESC
    LIMIT 1000
  `);

  return result.rows.map(row => ({
    id: row.id,
    source: row.source,
    message: row.message,
    playerOrRating: row.player_or_rating,
    call: row.call,
    reason: row.reason || "",
    expectedTimeframe: row.expected_timeframe || "",
    sourceReliability: Number(row.source_reliability || 50),
    category: row.category || "SHORT_TERM_FLIPS",
    marketConfirmed: row.confirmation_details ? row.market_confirmed === true : null,
    confirmationDetails: row.confirmation_details || "",
    eaId: row.target_ea_id == null ? null : String(row.target_ea_id),
    initialReferencePrice: row.initial_reference_price == null ? null : Number(row.initial_reference_price),
    initialReferenceAt: row.initial_reference_at ? new Date(row.initial_reference_at).getTime() : null,
    ingestOrigin: row.ingest_origin || "legacy",
    sourceEventAt: row.source_event_at ? new Date(row.source_event_at).getTime() : new Date(row.created_at).getTime(),
    receivedAt: row.received_at ? new Date(row.received_at).getTime() : new Date(row.created_at).getTime(),
    externalEventId: row.external_event_id || null,
    sourceChannel: row.source_channel || null,
    signalKind: row.signal_kind || (row.call === "BEOBACHTEN" ? "MARKET_EVENT" : "TRADER_CALL"),
    sourceChannelWeight: Number(row.source_channel_weight || 1),
    timestamp: row.source_event_at ? new Date(row.source_event_at).getTime() : new Date(row.created_at).getTime()
  }));
}

async function loadTraderProfiles() {
  if (!dbEnabled) return {};

  const result = await pool.query(`
    SELECT *
    FROM fc_trader_profiles
  `);

  const profiles = {};

  for (const row of result.rows) {
    profiles[String(row.source).toLowerCase()] = {
      source: row.source,
      displayName: row.display_name,
      overallAccuracy: Number(row.overall_accuracy || 50),
      totalSignals: Number(row.total_signals || 0),
      specializationAccuracy: {
        SBC_FODDER: Number(row.accuracy_sbc_fodder || 50),
        PROMO_CARDS: Number(row.accuracy_promo_cards || 50),
        SHORT_TERM_FLIPS: Number(row.accuracy_short_flips || 50),
        LEAKS_CONTENT: Number(row.accuracy_leaks || 50)
      }
    };
  }

  return profiles;
}

function median(values) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2
    ? clean[mid]
    : (clean[mid - 1] + clean[mid]) / 2;
}

function marketContextWindow(rows, field) {
  const moves = rows
    .map(row => Number(row?.[field]))
    .filter(Number.isFinite);

  if (!moves.length) {
    return {
      measuredCards: 0,
      medianMove: 0,
      risingPct: 0,
      fallingPct: 0
    };
  }

  const rising = moves.filter(value => value >= 0.5).length;
  const falling = moves.filter(value => value <= -0.5).length;

  return {
    measuredCards: moves.length,
    medianMove: Number((median(moves) ?? 0).toFixed(2)),
    risingPct: Number(((rising / moves.length) * 100).toFixed(1)),
    fallingPct: Number(((falling / moves.length) * 100).toFixed(1))
  };
}

function buildGlobalMarketContext(rows) {
  const eligible = (rows || []).filter(row =>
    row?.cardType === "Base Rare" &&
    !isLowWatchRating(row?.overall)
  );

  const w5m = marketContextWindow(eligible, "change5m");
  const w15m = marketContextWindow(eligible, "change15m");
  const w1h = marketContextWindow(eligible, "change1h");

  const packSupplyActive = Boolean(
    (w5m.measuredCards >= 25 && w5m.fallingPct >= 65 && w5m.medianMove <= -1.5) ||
    (w15m.measuredCards >= 25 && w15m.fallingPct >= 70 && w15m.medianMove <= -2.5)
  );

  let mood = "neutral";

  if (w5m.measuredCards < 25) {
    mood = "insufficient_data";
  } else if (w5m.fallingPct >= 75 && w5m.medianMove <= -2) {
    mood = "crash";
  } else if (packSupplyActive) {
    mood = "supply_pressure";
  } else if (
    w5m.risingPct >= 55 &&
    w5m.medianMove >= 0.5 &&
    w15m.medianMove <= -0.75
  ) {
    mood = "recovery";
  } else if (w5m.risingPct >= 70 && w5m.medianMove >= 1.5) {
    mood = "rising";
  } else if (w5m.fallingPct >= 60 && w5m.medianMove <= -0.75) {
    mood = "falling";
  } else if (
    Math.abs(w5m.medianMove) < 0.5 &&
    Math.abs(w15m.medianMove) < 1
  ) {
    mood = "flat";
  }

  const breadthStrength = Math.max(
    Math.abs(w5m.risingPct - w5m.fallingPct),
    Math.abs(w15m.risingPct - w15m.fallingPct)
  );

  const confidence = Math.max(
    0,
    Math.min(
      95,
      Math.round(
        Math.min(60, eligible.length / 8) +
        Math.min(35, breadthStrength * 0.45)
      )
    )
  );

  return {
    gameYear: GAME_YEAR,
    mood,
    packSupplyActive,
    packSupplyInference: packSupplyActive
      ? "Breiter Base-Rare-Abverkauf deutet auf erhöhte Pack-/Angebotszufuhr hin."
      : "Kein breites Angebotsdruck-Muster erkannt.",
    source: "market-inference",
    measuredCards: eligible.length,
    confidence,
    windows: {
      m5: w5m,
      m15: w15m,
      h1: w1h
    },
    updatedAt: new Date().toISOString()
  };
}

function reconstructPreviousPrice(currentPrice, changePctValue) {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(changePctValue) ||
    changePctValue <= -99
  ) {
    return null;
  }

  const divisor = 1 + changePctValue / 100;
  if (divisor <= 0) return null;

  return currentPrice / divisor;
}

function ratingWindowStats(cards, changeField) {
  const measured = cards.filter(card => Number.isFinite(card[changeField]));
  const moves = measured.map(card => card[changeField]);
  const rising = moves.filter(v => v >= 0.5).length;
  const falling = moves.filter(v => v <= -0.5).length;

  const previousPrices = measured
    .map(card => reconstructPreviousPrice(card.price, card[changeField]))
    .filter(Number.isFinite);

  return {
    measuredCards: measured.length,
    risingPct: moves.length
      ? Number(((rising / moves.length) * 100).toFixed(1))
      : 0,
    fallingPct: moves.length
      ? Number(((falling / moves.length) * 100).toFixed(1))
      : 0,
    medianMove: Number((median(moves) ?? 0).toFixed(2)),
    previousMedianPrice: median(previousPrices)
  };
}

function buildRatingStats(rows) {
  const byRating = new Map();

  for (const row of rows) {
    // Für Rating-/Fodder-Intelligence bewusst nur Base Rare verwenden.
    // Specials würden die Mediane und Marktbreite stark verzerren.
    if (row.cardType !== "Base Rare") continue;
    if (!byRating.has(row.overall)) byRating.set(row.overall, []);
    byRating.get(row.overall).push(row);
  }

  const stats = {};

  for (const [rating, cards] of byRating.entries()) {
    const currentMedian = median(cards.map(card => card.price));
    const priceProfile = ratingPriceProfile(cards);
    const w1m = ratingWindowStats(cards, "change1m");
    const w5m = ratingWindowStats(cards, "change5m");
    const w15m = ratingWindowStats(cards, "change15m");
    const w1h = ratingWindowStats(cards, "change1h");
    const w24h = ratingWindowStats(cards, "change24h");

    const nearLowCards = cards.filter(card =>
      Number.isFinite(card.distanceFrom24hLow) &&
      card.distanceFrom24hLow <= 5
    );

    const recoveryCards = cards.filter(card =>
      Number.isFinite(card.change5m) &&
      Number.isFinite(card.change15m) &&
      card.change5m >= 1 &&
      card.change15m >= 1
    );

    const nearHighCards = cards.filter(card =>
      Number.isFinite(card.high24h) &&
      card.high24h > 0 &&
      Number.isFinite(card.price) &&
      card.price >= card.high24h * 0.97
    );

    const coolingCards = cards.filter(card =>
      (Number.isFinite(card.change1m) && card.change1m <= 0) ||
      (
        Number.isFinite(card.change5m) &&
        Number.isFinite(card.change15m) &&
        card.change15m >= 3 &&
        card.change5m <= Math.max(0.5, card.change15m - 2)
      )
    );

    const nearLowPct = cards.length
      ? Number(((nearLowCards.length / cards.length) * 100).toFixed(1))
      : 0;

    const recoveryPct = cards.length
      ? Number(((recoveryCards.length / cards.length) * 100).toFixed(1))
      : 0;

    const nearHighPct = cards.length
      ? Number(((nearHighCards.length / cards.length) * 100).toFixed(1))
      : 0;

    const coolingPct = cards.length
      ? Number(((coolingCards.length / cards.length) * 100).toFixed(1))
      : 0;

    let trend = "neutral";
    if (w5m.risingPct >= 70 && w5m.medianMove >= 1) trend = "stark_steigend";
    else if (w5m.risingPct >= 55 || w5m.medianMove >= 0.6) trend = "steigend";
    else if (w5m.fallingPct >= 70 && w5m.medianMove <= -1) trend = "stark_fallend";
    else if (w5m.fallingPct >= 55 || w5m.medianMove <= -0.6) trend = "fallend";

    let marketSignal = "NEUTRAL";
    let marketAdvice = "BEOBACHTEN";
    let confidence = 58;
    let reason = "Kein klares Rating-Markt-Setup.";

    const enoughData = w5m.measuredCards >= 5;

    if (!enoughData) {
      marketSignal = "ZU WENIG DATEN";
      marketAdvice = "BEOBACHTEN";
      confidence = 35;
      reason = "Noch zu wenige Karten mit 5-Minuten-Historie für ein belastbares Rating-Signal.";
    } else if (
      w5m.fallingPct >= 70 &&
      w5m.medianMove <= -2
    ) {
      marketSignal = "STARK FALLEND";
      marketAdvice = "NOCH WARTEN";
      confidence = Math.min(
        95,
        Math.round(78 + Math.min(12, Math.abs(w5m.medianMove) * 2))
      );
      reason =
        `${w5m.fallingPct.toFixed(0)}% der ${rating}er fallen in 5m; ` +
        `Median-Bewegung ${w5m.medianMove.toFixed(2)}%. Breiter Abverkauf noch aktiv.`;
    } else if (
      nearHighPct >= 40 &&
      w15m.medianMove >= 3 &&
      (
        w1m.medianMove <= 0 ||
        w5m.medianMove <= 0.5 ||
        coolingPct >= 45
      )
    ) {
      marketSignal = "VERKAUFSZONE";
      marketAdvice = "JETZT VERKAUFEN";
      confidence = Math.min(
        95,
        Math.round(78 + Math.min(10, nearHighPct / 8) + Math.min(7, Math.max(0, w15m.medianMove) / 2))
      );
      reason =
        `${nearHighPct.toFixed(0)}% der ${rating}er liegen nahe ihrem 24h-Hoch; ` +
        `${coolingPct.toFixed(0)}% zeigen abkühlendes Momentum. 15m-Median ${w15m.medianMove >= 0 ? "+" : ""}${w15m.medianMove.toFixed(2)}%. Gewinnmitnahme im Rating-Segment sinnvoll.`;
    } else if (
      nearLowPct >= 50 &&
      recoveryPct >= 45 &&
      w5m.risingPct >= 50 &&
      w5m.fallingPct < 40 &&
      w15m.medianMove >= 0.8 &&
      w15m.medianMove <= 10
    ) {
      marketSignal = "KAUFZONE";
      marketAdvice = "JETZT KAUFEN";
      confidence = Math.min(
        95,
        Math.round(76 + Math.min(15, recoveryPct / 5))
      );
      reason =
        `${nearLowPct.toFixed(0)}% der ${rating}er liegen nahe ihrem 24h-Tief und ` +
        `${recoveryPct.toFixed(0)}% bestätigen 5m/15m-Erholung. Rating-Segment dreht.`;
    } else if (
      w5m.risingPct >= 70 &&
      w5m.medianMove >= 2
    ) {
      marketSignal = "STARK STEIGEND";

      if (w15m.medianMove >= 10 && nearHighPct >= 40) {
        marketSignal = "VERKAUFSZONE";
        marketAdvice = "JETZT VERKAUFEN";
        confidence = Math.min(
          95,
          Math.round(84 + Math.min(8, w5m.medianMove))
        );
        reason =
          `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen und ${nearHighPct.toFixed(0)}% liegen nahe dem 24h-Hoch; ` +
          `15m-Median bereits +${w15m.medianMove.toFixed(2)}%. Rating-Segment ist stark ausgedehnt: Gewinnmitnahme bevorzugt.`;
      } else if (w15m.medianMove >= 10) {
        marketAdvice = "NICHT HINTERHERKAUFEN";
        confidence = Math.min(
          95,
          Math.round(82 + Math.min(10, w5m.medianMove))
        );
        reason =
          `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
          `15m-Median bereits +${w15m.medianMove.toFixed(2)}%. FOMO-Risiko erhöht.`;
      } else {
        marketAdvice = "BEOBACHTEN";
        confidence = Math.min(
          95,
          Math.round(76 + Math.min(12, w5m.medianMove * 2))
        );
        reason =
          `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
          `5m-Median +${w5m.medianMove.toFixed(2)}%. Breite Aufwärtsbewegung bestätigt.`;
      }
    } else if (
      w5m.risingPct >= 60 ||
      w5m.medianMove >= 1
    ) {
      marketSignal = "STEIGEND";
      marketAdvice = "BEOBACHTEN";
      confidence = 68;
      reason =
        `${w5m.risingPct.toFixed(0)}% der ${rating}er steigen; ` +
        `5m-Median ${w5m.medianMove >= 0 ? "+" : ""}${w5m.medianMove.toFixed(2)}%.`;
    } else if (
      w5m.fallingPct >= 60 ||
      w5m.medianMove <= -1
    ) {
      marketSignal = "FÄLLT";
      marketAdvice = "NOCH WARTEN";
      confidence = 72;
      reason =
        `${w5m.fallingPct.toFixed(0)}% der ${rating}er fallen; ` +
        `5m-Median ${w5m.medianMove.toFixed(2)}%. Noch keine breite Trendwende.`;
    }

    stats[rating] = {
      rating,
      cardCount: cards.length,
      measuredCards: w5m.measuredCards,
      medianPrice: currentMedian,
      ratingReferencePrice: priceProfile.referencePrice,
      dominantRatingPrice: priceProfile.dominantPrice,
      dominantPriceSharePct: priceProfile.dominantSharePct,
      priceExceptionCount: priceProfile.exceptionCount,
      namedPriceExceptions: priceProfile.namedExceptions,
      medianPrice1mAgo: w1m.previousMedianPrice,
      medianPrice5mAgo: w5m.previousMedianPrice,
      medianPrice15mAgo: w15m.previousMedianPrice,
      medianPrice1hAgo: w1h.previousMedianPrice,
      medianPrice24hAgo: w24h.previousMedianPrice,

      risingPct: w5m.risingPct,
      fallingPct: w5m.fallingPct,
      medianMove5m: w5m.medianMove,
      trend,

      change1m: w1m.medianMove,
      change5m: w5m.medianMove,
      change15m: w15m.medianMove,
      change1h: w1h.medianMove,
      change24h: w24h.medianMove,

      risingPct1m: w1m.risingPct,
      fallingPct1m: w1m.fallingPct,
      risingPct5m: w5m.risingPct,
      fallingPct5m: w5m.fallingPct,
      risingPct15m: w15m.risingPct,
      fallingPct15m: w15m.fallingPct,

      near24hLowPct: nearLowPct,
      near24hHighPct: nearHighPct,
      recoveryPct,
      coolingPct,
      marketSignal,
      marketAdvice,
      confidence,
      reason,
      marketTier: isLowWatchRating(rating) ? "LOW_WATCH" : "MAIN",
      unusualMovePct: Math.max(
        Math.abs(Number(w5m.medianMove || 0)),
        Math.abs(Number(w15m.medianMove || 0)),
        Math.abs(Number(w1h.medianMove || 0))
      ),
      unusualMoveSignedPct: [w5m.medianMove, w15m.medianMove, w1h.medianMove]
        .map(value => Number(value || 0))
        .reduce((strongest, value) =>
          Math.abs(value) > Math.abs(strongest) ? value : strongest
        , Number(w5m.medianMove || 0)),
      lowWatchAlertEligible: isLowWatchRating(rating)
        ? Math.max(
            Math.abs(Number(w5m.medianMove || 0)),
            Math.abs(Number(w15m.medianMove || 0)),
            Math.abs(Number(w1h.medianMove || 0))
          ) >= LOW_RATING_ALERT_MOVE_PCT
        : null
    };
  }

  return stats;
}

function matchingSignalsForRow(row, allSignals) {
  const ratingText = String(row.overall);
  const name = String(row.name || "").toLowerCase();
  const eaId = String(row.eaId);

  return allSignals.filter(signal => {
    const target = String(signal.playerOrRating || "").toLowerCase().trim();
    return (
      target === eaId ||
      target === ratingText ||
      target === `${ratingText}er` ||
      (target.length >= 4 && name.includes(target)) ||
      (name.length >= 4 && target.includes(name))
    );
  });
}

async function persistDiscordSignalMarketConfirmations(rows, brainWork) {
  if (!dbEnabled || !rows?.length || !brainWork?.size) return;

  const grouped = new Map();

  for (const row of rows) {
    const work = brainWork.get(String(row.eaId));
    const processedSignals = work?.confluence?.processedSignals || [];

    if (!processedSignals.length) continue;

    const hasMarketHistory = [
      row.change1m,
      row.change5m,
      row.change15m,
      row.change1h
    ].some(Number.isFinite);

    // Noch keine echte Historie vorhanden: Signal nicht voreilig als falsch speichern.
    if (!hasMarketHistory) continue;

    for (const signal of processedSignals) {
      if (!signal?.id) continue;

      const target = String(signal.playerOrRating || "").trim();
      const rating = /^\d{2}$/.test(target) ? Number(target) : null;
      const isRatingSignal = Number.isFinite(rating) && rating >= 75 && rating <= 99;

      // Rating-Signale wie "89er Fodder" nur mit Base-Rare-Karten
      // desselben Ratings prüfen. Specials und Commons verfälschen sonst den Fodder-Markt.
      if (isRatingSignal) {
        if (row.cardType !== "Base Rare" || row.overall !== rating) continue;
      }

      let group = grouped.get(signal.id);
      if (!group) {
        group = {
          id: signal.id,
          target,
          rating,
          isRatingSignal,
          checked: 0,
          confirmed: 0,
          details: new Set()
        };
        grouped.set(signal.id, group);
      }

      group.checked += 1;
      if (signal.marketConfirmation === true) group.confirmed += 1;
      if (signal.confirmationDetails) {
        group.details.add(String(signal.confirmationDetails));
      }
    }
  }

  for (const group of grouped.values()) {
    if (!group.checked) continue;

    const confirmationRatio = group.confirmed / group.checked;
    const marketConfirmed = confirmationRatio >= 0.5;
    const percent = Math.round(confirmationRatio * 100);

    const prefix = group.isRatingSignal
      ? `FUT.GG Rating-Check ${group.rating}er Base Rare`
      : `FUT.GG Spieler-Check ${group.target}`;

    const extraDetails = Array.from(group.details).slice(0, 3).join(" | ");
    const confirmationDetails = (
      `${prefix}: ${group.confirmed}/${group.checked} Marktprüfungen ` +
      `bestätigen das Trader-Signal (${percent}%).` +
      (extraDetails ? ` ${extraDetails}` : "")
    ).slice(0, 2000);

    await pool.query(
      `
        UPDATE fc_discord_signals
        SET
          market_confirmed = $2,
          confirmation_details = $3
        WHERE id = $1
          AND (
            market_confirmed IS DISTINCT FROM $2
            OR confirmation_details IS DISTINCT FROM $3
          )
      `,
      [group.id, marketConfirmed, confirmationDetails]
    );
  }
}

const TRADER_RELIABILITY_HORIZONS = [5, 15, 60, 360, 1440];
const TRADER_RELIABILITY_PRIOR_ACCURACY = 50;
const TRADER_RELIABILITY_PRIOR_STRENGTH = 8;
const TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH = 5;

function nearestTraderReliabilityHorizon(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;

  return TRADER_RELIABILITY_HORIZONS.reduce((best, candidate) => {
    const bestDistance = Math.abs(Math.log(best / minutes));
    const candidateDistance = Math.abs(Math.log(candidate / minutes));
    return candidateDistance < bestDistance ? candidate : best;
  }, TRADER_RELIABILITY_HORIZONS[0]);
}

function preferredTraderSignalHorizon(signal) {
  const timeframe = String(signal?.expectedTimeframe || "").toLowerCase().trim();

  if (/(morgen|tomorrow)/.test(timeframe)) return 1440;
  if (/(heute abend|tonight)/.test(timeframe)) return 360;
  if (/\b(heute|today)\b/.test(timeframe)) return 360;

  const minuteMatch = timeframe.match(/\b(\d{1,4})\s*(?:m|min|mins|minute|minutes)\b/i);
  if (minuteMatch) {
    return nearestTraderReliabilityHorizon(Number(minuteMatch[1]));
  }

  const hourMatch = timeframe.match(/\b(\d{1,3})\s*(?:h|hr|hrs|hour|hours|stunde|stunden)\b/i);
  if (hourMatch) {
    return nearestTraderReliabilityHorizon(Number(hourMatch[1]) * 60);
  }

  switch (String(signal?.category || "").toUpperCase()) {
    case "SBC_FODDER":
      return 360;
    case "PROMO_CARDS":
      return 360;
    case "LEAKS_CONTENT":
      return 1440;
    case "SHORT_TERM_FLIPS":
    default:
      return 60;
  }
}

function traderReliabilityOutcomeWeight(signal, horizonMinutes) {
  const preferred = preferredTraderSignalHorizon(signal);
  const preferredIndex = TRADER_RELIABILITY_HORIZONS.indexOf(preferred);
  const horizonIndex = TRADER_RELIABILITY_HORIZONS.indexOf(Number(horizonMinutes));

  if (preferredIndex < 0 || horizonIndex < 0) return 0.25;

  const distance = Math.abs(preferredIndex - horizonIndex);

  if (distance === 0) return 1.0;
  if (distance === 1) return 0.6;
  if (distance === 2) return 0.3;
  return 0.1;
}

function smoothedTraderAccuracy(outcomes, priorStrength) {
  const clean = (outcomes || []).filter(item =>
    Number.isFinite(item.weight) &&
    item.weight > 0 &&
    typeof item.wasCorrect === "boolean"
  );

  const totalWeight = clean.reduce((sum, item) => sum + item.weight, 0);
  const weightedCorrect = clean.reduce(
    (sum, item) => sum + (item.wasCorrect ? item.weight : 0),
    0
  );

  const score =
    (
      TRADER_RELIABILITY_PRIOR_ACCURACY * priorStrength +
      weightedCorrect * 100
    ) /
    (priorStrength + totalWeight);

  return Number(score.toFixed(2));
}

async function loadTraderSignalsForReliability() {
  if (!dbEnabled) return [];

  const result = await pool.query(`
    SELECT
      id,
      source,
      player_or_rating,
      target_ea_id,
      call,
      category,
      signal_kind,
      source_channel_weight,
      initial_reference_price,
      initial_reference_at,
      source_event_at,
      created_at
    FROM fc_discord_signals
    WHERE created_at >= NOW() - INTERVAL '30 hours'
    ORDER BY created_at ASC
  `);

  return result.rows.map(row => ({
    id: row.id,
    source: row.source,
    playerOrRating: row.player_or_rating,
    eaId: row.target_ea_id == null ? null : String(row.target_ea_id),
    call: row.call,
    category: row.category || "SHORT_TERM_FLIPS",
    signalKind: row.signal_kind || (row.call === "BEOBACHTEN" ? "MARKET_EVENT" : "TRADER_CALL"),
    sourceChannelWeight: Number(row.source_channel_weight || 1),
    initialReferencePrice: row.initial_reference_price == null ? null : Number(row.initial_reference_price),
    initialReferenceAt: row.initial_reference_at ? new Date(row.initial_reference_at).getTime() : null,
    createdAt: row.source_event_at ? new Date(row.source_event_at).getTime() : new Date(row.created_at).getTime()
  }));
}

function traderSignalEaIds(signal, rows) {
  const target = String(signal?.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;

  if (Number.isFinite(rating) && rating >= 75 && rating <= 99) {
    return rows
      .filter(row => row.overall === rating && row.cardType === "Base Rare" && Number.isFinite(row.eaId))
      .map(row => String(row.eaId));
  }

  if (signal?.eaId) return [String(signal.eaId)];

  const lower = target.toLowerCase();
  return rows
    .filter(row => String(row.name || "").toLowerCase() === lower && Number.isFinite(row.eaId))
    .map(row => String(row.eaId));
}

async function traderSignalReferencePriceAt(signal, rows, atMs) {
  const ids = [...new Set(traderSignalEaIds(signal, rows))];
  if (!ids.length) return null;

  const historical = await lookupDb(ids, atMs);
  const prices = ids
    .map(id => historical.get(String(id)))
    .filter(Number.isFinite);

  if (prices.length) return median(prices);

  // Für sehr neue Signale darf der aktuelle Preis als Fallback dienen.
  if (Math.abs(Date.now() - atMs) <= 2 * 60_000) {
    const currentById = new Map(rows.map(row => [String(row.eaId), row.price]));
    const currentPrices = ids.map(id => currentById.get(String(id))).filter(Number.isFinite);
    if (currentPrices.length) return median(currentPrices);
  }

  return null;
}

async function ensureFrozenTraderSignalReference(signal, rows) {
  if (!dbEnabled || !signal?.id) return null;

  if (Number.isFinite(signal.initialReferencePrice) && signal.initialReferencePrice > 0) {
    return Math.round(signal.initialReferencePrice);
  }

  // Migration für Signale, die vor dem eingefrorenen Einstiegspreis angelegt wurden:
  // Falls bereits ein Outcome existiert, nehmen wir dessen allerersten Einstiegspreis.
  // Dadurch bleiben 5m, 15m, 1h, 6h und 24h garantiert auf derselben Basis.
  const previousOutcome = await pool.query(`
    SELECT initial_price
    FROM fc_trader_signal_outcomes
    WHERE signal_id = $1
    ORDER BY horizon_minutes ASC, evaluated_at ASC
    LIMIT 1
  `, [signal.id]);

  let frozenPrice = previousOutcome.rowCount
    ? Number(previousOutcome.rows[0].initial_price)
    : null;

  if (!Number.isFinite(frozenPrice) || frozenPrice <= 0) {
    frozenPrice = await traderSignalReferencePriceAt(signal, rows, signal.createdAt);
  }

  if (!Number.isFinite(frozenPrice) || frozenPrice <= 0) return null;

  frozenPrice = Math.round(frozenPrice);
  const frozenAt = new Date(signal.createdAt).toISOString();

  await pool.query(`
    UPDATE fc_discord_signals
    SET
      initial_reference_price = COALESCE(initial_reference_price, $2),
      initial_reference_at = COALESCE(initial_reference_at, $3)
    WHERE id = $1
  `, [signal.id, frozenPrice, frozenAt]);

  signal.initialReferencePrice = frozenPrice;
  signal.initialReferenceAt = signal.createdAt;
  return frozenPrice;
}

async function normalizeTraderSignalOutcomesToFrozenReference(signal, frozenPrice) {
  if (!dbEnabled || !signal?.id || !Number.isFinite(frozenPrice) || frozenPrice <= 0) return 0;

  const result = await pool.query(`
    SELECT horizon_minutes, observed_price, initial_price
    FROM fc_trader_signal_outcomes
    WHERE signal_id = $1
  `, [signal.id]);

  let corrected = 0;

  for (const row of result.rows) {
    const observedPrice = Number(row.observed_price);
    if (!Number.isFinite(observedPrice) || observedPrice <= 0) continue;

    const evaluation = evaluateTraderCall(signal.call, frozenPrice, observedPrice);
    const oldInitial = Number(row.initial_price);

    // Auch bestehende v10.6/v10.6.1-Outcomes werden auf denselben Einstiegspreis
    // zurückgerechnet, damit die Lernhistorie nicht mit wechselnden Basen arbeitet.
    const update = await pool.query(`
      UPDATE fc_trader_signal_outcomes
      SET
        initial_price = $3,
        gross_change_pct = $4,
        net_roi_after_tax_pct = $5,
        was_correct = $6,
        evaluation_reason = $7
      WHERE signal_id = $1
        AND horizon_minutes = $2
        AND (
          initial_price IS DISTINCT FROM $3
          OR gross_change_pct IS DISTINCT FROM $4
          OR net_roi_after_tax_pct IS DISTINCT FROM $5
          OR was_correct IS DISTINCT FROM $6
          OR evaluation_reason IS DISTINCT FROM $7
        )
    `, [
      signal.id,
      Number(row.horizon_minutes),
      frozenPrice,
      Number(evaluation.grossChangePct.toFixed(4)),
      Number(evaluation.netRoiAfterTaxPct.toFixed(4)),
      evaluation.wasCorrect,
      evaluation.reason
    ]);

    if (update.rowCount && oldInitial !== frozenPrice) corrected += 1;
  }

  return corrected;
}

function evaluateTraderCall(call, initialPrice, observedPrice) {
  const grossChangePct = ((observedPrice - initialPrice) / initialPrice) * 100;
  const netRoiAfterTaxPct = (((observedPrice * 0.95) - initialPrice) / initialPrice) * 100;
  const normalizedCall = String(call || "").toUpperCase();

  if (normalizedCall === "KAUFEN") {
    const wasCorrect = netRoiAfterTaxPct > 0;
    return {
      wasCorrect,
      grossChangePct,
      netRoiAfterTaxPct,
      reason: wasCorrect
        ? `KAUFEN war nach 5% EA-Steuer profitabel (${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI).`
        : `KAUFEN war nach 5% EA-Steuer noch nicht profitabel (${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI).`
    };
  }

  if (normalizedCall === "VERKAUFEN") {
    const wasCorrect = observedPrice < initialPrice;
    return {
      wasCorrect,
      grossChangePct,
      netRoiAfterTaxPct,
      reason: wasCorrect
        ? `VERKAUFEN war richtig: der Referenzpreis fiel danach um ${Math.abs(grossChangePct).toFixed(2)}%.`
        : `VERKAUFEN war zu früh: der Referenzpreis stieg danach um ${Math.max(0, grossChangePct).toFixed(2)}%.`
    };
  }

  // WARTEN wird daran gemessen, ob ein sofortiger Kauf bis zum Prüfzeitpunkt
  // nach EA-Steuer keinen positiven Netto-ROI gebracht hätte.
  const wasCorrect = netRoiAfterTaxPct <= 0;
  return {
    wasCorrect,
    grossChangePct,
    netRoiAfterTaxPct,
    reason: wasCorrect
      ? `WARTEN war sinnvoll: ein Sofortkauf wäre nach Steuer bei ${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI.`
      : `WARTEN verpasste einen profitablen Move von ${netRoiAfterTaxPct.toFixed(2)}% Netto-ROI nach Steuer.`
  };
}

async function refreshTraderReliabilityProfiles() {
  if (!dbEnabled) return;

  const result = await pool.query(`
    SELECT
      s.source,
      s.category,
      s.expected_timeframe,
      s.source_channel_weight,
      o.horizon_minutes,
      o.was_correct
    FROM fc_trader_signal_outcomes o
    JOIN fc_discord_signals s ON s.id = o.signal_id
    ORDER BY s.source, o.evaluated_at ASC
  `);

  const bySource = new Map();

  for (const row of result.rows) {
    const source = String(row.source || "");
    if (!source) continue;

    if (!bySource.has(source)) {
      bySource.set(source, []);
    }

    const signalLike = {
      category: row.category || "SHORT_TERM_FLIPS",
      expectedTimeframe: row.expected_timeframe || ""
    };

    bySource.get(source).push({
      category: signalLike.category,
      horizonMinutes: Number(row.horizon_minutes),
      wasCorrect: row.was_correct === true,
      weight: traderReliabilityOutcomeWeight(signalLike, Number(row.horizon_minutes)) * Math.max(0.1, Math.min(1, Number(row.source_channel_weight || 1)))
    });
  }

  for (const [source, outcomes] of bySource.entries()) {
    const overallAccuracy = smoothedTraderAccuracy(
      outcomes,
      TRADER_RELIABILITY_PRIOR_STRENGTH
    );

    const categoryAccuracy = category => {
      const selected = outcomes.filter(item => item.category === category);
      if (!selected.length) return null;
      return smoothedTraderAccuracy(
        selected,
        TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH
      );
    };

    const evaluatedOutcomes = outcomes.length;
    const effectiveWeight = outcomes.reduce((sum, item) => sum + item.weight, 0);

    let badge = "Unbewiesen";
    if (effectiveWeight >= 15 && overallAccuracy >= 80) badge = "Sehr stark";
    else if (effectiveWeight >= 8 && overallAccuracy >= 70) badge = "Stark";
    else if (effectiveWeight >= 8 && overallAccuracy < 40) badge = "Schwach";
    else if (effectiveWeight >= 8) badge = "Beobachten";

    await pool.query(`
      UPDATE fc_trader_profiles
      SET
        overall_accuracy = $2,
        accuracy_sbc_fodder = COALESCE($3, accuracy_sbc_fodder),
        accuracy_promo_cards = COALESCE($4, accuracy_promo_cards),
        accuracy_short_flips = COALESCE($5, accuracy_short_flips),
        accuracy_leaks = COALESCE($6, accuracy_leaks),
        reputation_badge = $7,
        notes = $8,
        updated_at = NOW()
      WHERE source = $1
    `, [
      source,
      overallAccuracy,
      categoryAccuracy("SBC_FODDER"),
      categoryAccuracy("PROMO_CARDS"),
      categoryAccuracy("SHORT_TERM_FLIPS"),
      categoryAccuracy("LEAKS_CONTENT"),
      badge,
      `v10.6.2 gewichtete Reliability: ${evaluatedOutcomes} Outcomes, effektives Gewicht ${effectiveWeight.toFixed(2)}, Bayes-Startbasis 50%.`
    ]);
  }
}

async function evaluateTraderSignalReliability(rows) {
  if (!dbEnabled || !rows?.length) return 0;

  const signals = await loadTraderSignalsForReliability();
  if (!signals.length) return 0;

  const existingResult = await pool.query(`
    SELECT signal_id, horizon_minutes
    FROM fc_trader_signal_outcomes
    WHERE signal_id = ANY($1::varchar[])
  `, [signals.map(signal => signal.id)]);

  const existing = new Set(
    existingResult.rows.map(row => `${row.signal_id}:${Number(row.horizon_minutes)}`)
  );

  let inserted = 0;
  const now = Date.now();

  for (const signal of signals) {
    if (signal.signalKind === "MARKET_EVENT" || String(signal.call || "").toUpperCase() === "BEOBACHTEN") continue;
    const initialPrice = await ensureFrozenTraderSignalReference(signal, rows);
    if (!Number.isFinite(initialPrice) || initialPrice <= 0) continue;

    await normalizeTraderSignalOutcomesToFrozenReference(signal, initialPrice);

    for (const horizonMinutes of TRADER_RELIABILITY_HORIZONS) {
      const key = `${signal.id}:${horizonMinutes}`;
      if (existing.has(key)) continue;

      const targetAt = signal.createdAt + horizonMinutes * 60_000;
      if (now < targetAt) continue;

      const observedPrice = await traderSignalReferencePriceAt(signal, rows, targetAt);
      if (!Number.isFinite(observedPrice) || observedPrice <= 0) continue;

      const evaluation = evaluateTraderCall(signal.call, initialPrice, observedPrice);

      const result = await pool.query(`
        INSERT INTO fc_trader_signal_outcomes (
          signal_id,
          horizon_minutes,
          initial_price,
          observed_price,
          gross_change_pct,
          net_roi_after_tax_pct,
          was_correct,
          evaluation_reason,
          evaluated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
        ON CONFLICT (signal_id, horizon_minutes) DO NOTHING
      `, [
        signal.id,
        horizonMinutes,
        Math.round(initialPrice),
        Math.round(observedPrice),
        Number(evaluation.grossChangePct.toFixed(4)),
        Number(evaluation.netRoiAfterTaxPct.toFixed(4)),
        evaluation.wasCorrect,
        evaluation.reason
      ]);

      if (result.rowCount) {
        inserted += 1;
        existing.add(key);
      }
    }
  }

  // v10.6.2: Profile in jedem Zyklus neu berechnen.
  // Dadurch werden auch bereits vorhandene v10.6-Outcomes sofort
  // mit Zeitfenster-Gewichtung und 50%-Startbasis korrigiert.
  await refreshTraderReliabilityProfiles();
  return inserted;
}

async function loadTraderMarketEventsForImpact() {
  if (!dbEnabled) return [];
  const result = await pool.query(`
    SELECT id, source, source_channel, category, message, player_or_rating, source_event_at, created_at
    FROM fc_discord_signals
    WHERE (signal_kind = 'MARKET_EVENT' OR call = 'BEOBACHTEN')
      AND COALESCE(source_event_at, created_at) >= NOW() - INTERVAL '30 hours'
    ORDER BY COALESCE(source_event_at, created_at) ASC
    LIMIT 200
  `);
  return result.rows.map(row => ({ id: row.id, source: row.source, sourceChannel: row.source_channel || null, category: row.category || "LEAKS_CONTENT", message: row.message || "", target: row.player_or_rating || "MARKT", createdAt: row.source_event_at ? new Date(row.source_event_at).getTime() : new Date(row.created_at).getTime() }));
}

async function ratingMedianSnapshotAt(rows, atMs) {
  if (!dbEnabled || !rows?.length) return {};
  const baseRare = rows.filter(row => row.cardType === "Base Rare" && Number.isFinite(Number(row.eaId)) && Number(row.overall) >= RATING_MIN && Number(row.overall) <= RATING_MAX);
  if (!baseRare.length) return {};
  const ids = [...new Set(baseRare.map(row => String(row.eaId)))];
  const prices = await lookupDb(ids, atMs);
  const grouped = new Map();
  for (const row of baseRare) {
    const price = prices.get(String(row.eaId));
    if (!Number.isFinite(price) || price <= 0) continue;
    const rating = Number(row.overall);
    if (!grouped.has(rating)) grouped.set(rating, []);
    grouped.get(rating).push(price);
  }
  const snapshot = {};
  for (const [rating, values] of grouped.entries()) if (values.length >= 3) snapshot[rating] = median(values);
  return snapshot;
}

function compareRatingSnapshots(before, after) {
  const moves = [];
  for (let rating = RATING_MIN; rating <= RATING_MAX; rating++) {
    const a = Number(before?.[rating]); const b = Number(after?.[rating]);
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) continue;
    moves.push({ rating, before: Math.round(a), after: Math.round(b), changePct: Number((((b - a) / a) * 100).toFixed(4)) });
  }
  const marketMedianChangePct = median(moves.map(item => item.changePct));
  const strongest = [...moves].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0] || null;
  const affectedRatings = [...moves].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, 8);
  let direction = "FLAT";
  if (Number.isFinite(marketMedianChangePct) && marketMedianChangePct >= 1) direction = "RISING";
  else if (Number.isFinite(marketMedianChangePct) && marketMedianChangePct <= -1) direction = "FALLING";
  else if (affectedRatings.some(item => Math.abs(item.changePct) >= 3)) direction = "MIXED";
  return { marketMedianChangePct, strongest, affectedRatings, direction };
}

async function evaluateTraderMarketImpact(rows) {
  if (!dbEnabled || !rows?.length) return 0;
  const events = await loadTraderMarketEventsForImpact();
  if (!events.length) return 0;
  const existingResult = await pool.query(`SELECT signal_id, horizon_minutes FROM fc_trader_market_impacts WHERE signal_id = ANY($1::varchar[])`, [events.map(event => event.id)]);
  const existing = new Set(existingResult.rows.map(row => `${row.signal_id}:${Number(row.horizon_minutes)}`));
  let inserted = 0; const now = Date.now(); const snapshotCache = new Map();
  const getSnapshot = async atMs => { const key = String(Math.floor(atMs / 60_000)); if (!snapshotCache.has(key)) snapshotCache.set(key, await ratingMedianSnapshotAt(rows, atMs)); return snapshotCache.get(key); };
  for (const event of events) {
    let baseline = null;
    for (const horizonMinutes of TRADER_MARKET_IMPACT_HORIZONS) {
      const key = `${event.id}:${horizonMinutes}`; if (existing.has(key)) continue;
      const targetAt = event.createdAt + horizonMinutes * 60_000; if (now < targetAt) continue;
      if (!baseline) baseline = await getSnapshot(event.createdAt);
      const observed = await getSnapshot(targetAt); const comparison = compareRatingSnapshots(baseline, observed);
      if (!Number.isFinite(comparison.marketMedianChangePct) || !comparison.affectedRatings.length) continue;
      const result = await pool.query(`
        INSERT INTO fc_trader_market_impacts (signal_id, horizon_minutes, market_median_change_pct, strongest_rating, strongest_rating_change_pct, affected_ratings, direction, evaluated_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NOW()) ON CONFLICT (signal_id, horizon_minutes) DO NOTHING
      `, [event.id, horizonMinutes, Number(comparison.marketMedianChangePct.toFixed(4)), comparison.strongest?.rating ?? null, Number.isFinite(comparison.strongest?.changePct) ? Number(comparison.strongest.changePct.toFixed(4)) : null, JSON.stringify(comparison.affectedRatings), comparison.direction]);
      if (result.rowCount) { inserted += 1; existing.add(key); }
    }
  }
  return inserted;
}


function curatedTraderChannelMeta(sourceName, channelName) {
  const source = curatedTraderSourceFor(sourceName);
  if (!source || !channelName) return null;
  const wanted = String(channelName).toLowerCase().replace(/^#/, "");
  const channel = (source.channels || []).find(item => String(item.name || "").toLowerCase() === wanted);
  if (!channel) return null;
  return {
    source: source.displayName,
    channel: channel.name,
    type: channel.type || "UNKNOWN",
    category: channel.category || null,
    weight: Number.isFinite(Number(channel.weight)) ? Number(channel.weight) : 1
  };
}

function marketKnowledgeRulesForSignal(signal) {
  const text = `${signal?.message || ""} ${signal?.reason || ""}`.toLowerCase();
  const channel = curatedTraderChannelMeta(signal?.source, signal?.sourceChannel);
  const type = String(channel?.type || signal?.sourceChannelType || "").toUpperCase();
  const category = String(channel?.category || signal?.category || "").toUpperCase();
  const ids = new Set();

  const isExpiry = type === "EXPIRY" || /\b(expir(?:e|es|y|ing)|ablauf|läuft aus|laeuft aus|endet)\b/i.test(text);
  const isSbc = type === "SBC_CONTENT" || category === "SBC_FODDER" || /\bsbc\b|fodder|squad building|marquee matchup/i.test(text);
  const isSupply = type === "SUPPLY" || /\b(pack|packs|rewards?|supply|angebot|pack weight|store pack)\b/i.test(text);
  const isLeak = ["LEAK", "NEWS_LEAK"].includes(type) || /\b(leak|leaked|geleakt|content leak)\b/i.test(text);
  const isPromo = category === "PROMO_CARDS" || /\b(promo|toty|tots|futties|rttf|future stars|trailblazer|totw)\b/i.test(text);
  const isOutOfPacks = /out[ -]?of[ -]?packs|leaves? packs|verlässt? packs|verlaesst? packs|nicht mehr in packs/i.test(text);
  const isPanic = /panic|crash|sell[ -]?off|abverkauf|falling knife|preissturz/i.test(text);
  const isComplementary = /chemistry|links?|linkt|nation link|league link|club link|ersatzkarte|substitut/i.test(text);

  if (isExpiry) ids.add("fodder_expiry_cooldown");
  else if (isSbc) ids.add("sbc_fodder_demand");
  if (isSupply) ids.add("pack_supply_pressure");
  if (isOutOfPacks) ids.add("out_of_packs_scarcity");
  if (isLeak) {
    ids.add("leak_market_reaction");
    ids.add("leak_never_buys_alone");
  }
  if (isPromo || isSupply) ids.add("promo_price_discovery");
  if (isPanic) ids.add("panic_sell_requires_bottom");
  if (isComplementary) ids.add("complementary_goods");

  return MARKET_KNOWLEDGE_RULES.filter(rule => ids.has(rule.id));
}

async function loadMarketKnowledgeSignals() {
  if (!dbEnabled) return [];
  const result = await pool.query(`
    SELECT id, source, source_channel, signal_kind, category, message, reason,
           player_or_rating, target_ea_id, source_event_at, created_at
    FROM fc_discord_signals
    WHERE COALESCE(source_event_at, created_at) >= NOW() - INTERVAL '30 hours'
    ORDER BY COALESCE(source_event_at, created_at) ASC
    LIMIT 300
  `);
  return result.rows.map(row => ({
    id: row.id,
    source: row.source,
    sourceChannel: row.source_channel || null,
    signalKind: row.signal_kind || null,
    category: row.category || "SHORT_TERM_FLIPS",
    message: row.message || "",
    reason: row.reason || "",
    playerOrRating: row.player_or_rating || "MARKT",
    eaId: row.target_ea_id == null ? null : String(row.target_ea_id),
    createdAt: row.source_event_at ? new Date(row.source_event_at).getTime() : new Date(row.created_at).getTime()
  }));
}

function marketKnowledgeRuleById(ruleId) {
  return MARKET_KNOWLEDGE_RULES.find(rule => rule.id === ruleId) || null;
}

function marketKnowledgeTargetRatings(signal, rule, before, after) {
  const target = String(signal?.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;
  if (Number.isFinite(rating) && rating >= RATING_MIN && rating <= RATING_MAX) return [rating];
  if (rule.scope === "FODDER") return FODDER_KNOWLEDGE_RATINGS.filter(value => Number.isFinite(Number(before?.[value])) && Number.isFinite(Number(after?.[value])));
  return Object.keys(before || {})
    .map(Number)
    .filter(value => Number.isFinite(value) && Number.isFinite(Number(after?.[value])));
}

function marketKnowledgeSupport(rule, observedChangePct) {
  if (!Number.isFinite(Number(observedChangePct))) return null;
  const move = Number(observedChangePct);
  const threshold = Math.max(0.1, Number(rule.minMovePct || 1));
  let directional = 0;
  if (rule.expected === "RISING") directional = move / threshold;
  else if (rule.expected === "FALLING") directional = (-move) / threshold;
  else if (rule.expected === "VOLATILITY") directional = Math.abs(move) / threshold;
  else return null;
  const supportScore = Math.max(0, Math.min(100, Math.round(50 + directional * 25)));
  return { supportScore, wasSupported: directional >= 1 };
}

async function marketKnowledgeObservation(signal, rule, horizonMinutes, rows, getSnapshot) {
  const baselineAt = signal.createdAt;
  const observedAt = signal.createdAt + horizonMinutes * 60_000;

  if (rule.scope === "TARGET" && signal.eaId) {
    const [beforePrice, afterPrice] = await Promise.all([
      priceAtOrBefore(signal.eaId, baselineAt),
      priceAtOrBefore(signal.eaId, observedAt)
    ]);
    if (!Number.isFinite(beforePrice) || beforePrice <= 0 || !Number.isFinite(afterPrice) || afterPrice <= 0) return null;
    const observedChangePct = Number((((afterPrice - beforePrice) / beforePrice) * 100).toFixed(4));
    return {
      targetScope: `EA:${signal.eaId}`,
      observedChangePct,
      details: { beforePrice, afterPrice, eaId: signal.eaId }
    };
  }

  const before = await getSnapshot(baselineAt);
  const after = await getSnapshot(observedAt);
  const ratings = marketKnowledgeTargetRatings(signal, rule, before, after);
  if (!ratings.length) return null;
  const moves = ratings.map(rating => {
    const a = Number(before?.[rating]);
    const b = Number(after?.[rating]);
    if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) return null;
    return { rating, before: Math.round(a), after: Math.round(b), changePct: Number((((b - a) / a) * 100).toFixed(4)) };
  }).filter(Boolean);
  if (!moves.length) return null;
  return {
    targetScope: /^\d{2}$/.test(String(signal.playerOrRating || "")) ? `RATING:${signal.playerOrRating}` : rule.scope,
    observedChangePct: Number(median(moves.map(item => item.changePct)).toFixed(4)),
    details: { ratings: moves.slice(0, 25) }
  };
}

async function evaluateMarketKnowledge(rows) {
  if (!dbEnabled || !rows?.length) return 0;
  const signals = await loadMarketKnowledgeSignals();
  if (!signals.length) return 0;
  const learnablePairs = [];
  for (const signal of signals) {
    for (const rule of marketKnowledgeRulesForSignal(signal)) {
      if (rule.kind === "LEARNABLE") learnablePairs.push({ signal, rule });
    }
  }
  if (!learnablePairs.length) return 0;

  const signalIds = [...new Set(learnablePairs.map(item => item.signal.id))];
  const existingResult = await pool.query(`
    SELECT signal_id, rule_id, horizon_minutes
    FROM fc_market_knowledge_evaluations
    WHERE signal_id = ANY($1::varchar[])
  `, [signalIds]);
  const existing = new Set(existingResult.rows.map(row => `${row.signal_id}:${row.rule_id}:${Number(row.horizon_minutes)}`));
  const snapshotCache = new Map();
  const getSnapshot = async atMs => {
    const key = String(Math.floor(atMs / 60_000));
    if (!snapshotCache.has(key)) snapshotCache.set(key, await ratingMedianSnapshotAt(rows, atMs));
    return snapshotCache.get(key);
  };

  let inserted = 0;
  const now = Date.now();
  for (const { signal, rule } of learnablePairs) {
    // Out-of-packs ohne konkrete Karte/Rating nicht künstlich auf den Gesamtmarkt anwenden.
    if (rule.scope === "TARGET" && !signal.eaId && !/^\d{2}$/.test(String(signal.playerOrRating || ""))) continue;
    for (const horizonMinutes of MARKET_KNOWLEDGE_HORIZONS) {
      const key = `${signal.id}:${rule.id}:${horizonMinutes}`;
      if (existing.has(key) || now < signal.createdAt + horizonMinutes * 60_000) continue;
      const observation = await marketKnowledgeObservation(signal, rule, horizonMinutes, rows, getSnapshot);
      if (!observation) continue;
      const support = marketKnowledgeSupport(rule, observation.observedChangePct);
      if (!support) continue;
      const result = await pool.query(`
        INSERT INTO fc_market_knowledge_evaluations (
          signal_id, rule_id, horizon_minutes, target_scope, observed_change_pct,
          expected_mode, support_score, was_supported, details, evaluated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
        ON CONFLICT (signal_id, rule_id, horizon_minutes) DO NOTHING
      `, [
        signal.id,
        rule.id,
        horizonMinutes,
        observation.targetScope,
        observation.observedChangePct,
        rule.expected,
        support.supportScore,
        support.wasSupported,
        JSON.stringify(observation.details || {})
      ]);
      if (result.rowCount) {
        inserted += 1;
        existing.add(key);
      }
    }
  }
  return inserted;
}

async function loadMarketKnowledgeProfiles() {
  const empty = {};
  for (const rule of MARKET_KNOWLEDGE_RULES) {
    empty[rule.id] = {
      ruleId: rule.id,
      samples: 0,
      supportRate: 50,
      smoothedSupportRate: 50,
      avgObservedMovePct: 0,
      avgSupportScore: 50,
      preferredHorizonMinutes: rule.preferredHorizonMinutes,
      mature: rule.kind === "POLICY",
      state: rule.kind === "POLICY" ? "POLICY_ACTIVE" : rule.kind === "SHADOW" ? "SHADOW" : "LEARNING"
    };
  }
  if (!dbEnabled) return empty;
  const result = await pool.query(`
    SELECT rule_id, horizon_minutes, COUNT(*)::int AS samples,
           ROUND(AVG(CASE WHEN was_supported THEN 100.0 ELSE 0.0 END)::numeric, 2) AS support_rate,
           ROUND(AVG(observed_change_pct)::numeric, 3) AS avg_move,
           ROUND(AVG(support_score)::numeric, 2) AS avg_support_score
    FROM fc_market_knowledge_evaluations
    WHERE evaluated_at >= NOW() - INTERVAL '120 days'
    GROUP BY rule_id, horizon_minutes
  `);
  for (const row of result.rows) {
    const rule = marketKnowledgeRuleById(row.rule_id);
    if (!rule || Number(row.horizon_minutes) !== Number(rule.preferredHorizonMinutes)) continue;
    const samples = Number(row.samples || 0);
    const rawSupport = Number(row.support_rate || 0);
    const smoothed = ((50 * MARKET_KNOWLEDGE_PRIOR_STRENGTH) + (rawSupport * samples)) / (MARKET_KNOWLEDGE_PRIOR_STRENGTH + samples);
    const mature = samples >= MARKET_KNOWLEDGE_MIN_SAMPLES && smoothed >= MARKET_KNOWLEDGE_MIN_SUPPORT;
    empty[rule.id] = {
      ruleId: rule.id,
      samples,
      supportRate: Number(rawSupport.toFixed(2)),
      smoothedSupportRate: Number(smoothed.toFixed(2)),
      avgObservedMovePct: Number(row.avg_move || 0),
      avgSupportScore: Number(row.avg_support_score || 50),
      preferredHorizonMinutes: rule.preferredHorizonMinutes,
      mature,
      state: mature ? "VERIFIED" : "LEARNING"
    };
  }
  return empty;
}

function marketKnowledgeRuleAppliesToRow(rule, signal, row) {
  if (!rule || !signal || !row) return false;
  const target = String(signal.playerOrRating || "").trim();
  const rating = /^\d{2}$/.test(target) ? Number(target) : null;
  if (signal.eaId) return String(signal.eaId) === String(row.eaId);
  if (Number.isFinite(rating)) return row.cardType === "Base Rare" && Number(row.overall) === rating;
  if (rule.scope === "FODDER") return row.cardType === "Base Rare" && FODDER_KNOWLEDGE_RATINGS.includes(Number(row.overall));
  if (rule.scope === "MARKET") return true;
  return false;
}

function marketKnowledgeContextForRow(row, activeSignals, profiles) {
  const evidence = [];
  for (const signal of activeSignals || []) {
    for (const rule of marketKnowledgeRulesForSignal(signal)) {
      if (rule.kind !== "LEARNABLE" || !rule.directInfluence) continue;
      if (!marketKnowledgeRuleAppliesToRow(rule, signal, row)) continue;
      const profile = profiles?.[rule.id];
      if (!profile?.mature) continue;
      evidence.push({
        ruleId: rule.id,
        ruleName: rule.name,
        expected: rule.expected,
        source: signal.source,
        signalId: signal.id,
        supportRate: profile.smoothedSupportRate,
        samples: profile.samples,
        avgObservedMovePct: profile.avgObservedMovePct
      });
    }
  }
  // Ein Event soll dieselbe Regel pro Karte nur einmal gewichten.
  const unique = [];
  const seen = new Set();
  for (const item of evidence) {
    const key = `${item.ruleId}:${item.signalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function applyMarketKnowledgeLayer(row, evidence) {
  row.aiMarketKnowledge = {
    version: "10.39",
    activeVerifiedRules: evidence || [],
    influenced: false,
    note: "Nur verifizierte Regeln mit echten FC-Daten dürfen leicht beeinflussen; keine Regel erzeugt alleine einen Kauf."
  };
  if (!Array.isArray(evidence) || !evidence.length) return row;

  const rising = evidence.filter(item => item.expected === "RISING");
  const falling = evidence.filter(item => item.expected === "FALLING");
  const strongestRising = [...rising].sort((a, b) => b.supportRate - a.supportRate)[0] || null;
  const strongestFalling = [...falling].sort((a, b) => b.supportRate - a.supportRate)[0] || null;

  if (row.aiAction === "JETZT KAUFEN" && strongestFalling) {
    row.aiAction = "NOCH WARTEN";
    row.aiConfidence = Math.min(Number(row.aiConfidence || 78), 78);
    row.aiRisk = "mittel";
    row.aiMarketState = "Verifizierte Marktregel widerspricht Sofort-Kauf";
    row.aiReason = `${row.aiReason} Market-Knowledge: ${strongestFalling.ruleName} ist nach ${strongestFalling.samples} FC-Beobachtungen mit ${strongestFalling.supportRate.toFixed(1)}% geglätteter Unterstützung verifiziert und spricht aktuell gegen einen Sofort-Kauf.`.slice(0, 1800);
    row.aiRecommendedHorizon = "Marktregel abklingen lassen und Preis erneut bestätigen";
    row.aiMarketKnowledge.influenced = true;
    row.aiMarketKnowledge.effect = "BUY_BLOCKED_TO_WAIT";
  } else if (row.aiAction === "JETZT KAUFEN" && strongestRising) {
    const historicalCap = Number(row?.aiBuyGuard?.historicalConfidenceCap);
    const upper = Number.isFinite(historicalCap) ? Math.min(95, historicalCap) : 95;
    const bonus = strongestRising.supportRate >= 75 ? 3 : 2;
    const before = Number(row.aiConfidence || 50);
    row.aiConfidence = Math.min(upper, before + bonus);
    if (row.aiConfidence > before) {
      row.aiReason = `${row.aiReason} Market-Knowledge: ${strongestRising.ruleName} ist nach ${strongestRising.samples} FC-Beobachtungen verifiziert und bestätigt den Kontext leicht (+${row.aiConfidence - before} Confidence).`.slice(0, 1800);
      row.aiMarketKnowledge.influenced = true;
      row.aiMarketKnowledge.effect = `CONFIDENCE_PLUS_${row.aiConfidence - before}`;
    }
  } else if (["VERKAUF PRÜFEN", "JETZT VERKAUFEN"].includes(row.aiAction) && strongestFalling) {
    const before = Number(row.aiConfidence || 50);
    row.aiConfidence = Math.min(95, before + (strongestFalling.supportRate >= 75 ? 2 : 1));
    row.aiMarketKnowledge.influenced = row.aiConfidence > before;
    row.aiMarketKnowledge.effect = row.aiConfidence > before ? `SELL_CONFIDENCE_PLUS_${row.aiConfidence - before}` : null;
  }

  if (row.aiMarketKnowledge.influenced && !String(row.aiModelUsed || "").includes("Market Knowledge")) {
    row.aiModelUsed = `${row.aiModelUsed || "Quantitative Core"} + Market Knowledge`;
  }
  return row;
}

function brainLearningRatingBand(rating) {
  const value = Number(rating);
  if (!Number.isFinite(value)) return "unknown";
  if (value <= 79) return "75-79";
  if (value <= 84) return "80-84";
  if (value <= 89) return "85-89";
  if (value <= 94) return "90-94";
  return "95-99";
}

function brainLearningGroupKey(action, cardType = "*", ratingBand = "*") {
  return `${String(action || "UNKNOWN")}|${String(cardType || "*")}|${String(ratingBand || "*")}`;
}

function brainLearningRegimeKey(action, cardType, ratingBand, marketRegime) {
  return `${brainLearningGroupKey(action, cardType, ratingBand)}|${String(marketRegime || "NORMAL")}`;
}

function brainLearningMarketRegime(input) {
  let data = input || {};

  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }

  const num = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const c5 = num(data.change5m);
  const c15 = num(data.change15m);
  const c1h = num(data.change1h);
  const c24 = num(data.change24h);
  const distanceLow = Math.max(0, num(data.distanceTo24hLow));
  const rising = Math.max(0, num(data.ratingMarketRisingPct));
  const falling = Math.max(0, num(data.ratingMarketFallingPct));

  // Nicht jede rote Kerze ist ein Crash. Erst starke Einzelkartenbewegung
  // oder klarer Rating-Markt-Abverkauf erzeugt ein eigenes Regime.
  if (
    c5 <= -8 ||
    c15 <= -12 ||
    c1h <= -15 ||
    (falling >= 75 && c5 <= -3)
  ) {
    return "CRASH";
  }

  if (
    c5 >= 8 ||
    c15 >= 12 ||
    c1h >= 15 ||
    (rising >= 75 && c5 >= 3)
  ) {
    return "PUMP";
  }

  // Rebound nahe dem 24h-Tief: vorheriger Abverkauf, kurzfristig dreht
  // Momentum sichtbar nach oben.
  if (
    distanceLow <= 5 &&
    (
      (c5 >= 1 && c15 >= 1.5) ||
      (c1h >= 2 && c24 < 0)
    )
  ) {
    return "RECOVERY";
  }

  if (
    Math.abs(c5) <= 1 &&
    Math.abs(c15) <= 2 &&
    Math.abs(c1h) <= 3
  ) {
    return "FLAT";
  }

  return "NORMAL";
}

function brainLearningMovePct(initialPrice, prices) {
  const initial = Number(initialPrice);
  if (!Number.isFinite(initial) || initial <= 0) return null;

  const moves = (prices || [])
    .map(Number)
    .filter(value => Number.isFinite(value) && value > 0)
    .map(value => Math.abs(((value - initial) / initial) * 100));

  return moves.length ? Math.max(...moves) : null;
}

function brainLearningQualityWeight(row) {
  // Ein kaum bewegter Markt darf passive WAIT-Entscheidungen nicht als
  // vollwertigen Treffer aufblasen. Echte Bewegungen behalten Gewicht 1.0.
  if (row.action === "NOCH WARTEN") {
    const move = brainLearningMovePct(row.initialPrice, [row.priceAfter5m, row.priceAfter15m]);
    if (move == null) return 0.1;
    if (move < 0.25) return 0.05;
    if (move < 0.5) return 0.15;
    if (move < 1) return 0.35;
    if (move < 2) return 0.65;
    return 1;
  }

  const move = brainLearningMovePct(row.initialPrice, [row.priceAfter1h, row.priceAfter6h, row.priceAfter24h]);
  if (move == null) return 0.25;
  if (move < 0.5) return 0.5;
  return 1;
}

function brainLearningRecencyWeight(createdAt, now = Date.now()) {
  const created = Number(createdAt);
  if (!Number.isFinite(created) || created <= 0) return BRAIN_LEARNING_RECENCY_MIN_WEIGHT;

  const ageDays = Math.max(0, (now - created) / (24 * 60 * 60_000));
  const decay = Math.pow(0.5, ageDays / BRAIN_LEARNING_RECENCY_HALF_LIFE_DAYS);
  return Math.max(BRAIN_LEARNING_RECENCY_MIN_WEIGHT, Math.min(1, decay));
}

function addBrainLearningSample(map, key, row, scope) {
  let group = map.get(key);
  if (!group) {
    group = {
      scope,
      key,
      action: row.action,
      cardType: scope === "action" ? "*" : row.cardType,
      ratingBand: ["exact", "regimeExact"].includes(scope) ? row.ratingBand : "*",
      marketRegime: scope === "regimeExact" ? row.marketRegime : "*",
      samples: 0,
      wins: 0,
      effectiveSamples: 0,
      weightedWins: 0,
      totalOutcomeScore: 0,
      scoredOutcomeWeight: 0,
      totalMaxRoi: 0,
      roiWeight: 0
    };
    map.set(key, group);
  }

  const weight = Math.max(0.05, Math.min(1, Number(row.learningWeight || 1)));
  group.samples += 1;
  group.effectiveSamples += weight;
  if (row.wasCorrect === true) {
    group.wins += 1;
    group.weightedWins += weight;
  }

  if (Number.isFinite(row.outcomeScore)) {
    group.totalOutcomeScore += row.outcomeScore * weight;
    group.scoredOutcomeWeight += weight;
  }

  // ROI-Ausreißer sind für die Confidence nicht entscheidend. Für die Anzeige
  // kappen wir sie robust, damit einzelne illiquide Karten das Profil nicht verzerren.
  if (Number.isFinite(row.maxRoi)) {
    const clippedRoi = Math.max(-100, Math.min(200, row.maxRoi));
    group.totalMaxRoi += clippedRoi * weight;
    group.roiWeight += weight;
  }
}

function finalizeBrainLearningGroup(group) {
  const samples = Number(group.samples || 0);
  const wins = Number(group.wins || 0);
  const effectiveSamples = Number(group.effectiveSamples || 0);
  const weightedWins = Number(group.weightedWins || 0);

  const rawAccuracy = effectiveSamples > 0
    ? (weightedWins / effectiveSamples) * 100
    : 50;

  const smoothedAccuracy = (
    BRAIN_LEARNING_PRIOR_ACCURACY * BRAIN_LEARNING_PRIOR_STRENGTH +
    weightedWins * 100
  ) / (BRAIN_LEARNING_PRIOR_STRENGTH + effectiveSamples);

  const averageOutcomeScore = group.scoredOutcomeWeight > 0
    ? group.totalOutcomeScore / group.scoredOutcomeWeight
    : 0;

  const averageMaxRoi = group.roiWeight > 0
    ? group.totalMaxRoi / group.roiWeight
    : null;

  const accuracyAdjustment = Math.max(
    -BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT,
    Math.min(
      BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT,
      Math.round((smoothedAccuracy - 50) / 4)
    )
  );

  // v10.8.1: Nicht jeder Treffer/Fehler ist gleich wertvoll.
  // Erst bei genügend effektiver Evidenz darf die durchschnittliche
  // Ergebnis-Schwere die Confidence zusätzlich konservativ kalibrieren.
  let severityAdjustment = 0;
  if (effectiveSamples >= BRAIN_LEARNING_SEVERITY_MIN_EFFECTIVE) {
    if (averageOutcomeScore <= -40) {
      severityAdjustment = -BRAIN_LEARNING_SEVERITY_MAX_ADJUSTMENT;
    } else if (averageOutcomeScore <= -15) {
      severityAdjustment = -1;
    } else if (averageOutcomeScore >= 70) {
      severityAdjustment = BRAIN_LEARNING_SEVERITY_MAX_ADJUSTMENT;
    } else if (averageOutcomeScore >= 45) {
      severityAdjustment = 1;
    }
  }

  let confidenceAdjustment = Math.max(
    -BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT,
    Math.min(
      BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT,
      accuracyAdjustment + severityAdjustment
    )
  );

  // WAIT ist eine passive Aktion und kann bei flachem Markt leicht scheinbar
  // perfekt aussehen. Positive Verstärkung deshalb bewusst kleiner halten.
  if (group.action === "NOCH WARTEN" && confidenceAdjustment > BRAIN_LEARNING_WAIT_POSITIVE_CAP) {
    confidenceAdjustment = BRAIN_LEARNING_WAIT_POSITIVE_CAP;
  }

  return {
    scope: group.scope,
    key: group.key,
    action: group.action,
    cardType: group.cardType,
    ratingBand: group.ratingBand,
    marketRegime: group.marketRegime || "*",
    samples,
    effectiveSamples: Number(effectiveSamples.toFixed(2)),
    wins,
    weightedWins: Number(weightedWins.toFixed(2)),
    rawAccuracy: Number(rawAccuracy.toFixed(2)),
    smoothedAccuracy: Number(smoothedAccuracy.toFixed(2)),
    averageOutcomeScore: Number(averageOutcomeScore.toFixed(2)),
    averageMaxRoi: averageMaxRoi == null ? null : Number(averageMaxRoi.toFixed(2)),
    accuracyAdjustment,
    severityAdjustment,
    confidenceAdjustment
  };
}

function brainLearningDecisionIsMature(row) {
  const action = String(row.action || "");

  // WAIT ist eine kurzfristige Entscheidung. Nach 15 Minuten ist genug
  // Information vorhanden, um sie als abgeschlossene Lernepisode zu werten.
  if (action === "NOCH WARTEN") {
    return row.priceAfter15m != null;
  }

  // BUY / AVOID / SELL dürfen nicht schon nach 1h als endgültiger Lernerfolg
  // gelten. Die Bewertungslogik betrachtet bei diesen Aktionen ein längeres
  // Fenster; deshalb lernen wir erst, sobald der 6h-Punkt vorhanden ist.
  if (["JETZT KAUFEN", "NICHT KAUFEN", "VERKAUF PRÜFEN"].includes(action)) {
    return row.priceAfter6h != null;
  }

  return false;
}


function performanceConfidenceBucket(confidence) {
  const value = Math.max(0, Math.min(95, Number(confidence || 0)));
  if (value >= 90) return "90-95";
  if (value >= 80) return "80-89";
  if (value >= 70) return "70-79";
  if (value >= 60) return "60-69";
  return "0-59";
}

function performanceCardGroup(cardType) {
  const type = String(cardType || "").toLowerCase();
  return type.includes("base rare") || type.includes("base common") ? "BASE" : "SPECIAL";
}

function performanceAction(action) {
  return String(action || "").toUpperCase() === "JETZT VERKAUFEN"
    ? "VERKAUF PRÜFEN"
    : String(action || "").toUpperCase();
}

function performanceNetRoi(initialPrice, futurePrice) {
  const initial = Number(initialPrice);
  const future = Number(futurePrice);
  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(future) || future <= 0) return null;
  // Hypothetischer Kauf zum Signalpreis, Verkauf spaeter nach 5% EA-Steuer.
  return ((future * 0.95 - initial) / initial) * 100;
}

function performanceRawMove(initialPrice, futurePrice) {
  const initial = Number(initialPrice);
  const future = Number(futurePrice);
  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(future) || future <= 0) return null;
  return ((future - initial) / initial) * 100;
}

function decisionPerformanceIsMature(action, tracked) {
  const normalized = performanceAction(action);
  if (normalized === "NOCH WARTEN") {
    return tracked.after30m != null;
  }
  if (["JETZT KAUFEN", "NICHT KAUFEN", "VERKAUF PRÜFEN"].includes(normalized)) {
    return tracked.after6h != null;
  }
  return false;
}

function enhancedDecisionPerformance(record, tracked, baseEvaluation) {
  const initial = Number(record.initial_price);
  const prices = [
    tracked.after5m,
    tracked.after15m,
    tracked.after30m,
    tracked.after1h,
    tracked.after3h,
    tracked.after6h,
    tracked.after24h
  ];

  const rawMoves = prices.map(price => performanceRawMove(initial, price));
  const netRois = prices.map(price => performanceNetRoi(initial, price));
  const validRaw = rawMoves.filter(Number.isFinite);
  const validNet = netRois.filter(Number.isFinite);

  const action = performanceAction(record.action);
  const bestNetRoi = validNet.length ? Math.max(...validNet) : null;
  const worstMovePct = validRaw.length ? Math.min(...validRaw) : null;

  // Camavinga-artiger Fehler: WAIT, aber danach waere nach Steuer ein klarer
  // profitabler Rebound moeglich gewesen.
  const missedEntry =
    action === "NOCH WARTEN" &&
    decisionPerformanceIsMature(action, tracked) &&
    Number.isFinite(bestNetRoi) &&
    bestNetRoi >= PERFORMANCE_LAB_MISSED_ENTRY_NET_ROI;

  // Lauren-James-artiger Fehler: BUY, aber bis zur Reife kein einziger
  // profitabler Exit nach Steuer.
  const falseBuy =
    action === "JETZT KAUFEN" &&
    decisionPerformanceIsMature(action, tracked) &&
    Number.isFinite(bestNetRoi) &&
    bestNetRoi <= PERFORMANCE_LAB_FALSE_BUY_MAX_NET_ROI;

  let sellTimingScore = null;
  if (action === "VERKAUF PRÜFEN" && validRaw.length) {
    // Ein gutes Sell-Timing zeigt sich daran, dass der Markt nach dem Signal
    // nachgibt. 0% Rueckgang = 50 Punkte, -10% oder mehr = 100 Punkte.
    const postSignalLowMove = Math.min(...validRaw);
    sellTimingScore = Math.max(0, Math.min(100, Math.round(50 + (-postSignalLowMove * 5))));
  }

  const outcomeCorrect = baseEvaluation?.wasCorrect === true;
  const confidence = Number(record.confidence || 0);
  const confidenceError = baseEvaluation?.wasCorrect == null
    ? null
    : Math.abs(confidence - (outcomeCorrect ? 100 : 0));

  let outcomeClass = "LEARNING";
  if (falseBuy) outcomeClass = "FALSE_BUY";
  else if (missedEntry) outcomeClass = "MISSED_ENTRY";
  else if (action === "JETZT KAUFEN" && baseEvaluation?.wasCorrect === true) outcomeClass = "GOOD_BUY";
  else if (action === "NOCH WARTEN" && baseEvaluation?.wasCorrect === true) outcomeClass = "GOOD_WAIT";
  else if (action === "NICHT KAUFEN" && baseEvaluation?.wasCorrect === true) outcomeClass = "GOOD_AVOID";
  else if (action === "VERKAUF PRÜFEN" && baseEvaluation?.wasCorrect === true) outcomeClass = "GOOD_SELL";
  else if (decisionPerformanceIsMature(action, tracked) && baseEvaluation?.wasCorrect === false) outcomeClass = "WRONG_DECISION";

  return {
    roi30m: rawMoves[2],
    roi3h: rawMoves[4],
    netRoi5m: netRois[0],
    netRoi15m: netRois[1],
    netRoi30m: netRois[2],
    netRoi1h: netRois[3],
    netRoi3h: netRois[4],
    netRoi6h: netRois[5],
    netRoi24h: netRois[6],
    bestNetRoi,
    worstMovePct,
    missedEntry,
    falseBuy,
    sellTimingScore,
    outcomeClass,
    confidenceError
  };
}

function addPerformanceCalibrationSample(map, key, row) {
  let group = map.get(key);
  if (!group) {
    group = {
      key,
      action: row.action,
      cardGroup: row.cardGroup,
      confidenceBucket: row.confidenceBucket,
      samples: 0,
      wins: 0,
      confidenceTotal: 0
    };
    map.set(key, group);
  }
  group.samples += 1;
  if (row.wasCorrect === true) group.wins += 1;
  group.confidenceTotal += Number(row.confidence || 0);
}

function finalizePerformanceCalibrationGroup(group) {
  const samples = Number(group.samples || 0);
  const wins = Number(group.wins || 0);
  const empiricalAccuracy = samples ? (wins / samples) * 100 : 50;
  const smoothedAccuracy = (
    50 * 8 + wins * 100
  ) / (8 + samples);
  const averageConfidence = samples ? Number(group.confidenceTotal || 0) / samples : 0;
  return {
    ...group,
    empiricalAccuracy: Number(empiricalAccuracy.toFixed(2)),
    smoothedAccuracy: Number(smoothedAccuracy.toFixed(2)),
    averageConfidence: Number(averageConfidence.toFixed(2)),
    calibrationGap: Number((averageConfidence - empiricalAccuracy).toFixed(2))
  };
}

async function loadDecisionPerformanceProfiles(force = false) {
  if (!dbEnabled) return decisionPerformanceCache;

  const now = Date.now();
  if (
    !force &&
    decisionPerformanceCache.loadedAt > 0 &&
    now - decisionPerformanceCache.loadedAt < PERFORMANCE_LAB_REFRESH_MS
  ) {
    return decisionPerformanceCache;
  }

  try {
    const result = await pool.query(`
      SELECT
        d.action,
        d.confidence,
        d.card_type,
        e.was_correct,
        e.price_after_30m,
        e.price_after_6h
      FROM fc_trader_brain_decisions d
      JOIN fc_decision_evaluations e ON e.decision_id = d.id
      WHERE d.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND e.was_correct IS NOT NULL
        AND (
          (d.action = 'NOCH WARTEN' AND e.price_after_30m IS NOT NULL)
          OR
          (d.action IN ('JETZT KAUFEN','NICHT KAUFEN','VERKAUF PRÜFEN') AND e.price_after_6h IS NOT NULL)
        )
      ORDER BY d.created_at DESC
      LIMIT 5000
    `, [PERFORMANCE_LAB_WINDOW_DAYS]);

    const exact = new Map();
    const fallback = new Map();

    for (const dbRow of result.rows) {
      const row = {
        action: performanceAction(dbRow.action),
        confidence: Number(dbRow.confidence || 0),
        cardGroup: performanceCardGroup(dbRow.card_type),
        confidenceBucket: performanceConfidenceBucket(dbRow.confidence),
        wasCorrect: dbRow.was_correct
      };
      addPerformanceCalibrationSample(
        exact,
        `${row.action}|${row.cardGroup}|${row.confidenceBucket}`,
        row
      );
      addPerformanceCalibrationSample(
        fallback,
        `${row.action}|*|${row.confidenceBucket}`,
        { ...row, cardGroup: "*" }
      );
    }

    const profiles = [
      ...Array.from(exact.values()).map(finalizePerformanceCalibrationGroup),
      ...Array.from(fallback.values()).map(finalizePerformanceCalibrationGroup)
    ];

    decisionPerformanceCache = {
      loadedAt: now,
      updatedAt: new Date().toISOString(),
      totalMature: result.rowCount,
      profiles: new Map(profiles.map(profile => [profile.key, profile])),
      profileList: profiles.sort((a, b) => b.samples - a.samples)
    };
    return decisionPerformanceCache;
  } catch (error) {
    console.error("Decision Performance profile error:", error);
    return decisionPerformanceCache;
  }
}

function selectDecisionPerformanceProfile(cache, action, cardType, confidence) {
  const normalizedAction = performanceAction(action);
  const bucket = performanceConfidenceBucket(confidence);
  const cardGroup = performanceCardGroup(cardType);
  const exact = cache?.profiles?.get(`${normalizedAction}|${cardGroup}|${bucket}`);
  if (exact && exact.samples >= PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES) return exact;
  const fallback = cache?.profiles?.get(`${normalizedAction}|*|${bucket}`);
  if (fallback && fallback.samples >= PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES) return fallback;
  return null;
}

function applyDecisionPerformanceCalibration(row, cache = decisionPerformanceCache) {
  if (!row || !Number.isFinite(Number(row.aiConfidence))) return row;
  const profile = selectDecisionPerformanceProfile(cache, row.aiAction, row.cardType, row.aiConfidence);
  if (!profile) {
    row.aiPerformanceCalibration = {
      active: false,
      reason: "Noch nicht genug unabhaengige reife Outcomes."
    };
    return row;
  }

  const oldConfidence = Number(row.aiConfidence);
  const confidenceCap = Math.max(
    50,
    Math.min(95, Math.round(profile.smoothedAccuracy + PERFORMANCE_LAB_CONFIDENCE_BUFFER))
  );
  if (oldConfidence > confidenceCap) {
    row.aiConfidence = confidenceCap;
  }

  const originalAction = row.aiAction;
  let abstained = false;

  // Harte Abstain-Zone nur bei BUY. Schlechte Historie darf einen Kauf stoppen,
  // aber nie umgekehrt aus schwacher Historie einen neuen Kauf erzeugen.
  if (
    originalAction === "JETZT KAUFEN" &&
    profile.samples >= PERFORMANCE_LAB_MIN_ABSTAIN_SAMPLES
  ) {
    if (profile.smoothedAccuracy < PERFORMANCE_LAB_BUY_BLOCK_ACCURACY) {
      row.aiAction = "NICHT KAUFEN";
      abstained = true;
      row.aiReason = `${row.aiReason} Performance Lab: vergleichbare reife Kaufsignale trafen nur ${profile.smoothedAccuracy.toFixed(1)}% geglaettet. Historie blockiert den Einstieg.`;
    } else if (profile.smoothedAccuracy < PERFORMANCE_LAB_BUY_ABSTAIN_ACCURACY) {
      row.aiAction = "NOCH WARTEN";
      abstained = true;
      row.aiReason = `${row.aiReason} Performance Lab: vergleichbare reife Kaufsignale liegen nur bei ${profile.smoothedAccuracy.toFixed(1)}% geglaetteter Trefferquote. Erst weitere Marktbestätigung abwarten.`;
    }
  }

  row.aiPerformanceCalibration = {
    active: true,
    samples: profile.samples,
    confidenceBucket: profile.confidenceBucket,
    cardGroup: profile.cardGroup,
    empiricalAccuracy: profile.empiricalAccuracy,
    smoothedAccuracy: profile.smoothedAccuracy,
    previousConfidence: oldConfidence,
    confidenceCap,
    finalConfidence: Number(row.aiConfidence),
    originalAction,
    finalAction: row.aiAction,
    abstained
  };

  return row;
}

async function buildDecisionPerformanceScorecard(limit = 500) {
  if (!dbEnabled) {
    return {
      ok: true,
      enabled: false,
      total: 0,
      note: "PostgreSQL nicht aktiv."
    };
  }

  const safeLimit = Math.max(50, Math.min(2000, Number(limit || 500)));
  const result = await pool.query(`
    SELECT
      d.id,
      d.ea_id::text AS ea_id,
      d.player_name,
      d.rating,
      d.card_type,
      d.initial_price,
      d.action,
      d.confidence,
      d.market_state,
      d.created_at,
      e.price_after_5m,
      e.price_after_15m,
      e.price_after_30m,
      e.price_after_1h,
      e.price_after_3h,
      e.price_after_6h,
      e.price_after_24h,
      e.net_roi_5m,
      e.net_roi_15m,
      e.net_roi_30m,
      e.net_roi_1h,
      e.net_roi_3h,
      e.net_roi_6h,
      e.net_roi_24h,
      e.best_net_roi,
      e.worst_move_pct,
      e.was_correct,
      e.outcome_score,
      e.missed_entry,
      e.false_buy,
      e.sell_timing_score,
      e.outcome_class,
      e.confidence_error,
      e.evaluated_at
    FROM fc_trader_brain_decisions d
    JOIN fc_decision_evaluations e ON e.decision_id = d.id
    WHERE e.was_correct IS NOT NULL
      AND (
        (d.action = 'NOCH WARTEN' AND e.price_after_30m IS NOT NULL)
        OR
        (d.action IN ('JETZT KAUFEN','NICHT KAUFEN','VERKAUF PRÜFEN') AND e.price_after_6h IS NOT NULL)
      )
    ORDER BY d.created_at DESC
    LIMIT $1
  `, [safeLimit]);

  const rows = result.rows.map(row => ({
    ...row,
    confidence: Number(row.confidence || 0),
    best_net_roi: row.best_net_roi == null ? null : Number(row.best_net_roi),
    worst_move_pct: row.worst_move_pct == null ? null : Number(row.worst_move_pct),
    confidence_error: row.confidence_error == null ? null : Number(row.confidence_error),
    sell_timing_score: row.sell_timing_score == null ? null : Number(row.sell_timing_score),
    was_correct: row.was_correct === true
  }));

  const total = rows.length;
  const wins = rows.filter(row => row.was_correct).length;
  const buyRows = rows.filter(row => performanceAction(row.action) === "JETZT KAUFEN");
  const waitRows = rows.filter(row => performanceAction(row.action) === "NOCH WARTEN");
  const falseBuys = buyRows.filter(row => row.false_buy === true).length;
  const missedEntries = waitRows.filter(row => row.missed_entry === true).length;
  const sellRows = rows.filter(row => performanceAction(row.action) === "VERKAUF PRÜFEN" && Number.isFinite(row.sell_timing_score));
  const confidenceErrors = rows.map(row => row.confidence_error).filter(Number.isFinite);
  const bestNet = buyRows.map(row => row.best_net_roi).filter(Number.isFinite);

  function groupSummary(keyFn) {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      let group = groups.get(key);
      if (!group) {
        group = { key, samples: 0, wins: 0, confidenceTotal: 0, bestNetTotal: 0, bestNetCount: 0, falseBuys: 0, missedEntries: 0 };
        groups.set(key, group);
      }
      group.samples += 1;
      if (row.was_correct) group.wins += 1;
      group.confidenceTotal += Number(row.confidence || 0);
      if (Number.isFinite(row.best_net_roi)) {
        group.bestNetTotal += row.best_net_roi;
        group.bestNetCount += 1;
      }
      if (row.false_buy === true) group.falseBuys += 1;
      if (row.missed_entry === true) group.missedEntries += 1;
    }
    return Array.from(groups.values()).map(group => ({
      key: group.key,
      samples: group.samples,
      accuracy: Number(((group.wins / Math.max(1, group.samples)) * 100).toFixed(2)),
      averageConfidence: Number((group.confidenceTotal / Math.max(1, group.samples)).toFixed(2)),
      averageBestNetRoi: group.bestNetCount
        ? Number((group.bestNetTotal / group.bestNetCount).toFixed(2))
        : null,
      falseBuys: group.falseBuys,
      missedEntries: group.missedEntries
    })).sort((a, b) => b.samples - a.samples);
  }

  return {
    ok: true,
    enabled: true,
    version: "10.50-rating-list-all-watch",
    sampleSize: total,
    scorecard: {
      accuracy: total ? Number(((wins / total) * 100).toFixed(2)) : null,
      falseBuyRate: buyRows.length ? Number(((falseBuys / buyRows.length) * 100).toFixed(2)) : null,
      missedEntryRate: waitRows.length ? Number(((missedEntries / waitRows.length) * 100).toFixed(2)) : null,
      buySamples: buyRows.length,
      waitSamples: waitRows.length,
      sellSamples: sellRows.length,
      averageBestNetRoi: bestNet.length
        ? Number((bestNet.reduce((a, b) => a + b, 0) / bestNet.length).toFixed(2))
        : null,
      averageSellTimingScore: sellRows.length
        ? Number((sellRows.reduce((sum, row) => sum + row.sell_timing_score, 0) / sellRows.length).toFixed(2))
        : null,
      meanConfidenceError: confidenceErrors.length
        ? Number((confidenceErrors.reduce((a, b) => a + b, 0) / confidenceErrors.length).toFixed(2))
        : null
    },
    byAction: groupSummary(row => performanceAction(row.action)),
    byConfidenceBucket: groupSummary(row => performanceConfidenceBucket(row.confidence)),
    byCardGroup: groupSummary(row => performanceCardGroup(row.card_type)),
    recent: rows.slice(0, 30),
    calibration: decisionPerformanceCache.profileList.slice(0, 40),
    thresholds: {
      evaluationHorizonsMinutes: [5, 15, 30, 60, 180, 360, 1440],
      eaTaxPct: 5,
      missedEntryMinNetRoi: PERFORMANCE_LAB_MISSED_ENTRY_NET_ROI,
      falseBuyMaxBestNetRoi: PERFORMANCE_LAB_FALSE_BUY_MAX_NET_ROI,
      calibrationMinSamples: PERFORMANCE_LAB_MIN_CALIBRATION_SAMPLES,
      abstainMinSamples: PERFORMANCE_LAB_MIN_ABSTAIN_SAMPLES,
      buyAbstainBelowAccuracy: PERFORMANCE_LAB_BUY_ABSTAIN_ACCURACY,
      buyBlockBelowAccuracy: PERFORMANCE_LAB_BUY_BLOCK_ACCURACY
    }
  };
}

async function loadBrainLearningProfiles(force = false) {
  if (!dbEnabled) return brainLearningCache;

  const now = Date.now();
  if (
    !force &&
    brainLearningCache.loadedAt > 0 &&
    now - brainLearningCache.loadedAt < BRAIN_LEARNING_REFRESH_MS
  ) {
    return brainLearningCache;
  }

  try {
    const result = await pool.query(`
      SELECT
        d.ea_id,
        d.created_at,
        d.initial_price,
        d.action,
        d.card_type,
        d.rating,
        d.input_snapshot,
        e.was_correct,
        e.outcome_score,
        e.max_roi,
        e.price_after_5m,
        e.price_after_15m,
        e.price_after_1h,
        e.price_after_6h,
        e.price_after_24h
      FROM fc_trader_brain_decisions d
      JOIN fc_decision_evaluations e ON e.decision_id = d.id
      WHERE d.created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND e.was_correct IS NOT NULL
        AND d.action IN ('JETZT KAUFEN', 'NOCH WARTEN', 'NICHT KAUFEN', 'VERKAUF PRÜFEN')
      ORDER BY d.created_at DESC
      LIMIT 5000
    `, [BRAIN_LEARNING_WINDOW_DAYS]);

    const regimeRaw = new Map();
    const exactRaw = new Map();
    const cardTypeRaw = new Map();
    const actionRaw = new Map();
    const rollingEpisodeLastSeen = new Map();
    let rawMature = 0;
    let mature = 0;

    for (const dbRow of result.rows) {
      const row = {
        eaId: String(dbRow.ea_id || ""),
        createdAt: new Date(dbRow.created_at).getTime(),
        initialPrice: dbRow.initial_price == null ? null : Number(dbRow.initial_price),
        action: String(dbRow.action || ""),
        cardType: String(dbRow.card_type || "Unknown"),
        ratingBand: brainLearningRatingBand(Number(dbRow.rating)),
        marketRegime: brainLearningMarketRegime(dbRow.input_snapshot),
        wasCorrect: dbRow.was_correct,
        outcomeScore: dbRow.outcome_score == null ? null : Number(dbRow.outcome_score),
        maxRoi: dbRow.max_roi == null ? null : Number(dbRow.max_roi),
        priceAfter5m: dbRow.price_after_5m == null ? null : Number(dbRow.price_after_5m),
        priceAfter15m: dbRow.price_after_15m == null ? null : Number(dbRow.price_after_15m),
        priceAfter1h: dbRow.price_after_1h == null ? null : Number(dbRow.price_after_1h),
        priceAfter6h: dbRow.price_after_6h == null ? null : Number(dbRow.price_after_6h),
        priceAfter24h: dbRow.price_after_24h == null ? null : Number(dbRow.price_after_24h)
      };

      if (!brainLearningDecisionIsMature(row)) continue;
      rawMature += 1;

      // Mehrere fast identische Entscheidungen derselben Karte im selben
      // Marktfenster sind ein Ereignis, nicht mehrere unabhängige Beweise.
      const seriesKey = `${row.eaId}|${row.action}`;
      const lastSeenAt = rollingEpisodeLastSeen.get(seriesKey);

      if (Number.isFinite(lastSeenAt)) {
        const gapMs = lastSeenAt - row.createdAt;

        if (gapMs >= 0 && gapMs < BRAIN_LEARNING_EPISODE_MS) {
          rollingEpisodeLastSeen.set(seriesKey, row.createdAt);
          continue;
        }
      }

      rollingEpisodeLastSeen.set(seriesKey, row.createdAt);
      row.learningQualityWeight = brainLearningQualityWeight(row);
      row.learningRecencyWeight = brainLearningRecencyWeight(row.createdAt, now);
      row.learningWeight = row.learningQualityWeight * row.learningRecencyWeight;
      mature += 1;

      // v10.8: Wenn genügend Evidenz vorhanden ist, lernt der Brain zuerst
      // aus derselben Marktlage. Ein Crash wird damit nicht mehr mit einem
      // flachen oder bereits gepumpten Markt in einen Topf geworfen.
      addBrainLearningSample(
        regimeRaw,
        brainLearningRegimeKey(row.action, row.cardType, row.ratingBand, row.marketRegime),
        row,
        "regimeExact"
      );
      addBrainLearningSample(
        exactRaw,
        brainLearningGroupKey(row.action, row.cardType, row.ratingBand),
        row,
        "exact"
      );
      addBrainLearningSample(
        cardTypeRaw,
        brainLearningGroupKey(row.action, row.cardType, "*"),
        row,
        "cardType"
      );
      addBrainLearningSample(
        actionRaw,
        brainLearningGroupKey(row.action, "*", "*"),
        row,
        "action"
      );
    }

    const regimeExact = new Map([...regimeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));
    const exact = new Map([...exactRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));
    const cardType = new Map([...cardTypeRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));
    const action = new Map([...actionRaw.entries()].map(([key, value]) => [key, finalizeBrainLearningGroup(value)]));

    const profiles = [
      ...regimeExact.values(),
      ...exact.values(),
      ...cardType.values(),
      ...action.values()
    ].sort((a, b) => b.samples - a.samples || Math.abs(b.confidenceAdjustment) - Math.abs(a.confidenceAdjustment));

    brainLearningCache = {
      loadedAt: now,
      updatedAt: new Date(now).toISOString(),
      totalMatureDecisions: mature,
      rawMatureDecisions: rawMature,
      uniqueLearningEpisodes: mature,
      regimeExact,
      exact,
      cardType,
      action,
      profiles
    };
    lastBrainLearningRefreshAt = now;
    lastBrainLearningError = null;
    return brainLearningCache;
  } catch (error) {
    lastBrainLearningError = String(error);
    console.error("Brain learning refresh error:", error);
    return brainLearningCache;
  }
}

function selectBrainLearningProfile(cache, action, cardType, rating, input = null) {
  if (!cache) return null;

  const ratingBand = brainLearningRatingBand(rating);
  const marketRegime = brainLearningMarketRegime(input);

  const byRegime = cache.regimeExact?.get(
    brainLearningRegimeKey(action, cardType, ratingBand, marketRegime)
  );
  if (
    byRegime &&
    byRegime.samples >= BRAIN_LEARNING_REGIME_MIN_SAMPLES &&
    byRegime.effectiveSamples >= BRAIN_LEARNING_REGIME_MIN_EFFECTIVE
  ) return byRegime;

  const exact = cache.exact?.get(brainLearningGroupKey(action, cardType, ratingBand));
  if (
    exact &&
    exact.samples >= BRAIN_LEARNING_EXACT_MIN_SAMPLES &&
    exact.effectiveSamples >= BRAIN_LEARNING_EXACT_MIN_EFFECTIVE
  ) return exact;

  const byCardType = cache.cardType?.get(brainLearningGroupKey(action, cardType, "*"));
  if (
    byCardType &&
    byCardType.samples >= BRAIN_LEARNING_CARDTYPE_MIN_SAMPLES &&
    byCardType.effectiveSamples >= BRAIN_LEARNING_CARDTYPE_MIN_EFFECTIVE
  ) return byCardType;

  const byAction = cache.action?.get(brainLearningGroupKey(action, "*", "*"));
  if (
    byAction &&
    byAction.samples >= BRAIN_LEARNING_ACTION_MIN_SAMPLES &&
    byAction.effectiveSamples >= BRAIN_LEARNING_ACTION_MIN_EFFECTIVE
  ) return byAction;

  return null;
}

function applyBrainLearningToDecision(decision, profile) {
  if (!decision) return decision;

  if (!profile) {
    return {
      ...decision,
      historical_learning: {
        applied: false,
        reason: "Noch nicht genug ausgewertete ähnliche Entscheidungen."
      }
    };
  }

  const modifier = Number(profile.confidenceAdjustment || 0);
  const oldConfidence = Number(decision.confidence || 50);
  const confidence = Math.max(10, Math.min(95, oldConfidence + modifier));
  const signed = modifier > 0 ? `+${modifier}` : String(modifier);
  const effectiveText = Number.isFinite(profile.effectiveSamples)
    ? ` (${profile.effectiveSamples.toFixed(1)} effektiv)`
    : "";
  const regimeText =
    profile.marketRegime && profile.marketRegime !== "*"
      ? `, Marktlage ${profile.marketRegime}`
      : "";
  const learningFactor = `Historie: ${profile.samples} unabhängige Fälle${effectiveText}${regimeText}, ${profile.smoothedAccuracy.toFixed(1)}% geglättete Trefferquote, Confidence ${signed}.`;

  return {
    ...decision,
    confidence,
    reason: modifier === 0
      ? decision.reason
      : `${decision.reason} ${learningFactor}`.slice(0, 1800),
    key_factors: [
      ...(Array.isArray(decision.key_factors) ? decision.key_factors : []),
      learningFactor
    ].slice(0, 12),
    historical_learning: {
      applied: true,
      scope: profile.scope,
      marketRegime: profile.marketRegime || "*",
      samples: profile.samples,
      effectiveSamples: profile.effectiveSamples,
      wins: profile.wins,
      weightedWins: profile.weightedWins,
      rawAccuracy: profile.rawAccuracy,
      smoothedAccuracy: profile.smoothedAccuracy,
      averageOutcomeScore: profile.averageOutcomeScore,
      averageMaxRoi: profile.averageMaxRoi,
      accuracyAdjustment: profile.accuracyAdjustment ?? profile.confidenceAdjustment,
      severityAdjustment: profile.severityAdjustment ?? 0,
      confidenceBefore: oldConfidence,
      confidenceModifier: modifier,
      confidenceAfter: confidence
    },
    ai_model_used: modifier === 0
      ? (decision.ai_model_used || "Quantitative Core")
      : `${decision.ai_model_used || "Quantitative Core"} + Self-Learning`
  };
}

function baseDecisionFromQuant(quant, confluence) {
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
    ai_model_used: "Quantitative Core"
  };
}

function applyDecisionToRow(row, decision) {
  row.aiAction = decision.action;
  row.aiConfidence = decision.confidence;
  row.aiReason = decision.reason;
  row.aiRisk = decision.risk;
  row.aiMarketState = decision.market_state;
  row.aiModelUsed = decision.ai_model_used || "Quantitative Core";
  row.aiKeyFactors = decision.key_factors || [];
  row.aiRecommendedHorizon = decision.recommended_horizon || null;
  row.aiEntryZone = decision.entry_zone || null;
  row.aiTargetExitZone = decision.target_exit_zone || null;
  row.aiContext = decision.context_breakdown || null;
  row.aiTraderConfluence = decision.trader_signals_confluence || null;
  row.aiHistoricalLearning = decision.historical_learning || null;
}

function registerStrictBuyCycle(row, at = Date.now()) {
  if (!row || !Number.isFinite(Number(row.eaId)) || !Number.isFinite(Number(row.price)) || Number(row.price) <= 0) return;
  const key = String(row.eaId);
  const list = strictBuyCycleHistory.get(key) || [];
  const last = list[list.length - 1];

  // buildTradingRows can also be called by an HTTP bootstrap. Do not let two
  // calls in the same market minute fake two independent recovery cycles.
  if (last && at - last.t < STRICT_BUY_CYCLE_MIN_GAP_MS) {
    last.price = Number(row.price);
  } else {
    list.push({ t: at, price: Number(row.price) });
  }

  while (list.length > 8) list.shift();
  strictBuyCycleHistory.set(key, list);
}

function strictBuyRecoverySnapshot(row) {
  const list = strictBuyCycleHistory.get(String(row?.eaId)) || [];
  const recent = list.slice(-Math.max(STRICT_BUY_RECOVERY_CYCLES + 1, 4));
  if (!recent.length) {
    return { samples: 0, heldCycles: 0, noNewLow: false, higherLow: false, recoveryLiftPct: 0, currentDecline: false };
  }

  let heldCycles = 1;
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i].price >= recent[i - 1].price) heldCycles += 1;
    else break;
  }

  const prices = recent.map(point => Number(point.price)).filter(Number.isFinite);
  const current = prices[prices.length - 1];
  const previous = prices.length >= 2 ? prices[prices.length - 2] : null;
  const priorPrices = prices.slice(0, -1);
  const priorLow = priorPrices.length ? Math.min(...priorPrices) : current;
  const recentLow = prices.length ? Math.min(...prices) : current;
  const noNewLow = priorPrices.length ? current >= priorLow : false;
  const higherLow = priorPrices.length ? current > priorLow : false;
  const recoveryLiftPct = Number.isFinite(recentLow) && recentLow > 0
    ? Number((((current - recentLow) / recentLow) * 100).toFixed(2))
    : 0;

  return {
    samples: prices.length,
    heldCycles,
    noNewLow,
    higherLow,
    recoveryLiftPct,
    currentDecline: Number.isFinite(previous) ? current < previous : false,
    prices: prices.slice(-4)
  };
}

function strictBuyShortHorizonSnapshot(row) {
  const values = [row?.change1m, row?.change5m, row?.change15m]
    .map(Number)
    .filter(Number.isFinite);
  if (values.length < 3) return { duplicate: false, independentConfirmations: values.length, values };

  const sameDirection = values.every(value => value > 0) || values.every(value => value < 0) || values.every(value => Math.abs(value) < 0.1);
  const spread = Math.max(...values) - Math.min(...values);
  const duplicate = sameDirection && spread <= STRICT_BUY_DUPLICATE_HORIZON_EPS;

  return {
    duplicate,
    independentConfirmations: duplicate ? 1 : values.length,
    spreadPct: Number(spread.toFixed(3)),
    values
  };
}

function strictBuyHistoricalConfidenceCap(row) {
  const learning = row?.aiHistoricalLearning;
  if (!learning?.applied || !Number.isFinite(Number(learning.smoothedAccuracy))) return null;
  const accuracy = Number(learning.smoothedAccuracy);

  // The old system could turn ~42% learned hit rate into 87-90% confidence.
  // v10.37 makes the learned hit rate a real ceiling, not a cosmetic modifier.
  if (accuracy < 40) return 62;
  if (accuracy < 45) return 68;
  if (accuracy < 50) return 72;
  if (accuracy < 55) return 78;
  if (accuracy < 60) return 84;
  return null;
}

function strictBuyLooksLikeRecoveryAfterSelloff(row, work) {
  const quantText = `${work?.quant?.marketState || ""} ${work?.quant?.primaryReason || ""}`.toLowerCase();
  const textSaysRecovery = /(erhol|recovery|abverkauf|selloff|falling knife|boden|bottom|sturz|sell-off)/i.test(quantText);
  const nearLow = Number.isFinite(Number(row?.distanceFrom24hLow)) && Number(row.distanceFrom24hLow) <= 4;
  const recentSelloff =
    Number(row?.change15m || 0) <= -4 ||
    Number(row?.change1h || 0) <= -7 ||
    Number(row?.change24h || 0) <= -12 ||
    (nearLow && Number(row?.change1h || 0) < -2) ||
    (nearLow && Number(row?.change24h || 0) < -8);
  return textSaysRecovery || recentSelloff;
}

function strictBuyFutbinBlock(row) {
  if (!futbinCrossCheckCanInfluenceAlerts(row)) return null;
  if (row?.futbinCrossCheck === "OUTLIER") return "OUTLIER";
  if (row?.futbinCrossCheck === "DIVERGENCE") return "DIVERGENCE";
  return null;
}

function calibrateStrictBuyDecision(row, work) {
  if (!row || row.aiAction !== "JETZT KAUFEN") return row;

  const originalAction = row.aiAction;
  const originalConfidence = Number(row.aiConfidence || 50);
  const short = strictBuyShortHorizonSnapshot(row);
  const recovery = strictBuyRecoverySnapshot(row);
  const recoveryAfterSelloff = strictBuyLooksLikeRecoveryAfterSelloff(row, work);
  const special = String(row.cardType || "").toLowerCase() === "special";
  const historyAccuracy = row?.aiHistoricalLearning?.applied && Number.isFinite(Number(row?.aiHistoricalLearning?.smoothedAccuracy))
    ? Number(row.aiHistoricalLearning.smoothedAccuracy)
    : NaN;
  const historyCap = strictBuyHistoricalConfidenceCap(row);
  const futbinBlock = strictBuyFutbinBlock(row);
  const change15m = Number(row.change15m || 0);
  const change1h = Number(row.change1h || 0);
  const recoveryPrices = Array.isArray(recovery.prices) ? recovery.prices : [];
  const previousCyclePrice = recoveryPrices.length >= 2 ? Number(recoveryPrices[recoveryPrices.length - 2]) : null;
  const cycleDropPct = Number.isFinite(previousCyclePrice) && previousCyclePrice > 0
    ? Number((((Number(row.price) - previousCyclePrice) / previousCyclePrice) * 100).toFixed(2))
    : 0;
  const atFresh24hLow = Number.isFinite(Number(row.low24h)) && Number(row.low24h) > 0
    ? Number(row.price) <= Number(row.low24h) * 1.002
    : false;
  const brokeConfirmedFloor = recovery.currentDecline && atFresh24hLow && cycleDropPct <= -STRICT_BUY_INVALIDATION_DROP_PCT;
  const strongIndependentRecovery =
    recovery.heldCycles >= STRICT_BUY_RECOVERY_CYCLES &&
    recovery.noNewLow &&
    recovery.recoveryLiftPct >= 0.5 &&
    change15m >= 1 &&
    change1h >= 0 &&
    !short.duplicate;

  const blockers = [];
  let severeBlock = false;
  let confidence = originalConfidence;

  if (historyCap != null && confidence > historyCap) confidence = historyCap;

  if (brokeConfirmedFloor) {
    blockers.push(`Der Preis hat den zuletzt bestätigten Boden im nächsten Zyklus um ${Math.abs(cycleDropPct).toFixed(2)}% unterschritten.`);
    severeBlock = true;
  }

  if (short.duplicate && change1h < 1) {
    blockers.push(`1m/5m/15m bewegen sich nahezu identisch und zählen deshalb nur als 1 Bestätigung statt 3.`);
  }

  if (recoveryAfterSelloff) {
    if (recovery.samples < STRICT_BUY_RECOVERY_CYCLES || recovery.heldCycles < STRICT_BUY_RECOVERY_CYCLES) {
      blockers.push(`Erholung erst ${recovery.heldCycles}/${STRICT_BUY_RECOVERY_CYCLES} Marktzyklen gehalten.`);
    }
    if (!recovery.noNewLow) {
      blockers.push("Noch kein bestätigtes Higher-Low/kein neues Tief.");
    }
    if (recovery.currentDecline) {
      blockers.push("Der aktuelle 60-Sekunden-Zyklus macht wieder ein tieferes Preisniveau.");
    }
  }

  if (special && recoveryAfterSelloff) {
    if (change15m < STRICT_BUY_SPECIAL_MIN_15M) {
      blockers.push(`Special-Karte: 15m-Bestätigung zu schwach (${change15m.toFixed(2)}%).`);
    }
    if (change1h < STRICT_BUY_SPECIAL_MIN_1H) {
      blockers.push(`Special-Karte: 1h-Trend noch zu negativ (${change1h.toFixed(2)}%).`);
    }
  }

  if (Number.isFinite(historyAccuracy) && historyAccuracy < 45 && !strongIndependentRecovery) {
    blockers.push(`Historische Trefferquote nur ${historyAccuracy.toFixed(1)}%; ohne starke unabhängige Recovery kein Sofort-Kauf.`);
  }

  if (futbinBlock === "OUTLIER") {
    blockers.push(`FUTBIN-Cross-Check ist ein belastbarer OUTLIER (${Number(row.futbinDiffPct || 0).toFixed(2)}%).`);
    severeBlock = true;
  } else if (futbinBlock === "DIVERGENCE") {
    blockers.push(`FUTBIN-Cross-Check weicht deutlich ab (${Number(row.futbinDiffPct || 0).toFixed(2)}%).`);
  }

  if (blockers.length) {
    row.aiAction = severeBlock ? "NICHT KAUFEN" : "NOCH WARTEN";
    row.aiConfidence = Math.min(confidence, severeBlock ? 82 : 78);
    row.aiRisk = severeBlock ? "hoch" : "mittel";
    row.aiMarketState = severeBlock ? "Kaufsignal durch Cross-Check invalidiert" : "Recovery noch nicht ausreichend bestätigt";
    row.aiReason = `v10.37 Kauf-Guard: ${blockers.join(" ")} Der frühere erste grüne Tick reicht nicht mehr für JETZT KAUFEN.`.slice(0, 1800);
    row.aiRecommendedHorizon = `Noch ${Math.max(0, STRICT_BUY_RECOVERY_CYCLES - recovery.heldCycles)} Recovery-Zyklen bzw. 15m/1h-Bestätigung abwarten`;
  } else {
    row.aiConfidence = Math.max(10, Math.min(95, confidence));
    if (historyCap != null && originalConfidence > historyCap) {
      row.aiReason = `${row.aiReason} Historische Trefferquote deckelt die Confidence auf ${historyCap}%.`.slice(0, 1800);
    }
  }

  row.aiBuyGuard = {
    version: "10.37",
    originalAction,
    originalConfidence,
    finalAction: row.aiAction,
    finalConfidence: row.aiConfidence,
    blocked: blockers.length > 0,
    blockers,
    duplicateShortHorizons: short.duplicate,
    independentShortConfirmations: short.independentConfirmations,
    recoveryAfterSelloff,
    requiredRecoveryCycles: STRICT_BUY_RECOVERY_CYCLES,
    recoveryHeldCycles: recovery.heldCycles,
    recoverySamples: recovery.samples,
    noNewLow: recovery.noNewLow,
    higherLow: recovery.higherLow,
    recoveryLiftPct: recovery.recoveryLiftPct,
    historicalAccuracy: Number.isFinite(historyAccuracy) ? Number(historyAccuracy.toFixed(2)) : null,
    historicalConfidenceCap: historyCap,
    brokeConfirmedFloor,
    cycleDropPct,
    futbinStatus: row.futbinCrossCheck || "NO_DATA",
    futbinDiffPct: Number.isFinite(Number(row.futbinDiffPct)) ? Number(row.futbinDiffPct) : null,
    checkedAt: new Date().toISOString()
  };

  return row;
}

function recordStrictBuyGuardOutcome(row) {
  const guard = row?.aiBuyGuard;
  if (!guard || guard.recorded) return;
  guard.recorded = true;
  strictBuyGuardStats.evaluatedBuyCandidates += 1;
  if (guard.blocked) strictBuyGuardStats.blockedBuyCandidates += 1;
  else strictBuyGuardStats.allowedBuyCandidates += 1;
  if (Number.isFinite(guard.historicalConfidenceCap) && guard.originalConfidence > guard.historicalConfidenceCap) strictBuyGuardStats.confidenceCapped += 1;
  if (guard.blocked && guard.duplicateShortHorizons) strictBuyGuardStats.duplicateHorizonBlocks += 1;
  if (guard.blocked && guard.recoveryAfterSelloff && guard.recoveryHeldCycles < guard.requiredRecoveryCycles) strictBuyGuardStats.recoveryBlocks += 1;
  if (guard.blocked && Number.isFinite(guard.historicalAccuracy) && guard.historicalAccuracy < 45) strictBuyGuardStats.historicalBlocks += 1;
  if (guard.blocked && ["DIVERGENCE", "OUTLIER"].includes(String(guard.futbinStatus))) strictBuyGuardStats.futbinBlocks += 1;
  strictBuyGuardStats.lastDecision = {
    eaId: row.eaId,
    player: row.name,
    originalAction: guard.originalAction,
    finalAction: guard.finalAction,
    originalConfidence: guard.originalConfidence,
    finalConfidence: guard.finalConfidence,
    blockers: guard.blockers,
    at: guard.checkedAt
  };
  strictBuyGuardStats.updatedAt = new Date().toISOString();
}

function normalizeDecisionForPosition(row, decision) {
  if (!decision || decision.action !== "VERKAUF PRÜFEN") return decision;

  const profit = Number.isFinite(row.profitPercent) ? row.profitPercent : null;
  const netProfitTotal = Number.isFinite(row.netProfitTotal) ? row.netProfitTotal : null;
  const nearHigh =
    Number.isFinite(row.high24h) &&
    row.high24h > 0 &&
    row.price >= row.high24h * 0.97;

  const strongRun =
    (Number.isFinite(row.change15m) && row.change15m >= 10) ||
    (Number.isFinite(row.change1h) && row.change1h >= 12) ||
    (Number.isFinite(row.change24h) && row.change24h >= 18);

  const momentumCooling =
    (Number.isFinite(row.change1m) && row.change1m < 0) ||
    (
      Number.isFinite(row.change1m) &&
      Number.isFinite(row.change5m) &&
      row.change1m <= 0.5 &&
      row.change5m <= 3
    ) ||
    (
      Number.isFinite(row.change5m) &&
      Number.isFinite(row.change15m) &&
      row.change5m <= row.change15m - 2
    );

  // Verkaufshinweise sind nur für Karten sinnvoll, die der Nutzer wirklich besitzt.
  if (!row.tracked) {
    return {
      ...decision,
      action: "NICHT KAUFEN",
      confidence: Math.max(80, Math.min(92, decision.confidence ?? 82)),
      risk: "hoch",
      market_state: "stark gestiegen / Einstieg unattraktiv",
      reason: "Karte notiert nach starkem Anstieg nahe dem 24h-Hoch. Ohne eigenen Bestand kein Verkaufssignal: nicht hinterherkaufen, Rücksetzer abwarten.",
      recommended_horizon: "Rücksetzer abwarten"
    };
  }

  // Kein echter Netto-Gewinn nach EA-Steuer -> nicht vorschnell verkaufen.
  if (profit === null || profit < 6) {
    return {
      ...decision,
      action: "HALTEN",
      confidence: 78,
      risk: "mittel",
      market_state: "Position noch ohne ausreichende Gewinnmarge",
      reason: profit === null
        ? "Eigener Bestand erkannt, aber die Netto-Gewinnmarge ist noch nicht belastbar. Position weiter beobachten."
        : `Nach 5% EA-Steuer liegt der Netto-Gewinn erst bei ${profit.toFixed(2)}%. Für ein Verkaufssignal ist die Marge noch zu klein.`,
      recommended_horizon: "Weiter beobachten"
    };
  }

  // v10.33: VERKAUF PRÜFEN ist nur noch die Vorstufe. Wenn Gewinn UND Exit-
  // Bestätigung stark genug sind, sagt der Brain klar JETZT VERKAUFEN.
  const clearSellNow =
    (profit >= 15 && nearHigh) ||
    (profit >= 8 && nearHigh && strongRun && momentumCooling);

  if (clearSellNow) {
    const coins = netProfitTotal == null ? "" : ` (${Math.round(netProfitTotal).toLocaleString("de-DE")} Coins netto)`;
    return {
      ...decision,
      action: "JETZT VERKAUFEN",
      confidence: Math.max(90, Math.min(95, decision.confidence ?? 90)),
      risk: "niedrig",
      market_state: "Gewinnmitnahme bestätigt",
      reason: `Nach 5% EA-Steuer liegt dein Netto-Gewinn bei +${profit.toFixed(2)}%${coins}. Die Karte steht nahe dem 24h-Hoch${momentumCooling ? " und das kurzfristige Momentum kühlt ab" : ""}. Der Exit ist ausreichend bestätigt: jetzt verkaufen.`,
      recommended_horizon: "Jetzt verkaufen / Gewinn sichern"
    };
  }

  // Gute Marge, aber noch keine harte Exit-Bestätigung: erst prüfen, nicht blind verkaufen.
  if (profit >= 6 && nearHigh) {
    return {
      ...decision,
      action: "VERKAUF PRÜFEN",
      confidence: Math.max(84, Math.min(93, decision.confidence ?? 86)),
      risk: "niedrig",
      market_state: "Gewinnposition nahe möglichem Exit",
      reason: `Nach 5% EA-Steuer liegt dein Netto-Gewinn bei +${profit.toFixed(2)}%. Die Karte notiert nahe dem 24h-Hoch, aber der Exit ist noch nicht stark genug bestätigt. Verkauf prüfen, noch nicht blind aussteigen.`,
      recommended_horizon: "Exit-Signal beobachten"
    };
  }

  return {
    ...decision,
    action: "HALTEN",
    confidence: 82,
    risk: "niedrig",
    market_state: "Gewinnposition mit weiter laufendem Momentum",
    reason: `Eigener Bestand liegt bei +${profit.toFixed(2)}% Netto-Gewinn, aber der Aufwärtstrend ist noch nicht klar ausgelaufen. Weiter halten und Momentum beobachten.`,
    recommended_horizon: "Momentum weiter beobachten"
  };
}

async function buildTradingRows(futbinFeedOverride = null) {
  const [cards, bulk, positions, intensiveWatches, allSignals, traderProfiles, brainLearning, marketKnowledgeProfiles, performanceProfiles] = await Promise.all([
    ensureUniverse(false),
    loadBulkPs5Prices(false),
    getPositions(),
    getIntensiveWatchlist(),
    loadRecentDiscordSignals(),
    loadTraderProfiles(),
    loadBrainLearningProfiles(false),
    loadMarketKnowledgeProfiles(),
    loadDecisionPerformanceProfiles(false)
  ]);

  const futbinFeed = futbinFeedOverride || await loadAuthorizedFutbinFeedSafe(false);
  const current = currentPricedCards(cards, bulk);
  const ids = current.map(row => row.eaId);
  const now = Date.now();
  const activeSignals = allSignals.filter(signal => traderSignalIsActive(signal, now));

  const thresholds = {
    m1: now - 60_000,
    m5: now - 5 * 60_000,
    m15: now - 15 * 60_000,
    h1: now - 60 * 60_000,
    h24: now - 24 * 60 * 60_000,
    d7: now - 7 * 24 * 60 * 60_000,
    d30: now - 30 * 24 * 60 * 60_000
  };

  let p1m = new Map();
  let p5m = new Map();
  let p15m = new Map();
  let p1h = new Map();
  let p24h = new Map();
  let p7d = new Map();
  let p30d = new Map();
  let ranges24h = new Map();

  if (dbEnabled) {
    [p1m, p5m, p15m, p1h, p24h, p7d, p30d, ranges24h] = await Promise.all([
      lookupDb(ids, thresholds.m1),
      lookupDb(ids, thresholds.m5),
      lookupDb(ids, thresholds.m15),
      lookupDb(ids, thresholds.h1),
      lookupDb(ids, thresholds.h24),
      lookupDb(ids, thresholds.d7),
      lookupDb(ids, thresholds.d30),
      rangeDb(ids, thresholds.h24)
    ]);
  }

  const rows = current.map(card => {
    const key = String(card.eaId);

    const old1m = (dbEnabled ? p1m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m1);
    const old5m = (dbEnabled ? p5m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m5);
    const old15m = (dbEnabled ? p15m.get(key) : null) ?? lookupMemory(card.eaId, thresholds.m15);
    const old1h = (dbEnabled ? p1h.get(key) : null) ?? lookupMemory(card.eaId, thresholds.h1);
    const old24h = (dbEnabled ? p24h.get(key) : null) ?? lookupMemory(card.eaId, thresholds.h24);
    const old7d = (dbEnabled ? p7d.get(key) : null) ?? lookupMemory(card.eaId, thresholds.d7);
    const old30d = (dbEnabled ? p30d.get(key) : null) ?? lookupMemory(card.eaId, thresholds.d30);

    const range = dbEnabled
      ? ranges24h.get(key) ?? { low: null, high: null }
      : rangeMemory(card.eaId, thresholds.h24);

    const row = {
      eaId: card.eaId,
      name: card.name,
      overall: card.overall,
      cardType: card.cardType,
      rarityName: card.rarityName,
      position: card.position,
      club: card.club,
      url: card.url,
      price: card.price,
      change1m: changePct(card.price, old1m),
      change5m: changePct(card.price, old5m),
      change15m: changePct(card.price, old15m),
      change1h: changePct(card.price, old1h),
      change24h: changePct(card.price, old24h),
      change7d: changePct(card.price, old7d),
      change30d: changePct(card.price, old30d),
      low24h: range.low ?? card.price,
      high24h: range.high ?? card.price,
      distanceFrom24hLow: distancePct(card.price, range.low),
      tracked: positions.has(key),
      intensiveWatch: intensiveWatches.has(key)
    };

    Object.assign(row, signalFor(row));
    Object.assign(row, profitInfo(card.price, positions.get(key)));
    Object.assign(row, futbinCrossCheckFields(card.eaId, card.price, futbinFeed));
    row.dataSource = "FUT.GG";
    return row;
  });

  const ratingStats = buildRatingStats(rows);
  const globalMarketContext = buildGlobalMarketContext(rows);
  latestMarketContext = globalMarketContext;
  const brainWork = new Map();

  for (const row of rows) {
    registerStrictBuyCycle(row, now);

    const rating = ratingStats[row.overall] || {
      trend: "neutral",
      risingPct: 0,
      fallingPct: 0
    };

    const signals = matchingSignalsForRow(row, activeSignals);
    const knowledgeContext = marketKnowledgeContextForRow(row, activeSignals, marketKnowledgeProfiles);

    const input = {
      playerName: row.name || `EA ${row.eaId}`,
      eaId: row.eaId,
      rating: row.overall,
      cardType: row.cardType,
      currentPrice: row.price,
      change1m: row.change1m ?? 0,
      change5m: row.change5m ?? 0,
      change15m: row.change15m ?? 0,
      change1h: row.change1h ?? 0,
      change24h: row.change24h ?? 0,
      change7d: row.change7d ?? 0,
      change30d: row.change30d ?? 0,
      low24h: row.low24h ?? row.price,
      high24h: row.high24h ?? row.price,
      distanceTo24hLow: row.distanceFrom24hLow ?? 0,
      ratingMarketTrend: rating.trend,
      ratingMarketRisingPct: rating.risingPct,
      ratingMarketFallingPct: rating.fallingPct,
      marketContext: {
        packSupplyActive: globalMarketContext.packSupplyActive,
        overallMarketMood: globalMarketContext.mood,
        contextConfidence: globalMarketContext.confidence,
        contextSource: globalMarketContext.source,
        packSupplyInference: globalMarketContext.packSupplyInference
      },
      discordSignals: signals
    };

    const quant = analyzeMarketPatterns(input);
    const confluence = evaluateDiscordSignals(signals, input, quant, traderProfiles);
    const rawDecision = baseDecisionFromQuant(quant, confluence);
    const normalizedDecision = normalizeDecisionForPosition(row, rawDecision);
    const learningProfile = selectBrainLearningProfile(
      brainLearning,
      normalizedDecision?.action === "JETZT VERKAUFEN" ? "VERKAUF PRÜFEN" : normalizedDecision?.action,
      row.cardType,
      row.overall,
      input
    );
    const decision = applyBrainLearningToDecision(normalizedDecision, learningProfile);
    applyDecisionToRow(row, decision);
    calibrateStrictBuyDecision(row, { input, quant, confluence, learningProfile });
    applyMarketKnowledgeLayer(row, knowledgeContext);
    applyDecisionPerformanceCalibration(row, performanceProfiles);

    row.ratingMarketTrend = rating.trend;
    row.ratingMarketRisingPct = rating.risingPct;
    row.ratingMarketFallingPct = rating.fallingPct;
    row.ratingMarketMedianPrice = Number.isFinite(Number(rating.medianPrice)) ? Number(rating.medianPrice) : null;
    row.globalMarketMood = globalMarketContext.mood;
    row.packSupplyActive = globalMarketContext.packSupplyActive;
    row.marketContextConfidence = globalMarketContext.confidence;
    applyAlertSanityGuard(row);

    brainWork.set(String(row.eaId), {
      input,
      quant,
      confluence,
      learningProfile,
      knowledgeContext,
      performanceCalibration: row.aiPerformanceCalibration || null
    });
  }

  await persistDiscordSignalMarketConfirmations(rows, brainWork);

  const aiPriority = {
    "JETZT VERKAUFEN": 7,
    "JETZT KAUFEN": 6,
    "VERKAUF PRÜFEN": 5,
    "NOCH WARTEN": 4,
    "NICHT KAUFEN": 3,
    "BEOBACHTEN": 2,
    "HALTEN": 1
  };

  rows.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    if (a.intensiveWatch !== b.intensiveWatch) return a.intensiveWatch ? -1 : 1;
    const actionDiff = (aiPriority[b.aiAction] ?? 0) - (aiPriority[a.aiAction] ?? 0);
    if (actionDiff !== 0) return actionDiff;
    if (b.aiConfidence !== a.aiConfidence) return b.aiConfidence - a.aiConfidence;
    return Math.abs(b.change5m ?? b.change1m ?? 0) - Math.abs(a.change5m ?? a.change1m ?? 0);
  });

  return { rows, brainWork, ratingStats };
}

function candidateScore(row, work) {
  const actionScore = {
    "JETZT VERKAUFEN": 110,
    "JETZT KAUFEN": 100,
    "VERKAUF PRÜFEN": 95,
    "NOCH WARTEN": 85,
    "NICHT KAUFEN": 80,
    "BEOBACHTEN": 45,
    "HALTEN": 10
  }[row.aiAction] || 0;

  const movement =
    Math.min(40, Math.abs(row.change1m ?? 0) * 2) +
    Math.min(30, Math.abs(row.change5m ?? 0)) +
    Math.min(20, Math.abs(row.change15m ?? 0) * 0.5);

  const marketBreadth = Math.max(
    row.ratingMarketRisingPct ?? 0,
    row.ratingMarketFallingPct ?? 0
  ) >= 70 ? 20 : 0;

  const discordBonus = work.confluence.signalCount > 0 ? 10 : 0;
  return actionScore + movement + marketBreadth + discordBonus;
}

async function saveDecisionIfNeeded(row, work, decision, forceGemini = false) {
  if (!dbEnabled) return null;

  const storageAction = decision.action === "JETZT VERKAUFEN" ? "VERKAUF PRÜFEN" : decision.action;
  const important =
    ["JETZT KAUFEN", "VERKAUF PRÜFEN", "JETZT VERKAUFEN", "NICHT KAUFEN"].includes(decision.action) ||
    (decision.action === "NOCH WARTEN" && (Math.abs(row.change1m ?? 0) >= 5 || Math.abs(row.change5m ?? 0) >= 10));

  if (!important && !forceGemini) return null;

  const recent = await pool.query(`
    SELECT id, ai_model_used
    FROM fc_trader_brain_decisions
    WHERE ea_id = $1
      AND action = $2
      AND created_at >= NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 1
  `, [String(row.eaId), storageAction]);

  if (recent.rowCount) {
    const oldModel = String(recent.rows[0].ai_model_used || "");
    if (!forceGemini || oldModel.includes("Gemini")) return null;
  }

  const id = `dec_${row.eaId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  await pool.query(`
    INSERT INTO fc_trader_brain_decisions (
      id, ea_id, player_name, rating, card_type, initial_price,
      action, confidence, reason, risk, market_state,
      ea_tax_break_even, ai_model_used, input_snapshot, decision_payload
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb
    )
  `, [
    id,
    String(row.eaId),
    row.name || `EA ${row.eaId}`,
    row.overall,
    row.cardType,
    row.price,
    storageAction,
    decision.confidence,
    decision.reason,
    decision.risk,
    decision.market_state,
    decision.eaTaxBreakEven || Math.ceil(row.price / 0.95),
    decision.ai_model_used || "Quantitative Core",
    JSON.stringify(work.input),
    JSON.stringify(decision)
  ]);

  return id;
}

async function automaticTraderBrain(rows, brainWork) {
  try {
    const candidates = [];

    for (const row of rows) {
      const work = brainWork.get(String(row.eaId));
      if (!work) continue;
      const gate = shouldUseGemini(work.input, work.quant, work.confluence);
      if (!gate.useGemini) continue;
      candidates.push({ row, work, gate, score: candidateScore(row, work) });
    }

    candidates.sort((a, b) => b.score - a.score);

    const quota = getGeminiQuotaInfo();
    const now = Date.now();
    let geminiCandidate = null;

    if (
      process.env.GEMINI_API_KEY &&
      !quota.quotaExhausted &&
      now - lastGeminiAttemptAt >= GEMINI_MIN_INTERVAL_MS
    ) {
      geminiCandidate = candidates.find(item => {
        const key = `${item.row.eaId}|${item.row.aiAction}`;
        const last = lastGeminiByCard.get(key) || 0;
        return now - last >= GEMINI_CARD_COOLDOWN_MS;
      }) || null;
    }

    if (geminiCandidate) {
      lastGeminiAttemptAt = now;
      const rawDecision = await generateAiTraderDecision(
        geminiCandidate.work.input,
        geminiCandidate.work.quant,
        geminiCandidate.work.confluence
      );

      const normalizedDecision = normalizeDecisionForPosition(geminiCandidate.row, rawDecision);
      const learningProfile = selectBrainLearningProfile(
        brainLearningCache,
        normalizedDecision?.action === "JETZT VERKAUFEN" ? "VERKAUF PRÜFEN" : normalizedDecision?.action,
        geminiCandidate.row.cardType,
        geminiCandidate.row.overall,
        geminiCandidate.work.input
      );
      const decision = applyBrainLearningToDecision(normalizedDecision, learningProfile);
      applyDecisionToRow(geminiCandidate.row, decision);
      calibrateStrictBuyDecision(geminiCandidate.row, {
        ...geminiCandidate.work,
        learningProfile
      });
      applyMarketKnowledgeLayer(geminiCandidate.row, geminiCandidate.work.knowledgeContext || []);
      applyDecisionPerformanceCalibration(geminiCandidate.row, decisionPerformanceCache);
      lastGeminiCandidate = {
        eaId: geminiCandidate.row.eaId,
        player: geminiCandidate.row.name,
        action: decision.action,
        model: decision.ai_model_used,
        at: new Date().toISOString(),
        trigger: geminiCandidate.gate.triggerReason
      };

      lastGeminiByCard.set(
        `${geminiCandidate.row.eaId}|${decision.action}`,
        now
      );

      const calibratedGeminiDecision = {
        ...decision,
        action: geminiCandidate.row.aiAction,
        confidence: geminiCandidate.row.aiConfidence,
        reason: geminiCandidate.row.aiReason,
        risk: geminiCandidate.row.aiRisk,
        market_state: geminiCandidate.row.aiMarketState,
        recommended_horizon: geminiCandidate.row.aiRecommendedHorizon,
        buy_guard: geminiCandidate.row.aiBuyGuard || null
      };

      await saveDecisionIfNeeded(
        geminiCandidate.row,
        geminiCandidate.work,
        calibratedGeminiDecision,
        String(decision.ai_model_used || "").includes("Gemini")
      );
    }

    if (dbEnabled) {
      const notable = rows
        .filter(row =>
          ["JETZT KAUFEN", "VERKAUF PRÜFEN", "JETZT VERKAUFEN", "NICHT KAUFEN"].includes(row.aiAction) ||
          (row.aiAction === "NOCH WARTEN" && (Math.abs(row.change1m ?? 0) >= 5 || Math.abs(row.change5m ?? 0) >= 10))
        )
        .sort((a, b) => b.aiConfidence - a.aiConfidence)
        .slice(0, 8);

      for (const row of notable) {
        const work = brainWork.get(String(row.eaId));
        if (!work) continue;
        const decision = {
          action: row.aiAction,
          confidence: row.aiConfidence,
          reason: row.aiReason,
          risk: row.aiRisk,
          market_state: row.aiMarketState,
          context_breakdown: row.aiContext,
          key_factors: row.aiKeyFactors,
          entry_zone: row.aiEntryZone,
          target_exit_zone: row.aiTargetExitZone,
          trader_signals_confluence: row.aiTraderConfluence,
          historical_learning: row.aiHistoricalLearning,
          market_knowledge: row.aiMarketKnowledge || null,
          performance_calibration: row.aiPerformanceCalibration || null,
          recommended_horizon: row.aiRecommendedHorizon,
          eaTaxBreakEven: Math.ceil(row.price / 0.95),
          ai_model_used: row.aiModelUsed
        };
        await saveDecisionIfNeeded(row, work, decision, false);
      }
    }

    lastBrainRunAt = new Date().toISOString();
    lastBrainError = null;
  } catch (error) {
    lastBrainError = String(error);
    console.error("Trader Brain error:", error);
  }
}

async function priceAtOrBefore(eaId, targetMs) {
  if (!dbEnabled) return null;

  const result = await pool.query(`
    SELECT price
    FROM fc_price_history
    WHERE ea_id = $1
      AND recorded_at <= $2
    ORDER BY recorded_at DESC
    LIMIT 1
  `, [String(eaId), new Date(targetMs).toISOString()]);

  return result.rowCount ? Number(result.rows[0].price) : null;
}

async function evaluatePendingDecisions() {
  if (!dbEnabled) return;
  if (Date.now() - lastEvaluationSweepAt < 5 * 60_000) return;
  lastEvaluationSweepAt = Date.now();

  const result = await pool.query(`
    SELECT
      d.*,
      e.price_after_5m,
      e.price_after_15m,
      e.price_after_30m,
      e.price_after_1h,
      e.price_after_3h,
      e.price_after_6h,
      e.price_after_24h
    FROM fc_trader_brain_decisions d
    LEFT JOIN fc_decision_evaluations e ON e.decision_id = d.id
    WHERE d.created_at >= NOW() - INTERVAL '30 hours'
    ORDER BY d.created_at DESC
    LIMIT 200
  `);

  const now = Date.now();

  for (const record of result.rows) {
    const created = new Date(record.created_at).getTime();
    const tracked = {
      after5m: record.price_after_5m == null ? null : Number(record.price_after_5m),
      after15m: record.price_after_15m == null ? null : Number(record.price_after_15m),
      after30m: record.price_after_30m == null ? null : Number(record.price_after_30m),
      after1h: record.price_after_1h == null ? null : Number(record.price_after_1h),
      after3h: record.price_after_3h == null ? null : Number(record.price_after_3h),
      after6h: record.price_after_6h == null ? null : Number(record.price_after_6h),
      after24h: record.price_after_24h == null ? null : Number(record.price_after_24h)
    };

    const horizons = [
      ["after5m", 5 * 60_000],
      ["after15m", 15 * 60_000],
      ["after30m", 30 * 60_000],
      ["after1h", 60 * 60_000],
      ["after3h", 3 * 60 * 60_000],
      ["after6h", 6 * 60 * 60_000],
      ["after24h", 24 * 60 * 60_000]
    ];

    let changed = false;
    for (const [field, offset] of horizons) {
      if (tracked[field] == null && now >= created + offset) {
        tracked[field] = await priceAtOrBefore(record.ea_id, created + offset);
        if (tracked[field] != null) changed = true;
      }
    }

    if (!changed && Object.values(tracked).every(value => value == null)) continue;

    const evaluation = evaluateTrackedDecision(
      record.action,
      Number(record.initial_price),
      tracked
    );
    const performance = enhancedDecisionPerformance(record, tracked, evaluation);

    await pool.query(`
      INSERT INTO fc_decision_evaluations (
        decision_id,
        price_after_5m,
        price_after_15m,
        price_after_30m,
        price_after_1h,
        price_after_3h,
        price_after_6h,
        price_after_24h,
        roi_5m,
        roi_15m,
        roi_30m,
        roi_1h,
        roi_3h,
        roi_6h,
        roi_24h,
        net_roi_5m,
        net_roi_15m,
        net_roi_30m,
        net_roi_1h,
        net_roi_3h,
        net_roi_6h,
        net_roi_24h,
        max_roi,
        best_net_roi,
        worst_move_pct,
        was_correct,
        outcome_score,
        missed_entry,
        false_buy,
        sell_timing_score,
        outcome_class,
        confidence_error,
        notes,
        evaluated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,NOW()
      )
      ON CONFLICT (decision_id)
      DO UPDATE SET
        price_after_5m = EXCLUDED.price_after_5m,
        price_after_15m = EXCLUDED.price_after_15m,
        price_after_30m = EXCLUDED.price_after_30m,
        price_after_1h = EXCLUDED.price_after_1h,
        price_after_3h = EXCLUDED.price_after_3h,
        price_after_6h = EXCLUDED.price_after_6h,
        price_after_24h = EXCLUDED.price_after_24h,
        roi_5m = EXCLUDED.roi_5m,
        roi_15m = EXCLUDED.roi_15m,
        roi_30m = EXCLUDED.roi_30m,
        roi_1h = EXCLUDED.roi_1h,
        roi_3h = EXCLUDED.roi_3h,
        roi_6h = EXCLUDED.roi_6h,
        roi_24h = EXCLUDED.roi_24h,
        net_roi_5m = EXCLUDED.net_roi_5m,
        net_roi_15m = EXCLUDED.net_roi_15m,
        net_roi_30m = EXCLUDED.net_roi_30m,
        net_roi_1h = EXCLUDED.net_roi_1h,
        net_roi_3h = EXCLUDED.net_roi_3h,
        net_roi_6h = EXCLUDED.net_roi_6h,
        net_roi_24h = EXCLUDED.net_roi_24h,
        max_roi = EXCLUDED.max_roi,
        best_net_roi = EXCLUDED.best_net_roi,
        worst_move_pct = EXCLUDED.worst_move_pct,
        was_correct = EXCLUDED.was_correct,
        outcome_score = EXCLUDED.outcome_score,
        missed_entry = EXCLUDED.missed_entry,
        false_buy = EXCLUDED.false_buy,
        sell_timing_score = EXCLUDED.sell_timing_score,
        outcome_class = EXCLUDED.outcome_class,
        confidence_error = EXCLUDED.confidence_error,
        notes = EXCLUDED.notes,
        evaluated_at = NOW()
    `, [
      record.id,
      tracked.after5m,
      tracked.after15m,
      tracked.after30m,
      tracked.after1h,
      tracked.after3h,
      tracked.after6h,
      tracked.after24h,
      evaluation.roi5m,
      evaluation.roi15m,
      performance.roi30m,
      evaluation.roi1h,
      performance.roi3h,
      evaluation.roi6h,
      evaluation.roi24h,
      performance.netRoi5m,
      performance.netRoi15m,
      performance.netRoi30m,
      performance.netRoi1h,
      performance.netRoi3h,
      performance.netRoi6h,
      performance.netRoi24h,
      evaluation.maxRoi,
      performance.bestNetRoi,
      performance.worstMovePct,
      evaluation.wasCorrect,
      evaluation.outcomeScore,
      performance.missedEntry,
      performance.falseBuy,
      performance.sellTimingScore,
      performance.outcomeClass,
      performance.confidenceError,
      evaluation.notes
    ]);

    // Neue Outcomes sollen spaetestens im naechsten Marktzyklus in Confidence
    // und Abstain-Zone einfliessen.
    decisionPerformanceCache.loadedAt = 0;
  }
}

app.get("/", (req, res) => {
  res.json({
    online: true,
    service: "FC Trading Intelligence",
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    marketProfile: marketProfile(),
    refreshSeconds: 60,
    storage:
      dbEnabled
        ? "Postgres + memory fallback"
        : "memory only",
    endpoints: {
      trading: "GET /trading",
      tradingData: "GET /api/trading",
      positionSave: "POST /api/position",
      positionDelete: "DELETE /api/position/:eaId",
      intensiveWatchlist: "GET /api/intensive-watchlist",
      intensiveWatchAdd: "POST /api/intensive-watch/:eaId",
      intensiveWatchDelete: "DELETE /api/intensive-watch/:eaId",
      traderBrainStatus: "GET /api/trader-brain/status",
      ratingIntelligence: "GET /api/ratings-intelligence",
      traderBrainHistory: "GET /api/trader-brain/feedback/history",
      traderBrainLearning: "GET /api/trader-brain/learning/status",
      decisionPerformance: "GET /api/trader-brain/performance/status",
      geminiHealth: "GET /api/gemini-health",
      discordStatus: "GET /api/discord/status",
      traderSignalsStatus: "GET /api/trader-signals/status",
      authorizedTraderFeedStatus: "GET /api/trader-feeds/status",
      authorizedTraderFeedIngest: "POST /api/trader-signals/ingest",
      traderConfluenceStatus: "GET /api/trader-confluence/status",
      traderReliabilityStatus: "GET /api/trader-reliability/status",
      traderSourcesStatus: "GET /api/trader-sources/status",
      leakImpactStatus: "GET /api/leak-impact/status",
      marketKnowledgeStatus: "GET /api/market-knowledge/status",
      marketContext: "GET /api/market-context",
      sourceHealth: "GET /api/source-health",
      processingHealth: "GET /api/processing-health",
      futbinStatus: "GET /api/futbin/status",
      safeStaleMode: "GET /api/trading",
      readiness: "GET /api/readiness",
      health: "GET /health"
    }
  });
});

function runtimeReadinessSnapshot() {
  const now = Date.now();
  const source = sourceHealthSnapshot();
  const monitorAtMs = lastMonitorAt ? new Date(lastMonitorAt).getTime() : 0;
  const brainAtMs = lastBrainRunAt ? new Date(lastBrainRunAt).getTime() : 0;
  const monitorMaxAgeMs = Math.max(PRICE_REFRESH_MS * 4, SOURCE_HEALTH_STALE_MS);
  const brainMaxAgeMs = Math.max(PRICE_REFRESH_MS * 5, 5 * 60_000);
  const monitorAgeMs = monitorAtMs ? Math.max(0, now - monitorAtMs) : null;
  const brainAgeMs = brainAtMs ? Math.max(0, now - brainAtMs) : null;

  const checks = {
    runtimeState: {
      ok: shuttingDown !== true,
      shuttingDown,
      shutdownStartedAt,
      shutdownReason
    },
    monitoringLoop: {
      ok: monitoringStarted === true && monitorAtMs > 0 && monitorAgeMs <= monitorMaxAgeMs,
      lastAt: lastMonitorAt,
      ageSeconds: monitorAgeMs == null ? null : Math.round(monitorAgeMs / 1000),
      maxAgeSeconds: Math.round(monitorMaxAgeMs / 1000),
      busy: monitoringBusy
    },
    primaryMarketSource: {
      ok: source.tradingAllowed === true,
      status: source.status,
      reason: source.reason,
      recoveryPending: source.recoveryPending,
      coveragePct: source.coveragePct
    },
    processingPipeline: {
      ok: processingHealthSnapshot().healthy === true,
      ...processingHealthSnapshot()
    },
    safeMarketSnapshot: {
      ok: latestTradingRows.length > 0,
      cards: latestTradingRows.length,
      updatedAt: lastMonitorAt || source.lastSuccessAt || null
    },
    persistentDatabase: {
      ok: dbEnabled === true,
      mode: dbEnabled ? "PostgreSQL" : "memory-only"
    },
    discordGateway: {
      ok: DISCORD_CONFIGURED === true && discordClientReady === true && Boolean(discordResolvedChannelId),
      configured: DISCORD_CONFIGURED,
      gatewayReady: discordClientReady,
      channelId: discordResolvedChannelId,
      lastError: lastDiscordError
    },
    traderBrainLoop: {
      ok: brainAtMs > 0 && brainAgeMs <= brainMaxAgeMs && !lastBrainError,
      lastAt: lastBrainRunAt,
      ageSeconds: brainAgeMs == null ? null : Math.round(brainAgeMs / 1000),
      maxAgeSeconds: Math.round(brainMaxAgeMs / 1000),
      lastError: lastBrainError
    }
  };

  const failed = Object.entries(checks)
    .filter(([, value]) => value.ok !== true)
    .map(([name]) => name);

  return {
    ready: failed.length === 0,
    status: failed.length === 0 ? "READY" : "NOT_READY",
    failedChecks: failed,
    checks,
    optional: {
      futbinConfigured: Boolean(FUTBIN_AUTHORIZED_FEED_URL || FUTBIN_PARSE_API_KEY),
      futbinStatus: FUTBIN_AUTHORIZED_FEED_URL ? latestFutbinStatus.status : latestFutbinParseStatus.status,
      futbinTrusted: latestFutbinCrossCheckHealth.trusted === true,
      futbinPublicApi: latestFutbinParseStatus,
      authorizedTraderFeedConfigured: TRADER_FEED_INGEST_CONFIGURED,
      geminiQuota: getGeminiQuotaInfo()
    },
    uptimeSeconds: Math.round(process.uptime()),
    checkedAt: new Date().toISOString()
  };
}

app.get("/api/readiness", (req, res) => {
  const readiness = runtimeReadinessSnapshot();
  res.status(readiness.ready ? 200 : 503).json({
    ok: readiness.ready,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    readiness,
    note: "Dieser Endpunkt ist absichtlich strenger als /health. /health zeigt, ob der Webdienst lebt; /api/readiness zeigt, ob Marktquelle, Monitoring, Datenbank, Discord und Trader Brain wirklich produktionsbereit sind."
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    marketProfile: marketProfile(),
    marketContext: latestMarketContext,
    sourceHealth: sourceHealthSnapshot(),
    processingHealth: processingHealthSnapshot(),
    runtime: {
      shuttingDown,
      shutdownStartedAt,
      shutdownReason
    },
    futbin: {
      authorizedFeed: latestFutbinStatus,
      publicApi: latestFutbinParseStatus
    },
    monitoringStarted,
    monitoringBusy,
    lastMonitorAt,
    lastMonitorError,
    cardsKnown: universe.length,
    dbEnabled,
    traderBrainAutomatic: true,
    lastBrainRunAt,
    lastBrainError,
    brainLearning: {
      totalMatureDecisions: brainLearningCache.totalMatureDecisions,
      rawMatureDecisions: brainLearningCache.rawMatureDecisions,
      uniqueLearningEpisodes: brainLearningCache.uniqueLearningEpisodes,
      updatedAt: brainLearningCache.updatedAt,
      lastError: lastBrainLearningError
    },
    decisionPerformanceLab: {
      enabled: dbEnabled,
      totalMature: decisionPerformanceCache.totalMature,
      updatedAt: decisionPerformanceCache.updatedAt,
      calibrationProfiles: decisionPerformanceCache.profileList.length,
      horizonsMinutes: [5, 15, 30, 60, 180, 360, 1440]
    },
    geminiQuota: getGeminiQuotaInfo(),
    discord: {
      configured: DISCORD_CONFIGURED,
      channelConfigured: Boolean(DISCORD_ALERT_CHANNEL_ID),
      tokenConfigured: Boolean(DISCORD_BOT_TOKEN),
      gatewayReady: discordClientReady,
      botTag: discordBotTag,
      guildCount: discordGuildCount,
      resolvedChannelId: discordResolvedChannelId,
      resolvedChannelName: discordResolvedChannelName,
      traderSignalChannelConfigured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
      traderSignalChannelId: traderSignalResolvedChannelId,
      traderSignalChannelName: traderSignalResolvedChannelName,
      traderSignalsReceived,
      traderSignalsAccepted,
      traderSignalsIgnored,
      lastTraderSignalAt,
      lastTraderSignalError,
      authorizedTraderFeed: {
        configured: TRADER_FEED_INGEST_CONFIGURED,
        received: authorizedTraderFeedReceived,
        accepted: authorizedTraderFeedAccepted,
        ignored: authorizedTraderFeedIgnored,
        rateLimited: authorizedTraderFeedRateLimited,
        replayRejected: authorizedTraderFeedReplayRejected,
        sourceRejected: authorizedTraderFeedSourceRejected,
        sourceAllowlistRequired: TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST,
        allowedSourceCount: TRADER_FEED_ALLOWED_SOURCE_MAP.size,
        lastAt: lastAuthorizedTraderFeedAt,
        lastSource: lastAuthorizedTraderFeedSource,
        lastError: lastAuthorizedTraderFeedError
      },
      traderConfluenceAlertsSent,
      lastTraderConfluenceAlertAt,
      lastTraderConfluenceAlertError,
      traderConfluenceSuppressedLowReliability: traderConfluenceSuppressedSignals.size,
      lastTraderConfluenceGate,
      alertsSent: discordAlertsSent,
      lastSendAt: lastDiscordSendAt,
      lastError: lastDiscordError,
      cycleBudget: lastDiscordCycleBudget
    },
    now: new Date().toISOString()
  });
});

app.get("/api/trader-signals/status", async (req, res) => {
  try {
    const recent = await loadRecentDiscordSignals();
    return res.json({
      configured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
      channelId: traderSignalResolvedChannelId || TRADER_SIGNAL_CHANNEL_ID || null,
      channelName: traderSignalResolvedChannelName,
      received: traderSignalsReceived,
      accepted: traderSignalsAccepted,
      ignored: traderSignalsIgnored,
      lastSignalAt: lastTraderSignalAt,
      lastError: lastTraderSignalError,
      recentSignals: recent.slice(0, 25)
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

app.get("/api/trader-feeds/status", (req, res) => {
  res.json({
    enabled: TRADER_FEED_INGEST_CONFIGURED,
    ready: TRADER_FEED_INGEST_CONFIGURED && (!TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST || TRADER_FEED_ALLOWED_SOURCE_MAP.size > 0),
    authentication: TRADER_FEED_INGEST_CONFIGURED ? "Bearer/x-trader-feed-token" : "NOT_CONFIGURED",
    endpoint: "POST /api/trader-signals/ingest",
    policy: "Nur fuer autorisierte/erlaubte Forwarder oder lizenzierte Feeds. Kein automatisches Umgehen privater Discord-Kanaele.",
    received: authorizedTraderFeedReceived,
    accepted: authorizedTraderFeedAccepted,
    ignored: authorizedTraderFeedIgnored,
    rateLimited: authorizedTraderFeedRateLimited,
    replayRejected: authorizedTraderFeedReplayRejected,
    sourceRejected: authorizedTraderFeedSourceRejected,
    guard: {
      maxRequestsPerMinute: TRADER_FEED_MAX_REQUESTS_PER_MIN,
      maxEventAgeMinutes: Math.round(TRADER_FEED_MAX_EVENT_AGE_MS / 60_000),
      maxFutureSkewMinutes: Math.round(TRADER_FEED_MAX_FUTURE_SKEW_MS / 60_000),
      sourceAllowlistRequired: TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST,
      sourceAllowlistConfigured: TRADER_FEED_ALLOWED_SOURCE_MAP.size > 0,
      allowedSources: Array.from(TRADER_FEED_ALLOWED_SOURCE_MAP.values()),
      eventTimeBasis: "source_event_at; reliability horizons start at the original trader event time",
      receivedTimeStoredSeparately: true,
      currentWindowCount: traderFeedRateWindowCount,
      windowResetAt: new Date(traderFeedRateWindowStartedAt + 60_000).toISOString()
    },
    lastAt: lastAuthorizedTraderFeedAt,
    lastSource: lastAuthorizedTraderFeedSource,
    lastError: lastAuthorizedTraderFeedError
  });
});

app.post("/api/trader-signals/ingest", async (req, res) => {
  authorizedTraderFeedReceived++;
  lastAuthorizedTraderFeedAt = new Date().toISOString();

  try {
    if (!TRADER_FEED_INGEST_CONFIGURED) {
      authorizedTraderFeedIgnored++;
      lastAuthorizedTraderFeedError = "TRADER_FEED_INGEST_TOKEN ist nicht konfiguriert.";
      return res.status(503).json({ ok: false, error: lastAuthorizedTraderFeedError });
    }

    const providedToken = traderFeedTokenFromRequest(req);
    if (!secureTokenEquals(providedToken, TRADER_FEED_INGEST_TOKEN)) {
      authorizedTraderFeedIgnored++;
      lastAuthorizedTraderFeedError = "Nicht autorisierter Trader-Feed-Aufruf.";
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const rate = traderFeedRateLimitCheck();
    if (!rate.allowed) {
      authorizedTraderFeedIgnored++;
      authorizedTraderFeedRateLimited++;
      lastAuthorizedTraderFeedError = `Trader-Feed Rate-Limit erreicht (${rate.limit}/Minute).`;
      res.set("Retry-After", String(Math.max(1, Math.ceil((new Date(rate.resetAt).getTime() - Date.now()) / 1000))));
      return res.status(429).json({ ok: false, error: lastAuthorizedTraderFeedError, resetAt: rate.resetAt });
    }

    const requestedSource = compactWhitespace(req.body?.source || "").slice(0, 120);
    const requestedChannel = compactWhitespace(req.body?.channel || req.body?.channelName || "").replace(/^#/, "").slice(0, 120);
    const text = compactWhitespace(req.body?.message ?? req.body?.text ?? "").slice(0, 3000);
    const externalIdRaw = compactWhitespace(req.body?.eventId ?? req.body?.id ?? "");
    const eventTimeRaw = req.body?.eventTime ?? req.body?.timestamp ?? req.body?.createdAt ?? null;
    const eventTime = parseTraderFeedEventTime(eventTimeRaw);

    if (!requestedSource || requestedSource.length < 2 || !text || text.length < 3) {
      authorizedTraderFeedIgnored++;
      lastAuthorizedTraderFeedError = "source und message/text sind erforderlich.";
      return res.status(400).json({ ok: false, error: lastAuthorizedTraderFeedError });
    }

    if (TRADER_FEED_REQUIRE_SOURCE_ALLOWLIST && TRADER_FEED_ALLOWED_SOURCE_MAP.size === 0) {
      authorizedTraderFeedIgnored++;
      authorizedTraderFeedSourceRejected++;
      lastAuthorizedTraderFeedError = "Trader-Feed Source-Allowlist ist erforderlich, aber TRADER_FEED_ALLOWED_SOURCES ist leer.";
      return res.status(503).json({ ok: false, error: lastAuthorizedTraderFeedError });
    }

    const allowedSource = traderFeedAllowedSource(requestedSource);
    if (TRADER_FEED_ALLOWED_SOURCE_MAP.size > 0 && !allowedSource) {
      authorizedTraderFeedIgnored++;
      authorizedTraderFeedSourceRejected++;
      lastAuthorizedTraderFeedError = `Nicht erlaubte Trader-Quelle: ${requestedSource}`;
      return res.status(403).json({ ok: false, error: "Trader source not allowed" });
    }

    // Kanonischer Anzeigename aus der Allowlist verhindert, dass kleine Schreibvarianten
    // mehrere Zuverlaessigkeitsprofile fuer denselben Trader erzeugen.
    const source = canonicalTraderSourceName(allowedSource || requestedSource);

    if (eventTimeRaw != null && !eventTime) {
      authorizedTraderFeedIgnored++;
      authorizedTraderFeedReplayRejected++;
      lastAuthorizedTraderFeedError = "Ungueltiger eventTime/timestamp im Trader-Feed.";
      return res.status(400).json({ ok: false, error: lastAuthorizedTraderFeedError });
    }

    if (eventTime) {
      const ageMs = Date.now() - eventTime.getTime();
      if (ageMs > TRADER_FEED_MAX_EVENT_AGE_MS) {
        authorizedTraderFeedIgnored++;
        authorizedTraderFeedReplayRejected++;
        lastAuthorizedTraderFeedError = "Trader-Feed Event ist zu alt und wurde als Replay verworfen.";
        return res.status(409).json({ ok: false, error: lastAuthorizedTraderFeedError });
      }
      if (ageMs < -TRADER_FEED_MAX_FUTURE_SKEW_MS) {
        authorizedTraderFeedIgnored++;
        authorizedTraderFeedReplayRejected++;
        lastAuthorizedTraderFeedError = "Trader-Feed Event liegt unplausibel weit in der Zukunft.";
        return res.status(409).json({ ok: false, error: lastAuthorizedTraderFeedError });
      }
    }

    lastAuthorizedTraderFeedSource = source;

    const eventKey = traderFeedSafeKey(
      externalIdRaw || traderFeedFallbackEventKey(source, text, eventTime)
    );
    const sourceKey = traderFeedSafeKey(source, "source");
    const synthetic = {
      id: `${sourceKey}_${eventKey}`.slice(0, 90),
      content: `Quelle: ${source}${requestedChannel ? `\nKanal: #${requestedChannel}` : ""}\n${text}`,
      embeds: [],
      author: { username: source }
    };

    const parsed = parseTraderSignalMessage(synthetic);
    if (!parsed.ok) {
      authorizedTraderFeedIgnored++;
      lastAuthorizedTraderFeedError = parsed.reason;
      return res.status(422).json({ ok: false, error: parsed.reason });
    }

    parsed.signal.id = `feed_${sourceKey}_${eventKey}`.slice(0, 118);
    parsed.signal.source = source;
    parsed.signal.message = text;
    parsed.signal.reason = text.slice(0, 1200);
    parsed.signal.sourceChannel = requestedChannel || parsed.signal.sourceChannel || null;
    const channelMeta = detectKnownTraderChannel(`${requestedChannel ? `#${requestedChannel} ` : ""}${text}`, source);
    if (channelMeta) {
      parsed.signal.sourceChannelType = channelMeta.type || parsed.signal.sourceChannelType || null;
      parsed.signal.sourceChannelWeight = Number(channelMeta.weight || parsed.signal.sourceChannelWeight || 1);
      if (channelMeta.category) parsed.signal.category = channelMeta.category;
    }
    parsed.signal.sourceEventAt = (eventTime || new Date()).getTime();
    parsed.signal.timestamp = parsed.signal.sourceEventAt;
    parsed.signal.ingestOrigin = "authorized_feed";
    parsed.signal.externalEventId = (externalIdRaw || eventKey).slice(0, 180);

    const inserted = await saveIncomingTraderSignal(parsed.signal);
    if (!inserted) {
      authorizedTraderFeedIgnored++;
      lastAuthorizedTraderFeedError = "Doppeltes Feed-Event wurde idempotent ignoriert.";
      return res.status(200).json({
        ok: true,
        duplicate: true,
        signalId: parsed.signal.id
      });
    }

    authorizedTraderFeedAccepted++;
    lastAuthorizedTraderFeedError = null;

    return res.status(201).json({
      ok: true,
      signal: {
        id: parsed.signal.id,
        source: parsed.signal.source,
        call: parsed.signal.call,
        target: parsed.signal.playerOrRating,
        category: parsed.signal.category,
        channel: parsed.signal.sourceChannel || null,
        signalKind: parsed.signal.signalKind || "TRADER_CALL",
        expectedTimeframe: parsed.signal.expectedTimeframe,
        eventTime: new Date(parsed.signal.sourceEventAt).toISOString(),
        receivedAt: lastAuthorizedTraderFeedAt,
        timingBasis: "source-event-time",
        idempotency: externalIdRaw ? "external-event-id" : "deterministic-fallback"
      },
      nextStep: "Wird beim naechsten 60-Sekunden-Marktcheck gegen FUT.GG und den Trader Brain geprueft."
    });
  } catch (error) {
    authorizedTraderFeedIgnored++;
    lastAuthorizedTraderFeedError = String(error);
    console.error("Authorized trader feed ingest error:", error);
    return res.status(500).json({ ok: false, error: "Trader-Feed-Ingest fehlgeschlagen." });
  }
});

app.get("/api/trader-sources/status", (req, res) => {
  res.json({
    ok: true, version: "10.50-rating-list-all-watch", mode: "forwarded-or-authorized-only", automaticForeignDiscordReading: false,
    sources: CURATED_TRADER_SOURCES.map(source => ({ id: source.id, name: source.displayName, aliases: source.aliases, channels: source.channels.map(channel => ({ channel: channel.name, type: channel.type, category: channel.category, defaultCall: channel.defaultCall, reliabilityWeight: Number(channel.weight || 1) })) })),
    note: "Die Registry normalisiert weitergeleitete/erlaubte Signale. Sie liest keine fremden Discord-Server automatisch oder verdeckt aus."
  });
});

app.get("/api/alert-sanity/status", (req, res) => {
  const blocked = (latestTradingRows || []).filter(row => row?.aiAlertSanity?.blocked).slice(0, 25).map(row => ({
    eaId: row.eaId,
    player: row.name,
    rating: row.overall,
    analyzedPrice: row.price,
    recheckPrice: row?.aiAlertSanity?.recheckPrice ?? null,
    recheckDiffPct: row?.aiAlertSanity?.recheckDiffPct ?? null,
    action: row.aiAction,
    confidence: row.aiConfidence,
    regime: row?.aiAlertSanity?.derivedRegime,
    reasons: row?.aiAlertSanity?.reasons || []
  }));
  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    blockedNow: blocked.length,
    thresholds: {
      livePriceDiffPct: ALERT_SANITY_RECHECK_DIFF_PCT,
      liveRecheckMinMovePct: ALERT_SANITY_RECHECK_MIN_MOVE_PCT,
      opposingMovePct: ALERT_SANITY_OPPOSING_MOVE_PCT
    },
    blocked,
    note: "Widerspruechliche Horizonte oder ein materiell veraenderter Live-FUT.GG-Preis erzeugen keinen Richtungsalarm."
  });
});

app.get("/api/buy-guard/status", (req, res) => {
  res.json({
    ok: true,
    enabled: true,
    version: "10.50-rating-list-all-watch",
    rules: {
      duplicateShortHorizonsCountAsOne: true,
      requiredRecoveryCycles: STRICT_BUY_RECOVERY_CYCLES,
      higherLowOrNoNewLowRequiredAfterSelloff: true,
      specialMin15mPctAfterSelloff: STRICT_BUY_SPECIAL_MIN_15M,
      specialMin1hPctAfterSelloff: STRICT_BUY_SPECIAL_MIN_1H,
      failedBottomInvalidationPct: STRICT_BUY_INVALIDATION_DROP_PCT,
      historicalConfidenceCaps: { under40: 62, under45: 68, under50: 72, under55: 78, under60: 84 },
      futbinCanBlockBuy: true,
      failedBuySignalAlert: true
    },
    stats: strictBuyGuardStats,
    note: "v10.37 verhindert den Lauren-James-Fehler: ein erster gruener Tick oder identische 1m/5m/15m-Werte reichen nach einem Selloff nicht mehr fuer JETZT KAUFEN."
  });
});

app.get("/api/leak-impact/status", async (req, res) => {
  try {
    if (!dbEnabled) return res.json({ ok: false, enabled: false, reason: "PostgreSQL ist nicht aktiv." });
    const recent = await pool.query(`
      SELECT i.signal_id, i.horizon_minutes, i.market_median_change_pct, i.strongest_rating, i.strongest_rating_change_pct, i.affected_ratings, i.direction, i.evaluated_at,
             s.source, s.source_channel, s.category, s.message, COALESCE(s.source_event_at, s.created_at) AS source_event_at
      FROM fc_trader_market_impacts i JOIN fc_discord_signals s ON s.id = i.signal_id
      ORDER BY i.evaluated_at DESC LIMIT 100
    `);
    const sourceSummary = await pool.query(`
      SELECT s.source, COUNT(*)::int AS evaluated_points, COUNT(DISTINCT i.signal_id)::int AS events,
             ROUND(AVG(ABS(i.market_median_change_pct))::numeric, 2) AS avg_abs_market_move, ROUND(AVG(i.market_median_change_pct)::numeric, 2) AS avg_market_move
      FROM fc_trader_market_impacts i JOIN fc_discord_signals s ON s.id = i.signal_id
      GROUP BY s.source ORDER BY COUNT(DISTINCT i.signal_id) DESC, s.source ASC
    `);
    return res.json({
      ok: true, enabled: true, version: "10.50-rating-list-all-watch", horizonsMinutes: TRADER_MARKET_IMPACT_HORIZONS,
      sourceSummary: sourceSummary.rows.map(row => ({ source: row.source, events: Number(row.events || 0), evaluatedPoints: Number(row.evaluated_points || 0), avgAbsMarketMovePct: Number(row.avg_abs_market_move || 0), avgMarketMovePct: Number(row.avg_market_move || 0) })),
      recent: recent.rows.map(row => ({ signalId: row.signal_id, source: row.source, channel: row.source_channel || null, category: row.category, horizonMinutes: Number(row.horizon_minutes), marketMedianChangePct: Number(row.market_median_change_pct), strongestRating: row.strongest_rating == null ? null : Number(row.strongest_rating), strongestRatingChangePct: row.strongest_rating_change_pct == null ? null : Number(row.strongest_rating_change_pct), affectedRatings: row.affected_ratings || [], direction: row.direction, sourceEventAt: row.source_event_at, evaluatedAt: row.evaluated_at, message: String(row.message || "").slice(0, 500) })),
      note: "Leak/Content-Events loesen keinen Kauf aus. Der Brain misst zuerst, welche Rating-Segmente sich nach 15m/1h/6h/24h real bewegen."
    });
  } catch (error) { return res.status(500).json({ ok: false, error: String(error) }); }
});

app.get("/api/market-knowledge/status", async (req, res) => {
  try {
    const profiles = await loadMarketKnowledgeProfiles();
    let recent = [];
    if (dbEnabled) {
      const result = await pool.query(`
        SELECT e.signal_id, e.rule_id, e.horizon_minutes, e.target_scope,
               e.observed_change_pct, e.expected_mode, e.support_score,
               e.was_supported, e.details, e.evaluated_at,
               s.source, s.source_channel, s.message,
               COALESCE(s.source_event_at, s.created_at) AS source_event_at
        FROM fc_market_knowledge_evaluations e
        JOIN fc_discord_signals s ON s.id = e.signal_id
        ORDER BY e.evaluated_at DESC
        LIMIT 100
      `);
      recent = result.rows.map(row => ({
        signalId: row.signal_id,
        ruleId: row.rule_id,
        source: row.source,
        channel: row.source_channel || null,
        horizonMinutes: Number(row.horizon_minutes),
        targetScope: row.target_scope || null,
        observedChangePct: row.observed_change_pct == null ? null : Number(row.observed_change_pct),
        expectedMode: row.expected_mode,
        supportScore: Number(row.support_score),
        wasSupported: row.was_supported === true,
        sourceEventAt: row.source_event_at,
        evaluatedAt: row.evaluated_at,
        details: row.details || {},
        message: String(row.message || "").slice(0, 400)
      }));
    }
    return res.json({
      ok: true,
      enabled: true,
      version: "10.50-rating-list-all-watch",
      policy: {
        hypothesesAreNotTruth: true,
        minimumSamplesBeforeInfluence: MARKET_KNOWLEDGE_MIN_SAMPLES,
        minimumSmoothedSupportPct: MARKET_KNOWLEDGE_MIN_SUPPORT,
        canCreateBuyAlone: false,
        canBlockBuyWhenVerifiedRuleContradicts: true,
        learningHorizonsMinutes: MARKET_KNOWLEDGE_HORIZONS
      },
      rules: MARKET_KNOWLEDGE_RULES.map(rule => ({
        ...rule,
        profile: profiles[rule.id] || null
      })),
      recent,
      note: "Trader-Wissen wird als Hypothese gespeichert, mit echten FUT.GG-Marktdaten geprüft und erst nach genügend FC-Beobachtungen vorsichtig gewichtet."
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-reliability/status", async (req, res) => {
  try {
    if (!dbEnabled) {
      return res.json({ enabled: false, reason: "PostgreSQL ist nicht aktiv." });
    }

    const [profiles, outcomes] = await Promise.all([
      pool.query(`
        SELECT
          source,
          display_name,
          overall_accuracy,
          total_signals,
          accuracy_sbc_fodder,
          accuracy_promo_cards,
          accuracy_short_flips,
          accuracy_leaks,
          reputation_badge,
          updated_at
        FROM fc_trader_profiles
        ORDER BY overall_accuracy DESC, total_signals DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT
          o.signal_id,
          s.source,
          s.player_or_rating,
          s.call,
          s.category,
          s.expected_timeframe,
          o.horizon_minutes,
          o.initial_price,
          o.observed_price,
          o.gross_change_pct,
          o.net_roi_after_tax_pct,
          o.was_correct,
          o.evaluation_reason,
          o.evaluated_at
        FROM fc_trader_signal_outcomes o
        JOIN fc_discord_signals s ON s.id = o.signal_id
        ORDER BY o.evaluated_at DESC
        LIMIT 100
      `)
    ]);

    return res.json({
      enabled: true,
      version: "10.50-rating-list-all-watch",
      gameYear: GAME_YEAR,
      method: {
        priorAccuracy: TRADER_RELIABILITY_PRIOR_ACCURACY,
        priorStrength: TRADER_RELIABILITY_PRIOR_STRENGTH,
        categoryPriorStrength: TRADER_RELIABILITY_CATEGORY_PRIOR_STRENGTH,
        note: "Zeitfenster werden passend zu Erwartung/Kategorie gewichtet; der Einstiegspreis wird pro Signal einmal eingefroren und für 5m/15m/1h/6h/24h identisch verwendet. Autorisierte Forwarder werden ab v10.28 anhand der originalen source_event_at-Zeit bewertet, nicht anhand der späteren Empfangszeit."
      },
      horizonsMinutes: TRADER_RELIABILITY_HORIZONS,
      profiles: profiles.rows.map(row => ({
        source: row.source,
        displayName: row.display_name,
        overallAccuracy: Number(row.overall_accuracy || 50),
        totalSignals: Number(row.total_signals || 0),
        categoryAccuracy: {
          SBC_FODDER: Number(row.accuracy_sbc_fodder || 50),
          PROMO_CARDS: Number(row.accuracy_promo_cards || 50),
          SHORT_TERM_FLIPS: Number(row.accuracy_short_flips || 50),
          LEAKS_CONTENT: Number(row.accuracy_leaks || 50)
        },
        reputationBadge: row.reputation_badge,
        updatedAt: row.updated_at
      })),
      recentOutcomes: outcomes.rows.map(row => ({
        signalId: row.signal_id,
        source: row.source,
        playerOrRating: row.player_or_rating,
        call: row.call,
        category: row.category,
        expectedTimeframe: row.expected_timeframe || "",
        preferredHorizonMinutes: preferredTraderSignalHorizon({
          category: row.category,
          expectedTimeframe: row.expected_timeframe
        }),
        horizonMinutes: Number(row.horizon_minutes),
        reliabilityWeight: traderReliabilityOutcomeWeight(
          {
            category: row.category,
            expectedTimeframe: row.expected_timeframe
          },
          Number(row.horizon_minutes)
        ),
        initialPrice: Number(row.initial_price),
        observedPrice: Number(row.observed_price),
        grossChangePct: Number(row.gross_change_pct),
        netRoiAfterTaxPct: Number(row.net_roi_after_tax_pct),
        wasCorrect: row.was_correct,
        reason: row.evaluation_reason,
        evaluatedAt: row.evaluated_at
      }))
    });
  } catch (error) {
    return res.status(500).json({ error: String(error) });
  }
});

app.get("/api/trader-confluence/status", (req, res) => {
  res.json({
    enabled: DISCORD_CONFIGURED && dbEnabled,
    version: "10.50-rating-list-all-watch",
    minCardConfidence: DISCORD_TRADER_CONFLUENCE_MIN_CONFIDENCE,
    minRatingConfidence: DISCORD_TRADER_CONFLUENCE_MIN_RATING_CONFIDENCE,
    minTraderReliability: DISCORD_TRADER_CONFLUENCE_MIN_RELIABILITY,
    reliabilityPolicy: {
      high75Plus: -4,
      good65Plus: -2,
      neutral50Plus: 0,
      weak40Plus: 3,
      poorBelow40: 6
    },
    suppressedLowReliabilitySignals: traderConfluenceSuppressedSignals.size,
    lifecyclePolicy: {
      signalLookbackHours: 30,
      minActiveMinutes: 90,
      maxActiveMinutes: 1560,
      reconfirmStabilityMinutes: 15,
      note: "24h-/morgen-Signale bleiben bis zur finalen Auswertung verfügbar; nur aktive Signale beeinflussen den Brain. Bestätigte Signale melden Invalidierung oder Ablauf einmalig."
    },
    lastGate: lastTraderConfluenceGate,
    alertsSent: traderConfluenceAlertsSent,
    invalidationsSent: traderConfluenceInvalidationsSent,
    expirationsSent: traderConfluenceExpirationsSent,
    lastAlertAt: lastTraderConfluenceAlertAt,
    lastInvalidationAt: lastTraderConfluenceInvalidationAt,
    lastExpirationAt: lastTraderConfluenceExpirationAt,
    lastError: lastTraderConfluenceAlertError
  });
});

app.get("/api/discord-rating-mode/status", (req, res) => {
  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    ratingFirst: DISCORD_RATING_FIRST_BASE_ALERTS,
    strictRatingFeed: true,
    normalPlayerAlerts: false,
    suppressedCardTypes: ["Base Rare", "Base Common", "Special"],
    playerNameExceptions: ["tracked_purchase", "intensive_watch"],
    ratingPlayerList: {
      enabled: true,
      button: "Spieler anzeigen",
      intensiveSelector: "Spieler intensiv überwachen",
      intensiveAllOption: "ALLE Rating-Spieler intensiv überwachen",
      privateToClickingUser: true,
      pageSize: RATING_LIST_PAGE_SIZE
    },
    specialCardsRemainIndividual: false,
    traderPlayerConfluencePublic: false,
    note: "Öffentlicher Feed bleibt Rating-only. Die private Liste führt Männer- und Frauenkarten zusammen und bietet zusätzlich ALLE Rating-Spieler intensiv überwachen."
  });
});

app.get("/api/discord/status", (req, res) => {
  res.json({
    configured: DISCORD_CONFIGURED,
    channelConfigured: Boolean(DISCORD_ALERT_CHANNEL_ID),
    tokenConfigured: Boolean(DISCORD_BOT_TOKEN),
    gatewayReady: discordClientReady,
    botTag: discordBotTag,
    guildCount: discordGuildCount,
    resolvedChannelId: discordResolvedChannelId,
    resolvedChannelName: discordResolvedChannelName,
    traderSignalChannelConfigured: Boolean(TRADER_SIGNAL_CHANNEL_ID),
    traderSignalChannelId: traderSignalResolvedChannelId,
    traderSignalChannelName: traderSignalResolvedChannelName,
    traderSignalsReceived,
    traderSignalsAccepted,
    traderSignalsIgnored,
    lastTraderSignalAt,
    lastTraderSignalError,
    authorizedTraderFeed: {
      configured: TRADER_FEED_INGEST_CONFIGURED,
      received: authorizedTraderFeedReceived,
      accepted: authorizedTraderFeedAccepted,
      ignored: authorizedTraderFeedIgnored,
      rateLimited: authorizedTraderFeedRateLimited,
      replayRejected: authorizedTraderFeedReplayRejected,
      lastAt: lastAuthorizedTraderFeedAt,
      lastSource: lastAuthorizedTraderFeedSource,
      lastError: lastAuthorizedTraderFeedError
    },
    traderConfluenceAlertsSent,
    traderConfluenceInvalidationsSent,
    lastTraderConfluenceAlertAt,
    lastTraderConfluenceInvalidationAt,
    lastTraderConfluenceAlertError,
    traderConfluenceSuppressedLowReliability: traderConfluenceSuppressedSignals.size,
    lastTraderConfluenceGate,
    alertsSent: discordAlertsSent,
    lastSendAt: lastDiscordSendAt,
    lastError: lastDiscordError,
    cooldownMinutes: Math.round(DISCORD_ALERT_COOLDOWN_MS / 60_000),
    maxAlertsPerCycle: DISCORD_MAX_ALERTS_PER_CYCLE,
    cycleBudget: lastDiscordCycleBudget,
    minBuyConfidence: DISCORD_MIN_BUY_CONFIDENCE,
    minSellConfidence: DISCORD_MIN_SELL_CONFIDENCE,
    minRatingConfidence: DISCORD_MIN_RATING_CONFIDENCE,
    intensiveWatch: {
      alertsSent: intensiveWatchAlertsSent,
      lastAlertAt: lastIntensiveWatchAlertAt,
      lastError: lastIntensiveWatchError,
      moveAlertPct: INTENSIVE_WATCH_MOVE_PCT,
      minAlertGapMinutes: Math.round(INTENSIVE_WATCH_MIN_ALERT_GAP_MS / 60_000)
    }
  });
});

app.post("/api/position", async (req, res) => {
  try {
    const eaId = Number(req.body?.eaId);
    const buyPrice = Number(req.body?.buyPrice);
    const quantity = Number(req.body?.quantity ?? 1);
    const note = String(req.body?.note ?? "").slice(0, 500);

    if (!Number.isFinite(eaId) || eaId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige eaId"
      });
    }

    if (
      !Number.isFinite(buyPrice) ||
      buyPrice <= 0 ||
      !Number.isInteger(buyPrice)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Kaufpreis muss eine positive ganze Zahl sein"
      });
    }

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isInteger(quantity) ||
      quantity > 1000
    ) {
      return res.status(400).json({
        ok: false,
        error: "Menge muss 1 bis 1000 sein"
      });
    }

    await savePosition(
      eaId,
      buyPrice,
      quantity,
      note
    );

    res.json({
      ok: true,
      eaId,
      buyPrice,
      quantity,
      note
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.delete("/api/position/:eaId", async (req, res) => {
  try {
    const eaId = Number(req.params.eaId);

    if (!Number.isFinite(eaId) || eaId <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Ungültige eaId"
      });
    }

    await deletePosition(eaId);

    res.json({
      ok: true,
      eaId
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/api/intensive-watchlist", async (req, res) => {
  try {
    const watches = await getIntensiveWatchlist();
    const rowMap = new Map(latestTradingRows.map(row => [String(row.eaId), row]));
    const items = [...watches.values()].map(watch => {
      const row = rowMap.get(String(watch.eaId));
      return {
        ...watch,
        currentPrice: row?.price ?? watch.lastPrice ?? null,
        currentAction: row?.aiAction ?? watch.lastAction ?? null,
        currentConfidence: row?.aiConfidence ?? watch.lastConfidence ?? null,
        url: row?.url || null,
        trackedPosition: Boolean(row?.tracked)
      };
    });

    res.json({
      ok: true,
      version: "10.50-rating-list-all-watch",
      count: items.length,
      settings: {
        moveAlertPct: INTENSIVE_WATCH_MOVE_PCT,
        minAlertGapMinutes: Math.round(INTENSIVE_WATCH_MIN_ALERT_GAP_MS / 60_000),
        maxAlertsPerCycle: INTENSIVE_WATCH_MAX_ALERTS_PER_CYCLE
      },
      alertsSent: intensiveWatchAlertsSent,
      lastAlertAt: lastIntensiveWatchAlertAt,
      lastError: lastIntensiveWatchError,
      items
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.post("/api/intensive-watch/:eaId", async (req, res) => {
  try {
    const eaId = String(req.params.eaId || "");
    const row = latestTradingRows.find(item => String(item.eaId) === eaId);
    if (!row) return res.status(404).json({ ok: false, error: "Karte im aktuellen Snapshot nicht gefunden" });
    const watch = await saveIntensiveWatch(row, "api");
    res.json({ ok: true, watch });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.delete("/api/intensive-watch/:eaId", async (req, res) => {
  try {
    const eaId = String(req.params.eaId || "");
    if (!/^\d+$/.test(eaId)) return res.status(400).json({ ok: false, error: "Ungültige eaId" });
    await deleteIntensiveWatch(eaId);
    res.json({ ok: true, eaId });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});


function tradingDataMode() {
  const health = sourceHealthSnapshot();
  const hasSafeSnapshot = latestTradingRows.length > 0;
  const hasFutbinFallback = latestFutbinFallbackRows.length > 0;
  const safeSnapshotAt = lastMonitorAt || health.lastSuccessAt || null;

  if (health.status === "HEALTHY" || health.status === "DEGRADED") {
    return {
      mode: "LIVE",
      live: true,
      stale: false,
      hasSafeSnapshot,
      safeSnapshotAt,
      reason: health.reason
    };
  }

  if (hasFutbinFallback) {
    return {
      mode: "FUTBIN_FALLBACK_SAFE",
      live: false,
      stale: true,
      hasSafeSnapshot: true,
      safeSnapshotAt: latestFutbinStatus.lastSuccessAt || safeSnapshotAt,
      reason:
        "FUT.GG ist aktuell nicht sicher. Ein autorisierter FUTBIN-Feed liefert Ersatzpreise nur zur Anzeige. Historie, Brain, Lernen und Trading-Alerts bleiben blockiert."
    };
  }

  if (hasSafeSnapshot) {
    return {
      mode: "STALE_SAFE",
      live: false,
      stale: true,
      hasSafeSnapshot: true,
      safeSnapshotAt,
      reason:
        "FUT.GG ist aktuell nicht sicher. Es werden nur die letzten bereits geprüften Marktdaten angezeigt. Historie, Lernen und Trading-Alerts bleiben blockiert, bis die Quelle wieder stabil ist."
    };
  }

  return {
    mode: "STARTING",
    live: false,
    stale: true,
    hasSafeSnapshot: false,
    safeSnapshotAt: null,
    reason:
      "Noch kein sicherer Markt-Snapshot verfügbar. Das System wartet auf einen erfolgreichen FUT.GG-Marktcheck."
  };
}

app.get("/api/trading", async (req, res) => {
  try {
    const health = sourceHealthSnapshot();
    let mode = tradingDataMode();
    let rows = mode.mode === "FUTBIN_FALLBACK_SAFE"
      ? latestFutbinFallbackRows
      : latestTradingRows;

    // Wichtig: Der HTTP-Endpunkt darf den Source-Health-Guard nicht umgehen.
    // Nur bei verwendbarer FUT.GG-Quelle darf ein initialer Snapshot aufgebaut werden.
    if (!rows.length && !monitoringBusy && health.usable === true) {
      const built = await buildTradingRows();
      rows = built.rows;
      latestTradingRows = rows;
      latestRatingStats = built.ratingStats;
      mode = tradingDataMode();
    }

    res.json({
      ok: true,
      version: "10.50-rating-list-all-watch",
      refreshSeconds: 60,
      dbEnabled,
      sourceHealth: health,
      futbin: latestFutbinStatus,
      dataMode: mode,
      historyNote:
        dbEnabled
          ? "Dauerhafte Historie + Trader-Brain-Lernspeicher aktiv"
          : "Nur Arbeitsspeicher; Lernhistorie ist ohne PostgreSQL nicht dauerhaft",
      totalPricedCards: rows.length,
      trackedPositions: rows.filter(row => row.tracked).length,
      intensiveWatchedCards: rows.filter(row => row.intensiveWatch).length,
      aiSummary: {
        buyNow: rows.filter(row => row.aiAction === "JETZT KAUFEN").length,
        wait: rows.filter(row => row.aiAction === "NOCH WARTEN").length,
        doNotBuy: rows.filter(row => row.aiAction === "NICHT KAUFEN").length,
        sellCheck: rows.filter(row => row.aiAction === "VERKAUF PRÜFEN").length,
        sellNow: rows.filter(row => row.aiAction === "JETZT VERKAUFEN").length
      },
      ratingIntelligence: Object.values(latestRatingStats)
        .sort((a, b) => b.rating - a.rating),
      ratingAlerts: Object.values(latestRatingStats)
        .filter(r => !["NEUTRAL", "ZU WENIG DATEN"].includes(r.marketSignal)).length,
      geminiQuota: getGeminiQuotaInfo(),
      discord: {
        configured: DISCORD_CONFIGURED,
        alertsSent: discordAlertsSent,
        lastSendAt: lastDiscordSendAt,
        lastError: lastDiscordError
      },
      lastBrainRunAt,
      lastBrainError,
      lastGeminiCandidate,
      rows,
      updatedAt: mode.safeSnapshotAt || lastMonitorAt || new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: String(error)
    });
  }
});

app.get("/api/ratings-intelligence", (req, res) => {
  const priority = {
    "KAUFZONE": 6,
    "STARK FALLEND": 5,
    "STARK STEIGEND": 4,
    "FÄLLT": 3,
    "STEIGEND": 2,
    "NEUTRAL": 1,
    "ZU WENIG DATEN": 0
  };

  const ratings = Object.values(latestRatingStats)
    .sort((a, b) => {
      const signalDiff =
        (priority[b.marketSignal] ?? 0) -
        (priority[a.marketSignal] ?? 0);

      if (signalDiff !== 0) return signalDiff;
      return b.rating - a.rating;
    });

  res.json({
    ok: true,
    refreshSeconds: 60,
    source: `FUT.GG FC${GAME_YEAR} Base Rare`,
    gameYear: GAME_YEAR,
    marketProfile: marketProfile(),
    ratings,
    updatedAt: lastMonitorAt || new Date().toISOString()
  });
});

app.get("/api/processing-health", (req, res) => {
  const health = processingHealthSnapshot();
  res.status(health.healthy ? 200 : 503).json({
    ok: health.healthy,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    processingHealth: health,
    note: "DB-, Brain- oder Discord-Fehler werden getrennt von FUT.GG-Quellfehlern bewertet und können den Source Health Guard nicht mehr fälschlich in Quarantäne schicken."
  });
});

app.get("/api/source-health", (req, res) => {
  const health = sourceHealthSnapshot();
  res.status(health.status === "UNHEALTHY" ? 503 : 200).json({
    ok: health.status !== "UNHEALTHY",
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    refreshSeconds: 60,
    source: "FUT.GG PS5 bulk prices",
    health,
    guard: {
      blocksHistoryWriteWhenUnhealthy: true,
      blocksBrainCycleWhenUnhealthy: true,
      blocksTradingAlertsWhenUnhealthy: true,
      note: "Bei klar unvollständigen oder ausgefallenen FUT.GG-Daten wird der aktive Trading-Zyklus gestoppt. Ohne autorisierten FUTBIN-Feed zeigt die API nur den letzten geprüften STALE_SAFE-Snapshot. Mit belastbar verifiziertem Bulk-Feed darf sie aktuelle Ersatzpreise im FUTBIN_FALLBACK_SAFE-Modus anzeigen; Historie, Lernen und Trading-Alerts bleiben dabei blockiert."
    }
  });
});

app.get("/api/futbin/status", (req, res) => {
  const matched = latestTradingRows.filter(row => Number.isFinite(row.futbinPrice)).length;
  const divergent = latestTradingRows.filter(row => ["DIVERGENCE", "OUTLIER"].includes(row.futbinCrossCheck)).length;

  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    configured: Boolean(FUTBIN_AUTHORIZED_FEED_URL || FUTBIN_PARSE_API_KEY),
    status: latestFutbinStatus,
    publicApi: {
      ...latestFutbinParseStatus,
      budget: refreshFutbinParseDailyBudget(),
      baseUrl: FUTBIN_PARSE_BASE_URL,
      minIntervalMinutes: Math.round(FUTBIN_PARSE_MIN_INTERVAL_MS / 60_000),
      cardCooldownMinutes: Math.round(FUTBIN_PARSE_CARD_COOLDOWN_MS / 60_000),
      minAiConfidence: FUTBIN_PARSE_MIN_AI_CONFIDENCE
    },
    policy: {
      directWebScraping: false,
      authorizedFeedOnly: false,
      providers: [
        FUTBIN_AUTHORIZED_FEED_URL ? "AUTHORIZED_JSON_FEED" : null,
        FUTBIN_PARSE_API_KEY ? "PARSE_PUBLIC_API" : null
      ].filter(Boolean),
      refreshMinutes: Math.round(FUTBIN_REFRESH_MS / 60_000),
      divergencePct: FUTBIN_MAX_DIFF_PCT,
      outlierPct: FUTBIN_OUTLIER_DIFF_PCT,
      fallbackMinMatches: FUTBIN_FALLBACK_MIN_MATCHES,
      trustMinMatches: FUTBIN_TRUST_MIN_MATCHES,
      maxDivergentSharePct: Number((FUTBIN_MAX_DIVERGENT_SHARE * 100).toFixed(1)),
      maxOutlierSharePct: Number((FUTBIN_MAX_OUTLIER_SHARE * 100).toFixed(1)),
      trustTtlMinutes: Math.round(FUTBIN_TRUST_TTL_MS / 60_000),
      note: "FUT.GG bleibt Hauptquelle. FUTBIN kommt entweder über einen autorisierten Bulk-Feed oder über die öffentliche Parse-API. Parse wird nur sparsam für relevante Einzelkarten geprüft; ein eindeutiger OUTLIER darf einen Kaufalarm blockieren, aber niemals allein einen Kauf auslösen. Anzeige-Fallback bleibt dem belastbar verifizierten Bulk-Feed vorbehalten."
    },
    crossCheckHealth: latestFutbinCrossCheckHealth,
    currentCrossCheck: {
      matchedCards: matched,
      divergentCards: divergent,
      fallbackRows: latestFutbinFallbackRows.length
    }
  });
});

app.get("/api/market-context", (req, res) => {
  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    refreshSeconds: 60,
    context: latestMarketContext,
    note: "Der Pack-Supply-Kontext ist eine konservative Marktdaten-Inferenz aus Base-Rare-Breite und Preisbewegungen, kein externer Content-Leak."
  });
});

app.get("/api/trader-brain/status", (req, res) => {
  res.json({
    ok: true,
    version: "10.50-rating-list-all-watch",
    gameYear: GAME_YEAR,
    marketProfile: marketProfile(),
    marketContext: latestMarketContext,
    automatic: true,
    refreshSeconds: 60,
    lastBrainRunAt,
    lastBrainError,
    lastGeminiCandidate,
    learning: {
      version: "10.50-rating-list-all-watch",
      totalMatureDecisions: brainLearningCache.totalMatureDecisions,
      rawMatureDecisions: brainLearningCache.rawMatureDecisions,
      uniqueLearningEpisodes: brainLearningCache.uniqueLearningEpisodes,
      updatedAt: brainLearningCache.updatedAt,
      lastError: lastBrainLearningError
    },
    gemini: getGeminiQuotaInfo(),
    ratingStats: latestRatingStats
  });
});

app.get("/api/trader-brain/learning/status", async (req, res) => {
  if (!dbEnabled) {
    return res.json({ enabled: false, reason: "PostgreSQL ist nicht aktiv." });
  }

  try {
    const cache = await loadBrainLearningProfiles(true);
    return res.json({
      enabled: true,
      version: "10.50-rating-list-all-watch",
      method: {
        windowDays: BRAIN_LEARNING_WINDOW_DAYS,
        priorAccuracy: BRAIN_LEARNING_PRIOR_ACCURACY,
        priorStrength: BRAIN_LEARNING_PRIOR_STRENGTH,
        maxConfidenceAdjustment: BRAIN_LEARNING_MAX_CONFIDENCE_ADJUSTMENT,
        waitPositiveCap: BRAIN_LEARNING_WAIT_POSITIVE_CAP,
        episodeHours: Math.round(BRAIN_LEARNING_EPISODE_MS / 60 / 60_000),
        recencyHalfLifeDays: BRAIN_LEARNING_RECENCY_HALF_LIFE_DAYS,
        recencyMinWeight: BRAIN_LEARNING_RECENCY_MIN_WEIGHT,
        severityMinEffectiveSamples: BRAIN_LEARNING_SEVERITY_MIN_EFFECTIVE,
        severityMaxAdjustment: BRAIN_LEARNING_SEVERITY_MAX_ADJUSTMENT,
        regimeMinSamples: BRAIN_LEARNING_REGIME_MIN_SAMPLES,
        exactMinSamples: BRAIN_LEARNING_EXACT_MIN_SAMPLES,
        cardTypeMinSamples: BRAIN_LEARNING_CARDTYPE_MIN_SAMPLES,
        actionMinSamples: BRAIN_LEARNING_ACTION_MIN_SAMPLES,
        regimeMinEffectiveSamples: BRAIN_LEARNING_REGIME_MIN_EFFECTIVE,
        exactMinEffectiveSamples: BRAIN_LEARNING_EXACT_MIN_EFFECTIVE,
        cardTypeMinEffectiveSamples: BRAIN_LEARNING_CARDTYPE_MIN_EFFECTIVE,
        actionMinEffectiveSamples: BRAIN_LEARNING_ACTION_MIN_EFFECTIVE,
        marketRegimes: ["CRASH", "PUMP", "RECOVERY", "FLAT", "NORMAL"],
        note: "v10.8.1 lernt zuerst aus derselben Marktlage: Crash, Pump, Recovery, Flat oder Normal. Zusätzlich berücksichtigt die Confidence nach genügend effektiven Fällen die Schwere historischer Ergebnisse: starke wiederholte Fehler drücken etwas stärker, klar positive Outcomes verstärken etwas. Der Zusatz bleibt auf wenige Confidence-Punkte begrenzt; Aktionen werden nicht blind umgedreht."
      },
      totalMatureDecisions: cache.totalMatureDecisions,
      rawMatureDecisions: cache.rawMatureDecisions,
      uniqueLearningEpisodes: cache.uniqueLearningEpisodes,
      updatedAt: cache.updatedAt,
      lastError: lastBrainLearningError,
      profiles: cache.profiles.slice(0, 100)
    });
  } catch (error) {
    return res.status(500).json({ enabled: false, error: String(error) });
  }
});

app.get("/api/trader-brain/performance/status", async (req, res) => {
  try {
    await loadDecisionPerformanceProfiles(true);
    const limit = Number(req.query.limit || 500);
    res.json(await buildDecisionPerformanceScorecard(limit));
  } catch (error) {
    res.status(500).json({
      ok: false,
      enabled: dbEnabled,
      version: "10.50-rating-list-all-watch",
      error: String(error)
    });
  }
});

app.get("/api/gemini-health", async (req, res) => {
  try {
    res.json(await checkGeminiHealth());
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/api/trader-brain/feedback/history", async (req, res) => {
  if (!dbEnabled) {
    return res.json({ ok: true, total: 0, history: [], note: "PostgreSQL nicht aktiv" });
  }

  try {
    const result = await pool.query(`
      SELECT
        d.id,
        d.ea_id::text AS ea_id,
        d.player_name,
        d.rating,
        d.card_type,
        d.initial_price,
        d.action,
        d.confidence,
        d.reason,
        d.risk,
        d.market_state,
        d.ai_model_used,
        d.created_at,
        e.price_after_5m,
        e.price_after_15m,
        e.price_after_1h,
        e.price_after_6h,
        e.price_after_24h,
        e.roi_5m,
        e.roi_15m,
        e.roi_30m,
        e.roi_1h,
        e.roi_3h,
        e.roi_6h,
        e.roi_24h,
        e.net_roi_5m,
        e.net_roi_15m,
        e.net_roi_30m,
        e.net_roi_1h,
        e.net_roi_3h,
        e.net_roi_6h,
        e.net_roi_24h,
        e.best_net_roi,
        e.worst_move_pct,
        e.missed_entry,
        e.false_buy,
        e.sell_timing_score,
        e.outcome_class,
        e.confidence_error,
        e.was_correct,
        e.outcome_score,
        e.notes
      FROM fc_trader_brain_decisions d
      LEFT JOIN fc_decision_evaluations e ON e.decision_id = d.id
      ORDER BY d.created_at DESC
      LIMIT 100
    `);

    res.json({ ok: true, total: result.rowCount, history: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.get("/overview", (req, res) => {
  res.redirect("/trading");
});

app.get("/trading", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FC Trading Intelligence</title>

<style>
  :root {
    color-scheme: dark;
    font-family: Arial, sans-serif;
  }

  body {
    margin: 0;
    background: #0f0f0f;
    color: #f2f2f2;
  }

  .wrap {
    padding: 18px 22px 40px;
  }

  h1 {
    margin: 0 0 5px;
    font-size: 30px;
  }

  .sub {
    color: #aaa;
    margin-bottom: 14px;
  }

  .bar {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    padding: 12px;
    background: #181818;
    border-radius: 10px;
    margin-bottom: 12px;
  }

  input,
  select,
  button {
    background: #101010;
    color: #eee;
    border: 1px solid #333;
    padding: 9px 10px;
    border-radius: 7px;
  }

  button {
    cursor: pointer;
  }

  input {
    min-width: 180px;
  }

  .status {
    margin-left: auto;
    color: #aaa;
    font-size: 13px;
  }

  .storage {
    background: #181818;
    padding: 10px 12px;
    border-radius: 8px;
    margin-bottom: 12px;
    color: #bbb;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    background: #161616;
    font-size: 13px;
  }

  th,
  td {
    padding: 8px 7px;
    border-bottom: 1px solid #292929;
    text-align: right;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    text-align: left;
  }

  th {
    position: sticky;
    top: 0;
    background: #202020;
    z-index: 2;
  }

  tr:hover {
    background: #202020;
  }

  a {
    color: #fff;
  }

  .strong {
    font-weight: 700;
  }

  .muted {
    color: #777;
  }

  .pos {
    color: #8fe59b;
  }

  .neg {
    color: #ff9b9b;
  }

  .tracked {
    background: #1a1a1a;
  }

  .tiny {
    font-size: 11px;
    padding: 5px 7px;
  }

  .rating-box {
    background: #161616;
    border: 1px solid #252525;
    border-radius: 10px;
    margin-bottom: 14px;
    overflow: hidden;
  }

  .rating-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: #1b1b1b;
    border-bottom: 1px solid #292929;
  }

  .rating-title {
    font-weight: 700;
    font-size: 16px;
  }

  .rating-sub {
    color: #999;
    font-size: 12px;
  }

  .rating-scroll {
    max-height: 330px;
    overflow: auto;
  }

  .rating-table {
    font-size: 12px;
  }

  .rating-table th,
  .rating-table td {
    padding: 7px 8px;
  }

  .rating-signal {
    font-weight: 800;
  }

  .rating-hot {
    background: #1b1b1b;
  }

</style>
</head>

<body>
<div class="wrap">

  <h1>FC Trading Intelligence</h1>

  <div class="sub">
    Google Trader Brain • 1m / 5m / 15m / 1h / 24h / 7d / 30d • 60-Sekunden-Refresh • 5 % EA-Steuer
  </div>

  <div class="bar">

    <input
      id="search"
      placeholder="Spieler suchen…"
    >

    <select id="type">
      <option value="all">Alle Kartentypen</option>
      <option value="Base Rare">Base Rare</option>
      <option value="Base Common">Base Common</option>
      <option value="Special">Special</option>
    </select>

    <select id="minRating">
      ${Array.from(
        { length: 25 },
        (_, i) => 75 + i
      )
        .map(
          rating =>
            `<option value="${rating}"${rating === MAIN_RATING_MIN ? " selected" : ""}>${rating}+</option>`
        )
        .join("")}
    </select>

    <select id="signal">
      <option value="all">Alle Signale</option>
      <option>KAUFEN</option>
      <option>BEOBACHTEN</option>
      <option>ERHOLUNG</option>
      <option>VERKAUF PRÜFEN</option>
      <option>HALTEN</option>
      <option>FÄLLT</option>
    </select>

    <select id="aiFilter">
      <option value="all">Alle KI-Entscheidungen</option>
      <option>JETZT KAUFEN</option>
      <option>NOCH WARTEN</option>
      <option>NICHT KAUFEN</option>
      <option>BEOBACHTEN</option>
      <option>HALTEN</option>
      <option>VERKAUF PRÜFEN</option>
      <option>JETZT VERKAUFEN</option>
    </select>

    <select id="trackedFilter">
      <option value="all">Alle Karten</option>
      <option value="tracked">Meine Käufe</option>
      <option value="notTracked">Ohne Kaufpreis</option>
    </select>

    <div
      id="status"
      class="status"
    >
      Wird geladen…
    </div>

  </div>

  <div
    id="storage"
    class="storage"
  >
    Lade Datenbankstatus…
  </div>

  <div class="rating-box">
    <div class="rating-head">
      <div>
        <div class="rating-title">Rating-Markt Intelligence</div>
        <div class="rating-sub">Base Rare • kompletter Rating-Markt • automatisch alle 60 Sekunden</div>
      </div>
      <div id="ratingSummary" class="rating-sub">Lade Rating-Märkte…</div>
    </div>

    <div class="rating-scroll">
      <table class="rating-table">
        <thead>
          <tr>
            <th>GES</th>
            <th>Median</th>
            <th>1m</th>
            <th>5m</th>
            <th>15m</th>
            <th>1h</th>
            <th>Steigen 5m</th>
            <th>Fallen 5m</th>
            <th>Nahe 24h-Tief</th>
            <th>Signal</th>
            <th>Rating-Aktion</th>
            <th>Sicherheit</th>
            <th>Grund</th>
          </tr>
        </thead>
        <tbody id="ratingRows"></tbody>
      </table>
    </div>
  </div>

  <table>

    <thead>
      <tr>
        <th>Spieler</th>
        <th>GES</th>
        <th>Typ</th>
        <th>Preis</th>
        <th>1m</th>
        <th>5m</th>
        <th>15m</th>
        <th>1h</th>
        <th>24h</th>
        <th>7d</th>
        <th>30d</th>
        <th>24h Tief</th>
        <th>24h Hoch</th>
        <th>Signal</th>
        <th>Score</th>
        <th>KI-Entscheidung</th>
        <th>KI-Sicherheit</th>
        <th>KI-Grund</th>
        <th>Kaufpreis</th>
        <th>Menge</th>
        <th>EA-Steuer</th>
        <th>Nach Steuer</th>
        <th>Netto-Gewinn</th>
        <th>Gewinn %</th>
        <th>Aktion</th>
      </tr>
    </thead>

    <tbody id="rows"></tbody>

  </table>

</div>

<script>

let allRows = [];
let allRatingRows = [];
let busy = false;

const fmt = value =>
  Number.isFinite(value)
    ? value.toLocaleString("de-DE")
    : "-";

function pctCell(value) {

  if (!Number.isFinite(value)) {
    return '<span class="muted">-</span>';
  }

  const cls =
    value > 0
      ? "pos"
      : value < 0
      ? "neg"
      : "";

  return (
    '<span class="' +
    cls +
    '">' +
    (value > 0 ? "+" : "") +
    value.toFixed(2) +
    "%</span>"
  );
}

function moneyClass(value) {
  if (!Number.isFinite(value)) return "";

  if (value > 0) return "pos";
  if (value < 0) return "neg";

  return "";
}


function renderRatings() {
  const body = document.getElementById("ratingRows");
  const summary = document.getElementById("ratingSummary");

  if (!body || !summary) return;

  const priority = {
    "KAUFZONE": 6,
    "STARK FALLEND": 5,
    "STARK STEIGEND": 4,
    "FÄLLT": 3,
    "STEIGEND": 2,
    "NEUTRAL": 1,
    "ZU WENIG DATEN": 0
  };

  const rows = [...allRatingRows].sort((a, b) => {
    const p =
      (priority[b.marketSignal] ?? 0) -
      (priority[a.marketSignal] ?? 0);

    if (p !== 0) return p;
    return b.rating - a.rating;
  });

  body.innerHTML = "";

  for (const row of rows) {
    const tr = document.createElement("tr");

    if (
      row.marketSignal === "KAUFZONE" ||
      row.marketSignal === "STARK FALLEND" ||
      row.marketSignal === "STARK STEIGEND"
    ) {
      tr.className = "rating-hot";
    }

    tr.innerHTML = \`
      <td class="strong">\${row.rating}</td>
      <td>\${fmt(row.medianPrice)}</td>
      <td>\${pctCell(row.change1m)}</td>
      <td>\${pctCell(row.change5m)}</td>
      <td>\${pctCell(row.change15m)}</td>
      <td>\${pctCell(row.change1h)}</td>
      <td>\${Number(row.risingPct5m ?? 0).toFixed(1)}%</td>
      <td>\${Number(row.fallingPct5m ?? 0).toFixed(1)}%</td>
      <td>\${Number(row.near24hLowPct ?? 0).toFixed(1)}%</td>
      <td class="rating-signal">\${row.marketSignal}</td>
      <td class="strong">\${row.marketAdvice}</td>
      <td>\${row.confidence}%</td>
      <td style="text-align:left; white-space:normal; min-width:320px">\${row.reason}</td>
    \`;

    body.appendChild(tr);
  }

  const alerts = rows.filter(
    row => !["NEUTRAL", "ZU WENIG DATEN"].includes(row.marketSignal)
  ).length;

  summary.textContent =
    rows.length +
    " Ratings • " +
    alerts +
    " aktive Rating-Signale";
}

function render() {

  const query =
    document
      .getElementById("search")
      .value
      .trim()
      .toLowerCase();

  const type =
    document
      .getElementById("type")
      .value;

  const minRating =
    Number(
      document
        .getElementById("minRating")
        .value
    );

  const signal =
    document
      .getElementById("signal")
      .value;

  const aiFilter =
    document
      .getElementById("aiFilter")
      .value;

  const trackedFilter =
    document
      .getElementById("trackedFilter")
      .value;

  const filtered =
    allRows.filter(row => {

      if (row.overall < minRating) {
        return false;
      }

      if (
        type !== "all" &&
        row.cardType !== type
      ) {
        return false;
      }

      if (
        signal !== "all" &&
        row.signal !== signal
      ) {
        return false;
      }

      if (
        aiFilter !== "all" &&
        row.aiAction !== aiFilter
      ) {
        return false;
      }

      if (
        trackedFilter === "tracked" &&
        !row.tracked
      ) {
        return false;
      }

      if (
        trackedFilter === "notTracked" &&
        row.tracked
      ) {
        return false;
      }

      if (query) {

        const hay =
          [
            row.name,
            row.rarityName,
            row.club,
            row.position
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        if (!hay.includes(query)) {
          return false;
        }
      }

      return true;
    });

  const rowsEl =
    document.getElementById("rows");

  rowsEl.innerHTML = "";

  for (
    const row of filtered.slice(0, 500)
  ) {

    const tr =
      document.createElement("tr");

    if (row.tracked) {
      tr.className = "tracked";
    }

    const buyInput =
      row.tracked
        ? fmt(row.buyPrice)
        : "-";

    const qty =
      row.tracked
        ? fmt(row.quantity)
        : "-";

    const action =
      row.tracked
        ? \`
            <button
              class="tiny"
              onclick="editPosition(\${row.eaId})"
            >
              Ändern
            </button>

            <button
              class="tiny"
              onclick="removePosition(\${row.eaId})"
            >
              Löschen
            </button>
          \`
        : \`
            <button
              class="tiny"
              onclick="editPosition(\${row.eaId})"
            >
              Kaufpreis
            </button>
          \`;

    tr.innerHTML = \`
      <td>
        <a
          href="\${row.url}"
          target="_blank"
        >
          \${row.name || "-"}
        </a>
      </td>

      <td>\${row.overall}</td>

      <td>\${row.cardType}</td>

      <td>\${fmt(row.price)}</td>

      <td>\${pctCell(row.change1m)}</td>

      <td>\${pctCell(row.change5m)}</td>

      <td>\${pctCell(row.change15m)}</td>

      <td>\${pctCell(row.change1h)}</td>

      <td>\${pctCell(row.change24h)}</td>

      <td>\${pctCell(row.change7d)}</td>

      <td>\${pctCell(row.change30d)}</td>

      <td>\${fmt(row.low24h)}</td>

      <td>\${fmt(row.high24h)}</td>

      <td class="strong">
        \${row.signal}
      </td>

      <td>
        \${row.score}
      </td>

      <td class="strong">
        \${row.aiAction}
      </td>

      <td>
        \${row.aiConfidence}%
      </td>

      <td style="text-align:left; white-space:normal; min-width:320px">
        \${row.aiReason}
      </td>

      <td>
        \${buyInput}
      </td>

      <td>
        \${qty}
      </td>

      <td>
        \${fmt(row.tax)}
      </td>

      <td>
        \${fmt(row.saleAfterTax)}
      </td>

      <td class="\${moneyClass(row.netProfitTotal)} strong">
        \${fmt(row.netProfitTotal)}
      </td>

      <td>
        \${pctCell(row.profitPercent)}
      </td>

      <td>
        \${action}
      </td>
    \`;

    rowsEl.appendChild(tr);
  }

  document
    .getElementById("status")
    .textContent =
      filtered.length +
      " passende Karten • zeige " +
      Math.min(
        500,
        filtered.length
      );

}

async function editPosition(eaId) {

  const row =
    allRows.find(
      item => item.eaId === eaId
    );

  if (!row) return;

  const current =
    row.tracked
      ? String(row.buyPrice)
      : "";

  const buyRaw =
    prompt(
      "Kaufpreis für " +
      row.name +
      " in Coins:",
      current
    );

  if (buyRaw === null) return;

  const buyPrice =
    Number(
      String(buyRaw)
        .replace(/[.\s]/g, "")
        .replace(",", "")
    );

  if (
    !Number.isInteger(buyPrice) ||
    buyPrice <= 0
  ) {
    alert("Ungültiger Kaufpreis.");
    return;
  }

  const qtyRaw =
    prompt(
      "Wie viele Karten?",
      row.tracked
        ? String(row.quantity || 1)
        : "1"
    );

  if (qtyRaw === null) return;

  const quantity =
    Number(qtyRaw);

  if (
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    quantity > 1000
  ) {
    alert("Ungültige Menge.");
    return;
  }

  const response =
    await fetch(
      "/api/position",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body: JSON.stringify({
          eaId,
          buyPrice,
          quantity
        })
      }
    );

  const json =
    await response.json();

  if (!response.ok || !json.ok) {
    alert(
      json.error ||
      "Speichern fehlgeschlagen"
    );
    return;
  }

  await load();

}

async function removePosition(eaId) {

  const row =
    allRows.find(
      item => item.eaId === eaId
    );

  if (!row) return;

  if (
    !confirm(
      "Kaufpreis für " +
      row.name +
      " löschen?"
    )
  ) {
    return;
  }

  const response =
    await fetch(
      "/api/position/" + eaId,
      {
        method: "DELETE"
      }
    );

  const json =
    await response.json();

  if (!response.ok || !json.ok) {
    alert(
      json.error ||
      "Löschen fehlgeschlagen"
    );
    return;
  }

  await load();

}

async function load() {

  if (busy) return;

  busy = true;

  const status =
    document.getElementById("status");

  status.textContent =
    "Aktualisiere…";

  try {

    const response =
      await fetch(
        "/api/trading",
        {
          cache: "no-store"
        }
      );

    const json =
      await response.json();

    if (
      !response.ok ||
      !json.ok
    ) {
      throw new Error(
        json.error ||
        "Abruf fehlgeschlagen"
      );
    }

    allRows =
      json.rows || [];

    allRatingRows =
      json.ratingIntelligence || [];

    const dataMode =
      json.dataMode?.mode || "LIVE";

    const sourceStatus =
      json.sourceHealth?.status || "UNKNOWN";

    status.textContent =
      dataMode === "LIVE"
        ? "LIVE • FUT.GG " + sourceStatus
        : dataMode === "FUTBIN_FALLBACK_SAFE"
        ? "🟡 FUTBIN FALLBACK SAFE • Anzeige-only • Brain/Alerts pausiert"
        : dataMode === "STALE_SAFE"
        ? "⚠ STALE SAFE • letzte geprüfte Daten • FUT.GG " + sourceStatus
        : "Warte auf sicheren FUT.GG-Markt-Snapshot…";

    document
      .getElementById("storage")
      .textContent =
        (
          json.dbEnabled
            ? "Dauerhafte Historie: AN"
            : "Dauerhafte Historie: AUS"
        ) +
        " • Datenmodus: " +
        dataMode +
        " • FUT.GG: " +
        sourceStatus +
        " • " +
        json.historyNote +
        " • Eigene Käufe: " +
        json.trackedPositions +
        " • KI jetzt kaufen: " +
        (json.aiSummary?.buyNow ?? 0) +
        " • KI Verkauf prüfen: " +
        (json.aiSummary?.sellCheck ?? 0) +
        " • Rating-Signale: " +
        (json.ratingAlerts ?? 0) +
        " • Gemini: " +
        (json.geminiQuota?.usedToday ?? 0) +
        "/" +
        (json.geminiQuota?.dailyBudget ?? 15) +
        " • Discord: " +
        (json.discord?.configured ? "AN" : "AUS") +
        " • Aktualisiert " +
        new Date(
          json.updatedAt
        ).toLocaleTimeString(
          "de-DE"
        );

    renderRatings();
    render();

  } catch (error) {

    status.textContent =
      "Fehler: " +
      error.message;

  } finally {

    busy = false;

  }

}

for (
  const id of [
    "search",
    "type",
    "minRating",
    "signal",
    "aiFilter",
    "trackedFilter"
  ]
) {

  document
    .getElementById(id)
    .addEventListener(
      id === "search"
        ? "input"
        : "change",
      render
    );

}

load();

setInterval(
  load,
  60_000
);

</script>

</body>
</html>`);
});

async function startMonitoring() {
  if (monitoringStarted) return;

  monitoringStarted = true;

  try {
    await initDb();
  } catch (error) {
    console.error(
      "DB init error:",
      error
    );

    lastMonitorError =
      "DB init: " +
      String(error);
  }

  if (DISCORD_CONFIGURED) {
    await initDiscordBot();
  }

  await sendDiscordStartupMessage();
  monitorOnce();

  monitorIntervalHandle = setInterval(
    monitorOnce,
    PRICE_REFRESH_MS
  );

  metadataIntervalHandle = setInterval(
    () => {
      ensureUniverse(true).catch(
        error => {
          console.error(
            "metadata refresh error:",
            error
          );
        }
      );
    },
    META_REFRESH_MS
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function gracefulShutdown(reason = "shutdown") {
  if (shuttingDown) return;

  shuttingDown = true;
  shutdownStartedAt = new Date().toISOString();
  shutdownReason = String(reason);
  monitoringStarted = false;

  console.log(`Graceful shutdown gestartet: ${shutdownReason}`);

  if (monitorIntervalHandle) {
    clearInterval(monitorIntervalHandle);
    monitorIntervalHandle = null;
  }
  if (metadataIntervalHandle) {
    clearInterval(metadataIntervalHandle);
    metadataIntervalHandle = null;
  }

  // Einen laufenden Marktzyklus kurz sauber auslaufen lassen.
  const waitUntil = Date.now() + 10_000;
  while (monitoringBusy && Date.now() < waitUntil) {
    await sleep(100);
  }

  try {
    if (discordClient) discordClient.destroy();
  } catch (error) {
    console.error("Discord shutdown error:", error);
  }

  if (pool) {
    try {
      await Promise.race([pool.end(), sleep(5_000)]);
    } catch (error) {
      console.error("PostgreSQL shutdown error:", error);
    }
  }

  if (httpServer) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  console.log("Graceful shutdown abgeschlossen.");
  process.exit(0);
}

process.once("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(error => {
    console.error("SIGTERM shutdown error:", error);
    process.exit(1);
  });
});

process.once("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(error => {
    console.error("SIGINT shutdown error:", error);
    process.exit(1);
  });
});

httpServer = app.listen(
  port,
  () => {
    console.log(
      `FC Trading Intelligence v10.47 Rating Only Hard Gate (FC${GAME_YEAR}) running on ${port}`
    );

    startMonitoring();
  }
);