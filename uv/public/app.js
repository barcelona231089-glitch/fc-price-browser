const $ = s => document.querySelector(s);
const btn = $('#generateBtn');
const loading = $('#loading');
const rows = $('#rows');
const summary = $('#summary');
const notice = $('#notice');
const filter = $('#filter');
const recheckBtn = $('#recheckBtn');
const rebalanceBtn = $('#rebalanceBtn');
const savedListSelect = $('#savedListSelect');
const loadSavedBtn = $('#loadSavedBtn');
const saveListChoice = $('#saveListChoice');
const budgetPresetButtons = [...document.querySelectorAll('.budgetPreset')];
const statusFilters = [...document.querySelectorAll('.statusFilter')];
let lastCards = [];
let lastListId = null;
let lastCheckedListId = null;
let activeStatusFilter = 'ALL';
let actionBusy = false;
const expandedRows = new Set();

function setActionBusy(active){
  actionBusy=active;
  btn.disabled=active;
  recheckBtn.disabled=active||!lastListId;
  rebalanceBtn.disabled=active||!lastListId||lastCheckedListId!==lastListId;
  loadSavedBtn.disabled=active||!savedListSelect.value;
  savedListSelect.disabled=active;
}

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const coins = n => new Intl.NumberFormat('de-DE').format(Math.round(Number(n || 0)));
const pct = n => `${Number(n || 0).toFixed(1)} %`;
const trendLabel = v => v === 'rising' ? '📈 steigend' : v === 'falling' ? '📉 fallend' : v === 'stable' ? '➖ stabil' : '❔ unbekannt';
const finite = v => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v));

async function loadStatus(){
  try{
    const r=await fetch('/api/uv/status'); const s=await r.json();
    $('#statusBadge').textContent=`FC27 • FUTBIN • Konsole • v${s.version}`;
    $('#statusBadge').title='Angebotspreise verfügbar; Games und Sales derzeit nicht abrufbar.';
    $('#statusBadge').classList.add('good');
  }catch{ $('#statusBadge').textContent='Status nicht erreichbar'; }
}

function metric(label,value,green=false){return `<div class="metric"><span>${label}</span><strong class="${green?'green':''}">${value}</strong></div>`}

function renderSummary(data){
  const complete=data.currentTotalComplete!==false;
  const primary=[metric('Budget',coins(data.budget)+' 🪙'),metric(complete?'Planwert':'Letzter Planwert',coins(data.totalBuy)+' 🪙'),
    metric('Positionen',`${data.count} / 100`),metric('Restbudget',coins(data.unusedBudget)+' 🪙'),
    metric('Zielgewinn (rechnerisch)',complete?coins(data.scenarioTargetProfit)+' 🪙':'Nicht vollständig prüfbar')].join('');
  const details=[metric('Unterschiedliche Karten',data.uniqueCardCount??data.count),
    metric('Budget genutzt',pct(data.budgetUsagePct)),metric('Specials',data.specialCount||0),
    metric('Games','Nicht verfügbar'),metric('Sales History','Nicht verfügbar'),
    metric('Kauf-Freigaben','Keine'),metric('Quelle','FUTBIN FC27 Konsole'),
    metric('Datenabruf',esc(data.marketSnapshot?.updatedAt?new Date(data.marketSnapshot.updatedAt).toLocaleString('de-DE'):'–'))].join('');
  summary.innerHTML=`<div class="summaryPrimary">${primary}</div><details class="summaryMore"><summary>Mehr Analyse</summary><div class="summaryGrid">${details}</div></details>`;
  summary.classList.remove('hidden');
}

function hasCurrentRecheck(c){
  return Boolean(lastListId && lastCheckedListId === lastListId && c?._recheck);
}

function cardStatus(c){
  if(!hasCurrentRecheck(c)) return c.scenarioOnly?'WATCH':'UNCHECKED';
  return String(c._recheck?.status || 'UNCHECKED').toUpperCase();
}

