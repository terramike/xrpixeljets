// server/index.js — XRPixel Jets API (2025-01-09 NFT regen bonuses r1)
// Adds: Server-side NFT scanning for regen bonuses (offline regen now includes +regen NFTs)
// Fixes: hardened claims + daily cap; CORS; reduced DB churn on /profile creation.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import { decode, encodeForSigning } from 'ripple-binary-codec';
import { Client as XRPLClient, Wallet as XRPLWallet } from 'xrpl';
import { registerBazaarHotRoutes } from './bazaar-hot.js';
import { sendIssued } from './claimJetFuel.js';

const { Pool } = pkg;
const app = Fastify({ logger: true, ajv: { customOptions: { removeAdditional: false, useDefaults: true, coerceTypes: true, allErrors: false } } });

/* ============================ ENV / CONSTANTS ============================ */
const PORT = Number(process.env.PORT || 10000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ECON_SCALE_ENV    = Number(process.env.ECON_SCALE || 0.10);
const CLAIM_MAX_PER_24H = Number(process.env.CLAIM_MAX_PER_24H || 15000);
const BASE_PER_LEVEL    = Number(process.env.BASE_PER_LEVEL || 300);
const REGEN_STEP        = Number(process.env.REGEN_STEP || 0.1);

// Reward tuning
const REWARD_SCALE = Number.isFinite(Number(process.env.REWARD_SCALE))
  ? Number(process.env.REWARD_SCALE)
  : ECON_SCALE_ENV; // default to old behavior if not set
const REWARD_MAX   = Number(process.env.REWARD_MAX || 0); // optional hard cap per mission (0 = no cap)

// Claim fee (basis points: 100 = 1%, 1500 = 15%)
const CLAIM_FEE_BPS = Number(process.env.CLAIM_FEE_BPS || 0);

// NFT Bonus scanning config
const REGISTRY_URL = process.env.REGISTRY_URL || 'https://mykeygo.io/jets/asset/accessory-registry.json';
const NFT_BONUS_CACHE_SEC = Number(process.env.NFT_BONUS_CACHE_SEC || 300); // 5 min cache

/** XRPL */
const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const HOT_SEED = process.env.HOT_SEED || process.env.HOT_WALLET_SEED || '';
const HOT_ALGO = (process.env.HOT_ALGO || 'secp').toLowerCase(); // 'secp' | 'ed'
const algoOpt  = HOT_ALGO === 'ed' ? { algorithm: 'ed25519' } : { algorithm: 'secp256k1' };

const TOKEN_MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase(); // 'hot' | 'prepare' | 'mock'

/** JETS IOU settings */
const CURRENCY_CODE = process.env.CURRENCY_CODE || process.env.CURRENCY || 'JETS';
const CURRENCY_HEX  = process.env.CURRENCY_HEX || null;
const ISSUER_ADDR   = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || null;

const xrpl = {
  client: new XRPLClient(XRPL_WSS),
  wallet: HOT_SEED ? XRPLWallet.fromSeed(HOT_SEED, algoOpt) : null
};

const BAZAAR_ENABLED = (process.env.BAZAAR_ENABLED || 'true').toLowerCase() !== 'false';
const ADMIN_KEY      = process.env.ADMIN_KEY || '';

/* ============================== CORS / ERRORS ============================ */
await app.register(cors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, ALLOW.includes(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: '*',
  credentials: false,
  maxAge: 86400,
  strictPreflight: false
});

app.addHook('preHandler', async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
});

app.addHook('onSend', async (req, reply, payload) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
  return payload;
});

app.setErrorHandler((err, req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
  }
  const code = err.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
  req.log.error({ err }, 'request_error');
  reply.code(code).send({ error: 'internal_error' });
});

/* ================================== DB =================================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================================ UTILS ================================== */
const toInt  = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? Math.trunc(n) : d; };
const nowSec = () => Math.floor(Date.now() / 1000);
const asciiToHex = (s) => Buffer.from(String(s), 'utf8').toString('hex').toUpperCase();
const hexToAscii = (h) => { try { return Buffer.from(String(h), 'hex').toString('utf8'); } catch { return ''; } };

const isSecpPublicKeyHex    = (pk) => typeof pk === 'string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk);
const isEd25519PublicKeyHex = (pk) => typeof pk === 'string' && /^ED[0-9A-Fa-f]{64}$/.test(pk);

