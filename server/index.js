// server/index.js — XRPixel Jets MKG (2025-10-25 secp-auth+jwt)
import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import jwt from 'jsonwebtoken';
import * as keypairs from 'ripple-keypairs';
import crypto from 'crypto';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;
const app = Fastify({ logger: true });

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_only_change_me';
const CORS_ALLOW = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

await app.register(cors, {
  origin: CORS_ALLOW,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','Authorization'],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: false,
  hideOptionsRoute: false,
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

// ---------- Nonce (single-use, 5 min) ----------
const NONCES = new Map(); // address -> { nonce, exp: ms, used: bool }
function newNonce() { return crypto.randomBytes(32).toString('hex'); }
function storeNonce(address, nonce) { NONCES.set(address, { nonce, exp: Date.now() + 5*60_000, used:false }); }
function takeNonce(address) {
  const rec = NONCES.get(address);
  if (!rec) return { err: 'expired_nonce' };
  NONCES.delete(address);
  if (rec.used) return { err: 'expired_nonce' };
  if (Date.now() > rec.exp) return { err: 'expired_nonce' };
  rec.used = true;
  return { ok: true, nonce: rec.nonce };
}
function asciiToHex(s){ return Buffer.from(String(s), 'utf8').toString('hex'); }
function isSecpPublicKeyHex(pk){ return typeof pk === 'string' && /^(02|03)[0-9A-Fa-f]{64}$/.test(pk); }
function isEd25519PublicKeyHex(pk){ return typeof pk === 'string' && /^ED[0-9A-Fa-f]{64}$/.test(pk); }

// ---------- Rate limit + X-Wallet ----------
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();
app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return;
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  req.wallet = w;

  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  const since = now - cur.ts;
  if (since > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error: 'rate_limited' });
});

// ---------- Profile helpers ----------
async function ensureProfile(wallet){
  await pool.query(`insert into player_profiles (wallet) values ($1) on conflict (wallet) do nothing`, [wallet]);
  return wallet;
}
async function getProfileRaw(wallet){
  const { rows } = await pool.query(
`select wallet, jet_fuel, energy, energy_cap,
        ms_base, ms_level, ms_current,
        coalesce(ms_hit,0)::int as ms_hit,
        coalesce(ms_crit,10)::int as ms_crit,
        coalesce(ms_dodge,0)::int as ms_dodge,
        unlocked_level, last_claim_at, updated_at, created_at
   from player_profiles where wallet = $1`, [wallet]);
  return rows[0] || null;
}
function recomputeCurrent(base, level) {
  const b = base || { health:20, energyCap:100, regenPerMin:1 };
  const lv = level || { health:0, energyCap:0, regenPerMin:0 };
  return {
    health: (b.health|0) + (lv.health|0),
    energyCap: (b.energyCap|0) + (lv.energyCap|0),
    regenPerMin: (b.regenPerMin|0) + (lv.regenPerMin|0),
  };
}
function toClient(row){
  const ms_current = row.ms_current || recomputeCurrent(row.ms_base, row.ms_level);
  return {
    ms: { base: row.ms_base, level: row.ms_level, current: ms_current },
    pct: { hit: row.ms_hit|0, crit: row.ms_crit|0, dodge: row.ms_dodge|0 },
    jetFuel: row.jet_fuel|0,
    energy: row.energy|0,
    energyCap: row.energy_cap|0,
    unlockedLevel: row.unlocked_level|0,
  };
}
async function applyRegen(wallet, row) {
  try {
    const now = new Date();
    const updated = new Date(row.updated_at);
    const minutes = Math.max(0, Math.floor((now - updated)/60000));
    const ms = recomputeCurrent(row.ms_base, row.ms_level);
    const regenPerMin = (ms.regenPerMin|0) || 1;
    if (minutes > 0 && regenPerMin > 0) {
      const cap = (row.energy_cap|0) || 100;
      const next = clamp((row.energy|0) + minutes * regenPerMin, 0, cap);
      if (next !== (row.energy|0)) {
        const { rows } = await pool.query(
`update player_profiles
   set energy = $2, ms_current = $3, updated_at = now()
 where wallet = $1
 returning *`, [wallet, next, JSON.stringify(ms)]);
        return rows[0];
      }
    }
  } catch (e) { app.log.warn({ err:e }, 'regen_nonfatal'); }
  return row;
}

