// server/claimJetFuel.js — XRPixel Jets MKG (2025-10-25a)
// Hot-wallet sender for issued JetFuel (IOU) or native XRP (switchable via ENV).
// Exports: sendIssued, prepareIssued, hasTrustline
//
// ENV (with sane aliases):
//   NETWORK or XRPL_WSS         → wss endpoint (default: wss://s1.ripple.com)
//   ISSUER_ADDRESS or ISSUER_ADDR  (classic r.. address of issuer; needed for IOU)
//   HOT_WALLET_SEED or HOT_SEED    (family seed; server hot wallet)
//   CURRENCY_CODE or CURRENCY      (e.g., "JFUEL" or "USD")
//   CURRENCY_HEX                   (optional 40-hex code for non-3-char currency)
//   TOKEN_MODE                     ("IOU" | "XRP"; default IOU)
//   CLAIM_FALLBACK_TXJSON          ("1" to return txJSON when no trustline)

import xrpl from "xrpl";

// ----- ENV -----
const WSS =
  process.env.NETWORK ||
  process.env.XRPL_WSS ||
  "wss://s1.ripple.com";

const ISSUER =
  process.env.ISSUER_ADDRESS ||
  process.env.ISSUER_ADDR ||
  "";

const HOT_SEED =
  process.env.HOT_WALLET_SEED ||
  process.env.HOT_SEED ||
  "";

const CODE_ASCII =
  process.env.CURRENCY_CODE ||
  process.env.CURRENCY ||
  "JFUEL";

const CODE_HEX = (process.env.CURRENCY_HEX || "").toUpperCase();

const TOKEN_MODE = (process.env.TOKEN_MODE || "IOU").toUpperCase();
const FALLBACK_TXJSON = process.env.CLAIM_FALLBACK_TXJSON === "1";

// ----- helpers -----
function assertEnv() {
  if (!HOT_SEED) throw new Error("HOT_WALLET_SEED (or HOT_SEED) not set");
  if (TOKEN_MODE === "IOU") {
    if (!ISSUER) throw new Error("ISSUER_ADDRESS (or ISSUER_ADDR) not set for IOU");
  }
}

function currencyField() {
  // For IOU payments: choose currency form
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  // encode longer ASCII into 20-byte hex (padded)
  const hex = Buffer.from(CODE_ASCII, "ascii")
    .toString("hex")
    .padEnd(40, "0")
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
  if (TOKEN_MODE !== "IOU") return true; // XRP needs no trustline
  const client = await newClient();
  try {
    const resp = await client.request({
      method: "account_lines",
      params: [{ account, peer: ISSUER, ledger_index: "validated" }],
    });
    const cur = currencyField();
    return (resp.result.lines || []).some((l) => {
      // matches either 3-char or 160-bit hex
      return (l.currency || "").toUpperCase() === cur;
    });
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

// Build (autofilled) unsigned tx JSON for user-sign flow
export async function prepareIssued({ to, amount }) {
  assertEnv();
  const client = await newClient();
  try {
    if (TOKEN_MODE === "XRP") {
      const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
      const tx = await client.autofill({
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: to,
        Amount: xrpl.xrpToDrops(String(amount)),
      });
      return { txJSON: JSON.stringify(tx) };
    } else {
      const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
      const tx = await client.autofill({
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: to,
        Amount: {
          currency: currencyField(),
          issuer: ISSUER,
          value: String(amount),
        },
      });
      return { txJSON: JSON.stringify(tx) };
    }
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

// Server-send: submit payment and return txid (hash)
export async function sendIssued(a, b) {
  // Accept either (to, amount) or ({ to, amount })
  const params = typeof a === "object" ? a : { to: a, amount: b };
  const to = params.to || params.destination || params.wallet;
  const amount = Number(params.amount || params.value || 0);

  if (!to || !to.startsWith("r")) throw new Error("bad_destination");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("bad_amount");

  assertEnv();

  const client = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);

    // Optional trustline guard for IOU
    if (TOKEN_MODE === "IOU") {
      let tlOK = true;
      try {
        const resp = await client.request({
          method: "account_lines",
          params: [{ account: to, peer: ISSUER, ledger_index: "validated" }],
        });
        const cur = currencyField();
        tlOK = (resp.result.lines || []).some((l) => (l.currency || "").toUpperCase() === cur);
      } catch (e) {
        // If account_lines fails, allow fallback below
        tlOK = false;
      }
      if (!tlOK) {
        if (FALLBACK_TXJSON) {
          const { txJSON } = await prepareIssued({ to, amount });
          return { txJSON }; // caller can branch on this
        }
        throw new Error("no_trustline");
      }
    }

    const payment =
      TOKEN_MODE === "XRP"
        ? {
            TransactionType: "Payment",
            Account: wallet.address,
            Destination: to,
            Amount: xrpl.xrpToDrops(String(amount)),
          }
        : {
            TransactionType: "Payment",
            Account: wallet.address,
            Destination: to,
            Amount: {
              currency: currencyField(),
              issuer: ISSUER,
              value: String(amount),
            },
          };

    const prepared = await client.autofill(payment);
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

    // XRPL success check
    const code =
      res.result?.meta?.TransactionResult ||
      res.result?.engine_result ||
      "unknown";
    if (code !== "tesSUCCESS") {
      throw new Error(`XRPL tx failed: ${code}`);
    }

    const hash = res.result?.hash || signed.hash;
    return hash ? String(hash) : "";
  } finally {
    try { await client.disconnect(); } catch {}
  }
}
