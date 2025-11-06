// bazaar-store.js  (2025-11-06json1)
// Loads Bazaar SKUs and Inventory from JSON. Hot-reloadable.
// ENV:
//  - BAZAAR_SKUS_PATH=./data/bazaar-skus.json
//  - BAZAAR_INVENTORY_PATH=./data/bazaar-inventory.json

import { readFile } from 'fs/promises';
import path from 'path';

const SKUS_PATH = process.env.BAZAAR_SKUS_PATH || './data/bazaar-skus.json';
const INV_PATH  = process.env.BAZAAR_INVENTORY_PATH || './data/bazaar-inventory.json';

let skus = new Map();              // sku -> record
let inventory = [];                // [{id, sku, nftoken_id, status}]
let loadedAt = null;

function mustString(x){ return typeof x === 'string' ? x : ''; }
function isClassicR(x){ return typeof x==='string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(x); }
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
  if(!i.id && i.id !== 0) return 'inventory.id missing';
  if(!i.sku) return `inventory ${i.id}: sku missing`;
  if(!i.nftoken_id) return `inventory ${i.id}: nftoken_id missing`;
  const st = i.status || 'minted_stock';
  if(!['minted_stock','offered_to_wallet','sold'].includes(st)) return `inventory ${i.id}: bad status`;
  return null;
}

export async function loadBazaarFromFiles(){
  const skuPath = path.resolve(SKUS_PATH);
  const invPath = path.resolve(INV_PATH);
  const skuRaw = await readFile(skuPath, 'utf8');
  const invRaw = await readFile(invPath, 'utf8');

  /** @type {{skus:Array}} */
  const skuJson = JSON.parse(skuRaw);
  /** @type {{inventory:Array}} */
  const invJson = JSON.parse(invRaw);

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
      priceJetFuel: toInt(s.priceJetFuel, 0),
      priceXrpDrops: toInt(s.priceXrpDrops, 0),
      stackRule: s.stackRule || 'best-of-per-stat',
      active: s.active !== false,
      supply: toInt(s.supply, 0)
    });
  }

  const inv = [];
  for(const i of (invJson.inventory||[])){
    const e = validateInv(i);
    if(e){ errs.push(e); continue; }
    inv.push({
      id: i.id,
      sku: i.sku,
      nftoken_id: i.nftoken_id,
      status: i.status || 'minted_stock'
    });
  }

  if(errs.length){ throw new Error('Bazaar JSON validation errors:\n- ' + errs.join('\n- ')); }

  skus = map;
  inventory = inv;
  loadedAt = new Date().toISOString();
  return { ok:true, skus: skus.size, inventory: inventory.length, loadedAt };
}

export function getLiveSkus(){
  const out = [];
  for(const s of skus.values()){
    if(!s.active) continue;
    const available = inventory.filter(x => x.sku===s.sku && x.status==='minted_stock').length;
    out.push({
      sku: s.sku,
      name: s.name,
      image: s.image,
      priceJetFuel: s.priceJetFuel,
      priceXrpDrops: s.priceXrpDrops,
      available,
      stackRule: s.stackRule,
      previewBonuses: s.previewBonuses || s.preview || [] // optional convenience
    });
  }
  return out;
}

export function getSku(id){ return skus.get(id) || null; }

export function reserveOneFromInventory(sku){
  const item = inventory.find(x => x.sku===sku && x.status==='minted_stock');
  if(!item) return null;
  item.status = 'offered_to_wallet';
  return item;
}
export function markSold(inventoryId){
  const item = inventory.find(x => x.id===inventoryId);
  if(item) item.status = 'sold';
}
export function getLoadedInfo(){ return { loadedAt, skus: skus.size, inventory: inventory.length }; }
