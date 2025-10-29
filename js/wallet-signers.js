// /jets/js/wallet-signers.js — Crossmark + GemWallet message signer (2025-10-25m)
// Robust Crossmark support: tries multiple APIs and deep-extracts signature/publicKey.

const asciiToHex = (s) => Array.from(s, ch => ch.charCodeAt(0).toString(16).padStart(2,'0')).join('');

(function attachSigners(g) {
  const XRPLWallet = (g.XRPLWallet = g.XRPLWallet || {});
  const cmRoot = () => g.crossmark || g.xrpl?.crossmark;

  function setCurrentWallet(addr) {
    try { localStorage.setItem('WALLET', addr); } catch {}
    g.CURRENT_WALLET = addr;
    const inp = document.getElementById('xrpl-address'); if (inp) inp.value = addr;
    const label = document.getElementById('session-status'); if (label) label.textContent = addr ? `Connected: ${addr}` : 'Not connected';
  }

  function deepExtractSigKey(obj) {
    let signature = null, publicKey = null, address = null;
    const seen = new Set();
    function walk(o, depth = 0) {
      if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return;
      seen.add(o);
      if (!signature && typeof o.signature === 'string') signature = o.signature;
      if (!publicKey && typeof o.publicKey === 'string') publicKey = o.publicKey;
      if (!address && typeof o.address === 'string' && o.address.startsWith('r')) address = o.address;
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (v && typeof v === 'object') walk(v, depth + 1);
      }
    }
    walk(obj);
    return { signature, publicKey, address };
  }

  async function ensureCrossmarkAddress() {
    const cm = cmRoot();
    if (!cm) throw new Error('Crossmark not detected');
    try { await cm.async?.connect?.(250); } catch {}
    if (!cm.session?.address) { try { await cm.async?.signInAndWait?.(); } catch {} }
    const addr = cm.session?.address || cm.address;
    if (!addr) throw new Error('Crossmark did not provide an address');
    setCurrentWallet(addr);
    return addr;
  }

  async function crossmarkSignMessageHex(hexPayload) {
    const cm = cmRoot();
    if (!cm) throw new Error('Crossmark not detected');

    const tries = [];
    // Try the most common shapes in order:
    tries.push(() => cm.signMessage?.(hexPayload));
    tries.push(() => cm.signMessage?.({ hex: hexPayload }));
    tries.push(() => cm.async?.signMessage?.({ hex: hexPayload }));
    // Fallback: signInAndWait can return a signedMessage structure
    tries.push(() => cm.async?.signInAndWait?.(hexPayload));
    tries.push(() => cm.async?.signInAndWait?.({ hex: hexPayload }));

    let resp = null;
    for (const t of tries) {
      try {
        const r = await t?.();
        if (r) { resp = r.response || r; break; }
      } catch {}
    }
    // One more hail-mary: some builds expose a generic request
    if (!resp && typeof cm.request === 'function') {
      try { resp = await cm.request({ method: 'signMessage', hex: hexPayload }); } catch {}
    }
    if (!resp) throw new Error('Crossmark did not return a signature');

    const { signature, publicKey, address } = deepExtractSigKey(resp);
    if (!signature) throw new Error('Crossmark did not return a signature');
    if (address) setCurrentWallet(address);

    return { signature, publicKey, address: address || g.CURRENT_WALLET, payloadHex: hexPayload, provider: 'crossmark' };
  }

  async function gemAddress() {
    const api = g.GemWalletApi || g.gemWallet;
    if (!(await api?.isConnected?.())) throw new Error('GemWallet not connected');
    const a = (await api.getAddress?.())?.address || (await api.request?.('getAddress'))?.result?.classicAddress;
    if (!a) throw new Error('GemWallet address unavailable');
    setCurrentWallet(a);
    return a;
  }
  async function gemSign(ascii) {
    const api = g.GemWalletApi || g.gemWallet;
    const sig = await api?.signMessage?.(ascii);
    if (!sig) throw new Error('GemWallet did not return a signature');
    return { signature: sig, publicKey: null, address: g.CURRENT_WALLET, payloadHex: null, provider: 'gemwallet' };
  }

  XRPLWallet.getClassicAddress = async function () {
    if (cmRoot()) return ensureCrossmarkAddress();
    if (g.GemWalletApi || g.gemWallet) return gemAddress();
    const v = document.getElementById('xrpl-address')?.value?.trim();
    if (v?.startsWith('r')) { setCurrentWallet(v); return v; }
    throw new Error('No supported wallet found (Crossmark/GemWallet) and no r-address provided.');
  };

  XRPLWallet.signMessageClassic = async function (address, asciiMsg) {
    if (cmRoot()) return crossmarkSignMessageHex(asciiToHex(asciiMsg));
    if (g.GemWalletApi || g.gemWallet) return gemSign(asciiMsg);
    throw new Error('signMessageClassic not available (install GemWallet or Crossmark)');
  };
})(window);
