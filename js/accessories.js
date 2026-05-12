/* /jets/js/accessories.js — OG inline + Registry Crew (collection-aware)
   v2025-01-16
   - FIXED: Now parses direct stat attributes like { trait_type: "regen", value: "3" }
   - FIXED: Handles all stat types: regen, health, energyCap, attack, speed, defense, hit, crit, dodge
   - Matching order: 1) Issuer (if specified), 2) Taxon (if specified), 3) Normalized collection name/ID, 4) Match array
   - Totals = registry sums + gear sums (unchanged)
   - Jets (taxon 200) are ignored by gear parser so Legendary Jets don't show as accessories
*/

export const ACCESSORY = {
  STATS: {
    health: 'health',
    energyCap: 'energyCap',
    regen: 'regen',
    attack: 'attack',
    speed: 'speed',
    defense: 'defense',
    hit: 'hit',
    crit: 'crit',
    dodge: 'dodge'
  }
};

const XRPL = window.xrpl;
const NET  = window.XRPL_NET || 'wss://xrplcluster.com';

const CACHE = new Map();
const META_CACHE = new Map();
const WEB_BASE = String(window.JETS_WEB_BASE || 'https://mykeygo.io/jets').replace(/\/+$/, '');
const REGISTRY_URL = String(window.JETS_REGISTRY_URL || `${WEB_BASE}/registry.json`);

const REG_URLS = Array.from(new Set([
  '/registry.json',
  '/jets/registry.json',
  REGISTRY_URL
]));
const REG_TTL = 0; // Always reload
let REGISTRY = null, REGISTRY_TS = 0;

function emptyBonuses() {
  return {
    health: 0,
    energyCap: 0,
    regen: 0,
    attack: 0,
    speed: 0,
    defense: 0,
    hit: 0,
    crit: 0,
    dodge: 0
  };
}

function isClassic(a) { return /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(a || '')); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

const uniqBy = (arr, keyFn) => {
  const s = new Set(), out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (s.has(k)) continue;
    s.add(k); out.push(it);
  }
  return out;
};

