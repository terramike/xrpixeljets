// /jets/js/wallet-modal.js — v2025-01-16-wc-mobile-v1
// Wallet chooser modal with WalletConnect mobile support
(function(){
  const $ = (id) => document.getElementById(id);
  const backdrop = $('wallet-modal');
  const closeBtn = $('wallet-modal-close');

  function open(){ 
    backdrop?.classList?.add('open'); 
    backdrop?.setAttribute('aria-hidden','false'); 
  }
  
  function close(){ 
    backdrop?.classList?.remove('open'); 
    backdrop?.setAttribute('aria-hidden','true'); 
  }

  function wire(){
    // Open modal when "Connect Wallet" button clicked
    const connect = $('btn-connect') || $('btn-sign');
    if (connect && !connect.__b){ 
      connect.__b = 1; 
      connect.addEventListener('click', open); 
    }
    
    // Close button
    if (closeBtn && !closeBtn.__b){ 
      closeBtn.__b = 1; 
      closeBtn.addEventListener('click', close); 
    }
    
    // Click backdrop to close
    if (backdrop && !backdrop.__b){
      backdrop.__b = 1;
      backdrop.addEventListener('click', (e) => { 
        if (e.target === backdrop) close(); 
      });
    }

    // CROSSMARK BUTTON
    const btnXMK = $('wallet-modal-crossmark');
    if (btnXMK && !btnXMK.__b){
      btnXMK.__b = 1;
      btnXMK.addEventListener('click', async () => {
        close();
        
        try {
          console.log('[Modal] Connecting with Crossmark...');
          
          if (!window.crossmark) {
            alert('Crossmark wallet not detected!\n\nPlease install the Crossmark browser extension:\nhttps://crossmark.io');
            return;
          }
          
          const ok = await window.JetsAuth?.signInCrossmark?.();
          
          if (ok) {
            console.log('[Modal] Crossmark connection successful');
          } else {
            console.log('[Modal] Crossmark connection failed or cancelled');
          }
        } catch(e) { 
          console.error('[Modal] Crossmark error:', e);
          alert('Crossmark connection failed: ' + e.message);
        }
      });
    }

    // GEM WALLET BUTTON
    const btnGEM = $('wallet-modal-gem');
    if (btnGEM && !btnGEM.__b){
      btnGEM.__b = 1;
      btnGEM.addEventListener('click', async () => {
        close();
        
        try {
          console.log('[Modal] Connecting with Gem Wallet...');
          
          const ok = await window.JetsAuth?.signInGem?.();
          
          if (ok) {
            console.log('[Modal] Gem Wallet connection successful');
          } else {
            console.log('[Modal] Gem Wallet connection failed or cancelled');
          }
        } catch(e) { 
          console.error('[Modal] Gem Wallet error:', e);
          alert('Gem Wallet connection failed: ' + e.message);
        }
      });
    }

    // WALLETCONNECT BUTTON - Direct integration (not via btn-wc-connect click)
    const btnWC = $('wallet-modal-wc');
    if (btnWC && !btnWC.__b){
      btnWC.__b = 1;
      btnWC.addEventListener('click', async () => {
        close();
        
        console.log('[Modal] Starting WalletConnect...');
        
        try {
          // Check if XRPLWallet WC functions are available
          const XRPLWallet = window.XRPLWallet;
          
          if (!XRPLWallet) {
            console.error('[Modal] XRPLWallet not found on window');
            alert('WalletConnect module not loaded.\n\nPlease refresh the page and try again.');
            return;
          }
          
          // Initialize WC if not already done
          if (!XRPLWallet.wcIsInitialized?.() && !XRPLWallet.wcHasSession?.()) {
            const projectId = window.WC_PROJECT_ID;
            if (!projectId) {
              console.error('[Modal] WC_PROJECT_ID not set');
              alert('WalletConnect configuration missing.\n\nPlease contact support.');
              return;
            }
            
            console.log('[Modal] Initializing WalletConnect with projectId:', projectId);
            await XRPLWallet.wcInit({ projectId });
          }
          
          // Check for existing session
          if (XRPLWallet.wcHasSession?.()) {
            const addr = XRPLWallet.wcGetAddress?.();
            if (addr) {
              console.log('[Modal] Already connected:', addr);
              // Dispatch auth event to refresh UI
              window.dispatchEvent(new CustomEvent('jets:auth', { detail: { address: addr } }));
              return;
            }
          }
          
          // Start connection flow
          console.log('[Modal] Starting WC connect flow...');
          const address = await XRPLWallet.wcConnect();
          
          if (address) {
            console.log('[Modal] WalletConnect connected:', address);
          } else {
            console.log('[Modal] WalletConnect cancelled or failed');
          }
          
        } catch(e) {
          console.error('[Modal] WalletConnect error:', e);
          
          // User-friendly error messages
          if (e.message?.includes('user_cancelled')) {
            console.log('[Modal] User cancelled WC connection');
          } else if (e.message?.includes('wc_deps_missing')) {
            alert('WalletConnect failed to load.\n\nPlease check your internet connection and refresh.');
          } else if (e.message?.includes('wc_projectId_missing')) {
            alert('WalletConnect not configured.\n\nPlease contact support.');
          } else {
            alert('WalletConnect error: ' + (e.message || 'Unknown error'));
          }
        }
      });
    }

    // XAMAN BUTTON (Coming Soon)
    const btnXaman = $('wallet-modal-xaman');
    if (btnXaman && !btnXaman.__b) {
      btnXaman.__b = 1;
      // Keep disabled, but add click handler for feedback
      btnXaman.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('[Modal] Xaman coming soon');
      });
    }
  }

  // Initial wire
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire, { once: true });
  } else {
    wire();
  }

  // Re-wire on DOM changes (in case modal is added dynamically)
  const observer = new MutationObserver(() => {
    if ($('wallet-modal') && !$('wallet-modal').__b) {
      wire();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  console.log('[Modal] wallet-modal.js loaded (v2025-01-16-wc-mobile-v1)');
})();