// server/claimJetFuel.js — XRPixel Jets MKG (2025-10-23)
// Minimal XRPL sender for issued currency claims.
// ENV:
//   XRPL_WSS          (default wss://s1.ripple.com)
//   ISSUER_ADDR       (classic r...)
//   HOT_SEED          (family seed for hot wallet)
//   CURRENCY_CODE     (default JFUEL)

import xrpl from 'xrpl';

const WSS = process.env.XRPL_WSS || 'wss://s1.ripple.com';
const ISSUER = process.env.ISSUER_ADDR || '';
const CODE = process.env.CURRENCY_CODE || 'JFUEL';

function assertEnv() {
  if (!ISSUER) throw new Error('ISSUER_ADDR not set');
  if (!process.env.HOT_SEED) throw new Error('HOT_SEED not set');
}

export async function sendJetFuel(dest, amount) {
  assertEnv();
  if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(dest)) throw new Error('invalid destination');
  const value = String(amount);

  const client = new xrpl.Client(WSS);
  await client.connect();
  try {
    const wallet = xrpl.Wallet.fromSeed(process.env.HOT_SEED);

    const payment = {
      TransactionType: 'Payment',
      Account: wallet.classicAddress,
      Destination: dest,
      Amount: { currency: CODE, issuer: ISSUER, value }
    };

    const prepared = await client.autofill(payment);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

    if (res.result?.meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error('XRPL tx failed: ' + (res.result?.meta?.TransactionResult || 'unknown'));
    }

    return res.result?.hash || signed.hash;
  } finally {
    try { await client.disconnect(); } catch {}
  }
}
