import { extractFutbinStructuredEvidence, parseFutPrice } from './futbinEvidence.js';

const ENGLISH_SALE_DATE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+(?:(?:20)\d{2},?\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)\b/gi;
const ISOISH_SALE_DATE = /\b\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\b/g;

function uniquePositivePrices(values = []) {
  return values
    .map(parseFutPrice)
    .filter(value => Number.isFinite(value) && value > 0)
    .slice(0, 5);
}

export function parseVisibleLatestSalesText(value = '') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const dates = [
    ...text.matchAll(ENGLISH_SALE_DATE),
    ...text.matchAll(ISOISH_SALE_DATE)
  ].sort((a, b) => a.index - b.index);

  const sales = [];
  for (let index = 0; index < dates.length; index += 1) {
    const match = dates[index];
    const end = index + 1 < dates.length ? dates[index + 1].index : text.length;
    const tail = text.slice(match.index + match[0].length, end).trim();
    const priceToken = tail.match(/^([\d,.]+(?:\.\d+)?\s*[KM]?)(?!\w)/i)?.[1]
      || tail.match(/\b([\d,.]+(?:\.\d+)?\s*[KM])\b/i)?.[1];
    const price = parseFutPrice(priceToken);
    if (!Number.isFinite(price) || price <= 0) continue;
    sales.push({
      price: Math.round(price),
      displayTime: match[0].trim()
    });
  }
  return sales;
}

export function buildFutbinVisibleMarketExpression(futbinId, platform = 'console') {
  const id = String(futbinId || '');
  const platformClass = platform === 'pc' ? 'platform-pc-only' : 'platform-ps-only';
  return `(() => {
    const wantedId = ${JSON.stringify(id)};
    const platformClass = ${JSON.stringify(platformClass)};
    const selector = '.' + platformClass;
    const boxes = [...document.querySelectorAll('div.price-box' + selector + '[data-id]')];
    const box = boxes.find(element => String(element.getAttribute('data-id') || '') === wantedId)
      || boxes[0]
      || document.querySelector('div.price-box' + selector);

    const listingTexts = box
      ? [...box.querySelectorAll('.lowest-price-1, .lowest-prices-wrapper > .lowest-price')]
          .map(element => String(element.textContent || '').replace(/\\s+/g, ' ').trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    const roots = [...document.querySelectorAll(selector)]
      .filter(element => /Latest Sales|Recent Sales|最近销售|最新销售/i.test(String(element.innerText || '')))
      .sort((a, b) => String(a.innerText || '').length - String(b.innerText || '').length);

    let latestSalesText = roots[0] ? String(roots[0].innerText || '') : '';
    if (!latestSalesText) {
      const body = String(document.body?.innerText || '');
      const match = body.match(/(?:Latest Sales|Recent Sales|最近销售|最新销售)/i);
      if (match) latestSalesText = body.slice(match.index, match.index + 6000);
    }

    const updatedLabel = box
      ? String(box.querySelector('.prices-updated')?.textContent || '').replace(/\\s+/g, ' ').trim()
      : '';

    return {
      url: location.href,
      listingTexts,
      latestSalesText: latestSalesText.slice(0, 6000),
      updatedLabel,
      priceBoxText: box ? String(box.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1200) : ''
    };
  })()`;
}

export function parseFutbinVisibleMarketSnapshot(snapshot = {}, livePrice = null) {
  const listingPrices = uniquePositivePrices(snapshot?.listingTexts || []);
  const lowestListingPrice = listingPrices.length ? Math.min(...listingPrices) : null;
  const latestSales = parseVisibleLatestSalesText(snapshot?.latestSalesText || '');
  const salesHistory = latestSales.map(row => ({
    date: row.displayTime,
    sold_for: row.price,
    status: 'sold'
  }));

  const salesEvidence = extractFutbinStructuredEvidence({ sales_history: salesHistory }, lowestListingPrice || livePrice);
  return {
    listingPrices,
    lowestListingPrice,
    latestSales,
    evidence: {
      ...salesEvidence,
      salesHistoryAvailable: latestSales.length > 0,
      futbinSalesRowCount: latestSales.length + listingPrices.length,
      futbinListedSampleCount: listingPrices.length,
      futbinSoldSampleCount: latestSales.length
    },
    sourceUpdatedLabel: snapshot?.updatedLabel || null,
    marketUrl: snapshot?.url || null
  };
}
