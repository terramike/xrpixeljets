// /jets/js/signers.gemwallet.js  (v2025-12-18-g1)
import { Signers } from './signers.js';

// Defensive detection across historical window names
function gw() {
  return window.gemWallet || window.GemWalletApi || window.gemwallet || null;
}

const GemSigner = {
  key: 'gemwallet',
  name: 'GemWallet',

  available() {
    const w = gw();
    return !!(w && typeof w.getAddress === 'function');
  },

  async address() {
    const w = gw();
    const res = await w.getAddress();
    // Newer APIs return { type, result: { address } }; older builds may return a string
    return res?.result?.address || res?.address || res || null;
  },

  // Optional: helpful if you later use GemWallet for login proofs
  async signMessageHexClassic({ messageHex }) {
    const w = gw();
    // API expects message string and format flag
    // See "signMessage" in GemWallet API reference.
    const res = await w.signMessage({ message: messageHex, isHex: true });
    return {
      signature: res?.result?.signedMessage || res?.signedMessage,
      publicKey: res?.result?.publicKey || res?.publicKey,
    };
  },

  // Used by your claim flow
  async signAndSubmit(tx_json) {
    const w = gw();
    // Raw transaction path; GemWallet autofills & submits
    // Returns { type, result: { hash } } on success.
    const res = await w.submitTransaction({
      transaction: tx_json,
      options: { autofill: true, submit: true }
    });
    return res?.result?.hash || res?.hash || null;
  }
};

// Register with your existing Signers registry
Signers.register(GemSigner);
export default GemSigner;
