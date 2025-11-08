// server/bazaar-routes.js  v2025-11-08-chain-scan-fix
// Chain-scan purchase flow that reads inventory directly from the hot wallet.
// Endpoints (with server prefix '/bazaar'):
//   GET  /bazaar/chain/available?sku=BAZ-DEFENSE-V1
//   POST /bazaar/chain/purchase      (Authorization: Bearer <jwt>, X-Wallet: r...)
//   POST /bazaar/chain/settle        (Authorization: Bearer <jwt>, X-Wallet: r...)

import fastifyPlugin from "fastify-plugin";
import jwt from "jsonwebtoken";
import * as xrpl from "xrpl";

// ---- Config ----
const XRPL_WSS   = process.env.XRPL_WSS || "wss://xrplcluster.com";
const ISSUER     = process.env.ISSUER_ADDR;                         // rfYZ…
const TAXON      = Number(process.env.BAZAAR_TAXON ?? 201);
const HOT_SEED   = process.env.HOT_SEED || process.env.HOT_WALLET_SEED; // 's...' secp256k1
const JWT_SECRET = process.env.JWT_SECRET || "dev";
const OFFER_TTL  = Number(process.env.BAZAAR_OFFER_TTL_SEC ?? 900); // 15 min

// ---- Single XRPL client + Hot wallet ----
let client, hotWallet, hotAddress;

async function ensureClient() {
  if (!client) {
    client = new xrpl.Client(XRPL_WSS, { connectionTimeout: 20000 });
    await client.connect();
  } else if (!client.isConnected()) {
    await client.connect();
  }
  if (!hotWallet) {
    if (!HOT_SEED) throw new Error("hot_seed_missing");
    hotWallet = xrpl.Wallet.fromSeed(HOT_SEED); // secp256k1 seed => secp wallet
    hotAddress = hotWallet.classicAddress;
    if (!hotAddress) throw new Error("hot_address_derive_failed");
  }
  return client;
}

// ---- JWT helper ----
function requireAuth(req) {
  const hdr = req.headers?.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Unauthorized");
  try { return jwt.verify(m[1], JWT_SECRET); }
  catch { throw new Error("Unauthorized"); }
}

