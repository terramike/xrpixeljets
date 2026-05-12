// server/xaman.js — safe optional plugin with lazy xumm-sdk loading
import fp from 'fastify-plugin';

export default fp(async function (app) {
  const { XAMAN_API_KEY, XAMAN_API_SECRET } = process.env;
  const returnWeb =
    process.env.JETS_RETURN_WEB || process.env.WEB_BASE_URL || 'https://mykeygo.io/jets';

  if (!XAMAN_API_KEY || !XAMAN_API_SECRET) {
    app.log.warn('[Xaman] Disabled (missing XAMAN_API_KEY / XAMAN_API_SECRET)');
    return;
  }

  let XummSdk;
  try {
    ({ XummSdk } = await import('xumm-sdk'));
  } catch (error) {
    app.log.error(error, '[Xaman] xumm-sdk not installed — add it to dependencies or disable plugin');
    throw error;
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
          return_url: { web: returnWeb }
        }
      });

      return reply.send({
        uuid: payload.uuid,
        next: payload.next,
        refs: payload.refs
      });
    } catch (error) {
      req.log.error(error, '[Xaman] create failed');
      return reply.code(500).send({ error: 'xaman_create_failed' });
    }
  });

  app.get('/xaman/payload/:uuid', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const payload = await sdk.payload.get(uuid);
      return reply.send({
        resolved: !!payload?.meta?.resolved,
        signed: !!payload?.meta?.signed,
        txid: payload?.response?.txid || payload?.response?.txid_hex || null,
        hex: payload?.response?.hex || null
      });
    } catch (error) {
      req.log.error(error, '[Xaman] get failed');
      return reply.code(500).send({ error: 'xaman_get_failed' });
    }
  });
});