function statusMeta(status){
  switch(status){
    case 'WATCH': return {label:'BEOBACHTEN',hint:'KEINE KAUF-FREIGABE',hintClass:''};
    case 'KEEP': return {label:'PRÜFEN', hint:'KEINE KAUF-FREIGABE', hintClass:''};
    case 'REPRICE': return {label:'NEUER PREIS', hint:'KEINE KAUF-FREIGABE', hintClass:'reprice'};
    case 'WAIT': return {label:'WAIT', hint:'NICHT KAUFEN', hintClass:'blocked'};
    case 'DROP': return {label:'DROP', hint:'NICHT KAUFEN', hintClass:'blocked'};
    case 'MISSING': return {label:'MISSING', hint:'NICHT KAUFEN', hintClass:'blocked'};
    default: return {label:'PRÜFEN', hint:'ERST LIVE PRÜFEN', hintClass:''};
  }
}

function effectivePricing(c){
  const r = hasCurrentRecheck(c) ? c._recheck : null;
  const status = cardStatus(c);
  const actionable = status === 'KEEP' || status === 'REPRICE';
  const fresh = r?.fresh || {};
  const buy = actionable && finite(fresh.recommendedBuyPrice ?? r?.freshBuyPrice) ? Number(fresh.recommendedBuyPrice ?? r.freshBuyPrice) : Number(c.buyPrice || 0);
  const start = actionable && finite(fresh.startPrice) ? Number(fresh.startPrice) : Number(c.startPrice || 0);
  const sell = actionable && finite(fresh.sellPrice ?? r?.freshSellPrice) ? Number(fresh.sellPrice ?? r.freshSellPrice) : Number(c.sellPrice || 0);
  const profit = actionable && finite(fresh.netProfit ?? r?.freshNetProfit) ? Number(fresh.netProfit ?? r.freshNetProfit) : Number(c.netProfit || 0);
  const market = r && finite(r.currentPrice ?? fresh.price) ? Number(r.currentPrice ?? fresh.price) : Number(c.price || 0);
  const tax = Math.floor(Math.max(0, sell) * 0.05);
  return {buy,start,sell,profit,market,tax,actionable};
}

function currentQuality(c){
  const fresh = hasCurrentRecheck(c) ? c._recheck?.fresh : null;
  const score = finite(fresh?.tradeQualityScore) ? Number(fresh.tradeQualityScore) : Number(c.tradeQualityScore || 0);
  const flags = Array.isArray(fresh?.riskFlags) ? fresh.riskFlags : (Array.isArray(c.riskFlags) ? c.riskFlags : []);
  return {score,flags};
}

function signalText(c){
  return `FUTBIN Angebot • ${c.futbinGamesCount===null?'Games unbekannt':coins(c.futbinGamesCount)+' Games'} • Sales nicht verfügbar`;
}