function hexToAscii(h) {
  try {
    let hex = String(h || '').replace(/^0x/i, '').replace(/\s+/g, '');
    if (!hex || hex.length % 2) return '';
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch { return ''; }
}

const IPFS_GW = [
  'https://ipfs.xrp.cafe/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://cf-ipfs.com/ipfs/'
];

function ipfsCandidates(uri) {
  const id = String(uri || '').replace(/^ipfs:\/\//, '').replace(/^ipfs\//, '');
  return IPFS_GW.map(g => g + id);
}

function candidatesFor(uri) {
  if (!uri) return [];
  const s = String(uri);
  return (s.startsWith('ipfs://') || s.startsWith('ipfs/')) ? ipfsCandidates(s) : [s];
}

async function fetchWithFallback(urls) {
  let last;
  for (const u of urls) {
    try {
      const r = await fetch(u, { mode: 'cors' });
      if (r.ok) return await r.json();
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
  }
  throw last || new Error('fetch failed');
}

async function fetchMeta(uri) {
  const key = String(uri || ''); if (!key) return null;
  if (META_CACHE.has(key)) return META_CACHE.get(key);
  try {
    const j = await fetchWithFallback(candidatesFor(key));
    META_CACHE.set(key, j || null);
    return j || null;
  } catch {
    META_CACHE.set(key, null);
    return null;
  }
}

function cacheBustUrl(url) {
  const sep = url.includes('?') ? '&' : '?';
  const ts = Date.now();
  const nonce = Math.random().toString(36).substring(2, 10);
  return `${url}${sep}_cb=${ts}&_n=${nonce}`;
}

async function loadRegistry(force = false) {
  const now = Date.now();
  if (!force && REGISTRY && (now - REGISTRY_TS) < REG_TTL) return REGISTRY;

  console.info('[Accessories] Loading registry... force=' + force + ', current version=' + (REGISTRY?.version || 'none'));

  let lastErr;
  for (const baseUrl of REG_URLS) {
    try {
      const url = cacheBustUrl(baseUrl);
      console.info('[Accessories] Fetching:', url);

      const r = await fetch(url, {
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });

      if (r.ok) {
        REGISTRY = await r.json();
        REGISTRY_TS = now;
        console.info('[Accessories] Registry loaded from:', baseUrl, 'version:', REGISTRY?.version || 'unknown', 'collections:', REGISTRY?.collections?.length || 0);
        if (REGISTRY?.collections) {
          console.info('[Accessories] Collections:', REGISTRY.collections.map(c => c.name || c.id).join(', '));
        }
        return REGISTRY;
      }
      lastErr = new Error('http_' + r.status);
      console.warn('[Accessories] HTTP error from', baseUrl, r.status);
    } catch (e) {
      lastErr = e;
      console.warn('[Accessories] Fetch error from', baseUrl, e.message);
    }
  }

  console.warn('[Accessories] Registry unavailable, using embedded fallback.', lastErr?.message || lastErr);
  REGISTRY = {
    version: 'embedded-fallback',
    rules: {
      evaluation: 'presencePerCollection_bestOfInside_sumAcrossCollections',
      globalCaps: {
        attack: 999, speed: 999, defense: 999,
        health: 9999, energyCap: 9999, regen: 999,
        hit: 100, crit: 100, dodge: 100
      }
    },
    collections: [{
      id: 'fuzzy-bears',
      name: 'Fuzzy Bears',
      type: 'crew',
      logo: `${WEB_BASE}/asset/fuzzybearlogo.webp`,
      match: ['xrp.cafe/collection/fuzzybears', 'fuzzy bear', 'fuzzybears'],
      bonuses: { attack: 10, speed: 10, defense: 10 },
      stacking: 'presence'
    }]
  };
  REGISTRY_TS = now;
  return REGISTRY;
}

export function clearAllCaches() {
  CACHE.clear();
  META_CACHE.clear();
  REGISTRY = null;
  REGISTRY_TS = 0;
  console.info('[Accessories] All caches cleared');
}

export async function forceReloadRegistry() {
  REGISTRY = null;
  REGISTRY_TS = 0;
  return await loadRegistry(true);
}

function matchesAny(haystack, needles) {
  const hay = String(haystack || '').toLowerCase();
  return (needles || []).some(nx => hay.includes(String(nx || '').toLowerCase()));
}

function metaHay(meta, uri, nft) {
  return [
    meta?.collection?.name, meta?.collection, meta?.name, meta?.series,
    meta?.external_url, meta?.website, meta?.description,
    meta?.image, meta?.animation_url, uri,
    nft?.Issuer, nft?.NFTokenTaxon
  ].filter(Boolean).join(' | ');
}

async function listAllNFTs(account) {
  const client = new XRPL.Client(NET); await client.connect();
  const out = []; let marker = null;
  try {
    do {
      const req = { command: 'account_nfts', account, limit: 400 };
      if (marker) req.marker = marker;
      const res = await client.request(req);
      out.push(...(res.result?.account_nfts || []));
      marker = res.result?.marker;
    } while (marker);
  } finally { try { await client.disconnect(); } catch {} }
  return out;
}

/* --- Upgrade parser for in-game gear (with Jet skip but allow taxon 201 for crew bonus) --- */
async function parseGearFromMeta(nft) {
  // Skip XRPixel Jets (taxon 200) so they don't become "gear"
  const JETS_TAXON = 200;
  const taxonRaw = nft.NFTokenTaxon ?? nft.nftoken_taxon;
  const taxon = Number(taxonRaw ?? NaN);
  if (Number.isFinite(taxon) && taxon === JETS_TAXON) {
    return null;
  }

  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex))
    ? hexToAscii(uriHex)
    : String(uriHex || '');
  if (!uri) return null;

  const j = await fetchMeta(uri);
  if (!j) return null;

  const props = j.properties || {};
  const collName = j.collection?.name || j.collection || null;

  const img = (() => {
    const u = j.image || j.image_url || props.image || j.video || '';
    const urls = candidatesFor(u);
    return urls.length ? urls[0] : '';
  })();

  // Multi-stat support: a single NFT can contribute multiple stat bonuses (Pilots patches)
  const items = [];

  const pushStat = (statKey, bonusVal) => {
    const stat = String(statKey || '').toLowerCase().trim();
    const bonus = Number(bonusVal);

    if (!ACCESSORY.STATS[stat]) return;
    if (!Number.isFinite(bonus) || bonus === 0) return;

    items.push({
      id: `${nft.NFTokenID}:${stat}`,
      name: j.name || props.name || 'Upgrade',
      stat,
      bonus,
      image: img,
      collection: collName ? { id: collName.toLowerCase().replace(/\s+/g, '-'), name: collName } : null,
      logo: img
    });
  };

  // === Pilot patch parsing ===
  // Looks for attributes where trait_type contains "patch"
  // and values like: a5, atk5, attack5, speed_5, def5, hit5, crit5, dodge5
  const attrs = Array.isArray(j.attributes) ? j.attributes : [];

  const decodePatch = (vRaw) => {
    const s = String(vRaw || '').toLowerCase().trim();
    if (!s) return null;

    const m = s.match(/(\d+)\s*$/) || s.match(/_(\d+)\s*$/);
    const n = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(n) || n === 0) return null;

    if (s.startsWith('a') || s.startsWith('atk') || s.startsWith('attack')) return { stat: 'attack', bonus: n };
    if (s.startsWith('spd') || s.startsWith('speed')) return { stat: 'speed', bonus: n };
    if (s.startsWith('def') || s.startsWith('defense')) return { stat: 'defense', bonus: n };
    if (s.startsWith('hit')) return { stat: 'hit', bonus: n };
    if (s.startsWith('crit')) return { stat: 'crit', bonus: n };
    if (s.startsWith('dodge') || s.startsWith('ddg')) return { stat: 'dodge', bonus: n };

    return null;
  };

  for (const a of attrs) {
    const tt = String(a.trait_type || a.type || '').toLowerCase();
    if (!tt.includes('patch')) continue;
    const parsed = decodePatch(a.value);
    if (!parsed) continue;
    pushStat(parsed.stat, parsed.bonus);
  }

  // === Direct stat attribute parsing ===
  // Handle NFTs where the trait_type IS the stat name (e.g., { trait_type: "regen", value: "3" })
  for (const a of attrs) {
    const traitType = String(a.trait_type || a.type || '').toLowerCase().trim();
    const val = a.value;
    if (ACCESSORY.STATS[traitType] && val != null) {
      const numVal = Number(val);
      if (Number.isFinite(numVal) && numVal !== 0) {
        pushStat(traitType, numVal);
      }
    }
  }

  // === Back-compat: stat/bonus pattern (single pair) ===
  let stat = (j.stat || '').toString().trim().toLowerCase();
  let bonus = Number(j.bonus);

  if (!stat && props.stat != null) stat = String(props.stat).toLowerCase();
  if (!Number.isFinite(bonus) && props.bonus != null) bonus = Number(props.bonus);

  if ((!stat || !Number.isFinite(bonus)) && Array.isArray(attrs)) {
    for (const a of attrs) {
      const k = String(a.trait_type || a.type || '').toLowerCase();
      const v = a.value;
      if (!stat && k === 'stat' && v != null) stat = String(v).toLowerCase();
      if (!Number.isFinite(bonus) && k === 'bonus' && v != null) bonus = Number(v);
    }
  }

  if (ACCESSORY.STATS[stat] && Number.isFinite(bonus) && bonus !== 0) {
    pushStat(stat, bonus);
  }

  // === Bazaar-style fallback: infer from Attack/Defense/Speed/etc attrs (single best) ===
  // Keep existing behavior so older upgrades still work.
  if (items.length === 0) {
    let kind = '';
    const atts = Object.create(null);

    if (Array.isArray(attrs)) {
      for (const a of attrs) {
        const k = String(a?.trait_type ?? a?.type ?? '').toLowerCase();
        atts[k] = a?.value;
      }
      if (typeof atts['kind'] === 'string') kind = String(atts['kind']).toLowerCase().trim();
    }

    const nums = {
      attack: Number(atts['attack'] ?? NaN),
      defense: Number(atts['defense'] ?? NaN),
      speed: Number(atts['speed'] ?? NaN),
      regen: Number(atts['regen'] ?? NaN),
      health: Number(atts['health'] ?? NaN),
      energyCap: Number(atts['energycap'] ?? atts['energy_cap'] ?? atts['energycap'] ?? NaN),
      hit: Number(atts['hit'] ?? NaN),
      crit: Number(atts['crit'] ?? NaN),
      dodge: Number(atts['dodge'] ?? NaN)
    };

    const CANDS = ['attack', 'defense', 'speed', 'regen', 'health', 'energyCap', 'hit', 'crit', 'dodge'];
    let chosen = '';

    if (kind && CANDS.includes(kind) && Number.isFinite(nums[kind]) && nums[kind] !== 0) {
      chosen = kind;
    } else {
      for (const k of CANDS) {
        if (Number.isFinite(nums[k]) && nums[k] !== 0) { chosen = k; break; }
      }
    }

    if (ACCESSORY.STATS[chosen] && Number.isFinite(nums[chosen]) && Number(nums[chosen]) !== 0) {
      pushStat(chosen, nums[chosen]);
    }
  }

  if (!items.length) return null;

  console.info('[Accessories] Parsed multi-gear:', items.map(x => ({ stat: x.stat, bonus: x.bonus, nft: String(nft.NFTokenID || '').slice(0, 12) })));
  return items;
}

