/* /jets/js/accessories.js — OG inline + Registry Crew (issuer-aware)
   v2025-11-12r3
   - Registry loaded from WP JSON (first) with cache bump
   - NEW: issuer/taxon matching from registry entries (exact Issuer match; optional NFTokenTaxon allowlist)
   - Keeps URL/text "match" fallback
   - Totals = registry sums + gear sums (unchanged)
*/

export const ACCESSORY = {
  STATS: { health:'health', energyCap:'energyCap', regen:'regen',
           attack:'attack', speed:'speed', defense:'defense',
           hit:'hit', crit:'crit', dodge:'dodge' }
};

const XRPL = window.xrpl;
const NET  = window.XRPL_NET || 'wss://xrplcluster.com';

const CACHE = new Map();
const META_CACHE = new Map();

const REG_URLS = [
  '/jets/registry.json?v=2025-11-13r1',
  'https://mykeygo.io/jets/registry.json?v=2025-11-13r1',
  'https://www.mykeygo.io/jets/registry.json?v=2025-11-13r1'
];
const REG_TTL = 5 * 60 * 1000; // 5 minutes
let REGISTRY = null, REGISTRY_TS = 0;

function emptyBonuses(){ return { health:0, energyCap:0, regen:0, attack:0, speed:0, defense:0, hit:0, crit:0, dodge:0 }; }
function isClassic(a){ return /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(a||'')); }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
const uniqBy = (arr, keyFn) => { const s=new Set(), out=[]; for(const it of arr){ const k=keyFn(it); if(s.has(k)) continue; s.add(k); out.push(it);} return out; };

function hexToAscii(h){
  try{
    let hex = String(h||'').replace(/^0x/i,'').replace(/\s+/g,'');
    if (!hex || hex.length%2) return '';
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b=>parseInt(b,16)));
    return new TextDecoder().decode(bytes);
  }catch{ return ''; }
}

