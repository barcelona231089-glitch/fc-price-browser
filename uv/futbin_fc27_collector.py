#!/usr/bin/env python3
import argparse, io, json, re, sqlite3, time
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
import pandas as pd
import requests

UA = "Mozilla/5.0 (compatible; FC27-UV-Collector/1.0)"
PRICE_RE = re.compile(r"^\s*([0-9][0-9.,]*)\s*([KkMm]?)")

def page_url(url, page):
    u=urlparse(url); q=parse_qs(u.query); q["page"]=[str(page)]
    return urlunparse(u._replace(query=urlencode(q,doseq=True)))

def number(v):
    m=PRICE_RE.match(str(v or "")); 
    if not m: return None
    raw,s=m.groups()
    try: n=float(raw.replace(",",""))
    except ValueError: return None
    return int(round(n*{"":1,"k":1000,"m":1000000}[s.lower()]))

def fetch(session,url,delay):
    time.sleep(max(0,delay))
    r=session.get(url,timeout=30)
    if r.status_code in (401,403): raise RuntimeError(f"blocked HTTP {r.status_code}")
    if r.status_code==429: raise RuntimeError("rate limited HTTP 429")
    r.raise_for_status(); return r.text

def collect(url,pages,delay):
    s=requests.Session(); s.headers["User-Agent"]=UA; out=[]
    start=int(parse_qs(urlparse(url).query).get("page",["1"])[0])
    for p in range(start,start+pages):
        html=fetch(s,page_url(url,p),0 if p==start else delay)
        tables=pd.read_html(io.StringIO(html),flavor="lxml",extract_links="body")
        if not tables: break
        df=max(tables,key=lambda x:(x.shape[1],x.shape[0])).dropna(how="all")
        if df.empty: break
        first=df.columns[0]
        links=df[first].map(lambda v: v[1] if isinstance(v,tuple) else None)
        ids=links.map(lambda v: re.search(r'/27/player/(\d+)/',str(v or ''))).map(lambda m: int(m.group(1)) if m else pd.NA)
        for c in df.columns: df[c]=df[c].map(lambda v: v[0] if isinstance(v,tuple) else v)
        df.insert(0,"futbin_id",pd.array(ids,dtype="Int64"))
        df=df[df["futbin_id"].notna()].drop_duplicates(subset=["futbin_id"]).reset_index(drop=True)
        df.insert(0,"page",p); out.append(df)
    return pd.concat(out,ignore_index=True) if out else pd.DataFrame()

def normalize(df):
    if df.empty: return df
    price=[c for c in df.columns if str(c).startswith("PriceOrder By Price")]
    if price: df["price_console"]=df[price[0]].map(number).replace(0,pd.NA).astype("Int64")
    if len(price)>1: df["price_pc"]=df[price[1]].map(number).replace(0,pd.NA).astype("Int64")
    df.insert(0,"fetched_at",datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return df

def save_db(df,path):
    with sqlite3.connect(path) as con: df.to_sql("futbin_fc27_snapshots",con,if_exists="append",index=False)

def main():
    p=argparse.ArgumentParser(); p.add_argument("url"); p.add_argument("--pages",type=int,default=3)
    p.add_argument("--delay",type=float,default=6); p.add_argument("--csv",default="uv/data/futbin_fc27_latest.csv")
    p.add_argument("--db",default="uv/data/futbin_fc27_history.db"); a=p.parse_args()
    if not 1<=a.pages<=30: p.error("--pages 1..30")
    df=normalize(collect(a.url,a.pages,a.delay))
    if df.empty: raise SystemExit("NO_DATA")
    import os; os.makedirs(os.path.dirname(a.csv) or ".",exist_ok=True); os.makedirs(os.path.dirname(a.db) or ".",exist_ok=True)
    df.to_csv(a.csv,index=False,encoding="utf-8-sig"); save_db(df,a.db)
    print(json.dumps({"ok":True,"rows":len(df),"pages":a.pages,"priced_console":int(df.get("price_console",pd.Series()).notna().sum()),"csv":a.csv,"db":a.db}))

if __name__=="__main__": main()
