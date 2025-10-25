// server/claimJetFuel.js — XRPixel Jets MKG (2025-10-25d)
// - Flat XRPL requests (command + flat args)
// - Robust trustline detection (alias/hex)
// - Diagnostics helpers (ping / inspect)
// - IOU/XRP payout via server hot wallet
//
// ENV aliases supported:
//   XRPL_WSS | NETWORK
//   ISSUER_ADDR | ISSUER_ADDRESS  (for IOU)
//   HOT_SEED | HOT_WALLET_SEED
//   CURRENCY_CODE | CURRENCY (ASCII alias, e.g., "JFUEL")
//   CURRENCY_HEX  (40-hex; takes precedence if set)
//   TOKEN_MODE ("IOU" | "XRP")  default IOU
//   CLAIM_FALLBACK_TXJSON=1 → return txJSON if no trustline

import xrpl from "xrpl";

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

const CODE_ASCII = (process.env.CURRENCY_CODE || process.env.CURRENCY || "JFUEL").toUpperCase();
const CODE_HEX = (process.env.CURRENCY_HEX || "").toUpperCase();
const TOKEN_MODE = (process.env.TOKEN_MODE || "IOU").toUpperCase();
const FALLBACK_TXJSON = process.env.CLAIM_FALLBACK_TXJSON === "1";

function assertEnv() {
  if (!HOT_SEED) throw new Error("HOT_SEED not set");
  if (TOKEN_MODE === "IOU" && !ISSUER) throw new Error("ISSUER_ADDR not set for IOU");
}

function hexToAsciiAlias(hex) {
  if (!/^[A-F0-9]{40}$/i.test(hex || "")) return "";
  try {
    const buf = Buffer.from(hex, "hex");
    return buf.toString("ascii").replace(/\x00+$/g, "");
  } catch { return ""; }
}

function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  return Buffer.from(CODE_ASCII, "ascii").toString("hex").padEnd(40, "0").slice(0, 40).toUpperCase();
}

async function client() {
  const c = new xrpl.Client(WSS);
  await c.connect();
  return c;
}

async function accountExists(c, account) {
  try {
    const r = await c.request({ command: "account_info", account, ledger_index: "validated", strict: true });
    return !!r?.result?.account_data;
  } catch (e) {
    // rippled returns actNotFound or “Account not found.”
    return false;
  }
}

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== "IOU") return true;
  const wantHex = currencyField();
  const wantAlias = CODE_ASCII;
  const c = await client();
  try {
    const r = await c.request({ command: "account_lines", account, ledger_index: "validated" });
    const lines = r.result?.lines || [];
    return lines.some((l) => {
      const cur = (l.currency || "").toUpperCase();
      const alias = hexToAsciiAlias(cur).toUpperCase();
      const cp = l.account || l.issuer || l.peer || "";
      return cp === ISSUER && (cur === wantHex || cur === wantAlias || alias === wantAlias);
    });
  } finally { try { await c.disconnect(); } catch {} }
}

// Diagnostics for /debug/claim/ping
export async function diagnostics({ dest }) {
  const c = await client();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const hot = wallet.address;
    const hotExists = await accountExists(c, hot);
    const issuerExists = ISSUER ? await accountExists(c, ISSUER) : null;
    const destExists = dest ? await accountExists(c, dest) : null;

    let trustlineOK = null;
    if (dest && ISSUER && TOKEN_MODE === "IOU") {
      trustlineOK = await hasTrustline({ account: dest });
    }

    const si = await c.request({ command: "server_info" });
    return {
      wss: WSS,
      tokenMode: TOKEN_MODE,
      currencyHex: currencyField(),
      currencyAlias: CODE_ASCII,
      issuer: ISSUER || null,
      hotAddress: hot,
      hotExists,
      issuerExists,
      dest,
      destExists,
      trustlineOK,
      server: {
        buildVersion: si?.result?.info?.build_version,
        networkId: si?.result?.info?.network_id,
        validatedLedger: si?.result?.info?.validated_ledger?.seq,
      },
    };
  } finally { try { await c.disconnect(); } catch {} }
}

// Build unsigned tx (user-sign)
export async function prepareIssued({ to, amount }) {
  assertEnv();
  const c = await client();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const Amount = TOKEN_MODE === "XRP"
      ? xrpl.xrpToDrops(String(amount))
      : { currency: currencyField(), issuer: ISSUER, value: String(amount) };
    const tx = await c.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: to,
      Amount,
    });
    return { txJSON: JSON.stringify(tx) };
  } finally { try { await c.disconnect(); } catch {} }
}

// Server-send: submit and return tx hash or txJSON fallback
export async function sendIssued({ to, amount }) {
  assertEnv();
  if (!to || !to.startsWith("r")) throw new Error("bad_destination");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("bad_amount");

  const c = await client();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);

    // Pre-check accounts to catch network mismatch fast:
    const destOK = await accountExists(c, to);
    if (!destOK) throw new Error("dest_account_not_found");

    if (TOKEN_MODE === "IOU") {
      const issuerOK = await accountExists(c, ISSUER);
      if (!issuerOK) throw new Error("issuer_account_not_found");
      const tlOK = await hasTrustline({ account: to });
      if (!tlOK) {
        if (FALLBACK_TXJSON) {
          const { txJSON } = await prepareIssued({ to, amount: n });
          return { txJSON };
        }
        throw new Error("no_trustline");
      }
    }

    const Amount = TOKEN_MODE === "XRP"
      ? xrpl.xrpToDrops(String(n))
      : { currency: currencyField(), issuer: ISSUER, value: String(n) };

    const prepared = await c.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: to,
      Amount,
    });
    const signed = wallet.sign(prepared);
    const res = await c.submitAndWait(signed.tx_blob);
    const code = res.result?.meta?.TransactionResult || res.result?.engine_result || "unknown";
    if (code !== "tesSUCCESS") throw new Error(`XRPL tx failed: ${code}`);
    return res.result?.hash || signed.hash || "";
  } finally { try { await c.disconnect(); } catch {} }
}
