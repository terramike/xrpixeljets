// claimJetFuel.js — XRPixel Jets (2025-12-18-hot-force1)
// Force hot if HOT_SEED; remove prepare
import xrpl from 'xrpl';

const WSS      = process.env.NETWORK || process.env.XRPL_WSS || 'wss://xrplcluster.com';
const ISSUER   = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';
const HOT_SEED = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';
const CODE_ASCII = process.env.CURRENCY_CODE || process.env.CURRENCY || 'JFUEL';
const CODE_HEX   = (process.env.CURRENCY_HEX || '').toUpperCase();
const TOKEN_MODE = (process.env.TOKEN_MODE || 'hot').toUpperCase(); // Force hot default

function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  return Buffer.from(CODE_ASCII, 'ascii').toString('hex').padEnd(40,'0').slice(0,40).toUpperCase();
}
async function newClient(){ const c = new xrpl.Client(WSS); await c.connect(); return c; }

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== 'IOU') return true;
  const c = await newClient();
  try {
    const r = await c.request({ method:'account_lines', params:[{ account, peer: ISSUER, ledger_index:'validated' }] });
    const cur = currencyField();
    return (r.result.lines||[]).some(l => (l.currency||'').toUpperCase() === cur.toUpperCase());
  } finally { try { await c.disconnect(); } catch {} }
}

export async function sendIssued({ to, amount }) {
  const dest = to;
  const amt = Number(amount||0);
  if (!dest.startsWith('r')) throw new Error('bad_destination');
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('bad_amount');

  const c = await newClient();
  try {
    if (TOKEN_MODE === 'MOCK') return { ok:true, txid:null, txJSON:null };

    if (HOT_SEED) {
      const wallet = xrpl.Wallet.fromSeed(HOT_SEED, { algorithm:'secp256k1' });
      if ((wallet.publicKey || '').toUpperCase().startsWith('ED')) throw new Error('bad_hot_wallet_algo_secp_required');

      if (TOKEN_MODE === 'XRP') {
        const tx = await c.autofill({ TransactionType:'Payment', Account: wallet.address, Destination: dest, Amount: xrpl.xrpToDrops(String(amt)) });
        const { tx_blob } = wallet.sign(tx);
        const sub = await c.submitAndWait(tx_blob);
        return { ok:true, txid: sub?.result?.hash || sub?.result?.tx_json?.hash || null };
      }

      const tlOK = await hasTrustline({ account: dest }).catch(() => false);
      if (!tlOK) throw new Error('no_trustline');

      const tx = await c.autofill({
        TransactionType:'Payment',
        Account: wallet.address,
        Destination: dest,
        Amount: { currency: currencyField(), issuer: ISSUER, value: String(amt) }
      });
      const { tx_blob } = wallet.sign(tx);
      const sub = await c.submitAndWait(tx_blob);
      return { ok:true, txid: sub?.result?.hash || sub?.result?.tx_json?.hash || null };
    }

    throw new Error('hot_wallet_missing');
  } finally { try { await c.disconnect(); } catch {} }
}
