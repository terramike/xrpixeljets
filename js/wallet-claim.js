// /jets/js/wallet-claim.js — 2025-12-18r4 (adds Gem wiring)
import { Signers } from './signers.js';

(function setup(g){
  'use strict';

  const ISSUER  = g.ISSUER_ADDR || 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e';
  const CURRENCY_HEX = g.CURRENCY_HEX || '4A45545300000000000000000000000000000000';
  const XRPL_WSS = g.XRPL_WSS || 'wss://xrplcluster.com';

  const $ = (id) => document.getElementById(id);
  const hud = (m) => {
    console.log('[Claim]', m);
    const el = $('log'); if (!el) return;
    const d = document.createElement('div'); d.className='log-line'; d.textContent=String(m);
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  };

  async function ensureTrustline(addr){
    try{
      if (!g.xrpl) return true;
      const api = new g.xrpl.Client(XRPL_WSS);
      await api.connect();
      const lines = await api.request({ command:'account_lines', account: addr, ledger_index:'validated' });
      await api.disconnect();
      const has = (lines?.result?.lines || []).some(l => l.account === ISSUER && (l.currency === CURRENCY_HEX || l.currency === 'JETS'));
      if (!has) hud('No JETS trustline. Use Set Trustline before claiming.');
      return has;
    } catch {
      hud('Trustline check skipped (network hiccup).');
      return true;
    }
  }

  function getAmount() {
    const v = Number(($('claim-amount')?.value || '0').trim());
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  async function fetchJsonOrError(r){
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) {
      const err = (body && (body.error || body.message)) ? `${body.error}${body.detail? ' '+JSON.stringify(body.detail):''}` : `http_${r.status}`;
      throw new Error(err);
    }
    return body;
  }

  async function fetchClaimStart(amount, token, wallet){
    const base = g.JETS_API_BASE || '';
    const r = await fetch(`${base}/claim/start`, {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization': token ? `Bearer ${token}` : '',
        'X-Wallet': (wallet || '').trim()
      },
      body: JSON.stringify({ amount })
    });
    return fetchJsonOrError(r);
  }

  async function claim(prefer) {
    try {
      const signer = Signers.getActive(prefer);
      if (!signer) { hud('No wallet connected. Connect first.'); return; }
      const addr = (await signer.address() || '').trim();
      const which = signer?.id || 'unknown';
      hud(`Using signer: ${which}, address: ${addr || '(none)'}`);
      if (!addr) { hud('Could not resolve address from wallet.'); return; }

      const okTL = await ensureTrustline(addr);
      if (!okTL) {
        g.dispatchEvent(new CustomEvent('jets:trustline_required', { detail: { address: addr } }));
        return;
      }

      const amount = getAmount();
      if (!amount) { hud('Enter a valid claim amount.'); return; }
      const token = (localStorage.getItem('JWT') || '').trim();
      if (!token) { hud('Not signed in. Click “Sign In” first to get a JWT.'); return; }

      hud(`Starting claim for ${amount} JF…`);
      const res = await fetchClaimStart(amount, token, addr);

      if (res?.txid || (typeof res?.amount === 'number' && typeof res?.net === 'number')) {
        if (res.txid) hud(`✅ Claim sent on XRPL: ${res.txid}`);
        hud(`Spent ${res.amount ?? amount} JF → Received ${res.net ?? '(see wallet)'} JETS`);
        try { await g.SrvAPI?.profile?.(); } catch {}
        return;
      }

      const tx_json = res?.tx_json || res?.result?.tx_json || res?.tx || res?.txJSON || null;
      if (!tx_json) {
        hud('Claim acknowledged.');
        try { await g.SrvAPI?.profile?.(); } catch {}
        return;
      }

      const hash = await signer.signAndSubmit(tx_json);
      hud(`Submitted claim: ${hash || '(no hash)'} — waiting for validation…`);
      try { await g.SrvAPI?.profile?.(); } catch {}
      hud('✅ Claim flow complete.');
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('unauthorized') || msg.includes('401')) {
        hud('JWT expired. Please sign in again.');
        const loginBtn = document.getElementById('btn-login') || document.getElementById('btn-sign');
        if (loginBtn) try { loginBtn.click(); } catch {}
        return;
      }
      hud(`❌ Claim failed: ${msg}`);
    }
  }

  function wire() {
    const b1 = $('btn-claim');
    const b2 = $('btn-claim-wc');
    const b3 = $('btn-claim-gem'); // NEW
    if (b1 && !b1.__bound){ b1.__bound = true; b1.addEventListener('click', ()=>claim('crossmark')); }
    if (b2 && !b2.__bound){ b2.__bound = true; b2.addEventListener('click', ()=>claim('walletconnect')); }
    if (b3 && !b3.__bound){ b3.__bound = true; b3.addEventListener('click', ()=>claim('gemwallet')); } // NEW
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once:true });
  } else {
    wire();
  }
})(window);
