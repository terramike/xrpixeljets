// server/bazaar-hot.js — v=2025-11-08-hot-simple+debug3
// Minimal hot-wallet bazaar plugin + diagnostics
//
// Client flow (already in your page):
//  • GET  /bazaar/hot/list                -> quick list from hot wallet (no headers)
//  • POST /bazaar/hot/purchase {sku}      -> JWT + X-Wallet; server debits JFUEL & creates directed SellOffer
//
// ENV:
//   HOT_SEED | HOT_WALLET_SEED  -> secp seed for hot wallet (should derive rJz7oo...)
//   ISSUER_ADDR | ISSUER_ADDRESS -> rfYZ... issuer for game
//   XRPL_WSS                     -> wss://xrplcluster.com
//   JWT_SECRET, DATABASE_URL
// Optional:
//   BAZAAR_TAXON (default 201)
//   BAZAAR_OFFER_TTL_SEC (default 900)

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

async function accountInfoClassic(addr){
  await ensureXRPL();
  try{
    const r = await xrplClient.request({ command:'account_info', account: addr, ledger_index:'current' });
    return r.result;
  }catch(e){
    // bubble raw ripple error code if present
    throw new Error(e?.data?.error_message || e?.data?.error || e?.message || 'account_info_failed');
  }
}

async function listFromHot(){
  await ensureXRPL();
  const out = [];
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
      const price = priceFromMeta(meta);
      out.push({
        nftoken_id: nf.NFTokenID,
        sku: skuFromMeta(meta),
        name: meta?.name || '',
        uri,
        image: meta?.image || null,
        price
      });
    }
  } while(marker);
  return out;
}

async function createDirectedSellOffer({ nftoken_id, buyer, amountDrops }){
  await ensureXRPL();
  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: hotWallet.address,
    NFTokenID: nftoken_id,
    Amount: String(amountDrops ?? 0),
    Flags: 1,
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

// ----------------- ROUTES -----------------
export async function registerBazaarHotRoutes(app){

  // Simple status (no headers)
  app.get('/bazaar/hot/ping', async (_req, reply) => {
    reply.send({
      ok:true,
      issuer: ISSUER || '(missing)',
      taxon: TAXON,
      hotConfigured: !!HOT_SEED
    });
  });

  // Who am I (no headers)
  app.get('/bazaar/hot/wallet', async (_req, reply) => {
    try{
      await ensureXRPL();
      reply.send({ ok:true, address: hotWallet.address, wss: XRPL_WSS });
    }catch(e){
      reply.code(500).send({ error:'whoami_failed', detail:String(e?.message||e) });
    }
  });

  // Check account_info (no headers) — will expose “Account not found.” if that’s the case
  app.get('/bazaar/hot/check-account', async (_req, reply) => {
    try{
      await ensureXRPL();
      const info = await accountInfoClassic(hotWallet.address);
      reply.send({ ok:true, address: hotWallet.address, info });
    }catch(e){
      reply.code(500).send({ error:'account_info_failed', detail:String(e?.message||e), address: hotWallet?.address || '(none)' });
    }
  });

  // Debug (no headers)
  app.get('/bazaar/hot/debug', async (_req, reply) => {
    try{
      await ensureXRPL();
      // Count NFTs without throwing if actNotFound
      let hotNftCount = -1;
      try{
        const r = await xrplClient.request({ command:'account_nfts', account: hotWallet.address, limit:1 });
        hotNftCount = (r?.result?.account_nfts||[]).length;
      }catch(e){
        hotNftCount = String(e?.data?.error || e?.message || 'error');
      }
      reply.send({
        ok:true,
        wss: XRPL_WSS,
        hot: hotWallet?.address || '(none)',
        issuer: ISSUER || '(missing)',
        taxon: TAXON,
        xrplConnected: xrplClient?.isConnected() || false,
        hotNftCount
      });
    }catch(e){
      reply.code(500).send({ error:'debug_failed', detail:String(e?.message||e) });
    }
  });

  // Public list (no headers)
  app.get('/bazaar/hot/list', async (_req, reply) => {
    try{
      const items = await listFromHot();
      reply.send({ ok:true, items });
    }catch(e){
      reply.code(500).send({ error:'list_failed', detail:String(e?.message||e) });
    }
  });

  // Peek one SKU (no headers)
  app.get('/bazaar/hot/peek', async (req, reply) => {
    const sku = String(req.query?.sku || '').toUpperCase();
    if (!sku) return reply.code(400).send({ error:'bad_sku' });
    try{
      // reuse list & find first
      const items = await listFromHot();
      const m = items.find(it => it.sku === sku);
      if (!m) return reply.code(404).send({ error:'not_found' });
      reply.send({ ok:true, ...m });
    }catch(e){
      reply.code(500).send({ error:'peek_failed', detail:String(e?.message||e) });
    }
  });

  // Purchase (JWT + X-Wallet)
  app.post('/bazaar/hot/purchase', async (req, reply) => {
    const jwtOk = requireJWT(req, reply); if (!jwtOk) return;
    const buyer = needWallet(req, reply); if (!buyer) return;

    const { sku } = req.body || {};
    if (!sku) return reply.code(400).send({ error:'bad_sku' });

    // choose first matching in list
    let match;
    try{
      const items = await listFromHot();
      match = items.find(it => it.sku === String(sku).toUpperCase());
      if (!match) return reply.code(409).send({ error:'sold_out' });
    }catch(e){
      return reply.code(500).send({ error:'scan_failed', detail:String(e?.message||e) });
    }

    // JFUEL debit
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

    // Offer creation (refund on error)
    try{
      const offerId = await createDirectedSellOffer({
        nftoken_id: match.nftoken_id,
        buyer,
        amountDrops: match.price.xrpDrops|0
      });
      reply.send({ ok:true, sellOfferId: offerId, nftokenId: match.nftoken_id, price: match.price });
    }catch(e){
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
      if (msg.startsWith('xrpl_offer_failed'))    return reply.code(502).send({ error:'xrpl_offer_failed', detail: msg.split(':')[1]||'unknown' });
      return reply.code(500).send({ error:'purchase_failed', detail: msg });
    }
  });
}
