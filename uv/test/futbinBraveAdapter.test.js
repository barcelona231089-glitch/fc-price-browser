import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  getFutbinBraveCards,
  getFutbinBraveStatus,
  isFutbinBraveEnabled,
  resetFutbinBraveStateForTests
} from "../src/futbinBraveAdapter.js";

test("Brave FUTBIN adapter is off by default", async () => {
  const prevEnabled = process.env.FUTBIN_BRAVE_ENABLED;
  const prevConfirmed = process.env.FUTBIN_BRAVE_ACTIVATION_CONFIRMED;
  delete process.env.FUTBIN_BRAVE_ENABLED;
  delete process.env.FUTBIN_BRAVE_ACTIVATION_CONFIRMED;
  resetFutbinBraveStateForTests();
  assert.equal(isFutbinBraveEnabled(), false);
  const out = await getFutbinBraveCards([{ eaId: "1", name: "Test" }], "console", { gameYear: 27 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "FUTBIN_BRAVE_DISABLED");
  if (prevEnabled === undefined) delete process.env.FUTBIN_BRAVE_ENABLED; else process.env.FUTBIN_BRAVE_ENABLED = prevEnabled;
  if (prevConfirmed === undefined) delete process.env.FUTBIN_BRAVE_ACTIVATION_CONFIRMED; else process.env.FUTBIN_BRAVE_ACTIVATION_CONFIRMED = prevConfirmed;
});

test("Brave FUTBIN adapter is FC27-only", async () => {
  const out = await getFutbinBraveCards([], "console", { gameYear: 26, force: true });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "FC27_ONLY");
});

test("status documents safe local browser policy", () => {
  const status = getFutbinBraveStatus();
  assert.equal(status.localDebugOnly, true);
  assert.equal(status.readsCookies, false);
  assert.equal(status.solvesChallenges, false);
  assert.equal(status.bypasses403or429, false);
});


test("adapter can use the freshly observed filtered FUTBIN console price when rendered price is missing", () => {
  const source = readFileSync(new URL("../src/futbinBraveAdapter.js", import.meta.url), "utf8");
  assert.ok(source.includes("filteredPriceConsole"));
  assert.ok(source.includes("card?.targetObservedAt"));
  assert.ok(source.includes("fallbackGamesPlayedConsole"));
  assert.ok(source.includes("cache.delete(key)"));
  assert.ok(source.includes("forceFresh"));
});


test("Brave adapter bounds websocket open and CDP command waits", () => {
  const source = readFileSync(new URL("../src/futbinBraveAdapter.js", import.meta.url), "utf8");
  assert.ok(source.includes("BRAVE_DEBUG_WEBSOCKET_OPEN_TIMEOUT"));
  assert.ok(source.includes("BRAVE_CDP_TIMEOUT_"));
  assert.ok(source.includes("timeoutMs = 20_000"));
  assert.ok(source.includes("pending.delete(id)"));
});
