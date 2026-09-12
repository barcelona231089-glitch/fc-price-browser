# v10.69.9.6.5 Leak Hotfix L2

Adds a third public-only fallback when direct X syndication and the existing public mirrors are unavailable or stale.

The fallback reads Bing's public RSS search index to discover public `x.com/<handle>/status/<id>` URLs. Event time is derived from the public X snowflake status id, not from search crawl time. Only posts inside the existing max-age window are accepted.

Existing L1 behavior remains: FutSheriff, FutPoliceLeaks, Criminal__x and Futdonk, plus FC27 prelaunch intake while GAME_YEAR is still 26.

This does not use login credentials, private channels, CAPTCHA bypass, or synthetic leak data.
