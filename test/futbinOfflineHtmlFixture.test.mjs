import test from "node:test";
import assert from "node:assert/strict";
import { parseFutbinPlayerHtml } from "../futbinMarketV1064.js";

test("offline FUTBIN HTML fixture reads visible FC27 platform prices", () => {
  const html = `
    <div class="price-box-background-graph"
      data-recent-prices="117000,117000,117000,117000,117000"></div>
    <div class="price inline-with-icon lowest-price-1">117,000</div>
    <p>His current price on FUT is 117,000 on PlayStation,
      117,000 on Xbox, and 119,000 on PC.</p>`;

  const parsed = parseFutbinPlayerHtml(html);
  assert.equal(parsed.pricePlayStation, 117000);
  assert.equal(parsed.priceXbox, 117000);
  assert.equal(parsed.pricePc, 119000);
  assert.equal(parsed.priceUpdatedAtConsole, null);
  assert.equal(parsed.priceUpdatedAtPc, null);
});

test("offline fixture does not invent prices or timestamps", () => {
  const parsed = parseFutbinPlayerHtml("<html><body>No market price here</body></html>");
  assert.equal(parsed.pricePlayStation, null);
  assert.equal(parsed.priceXbox, null);
  assert.equal(parsed.pricePc, null);
  assert.equal(parsed.priceUpdatedAtConsole, null);
  assert.equal(parsed.priceUpdatedAtPc, null);
});
