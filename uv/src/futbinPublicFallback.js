import { fetchFutbinPublicForRow } from "../../futbinMarketV1064.js";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

export function isPublicFutbinEnabled() {
  return truthy(process.env.FUTBIN_PUBLIC_ENABLED)
    && truthy(process.env.FUTBIN_PUBLIC_ACTIVATION_CONFIRMED);
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function pickPrice(detail, platform) {
  if (platform === "pc") return positive(detail?.pricePc) || positive(detail?.pricePC);
  return positive(detail?.pricePlayStation) || positive(detail?.marketAverageBin) || positive(detail?.salesMetrics?.medianSoldPrice);
}
export async function getPublicFutbinCards(cards = [], platform = "console", options = {}) {
  const year = Number(options.gameYear || 27);
  const results = new Map();
  if (year !== 27) return { ok:false, year, results, reason:"FC27_ONLY" };
  if (!options.force && !isPublicFutbinEnabled()) {
    return { ok:false, year, results, reason:"FUTBIN_PUBLIC_DISABLED" };
  }
  for (const card of cards) {
    try {
      const detail = await fetchFutbinPublicForRow(card, { gameYear:"27", pool:options.pool || null });
      const price = pickPrice(detail, platform);
      results.set(String(card.eaId), {
        ok:Boolean(detail && price), price, id:detail?.futbinId || null,
        name:detail?.name || card?.name || null, source:"FUTBIN_PUBLIC_HTML_FC27",
        checked:detail?.priceUpdatedAtConsole || detail?.marketPriceUpdatedAt || null,
        retrievedAt:detail?.fetchedAt || new Date().toISOString(),
        evidence:{ gamesAvailable:Boolean(detail?.dataCompleteness?.games), salesHistoryAvailable:Boolean(detail?.dataCompleteness?.soldListings), detail }
      });
    } catch (error) {
      results.set(String(card.eaId), {ok:false,price:null,id:null,source:"FUTBIN_PUBLIC_HTML_FC27",reason:String(error?.message||error)});
    }
  }
  return {ok:true,year,results};
}
