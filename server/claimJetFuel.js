// server/claimJetFuel.js — XRPL hot-wallet sender or txJSON prep (2025-10-25a)
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

function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  // pad ASCII to 20-byte hex
  return Buffer.from(CODE_ASCII, 'ascii').toString('hex').padEnd(40, '0').slice(0, 40).toUpperCase();
}
async function newClient() { const c = new xrpl.Client(WSS); await c.connect(); return c; }

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== 'IOU') return true;
  const client = await newClient();
  try {
    const resp = await client.request({ method:'account_lines', params:[{ account, peer: ISSUER, ledger_index:'validated' }]});
    const cur = currencyField();
    return (resp.result.lines || []).some(l => (l.currency || '').toUpperCase() === cur);
  } finally { try { await client.disconnect(); } catch {} }
}

export async function prepareIssued({ to, amount }) {
  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const tx = await client.autofill(
      TOKEN_MODE === 'XRP'
        ? { TransactionType:'Payment', Account: wallet.address, Destination: to, Amount: xrpl.xrpToDrops(String(amount)) }
        : { TransactionType:'Payment', Account: wallet.address, Destination: to,
            Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) } }
    );
    return { txJSON: JSON.stringify(tx) };
  } finally { try { await client.disconnect(); } catch {} }
}

export async function sendIssued({ to, amount }) {
  if (!to || !to.startsWith('r')) throw new Error('bad_destination');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('bad_amount');

  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const tx = TOKEN_MODE === 'XRP'
      ? { TransactionType:'Payment', Account: wallet.address, Destination: to, Amount: xrpl.xrpToDrops(String(amount)) }
      : { TransactionType:'Payment', Account: wallet.address, Destination: to,
          Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) } };
    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared);
    const sub = await client.submitAndWait(signed.tx_blob);
    return { txid: sub.result?.hash || signed.hash };
  } finally { try { await client.disconnect(); } catch {} }
}
