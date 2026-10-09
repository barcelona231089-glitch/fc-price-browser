// Automatic FUTBIN FC27 JSON discovery + console prices, with optional browser captures.
// Uses the functioning futbin.org JSON endpoint, not the Cloudflare-blocked www.futbin.com pages.
const budgetInput = document.querySelector('#futbinConsoleBudget');
const refreshButton = document.querySelector('#futbinConsoleRefresh');
const connection = document.querySelector('#futbinConnection');
const status = document.querySelector('#futbinConsoleStatus');
const tableBody = document.querySelector('#futbinConsoleRows');
const badge = document.querySelector('#statusBadge');
badge.textContent = 'FC27 · FUTBIN Konsole · automatische API';
badge.classList.add('good');

let companionConnectedAt = null;
let lastSyncedSignature = '';
let syncing = false;
let lastPrices = null;
let pollBusy = false;

const isValidId = id => /^[1-9]\d{0,14}$/.test(String(id));
const coinFormat = n => Number(n).toLocaleString('de-DE');
const showStatus = (message, warning = false) => {
  status.textContent = message;
  status.classList.toggle('futbinConsoleError', warning);
};
const getBudget = () => Number(budgetInput.value);
const validBudget = budget => Number.isSafeInteger(budget) && budget >= 30000 && budget <= 100000000;

function extractConsoleRows(captures) {
  if (!Array.isArray(captures)) return null;
  const rows = [];
  for (const p of captures.slice(-500)) {
    if (p?.source !== 'futbin' || p.year !== 27 || !isValidId(p.playerId) ||
      !Array.isArray(p.prices) || typeof p.pagePath !== 'string') continue;
    const prefix = '/27/player/' + p.playerId;
    if (p.pagePath !== prefix && !p.pagePath.startsWith(prefix + '/')) continue;
    for (const value of p.prices) {
      if (value?.platform !== 'ps' || value.evidence !== 'visible-price-box' ||
        !Number.isSafeInteger(value.price)) continue;
      rows.push({ source: 'FUTBIN', game: 'FC27', playerId: String(p.playerId),
        playerName: typeof p.playerName === 'string' ? p.playerName.slice(0,90) : null,
        platform: 'console', coins: value.price, capturedAt: p.capturedAt,
        evidence: 'visible-price-box', priceType: 'visible_listing',
        salesVerified: false });
    }
  }
  return { schemaVersion: 1, source: 'FUTBIN', prices: rows };
}

function rowForCard(card, old = false) {
  if (!isValidId(card.playerId)) return;
  const tr = document.createElement('tr');
  if (old) tr.classList.add('futbinStaleRow');
  const first = document.createElement('td');
  const link = document.createElement('a');
  link.href = 'https://www.futbin.com/27/player/' + encodeURIComponent(card.playerId);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = (card.playerName || ('#' + card.playerId)) +
    (card.rating ? ' (' + card.rating + ')' : '') + ' · ' + card.playerId + ' ↗';
  link.title = 'FUTBIN-Spielerseite öffnen';
  first.append(link);
  tr.append(first);
  const other = [
    'PS / Konsole',
    coinFormat(card.priceCoins),
    'Abruf ' + new Date(card.capturedAt).toLocaleTimeString('de-DE') +
      (card.sourceCheckedAt ? ' · FUTBIN geprüft: ' + String(card.sourceCheckedAt).slice(0,25) : ''),
    old ? 'ALT · nächster API-Abruf nötig' :
      card.evidence === 'futbin-direct-json'
        ? 'FUTBIN JSON · Verkauf unbestätigt'
        : 'Browser · Verkauf unbestätigt'
  ];
  for (const content of other) {
    const td = document.createElement('td');
    td.textContent = content;
    tr.append(td);
  }
  tableBody.append(tr);
}

