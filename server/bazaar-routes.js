// bazaar-routes.js  v2025-11-07a  (ESM)
import fastifyPlugin from "fastify-plugin";
import jwt from "jsonwebtoken";
import * as xrpl from "xrpl";

// --- Config
const XRPL_WSS   = process.env.XRPL_WSS || "wss://xrplcluster.com";
const ISSUER     = process.env.ISSUER_ADDR;                    // rfYZ…
const TAXON      = Number(process.env.BAZAAR_TAXON ?? 201);
const HOT_SEED   = process.env.HOT_SEED;                       // 's...' secp256k1
const JWT_SECRET = process.env.JWT_SECRET || "dev";
const OFFER_TTL  = Number(process.env.BAZAAR_OFFER_TTL_SEC ?? 900); // 15 min

// --- Single XRPL client + Hot wallet
let client;
let hotWallet;
let hotAddress;

async function ensureClient() {
  if (!client) {
    client = new xrpl.Client(XRPL_WSS, { connectionTimeout: 20000 });
    await client.connect();
  } else if (!client.isConnected()) {
    await client.connect();
  }
  if (!hotWallet) {
    // Force secp256k1. Wallet.fromSeed auto-detects, but we enforce by using keypairs if needed.
    hotWallet = xrpl.Wallet.fromSeed(HOT_SEED); // Your seed is secp, so this is fine
    hotAddress = hotWallet.classicAddress;
    if (!hotAddress) throw new Error("Hot wallet address derive failed");
  }
  return client;
}

// --- JWT helper
function requireAuth(req) {
  const hdr = req.headers?.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("Unauthorized");
  try { return jwt.verify(m[1], JWT_SECRET); }
  catch { throw new Error("Unauthorized"); }
}

// --- Small helpers
function nowRippleEpochPlus(sec) {
  // XRPL expiration = seconds since 2000-01-01T00:00:00Z
  const unix = Math.floor(Date.now()/1000);
  return unix - 946684800 + sec;
}

