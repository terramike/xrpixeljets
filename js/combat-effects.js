/* /jets/js/combat-effects.js — Combat NFT effects reader (Damage Shield + hooks)
   v2025-11-20fx1

   - Scans XLS-20 NFTs for a dedicated "Combat Upgrade" taxon
   - Reads metadata:
       properties.issuer == COMBAT_ISSUER
       properties.game.category == "combat"
       properties.game.taxon == COMBAT_TAXON
       attributes:
         Type  = "Combat Upgrade"
         Effect = "Damage Shield" | "Bonus Attack"
         Damage Shield Per Hit   (number)
         Bonus Attacks Per Turn  (number)
   - Aggregates into:
       { damageShieldPerHit, bonusAttacksPerTurn }
   - Safe defaults: if no combat NFTs => {0,0}
*/

const XRPL = window.xrpl;
const NET  = window.XRPL_NET || 'wss://xrplcluster.com';

// Canonical combat issuer / taxon (overrideable via window.COMBAT_*)
const COMBAT_ISSUER = window.COMBAT_ISSUER
  || 'rfYZ17wwhA4Be23fw8zthVmQQnrcdDRi52'; // Upgrades issuer
const COMBAT_TAXON  = Number(
  window.COMBAT_TAXON != null ? window.COMBAT_TAXON : 777
);

// Soft caps so a whale stack doesn’t break the game
const MAX_DAMAGE_SHIELD_PER_HIT   = 10;
const MAX_BONUS_ATTACKS_PER_TURN  = 2;

// Caches
const CACHE = new Map();      // wallet -> { ts, effects }
const META_CACHE = new Map(); // uri -> json|null

// IPFS gateways (aligned with other game modules)
const IPFS_GATEWAYS = [
  'https://ipfs.xrp.cafe/ipfs/',
  'https://nftstorage.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://cf-ipfs.com/ipfs/'
];

function isClassic(a){
  return /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(String(a || ''));
}