const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();

/* Routes allowed without X-Wallet */
const OPEN_ROUTES = [
  '/session/start',
  '/session/finish',
  '/session/verify',
  '/config',
  '/healthz',
  '/bazaar/skus',
  '/bazaar/hot/ping',
  '/bazaar/hot/check',
  '/bazaar/hot/live'
];

app.addHook('onRequest', async (req, reply) => {
  const url = (req.raw.url || '').split('?')[0];
  if (req.method === 'OPTIONS') return;
  if (OPEN_ROUTES.some(p => url === p || url.startsWith(p + '/'))) return;

  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;

  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  if (now - cur.ts > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1;
  bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) {
    return reply.code(429).send({ error: 'rate_limited' });
  }
});

/* ========================= NFT BONUS SCANNING ============================= */
// Server-side NFT scanning for regen bonuses (mirrors client accessories.js logic)

let REGISTRY = null;
let REGISTRY_TS = 0;
const BONUS_CACHE = new Map(); // wallet -> { ts, regenBonus }

const ACCESSORY_STATS = { attack:1, speed:1, defense:1, health:1, energyCap:1, regen:1, hit:1, crit:1, dodge:1 };

async function loadRegistry(force = false) {
  const now = Date.now();
  if (!force && REGISTRY && (now - REGISTRY_TS < 300_000)) return REGISTRY; // 5 min cache

  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    REGISTRY = await res.json();
    REGISTRY_TS = now;
    app.log.info('[NFT] Registry loaded:', REGISTRY?.version || 'unknown');
    return REGISTRY;
  } catch (e) {
    app.log.warn('[NFT] Registry fetch failed:', e.message);
    // Fallback embedded registry
    if (!REGISTRY) {
      REGISTRY = {
        version: 'embedded-fallback',
        rules: {
          evaluation: 'presencePerCollection_bestOfInside_sumAcrossCollections',
          globalCaps: { attack:999, speed:999, defense:999, health:9999, energyCap:9999, regen:999, hit:100, crit:100, dodge:100 }
        },
        collections: []
      };
      REGISTRY_TS = now;
    }
    return REGISTRY;
  }
}

