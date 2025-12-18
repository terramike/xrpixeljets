// /jets/js/wallet-modal.js — explicit provider buttons, no pre-detection
// v=2025-12-18-simplogin5
(function(){
  const $ = (id)=>document.getElementById(id);
  const root = $('wallet-modal');
  const closeBtn = $('wallet-modal-close');

  function open(){ root?.classList?.add('open'); root?.setAttribute('aria-hidden','false'); }
  function close(){ root?.classList?.remove('open'); root?.setAttribute('aria-hidden','true'); }

  function wire(){
    // Openers: prefer #btn-connect; fall back to #btn-sign if present
    const opener = $('btn-connect') || $('btn-sign');
    if (opener && !opener.__b){ opener.__b = 1; opener.addEventListener('click', open); }

    if (closeBtn && !closeBtn.__b){ closeBtn.__b = 1; closeBtn.addEventListener('click', close); }
    if (root && !root.__b){
      root.__b = 1;
      root.addEventListener('click', (e)=>{ if (e.target === root) close(); });
    }

    // Distinct providers: call JetsAuth directly (no detection)
    const btnX = $('wallet-modal-crossmark');
    const btnG = $('wallet-modal-gem');
    const btnW = $('wallet-modal-wc');

    if (btnX && !btnX.__b){
      btnX.__b = 1;
      btnX.addEventListener('click', async ()=>{
        await window.JetsAuth?.signIn('crossmark');
        close();
      });
    }
    if (btnG && !btnG.__b){
      btnG.__b = 1;
      btnG.addEventListener('click', async ()=>{
        await window.JetsAuth?.signIn('gem');
        close();
      });
    }
    if (btnW && !btnW.__b){
      btnW.__b = 1;
      btnW.addEventListener('click', ()=>{
        // re-use existing WC connector button to show the QR/deeplink
        document.getElementById('btn-wc-connect')?.click?.();
        close();
      });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, { once:true });
  else wire();
})();
