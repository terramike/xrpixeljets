// server/bazaar-hot.js — 2025-11-08 hot-scan-only (no JSON inventory)
// Requires env: XRPL_WSS, HOT_SEED (secp), ISSUER_ADDR, BAZAAR_ENABLED
// Optional: BAZAAR_OFFER_TTL_SEC (default 900)

import { Client as XRPLClient, Wallet as XRPLWallet } from "xrpl";
import * as keypairs from "ripple-keypairs";

const XRPL_WSS = process.env.XRPL_WSS || "wss://xrplcluster.com";
const HOT_SEED  = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || "";
const ISSUER    = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || "";
const ENABLED   = (process.env.BAZAAR_ENABLED || "true").toLowerCase() !== "false";
const OFFER_TTL_SEC = Number(process.env.BAZAAR_OFFER_TTL_SEC || 900);

// In-memory locks so two buyers can’t grab the same NFTokenID at once.
const locked = new Set();

function rippleEpoch(unix) { return Math.floor(unix) - 946684800; }
function okClassic(r){ return typeof r === "string" && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(r); }
function hex(h){ return (h||"").toUpperCase(); }
function isSecpPub(pk){ return typeof pk==="string" && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk); }

function requireWalletHeader(req, reply){
  const w = req.headers["x-wallet"];
  if (!okClassic(w)) { reply.code(400).send({ error:"missing_or_bad_X-Wallet" }); return null; }
  return w;
}

async function xrplReady(){
  if (!HOT_SEED) throw new Error("hot_wallet_missing");
  const hot = XRPLWallet.fromSeed(HOT_SEED); // xrpl enforces secp seeds
  // extra paranoia: enforce secp pub
  const pub = hex(hot.publicKey);
  if (!isSecpPub(pub)) throw new Error("hot_wallet_algo_error");
  const client = new XRPLClient(XRPL_WSS);
  if (!client.isConnected()) await client.connect();

  // sanity: ensure account exists
  try {
    const ai = await client.request({ command:"account_info", account: hot.address, ledger_index:"current" });
    if (!ai?.result?.account_data) throw new Error("account_info_failed");
  } catch (e) {
    const msg = String(e?.data?.error_message || e?.message || "");
    throw new Error(msg || "account_info_failed");
  }
  return { client, hot };
}

// Parse a few useful bits from NFT metadata json (if available)
function parseKindFromMeta(m){
  // XRPixel Bazaar style (attributes w/ Kind)
  const attrs = Array.isArray(m?.attributes) ? m.attributes : [];
  const kind = (attrs.find(a => (a?.trait_type||"").toLowerCase()==="kind")?.value || "").toString().toLowerCase();
  return ["attack","speed","defense"].includes(kind) ? kind : null;
}

async function fetchUriJson(uri){
  // Only supports ipfs://; xrp.cafe gateways fetchable by client, but on server we avoid external fetch by design.
  // If you later allow fetch, plug it here. For now we don’t fetch; we’ll rely on SKU or Kind that we can infer.
  return null;
}

// Scan all NFTs owned by HOT wallet that match the issuer (and optional taxon/kind)
async function scanHotOwned({ client, hot, issuer, taxon, wantKind }){
  const items = [];
  let marker = null;
  do {
    const res = await client.request({
      command: "account_nfts",
      account: hot.address,
      ledger_index: "current",
      limit: 400,
      marker
    });
    marker = res.result.marker;

    for (const n of res.result.account_nfts || []){
      if (issuer && n.Issuer !== issuer) continue;
      if (typeof taxon === "number" && Number(n.NFTokenTaxon) !== Number(taxon)) continue;
      // Try to infer kind from URI json if ever enabled. For now, accept all and let SKU filtering handle price/label.
      items.push({
        nftoken_id: n.NFTokenID,
        issuer: n.Issuer,
        taxon: Number(n.NFTokenTaxon),
        uri: n.URI || null
      });
    }
  } while (marker);

  // optional soft filter by Kind if you later fetch metadata
  if (wantKind) {
    // If we had metadata, we would filter here. For now, return as-is.
  }

  return items;
}

