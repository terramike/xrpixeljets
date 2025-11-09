// server/bazaar-hot.js — 2025-11-09 live1
// Adds /bazaar/hot/live that exposes active PUBLIC SellOffers (no Destination).
// Keeps ping/check; leaves other green paths untouched.

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
const ISSUER_ADDR  = process.env.BAZAAR_UPGRADES_ISSUER
  || process.env.ISSUER_ADDR
  || process.env.ISSUER_ADDRESS
  || null;

// ---------- helpers ----------
const isSecpPK = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-F]{64}$/i.test(pk);
const isEdPK   = (pk) => typeof pk === 'string' && /^ED[0-9A-F]{64}$/i.test(pk);
const rippleNow = () => Math.floor(Date.now()/1000) - 946684800; // UNIX - Ripple epoch

// ---------- hot wallet state ----------
let xrpl = { client: null, wallet: null, algo: 'unknown', note: null, source: 'unknown', pubPrefix: '??' };

async function ensureXRPL() {
  if (xrpl.client && xrpl.client.isConnected() && xrpl.wallet) return xrpl;
  xrpl.client = new XRPLClient(XRPL_WSS);

  if (HOT_PUBLIC_HEX && HOT_PRIVATE_HEX) {
    if (!(isSecpPK(HOT_PUBLIC_HEX) || isEdPK(HOT_PUBLIC_HEX))) {
      xrpl.note = 'hot_keys_invalid: HOT_PUBLIC_HEX must be compressed secp (02/03 + 64 hex) or ED...';
      throw new Error(xrpl.note);
    }
    xrpl.wallet = new XRPLWallet(HOT_PUBLIC_HEX, HOT_PRIVATE_HEX);
    xrpl.source = 'keys';
  } else if (HOT_SEED) {
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
  if (!xrpl.client.isConnected()) await xrpl.client.connect();
  return xrpl;
}

// ---------- cache ----------
let lastLive = { at: 0, items: [] };

// Build public shop feed by joining account_offers (sell, public, active) with account_nfts (for URI)
async function buildLiveFeed() {
  await ensureXRPL();
  const [offersRes, nftsRes] = await Promise.all([
    xrpl.client.request({ command: 'account_offers', account: xrpl.wallet.address, limit: 400 }),
    xrpl.client.request({ command: 'account_nfts',   account: xrpl.wallet.address, limit: 400 }),
  ]);

  const now = rippleNow();
  const nfts = new Map((nftsRes.result.account_nfts || []).map(n => [n.NFTokenID, n]));
  const items = (offersRes.result.offers || [])
    .filter(o => ((Number(o.flags)||0) & 1) === 1)                 // sell
    .filter(o => !o.destination)                                    // public (no Destination)
    .filter(o => !o.expiration || Number(o.expiration) > now)       // active
    .map(o => {
      const n = nfts.get(o.nft_id);
      return {
        offerId: o.nft_offer_index || o.index,
        nftokenId: o.nft_id,
        amountDrops: o.amount,
        priceXRP: Number(o.amount)/1e6,
        expiration: o.expiration || null,
        uri: n?.URI || null,
        taxon: n?.NFTokenTaxon,
        flags: n?.Flags
      };
    })
    .filter(it => Number(it.taxon) === BAZAAR_TAXON);

  lastLive = { at: Date.now(), items };
  return items;
}

// ---------- routes ----------
export async function registerBazaarHotRoutes(app) {
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

  app.get('/bazaar/hot/check', async (_req, reply) => {
    try {
      await ensureXRPL();
      const r = await xrpl.client.request({ command: 'account_info', account: xrpl.wallet.address, ledger_index: 'validated' });
      reply.send({ ok: true, account_data: r.result.account_data });
    } catch (e) {
      reply.code(500).send({ ok: false, error: 'account_info_failed', detail: String(e?.message || e) });
    }
  });

  // NEW: public offers feed
  app.get('/bazaar/hot/live', async (_req, reply) => {
    try {
      const age = Date.now() - lastLive.at;
      if (age > 10_000 || lastLive.items.length === 0) await buildLiveFeed();
      reply.send({ ok: true, items: lastLive.items, taxon: BAZAAR_TAXON });
    } catch (e) {
      reply.code(500).send({ ok: false, error: 'live_failed', detail: String(e?.message||e) });
    }
  });

  // Optional: keep a no-op settle endpoint so client doesn’t 404
  app.post('/bazaar/settle', async (_req, reply) => {
    reply.send({ ok: true, note: 'settle stub' });
  });
}