function detailMetric(label,value){
  return `<div class="detailMetric"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderDetail(c, pricing, status, quality){
  return `<div class="detailPanel"><div class="detailGrid">
    ${detailMetric('Kartenversion',esc(c.rarityName||c.cardType))}
    ${detailMetric('Quelle','FUTBIN FC27 · Konsole')}
    ${detailMetric('FUTBIN Karten-ID',esc(c.futbinId))}
    ${detailMetric('EA Ressourcen-ID',esc(c.eaId))}
    ${detailMetric('Abgerufen',esc(new Date(c.priceCheckedAt).toLocaleString('de-DE')))}
    ${detailMetric('FUTBIN-Zeitangabe',esc(c.futbinSourceCheckedAt||'Unbekannt'))}
    ${detailMetric('Games','Nicht verfügbar')}${detailMetric('Bestätigte Verkäufe','Nicht verfügbar')}
    ${detailMetric('5 % EA-Steuer beim Zielpreis',coins(pricing.tax))}
  </div><p>Zielpreise sind Rechenbeispiele. Es gibt keinen belegten Verkaufsgewinn und keine Kauf-Freigabe.</p>
  <a href="https://www.futbin.com/27/player/${Number(c.futbinId)}" target="_blank" rel="noopener noreferrer">Karte bei FUTBIN öffnen</a></div>`;
}

function statusCounts(){
  const counts={ALL:lastCards.length};
  for(const c of lastCards){const key=cardStatus(c);counts[key]=(counts[key]||0)+1;}
  return counts;
}

function updateStatusFilters(){
  const counts = statusCounts();
  for(const button of statusFilters){
    const status = button.dataset.status;
    const counter = button.querySelector('[data-count]');
    if(counter) counter.textContent = counts[status] || 0;
    button.classList.toggle('active',status === activeStatusFilter);
  }
}

function visibleCards(){
  const q = filter.value.toLowerCase().trim();
  return lastCards.filter(c => {
    const matchesStatus = activeStatusFilter === 'ALL' || cardStatus(c) === activeStatusFilter;
    const haystack = `${c.name||''} ${c.club||''} ${c.rarityName||''} ${c.cardType||''} ${c.position||''}`.toLowerCase();
    return matchesStatus && (!q || haystack.includes(q));
  });
}

function renderRows(cards){
  updateStatusFilters();
  if(!cards.length){
    rows.innerHTML='<tr><td colspan="9" class="empty">Für diesen Filter wurden keine Karten gefunden.</td></tr>';
    return;
  }
  const indexById = new Map(lastCards.map((c,i)=>[String(c.eaId),i+1]));
  rows.innerHTML = cards.map(c=>{
    const status = cardStatus(c);
    const meta = statusMeta(status);
    const pricing = effectivePricing(c);
    const quality = currentQuality(c);
    const typeClass = c.cardType==='Special'?'special':'';
    const qualityClass = ['A+','A'].includes(c.qualityGrade)?'high':c.qualityGrade==='B'?'mid':'';
    const reason = hasCurrentRecheck(c) ? c._recheck?.reasons?.[0] : null;
    const blocked = ['WAIT','DROP','MISSING'].includes(status);
    const riskClass = blocked ? 'blocked' : quality.flags.length ? 'risky' : '';
    const riskText = blocked ? '⛔ gesperrt' : quality.flags.length ? `⚠ ${quality.flags.length} Risiko${quality.flags.length===1?'':'s'}` : '✓ niedrig';
    const drift = hasCurrentRecheck(c) && finite(c._recheck?.priceDriftPct) ? `${Number(c._recheck.priceDriftPct)>0?'+':''}${Number(c._recheck.priceDriftPct).toFixed(1)} %` : '';
    const key = String(c.eaId);
    const expanded = expandedRows.has(key);
    const slot = c.slot || indexById.get(key) || '';
    const version = esc(c.rarityName||c.cardType||'-');
    const repriceHint = status === 'REPRICE' ? 'live aktualisiert' : status === 'KEEP' ? 'live bestätigt' : status === 'UNCHECKED' ? 'Rechenwert' : 'nicht verwenden';
    const main = `<tr class="tradeRow status-${status.toLowerCase()}">
      <td class="playerCell" data-label="Spieler / Version">
        <div class="player">
          ${c.image?`<img class="avatar" src="${c.image}" alt="" loading="lazy">`:`<div class="rating">${c.overall??'?'}</div>`}
          <div class="playerText">
            <div class="playerName"><span class="slot">#${slot}</span><span class="playerNameText">${esc(c.name||'Unbekannt')}</span><span class="ratingChip">${c.overall??'?'}</span></div>
            <div class="sub"><span class="pill ${typeClass}">${version}</span> • ${esc(c.position||'-')} • ${esc(c.club||'-')}</div>
          </div>
        </div>
      </td>
      <td class="statusCell" data-label="Status"><span class="statusBadge ${status.toLowerCase()}">${meta.label}</span><span class="statusHint ${meta.hintClass}">${meta.hint}</span>${drift?`<span class="drift">Drift ${drift}</span>`:''}</td>
      <td data-label="Planpreis"><span class="priceValue">${blocked?'–':coins(pricing.buy)}</span><span class="priceHint">${blocked?'Preis fehlt':'FUTBIN-Angebot'}</span></td>
      <td data-label="Start"><span class="priceValue">${blocked?'–':coins(pricing.start)}</span><span class="priceHint">${blocked?'gesperrt':'Rechenziel'}</span></td>
      <td data-label="Sofortkauf"><span class="priceValue">${blocked?'–':coins(pricing.sell)}</span><span class="priceHint">${blocked?'gesperrt':'Rechenziel'}</span></td>
      <td data-label="Zielgewinn"><span class="priceValue profit">${blocked?'–':`+${coins(pricing.profit)}`}</span><span class="priceHint">nach 5 % Steuer</span></td>
      <td data-label="Marktpreis"><span class="priceValue marketFresh">${status==='MISSING'?'–':coins(pricing.market)}</span><span class="marketSource">FUTBIN · Angebot</span></td>
      <td class="qualityCell" data-label="Games / Sales"><div class="qualityLine">Games: ${finite(c.futbinGamesCount)?coins(c.futbinGamesCount):'–'}</div><div class="riskLine">Sales: ${c.salesHistoryAvailable?coins(c.futbinSoldSampleCount):'–'}</div><span class="reasonMini">Nicht nachgewiesen</span></td>
      <td class="detailsCell" data-label="Details"><button class="detailToggle" type="button" data-details="${key}" aria-expanded="${expanded?'true':'false'}" aria-label="Details für ${esc(c.name||'Karte')} ${expanded?'schließen':'öffnen'}">${expanded?'−':'+'}</button></td>
    </tr>`;
    const detail = expanded ? `<tr class="detailRow"><td colspan="9">${renderDetail(c,pricing,status,quality)}</td></tr>` : '';
    return main + detail;
  }).join('');
}

function renderCurrentRows(){
  renderRows(visibleCards());
}

function resetListUiState(){
  activeStatusFilter='ALL';
  expandedRows.clear();
  filter.value='';
  updateStatusFilters();
}

function savedListLabel(item){
  const date = item.createdAt ? new Date(item.createdAt).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
  const checked = item.lastRecheckAt ? ' • live geprüft' : '';
  return `#${item.id} • ${coins(item.budget)} • ${item.platform==='pc'?'PC':'Konsole'} • ${date}${checked}`;
}

