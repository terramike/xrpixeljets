// claimJetFuel.js — XRPixel Jets (2025-10-26claim3)
// HOT mode now supports two patterns for IOU payouts:
//  - Sign as ISSUER (recommended): use issuer seed as HOT_SEED (or set ISSUER_SEED).
//  - Sign as HOT wallet (non-issuer): requires trustline + sufficient JFUEL balance on the HOT wallet.
// Also returns clear error codes for trustline/inventory issues.

export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase(); // 'mock' | 'hot' | 'prepare'
  const WSS  = process.env.XRPL_WSS || process.env.NETWORK || 'wss://s.altnet.rippletest.net:51233';

  const CODE_ASCII = process.env.CURRENCY_CODE || process.env.CURRENCY || 'JFUEL';
  const CODE_HEX   = (process.env.CURRENCY_HEX || '').toUpperCase(); // 40-hex optional
  const ISSUER     = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';
  const HOT_SEED   = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';
  const ISSUER_SEED= process.env.ISSUER_SEED || ''; // optional explicit issuer seed

  const isIOU = !!CODE_HEX || (CODE_ASCII && CODE_ASCII.toUpperCase() !== 'XRP');

  const currencyField = () => {
    if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
    if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII.toUpperCase();
    return Buffer.from(CODE_ASCII, 'ascii').toString('hex').padEnd(40,'0').slice(0,40).toUpperCase();
  };
  const SHAPE = (txid=null, txJSON=null) => ({ ok:true, txid, txJSON });

  if (MODE === 'mock') return SHAPE(null, null);

  if (MODE === 'prepare') {
    const tx = isIOU
      ? { TransactionType:'Payment', Account: ISSUER || 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Destination: to,
          Amount:{ currency: currencyField(), issuer: ISSUER, value: String(amount) } }
      : { TransactionType:'Payment', Account:'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Destination: to,
          Amount: String(Math.trunc(Number(amount)*1_000_000)) };
    return SHAPE(null, tx);
  }

  if (MODE !== 'hot') return SHAPE(null, null);

  if (!HOT_SEED && !ISSUER_SEED) throw new Error('hot_wallet_missing');

  const xrpl = await import('xrpl').catch(() => null);
  if (!xrpl) throw new Error('xrpl_not_installed');

  const client = new xrpl.Client(WSS);
  await client.connect();
  try {
    // Choose signer:
    // 1) If ISSUER_SEED provided, sign as issuer (best for IOU).
    // 2) Else sign with HOT_SEED.
    const signer = xrpl.Wallet.fromSeed(ISSUER_SEED || HOT_SEED, { algorithm:'secp256k1' });
    const signerAddr = signer.address;

    const cur = currencyField();

    // --- IOU path ---
    if (isIOU) {
      if (!ISSUER) throw new Error('issuer_missing');

      // Recipient must trust the issuer/currency
      const destLines = await client.request({ method:'account_lines', account: to, ledger_index:'validated' });
      const destHasTL = (destLines?.result?.lines || []).some(l => l.account === ISSUER && (String(l.currency).toUpperCase() === cur));
      if (!destHasTL) throw Object.assign(new Error('trustline_required'), { code:'trustline_required' });

      const signingAsIssuer = (signerAddr === ISSUER);

      if (!signingAsIssuer) {
        // HOT wallet path: ensure it can deliver (trustline + balance >= amount)
        const hotLines = await client.request({ method:'account_lines', account: signerAddr, ledger_index:'validated' });
        const hotTL = (hotLines?.result?.lines || []).find(l => l.account === ISSUER && (String(l.currency).toUpperCase() === cur));
        if (!hotTL) throw Object.assign(new Error('hot_wallet_needs_trustline'), { code:'hot_wallet_needs_trustline' });

        const bal = Number(hotTL.balance || 0); // holder balance in IOU units
        if (!Number.isFinite(bal) || bal < Number(amount)) {
          throw Object.assign(new Error('hot_wallet_no_inventory'), { code:'hot_wallet_no_inventory' });
        }
      }

      const tx = await client.autofill({
        TransactionType: 'Payment',
        Account: signerAddr,       // issuer or hot wallet
        Destination: to,
        Amount: { currency: cur, issuer: ISSUER, value: String(amount) },
        Flags: 0
      });

      const { tx_blob } = signer.sign(tx);
      const sub = await client.submitAndWait(tx_blob);
      const txid = sub?.result?.hash || sub?.result?.tx_json?.hash || null;
      return SHAPE(txid, null);
    }

    // --- XRP path ---
    const tx = await client.autofill({
      TransactionType: 'Payment',
      Account: signerAddr,
      Destination: to,
      Amount: xrpl.xrpToDrops(String(amount)),
      Flags: 0
    });
    const { tx_blob } = signer.sign(tx);
    const sub = await client.submitAndWait(tx_blob);
    const txid = sub?.result?.hash || sub?.result?.tx_json?.hash || null;
    return SHAPE(txid, null);
  } finally {
    try { await client.disconnect(); } catch {}
  }
}
