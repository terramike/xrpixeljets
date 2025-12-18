// /jets/js/xaman-bridge.js — 2025-12-18r1 (client bridge for Xaman/XUMM payload flow)
(function (g) {
  'use strict';

  const BASE = g.JETS_API_BASE || '';
  const POLL_MS = 1600;
  const TIMEOUT_MS = 180000; // 3 minutes

  async function createPayload(tx_json) {
    const r = await fetch(`${BASE}/xaman/payload`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ tx_json, options:{ submit:true } }) // let Xaman submit on success
    });
    if (!r.ok) throw new Error(`xaman_payload_http_${r.status}`);
    return r.json(); // {uuid, next, refs}
  }

  async function getPayload(uuid) {
    const r = await fetch(`${BASE}/xaman/payload/${encodeURIComponent(uuid)}`);
    if (!r.ok) throw new Error(`xaman_poll_http_${r.status}`);
    return r.json(); // {resolved, signed, txid, hex}
  }

  function openDeeplink(next) {
    // Prefer the universal https link; Xaman app will handle it
    const url = next?.always || next?.mobile || next?.web;
    if (!url) throw new Error('xaman_no_deeplink');
    // Open in same tab for in-app browsers; new tab otherwise
    try {
      if (/Instagram|FBAN|FBAV|Twitter|X-Twitter|Discord|Telegram/i.test(navigator.userAgent)) {
        location.href = url;
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch { location.href = url; }
  }

  async function signTxViaPayload(tx_json) {
    const start = Date.now();
    const { uuid, next } = await createPayload(tx_json);
    openDeeplink(next);

    // poll for completion
    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const s = await getPayload(uuid);
      if (s.resolved) {
        if (!s.signed) throw new Error('xaman_user_rejected');
        return { hash: s.txid || '' };
      }
    }
    throw new Error('xaman_timeout');
  }

  g.XamanBridge = { signTxViaPayload };
})(window);