async function loadSavedLists(selectId = null){
  if(!savedListSelect) return;
  try{
    const platform = $('#platform').value;
    const r = await fetch(`/api/uv/history?platform=${encodeURIComponent(platform)}&limit=30`);
    const data = await r.json();
    if(!r.ok) throw new Error(data.error||'Gespeicherte Listen konnten nicht geladen werden.');
    const previous = selectId ? String(selectId) : savedListSelect.value;
    savedListSelect.innerHTML = '<option value="">Gespeicherte Listen…</option>' + (data.lists||[]).map(item=>`<option value="${item.id}">${savedListLabel(item)}</option>`).join('');
    if(previous && [...savedListSelect.options].some(o=>o.value===previous)) savedListSelect.value=previous;
    loadSavedBtn.disabled=actionBusy||!savedListSelect.value;
  }catch{
    savedListSelect.innerHTML='<option value="">Gespeicherte Listen nicht verfügbar</option>';
    loadSavedBtn.disabled=true;
  }
}

async function openSavedList(listId){
  if(!listId||actionBusy) return;
  setActionBusy(true);
  loadSavedBtn.disabled=true;
  const oldText=loadSavedBtn.textContent;
  loadSavedBtn.textContent='Öffne…';
  try{
    const r=await fetch(`/api/uv/list/${encodeURIComponent(listId)}`);
    const data=await r.json(); if(!r.ok) throw new Error(data.error||'Liste konnte nicht geöffnet werden.');
    $('#budget').value=data.budget;
    syncBudgetPresetState();
    $('#platform').value=data.platform;
    for(const field of ['minPrice','maxPrice','minGames','minSales']) if($('#'+field)) $('#'+field).value=data.filters?.[field]??'';
    lastCards=data.cards||[];
    lastListId=data.recheckListId||data.listId||listId;
    lastCheckedListId=data.persistedLiveRecheck?lastListId:null;
    resetListUiState();
    renderSummary(data);
    renderCurrentRows();
    filter.disabled=false;
    recheckBtn.disabled=!lastListId;
    rebalanceBtn.disabled=!data.persistedLiveRecheck;
    const checkText=data.lastRecheckAt?` • letzter Live-Check ${new Date(data.lastRecheckAt).toLocaleString('de-DE')}`:' • FUTBIN-Preise erneut prüfen';
    $('#tableSub').textContent=`Gespeicherte Liste #${lastListId} • ${data.count} Karten • ${coins(data.totalBuy)} / ${coins(data.budget)}${checkText}`;
    notice.textContent=`Liste #${lastListId} geöffnet. Gespeicherte Angebotspreise und Rechenziele jetzt erneut prüfen. Keine Kauf-Freigabe.`;
    notice.classList.remove('hidden');
    await loadSavedLists(lastListId);
  }catch(e){notice.textContent=e.message;notice.classList.remove('hidden')}
  finally{loadSavedBtn.textContent=oldText;setActionBusy(false)}
}

