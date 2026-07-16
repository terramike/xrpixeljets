// Wake the Render API as soon as the browser game loads.
(function installServerWake(g) {
  'use strict';

  if (typeof g.JETS_WAKE_SERVER === 'function') return;

  const base = String(g.JETS_API_BASE || 'https://xrpixeljets.onrender.com').replace(/\/+$/, '');
  const timeoutMs = 90_000;
  let readyPromise = null;

  function wakeServer({ force = false } = {}) {
    if (!force && readyPromise) return readyPromise;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const request = fetch(`${base}/healthz`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`health_http_${response.status}`);
        const body = await response.json().catch(() => ({}));
        return { ok: body?.ok !== false, status: response.status };
      })
      .catch((error) => ({
        ok: false,
        error: error?.name === 'AbortError' ? 'server_wake_timeout' : String(error?.message || error)
      }))
      .finally(() => clearTimeout(timeout));

    readyPromise = request;
    g.JETS_SERVER_READY = request;

    request.then((result) => {
      if (!result?.ok && readyPromise === request) readyPromise = null;
      const method = result?.ok ? 'info' : 'warn';
      console[method]('[Jets] Server wake check', result);
    });

    return request;
  }

  g.JETS_WAKE_SERVER = wakeServer;
  g.JETS_SERVER_READY = wakeServer();
})(window);
