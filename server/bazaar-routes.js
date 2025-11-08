// server/bazaar-routes.js  v2025-11-08c6
// Hot-wallet chain-scan Bazaar (reads inventory directly from HOT_SEED wallet).
// NOTE: Your server must register this file with prefix '/bazaar' (see step 2).

import fastifyPlugin from "fastify-plugin";
import * as xrpl from "xrpl";
import jwt from "jsonwebtoken";

// ---------- Env / Config ----------
const XRPL_WSS   = process.env.XRPL_WSS || "wss://xrplcluster.com";
const ISSUER     = process.env.ISSUER_ADDR;             // rfYZ…
const TAXON      = Number(process.env.BAZAAR_TAXON ?? 201);
const HOT_SEED   = process.env.HOT_SEED || process.env.HOT_WALLET_SEED; // 's…' (secp256k1)
const JWT_SECRET = process.env.JWT_SECRET || "dev";
const OFFER_TTL  = Number(process.env.BAZAAR_OFFER_TTL_SEC ?? 900);     // 15 min

// ---------- Utilities ----------
function xrplExpiryIn(sec) {
  const now = Math.floor(Date.now() / 1000);
  return now - 946684800 + sec; // unix->xrpl epoch
}
function hexToUtf8(hex) {
  try {
    const h = String(hex||"").replace(/^0x/i,'');
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) return "";
    const bytes = new Uint8Array(h.match(/.{2}/g)?.map(b=>parseInt(b,16)) || []);
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}
function deriveStatBonus(meta){
  const at = Object.create(null);
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      at[k] = a?.value;
    }
  }
  const pick = ["attack","defense","speed"].find(k => Number(at[k])>0);
  return pick ? { stat: pick, bonus: Number(at[pick])||1 } : null;
}
function priceFromMeta(meta){
  let jf = 0, xrp = 0;
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      if (k === "price (jfuel)") jf = Number(a.value)||0;
      if (k === "price (xrp)")   xrp = Number(a.value)||0;
    }
  }
  return { jf, xrpDrops: Math.round((Number.isFinite(xrp)?xrp:0)*1_000_000) };
}
async function httpGetJson(url){
  // Works on Node 18+ (global fetch). If missing, lazy-load node-fetch.
  const f = typeof fetch === "function" ? fetch : (await import("node-fetch")).default;
  const r = await f(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch ${r.status} ${url}`);
  return r.json();
}
async function fetchIpfsJson(uri){
  const id = String(uri||"").replace(/^ipfs:\/\//,'').replace(/^ipfs\//,'');
  const probes = [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`,
  ];
  for (const u of probes) {
    try { return await httpGetJson(u); } catch {}
  }
  return null;
}
function offerIdFromMeta(meta){
  for (const n of (meta?.AffectedNodes||[])) {
    const c = n?.CreatedNode;
    if (c?.LedgerEntryType === "NFTokenOffer") return c.LedgerIndex;
  }
  return null;
}
function requireAuth(req){
  const h = req.headers?.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("unauthorized");
  try { return jwt.verify(m[1], JWT_SECRET); }
  catch { throw new Error("unauthorized"); }
}

// ---------- Single XRPL client / hot wallet ----------
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
    hotWallet  = xrpl.Wallet.fromSeed(HOT_SEED); // secp256k1
    hotAddress = hotWallet.classicAddress;
  }
  return client;
}
async function accountExists(addr) {
  const c = await ensureClient();
  try { await c.request({ command:"account_info", account: addr, ledger_index:"current" }); return true; }
  catch { return false; }
}

// ---------- Chain scan helpers ----------
async function listAvailableForSku(sku) {
  const c = await ensureClient();
  const out = [];
  let marker;
  do {
    const res = await c.request({ command:"account_nfts", account: hotAddress, limit: 400, marker });
    for (const nf of (res.result.account_nfts||[])) {
      if (nf.Issuer !== ISSUER) continue;
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI||""); if (!uri) continue;
      const meta = await fetchIpfsJson(uri); if (!meta) continue;
      const sb   = deriveStatBonus(meta);
      const kind = (sb?.stat || "attack").toUpperCase();
      const serverSku = String(
        meta?.properties?.sku || meta?.properties?.slugPrefix || `BAZ-${kind}-V1`
      ).toUpperCase().replace(/[^A-Z0-9_-]/g,"");
      if (serverSku === sku.toUpperCase()) {
        const { jf, xrpDrops } = priceFromMeta(meta);
        out.push({ nftoken_id: nf.NFTokenID, uri, jf, xrpDrops });
      }
    }
    marker = res.result.marker;
  } while (marker);
  return out;
}
async function findOneForSku(sku) {
  const items = await listAvailableForSku(sku);
  if (!items.length) return null;
  return items[0];
}

