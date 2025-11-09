// server/bazaar-hot.js — 2025-11-09 r3 (hot + reserves + rich errors)
// Routes:
//   GET  /bazaar/hot/ping
//   GET  /bazaar/hot/check
//   GET  /bazaar/hot/list
//   POST /bazaar/hot/purchase  { sku: <NFTokenID>, priceXRP: <number> }
//
// Behavior:
// - Prefer HOT_PUBLIC_HEX/HOT_PRIVATE_HEX (no guessing), else HOT_SEED (+ HOT_ALGO=secp|ed; default secp).
// - Enforce secp unless ALLOW_ED_HOT=true. Assert HOT_ADDR if provided.
// - Inventory = on-chain scan of HOT wallet (issuer/taxon filter is client-side).
// - Purchase = NFTokenCreateOffer directed to buyer; preflights for reserves, buyer account, transferable, etc.
// - Rich error details: engine_result, engine_result_message, tx hash, and a trimmed raw result.

import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';

// ---------- env ----------
const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';

const HOT_PUBLIC_HEX  = (process.env.HOT_PUBLIC_HEX || process.env.HOT_PUB_HEX || '').toUpperCase().trim();
const HOT_PRIVATE_HEX = (process.env.HOT_PRIVATE_HEX || process.env.HOT_PRV_HEX || '').toUpperCase().trim();

const HOT_SEED = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
const HOT_ALGO = (process.env.HOT_ALGO || 'secp').toLowerCase(); // 'secp' | 'ed'
const HOT_ADDR = (process.env.HOT_ADDR || '').trim();

const ALLOW_ED_HOT = String(process.env.ALLOW_ED_HOT || 'false').toLowerCase() === 'true';

const BAZAAR_TAXON = Number(process.env.BAZAAR_TAXON || 201);
// Issuer is informational here; metadata validation lives client-side
const ISSUER_ADDR  = process.env.BAZAAR_UPGRADES_ISSUER
  || process.env.ISSUER_ADDR
  || process.env.ISSUER_ADDRESS
  || null;

const OFFER_TTL_SEC = Number(process.env.BAZAAR_OFFER_TTL_SEC || 900); // optional Expiration for offers

// ---------- helpers ----------
const isSecpPK = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-F]{64}$/i.test(pk);
const isEdPK   = (pk) => typeof pk === 'string' && /^ED[0-9A-F]{64}$/i.test(pk);
const toDrops  = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.round(n * 1_000_000));
};
const nowRippleEpoch = () => Math.floor(Date.now() / 1000) - 946684800; // UNIX - Ripple epoch
const bit = (flags, mask) => ((Number(flags) >>> 0) & mask) === mask;

// DisallowIncoming flags (AccountRoot)
const lsfDisallowIncomingNFTokenOffer = 0x04000000; // 67108864

function trimJSON(obj, max = 2000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  } catch {
    return undefined;
  }
}

// ---------- hot wallet state ----------
let xrpl = { client: null, wallet: null, algo: 'unknown', note: null, source: 'unknown', pubPrefix: '??' };

