const state={lastRunAt:null,candidates:0,historyCards:0,error:null};
export async function buildFutbinSecondaryIntelligence(pool,{gameYear=27,limit=100}={}){
 if(Number(gameYear)!==27||!pool?.query)return {ok:false,reason:"UNAVAILABLE"};
 try{
  const q=await pool.query(`WITH x AS (
   SELECT futbin_id,name,rating,observed_at,price_console,popular_rank,
    lag(price_console) OVER(PARTITION BY futbin_id ORDER BY observed_at) prev
   FROM fc_futbin_fc27_snapshots WHERE observed_at>=NOW()-INTERVAL '24 hours' AND price_console>0
  ), a AS (
   SELECT futbin_id,max(name) name,max(rating) rating,max(observed_at) last_seen,
    count(*) samples,min(price_console) low,max(price_console) high,
    avg(price_console)::numeric avg_price,max(popular_rank) popularity,
    avg(abs(price_console-prev)) FILTER(WHERE prev>0) avg_step
   FROM x GROUP BY futbin_id
  ) SELECT *,round((100.0*(high-low)/NULLIF(avg_price,0))::numeric,2) range_pct
  FROM a WHERE last_seen>=NOW()-INTERVAL '90 minutes'
  ORDER BY samples DESC,popularity DESC NULLS LAST LIMIT $1`,[Math.max(30,Math.min(100,limit))]);
  state.lastRunAt=new Date().toISOString();state.candidates=q.rows.length;state.historyCards=q.rows.filter(r=>Number(r.samples)>=2).length;state.error=null;
  return {ok:true,realObservedOnly:true,synthetic:false,watchlist:q.rows,state:{...state}};
 }catch(e){state.error=String(e?.message||e);return {ok:false,error:state.error,state:{...state}}}
}
export function getFutbinSecondaryIntelligenceStatus(){return {...state,realObservedOnly:true,synthetic:false};}
