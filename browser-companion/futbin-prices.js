// FUTBIN-only visible DOM price capture. No network requests, cookies, headers or hidden data.
(() => {
  const match = location.pathname.match(/^\/(27)\/player\/(\d+)(?:\/|$)/);
  if (!match || !/(^|\.)futbin\.com$/i.test(location.hostname)) return;
  const year = Number(match[1]), playerId = match[2];
  const parseCoins = value => {
    const raw = String(value || '').trim().replace(/[,\s]/g, '');
    const m = raw.match(/(?:^|[^\d])(\d+(?:\.\d+)?)([kKmM]?)(?:$|[^a-z])/);
    if (!m) return null;
    const n = Number(m[1]) * ({ k: 1000, m: 1000000 }[m[2].toLowerCase()] || 1);
    return Number.isFinite(n) && n >= 100 && n <= 15000000 ? Math.round(n) : null;
  };
  let last = '';
  function scan() {
    const prices = [];
    for (const [platform, cls] of [['ps', 'platform-ps-only'], ['pc', 'platform-pc-only']]) {
      const box = document.querySelector('.price-box.' + cls);
      if (!box) continue;
      const el = box.querySelector('[class*="lowest-price"]');
      const price = parseCoins(el?.textContent);
      if (price === null) continue;
      prices.push({ platform, price, evidence: 'visible-price-box' });
    }
    if (!prices.length) return;
    const visibleName = String(document.querySelector('h1')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const playerName = visibleName.length >= 2 && visibleName.length <= 90 ? visibleName : null;
    const payload = { source: 'futbin', year, playerId, pagePath: location.pathname,
      playerName, capturedAt: new Date().toISOString(), prices };
    // Deduplicate by actual visible values, not capturedAt (which changes every scan).
    // A real page reload gets a fresh timestamp because this content script restarts.
    const fingerprint = JSON.stringify({ year, playerId, playerName, prices });
    if (fingerprint === last) return;
    last = fingerprint;
    chrome.runtime.sendMessage({ type: 'ATF_FUTBIN_PRICE', payload }, () => void chrome.runtime.lastError);
  }
  scan();
  const observer = new MutationObserver(() => { clearTimeout(scan.pending); scan.pending = setTimeout(scan, 350); });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
})();
