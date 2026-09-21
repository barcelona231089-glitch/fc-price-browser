import test from "node:test";
import assert from "node:assert/strict";
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
