// server/bazaar-hot.js — 2025-11-08 hot-keys+secp enforced
// Routes:
//   GET  /bazaar/hot/ping    (OPEN)
//   GET  /bazaar/hot/check   (OPEN)
//   GET  /bazaar/hot/list    (OPEN)
//   POST /bazaar/hot/purchase {sku}  (requires JWT + X-Wallet via global guard)
//
// Behavior:
// - Initializes hot wallet from explicit HEX keys if provided, else from seed.
// - Enforces secp256k1 unless ALLOW_ED_HOT=true.
// - Leaves list/purchase logic intact; only wallet init is upgraded.
//
// Required env (project-wide):
//   XRPL_WSS=wss://xrplcluster.com
//   BAZAAR_TAXON=201
//   ISSUER_ADDR=rfYZ17wwhA4Be23fw8zthVmQQnrcdDRi52  (Upgrades issuer)
//
// Hot wallet env (choose ONE init path):
//   A) RAW KEYS (preferred):
//      HOT_PUBLIC_HEX=02... (or 03...)
//      HOT_PRIVATE_HEX=<64-hex>
//      HOT_ADDR=rJz7ooSyXQKEiS5dSucEyjxz5t6Ewded6n (optional assert)
//   B) SEED fallback:
//      HOT_SEED=<secp family seed starting with 's...' (NOT sEd...)>
//      (or HOT_WALLET_SEED=...)
//
// Policy env:
//   ALLOW_ED_HOT=false
//
// Note: This file assumes your global index.js already whitelists ping/check/list.

import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';
import * as keypairs from 'ripple-keypairs';

// ---------- env ----------
const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';

const HOT_PUBLIC_HEX  = (process.env.HOT_PUBLIC_HEX || process.env.HOT_PUB_HEX || '').toUpperCase().trim();
const HOT_PRIVATE_HEX = (process.env.HOT_PRIVATE_HEX || process.env.HOT_PRV_HEX || '').toUpperCase().trim();

const HOT_SEED = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
const HOT_ADDR = process.env.HOT_ADDR || '';

const ALLOW_ED_HOT = String(process.env.ALLOW_ED_HOT || 'false').toLowerCase() === 'true';

const BAZAAR_TAXON = Number(process.env.BAZAAR_TAXON || 201);
const ISSUER_ADDR  = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || null;

// ---------- helpers ----------
const isSecpPK = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-F]{64}$/i.test(pk);
const isEdPK   = (pk) => typeof pk === 'string' && /^ED[0-9A-F]{64}$/i.test(pk);
const toDrops  = (xrp) => {
  const n = Number(xrp);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(Math.round(n * 1_000_000));
};

// ---------- hot wallet state ----------
let xrpl = { client: null, wallet: null, algo: 'unknown', note: null };

async function ensureXRPL(app) {
  if (xrpl.client && xrpl.client.isConnected() && xrpl.wallet) return xrpl;
  xrpl.client = new XRPLClient(XRPL_WSS);

  // Priority A: explicit HEX keys (no guessing)
  if (HOT_PUBLIC_HEX && HOT_PRIVATE_HEX) {
    if (!isSecpPK(HOT_PUBLIC_HEX)) {
      xrpl.note = 'hot_keys_invalid: HOT_PUBLIC_HEX must be compressed secp (02/03 + 64 hex)';
      throw new Error(xrpl.note);
    }
    xrpl.wallet = new XRPLWallet(HOT_PUBLIC_HEX, HOT_PRIVATE_HEX);
    xrpl.algo = 'secp256k1';
  } else if (HOT_SEED) {
    // Priority B: seed fallback (may be secp or ed, so we must check)
    xrpl.wallet = XRPLWallet.fromSeed(HOT_SEED);
    const pub = String(xrpl.wallet.publicKey || '').toUpperCase();
    xrpl.algo = isSecpPK(pub) ? 'secp256k1' : (isEdPK(pub) ? 'ed25519' : 'unknown');
  } else {
    xrpl.note = 'hot_wallet_init_failed: missing HOT_PUBLIC_HEX/HOT_PRIVATE_HEX or HOT_SEED';
    throw new Error(xrpl.note);
  }

  // Optional address assertion
  if (HOT_ADDR && xrpl.wallet?.address && xrpl.wallet.address !== HOT_ADDR) {
    xrpl.note = `hot_addr_mismatch: expected ${HOT_ADDR}, got ${xrpl.wallet.address}`;
    throw new Error(xrpl.note);
  }

  // Enforce secp unless explicitly allowed for hot
  if (xrpl.algo !== 'secp256k1' && !ALLOW_ED_HOT) {
    xrpl.note = 'secp_required: public key must start with 02/03; Ed25519 (ED…) is banned';
    throw new Error(xrpl.note);
  }

  if (!xrpl.client.isConnected()) {
    await xrpl.client.connect();
  }
  return xrpl;
}

// ---------- SKU cache (intentionally minimal; your existing logic may be richer) ----------
let lastList = { at: 0, skus: [] };

