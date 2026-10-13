import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createFutbinConsoleRouter, originalUvFutbinPriceFeed, FUTBIN_DATA_DIR } from './src/futbinConsoleApi.js';
import { mapFutbinQuoteToUvCard } from './src/futbinOriginalSource.js';
import { buildFutbinPortfolio, recheckFutbinPortfolio, validateBudget, normalizeFilters, portfolioError, SOURCE, WATCHLIST_NOTICE } from './src/futbinPortfolio.js';
import { createFutbinListStore } from './src/futbinListStore.js';

const UV_VERSION = '2.11.0-futbin-only';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let uvActive = true, uvStarted = false, lastGenerationAt = null, lastError = null;

// Provider/router migration in the original app. uvEngine's existing allocator,
// price steps, budget constraints, diversity and max-copy rules remain in use.
export function createUvRouter({ feed = originalUvFutbinPriceFeed, store = createFutbinListStore({directory:FUTBIN_DATA_DIR}) } = {}) {
  const app = express.Router();
  const jobs = new Map();
  let busy = false;
  app.use(express.json({limit:'512kb'}));
  app.use('/api/uv', (req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(req.method==='POST') {
      if(!uvActive) return res.status(503).json({error:'Diese Instanz ist im Standby.',code:'HA_STANDBY_READ_ONLY'});
      const origin=req.get('origin');
      if(origin) {
        let valid=false;try { valid=new URL(origin).host===req.get('host'); }catch{}
        if(!valid) return res.status(403).json({error:'Zugriff nur aus der geöffneten App erlaubt.'});
      }
    }
    next();
  });
  app.use(createFutbinConsoleRouter({direct:feed}));
  app.use('/uv',express.static(path.join(__dirname,'public'),{maxAge:0}));
  const route = fn => (req,res,next) => Promise.resolve(fn(req,res)).catch(next);
  function status() {
    const s=feed.getStatus();
    return {ok:true,service:'FC ÜV Brain',version:UV_VERSION,gameYear:27,priceSourceMode:'FUTBIN_ONLY',
      primaryPriceSource:SOURCE, futbinOnlyPriceStatus:s,activeInstance:uvActive,
      databaseConfigured:false, localListStorage:true, storage:'local-futbin27',
      mode:'FUTBIN_LISTING_WATCHLIST',readyForTrading:false,automation:'none',
      lastGenerationAt,lastError,
      currentCapabilities:{futbinOnlyPrimaryPrices:true,budgetOptimizer100:true,eaTax:true,
        maxExactCardCopies:2,savedLists:true,liveRecheckPost:true,portfolioRebalancing:true,
        pgpGames:false,playerSalesHistory:false,futbinConfirmedSales:false,
        priceFilters:true,gamesFilters:true,salesFilters:true},
      dataCoverage:{prices:s.hasSuccessfulFetch&&!s.lastError?'AVAILABLE':'WAITING',games:'UNAVAILABLE',sales:'UNAVAILABLE'},
      lastAccessAudit:{date:'2026-10-09',device:'Messi',pgpHttpStatus:403,salesHttpStatus:403},
      dataNotice:WATCHLIST_NOTICE};
  }
  function requestOptions(body={}) {
    if(body.platform && body.platform!=='console') throw portfolioError('Nur FC27-Konsolenpreise werden unterstützt.','PLATFORM_UNSUPPORTED',400);
    const budget=Number(body.budget);validateBudget(budget);
    return {budget,filters:normalizeFilters(body.filters||{}),save:body.saveList===true};
  }
  async function sourceRows() {
    feed.ensureRefreshed();
    await feed.waitForCurrent();
    const s=feed.getStatus();
    const age=Date.now()-Date.parse(s.lastSuccessAt);
    if(!s.hasSuccessfulFetch || !Number.isFinite(age) || age>30*60000 || age< -60000 || s.lastError) {
      throw portfolioError('FUTBIN-Quelle noch nicht nutzbar: '+(s.lastError||s.currentPhase)+
        (s.nextRefreshAt?' · nächster Versuch frühestens '+s.nextRefreshAt:''),'FUTBIN_SOURCE_NOT_READY',503);
    }
    return feed.getRows();
  }
  async function generate(options, previousCards=[]) {
    const quotes=await sourceRows();
    const portfolio=buildFutbinPortfolio(quotes,{budget:options.budget,filters:options.filters,previousCards});
    portfolio.version=UV_VERSION;
    portfolio.marketSnapshot={updatedAt:feed.getStatus().lastSuccessAt,source:SOURCE};
    const result=await store.put(portfolio,options.save);
    lastGenerationAt=new Date().toISOString();lastError=null;return result;
  }
  async function recheck(id) {
    const original=await store.get(id);
    const checked=recheckFutbinPortfolio(original,await sourceRows());
    const bySlot=new Map(checked.cards.map(c=>[c.slot,c]));
    original.cards=original.cards.map(c=>{const r=bySlot.get(c.slot);return {...c,...(r?.fresh||{}),_recheck:r};});
    original.lastRecheckAt=checked.checkedAt;original.persistedLiveRecheck=true;
    const known=checked.cards.filter(c=>c.currentPrice!==null);
    original.currentKnownTotal=known.reduce((sum,c)=>sum+c.currentPrice,0);
    original.currentTotalComplete=known.length===original.cards.length;
    if(original.currentTotalComplete) {
      original.totalBuy=original.currentKnownTotal;
      original.unusedBudget=original.budget-original.totalBuy;
      original.budgetUsagePct=original.totalBuy/original.budget*100;
      original.scenarioTargetProfit=original.cards.reduce((sum,c)=>sum+(c.netProfit||0),0);
    }
    original.overBudget=original.currentTotalComplete&&original.totalBuy>original.budget;
    await store.update(id,original);
    return {...checked,listId:original.listId,recheckListId:id,portfolio:original};
  }
  function startJob(work,kind) {
    if(busy) throw portfolioError('Eine Berechnung läuft bereits. Bitte kurz warten.','BUSY',429);
    busy=true;
    const jobId=randomUUID();
    const job={ok:true,jobId,status:'RUNNING',startedAt:new Date().toISOString(),phase:'FUTBIN_SOURCE',kind};
    jobs.set(jobId,job);
    const timer=setTimeout(()=>jobs.delete(jobId),15*60000);timer.unref?.();
    Promise.resolve().then(work).then(result=>{
      Object.assign(job,{status:'DONE',result,httpStatus:200,finishedAt:new Date().toISOString()});
    }).catch(error=>{
      lastError=error.message;Object.assign(job,{status:'FAILED',error:error.message,code:error.code,httpStatus:error.status||500});
    }).finally(()=>{busy=false;});
    return {ok:true,jobId,status:job.status,pollUrl:'/api/uv/job/'+jobId};
  }
  app.get('/api/uv/status',(_req,res)=>res.json(status()));
  app.get('/api/uv/health',(_req,res)=>res.json(status()));
  app.get('/api/uv/source/market',route(async(_req,res)=>{
    const cards=(await sourceRows()).map(mapFutbinQuoteToUvCard).filter(Boolean);
    res.json({ok:true,source:SOURCE,gameYear:27,platform:'console',listingOnly:true,confirmedSales:0,
      updatedAt:feed.getStatus().lastSuccessAt,cards,count:cards.length});
  }));
  app.post('/api/uv/generate',route(async(req,res)=>{
    const options=requestOptions(req.body);
    if(busy) throw portfolioError('Eine Berechnung läuft bereits.','BUSY',429);
    busy=true;try{res.json(await generate(options));}finally{busy=false;}
  }));
  app.post('/api/uv/generate-async',route(async(req,res)=>{
    const options=requestOptions(req.body);
    res.status(202).json(startJob(()=>generate(options),'GENERATE'));
  }));
  const jobStatus=(req,res)=>{
    const job=jobs.get(req.params.jobId);
    if(!job) return res.status(404).json({status:'MISSING',error:'Prüfauftrag nicht gefunden.'});
    res.json(job);
  };
  app.get('/api/uv/job/:jobId',jobStatus);
  app.get('/api/uv/recheck-job/:jobId',jobStatus);
  app.get('/api/uv/history',route(async(req,res)=>{
    if(req.query.platform && req.query.platform!=='console') return res.json({ok:true,lists:[]});
    res.json({ok:true,storage:'local-futbin27',lists:await store.list(Math.max(1,Math.min(100,Number(req.query.limit)||30)))});
  }));
  app.get('/api/uv/list/:listId',route(async(req,res)=>res.json(await store.get(req.params.listId))));
  app.post('/api/uv/recheck/:listId',route(async(req,res)=>{
    await store.get(req.params.listId);
    res.status(202).json(startJob(()=>recheck(req.params.listId),'RECHECK'));
  }));
  app.get('/api/uv/recheck/:listId',(_req,res)=>res.status(405).set('Allow','POST').json({error:'Preisprüfung bitte per POST starten.'}));
  app.post('/api/uv/rebalance/:listId',route(async(req,res)=>{
    if(busy) throw portfolioError('Eine Berechnung läuft bereits.','BUSY',429);
    const previous=await store.get(req.params.listId);
    busy=true;try{
      res.json(await generate({budget:previous.budget,filters:previous.filters,save:req.body?.saveList===true},previous.cards));
    }finally{busy=false;}
  }));
  app.get('/api/uv/target-learning/status',(_req,res)=>res.json({ok:true,enabled:false,reason:'Keine bestätigten FUTBIN-Verkäufe verfügbar.'}));
  app.post('/api/uv/feedback',(_req,res)=>res.status(409).json({ok:false,error:'Manuelle Angaben werden nicht als FUTBIN-Verkaufsnachweise übernommen.'}));
  app.get(/^\/uv(?:\/.*)?$/,(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
  app.use((error,_req,res,_next)=>{
    lastError=error.message;
    res.status(error.status||500).json({ok:false,error:error.message,code:error.code||'UV_ERROR'});
  });
  return app;
}
export const uvRouter=createUvRouter();
export async function initUvBrain({active=true}={}) {uvStarted=true;uvActive=active!==false;return getUvRuntimeStatus();}
export async function setUvBrainActive(active) {uvActive=active===true;return getUvRuntimeStatus();}
export async function shutdownUvBrain() {uvActive=false;uvStarted=false;}
export function getUvRuntimeStatus() {return {started:uvStarted,active:uvActive,version:UV_VERSION,source:SOURCE,lastGenerationAt,lastError};}