// ---- Utils ----
function rippleExpiryIn(sec) {
  const unix = Math.floor(Date.now() / 1000);
  return unix - 946684800 + sec; // XRPL epoch offset
}
function hexToUtf8(hex) {
  try {
    const h = String(hex||"").replace(/^0x/i,'').trim();
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) return "";
    const bytes = new Uint8Array(h.match(/.{2}/g)?.map(b=>parseInt(b,16)) || []);
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}
function deriveStatBonus(meta){
  const atts = Object.create(null);
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      atts[k] = a?.value;
    }
  }
  const cand = ["attack","defense","speed"].find(k => Number(atts[k])>0);
  return cand ? { stat: cand, bonus: Number(atts[cand])||1 } : null;
}
function priceFromMeta(meta){
  let jf=0, xrp=0;
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      if (k==="price (jfuel)") jf = Number(a.value)||0;
      if (k==="price (xrp)")   xrp = Number(a.value)||0;
    }
  }
  return { jf, xrpDrops: Math.round(xrp*1_000_000) };
}
async function fetchJsonFromIpfsUri(uri){
  const id = String(uri||"").replace(/^ipfs:\/\//,"").replace(/^ipfs\//,"");
  const urls = [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`,
  ];
  for (const u of urls) {
    try { const r = await fetch(u, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}

// Scan hot wallet for one NFT that matches a SKU
async function findOneNftForSku(sku) {
  const c = await ensureClient();
  let marker;
  while (true) {
    const res = await c.request({ command:"account_nfts", account: hotAddress, limit: 400, marker });
    for (const nf of (res.result.account_nfts||[])) {
      if (nf.Issuer !== ISSUER) continue;
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI||"");
      if (!uri) continue;
      const meta = await fetchJsonFromIpfsUri(uri);
      if (!meta) continue;

      const sb   = deriveStatBonus(meta);
      const kind = (sb?.stat || "attack").toUpperCase();
      const serverSku = String(
        meta?.properties?.sku ||
        meta?.properties?.slugPrefix ||
        `BAZ-${kind}-V1`
      ).toUpperCase().replace(/[^A-Z0-9_-]/g,"");

      if (serverSku === sku.toUpperCase()) {
        const { jf, xrpDrops } = priceFromMeta(meta);
        return { nft: nf, meta, priceJFUEL: jf, priceXRPDrops: xrpDrops };
      }
    }
    marker = res.result.marker;
    if (!marker) break;
  }
  return null;
}

// Enumerate availability (count + preview)
async function listAvailableForSku(sku) {
  const c = await ensureClient();
  const out = [];
  let marker;
  while (true) {
    const res = await c.request({ command:"account_nfts", account: hotAddress, limit: 400, marker });
    for (const nf of (res.result.account_nfts||[])) {
      if (nf.Issuer !== ISSUER) continue;
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI||""); if (!uri) continue;
      const meta = await fetchJsonFromIpfsUri(uri); if (!meta) continue;

      const sb   = deriveStatBonus(meta);
      const kind = (sb?.stat || "attack").toUpperCase();
      const serverSku = String(
        meta?.properties?.sku ||
        meta?.properties?.slugPrefix ||
        `BAZ-${kind}-V1`
      ).toUpperCase().replace(/[^A-Z0-9_-]/g,"");

      if (serverSku === sku.toUpperCase()) {
        const { jf, xrpDrops } = priceFromMeta(meta);
        out.push({ nftoken_id: nf.NFTokenID, uri, jf, xrpDrops });
      }
    }
    marker = res.result.marker;
    if (!marker) break;
  }
  return out;
}

// Light account check
async function accountExists(addr) {
  const c = await ensureClient();
  try { await c.request({ command:"account_info", account: addr, ledger_index:"current" }); return true; }
  catch { return false; }
}

// Extract OfferID from validated meta
function offerIdFromMeta(meta){
  const nodes = meta?.AffectedNodes || [];
  for (const n of nodes) {
    const created = n?.CreatedNode;
    if (created?.LedgerEntryType === "NFTokenOffer") {
      return created.LedgerIndex; // Offer ID
    }
  }
  return null;
}

// TODO: wire these to your Postgres profile store (holds/commit/release)
async function holdJetFuel(/*buyer, jf, holdKey*/) { return { ok:true }; }
async function commitJetFuel(/*buyer, jf, holdKey*/) { return { ok:true }; }
async function releaseJetFuel(/*buyer, jf, holdKey*/) { return { ok:true }; }

// ---- Plugin ----
export default fastifyPlugin(async function bazaarRoutes(app){
  app.log.info("[Bazaar] chain-scan routes mounted (hot-wallet inventory)");

  // NOTE: no '/bazaar' here — index.js prefixes with '/bazaar'
  app.get("/chain/available", async (req, reply) => {
    const sku = String(req.query?.sku || "").toUpperCase().trim();
    if (!sku) return reply.code(400).send({ error:"bad_sku" });
    try {
      const items = await listAvailableForSku(sku);
      return reply.send({ sku, available: items.length, items });
    } catch (e) {
      app.log.error(e, "[GET /chain/available]");
      return reply.code(500).send({ error:"server_error" });
    }
  });

  // Create directed sell-offer to buyer
  app.post("/chain/purchase", async (req, reply) => {
    try {
      requireAuth(req);
      const buyer = (req.headers["x-wallet"]||"").toString().trim();
      const { sku } = req.body || {};
      if (!buyer || !buyer.startsWith("r")) return reply.code(400).send({ error:"bad_buyer" });
      if (!sku) return reply.code(400).send({ error:"bad_sku" });
      if (!(await accountExists(buyer))) return reply.code(400).send({ error:"buyer_not_found" });

      const item = await findOneNftForSku(sku);
      if (!item) return reply.code(404).send({ error:"no_inventory" });

      const holdKey = `bazaar:${buyer}:${item.nft.NFTokenID}`;
      const hold = await holdJetFuel(buyer, item.priceJFUEL, holdKey);
      if (!hold?.ok) return reply.code(402).send({ error:"insufficient_jetfuel" });

      const c = await ensureClient();
      const tx = {
        TransactionType: "NFTokenCreateOffer",
        Account: hotAddress,
        NFTokenID: item.nft.NFTokenID,
        Amount: String(item.priceXRPDrops || 0),
        Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken,
        Destination: buyer,
        Expiration: rippleExpiryIn(OFFER_TTL),
      };
      const prepared = await c.autofill(tx);
      const signed   = hotWallet.sign(prepared);
      const sub      = await c.submitAndWait(signed.tx_blob, { failHard: false });

      const ok = sub.result?.meta?.TransactionResult === "tesSUCCESS";
      if (!ok) {
        await releaseJetFuel(buyer, item.priceJFUEL, holdKey);
        return reply.code(500).send({ error:"offer_failed", meta: sub.result?.meta });
      }
      const offerId = offerIdFromMeta(sub.result?.meta);
      if (!offerId) {
        await releaseJetFuel(buyer, item.priceJFUEL, holdKey);
        return reply.code(500).send({ error:"no_offer_id" });
      }
      return reply.send({
        ok: true,
        sellOfferId: offerId,
        nftokenId: item.nft.NFTokenID,
        sku,
        jf: item.priceJFUEL || 0,
        xrpDrops: item.priceXRPDrops || 0,
        expiresInSec: OFFER_TTL
      });
    } catch (e) {
      if (String(e.message).toLowerCase().includes("unauthorized")) return reply.code(401).send({ error:"unauthorized" });
      app.log.error(e, "[POST /chain/purchase]");
      return reply.code(500).send({ error:"server_error" });
    }
  });

  // Finalize JFUEL hold once user accepts the offer in their wallet
  app.post("/chain/settle", async (req, reply) => {
    try {
      requireAuth(req);
      const buyer = (req.headers["x-wallet"]||"").toString().trim();
      const { offerId, holdKey, jf=0 } = req.body || {};
      if (!offerId) return reply.code(400).send({ error:"bad_offer" });

      const c = await ensureClient();
      let accepted;
      try {
        await c.request({ command:"ledger_entry", index: offerId });
        accepted = false; // still exists
      } catch {
        accepted = true;  // missing => consumed/canceled
      }

      if (accepted) {
        await commitJetFuel(buyer, jf, holdKey);
        return reply.send({ ok:true, state:"accepted" });
      } else {
        return reply.send({ ok:false, state:"still_open" });
      }
    } catch (e) {
      if (String(e.message).toLowerCase().includes("unauthorized")) return reply.code(401).send({ error:"unauthorized" });
      return reply.code(500).send({ error:"server_error" });
    }
  });
});
