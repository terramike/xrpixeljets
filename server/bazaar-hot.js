// bazaar-hot.js — Preminted Hot-Wallet Bazaar (2025-11-08-hot-metadata-v3)
// Lists NFTs in the hot wallet by reading XRPL directly, parses prices from metadata,
// and supports a directed-offer purchase flow without any JSON registry.
// Env:
//   XRPL_WSS            (default: wss://xrplcluster.com)
//   HOT_WALLET_ADDR     (preferred) OR HOT_SEED/HOT_WALLET_SEED (secp only; derives addr)
//   JWT_SECRET          (used by the parent server for /session)
// Optional:
//   ISSUER_ADDR         (if set, we keep items even if issuer differs; filtering is metadata-driven)

import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';

// ---------- Config ----------
const WSS = process.env.XRPL_WSS || process.env.NETWORK || 'wss://xrplcluster.com';
const ISSUER_ADDR = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || null;

// ---------- XRPL Client (lazy) ----------
let _client = null;
async function ensureClient() {
  if (!_client) _client = new XRPLClient(WSS);
  if (!_client.isConnected()) await _client.connect();
  return _client;
}

// ---------- Hot wallet address ----------
function getHotAddr() {
  const addr = process.env.HOT_WALLET_ADDR || process.env.HOT_WALLET || null;
  if (addr) return addr;
  const seed = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
  if (!seed) return null;
  try { return XRPLWallet.fromSeed(seed).address; } catch { return null; }
}

// ---------- Helpers ----------
function hexToUtf8(hex) {
  try { return Buffer.from(hex, 'hex').toString('utf8'); } catch { return null; }
}
function ipfsToHttp(u) {
  if (!u || typeof u !== 'string') return null;
  if (u.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + u.slice(7);
  return u;
}
async function fetchJson(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('meta_http_' + r.status);
  return await r.json();
}
function getAttr(meta, name) {
  const list = Array.isArray(meta?.attributes) ? meta.attributes : [];
  const hit = list.find(a => String(a?.trait_type || a?.trait || '').toLowerCase() === String(name).toLowerCase());
  return hit?.value;
}
function parsePrice(meta) {
  const jf = Number(getAttr(meta, 'Price (JFUEL)')) || 0;
  const xrp = Number(getAttr(meta, 'Price (XRP)')) || 0;
  const drops = Math.max(0, Math.round(xrp * 1_000_000));
  return { jf: Math.max(0, Math.trunc(jf)), xrp, xrpDrops: drops };
}
function parseKind(meta) {
  return String(getAttr(meta, 'Kind') || '').toLowerCase(); // 'attack' | 'defense' | 'speed'
}
function deriveSku(kind) {
  if (kind === 'attack') return 'BAZ-ATTACK-V1';
  if (kind === 'speed')  return 'BAZ-SPEED-V1';
  if (kind === 'defense')return 'BAZ-DEFENSE-V1';
  return 'BAZ-UNKNOWN';
}

// Confirm an NFToken is still owned by the hot wallet before selling
async function nftOwnedBy(client, owner, nftokenId) {
  const out = await client.request({ command: 'account_nfts', account: owner, limit: 400 });
  const set = new Set((out.result?.account_nfts || []).map(n => n.NFTokenID));
  if (out.result?.marker) {
    let marker = out.result.marker;
    while (marker) {
      const nxt = await client.request({ command: 'account_nfts', account: owner, limit: 400, marker });
      (nxt.result?.account_nfts || []).forEach(n => set.add(n.NFTokenID));
      marker = nxt.result?.marker;
    }
  }
  return set.has(nftokenId);
}

// Create a directed sell offer from hot wallet → buyer
async function createDirectedOffer(client, hotSeedOrNull, nftokenId, buyer, amountDrops) {
  const seed = hotSeedOrNull || process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
  if (!seed) throw new Error('hot_wallet_missing');
  const hot = XRPLWallet.fromSeed(seed);

  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: hot.address,
    NFTokenID: nftokenId,
    Amount: String(amountDrops ?? 0),
    Flags: 1, // tfSellNFToken
    Destination: buyer
  };
  const prepared = await client.autofill(tx);
  const signed = hot.sign(prepared);
  const sub = await client.submitAndWait(signed.tx_blob, { failHard: false });
  const res = sub?.result;
  const ok = (res?.engine_result || res?.meta?.TransactionResult) === 'tesSUCCESS';
  if (!ok) throw new Error('xrpl_offer_failed:' + (res?.engine_result || res?.meta?.TransactionResult || 'unknown'));

  const nodes = res?.meta?.AffectedNodes || [];
  for (const n of nodes) {
    const cn = n.CreatedNode;
    if (cn && cn.LedgerEntryType === 'NFTokenOffer') {
      return cn.LedgerIndex || cn.NewFields?.OfferID || cn.LedgerIndexHex || null;
    }
  }
  throw new Error('offer_id_parse_failed');
}

