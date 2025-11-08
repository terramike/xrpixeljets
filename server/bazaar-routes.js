// server/bazaar-routes.js
// Bazaar chain-scan routes (hot-wallet only) — v2025-11-08-cs5
// Endpoints:
//   GET  /bazaar/chain/ping
//   GET  /bazaar/chain/available?sku=BAZ-DEFENSE-V1
//   POST /bazaar/chain/purchase   { sku }           (JWT + X-Wallet required)
//   POST /bazaar/chain/settle     { offerId, jf }   (JWT + X-Wallet required)

import fs from 'node:fs';
import path from 'node:path';
import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';

const WSS         = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const HOT_SEED    = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || ''; // secp256k1 seed for rJz…
const ISSUER_ADDR = process.env.ISSUER_ADDR || process.env.ISSUER_ADDRESS || null; // rfYZ… (optional but recommended)
const OFFER_TTL_S = Number(process.env.BAZAAR_OFFER_TTL_SEC || 900);

// --- simple JWT gate (reuse same secret as main app) ---
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
function requireJWT(req, reply) {
  try {
    const h = req.headers['authorization'] || '';
    const t = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!t) return reply.code(401).send({ error: 'unauthorized' });
    // lazy import to avoid top-level dep here
    const jwt = require('jsonwebtoken'); // CJS ok under Node
    const payload = jwt.verify(t, JWT_SECRET, { algorithms: ['HS256'] });
    req.jwt = payload;
    return payload;
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

// --- load SKU registry (for uriPrefixes / pricing) ---
function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}
function loadSkuMap() {
  const dataDir  = process.env.BAZAAR_DATA_DIR || path.resolve('server', 'data');
  const regPath  = process.env.BAZAAR_REGISTRY_PATH || path.join(dataDir, 'registry.json');
  const skusPath = process.env.BAZAAR_SKUS_PATH     || path.join(dataDir, 'bazaar-skus.json');

  // Priority: registry.json.chainSkus → bazaar-skus.json.skus
  const reg  = readJsonSafe(regPath);
  const skus = readJsonSafe(skusPath);

  const out = {};
  if (reg?.chainSkus && typeof reg.chainSkus === 'object') {
    for (const [k, v] of Object.entries(reg.chainSkus)) out[k] = v;
  }
  if (skus?.skus && Array.isArray(skus.skus)) {
    for (const s of skus.skus) {
      if (!s?.sku) continue;
      out[s.sku] = Object.assign(out[s.sku] || {}, s);
    }
  }

  // sane defaults for your three weekly SKUs if nothing provided
  for (const sku of ['BAZ-ATTACK-V1', 'BAZ-SPEED-V1', 'BAZ-DEFENSE-V1']) {
    out[sku] = Object.assign({
      sku,
      // Put your IPFS *metadata* URI prefix(es) here so we can match on-chain:
      // Example: ["ipfs://Qm..."]  (you minted two DEFENSE URIs earlier, add both)
      uriPrefixes: [],
      // Optional tighter filter:
      issuer: ISSUER_ADDR || null, // rfYZ… (main issuer)
      taxon: 201,                  // upgrades taxon
      jf: 15000,                   // JetFuel price (server debits separately if using /bazaar/purchase)
      xrpDrops: 250000,            // 0.25 XRP (drops) for directed offer
      title: sku.replace('BAZ-', '').replace('-V1','').toUpperCase()
    }, out[sku] || {});
  }
  return out;
}

// XRPL helpers
async function ensureClient(c) { if (!c.isConnected()) await c.connect(); }
function rippleEpoch(unix) { return unix - 946684800; }

