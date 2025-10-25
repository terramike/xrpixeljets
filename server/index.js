// server/index.js — XRPixel Jets (2025-10-25b) — CORS + JWT + protected /claim/start
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwtlib from 'jsonwebtoken';
import crypto from 'crypto';
import * as claim from './claimJetFuel.js';

const app = Fastify({ logger: true });

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

await app.register(cors, {
  origin: CORS_ORIGIN,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Accept','Origin','X-Wallet','X-Admin-Key','Authorization','X-Requested-With'],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: false,
  hideOptionsRoute: false,
});

app.addHook('onRequest', async (req, reply) => {
  // simple JSON guard
  if (['POST','PUT','PATCH'].includes(req.method) && req.headers['content-type']?.includes('application/json') && !req.body) {
    // Fastify already parsed, this fires only if empty body with JSON type:
    req.body = {};
  }
});

// ---- Nonce store (in-memory for now) ----
const nonces = new Map(); // wallet -> { nonce, exp }
function makeNonce() { return crypto.randomBytes(32).toString('hex'); }
function putNonce(address) {
  const n = makeNonce();
  nonces.set(address, { nonce: n, exp: Date.now() + 5*60_000 });
  return n;
}
function takeNonce(address, nonce) {
  const rec = nonces.get(address);
  if (!rec || rec.nonce !== nonce || Date.now() > rec.exp) return false;
  nonces.delete(address);
  return true;
}

// ---- Open: /session/start ----
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  const nonce = putNonce(address);
  return reply.send({ nonce });
});

// ---- Verify signature + mint JWT ----
// NOTE: for initial bring-up we *accept* the signed payload presence and matching nonce.
// You can later add strict signature verification using ripple-keypairs.
app.post('/session/verify', async (req, reply) => {
  const { address, signature, publicKey, payload, scope, ts } = req.body || {};
  if (!address || !payload || !signature) return reply.code(400).send({ error: 'bad_signature' });

  const parts = String(payload).split('||');
  if (parts.length !== 4) return reply.code(400).send({ error: 'bad_signature' });
  const [nonce, scopeIn, tsIn, addrIn] = parts;
  if (addrIn !== address) return reply.code(400).send({ error: 'bad_signature' });
  if (!takeNonce(address, nonce)) return reply.code(400).send({ error: 'expired_nonce' });

  // (Optional) TODO: verify `signature` against `payload` with `publicKey`

  const now = Math.floor(Date.now()/1000);
  const exp = now + 45 * 60; // 45 min
  const jwt = jwtlib.sign({ sub: address, scope: scopeIn || scope || 'play,upgrade,claim', iat: now, exp }, JWT_SECRET, { algorithm:'HS256' });
  return reply.send({ ok: true, jwt });
});

// ---- Protected routes middleware ----
app.addHook('preHandler', async (req, reply) => {
  if (req.url.startsWith('/claim/')) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const xw = req.headers['x-wallet'] || '';
    if (!token || !xw) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const dec = jwtlib.verify(token, JWT_SECRET);
      if (!dec?.sub || dec.sub !== xw) return reply.code(401).send({ error: 'unauthorized' });
      req.jwt = dec;
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  }
});

// ---- Claim (cooldown + amount checks; then XRPL or txJSON fallback) ----
const COOLDOWN_SEC = Number(process.env.CLAIM_COOLDOWN_SEC || (Number(process.env.CLAIM_COOLDOWN_HOURS || 0) * 3600) || 300);
const MAX_PER_24H = Number(process.env.CLAIM_MAX_PER_24H || 1000);
const DRY_RUN = process.env.DRY_RUN === '1'; // set DRY_RUN=1 for testing

const recentClaims = new Map(); // wallet -> { total24h, lastAt }

app.post('/claim/start', async (req, reply) => {
  const wallet = req.headers['x-wallet'];
  const amount = Number(req.body?.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return reply.code(400).send({ error: 'bad_amount' });

  const now = Date.now();
  const rec = recentClaims.get(wallet) || { total24h: 0, lastAt: 0, windowStart: now };
  // reset 24h window
  if (now - rec.windowStart > 24*3600_000) { rec.windowStart = now; rec.total24h = 0; }
  // cooldown
  if (now - rec.lastAt < COOLDOWN_SEC * 1000) return reply.code(429).send({ error: 'cooldown' });
  // limit
  if (rec.total24h + amount > MAX_PER_24H) return reply.code(429).send({ error: 'limit_exceeded' });

  // XRPL send or fallback
  try {
    let out;
    if (DRY_RUN) {
      out = { txid: 'dryrun-' + now };
    } else {
      // Prefer IOU; prepare txJSON if no trustline and env allows
      const hasTL = await claim.hasTrustline({ account: wallet });
      if (!hasTL && process.env.CLAIM_FALLBACK_TXJSON === '1') {
        out = await claim.prepareIssued({ to: wallet, amount });
      } else {
        out = await claim.sendIssued({ to: wallet, amount });
      }
    }
    rec.lastAt = now; rec.total24h += amount; recentClaims.set(wallet, rec);
    return reply.send({ ok: true, ...out });
  } catch (e) {
    req.log.error({ err:e }, 'claim_send_failed');
    return reply.code(502).send({ error: 'send_failed', message: e?.message || String(e) });
  }
});

app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`XRPixel server on :${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
