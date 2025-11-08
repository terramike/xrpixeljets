// server/bazaar-hot.js — v=2025-11-08-hot-simple+debug2
// Minimal hot-wallet bazaar plugin + diagnostics
// - Lists can be client-side by scanning HOT wallet
// - This server does: verify JWT, atomic JFUEL debit, CreateOffer → client AcceptOffer
//
// ENV required:
//   HOT_SEED (or HOT_WALLET_SEED)  -> secp seed for rJz… hot wallet
//   ISSUER_ADDR                    -> rfYZ… (Jets issuer; must match NFT metadata properties.issuer)
//   XRPL_WSS                       -> wss://xrplcluster.com
//   JWT_SECRET                     -> same one your /session uses
//   DATABASE_URL                   -> same DB the game uses (player_profiles.jet_fuel)
//
// Optional ENV:
//   BAZAAR_TAXON                   -> defaults 201
//   BAZAAR_OFFER_TTL_SEC           -> defaults 900

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
function needWallet(req, reply){
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)){
    reply.code(400).send({ error:'missing_or_bad_X-Wallet' });
    return null;
  }
  return w;
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
  if (!xrplClient.isConnected()){
    try{ await xrplClient.connect(); }
    catch(e){ throw new Error(`xrpl_connect_failed:${e?.message||'unknown'}`); }
  }
}

async function countNftsOwnedByHot(){
  await ensureXRPL();
  let marker=null, n=0;
  do{
    const req = { command:'account_nfts', account: hotWallet.address, limit: 400 };
    if (marker) req.marker = marker;
    const res = await xrplClient.request(req);
    marker = res.result.marker;
    n += (res.result.account_nfts||[]).length;
  } while(marker);
  return n;
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
  let prepared;
  try{
    prepared = await xrplClient.autofill(tx);
  }catch(e){
    throw new Error(`xrpl_autofill_failed:${e?.data?.error || e?.message || 'unknown'}`);
  }
  let tx_blob;
  try{
    ({ tx_blob } = hotWallet.sign(prepared));
  }catch(e){
    throw new Error(`xrpl_sign_failed:${e?.message||'unknown'}`);
  }
  let sub;
  try{
    sub = await xrplClient.submitAndWait(tx_blob, { failHard:false });
  }catch(e){
    throw new Error(`xrpl_submit_failed:${e?.data?.error || e?.message || 'unknown'}`);
  }
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
  // quick health
  app.get('/bazaar/hot/ping', async (_req, reply) => {
    reply.send({
      ok:true,
      issuer: ISSUER || '(missing)',
      taxon: TAXON,
      hotConfigured: !!HOT_SEED
    });
  });

  // deep debug (no secrets)
  app.get('/bazaar/hot/debug', async (_req, reply) => {
    try{
      await ensureXRPL();
      const count = await countNftsOwnedByHot().catch(()=>-1);
      reply.send({
        ok:true,
        wss: XRPL_WSS,
        hot: hotWallet?.address || '(none)',
        issuer: ISSUER || '(missing)',
        taxon: TAXON,
        xrplConnected: xrplClient?.isConnected() || false,
        hotNftCount: count
      });
    }catch(e){
      reply.code(500).send({ error:'debug_failed', detail:String(e?.message||e) });
    }
  });

  // peek a SKU (helps confirm metadata/issuer/taxon matching)
  app.get('/bazaar/hot/peek', async (req, reply) => {
    try{
      const sku = String(req.query?.sku || '').toUpperCase();
      if (!sku) return reply.code(400).send({ error:'bad_sku' });
      const m = await findMatchingNFT({ skuWanted: sku });
      if (!m) return reply.code(404).send({ error:'not_found' });
      reply.send({
        ok:true,
        nftoken_id: m.nf.NFTokenID,
        price: m.price,
        name: m.meta?.name || null,
        uri: hexToUtf8(m.nf.URI||'')
      });
    }catch(e){
      reply.code(500).send({ error:'peek_failed', detail:String(e?.message||e) });
    }
  });

  // BUY: JWT + X-Wallet required; does atomic JFUEL debit + creates directed SellOffer
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    // validate headers
    const jwtOk = requireJWT(req, reply); if (!jwtOk) return;
    const buyer = needWallet(req, reply); if (!buyer) return;

    const { sku } = req.body || {};
    if (!sku) return reply.code(400).send({ error:'bad_sku' });

    // 1) find item
    let match;
    try{
      match = await findMatchingNFT({ skuWanted: String(sku).toUpperCase() });
      if (!match) return reply.code(409).send({ error:'sold_out' });
    }catch(e){
      return reply.code(500).send({ error:'scan_failed', detail:String(e?.message||e) });
    }

    // 2) atomic JFUEL debit
    const needJF = match.price.jf|0;
    let debited = false;
    try{
      if (needJF>0){
        const res = await pool.query(
          `update player_profiles
              set jet_fuel = jet_fuel - $2,
                  updated_at = now()
            where wallet = $1
              and jet_fuel >= $2
          returning wallet`,
          [buyer, needJF]
        );
        if (res.rows.length===0) return reply.code(402).send({ error:'insufficient_funds' });
        debited = true;
      }
    }catch(e){
      return reply.code(500).send({ error:'db_debit_failed', detail:String(e?.message||e) });
    }

    // 3) create offer; on failure refund JFUEL
    try{
      const sellOfferId = await createDirectedSellOffer({
        nftoken_id: match.nf.NFTokenID,
        buyer,
        amountDrops: match.price.xrpDrops|0
      });
      return reply.send({
        ok:true,
        sellOfferId,
        nftokenId: match.nf.NFTokenID,
        price: match.price
      });
    }catch(e){
      // refund if we debited
      if (debited){
        try{
          await pool.query(
            `update player_profiles
                set jet_fuel = jet_fuel + $2,
                    updated_at = now()
              where wallet = $1`,
            [buyer, needJF]
          );
        }catch{}
      }
      const msg = String(e?.message||'');
      if (msg.startsWith('xrpl_connect_failed')) return reply.code(502).send({ error:'xrpl_connect_failed' });
      if (msg.startsWith('xrpl_autofill_failed')) return reply.code(502).send({ error:'xrpl_autofill_failed' });
      if (msg.startsWith('xrpl_sign_failed'))     return reply.code(502).send({ error:'xrpl_sign_failed' });
      if (msg.startsWith('xrpl_submit_failed'))   return reply.code(502).send({ error:'xrpl_submit_failed' });
      if (msg.startsWith('xrpl_offer_failed'))    return reply.code(502).send({ error:'xrpl_offer_failed', detail: msg.split(':')[1]||'unknown' });
      return reply.code(500).send({ error:'purchase_failed', detail: msg });
    }
  });
}
