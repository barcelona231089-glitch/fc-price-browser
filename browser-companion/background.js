// Local-only, bounded, sanitized FUTBIN request discovery. No headers, bodies, cookies or query strings.
const MAX=2000;
let items=[],seen=0,filtered=0,lastEvent=null,prices=[];
let ready=chrome.storage.local.get("atfCapture").then(({atfCapture})=>{
  if(!atfCapture)return;
  items=Array.isArray(atfCapture.items)?atfCapture.items.slice(-MAX):[];
  seen=Number(atfCapture.seen)||0;
  filtered=Number(atfCapture.filtered)||0;
  lastEvent=typeof atfCapture.lastEvent==="string"?atfCapture.lastEvent:null;
  prices=Array.isArray(atfCapture.prices)?atfCapture.prices.slice(-500):[];
}).catch(()=>{});
let saving=Promise.resolve();
function persist(){
  const snapshot={items:items.slice(-MAX),seen,filtered,lastEvent,prices};
  saving=saving.catch(()=>{}).then(()=>chrome.storage.local.set({atfCapture:snapshot}));
  return saving;
}
function safe(url){
  try{
    const u=new URL(url);
    if(!["https:","http:"].includes(u.protocol))return null;
    return {url:u.origin+u.pathname,hostname:u.hostname,path:u.pathname};
  }catch{return null}
}
function protection(path){return /^\/cdn-cgi\/(?:challenge-platform|turnstile)(?:\/|$)/i.test(path)}
function contentType(headers){
  const h=(headers||[]).find(x=>String(x.name||"").toLowerCase()==="content-type");
  return typeof h?.value==="string"?h.value.split(";",1)[0].trim().toLowerCase():null;
}
chrome.webRequest.onCompleted.addListener(d=>{
  ready.then(()=>{
    seen++;lastEvent=new Date(d.timeStamp).toISOString();
    const s=safe(d.url);
    if(!s||protection(s.path)||!["xmlhttprequest","websocket"].includes(d.type)){
      filtered++;persist();return;
    }
    items.push({
      id:"local-"+d.requestId+"-"+d.timeStamp,...s,
      method:String(d.method||"GET").toUpperCase(),
      statusCode:Number.isFinite(d.statusCode)?d.statusCode:null,
      startedAt:lastEvent,durationMs:null,
      resourceType:d.type==="xmlhttprequest"?"xhr":"websocket",
      contentType:contentType(d.responseHeaders)
    });
    if(items.length>MAX)items.splice(0,items.length-MAX);
    persist();
  });
},{urls:["https://futbin.com/*","https://*.futbin.com/*"]},["responseHeaders"]);
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="ATF_FUTBIN_PRICE"){
    const p=msg.payload;
    if(sender.url?.startsWith("https://") && /(^|\\.)futbin\\.com$/.test(new URL(sender.url).hostname) && p?.source==="futbin" && p?.year===27 && /^\\d+$/.test(String(p.playerId)) && Array.isArray(p.prices)){
      prices=prices.filter(x=>!(x.playerId===p.playerId && x.pagePath===p.pagePath));
      prices.push(p); prices=prices.slice(-500); persist();
    }
    return false;
  }
  if(msg?.type!=="ATF_GET"&&msg?.type!=="ATF_CLEAR")return false;
  ready.then(async()=>{
    if(msg.type==="ATF_CLEAR"){
      items=[];seen=0;filtered=0;lastEvent=null;prices=[];
      await persist();
      sendResponse({ok:true});
      return;
    }
    sendResponse({items:items.slice(),prices:prices.slice(),diagnostics:{seen,filtered,kept:items.length,lastEvent,version:"1.4.0"}});
  }).catch(()=>sendResponse({items:[],diagnostics:{seen:0,filtered:0,kept:0,lastEvent:null,version:"1.4.0"}}));
  return true;
});