// ---------- JWT ----------
function signJWT(address, scope='play,upgrade,claim'){
  const now = Math.floor(Date.now()/1000);
  const exp = now + 60*60;
  return jwt.sign({ sub: address, scope, iat: now, exp }, process.env.JWT_SECRET || 'dev_only_change_me', { algorithm: 'HS256' });
}
function requireJWT(req, reply){
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) { reply.code(401).send({ error: 'unauthorized' }); return null; }
  try { return jwt.verify(token, process.env.JWT_SECRET || 'dev_only_change_me', { algorithms:['HS256'] }); }
  catch { reply.code(401).send({ error: 'unauthorized' }); return null; }
}

// ---------- Routes ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error: 'bad_address' });
  await ensureProfile(address);
  const nonce = newNonce(); storeNonce(address, nonce);
  return reply.send({ nonce });
});

app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payload, payloadHex, scope='play,upgrade,claim', ts } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) return reply.code(400).send({ error: 'bad_address' });
  if (!signature || typeof signature !== 'string') return reply.code(400).send({ error: 'bad_signature' });
  if (!publicKey) return reply.code(400).send({ error: 'bad_key' });
  if (isEd25519PublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key_algo', detail:'secp_required' });
  if (!isSecpPublicKeyHex(publicKey)) return reply.code(400).send({ error: 'bad_key' });

  const taken = takeNonce(address);
  if (!taken.ok) return reply.code(400).send({ error: taken.err });

  const now = Math.floor(Date.now()/1000);
  const tsNum = Number(ts || now);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > 5*60) return reply.code(400).send({ error: 'expired_nonce' });

  const expected = `${taken.nonce}||${scope}||${tsNum}||${address}`;
  const msgHex = (payloadHex && typeof payloadHex === 'string' && payloadHex.length >= 8) ? payloadHex : asciiToHex(expected);

  let okSig = false, derivedAddr = '';
  try {
    okSig = keypairs.verify(msgHex, signature, publicKey) === true;
    derivedAddr = keypairs.deriveAddress(publicKey);
  } catch {}
  if (!okSig) return reply.code(401).send({ error: 'bad_signature' });
  if (derivedAddr !== address) return reply.code(401).send({ error: 'unauthorized' });

  const token = signJWT(address, scope);
  return reply.send({ ok: true, jwt: token });
});

app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

// ... (keep your existing /ms/costs, /ms/upgrade, /battle/* unchanged)

app.post('/claim/start', async (req, reply) => {
  const jwtClaims = requireJWT(req, reply); if (!jwtClaims) return;
  const { amount } = req.body || {};
  const amt = Number(amount||0); if (!Number.isFinite(amt) || amt <= 0) return reply.code(400).send({ error:'bad_amount' });

  // Limits / Cooldown
  const MAX24 = Number(process.env.CLAIM_MAX_PER_24H || 1000);
  const COOLD = Number(process.env.CLAIM_COOLDOWN_SEC || 300);

  const row = await getProfileRaw(req.wallet);
  if (!row) return reply.code(404).send({ error: 'not_found' });

  const lastTs = row.last_claim_at ? Math.floor(new Date(row.last_claim_at).getTime()/1000) : 0;
  const now = Math.floor(Date.now()/1000);
  if (COOLD > 0 && (now - lastTs) < COOLD) return reply.code(429).send({ error:'cooldown' });

  // (You can add rolling 24h cap here with audit table if desired)

  const mode = (process.env.CLAIM_MODE || 'server-send').toLowerCase();
  try {
    const dest = req.wallet;
    if (mode === 'user-sign') {
      const prep = await claim.prepareIssued({ to: dest, amount: amt });
      await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [dest, amt, null]).catch(()=>{});
      return reply.send({ ok:true, txJSON: prep.txJSON || null });
    } else {
      const sent = await claim.sendIssued({ to: dest, amount: amt });
      await pool.query(`update player_profiles set last_claim_at = now() where wallet=$1`, [dest]).catch(()=>{});
      await pool.query(`insert into claim_audit (wallet, amount, tx_hash) values ($1,$2,$3)`, [dest, amt, sent?.txid||null]).catch(()=>{});
      return reply.send({ ok:true, txid: sent?.txid || null });
    }
  } catch (e) {
    return reply.code(500).send({ error: String(e?.message || e) });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`XRPixel Jets API listening on ${PORT}`);
});
