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
    # Stable local history schema. Page HTML may add/rename columns without breaking history.
    name_col=next((c for c in df.columns if str(c)=="Name"),None)
    rating_col=next((c for c in df.columns if str(c).startswith("RATOrder By Rating")),None)
    pop_col=next((c for c in df.columns if str(c).startswith("POPOrder By Popularity")),None)
    stable=pd.DataFrame({
        "fetched_at":df["fetched_at"], "futbin_id":df["futbin_id"],
        "name":df[name_col] if name_col else None,
        "rating":pd.to_numeric(df[rating_col],errors="coerce") if rating_col else None,
        "price_console":df.get("price_console"), "price_pc":df.get("price_pc"),
        "popular_rank":pd.to_numeric(df[pop_col],errors="coerce") if pop_col else None,
    })
    with sqlite3.connect(path) as con:
        con.execute("CREATE TABLE IF NOT EXISTS futbin_fc27_history_v2 (fetched_at TEXT NOT NULL, futbin_id INTEGER NOT NULL, name TEXT, rating INTEGER, price_console INTEGER, price_pc INTEGER, popular_rank REAL, PRIMARY KEY(fetched_at,futbin_id))")
        con.execute("CREATE INDEX IF NOT EXISTS idx_futbin_fc27_history_v2_id_time ON futbin_fc27_history_v2(futbin_id,fetched_at DESC)")
        stable.to_sql("_futbin_stage",con,if_exists="replace",index=False)
        con.execute("INSERT OR IGNORE INTO futbin_fc27_history_v2 SELECT fetched_at,futbin_id,name,rating,price_console,price_pc,popular_rank FROM _futbin_stage")
        con.execute("DROP TABLE _futbin_stage")

def upload_snapshot(df):
    import os
    url=os.getenv("FUTBIN_SNAPSHOT_INGEST_URL") or os.getenv("FUTBIN_INGEST_URL")
    token=os.getenv("FUTBIN_SNAPSHOT_INGEST_TOKEN") or os.getenv("FUTBIN_INGEST_TOKEN")
    if os.name=="nt" and (not url or not token):
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,"Environment") as key:
                if not url: url=winreg.QueryValueEx(key,"FUTBIN_SNAPSHOT_INGEST_URL")[0]
                if not token: token=winreg.QueryValueEx(key,"FUTBIN_SNAPSHOT_INGEST_TOKEN")[0]
        except OSError: pass
    if not url and not token: return {"configured":False}
    if not url or not token: raise RuntimeError("incomplete FUTBIN snapshot ingest config")
    name_col=next((c for c in df.columns if str(c)=="Name"),None)
    rating_col=next((c for c in df.columns if str(c).startswith("RATOrder By Rating")),None)
    pop_col=next((c for c in df.columns if str(c).startswith("POPOrder By Popularity")),None)
    def val(v): return None if pd.isna(v) else v.item() if hasattr(v,"item") else v
    rows=[]
    for _,r in df.iterrows():
        rows.append({"futbinId":int(r["futbin_id"]),"observedAt":r["fetched_at"],"name":val(r.get(name_col)) if name_col else None,"rating":val(r.get(rating_col)) if rating_col else None,"priceConsole":val(r.get("price_console")),"pricePc":val(r.get("price_pc")),"popularRank":val(r.get(pop_col)) if pop_col else None})
    inserted=0; batches=0
    for i in range(0,len(rows),250):
        batch=rows[i:i+250]; last=None
        for attempt in range(3):
            try:
                resp=requests.post(url,json={"rows":batch},headers={"x-futbin-ingest-token":token},timeout=20)
                if resp.status_code in (401,403): raise RuntimeError(f"ingest authorization HTTP {resp.status_code}")
                if resp.status_code==429 or resp.status_code>=500:
                    last=RuntimeError(f"temporary ingest HTTP {resp.status_code}"); time.sleep(2**attempt); continue
                resp.raise_for_status(); body=resp.json(); inserted+=int(body.get("inserted",0)); batches+=1; last=None; break
            except (requests.Timeout,requests.ConnectionError) as e:
                last=e; time.sleep(2**attempt)
        if last: raise last
    return {"configured":True,"status":200,"inserted":inserted,"received":len(rows),"batches":batches}

def main():
    p=argparse.ArgumentParser(); p.add_argument("url"); p.add_argument("--pages",type=int,default=3)
    p.add_argument("--delay",type=float,default=6); p.add_argument("--csv",default="uv/data/futbin_fc27_latest.csv")
    p.add_argument("--db",default="uv/data/futbin_fc27_history.db")
    p.add_argument("--adaptive",action="store_true"); p.add_argument("--core-pages",type=int,default=4)
    p.add_argument("--rotate-pages",type=int,default=4); p.add_argument("--rotate-max-page",type=int,default=40)
    p.add_argument("--rotation-state",default="uv/data/futbin_fc27_rotation.json"); a=p.parse_args()
    if not 1<=a.pages<=30: p.error("--pages 1..30")
    import os
    os.makedirs(os.path.dirname(a.csv) or ".",exist_ok=True); os.makedirs(os.path.dirname(a.db) or ".",exist_ok=True)
    if a.adaptive:
        if not 1<=a.core_pages<=10 or not 1<=a.rotate_pages<=10: p.error("adaptive page windows must be 1..10")
        if a.core_pages+a.rotate_pages>12: p.error("adaptive total pages must be <=12")
        rotate_start=a.core_pages+1
        try:
            with open(a.rotation_state,encoding="utf-8") as f: rotate_start=max(a.core_pages+1,int(json.load(f).get("nextStart",rotate_start)))
        except (OSError,ValueError,TypeError,json.JSONDecodeError): pass
        core=collect(page_url(a.url,1),a.core_pages,a.delay)
        time.sleep(max(0,a.delay))
        rotating=collect(page_url(a.url,rotate_start),a.rotate_pages,a.delay)
        parts=[x for x in (core,rotating) if not x.empty]
        raw=pd.concat(parts,ignore_index=True).drop_duplicates(subset=["futbin_id"],keep="first") if parts else pd.DataFrame()
        next_start=rotate_start+a.rotate_pages
        if next_start>a.rotate_max_page: next_start=a.core_pages+1
        observed_pages=sorted(set(pd.to_numeric(raw.get("page",pd.Series(dtype=int)),errors="coerce").dropna().astype(int).tolist()))
    else:
        raw=collect(a.url,a.pages,a.delay); rotate_start=None; next_start=None
        observed_pages=sorted(set(pd.to_numeric(raw.get("page",pd.Series(dtype=int)),errors="coerce").dropna().astype(int).tolist())) if not raw.empty else []
    df=normalize(raw)
    if df.empty: raise SystemExit("NO_DATA")
    df.to_csv(a.csv,index=False,encoding="utf-8-sig"); save_db(df,a.db)
    upload=upload_snapshot(df)
    if a.adaptive:
        os.makedirs(os.path.dirname(a.rotation_state) or ".",exist_ok=True)
        with open(a.rotation_state,"w",encoding="utf-8") as f: json.dump({"nextStart":next_start,"lastStart":rotate_start,"updatedAt":datetime.now(timezone.utc).isoformat(timespec="seconds")},f)
    print(json.dumps({"ok":True,"rows":len(df),"pages":len(observed_pages),"pageNumbers":observed_pages,"adaptive":a.adaptive,"rotationStart":rotate_start,"nextRotationStart":next_start,"priced_console":int(df.get("price_console",pd.Series()).notna().sum()),"csv":a.csv,"db":a.db,"upload":upload}))

if __name__=="__main__": main()
