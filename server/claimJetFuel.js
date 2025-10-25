// server/claimJetFuel.js — XRPixel Jets MKG (2025-10-25 secp hot-wallet)
// Server-send / user-sign helpers for JFUEL IOU or XRP payouts.
// **Forces secp256k1** when deriving the hot wallet.

import xrpl from 'xrpl';

const WSS =
  process.env.NETWORK ||
  process.env.XRPL_WSS ||
  'wss://s1.ripple.com';

const ISSUER =
  process.env.ISSUER_ADDRESS ||
  process.env.ISSUER_ADDR ||
  '';

const HOT_SEED =
  process.env.HOT_WALLET_SEED ||
  process.env.HOT_SEED ||
  '';

const CODE_ASCII =
  process.env.CURRENCY_CODE ||
  process.env.CURRENCY ||
  'JFUEL';

const CODE_HEX = (process.env.CURRENCY_HEX || '').toUpperCase();
const TOKEN_MODE = (process.env.TOKEN_MODE || 'IOU').toUpperCase();
const FALLBACK_TXJSON = process.env.CLAIM_FALLBACK_TXJSON === '1';

function assertEnv() {
  if (!HOT_SEED) throw new Error('HOT_WALLET_SEED (or HOT_SEED) not set');
  if (TOKEN_MODE === 'IOU' && !ISSUER) throw new Error('ISSUER_ADDRESS (or ISSUER_ADDR) not set for IOU');
}

function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  const hex = Buffer.from(CODE_ASCII, 'ascii')
    .toString('hex')
    .padEnd(40, '0')
    .slice(0, 40)
    .toUpperCase();
  return hex;
}

async function newClient() {
  const c = new xrpl.Client(WSS);
  await c.connect();
  return c;
}

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== 'IOU') return true;
  const client = await newClient();
  try {
    const resp = await client.request({
      method: 'account_lines',
      params: [{ account, peer: ISSUER, ledger_index: 'validated' }],
    });
    const cur = currencyField();
    return (resp.result.lines || []).some(l => (l.currency || '').toUpperCase() === cur);
  } finally { try { await client.disconnect(); } catch {} }
}

export async function prepareIssued({ to, amount }) {
  assertEnv();
  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED, { algorithm: 'secp256k1' }); // explicit secp
    if (TOKEN_MODE === 'XRP') {
      const tx = await client.autofill({
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: to,
        Amount: xrpl.xrpToDrops(String(amount)),
      });
      return { txJSON: JSON.stringify(tx) };
    } else {
      const tx = await client.autofill({
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: to,
        Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) },
      });
      return { txJSON: JSON.stringify(tx) };
    }
  } finally { try { await client.disconnect(); } catch {} }
}

export async function sendIssued(params) {
  const { to, amount } = (typeof params === 'object') ? params : { to: params, amount: arguments[1] };
  if (!to || !to.startsWith('r')) throw new Error('bad_destination');
  const amt = Number(amount||0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('bad_amount');

  assertEnv();
  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED, { algorithm: 'secp256k1' }); // explicit secp

    if (TOKEN_MODE === 'XRP') {
      const tx = await client.autofill({
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: to,
        Amount: xrpl.xrpToDrops(String(amt)),
      });
      const { tx_blob } = wallet.sign(tx);
      const sub = await client.submitAndWait(tx_blob);
      return { ok:true, txid: sub?.result?.hash || sub?.result?.tx_json?.hash || null };
    }

    // IOU mode
    const trustOk = await hasTrustline({ account: to }).catch(() => false);
    if (!trustOk && FALLBACK_TXJSON) {
      const prep = await prepareIssued({ to, amount: amt });
      return { ok:true, txJSON: prep.txJSON || null };
    }
    const tx = await client.autofill({
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: to,
      Amount: { currency: currencyField(), issuer: ISSUER, value: String(amt) },
    });
    const { tx_blob } = wallet.sign(tx);
    const sub = await client.submitAndWait(tx_blob);
    return { ok:true, txid: sub?.result?.hash || sub?.result?.tx_json?.hash || null };
  } finally { try { await client.disconnect(); } catch {} }
}
