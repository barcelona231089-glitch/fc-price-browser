import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../futbinEvidenceAdapterV10696.js";

test("exact search match rejects ambiguous cards", () => {
  const row = { name: "Example Player", overall: 90, cardType: "TOTW" };
  const items = [
    { id: 10, name: "Example Player", version: "TOTW", ratingSquare: { rating: "90" }, location: { url: "/26/player/10/example" } },
    { id: 11, name: "Example Player", version: "Gold Rare", ratingSquare: { rating: "90" }, location: { url: "/26/player/11/example" } }
  ];
  assert.equal(__test.selectExactSearchMatch(items, row)?.id, 10);
});

test("usage parser reads console and PC games", () => {
  const html = `<p>He has been used in 1,083,509 games with a GPG of 0.098.
                He has been used in 227,893 games with a GPG of 0.096.</p>`;
  assert.deepEqual(__test.parseUsageGames(html), {
    games: 1311402,
    gamesConsole: 1083509,
    gamesPc: 227893
  });
});

test("popular parser ranks unique FUTBIN ids", () => {
  const html = `
    <a class="playercard-wrapper" href="/26/player/100/a"></a>
    <a class="playercard-wrapper" href="/26/player/200/b"></a>
    <a href="/26/player/100/a">duplicate</a>`;
  const ranks = __test.extractPopularIds(html);
  assert.equal(ranks.get("100"), 1);
  assert.equal(ranks.get("200"), 2);
});

test("sales path prefers confirmed Full History link", () => {
  const html = `<a class="market-grid-lates-sale-link" href="/26/sales/357/estevao?platform=ps">Full History</a>`;
  assert.equal(__test.resolveSalesPath(html), "/26/sales/357/estevao");
});

test("sales parser keeps only sold rows and computes fallback tax/net", () => {
  const html = `
    <table class="auctions-table"><tbody>
      <tr>
        <td><div><i class="fa fa-check"></i><span class="sales-date-time">Sep 10, 7:15 PM</span></div></td>
        <td>10,000</td><td>12,000</td><td></td><td></td>
      </tr>
      <tr>
        <td><div><i class="fa fa-times"></i><span class="sales-date-time">Sep 10, 7:10 PM</span></div></td>
        <td>10,000</td><td>11,000</td><td>550</td><td>10,450</td>
      </tr>
    </tbody></table>`;
  const rows = __test.parseSalesHistory(html, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].soldFor, 12000);
  assert.equal(rows[0].eaTax, 600);
  assert.equal(rows[0].netPrice, 11400);
  assert.match(rows[0].date, /^2026-09-10T18:15:00\.000Z$/);
});
