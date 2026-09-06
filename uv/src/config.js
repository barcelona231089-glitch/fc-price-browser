export const GAME_YEAR = Math.max(26, Number(process.env.GAME_YEAR || 26));
export const PRICE_REFRESH_MS = Math.max(15, Number(process.env.PRICE_REFRESH_SECONDS || 60)) * 1000;
export const META_REFRESH_MS = Math.max(5, Number(process.env.META_REFRESH_MINUTES || 30)) * 60_000;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_PAGES = 60;
export const META_CONCURRENCY = 3;
export const RATING_MIN = 75;
export const RATING_MAX = 99;
export const HISTORY_SAMPLE_LIMIT = Math.max(100, Math.min(2000, Number(process.env.HISTORY_SAMPLE_LIMIT || 700)));
export const FUTBIN_CROSSCHECK_LIMIT = Math.max(0, Math.min(50, Number(process.env.FUTBIN_CROSSCHECK_LIMIT || 12)));
export const FUTBIN_PARSE_API_BASE = String(process.env.FUTBIN_PARSE_API_BASE || "https://api.parse.bot/scraper/21963078-8a17-40ff-a896-9b0b0ec3e828").replace(/\/$/, "");
export const FUTBIN_SEARCH_ENDPOINT = String(process.env.FUTBIN_SEARCH_ENDPOINT || (GAME_YEAR === 26 ? 'search_players_fc26' : `search_players_fc${GAME_YEAR}`));
export const DEMAND_REFRESH_MS = Math.max(10, Number(process.env.DEMAND_REFRESH_MINUTES || 30)) * 60_000;
export const FUTGG_MOST_USED_URL = String(process.env.FUTGG_MOST_USED_URL || "https://www.fut.gg/tactics/most-used-players/");
export const FUTGG_MOMENTUM_URL = String(process.env.FUTGG_MOMENTUM_URL || "https://www.fut.gg/players/momentum/");
export const FUTGG_IN_PACKS_URL = String(process.env.FUTGG_IN_PACKS_URL || "https://www.fut.gg/players/in-packs/");
export const HISTORY_MONITOR_MS = Math.max(60, Number(process.env.HISTORY_MONITOR_SECONDS || 60)) * 1000;
export const HISTORY_MONITOR_MAX_CARDS = Math.max(100, Math.min(600, Number(process.env.HISTORY_MONITOR_MAX_CARDS || 350)));
export const HISTORY_HEARTBEAT_MINUTES = Math.max(5, Math.min(60, Number(process.env.HISTORY_HEARTBEAT_MINUTES || 15)));

// v2.9.0 CPU-safe live recheck defaults for constrained hosts.
export const LIVE_RECHECK_BATCH_SIZE = Math.max(2, Math.min(20, Number(process.env.LIVE_RECHECK_BATCH_SIZE || 5)));
export const LIVE_RECHECK_BATCH_PAUSE_MS = Math.max(25, Math.min(1000, Number(process.env.LIVE_RECHECK_BATCH_PAUSE_MS || 180)));
export const LIVE_RECHECK_MAX_QUEUE = Math.max(1, Math.min(10, Number(process.env.LIVE_RECHECK_MAX_QUEUE || 3)));
export const LIVE_RECHECK_JOB_TTL_MS = Math.max(120_000, Math.min(3_600_000, Number(process.env.LIVE_RECHECK_JOB_TTL_MS || 600_000)));
