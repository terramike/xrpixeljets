// server/index.js
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'crypto'; // ✅ built-in in Node 16+

// ---------- Config ----------
const PORT = process.env.PORT || 8787; // Render injects PORT
const HOST = '0.0.0.0';
const ORIGINS = (process.env.ALLOW_ORIGIN || 'http://localhost:8000,https://mykeygo.io')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ---------- App ----------
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    // allow no-origin (Render health checks, curl) or exact matches
    if (!origin) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed: ' + origin), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false
});

// ---------- In-memory “DB” ----------
/**
 * profiles[address] = {
 *   nonce, jetFuel, unlockedLevel,
 *   energy, ms:{base,current,level}, pct:{hit,crit,dodge},
 *   lastTick
 * }
 */
const profiles = Object.create(null);

const DEFAULT_MS = {
  base: { health: 20, energyCap: 100, regenPerMin: 1.0 },
  current: { health: 20, energyCap: 100, regenPerMin: 1.0 },
  level: { health: 0, energyCap: 0, regenPerMin: 0 }
};
const DEFAULT_PCT = { hit: 0, crit: 10, dodge: 0 };

function ensureProfile(address) {
  if (!profiles[address]) {
    profiles[address] = {
      nonce: randomUUID().slice(0, 8),
      jetFuel: 100,
      unlockedLevel: 5,
      energy: 100,
      ms: JSON.parse(JSON.stringify(DEFAULT_MS)),
      pct: { ...DEFAULT_PCT },
      lastTick: Date.now()
    };
  }
  return profiles[address];
}

function tickEnergy(p) {
  const now = Date.now();
  const dtMs = now - (p.lastTick || now);
  if (dtMs <= 0) return;
  const perSec = (p.ms.current.regenPerMin ?? 1) / 60;
  const gained = perSec * (dtMs / 1000);
  p.energy = Math.min(p.energy + gained, p.ms.current.energyCap);
  p.lastTick = now;
}

function authOrThrow(address, nonce) {
  if (!address) { const e = new Error('missing address'); e.statusCode = 400; throw e; }
  const p = ensureProfile(address);
  if (nonce && p.nonce !== nonce) { const e = new Error('bad nonce'); e.statusCode = 401; throw e; }
  return p;
}

function toClientProfile(p) {
  return {
    ms: p.ms,
    energy: Math.floor(p.energy),
    energyCap: p.ms.current.energyCap,
    unlockedLevel: p.unlockedLevel,
    jetFuel: p.jetFuel,
    pct: p.pct
  };
}

function upgradeCost(stat, lvNext) {
  switch (stat) {
    case 'health':     return 10 * lvNext * lvNext;
    case 'energyCap':  return 12 * lvNext * lvNext;
    case 'regenPerMin':return 15 * lvNext * lvNext;
    case 'hit':        return 10 * lvNext * lvNext;
    case 'crit':       return 14 * lvNext * lvNext;
    case 'dodge':      return 12 * lvNext * lvNext;
    default: return 9999;
  }
}

// ---------- Routes ----------
app.get('/', async () => ({ ok: true, service: 'XRPixelJets API' }));
app.get('/health', async () => ({ ok: true }));

app.post('/session/start', async (req, reply) => {
  const { address } = req.body || {};
  if (!address) return reply.code(400).send({ error: 'missing address' });
  const p = ensureProfile(address);
  p.nonce = randomUUID().slice(0, 8); // rotate
  return { nonce: p.nonce };
});

app.get('/profile', async (req, reply) => {
  const { address } = req.query || {};
  if (!address) return reply.code(400).send({ error: 'missing address' });
  const p = ensureProfile(address);
  tickEnergy(p);
  return toClientProfile(p);
});

app.post('/battle/start', async (req, reply) => {
  const { address, nonce } = req.body || {};
  try {
    const p = authOrThrow(address, nonce);
    tickEnergy(p);
    if (Math.floor(p.energy) < 10) {
      return reply.code(400).send({ error: 'insufficient energy', need: 10, have: Math.floor(p.energy) });
    }
    p.energy -= 10;
    return { ok: true, energy: Math.floor(p.energy) };
  } catch (e) {
    return reply.code(e.statusCode || 400).send({ error: e.message || 'bad request' });
  }
});