async function fetchMeta(uri) {
  if (!uri) return null;
  try {
    // Handle IPFS
    let url = uri;
    if (uri.startsWith('ipfs://')) {
      url = 'https://ipfs.io/ipfs/' + uri.slice(7);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
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

function nftMatchesRegistryCollection(nft, coll, hay) {
  // 1) Issuer hard match (fast path)
  const issuer = String(coll?.issuer || '').trim();
  if (issuer && String(nft?.Issuer).trim() === issuer) {
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

// Parse gear NFT for regen bonus
async function parseGearRegen(nft) {
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex || '');
  if (!uri) return 0;

  const j = await fetchMeta(uri);
  if (!j) return 0;

  let stat = (j.stat || '').toString().trim().toLowerCase();
  let bonus = Number(j.bonus);
  const props = j.properties || {};

  if (!stat && props.stat != null) stat = String(props.stat).toLowerCase();
  if (!Number.isFinite(bonus) && props.bonus != null) bonus = Number(props.bonus);

  // Check attributes array
  if ((!stat || !Number.isFinite(bonus)) && Array.isArray(j.attributes)) {
    for (const a of j.attributes) {
      const k = String(a.trait_type || a.type || '').toLowerCase();
      const v = a.value;
      if (!stat && k === 'stat' && v != null) stat = String(v).toLowerCase();
      if (!Number.isFinite(bonus) && k === 'bonus' && v != null) bonus = Number(v);
    }
  }

  // Only care about regen stat
  if (stat === 'regen' && Number.isFinite(bonus) && bonus > 0) {
    return bonus;
  }
  return 0;
}

// Detect registry collection regen bonuses
async function detectRegistryRegen(nft) {
  const uriHex = nft.URI || nft.NFTokenURI || '';
  const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex || '');

  await loadRegistry(false);
  if (!REGISTRY?.collections) return 0;

  const meta = uri ? await fetchMeta(uri) : null;
  const hay = metaHay(meta, uri, nft);

  let totalRegen = 0;
  const seenColls = new Set();

  for (const coll of REGISTRY.collections) {
    if (!coll?.bonuses) continue;
    if (seenColls.has(coll.id)) continue; // Only count each collection once (presence-based)
    if (!nftMatchesRegistryCollection(nft, coll, hay)) continue;

    const regenVal = Number(coll.bonuses.regen || 0);
    if (regenVal > 0) {
      totalRegen += regenVal;
      seenColls.add(coll.id);
    }
  }

  return totalRegen;
}

// Main function: get total regen bonus for a wallet
async function getWalletRegenBonus(wallet) {
  if (!wallet || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(wallet)) return 0;

  const now = Date.now();
  const cached = BONUS_CACHE.get(wallet);
  if (cached && (now - cached.ts < NFT_BONUS_CACHE_SEC * 1000)) {
    return cached.regenBonus;
  }

  let totalRegen = 0;
  let client = null;

  try {
    client = new XRPLClient(XRPL_WSS);
    await client.connect();

    const nfts = [];
    let marker = null;

    do {
      const req = { command: 'account_nfts', account: wallet, limit: 400 };
      if (marker) req.marker = marker;
      const res = await client.request(req);
      nfts.push(...(res.result?.account_nfts || []));
      marker = res.result?.marker;
    } while (marker);

    // Process NFTs in parallel batches (limit concurrency)
    const BATCH_SIZE = 10;
    const seenCollections = new Set();

    for (let i = 0; i < nfts.length; i += BATCH_SIZE) {
      const batch = nfts.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (nft) => {
        // Gear-based regen (stacks additively)
        const gearRegen = await parseGearRegen(nft);

        // Registry-based regen (presence per collection)
        let registryRegen = 0;
        const uriHex = nft.URI || nft.NFTokenURI || '';
        const uri = /^[0-9A-Fa-f]+$/.test(String(uriHex)) ? hexToAscii(uriHex) : String(uriHex || '');
        await loadRegistry(false);

        if (REGISTRY?.collections) {
          const meta = uri ? await fetchMeta(uri) : null;
          const hay = metaHay(meta, uri, nft);

          for (const coll of REGISTRY.collections) {
            if (!coll?.bonuses || seenCollections.has(coll.id)) continue;
            if (!nftMatchesRegistryCollection(nft, coll, hay)) continue;

            const regenVal = Number(coll.bonuses.regen || 0);
            if (regenVal > 0) {
              registryRegen += regenVal;
              seenCollections.add(coll.id); // Only count collection once
            }
          }
        }

        return gearRegen + registryRegen;
      }));

      for (const r of results) {
        if (r.status === 'fulfilled') totalRegen += r.value;
      }
    }

    // Apply global cap
    const cap = REGISTRY?.rules?.globalCaps?.regen || 999;
    totalRegen = Math.min(totalRegen, cap);

  } catch (e) {
    app.log.warn('[NFT] getWalletRegenBonus failed for', wallet, e.message);
    totalRegen = 0;
  } finally {
    if (client) {
      try { await client.disconnect(); } catch {}
    }
  }

  // Cache the result
  BONUS_CACHE.set(wallet, { ts: now, regenBonus: totalRegen });
  app.log.info(`[NFT] Wallet ${wallet} regen bonus: +${totalRegen}`);

  return totalRegen;
}

/* ============================= PROFILES ============================= */
async function ensureProfile(wallet) {
  await pool.query(
    `insert into player_profiles (wallet)
     values ($1)
     on conflict (wallet) do nothing`,
    [wallet]
  );
}

async function getProfileRaw(wallet) {
  const { rows } = await pool.query(
`select wallet,
  coalesce(jet_fuel,0)::int      as jet_fuel,
  coalesce(energy,0)::int        as energy,
  coalesce(energy_cap,100)::int  as energy_cap,
  ms_base, ms_level, ms_current,
  coalesce(ms_hit,0)::int        as ms_hit,
  coalesce(ms_crit,10)::int      as ms_crit,
  coalesce(ms_dodge,0)::int      as ms_dodge,
  coalesce(unlocked_level,1)::int as unlocked_level,
  last_claim_at, updated_at, created_at
 from player_profiles
 where wallet=$1`,
    [wallet]
  );
  return rows[0] || null;
}

function recomputeCurrent(b, lv) {
  const base = b || { health: 20, energyCap: 100, regenPerMin: 1 };
  const L    = lv || { health: 0,  energyCap: 0,   regenPerMin: 0 };
  return {
    health:      (base.health     | 0) + (L.health     | 0),
    energyCap:   (base.energyCap  | 0) + (L.energyCap  | 0),
    regenPerMin: Number(base.regenPerMin || 0) + Number(L.regenPerMin || 0) * REGEN_STEP
  };
}

function toClient(row, nftRegenBonus = 0) {
  const cur = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  return {
    ms:   { base: row.ms_base, level: row.ms_level, current: cur },
    pct:  { hit: row.ms_hit | 0, crit: row.ms_crit | 0, dodge: row.ms_dodge | 0 },
    jetFuel:    row.jet_fuel    | 0,
    energy:     row.energy      | 0,
    energyCap:  row.energy_cap  | 0,
    unlockedLevel: row.unlocked_level | 0,
    // NEW: surface the NFT regen bonus so client can display it
    nftRegenBonus: nftRegenBonus | 0
  };
}

async function regenEnergyIfDue(wallet) {
  let row = await getProfileRaw(wallet);
  if (!row) return null;

  const cur = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  const cap = Number(cur.energyCap ?? row.energy_cap ?? 100) || 100;
  const baseRpm = Number(cur.regenPerMin || 0);

  // NEW: Fetch NFT regen bonus and add to base regen
  let nftRegenBonus = 0;
  try {
    nftRegenBonus = await getWalletRegenBonus(wallet);
  } catch (e) {
    app.log.warn('[NFT] Failed to get regen bonus for', wallet, e.message);
  }

  const totalRpm = baseRpm + nftRegenBonus;
  if (totalRpm <= 0) return row;

  const nowS  = nowSec();
  const lastS = row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : nowS;
  const deltaS = Math.max(0, nowS - lastS);

  // Regen calculation: (elapsed_seconds * regen_per_hour) / 3600
  const gain = Math.floor((deltaS * totalRpm) / 3600);
  if (gain <= 0) return row;

  const before = row.energy | 0;
  if (before >= cap) return row;

  const after = Math.min(cap, before + gain);
  if (after === before) return row;

  const { rows } = await pool.query(
    `update player_profiles
        set energy=$2,
            updated_at=now()
      where wallet=$1
      returning *`,
    [wallet, after]
  );

  app.log.info(`[Regen] ${wallet}: ${before} -> ${after} (+${gain}E, base=${baseRpm}/h, nft=+${nftRegenBonus}/h, elapsed=${deltaS}s)`);

  return rows[0] || row;
}

/* ============================== AUTH/JWT ============================== */
const NONCES = new Map();
const newNonce = () => crypto.randomBytes(32).toString('hex');
function storeNonce(address, nonce) {
  NONCES.set(address, { nonce, exp: Date.now() + 5 * 60_000, used: false });
}
function takeNonce(address) {
  const r = NONCES.get(address);
  if (!r) { return { err: 'expired_nonce' }; }
  NONCES.delete(address);
  if (r.used || Date.now() > r.exp) { return { err: 'expired_nonce' }; }
  r.used = true;
  return { ok: true, nonce: r.nonce };
}

function signJWT(address, scope = 'play,upgrade,claim,bazaar') {
  const now = nowSec();
  const exp = now + 60 * 60;
  return jwt.sign({ sub: address, scope, iat: now, exp }, JWT_SECRET, { algorithm: 'HS256' });
}
function requireJWT(req, reply) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
}