function clamp(n, lo, hi){
  n = Number(n) || 0;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function hexToUtf8(hex){
  try {
    let h = String(hex || '').replace(/^0x/i,'').replace(/\s+/g,'');
    if (!h || h.length % 2) return '';
    const bytes = new Uint8Array(h.match(/.{2}/g).map(b => parseInt(b, 16)));
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

function ipfsCandidates(uri){
  const raw = String(uri || '')
    .replace(/^ipfs:\/\//, '')
    .replace(/^ipfs\//, '');
  return IPFS_GATEWAYS.map(g => g + raw);
}

function uriCandidates(uri){
  const s = String(uri || '').trim();
  if (!s) return [];
  if (s.startsWith('ipfs://') || s.startsWith('ipfs/')) {
    return ipfsCandidates(s);
  }
  return [s];
}

async function fetchWithFallback(urls){
  let lastErr;
  for (const u of urls){
    try{
      const res = await fetch(u, { mode:'cors' });
      if (res.ok) {
        return await res.json();
      }
      lastErr = new Error('HTTP ' + res.status);
    } catch(e){
      lastErr = e;
    }
  }
  throw (lastErr || new Error('meta fetch failed'));
}

async function fetchMeta(uri){
  const key = String(uri || '');
  if (!key) return null;
  if (META_CACHE.has(key)) return META_CACHE.get(key);

  try{
    const json = await fetchWithFallback(uriCandidates(key));
    META_CACHE.set(key, json || null);
    return json || null;
  } catch {
    META_CACHE.set(key, null);
    return null;
  }
}

// Fallback account_nfts scanner if XRPLWallet.debugListNFTs is missing
async function listAllNFTsDirect(account){
  if (!XRPL || !XRPL.Client) throw new Error('xrpl.js client missing');
  const client = new XRPL.Client(NET);
  await client.connect();
  const out = [];
  let marker = null;
  try{
    do{
      const req = { command:'account_nfts', account, limit:400 };
      if (marker) req.marker = marker;
      const res = await client.request(req);
      out.push(...(res.result?.account_nfts || []));
      marker = res.result?.marker;
    } while (marker);
  } finally {
    try { await client.disconnect(); } catch {}
  }
  return out;
}

// Extracts combat effects from NFT metadata JSON, or null if not a combat upgrade
function extractCombatEffectFromMeta(meta){
  try{
    if (!meta || typeof meta !== 'object') return null;

    const props = meta.properties || {};
    const issuer = props.issuer || props.Issuer || props.ISSUER || '';
    const game = props.game || {};
    const category = String(game.category || game.Category || '').toLowerCase();
    const taxon = game.taxon ?? game.NFTokenTaxon ?? game.taxon_id;

    if (COMBAT_ISSUER && issuer && issuer !== COMBAT_ISSUER) return null;
    if (Number.isFinite(COMBAT_TAXON) && COMBAT_TAXON > 0) {
      if (Number(taxon) !== COMBAT_TAXON) return null;
    }
    if (category && category !== 'combat') return null;

    const attrs = Array.isArray(meta.attributes) ? meta.attributes : [];
    let type = '';
    let effect = '';
    let shield = 0;
    let bonus = 0;

    for (const a of attrs){
      const key = String(a.trait_type || a.type || '').toLowerCase();
      const val = a.value;

      if (key === 'type' && val != null) {
        type = String(val).toLowerCase();
      } else if (key === 'effect' && val != null) {
        effect = String(val).toLowerCase();
      } else if (key === 'damage shield per hit' && val != null) {
        const n = Number(val);
        if (Number.isFinite(n)) shield += n;
      } else if (key === 'bonus attacks per turn' && val != null) {
        const n = Number(val);
        if (Number.isFinite(n)) bonus += n;
      }
    }

    // Require this to be explicitly flagged as a Combat Upgrade
    if (type && type !== 'combat upgrade') return null;

    const out = {
      damageShieldPerHit: 0,
      bonusAttacksPerTurn: 0
    };

    if (!effect || effect === 'damage shield') {
      if (shield > 0) out.damageShieldPerHit = shield;
    }
    if (!effect || effect === 'bonus attack' || effect === 'bonus attacks') {
      if (bonus > 0) out.bonusAttacksPerTurn = bonus;
    }

    if (out.damageShieldPerHit === 0 && out.bonusAttacksPerTurn === 0) {
      return null;
    }
    return out;
  } catch {
    return null;
  }
}

// Merge + cap effects from multiple NFTs
function accumulateEffects(total, eff){
  if (!eff) return total;
  total.damageShieldPerHit  += Number(eff.damageShieldPerHit  || 0);
  total.bonusAttacksPerTurn += Number(eff.bonusAttacksPerTurn || 0);
  return total;
}

/**
 * Async loader: Scan wallet NFTs and return combat effects.
 *
 * @param {string} wallet - classic r-address
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - bypass 60s cache
 * @returns {Promise<{damageShieldPerHit:number, bonusAttacksPerTurn:number}>}
 */
export async function getCombatEffectsForWallet(wallet, { force = false } = {}){
  if (!isClassic(wallet)) {
    return { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
  }

  const now = Date.now();
  const cached = CACHE.get(wallet);
  if (cached && !force && (now - cached.ts) < 60_000) {
    return { ...cached.effects };
  }

  let nfts = [];
  try{
    const dbg = window.XRPLWallet && window.XRPLWallet.debugListNFTs;
    if (typeof dbg === 'function') {
      nfts = await dbg(wallet);
    } else {
      nfts = await listAllNFTsDirect(wallet);
    }
  } catch (e){
    console.error('[CombatFX] account_nfts failed for', wallet, e);
    return { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
  }

  const effects = { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };

  for (const nft of nfts){
    const issuer = nft.Issuer || nft.issuer || '';
    const taxon  = nft.NFTokenTaxon ?? nft.nft_taxon ?? nft.Taxon;
    if (COMBAT_ISSUER && issuer && issuer !== COMBAT_ISSUER) continue;
    if (Number.isFinite(COMBAT_TAXON) && COMBAT_TAXON > 0) {
      if (Number(taxon) !== COMBAT_TAXON) continue;
    }

    const uriHex = nft.URI || nft.Uri || nft.NFTokenURI || nft.nft_uri;
    if (!uriHex) continue;

    const uriStr = (typeof uriHex === 'string' && uriHex.startsWith('http'))
      ? uriHex
      : hexToUtf8(uriHex);

    if (!uriStr) continue;

    const meta = await fetchMeta(uriStr);
    const eff = extractCombatEffectFromMeta(meta);
    if (!eff) continue;

    accumulateEffects(effects, eff);
  }

  // Clamp to safe caps
  effects.damageShieldPerHit  = clamp(effects.damageShieldPerHit,  0, MAX_DAMAGE_SHIELD_PER_HIT);
  effects.bonusAttacksPerTurn = clamp(effects.bonusAttacksPerTurn, 0, MAX_BONUS_ATTACKS_PER_TURN);

  const payload = { ts: now, effects };
  CACHE.set(wallet, payload);

  console.log('[CombatFX] effects for', wallet, effects);
  return { ...effects };
}

/**
 * Snapshot helper: returns cached effects if present, otherwise zeros.
 * Does NOT hit XRPL or fetch metadata.
 */
export function getCombatEffectsSnapshot(wallet){
  if (!isClassic(wallet)) {
    return { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
  }
  const cached = CACHE.get(wallet);
  if (!cached) return { damageShieldPerHit: 0, bonusAttacksPerTurn: 0 };
  return { ...cached.effects };
}

// Optional: mount a tiny debug helper on window for console testing
(function exposeDebug(){
  const g = (typeof window !== 'undefined') ? window : {};
  g.JETS_COMBATFX = g.JETS_COMBATFX || {};
  g.JETS_COMBATFX.get = getCombatEffectsForWallet;
  g.JETS_COMBATFX.peek = getCombatEffectsSnapshot;
  g.JETS_COMBATFX.__issuer = COMBAT_ISSUER;
  g.JETS_COMBATFX.__taxon  = COMBAT_TAXON;
})();
