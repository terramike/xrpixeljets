// server/claimJetFuel.js — XRPixel Jets MKG (2025-10-25c)
// Fixes: use client.request({ command, ...flat args }) for xrpl.js
// Robust IOU/XRP payout + trustline check + inspect + user-sign fallback.

import xrpl from "xrpl";

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
  (process.env.CURRENCY_CODE || process.env.CURRENCY || "JFUEL").toUpperCase();

const CODE_HEX = (process.env.CURRENCY_HEX || "").toUpperCase();

const TOKEN_MODE = (process.env.TOKEN_MODE || "IOU").toUpperCase();
const FALLBACK_TXJSON = process.env.CLAIM_FALLBACK_TXJSON === "1";

function assertEnv() {
  if (!HOT_SEED) throw new Error("HOT_WALLET_SEED not set");
  if (TOKEN_MODE === "IOU" && !ISSUER) {
    throw new Error("ISSUER_ADDRESS not set for IOU");
  }
}

function hexToAsciiAlias(hex) {
  if (!/^[A-F0-9]{40}$/i.test(hex || "")) return "";
  try {
    const buf = Buffer.from(hex, "hex");
    return buf.toString("ascii").replace(/\x00+$/g, "");
  } catch {
    return "";
  }
}

function currencyField() {
  if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
  if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
  const hex = Buffer.from(CODE_ASCII, "ascii")
    .toString("hex")
    .padEnd(40, "0")
    .slice(0, 40)
    .toUpperCase();
  return hex;
}

async function client() {
  const c = new xrpl.Client(WSS);
  await c.connect();
  return c;
}

// ---------- Trustline check (flat request shape) ----------
export async function hasTrustline({ account }) {
  if (TOKEN_MODE !== "IOU") return true;
  const wantHex = currencyField();
  const wantAlias = CODE_ASCII.toUpperCase();
  const c = await client();
  try {
    let lines = [];
    try {
      const r = await c.request({
        command: "account_lines",
        account,
        peer: ISSUER,
        ledger_index: "validated",
      });
      lines = r.result?.lines || [];
    } catch {
      const r = await c.request({
        command: "account_lines",
        account,
        ledger_index: "validated",
      });
      lines = (r.result?.lines || []).filter(
        (l) => (l.account || l.issuer || l.peer) === ISSUER
      );
    }
    return lines.some((l) => {
      const cur = (l.currency || "").toUpperCase();
      const alias = hexToAsciiAlias(cur).toUpperCase();
      return cur === wantHex || cur === wantAlias || alias === wantAlias;
    });
  } finally {
    try { await c.disconnect(); } catch {}
  }
}

// ---------- Inspect helper (flat request shape) ----------
export async function inspectTrustlines({ account }) {
  const wantHex = currencyField();
  const wantAlias = CODE_ASCII.toUpperCase();
  const c = await client();
  try {
    const r = await c.request({
      command: "account_lines",
      account,
      ledger_index: "validated",
    });
    const rows = (r.result?.lines || []).map((l) => ({
      counterparty: l.account || l.issuer || l.peer || "",
      currency: l.currency,
      alias: hexToAsciiAlias(l.currency || ""),
      limit: l.limit,
      balance: l.balance,
      quality_in: l.quality_in,
      quality_out: l.quality_out,
    }));
    const matches = rows.filter(
      (l) =>
        l.counterparty === ISSUER &&
        (
          (l.currency || "").toUpperCase() === wantHex ||
          (l.currency || "").toUpperCase() === wantAlias ||
          (l.alias || "").toUpperCase() === wantAlias
        )
    );
    return {
      network: WSS,
      issuer: ISSUER,
      tokenMode: TOKEN_MODE,
      wantHex,
      wantAlias,
      totalLines: rows.length,
      matches,
      sample: rows.slice(0, 10),
    };
  } finally {
    try { await c.disconnect(); } catch {}
  }
}

// ---------- Prepare unsigned tx (user-sign fallback) ----------
export async function prepareIssued({ to, amount }) {
  assertEnv();
  const c = await client();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);
    const base = {
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: to,
    };
    const Amount =
      TOKEN_MODE === "XRP"
        ? xrpl.xrpToDrops(String(amount))
        : { currency: currencyField(), issuer: ISSUER, value: String(amount) };
    const tx = await c.autofill({ ...base, Amount });
    return { txJSON: JSON.stringify(tx) };
  } finally {
    try { await c.disconnect(); } catch {}
  }
}

// ---------- Hot-wallet send ----------
export async function sendIssued({ to, amount }) {
  assertEnv();
  if (!to || !to.startsWith("r")) throw new Error("bad_destination");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("bad_amount");

  const c = await client();
  try {
    const wallet = xrpl.Wallet.fromSeed(HOT_SEED);

    if (TOKEN_MODE === "IOU") {
      const ok = await hasTrustline({ account: to });
      if (!ok) {
        if (FALLBACK_TXJSON) {
          const { txJSON } = await prepareIssued({ to, amount: n });
          return { txJSON };
        }
        throw new Error("no_trustline");
      }
    }

    const Amount =
      TOKEN_MODE === "XRP"
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
    const code =
      res.result?.meta?.TransactionResult ||
      res.result?.engine_result ||
      "unknown";
    if (code !== "tesSUCCESS") throw new Error(`XRPL tx failed: ${code}`);
    return res.result?.hash || signed.hash || "";
  } finally {
    try { await c.disconnect(); } catch {}
  }
}
