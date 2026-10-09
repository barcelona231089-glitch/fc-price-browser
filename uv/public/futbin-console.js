// Dedicated FUTBIN-only frontend. No mixed-source generation or fallback.
const fileInput = document.querySelector('#futbinConsoleFile');
const budgetInput = document.querySelector('#futbinConsoleBudget');
const checkButton = document.querySelector('#futbinConsoleCheck');
const status = document.querySelector('#futbinConsoleStatus');
const tableBody = document.querySelector('#futbinConsoleRows');
const badge = document.querySelector('#statusBadge');
badge.textContent = 'FC27 • FUTBIN Konsole • Importprüfung';
badge.classList.add('good');

const formatCoins = n => Number(n).toLocaleString('de-DE');
const showStatus = (message, error = false) => {
  status.textContent = message;
  status.classList.toggle('futbinConsoleError', error);
};
function showResults(data) {
  tableBody.replaceChildren();
  for (const card of data.cards || []) {
    const tr = document.createElement('tr');
    const columns = [
      card.playerId, 'PS / Konsole', formatCoins(card.priceCoins),
      new Date(card.capturedAt).toLocaleString('de-DE'),
      'WAIT · Verkauf nicht bestätigt'
    ];
    for (const content of columns) {
      const td = document.createElement('td');
      td.textContent = content;
      tr.append(td);
    }
    tableBody.append(tr);
  }
  if (!data.cards?.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'empty';
    cell.textContent = 'Keine frischen, gültigen FUTBIN-Konsolenpreise vorhanden.';
    row.append(cell);
    tableBody.append(row);
  }
  showStatus(
    `${data.freshPlayers} frische Spielerpreise · ${data.affordableListings} im Budget (nur Angebotsvergleich) · ${data.staleRows} veraltet · ${data.invalidRows} ungültig · ${data.missingForTarget} fehlen für 100. ${data.notice} Kaufempfehlungen: ${data.recommendationCount}.`,
    true
  );
}
checkButton.addEventListener('click', async () => {
  const file = fileInput.files?.[0];
  if (!file) return showStatus('Bitte zuerst futbin-fc27-console-prices.json auswählen.', true);
  if (file.size > 900_000) return showStatus('JSON-Datei zu groß (maximal 900 KB).', true);
  const budget = Number(budgetInput.value);
  if (!Number.isSafeInteger(budget) || budget < 30000 || budget > 100000000) {
    return showStatus('Bitte ein Budget zwischen 30.000 und 100.000.000 Coins eingeben.', true);
  }
  checkButton.disabled = true;
  showStatus('Prüfe FC27-Konsolenpreise, Alter und FUTBIN-Nachweis …');
  try {
    const exportData = JSON.parse(await file.text());
    const response = await fetch('/api/uv/futbin-console/analyze', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ export: exportData, budget })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'FUTBIN-Import konnte nicht geprüft werden.');
    if (result.source !== 'FUTBIN' || result.mode !== 'FUTBIN_FC27_CONSOLE_ONLY') {
      throw new Error('Unerwartete Quelle: Nicht-FUTBIN-Daten wurden zurückgewiesen.');
    }
    showResults(result);
  } catch (error) {
    tableBody.replaceChildren();
    showStatus(String(error?.message || error), true);
  } finally {
    checkButton.disabled = false;
  }
});