function renderResponse(data) {
  tableBody.replaceChildren();
  for (const item of data.cards || []) rowForCard(item);
  for (const item of data.staleCards || []) rowForCard(item, true);
  if (!tableBody.children.length) {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = 'FUTBIN-API sucht Spieler. Die erste Suche kann einige Sekunden dauern.';
    row.append(cell);
    tableBody.append(row);
  }
  const direct = data.directFutbin || {};
  const last = direct.lastSuccessAt
    ? new Date(direct.lastSuccessAt).toLocaleTimeString('de-DE') : 'noch nie';
  const progress = direct.active
    ? ' · Suche läuft: ' + direct.currentPhase +
      ', ' + (direct.discoveredPlayers || 0) + ' entdeckt, ' +
      (direct.pricedPlayers || 0) + ' bepreist'
    : '';
  const message = `FUTBIN-API: ${data.cachedPlayers} Spieler · ${data.freshPlayers} frische Preis-Snapshots · ${data.staleRows} veraltet · ${data.affordableListings} im Budget (reiner Angebotsvergleich) · ${data.missingForTarget} fehlen für 100. ${progress} Letzter erfolgreicher JSON-Abruf: ${last}. Keine bestätigten Verkäufe, daher 0 Kaufempfehlungen.`;
  showStatus(message, data.freshPlayers === 0 && !direct.active);
  if (direct.active) {
    connection.textContent = '✅ Direkte FUTBIN-FC27-JSON-API antwortet. Spieler und PS-Konsolenpreise werden automatisch geladen (' +
      (direct.requests || 0) + ' begrenzte Anfragen). Kein Browser-Companion nötig.';
  } else if (direct.hasSuccessfulFetch) {
    connection.textContent = '✅ FUTBIN-FC27-JSON-API läuft! ' +
      (direct.pricedPlayers || 0) + ' Spieler automatisch geladen. Nächste Aktualisierung frühestens ' +
      (direct.nextRefreshAt ? new Date(direct.nextRefreshAt).toLocaleTimeString('de-DE') : 'in einigen Minuten') +
      '. Browser-Companion optional.';
  } else if (direct.lastError) {
    connection.textContent = 'FUTBIN-JSON-API meldet ' + direct.lastError +
      '. Automatische Pause bis ' +
      (direct.nextRefreshAt ? new Date(direct.nextRefreshAt).toLocaleTimeString('de-DE') : 'zum nächsten Versuch') +
      '; vorhandene Browserdaten bleiben getrennt.';
  } else {
    connection.textContent = 'Verbindung zur direkten FUTBIN-FC27-JSON-API wird aufgebaut …';
  }
}

async function refreshFromApi() {
  if (pollBusy) return;
  const budget = getBudget();
  if (!validBudget(budget)) return showStatus('Budget zwischen 30.000 und 100.000.000 Coins eingeben.', true);
  pollBusy = true;
  try {
    const res = await fetch('/api/uv/futbin-console/players?budget=' + budget, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.source !== 'FUTBIN' || data.mode !== 'FUTBIN_FC27_CONSOLE_ONLY')
      throw new Error(data.error || 'FUTBIN-API nicht erreichbar');
    renderResponse(data);
  } catch (error) {
    showStatus('Lokale API-Fehler: ' + String(error?.message || error), true);
  } finally {
    pollBusy = false;
  }
}

async function syncCompanion(packet) {
  if (syncing || !packet?.prices?.length) return;
  const signature = JSON.stringify(packet.prices);
  if (signature === lastSyncedSignature) return;
  syncing = true;
  try {
    const res = await fetch('/api/uv/futbin-console/sync', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(packet)
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Browserabgleich gescheitert');
    lastSyncedSignature = signature;
    await refreshFromApi();
  } catch (error) {
    connection.textContent = 'Browser-Companion verbunden, aber API-Abgleich fehlgeschlagen: ' +
      String(error?.message || error);
  } finally {
    syncing = false;
  }
}

// The extension's content script bridges its background storage into this local page.
// No credentials, cookies, request headers or FUTBIN session data are transferred.
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== location.origin ||
    event.data?.source !== 'atf-companion' ||
    event.data?.type !== 'ATF_TRAFFIC') return;
  companionConnectedAt = Date.now();
  const version = String(event.data?.diagnostics?.version || '?');
  // Optional: the direct JSON feed works without the browser companion.
  connection.title = 'Optionaler Browser-Companion v' + version + ' verbunden';
  const packet = extractConsoleRows(event.data.prices);
  if (packet && packet.prices.length) {
    lastPrices = packet;
    void syncCompanion(packet);
  }
});

refreshButton.addEventListener('click', () => {
  window.postMessage({ source: 'atf-web', type: 'ATF_GET' }, location.origin);
  if (lastPrices) void syncCompanion(lastPrices);
  void refreshFromApi();
});
budgetInput.addEventListener('change', () => { void refreshFromApi(); });
setInterval(() => {
  void refreshFromApi();
}, 5000);
window.postMessage({ source: 'atf-web', type: 'ATF_GET' }, location.origin);
void refreshFromApi();
