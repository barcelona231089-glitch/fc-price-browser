import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVisibleLatestSalesText,
  parseFutbinVisibleMarketSnapshot
} from '../src/futbinVisibleMarket.js';

test('visible FUTBIN market parser keeps listings and sold samples separate', () => {
  const latest = parseVisibleLatestSalesText(
    'Latest Sales Nov 6, 2026 1:00 PM 1.9K Nov 6, 2026 12:30 PM 1,800 Full History'
  );
  assert.deepEqual(latest.map(row => row.price), [1900, 1800]);

  const parsed = parseFutbinVisibleMarketSnapshot({
    listingTexts: ['1,500', '1.6K', '1,600'],
    latestSalesText: 'Latest Sales Nov 6, 2026 1:00 PM 1.9K Nov 6, 2026 12:30 PM 1,800 Full History',
    updatedLabel: 'Updated 1 min ago',
    url: 'https://www.futbin.com/27/player/123/test/market'
  }, 1550);

  assert.equal(parsed.lowestListingPrice, 1500);
  assert.equal(parsed.evidence.futbinListedSampleCount, 3);
  assert.equal(parsed.evidence.futbinSoldSampleCount, 2);
  assert.equal(parsed.evidence.salesHistoryAvailable, true);
  assert.equal(parsed.evidence.futbinSoldPriceMedian, 1850);
});