/* ================= XRPL helpers for WC tx-proof (secp only) ================ */
async function ensureXRPL() {
  if (!xrpl.wallet) throw new Error('hot_wallet_missing');
  if (!xrpl.client.isConnected()) await xrpl.client.connect();
}

/* ============================== /config =================================== */
app.get('/config', async (_req, reply) => {
  reply.send({
    tokenMode: TOKEN_MODE,
    network: XRPL_WSS,
    currencyCode: CURRENCY_CODE,
    currencyHex: CURRENCY_HEX,
    issuer: ISSUER_ADDR,
    // New: surface claim economics to the client
    claimFeeBps: CLAIM_FEE_BPS,        // e.g. 1500 = 15%
    claimMaxPer24h: CLAIM_MAX_PER_24H  // e.g. 15000 JetFuel/day
  });
});

/* ============================= session (JWT) =============================== */
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  await ensureProfile(address);
  const nonce = newNonce();
  storeNonce(address, nonce);
  reply.send({ nonce, payload: `XRPixelJets|${nonce}` });
});

async function verifyOrFinish(req, reply) {
  const {
    address,
    signature,
    publicKey,
    payloadHex,
    scope = 'play,upgrade,claim,bazaar',
    ts,
    txProof
  } = req.body || {};

  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }

  const taken = takeNonce(address);
  if (!taken.ok) return reply.code(400).send({ error: taken.err });

  const now  = nowSec();
  const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 300) {
    return reply.code(400).send({ error: 'expired_nonce' });
  }

  // WC AccountSet tx-proof path (secp)
  if (txProof && txProof.tx_blob) {
    try {
      const tx = decode(txProof.tx_blob);
      if (tx.TransactionType !== 'AccountSet') {
        return reply.code(400).send({ error: 'bad_tx_type' });
      }
      if (tx.Account !== address) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const pub = String(tx.SigningPubKey || '').toUpperCase();
      if (!(pub.startsWith('02') || pub.startsWith('03'))) {
        return reply.code(400).send({ error: 'bad_key_algo', detail: 'secp_required' });
      }

      const wantMemo = asciiToHex(`XRPixelJets|${taken.nonce}|${scope}|${tsNum}`);
      const memos = (tx.Memos || []).map(m => (m?.Memo?.MemoData || '').toUpperCase());
      if (!memos.includes(wantMemo)) {
        return reply.code(400).send({ error: 'memo_missing' });
      }

      const preimageHex = encodeForSigning(tx).toUpperCase();
      const sigHex      = String(tx.TxnSignature || '').toUpperCase();
      const ok = keypairs.verify(preimageHex, sigHex, pub) === true;
      if (!ok) return reply.code(401).send({ error: 'bad_signature' });

      const derived = keypairs.deriveAddress(pub);
      if (derived !== address) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      return reply.send({ ok: true, jwt: signJWT(address, scope) });
    } catch {
      return reply.code(400).send({ error: 'bad_tx_proof' });
    }
  }

  // GEM WALLET: Now uses txProof path (lines 330-363)
  // This custom detection is DISABLED to avoid conflicts with Crossmark
  // Both Crossmark and Gem can have ~140 char signatures!
  const isLikelyGemWallet = false; // DISABLED - Gem uses txProof now
  
  if (isLikelyGemWallet) {
    
    try {
      const pub = String(publicKey || '').toUpperCase();
      if (!(pub.startsWith('02') || pub.startsWith('03'))) {
        return reply.code(400).send({ error: 'bad_key_algo', detail: 'secp_required' });
      }
      
      // Expected message format: nonce||scope||ts||address
      const expectedMessage = `${taken.nonce}||${scope}||${tsNum}||${address}`;
      const expectedMessageHex = asciiToHex(expectedMessage).toUpperCase();
      
      // Verify payloadHex matches
      if (!payloadHex || payloadHex.toUpperCase() !== expectedMessageHex) {
        req.log.warn('[Auth] Gem Wallet: payloadHex mismatch');
        return reply.code(401).send({ error: 'bad_signature', detail: 'payload_mismatch' });
      }
      
      // Reconstruct the AccountSet transaction to verify signature
      const reconstructedTx = {
        TransactionType: 'AccountSet',
        Account: address,
        Memos: [{
          Memo: {
            MemoType: asciiToHex('XRPixelJets'),
            MemoData: expectedMessageHex
          }
        }],
        SigningPubKey: pub,
        TxnSignature: signature.toUpperCase()
      };
      
      // Encode for signing (without signature field)
      const { TxnSignature, ...txWithoutSig } = reconstructedTx;
      const preimageHex = encodeForSigning(txWithoutSig).toUpperCase();
      
      // Verify signature
      const okSig = keypairs.verify(preimageHex, signature.toUpperCase(), pub) === true;
      if (!okSig) {
        req.log.warn('[Auth] Gem Wallet: signature verification failed');
        return reply.code(401).send({ error: 'bad_signature' });
      }
      
      // Verify publicKey derives to address
      const derived = keypairs.deriveAddress(pub);
      if (derived !== address) {
        req.log.warn('[Auth] Gem Wallet: derived address mismatch');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      
      req.log.info('[Auth] ✅ Gem Wallet auth successful');
      return reply.send({ ok: true, jwt: signJWT(address, scope) });
      
    } catch (err) {
      req.log.error({ err }, '[Auth] Gem Wallet verification error');
      return reply.code(401).send({ error: 'bad_signature', detail: 'gem_verify_failed' });
    }
  }

  // Simple signMessage path (secp only) - CROSSMARK and others
  if (!signature) return reply.code(400).send({ error: 'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error: 'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) {
    return reply.code(400).send({ error: 'bad_key_algo', detail: 'secp_required' });
  }
  if (!isSecpPublicKeyHex(publicKey)) {
    return reply.code(400).send({ error: 'bad_key' });
  }

  const expectedHex = payloadHex && payloadHex.length >= 8
    ? String(payloadHex).toUpperCase()
    : asciiToHex(`${taken.nonce}||${scope}||${tsNum}||${address}`);

  let okSig = false;
  let derived = '';
  try {
    okSig = keypairs.verify(
      expectedHex,
      String(signature).toUpperCase(),
      String(publicKey).toUpperCase()
    ) === true;
    derived = keypairs.deriveAddress(publicKey);
  } catch {}

  if (!okSig) return reply.code(401).send({ error: 'bad_signature' });
  if (derived !== address) return reply.code(401).send({ error: 'unauthorized' });

  reply.send({ ok: true, jwt: signJWT(address, scope) });
}
app.post('/session/verify', verifyOrFinish);
app.post('/session/finish', verifyOrFinish);

/* ======================= GREEN: profile / ms / battle ====================== */
function getEconScaleFrom(arg) {
  const n = Number(arg);
  return (Number.isFinite(n) && n >= 0) ? n : ECON_SCALE_ENV;
}
function levelsFromRow(row) {
  const lv = row?.ms_level || {};
  return {
    health:      toInt(lv.health, 0),
    energyCap:   toInt(lv.energyCap, 0),
    regenPerMin: toInt(lv.regenPerMin, 0),
    hit:         toInt(row?.ms_hit, 0),
    crit:        toInt(row?.ms_crit, 10),
    dodge:       toInt(row?.ms_dodge, 0)
  };
}
function unitCost(level, s) {
  const raw = BASE_PER_LEVEL * (toInt(level, 0) + 1);
  return Math.max(1, Math.round(raw * s));
}
function calcCosts(levels, s) {
  return {
    health:      unitCost(levels.health, s),
    energyCap:   unitCost(levels.energyCap, s),
    regenPerMin: unitCost(levels.regenPerMin, s),
    hit:         unitCost(levels.hit, s),
    crit:        unitCost(levels.crit, s),
    dodge:       unitCost(levels.dodge, s)
  };
}

// NEW: missionReward curve (Mike's spec) + REWARD_SCALE + optional cap
function missionReward(l) {
  const level = Math.max(1, Number(l) || 1);
  let base;

  if (level <= 5) {
    // 1–5: [1,1,2,2,3]
    const table = [0, 1, 1, 2, 2, 3];
    base = table[level] || 1;
  } else {
    // Then +1 every 3 levels, starting at 4 JF at level 6:
    // 6–8: 4, 9–11: 5, 12–14: 6, etc.
    const k = level - 6;
    const block = Math.floor(k / 3); // 0 for 6–8, 1 for 9–11...
    base = 4 + block;
  }

  let reward = Math.round(base * (REWARD_SCALE || 1));
  if (REWARD_MAX > 0 && reward > REWARD_MAX) {
    reward = REWARD_MAX;
  }
  return Math.max(1, reward);
}

app.get('/profile', async (req, reply) => {
  // profile row is created during /session/start; no need to ensure here
  const rowR = await regenEnergyIfDue(req.wallet);
  const row  = rowR || await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  // Get NFT regen bonus for client display
  let nftRegenBonus = 0;
  try {
    nftRegenBonus = await getWalletRegenBonus(req.wallet);
  } catch {}

  reply.send(toClient(row, nftRegenBonus));
});

app.get('/ms/costs', async (req, reply) => {
  const scale = getEconScaleFrom(req.query?.econScale);
  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });
  const levels = levelsFromRow(row);
  reply.send({ costs: calcCosts(levels, scale), levels, scale });
});

