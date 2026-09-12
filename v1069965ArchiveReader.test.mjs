import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  patchTwoYearArchiveV1069965,
  patchPermanentMlArchiveV1069965
} from "../v1069965Loader.mjs";

async function source(name) {
  return readFile(new URL(`../${name}`, import.meta.url), "utf8");
}

test("v10.69.9.6.5 wires the real historical archive into the 730d AI reader", async () => {
  const raw = await source("twoYearAiContextV106996.js");
  const patched = patchTwoYearArchiveV1069965(raw);

  assert.match(patched, /fc_historical_price_archive/);
  assert.match(patched, /archiveTablePresent/);
  assert.match(patched, /HISTORICAL_ARCHIVE_PLATFORM/);
  assert.match(patched, /d730: periodStats\(yearRows, 730/);
  assert.match(patched, /crossSeasonAbsoluteChangePct: null/);
  assert.match(patched, /rawPricesMergedAcrossGameYears: false/);
  assert.doesNotMatch(patched, /synthetic:\s*true/);
});

test("v10.69.9.6.5 gives Permanent ML archive input and time-aware horizons", async () => {
  const raw = await source("permanentMlBrainV106996.js");
  const patched = patchPermanentMlArchiveV1069965(raw);

  assert.match(patched, /fc_historical_price_archive/);
  assert.match(patched, /v10\.69\.9\.6\.5 time-aware historical labels/);
  assert.match(patched, /atOrBefore/);
  assert.match(patched, /atOrAfter/);
  assert.match(patched, /future24/);
  assert.match(patched, /future7/);
  assert.match(patched, /sourceSql = sources\.join\(" UNION "\)/);
  assert.doesNotMatch(patched, /synthetic:\s*true/);
});
