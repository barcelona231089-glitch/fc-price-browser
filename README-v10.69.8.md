# FC Trader Brain v10.69.8 — Parse FUTBIN Evidence Adapter

## What this fixes

The direct Hostless -> FUTBIN collector is receiving HTTP 403. v10.69.8 adds
a managed Parse API transport for supplemental FUTBIN evidence.

FUT.GG stays the sole live price / market authority.

Parse/FUTBIN may contribute only:
- Games
- Sales History
- Popular Rank

Trader Brain continues to calculate Liquidity itself from observed completed
sales.

## Important current limitation

The public Parse FUTBIN marketplace API currently exposes player search,
player details, prices/stats, market trends, SBCs, objectives and evolutions,
but it does NOT currently expose the three evidence fields we need:
Games, completed Sales History and Popular Rank.

Therefore v10.69.8 is intentionally fail-closed:
- it never invents those fields,
- it never uses Parse price fields as FUT.GG replacements,
- it reports `EVIDENCE_ENDPOINT_NOT_AVAILABLE` until a Parse endpoint that
  actually returns verified evidence is available.

The adapter expects the endpoint name:

`get_player_evidence`

You can change it without redeploying code using:

`FUTBIN_PARSE_EVIDENCE_ENDPOINT=<endpoint-name>`

A ready-to-paste request for the Parse API agent is included in
`PARSE-ENDPOINT-PROMPT.txt`.

## Files to upload

Upload/replace:
- package.json
- futbinParseEvidenceAdapterV10698.js
- v10698Register.mjs
- v10698Loader.mjs
- test/futbinParseEvidenceAdapterV10698.test.mjs

Keep all existing v10.69.6/v10.69.5 files. The register chain is:

v10.69.8 -> v10.69.6 -> v10.69.5 -> older runtime patches

## Hostless environment

Keep:

`MARKET_EVIDENCE_FUTBIN_AUTHORIZED=false`

Add:

`FUTBIN_PARSE_API_KEY=<your Parse API key>`

Optional/default:

`FUTBIN_PARSE_BASE_URL=https://api.parse.bot/scraper/21963078-8a17-40ff-a896-9b0b0ec3e828`

`FUTBIN_PARSE_EVIDENCE_ENDPOINT=get_player_evidence`

`MARKET_EVIDENCE_PARSE_BATCH=3`

`MARKET_EVIDENCE_PARSE_DAILY_BUDGET=20`

`MARKET_EVIDENCE_PARSE_MIN_DELAY_MS=13000`

The default delay stays below the published free-tier 5 req/min limit.

## Expected status

Before a Parse API key:

`parseAdapter.status = NOT_CONFIGURED`

With a key but before the evidence endpoint exists:

`parseAdapter.status = EVIDENCE_ENDPOINT_NOT_AVAILABLE`

Once the endpoint exists and returns verified data:

`parseAdapter.status = READY`

and the Evidence API should begin showing non-zero values for:
- cachedCards
- cardsWithGames
- cardsWithPopularRank
- salesLoaded

The source should become:

`FUTBIN_PARSE_MANAGED_API`

## Guardrails

- Parse current price fields are ignored by this evidence adapter.
- Missing Games/Sales/Popular remain null/empty.
- Exact card matching uses name + rating + version and rejects ambiguity.
- No synthetic sales.
- No direct FUTBIN request is made by the v10.69.8 Parse path.
- When Parse is configured, it owns the supplemental collection path. The
  runtime does not silently jump back to the direct FUTBIN collector or Gemini.