app.post('/ms/upgrade', async (req, reply) => {
  const q = req.body || {};
  const scale = getEconScaleFrom(q.econScale);

  let row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  const levels = levelsFromRow(row);
  const order  = ['health', 'energyCap', 'regenPerMin', 'hit', 'crit', 'dodge'];
  let jf       = row.jet_fuel | 0;
  const applied = { health: 0, energyCap: 0, regenPerMin: 0, hit: 0, crit: 0, dodge: 0 };
  let spent = 0;

  for (const key of order) {
    const want = Math.max(0, toInt(q[key], 0));
    for (let i = 0; i < want; i++) {
      const lvlNow = (key === 'health' || key === 'energyCap' || key === 'regenPerMin')
        ? levels[key]
        : (key === 'hit' ? levels.hit : (key === 'crit' ? levels.crit : levels.dodge));

      const price = Math.max(1, Math.round(BASE_PER_LEVEL * (lvlNow + 1) * getEconScaleFrom(scale)));
      if (jf < price) break;

      jf    -= price;
      spent += price;
      applied[key] += 1;

      if (key === 'health' || key === 'energyCap' || key === 'regenPerMin') {
        levels[key] += 1;
      } else if (key === 'hit') {
        levels.hit += 1;
      } else if (key === 'crit') {
        levels.crit += 1;
      } else {
        levels.dodge += 1;
      }
    }
  }

  const newCore   = { health: levels.health, energyCap: levels.energyCap, regenPerMin: levels.regenPerMin };
  const ms_current = recomputeCurrent(row.ms_base, newCore);

  const { rows } = await pool.query(
`update player_profiles
    set jet_fuel=$2,
        ms_level=$3,
        ms_current=$4,
        ms_hit=$5,
        ms_crit=$6,
        ms_dodge=$7,
        updated_at=now()
  where wallet=$1
  returning *`,
    [req.wallet, jf, JSON.stringify(newCore), JSON.stringify(ms_current), levels.hit, levels.crit, levels.dodge]
  );

  reply.send({ ok: true, applied, spent, profile: toClient(rows[0]), scale });
});