/* --- Registry detection: collection-aware matching with normalization --- */
function normalizeForMatch(str) {
  return String(str || '').toLowerCase().replace(/[\s\-_]+/g, '');
}

function nftMatchesRegistryCollection(nft, coll, meta) {
  const issuer = String(coll?.issuer || '').trim();
  const nftIssuer = String(nft?.Issuer || '').trim();

  const issuerMatches = !issuer || (nftIssuer === issuer);
  if (!issuerMatches) {
    return false;
  }

  const txs = Array.isArray(coll?.taxons) ? coll.taxons.map(Number).filter(Number.isFinite) : null;
  if (txs && txs.length > 0) {
    if (!txs.includes(Number(nft?.NFTokenTaxon || NaN))) {
      return false;
    }
  }

  const collectionId = String(coll?.id || '').toLowerCase();
  const collectionName = String(coll?.name || '').toLowerCase();
  const normId = normalizeForMatch(collectionId);
  const normName = normalizeForMatch(collectionName);

  const metaCollectionName = String(meta?.collection?.name || meta?.collection || '').toLowerCase();
  const metaName = String(meta?.name || '').toLowerCase();
  const metaSeries = String(meta?.series || '').toLowerCase();
  const metaDescription = String(meta?.description || '').toLowerCase();

  const normMetaColl = normalizeForMatch(metaCollectionName);
  const normMetaName = normalizeForMatch(metaName);
  const normMetaSeries = normalizeForMatch(metaSeries);
  const normMetaDesc = normalizeForMatch(metaDescription);

  if (normMetaColl && (normId || normName)) {
    if (normMetaColl.includes(normId) || normId.includes(normMetaColl)) {
      return true;
    }
    if (normMetaColl.includes(normName) || normName.includes(normMetaColl)) {
      return true;
    }
  }

  if (normId || normName) {
    if (normMetaName && (normMetaName.includes(normId) || normMetaName.includes(normName))) {
      return true;
    }
    if (normMetaSeries && (normMetaSeries.includes(normId) || normMetaSeries.includes(normName))) {
      return true;
    }
  }

  if (normId || normName) {
    if (normMetaDesc && (normMetaDesc.includes(normId) || normMetaDesc.includes(normName))) {
      console.log(`[Accessories] Matched ${collectionName} via description for NFT ${nft?.NFTokenID?.slice(0, 12)}`);
      return true;
    }
  }

  if (Array.isArray(coll?.match) && coll.match.length > 0) {
    const hay = metaHay(meta, '', nft);
    if (matchesAny(hay, coll.match)) {
      return true;
    }
  }

  if (issuer && nftIssuer === issuer) {
    const hasNoCollectionMeta = !metaCollectionName && !metaSeries;
    if (hasNoCollectionMeta) {
      console.log(`[Accessories] Matched ${collectionName} by issuer-only for NFT ${nft?.NFTokenID?.slice(0, 12)} (no collection metadata)`);
      return true;
    }
  }

  return false;
}

