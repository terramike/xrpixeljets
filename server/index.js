// server/claimJetFuel.js — XRPixel Jets claim helper (secp256k1; XRPL-first)
// Modes via env TOKEN_MODE: 'mock' (default), 'prepare', 'hot'

export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase();
  const NETWORK = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
  const CURRENCY_HEX = process.env.CURRENCY_HEX || null; // 160-bit hex for IOU, else native XRP
  const CURRENCY_CODE = process.env.CURRENCY_CODE || 'JFUEL';
  const ISSUER_ADDR   = process.env.ISSUER_ADDR || null; // required for IOU
  const HOT_SEED      = process.env.HOT_SEED || null;

  // Always return a stable shape
  if (MODE === 'mock') {
    // pretend success; useful for dev/demo
    return { txid: null, txJSON: null };
  }

  // Prepare unsigned tx for wallet to sign
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
          Account: ISSUER_ADDR || 'r'+'0'.repeat(25), // placeholder
          Destination: to,
          Amount: String(Math.trunc(Number(amount) * 1_000_000)), // drops
        };
    return { txid: null, txJSON: tx };
  }

  // HOT mode (server signs & submits) — requires xrpl lib
  if (MODE === 'hot') {
    if (!HOT_SEED) throw new Error('HOT_SEED missing');
    const xrpl = await import('xrpl').catch(() => null);
    if (!xrpl) throw new Error('xrpl library not installed');

    const client = new xrpl.Client(NETWORK);
    await client.connect();
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED); // secp256k1 seed preferred

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
          Amount: String(Math.trunc(Number(amount) * 1_000_000)), // drops
        };

    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    const sub = await client.submitAndWait(signed.tx_blob);
    await client.disconnect();

    const txid = sub?.result?.hash || signed.hash || null;
    return { txid, txJSON: null };
  }

  // Fallback to mock if MODE unknown
  return { txid: null, txJSON: null };
}
