import argparse,json,time,urllib.parse,urllib.request,urllib.error

def fetch(rating,page):
 q=urllib.parse.urlencode({'platform':'PS','rating':f'{rating}-{rating}','sort':'rating','order':'desc','page':page})
 req=urllib.request.Request('https://www.futbin.org/futbin/api/27/getFilteredPlayers?'+q,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json'})
 with urllib.request.urlopen(req,timeout=20) as r: return json.load(r).get('data',[])

def main():
 p=argparse.ArgumentParser();p.add_argument('--min-rating',type=int,default=75);p.add_argument('--max-rating',type=int,default=99);p.add_argument('--pages',type=int,default=8);p.add_argument('--delay',type=float,default=3);p.add_argument('--out',default='uv/data/futbin_fc27_verified_map.json');a=p.parse_args()
 out={}; stopped=None
 for rating in range(a.min_rating,a.max_rating+1):
  for page in range(1,a.pages+1):
   try: rows=fetch(rating,page)
   except urllib.error.HTTPError as e:
    stopped=f'HTTP_{e.code}'; break
   except Exception as e:
    stopped=type(e).__name__; break
   if not rows: break
   for x in rows:
    ea=x.get('resource_id') or x.get('Player_Resource') or x.get('playerid'); fid=x.get('ID') or x.get('id')
    if ea and fid: out[str(int(ea))]=int(fid)
   if len(rows)<30: break
   time.sleep(max(1,a.delay))
  if stopped: break
 import os;os.makedirs(os.path.dirname(a.out),exist_ok=True);open(a.out,'w',encoding='utf-8').write(json.dumps(out,indent=2,sort_keys=True))
 print(json.dumps({'ok':not bool(stopped),'verifiedMappings':len(out),'stopped':stopped,'out':a.out}))
if __name__=='__main__': main()