btn.addEventListener('click', async()=>{
  if(actionBusy) return;
  setActionBusy(true);
  const budget = Number($('#budget').value); const platform=$('#platform').value;
  const saveList = Boolean(saveListChoice?.checked);
  lastCards=[];lastListId=null;lastCheckedListId=null;filter.disabled=true;
  btn.disabled=true;loading.classList.remove('hidden');summary.classList.add('hidden');notice.classList.add('hidden');
  rows.innerHTML='<tr><td colspan="9" class="empty">FUTBIN-Preise werden geladen. Danach werden bis zu 100 Karten nach deinen Filtern innerhalb des Budgets ausgewählt…</td></tr>';
  try{
    const r=await fetch('/api/uv/generate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({budget,platform,saveList,filters:{minPrice:Number($('#minPrice').value)||0,maxPrice:$('#maxPrice').value?Number($('#maxPrice').value):15000000,minGames:Number($('#minGames').value)||0,minSales:Number($('#minSales').value)||0}})});
    const text=await r.text();
    let data;
    try{data=JSON.parse(text)}catch{throw new Error(`Server lieferte keine JSON-Antwort (HTTP ${r.status}).`)}
    if(!r.ok) throw new Error(data.error||'Fehler');
    lastCards=data.cards; lastListId=data.recheckListId||data.listId||null; lastCheckedListId=null; resetListUiState(); renderSummary(data); renderCurrentRows(); filter.disabled=false; recheckBtn.disabled=!lastListId; rebalanceBtn.disabled=true;
    $('#tableSub').textContent=`${data.count}/100 Positionen • Pool ${data.candidatePoolSize} • Restbudget ${coins(data.unusedBudget)} • ${data.saved?'Gespeichert':'Nur diese Sitzung'}`;
    notice.textContent=(data.saved?'Liste gespeichert. ':'Liste nur für diese Sitzung. ')+(data.dataNotice||'');
    notice.classList.remove('hidden');
    await loadSavedLists(data.listId||null);
  }catch(e){rows.innerHTML=`<tr><td colspan="9" class="empty error">${esc(e.message)}</td></tr>`}
  finally{loading.classList.add('hidden');setActionBusy(false)}
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startLiveRecheckJob(listId) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`/api/uv/recheck/${encodeURIComponent(listId)}`, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:'{}',
        cache:'no-store'
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Recheck konnte nicht gestartet werden');
      if (!data.jobId) throw new Error('Recheck-Job-ID fehlt');
      return data;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(1200);
    }
  }
  throw lastError || new Error('Recheck konnte nicht gestartet werden');
}

