// /jets/js/signers.js — 2025-12-18r6
// WalletConnect (xrpl:0), Crossmark, GemWallet, Xaman signers with
// resilient address resolution and submit fallbacks.
//
// Requires xrpl vendor on the page BEFORE this module:
//   <script src="/jets/js/vendor/xrpl-latest-min.js"></script>
//
// Usage from other modules:
//   import { Signers } from '/jets/js/signers.js?v=2025-12-18r6';
//   const s = Signers.getActive(); const addr = await s?.address();
//   const hash = await s?.signAndSubmit(tx_json);

export const Signers = (() => {
  const CHAIN_ID = 'xrpl:0';
  const WSS = window.XRPL_WSS || 'wss://xrplcluster.com';

  const hud = (msg) => {
    console.log('[Signers]', msg);
    const el = document.getElementById('log'); if (!el) return;
    const d = document.createElement('div'); d.className = 'log-line'; d.textContent = String(msg);
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  };

  const isClassic = (r) => typeof r === 'string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(r);

  async function submitBlob(blob){
    const xrpl = window.xrpl;
    if (!xrpl) throw new Error('xrpl_vendor_missing_for_submit');
    const api = new xrpl.Client(WSS);
    await api.connect();
    try {
      const sub = await api.submitAndWait(blob, { failHard:false });
      const tx  = sub?.result?.tx_json || sub?.result;
      return tx?.hash || sub?.hash || '';
    } finally {
      try { await api.disconnect(); } catch {}
    }
  }

  // ---------------------------------------------------------------
  // WalletConnect (Bifrost & others)
  // ---------------------------------------------------------------
  function wcClient(){ return window.XRPLWallet?.__Sclient || null; }
  function wcSession(){
    const c = wcClient();
    return c?.session?.getAll?.()[0] || c?.session || null;
  }
  function wcAddress(){
    const s = wcSession();
    const accs = s?.namespaces?.xrpl?.accounts || [];
    for (const a of accs) {
      const addr = (a||'').split(':').pop();
      if (isClassic(addr)) return addr;
    }
    return '';
  }

  const WcSigner = {
    id: 'walletconnect',
    available() { return !!(wcClient() && wcSession() && wcAddress()); },
    address()   { return wcAddress(); },
    async signAndSubmit(tx_json) {
      const client  = wcClient();
      const session = wcSession();
      const topic   = session?.topic;
      if (!client || !topic) throw new Error('wc_session_missing');

      // Try native sign+submit first (some wallets implement it)
      try {
        const res = await client.request({
          topic, chainId: CHAIN_ID,
          request: { method:'xrpl_signAndSubmit', params:{ tx_json, autofill:true, submit:true } }
        });
        const hash = res?.result?.hash || res?.tx_hash || res?.hash;
        if (hash) return hash;
      } catch (e) {
        hud('WC signAndSubmit not available, falling back to sign → local submit…');
      }

      // Fallback: sign only, then local submit via xrpl client
      const signed = await client.request({
        topic, chainId: CHAIN_ID,
        request: { method:'xrpl_signTransaction', params:{ tx_json, autofill:true, submit:false } }
      });
      const blob = signed?.result?.tx_blob || signed?.tx_blob || signed?.signedTransaction || signed?.blob;
      if (!blob) throw new Error('wc_sign_failed_no_blob');
      return submitBlob(blob);
    }
  };

  // ---------------------------------------------------------------
  // Crossmark (desktop extension)
  // ---------------------------------------------------------------
  const CrossmarkSigner = {
    id: 'crossmark',
    available() { return !!window.crossmark; },
    async address() {
      try {
        const a = await (window.crossmark?.getAddress?.() || window.crossmark?.xrpl?.getAddress?.());
        if (isClassic(a)) return a;
      } catch {}
      try {
        const b = localStorage.getItem('WALLET');
        if (isClassic(b)) return b;
      } catch {}
      return '';
    },
    async signAndSubmit(tx_json) {
      // Prefer signAndSubmit if present
      if (window.crossmark?.xrpl?.signAndSubmit) {
        const res = await window.crossmark.xrpl.signAndSubmit(tx_json, { autofill:true });
        const hash = res?.result?.hash || res?.hash;
        if (hash) return hash;
      }
      if (window.crossmark?.signAndSubmit) {
        const res = await window.crossmark.signAndSubmit(tx_json, { autofill:true });
        const hash = res?.result?.hash || res?.hash;
        if (hash) return hash;
      }
      // Fallback: sign only then submit locally
      const signed =
        (window.crossmark?.xrpl?.sign)
          ? await window.crossmark.xrpl.sign(tx_json, { autofill:true })
          : await window.crossmark.sign(tx_json, { autofill:true });
      const blob = signed?.result?.tx_blob || signed?.tx_blob || signed?.signedTransaction || signed?.blob;
      if (!blob) throw new Error('crossmark_sign_failed_no_blob');
      return submitBlob(blob);
    }
  };

  // ---------------------------------------------------------------
  // GemWallet (desktop extension)
  // ---------------------------------------------------------------
  function gem() { return window.gemWallet || window.GemWalletApi || window.gemwallet || null; }
  const GemSigner = {
    id: 'gemwallet',
    available() { return !!(gem() && (gem().getAddress || gem().request)); },
    async address() {
      const w = gem(); if (!w) return '';
      try {
        const res = await w.getAddress?.();
        const addr = res?.result?.address || res?.address || res;
        return isClassic(addr) ? addr : '';
      } catch {
        try {
          const res = await w.request?.({ method: 'getAddress' });
          const addr = res?.result?.address || res?.address || res;
          return isClassic(addr) ? addr : '';
        } catch { return ''; }
      }
    },
    async signAndSubmit(tx_json) {
      const w = gem(); if (!w) throw new Error('gemwallet_unavailable');

      // Prefer submitTransaction / signAndSubmit
      if (typeof w.submitTransaction === 'function') {
        const res = await w.submitTransaction({ transaction: tx_json, options: { autofill:true, submit:true } });
        const h = res?.result?.hash || res?.hash; if (h) return h;
      }
      if (typeof w.signAndSubmit === 'function') {
        const res = await w.signAndSubmit(tx_json, { autofill:true });
        const h = res?.result?.hash || res?.hash; if (h) return h;
      }

      // Fallback: sign only then local submit
      if (typeof w.sign === 'function') {
        const signed = await w.sign(tx_json, { autofill:true });
        const blob = signed?.result?.tx_blob || signed?.tx_blob || signed?.signedTransaction || signed?.blob;
        if (!blob) throw new Error('gemwallet_sign_failed_no_blob');
        return submitBlob(blob);
      }
      if (typeof w.request === 'function') {
        try {
          const res = await w.request({ method:'signAndSubmit', params:{ tx_json, autofill:true } });
          const h = res?.result?.hash || res?.hash; if (h) return h;
        } catch {}
        const signed = await w.request({ method:'sign', params:{ tx_json, autofill:true } });
        const blob = signed?.result?.tx_blob || signed?.tx_blob || signed?.signedTransaction || signed?.blob;
        if (!blob) throw new Error('gemwallet_sign_failed_no_blob');
        return submitBlob(blob);
      }
      throw new Error('gemwallet_api_unavailable');
    }
  };

  // ---------------------------------------------------------------
  // Xaman (optional bridge you included)
  // ---------------------------------------------------------------
  const XamanSigner = {
    id: 'xaman',
    available() { return !!window.XamanBridge; },
    async address() {
      try { const a = localStorage.getItem('WALLET'); return isClassic(a) ? a : ''; } catch { return ''; }
    },
    async signAndSubmit(tx_json) {
      const out = await window.XamanBridge.signTxViaPayload(tx_json);
      if (!out?.hash) throw new Error('xaman_sign_failed');
      return out.hash;
    }
  };

  // Preferred order: WC (if session), Crossmark, Gem, Xaman.
  const registry = [WcSigner, CrossmarkSigner, GemSigner, XamanSigner];

  function getActive(prefer) {
    if (prefer) {
      const pick = registry.find(r => r.id === String(prefer));
      if (pick?.available()) return pick;
    }
    if (WcSigner.available()) return WcSigner;
    if (CrossmarkSigner.available()) return CrossmarkSigner;
    if (GemSigner.available()) return GemSigner;
    if (XamanSigner.available()) return XamanSigner;
    return null;
  }

  async function activeAddress(prefer){
    const s = getActive(prefer);
    if (!s) return '';
    try { return await (typeof s.address === 'function' ? s.address() : s.address); } catch { return ''; }
  }

  return {
    getActive,
    activeAddress,
    adapters: { WcSigner, CrossmarkSigner, GemSigner, XamanSigner }
  };
})();
