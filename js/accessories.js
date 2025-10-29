// /jets/js/accessories.js — XRPixel Jet Upgrades (metadata-driven detection)
// v2025-10-28c — relax issuer/taxon filter, add ipfs.xrp.cafe gateway, xrp.cafe "attributes" & "properties" support

export const ACCESSORY = {
  COLLECTION_NAME: 'XRPixel Jets Upgrades',    // optional check
  // issuer/taxon no longer hard-required; we detect by metadata (stat+bonus).
  STATS: {
    health:'health', energyCap:'energyCap', regen:'regen',
    attack:'attack', speed:'speed', defense:'defense',
    hit:'hit', crit:'crit', dodge:'dodge'
  }
};

const XRPL = window.xrpl;
const NET  = window.XRPL_NET || 'wss://xrplcluster.com';

// Multiple gateways incl. xrp.cafe
const IPFS_GATEWAYS = [
  'https://ipfs.xrp.cafe/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://cf-ipfs.com/ipfs/'
];

const CACHE = new Map(); // wallet -> { ts, bonuses, items }

function emptyBonuses(){
  return { health:0, energyCap:0, regen:0, attack:0, speed:0, defense:0, hit:0, crit:0, dodge:0 };
}
function isClassic(a){ return /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(a||'')); }

function hexToAscii(h){
  try{
    let hex = String(h||'').replace(/^0x/i,'').replace(/\s+/g,'');
    if (!hex || hex.length%2) return '';
    const bytes = new Uint8Array(hex.match(/.{2}/g).map(b=>parseInt(b,16)));
    return new TextDecoder().decode(bytes);
  }catch{ return ''; }
}
function ipfsCandidates(uri){
  const id = String(uri||'').replace(/^ipfs:\/\//,'').replace(/^ipfs\//,'');
  return IPFS_GATEWAYS.map(g => g + id);
}
function candidatesFor(uri){
  if (!uri) return [];
  return String(uri).startsWith('ipfs://') || String(uri).startsWith('ipfs/')
    ? ipfsCandidates(uri)
    : [uri];
}
async function fetchWithFallback(urls){
  let last;
  for (const u of urls){
    try{
      const r = await fetch(u, { mode:'cors' });
      if (r.ok) return await r.json();
      last = new Error('HTTP '+r.status);
    }catch(e){ last = e; }
  }
  throw last || new Error('fetch failed');
}

async function listAllNFTs(account){
  const client = new XRPL.Client(NET);
  await client.connect();
  const out=[]; let marker=null;
  try{
    do{
      const req={ command:'account_nfts', account, limit:400 };
      if (marker) req.marker=marker;
      const res=await client.request(req);
      out.push(...(res.result?.account_nfts||[]));
      marker=res.result?.marker;
    }while(marker);
  } finally { try{ await client.disconnect(); }catch{} }
  return out;
}

// ---- parse accessory metadata { stat, bonus, name, image, collection } ----
async function parseAccessory(nft){
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex||'');
  if (!uri) return null;

  // Resolve metadata (with gateway fallbacks)
  let j=null;
  try { j = await fetchWithFallback(candidatesFor(uri)); } catch { return null; }
  if (!j) return null;

  // Collection name (optional)
  const collName = j.collection?.name || j.collection || null;

  // Extract stat / bonus from: top-level, properties, or attributes[]
  let stat  = (j.stat || '').toString().trim().toLowerCase();
  let bonus = Number(j.bonus);

  const props = j.properties || {};
  if (!stat && props.stat != null)  stat  = String(props.stat).toLowerCase();
  if (!Number.isFinite(bonus) && props.bonus != null) bonus = Number(props.bonus);

  if ((!stat || !Number.isFinite(bonus)) && Array.isArray(j.attributes)) {
    for (const a of j.attributes) {
      const k = String(a.trait_type || a.type || '').toLowerCase();
      const v = a.value;
      if (!stat && k==='stat' && v!=null)  stat = String(v).toLowerCase();
      if (!Number.isFinite(bonus) && k==='bonus' && v!=null) bonus = Number(v);
    }
  }

  // Gate: require valid stat+bonus
  if (!ACCESSORY.STATS[stat] || !Number.isFinite(bonus)) return null;

  // Optional: prefer our collection if present, but don't require
  // if (collName && collName !== ACCESSORY.COLLECTION_NAME) return null;

  const name  = j.name || props.name || 'Upgrade';
  const image = (()=>{
    const img = j.image || j.image_url || props.image || '';
    const urls = candidatesFor(img);
    return urls.length ? urls[0] : '';
  })();

  return {
    id: nft.NFTokenID,
    name, stat, bonus: Number(bonus),
    image, collection: collName
  };
}

