(() => {
  const baseFetch = window.fetch.bind(window);
  const transientIds = new Set();

  function requestMeta(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let pathname = '';
    try { pathname = new URL(rawUrl, window.location.href).pathname; } catch {}
    return { pathname, method };
  }

  function copyJsonResponse(response, data) {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  window.fetch = async function unsavedLiveFetch(input, init = {}) {
    const response = await baseFetch(input, init);
    const { pathname, method } = requestMeta(input, init);
    const isGeneration = pathname === '/api/uv/generate' && method === 'POST';
    const isGenerationJobStatus = pathname.startsWith('/api/uv/generate-job/') && method === 'GET';
    const isRebalance = pathname.startsWith('/api/uv/rebalance/') && method === 'POST';
    if (!isGeneration && !isGenerationJobStatus && !isRebalance) return response;

    let data;
    try { data = JSON.parse(await response.clone().text()); } catch { return response; }

    // Async generation returns the actual generated list nested in result.
    // Record its temporary recheck id for UI wording, but do not pretend it is persisted.
    if (isGenerationJobStatus) {
      const result = data?.result;
      if (response.ok && result?.transientRecheckOnly && result?.recheckListId && !result?.listId) {
        transientIds.add(String(result.recheckListId));
      }
      return response;
    }

    if (!response.ok || !data?.transientRecheckOnly || !data?.recheckListId || data?.listId) return response;

    const id = String(data.recheckListId);
    transientIds.add(id);

    // Legacy direct-generation/rebalance compatibility.
    return copyJsonResponse(response, {
      ...data,
      listId: data.recheckListId,
      saved: false,
      __transientPresentedAsListId: true
    });
  };

  function isTransientText(text = '') {
    for (const id of transientIds) {
      if (String(text).includes(`#${id}`)) return true;
    }
    return false;
  }

  function rewriteUi() {
    const note = document.querySelector('.generatorNote');
    if (note) {
      const desired = 'Top 100 fürs Budget • Speichern ist nur fürs spätere Öffnen • FUTBIN Primary: Preis, Games, Listings und echte Verkaufspreise';
      if (note.textContent !== desired) note.textContent = desired;
    }

    const notice = document.querySelector('#notice');
    if (notice && isTransientText(notice.textContent)) {
      const text = String(notice.textContent || '');
      if (/gespeichert/i.test(text)) {
        notice.textContent = 'Liste NICHT dauerhaft gespeichert. Live-Prüfung und Neuausbalancieren bleiben trotzdem frei nutzbar. Der interne Prüfzustand ist nur temporär und wird automatisch gelöscht.';
      } else if (/live geprüft/i.test(text)) {
        notice.textContent = 'Aktuelle NICHT gespeicherte Liste live geprüft. Kaufen nur bei KEEP oder REPRICE und niemals über KAUFEN MAX. WAIT/DROP/MISSING nicht kaufen.';
      }
    }

    const sub = document.querySelector('#tableSub');
    if (sub && isTransientText(sub.textContent) && /Rebalance/i.test(String(sub.textContent || ''))) {
      sub.textContent = String(sub.textContent)
        .replace(/#\d+\s*→\s*#\d+/, 'temporär')
        .replace(/Vor dem Kaufen wieder live prüfen/i, 'Nicht gespeichert • Vor dem Kaufen wieder live prüfen');
    }
  }

  const observer = new MutationObserver(rewriteUi);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.addEventListener('DOMContentLoaded', rewriteUi);
  rewriteUi();
})();