async function ensureXRPL() {
  if (xrpl.client && xrpl.client.isConnected() && xrpl.wallet) return xrpl;
  xrpl.client = new XRPLClient(XRPL_WSS);

  // Priority A: explicit hex keys (no guessing)
  if (HOT_PUBLIC_HEX && HOT_PRIVATE_HEX) {
    if (!(isSecpPK(HOT_PUBLIC_HEX) || isEdPK(HOT_PUBLIC_HEX))) {
      xrpl.note = 'hot_keys_invalid: HOT_PUBLIC_HEX must be compressed secp (02/03 + 64 hex) or ED...';
      throw new Error(xrpl.note);
    }
    xrpl.wallet = new XRPLWallet(HOT_PUBLIC_HEX, HOT_PRIVATE_HEX);
    xrpl.source = 'keys';
  } else if (HOT_SEED) {
    // Priority B: seed path with explicit algo
    const algoOpt = HOT_ALGO === 'ed' ? { algorithm: 'ed25519' } : { algorithm: 'secp256k1' };
    xrpl.wallet = XRPLWallet.fromSeed(HOT_SEED, algoOpt);
    xrpl.source = 'seed';
  } else {
    xrpl.note = 'hot_wallet_init_failed: missing HOT_PUBLIC_HEX/HOT_PRIVATE_HEX or HOT_SEED';
    throw new Error(xrpl.note);
  }

  const pub = String(xrpl.wallet.publicKey || '').toUpperCase();
  xrpl.pubPrefix = pub.slice(0,2);
  xrpl.algo = pub.startsWith('ED') ? 'ed25519' : ((pub.startsWith('02') || pub.startsWith('03')) ? 'secp256k1' : 'unknown');

  if (HOT_ADDR && xrpl.wallet?.address && xrpl.wallet.address !== HOT_ADDR) {
    xrpl.note = `hot_addr_mismatch: expected ${HOT_ADDR}, got ${xrpl.wallet.address}`;
    throw new Error(xrpl.note);
  }

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

async function buildSkusFromHot() {
  await ensureXRPL();
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

// ---------- reserve helpers ----------
async function fetchReserves() {
  const s = await xrpl.client.request({ command: 'server_info' });
  const info = s.result.info || {};
  const ledg = info.validated_ledger || info.closed_ledger || {};
  // Live values (as of 2024/2025 typical: base=1 XRP, inc=0.2 XRP)
  const baseXRP = Number(ledg.reserve_base_xrp ?? info.reserve_base_xrp ?? 1);
  const incXRP  = Number(ledg.reserve_inc_xrp  ?? info.reserve_inc_xrp  ?? 0.2);
  return { baseDrops: BigInt(Math.round(baseXRP * 1_000_000)), incDrops: BigInt(Math.round(incXRP * 1_000_000)) };
}

// ---------- routes ----------
export async function registerBazaarHotRoutes(app) {
  // OPEN: ping
  app.get('/bazaar/hot/ping', async (_req, reply) => {
    try {
      await ensureXRPL();
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
      await ensureXRPL();
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
        await buildSkusFromHot();
      }
      reply.send({ skus: lastList.skus, taxon: BAZAAR_TAXON });
    } catch (e) {
      reply.code(500).send({ error: 'list_failed', detail: String(e?.message || e) });
    }
  });

  // AUTHED: create a directed SellOffer to buyer for selected NFT
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    const buyerHeader = req.wallet || req.headers['x-wallet'] || req.headers['X-Wallet'];
    const buyer = typeof buyerHeader === 'string' ? buyerHeader.trim() : '';
    const { sku, priceXRP } = req.body || {};
    if (!buyer || buyer[0] !== 'r') return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
    if (!sku)   return reply.code(400).send({ error: 'bad_request', detail: 'missing sku (expect NFTokenID)' });
    const priceNum = Number(priceXRP);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return reply.code(400).send({ error: 'bad_price' });

    try {
      await ensureXRPL();

      // Verify buyer exists & doesn’t block incoming NFT offers
      let buyerInfo;
      try {
        const r = await xrpl.client.request({ command: 'account_info', account: buyer, ledger_index: 'validated' });
        buyerInfo = r.result.account_data;
        const blocksOffers = bit(buyerInfo.Flags || 0, lsfDisallowIncomingNFTokenOffer);
        if (blocksOffers) {
          return reply.code(409).send({ error: 'buyer_blocks_offers', detail: 'Destination blocks incoming NFTokenOffers' });
        }
      } catch {
        return reply.code(404).send({ error: 'buyer_unfunded', detail: 'Destination account does not exist (fund it first)' });
      }

      // Verify HOT still owns the NFT (guard against race)
      const listAge = Date.now() - lastList.at;
      if (listAge > 10_000) await buildSkusFromHot();
      const owned = lastList.skus.find(x => x.nftokenId === sku);
      if (!owned) return reply.code(410).send({ error: 'sold_out', detail: 'NFT not owned by HOT' });

      // Verify transferable (flags bit 0x0008)
      if ((Number(owned.flags) & 0x0008) !== 0x0008) {
        return reply.code(409).send({ error: 'not_transferable', detail: 'NFToken lacks lsfTransferable' });
      }

      // Live reserves & balance preflight (XRPL mainnet typical: base 1 XRP + 0.2 XRP per owned object)
      const [{ baseDrops, incDrops }, ai] = await Promise.all([
        fetchReserves(),
        xrpl.client.request({ command: 'account_info', account: xrpl.wallet.address, ledger_index: 'validated' })
      ]);
      const acct = ai.result.account_data;
      const balanceDrops = BigInt(acct.Balance);
      const ownerCount   = Number(acct.OwnerCount || 0);
      const needed = baseDrops + incDrops * BigInt(ownerCount + 1); // +1 for the new NFTokenOffer
      if (balanceDrops < needed) {
        const short = Number(needed - balanceDrops) / 1e6;
        return reply.code(402).send({
          error: 'hot_insufficient_reserve',
          detail: `Top up hot wallet by ~${short.toFixed(4)} XRP to create the offer`,
          ownerCount, balanceXRP: Number(balanceDrops)/1e6
        });
      }

      // Build & submit directed SellOffer
      const drops = toDrops(priceNum);
      const tx = {
        TransactionType: 'NFTokenCreateOffer',
        Account: xrpl.wallet.address,
        NFTokenID: sku,
        Amount: drops,
        Destination: buyer,
        Flags: 0x00000001 // tfSellNFToken
      };
      if (OFFER_TTL_SEC > 0) {
        tx.Expiration = nowRippleEpoch() + OFFER_TTL_SEC;
      }

      const prepared = await xrpl.client.autofill(tx);
      const signed = xrpl.wallet.sign(prepared);
      const sub = await xrpl.client.submitAndWait(signed.tx_blob);

      const er = sub?.result?.engine_result || sub?.engine_result || '';
      const em = sub?.result?.engine_result_message || sub?.engine_result_message || '';
      const meta = sub?.result?.meta || sub?.result?.meta_json || {};
      let sellOfferId = null;
      try {
        const obj = meta.AffectedNodes?.find(n =>
          (n.CreatedNode?.LedgerEntryType === 'NFTokenOffer') &&
          (n.CreatedNode?.NewFields?.Owner === xrpl.wallet.address)
        );
        sellOfferId = obj?.CreatedNode?.LedgerIndex || null;
      } catch {}

      if (er !== 'tesSUCCESS') {
        // Friendly mappings
        if (er === 'tecINSUFFICIENT_RESERVE' || er === 'tecINSUF_RESERVE') {
          return reply.code(402).send({ error: 'hot_insufficient_reserve', detail: em || er, engine_result: er, hash: signed.hash });
        }
        if (er === 'tecNO_PERMISSION') {
          return reply.code(409).send({ error: 'buyer_blocks_offers', detail: em || er, engine_result: er, hash: signed.hash });
        }
        if (er === 'tecNO_DST') {
          return reply.code(404).send({ error: 'buyer_unfunded', detail: em || er, engine_result: er, hash: signed.hash });
        }
        if (er === 'tefNFTOKEN_IS_NOT_TRANSFERABLE') {
          return reply.code(409).send({ error: 'not_transferable', detail: em || er, engine_result: er, hash: signed.hash });
        }
        // Unknown: return raw envelope trimmed so we can see what's up
        return reply.code(500).send({
          error: 'create_offer_failed',
          detail: em || er || 'unknown_engine_result',
          engine_result: er || null,
          hash: signed.hash,
          raw: trimJSON(sub, 1800)
        });
      }

      return reply.send({ ok: true, sellOfferId, nftokenId: sku, hash: signed.hash });
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('secp_required') || msg.includes('banned')) {
        return reply.code(500).send({ error: 'server_hot_wallet_missing', detail: `hot_wallet_init_failed: ${msg}` });
      }
      return reply.code(500).send({ error: 'purchase_failed', detail: msg });
    }
  });
}
