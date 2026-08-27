# FC Price Browser

Minimal Render backend for testing whether a normal Chromium browser can load a public FUT.GG player page.

## Endpoints

- `/` returns service status.
- `/price?url=https://www.fut.gg/players/...` loads the supplied FUT.GG URL in headless Chromium and returns basic page information plus a short text preview.

## Render

This project includes `render.yaml`.

Build command:
`npm install && npx playwright install chromium`

Start command:
`npm start`

## Important

This first version is only a connectivity/page-load test. It does not bypass access controls or reproduce protected FUT.GG verification/signature mechanisms.