async function createDirectedSellOffer({ client, hot, nftoken_id, destination, amountDrops }){
  const prepared = await client.autofill({
    TransactionType: "NFTokenCreateOffer",
    Account: hot.address,
    NFTokenID: nftoken_id,
    Amount: String(amountDrops||0),
    Flags: 1, // tfSellNFToken
    Destination: destination,
    Expiration: rippleEpoch(Date.now()/1000 + OFFER_TTL_SEC)
  });
  const signed = hot.sign(prepared);
  const sub = await client.submitAndWait(signed.tx_blob, { failHard:false });
  const r = sub?.result;
  const ok = (r?.engine_result || r?.meta?.TransactionResult) === "tesSUCCESS";
  if (!ok) throw new Error(`xrpl_offer_failed:${r?.engine_result || r?.meta?.TransactionResult || "unknown"}`);

  const nodes = r?.meta?.AffectedNodes || [];
  for (const n of nodes){
    const cn = n.CreatedNode;
    if (cn && cn.LedgerEntryType === "NFTokenOffer"){
      return cn.LedgerIndex || cn.NewFields?.OfferID || cn.LedgerIndexHex || null;
    }
  }
  throw new Error("offer_id_parse_failed");
}

export async function registerBazaarHotRoutes(app){
  if (!ENABLED){
    app.get("/bazaar/hot/list", async (_req, reply) => reply.code(503).send({ error:"disabled" }));
    app.post("/bazaar/hot/purchase", async (_req, reply) => reply.code(503).send({ error:"disabled" }));
    return;
  }

  // List hot inventory (minimal info; client will decorate UI)
  app.get("/bazaar/hot/list", async (req, reply) => {
    const wallet = requireWalletHeader(req, reply); if (!wallet) return;
    try {
      const { client, hot } = await xrplReady();
      const taxon = Number(req.query?.taxon ?? 201);
      const rows = await scanHotOwned({ client, hot, issuer: ISSUER, taxon });

      // Group by URI (so 2/2 etc still list as same ‘product’) and return available count + ids
      const byUri = new Map();
      for (const it of rows){
        const key = (it.uri || "").toString();
        const g = byUri.get(key) || { uri: key, items: [] };
        g.items.push({ id: it.nftoken_id, taxon: it.taxon });
        byUri.set(key, g);
      }
      const out = [];
      for (const g of byUri.values()){
        out.push({ uri: g.uri, count: g.items.filter(x => !locked.has(x.id)).length, ids: g.items.map(x=>x.id) });
      }
      reply.send({ ok:true, issuer: ISSUER, hot: hot.address, groups: out });
    } catch (e) {
      req.log.error({ err:e }, "hot_list_failed");
      reply.code(500).send({ error:"list_failed" });
    }
  });

  // Purchase = choose one unlocked NFTokenID from the current scan and create directed offer
  app.post("/bazaar/hot/purchase", async (req, reply) => {
    const wallet = requireWalletHeader(req, reply); if (!wallet) return;
    try {
      const { client, hot } = await xrplReady();

      // very light input: optional explicit nftoken_id, else pick first available; optional price in drops for future price tiers
      const body = req.body || {};
      const wantId = (body.nftoken_id || "").trim();
      const priceDrops = Number(body.priceDrops || 250000); // default 0.25 XRP
      const taxon = Number(body.taxon ?? 201);

      // scan
      const rows = await scanHotOwned({ client, hot, issuer: ISSUER, taxon });
      let pick = null;

      if (wantId){
        pick = rows.find(r => r.nftoken_id === wantId) || null;
      } else {
        pick = rows.find(r => !locked.has(r.nftoken_id)) || null;
      }

      if (!pick) return reply.code(409).send({ error:"sold_out" });

      // lock & offer
      locked.add(pick.nftoken_id);
      try {
        const sellOfferId = await createDirectedSellOffer({
          client, hot, nftoken_id: pick.nftoken_id, destination: wallet, amountDrops: priceDrops
        });
        return reply.send({
          ok:true,
          nftokenId: pick.nftoken_id,
          sellOfferId,
          ttlSec: OFFER_TTL_SEC
        });
      } catch (e) {
        locked.delete(pick.nftoken_id);
        const msg = String(e?.message || "");
        if (msg.startsWith("xrpl_offer_failed")) {
          return reply.code(500).send({ error:"xrpl_offer_failed", detail: msg.split(":")[1] || "unknown" });
        }
        return reply.code(500).send({ error:"purchase_failed" });
      }
    } catch (e) {
      const m = String(e?.message||"");
      if (m.includes("account_info_failed")) return reply.code(500).send({ error:"account_info_failed" });
      if (m.includes("hot_wallet_missing"))  return reply.code(500).send({ error:"hot_wallet_missing" });
      return reply.code(500).send({ error:"purchase_failed" });
    }
  });

  // Optional: unlock on settle failure (client can call if accept fails)
  app.post("/bazaar/hot/unlock", async (req, reply) => {
    const wallet = requireWalletHeader(req, reply); if (!wallet) return;
    const id = (req.body||{}).nftoken_id;
    if (id && locked.has(id)) locked.delete(id);
    reply.send({ ok:true });
  });
}
