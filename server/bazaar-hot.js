// server/bazaar-hot.js
// XRPixel Jets — Bazaar (Hot Wallet simple path)
// v=2025-11-08-hot-simple-fix3
// - Lists NFTs from the HOT wallet (Taxon=201) by reading metadata on IPFS
// - Derives SKU, JetFuel/XRP prices from metadata attributes
// - Creates directed NFTokenCreateOffer to buyer (XRP only).
//   (No DB/JFUEL debit in this route to avoid 500s; keep it simple.)

import { Client as XRPLClient, Wallet as XRPLWallet } from "xrpl";

// --- ENV ---
const XRPL_WSS = process.env.XRPL_WSS || "wss://xrplcluster.com";
const HOT_SEED  = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || ""; // REQUIRED (secp256k1)
const TAXON     = Number(process.env.BAZAAR_TAXON ?? 201);
const ISSUER    = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || "rfYZ17wwhA4Be23fw8zthVmQQnrcdDRi52";
const OFFER_TTL_SEC = Number(process.env.BAZAAR_OFFER_TTL_SEC || 15 * 60); // 15 minutes

// --- XRPL wiring (single client + wallet) ---
const xrpl = {
  client: new XRPLClient(XRPL_WSS),
  wallet: HOT_SEED ? XRPLWallet.fromSeed(HOT_SEED) : null
};

async function ensureXRPL() {
  if (!xrpl.wallet) throw new Error("hot_wallet_missing");
  if (!xrpl.client.isConnected()) await xrpl.client.connect();
}

