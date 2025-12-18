// /jets/js/auth-claim.js — simple, provider-explicit login (Crossmark / Gem / WC)
// v=2025-12-18-simplogin5
import { sessionStart, sessionVerify, setAuthToken } from '/jets/js/serverApi.js';

(function(){
  const g = window;
  const API_BASE = g.JETS_API_BASE || 'https://xrpixeljets.onrender.com';
  const CHAIN = 'xrpl:mainnet';

  // ---------- small utils ----------
  const $ = (id)=>document.getElementById(id);
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const toHexU = (s)=>Array.from(new TextEncoder().encode(s)).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const hud = (m)=> (g.XRPLWallet?.hud || console.log)(`[auth] ${m}`);
  const status = (msg, html=false)=>{
    const el = $('claim-status') || $('session-status') || $('status');
    if (!el) return;
    if (html) el.innerHTML = msg; else el.textContent = msg;
  };
  const setWalletLocal = (addr)=>{
    try { localStorage.setItem('WALLET', addr||''); } catch {}
    g.CURRENT_WALLET = addr||'';
    const s = $('session-status'); if (s) s.textContent = addr ? `Connected: ${addr}` : 'Not connected';
    try { g.dispatchEvent(new CustomEvent('jets:auth', { detail:{ address: addr } })); } catch {}
  };
  const extractTxBlob = (r)=>{
    const x = r?.result || r || {};
    return x.tx_blob || x.txBlob || x.signedTransaction || x.blob || x.signedTx || '';
  };

  async function waitFor(fn, ms=8000, step=100){
    const t0 = Date.now();
    while (Date.now()-t0 < ms){
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ---------- login core (tx-proof, non-submitting if supported) ----------
  function buildLoginTx({ address, nonce, scope, ts }){
    const memoType = toHexU('XRPixelJets');
    const memoData = toHexU(`XRPixelJets|${nonce}|${scope}|${ts}`);
    return {
      TransactionType: 'AccountSet',
      Account: address,
      // Do NOT change flags; we only need a signable tx with a stable memo
      Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }],
    };
  }

  async function verifyWithTxBlob({ address, signer, tx_blob }){
    const v = await sessionVerify({ address, network: CHAIN, signer, tx_blob });
    const token = v?.token || v?.jwt;
    if (!token) throw new Error('no_jwt');
    setAuthToken(token);
    status('Signed in.');
    hud(`Signed in with ${signer} (JWT stored).`);
    setWalletLocal(address);
    return true;
  }

  // ---------- Crossmark (explicit) ----------
  async function signInCrossmark(){
    status('Opening Crossmark…');
    // give the extension time to inject AFTER the click gesture
    const xmk = await waitFor(()=> g.crossmark && (g.crossmark.request || g.crossmark.xrpl), 12000);
    if (!xmk) { status('Crossmark not available.'); throw new Error('crossmark_unavailable'); }

    // Address: prefer field, else Crossmark helper, else WALLET
    let address = ($('xrpl-address')?.value || '').trim();
    if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)){
      // try provider helpers without "detection gating"—just call them
      try {
        if (g.crossmark?.request) {
          const ra = await g.crossmark.request({ method: 'xrpl_getAddress', params: {} }).catch(()=>null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        } else if (g.crossmark?.getAddress) {
          const ra = await g.crossmark.getAddress().catch(()=>null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        }
      } catch {}
      if (!address) address = (localStorage.getItem('WALLET')||'').trim();
    }
    if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) throw new Error('no_address');

    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts    = Date.now();
    const tx_json = buildLoginTx({ address, nonce, scope, ts });

    // try a few Crossmark request shapes, do NOT pre-check—just call to pop the UI
    const attempts = [];
    if (g.crossmark?.request){
      attempts.push(()=> g.crossmark.request({ method:'xrpl_signTransaction',    params:{ tx_json, autofill:true, submit:false } }));
      attempts.push(()=> g.crossmark.request({ method:'xrpl_signTransactionFor', params:{ tx_signer:address, tx_json, autofill:true, submit:false } }));
      attempts.push(()=> g.crossmark.request({ method:'xrpl_sign',               params:{ tx_json, autofill:true, submit:false } }));
      attempts.push(()=> g.crossmark.request({ method:'xrpl_signAndSubmit',      params:{ tx_json, autofill:true, submit:true } }));
    }
    if (g.crossmark?.xrpl?.signTransaction){
      attempts.push(()=> g.crossmark.xrpl.signTransaction({ tx_json, autofill:true, submit:false }));
    }

    let blob = '';
    let lastErr = null;
    for (const call of attempts){
      try {
        const reply = await call();
        blob = extractTxBlob(reply);
        if (blob) break;
      } catch(e){ lastErr = e; }
    }
    if (!blob){ console.warn('[auth] crossmark sign fail:', lastErr); throw new Error('crossmark_sign_failed'); }

    return verifyWithTxBlob({ address, signer:'crossmark', tx_blob: blob });
  }

  // ---------- GemWallet (explicit) ----------
  async function signInGem(){
    status('Opening GemWallet…');
    // give the extension time to inject AFTER the click gesture
    const gem = await waitFor(()=> g.gemWallet, 12000);
    if (!gem) { status('GemWallet not available.'); throw new Error('gemwallet_unavailable'); }

    // Address: prefer field, else gem helper, else WALLET
    let address = ($('xrpl-address')?.value || '').trim();
    if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)){
      try {
        if (g.gemWallet?.getAddress){
          const ra = await g.gemWallet.getAddress().catch(()=>null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        } else if (g.gemWallet?.xrpl?.getAddress){
          const ra = await g.gemWallet.xrpl.getAddress().catch(()=>null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        }
      } catch {}
      if (!address) address = (localStorage.getItem('WALLET')||'').trim();
    }
    if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) throw new Error('no_address');

    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts    = Date.now();
    const tx_json = buildLoginTx({ address, nonce, scope, ts });

    // call Gem methods directly—no preflight checks; let extension surface the UI
    const tries = [
      async ()=> g.gemWallet?.xrpl?.signTransaction?.(tx_json, { autofill:true, submit:false }),
      async ()=> g.gemWallet?.signTransaction?.(tx_json, { autofill:true, submit:false }),
      async ()=> g.gemWallet?.xrpl?.signAndSubmitTransaction?.(tx_json, { autofill:true, submit:true }),
      async ()=> g.gemWallet?.signAndSubmitTransaction?.(tx_json, { autofill:true, submit:true }),
      async ()=> g.gemWallet?.request?.({ method:'xrpl_signTransaction', params:{ tx_json, autofill:true, submit:false } }),
      async ()=> g.gemWallet?.request?.({ method:'xrpl_signAndSubmit',   params:{ tx_json, autofill:true, submit:true } }),
    ];

    let blob = '';
    let lastErr = null;
    for (const t of tries){
      try {
        const reply = await t();
        blob = extractTxBlob(reply);
        if (blob) break;
      } catch(e){ lastErr = e; }
    }
    if (!blob){ console.warn('[auth] gem sign fail:', lastErr); throw new Error('gem_sign_failed'); }

    return verifyWithTxBlob({ address, signer:'gem', tx_blob: blob });
  }

  // ---------- WalletConnect (optional, unchanged path) ----------
  async function signInWalletConnect(){
    if (!g.XRPLWallet?.wcHasSession?.()) {
      // simulate the visible WC connect button click to open modal/QR
      $('btn-wc-connect')?.click?.();
      // wait until connected
      const ok = await waitFor(()=> g.XRPLWallet?.wcHasSession?.(), 20000, 200);
      if (!ok) throw new Error('wc_no_session');
    }
    const address = g.XRPLWallet.wcGetAddress?.();
    if (!address) throw new Error('wc_no_address');

    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts    = Date.now();
    const { tx_blob } = await g.XRPLWallet.wcSignLoginTx?.({ address, nonce, scope, ts }) || {};
    if (!tx_blob) throw new Error('wc_sign_failed');

    return verifyWithTxBlob({ address, signer:'walletconnect', tx_blob });
  }

  // ---------- public API ----------
  async function signIn(which){
    try{
      if (which === 'crossmark') return await signInCrossmark();
      if (which === 'gem')       return await signInGem();
      if (which === 'walletconnect' || which === 'wc') return await signInWalletConnect();
      // default: show modal elsewhere
      throw new Error('unknown_provider');
    } catch(e){
      hud(`Sign-in failed: ${e?.message || e}`);
      status('Sign-in failed');
      return false;
    }
  }

  // Expose
  g.JetsAuth = { signIn };

  // Optional: wire the legacy "Sign In" button to open your modal or call Crossmark directly
  document.addEventListener('DOMContentLoaded', ()=>{
    const btn = $('btn-sign'); // legacy button
    if (btn && !btn.__b){ btn.__b = 1; btn.addEventListener('click', ()=> g.JetsAuth.signIn('crossmark')); }
  });
})();