async function detectRegistryItems(nft) {
  const items = [];
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex))
    ? hexToAscii(uriHex)
    : String(uriHex || '');
  if (!REGISTRY) await loadRegistry(false);
  if (!REGISTRY?.collections) return items;

  const meta = uri ? await fetchMeta(uri) : null;

  for (const coll of REGISTRY.collections) {
    if (!coll?.bonuses) continue;
    if (!nftMatchesRegistryCollection(nft, coll, meta)) continue;

    for (const [k, v] of Object.entries(coll.bonuses || {})) {
      if (!ACCESSORY.STATS[k]) continue;
      items.push({
        id: `${coll.id}_${k}`,
        name: coll.name || 'Crew',
        stat: k,
        bonus: Number(v || 0),
        image: coll.logo || '',
        logo: coll.logo || '',
        collection: { id: coll.id, name: coll.name || 'Crew' },
        sourceId: coll.id
      });
    }
  }
  return items;
}

/* --- Aggregation paths: registry (crew) vs gear (upgrades) --- */
function aggregateRegistry(items) {
  const zero = emptyBonuses();
  const byColl = new Map();

  for (const it of items.filter(x => !!x.sourceId)) {
    const key = String(it.collection?.id || it.sourceId).toLowerCase();
    if (!key) continue;
    const rec = byColl.get(key) || {
      bonuses: { ...zero },
      logo: it.logo || it.image || '',
      name: it.collection?.name || it.name || 'Crew',
      id: key
    };
    const statKey = (it.stat || '').toLowerCase();
    if (!ACCESSORY.STATS[statKey]) { byColl.set(key, rec); continue; }
    const val = Number(it.bonus || 0);
    const cur = Number(rec.bonuses[statKey] || 0);
    rec.bonuses[statKey] = (val < 0) ? Math.min(cur, val) : Math.max(cur, val);
    if (!rec.logo && (it.logo || it.image)) rec.logo = it.logo || it.image;
    byColl.set(key, rec);
  }

  const registryTotals = { ...zero };
  for (const { bonuses } of byColl.values()) {
    for (const k of Object.keys(registryTotals)) {
      registryTotals[k] += Number(bonuses[k] || 0);
    }
  }
  return { registryTotals, activeCollections: Array.from(byColl.values()) };
}