const IPFS_GW = [
  'https://ipfs.xrp.cafe/ipfs/','https://nftstorage.link/ipfs/','https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/','https://gateway.pinata.cloud/ipfs/','https://cf-ipfs.com/ipfs/'
];
function ipfsCandidates(uri){ const id=String(uri||'').replace(/^ipfs:\/\//,'').replace(/^ipfs\//,''); return IPFS_GW.map(g => g + id); }
function candidatesFor(uri){ if(!uri) return []; const s=String(uri); return (s.startsWith('ipfs://')||s.startsWith('ipfs/'))? ipfsCandidates(s) : [s]; }
async function fetchWithFallback(urls){
  let last;
  for (const u of urls){
    try{ const r=await fetch(u,{mode:'cors'}); if(r.ok) return await r.json(); last=new Error('HTTP '+r.status); }
    catch(e){ last=e; }
  }
  throw last || new Error('fetch failed');
}
async function fetchMeta(uri){
  const key=String(uri||''); if(!key) return null;
  if (META_CACHE.has(key)) return META_CACHE.get(key);
  try { const j = await fetchWithFallback(candidatesFor(key)); META_CACHE.set(key, j||null); return j||null; }
  catch { META_CACHE.set(key, null); return null; }
}

async function loadRegistry(force=false){
  const now=Date.now();
  if (!force && REGISTRY && (now-REGISTRY_TS)<REG_TTL) return REGISTRY;
  let lastErr;
  for (const url of REG_URLS){
    try{
      const r=await fetch(url,{mode:'cors',cache:'no-store'});
      if (r.ok){ REGISTRY=await r.json(); REGISTRY_TS=now; console.info('[Accessories] Registry loaded:',url); return REGISTRY; }
      lastErr=new Error('http_'+r.status);
    }catch(e){ lastErr=e; }
  }
  console.warn('[Accessories] Registry unavailable, using embedded fallback.', lastErr?.message||lastErr);
  REGISTRY = {
    version:'embedded-fallback',
    rules:{ evaluation:'presencePerCollection_bestOfInside_sumAcrossCollections',
      globalCaps:{ attack:999,speed:999,defense:999,health:9999,energyCap:9999,regen:999,hit:100,crit:100,dodge:100 } },
    collections:[{
      id:'fuzzy-bears', name:'Fuzzy Bears', type:'crew',
      logo:'https://mykeygo.io/jets/asset/fuzzybearlogo.webp',
      match:['xrp.cafe/collection/fuzzybears','fuzzy bear','fuzzybears'],
      bonuses:{ attack:10, speed:10, defense:10 }, stacking:'presence'
    }]
  };
  REGISTRY_TS=now; return REGISTRY;
}

function matchesAny(haystack, needles){
  const hay=String(haystack||'').toLowerCase();
  return (needles||[]).some(nx => hay.includes(String(nx||'').toLowerCase()));
}
function metaHay(meta, uri, nft){
  return [
    meta?.collection?.name, meta?.collection, meta?.name, meta?.series,
    meta?.external_url, meta?.website, meta?.description,
    meta?.image, meta?.animation_url, uri,
    nft?.Issuer, nft?.NFTokenTaxon
  ].filter(Boolean).join(' | ');
}

async function listAllNFTs(account){
  const client=new XRPL.Client(NET); await client.connect();
  const out=[]; let marker=null;
  try{
    do{
      const req={command:'account_nfts',account,limit:400}; if(marker) req.marker=marker;
      const res=await client.request(req);
      out.push(...(res.result?.account_nfts||[]));
      marker=res.result?.marker;
    }while(marker);
  } finally { try{ await client.disconnect(); }catch{} }
  return out;
}

/* --- Upgrade parser for in-game gear (unchanged semantics) --- */
async function parseGearFromMeta(nft){
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex||'');
  if (!uri) return null;

  const j = await fetchMeta(uri); if (!j) return null;

  let stat  = (j.stat || '').toString().trim().toLowerCase();
  let bonus = Number(j.bonus);
  const props = j.properties || {};
  if (!stat && props.stat != null)  stat  = String(props.stat).toLowerCase();
  if (!Number.isFinite(bonus) && props.bonus != null) bonus = Number(props.bonus);

  if ((!stat || !Number.isFinite(bonus)) && Array.isArray(j.attributes)) {
    for (const a of j.attributes) {
      const k = String(a.trait_type || a.type || '').toLowerCase();
      const v = a.value;
      if (!stat && k==='stat' && v!=null)  stat  = String(v).toLowerCase();
      if (!Number.isFinite(bonus) && k==='bonus' && v!=null) bonus = Number(v);
    }
  }

  const needFallback = (!ACCESSORY.STATS[stat]) || !Number.isFinite(bonus);
  if (needFallback) {
    let kind = '';
    const atts = Object.create(null);

    if (Array.isArray(j.attributes)) {
      for (const a of j.attributes) {
        const k = String(a?.trait_type ?? a?.type ?? '').toLowerCase();
        atts[k] = a?.value;
      }
      if (typeof atts['kind'] === 'string') kind = String(atts['kind']).toLowerCase().trim();
    }

    const nums = {
      attack : Number(atts['attack']  ?? NaN),
      defense: Number(atts['defense'] ?? NaN),
      speed  : Number(atts['speed']   ?? NaN)
    };

    const CANDS = ['attack','defense','speed'];
    let chosen = '';
    if (kind && CANDS.includes(kind) && Number.isFinite(nums[kind]) && nums[kind] > 0) {
      chosen = kind;
    } else {
      for (const k of CANDS) {
        if (Number.isFinite(nums[k]) && nums[k] > 0) { chosen = k; break; }
      }
    }
    if (!ACCESSORY.STATS[chosen]) return null;

    stat  = chosen;
    bonus = Number(nums[chosen] || 0);
    if (!Number.isFinite(bonus) || bonus === 0) return null;
  }

  const collName = j.collection?.name || j.collection || null;
  const img = (()=> {
    const u = j.image || j.image_url || props.image || '';
    const urls = candidatesFor(u);
    return urls.length ? urls[0] : '';
  })();

  return {
    id: nft.NFTokenID,
    name: j.name || props.name || 'Upgrade',
    stat, bonus: Number(bonus),
    image: img,
    collection: collName ? { id: collName.toLowerCase(), name: collName } : null,
    logo: img
  };
}

/* --- Registry detection: now issuer/taxon aware --- */
function nftMatchesRegistryCollection(nft, coll, hay) {
  // 1) Issuer hard match (fast path)
  const issuer = String(coll?.issuer || '').trim();
  if (issuer && String(nft?.Issuer).trim() === issuer) {
    // If taxons are supplied, require one to match
    const txs = Array.isArray(coll?.taxons) ? coll.taxons.map(Number).filter(Number.isFinite) : null;
    if (txs && txs.length > 0) {
      return txs.includes(Number(nft?.NFTokenTaxon || NaN));
    }
    return true;
  }
  // 2) Fallback to match strings (URLs/keywords)
  if (Array.isArray(coll?.match) && coll.match.length) {
    return matchesAny(hay, coll.match);
  }
  return false;
}

async function detectRegistryItems(nft){
  const items=[];
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex||'');
  if (!REGISTRY) await loadRegistry(false);
  if (!REGISTRY?.collections) return items;

  const meta = uri ? await fetchMeta(uri) : null;
  const hay  = metaHay(meta, uri, nft);

  for (const coll of REGISTRY.collections) {
    if (!coll?.bonuses) continue;
    if (!nftMatchesRegistryCollection(nft, coll, hay)) continue;

    for (const [k,v] of Object.entries(coll.bonuses||{})) {
      if (!ACCESSORY.STATS[k]) continue;
      items.push({
        id:`${coll.id}_${k}`, name: coll.name || 'Crew',
        stat:k, bonus:Number(v||0),
        image: coll.logo || '', logo: coll.logo || '',
        collection:{ id:coll.id, name:coll.name || 'Crew' },
        sourceId: coll.id
      });
    }
  }
  return items;
}

