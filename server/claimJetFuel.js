// claimJetFuel.js — XRPixel Jets claim helper (2025-10-25claim1)
// Modes via env TOKEN_MODE: 'mock' (default), 'hot' (server signs & submits), 'prepare' (debug only)
// IOU (issuer token) or native XRP supported.
// For IOU, we optionally enforce a trustline check before sending.

export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase();
  const NETWORK = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
  const CURRENCY_HEX = process.env.CURRENCY_HEX || null; // 160-bit hex for IOU, else native XRP
  const CURRENCY_CODE = process.env.CURRENCY_CODE || 'JFUEL';
  const ISSUER_ADDR   = process.env.ISSUER_ADDR || null; // required for IOU
  const HOT_SEED      = process.env.HOT_SEED || null;

  // Always return this shape.
  const SHAPE = (txid=null, txJSON=null) => ({ txid, txJSON });

  if (MODE === 'mock') return SHAPE(null, null);

  // NOTE: 'prepare' is informational only; issuer-signed Payment cannot be signed by the user.
  if (MODE === 'prepare') {
    const tx = (CURRENCY_HEX && ISSUER_ADDR)
      ? {
          TransactionType: 'Payment',
          Account: ISSUER_ADDR,
          Destination: to,
          Amount: { currency: CURRENCY_HEX, issuer: ISSUER_ADDR, value: String(amount) },
        }
      : {
          TransactionType: 'Payment',
          Account: ISSUER_ADDR || 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
          Destination: to,
          Amount: String(Math.trunc(Number(amount) * 1_000_000)), // drops
        };
    return SHAPE(null, tx);
  }

  if (MODE === 'hot') {
    if (!HOT_SEED) throw new Error('HOT_SEED missing');
    const xrpl = await import('xrpl').catch(() => null);
    if (!xrpl) throw new Error('xrpl library not installed');

    const client = new xrpl.Client(NETWORK);
    await client.connect();

    try {
      const wallet = xrpl.Wallet.fromSeed(HOT_SEED); // secp256k1 seed preferred

      // If IOU, ensure trustline exists on 'to'
      if (CURRENCY_HEX && ISSUER_ADDR) {
        const lines = await client.request({ method:'account_lines', account: to, ledger_index:'validated' });
        const hasLine = (lines?.result?.lines || []).some(
          l => String(l.account)===ISSUER_ADDR && (String(l.currency).toUpperCase()===String(CURRENCY_CODE).toUpperCase() || String(l.currency)===CURRENCY_HEX)
        );
        if (!hasLine) throw Object.assign(new Error('trustline_required'), { code:'trustline_required' });
      }

      const tx = (CURRENCY_HEX && ISSUER_ADDR)
        ? {
            TransactionType: 'Payment',
            Account: wallet.address,
            Destination: to,
            Amount: { currency: CURRENCY_HEX, issuer: ISSUER_ADDR, value: String(amount) },
          }
        : {
            TransactionType: 'Payment',
            Account: wallet.address,
            Destination: to,
            Amount: String(Math.trunc(Number(amount) * 1_000_000)), // drops (XRP)
          };

      const prepared = await client.autofill(tx);
      const signed = wallet.sign(prepared);
      const sub = await client.submitAndWait(signed.tx_blob);

      const txid = sub?.result?.hash || signed.hash || null;
      return SHAPE(txid, null);
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }

  // Fallback
  return SHAPE(null, null);
}
