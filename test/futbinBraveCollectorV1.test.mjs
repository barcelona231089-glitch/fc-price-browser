import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectCollectorCards } from "../futbinBraveCollectorV1.js";
import { parseAuthorizedFutbinImport } from "../futbinAuthorizedImportV1.js";

test("collector selects mapped FC27 cards and ignores low/unmapped rows", () => {
  const rows = [
    { eaId: 230899, name: "Lookman", overall: 87, price: 10000, aiAction: "BUY", aiConfidence: 80 },
    { eaId: 1397, name: "Zidane", overall: 94, price: 3000000, tracked: true },
    { eaId: 999999999, name: "Unknown", overall: 90, price: 5000 },
    { eaId: 20801, name: "Low", overall: 79, price: 5000 }
  ];
  const out = selectCollectorCards(rows, { maxCards: 3, cursor: 0 });
  assert.equal(out.cards.length, 2);
  assert.ok(out.cards.every(card => Number(card.futbinId) > 0));
  assert.ok(out.cards.some(card => String(card.eaId) === "230899"));
  assert.ok(out.cards.some(card => String(card.eaId) === "1397"));
});

test("authorized import never invents a missing observation timestamp", () => {
  const out = parseAuthorizedFutbinImport([
    { futbinId: 778, priceConsole: 10000 },
    { futbinId: 778, priceConsole: 10000, observedAt: "2026-09-21T20:00:00Z" }
  ]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].observedAt, "2026-09-21T20:00:00.000Z");
});

test("collector launcher uses one isolated reusable Brave page", () => {
  const source = readFileSync(new URL("../futbinBraveCollectorV1.js", import.meta.url), "utf8");
  const launcher = readFileSync(new URL("../startFutbinBraveBrowser.ps1", import.meta.url), "utf8");
  const supervisor = readFileSync(new URL("../startFutbinBraveCollectorHidden.ps1", import.meta.url), "utf8");
  assert.ok(source.includes('method: "Browser.close"'));
  assert.equal(source.includes("Stop-Process -Id $_.ProcessId -Force"), false);
  assert.ok(launcher.includes("--app=https://www.futbin.com/27/players"));
  assert.equal(launcher.includes("--new-window"), false);
  assert.ok(launcher.includes("Default\\Sessions"));
  assert.ok(supervisor.includes("FUTBIN_BRAVE_CLOSE_AFTER_CYCLE = '0'"));
});
