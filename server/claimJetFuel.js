// claimJetFuel.js — XRPixel Jets claim helper (secp256k1; XRPL-first)
// TOKEN_MODE: 'mock' (default), 'prepare' (return txJSON), 'hot' (server-sign & submit)

export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase();
  const NETWORK = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
  const CURRENCY_HEX = process.env.CURRENCY_HEX || null;  // 160-bit hex for IOU
  const CURRENCY_CODE = process.env.CURRENCY_CODE || 'JFUEL';
  const ISSUER_ADDR   = process.env.ISSUER_ADDR || null;   // required for IOU
  const HOT_SEED      = process.env.HOT_SEED || null;

  if (MODE === 'mock') return { txid: null, txJSON: null };

  if (MODE === 'prepare') {
    const tx = (CURRENCY_HEX && ISSUER_ADDR)
      ? { TransactionType:'Payment', Account: ISSUER_ADDR, Destination: to, Amount: { currency:CURRENCY_HEX, issuer:ISSUER_ADDR, value:String(amount) } }
      : { TransactionType:'Payment', Account: ISSUER_ADDR || 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Destination: to, Amount: String(Math.trunc(Number(amount)*1_000_000)) };
    return { txid: null, txJSON: tx };
  }

  if (MODE === 'hot') {
    if (!HOT_SEED) throw new Error('HOT_SEED missing');
    const xrpl = await import('xrpl').catch(() => null);
    if (!xrpl) throw new Error('xrpl not installed');

    const client = new xrpl.Client(NETWORK);
    await client.connect();
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED); // secp256k1 seed preferred

    const tx = (CURRENCY_HEX && ISSUER_ADDR)
      ? { TransactionType:'Payment', Account: wallet.address, Destination: to,
          Amount: { currency:CURRENCY_HEX, issuer:ISSUER_ADDR, value:String(amount) } }
      : { TransactionType:'Payment', Account: wallet.address, Destination: to,
          Amount: String(Math.trunc(Number(amount)*1_000_000)) };

    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    const sub = await client.submitAndWait(signed.tx_blob);
    await client.disconnect();

    const txid = sub?.result?.hash || signed.hash || null;
    return { txid, txJSON: null };
  }

  return { txid: null, txJSON: null };
}