async function buildSkusFromHot(app) {
  // Connect & ensure wallet
  await ensureXRPL(app);
  // Pull NFTs from the hot wallet account
  const res = await xrpl.client.request({
    command: 'account_nfts',
    account: xrpl.wallet.address,
    limit: 400
  });

  // Map to lightweight SKUs (your client-side parser reads metadata/attributes)
  const items = (res.result.account_nfts || []).map(n => {
    // Carry through fields your front-end expects
    // We don't fetch metadata here; the client can deref URI/IPFS like before
    return {
      nftokenId: n.NFTokenID,
      uri: n.URI || null,
      taxon: n.NFTokenTaxon,
      flags: n.Flags,
      issuer_hint: n.Issuer || null // not always present; kept for debugging
    };
  });

  lastList = { at: Date.now(), skus: items };
  return items;
}

// ---------- routes ----------
export async function registerBazaarHotRoutes(app) {
  // OPEN: ping
  app.get('/bazaar/hot/ping', async (_req, reply) => {
    try {
      await ensureXRPL(app);
      reply.send({
        ok: true,
        wss: XRPL_WSS,
        hot: xrpl.wallet.address,
        algo: xrpl.algo,
        secp: xrpl.algo === 'secp256k1',
        taxon: BAZAAR_TAXON,
        issuer: ISSUER_ADDR,
        allowEdForHot: ALLOW_ED_HOT
      });
    } catch (e) {
      reply.send({
        ok: false,
        wss: XRPL_WSS,
        hot: null,
        algo: xrpl.algo || 'unknown',
        secp: false,
        taxon: BAZAAR_TAXON,
        issuer: ISSUER_ADDR,
        allowEdForHot: ALLOW_ED_HOT,
        note: xrpl.note || String(e?.message || e)
      });
    }
  });

  // OPEN: account check
  app.get('/bazaar/hot/check', async (_req, reply) => {
    try {
      await ensureXRPL(app);
      const r = await xrpl.client.request({ command: 'account_info', account: xrpl.wallet.address, ledger_index: 'validated' });
      reply.send({ ok: true, account_data: r.result.account_data });
    } catch (e) {
      reply.code(500).send({ ok: false, error: 'account_info_failed', detail: String(e?.message || e) });
    }
  });

  // OPEN: list inventory (scan hot wallet)
  app.get('/bazaar/hot/list', async (_req, reply) => {
    try {
      const age = Date.now() - lastList.at;
      if (age > 15_000 || lastList.skus.length === 0) {
        await buildSkusFromHot(app);
      }
      reply.send({ skus: lastList.skus, taxon: BAZAAR_TAXON });
    } catch (e) {
      reply.code(500).send({ error: 'list_failed', detail: String(e?.message || e) });
    }
  });

  // AUTHED: create a directed SellOffer to buyer for selected SKU
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    // Global guard already required X-Wallet + JWT; trust req.wallet
    const buyer = req.wallet;
    const { sku } = req.body || {};
    if (!buyer) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
    if (!sku)   return reply.code(400).send({ error: 'bad_request', detail: 'missing sku' });

    try {
      await ensureXRPL(app);

      // Your existing code probably resolves sku -> { nftokenId, priceXRP } using metadata.
      // Here we assume the client sent nftokenId directly as sku, and the client knows the price.
      // If you pass price in body, prefer verifying against metadata on the server.
      const nftokenId = sku;

      // TEMP: expect priceXRP in header/body (use your existing resolver otherwise)
      const priceXRP = Number(req.body?.priceXRP);
      if (!Number.isFinite(priceXRP) || priceXRP <= 0) {
        return reply.code(400).send({ error: 'bad_price' });
      }
      const drops = toDrops(priceXRP);
      if (!drops) return reply.code(400).send({ error: 'bad_price' });

      // Create directed SellOffer
      const tx = {
        TransactionType: 'NFTokenCreateOffer',
        Account: xrpl.wallet.address,
        NFTokenID: nftokenId,
        Amount: drops,
        Destination: buyer,
        Flags: 1, // tfSellNFToken
      };

      const prepared = await xrpl.client.autofill(tx);
      const signed = xrpl.wallet.sign(prepared);
      const sub = await xrpl.client.submitAndWait(signed.tx_blob);

      if (sub.result.engine_result !== 'tesSUCCESS') {
        return reply.code(500).send({
          error: 'create_offer_failed',
          detail: sub.result.engine_result_message || sub.result.engine_result
        });
      }

      // Extract offer ID from metadata
      const meta = sub.result.meta || sub.result.meta_json || {};
      let sellOfferId = null;
      try {
        const obj = meta.AffectedNodes?.find(n =>
          (n.CreatedNode?.LedgerEntryType === 'NFTokenOffer') &&
          (n.CreatedNode?.NewFields?.Owner === xrpl.wallet.address)
        );
        sellOfferId = obj?.CreatedNode?.LedgerIndex || null;
      } catch {}

      reply.send({ ok: true, sellOfferId, nftokenId });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('secp_required') || msg.includes('banned')) {
        return reply.code(500).send({ error: 'server_hot_wallet_missing', detail: `hot_wallet_init_failed: ${msg}` });
      }
      return reply.code(500).send({ error: 'purchase_failed', detail: msg });
    }
  });
}
