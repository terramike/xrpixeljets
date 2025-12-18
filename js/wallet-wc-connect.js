// /jets/js/wallet-wc-connect.js — 2025-11-13wc-connect3 (connect + login only, mobile-hardened, Bifrost-friendly)
const WC = {};
export default WC;

(function attach(g){
  'use strict';

  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const LOG_ID='log', INPUT_ID='xrpl-address', STATUS_ID='session-status';
  const BTN_CONNECT='btn-wc-connect';
  const CHAIN_ID='xrpl:0'; // XRPL mainnet

  const S = {
    projectId: null, client: null, modal: null, session: null,
    requiredNamespaces: { xrpl:{ chains:[CHAIN_ID], methods:[
      // keep only what we need for login (tx-proof)
      'xrpl_signTransaction','xrpl_signTransactionFor','xrpl_sign','xrpl_signAndSubmit'
    ], events:[] } }
  };

  // ---------- helpers ----------
  const toHex = (s)=>Array.from(new TextEncoder().encode(s)).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  function hud(msg){
    try{
      const el=document.getElementById(LOG_ID); if(!el) return;
      const d=document.createElement('div'); d.className='log-line'; d.textContent=String(msg);
      el.appendChild(d); el.scrollTop=el.scrollHeight;
    }catch{}
    console.log('[WC]', msg);
  }

  function setCurrentWallet(addr){
    try{ localStorage.setItem('WALLET', addr||''); }catch{}
    g.CURRENT_WALLET = addr||'';
    const inp=document.getElementById(INPUT_ID); if (inp) inp.value=g.CURRENT_WALLET;
    const st=document.getElementById(STATUS_ID); if (st) st.textContent = addr?`Connected: ${addr}`:'Not connected';
    try { window.JetsApi?.setWallet?.(addr); } catch {}
    try { g.dispatchEvent(new CustomEvent('jets:auth', { detail:{ address: addr } })); } catch {}
  }

  function parseFirstAccount(session){
    const acc=session?.namespaces?.xrpl?.accounts?.[0]||''; // "xrpl:0:r..."
    return acc.split(':').pop()||'';
  }

  // ---------- dependency loader (ESM CDNs, with fallbacks) ----------
  async function ensureDeps(){
    let SignClient = g.WalletConnect?.SignClient;
    let ModalCtor  = g.WalletConnectModal;

    const tryImport = async (urls) => {
      for (const url of urls){
        try { const mod = await import(url); if (mod) return mod; } catch(_){ /* try next */ }
      }
      return null;
    };

    if (!SignClient){
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://unpkg.com/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://esm.sh/@walletconnect/sign-client@2.21.8'
      ]);
      if (mod) { g.WalletConnect = g.WalletConnect || {}; g.WalletConnect.SignClient = mod.SignClient || mod.default; }
      SignClient = g.WalletConnect.SignClient;
    }
    if (!ModalCtor){
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/index.js',
        'https://esm.sh/@walletconnect/modal@2.7.0'
      ]);
      if (mod) g.WalletConnectModal = mod.default || mod.WalletConnectModal || mod;
      ModalCtor = g.WalletConnectModal;
    }

    if (!SignClient || !ModalCtor) throw new Error('wc_deps_missing');
  }

  // ---------- init / connect ----------
  async function init({ projectId }){
    if (!projectId) throw new Error('wc_projectId_missing');
    S.projectId = projectId;
    await ensureDeps();
    S.client = await g.WalletConnect.SignClient.init({ projectId });
    S.modal = new g.WalletConnectModal({ projectId, themeMode:'dark' });
    S.__Sclient = S.client; // internal bridge
    hud('WC inited.');
  }

  async function connect(){
    if (!S.client || !S.modal) throw new Error('wc_not_inited');

    const { uri, approval } = await S.client.connect({ requiredNamespaces: S.requiredNamespaces });
    if (uri) {
      if (isMobile()) window.open(uri, '_blank');
      else await S.modal.openModal({ uri });
    }

    S.session = await approval();
    const address = parseFirstAccount(S.session);
    setCurrentWallet(address);
    hud(`Connected: ${address}`);
    g.dispatchEvent(new CustomEvent('jets:auth', { detail:{ address } }));

    // NEW: Auto-sign login tx after connect to get JWT
    try {
      const API_BASE = g.JETS_API_BASE || 'https://xrpixeljets.onrender.com';
      const start = await g.JetsApi.sessionStart(address);
      const ts = Date.now();
      const scope = 'play,upgrade,claim';
      const res = await wcSignLoginTx({ address, nonce: start.nonce, scope, ts });
      const v = await g.JetsApi.sessionVerify({
        address,
        network: 'xrpl:mainnet',
        signer: 'walletconnect',
        tx_blob: res.tx_blob
      });
      await g.JetsApi.setAuthToken(v.token);
      hud('Signed in with WalletConnect.');
      const statusEl = document.getElementById('session-status');
      if (statusEl) statusEl.textContent = `Connected & Signed In: ${address}`;
    } catch (e) {
      hud(`Sign-in failed: ${e?.message || e}`);
    }
  }

  async function disconnect(){
    if (!S.session) return;
    await S.client.disconnect({ topic: S.session.topic, reason: { code:1, message:'User disconnected' } });
    S.session = null;
    setCurrentWallet('');
    hud('Disconnected.');
    try { localStorage.removeItem('JWT'); g.JetsApi.setAuthToken(null); } catch {}
  }

  function wcGetAddress(){ return parseFirstAccount(S.session); }
  function wcHasSession(){ return !!S.session; }

  function extractTxBlob(reply){
    const r = reply?.result || reply;
    return r?.tx_blob || r?.txBlob || r?.signedTransaction || r?.blob || r?.signedTx || '';
  }

  async function wcSignLoginTx({ address, nonce, scope, ts }){
    if (!S.session) throw new Error('No WC session');

    const memoType = toHex('XRPixelJets');
    const memoData = toHex(`XRPixelJets|${nonce}|${scope}|${ts}`);

    const tx_json = {
      TransactionType:'AccountSet',
      Account: address,
      Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }],
    };

    const attempts = [
      { method:'xrpl_signTransaction',    params:{ tx_json, autofill:true, submit:false } },
      { method:'xrpl_signTransactionFor', params:{ tx_signer:address, tx_json, autofill:true, submit:false } },
      { method:'xrpl_sign',               params:{ tx_json, autofill:true, submit:false } },
      { method:'xrpl_signAndSubmit',      params:{ tx_json, autofill:true, submit:true } }, // last resort
    ];

    let lastErr, reply;
    for (const a of attempts){
      try{
        reply = await S.client.request({
          topic:S.session.topic, chainId:CHAIN_ID,
          request: { method:a.method, params:a.params }
        });
        const blob = extractTxBlob(reply);
        if (blob){ hud(`Signed via ${a.method}.`); return { tx_blob: blob, tx_json }; }
      }catch(e){ lastErr = e; }
    }
    console.error('[WC] sign login tx failed:', lastErr, 'reply=', reply);
    throw new Error('wallet_sign_failed');
  }

  // ---------- minimal UI wiring ----------
  function once(el, evt, fn){
    if (!el || el.__bound) return;
    el.__bound = true;
    el.addEventListener(evt, fn);
  }
  function wireUI(){
    const btnC = document.getElementById(BTN_CONNECT);
    once(btnC, 'click', async (e) => {
      try{
        // keep as light as possible inside the click to preserve gesture
        if (!S.client) await init({ projectId: g.WC_PROJECT_ID });
        if (S.session){ hud('Already connected.'); return; }
        await connect();
      }catch(err){ hud(`Connect failed: ${err?.message||err}`); }
    });
  }

  // Keep binding stable even if DOM changes
  if (!S.__mo) {
    S.__mo = new MutationObserver(wireUI);
    S.__mo.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireUI, { once:true });
    else wireUI();
  }

  // ---------- public API ----------
  XRPLWallet.wcInit = init;
  XRPLWallet.wcConnect = connect;
  XRPLWallet.wcDisconnect = disconnect;
  XRPLWallet.wcGetAddress = wcGetAddress;
  XRPLWallet.wcHasSession = wcHasSession;
  XRPLWallet.wcSignLoginTx = wcSignLoginTx; // login only (keep)

  // Pre-warm on DOM ready so the click handler only does connect+openModal
  document.addEventListener('DOMContentLoaded', () => {
    try {
      if (g.WC_PROJECT_ID && !S.client) init({ projectId: g.WC_PROJECT_ID }).catch(e=>console.warn('[WC] init error:', e));
    } catch (e) {}
  });

})(window);