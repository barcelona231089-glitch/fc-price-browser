# FC Trader Brain v10.69.9.6.5 Leak Hotfix L1

Targeted pre-FC27 public leak intake patch layered on the existing 6.5 archive build.

## Direct public sources
- @FutSheriff
- @FutPoliceLeaks
- @Criminal__x
- @Futdonk

The existing Telegram preview/fallback sources and source-attribution logic are not removed.

## FC27 prelaunch behavior
When the live runtime is still `GAME_YEAR=26`, posts that explicitly mention `FC27` are now accepted as relevant public leak input. This can be disabled with `PUBLIC_LEAK_ACCEPT_NEXT_GAME_YEAR=false`.

## Safety
No authentication bypass, private channels, paywalls, CAPTCHA bypass or aggressive retry behavior is added.
