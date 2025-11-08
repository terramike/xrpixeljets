// bazaar-store.js — Registry-driven Bazaar store (2025-11-07-regfix1)
import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// ---------- data paths ----------
const DATA_DIR = process.env.BAZAAR_DATA_DIR
  || path.resolve(process.cwd(), "server", "data"); // your repo layout
const REG_PATH = path.join(DATA_DIR, "registry.json");
const INV_PATH = path.join(DATA_DIR, "bazaar-inventory.json");

// ---------- in-memory state ----------
let REGISTRY = { skus: [] }; // canonical list (names, prices, issuer, taxon, kind, etc.)
let INVENTORY = [];          // [{id, sku, nftoken_id, status, reservedAt, offeredTo}]
let LOADED_AT = null;

const normalizeSKU = (s) => String(s || "").trim().toUpperCase();
const nowMs = () => Date.now();

// ---------- fs helpers ----------
async function readJSON(p, fallback) {
  try { return JSON.parse(await fsp.readFile(p, "utf8")); }
  catch { return fallback; }
}
async function writeJSON(p, obj) {
  const tmp = p + ".tmp";
  await fsp.mkdir(path.dirname(p), { recursive: true }).catch(()=>{});
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fsp.rename(tmp, p);
}

// ---------- load/merge ----------
export async function loadBazaarFromFiles() {
  const reg = await readJSON(REG_PATH, { skus: [] });
  const inv = await readJSON(INV_PATH, { items: [] });

  // normalize registry skus
  const skus = (Array.isArray(reg.skus) ? reg.skus : []).map(s => ({
    ...s,
    sku: normalizeSKU(s.sku),
    issuer: String(s.issuer || "").trim(),
    hotWallet: String(s.hotWallet || "").trim(),
    taxon: Number(s.taxon ?? 0),
    active: s.active !== false,
    kind: (s.kind || "").toLowerCase(),
    priceJetFuel: Number(s.priceJetFuel || 0) | 0,
    priceXrpDrops: Number(s.priceXrpDrops || 0) | 0,
    previewBonuses: Array.isArray(s.previewBonuses) ? s.previewBonuses : [],
    image: s.image || "",
    uriPrefix: s.uriPrefix || ""
  }));

  // normalize inventory
  const items = Array.isArray(inv.items) ? inv.items : [];
  const seen = new Set();
  INVENTORY = items.map(it => {
    const sku = normalizeSKU(it.sku);
    const id  = it.id || `${sku}:${it.nftoken_id}`;
    if (seen.has(id)) return null;
    seen.add(id);
    return {
      id,
      sku,
      nftoken_id: String(it.nftoken_id || "").trim(),
      status: it.status || "minted_stock", // minted_stock|offered_to_wallet|sold
      reservedAt: Number(it.reservedAt || 0) || 0,
      offeredTo: it.offeredTo || null
    };
  }).filter(Boolean);

  REGISTRY = { ...reg, skus };
  LOADED_AT = new Date().toISOString();

  return {
    dataDir: DATA_DIR,
    regPath: REG_PATH,
    invPath: INV_PATH,
    loadedAt: LOADED_AT,
    count: skus.length
  };
}

function liveAvailableCount(skuCode) {
  let n = 0;
  for (const it of INVENTORY) {
    if (it.sku !== skuCode) continue;
    if (it.status === "minted_stock") n++;
  }
  return n;
}

export function getLiveSkus() {
  return REGISTRY.skus.map(s => ({
    ...s,
    available: liveAvailableCount(s.sku)
  }));
}

export function getSku(sku) {
  const code = normalizeSKU(sku);
  return REGISTRY.skus.find(s => s.sku === code) || null;
}

export async function appendInventory(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("no_items");
  let added = 0;
  for (const raw of items) {
    const sku = normalizeSKU(raw.sku);
    const rec = getSku(sku);
    if (!rec) throw new Error(`unknown_sku:${sku}`);
    const nftoken_id = String(raw.nftoken_id || "").trim();
    if (!nftoken_id) throw new Error("bad_nfTokenId");

    const id = raw.id || `${sku}:${nftoken_id}`;
    if (INVENTORY.some(x => x.id === id)) continue;

    INVENTORY.push({
      id,
      sku,
      nftoken_id,
      status: raw.status || "minted_stock",
      reservedAt: 0,
      offeredTo: null
    });
    added++;
  }
  await writeJSON(INV_PATH, { items: INVENTORY });
  return { ok: true, added };
}

// reserve 1 stock for a buyer; API will create a directed SellOffer and then settle.
export function reserveOneFromInventory(sku, buyer) {
  const code = normalizeSKU(sku);
  for (const it of INVENTORY) {
    if (it.sku !== code) continue;
    if (it.status !== "minted_stock") continue;
    it.status = "offered_to_wallet";
    it.reservedAt = nowMs();
    it.offeredTo = buyer || null;
    // persistence is handled by API call path after success, but safe to sync here:
    // (we don't await; caller can catch up with markSold or reclaim)
    writeJSON(INV_PATH, { items: INVENTORY }).catch(()=>{});
    return it;
  }
  return null;
}

export async function markSold(inventoryId) {
  const idx = INVENTORY.findIndex(x => x.id === inventoryId || x.nftoken_id === inventoryId);
  if (idx >= 0) {
    INVENTORY[idx].status = "sold";
    INVENTORY[idx].offeredTo = null;
    INVENTORY[idx].reservedAt = 0;
    await writeJSON(INV_PATH, { items: INVENTORY });
    return { ok: true };
  }
  return { ok: false, error: "not_found" };
}