function sumGearBonuses(items) {
  const out = emptyBonuses();
  for (const it of items.filter(x => !x.sourceId)) {
    const k = (it.stat || '').toLowerCase();
    if (!ACCESSORY.STATS[k]) continue;
    out[k] += Number(it.bonus || 0);
  }
  return out;
}

function addBonuses(a, b) {
  const out = { ...emptyBonuses() };
  for (const k of Object.keys(out)) out[k] = Number(a[k] || 0) + Number(b[k] || 0);
  return out;
}

export async function getAccessoryBonuses(wallet, { force = false } = {}) {
  if (!isClassic(wallet)) {
    return { ts: Date.now(), bonuses: emptyBonuses(), items: [], activeCollections: [] };
  }

  const now = Date.now();
  const cached = CACHE.get(wallet);
  if (cached && !force && (now - cached.ts < 60_000)) return cached;

  if (force) {
    console.info('[Accessories] Force refresh - clearing wallet cache for', wallet);
    CACHE.delete(wallet);
    META_CACHE.clear(); // Clear meta cache too for fresh NFT metadata
    await loadRegistry(true);
  } else {
    await loadRegistry(false);
  }

  try {
    const nfts = await listAllNFTs(wallet);
    console.info('[Accessories] Loaded', nfts.length, 'NFTs for', wallet);

    const gearRaw = (await Promise.all(nfts.map(parseGearFromMeta))).flat().filter(Boolean);
    const regRaw = (await Promise.all(nfts.map(detectRegistryItems))).flat();

    console.info('[Accessories] Parsed gear items:', gearRaw.length, 'registry items:', regRaw.length);

    const gear = uniqBy(gearRaw, it => `${it.id}:${it.stat}:${it.bonus}`);
    const regPresents = uniqBy(regRaw, it => `${it.sourceId}:${it.stat}`);
    const parsed = [...gear, ...regPresents];

    const { registryTotals, activeCollections } = aggregateRegistry(parsed);
    const gearTotals = sumGearBonuses(parsed);

    const caps = REGISTRY?.rules?.globalCaps || {};
    const totalsPreCap = addBonuses(registryTotals, gearTotals);
    for (const [k, cap] of Object.entries(caps)) {
      totalsPreCap[k] = clamp(Number(totalsPreCap[k] || 0), -999999, cap);
    }

    console.info('[Accessories] Final bonuses:', totalsPreCap);

    const payload = { ts: now, bonuses: totalsPreCap, items: parsed, activeCollections };
    CACHE.set(wallet, payload);
    return payload;
  } catch (e) {
    console.error('[Accessories] Error:', e);
    const payload = { ts: now, bonuses: emptyBonuses(), items: [], activeCollections: [] };
    CACHE.set(wallet, payload);
    return payload;
  }
}

