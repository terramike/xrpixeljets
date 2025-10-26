// claimJetFuel.js — XRPixel Jets (2025-10-25claim2)
// Defaults to MOCK so unconfigured servers never 500. HOT mode supports IOU or XRP payouts.
// Emits { ok:true, txid? } on success, or throws 'trustline_required' error for IOU sans TL.

export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase(); // default mock
  const WSS  = process.env.XRPL_WSS || process.env.NETWORK || 'wss://s.altnet.rippletest.net:51233';
  const CODE_ASCII = process.env.CURRENCY_CODE || process.env.CURRENCY || 'JFUEL';
  const CODE_HEX   = (process.env.CURRENCY_HEX || '').toUpperCase();
  const ISSUER     = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';
  const HOT_SEED   = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';

  const currencyField = () => {
    if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
    if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII;
    return Buffer.from(CODE_ASCII, 'ascii').toString('hex').padEnd(40,'0').slice(0,40).toUpperCase();
  };
  const SHAPE = (txid=null, txJSON=null) => ({ ok:true, txid, txJSON });

  // MOCK — return success, no tx
  if (MODE === 'mock') return SHAPE(null, null);

  // HOT — server signs & submits
  if (MODE === 'hot') {
    if (!HOT_SEED) throw new Error('hot_wallet_missing');
    const xrpl = await import('xrpl').catch(() => null);
    if (!xrpl) throw new Error('xrpl_not_installed');

    const client = new xrpl.Client(WSS);
    await client.connect();
    try {
      const wallet = xrpl.Wallet.fromSeed(HOT_SEED, { algorithm: 'secp256k1' });

      // IOU path (needs trustline)
      if (CODE_HEX || (CODE_ASCII && CODE_ASCII !== 'XRP')) {
        if (!ISSUER) throw new Error('issuer_missing');

        // trustline check
        const lines = await client.request({ method: 'account_lines', account: to, ledger_index: 'validated' });
        const cur = currencyField();
        const hasLine = (lines?.result?.lines || []).some(l => (l.account === ISSUER) && (String(l.currency).toUpperCase() === cur));
        if (!hasLine) throw Object.assign(new Error('trustline_required'), { code: 'trustline_required' });

        const tx = await client.autofill({
          TransactionType: 'Payment',
          Account: wallet.address,
          Destination: to,
          Amount: { currency: cur, issuer: ISSUER, value: String(amount) }
        });
        const { tx_blob } = wallet.sign(tx);
        const sub = await client.submitAndWait(tx_blob);
        const txid = sub?.result?.hash || sub?.result?.tx_json?.hash || null;
        return SHAPE(txid, null);
      }

      // XRP path
      const tx = await client.autofill({
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: to,
        Amount: xrpl.xrpToDrops(String(amount))
      });
      const { tx_blob } = wallet.sign(tx);
      const sub = await client.submitAndWait(tx_blob);
      const txid = sub?.result?.hash || sub?.result?.tx_json?.hash || null;
      return SHAPE(txid, null);
    } finally {
      try { await client.disconnect(); } catch {}
    }
  }

  // PREPARE (debug): return txJSON for inspection (issuer-send; not user-signable)
  if (MODE === 'prepare') {
    const tx = (CODE_HEX || CODE_ASCII !== 'XRP')
      ? { TransactionType:'Payment', Account: ISSUER || 'r'+'0'.repeat(25), Destination: to,
          Amount: { currency: currencyField(), issuer: ISSUER, value: String(amount) } }
      : { TransactionType:'Payment', Account: 'r'+'0'.repeat(25), Destination: to,
          Amount: String(Math.trunc(Number(amount)*1_000_000)) };
    return SHAPE(null, tx);
  }

  // Unknown mode → behave like mock
  return SHAPE(null, null);
}