app.post('/battle/start', async (req, reply) => {
  const level = toInt((req.body || {}).level, 1);
  let row = await regenEnergyIfDue(req.wallet);
  if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  let energy = row.energy | 0;
  let spent  = 0;
  if (energy >= 10) { energy -= 10; spent = 10; }

  const { rows } = await pool.query(
    `update player_profiles
        set energy=$2,
            updated_at=now()
      where wallet=$1
      returning *`,
    [req.wallet, energy]
  );

  reply.send({ ok: true, level, spent, profile: toClient(rows[0]) });
});

app.post('/battle/turn', async (req, reply) => {
  let row = await regenEnergyIfDue(req.wallet);
  if (!row) row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  let energy = row.energy | 0;
  let spent  = 0;
  if (energy >= 1) { energy -= 1; spent = 1; }

  const { rows } = await pool.query(
    `update player_profiles
        set energy=$2,
            updated_at=now()
      where wallet=$1
      returning *`,
    [req.wallet, energy]
  );

  reply.send({ ok: true, spent, profile: toClient(rows[0]) });
});

app.post('/battle/finish', async (req, reply) => {
  const lvl     = Math.max(1, toInt((req.body || {}).level, 1));
  const victory = !!(req.body || {}).victory;

  let row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  let jf       = row.jet_fuel | 0;
  let unlocked = row.unlocked_level | 0;
  let reward   = 0;

  if (victory) {
    reward = missionReward(lvl);
    jf += reward;
    if (lvl >= unlocked) unlocked = lvl + 1;
  }

  const { rows } = await pool.query(
    `update player_profiles
        set jet_fuel=$2,
            unlocked_level=$3,
            updated_at=now()
      where wallet=$1
      returning *`,
    [req.wallet, jf, unlocked]
  );

  reply.send({ ok: true, reward, victory, level: lvl, profile: toClient(rows[0]) });
});

