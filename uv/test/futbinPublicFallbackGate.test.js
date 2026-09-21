import test from "node:test";
import assert from "node:assert/strict";
import { getPublicFutbinCards, isPublicFutbinEnabled } from "../src/futbinPublicFallback.js";

test("public FUTBIN HTML fallback is off by default", async () => {
  const prevEnabled = process.env.FUTBIN_PUBLIC_ENABLED;
  const prevConfirmed = process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  delete process.env.FUTBIN_PUBLIC_ENABLED;
  delete process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  assert.equal(isPublicFutbinEnabled(), false);
  const out = await getPublicFutbinCards([{ eaId: "1", name: "Test" }], "console", { gameYear: 27 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "FUTBIN_PUBLIC_DISABLED");
  if (prevEnabled === undefined) delete process.env.FUTBIN_PUBLIC_ENABLED;
  else process.env.FUTBIN_PUBLIC_ENABLED = prevEnabled;
  if (prevConfirmed === undefined) delete process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  else process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED = prevConfirmed;
});

test("public FUTBIN HTML fallback requires both activation flags", () => {
  const prevEnabled = process.env.FUTBIN_PUBLIC_ENABLED;
  const prevConfirmed = process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  process.env.FUTBIN_PUBLIC_ENABLED = "1";
  delete process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  assert.equal(isPublicFutbinEnabled(), false);
  process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED = "1";
  assert.equal(isPublicFutbinEnabled(), true);
  if (prevEnabled === undefined) delete process.env.FUTBIN_PUBLIC_ENABLED;
  else process.env.FUTBIN_PUBLIC_ENABLED = prevEnabled;
  if (prevConfirmed === undefined) delete process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED;
  else process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED = prevConfirmed;
});
