import fs from 'node:fs';

const DEFAULT_PATH = new URL('../data/futbin_fc27_latest.csv', import.meta.url);
let cache = { mtimeMs: 0, rows: [] };

function splitCsv(line) {
  const out=[]; let cur=''; let quoted=false;
  for (let i=0;i<line.length;i++) {
    const c=line[i];
    if (c==='"') { if (quoted && line[i+1]==='"') { cur+='"'; i++; } else quoted=!quoted; }
    else if (c===',' && !quoted) { out.push(cur); cur=''; } else cur+=c;
  }
  out.push(cur); return out;
}
function norm(v) { return String(v||'').toLowerCase().replace(/\b\d{2}\b/g,'').replace(/\b(icon|rare|non rare)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
function num(v) { const n=Number(v); return Number.isFinite(n)&&n>0?n:null; }

export function loadLocalFutbinFc27(path = process.env.UV_FUTBIN_LOCAL_CSV || DEFAULT_PATH) {
  const file = path instanceof URL ? path : String(path);
  let stat; try { stat=fs.statSync(file); } catch { return []; }
  if (cache.mtimeMs===stat.mtimeMs) return cache.rows;
  const lines=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean);
  if (lines.length<2) return [];
  const head=splitCsv(lines[0]); const idx=Object.fromEntries(head.map((h,i)=>[h,i]));
  cache={mtimeMs:stat.mtimeMs,rows:lines.slice(1).map(line=>{const v=splitCsv(line); return {
    futbinId:num(v[idx.futbin_id]), name:v[idx.Name]||'', rating:num(v[idx['RATOrder By Rating']]),
    priceConsole:num(v[idx.price_console]), pricePc:num(v[idx.price_pc]),
    popularRank:num(v[idx['POPOrder By Popularity']]), fetchedAt:v[idx.fetched_at]||null
  };}).filter(x=>x.futbinId)};
  return cache.rows;
}

export function attachLocalFutbinFc27(cards=[], platform='console') {
  const rows=loadLocalFutbinFc27(); if (!rows.length) return cards;
  const byId=new Map(rows.map(r=>[String(r.futbinId),r]));
  const byName=new Map();
  for (const r of rows) { const k=norm(r.name); if (!byName.has(k)) byName.set(k,[]); byName.get(k).push(r); }
  return cards.map(card=>{
    let r=byId.get(String(card.futbinId||''))||null;
    if (!r) { const a=byName.get(norm(card.name))||[]; const rating=Number(card.overall); r=a.find(x=>!rating||x.rating===rating)||null; }
    if (!r) return card;
    const price=platform==='pc'?r.pricePc:r.priceConsole;
    return {...card,futbinId:card.futbinId||r.futbinId,futbinPrice:price||card.futbinPrice||null,
      futbinPopularRank:r.popularRank??card.futbinPopularRank??null,futbinLocalObservedAt:r.fetchedAt,
      futbinLocalSource:'FUTBIN_FC27_LOCAL_COLLECTOR',futbinLocalPriceAvailable:Boolean(price)};
  });
}
