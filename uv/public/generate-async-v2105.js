(() => {
  const nativeFetch = window.fetch.bind(window);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  window.fetch = async function uvGenerateProxy(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let pathname = '';
    try { pathname = new URL(rawUrl, window.location.href).pathname; } catch {}

    if (pathname !== '/api/uv/generate' || method !== 'POST') {
      return nativeFetch(input, init);
    }

    const start = await nativeFetch('/api/uv/generate-async', init);
    const startText = await start.text();
    let accepted;
    try { accepted = JSON.parse(startText); }
    catch { return jsonResponse({ error: `Async-Start lieferte keine JSON-Antwort (HTTP ${start.status}).` }, start.status || 500); }

    if (!start.ok || !accepted?.pollUrl) {
      return jsonResponse(accepted || { error: 'ÜV-Generierung konnte nicht gestartet werden.' }, start.status || 500);
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < 8 * 60_000) {
      await sleep(1500);
      const poll = await nativeFetch(accepted.pollUrl, {
        method: 'GET',
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      let job;
      try { job = await poll.json(); }
      catch { return jsonResponse({ error: `Job-Status lieferte keine JSON-Antwort (HTTP ${poll.status}).` }, poll.status || 500); }

      if (job?.status === 'DONE') {
        return jsonResponse(job.result || {}, Number(job.httpStatus || 200));
      }
      if (job?.status === 'FAILED' || job?.status === 'MISSING') {
        return jsonResponse({ error: job.error || 'ÜV-Generierung fehlgeschlagen.' }, Number(job.httpStatus || 500));
      }
    }

    return jsonResponse({ error: 'ÜV-Generierung läuft zu lange. Bitte Status prüfen.' }, 504);
  };
})();
