// server/claimJetFuel.js — XRPixel Jets (2025-10-25e)
// Uses XRPL_WSS, HOT_SEED, ISSUER_ADDR, CURRENCY_CODE/HEX, TOKEN_MODE, CLAIM_FALLBACK_TXJSON.

import xrpl from "xrpl";

// ----- ENV bindings (match your Render env names) -----
const WSS =
  process.env.XRPL_WSS ||
  process.env.NETWORK ||
  "wss://s1.ripple.com";

const ISSUER =
  process.env.ISSUER_ADDR ||
  process.env.ISSUER_ADDRESS ||
  "";

const HOT_SEED =
  process.env.HOT_SEED ||
  process.env.HOT_WALLET_SEED ||
  "";

const CODE_ASCII =
  process.env.CURRENCY_CODE ||
  process.env.CURRENCY ||
  "JFUEL";

const CODE_HEX = (process.env.CURRENCY_HEX || "").toUpperCase();
const TOKEN_MODE = (process.env.TOKEN_MODE || "IOU").toUpperCase();
const FALLBACK_TXJSON = String(process.env.CLAIM_FALLBACK_TXJSON || '') === '1';

// ----- helpers -----
function assertEnv() {
  if (!HOT_SEED) throw new Error("HOT_SEED not set");
  if (TOKEN_MODE === "IOU" && !ISSUER) throw new Error("ISSUER_ADDR not set for IOU");
}
function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  const hex = Buffer.from(CODE_ASCII, "ascii").toString("hex").padEnd(40, "0").slice(0, 40).toUpperCase();
  return hex;
}
async function newClient() { const c = new xrpl.Client(WSS); await c.connect(); return c; }

// Public health (no secrets)
export async function health() {
  try {
    const c = await newClient();
    try {
      const wallet = HOT_SEED ? xrpl.Wallet.fromSeed(HOT_SEED) : null;
      let acct = null, exists = false;
      if (wallet) {
        try {
          const r = await c.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' });
          acct = wallet.address;
          exists = !!r?.result?.account_data?.Account;
        } catch {
          acct = wallet.address;
          exists = false;
        }
      }
      return {
        ok: true,
        network: WSS,
        issuer: ISSUER || null,
        tokenMode: TOKEN_MODE,
        currency: CODE_HEX || CODE_ASCII,
        hotWallet: acct,
        hotWalletExists: exists
      };
    } finally { try { await c.disconnect(); } catch {} }
  } catch (e) {
    return { ok:false, error: String(e?.message || e) };
  }
}

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== "IOU") return true;
  const client = await newClient();
  try {
    const resp = await client.request({
      method: "account_lines",
      params: [{ account, peer: ISSUER, ledger_index: "validated" }],
    });
    const cur = currencyField();
    return (resp.result.lines || []).some((l) => (l.currency || "").toUpperCase() === cur);
  } finally { try { await client.disconnect(); } catch {} }
}

// Build unsigned tx (if you later want user-sign flow)
export async function prepareIssued({ to, amount }) {
  assertEnv();
  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const tx = await client.autofill(
      TOKEN_MODE === "XRP"
        ? { TransactionType: "Payment", Account: wallet.address, Destination: to, Amount: xrpl.xrpToDrops(String(amount)) }
        : { TransactionType: "Payment", Account: wallet.address, Destination: to,
            Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) } }
    );
    return { txJSON: JSON.stringify(tx) };
  } finally { try { await client.disconnect(); } catch {} }
}

// Server-send with preflight; throws 'hot_wallet_missing' clearly if unfunded on WSS
export async function sendIssued(a, b) {
  const params = typeof a === "object" ? a : { to: a, amount: b };
  const to = params.to || params.destination || params.wallet;
  const amount = Number(params.amount || params.value || 0);

  if (!to || !to.startsWith("r")) throw new Error("bad_destination");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("bad_amount");

  assertEnv();

  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);

    // Ensure the hot wallet exists on the configured network
    try {
      await client.request({ command: 'account_info', account: wallet.address, ledger_index: 'validated' });
    } catch {
      throw new Error('hot_wallet_missing');
    }

    // Trustline check in IOU mode
    if (TOKEN_MODE === "IOU") {
      let tlOK = true;
      try {
        const resp = await client.request({
          method: "account_lines",
          params: [{ account: to, peer: ISSUER, ledger_index: "validated" }],
        });
        const cur = currencyField();
        tlOK = (resp.result.lines || []).some((l) => (l.currency || "").toUpperCase() === cur);
      } catch {
        tlOK = false; // new/unfunded account case
      }
      if (!tlOK) {
        if (FALLBACK_TXJSON) {
          const { txJSON } = await prepareIssued({ to, amount });
          return { txJSON };
        }
        throw new Error("no_trustline");
      }
    }

    const payment =
      TOKEN_MODE === "XRP"
        ? { TransactionType: "Payment", Account: wallet.address, Destination: to, Amount: xrpl.xrpToDrops(String(amount)) }
        : { TransactionType: "Payment", Account: wallet.address, Destination: to,
            Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) } };

    const prepared = await client.autofill(payment);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

    const code =
      res.result?.meta?.TransactionResult ||
      res.result?.engine_result ||
      "unknown";
    if (code !== "tesSUCCESS") throw new Error(`XRPL tx failed: ${code}`);

    const hash = res.result?.hash || signed.hash;
    return hash ? String(hash) : "";
  } finally { try { await client.disconnect(); } catch {} }
}
