// /jets/js/wallet-wc-fixed.js — WalletConnect v2 with proper initialization
// v=2025-12-18-fixed1
(function attach(g) {
  'use strict';

  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const CHAIN_ID = 'xrpl:0'; // XRPL mainnet
  const WSS = g.XRPL_WSS || 'wss://xrplcluster.com';

  const S = {
    projectId: null,
    client: null,
    modal: null,
    session: null,
    requiredNamespaces: {
      xrpl: {
        chains: [CHAIN_ID],
        methods: [
          'xrpl_signTransaction',
          'xrpl_signTransactionFor',
          'xrpl_sign',
          'xrpl_signAndSubmit'
        ],
        events: []
      }
    }
  };

  // ========== UTILITIES ==========
  const toHex = (s) => Array.from(new TextEncoder().encode(s))
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  function hud(msg) {
    console.log('[WC]', msg);
    const el = document.getElementById('log');
    if (!el) return;
    const d = document.createElement('div');
    d.className = 'log-line';
    d.textContent = String(msg);
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
  }

  function setCurrentWallet(addr) {
    try {
      localStorage.setItem('WALLET', addr || '');
    } catch {}
    g.CURRENT_WALLET = addr || '';
    const inp = document.getElementById('xrpl-address');
    if (inp) inp.value = g.CURRENT_WALLET;
    const st = document.getElementById('session-status');
    if (st) st.textContent = addr ? `Connected: ${addr}` : 'Not connected';
    try {
      g.JetsApi?.setWallet?.(addr);
    } catch {}
    try {
      g.dispatchEvent(new CustomEvent('jets:auth', { detail: { address: addr } }));
    } catch {}
  }

  function parseFirstAccount(session) {
    const acc = session?.namespaces?.xrpl?.accounts?.[0] || '';
    return acc.split(':').pop() || '';
  }

  // ========== DEPENDENCY LOADER ==========
  async function ensureDeps() {
    let SignClient = g.WalletConnect?.SignClient;
    let ModalCtor = g.WalletConnectModal;

    const tryImport = async (urls) => {
      for (const url of urls) {
        try {
          const mod = await import(url);
          if (mod) return mod;
        } catch (_) {}
      }
      return null;
    };

    if (!SignClient) {
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://unpkg.com/@walletconnect/sign-client@2.21.8/dist/index.es.js'
      ]);
      if (mod) {
        g.WalletConnect = g.WalletConnect || {};
        g.WalletConnect.SignClient = mod.SignClient || mod.default;
      }
      SignClient = g.WalletConnect.SignClient;
    }

    if (!ModalCtor) {
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/index.js',
        'https://unpkg.com/@walletconnect/modal@2.7.0/dist/index.js'
      ]);
      if (mod) g.WalletConnectModal = mod.WalletConnectModal || mod.default;
      ModalCtor = g.WalletConnectModal;
    }

    if (!ModalCtor || !SignClient) {
      throw new Error('WalletConnect dependencies missing');
    }

    // Load CSS if needed
    if (![...document.styleSheets].some(ss => (ss.href || '').includes('/modal@2.7.0/'))) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/styles.css';
      document.head.appendChild(link);
    }
  }

  // ========== INIT / CONNECT / DISCONNECT ==========
  async function init({ projectId } = {}) {
    await ensureDeps();
    S.projectId = projectId || g.WC_PROJECT_ID;
    if (!S.projectId) throw new Error('WalletConnect projectId required');

    const SignClient = g.WalletConnect.SignClient;
    S.client = await SignClient.init({
      projectId: S.projectId,
      relayUrl: 'wss://relay.walletconnect.com'
    });

    const ModalCtor = g.WalletConnectModal;
    S.modal = new ModalCtor({
      projectId: S.projectId,
      themeMode: 'dark',
      enableExplorer: true
    });

    // Restore existing session
    const sessions = S.client.session?.getAll?.() || [];
    if (sessions.length) {
      S.session = sessions[0];
      const addr = parseFirstAccount(S.session);
      if (addr) {
        setCurrentWallet(addr);
        hud('Ready (restored WC session).');
      }
    } else {
      hud('Ready.');
    }

    XRPLWallet.__Sclient = S.client;
    XRPLWallet.__Smodal = S.modal;

    wireUI();
    return S.client;
  }

  async function connect() {
    if (!S.client || !S.modal) throw new Error('WalletConnect not initialized');

    const { uri, approval } = await S.client.connect({
      requiredNamespaces: S.requiredNamespaces
    });

    if (uri) {
      if (isMobile()) {
        // On mobile, deep link
        const link = `https://r.walletconnect.com/?uri=${encodeURIComponent(uri)}`;
        window.location.href = link;
      } else {
        // On desktop, show QR modal
        await S.modal.openModal({ uri, standaloneChains: [CHAIN_ID] });
      }
    } else {
      // No URI means existing pairing
      await S.modal.openModal({ standaloneChains: [CHAIN_ID] });
    }

    const session = await approval();
    S.session = session;
    
    try {
      S.modal.closeModal();
    } catch {}

    const addr = parseFirstAccount(S.session);
    if (!addr) throw new Error('No XRPL account in session');
    
    setCurrentWallet(addr);
    try {
      localStorage.removeItem('JWT');
    } catch {}
    hud(`Connected ${addr}`);
    return addr;
  }

  async function disconnect() {
    if (!S.session) return;
    try {
      await S.client.disconnect({
        topic: S.session.topic,
        reason: { code: 6000, message: 'User disconnect' }
      });
    } finally {
      S.session = null;
      setCurrentWallet('');
      try {
        localStorage.removeItem('JWT');
      } catch {}
      hud('Disconnected.');
    }
  }

  function wcGetAddress() {
    return parseFirstAccount(S.session);
  }

  function wcHasSession() {
    return !!S.session;
  }

  // ========== TX BLOB EXTRACTION ==========
  function isHexBlob(x) {
    return typeof x === 'string' && /^[A-F0-9]+$/i.test(x) && x.length > 200;
  }

  function deepFindHex(obj) {
    if (!obj) return '';
    if (isHexBlob(obj)) return obj;
    if (typeof obj === 'object') {
      for (const k of Object.keys(obj || {})) {
        const hit = deepFindHex(obj[k]);
        if (hit) return hit;
      }
    }
    return '';
  }

  function extractTxBlob(res) {
    const direct = res?.tx_blob || res?.signedTxn || res?.signedTransaction || res?.tx || res?.blob;
    if (isHexBlob(direct)) return String(direct);
    const nested = res?.result || res?.response || res?.data || res?.payload;
    if (nested) {
      const nestedBlob = extractTxBlob(nested);
      if (nestedBlob) return nestedBlob;
    }
    const scanned = deepFindHex(res);
    return scanned || '';
  }

  // ========== SIGN LOGIN TX ==========
  async function wcSignLoginTx({ address, nonce, scope, ts }) {
    if (!S.session) throw new Error('No WC session');

    const memoType = toHex('XRPixelJets');
    const memoData = toHex(`XRPixelJets|${nonce}|${scope}|${ts}`);

    const tx_json = {
      TransactionType: 'AccountSet',
      Account: address,
      Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }]
    };

    const attempts = [
      { method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: false } },
      { method: 'xrpl_signTransactionFor', params: { tx_signer: address, tx_json, autofill: true, submit: false } },
      { method: 'xrpl_sign', params: { tx_json, autofill: true, submit: false } },
      { method: 'xrpl_signAndSubmit', params: { tx_json, autofill: true, submit: true } }
    ];

    let lastErr, reply;
    for (const a of attempts) {
      try {
        reply = await S.client.request({
          topic: S.session.topic,
          chainId: CHAIN_ID,
          request: { method: a.method, params: a.params }
        });
        const blob = extractTxBlob(reply);
        if (blob) {
          hud(`Signed via ${a.method}.`);
          return { tx_blob: blob, tx_json };
        }
      } catch (e) {
        lastErr = e;
      }
    }
    console.error('[WC] sign login tx failed:', lastErr, 'reply=', reply);
    throw new Error('wallet_sign_failed');
  }

  // ========== UI WIRING ==========
  function wireUI() {
    const btnC = document.getElementById('btn-wc-connect');
    if (btnC && !btnC.__wc_bound) {
      btnC.__wc_bound = true;
      btnC.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (!S.client) {
            await init({ projectId: g.WC_PROJECT_ID });
          }
          if (S.session) {
            hud('Already connected.');
            return;
          }
          await connect();
        } catch (err) {
          hud(`Connect failed: ${err?.message || err}`);
        }
      });
    }
  }

  // Keep binding stable
  if (!S.__mo) {
    S.__mo = new MutationObserver(wireUI);
    S.__mo.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireUI, { once: true });
    } else {
      wireUI();
    }
  }

  // ========== PUBLIC API ==========
  XRPLWallet.wcInit = init;
  XRPLWallet.wcConnect = connect;
  XRPLWallet.wcDisconnect = disconnect;
  XRPLWallet.wcGetAddress = wcGetAddress;
  XRPLWallet.wcHasSession = wcHasSession;
  XRPLWallet.wcSignLoginTx = wcSignLoginTx;
})(window);