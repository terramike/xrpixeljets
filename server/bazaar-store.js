// bazaar-store.js  (2025-11-06json2)
// JSON-backed Bazaar store with:
// - hot reload on file changes
// - append/save inventory
// - offer locks + reclaim
// ENV: BAZAAR_SKUS_PATH, BAZAAR_INVENTORY_PATH

import { readFile, writeFile, watch } from 'fs/promises';
import fscb from 'fs';
import path from 'path';

const SKUS_PATH = process.env.BAZAAR_SKUS_PATH || './data/bazaar-skus.json';
const INV_PATH  = process.env.BAZAAR_INVENTORY_PATH || './data/bazaar-inventory.json';

let skus = new Map();      // sku -> { ... }
let inventory = [];        // [{id, sku, nftoken_id, status}]
let loadedAt = null;

// in-memory locks of offers: invId -> { ts }
const offerLocks = new Map();

function toInt(x, d=0){ const n=Number(x); return Number.isFinite(n)?Math.trunc(n):d; }

function validateSku(s){
  if(!s) return 'missing sku object';
  if(!s.sku || typeof s.sku!=='string') return 'sku.sku missing';
  if(!s.name) return `sku ${s.sku}: name missing`;
  if(!s.image) return `sku ${s.sku}: image missing`;
  if(s.priceXrpDrops != null && !Number.isFinite(Number(s.priceXrpDrops))) return `sku ${s.sku}: priceXrpDrops invalid`;
  if(s.priceJetFuel != null && !Number.isFinite(Number(s.priceJetFuel))) return `sku ${s.sku}: priceJetFuel invalid`;
  return null;
}
function validateInv(i){
  if(!i) return 'missing inventory object';
  if(i.id==null) return 'inventory.id missing';
  if(!i.sku) return `inventory ${i.id}: sku missing`;
  if(!i.nftoken_id) return `inventory ${i.id}: nftoken_id missing`;
  const st = i.status || 'minted_stock';
  if(!['minted_stock','offered_to_wallet','sold'].includes(st)) return `inventory ${i.id}: bad status`;
  return null;
}

async function readJSON(fp){
  const raw = await readFile(fp,'utf8');
  return JSON.parse(raw);
}
async function writeJSON(fp, obj){
  const tmp = fp + '.tmp';
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await writeFile(fp, JSON.stringify(obj, null, 2)); // overwrite atomically enough for our use
}

export async function loadBazaarFromFiles(){
  const skuJson = await readJSON(path.resolve(SKUS_PATH));
  const invJson = await readJSON(path.resolve(INV_PATH));

  const map = new Map();
  const errs = [];

  for(const s of (skuJson.skus||[])){
    const e = validateSku(s);
    if(e){ errs.push(e); continue; }
    map.set(s.sku, {
      sku: s.sku,
      name: s.name,
      image: s.image,
      meta_uri: s.meta_uri || '',
      meta_uri_prefix: s.meta_uri_prefix || '', // optional for scans
      priceJetFuel: toInt(s.priceJetFuel, 0),
      priceXrpDrops: toInt(s.priceXrpDrops, 0),
      stackRule: s.stackRule || 'best-of-per-stat',
      active: s.active !== false,
      supply: toInt(s.supply, 0),
      previewBonuses: s.previewBonuses || s.preview || []
    });
  }

  const inv = [];
  for(const i of (invJson.inventory||[])){
    const e = validateInv(i);
    if(e){ errs.push(e); continue; }
    inv.push({ id: i.id, sku: i.sku, nftoken_id: i.nftoken_id, status: i.status || 'minted_stock' });
  }

  if(errs.length){ throw new Error('Bazaar JSON validation errors:\n- ' + errs.join('\n- ')); }

  skus = map;
  inventory = inv;
  loadedAt = new Date().toISOString();
  return { ok:true, skus: skus.size, inventory: inventory.length, loadedAt };
}

export function getLoadedInfo(){ return { loadedAt, skus: skus.size, inventory: inventory.length }; }