// ---- best-of per stat accumulator ----
function bestOf(items){
  const out = emptyBonuses();
  for (const it of items) {
    const key = ACCESSORY.STATS[it.stat];
    const val = Number(it.bonus||0);
    if (!key || !Number.isFinite(val)) continue;
    if (val > out[key]) out[key] = val;
  }
  return out;
}

// ---- public api ----
export async function getAccessoryBonuses(wallet, { force=false } = {}){
  if (!isClassic(wallet)) return { ts: Date.now(), bonuses: emptyBonuses(), items: [] };

  const now = Date.now();
  const cached = CACHE.get(wallet);
  if (cached && !force && (now - cached.ts < 60_000)) return cached;

  try {
    // Load EVERYTHING, then keep items whose metadata declares stat+bonus
    const nfts = await listAllNFTs(wallet);
    const parsed = (await Promise.all(nfts.map(parseAccessory))).filter(Boolean);

    // Optional: if you want to restrict to a collection name:
    // const filtered = parsed.filter(it => !it.collection || it.collection === ACCESSORY.COLLECTION_NAME);

    const bonuses = bestOf(parsed);
    const payload = { ts: now, bonuses, items: parsed };
    CACHE.set(wallet, payload);
    return payload;
  } catch {
    const payload = { ts: now, bonuses: emptyBonuses(), items: [] };
    CACHE.set(wallet, payload);
    return payload;
  }
}

// Apply bonuses to an existing stats object (non-destructive).
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

// ---- UI panel ----
function labelFor(k){
  return {
    health:'HP', energyCap:'ENERGY', regen:'REGEN',
    attack:'ATK', speed:'SPD', defense:'DEF',
    hit:'HIT%', crit:'CRIT%', dodge:'DODGE%'
  }[k] || k.toUpperCase();
}
function fmtBonus(k, v){
  if (!v) return null;
  const isPct = (k==='hit' || k==='crit' || k==='dodge');
  return `${labelFor(k)} +${v}${isPct ? '%' : (k==='regen' ? '/min' : '')}`;
}
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
    el.innerHTML = `<h4>Accessories</h4><div id="accessory-list" class="tiny">Scanning…</div><div class="tiny" id="accessory-totals" style="margin-top:4px">—</div>`;
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

  if (!items.length) {
    listEl.textContent = 'No accessories detected.';
  } else {
    listEl.innerHTML = items.map(it => {
      const tag = labelFor(it.stat);
      const img = it.image ? `<img src="${it.image}" alt="" style="width:66px;height:66px;object-fit:contain;image-rendering:pixelated;margin-right:8px;border-radius:8px;border:1px solid #2a3550;background:#0f1729">` : '';
      return `<div style="display:flex;align-items:center;margin:2px 0">${img}<span>${escapeHtml(it.name)} (+${it.bonus} ${tag})</span></div>`;
    }).join('');
  }

  const lines = Object.entries(b).map(([k,v]) => fmtBonus(k,v)).filter(Boolean);
  totalsEl.textContent = lines.length ? `Passive bonuses → ${lines.join(', ')}` : 'Passive bonuses → —';
}
function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

export function refreshAccessoryPanel(wallet){
  const cached = wallet && CACHE.get(wallet);
  if (cached) renderAccessoryPanel(cached);
}

// ---- Auto-init (guard) ----
async function initAccessoriesFlow(){
  if (window.__ACC_INIT) return;
  window.__ACC_INIT = true;

  const input = document.getElementById('xrpl-address');
  const getWallet = () => (input?.value||'').trim();

  async function scanAndRender(){
    const w = getWallet();
    if (!isClassic(w)) { ensurePanelRoot(); renderAccessoryPanel({ items:[], bonuses:emptyBonuses() }); return; }
    const payload = await getAccessoryBonuses(w, { force:true });
    renderAccessoryPanel(payload);
try { window.dispatchEvent(new CustomEvent('jets:accessories', { detail: payload })); } catch {}
  }

  ensurePanelRoot();
  setTimeout(scanAndRender, 200);

  if (input && !input.__accBound) {
    input.__accBound = true;
    input.addEventListener('change', scanAndRender);
    input.addEventListener('blur', scanAndRender);
    input.addEventListener('keyup', (e)=>{ if (e.key==='Enter') scanAndRender(); });
  }

  window.addEventListener('jets:auth', scanAndRender);

  setInterval(() => {
    const w = getWallet();
    if (isClassic(w)) getAccessoryBonuses(w, { force:false }).then(renderAccessoryPanel);
  }, 60000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccessoriesFlow, { once:true });
} else {
  initAccessoriesFlow();
}