// reclaim offers older than ms (e.g., 15 minutes) back to stock
export function reclaimExpiredOffers(ms) {
  const cutoff = nowMs() - Math.max(60_000, Number(ms) || 900_000);
  let n = 0;
  for (const it of INVENTORY) {
    if (it.status === "offered_to_wallet" && it.reservedAt > 0 && it.reservedAt < cutoff) {
      it.status = "minted_stock";
      it.reservedAt = 0;
      it.offeredTo = null;
      n++;
    }
  }
  if (n > 0) writeJSON(INV_PATH, { items: INVENTORY }).catch(()=>{});
  return n;
}

export function getLoadedInfo() {
  return {
    dataDir: DATA_DIR,
    regPath: REG_PATH,
    invPath: INV_PATH,
    loadedAt: LOADED_AT,
    skus: getLiveSkus().map(s => ({
      sku: s.sku,
      active: !!s.active,
      available: s.available,
      kind: s.kind,
      priceJetFuel: s.priceJetFuel,
      priceXrpDrops: s.priceXrpDrops
    })),
    inventorySize: INVENTORY.length
  };
}

export function startFileWatchers(onMessage = () => {}) {
  // registry watcher -> live reload on change
  try {
    fs.watch(REG_PATH, { persistent: false }, async (ev) => {
      onMessage(`[Bazaar] registry changed (${ev}); reloading…`);
      await loadBazaarFromFiles();
      onMessage(`[Bazaar] registry reloaded`);
    });
  } catch {}
  // inventory watcher (optional; if another process edits it)
  try {
    fs.watch(INV_PATH, { persistent: false }, async (ev) => {
      onMessage(`[Bazaar] inventory changed (${ev}); syncing…`);
      const inv = await readJSON(INV_PATH, { items: [] });
      INVENTORY = Array.isArray(inv.items) ? inv.items : [];
      onMessage(`[Bazaar] inventory synced`);
    });
  } catch {}
}

// --------- chain scan helper ----------
import { Client as XRPLClient } from "xrpl";

function hexToUtf8(hex) {
  try {
    const h = String(hex || "").replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) return "";
    const bytes = new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch { return ""; }
}
function metaKind(meta) {
  // prefer explicit properties.kind
  const k1 = String(meta?.properties?.kind || meta?.Kind || "").toLowerCase();
  if (k1) return k1;
  // attributes Kind
  const a = (meta?.attributes || []).find(x => String(x?.trait_type || x?.type || "").toLowerCase() === "kind");
  return String(a?.value || "").toLowerCase();
}

// Scan owner account for NFTs that match this SKU's issuer/taxon (and optional uriPrefix/kind) and append to inventory.
export async function scanHotWalletAndCollect({ xrplClient, owner, sku, uriPrefix }) {
  const rec = getSku(sku);
  if (!rec) throw new Error(`unknown_sku:${sku}`);

  const client = xrplClient instanceof XRPLClient ? xrplClient : new XRPLClient(process.env.XRPL_WSS || "wss://xrplcluster.com");
  let weConnected = false;
  if (!client.isConnected()) { await client.connect(); weConnected = true; }

  const added = [];
  try {
    let marker = null;
    do {
      const req = { command: "account_nfts", account: owner, limit: 400 };
      if (marker) req.marker = marker;
      const res = await client.request(req);
      marker = res.result.marker;

      for (const nf of (res.result.account_nfts || [])) {
        if (nf.Issuer !== rec.issuer) continue;
        if (Number(nf.NFTokenTaxon) !== Number(rec.taxon)) continue;

        const nftId = nf.NFTokenID;
        if (INVENTORY.some(x => x.nftoken_id === nftId && x.sku === rec.sku)) continue;

        // optional URI/kind checks
        const uri = hexToUtf8(nf.URI || "");
        if (uriPrefix && uri && !uri.startsWith(uriPrefix)) continue;

        let okKind = true;
        if (rec.kind) {
          // fetch JSON to confirm kind
          okKind = false;
          if (uri) {
            const urls = uri.startsWith("ipfs://")
              ? [
                  `https://ipfs.xrp.cafe/ipfs/${uri.slice(7)}`,
                  `https://nftstorage.link/ipfs/${uri.slice(7)}`,
                  `https://ipfs.io/ipfs/${uri.slice(7)}`
                ]
              : [uri];
            for (const u of urls) {
              try {
                const r = await fetch(u, { cache: "no-store" });
                if (!r.ok) continue;
                const meta = await r.json();
                if (metaKind(meta) === rec.kind) { okKind = true; break; }
              } catch {}
            }
          }
        }
        if (!okKind) continue;

        INVENTORY.push({
          id: `${rec.sku}:${nftId}`,
          sku: rec.sku,
          nftoken_id: nftId,
          status: "minted_stock",
          reservedAt: 0,
          offeredTo: null
        });
        added.push(nftId);
      }
    } while (marker);
  } finally {
    await writeJSON(INV_PATH, { items: INVENTORY }).catch(()=>{});
    if (weConnected) { try { await client.disconnect(); } catch {} }
  }

  return { ok: true, added: added.length, nftIds: added };
}