export function getLiveSkus(){
  const out = [];
  for(const s of skus.values()){
    if(!s.active) continue;
    const available = inventory.filter(x => x.sku===s.sku && x.status==='minted_stock').length;
    out.push({ sku:s.sku, name:s.name, image:s.image, priceJetFuel:s.priceJetFuel, priceXrpDrops:s.priceXrpDrops, available, stackRule:s.stackRule, previewBonuses: s.previewBonuses });
  }
  return out;
}

export function getSku(id){ return skus.get(id) || null; }

export function reserveOneFromInventory(sku){
  const item = inventory.find(x => x.sku===sku && x.status==='minted_stock');
  if(!item) return null;
  item.status = 'offered_to_wallet';
  offerLocks.set(item.id, { ts: Date.now() });
  return item;
}

export function markSold(inventoryId){
  const item = inventory.find(x => x.id===inventoryId);
  if(item) { item.status = 'sold'; offerLocks.delete(item.id); }
}

export function reclaimExpiredOffers(olderMs){
  const cutoff = Date.now() - (olderMs|| (15*60*1000));
  let reclaimed = 0;
  for (const [invId, lock] of offerLocks.entries()){
    if (lock.ts <= cutoff){
      const item = inventory.find(x => x.id===invId);
      if(item && item.status==='offered_to_wallet'){
        item.status = 'minted_stock';
        offerLocks.delete(invId);
        reclaimed++;
      }
    }
  }
  return reclaimed;
}

// ---------- write-back helpers ----------
async function nextInventoryId(){
  const max = inventory.reduce((m,x)=> Math.max(m, Number(x.id)||0), 0);
  return max+1;
}
export async function appendInventory(rows){
  // rows: [{ sku, nftoken_id, status? }]
  const invPath = path.resolve(INV_PATH);
  const invJson = await readJSON(invPath);
  const cur = invJson.inventory || [];

  for(const r of rows){
    const row = { id: await nextInventoryId(), sku: r.sku, nftoken_id: r.nftoken_id, status: r.status || 'minted_stock' };
    const e = validateInv(row); if(e) throw new Error(e);
    cur.push(row);
    inventory.push(row); // in-memory
  }
  await writeJSON(invPath, { inventory: cur });
  loadedAt = new Date().toISOString();
  return { added: rows.length };
}

// ---------- hot reload on file changes ----------
let watchersStarted = false;
export function startFileWatchers(logFn=()=>{}){
  if (watchersStarted) return;
  watchersStarted = true;
  const start = (fp) => {
    fscb.watch(fp, { persistent: false }, async () => {
      try { await loadBazaarFromFiles(); logFn(`[Bazaar] Reloaded after change in ${fp}`); }
      catch(e){ logFn(`[Bazaar] Reload failed (${fp}): ${e.message}`); }
    });
  };
  try { start(path.resolve(SKUS_PATH)); } catch {}
  try { start(path.resolve(INV_PATH)); } catch {}
}

// ---------- scan helper (xrpl account_nfts) ----------
export async function scanHotWalletAndCollect({ xrplClient, owner, sku, uriPrefix }){
  // Fetch NFTs owned by 'owner', find URIs starting with 'uriPrefix' (or SKU.meta_uri_prefix/meta_uri), add missing NFTokenIDs to inventory.
  if (!xrplClient?.isConnected()) await xrplClient.connect();
  const s = getSku(sku);
  if (!s) throw new Error('invalid_sku');

  const prefix = uriPrefix || s.meta_uri_prefix || s.meta_uri || '';
  if (!prefix) throw new Error('uri_prefix_required');

  const out = await xrplClient.request({ command:'account_nfts', account: owner, ledger_index:'validated', limit: 400 });
  const nfts = out.result?.account_nfts || [];
  const haveIds = new Set(inventory.filter(i => i.sku===sku).map(i => i.nftoken_id));
  const adds = [];

  for (const n of nfts){
    const uriHex = String(n.URI||'');
    const uri = uriHex ? Buffer.from(uriHex, 'hex').toString('utf8') : '';
    if (!uri) continue;
    if (!uri.startsWith(prefix)) continue;
    if (haveIds.has(n.NFTokenID)) continue;
    adds.push({ sku, nftoken_id: n.NFTokenID });
  }
  if (!adds.length) return { added:0 };

  await appendInventory(adds);
  return { added: adds.length };
}
