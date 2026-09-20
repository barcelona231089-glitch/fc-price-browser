const state={lastRunAt:null,candidates:0,historyCards:0,stableCards:0,error:null};
const n=v=>Number(v||0);
export async function buildFutbinSecondaryIntelligence(pool,{gameYear=27,limit=100}={}){
 if(Number(gameYear)!==27||!pool?.query)return {ok:false,reason:"UNAVAILABLE"};
 try{
  const q=await pool.query(`WITH x AS (
   SELECT futbin_id,name,rating,observed_at,price_console,popular_rank,
    lag(price_console) OVER(PARTITION BY futbin_id ORDER BY observed_at) prev
   FROM fc_futbin_fc27_snapshots WHERE observed_at>=NOW()-INTERVAL '24 hours' AND price_console>0
  ), a AS (
   SELECT futbin_id,max(name) name,max(rating) rating,max(observed_at) last_seen,count(*) samples,
    min(price_console) low,max(price_console) high,avg(price_console)::numeric avg_price,
    max(popular_rank) popularity,avg(abs(price_console-prev)) FILTER(WHERE prev>0) avg_step,
    (array_agg(price_console ORDER BY observed_at DESC))[1] latest,
    (array_agg(price_console ORDER BY observed_at DESC) FILTER(WHERE observed_at<=NOW()-INTERVAL '30 minutes'))[1] p30m,
    (array_agg(price_console ORDER BY observed_at DESC) FILTER(WHERE observed_at<=NOW()-INTERVAL '1 hour'))[1] p1h,
    (array_agg(price_console ORDER BY observed_at DESC) FILTER(WHERE observed_at<=NOW()-INTERVAL '6 hours'))[1] p6h,
    (array_agg(price_console ORDER BY observed_at DESC) FILTER(WHERE observed_at<=NOW()-INTERVAL '24 hours'))[1] p24h
   FROM x GROUP BY futbin_id
  ) SELECT *,round((100.0*(high-low)/NULLIF(avg_price,0))::numeric,2) range_pct
  FROM a WHERE last_seen>=NOW()-INTERVAL '90 minutes'
  ORDER BY samples DESC,popularity DESC NULLS LAST LIMIT $1`,[Math.max(30,Math.min(100,limit))]);
  const pct=(a,b)=>b>0?Number((((a-b)/b)*100).toFixed(2)):null;
  const watchlist=q.rows.map(r=>{const latest=n(r.latest);const range=n(r.range_pct);const step=n(r.avg_step);
   const stability=Math.max(0,Math.min(100,Math.round(100-range*2-(latest?step/latest*100:0))));
   return {...r,move30m:pct(latest,n(r.p30m)),move1h:pct(latest,n(r.p1h)),move6h:pct(latest,n(r.p6h)),
    move24h:pct(latest,n(r.p24h)),stabilityScore:stability,liquidityProxy:Math.max(0,Math.min(100,Math.round(stability*.65+Math.min(35,n(r.samples)*3))))};
  });
  watchlist.sort((a,b)=>(b.liquidityProxy-a.liquidityProxy)||(b.samples-a.samples));
  state.lastRunAt=new Date().toISOString();state.candidates=watchlist.length;
  state.historyCards=watchlist.filter(r=>n(r.samples)>=2).length;
  state.stableCards=watchlist.filter(r=>r.stabilityScore>=70).length;state.error=null;
  return {ok:true,realObservedOnly:true,synthetic:false,
   horizons:["30m","1h","6h","24h"],rotation:"DYNAMIC_QUALITY_FIRST",
   watchlist,state:{...state}};
 }catch(e){state.error=String(e?.message||e);return {ok:false,error:state.error,state:{...state}}}
}
export function compareFutggFutbin(futggPrice,futbinPrice){
 const a=n(futggPrice),b=n(futbinPrice);if(!(a>0&&b>0))return {ok:false};
 const diffPct=Number((((b-a)/a)*100).toFixed(2)),abs=Math.abs(diffPct);
 return {ok:true,diffPct,agreement:abs<=12?"MATCH":abs<=25?"DIVERGENCE":"OUTLIER",
  trustMultiplier:abs<=12?1:abs<=25?.75:.4};
}
export function getFutbinSecondaryIntelligenceStatus(){
 return {...state,realObservedOnly:true,synthetic:false,horizons:["30m","1h","6h","24h"],dynamicRotation:true};
}