/* --- Aggregation paths: registry (crew) vs gear (upgrades) --- */
function aggregateRegistry(items){
  const zero = emptyBonuses();
  const byColl = new Map(); // key -> { bonuses, logo, name, id }

  for (const it of items.filter(x => !!x.sourceId)) {
    const key = String(it.collection?.id || it.sourceId).toLowerCase();
    if (!key) continue;
    const rec = byColl.get(key) || { bonuses: { ...zero }, logo: it.logo || it.image || '', name: it.collection?.name || it.name || 'Crew', id:key };
    const statKey = (it.stat || '').toLowerCase();
    if (!ACCESSORY.STATS[statKey]) { byColl.set(key, rec); continue; }
    const val = Number(it.bonus || 0);
    const cur = Number(rec.bonuses[statKey] || 0);
    // best-of per stat within a collection
    rec.bonuses[statKey] = (val < 0) ? Math.min(cur, val) : Math.max(cur, val);
    if (!rec.logo && (it.logo || it.image)) rec.logo = it.logo || it.image;
    byColl.set(key, rec);
  }

  const registryTotals = { ...zero };
  for (const { bonuses } of byColl.values()) {
    for (const k of Object.keys(registryTotals)) registryTotals[k] += Number(bonuses[k] || 0); // sum across collections
  }
  return { registryTotals, activeCollections: Array.from(byColl.values()) };
}

function sumGearBonuses(items){
  const out = emptyBonuses();
  for (const it of items.filter(x => !x.sourceId)) {
    const k = (it.stat||'').toLowerCase();
    if (!ACCESSORY.STATS[k]) continue;
    out[k] += Number(it.bonus||0); // upgrades stack additively
  }
  return out;
}

function addBonuses(a,b){
  const out = { ...emptyBonuses() };
  for (const k of Object.keys(out)) out[k] = Number(a[k]||0) + Number(b[k]||0);
  return out;
}

export async function getAccessoryBonuses(wallet, { force=false } = {}){
  if (!isClassic(wallet)) return { ts: Date.now(), bonuses: emptyBonuses(), items: [], activeCollections: [] };

  const now = Date.now();
  const cached = CACHE.get(wallet);
  if (cached && !force && (now - cached.ts < 60_000)) return cached;

  await loadRegistry(false);

  try {
    const nfts = await listAllNFTs(wallet);
    const gearRaw = (await Promise.all(nfts.map(parseGearFromMeta))).filter(Boolean);
    const regRaw  = (await Promise.all(nfts.map(detectRegistryItems))).flat();

    const gear = uniqBy(gearRaw, it => `${it.id}:${it.stat}:${it.bonus}`);
    const regPresents = uniqBy(regRaw, it => `${it.sourceId}:${it.stat}`);
    const parsed = [...gear, ...regPresents];

    const { registryTotals, activeCollections } = aggregateRegistry(parsed);
    const gearTotals = sumGearBonuses(parsed);

    // Totals = registry + gear, then cap
    const caps = REGISTRY?.rules?.globalCaps || {};
    const totalsPreCap = addBonuses(registryTotals, gearTotals);
    for (const [k, cap] of Object.entries(caps)) {
      totalsPreCap[k] = clamp(Number(totalsPreCap[k]||0), -999999, cap);
    }

    const payload = { ts: now, bonuses: totalsPreCap, items: parsed, activeCollections };
    CACHE.set(wallet, payload);
    return payload;
  } catch {
    const payload = { ts: now, bonuses: emptyBonuses(), items: [], activeCollections: [] };
    CACHE.set(wallet, payload);
    return payload;
  }
}

