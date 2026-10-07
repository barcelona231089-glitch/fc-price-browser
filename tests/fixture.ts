import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export async function startFixture() {
  const seen: Array<{ path:string; method:string; authorization:boolean; cookie:boolean }> = [];
  const sockets = new Set<import('node:net').Socket>();
  const page = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Öffentliche Testseite</title><style>body{margin:0;font:16px sans-serif;background:#fff;color:#222}h1{position:absolute;top:8px;left:24px;font-size:20px}button,input{position:absolute;left:24px;width:220px;height:36px;box-sizing:border-box}#load{top:64px}#query{top:120px}#password{top:176px}#slow{top:232px}#message{position:absolute;top:280px;left:24px}</style></head><body><h1>Öffentliche Testseite</h1><button id="load">Weitere Preise laden</button><input id="query" name="query" placeholder="Öffentliche Suche"><input id="password" name="password" type="password" value="FAKE_ONLY"><button id="slow">Langsame Anfrage</button><p id="message">Nur Testdaten</p><script>
  let next=3;
  fetch('/api/items/1?page=2',{headers:{'Authorization':'FAKE_ONLY','X-API-Key':'FAKE_ONLY'}}).catch(()=>{});
  const xhr=new XMLHttpRequest();xhr.open('GET','/rest/items/2');xhr.send();
  const text=new XMLHttpRequest();text.open('GET','/xhr-text');text.send();
  fetch('/gql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query Games { games { id price } }'})}).catch(()=>{});
  fetch('/query',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query Games { games { id price } }'})}).catch(()=>{});
  fetch('/api/protected').catch(()=>{});
  fetch('/api/items?access_token=FAKE_ONLY').catch(()=>{});
  fetch('http://localhost:'+location.port+'/private').catch(()=>{});
  const ws=new WebSocket('ws://127.0.0.1:'+location.port+'/stream');ws.onerror=()=>{};
  document.querySelector('#load').onclick=()=>fetch('/api/items/'+next++).then(()=>document.querySelector('#message').textContent='Geladen');
  document.querySelector('#slow').onclick=()=>fetch('/api/slow');
  document.querySelector('#query').onkeydown=e=>{if(e.key==='Enter')fetch('/api/search?term='+encodeURIComponent(e.target.value));};
</script></body></html>`;
  let fixtureUrl='';
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url ?? '/','http://127.0.0.1');
    seen.push({path:url.pathname,method:req.method??'GET',authorization:!!req.headers.authorization,cookie:!!req.headers.cookie});
    if(url.pathname==='/') {res.writeHead(200,{'content-type':'text/html'});res.end(page);return;}
    if(url.pathname==='/xhr-text') {res.writeHead(200,{'content-type':'text/plain'});res.end('Ordinary public text');return;}
    if(url.pathname==='/api/protected') {res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'Protected'}));return;}
    if(url.pathname==='/api/slow') await new Promise(resolve=>setTimeout(resolve,3500));
    if(url.pathname==='/redirect-chain') {res.writeHead(302,{location:fixtureUrl+'redirect'});res.end();return;}
    if(url.pathname==='/redirect') {res.writeHead(302,{location:'http://localhost:'+new URL(fixtureUrl).port+'/private'});res.end();return;}
    if(url.pathname==='/invalid-json') {res.writeHead(200,{'content-type':'application/json'});res.end('{invalid');return;}
    res.writeHead(200,{'content-type':'application/json','set-cookie':'fixture_only=FAKE_ONLY; Path=/'});
    res.end(JSON.stringify(url.pathname==='/gql'||url.pathname==='/query' ? {data:{games:[{id:1,price:250}]} } : {id:1,price:250,games:9,profile:{name:'ONLY_A_FAKE_BODY_VALUE',active:true},password:'FAKE_ONLY',accessToken:'FAKE_ONLY',nested:{clientSecret:'FAKE_ONLY',listing:4}}));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(req,socket)=>{
    seen.push({path:'/stream',method:req.method??'GET',authorization:!!req.headers.authorization,cookie:!!req.headers.cookie});
    if(req.url!=='/stream') {socket.destroy();return;}
    const key=String(req.headers['sec-websocket-key']);
    const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    setTimeout(()=>{if(!socket.destroyed){socket.write(Buffer.from([0x88,0x02,0x03,0xe8]));socket.end();}},300);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as AddressInfo).port;
  fixtureUrl=`http://127.0.0.1:${port}/`;
  return {url:fixtureUrl,seen,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
