# FC Trader Brain v10.69.6 — FUTBIN Evidence Adapter

Purpose:
- FUT.GG remains the sole live price / market authority.
- FUTBIN is supplemental evidence only:
  - Games / usage counts
  - completed Sales History
  - Popular Rank
- Liquidity stays inside Trader Brain and is calculated from observed completed sales.

Safety / source policy:
- Read-only GET requests only.
- Exact card matching by name + rating + version where available.
- Never guesses a sales URL. It resolves the confirmed Full History link from the card's `/market` page.
- No proxy rotation, stealth browser, Cloudflare challenge bypass, CAPTCHA bypass, or login automation.
- 403/429 fail closed.
- Missing evidence stays null/empty.
- Direct automated FUTBIN access is OFF by default. Enable only if you are authorized to automate that source.

Required Hostless environment variable for direct mode:
MARKET_EVIDENCE_FUTBIN_AUTHORIZED=true

Optional:
MARKET_EVIDENCE_PLATFORM=ps
MARKET_EVIDENCE_FUTBIN_BATCH=8
MARKET_EVIDENCE_FUTBIN_SALES_CARDS=4
MARKET_EVIDENCE_FUTBIN_SALES_LIMIT=100
MARKET_EVIDENCE_FUTBIN_REQUEST_DELAY_MS=1200
MARKET_EVIDENCE_FUTBIN_TIMEOUT_MS=12000
MARKET_EVIDENCE_FUTBIN_POPULAR_CACHE_MIN=20
MARKET_EVIDENCE_FUTBIN_MIN_RATING=82

Upload to repository root:
- package.json (replace)
- futbinEvidenceAdapterV10696.js
- v10696Register.mjs
- v10696Loader.mjs

Also upload:
- test/futbinEvidenceAdapterV10696.test.mjs

Then rebuild/deploy Hostless from main.

Expected log:
[v10.69.6] FUTBIN Evidence Adapter active: exact matching + Games/Sales/Popular, no bypass.

Verification:
1. GET / should show version 10.69.6-final.
2. GET /api/market/v1/evidence/status should show:
   apiVersion 1.2.0
   build 10.69.6
   directAdapter.adapterVersion 10.69.6
3. With authorized direct mode enabled and live candidates flowing, directAdapter should move from IDLE/NO_CANDIDATES to FETCHING/READY. In this mode Gemini is not used as a fallback collector.
4. cardsWithGames / cardsWithPopularRank / salesLoaded should begin increasing when FUTBIN returns verified evidence.
5. If FUTBIN replies 403/429, the adapter stops instead of attempting a bypass.
