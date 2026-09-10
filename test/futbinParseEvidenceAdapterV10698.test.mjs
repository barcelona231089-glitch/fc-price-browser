import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../futbinParseEvidenceAdapterV10698.js";

test("exact match requires name/rating/version and rejects ambiguity", () => {
  const row = { name: "Alexia Putellas", overall: 93, cardType: "TOTS" };
  const items = [
    { id: "1", name: "Alexia Putellas", rating: "93", version: "TOTS" },
    { id: "2", name: "Alexia Putellas", rating: "91", version: "Gold Rare" }
  ];
  assert.equal(__test.exactMatch(items, row).id, "1");

  const ambiguous = [
    { id: "1", name: "Alexia Putellas", rating: "93", version: "TOTS" },
    { id: "3", name: "Alexia Putellas", rating: "93", version: "TOTS" }
  ];
  assert.equal(__test.exactMatch(ambiguous, row), null);
});

test("normalizes Parse response wrapper", () => {
  assert.deepEqual(
    __test.unwrap({ status: "success", data: { ok: 1 } }),
    { ok: 1 }
  );
});

test("normalizes games, popular rank and completed sales", () => {
  const payload = {
    status: "success",
    data: {
      games_console: 1000,
      games_pc: 250,
      popular_rank: 17,
      sales_history: [
        {
          status: "sold",
          sold_at: "2026-09-10T18:15:00Z",
          listed_for: 120000,
          sold_for: 118000
        },
        {
          status: "expired",
          listed_for: 125000,
          sold_for: 0
        }
      ]
    }
  };

  const card = __test.normalizeEvidence(
    payload,
    { eaId: 123, name: "Player", overall: 93, cardType: "TOTS" },
    { id: "99", rating: 93, version: "TOTS", sourceUrl: "https://www.futbin.com/26/player/99/player" }
  );

  assert.equal(card.games, 1250);
  assert.equal(card.gamesConsole, 1000);
  assert.equal(card.gamesPc, 250);
  assert.equal(card.popularRank, 17);
  assert.equal(card.sales.length, 1);
  assert.equal(card.sales[0].soldFor, 118000);
  assert.equal(card.sales[0].eaTax, 5900);
  assert.equal(card.sales[0].netPrice, 112100);
});

test("does not turn Parse price fields into evidence", () => {
  const payload = {
    status: "success",
    data: {
      price_ps: "100K",
      price_pc: "110K",
      prices: { ps: { price: "100K" } }
    }
  };
  const card = __test.normalizeEvidence(
    payload,
    { eaId: 123, name: "Player", overall: 93, cardType: "TOTS" },
    { id: "99", rating: 93, version: "TOTS" }
  );
  assert.equal(card, null);
});
