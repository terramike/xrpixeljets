// /jets/js/auth-claim.js — trustline guard (2025-10-26v2-guard)
import { sessionStart, sessionVerify, setAuthToken, claimStart } from '/jets/js/serverApi.js';

(function () {
  const W = window.XRPLWallet || {};
  const API_BASE = window.JETS_API_BASE || 'https://xrpixeljets.onrender.com';

  let CFG = { tokenMode:'mock', network:'', currencyCode:'JFUEL', currencyHex:null, issuer:null };

  async function loadConfig(){
    try {
      const res = await fetch(`${API_BASE}/config`).then(r=>r.json());
      CFG = { ...CFG, ...res };
      window.TOKEN_MODE = CFG.tokenMode;
      window.XRPL_NET = CFG.network;
      window.CURRENCY_CODE = CFG.currencyCode;
      window.CURRENCY_HEX  = CFG.currencyHex;
      window.ISSUER_ADDR   = CFG.issuer;
    } catch {
      // Hard fail closed: without config, do NOT allow Set Trustline
      CFG = { tokenMode:'mock', network:'', currencyCode:'JFUEL', currencyHex:null, issuer:null, _blocked:true };
    }
  }

  function hud(m){ (W.hud || console.log)(`[auth] ${m}`); }
  function qs(id){ return document.getElementById(id); }
  function status(msg, html=false){ const el=qs('claim-status')||qs('session-status')||qs('status'); if(!el) return; html? el.innerHTML=msg : el.textContent=msg; }

  async function doSignIn(){
    try{
      const addrInput = qs('xrpl-address'); const address=(addrInput?.value||'').trim();
      const a = address && address.startsWith('r') ? address : (W.getClassicAddress? await W.getClassicAddress(): '');
      if (!a) throw new Error('No wallet');
      const { nonce } = await sessionStart(a);
      const scope='play,upgrade,claim'; const ts=Math.floor(Date.now()/1000);
      const payload=`${nonce}||${scope}||${ts}||${a}`;
      const hex = W.utf8ToHex ? W.utf8ToHex(payload) : Array.from(new TextEncoder().encode(payload)).map(b=>b.toString(16).padStart(2,'0')).join('');
      const sig = (W.signMessageHexClassic)
        ? await W.signMessageHexClassic({ address:a, hex })
        : (W.signMessageClassic ? await W.signMessageClassic(a, payload) : null);
      if (!sig || !sig.signature || !sig.publicKey) throw new Error('Sign failed');
      const v = await sessionVerify({ address:a, signature:sig.signature, publicKey:sig.publicKey, ts, scope, payload, payloadHex:hex });
      if (v?.jwt){ setAuthToken(v.jwt); hud('Signed in (JWT stored).'); status('Signed in.'); return true; }
      throw new Error('No JWT');
    } catch(e){ hud(`Sign-in failed: ${e.message||e}`); status('Sign-in failed'); return false; }
  }

  function confirmClaim({ amount, address }){
    const mode=(CFG.tokenMode||'mock').toLowerCase();
    const lines=[
      `Claim JetFuel`,
      `Amount: ${amount}`,
      `To: ${address}`,
      `Issuer: ${CFG.issuer||'(missing)'}`,
      `Token: ${CFG.currencyCode}${CFG.currencyHex?` (${CFG.currencyHex.slice(0,8)}…)`:''}`,
      `Mode: ${mode}${mode==='mock'?' (no on-ledger tx)':''}`,
      `Proceed?`
    ];
    return window.confirm(lines.join('\n'));
  }

  async function doClaim(){
    const a = (qs('xrpl-address')?.value||'').trim() || (W.getClassicAddress? await W.getClassicAddress(): '');
    const amt = Math.max(0, Math.trunc(Number((qs('claim-amount')?.value||'').trim()||'0')));
    if (!a) return status('No wallet');
    if (!amt) return status('Enter a positive amount');
    if (!confirmClaim({ amount:amt, address:a })) return status('Claim cancelled');
    try {
      status('Submitting claim…');
      const res = await claimStart(amt);
      if (res?.txid) status(`Claim sent on XRPL: ${res.txid} — <a target="_blank" rel="noopener" href="https://xrpscan.com/tx/${res.txid}">View on explorer</a>`, true);
      else if (res?.txJSON) status('Claim prepared (server not in hot mode).');
      else status('Claim acknowledged (mock mode).');
    } catch(e){
      const msg=String(e?.message||'');
      if (msg.includes('trustline_required')) return status('Trustline required for JFUELv2. Click “Set Trustline” below.');
      if (msg.includes('unauthorized')) return status('JWT expired. Please sign in again.');
      if (msg.includes('server_path_liquidity') || msg.includes('issuer_rippling_disabled')) return status('Issuer rippling misconfigured. Admin check needed.');
      status('Claim failed.');
    }
  }

  function bindTrustlineButton(){
    const btn = qs('btn-add-trustline') || qs('btnSetTrustline') || qs('btn-add-tl');
    if (!btn || btn.__bound) return;
    btn.__bound = true;
    btn.addEventListener('click', async () => {
      if (CFG._blocked) { return status('Config unavailable. Reload and try again.'); }
      const issuer = CFG.issuer;
      const code = CFG.currencyCode;
      const hex  = CFG.currencyHex;

      // Hard guard: only our issuer allowed
      if (!issuer || issuer !== 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e') {
        return status('Issuer mismatch — refusing to set trustline.');
      }

      const confirmText = `Set trustline to ${code} (${hex?.slice(0,8)}…) issued by ${issuer}?\n\nType: I TRUST ${issuer.slice(0,6)} to continue.`;
      const ok = window.prompt(confirmText, '');
      if (ok !== `I TRUST ${issuer.slice(0,6)}`) return status('Cancelled.');

      try {
        await (W.createTrustline?.({
          issuer,
          currencyCode: code,
          currencyHex: hex,
          limit: '10000000'
        }));
        status('Trustline set. You can claim now.');
      } catch(e) {
        status(`Trustline error: ${e.message||e}`);
      }
    }, { passive:true });
  }

  async function init(){
    await loadConfig();
    bindTrustlineButton();

    const btnLogin = document.getElementById('btn-login') || document.getElementById('btn-connect') || document.getElementById('btn-sign');
    if (btnLogin && !btnLogin.__bound){
      btnLogin.__bound = true;
      btnLogin.addEventListener('click', doSignIn, { passive:true });
    }

    const btnClaim = document.getElementById('btn-claim') || document.getElementById('btn-claim-jfuel') || document.getElementById('claim');
    if (btnClaim && !btnClaim.__bound){
      btnClaim.__bound = true;
      btnClaim.addEventListener('click', async () => {
        let hasJwt = !!(localStorage.getItem('JWT')||'').trim();
        if (!hasJwt) hasJwt = await doSignIn();
        if (hasJwt) await doClaim();
      }, { passive:true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
