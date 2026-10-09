# FC27 API source audit (2026-10-09)

Goal: verified FC27 Ultimate Team live coin prices for the UV app. A reachable documentation page is NOT proof of a working price API.

| Provider | URL | Tested on Messi | Live price confirmed? |
| --- | --- | --- | --- |
| FUTBIN | https://www.futbin.com/27/players | HTTP 403, zero captured requests | NO |
| FCRadar | https://pub-api.fcradar.gg/v1/games | HTTP 401; Bearer key required | NO; mainly player/career data |
| Parse FUT.GG | https://parse.bot/marketplace/21627d36-0117-4b4e-9528-0a138ddc3f31/fut-gg-api | HTTP 200 documentation page ONLY | NO; X-API-Key required |

Parse FUT.GG documentation describes `list_players` (card_id, name, rating, platform-specific price, filters and pagination), `get_card_prices` (price, history, trends, completed_auctions and live_auctions), and `list_holographic_players`. Its published free plan offers 200 credits/month, 5 requests/min; calls consume credits. None of these provider-claimed response fields has been verified by an authorized live API call.

## Integration acceptance criteria

Before enabling a provider in UV: authorized request must succeed; confirm FC27 card ID, platform (PS/PC), integer coin price, update timestamp, freshness, rate limits and permission for reuse. Validate completed sales separately. Keep FC25/26/27 distinct. Store API keys only server-side. Never bypass 401/403/429 or CAPTCHA. No purchase, API key or account action performed.

References: https://fcradar.gg/developers ; https://parse.bot/marketplace/21627d36-0117-4b4e-9528-0a138ddc3f31/fut-gg-api ; https://help.ea.com/en/articles/ea-sports-fc/community-api/
