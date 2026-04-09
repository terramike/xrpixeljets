// /jets/js/wallet-wc.js — WalletConnect (Reown) XRPL provider for XRPixel Jets
// Requires: @walletconnect/modal and @walletconnect/sign-client loaded by the page (see snippet).
// Mainnet only here (xrpl:0). Add :1 (testnet) / :2 (devnet) if needed.
const WC = {};
export default WC;

(function attach(g){
  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const LOG_ID = 'log', INPUT_ID='xrpl-address', STATUS_ID='session-status';
  const BTN_CONNECT='btn-wc-connect', BTN_TRUST='btn-wc-trustline', DLG_ID='wc-trustline-modal';
  const CHAIN_ID = 'xrpl:0'; // mainnet

  const FALLBACKS = {
    ISSUER_ADDR: 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e',
    CURRENCY_HEX: '4A45545300000000000000000000000000000000',
    LIMIT: '10000000',
  };

  const S = {
    projectId: null, client: null, modal: null, session: null,
    requiredNamespaces: { xrpl: { chains:[CHAIN_ID], methods:['xrpl_signTransaction','xrpl_signTransactionFor'], events:[] } }
  };

  function hud(msg){
    const el = document.getElementById(LOG_ID); if (!el) return;
    const d = document.createElement('div'); d.className='log-line'; d.textContent=String(msg);
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  }
  function setCurrentWallet(addr){
    try{ localStorage.setItem('WALLET', addr||''); }catch{}
    g.CURRENT_WALLET = addr||'';
    const inp = document.getElementById(INPUT_ID); if (inp) inp.value = g.CURRENT_WALLET;
    const st = document.getElementById(STATUS_ID); if (st) st.textContent = addr ? `Connected: ${addr}` : 'Not connected';
  }
  function parseFirstAccount(session){
    const acc = session?.namespaces?.xrpl?.accounts?.[0] || ''; // "xrpl:0:r..."
    return acc.split(':').pop() || '';
  }
  async function ensureDeps(){
    if (!g.WalletConnectModal) throw new Error('WalletConnectModal missing');
    if (!g.WalletConnect || !g.WalletConnect.SignClient) throw new Error('SignClient missing');
  }

  async function init({ projectId, relayUrl } = {}){
    await ensureDeps();
    S.projectId = projectId || g.WC_PROJECT_ID;
    if (!S.projectId) throw new Error('WalletConnect projectId required');

    S.client = await g.WalletConnect.SignClient.init({
      projectId: S.projectId,
      relayUrl: relayUrl || 'wss://relay.walletconnect.com',
    });
    S.modal = new g.WalletConnectModal({ projectId: S.projectId, enableExplorer: true });

    const sessions = S.client.session.getAll();
    if (sessions?.length){
      S.session = sessions[0];
      const addr = parseFirstAccount(S.session);
      if (addr) setCurrentWallet(addr);
    }
    wireUI();
    hud('[WC] Ready.');
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
    hud(`[WC] Connected ${addr}`);
    return addr;
  }

  async function disconnect(){
    if (!S.session) return;
    try{
      await S.client.disconnect({ topic: S.session.topic, reason: { code: 6000, message: 'User disconnect' } });
    }finally{
      S.session=null; setCurrentWallet(''); hud('[WC] Disconnected.');
    }
  }

  function wcGetAddress(){ return parseFirstAccount(S.session); }

  async function wcSetTrustline({ limit }={}){
    if (!S.session) throw new Error('No WC session');
    const address = wcGetAddress(); if (!address) throw new Error('No XRPL address from WC session');

    const issuer = g.ISSUER_ADDR || g.ISSUER_ADDRESS || FALLBACKS.ISSUER_ADDR;
    const currencyHex = g.CURRENCY_HEX || FALLBACKS.CURRENCY_HEX;
    const trustLimit = String(limit || FALLBACKS.LIMIT);

    const tx_json = {
      TransactionType: 'TrustSet',
      Account: address,
      LimitAmount: { currency: currencyHex, issuer, value: trustLimit }
    };

    hud('[WC] Requesting TrustSet…');
    // Try common XRPL WC methods in order
    const attempts = [
      { method:'xrpl_signTransaction', params:{ tx_json, autofill:true, submit:true } },
      { method:'xrpl_signAndSubmit',  params:{ tx_json, autofill:true } },
      { method:'xrpl_sign',           params:{ tx_json, autofill:true } },
    ];
    let result, lastErr;
    for (const req of attempts){
      try{
        result = await S.client.request({ topic: S.session.topic, chainId: CHAIN_ID, request: { method: req.method, params: req.params } });
        break;
      }catch(e){ lastErr=e; }
    }
    if (!result) throw lastErr || new Error('Wallet did not accept TrustSet');

    const spk = result?.tx_json?.SigningPubKey || '';
    if (!(spk.startsWith('02') || spk.startsWith('03'))){
      hud('[WC] Warning: SigningPubKey not secp256k1 (fine for tx; keep JWT login on Crossmark).');
    }
    hud(`[WC] Trustline tx: ${result?.tx_json?.hash || 'submitted'}`);
    return result;
  }

  function wireUI(){
    const btnC = document.getElementById(BTN_CONNECT);
    if (btnC && !btnC.__bound){
      btnC.__bound = true;
      btnC.addEventListener('click', async () => {
        try{
          if (!S.client) await init({ projectId: g.WC_PROJECT_ID });
          if (S.session){ hud('[WC] Already connected.'); return; }
          await connect();
        }catch(e){ hud(`[WC] ${e?.message||e}`); }
      }, { passive:true });
    }
    const btnT = document.getElementById(BTN_TRUST);
    const dlg  = document.getElementById(DLG_ID);
    if (btnT && !btnT.__bound){
      btnT.__bound = true;
      btnT.addEventListener('click', () => {
        if (!S.client || !S.session){ hud('[WC] Connect a wallet first.'); return; }
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
        catch(e){ hud(`[WC] ${e?.message||e}`); }
      });
      cancel?.addEventListener('click', () => dlg.close());
    }
  }

  // Public API (matches your existing signer namespace style)
  XRPLWallet.wcInit = init;
  XRPLWallet.wcConnect = connect;
  XRPLWallet.wcDisconnect = disconnect;
  XRPLWallet.wcGetAddress = wcGetAddress;
  XRPLWallet.wcSetTrustline = wcSetTrustline;

  // JWT login stays on Crossmark/GemWallet; WC is for on-ledger tx (TrustSet etc).
  XRPLWallet.signMessageClassic = XRPLWallet.signMessageClassic || (async () => {
    throw new Error('Use Crossmark for JWT login; WalletConnect handles on-ledger tx.');
  });
})(window);
