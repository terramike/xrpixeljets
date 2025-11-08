// server/bazaar-hot.js — v=2025-11-08-hot-simple
// Minimal hot-wallet bazaar plugin: POST /bazaar/hot/purchase
// Notes:
//  * Lists can be done client-side by scanning HOT wallet; this server only creates SellOffers + debits JFUEL.
//  * ENV: HOT_SEED (or HOT_WALLET_SEED), ISSUER_ADDR, XRPL_WSS, JWT_SECRET, DATABASE_URL
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';

const { Pool } = pkg;

const XRPL_WSS   = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const HOT_SEED   = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';
const ISSUER     = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const TAXON      = Number(process.env.BAZAAR_TAXON ?? 201);
const OFFER_TTL  = Number(process.env.BAZAAR_OFFER_TTL_SEC || 900);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });

let xrplClient = null;
let hotWallet  = null;

function rippleEpoch(unix){ return unix - 946684800; }

function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error:'unauthorized' }); return null; }
  try { return jwt.verify(token, JWT_SECRET, { algorithms:['HS256'] }); }
  catch { reply.code(401).send({ error:'unauthorized' }); return null; }
}
function hexToUtf8(h){
  try{
    const hex = String(h||"").replace(/^0x/i,'').trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length%2) return "";
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b=>parseInt(b,16)));
    return new TextDecoder().decode(bytes);
  }catch{ return ""; }
}
function ipfsUrls(u){
  const id = String(u||"").replace(/^ipfs:\/\//,"").replace(/^ipfs\//,"");
  return [
    `https://ipfs.xrp.cafe/ipfs/${id}`,
    `https://nftstorage.link/ipfs/${id}`,
    `https://ipfs.io/ipfs/${id}`,
    `https://cloudflare-ipfs.com/ipfs/${id}`
  ];
}
async function fetchMeta(uri){
  if (!uri) return null;
  const urls = (uri.startsWith("ipfs://")||uri.startsWith("ipfs/")) ? ipfsUrls(uri) : [uri];
  for (const u of urls){
    try{ const r=await fetch(u,{cache:"no-store"}); if(r.ok) return await r.json(); }catch{}
  }
  return null;
}
function priceFromMeta(meta){
  let jf=0, xrp=0;
  if (Array.isArray(meta?.attributes)){
    for (const a of meta.attributes){
      const k = String(a?.trait_type ?? a?.type ?? "").toLowerCase();
      if (k==="price (jfuel)") jf = Number(a.value)||0;
      if (k==="price (xrp)")   xrp = Number(a.value)||0;
    }
  }
  return { jf, xrpDrops: Math.round(xrp*1_000_000) };
}
function skuFromMeta(meta){
  const explicit = String(meta?.properties?.sku || "").toUpperCase().replace(/[^A-Z0-9_-]/g,"");
  if (explicit) return explicit;
  const kind = String(
    (meta?.attributes||[]).find(a => (a?.trait_type||"").toLowerCase()==="kind")?.value || ""
  ).toLowerCase();
  const K = ["attack","defense","speed"].includes(kind) ? kind.toUpperCase() : "ATTACK";
  return `BAZ-${K}-V1`;
}

async function ensureXRPL(){
  if (!HOT_SEED) throw new Error('hot_wallet_missing');
  if (!hotWallet) hotWallet = XRPLWallet.fromSeed(HOT_SEED);
  if (!xrplClient){ xrplClient = new XRPLClient(XRPL_WSS); }
  if (!xrplClient.isConnected()) await xrplClient.connect();
}

async function findMatchingNFT({ skuWanted }){
  await ensureXRPL();
  let marker=null;
  do{
    const req = { command:'account_nfts', account: hotWallet.address, limit: 400 };
    if (marker) req.marker = marker;
    const res = await xrplClient.request(req);
    marker = res.result.marker;
    const list = res.result.account_nfts || [];
    for (const nf of list){
      if (TAXON && Number(nf.NFTokenTaxon)!==TAXON) continue;
      const uri = hexToUtf8(nf.URI||"");
      const meta = await fetchMeta(uri);
      if (!meta) continue;
      if (String(meta?.properties?.issuer||"") !== ISSUER) continue;
      const sku = skuFromMeta(meta);
      if (sku !== skuWanted) continue;
      const price = priceFromMeta(meta);
      return { nf, meta, price };
    }
  } while(marker);
  return null;
}

async function createDirectedSellOffer({ nftoken_id, buyer, amountDrops }){
  await ensureXRPL();
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: hotWallet.address,
    NFTokenID: nftoken_id,
    Amount: String(amountDrops ?? 0),
    Flags: 1, // tfSellNFToken
    Destination: buyer,
    Expiration: rippleEpoch(Math.floor(Date.now()/1000) + OFFER_TTL)
  };
  const prepared = await xrplClient.autofill(tx);
  const { tx_blob } = hotWallet.sign(prepared);
  const sub = await xrplClient.submitAndWait(tx_blob, { failHard:false });
  const r = sub?.result;
  const ok = (r?.engine_result || r?.meta?.TransactionResult) === 'tesSUCCESS';
  if (!ok) throw new Error(`xrpl_offer_failed:${r?.engine_result || r?.meta?.TransactionResult || 'unknown'}`);
  for (const n of (r?.meta?.AffectedNodes||[])){
    const cn = n.CreatedNode;
    if (cn && cn.LedgerEntryType==='NFTokenOffer'){
      return cn.LedgerIndex || cn.NewFields?.OfferID || null;
    }
  }
  throw new Error('offer_id_parse_failed');
}

export async function registerBazaarHotRoutes(app){
  // Health ping (optional)
  app.get('/bazaar/hot/ping', async (_req, reply) => reply.send({ ok:true, hot: HOT_SEED? 'configured':'missing' }));

  // Purchase directly from HOT inventory by SKU (JWT + X-Wallet required)
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    try{
      const jwtOk = requireJWT(req, reply); if (!jwtOk) return;
      const buyer = req.wallet;
      const { sku } = req.body || {};
      if (!buyer || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(buyer)) return reply.code(400).send({ error:'bad_wallet' });
      if (!sku) return reply.code(400).send({ error:'bad_sku' });

      const match = await findMatchingNFT({ skuWanted: String(sku).toUpperCase() });
      if (!match) return reply.code(409).send({ error:'sold_out' });

      // Atomic JFUEL debit
      const needJF = match.price.jf|0;
      if (needJF>0){
        const debit = await pool.query(
          `update player_profiles
              set jet_fuel = jet_fuel - $2,
                  updated_at = now()
            where wallet = $1
              and jet_fuel >= $2
           returning *`,
          [buyer, needJF]
        );
        if (debit.rows.length===0) return reply.code(402).send({ error:'insufficient_funds' });
      }

      const sellOfferId = await createDirectedSellOffer({
        nftoken_id: match.nf.NFTokenID,
        buyer,
        amountDrops: match.price.xrpDrops|0
      });

      reply.send({ ok:true, sellOfferId, nftokenId: match.nf.NFTokenID, price: match.price });
    }catch(e){
      const m = String(e?.message||'');
      if (m.startsWith('xrpl_offer_failed')) return reply.code(500).send({ error:'xrpl_offer_failed', detail: m.split(':')[1]||'unknown' });
      if (m.includes('hot_wallet_missing')) return reply.code(500).send({ error:'server_hot_wallet_missing' });
      reply.code(500).send({ error:'purchase_failed' });
    }
  });
}
