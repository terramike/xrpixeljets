// server/bazaar-hot.js — 2025-11-09 hot-algo + keys preferred + richer ping
// Routes:
//   GET  /bazaar/hot/ping
//   GET  /bazaar/hot/check
//   GET  /bazaar/hot/list
//   POST /bazaar/hot/purchase  { sku: <NFTokenID>, priceXRP: <number> }
//
// Behavior:
// - Prefer explicit HOT_PUBLIC_HEX/HOT_PRIVATE_HEX (secp) over seed.
// - If seed path, honor HOT_ALGO ('secp' default) to avoid guesswork.
// - Enforce secp unless ALLOW_ED_HOT=true. Assert HOT_ADDR if provided.

import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';
import * as keypairs from 'ripple-keypairs';

// ---------- env ----------
const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';

const HOT_PUBLIC_HEX  = (process.env.HOT_PUBLIC_HEX || process.env.HOT_PUB_HEX || '').toUpperCase().trim();
const HOT_PRIVATE_HEX = (process.env.HOT_PRIVATE_HEX || process.env.HOT_PRV_HEX || '').toUpperCase().trim();

const HOT_SEED = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
const HOT_ALGO = (process.env.HOT_ALGO || 'secp').toLowerCase(); // 'secp' | 'ed'
const HOT_ADDR = process.env.HOT_ADDR || '';

const ALLOW_ED_HOT = String(process.env.ALLOW_ED_HOT || 'false').toLowerCase() === 'true';

const BAZAAR_TAXON = Number(process.env.BAZAAR_TAXON || 201);
const ISSUER_ADDR  = process.env.BAZAAR_UPGRADES_ISSUER
  || process.env.ISSUER_ADDR
  || process.env.ISSUER_ADDRESS
  || null;

// ---------- helpers ----------
const isSecpPK = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-F]{64}$/i.test(pk);
const isEdPK   = (pk) => typeof pk === 'string' && /^ED[0-9A-F]{64}$/i.test(pk);
const toDrops  = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * 1_000_000));
};

// ---------- hot wallet state ----------
let xrpl = { client: null, wallet: null, algo: 'unknown', note: null, source: 'unknown', pubPrefix: '??' };

async function ensureXRPL(app) {
  if (xrpl.client && xrpl.client.isConnected() && xrpl.wallet) return xrpl;
  xrpl.client = new XRPLClient(XRPL_WSS);

  // Priority A: explicit HEX keys (no guessing)
  if (HOT_PUBLIC_HEX && HOT_PRIVATE_HEX) {
    if (!(isSecpPK(HOT_PUBLIC_HEX) || isEdPK(HOT_PUBLIC_HEX))) {
      xrpl.note = 'hot_keys_invalid: HOT_PUBLIC_HEX must be compressed secp (02/03 + 64 hex) or ED...';
      throw new Error(xrpl.note);
    }
    // xrpl-js Wallet ctor accepts (pub, prv)
    xrpl.wallet = new XRPLWallet(HOT_PUBLIC_HEX, HOT_PRIVATE_HEX);
    xrpl.source = 'keys';
    xrpl.pubPrefix = (xrpl.wallet.publicKey || '').slice(0,2).toUpperCase();
    xrpl.algo = xrpl.pubPrefix === 'ED' ? 'ed25519' : ((xrpl.pubPrefix === '02' || xrpl.pubPrefix === '03') ? 'secp256k1' : 'unknown');
  } else if (HOT_SEED) {
    // Priority B: seed fallback — honor HOT_ALGO (default 'secp')
    const algoOpt = HOT_ALGO === 'ed' ? { algorithm: 'ed25519' } : { algorithm: 'secp256k1' };
    xrpl.wallet = XRPLWallet.fromSeed(HOT_SEED, algoOpt);
    xrpl.source = 'seed';
    const pub = String(xrpl.wallet.publicKey || '').toUpperCase();
    xrpl.pubPrefix = pub.slice(0,2);
    xrpl.algo = pub.startsWith('ED') ? 'ed25519' : ((pub.startsWith('02') || pub.startsWith('03')) ? 'secp256k1' : 'unknown');
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

// ---------- SKU cache ----------
let lastList = { at: 0, skus: [] };

async function buildSkusFromHot(app) {
  await ensureXRPL(app);
  const res = await xrpl.client.request({
    command: 'account_nfts',
    account: xrpl.wallet.address,
    limit: 400
  });

  const items = (res.result.account_nfts || []).map(n => ({
    nftokenId: n.NFTokenID,
    uri: n.URI || null,
    taxon: n.NFTokenTaxon,
    flags: n.Flags,
    issuer_hint: n.Issuer || null
  }));

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
        allowEdForHot: ALLOW_ED_HOT,
        source: xrpl.source,
        hotAlgoEnv: HOT_ALGO,
        pubPrefix: xrpl.pubPrefix
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
        source: xrpl.source,
        hotAlgoEnv: HOT_ALGO,
        pubPrefix: xrpl.pubPrefix,
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

  // OPEN: list inventory
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

  // AUTHED: create a directed SellOffer to buyer for selected NFT
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    const buyer = req.wallet;
    const { sku } = req.body || {};
    if (!buyer) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
    if (!sku)   return reply.code(400).send({ error: 'bad_request', detail: 'missing sku' });

    try {
      await ensureXRPL(app);

      // Expect sku == NFTokenID, plus priceXRP
      const nftokenId = sku;
      const priceXRP = Number(req.body?.priceXRP);
      if (!Number.isFinite(priceXRP) || priceXRP <= 0) return reply.code(400).send({ error: 'bad_price' });
      const drops = toDrops(priceXRP); if (!drops) return reply.code(400).send({ error: 'bad_price' });

      const tx = {
        TransactionType: 'NFTokenCreateOffer',
        Account: xrpl.wallet.address,
        NFTokenID: nftokenId,
        Amount: drops,
        Destination: buyer,
        Flags: 1 // tfSellNFToken
      };

      const prepared = await xrpl.client.autofill(tx);
      const signed = xrpl.wallet.sign(prepared);
      const sub = await xrpl.client.submitAndWait(signed.tx_blob);

      if (sub.result.engine_result !== 'tesSUCCESS') {
        return reply.code(500).send({ error: 'create_offer_failed', detail: sub.result.engine_result_message || sub.result.engine_result });
      }

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
