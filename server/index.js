// server.js — XRPixel Jets API (2025-12-18-db-nonce-r3)
// Base: your provided index.js + DB nonces for /session/start/verify
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
const app = Fastify({ logger: true });

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
  : ECON_SCALE_ENV;

await app.register(cors, {
  origin: (origin, cb) => { if (!origin) return cb(null, true); cb(null, ALLOW.includes(origin)); },
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization','X-Idempotency-Key'],
  credentials: false
});
app.addHook('onSend', async (req, reply, payload) => {
  const origin = req.headers.origin;
  if (origin && ALLOW.includes(origin)) reply.header('Access-Control-Allow-Origin', origin);
  return payload;
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    create table if not exists player_profiles (
      wallet text primary key,
      mothership jsonb not null default '{}',
      jet_fuel integer not null default 0,
      unlocked_level integer not null default 1,
      last_energy_at timestamp default now(),
      accrued_energy numeric not null default 0,
      created_at timestamp default now(),
      updated_at timestamp default now()
    );
    create table if not exists claim_audit (
      id serial primary key,
      wallet text not null,
      amount integer not null,
      txid text,
      ts timestamp default now()
    );
    create table if not exists session_nonces (
      wallet text primary key,
      nonce text not null,
      ts timestamp default now()
    );
  `);
}
await initDb();

/* ================================ AUTH ================================== */
app.post('/session/start', async (req, reply) => {
  const wallet = req.body.address || req.headers['x-wallet'] || '';
  if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(wallet)) return reply.code(400).send({ error:'bad_address' });

  const nonce = crypto.randomBytes(16).toString('hex');
  await pool.query(`insert into session_nonces (wallet, nonce) values ($1, $2) on conflict (wallet) do update set nonce = $2, ts = now()`, [wallet, nonce]);

  return reply.send({ nonce });
});

app.post('/session/verify', async (req, reply) => {
  const wallet = req.body.address;
  if (!/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(wallet)) return reply.code(400).send({ error:'bad_address' });

  const signer = String(req.body.signer || 'crossmark').toLowerCase();
  const txBlob = req.body.tx_blob;

  let nonce = null;
  const row = await pool.query(`select nonce, ts from session_nonces where wallet = $1`, [wallet]);
  const storedNonce = row.rows[0]?.nonce;
  const ts = row.rows[0]?.ts;
  if (!storedNonce) return reply.code(400).send({ error:'no_session' });
  if (new Date() - new Date(ts) > 5 * 60 * 1000) return reply.code(400).send({ error:'nonce_expired' });

  if (txBlob) {
    const tx = decode(txBlob);
    if (tx.TransactionType !== 'AccountSet' || tx.Account !== wallet) return reply.code(400).send({ error:'bad_tx_type' });
    const memo = tx.Memos?.[0]?.Memo;
    const memoType = memo?.MemoType ? Buffer.from(memo.MemoType, 'hex').toString('utf8') : '';
    const memoData = memo?.MemoData ? Buffer.from(memo.MemoData, 'hex').toString('utf8') : '';
    if (memoType !== 'XRPixelJets' || !memoData) return reply.code(400).send({ error:'bad_memo' });

    const [, nonceLine, addrLine] = memoData.split('\n');
    const parsedNonce = nonceLine?.split(':')[1] || '';
    const parsedAddr = addrLine?.split(':')[1] || '';
    if (parsedAddr !== wallet) return reply.code(400).send({ error:'bad_addr' });
    if (parsedNonce !== storedNonce) return reply.code(400).send({ error:'bad_nonce' });
  } else {
    // Legacy message sign
    const signature = req.body.signature;
    const publicKey = req.body.publicKey;
    if (!signature || !publicKey) return reply.code(400).send({ error:'missing_signature' });

    const message = `XRPixelJets login\nnonce:${storedNonce}\naddr:${wallet}`;
    const signed = encodeForSigning({ SigningPubKey: publicKey, TransactionType: 'SignIn', Message: message });
    if (!keypairs.verify(signed, signature, publicKey)) return reply.code(400).send({ error:'bad_signature' });
  }

  await pool.query(`delete from session_nonces where wallet = $1`, [wallet]);

  const token = jwt.sign({ wallet }, JWT_SECRET, { expiresIn: '1h' }); // Added expiry for safety
  return reply.send({ token });
});

/* ================================ PROFILE ================================= */
async function getProfileRaw(wallet) {
  const r = await pool.query(`select * from player_profiles where wallet = $1`, [wallet]);
  return r.rows[0] || null;
}

function toClient(row) {
  if (!row) return null;
  return {
    wallet: row.wallet,
    mothership: row.mothership || {},
    jetFuel: row.jet_fuel || 0,
    unlockedLevel: row.unlocked_level || 1,
    lastEnergyAt: row.last_energy_at || null,
    accruedEnergy: Number(row.accrued_energy || 0)
  };
}

app.get('/profile', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  let p = await getProfileRaw(req.wallet);
  if (!p) {
    await pool.query(`insert into player_profiles (wallet) values ($1)`, [req.wallet]);
    p = await getProfileRaw(req.wallet);
  }

  const ms = p.mothership || {};
  const base = ms.base || {};
  const cur = ms.current || {};

  const cap = Number(cur.energyCap || base.energyCap || 100);
  const regen = Number(cur.regenPerMin || base.regenPerMin || 1.0);
  const last = p.last_energy_at || new Date().toISOString();
  const acc = Number(p.accrued_energy || 0);

  const now = new Date();
  const mins = (now - new Date(last)) / (60 * 1000);
  const regenAmt = Math.min(cap - acc, mins * regen);

  if (regenAmt > 0) {
    await pool.query(`
      update player_profiles
      set accrued_energy = accrued_energy + $2,
          last_energy_at = now(),
          updated_at = now()
      where wallet = $1
    `, [req.wallet, regenAmt]);
    p.accrued_energy = (p.accrued_energy || 0) + regenAmt;
  }

  return reply.send(toClient(p));
});

/* ================================ MS ===================================== */
app.get('/ms/costs', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const econScale = Number(req.query.econScale || ECON_SCALE_ENV);
  const p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error:'no_profile' });

  const ms = p.mothership || {};
  const base = ms.base || {};
  const cur = ms.current || {};

  const health = Number(cur.health || base.health || 20);
  const cap = Number(cur.energyCap || base.energyCap || 100);
  const regen = Number(cur.regenPerMin || base.regenPerMin || 1.0);

  const nextHealth = health + 5;
  const nextCap = cap + 10;
  const nextRegen = regen + REGEN_STEP;

  const costHealth = Math.floor(nextHealth * BASE_PER_LEVEL * econScale);
  const costCap = Math.floor(nextCap * BASE_PER_LEVEL * econScale);
  const costRegen = Math.floor(nextRegen * BASE_PER_LEVEL * econScale * 10); // Regen is cheaper per step

  return reply.send({
    health: costHealth,
    energyCap: costCap,
    regenPerMin: costRegen
  });
});

app.post('/ms/upgrade', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const queue = req.body || {};
  const levels = {
    health: Number(queue.health || 0),
    energyCap: Number(queue.energyCap || 0),
    regenPerMin: Number(queue.regenPerMin || 0)
  };

  let p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error:'no_profile' });

  let totalCost = 0;
  for (const [key, lvl] of Object.entries(levels)) {
    if (lvl <= 0) continue;
    const base = p.mothership?.base?.[key] || (key === 'health' ? 20 : key === 'energyCap' ? 100 : 1.0);
    const cur = p.mothership?.current?.[key] || base;
    const step = key === 'regenPerMin' ? REGEN_STEP : (key === 'health' ? 5 : 10);
    const costFactor = key === 'regenPerMin' ? 10 : 1;

    let next = cur;
    for (let i = 0; i < lvl; i++) {
      next += step;
      totalCost += Math.floor(next * BASE_PER_LEVEL * ECON_SCALE_ENV * costFactor);
    }

    if (totalCost > p.jet_fuel) return reply.code(400).send({ error:'insufficient_funds' });

    p.mothership.current[key] = next;
  }

  await pool.query(`
    update player_profiles
    set mothership = $2,
        jet_fuel = jet_fuel - $3,
        updated_at = now()
    where wallet = $1
  `, [req.wallet, p.mothership, totalCost]);

  return reply.send({ ok:true, cost: totalCost, profile: toClient(p) });
});

/* ================================ BATTLE ================================== */
app.post('/battle/start', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error:'no_profile' });

  if (p.accrued_energy < 10) return reply.code(400).send({ error:'insufficient_energy' });

  await pool.query(`
    update player_profiles
    set accrued_energy = accrued_energy - 10,
        updated_at = now()
    where wallet = $1
  `, [req.wallet]);

  return reply.send({ ok:true, energySpent:10 });
});

app.post('/battle/turn', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error:'no_profile' });

  if (p.accrued_energy < 1) return reply.code(400).send({ error:'insufficient_energy' });

  await pool.query(`
    update player_profiles
    set accrued_energy = accrued_energy - 1,
        updated_at = now()
    where wallet = $1
  `, [req.wallet]);

  return reply.send({ ok:true, energySpent:1 });
});

app.post('/battle/finish', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const level = Number(req.body.level || 1);
  const turns = Number(req.body.turns || 0);
  if (level < 1 || turns < 1) return reply.code(400).send({ error:'bad_params' });

  const p = await getProfileRaw(req.wallet);
  if (!p) return reply.code(404).send({ error:'no_profile' });

  const reward = Math.floor(level * turns * REWARD_SCALE);
  await pool.query(`
    update player_profiles
    set jet_fuel = jet_fuel + $2,
        unlocked_level = GREATEST(unlocked_level, $3),
        updated_at = now()
    where wallet = $1
  `, [req.wallet, reward, level + 1]);

  return reply.send({ ok:true, reward });
});

/* ================================ CLAIM ================================== */
app.post('/claim/start', async (req, reply) => {
  if (!req.wallet) return reply.code(401).send({ error:'unauthorized' });

  const amt = Number(req.body.amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  const p = await getProfileRaw(req.wallet);
  if (!p || p.jet_fuel < amt) return reply.code(400).send({ error:'insufficient_funds' });

  const recent = await pool.query(`
    select sum(amount) as total from claim_audit
    where wallet = $1 and ts > now() - interval '24 hours'
  `, [req.wallet]);
  const total24h = Number(recent.rows[0]?.total || 0);
  if (total24h + amt > CLAIM_MAX_PER_24H) return reply.code(400).send({ error:'daily_cap_exceeded' });

  await pool.query(`
    update player_profiles
    set jet_fuel = jet_fuel - $2,
        updated_at = now()
    where wallet = $1
  `, [req.wallet, amt]);

  let sent;
  try {
    sent = await sendIssued({ to: req.wallet, amount: amt });
  } catch (e) {
    await pool.query(`
      update player_profiles
      set jet_fuel = jet_fuel + $2,
          updated_at = now()
      where wallet = $1
    `, [req.wallet, amt]);
    return reply.code(500).send({ error:'claim_failed' });
  }

  await pool.query(`
    insert into claim_audit (wallet, amount, txid)
    values ($1, $2, $3)
  `, [req.wallet, amt, sent?.txid || null]);

  const latest = await getProfileRaw(req.wallet);

  return reply.send({
    ok: true,
    txid: sent?.txid,
    txJSON: sent?.txJSON,
    amount, // JetFuel spent
    profile: toClient(latest || p)
  });
});

app.get('/healthz', async (_req, reply) => reply.send({ ok:true }));

/* ================================ BAZAAR ================================== */
let BAZAAR_ENABLED = false;
try {
  BAZAAR_ENABLED = process.env.BAZAAR_ENABLED === '1' || process.env.BAZAAR_ENABLED === 'true';
} catch {}
const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const HOT_SEED = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';
const TOKEN_MODE = (process.env.TOKEN_MODE || 'IOU').toUpperCase();
const CURRENCY_CODE = process.env.CURRENCY_CODE || process.env.CURRENCY || 'JETS';
const CURRENCY_HEX = (process.env.CURRENCY_HEX || '').toUpperCase();
const ISSUER_ADDR = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';

const xrpl = { client: new XRPLClient(XRPL_WSS), wallet: null };
let HOT_ALGO = 'unknown';
if (HOT_SEED) {
  try {
    xrpl.wallet = XRPLWallet.fromSeed(HOT_SEED, { algorithm: 'secp256k1' });
    HOT_ALGO = xrpl.wallet.algorithm;
    await xrpl.client.connect();
  } catch (e) {
    app.log.error(e, '[XRPL] client init failed');
  }
}

if (BAZAAR_ENABLED) {
  try {
    await registerBazaarHotRoutes(app, {
      xrpl,
      XRPL_WSS,
      HOT_SEED,
      TOKEN_MODE,
      CURRENCY_CODE,
      CURRENCY_HEX,
      ISSUER_ADDR
    });
    app.log.info('[Bazaar] hot routes registered');
  } catch (e) {
    app.log.error(e, '[Bazaar] failed to register');
  }
}

/* ============================ Optional Xaman ============================== */
// Loads ONLY when keys are present; otherwise skipped (prevents xumm-sdk crashes)
try {
  if (process.env.XAMAN_API_KEY && process.env.XAMAN_API_SECRET) {
    const { default: xaman } = await import('./xaman.js'); // xaman.js lazily imports xumm-sdk internally
    await (async () => app.register(xaman))();
    app.log.info('[Xaman] plugin registered');
  } else {
    app.log.info('[Xaman] plugin not configured');
  }
} catch (e) {
  app.log.error(e, '[Xaman] plugin failed to register');
}

/* ================================ Startup ================================= */
const HOST = process.env.HOST || '0.0.0.0';
const start = async () => {
  try {
    await app.ready();
    await app.listen({ port: PORT, host: HOST });
    app.log.info({ host: HOST, port: PORT }, '[Server] listening');
    if (xrpl.wallet) {
      app.log.info(`[XRPL] Hot wallet: ${xrpl.wallet.address} (algo=${HOT_ALGO})`);
    } else {
      app.log.warn('[XRPL] HOT_SEED missing — Bazaar offer creation & live claims may fail.');
    }
  } catch (err) {
    app.log.error(err, '[Server] failed to start');
    process.exit(1);
  }
};
await start();