export function applyAccessoryBonuses(base, wallet){
  const b = (wallet && CACHE.get(wallet)?.bonuses) || emptyBonuses();
  const out = { ...base };
  if (Number.isFinite(out.health))      out.health      += b.health;
  if (Number.isFinite(out.energyCap))   out.energyCap   += b.energyCap;
  if (Number.isFinite(out.regenPerMin)) out.regenPerMin += b.regen;
  if (Number.isFinite(out.attack))      out.attack      += b.attack;
  if (Number.isFinite(out.speed))       out.speed       += b.speed;
  if (Number.isFinite(out.defense))     out.defense     += b.defense;
  if (Number.isFinite(out.hit))         out.hit         += b.hit;
  if (Number.isFinite(out.crit))        out.crit        += b.crit;
  if (Number.isFinite(out.dodge))       out.dodge       += b.dodge;
  return out;
}

/* ---------- UI (unchanged layout; 66×66 icons) ---------- */
function labelFor(k){
  return { health:'HP', energyCap:'ENERGY', regen:'REGEN',
           attack:'ATK', speed:'SPD', defense:'DEF',
           hit:'HIT%', crit:'CRIT%', dodge:'DODGE%' }[k] || k.toUpperCase();
}
function fmtPair(k, v){
  if (!v) return null;
  const isPct = (k==='hit' || k==='crit' || k==='dodge');
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v}${isPct ? '%' : (k==='regen' ? '/min' : '')} ${labelFor(k)}`;
}
function summarizeBonuses(b){
  const parts = [];
  for (const [k,v] of Object.entries(b||{})) {
    const n = Number(v||0); if (!n) continue;
    const s = fmtPair(k, n); if (s) parts.push(s);
  }
  return parts.join(', ');
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function ensurePanelRoot(){
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

function renderAccessoryPanel(payload){
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
    const sub  = summarizeBonuses(c.bonuses || {});
    const text = `${escapeHtml(name)}${sub ? ': ' + escapeHtml(sub) : ''}`;
    const icon = img ? `<img src="${img}" alt="" style="width:66px;height:66px;object-fit:contain;image-rendering:pixelated;margin-right:8px;border-radius:8px;border:1px solid #2a3550;background:#0f1729">` : '';
    rows.push(`<div style="display:flex;align-items:center;margin:2px 0">${icon}<span>${text}</span></div>`);
  }

  // Gear rows (no registry)
  const gearOnly = items.filter(it => !it.sourceId);
  for (const it of gearOnly) {
    const tag = labelFor(it.stat);
    const name = (it.collection?.name ? `${it.collection.name}` : (it.name || 'Upgrade'));
    const img  = it.image || it.logo || '';
    const icon = img ? `<img src="${img}" alt="" style="width:66px;height:66px;object-fit:contain;image-rendering:pixelated;margin-right:8px;border-radius:8px;border:1px solid #2a3550;background:#0f1729">` : '';
    const line = `${escapeHtml(name)}: +${Number(it.bonus||0)} ${tag}`;
    rows.push(`<div style="display:flex;align-items:center;margin:2px 0">${icon}<span>${line}</span></div>`);
  }

  listEl.innerHTML = rows.length ? rows.join('') : 'No accessories detected.';
  const totalLine = summarizeBonuses(b);
  totalsEl.textContent = totalLine ? `Passive bonuses → ${totalLine}` : 'Passive bonuses → —';
}

export function refreshAccessoryPanel(wallet){
  const cached = wallet && CACHE.get(wallet);
  if (cached) renderAccessoryPanel(cached);
}

export async function initAccessoriesFlow(){
  if (window.__ACC_INIT) return;
  window.__ACC_INIT = true;

  await loadRegistry(false);

  const input = document.getElementById('xrpl-address');
  const getWallet = () => (input?.value||'').trim();

  async function scanAndRender(force=false){
    const w = getWallet();
    if (!isClassic(w)) { ensurePanelRoot(); renderAccessoryPanel({ items:[], bonuses:emptyBonuses(), activeCollections:[] }); return; }
    const payload = await getAccessoryBonuses(w, { force });
    renderAccessoryPanel(payload);
    try { window.dispatchEvent(new CustomEvent('jets:accessories', { detail: payload })); } catch {}
  }

  ensurePanelRoot();
  setTimeout(() => scanAndRender(true), 200);

  if (input && !input.__accBound) {
    input.__accBound = true;
    input.addEventListener('change', () => scanAndRender(true));
    input.addEventListener('blur',   () => scanAndRender(true));
    input.addEventListener('keyup',  (e)=>{ if (e.key==='Enter') scanAndRender(true); });
  }

  window.addEventListener('jets:auth', () => scanAndRender(true));
  setInterval(() => {
    const w = getWallet();
    if (isClassic(w)) getAccessoryBonuses(w, { force:false }).then(renderAccessoryPanel);
  }, 60000);
}
