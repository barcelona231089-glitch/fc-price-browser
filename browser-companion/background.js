const MAX=2000,items=[];let seen=0,filtered=0,lastEvent=null;
function safe(url){try{const u=new URL(url);if(!["https:","http:"].includes(u.protocol))return null;return{url:u.origin+u.pathname,hostname:u.hostname,path:u.pathname}}catch{return null}}
function protection(path){return /^\/cdn-cgi\/(?:challenge-platform|turnstile)(?:\/|$)/i.test(path)}
function contentType(headers){const h=(headers||[]).find(x=>String(x.name||"").toLowerCase()==="content-type");return typeof h?.value==="string"?h.value.split(";",1)[0].trim().toLowerCase():null}
chrome.webRequest.onCompleted.addListener(d=>{
  seen++;lastEvent=new Date(d.timeStamp).toISOString();
  const s=safe(d.url);
  if(!s||protection(s.path)||!["xmlhttprequest","websocket"].includes(d.type)){filtered++;return}
  items.push({id:"local-"+d.requestId+"-"+d.timeStamp,...s,method:String(d.method||"GET").toUpperCase(),statusCode:Number.isFinite(d.statusCode)?d.statusCode:null,startedAt:lastEvent,durationMs:null,resourceType:d.type==="xmlhttprequest"?"xhr":"websocket",contentType:contentType(d.responseHeaders)});
  if(items.length>MAX)items.splice(0,items.length-MAX);
},{urls:["https://futbin.com/*","https://*.futbin.com/*"]},["responseHeaders"]);
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg?.type==="ATF_GET")sendResponse({items:items.slice(),diagnostics:{seen,filtered,kept:items.length,lastEvent,version:"1.2.0"}});
  if(msg?.type==="ATF_CLEAR"){items.length=0;seen=0;filtered=0;lastEvent=null;sendResponse({ok:true})}
  return true;
});