// ---------- (Stub) JetFuel escrow hooks ----------
async function holdJetFuel(/*buyer, jf, key*/){ return { ok: true }; }
async function commitJetFuel(/*buyer, jf, key*/){ return { ok: true }; }
async function releaseJetFuel(/*buyer, jf, key*/){ return { ok: true }; }

// ---------- Fastify plugin ----------
export default fastifyPlugin(async function bazaarRoutes(app){
  app.log.info("[Bazaar] chain-scan routes mounted.");
  if (!ISSUER) app.log.warn("[Bazaar] Missing ISSUER_ADDR");
  if (!HOT_SEED) app.log.warn("[Bazaar] Missing HOT_SEED");
  if (!TAXON) app.log.warn("[Bazaar] Missing/invalid BAZAAR_TAXON (default 201)");

  // Health / introspection
  app.get("/chain/health", async (_req, reply) => {
    try {
      await ensureClient();
      return reply.send({ ok:true, issuer: ISSUER, taxon: TAXON, hot: hotAddress, wss: XRPL_WSS });
    } catch (e) {
      return reply.code(500).send({ ok:false, error: String(e?.message||e) });
    }
  });

  // Stock check
  app.get("/chain/available", async (req, reply) => {
    const sku = String(req.query?.sku || "").trim().toUpperCase();
    if (!sku) return reply.code(400).send({ error: "bad_sku" });
    try {
      const items = await listAvailableForSku(sku);
      return reply.send({ sku, available: items.length, items });
    } catch (e) {
      app.log.error(e, "[GET /chain/available]");
      return reply.code(500).send({ error: "server_error" });
    }
  });

  // Create directed sell-offer to buyer
  app.post("/chain/purchase", async (req, reply) => {
    try {
      requireAuth(req);
      const buyer = (req.headers["x-wallet"]||"").toString().trim();
      const { sku } = (req.body||{});
      if (!buyer || !buyer.startsWith("r")) return reply.code(400).send({ error:"bad_buyer" });
      if (!sku) return reply.code(400).send({ error:"bad_sku" });
      if (!(await accountExists(buyer))) return reply.code(400).send({ error:"buyer_not_found" });

      const item = await findOneForSku(sku);
      if (!item) return reply.code(404).send({ error:"no_inventory" });

      const holdKey = `bazaar:${buyer}:${item.nftoken_id}`;
      const hold = await holdJetFuel(buyer, item.jf||0, holdKey);
      if (!hold?.ok) return reply.code(402).send({ error:"insufficient_jetfuel" });

      const c  = await ensureClient();
      const tx = {
        TransactionType: "NFTokenCreateOffer",
        Account: hotAddress,
        NFTokenID: item.nftoken_id,
        Amount: String(item.xrpDrops || 0),
        Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken,
        Destination: buyer,
        Expiration: xrplExpiryIn(OFFER_TTL),
      };
      const prepared = await c.autofill(tx);
      const signed   = hotWallet.sign(prepared);
      const sub      = await c.submitAndWait(signed.tx_blob, { failHard:false });

      const ok = sub.result?.meta?.TransactionResult === "tesSUCCESS";
      if (!ok) {
        await releaseJetFuel(buyer, item.jf||0, holdKey);
        return reply.code(500).send({ error:"offer_failed", meta: sub.result?.meta });
      }
      const offerId = offerIdFromMeta(sub.result?.meta);
      if (!offerId) {
        await releaseJetFuel(buyer, item.jf||0, holdKey);
        return reply.code(500).send({ error:"no_offer_id" });
      }
      return reply.send({
        ok: true,
        sellOfferId: offerId,
        nftokenId: item.nftoken_id,
        sku,
        jf: item.jf||0,
        xrpDrops: item.xrpDrops||0,
        expiresInSec: OFFER_TTL
      });
    } catch (e) {
      if (String(e?.message||"").toLowerCase().includes("unauthorized"))
        return reply.code(401).send({ error:"unauthorized" });
      app.log.error(e, "[POST /chain/purchase]");
      return reply.code(500).send({ error:"server_error" });
    }
  });

  // Finalize JFUEL hold after user accepts the offer in wallet
  app.post("/chain/settle", async (req, reply) => {
    try {
      requireAuth(req);
      const buyer = (req.headers["x-wallet"]||"").toString().trim();
      const { offerId, jf=0, holdKey } = (req.body||{});
      if (!offerId) return reply.code(400).send({ error:"bad_offer" });

      const c = await ensureClient();
      let accepted;
      try {
        await c.request({ command:"ledger_entry", index: offerId });
        accepted = false; // offer still exists
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
      if (String(e?.message||"").toLowerCase().includes("unauthorized"))
        return reply.code(401).send({ error:"unauthorized" });
      return reply.code(500).send({ error:"server_error" });
    }
  });
});