/* =============================== CLAIM LIVE =============================== */
app.post('/claim/start', async (req, reply) => {
  const jwtOk = requireJWT(req, reply);
  if (!jwtOk) return;

  const amount = toInt(req.body?.amount, 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return reply.code(400).send({ error: 'bad_amount' });
  }

  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  const nowS  = nowSec();
  const lastS = row.last_claim_at
    ? Math.floor(new Date(row.last_claim_at).getTime() / 1000)
    : 0;
  const COOL = Number(process.env.CLAIM_COOLDOWN_SEC || 300);
  if (COOL > 0 && (nowS - lastS) < COOL) {
    return reply.code(429).send({ error: 'cooldown' });
  }

  // Daily cap is based on gross JetFuel spent (amount)
  if (CLAIM_MAX_PER_24H > 0) {
    try {
      const { rows: dayRows } = await pool.query(
        `select coalesce(sum(amount), 0)::int as total
           from claim_audit
          where wallet = $1
            and created_at >= now() - interval '24 hours'`,
        [req.wallet]
      );
      const claimed   = (dayRows[0]?.total | 0);
      const projected = claimed + amount;
      if (projected > CLAIM_MAX_PER_24H) {
        const remaining = Math.max(0, CLAIM_MAX_PER_24H - claimed);
        return reply.code(400).send({
          error: 'daily_cap',
          detail: { max: CLAIM_MAX_PER_24H, claimed, remaining }
        });
      }
    } catch (e) {
      req.log.error({ e }, '[claim] daily_cap_query_failed');
    }
  }

  // Compute claim fee and net payout (in-game JetFuel -> JETS on-ledger)
  const feeBps = Math.max(0, Number.isFinite(CLAIM_FEE_BPS) ? CLAIM_FEE_BPS : 0);
  const fee = feeBps > 0 ? Math.floor((amount * feeBps) / 10000) : 0;
  const net = amount - fee;

  if (net <= 0) {
    return reply.code(400).send({ error: 'claim_fee_too_high' });
  }

  // Debit JetFuel by the full amount
  const debit = await pool.query(
    `update player_profiles
        set jet_fuel = jet_fuel - $2,
            updated_at = now()
      where wallet = $1
        and jet_fuel >= $2
      returning *`,
    [req.wallet, amount]
  );

  if (debit.rows.length === 0) {
    return reply.code(400).send({ error: 'insufficient_funds' });
  }

  try {
    // Send only the net amount as JETS on-ledger
    const { ok, txid = null, txJSON = null, error: sendErr, detail } =
      await sendIssued({ to: req.wallet, amount: net });

    if (!ok && TOKEN_MODE === 'hot') {
      // Refund the full amount of JetFuel if XRPL send failed
      await pool.query(
        `update player_profiles
            set jet_fuel = jet_fuel + $2,
                updated_at = now()
          where wallet = $1`,
        [req.wallet, amount]
      ).catch(() => {});

      const code = (sendErr === 'trustline_required') ? 400 : 500;
      return reply.code(code).send({ error: sendErr || 'claim_failed', detail });
    }

    // Record last_claim_at and audit the gross amount (JetFuel spent)
    await pool.query(
      `update player_profiles
          set last_claim_at = now(),
              updated_at    = now()
        where wallet = $1`,
      [req.wallet]
    );
    await pool.query(
      `insert into claim_audit (wallet, amount, tx_hash)
       values ($1, $2, $3)`,
      [req.wallet, amount, txid]
    ).catch(() => {});

    const latest = await getProfileRaw(req.wallet);

    return reply.send({
      ok: true,
      txid,
      txJSON,
      amount, // JetFuel spent by player
      fee,    // JetFuel burned as claim fee
      net,    // JETS sent to wallet
      profile: toClient(latest || debit.rows[0])
    });
  } catch (e) {
    // On unexpected error, refund the full JetFuel amount
    await pool.query(
      `update player_profiles
          set jet_fuel = jet_fuel + $2,
              updated_at = now()
        where wallet = $1`,
      [req.wallet, amount]
    ).catch(() => {});

    req.log.error({ e }, '[claim] sendIssued failed');
    return reply.code(500).send({ error: 'claim_failed' });
  }
});

/* ================================ BAZAAR ================================== */
if (BAZAAR_ENABLED) {
  await registerBazaarHotRoutes(app, {
    xrpl,
    XRPL_WSS,
    HOT_SEED,
    TOKEN_MODE,
    CURRENCY_CODE,
    CURRENCY_HEX,
    ISSUER_ADDR
  });
}

/* ================================ Startup ================================= */
app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  app.log.info(`XRPixel Jets API listening on :${PORT}`);
  if (xrpl.wallet) {
    app.log.info(`[XRPL] Hot wallet: ${xrpl.wallet.address} (algo=${HOT_ALGO})`);
  } else {
    app.log.warn('[XRPL] HOT_SEED missing — Bazaar offer creation & live claims may fail.');
  }
  // Pre-load the registry on startup
  loadRegistry(true).catch(() => {});
});