async function waitForLiveRecheckJob(jobId, listId) {
  const startedPollingAt = Date.now();
  let transientFetchErrors = 0;
  while (true) {
    await sleep(2000);
    try {
      const r = await fetch(`/api/uv/recheck-job/${encodeURIComponent(jobId)}?t=${Date.now()}`, { cache:'no-store' });
      const text = await r.text();
      let data;
      try{data=JSON.parse(text)}catch{throw new Error(`Recheck-Status war keine JSON-Antwort (HTTP ${r.status}).`)}
      if (!r.ok) throw new Error(data.error || 'Recheck-Status nicht abrufbar');
      transientFetchErrors = 0;
      if (data.status === 'DONE') return data.result;
      if (data.status === 'FAILED') throw new Error(data.error || 'Live-Recheck fehlgeschlagen');
      if (data.status === 'QUEUED') {
        $('#tableSub').textContent=`Live-Recheck für Liste #${listId} wartet CPU-sicher in der Queue${data.queuePosition?` • Position ${data.queuePosition}`:''}…`;
        continue;
      }
      const seconds = Math.max(1, Math.round((Date.now() - new Date(data.startedAt || startedPollingAt).getTime()) / 1000));
      const progress = Number(data.total) > 0 ? ` • ${Number(data.processed||0)}/${Number(data.total)}` : '';
      const phase = data.phase ? ` • ${String(data.phase).replaceAll('_',' ')}` : '';
      const longRun = seconds >= 300 ? ' • läuft weiter, nicht fehlgeschlagen' : '';
      $('#tableSub').textContent=`Live-Recheck für Liste #${listId} läuft CPU-sicher… ${seconds}s${progress}${phase}${longRun}`;
      if(seconds >= 300){
        notice.textContent='Live-Prüfung dauert länger als 5 Minuten, läuft serverseitig aber weiter. Die Oberfläche wartet auf DONE oder einen echten FAILED-Status.';
        notice.classList.remove('hidden');
      }
    } catch (error) {
      const transient = error instanceof TypeError || /failed to fetch|network|keine json-antwort/i.test(String(error?.message || ''));
      if (transient && transientFetchErrors < 15) {
        transientFetchErrors++;
        $('#tableSub').textContent=`Live-Recheck läuft vermutlich weiter… Verbindung wird erneut geprüft (${transientFetchErrors}/15)`;
        continue;
      }
      throw error;
    }
  }
}

recheckBtn.addEventListener('click', async()=>{
  if(!lastListId||actionBusy) return;
  setActionBusy(true);
  recheckBtn.disabled=true;
  rebalanceBtn.disabled=true;
  const oldText=recheckBtn.textContent;
  recheckBtn.textContent='Prüfe live…';
  notice.textContent=`Live-Prüfung für Liste #${lastListId} startet… FUTBIN-Angebotspreise werden erneut geprüft. Die Abrufpause von zehn Minuten bleibt erhalten.`;
  notice.classList.remove('hidden');
  $('#tableSub').textContent=`Live-Recheck für Liste #${lastListId} startet…`;
  try{
    const started = await startLiveRecheckJob(lastListId);
    const data = await waitForLiveRecheckJob(started.jobId, lastListId);
    const bySlot=new Map((data.cards||[]).map(x=>[x.slot,x]));
    lastCards=lastCards.map(c=>{
      const liveRow=bySlot.get(c.slot)||null;
      return liveRow?.fresh ? {...c,...liveRow.fresh,_recheck:liveRow} : {...c,_recheck:liveRow};
    });
    lastCheckedListId=lastListId;
    if(data.portfolio) renderSummary(data.portfolio);
    renderCurrentRows();
    const c=data.summary?.counts||{};
    $('#tableSub').textContent=`Preisprüfung • Beobachten ${c.WATCH||0} • Preis fehlt ${c.MISSING||0}`;
    notice.textContent=`FUTBIN-Angebotspreise geprüft. ${data.portfolio?.currentTotalComplete===false?'Für einige Karten fehlen Preise. Der Gesamtplan kann aktuell nicht vollständig geprüft werden. ':''}${data.portfolio?.overBudget?'Die neuen Preise überschreiten dein Budget; bitte neu ausbalancieren. ':''}Keine Kauf-Freigabe, da Games und Verkäufe nicht nachgewiesen sind.`;
    notice.classList.remove('hidden');
    rebalanceBtn.disabled=false;
    loadSavedLists(lastListId).catch(()=>{});
  }catch(e){
    const message=e?.message||'Recheck fehlgeschlagen';
    notice.textContent=message;
    notice.classList.remove('hidden');
    $('#tableSub').textContent=`Live-Recheck fehlgeschlagen • Liste #${lastListId}`;
  }
  finally{recheckBtn.textContent=oldText;setActionBusy(false)}
});

