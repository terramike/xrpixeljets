// server/index.js — XRPixel Jets MKG (2025-10-25 ping+admin)
// Minimal patch: keep your existing costs/upgrade/claim logic,
// add diagnostics endpoint and allow X-Admin-Key in CORS.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import pkg from 'pg';
import * as claim from './claimJetFuel.js';

const { Pool } = pkg;

const PORT = process.env.PORT || 10000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

const app = Fastify({ logger: true });

// ---------- CORS (allowlist) ----------
const ORIGIN_LIST = (process.env.CORS_ORIGIN || 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000')
  .split(',').map(s => s.trim()).filter(Boolean);

await app.register(cors, {
  origin: ORIGIN_LIST,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Origin', 'X-Requested-With', 'X-Wallet', 'X-Admin-Key'],
  credentials: false,
  maxAge: 86400,
  preflight: true,
  strictPreflight: false,
  hideOptionsRoute: false,
});

// ---------- Helpers ----------
async function ensureProfile(wallet){
  const { rows } = await pool.query(
    `insert into player_profiles (wallet)
     values ($1)
     on conflict (wallet) do nothing
     returning wallet`, [wallet]
  );
  return rows[0]?.wallet || wallet;
}

async function getProfileRaw(wallet){
  const { rows } = await pool.query(
    `select wallet, jet_fuel, energy, energy_cap,
            ms_base, ms_level, ms_current,
            coalesce(ms_hit,0)::int as ms_hit,
            coalesce(ms_crit,10)::int as ms_crit,
            coalesce(ms_dodge,0)::int as ms_dodge,
            unlocked_level, last_claim_at, updated_at, created_at
       from player_profiles where wallet = $1`, [wallet]
  );
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
    const updated = row.updated_at ? new Date(row.updated_at) : null;
    if (!updated) return row;
    const minutes = Math.max(0, Math.floor((now - updated)/60000));
    const ms = recomputeCurrent(row.ms_base, row.ms_level);
    const regenPerMin = (ms.regenPerMin|0) || 1;
    if (minutes > 0 && regenPerMin > 0) {
      const cap = (row.energy_cap|0) || ms.energyCap || 100;
      const next = clamp((row.energy|0) + minutes * regenPerMin, 0, cap);
      if (next !== (row.energy|0)) {
        const { rows } = await pool.query(
          `update player_profiles
             set energy = $2, ms_current = $3, updated_at = now()
           where wallet = $1
           returning *`,
          [wallet, next, JSON.stringify(ms)]
        );
        return rows[0];
      }
    }
  } catch (e) {
    app.log.warn({ err:e }, 'regen_nonfatal');
  }
  return row;
}

// ---------- Rate-limit & wallet guard ----------
const RATE = { windowMs: 10_000, maxPerWindow: 30 };
const bucket = new Map();

app.addHook('onRequest', async (req, reply) => {
  if (req.raw.url === '/session/start') return; // open
  const w = req.headers['x-wallet'];
  if (!w || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(w)) {
    return reply.code(400).send({ error: 'missing_or_bad_X-Wallet' });
  }
  req.wallet = w;
  const key = `${req.ip}|${w}`;
  const now = Date.now();
  const cur = bucket.get(key) || { count: 0, ts: now };
  if (now - cur.ts > RATE.windowMs) { cur.count = 0; cur.ts = now; }
  cur.count += 1; bucket.set(key, cur);
  if (cur.count > RATE.maxPerWindow) return reply.code(429).send({ error: 'rate_limited' });
});

// ---------- Routes ----------
app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address || !/^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(address)) {
    return reply.code(400).send({ error: 'bad_address' });
  }
  await ensureProfile(address);
  return reply.send({ ok:true });
});

app.get('/profile', async (req, reply) => {
  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });
  const p = await applyRegen(req.wallet, p0) || p0;
  return reply.send(toClient(p));
});

// (… keep your existing /ms/costs, /ms/upgrade, /battle/* here …)

// Claim via XRPL hot wallet (unchanged flow; now benefits from stronger module)
app.post('/claim/start', async (req, reply) => {
  const { amount } = req.body || {};
  const amt = Math.max(1, parseInt(amount||0, 10));

  const p0 = await getProfileRaw(req.wallet);
  if (!p0) return reply.code(404).send({ error: 'not_found' });

  const last = p0.last_claim_at ? new Date(p0.last_claim_at) : null;
  const COOLDOWN_MS =
    process.env.CLAIM_COOLDOWN_SEC ? Number(process.env.CLAIM_COOLDOWN_SEC) * 1000 :
    process.env.CLAIM_COOLDOWN_HOURS ? Number(process.env.CLAIM_COOLDOWN_HOURS) * 3600 * 1000 :
    300 * 1000;

  if (last && (Date.now() - last.getTime()) < COOLDOWN_MS) {
    return reply.code(429).send({ error: 'cooldown' });
  }

  try {
    const out = await claim.sendIssued({ to: req.wallet, amount: amt });
    const txid = (typeof out === 'string') ? out : (out?.txJSON ? null : null);
    await pool.query(
      `update player_profiles set last_claim_at = now(), updated_at = now() where wallet = $1`,
      [req.wallet]
    );
    return reply.send({ ok:true, txid, ...(out?.txJSON ? { txJSON: out.txJSON } : {}) });
  } catch (e) {
    req.log.error({ err:e }, 'claim_send_failed');
    return reply.code(502).send({ error: 'send_failed', message: e.message || String(e) });
  }
});

// ---------- Admin diagnostics: verify network & accounts ----------
app.get('/debug/claim/ping', async (req, reply) => {
  const key = (req.headers['x-admin-key'] || '').trim();
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const wallet = (req.query.wallet || '').trim();
  try {
    const info = await claim.diagnostics({ dest: wallet || null });
    return reply.send({ ok:true, info });
  } catch (e) {
    return reply.code(500).send({ error: 'ping_failed', message: e.message || String(e) });
  }
});

app.listen({ port: PORT, host: '0.0.0.0' }, (err, addr) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`Server listening at ${addr}`);
});
