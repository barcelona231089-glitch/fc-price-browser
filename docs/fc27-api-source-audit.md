# FC27 FUTBIN-only API audit (2026-10-09)

## Mandatory source policy

**Only FUTBIN is allowed as an FC27 market-price data source.** Do not search, import, suggest, configure or integrate FUT.GG, Parse FUT.GG, FCRadar or other substitute providers into the API Traffic Finder / UV workflow. No automatic fallback to another provider. The application must return `unavailable` rather than fabricating prices when FUTBIN is inaccessible.

## FUTBIN verification

- Tested public target: `https://www.futbin.com/27/players`
- Direct automated scan on Messi: HTTP 403, 0 captured requests, 0 verified API candidates.
- Older FUTBIN endpoint names are historical leads, **not** verified FC27 APIs.
- No live FUTBIN price API has been verified. Never bypass access controls, CAPTCHA or rate limits.

## Integration acceptance criteria

Before enabling a FUTBIN endpoint in UV, verify authorized HTTP success and an actual FC27 player ID, platform, coin price, freshness/update timestamp, and applicable usage permissions. Verify completed sales separately. Keep FC25/FC26/FC27 distinct, and never expose secrets in frontend code. No verified source means no UV market-price recommendation.