app.post('/battle/finish', async (req, reply) => {
  const { address, nonce, win, wave, rewardJF, energyRefill } = req.body || {};
  try {
    const p = authOrThrow(address, nonce);
    tickEnergy(p);
    const jf = Math.max(0, Math.floor(rewardJF ?? 0));
    const refill = Math.max(0, Math.floor(energyRefill ?? 0));
    if (win) {
      p.jetFuel += jf;
      p.energy = Math.min(p.energy + refill, p.ms.current.energyCap);
      if (wave && wave > p.unlockedLevel) p.unlockedLevel = wave;
    } else {
      p.energy = Math.min(p.energy + refill, p.ms.current.energyCap);
    }
    return { ok: true, profile: toClientProfile(p) };
  } catch (e) {
    return reply.code(e.statusCode || 400).send({ error: e.message || 'bad request' });
  }
});

app.post('/ms/upgrade', async (req, reply) => {
  const { address, nonce, ops } = req.body || {};
  try {
    const p = authOrThrow(address, nonce);
    tickEnergy(p);

    const apply = {
      health: Math.max(0, ops?.health|0),
      energyCap: Math.max(0, ops?.energyCap|0),
      regenPerMin: Math.max(0, ops?.regenPerMin|0),
      hit: Math.max(0, ops?.hit|0),
      crit: Math.max(0, ops?.crit|0),
      dodge: Math.max(0, ops?.dodge|0),
    };

    let cost = 0;
    const nextLv = {
      health: p.ms.level.health + 1,
      energyCap: p.ms.level.energyCap + 1,
      regenPerMin: p.ms.level.regenPerMin + 1,
      hit: (p.pct.hitLevel || 0) + 1,
      crit: (p.pct.critLevel || 0) + 1,
      dodge: (p.pct.dodgeLevel || 0) + 1
    };
    const addCost = (stat, times) => {
      for (let i = 0; i < times; i++) { cost += upgradeCost(stat, nextLv[stat]); nextLv[stat]++; }
    };
    addCost('health', apply.health);
    addCost('energyCap', apply.energyCap);
    addCost('regenPerMin', apply.regenPerMin);
    addCost('hit', apply.hit);
    addCost('crit', apply.crit);
    addCost('dodge', apply.dodge);

    if (p.jetFuel < cost) return reply.code(400).send({ error: 'insufficient JetFuel', need: cost, have: p.jetFuel });

    p.jetFuel -= cost;

    if (apply.health) {
      p.ms.level.health += apply.health;
      p.ms.current.health = Math.min(p.ms.current.health + (1 * apply.health), 90);
    }
    if (apply.energyCap) {
      p.ms.level.energyCap += apply.energyCap;
      p.ms.current.energyCap = Math.min(p.ms.current.energyCap + (2 * apply.energyCap), 450);
      p.energy = Math.min(p.energy, p.ms.current.energyCap);
    }
    if (apply.regenPerMin) {
      p.ms.level.regenPerMin += apply.regenPerMin;
      p.ms.current.regenPerMin = Math.min(
        Math.round((p.ms.current.regenPerMin + 0.1 * apply.regenPerMin) * 10) / 10,
        5.0
      );
    }

    if (apply.hit)   { p.pct.hitLevel   = (p.pct.hitLevel   || 0) + apply.hit;   p.pct.hit   = Math.min(100, p.pct.hit   + 1 * apply.hit); }
    if (apply.crit)  { p.pct.critLevel  = (p.pct.critLevel  || 0) + apply.crit;  p.pct.crit  = Math.min(100, p.pct.crit  + 1 * apply.crit); }
    if (apply.dodge) { p.pct.dodgeLevel = (p.pct.dodgeLevel || 0) + apply.dodge; p.pct.dodge = Math.min(90,  p.pct.dodge + 1 * apply.dodge); }

    return reply.send({ ok: true, applied: apply, cost, profile: toClientProfile(p) });
  } catch (e) {
    return reply.code(e.statusCode || 400).send({ error: e.message || 'bad request' });
  }
});

// ---------- Regen ticker ----------
setInterval(() => {
  const now = Date.now();
  for (const addr of Object.keys(profiles)) {
    const p = profiles[addr];
    const dtMs = now - (p.lastTick || now);
    if (dtMs <= 0) { p.lastTick = now; continue; }
    const perSec = (p.ms.current.regenPerMin ?? 1) / 60;
    const gained = perSec * (dtMs / 1000);
    p.energy = Math.min(p.energy + gained, p.ms.current.energyCap);
    p.lastTick = now;
  }
}, 1000);

// ---------- Start ----------
app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`API listening on http://${HOST}:${PORT}`);
  app.log.info(`Allowed origins: ${ORIGINS.join(', ')}`);
});
