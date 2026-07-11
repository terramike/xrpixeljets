// /jets/js/auth-gem-sdk.js - v2025-12-20-sdk
// Gem Wallet integration using official @gemwallet/api SDK
// Load SDK from CDN before this script

import { sessionStart, sessionVerify, setAuthToken } from './serverApi.js?v=2025-12-20x8';

(function() {
  const log = (msg) => console.log('[Gem]', msg);

  // Check if Gem Wallet SDK is loaded
  function hasGemSDK() {
    return window.GemWalletAPI || window.isGemWalletInstalled || false;
  }

  // Dynamically load Gem Wallet SDK
  async function loadGemSDK() {
    if (window.GemWalletAPI) {
      log('SDK already loaded');
      return true;
    }

    log('Loading Gem Wallet SDK from CDN...');

    return new Promise((resolve) => {
      const script = document.createElement('script');
      // Correct path: @gemwallet/api exports ES modules, not UMD
      // Use the browser-compatible dist file
      script.src = 'https://unpkg.com/@gemwallet/api@3.7.0/dist/browser/index.js';
      script.type = 'module';

      script.onload = () => {
        log('SDK loaded successfully');
        // The SDK exports functions, not a global object
        // We'll import them dynamically
        resolve(true);
      };

      script.onerror = () => {
        log('SDK failed to load, trying ESM import...');

        // Try dynamic import instead
        import('https://unpkg.com/@gemwallet/api@3.7.0/dist/browser/index.js')
          .then(module => {
            log('SDK loaded via ESM import');
            // Store the module methods
            window.GemWalletAPI = module;
            resolve(true);
          })
          .catch(err => {
            log('ESM import failed:', err.message);
            log('Trying jsdelivr fallback...');

            import('https://cdn.jsdelivr.net/npm/@gemwallet/api@3.7.0/+esm')
              .then(module => {
                log('SDK loaded from jsdelivr');
                window.GemWalletAPI = module;
                resolve(true);
              })
              .catch(err2 => {
                log('All SDK load attempts failed');
                resolve(false);
              });
          });
      };

      document.head.appendChild(script);
    });
  }

  // Hex conversion
  function toHex(str) {
    return Array.from(new TextEncoder().encode(str))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  // Sign in with Gem Wallet
  async function signInGem() {
    try {
      log('Starting Gem Wallet login...');

      // 0. Security checks
      if (!window.isSecureContext) {
        throw new Error('Gem Wallet requires HTTPS. Please access the site via https://');
      }

      // 1. Load SDK if not already loaded
      const sdkLoaded = await loadGemSDK();
      if (!sdkLoaded) {
        throw new Error('Gem Wallet SDK failed to load. Check internet connection.');
      }

      log('Gem Wallet SDK loaded');

      // Wait for content script to initialize
      // CRITICAL: Need more time after fresh SDK load
      log('Waiting for Gem Wallet content script to initialize...');
      await new Promise(r => setTimeout(r, 2000)); // Increased to 2 seconds

      // 2. Import methods from SDK
      const { getAddress, signTransaction, isInstalled } = window.GemWalletAPI;

      if (!getAddress || !signTransaction || !isInstalled) {
        log('Available API:', Object.keys(window.GemWalletAPI));
        throw new Error('Gem Wallet API methods not available');
      }

      // 3. CRITICAL: Check if installed first!
      // This primes the extension connection
      log('Checking if Gem Wallet is installed...');
      const installCheck = await isInstalled();
      log('Install check result:', installCheck);

      if (!installCheck?.result?.isInstalled) {
        throw new Error('Gem Wallet extension not detected. Please install from https://gemwallet.app');
      }

      log('✅ Gem Wallet confirmed installed');

      // 4. Now get address (this should work after isInstalled)
      log('Requesting address from Gem Wallet...');
      log('(Popup will appear - please approve)');

      const addressResponse = await getAddress();

      log('Address response:', addressResponse);

      if (!addressResponse || addressResponse.type === 'reject') {
        throw new Error('User rejected address request');
      }

      const address = addressResponse.result?.address;

      if (!address || !address.startsWith('r')) {
        log('Invalid response:', addressResponse);
        throw new Error('Invalid address from Gem Wallet');
      }

      log('✅ Address received:', address);

      // 5. Get nonce from server
      log('Getting nonce from server...');
      const { nonce } = await sessionStart(address);
      log('Nonce: ' + nonce);

      // 6. Build message to sign (use server's txProof format)
      const scope = 'play,upgrade,claim,bazaar';
      const ts = Math.floor(Date.now() / 1000);
      // Server's txProof path expects: XRPixelJets|nonce|scope|ts
      const message = `XRPixelJets|${nonce}|${scope}|${ts}`;
      const messageHex = toHex(message);

      log('Message: ' + message);
      log('Message hex: ' + messageHex);

      // 7. Sign with transaction (use server's txProof format)
      log('Creating AccountSet transaction for signing...');

      // Don't need MemoType, server just checks MemoData
      const loginTx = {
        TransactionType: 'AccountSet',
        Account: address,
        Memos: [{
          Memo: {
            MemoData: messageHex  // Server expects: XRPixelJets|nonce|scope|ts
          }
        }]
      };

      log('Requesting signature via signTransaction...');

      const signResponse = await signTransaction({ transaction: loginTx });

      log('Sign response type: ' + signResponse.type);

      if (!signResponse || signResponse.type === 'reject') {
        throw new Error('User rejected signature request');
      }

      const tx_blob = signResponse.result?.signature;

      if (!tx_blob) {
        log('Full response: ' + JSON.stringify(signResponse, null, 2));
        throw new Error('No signature in response');
      }

      log('✅ Transaction signed, tx_blob: ' + tx_blob.slice(0, 50) + '...');

      // Extract publicKey from tx_blob for server validation
      log('Extracting publicKey from transaction...');
      let publicKey = null;

      try {
        if (typeof window.xrpl !== 'undefined' && window.xrpl.decode) {
          const decoded = window.xrpl.decode(tx_blob);
          publicKey = decoded.SigningPubKey;
          log('Extracted publicKey: ' + publicKey);
        } else {
          // Manual extraction: look for 0x7321 prefix (SigningPubKey field)
          const pubKeyIndex = tx_blob.indexOf('7321');
          if (pubKeyIndex !== -1) {
            publicKey = tx_blob.substr(pubKeyIndex + 4, 66);
            log('Extracted publicKey (manual): ' + publicKey);
          }
        }
      } catch (e) {
        log('Could not extract publicKey: ' + e.message);
      }

      if (!publicKey) {
        throw new Error('Could not extract publicKey from transaction');
      }

      // 8. Send to server using txProof (server already has perfect code for this!)
      log('Sending tx_blob to server via txProof parameter...');

      const verifyRes = await sessionVerify({
        address,
        signature: 'txproof',  // Dummy value to pass client validation
        publicKey,  // Real publicKey from transaction to pass server validation
        scope,
        ts,
        txProof: { tx_blob }  // Server will use this instead
      });

      if (!verifyRes?.jwt) {
        throw new Error('No JWT from server');
      }

      //9. Store JWT and wallet
      setAuthToken(verifyRes.jwt);

      try {
        localStorage.setItem('WALLET', address);
      } catch {}

      window.CURRENT_WALLET = address;

      // 10. Update UI
      const inp = document.getElementById('xrpl-address');
      if (inp) inp.value = address;

      const status = document.getElementById('session-status');
      if (status) status.textContent = `Connected: ${address}`;

      // 11. Fire auth event for accessories/NFTs
      window.dispatchEvent(new CustomEvent('jets:auth', {
        detail: { address, authed: true }
      }));

      log('✓ Signed in successfully!');

      return true;

    } catch (error) {
      log('✗ Sign-in failed:', error.message);
      console.error('[Gem Error]', error);

      // User-friendly error messages
      if (error.message.includes('not installed')) {
        alert('Gem Wallet Not Installed\n\nPlease install the Gem Wallet browser extension:\nhttps://gemwallet.app');
      } else if (error.message.includes('reject')) {
        alert('Request Rejected\n\nYou cancelled the request in Gem Wallet.');
      } else if (error.message.includes('SDK failed')) {
        alert('Connection Error\n\nCouldn\'t load Gem Wallet SDK. Check your internet connection.');
      } else {
        alert('Gem Wallet Error\n\n' + error.message);
      }

      return false;
    }
  }

  // Expose for modal/other scripts
  window.JetsAuth = window.JetsAuth || {};
  window.JetsAuth.signInGem = signInGem;

  // Pre-load SDK on page load to avoid timing issues
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      log('Pre-loading Gem Wallet SDK...');
      loadGemSDK().then(loaded => {
        if (loaded) {
          log('SDK pre-loaded successfully, ready for login');
        }
      });
    });
  } else {
    // Page already loaded
    log('Pre-loading Gem Wallet SDK...');
    loadGemSDK().then(loaded => {
      if (loaded) {
        log('SDK pre-loaded successfully, ready for login');
      }
    });
  }

  log('Gem Wallet SDK integration ready');

})();