rebalanceBtn.addEventListener('click', async()=>{
  if(!lastListId||actionBusy) return;
  setActionBusy(true);
  rebalanceBtn.disabled=true; recheckBtn.disabled=true;
  const oldText=rebalanceBtn.textContent;
  rebalanceBtn.textContent='Balanciere neu…';
  try{
    const oldListId=lastListId;
    const saveList=Boolean(saveListChoice?.checked);
    const r=await fetch(`/api/uv/rebalance/${lastListId}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({saveList})});
    const text=await r.text();
    let data;
    try{data=JSON.parse(text)}catch{throw new Error(`Server lieferte keine JSON-Antwort (HTTP ${r.status}).`)}
    if(!r.ok) throw new Error(data.error||'Rebalance fehlgeschlagen');
    lastCards=data.cards||[]; lastListId=data.recheckListId||data.listId||null; lastCheckedListId=null; activeStatusFilter='ALL'; expandedRows.clear();
    renderSummary(data); renderCurrentRows();
    const rb=data.rebalance||{};
    $('#tableSub').textContent=lastListId
      ? `Rebalance #${oldListId} → #${lastListId} • behalten ${rb.retainedCount||0} • ersetzt ${rb.replacementCount||0} • FUTBIN-Preise erneut prüfen`
      : `Rebalance von #${oldListId} nur angezeigt • behalten ${rb.retainedCount||0} • ersetzt ${rb.replacementCount||0} • Nicht gespeichert`;
    notice.textContent=lastListId
      ? `Liste neu ausbalanciert${data.saved?' und gespeichert':''}. ${data.dataNotice||''}`
      : `Neu ausbalancierte Liste wurde NICHT gespeichert. Aktiviere „Liste speichern“, wenn du die nächste erzeugte oder ausbalancierte Liste behalten möchtest.`;
    notice.classList.remove('hidden');
    recheckBtn.disabled=!lastListId;
    rebalanceBtn.disabled=true;
    await loadSavedLists(lastListId||null);
  }catch(e){notice.textContent=e.message;notice.classList.remove('hidden');rebalanceBtn.disabled=false}
  finally{rebalanceBtn.textContent=oldText;setActionBusy(false)}
});

savedListSelect?.addEventListener('change',()=>{ loadSavedBtn.disabled=!savedListSelect.value; });
loadSavedBtn?.addEventListener('click',()=>openSavedList(savedListSelect.value));
$('#platform')?.addEventListener('change',()=>loadSavedLists());

function syncBudgetPresetState(){
  const value=Number($('#budget')?.value||0);
  for(const button of budgetPresetButtons) button.classList.toggle('active',Number(button.dataset.budget)===value);
}
for(const button of budgetPresetButtons){
  button.addEventListener('click',()=>{
    $('#budget').value=button.dataset.budget;
    syncBudgetPresetState();
  });
}
$('#budget')?.addEventListener('input',syncBudgetPresetState);
syncBudgetPresetState();

filter.addEventListener('input',renderCurrentRows);

for(const button of statusFilters){
  button.addEventListener('click',()=>{
    activeStatusFilter=button.dataset.status||'ALL';
    renderCurrentRows();
  });
}

rows.addEventListener('click',event=>{
  const button=event.target.closest('[data-details]');
  if(!button) return;
  const key=String(button.dataset.details||'');
  if(expandedRows.has(key)) expandedRows.delete(key); else expandedRows.add(key);
  renderCurrentRows();
});

updateStatusFilters();
loadStatus();
loadSavedLists();
