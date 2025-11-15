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
        'https://unpkg.com/@walletconnect/modal@2.7.0/dist/index.js',
        'https://esm.sh/@walletconnect/modal@2.7.0'
      ]);
      if (mod) g.WalletConnectModal = mod.WalletConnectModal || mod.default;
      ModalCtor = g.WalletConnectModal;
    }
    if (!ModalCtor) throw new Error('WalletConnectModal missing');
    if (!SignClient)  throw new Error('SignClient missing');

    // modal css (idempotent)
    if (![...document.styleSheets].some(ss => (ss.href||'').includes('/modal@2.7.0/'))){
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/styles.css';
      document.head.appendChild(link);
    }
  }

  // ---------- init / connect / disconnect ----------
  async function init({ projectId, relayUrl } = {}){
    await ensureDeps();
    S.projectId = (projectId || g.WC_PROJECT_ID || '').trim();
    if (!S.projectId) throw new Error('WalletConnect projectId required');

    const SignClient = g.WalletConnect.SignClient;
    S.client = await SignClient.init({
      projectId: S.projectId,
      relayUrl: relayUrl || 'wss://relay.walletconnect.com',
    });

    const ModalCtor = g.WalletConnectModal;
    S.modal = new ModalCtor({ projectId: S.projectId, enableExplorer: true });

    // expose internals for advanced handlers (optional)
    XRPLWallet.__Sclient = S.client;
    XRPLWallet.__Smodal  = S.modal;

    const sessions = S.client.session.getAll?.() || [];
    if (sessions.length){
      S.session = sessions[0];
      const addr = parseFirstAccount(S.session);
      if (addr) setCurrentWallet(addr);
      hud('Ready (restored WC session).');
    } else {
      hud('Ready.');
    }

    wireUI();
    return S.client;
  }

  async function openModalWithFallback(uri){
    // Always try to open the modal (even with no uri — shows paired wallets)
    if (uri) {
      await S.modal.openModal({ uri, standaloneChains:[CHAIN_ID] });
      // Mobile fallback: if modal didn't render, deep-link to resolver in the same click
      setTimeout(() => {
        const opened = document.querySelector('.walletconnect-modal__container');
        if (!opened && isMobile()) {
          const link = `https://r.walletconnect.com/?uri=${encodeURIComponent(uri)}`;
          location.href = link;
        }
      }, 600);
    } else {
      await S.modal.openModal({ standaloneChains:[CHAIN_ID] });
    }
  }

  async function connect(){
    if (!S.client || !S.modal) throw new Error('WalletConnect not initialized');

    // request pairing
    const { uri, approval } = await S.client.connect({ requiredNamespaces: S.requiredNamespaces });

    // show modal regardless of uri (existing pairing often yields undefined)
    try { await openModalWithFallback(uri); }
    catch (e) {
      // As a last resort, deep-link if we have a URI
      if (uri) location.href = `https://r.walletconnect.com/?uri=${encodeURIComponent(uri)}`;
    }

    // wait for approval
    const session = await approval();
    S.session = session;
    try { S.modal.closeModal(); } catch {}

    const addr = parseFirstAccount(S.session);
    if (!addr) throw new Error('No XRPL account in session');
    setCurrentWallet(addr);
    try{ localStorage.removeItem('JWT'); }catch{} // auth is separate per-wallet
    hud(`Connected ${addr}`);
    return addr;
  }

  async function disconnect(){
    if (!S.session) return;
    try{
      await S.client.disconnect({ topic:S.session.topic, reason:{ code:6000, message:'User disconnect' } });
    } finally {
      S.session=null; setCurrentWallet(''); try{localStorage.removeItem('JWT');}catch{} hud('Disconnected.');
    }
  }

  function wcGetAddress(){ return parseFirstAccount(S.session); }
  function wcHasSession(){ return !!S.session; }

  // ---------- login (tx-proof) only ----------
  function isHexBlob(x){ return typeof x==='string' && /^[A-F0-9]+$/i.test(x) && x.length>200; }
  function deepFindHex(obj){
    if (!obj) return '';
    if (isHexBlob(obj)) return obj;
    if (typeof obj==='object'){
      for (const k of Object.keys(obj||{})){
        const hit = deepFindHex(obj[k]); if (hit) return hit;
      }
    }
    return '';
  }
  function extractTxBlob(res, fallbackTx){
    const direct = res?.tx_blob || res?.signedTxn || res?.signedTransaction || res?.tx || res?.blob;
    if (isHexBlob(direct)) return String(direct);
    const nested = res?.result || res?.response || res?.data || res?.payload;
    const nestedBlob = extractTxBlob(nested||{});
    if (nestedBlob) return nestedBlob;
    const scanned = deepFindHex(res); if (scanned) return scanned;
    return isHexBlob(fallbackTx) ? fallbackTx : '';
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
        reply = await S.client.request({ topic:S.session.topic, chainId:CHAIN_ID, request:{ method:a.method, params:a.params } });
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
