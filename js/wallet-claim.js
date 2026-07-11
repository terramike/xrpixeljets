// /jets/js/wallet-claim.js – 2025-12-20-ULTRA-SIMPLE-FIX
// CRITICAL FIX: Confirmation happens FIRST, before ANY async operations
import { Signers } from './signers.js';

(function setup(g){
  'use strict';

  const ISSUER  = g.ISSUER_ADDR || 'rHz5qqAo57UnEsrMtw5croE4WnK3Z3J52e';
  const CURRENCY_HEX = g.CURRENCY_HEX || '4A45545300000000000000000000000000000000';
  const XRPL_WSS = g.XRPL_WSS || 'wss://xrplcluster.com';
  const CLAIM_FEE_BPS = 1500; // 15%

  const $ = (id) => document.getElementById(id);
  const hud = (m) => {
    console.log('[Claim]', m);
    const el = $('log'); if (!el) return;
    const d = document.createElement('div'); d.className='log-line'; d.textContent=String(m);
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  };

  let CLAIMING = false;

  async function ensureTrustline(addr){
    try{
      if (!g.xrpl) return true;
      const api = new g.xrpl.Client(XRPL_WSS);
      await api.connect();
      const lines = await api.request({ command:'account_lines', account: addr, ledger_index:'validated' });
      await api.disconnect();
      const has = (lines?.result?.lines || []).some(l => l.account === ISSUER && (l.currency === CURRENCY_HEX || l.currency === 'JETS'));
      if (!has) hud('⚠️ No JETS trustline. Use Set Trustline before claiming.');
      return has;
    } catch {
      hud('⚠️ Trustline check skipped (network hiccup).');
      return true;
    }
  }

  function getAmount() {
    const v = Number(($('claim-amount')?.value || '0').trim());
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  
  function getCurrentJetFuel() {
    const el = $('jetfuel');
    if (!el) return 0;
    const text = el.textContent || '0';
    return parseInt(text.replace(/,/g, ''), 10) || 0;
  }

  async function fetchJsonOrError(r){
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) {
      const err = (body && (body.error || body.message)) ? `${body.error}${body.detail? ' '+JSON.stringify(body.detail):''}` : `http_${r.status}`;
      const e = new Error(err);
      e.status = r.status;
      e.body = body;
      throw e;
    }
    return body;
  }

  async function fetchClaimStart(amount, token, wallet){
    const base = g.JETS_API_BASE || '';
    const r = await fetch(`${base}/claim/start`, {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        'Authorization': token ? `Bearer ${token}` : '',
        'X-Wallet': (wallet || '').trim()
      },
      body: JSON.stringify({ amount })
    });
    return fetchJsonOrError(r);
  }

  // WRAPPER FUNCTION: Shows confirmation IMMEDIATELY, then processes async
  async function claim(prefer) {
    const callTime = Date.now();
    console.log(`[Claim] claim() called at ${callTime}, prefer=${prefer}, CLAIMING=${CLAIMING}`);
    
    // STEP 1: Check if already claiming (synchronous)
    if (CLAIMING) {
      hud('⏳ Claim already in progress, please wait...');
      console.log(`[Claim] BLOCKED: Already claiming`);
      return;
    }

    // STEP 2: Get amount (synchronous)
    const amount = getAmount();
    console.log(`[Claim] Amount from input: ${amount}`);
    if (!amount) { 
      hud('❌ Enter a valid claim amount.'); 
      return; 
    }

    // STEP 3: Check balance (synchronous)
    const currentBalance = getCurrentJetFuel();
    console.log(`[Claim] Current balance: ${currentBalance} JF, claiming: ${amount} JF`);
    if (amount > currentBalance) {
      alert(`❌ Insufficient JetFuel!\n\nYou have: ${currentBalance.toLocaleString()} JF\nYou're trying to claim: ${amount.toLocaleString()} JF`);
      hud(`❌ Insufficient JetFuel (have: ${currentBalance}, need: ${amount})`);
      return;
    }

    // STEP 4: Calculate fee (synchronous)
    const fee = Math.floor((amount * CLAIM_FEE_BPS) / 10000);
    const net = amount - fee;
    const remaining = currentBalance - amount;

    // STEP 5: SHOW CONFIRMATION IMMEDIATELY (synchronous, blocks execution)
    const message = `
╔════════════════════════════════════════╗
║     🎮 CLAIM JETFUEL → JETS TOKEN      ║
╚════════════════════════════════════════╝

📊 CLAIM DETAILS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  JetFuel to Spend:     ${amount.toLocaleString()} JF
  Claim Fee (15%):      ${fee.toLocaleString()} JF (burned)
  JETS You'll Receive:  ${net.toLocaleString()} JETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💰 YOUR BALANCE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Current JetFuel:      ${currentBalance.toLocaleString()} JF
  After Claim:          ${remaining.toLocaleString()} JF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  IMPORTANT:
  • You need a JETS trustline to receive tokens
  • Claim fee is burned (not refundable)
  • Max 15,000 JF can be claimed per 24 hours

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Do you want to proceed with this claim?
    `.trim();
    
    // THIS BLOCKS - nothing happens until user clicks OK or Cancel
    const confirmed = confirm(message);
    
    if (!confirmed) {
      hud('❌ Claim cancelled by user.');
      return; // User clicked Cancel - STOP HERE
    }

    // STEP 6: User clicked OK - NOW start async processing
    // Lock the button so they can't click again
    CLAIMING = true;
    hud('✅ Claim confirmed by user, processing...');

    try {
      // Now get wallet address (try Signers first, fallback to localStorage)
      let addr = null;
      let which = 'unknown';
      
      const signer = Signers.getActive(prefer);
      if (signer) {
        try {
          addr = (await signer.address() || '').trim();
          which = signer?.id || 'unknown';
        } catch (e) {
          hud(`⚠️ Signer error: ${e.message}, trying localStorage...`);
        }
      }
      
      // Fallback: Get address from localStorage or CURRENT_WALLET global
      if (!addr) {
        addr = g.CURRENT_WALLET || (localStorage.getItem('WALLET') || '').trim();
        which = 'localStorage';
        
        if (!addr) {
          // Last resort: check xrpl-address input field
          const inp = $('xrpl-address');
          if (inp && inp.value && inp.value.startsWith('r')) {
            addr = inp.value.trim();
            which = 'input-field';
          }
        }
      }
      
      hud(`Using wallet: ${which}, address: ${addr || '(none)'}`);
      
      if (!addr || !addr.startsWith('r')) { 
        hud('❌ Could not resolve address from wallet.'); 
        hud('💡 Try refreshing the page or reconnecting your wallet.');
        return; 
      }

      // Check trustline
      const okTL = await ensureTrustline(addr);
      if (!okTL) {
        g.dispatchEvent(new CustomEvent('jets:trustline_required', { detail: { address: addr } }));
        return;
      }

      // Check JWT
      const token = (localStorage.getItem('JWT') || '').trim();
      if (!token) { 
        hud('❌ Not signed in. Click "Sign In" first to get a JWT.'); 
        return; 
      }

      hud(`Sending claim request for ${amount} JF...`);
      
      // Send claim request
      const res = await fetchClaimStart(amount, token, addr);

      // SUCCESS CASE
      if (res?.txid || (typeof res?.amount === 'number' && typeof res?.net === 'number')) {
        const actualFee = res.fee || fee;
        const actualNet = res.net || net;
        const fullTxHash = res.txid || '(no hash)';
        
        hud(`✅ CLAIM SUCCESSFUL!`);
        if (res.txid) {
          hud(`✅ TX Hash: ${fullTxHash}`);
          hud(`✅ Explorer: https://xrpscan.com/tx/${fullTxHash}`);
        }
        hud(`✅ Spent ${res.amount ?? amount} JF → Received ${actualNet} JETS (fee: ${actualFee} JF)`);
        
        // Show success alert
        const successMsg = `
╔════════════════════════════════════════╗
║        ✅ CLAIM SUCCESSFUL!             ║
╚════════════════════════════════════════╝

📊 TRANSACTION DETAILS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  JetFuel Spent:        ${res.amount || amount} JF
  Claim Fee (burned):   ${actualFee} JF
  JETS Received:        ${actualNet} JETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${res.txid ? `🔗 Transaction Hash:\n  ${fullTxHash}\n\n  View on explorer:\n  https://xrpscan.com/tx/${fullTxHash}\n\n  Copy hash: ${fullTxHash}` : ''}
        `.trim();
        
        alert(successMsg);
        
        // Clear input
        const amtInput = $('claim-amount');
        if (amtInput) amtInput.value = '';
        
        // Refresh profile AFTER a delay to avoid race conditions
        hud('Refreshing profile in 2 seconds...');
        setTimeout(async () => {
          try { 
            hud('Fetching updated profile...');
            await g.SrvAPI?.profile?.(); 
            hud('✅ Profile refreshed');
          } catch (e) {
            hud('⚠️ Profile refresh failed: ' + e.message);
          }
        }, 2000);
        
        return;
      }

      // PREPARE MODE (server returns unsigned TX)
      const tx_json = res?.tx_json || res?.result?.tx_json || res?.tx || res?.txJSON || null;
      if (tx_json) {
        const hash = await signer.signAndSubmit(tx_json);
        hud(`✅ Submitted claim: ${hash || '(no hash)'} – waiting for validation…`);
        try { await g.SrvAPI?.profile?.(); } catch {}
        hud('✅ Claim flow complete.');
        return;
      }

      // MOCK MODE
      hud('✅ Claim acknowledged (server in mock/prepare mode).');
      try { await g.SrvAPI?.profile?.(); } catch {}

    } catch (e) {
      const msg = String(e?.message || '');
      const statusCode = Number(e?.status || 0);
      
      // Handle specific errors
      if (msg.includes('unauthorized') || msg.includes('401')) {
        alert('🔐 Session Expired\n\nYour login session has expired.\nPlease sign in again to continue.');
        hud('❌ JWT expired. Please sign in again.');
        const loginBtn = document.getElementById('btn-login') || document.getElementById('btn-sign');
        if (loginBtn) try { loginBtn.click(); } catch {}
        return;
      }
      
      if (msg.includes('insufficient_funds')) {
        const currentBalance = getCurrentJetFuel();
        alert(`❌ Insufficient JetFuel\n\nYour current balance: ${currentBalance} JF\n\nThe server rejected this claim because you don't have enough JetFuel.\n\nThis may have happened because:\n• You claimed very recently and balance hasn't updated\n• Another claim is processing\n\nRefreshing your profile...`);
        hud(`❌ Insufficient JetFuel (server-side check failed)`);
        try { await g.SrvAPI?.profile?.(); } catch {}
        return;
      }
      
      if (msg.includes('cooldown')) {
        alert('⏰ Claim Cooldown Active\n\nYou must wait 5 minutes between claims.\n\nPlease try again in a few minutes.');
        hud('❌ Claim on cooldown (5 minute wait)');
        return;
      }

      if (statusCode === 429 || msg.includes('rate_limited') || msg.includes('http_429')) {
        alert('⏳ Too Many Requests\n\nThe server is receiving requests too quickly.\n\nPlease wait a moment and try again.');
        hud('❌ Claim rate limited; wait a moment and try again');
        return;
      }
      
      if (msg.includes('daily_cap')) {
        alert('🚫 Daily Claim Limit Reached\n\nYou have reached the maximum claim amount for today (15,000 JF per 24 hours).\n\nTry again tomorrow!');
        hud('❌ Daily claim cap reached');
        return;
      }
      
      if (msg.includes('trustline')) {
        alert('⚠️ Trustline Required\n\nYou need to set a JETS trustline before claiming.\n\nUse the "Set Trustline" button to create one.');
        hud('❌ JETS trustline required');
        return;
      }
      
      // Generic error
      alert(`❌ Claim Failed\n\nError: ${msg}\n\nPlease try again or contact support if the issue persists.`);
      hud(`❌ Claim failed: ${msg}`);
      
    } finally {
      CLAIMING = false; // Always unlock
    }
  }

  function wire() {
    const b1 = $('btn-claim');
    const b2 = $('btn-claim-wc');
    const b3 = $('btn-claim-gem');
    
    if (b1 && !b1.__bound){ 
      b1.__bound = true; 
      b1.addEventListener('click', () => claim('crossmark'));
    }
    if (b2 && !b2.__bound){ 
      b2.__bound = true; 
      b2.addEventListener('click', () => claim('walletconnect'));
    }
    if (b3 && !b3.__bound){ 
      b3.__bound = true; 
      b3.addEventListener('click', () => claim('gemwallet'));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once:true });
  } else {
    wire();
  }
})(window);