export function applyAccessoryBonuses(base, wallet) {
  const b = (wallet && CACHE.get(wallet)?.bonuses) || emptyBonuses();
  const out = { ...base };
  if (Number.isFinite(out.health)) out.health += b.health;
  if (Number.isFinite(out.energyCap)) out.energyCap += b.energyCap;
  if (Number.isFinite(out.regenPerMin)) out.regenPerMin += b.regen;
  if (Number.isFinite(out.attack)) out.attack += b.attack;
  if (Number.isFinite(out.speed)) out.speed += b.speed;
  if (Number.isFinite(out.defense)) out.defense += b.defense;
  if (Number.isFinite(out.hit)) out.hit += b.hit;
  if (Number.isFinite(out.crit)) out.crit += b.crit;
  if (Number.isFinite(out.dodge)) out.dodge += b.dodge;
  return out;
}

/* ---------- UI ---------- */
function labelFor(k) {
  return {
    health: 'HP',
    energyCap: 'ENERGY',
    regen: 'REGEN',
    attack: 'ATK',
    speed: 'SPD',
    defense: 'DEF',
    hit: 'HIT%',
    crit: 'CRIT%',
    dodge: 'DODGE%'
  }[k] || k.toUpperCase();
}

function fmtPair(k, v) {
  if (!v) return null;
  const isPct = (k === 'hit' || k === 'crit' || k === 'dodge');
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v}${isPct ? '%' : (k === 'regen' ? '/min' : '')} ${labelFor(k)}`;
}

function summarizeBonuses(b) {
  const parts = [];
  for (const [k, v] of Object.entries(b || {})) {
    const n = Number(v || 0); if (!n) continue;
    const s = fmtPair(k, n); if (s) parts.push(s);
  }
  return parts.join(', ');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function ensurePanelRoot() {
  let el = document.getElementById('accessory-panel');
  if (!el) {
    const host = document.getElementById('mothership-upgrades')
      || document.getElementById('wallet-jets')
      || document.body;
    el = document.createElement('section');
    el.id = 'accessory-panel';
    el.className = 'box col';
    el.style.marginTop = '6px';
    el.innerHTML = `<h4>Accessories</h4>
      <div id="accessory-list" class="tiny">Scanning…</div>
      <div class="tiny" id="accessory-totals" style="margin-top:4px">—</div>`;
    if (host.parentElement && host !== document.body) host.parentElement.insertBefore(el, host.nextSibling);
    else host.appendChild(el);
  }
  return el;
}

function renderAccessoryPanel(payload) {
  const root = ensurePanelRoot();
  const listEl = root.querySelector('#accessory-list');
  const totalsEl = root.querySelector('#accessory-totals');

  const items = payload.items || [];
  const b = payload.bonuses || emptyBonuses();
  const active = payload.activeCollections || [];

  const rows = [];

  // Crew rows (REGISTRY ONLY)
  for (const c of active) {
    const img = c.logo || '';
    const name = c.name || 'Crew';
    const sub = summarizeBonuses(c.bonuses || {});
    const text = `${escapeHtml(name)}${sub ? ': ' + escapeHtml(sub) : ''}`;
    const icon = img
      ? `<img src="${img}" alt="" style="width:66px;height:66px;object-fit:contain;image-rendering:pixelated;margin-right:8px;border-radius:8px;border:1px solid #2a3550;background:#0f1729">`
      : '';
    rows.push(`<div style="display:flex;align-items:center;margin:2px 0">${icon}<span>${text}</span></div>`);
  }

  // Gear rows (no registry / direct stat NFTs)
  const gearOnly = items.filter(it => !it.sourceId);
  for (const it of gearOnly) {
    const tag = labelFor(it.stat);
    const name = (it.collection?.name ? `${it.collection.name}` : (it.name || 'Upgrade'));
    const img = it.image || it.logo || '';
    const icon = img
      ? `<img src="${img}" alt="" style="width:66px;height:66px;object-fit:contain;image-rendering:pixelated;margin-right:8px;border-radius:8px;border:1px solid #2a3550;background:#0f1729">`
      : '';
    const line = `${escapeHtml(name)}: +${Number(it.bonus || 0)} ${tag}`;
    rows.push(`<div style="display:flex;align-items:center;margin:2px 0">${icon}<span>${line}</span></div>`);
  }

  listEl.innerHTML = rows.length ? rows.join('') : 'No accessories detected.';
  const totalLine = summarizeBonuses(b);
  totalsEl.textContent = totalLine
    ? `Passive bonuses → ${totalLine}`
    : 'Passive bonuses → —';
}

export function refreshAccessoryPanel(wallet) {
  const cached = wallet && CACHE.get(wallet);
  if (cached) renderAccessoryPanel(cached);
}

export async function initAccessoriesFlow() {
  if (window.__ACC_INIT) return;
  window.__ACC_INIT = true;

  await loadRegistry(true);

  const input = document.getElementById('xrpl-address');
  const getWallet = () => (input?.value || '').trim();

  async function scanAndRender(force = false) {
    const w = getWallet();
    if (!isClassic(w)) {
      ensurePanelRoot();
      renderAccessoryPanel({ items: [], bonuses: emptyBonuses(), activeCollections: [] });
      return;
    }
    const payload = await getAccessoryBonuses(w, { force });
    renderAccessoryPanel(payload);
    try {
      window.dispatchEvent(new CustomEvent('jets:accessories', { detail: payload }));
    } catch {}
  }

  ensurePanelRoot();
  setTimeout(() => scanAndRender(true), 200);

  if (input && !input.__accBound) {
    input.__accBound = true;
    input.addEventListener('change', () => scanAndRender(true));
    input.addEventListener('blur', () => scanAndRender(true));
    input.addEventListener('keyup', (e) => { if (e.key === 'Enter') scanAndRender(true); });
  }

  window.addEventListener('jets:auth', () => scanAndRender(true));
  setInterval(() => {
    const w = getWallet();
    if (isClassic(w)) {
      getAccessoryBonuses(w, { force: false }).then(renderAccessoryPanel);
    }
  }, 60000);
}

// === Also expose on window for non-module scripts ===
if (typeof window !== 'undefined') {
  window.ACCESSORY = ACCESSORY;
  window.getAccessoryBonuses = getAccessoryBonuses;
  window.applyAccessoryBonuses = applyAccessoryBonuses;
  window.refreshAccessoryPanel = refreshAccessoryPanel;
  window.initAccessoriesFlow = initAccessoriesFlow;
  window.clearAllCaches = clearAllCaches;
  window.forceReloadRegistry = forceReloadRegistry;

  // Debug tools
  window.__JETS_ACCESSORIES = {
    clearAllCaches,
    forceReloadRegistry,
    getRegistry: () => REGISTRY,
    getCache: () => ({ CACHE: Object.fromEntries(CACHE), META_CACHE: Object.fromEntries(META_CACHE) })
  };

  console.info('[Accessories] Module loaded (v2025-01-16). Debug tools at window.__JETS_ACCESSORIES');
}


