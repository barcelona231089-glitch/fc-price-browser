import json,re,time,urllib.parse,urllib.request
TRADING='https://fc-trader-brain.hostless.app/api/trading'
API='https://www.futbin.org/futbin/api/27/getFilteredPlayers'
UA='Mozilla/5.0'
def gj(url,t=60):
 req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'application/json'})
 with urllib.request.urlopen(req,timeout=t) as r:return json.load(r)
s=open('futbinIdMapFc27.js',encoding='utf-8-sig').read(); mp={k:int(v) for k,v in re.findall(r'"(\d+)":\s*(\d+)',s)}
rows=gj(TRADING,120).get('rows',[]); pending=[]
for r in rows:
 ea=int(r.get('eaId') or 0)
 if not ea or str(ea) in mp:continue
 if r.get('cardType')=='Base Rare' and ea>=16777216 and str(ea%16777216) in mp:continue
 pending.append(r)
pending.sort(key=lambda r:(-int(r.get('overall') or 0),str(r.get('name') or '')))
added=0; tried=0
for r in pending[:40]:
 ea=int(r['eaId']); name=str(r.get('name') or '').strip(); rating=int(r.get('overall') or 0)
 if not name:continue
 url=API+'?'+urllib.parse.urlencode({'platform':'PS','name':name,'page':1})
 try:data=gj(url,20).get('data',[])
 except Exception:break
 matches=[]
 for x in data:
  rid=int(x.get('resource_id') or x.get('playerid') or 0); fid=int(x.get('ID') or 0); rr=int(x.get('rating') or 0)
  if rid==ea and fid and rr==rating:matches.append((rid,fid))
  elif r.get('cardType')=='Base Rare' and ea>=16777216 and rid==(ea%16777216) and fid and rr==rating:matches.append((rid,fid))
 if len(set(matches))==1:
  rid,fid=matches[0]; mp[str(rid)]=fid; mp[str(ea)]=fid; added+=1
 tried+=1; time.sleep(1.2)
lines=['export const FUTBIN_FC27_EA_TO_ID = Object.freeze({']+[f'  "{k}": {mp[k]},' for k in sorted(mp,key=int)]+['});','']
open('futbinIdMapFc27.js','w',encoding='utf-8').write('\n'.join(lines))
print(json.dumps({'pending':len(pending),'tried':tried,'added':added,'totalMap':len(mp)}))
