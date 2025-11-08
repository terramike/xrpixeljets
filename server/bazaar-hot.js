// server/bazaar-hot.js
// Minimal "Hot Wallet Bazaar"
// - Lists preminted NFTs in HOT wallet (issuer=rfYZ..., taxon=201)
// - Reads price from metadata: Price (JFUEL), Price (XRP)
// - Creates directed SellOffer to buyer for the XRP part
// ENV needed: HOT_SEED (sasa...), ISSUER_ADDR (rfYZ...), XRPL_WSS
// Optional: UPGRADE_TAXON=201, PRICE_DEFAULT_JFUEL=15000, PRICE_DEFAULT_XRP_DROPS=250000

import { Client as XRPLClient, Wallet as XRPLWallet } from "xrpl";

const XRPL_WSS  = process.env.XRPL_WSS || "wss://xrplcluster.com";
const HOT_SEED  = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || "";
const ISSUER    = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || "";
const TAXON     = Number(process.env.UPGRADE_TAXON || 201);
const DEF_JFUEL = Number(process.env.PRICE_DEFAULT_JFUEL || 15000);
const DEF_DROPS = Number(process.env.PRICE_DEFAULT_XRP_DROPS || 250000);

const isR = r => typeof r==="string" && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(r);
const ipfsHTTP = (uri) => !uri ? null : uri.startsWith("ipfs://")
  ? "https://cloudflare-ipfs.com/ipfs/" + uri.slice(7)
  : uri;

function priceFromMeta(meta){
  // attribute keys are matched case-insensitively
  const pick = (name) => {
    const A = meta?.attributes;
    if (!Array.isArray(A)) return null;
    const f = A.find(t => (t?.trait_type||"").toLowerCase() === name.toLowerCase());
    return f?.value ?? null;
  };
  const jf   = Number(pick("Price (JFUEL)"));
  const xrp  = Number(pick("Price (XRP)"));
  return {
    jf: Number.isFinite(jf) ? jf : DEF_JFUEL,
    xrpDrops: Number.isFinite(xrp) ? Math.round(xrp * 1_000_000) : DEF_DROPS
  };
}

export async function registerBazaarHotRoutes(app){
  if (!HOT_SEED)  app.log.warn("[BazaarHot] HOT_SEED missing");
  if (!isR(ISSUER)) app.log.warn("[BazaarHot] ISSUER_ADDR missing/invalid");

  const client = new XRPLClient(XRPL_WSS);
  const hot    = XRPLWallet.fromSeed(HOT_SEED);
  const HOT    = hot.classicAddress;

  async function ensureConnected(){
    if (!client.isConnected()) await client.connect();
  }

  async function listHot(){
    await ensureConnected();
    const out = [];
    let marker = null;
    do {
      const r = await client.request({ command:"account_nfts", account: HOT, limit: 400, marker });
      marker = r.result.marker;
      for (const n of (r.result.account_nfts||[])) {
        const issuer = n.Issuer || n.issuer;
        const taxon  = n.NFTokenTaxon ?? n.nft_taxon ?? n.TokenTaxon;
        if (issuer === ISSUER && Number(taxon) === TAXON) {
          out.push({
            nftoken_id: n.NFTokenID || n.nft_id || n.TokenID,
            uri: n.URI ? Buffer.from(n.URI, "hex").toString("utf8") : null
          });
        }
      }
    } while (marker);
    return out;
  }

  async function fetchMeta(uri){
    try {
      const url = ipfsHTTP(uri);
      if (!url) return null;
      const res = await fetch(url, { timeout: 8000 });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // GET: list items currently in the hot wallet (issuer/taxon filtered)
  app.get("/bazaar/hot/list", async (req, reply) => {
    try {
      if (!isR(ISSUER)) return reply.code(503).send({ error: "config_bad_issuer" });
      await ensureConnected();
      const raw = await listHot();

      // attach name/kind/prices from metadata
      const items = await Promise.all(raw.map(async it => {
        const meta = it.uri ? await fetchMeta(it.uri) : null;
        const { jf, xrpDrops } = priceFromMeta(meta || {});
        const name = meta?.name || "Bazaar Upgrade";
        const kind = (() => {
          const A = meta?.attributes;
          if (!Array.isArray(A)) return "";
          const f = A.find(a => (a?.trait_type||"").toLowerCase()==="kind");
          return (f?.value||"").toString();
        })();
        return { ...it, name, kind, priceJetFuel: jf, priceXrpDrops: xrpDrops };
      }));

      return reply.send({ items });
    } catch (e) {
      req.log.error(e, "[BazaarHot] list error");
      return reply.code(500).send({ error:"list_failed" });
    }
  });

  // POST: create directed SellOffer (hot -> buyer) at metadata price (XRP part)
  // Headers: X-Wallet: r...,  Authorization: Bearer <JWT> (optional for your JFUEL gate)
  // Body: { nftoken_id }
  app.post("/bazaar/hot/buy", async (req, reply) => {
    try {
      const buyer = req.headers["x-wallet"];
      if (!isR(buyer)) return reply.code(401).send({ error: "missing_or_bad_X-Wallet" });

      const nftoken_id = req.body?.nftoken_id;
      if (typeof nftoken_id !== "string" || nftoken_id.length < 16)
        return reply.code(400).send({ error: "bad_nftoken_id" });

      await ensureConnected();

      // verify NFT belongs to HOT and matches issuer/taxon
      const info = await client.request({ command:"nft_info", nft_id: nftoken_id }).catch(()=>null);
      if (!info?.result) return reply.code(404).send({ error: "nft_not_found" });
      const owner = info.result.owner;
      const issuer= info.result.issuer;
      const taxon = info.result.nft_taxon ?? info.result.NFTokenTaxon;
      if (owner !== HOT) return reply.code(409).send({ error: "not_in_hot_wallet" });
      if (issuer !== ISSUER || Number(taxon)!==TAXON) return reply.code(409).send({ error: "not_official_upgrade" });

      // price from meta (fallback to defaults)
      const uriHex = info.result.nft_uri;
      const uri    = uriHex ? Buffer.from(uriHex, "hex").toString("utf8") : null;
      const meta   = uri ? await fetchMeta(uri) : null;
      const { jf, xrpDrops } = priceFromMeta(meta || {});

      // TODO (optional): enforce JFUEL debit server-side with your existing game store.
      // If you have a function debitJetFuel(buyer, jf), call it here and 402 on failure.

      // create directed SellOffer
      const tx = {
        TransactionType: "NFTokenCreateOffer",
        Account: HOT,
        NFTokenID: nftoken_id,
        Amount: String(xrpDrops),
        Flags: 1,               // tfSellNFToken
        Destination: buyer
      };
      const prepared = await client.autofill(tx);
      const signed   = hot.sign(prepared);
      const subm     = await client.submitAndWait(signed.tx_blob);

      let offerId = null;
      for (const n of (subm?.result?.meta?.AffectedNodes||[])) {
        const c = n.CreatedNode;
        if (c?.LedgerEntryType === "NFTokenOffer") { offerId = c.LedgerIndex; break; }
      }
      if (!offerId) return reply.code(500).send({ error:"offer_create_unknown" });

      const acceptTx = { TransactionType: "NFTokenAcceptOffer", Account: buyer, NFTokenSellOffer: offerId };

      return reply.send({ ok:true, nftoken_id, uri: uri || null, price:{ jf, xrpDrops }, offerId, acceptTx });
    } catch (e) {
      req.log.error(e, "[BazaarHot] buy error");
      return reply.code(500).send({ error:"buy_failed" });
    }
  });
}