export default async function bazaarRoutes(app, opts) {
  const client = opts?.xrplClient || new XRPLClient(WSS);
  const wallet = opts?.hotWallet   || (HOT_SEED ? XRPLWallet.fromSeed(HOT_SEED) : null);
  if (!wallet) {
    app.log.warn('[Bazaar] HOT_SEED missing — chain purchase will fail.');
  }

  let SKUMAP = loadSkuMap();
  const reloadSkuMap = () => { try { SKUMAP = loadSkuMap(); } catch {} };

  app.get('/chain/ping', async (_req, reply) => {
    reply.send({ ok: true, wss: WSS, hot: wallet?.address || null });
  });

  // Return all matching hot-wallet NFTs for a given SKU
  app.get('/chain/available', async (req, reply) => {
    const skuId = String(req.query?.sku || '').trim();
    if (!skuId || !SKUMAP[skuId]) return reply.code(404).send({ error: 'bad_sku' });

    const sku = SKUMAP[skuId];
    try {
      await ensureClient(client);
      const owner = wallet?.address;
      if (!owner) return reply.code(500).send({ error: 'server_hot_wallet_missing' });

      // Fetch all NFTs owned by the hot wallet
      const res = await client.request({ command: 'account_nfts', account: owner, limit: 400 });

      const prefixes = Array.isArray(sku.uriPrefixes) ? sku.uriPrefixes.map(String) : [];
      const wantIssuer = sku.issuer || null;
      const wantTaxon  = typeof sku.taxon === 'number' ? sku.taxon : null;

      const items = [];
      for (const n of res.result.account_nfts || []) {
        // issuer/taxon filter (if provided)
        if (wantIssuer && n.Issuer && n.Issuer !== wantIssuer) continue;
        if (wantTaxon  != null && typeof n.NFTokenTaxon === 'number' && n.NFTokenTaxon !== wantTaxon) continue;

        // URI prefix filter
        let uri = '';
        try { uri = Buffer.from(n.URI || '', 'hex').toString('utf8'); } catch {}
        if (!uri) continue;
        if (prefixes.length > 0 && !prefixes.some(p => uri.startsWith(p))) continue;

        items.push({
          nftoken_id: n.NFTokenID,
          uri,
          jf: sku.jf|0,
          xrpDrops: sku.xrpDrops|0
        });
      }

      // If no matches, return 200 with empty list so the UI can say "no stock"
      return reply.send({ ok: true, sku: skuId, items });
    } catch (e) {
      app.log.error({ err: e }, '[Bazaar] chain/available failed');
      return reply.code(500).send({ error: 'server_error' });
    }
  });

  // Create a directed sell offer to the buyer (player signs Accept in wallet)
  app.post('/chain/purchase', async (req, reply) => {
    const auth = requireJWT(req, reply); if (!auth) return;
    const buyer = req.headers['x-wallet'];
    if (!buyer || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(buyer)) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });

    const { sku: skuId } = req.body || {};
    if (!skuId || !SKUMAP[skuId]) return reply.code(400).send({ error: 'bad_sku' });
    if (!wallet) return reply.code(500).send({ error: 'server_hot_wallet_missing' });

    try {
      await ensureClient(client);

      // Pick first available NFT from hot wallet for this SKU
      const avail = await app.inject({ method: 'GET', url: `/bazaar/chain/available?sku=${encodeURIComponent(skuId)}` });
      const data = avail.statusCode === 200 ? JSON.parse(avail.payload) : null;
      if (!data?.items?.length) return reply.code(404).send({ error: 'no_inventory' });

      const item = data.items[0];
      const tx = {
        TransactionType: 'NFTokenCreateOffer',
        Account: wallet.address,
        NFTokenID: item.nftoken_id,
        Amount: String(item.xrpDrops || 0),     // drops; can be "0"
        Flags: 1,                               // tfSellNFToken
        Destination: buyer,
        Expiration: rippleEpoch(Math.floor(Date.now()/1000) + OFFER_TTL_S)
      };
      const prepared = await client.autofill(tx);
      const signed   = wallet.sign(prepared);
      const sub      = await client.submitAndWait(signed.tx_blob, { failHard: false });

      const ok = (sub?.result?.engine_result || sub?.result?.meta?.TransactionResult) === 'tesSUCCESS';
      if (!ok) return reply.code(500).send({ error: 'xrpl_offer_failed', detail: sub?.result?.engine_result || 'unknown' });

      // Extract OfferID
      const nodes = sub?.result?.meta?.AffectedNodes || [];
      let offerId = null;
      for (const n of nodes) {
        const cn = n.CreatedNode;
        if (cn?.LedgerEntryType === 'NFTokenOffer') {
          offerId = cn.LedgerIndex || cn.NewFields?.OfferID || cn.LedgerIndexHex || null;
          if (offerId) break;
        }
      }
      if (!offerId) return reply.code(500).send({ error: 'offer_id_parse_failed' });

      reply.send({
        ok: true,
        sellOfferId: offerId,
        nftokenId: item.nftoken_id,
        jf: item.jf|0,
        xrpDrops: item.xrpDrops|0,
        expiresInSec: OFFER_TTL_S
      });
    } catch (e) {
      app.log.error({ err: e }, '[Bazaar] chain/purchase failed');
      reply.code(500).send({ error: 'server_error' });
    }
  });

  // After the player accepts the sell offer in wallet, the client calls this to confirm
  app.post('/chain/settle', async (req, reply) => {
    const auth = requireJWT(req, reply); if (!auth) return;
    const buyer = req.headers['x-wallet'];
    if (!buyer || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(buyer)) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
    const { offerId } = req.body || {};
    if (!offerId) return reply.code(400).send({ error: 'bad_request' });

    try {
      await ensureClient(client);

      // If the offer no longer exists on-ledger, assume it was consumed (accepted)
      const le = await client.request({ command: 'ledger_entry', offer: offerId }).catch(() => null);
      if (!le || le.status === 'error') {
        return reply.send({ ok: true, state: 'accepted' });
      }
      return reply.send({ ok: true, state: 'open' });
    } catch (e) {
      app.log.error({ err: e }, '[Bazaar] chain/settle failed');
      reply.code(500).send({ error: 'server_error' });
    }
  });

  // tiny helper to reload SKU map without restarting (optional)
  app.post('/chain/reload', async (req, reply) => {
    reloadSkuMap();
    reply.send({ ok: true, keys: Object.keys(SKUMAP) });
  });
}
