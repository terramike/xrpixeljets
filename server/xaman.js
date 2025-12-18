// server/xaman.js — 2025-12-18r2 (safe: no top-level xumm-sdk import)
import fp from 'fastify-plugin';

export default fp(async function (app) {
  const { XAMAN_API_KEY, XAMAN_API_SECRET, JETS_RETURN_WEB } = process.env;
  if (!XAMAN_API_KEY || !XAMAN_API_SECRET) {
    app.log.warn('[Xaman] Disabled (missing XAMAN_API_KEY / XAMAN_API_SECRET)');
    return;
  }

  // Lazy-load xumm-sdk only when configured
  let XummSdk;
  try {
    ({ XummSdk } = await import('xumm-sdk'));
  } catch (e) {
    app.log.error(e, '[Xaman] xumm-sdk not installed — add it to dependencies or disable plugin');
    throw e;
  }

  const sdk = new XummSdk(XAMAN_API_KEY, XAMAN_API_SECRET);

  app.post('/xaman/payload', async (req, reply) => {
    try {
      const { tx_json, options } = req.body || {};
      if (!tx_json || typeof tx_json !== 'object') {
        return reply.code(400).send({ error: 'bad_tx_json' });
      }
      const payload = await sdk.payload.create({
        txjson: tx_json,
        options: {
          submit: options?.submit ?? true,
          return_url: { web: JETS_RETURN_WEB || 'https://mykeygo.io/jets' }
        }
      });
      return reply.send({ uuid: payload.uuid, next: payload.next, refs: payload.refs });
    } catch (e) {
      req.log.error(e, '[Xaman] create failed');
      return reply.code(500).send({ error: 'xaman_create_failed' });
    }
  });

  app.get('/xaman/payload/:uuid', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const p = await sdk.payload.get(uuid);
      const resolved = !!p?.meta?.resolved;
      const signed   = !!p?.meta?.signed;
      const txid     = p?.response?.txid || p?.response?.txid_hex || null;
      const hex      = p?.response?.hex  || null;
      return reply.send({ resolved, signed, txid, hex });
    } catch (e) {
      req.log.error(e, '[Xaman] get failed');
      return reply.code(500).send({ error: 'xaman_get_failed' });
    }
  });
});