// ---------- Plugin ----------
export async function registerBazaarHotRoutes(app) {
  // Public: list items in hot wallet that look like Bazaar Upgrades (metadata-driven)
  app.get('/bazaar/hot/list', async (req, reply) => {
    try {
      const owner = getHotAddr();
      if (!owner) return reply.code(500).send({ error: 'hot_wallet_missing' });

      const client = await ensureClient();

      // Page through all NFTs
      let items = [];
      let marker = null;
      do {
        const res = await client.request({ command: 'account_nfts', account: owner, limit: 400, marker });
        marker = res.result.marker;
        const nfts = res.result.account_nfts || [];

        for (const n of nfts) {
          const id = n.NFTokenID;
          const uri = n.URI ? hexToUtf8(n.URI) : null;
          if (!uri) continue;

          // Fetch metadata
          let metaUrl = ipfsToHttp(uri);
          if (!metaUrl) continue;

          let meta;
          try { meta = await fetchJson(metaUrl); } catch { continue; }

          // Must be a "Bazaar Upgrade"
          const type = String(getAttr(meta, 'Type') || '').toLowerCase();
          if (type !== 'bazaar upgrade') continue;

          // Basic fields
          const kind = parseKind(meta);            // 'attack' | 'defense' | 'speed'
          const { jf, xrp, xrpDrops } = parsePrice(meta);
          const sku = deriveSku(kind);
          const image = ipfsToHttp(meta.image) || null;

          items.push({
            nftoken_id: id,
            sku,
            kind,
            jf,
            xrpDrops,
            xrp,
            name: meta.name || 'Bazaar Upgrade',
            description: meta.description || '',
            image,
            meta_uri: metaUrl
          });
        }
      } while (marker);

      reply.send({ items });
    } catch (e) {
      req.log.error({ err: e }, 'hot_list_failed');
      reply.code(500).send({ error: 'list_failed' });
    }
  });

  // Auth required: create a directed SellOffer for an item in hot wallet and hold/debit JetFuel
  // Body: { nftoken_id: string }
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    try {
      // Require JWT (parent server already set up requireJWT + X-Wallet gate on non-open routes)
      const buyer = req.wallet; // set by onRequest in index.js
      const { nftoken_id } = req.body || {};
      if (!nftoken_id || typeof nftoken_id !== 'string') {
        return reply.code(400).send({ error: 'bad_request' });
      }

      const owner = getHotAddr();
      if (!owner) return reply.code(500).send({ error: 'hot_wallet_missing' });

      const client = await ensureClient();

      // Confirm the NFT is still owned by hot wallet
      const stillOwned = await nftOwnedBy(client, owner, nftoken_id);
      if (!stillOwned) return reply.code(409).send({ error: 'sold_out' });

      // Fetch on-ledger URI -> metadata -> authoritative price (ignore client-provided numbers)
      const info = await client.request({ command: 'nft_info', nft_id: nftoken_id }).catch(() => null);
      // Fallback: fetch from account_nfts again to locate this NFT and read URI
      let uriHex = info?.result?.uri;
      if (!uriHex) {
        const res = await client.request({ command: 'account_nfts', account: owner, limit: 400 });
        const hit = (res.result?.account_nfts || []).find(x => x.NFTokenID === nftoken_id);
        uriHex = hit?.URI;
      }
      const metaUri = ipfsToHttp(hexToUtf8(uriHex || '')) || null;
      if (!metaUri) return reply.code(500).send({ error: 'meta_missing' });

      let meta;
      try { meta = await fetchJson(metaUri); } catch { return reply.code(500).send({ error: 'meta_fetch_failed' }); }

      const { jf, xrpDrops } = parsePrice(meta);

      // Atomic JetFuel debit (server DB) – mirrors /ms/upgrade pattern
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      const debit = await pool.query(
        `update player_profiles
           set jet_fuel = jet_fuel - $2,
               updated_at = now()
         where wallet = $1
           and jet_fuel >= $2
         returning wallet`,
        [buyer, jf | 0]
      );
      if (debit.rows.length === 0) {
        return reply.code(402).send({ error: 'insufficient_funds' });
      }

      // Create directed SellOffer from hot wallet to buyer
      const offerId = await createDirectedOffer(client, null, nftoken_id, buyer, xrpDrops);

      // Return to client; they will AcceptOffer from their wallet and then we can optionally add a /settle if needed
      reply.send({ ok: true, offerId, nftokenId: nftoken_id, priceDrops: xrpDrops, priceJFUEL: jf | 0, meta_uri: metaUri });
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.startsWith('xrpl_offer_failed')) return reply.code(500).send({ error: 'xrpl_offer_failed', detail: msg.split(':')[1] || 'unknown' });
      if (msg.includes('hot_wallet_missing')) return reply.code(500).send({ error: 'hot_wallet_missing' });
      return reply.code(500).send({ error: 'purchase_failed' });
    }
  });
}
