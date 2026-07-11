// /jets/js/auth-unified.js — Single source of truth for all wallet auth
// v=2025-12-18-unified1
import { sessionStart, sessionVerify, setAuthToken } from './serverApi.js';

(function(){
  const g = window;
  const API_BASE = g.JETS_API_BASE || 'https://xrpixeljets.onrender.com';

  // ========== UTILITIES ==========
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const toHexU = (s) => Array.from(new TextEncoder().encode(s))
    .map(b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  
  const hud = (m) => {
    console.log('[Auth]', m);
    const el = $('log');
    if (el) {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.textContent = String(m);
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
    }
  };

  const status = (msg, html = false) => {
    const el = $('claim-status') || $('session-status') || $('status');
    if (!el) return;
    if (html) el.innerHTML = msg;
    else el.textContent = msg;
  };

  const setWalletLocal = (addr) => {
    try { localStorage.setItem('WALLET', addr || ''); } catch {}
    g.CURRENT_WALLET = addr || '';
    const inp = $('xrpl-address');
    if (inp) inp.value = g.CURRENT_WALLET;
    const st = $('session-status');
    if (st) st.textContent = addr ? `Connected: ${addr}` : 'Not connected';
    try {
      g.dispatchEvent(new CustomEvent('jets:auth', { detail: { address: addr } }));
    } catch {}
  };

  const isClassic = (a) => typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(a);

  async function waitFor(fn, ms = 8000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  // ========== LOGIN TRANSACTION BUILDER ==========
  function buildLoginTx({ address, nonce, scope, ts }) {
    const memoType = toHexU('XRPixelJets');
    const memoData = toHexU(`XRPixelJets|${nonce}|${scope}|${ts}`);
    return {
      TransactionType: 'AccountSet',
      Account: address,
      Memos: [{ Memo: { MemoType: memoType, MemoData: memoData } }]
    };
  }

  function extractTxBlob(r) {
    const x = r?.result || r || {};
    return x.tx_blob || x.txBlob || x.signedTransaction || x.blob || x.signedTx || '';
  }

  async function verifyWithTxBlob({ address, signer, tx_blob }) {
    const v = await sessionVerify({
      address,
      network: 'xrpl:mainnet',
      signer,
      tx_blob
    });
    const token = v?.token || v?.jwt;
    if (!token) throw new Error('no_jwt');
    setAuthToken(token);
    status('Signed in.');
    hud(`Signed in with ${signer} (JWT stored).`);
    setWalletLocal(address);
    return true;
  }

  // ========== CROSSMARK ==========
  async function signInCrossmark() {
    status('Opening Crossmark…');
    
    // Wait for Crossmark to inject AFTER click gesture
    const xmk = await waitFor(() => g.crossmark, 12000);
    if (!xmk) {
      status('Crossmark not available.');
      throw new Error('crossmark_unavailable');
    }

    // Get address
    let address = ($('xrpl-address')?.value || '').trim();
    if (!isClassic(address)) {
      try {
        if (xmk.request) {
          const ra = await xmk.request({ method: 'xrpl_getAddress', params: {} }).catch(() => null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        } else if (xmk.getAddress) {
          const ra = await xmk.getAddress().catch(() => null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        }
      } catch {}
      if (!address) address = (localStorage.getItem('WALLET') || '').trim();
    }
    if (!isClassic(address)) throw new Error('no_address');

    // Get nonce and build tx
    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts = Date.now();
    const tx_json = buildLoginTx({ address, nonce, scope, ts });

    // Try multiple Crossmark methods
    const attempts = [];
    if (xmk.request) {
      attempts.push(() => xmk.request({ method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: false } }));
      attempts.push(() => xmk.request({ method: 'xrpl_signTransactionFor', params: { tx_signer: address, tx_json, autofill: true, submit: false } }));
      attempts.push(() => xmk.request({ method: 'xrpl_sign', params: { tx_json, autofill: true, submit: false } }));
    }
    if (xmk.xrpl?.signTransaction) {
      attempts.push(() => xmk.xrpl.signTransaction({ tx_json, autofill: true, submit: false }));
    }

    let blob = '';
    let lastErr = null;
    for (const call of attempts) {
      try {
        const reply = await call();
        blob = extractTxBlob(reply);
        if (blob) break;
      } catch (e) {
        lastErr = e;
      }
    }
    
    if (!blob) {
      console.warn('[Auth] Crossmark sign failed:', lastErr);
      throw new Error('crossmark_sign_failed');
    }

    return verifyWithTxBlob({ address, signer: 'crossmark', tx_blob: blob });
  }

  // ========== GEMWALLET ==========
  async function signInGem() {
    status('Opening GemWallet…');
    
    // Wait for GemWallet to inject
    const gem = await waitFor(() => g.gemWallet, 12000);
    if (!gem) {
      status('GemWallet not available.');
      throw new Error('gemwallet_unavailable');
    }

    // Get address
    let address = ($('xrpl-address')?.value || '').trim();
    if (!isClassic(address)) {
      try {
        if (gem.getAddress) {
          const ra = await gem.getAddress().catch(() => null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        } else if (gem.xrpl?.getAddress) {
          const ra = await gem.xrpl.getAddress().catch(() => null);
          if (typeof ra === 'string' && ra.startsWith('r')) address = ra;
        }
      } catch {}
      if (!address) address = (localStorage.getItem('WALLET') || '').trim();
    }
    if (!isClassic(address)) throw new Error('no_address');

    // Get nonce and build tx
    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts = Date.now();
    const tx_json = buildLoginTx({ address, nonce, scope, ts });

    // Try GemWallet sign methods
    const tries = [
      async () => gem.xrpl?.signTransaction?.(tx_json, { autofill: true, submit: false }),
      async () => gem.signTransaction?.(tx_json, { autofill: true, submit: false }),
      async () => gem.request?.({ method: 'xrpl_signTransaction', params: { tx_json, autofill: true, submit: false } })
    ];

    let blob = '';
    let lastErr = null;
    for (const t of tries) {
      try {
        const reply = await t();
        blob = extractTxBlob(reply);
        if (blob) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!blob) {
      console.warn('[Auth] GemWallet sign failed:', lastErr);
      throw new Error('gem_sign_failed');
    }

    return verifyWithTxBlob({ address, signer: 'gemwallet', tx_blob: blob });
  }

  // ========== WALLETCONNECT ==========
  async function signInWalletConnect() {
    // Check if WC session exists
    if (!g.XRPLWallet?.wcHasSession?.()) {
      // Trigger the visible WC connect button (opens modal/QR)
      const btn = $('btn-wc-connect');
      if (btn) {
        btn.click();
        // Wait for session
        const ok = await waitFor(() => g.XRPLWallet?.wcHasSession?.(), 60000, 500);
        if (!ok) throw new Error('wc_no_session');
      } else {
        throw new Error('wc_button_missing');
      }
    }

    const address = g.XRPLWallet.wcGetAddress?.();
    if (!isClassic(address)) throw new Error('wc_no_address');

    // Get nonce and sign login tx
    const { nonce } = await sessionStart(address);
    const scope = 'play,upgrade,claim';
    const ts = Date.now();
    
    const { tx_blob } = await g.XRPLWallet.wcSignLoginTx?.({ address, nonce, scope, ts }) || {};
    if (!tx_blob) throw new Error('wc_sign_failed');

    return verifyWithTxBlob({ address, signer: 'walletconnect', tx_blob });
  }

  // ========== PUBLIC API ==========
  async function signIn(provider) {
    try {
      if (provider === 'crossmark') return await signInCrossmark();
      if (provider === 'gem' || provider === 'gemwallet') return await signInGem();
      if (provider === 'walletconnect' || provider === 'wc') return await signInWalletConnect();
      throw new Error('unknown_provider');
    } catch (e) {
      hud(`Sign-in failed: ${e?.message || e}`);
      status('Sign-in failed');
      return false;
    }
  }

  // ========== UI WIRING ==========
  function wireButtons() {
    // Modal buttons (wallet-modal.js should call JetsAuth.signIn)
    // Legacy sign button
    const btnSign = $('btn-sign');
    if (btnSign && !btnSign.__auth_bound) {
      btnSign.__auth_bound = true;
      btnSign.addEventListener('click', () => signIn('crossmark'));
    }

    // Claim buttons - ensure signed in first
    const claimButtons = ['btn-claim', 'btn-claim-wc', 'btn-claim-gem'];
    claimButtons.forEach(btnId => {
      const btn = $(btnId);
      if (btn && !btn.__auth_bound) {
        btn.__auth_bound = true;
        btn.addEventListener('click', async () => {
          // Check JWT
          const jwt = (localStorage.getItem('JWT') || '').trim();
          if (!jwt) {
            hud('Not signed in. Click Sign In first.');
            return;
          }
          // Let wallet-claim.js handle the actual claim
        });
      }
    });
  }

  // ========== EXPORT ==========
  g.JetsAuth = { signIn };

  // Auto-wire on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireButtons);
  } else {
    wireButtons();
  }
})();