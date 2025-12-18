// /jets/js/wallet-wc.js — 2025-10-31 wc9 (robust tx-proof signer + consistent wiring)
const WC = {};
export default WC;

(function attach(g){
  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const LOG_ID='log', INPUT_ID='xrpl-address', STATUS_ID='session-status';
  const BTN_CONNECT='btn-wc-connect', BTN_TRUST='btn-wc-trustline', DLG_ID='wc-trustline-modal';
  const CHAIN_ID='xrpl:0'; // mainnet

  const FALLBACKS = {
    ISSUER_ADDR: 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e',
    CURRENCY_HEX: '4A45545300000000000000000000000000000000',
    LIMIT: '10000000',
  };

  const S = {
    projectId: null, client: null, modal: null, session: null,
    requiredNamespaces: { xrpl:{ chains:[CHAIN_ID], methods:[
      'xrpl_signTransaction','xrpl_signTransactionFor','xrpl_sign','xrpl_signAndSubmit'
    ], events:[] } }
  };

  const toHex = (s)=>Array.from(new TextEncoder().encode(s)).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();

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
  }
  function parseFirstAccount(session){
    const acc=session?.namespaces?.xrpl?.accounts?.[0]||''; // "xrpl:0:r..."
    return acc.split(':').pop()||'';
  }

  async function ensureDeps(){
    let SignClient = g.WalletConnect?.SignClient;
    let ModalCtor  = g.WalletConnectModal;

    const tryImport = async (urls) => {
      for (const url of urls){
        try { const mod = await import(url); if (mod) return mod; } catch(_){}
      }
      return null;
    };

    if (!SignClient){
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://esm.sh/@walletconnect/sign-client@2.21.8',
        'https://cdn.skypack.dev/@walletconnect/sign-client@2.21.8'
      ]);
      if (mod) { g.WalletConnect = g.WalletConnect || {}; g.WalletConnect.SignClient = mod.SignClient || mod.default; }
      SignClient = g.WalletConnect.SignClient;
    }
    if (!ModalCtor){
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/index.js',
        'https://esm.sh/@walletconnect/modal@2.7.0'
      ]);
      if (mod) g.WalletConnectModal = mod.WalletConnectModal || mod.default;
      ModalCtor = g.WalletConnectModal;
    }
    if (!ModalCtor) throw new Error('WalletConnectModal missing');
    if (!SignClient)  throw new Error('SignClient missing');
  }

  async function init({ projectId, relayUrl } = {}){
    await ensureDeps();
    S.projectId = projectId || g.WC_PROJECT_ID;
    if (!S.projectId) throw new Error('WalletConnect projectId required');

    const SignClient = g.WalletConnect.SignClient;
    S.client = await SignClient.init({
      projectId: S.projectId,
      relayUrl: relayUrl || 'wss://relay.walletconnect.com',
    });

    const ModalCtor = g.WalletConnectModal;
    S.modal = new ModalCtor({ projectId: S.projectId, enableExplorer: true });

    const sessions = S.client.session.getAll();
    if (sessions?.length){
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

  async function connect(){
    if (!S.client || !S.modal) throw new Error('WalletConnect not initialized');
    const { uri, approval } = await S.client.connect({ requiredNamespaces: S.requiredNamespaces });
    if (uri) await S.modal.openModal({ uri });
    const session = await approval();
    S.session = session;
    S.modal.closeModal();
    const addr = parseFirstAccount(S.session);
    if (!addr) throw new Error('No XRPL account in session');
    setCurrentWallet(addr);
    try{ localStorage.removeItem('JWT'); }catch{}
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

  // ---------- blob extractors ----------
  function isHexBlob(x){ return typeof x==='string' && /^[A-F0-9]+$/i.test(x) && x.length>200; }
  function deepFindHex(obj){
    if (!obj) return '';
    if (isHexBlob(obj)) return obj;
    if (typeof obj==='object'){
      for (const k of Object.keys(obj||{})){
        const v = obj[k]; const hit = deepFindHex(v); if (hit) return hit;
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

  // ---------- tx-proof login ----------
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
      { method:'xrpl_signAndSubmit',      params:{ tx_json, autofill:true, submit:true } }, // final resort
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

  async function wcSetTrustline({ limit } = {}){
    if (!S.session) throw new Error('No WC session');
    const address = wcGetAddress(); if (!address) throw new Error('No XRPL address from WC session');

    const issuer = g.ISSUER_ADDR || g.ISSUER_ADDRESS || FALLBACKS.ISSUER_ADDR;
    const currencyHex = g.CURRENCY_HEX || FALLBACKS.CURRENCY_HEX;
    const trustLimit = String(limit || FALLBACKS.LIMIT);

    const tx_json = {
      TransactionType:'TrustSet',
      Account: address,
      LimitAmount:{ currency: currencyHex, issuer, value: trustLimit },
    };

    hud('Requesting TrustSet…');
    const reqs = [
      { method:'xrpl_signTransaction',    params:{ tx_json, autofill:true, submit:true } },
      { method:'xrpl_signTransactionFor', params:{ tx_signer:address, tx_json, autofill:true, submit:true } },
      { method:'xrpl_signAndSubmit',      params:{ tx_json, autofill:true, submit:true } },
    ];
    let result, lastErr;
    for (const r of reqs){
      try{ result = await S.client.request({ topic:S.session.topic, chainId:CHAIN_ID, request:{ method:r.method, params:r.params } }); break; }
      catch(e){ lastErr=e; }
    }
    if (!result) { console.error('[WC] trustline error:', lastErr); throw lastErr || new Error('Wallet did not accept TrustSet'); }
    hud(`Trustline requested.`);
    return result;
  }

  function wireUI(){
    const btnC = document.getElementById(BTN_CONNECT);
    if (btnC && !btnC.__bound){
      btnC.__bound = true;
      btnC.addEventListener('click', async () => {
        try{
          if (!S.client) await init({ projectId: g.WC_PROJECT_ID });
          if (S.session){ hud('Already connected.'); return; }
          await connect();
        }catch(e){ hud(`Connect failed: ${e?.message||e}`); }
      }, { passive:true });
    }

    const btnT = document.getElementById(BTN_TRUST);
    const dlg  = document.getElementById(DLG_ID);
    if (btnT && !btnT.__bound){
      btnT.__bound = true;
      btnT.addEventListener('click', () => {
        if (!S.client || !S.session){ hud('Connect a wallet first.'); return; }
        dlg?.showModal?.();
      }, { passive:true });
    }

    if (dlg && !dlg.__wired){
      dlg.__wired = true;
      const form = dlg.querySelector('form');
      const cancel = dlg.querySelector('[data-cancel]');
      form?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const limit = form.querySelector('input[name=limit]')?.value || FALLBACKS.LIMIT;
        try{ await wcSetTrustline({ limit }); dlg.close(); }
        catch(e){ hud(`Trustline error: ${e?.message||e}`); }
      });
      cancel?.addEventListener('click', () => dlg.close());
    }
  }

  // Public API
  XRPLWallet.wcInit = init;
  XRPLWallet.wcConnect = connect;
  XRPLWallet.wcDisconnect = disconnect;
  XRPLWallet.wcGetAddress = wcGetAddress;
  XRPLWallet.wcHasSession = wcHasSession;
  XRPLWallet.wcSignLoginTx = wcSignLoginTx;
  XRPLWallet.wcSetTrustline = wcSetTrustline;
})(window);