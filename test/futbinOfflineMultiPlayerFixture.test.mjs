import test from "node:test";
import assert from "node:assert/strict";
import { parseFutbinPlayerHtml } from "../futbinMarketV1064.js";

const cases = [
  ["Player A", 245000, 247000, 252000],
  ["Player B", 98500, 99000, 103000],
  ["Player C", 12500, 13000, 14250],
  ["Player D", 1450000, 1475000, 1510000],
];

for (const [name, ps, xbox, pc] of cases) {
  test(`offline visible prices parse correctly: ${name}`, () => {
    const fmt = n => n.toLocaleString("en-US");
    const html = `<html><body>
      <h1>${name}</h1>
      <p>His current price on FUT is ${fmt(ps)} on PlayStation,
      ${fmt(xbox)} on Xbox, and ${fmt(pc)} on PC.</p>
    </body></html>`;
    const parsed = parseFutbinPlayerHtml(html);
    assert.equal(parsed.pricePlayStation, ps);
    assert.equal(parsed.priceXbox, xbox);
    assert.equal(parsed.pricePc, pc);
  });
}

test("missing PC price remains null", () => {
  const html = `<p>His current price on FUT is 88,000 on PlayStation, 89,000 on Xbox.</p>`;
  const parsed = parseFutbinPlayerHtml(html);
  assert.equal(parsed.pricePlayStation, 88000);
  assert.equal(parsed.priceXbox, 89000);
  assert.equal(parsed.pricePc, null);
});
