// /jets/js/wallet-wc-connect.js — 2025-01-16 mobile-bifrost-v2
// WalletConnect v2 for XRPL: Mobile-optimized with Bifrost deep links, QR fallback, session persistence
// Sign-only flow (hot wallet submits claims)
// FIXED: Proper profile load trigger after JWT auth

const WC = {};
export default WC;

(function attach(g) {
  'use strict';

  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const LOG_ID = 'log', INPUT_ID = 'xrpl-address', STATUS_ID = 'session-status';
  const BTN_CONNECT = 'btn-wc-connect';
  const CHAIN_ID = 'xrpl:0'; // XRPL mainnet

  // ---------- State ----------
  const S = {
    projectId: null,
    client: null,
    modal: null,
    session: null,
    initializing: false,
    initialized: false,
    requiredNamespaces: {
      xrpl: {
        chains: [CHAIN_ID],
        methods: [
          'xrpl_signTransaction',      // Bifrost preferred
          'xrpl_signTransactionFor',   // Multi-sign variant
          'xrpl_sign',                 // Generic
          'xrpl_signAndSubmit'         // Fallback (submits to network)
        ],
        events: ['chainChanged', 'accountsChanged']
      }
    }
  };

  // ---------- Platform Detection ----------
  const isMobile = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isAndroid = () => /Android/i.test(navigator.userAgent);

  // ---------- Helpers ----------
  const toHex = (s) => Array.from(new TextEncoder().encode(s)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function hud(msg) {
    try {
      const el = document.getElementById(LOG_ID);
      if (!el) return;
      const d = document.createElement('div');
      d.className = 'log-line';
      d.textContent = String(msg);
      el.appendChild(d);
      el.scrollTop = el.scrollHeight;
    } catch {}
    console.log('[WC]', msg);
  }

  function setCurrentWallet(addr) {
    try { localStorage.setItem('WALLET', addr || ''); } catch {}
    g.CURRENT_WALLET = addr || '';
    const inp = document.getElementById(INPUT_ID);
    if (inp) inp.value = g.CURRENT_WALLET;
    const st = document.getElementById(STATUS_ID);
    if (st) st.textContent = addr ? `Connected: ${addr}` : 'Not connected';
    try { window.JetsApi?.setWallet?.(addr); } catch {}
  }

  function parseFirstAccount(session) {
    const acc = session?.namespaces?.xrpl?.accounts?.[0] || ''; // "xrpl:0:r..."
    return acc.split(':').pop() || '';
  }

  // ---------- Deep Link Generators ----------
  function buildBifrostDeepLink(wcUri) {
    const encoded = encodeURIComponent(wcUri);
    return `bifrost://wc?uri=${encoded}`;
  }

  function buildGenericWcDeepLink(wcUri) {
    return `wc:${wcUri.replace('wc:', '')}`;
  }

  // ---------- Mobile Connect Modal ----------
  function showMobileConnectModal(uri) {
    const existing = document.getElementById('wc-mobile-modal');
    if (existing) existing.remove();

    const bifrostLink = buildBifrostDeepLink(uri);
    const genericLink = buildGenericWcDeepLink(uri);

    const modal = document.createElement('div');
    modal.id = 'wc-mobile-modal';
    modal.innerHTML = `
      <style>
        #wc-mobile-modal {
          position: fixed;
          inset: 0;
          background: rgba(3,7,18,0.92);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 2147483647;
          font-family: 'Press Start 2P', system-ui, monospace;
        }
        #wc-mobile-modal .wc-modal-content {
          background: #0f1524;
          border: 1px solid #2a3550;
          border-radius: 12px;
          padding: 16px;
          width: 90vw;
          max-width: 340px;
          text-align: center;
          color: #e6f3ff;
        }
        #wc-mobile-modal h3 {
          margin: 0 0 12px 0;
          font-size: 14px;
          color: #49f3ff;
        }
        #wc-mobile-modal .wc-btn {
          display: block;
          width: 100%;
          padding: 14px 12px;
          margin: 8px 0;
          border: 1px solid #2a3550;
          border-radius: 10px;
          background: linear-gradient(180deg, #1a2440, #121a30);
          color: #e6f3ff;
          font-family: inherit;
          font-size: 11px;
          cursor: pointer;
          text-decoration: none;
          text-align: center;
        }
        #wc-mobile-modal .wc-btn.primary {
          background: linear-gradient(180deg, #1d3b24, #142a1a);
          border-color: #2a5c35;
        }
        #wc-mobile-modal .wc-btn:active {
          transform: scale(0.98);
        }
        #wc-mobile-modal .wc-qr-section {
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid #2a3550;
        }
        #wc-mobile-modal .wc-qr-toggle {
          font-size: 10px;
          color: #9db0c4;
          cursor: pointer;
          text-decoration: underline;
        }
        #wc-mobile-modal .wc-qr-container {
          display: none;
          margin-top: 12px;
        }
        #wc-mobile-modal .wc-qr-container.show {
          display: block;
        }
        #wc-mobile-modal .wc-qr-container canvas {
          max-width: 200px;
          margin: 0 auto;
          display: block;
        }
        #wc-mobile-modal .wc-cancel {
          margin-top: 12px;
          font-size: 10px;
          color: #9db0c4;
          cursor: pointer;
        }
        #wc-mobile-modal .wc-status {
          font-size: 10px;
          color: #65f0a0;
          margin-top: 8px;
        }
        #wc-mobile-modal .wc-tiny {
          font-size: 9px;
          color: #9db0c4;
          margin-top: 4px;
        }
      </style>
      <div class="wc-modal-content">
        <h3>🔗 Connect Wallet</h3>
        
        <a href="${bifrostLink}" class="wc-btn primary" id="wc-open-bifrost">
          Open Bifrost Wallet
        </a>
        <div class="wc-tiny">Recommended for XRPL</div>
        
        <a href="${genericLink}" class="wc-btn" id="wc-open-other">
          Open Other WC Wallet
        </a>
        
        <div class="wc-qr-section">
          <span class="wc-qr-toggle" id="wc-show-qr">Show QR Code (scan from another device)</span>
          <div class="wc-qr-container" id="wc-qr-container">
            <div id="wc-qr-code"></div>
          </div>
        </div>
        
        <div class="wc-status" id="wc-modal-status">Waiting for wallet...</div>
        
        <div class="wc-cancel" id="wc-cancel">Cancel</div>
      </div>
    `;

    document.body.appendChild(modal);

    // Wire up events
    const toggleQr = modal.querySelector('#wc-show-qr');
    const qrContainer = modal.querySelector('#wc-qr-container');
    const cancelBtn = modal.querySelector('#wc-cancel');

    toggleQr?.addEventListener('click', async () => {
      qrContainer.classList.toggle('show');
      if (qrContainer.classList.contains('show')) {
        toggleQr.textContent = 'Hide QR Code';
        await renderQrCode(uri, modal.querySelector('#wc-qr-code'));
      } else {
        toggleQr.textContent = 'Show QR Code (scan from another device)';
      }
    });

    cancelBtn?.addEventListener('click', () => {
      closeMobileConnectModal();
      S._connectReject?.(new Error('user_cancelled'));
    });

    modal.querySelector('#wc-open-bifrost')?.addEventListener('click', () => {
      updateModalStatus('Opening Bifrost...');
    });
    modal.querySelector('#wc-open-other')?.addEventListener('click', () => {
      updateModalStatus('Opening wallet...');
    });

    return modal;
  }

  function updateModalStatus(msg) {
    const el = document.querySelector('#wc-mobile-modal .wc-status');
    if (el) el.textContent = msg;
  }

  function closeMobileConnectModal() {
    const modal = document.getElementById('wc-mobile-modal');
    if (modal) modal.remove();
  }

  async function renderQrCode(data, container) {
    if (!container) return;
    
    try {
      const QRCode = g.QRCode || (await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm')).default;
      if (QRCode?.toCanvas) {
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, data, { width: 200, margin: 2 });
        container.innerHTML = '';
        container.appendChild(canvas);
      } else if (QRCode) {
        container.innerHTML = '';
        new QRCode(container, { text: data, width: 200, height: 200 });
      }
    } catch (e) {
      console.warn('[WC] QR render failed:', e);
      container.innerHTML = `<div style="font-size:9px;color:#9db0c4;word-break:break-all;max-width:200px;margin:0 auto;">
        Copy URI manually:<br><code style="font-size:8px">${data.slice(0, 60)}...</code>
      </div>`;
    }
  }

  // ---------- Dependency Loader ----------
  async function ensureDeps() {
    let SignClient = g.WalletConnect?.SignClient;
    let ModalCtor = g.WalletConnectModal;

    const tryImport = async (urls) => {
      for (const url of urls) {
        try {
          const mod = await import(url);
          if (mod) return mod;
        } catch (_) { /* try next */ }
      }
      return null;
    };

    if (!SignClient) {
      hud('Loading WalletConnect...');
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://unpkg.com/@walletconnect/sign-client@2.21.8/dist/index.es.js',
        'https://esm.sh/@walletconnect/sign-client@2.21.8'
      ]);
      if (mod) {
        g.WalletConnect = g.WalletConnect || {};
        g.WalletConnect.SignClient = mod.SignClient || mod.default;
      }
      SignClient = g.WalletConnect?.SignClient;
    }

    if (!ModalCtor) {
      const mod = await tryImport([
        'https://cdn.jsdelivr.net/npm/@walletconnect/modal@2.7.0/dist/index.js',
        'https://esm.sh/@walletconnect/modal@2.7.0'
      ]);
      if (mod) g.WalletConnectModal = mod.default || mod.WalletConnectModal || mod;
      ModalCtor = g.WalletConnectModal;
    }

    if (!SignClient || !ModalCtor) throw new Error('wc_deps_missing');
  }

  // ---------- Session Event Handlers ----------
  function setupSessionHandlers() {
    if (!S.client) return;

    S.client.on('session_delete', ({ topic }) => {
      console.log('[WC] session_delete', topic);
      if (S.session?.topic === topic) {
        S.session = null;
        setCurrentWallet('');
        hud('Wallet disconnected.');
        try { localStorage.removeItem('JWT'); g.JetsApi?.setAuthToken?.(null); } catch {}
      }
    });

    S.client.on('session_expire', ({ topic }) => {
      console.log('[WC] session_expire', topic);
      if (S.session?.topic === topic) {
        S.session = null;
        setCurrentWallet('');
        hud('Session expired.');
        try { localStorage.removeItem('JWT'); g.JetsApi?.setAuthToken?.(null); } catch {}
      }
    });

    S.client.on('session_update', ({ topic, params }) => {
      console.log('[WC] session_update', topic, params);
      if (S.session?.topic === topic) {
        S.session.namespaces = params.namespaces;
        const addr = parseFirstAccount(S.session);
        if (addr) setCurrentWallet(addr);
      }
    });
  }

  // ---------- Init ----------
  async function init({ projectId }) {
    if (S.initializing) {
      while (S.initializing) await sleep(100);
      return S.client;
    }
    if (S.initialized && S.client) return S.client;

    S.initializing = true;
    try {
      if (!projectId) throw new Error('wc_projectId_missing');
      S.projectId = projectId;

      await ensureDeps();

      hud('Initializing WalletConnect...');
      S.client = await g.WalletConnect.SignClient.init({
        projectId: S.projectId,
        metadata: {
          name: 'XRPixel Jets',
          description: 'Retro pixel dogfight game on XRPL',
          url: 'https://mykeygo.io/jets',
          icons: ['https://mykeygo.io/jets/assets/favicon.png']
        }
      });

      S.modal = new g.WalletConnectModal({
        projectId: S.projectId,
        themeMode: 'dark',
        themeVariables: {
          '--wcm-z-index': '2147483647'
        }
      });

      setupSessionHandlers();

      // Restore existing session if any
      const sessions = S.client.session.getAll();
      if (sessions?.length) {
        S.session = sessions[0];
        const addr = parseFirstAccount(S.session);
        if (addr) {
          setCurrentWallet(addr);
          hud(`Restored session: ${addr.slice(0, 8)}...`);
          
          // Check if we have a JWT, if not, need to re-auth
          const jwt = localStorage.getItem('JWT');
          if (!jwt) {
            hud('Session restored but no JWT. Please sign in again.');
          }
        }
      }

      S.initialized = true;
      hud('WalletConnect ready.');
      return S.client;
    } finally {
      S.initializing = false;
    }
  }

  // ---------- Connect ----------
  async function connect() {
    if (!S.client || !S.modal) throw new Error('wc_not_inited');
    if (S.session) {
      const addr = parseFirstAccount(S.session);
      if (addr) {
        hud('Already connected: ' + addr.slice(0, 8) + '...');
        return addr;
      }
    }

    hud('Connecting...');
    const { uri, approval } = await S.client.connect({ requiredNamespaces: S.requiredNamespaces });

    if (!uri) throw new Error('wc_no_uri');

    // Show appropriate UI based on platform
    if (isMobile()) {
      showMobileConnectModal(uri);
    } else {
      await S.modal.openModal({ uri });
    }

    // Wait for approval
    try {
      S.session = await approval();
    } finally {
      closeMobileConnectModal();
      try { S.modal.closeModal(); } catch {}
    }

    const address = parseFirstAccount(S.session);
    if (!address) throw new Error('wc_no_address');

    setCurrentWallet(address);
    hud(`Connected: ${address.slice(0, 8)}...`);

    // Dispatch auth event BEFORE sign-in (so NFTs load)
    try {
      g.dispatchEvent(new CustomEvent('jets:auth', { detail: { address } }));
    } catch {}

    // Auto-sign login tx to get JWT
    const signedIn = await autoSignIn(address);
    
    // If sign-in succeeded, trigger profile load
    if (signedIn) {
      await triggerProfileLoad(address);
    }

    return address;
  }

  // ---------- Auto Sign-In After Connect ----------
  async function autoSignIn(address) {
    try {
      hud('Requesting signature for login...');
      updateModalStatus?.('Sign the login request in your wallet...');

      const JetsApi = g.JetsApi;
      if (!JetsApi?.sessionStart) {
        console.warn('[WC] JetsApi not available for auto sign-in');
        hud('⚠ JetsApi not ready. Please click Sign In manually.');
        return false;
      }

      // Step 1: Get nonce from server
      console.log('[WC] Getting nonce for address:', address);
      const start = await JetsApi.sessionStart(address);
      console.log('[WC] Got nonce:', start.nonce);
      
      const ts = Date.now();
      const scope = 'play,upgrade,claim';
      
      // Step 2: Sign the login transaction
      console.log('[WC] Requesting login signature...');
      const res = await wcSignLoginTx({ address, nonce: start.nonce, scope, ts });
      console.log('[WC] Got signed tx_blob, length:', res.tx_blob?.length);

      // Step 3: Verify with server
      console.log('[WC] Verifying with server...');
      const API_BASE = g.JETS_API_BASE || 'https://xrpixeljets.onrender.com';
      const verifyRes = await fetch(API_BASE + '/session/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Wallet': address },
        body: JSON.stringify({
          address,
          network: 'xrpl:mainnet',
          signer: 'walletconnect',
          tx_blob: res.tx_blob
        })
      });
      
      const v = await verifyRes.json();
      console.log('[WC] Verify response:', v);

      const token = v?.token || v?.jwt;
      if (token) {
        // Store JWT
        JetsApi.setAuthToken(token);
        try { localStorage.setItem('JWT', token); } catch {}
        
        hud('✓ Signed in with WalletConnect!');
        
        const statusEl = document.getElementById(STATUS_ID);
        if (statusEl) statusEl.textContent = `Signed In: ${address.slice(0, 8)}...`;
        
        return true;
      } else {
        console.error('[WC] No token in verify response:', v);
        hud('⚠ Sign-in failed: no token received');
        return false;
      }
    } catch (e) {
      console.error('[WC] Auto sign-in failed:', e);
      hud(`⚠ Sign-in failed: ${e?.message || e}`);
      return false;
    }
  }

  // ---------- Trigger Profile Load ----------
  async function triggerProfileLoad(address) {
    try {
      hud('Loading profile...');
      
      // Method 1: Call JetsApi.getProfile directly
      const JetsApi = g.JetsApi;
      if (JetsApi?.getProfile) {
        console.log('[WC] Calling getProfile...');
        const profile = await JetsApi.getProfile();
        console.log('[WC] Profile loaded:', profile);
        
        // Dispatch profile event
        try {
          g.dispatchEvent(new CustomEvent('jets:profile', { detail: profile }));
        } catch {}
        
        hud('✓ Profile loaded!');
      }
      
      // Method 2: Dispatch auth event again (triggers main.js handlers)
      try {
        g.dispatchEvent(new CustomEvent('jets:auth', { detail: { address, authenticated: true } }));
      } catch {}
      
    } catch (e) {
      console.error('[WC] Profile load failed:', e);
      hud(`⚠ Profile load failed: ${e?.message || e}`);
    }
  }

  // ---------- Disconnect ----------
  async function disconnect() {
    if (!S.session) return;
    try {
      await S.client.disconnect({
        topic: S.session.topic,
        reason: { code: 6000, message: 'User disconnected' }
      });
    } catch (e) {
      console.warn('[WC] Disconnect error:', e);
    } finally {
      S.session = null;
      setCurrentWallet('');
      hud('Disconnected.');
      try {
        localStorage.removeItem('JWT');
        g.JetsApi?.setAuthToken?.(null);
      } catch {}
    }
  }

  // ---------- Getters ----------
  function wcGetAddress() { return parseFirstAccount(S.session); }
  function wcHasSession() { return !!S.session; }
  function wcIsInitialized() { return S.initialized; }

  // ---------- Tx Blob Extraction ----------
  function extractTxBlob(reply) {
    if (!reply) return '';
    
    const r = reply?.result || reply;
    const direct = r?.tx_blob || r?.txBlob || r?.signedTransaction || r?.blob || r?.signedTx;
    if (direct && typeof direct === 'string' && direct.length > 100) return direct;

    const isHex = (x) => typeof x === 'string' && /^[A-F0-9]+$/i.test(x) && x.length > 200;
    function deepFind(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 5) return '';
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (isHex(v)) return v;
        const found = deepFind(v, depth + 1);
        if (found) return found;
      }
      return '';
    }
    return deepFind(reply);
  }

  // ---------- Sign Login Tx ----------
  async function wcSignLoginTx({ address, nonce, scope, ts }) {
    if (!S.session) throw new Error('No WC session');

    const memoType = toHex('XRPixelJets');
    const memoData = toHex(`XRPixelJets|${nonce}|${scope}|${ts}`);

    const tx_json = {
      TransactionType: 'AccountSet',
      Account: address,
      Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }]
    };

    // Bifrost-optimized method order (sign without submit preferred)
    const attempts = [
      { method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: false } },
      { method: 'xrpl_signTransactionFor', params: { tx_signer: address, tx_json, autofill: true, submit: false } },
      { method: 'xrpl_sign', params: { tx_json, autofill: true, submit: false } },
      { method: 'xrpl_signAndSubmit', params: { tx_json, autofill: true, submit: true } }
    ];

    let lastErr, reply;
    for (const a of attempts) {
      try {
        hud(`Trying ${a.method}...`);
        console.log(`[WC] Requesting ${a.method}...`);
        
        reply = await S.client.request({
          topic: S.session.topic,
          chainId: CHAIN_ID,
          request: { method: a.method, params: a.params }
        });
        
        console.log(`[WC] ${a.method} reply:`, reply);
        const blob = extractTxBlob(reply);
        
        if (blob) {
          hud(`✓ Signed via ${a.method}`);
          return { tx_blob: blob, tx_json };
        }
      } catch (e) {
        lastErr = e;
        console.warn(`[WC] ${a.method} failed:`, e?.message || e);
      }
    }

    console.error('[WC] All sign methods failed. Last error:', lastErr, 'Last reply:', reply);
    throw new Error('wallet_sign_failed');
  }

  // ---------- Sign Generic Tx ----------
  async function wcSignTx(tx_json, { submit = false } = {}) {
    if (!S.session) throw new Error('No WC session');

    const address = parseFirstAccount(S.session);
    if (!tx_json.Account) tx_json.Account = address;

    const attempts = submit
      ? [
          { method: 'xrpl_signAndSubmit', params: { tx_json, autofill: true, submit: true } },
          { method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: true } }
        ]
      : [
          { method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: false } },
          { method: 'xrpl_signTransactionFor', params: { tx_signer: address, tx_json, autofill: true, submit: false } },
          { method: 'xrpl_sign', params: { tx_json, autofill: true, submit: false } }
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
        if (blob) return { tx_blob: blob, tx_json, reply };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('wallet_sign_failed');
  }

  // ---------- TrustSet Helper ----------
  async function wcSetTrustline({ limit = '10000000' } = {}) {
    const address = wcGetAddress();
    if (!address) throw new Error('No address');

    const issuer = g.ISSUER_ADDR || g.ISSUER_ADDRESS || 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e';
    const currencyHex = g.CURRENCY_HEX || '4A45545300000000000000000000000000000000';

    const tx_json = {
      TransactionType: 'TrustSet',
      Account: address,
      LimitAmount: {
        currency: currencyHex,
        issuer: issuer,
        value: String(limit)
      }
    };

    hud('Requesting TrustSet...');
    const result = await wcSignTx(tx_json, { submit: true });
    hud('✓ Trustline request sent');
    return result;
  }

  // ---------- UI Wiring ----------
  function once(el, evt, fn) {
    if (!el || el.__wcbound) return;
    el.__wcbound = true;
    el.addEventListener(evt, fn);
  }

  function wireUI() {
    const btnC = document.getElementById(BTN_CONNECT);
    once(btnC, 'click', async (e) => {
      e.preventDefault();
      try {
        if (!S.client) await init({ projectId: g.WC_PROJECT_ID });
        if (S.session) {
          const addr = parseFirstAccount(S.session);
          if (addr) {
            hud('Already connected: ' + addr.slice(0, 8) + '...');
            g.dispatchEvent(new CustomEvent('jets:auth', { detail: { address: addr } }));
            return;
          }
        }
        await connect();
      } catch (err) {
        console.error('[WC] Connect error:', err);
        hud(`Connect failed: ${err?.message || err}`);
      }
    });

    // Trustline button
    const btnT = document.getElementById('btn-wc-trustline');
    const dlg = document.getElementById('wc-trustline-modal');
    once(btnT, 'click', () => {
      if (!S.session) {
        hud('Connect a wallet first.');
        return;
      }
      dlg?.showModal?.();
    });

    if (dlg && !dlg.__wcwired) {
      dlg.__wcwired = true;
      const form = dlg.querySelector('form');
      const cancel = dlg.querySelector('[data-cancel]');
      form?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const limit = form.querySelector('input[name=limit]')?.value || '10000000';
        try {
          await wcSetTrustline({ limit });
          dlg.close();
        } catch (e) {
          hud(`Trustline error: ${e?.message || e}`);
        }
      });
      cancel?.addEventListener('click', () => dlg.close());
    }
  }

  // MutationObserver to handle dynamic DOM
  if (!S.__mo) {
    S.__mo = new MutationObserver(wireUI);
    S.__mo.observe(document.documentElement, { childList: true, subtree: true });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireUI, { once: true });
    } else {
      wireUI();
    }
  }

  // ---------- Public API ----------
  XRPLWallet.wcInit = init;
  XRPLWallet.wcConnect = connect;
  XRPLWallet.wcDisconnect = disconnect;
  XRPLWallet.wcGetAddress = wcGetAddress;
  XRPLWallet.wcHasSession = wcHasSession;
  XRPLWallet.wcIsInitialized = wcIsInitialized;
  XRPLWallet.wcSignLoginTx = wcSignLoginTx;
  XRPLWallet.wcSignTx = wcSignTx;
  XRPLWallet.wcSetTrustline = wcSetTrustline;
  XRPLWallet.wcTriggerProfileLoad = triggerProfileLoad; // Expose for manual retry

  // ---------- Pre-warm on DOM ready ----------
  document.addEventListener('DOMContentLoaded', () => {
    const projectId = g.WC_PROJECT_ID;
    if (projectId && !S.client && !S.initializing) {
      init({ projectId }).catch(e => console.warn('[WC] Pre-warm init error:', e));
    }
  });

  console.log('[WC] wallet-wc-connect.js loaded (mobile-bifrost-v2)');

})(window);