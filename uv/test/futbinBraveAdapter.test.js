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