function hexToUtf8(hex) {
  try {
    const h = String(hex||"").replace(/^0x/i,'').trim();
    if (!/^[0-9a-fA-F]+$/.test(h) || h.length%2) return "";
    const bytes = new Uint8Array(h.match(/.{2}/g).map(b=>parseInt(b,16)));
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}

function deriveStatBonus(meta){
  const stat = String(meta?.stat ?? meta?.properties?.stat ?? "").toLowerCase();
  const bonus = Number(meta?.bonus ?? meta?.properties?.bonus ?? NaN);
  if (["attack","defense","speed"].includes(stat) && Number.isFinite(bonus) && bonus>0) return { stat, bonus };
  const atts = Object.create(null);
  if (Array.isArray(meta?.attributes)) for (const a of meta.attributes) {
    const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
    atts[k] = a?.value;
  }
  const cand = ["attack","defense","speed"].find(k => Number(atts[k])>0);
  if (cand) return { stat: cand, bonus: Number(atts[cand])||1 };
  return null;
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

// Fetch NFT metadata (IPFS gateways)
async function fetchMeta(uri){
  const id = String(uri||"").replace(/^ipfs:\/\//,"").replace(/^ipfs\//,"");
  const urls = [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`
  ];
  for (const u of urls) {
    try { const r = await fetch(u, { cache: "no-store" }); if (r.ok) return await r.json(); } catch {}
  }
  return null;
}

// Return a list of HOT nfts for the SKU we want
async function findOneNftForSku(sku) {
  const c = await ensureClient();
  let marker = undefined;
  while (true) {
    const res = await c.request({ command:"account_nfts", account: hotAddress, limit: 400, marker });
    for (const nf of (res.result.account_nfts||[])) {
      if (nf.Issuer !== ISSUER) continue;
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI||"");
      const meta = await fetchMeta(uri);
      if (!meta) continue;

      // Compute server-side SKU in the same way the client does
      const sb  = deriveStatBonus(meta);
      const kind = sb?.stat || "attack";
      const serverSku = (meta?.properties?.sku || meta?.properties?.slugPrefix || `BAZ-${kind.toUpperCase()}-V1`)
        .toString().toUpperCase().replace(/[^A-Z0-9_-]/g,"");

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

// Optional: verify buyer exists (account_info)
async function checkAccountExists(addr) {
  const c = await ensureClient();
  try {
    await c.request({ command:"account_info", account: addr, ledger_index:"current" });
    return true;
  } catch { return false; }
}

// Extract OfferID from validated meta
function extractOfferIdFromMeta(meta){
  const nodes = meta?.AffectedNodes || [];
  for (const n of nodes) {
    const created = n?.CreatedNode;
    if (created?.LedgerEntryType === "NFTokenOffer") {
      return created.LedgerIndex; // Offer ID
    }
  }
  return null;
}

// Replace these with your real JetFuel store hooks
async function assertAndHoldJetFuel(buyer, amountJFUEL, holdKey) {
  // TODO: integrate with your profile store. For now, accept if 0 or positive and pretend to hold.
  if (!amountJFUEL) return { ok:true };
  // Example: const ok = await profileStore.holdJetFuel(buyer, amountJFUEL, holdKey);
  return { ok:true };
}
async function finalizeJetFuel(buyer, amountJFUEL, holdKey) {
  if (!amountJFUEL) return { ok:true };
  // Example: await profileStore.commitHold(holdKey)
  return { ok:true };
}
async function refundJetFuel(buyer, amountJFUEL, holdKey) {
  if (!amountJFUEL) return { ok:true };
  // Example: await profileStore.releaseHold(holdKey)
  return { ok:true };
}

export default fastifyPlugin(async function bazaarRoutes(app){
  app.post("/bazaar/purchase", async (req, reply) => {
    try {
      const auth = requireAuth(req);
      const buyer = (req.headers["x-wallet"]||"").toString().trim();
      const { sku } = req.body || {};
      if (!buyer || !buyer.startsWith("r")) return reply.code(400).send({ error:"bad_buyer" });
      if (!sku) return reply.code(400).send({ error:"bad_sku" });
      if (!(await checkAccountExists(buyer))) return reply.code(400).send({ error:"buyer_not_found" });

      const item = await findOneNftForSku(sku);
      if (!item) return reply.code(404).send({ error:"no_inventory" });

      // Hold JetFuel server-side first
      const holdKey = `bazaar:${buyer}:${item.nft.NFTokenID}`;
      const hold = await assertAndHoldJetFuel(buyer, item.priceJFUEL, holdKey);
      if (!hold?.ok) return reply.code(400).send({ error:"insufficient_jetfuel" });

      // Create directed sell offer
      const c = await ensureClient();
      const tx = {
        TransactionType: "NFTokenCreateOffer",
        Account: hotAddress,
        NFTokenID: item.nft.NFTokenID,
        Amount: String(item.priceXRPDrops || 0),
        Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken,
        Destination: buyer,
        Expiration: nowRippleEpochPlus(OFFER_TTL)
      };
      const prepared = await xrpl.autofill(c, tx);               // uses network fee & sequence
      const signed   = hotWallet.sign(prepared);
      const sub      = await c.submitAndWait(signed.tx_blob, { failHard: false });
      if (sub.result?.meta?.TransactionResult !== "tesSUCCESS") {
        await refundJetFuel(buyer, item.priceJFUEL, holdKey);
        return reply.code(500).send({ error:"offer_failed", meta: sub.result?.meta });
      }
      const offerId = extractOfferIdFromMeta(sub.result?.meta);
      if (!offerId) {
        await refundJetFuel(buyer, item.priceJFUEL, holdKey);
        return reply.code(500).send({ error:"no_offer_id" });
      }

      // Optionally store a pending record so your janitor can reclaim
      // await bazaarStore.trackPending({ offerId, nftId: item.nft.NFTokenID, sku, buyer, expiresAt: Date.now()+OFFER_TTL*1000, holdKey, jf:item.priceJFUEL });

      return reply.send({ sellOfferId: offerId, nftId: item.nft.NFTokenID, xrpDrops: item.priceXRPDrops || 0, jf: item.priceJFUEL || 0 });
    } catch (e) {
      if (String(e.message).toLowerCase().includes("unauthorized")) return reply.code(401).send({ error:"unauthorized" });
      app.log.error(e, "[/bazaar/purchase]");
      return reply.code(500).send({ error:"server_error" });
    }
  });

  app.post("/bazaar/settle", async (req, reply) => {
    try {
      requireAuth(req);
      const { offerId } = req.body || {};
      if (!offerId) return reply.code(400).send({ error:"bad_offer" });

      const c = await ensureClient();
      // If the offer is gone from ledger, it was accepted/canceled.
      let accepted = false;
      try {
        await c.request({ command:"ledger_entry", index: offerId });
        accepted = false; // still exists
      } catch {
        accepted = true;  // not found => consumed
      }

      // TODO: look up your pending record by offerId, get buyer/jf/holdKey
      const pending = null;
      const buyer = req.headers["x-wallet"] || null;
      const jf = 0, holdKey = null;

      if (accepted) {
        await finalizeJetFuel(buyer, jf, holdKey);
        // await bazaarStore.markSold(offerId);
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
