// server/claimJetFuel.js — XRPixel Jets (2025-10-25e)
// XRPL hot-wallet payouts + robust trustline + diagnostics (mainnet/testnet friendly)

import xrpl from "xrpl";

const WSS =
  process.env.XRPL_WSS ||
  process.env.NETWORK ||
  "wss://s1.ripple.com";

const ISSUER =
  process.env.ISSUER_ADDR ||
  process.env.ISSUER_ADDRESS ||
  ""; // required for IOU

const HOT_SEED =
  process.env.HOT_SEED ||
  process.env.HOT_WALLET_SEED ||
  ""; // server hot wallet (funded on same network)

const CODE_ASCII = (process.env.CURRENCY_CODE || process.env.CURRENCY || "JFUEL").toUpperCase();
const CODE_HEX = (process.env.CURRENCY_HEX || "").toUpperCase();
const TOKEN_MODE = (process.env.TOKEN_MODE || "IOU").toUpperCase(); // IOU|XRP
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

async function newClient() {
  const c = new xrpl.Client(WSS);
  await c.connect();
  return c;
}

async function accountExists(c, account) {
  try {
    const r = await c.request({ command: "account_info", account, ledger_index: "validated", strict: true });
    return !!r?.result?.account_data;
  } catch (e) {
    return false; // actNotFound or "Account not found."
  }
}

export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== "IOU") return true;
  const wantHex = currencyField();
  const wantAlias = CODE_ASCII;
  const c = await newClient();
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

// Diagnostics (used by /debug/claim/ping)
export async function diagnostics({ dest }) {
  const c = await newClient();
  try {
    const hot = xrpl.Wallet.fromSeed(HOT_SEED).address;
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
        validatedLedger: si?.result?.info?.validated_ledger?.seq,
      },
    };
  } finally { try { await c.disconnect(); } catch {} }
}

// Build unsigned tx JSON for user-sign fallback
export async function prepareIssued({ to, amount }) {
  assertEnv();
  const c = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const Amount = TOKEN_MODE === "XRP"
      ? xrpl.xrpToDrops(String(amount))
      : { currency: currencyField(), issuer: ISSUER, value: String(amount) };
    const tx = await c.autofill({ TransactionType: "Payment", Account: wallet.address, Destination: to, Amount });
    return { txJSON: JSON.stringify(tx) };
  } finally { try { await c.disconnect(); } catch {} }
}

// Hot-wallet send
export async function sendIssued({ to, amount }) {
  assertEnv();
  if (!to || !to.startsWith("r")) throw new Error("bad_destination");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("bad_amount");

  const c = await newClient();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);

    // Preflight existence checks help catch network mismatch
    if (!(await accountExists(c, to))) throw new Error("dest_account_not_found");
    if (TOKEN_MODE === "IOU" && !(await accountExists(c, ISSUER))) throw new Error("issuer_account_not_found");

    if (TOKEN_MODE === "IOU") {
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

    const prepared = await c.autofill({ TransactionType: "Payment", Account: wallet.address, Destination: to, Amount });
    const signed = wallet.sign(prepared);
    const res = await c.submitAndWait(signed.tx_blob);
    const code = res.result?.meta?.TransactionResult || res.result?.engine_result || "unknown";
    if (code !== "tesSUCCESS") throw new Error(`XRPL tx failed: ${code}`);
    return res.result?.hash || signed.hash || "";
  } finally { try { await c.disconnect(); } catch {} }
}