// --- helpers ---
function hexToUtf8(h) {
  try {
    const hex = String(h || "").replace(/^0x/i, "").trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2) return "";
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}
function ipfsHttpCandidates(u) {
  const id = String(u || "").replace(/^ipfs:\/\//, "").replace(/^ipfs\//, "");
  return [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`
  ];
}
async function fetchJsonMaybe(u) {
  try {
    const r = await fetch(u, { cache: "no-store" });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}
async function fetchMeta(uri) {
  if (!uri) return null;
  const urls = (uri.startsWith("ipfs://") || uri.startsWith("ipfs/")) ? ipfsHttpCandidates(uri) : [uri];
  for (const u of urls) {
    const j = await fetchJsonMaybe(u);
    if (j) return j;
  }
  return null;
}

// SKU + price parsers from metadata
function skuFromMeta(meta) {
  // explicit override
  const explicit = String(meta?.properties?.sku || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  if (explicit) return explicit;
  // derive from Kind
  const kind = String(
    (meta?.attributes || []).find(a => (a?.trait_type || "").toLowerCase() === "kind")?.value || ""
  ).toLowerCase();
  const K = ["attack", "defense", "speed"].includes(kind) ? kind.toUpperCase() : "ATTACK";
  return `BAZ-${K}-V1`;
}
function priceFromMeta(meta) {
  let jf = 0, xrp = 0;
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      if (k === "price (jfuel)") jf = Number(a.value) || 0;
      if (k === "price (xrp)")   xrp = Number(a.value) || 0;
    }
  }
  return { jf, xrpDrops: Math.round((Number.isFinite(xrp) ? xrp : 0) * 1_000_000) };
}
function deriveBuff(meta) {
  const atts = Object.create(null);
  if (Array.isArray(meta?.attributes)) {
    for (const a of meta.attributes) {
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      atts[k] = a?.value;
    }
  }
  const cand = ["attack", "defense", "speed"].find(k => Number(atts[k]) > 0);
  return cand ? `+${Number(atts[cand]) || 1} ${cand.toUpperCase()}` : null;
}

async function listHotSkus() {
  await ensureXRPL();
  const owner = xrpl.wallet.address;

  const items = [];
  let marker = null;
  do {
    const req = { command: "account_nfts", account: owner, limit: 400 };
    if (marker) req.marker = marker;
    const res = await xrpl.client.request(req);
    marker = res.result.marker;
    for (const nf of (res.result.account_nfts || [])) {
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI || "");
      const meta = await fetchMeta(uri);
      if (!meta) continue;
      if (String(meta?.properties?.issuer || "") !== ISSUER) continue;
      const sku = skuFromMeta(meta);
      const price = priceFromMeta(meta);
      const buff = deriveBuff(meta);

      items.push({
        nftoken_id: nf.NFTokenID,
        uri,
        sku,
        name: meta?.name || "Bazaar Upgrade",
        image: (meta?.image || ""),
        priceJetFuel: price.jf,
        priceXrpDrops: price.xrpDrops,
        previewBonuses: buff ? [buff] : []
      });
    }
  } while (marker);

  // collapse into SKU buckets
  const buckets = new Map();
  for (const it of items) {
    const b = buckets.get(it.sku) || {
      sku: it.sku,
      name: it.name,
      image: it.image?.startsWith("ipfs://") ? ipfsHttpCandidates(it.image)[0] : it.image,
      priceJetFuel: it.priceJetFuel,
      priceXrpDrops: it.priceXrpDrops,
      previewBonuses: it.previewBonuses || [],
      available: 0
    };
    b.available += 1;
    buckets.set(it.sku, b);
  }
  return [...buckets.values()];
}

async function pickOneBySku(sku) {
  await ensureXRPL();
  const owner = xrpl.wallet.address;

  let marker = null;
  do {
    const req = { command: "account_nfts", account: owner, limit: 400 };
    if (marker) req.marker = marker;
    const res = await xrpl.client.request(req);
    marker = res.result.marker;

    for (const nf of (res.result.account_nfts || [])) {
      if (Number(nf.NFTokenTaxon) !== TAXON) continue;
      const uri = hexToUtf8(nf.URI || "");
      const meta = await fetchMeta(uri);
      if (!meta) continue;
      if (String(meta?.properties?.issuer || "") !== ISSUER) continue;
      const wantSku = skuFromMeta(meta);
      if (wantSku !== sku) continue;

      // Skip tokens that already have sell offers
      try {
        const offers = await xrpl.client.request({ command: "nft_sell_offers", nft_id: nf.NFTokenID })
          .then(r => r.result.offers || [])
          .catch(() => []);
        if (offers && offers.length) continue;
      } catch {}

      const price = priceFromMeta(meta);
      return {
        nftoken_id: nf.NFTokenID,
        uri,
        priceXrpDrops: price.xrpDrops
      };
    }
  } while (marker);

  return null;
}

function rippleEpoch(unixSeconds) {
  return unixSeconds - 946684800;
}

async function createDirectedSellOffer({ nftoken_id, buyer, amountDrops }) {
  await ensureXRPL();
  const tx = {
    TransactionType: "NFTokenCreateOffer",
    Account: xrpl.wallet.address,
    NFTokenID: nftoken_id,
    Amount: String(amountDrops ?? 0), // 0 allowed
    Flags: 1,                         // tfSellNFToken
    Destination: buyer,
    Expiration: rippleEpoch(Math.floor(Date.now() / 1000) + OFFER_TTL_SEC)
  };
  const prepared = await xrpl.client.autofill(tx);
  const signed = xrpl.wallet.sign(prepared);
  const sub = await xrpl.client.submitAndWait(signed.tx_blob, { failHard: false });
  const r = sub?.result;
  const ok = (r?.engine_result || r?.meta?.TransactionResult) === "tesSUCCESS";
  if (!ok) {
    const d = r?.engine_result || r?.meta?.TransactionResult || "unknown";
    const e = new Error(`xrpl_offer_failed:${d}`);
    e.detail = r;
    throw e;
  }
  const nodes = r?.meta?.AffectedNodes || [];
  for (const n of nodes) {
    const cn = n.CreatedNode;
    if (cn && cn.LedgerEntryType === "NFTokenOffer") {
      return cn.LedgerIndex || cn.NewFields?.OfferID || cn.LedgerIndexHex || null;
    }
  }
  throw new Error("offer_id_parse_failed");
}

// ---- ROUTES ----
export async function registerBazaarHotRoutes(app) {
  if (!xrpl.wallet) {
    app.log.error("[BazaarHot] HOT_SEED missing (secp256k1 required).");
  }

  app.get("/bazaar/hot/ping", async (_req, reply) => {
    try {
      await ensureXRPL();
      reply.send({
        ok: true,
        wss: XRPL_WSS,
        hot: xrpl.wallet?.address || null,
        taxon: TAXON,
        issuer: ISSUER
      });
    } catch (e) {
      reply.code(500).send({ error: "ping_failed", detail: String(e.message || e) });
    }
  });

  // NOTE: index.js onRequest hook requires X-Wallet header unless whitelisted; client now provides it.
  app.get("/bazaar/hot/list", async (_req, reply) => {
    try {
      const skus = await listHotSkus();
      reply.send({ skus });
    } catch (e) {
      app.log.error({ err: e }, "[BazaarHot] list_failed");
      reply.code(500).send({ error: "list_failed" });
    }
  });

  app.post("/bazaar/hot/purchase", async (req, reply) => {
    try {
      const buyer = req.headers["x-wallet"];
      if (!buyer || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(buyer)) {
        return reply.code(400).send({ error: "missing_or_bad_X-Wallet" });
      }
      const sku = String(req.body?.sku || "").toUpperCase();
      if (!sku) return reply.code(400).send({ error: "bad_request" });

      // Find a candidate NFT in hot wallet matching this SKU
      const cand = await pickOneBySku(sku);
      if (!cand) return reply.code(409).send({ error: "sold_out" });

      // Create directed offer to buyer (uses metadata-derived XRP price)
      const offerId = await createDirectedSellOffer({
        nftoken_id: cand.nftoken_id,
        buyer,
        amountDrops: cand.priceXrpDrops || 0
      });

      return reply.send({ ok: true, sellOfferId: offerId, nftokenId: cand.nftoken_id });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.startsWith("xrpl_offer_failed")) {
        return reply.code(500).send({ error: "purchase_failed", detail: msg.split(":")[1] || "xrpl" });
      }
      if (msg.includes("hot_wallet_missing")) {
        return reply.code(500).send({ error: "server_hot_wallet_missing" });
      }
      if (msg.includes("actNotFound") || msg.includes("Account not found")) {
        return reply.code(500).send({ error: "account_info_failed", detail: "Account not found." });
      }
      return reply.code(500).send({ error: "purchase_failed" });
    }
  });

  app.addHook("onClose", async () => {
    try { if (xrpl.client?.isConnected()) await xrpl.client.disconnect(); } catch {}
  });

  app.log.info({
    wss: XRPL_WSS,
    issuer: ISSUER,
    hot: xrpl.wallet?.address || "(none)"
  }, "[BazaarHot] mounted");
}
