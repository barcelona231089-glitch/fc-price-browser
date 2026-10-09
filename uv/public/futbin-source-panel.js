// Original FC ÜV Brain price-source inspector. No second app, no JSON import.
// Polls the price source already installed in uvRouter and renders real quotes only.
const panel = document.querySelector('#futbinSourcePanel');
const state = document.querySelector('#futbinSourceState');
const table = document.querySelector('#futbinSourceRows');
const budget = document.querySelector('#budget');
const platform = document.querySelector('#platform');
const generate = document.querySelector('#generateBtn');
const badge = document.querySelector('#statusBadge');
const number = n => Number(n).toLocaleString('de-DE');
let modeEnabled = false, loading = false;
let lastFingerprint = '';

function gateLegacyOrders() {
  platform.value = 'console';
  platform.disabled = true;
  generate.disabled = true;
  generate.title = 'FUTBIN-only: Handelsvorschläge werden erst nach unabhängigen Verkaufssignalen freigegeben';
  for (const id of ['saveListChoice','loadSavedBtn','savedListSelect','recheckBtn','rebalanceBtn']) {
    const control = document.getElementById(id);
    if (control) control.disabled = true;
  }
  const note = document.querySelector('.generatorNote');
  if (note) note.textContent = 'FUTBIN ONLY · FC27 Konsole · automatische PS-Preise · bestehende ÜV-Logik bleibt erhalten · Kaufempfehlungen ohne Verkaufsnachweise gesperrt';
  const sub = document.querySelector('#tableSub');
  if (sub && sub.textContent.includes('Noch keine Liste')) sub.textContent = 'Die Original-ÜV-Berechnung bleibt erhalten. FUTBIN-Angebote findest du oben.';
}
function createCell(content) {
  const el = document.createElement('td');
  el.textContent = String(content ?? '');
  return el;
}
function drawRows(cards = []) {
  table.replaceChildren();
  for (const card of cards.slice(0, 200)) {
    if (!/^[1-9]\d{0,14}$/.test(String(card.playerId))) continue;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = 'https://www.futbin.com/27/player/' + encodeURIComponent(card.playerId);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = (card.playerName || ('Spieler ' + card.playerId)) + ' · ' +
      (card.cardType || 'Version nicht angegeben');
    td.append(a);
    tr.append(td,
      createCell(card.rating ?? '?'),
      createCell(number(card.priceCoins)),
      createCell(card.evidence === 'futbin-direct-json' ? 'FUTBIN JSON · PS' : 'FUTBIN Browser · PS'),
      createCell(card.sourceCheckedAt || new Date(card.capturedAt).toLocaleString('de-DE'))
    );
    table.append(tr);
  }
  if (!table.children.length) {
    const tr = document.createElement('tr');
    const td = createCell('FUTBIN-Livequelle wird geladen oder liefert noch keine gültigen Konsolenpreise.');
    td.colSpan = 5;
    tr.append(td);
    table.append(tr);
  }
}
async function update() {
  if (loading) return;
  loading = true;
  try {
    if (!modeEnabled) {
      const statusRes = await fetch('/api/uv/status', {cache:'no-store'});
      if (!statusRes.ok) throw new Error('ÜV-Status nicht erreichbar');
      const source = await statusRes.json();
      if (source.priceSourceMode !== 'FUTBIN_ONLY') return;
      modeEnabled = true;
      panel.classList.remove('hidden');
    }
    const coins = Number(budget?.value);
    if (!Number.isSafeInteger(coins) || coins < 30000) return;
    const r = await fetch('/api/uv/futbin-console/players?budget=' + coins, {cache:'no-store'});
    const data = await r.json();
    if (!r.ok || data.source !== 'FUTBIN' || data.platform !== 'console') {
      throw new Error(data.error || 'FUTBIN-Preise nicht abrufbar');
    }
    gateLegacyOrders();
    badge.textContent = 'FUTBIN ONLY · FC27 Konsole';
    const direct = data.directFutbin || {};
    if (direct.active) {
      state.textContent = 'FUTBIN sucht automatisch … ' +
        (direct.discoveredPlayers || 0) + ' Spieler entdeckt, ' +
        (direct.pricedPlayers || 0) + ' bepreist. ';
    } else if (direct.lastError) {
      state.textContent = 'FUTBIN-Zugriff gestört: ' + direct.lastError +
        '. Kein Wechsel zu FUT.GG; erneuter Versuch erst nach Ablauf der Pause.';
    } else {
      state.textContent = data.freshPlayers + ' frische FUTBIN-PS-Preise, ' +
        data.staleRows + ' veraltet, ' + data.affordableListings +
        ' Angebote einzeln innerhalb deines Budgets. ' +
        (direct.nextRefreshAt ? 'Nächster Datenabruf frühestens ' +
        new Date(direct.nextRefreshAt).toLocaleTimeString('de-DE') : '');
    }
    const fingerprint = JSON.stringify([data.cards, data.staleCards]);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      drawRows([...(data.cards || []), ...(data.staleCards || [])]);
    }
  } catch (error) {
    if (modeEnabled) state.textContent = String(error?.message || error);
  } finally {
    loading = false;
  }
}
budget?.addEventListener('change', () => void update());
setInterval(() => void update(), 5000);
void update();
