// /jets/js/auth-claim.js - v=2025-12-20-crossmark-only
// CROSSMARK ONLY - Gem Wallet handled by auth-gem-sdk.js

import { sessionStart, sessionVerify, setAuthToken, claimStart } from './serverApi.js?v=2025-12-20x8';

(function () {
  const $ = (id) => document.getElementById(id);
  const hud = (m) => console.log(`[auth] ${m}`);

  function status(msg) {
    const el = $('claim-status') || $('session-status');
    if (el) el.textContent = msg;
  }

  function isAddress(a) {
    return typeof a === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(a.trim());
  }

  function toHex(s) {
    return Array.from(new TextEncoder().encode(String(s)))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  function setWallet(addr) {
    const clean = (addr || '').trim();
    try { localStorage.setItem('WALLET', clean); } catch {}
    window.CURRENT_WALLET = clean;

    const inp = $('xrpl-address');
    if (inp && clean) inp.value = clean;

    const st = $('session-status');
    if (st) st.textContent = clean ? `Connected: ${clean}` : 'Not connected';

    try {
      window.dispatchEvent(new CustomEvent('jets:auth', {
        detail: { address: clean, authed: !!clean }
      }));
    } catch {}
  }

  function getCrossmark() {
    return window.crossmark || window.xrpl?.crossmark || null;
  }

  function extractSigData(obj) {
    let sig = null, pub = null, addr = null;

    function search(o, depth = 0) {
      if (!o || typeof o !== 'object' || depth > 5) return;

      if (!sig && typeof o.signature === 'string') sig = o.signature;
      if (!pub && typeof o.publicKey === 'string') pub = o.publicKey;
      if (!addr && typeof o.address === 'string' && o.address.startsWith('r')) addr = o.address;

      for (const v of Object.values(o)) {
        if (v && typeof v === 'object') search(v, depth + 1);
      }
    }

    search(obj);
    return { signature: sig, publicKey: pub, address: addr };
  }

  let SIGNING = false;

  // CROSSMARK SIGN-IN
  async function signInCrossmark() {
    if (SIGNING) return false;
    SIGNING = true;

    try {
      status('Opening Crossmark…');

      const cm = getCrossmark();
      if (!cm) throw new Error('Crossmark not installed');

      // 1. Get address
      let addr = ($('xrpl-address')?.value || '').trim();

      if (!isAddress(addr)) {
        try {
          addr = (localStorage.getItem('WALLET') || '').trim();
        } catch {}
      }

      if (!isAddress(addr)) {
        // Show account selector
        const result = await (cm.async?.signInAndWait?.() || cm.signInAndWait?.() || Promise.reject());
        const ex = extractSigData(result);
        addr = ex.address || result?.response?.data?.address || '';
      }

      if (!isAddress(addr)) throw new Error('No wallet address');

      setWallet(addr);
      hud(`Wallet: ${addr}`);

      // 2. Get nonce
      const { nonce } = await sessionStart(addr);
      hud(`Nonce: ${nonce}`);

      // 3. Sign message
      const scope = 'play,upgrade,claim,bazaar';
      const ts = Math.floor(Date.now() / 1000);
      const message = `${nonce}||${scope}||${ts}||${addr}`;
      const messageHex = toHex(message);

      hud('Requesting signature…');
      const signResult = await (
        cm.async?.signInAndWait?.(messageHex) ||
        cm.signInAndWait?.(messageHex) ||
        Promise.reject(new Error('signInAndWait failed'))
      );

      const ex = extractSigData(signResult);
      const signature = ex.signature || signResult?.response?.data?.signature;
      const publicKey = ex.publicKey || signResult?.response?.data?.publicKey;

      if (!signature || !publicKey) {
        throw new Error('No signature from Crossmark');
      }

      hud(`Signature received`);

      // 4. Verify with server
      const verifyRes = await sessionVerify({
        address: addr,
        signature,
        publicKey,
        scope,
        ts,
        payloadHex: messageHex
      });

      if (verifyRes?.jwt) {
        setAuthToken(verifyRes.jwt);
        hud('✓ Signed in with Crossmark');
        status('Signed in');
        return true;
      }

      throw new Error('No JWT from server');

    } catch (e) {
      hud(`✗ Crossmark sign-in failed: ${e.message || e}`);
      status('Sign-in failed');
      return false;
    } finally {
      SIGNING = false;
    }
  }

  async function claim() {
    const addr = ($('xrpl-address')?.value || '').trim() || window.CURRENT_WALLET;
    const amount = parseInt($('claim-amount')?.value || '0', 10);

    if (!isAddress(addr)) {
      status('No wallet');
      return;
    }

    if (!amount || amount <= 0) {
      status('Enter amount');
      return;
    }

    const jwt = (localStorage.getItem('JWT') || '').trim();
    if (!jwt) {
      status('Not signed in');
      const ok = await signInCrossmark();
      if (!ok) return;
    }

    try {
      status('Claiming…');
      const res = await claimStart(amount);

      if (res?.txid) {
        status(`✓ Claimed! TX: ${res.txid.slice(0, 8)}…`);
      } else {
        status('✓ Claim acknowledged');
      }

      // Refresh profile
      try {
        await window.SrvAPI?.profile?.();
      } catch {}

    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('unauthorized') || msg.includes('401')) {
        status('JWT expired - sign in again');
      } else if (msg.includes('trustline')) {
        status('Trustline required');
      } else {
        status('Claim failed');
      }
    }
  }

  // Wire up buttons
  function init() {
    const btnSign = $('btn-sign') || $('btn-connect') || $('btn-login');
    const btnClaim = $('btn-claim');

    if (btnSign && !btnSign.__wired) {
      btnSign.__wired = true;
      btnSign.addEventListener('click', () => void signInCrossmark());
    }

    if (btnClaim && !btnClaim.__wired) {
      btnClaim.__wired = true;
      btnClaim.addEventListener('click', async () => {
        const jwt = (localStorage.getItem('JWT') || '').trim();
        if (!jwt) {
          const ok = await signInCrossmark();
          if (!ok) return;
        }
        await claim();
      });
    }

    // Expose for wallet-modal.js
    // NOTE: signInGem is provided by auth-gem-sdk.js (loaded separately)
    window.JetsAuth = window.JetsAuth || {};
    window.JetsAuth.signInCrossmark = signInCrossmark;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
