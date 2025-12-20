// claimJetFuel.js — XRPixel Jets (2025-10-31rel2-mainnet-default + soft-algo-probe)
// Base: 2025-10-26-path-fallback3
export async function sendIssued({ to, amount }) {
  const MODE = (process.env.TOKEN_MODE || 'mock').toLowerCase(); // 'mock' | 'hot' | 'prepare'
  const WSS  = process.env.XRPL_WSS || process.env.NETWORK || 'wss://xrplcluster.com';

  const RAW_CODE   = (process.env.CURRENCY_CODE || process.env.CURRENCY || 'JFUEL');
  const CODE_ASCII = RAW_CODE.replace(/^\$/, '');
  const CODE_HEX   = (process.env.CURRENCY_HEX || '').toUpperCase();
  const ISSUER     = process.env.ISSUER_ADDRESS || process.env.ISSUER_ADDR || '';
  const HOT_SEED   = process.env.HOT_WALLET_SEED || process.env.HOT_SEED || '';
  const ISSUER_SEED= process.env.ISSUER_SEED || '';

  const isIOU = !!CODE_HEX || (CODE_ASCII && CODE_ASCII.toUpperCase() !== 'XRP');

  const currencyField = () => {
    if (CODE_HEX && /^[A-F0-9]{40}$/i.test(CODE_HEX)) return CODE_HEX;
    if (/^[A-Z0-9]{3}$/.test(CODE_ASCII)) return CODE_ASCII.toUpperCase();
    return Buffer.from(CODE_ASCII, 'ascii').toString('hex').padEnd(40,'0').slice(0,40).toUpperCase();
  };
  const SHAPE = (txid=null, txJSON=null) => ({ ok:true, txid, txJSON });

  if (MODE === 'mock')    return SHAPE(null, null);
  if (MODE === 'prepare') {
    const tx = isIOU
      ? { TransactionType:'Payment', Account: ISSUER || 'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Destination: to,
          Amount:{ currency: currencyField(), issuer: ISSUER, value: String(amount) } }
      : { TransactionType:'Payment', Account:'rrrrrrrrrrrrrrrrrrrrrhoLvTp', Destination: to,
          Amount: String(Math.trunc(Number(amount)*1_000_000)) };
    return SHAPE(null, tx);
  }
  if (MODE !== 'hot')     return SHAPE(null, null);
  if (!HOT_SEED && !ISSUER_SEED) throw new Error('hot_wallet_missing');

  const xrpl = await import('xrpl').catch(() => null);
  if (!xrpl) throw new Error('xrpl_not_installed');

  // Soft probe (no throw): log if HOT_SEED is Ed25519 to help ops, but do not block
  try {
    const probe = xrpl.Wallet.fromSeed(HOT_SEED || ISSUER_SEED);
    if ((probe.publicKey||'').toUpperCase().startsWith('ED')) {
      console.warn('[Jets] HOT_WALLET_SEED appears to be Ed25519 (soft warning).');
    }
  } catch {}

  const client = new xrpl.Client(WSS);
  await client.connect();
  try {
    const cur = currencyField();

    async function signSubmitAndCheck(wallet, tx) {
      const prepared = await client.autofill(tx);
      const { tx_blob } = wallet.sign(prepared);
      const sub = await client.submitAndWait(tx_blob);
      const eng = sub?.result?.engine_result || sub?.engine_result || sub?.meta?.TransactionResult || 'tesSUCCESS';
      const hash = sub?.result?.hash || sub?.result?.tx_json?.hash || null;
      return { eng, hash };
    }

    if (isIOU) {
      if (!ISSUER) throw new Error('issuer_missing');

      const destLines = await client.request({ method:'account_lines', account: to, ledger_index:'validated' });
      const destHasTL = (destLines?.result?.lines || []).some(l => l.account === ISSUER && String(l.currency).toUpperCase() === cur);
      if (!destHasTL) throw Object.assign(new Error('trustline_required'), { code:'trustline_required' });

      const hot = xrpl.Wallet.fromSeed(HOT_SEED || ISSUER_SEED, { algorithm:'secp256k1' });
      const signingAsIssuer = (hot.address === ISSUER);

      if (!signingAsIssuer) {
        const hotLines = await client.request({ method:'account_lines', account: hot.address, ledger_index:'validated' });
        const hotTL = (hotLines?.result?.lines || []).find(l => l.account === ISSUER && String(l.currency).toUpperCase() === cur);
        if (!hotTL) throw Object.assign(new Error('hot_wallet_needs_trustline'), { code:'hot_wallet_needs_trustline' });
        const bal = Number(hotTL.balance || 0);
        if (!Number.isFinite(bal) || bal < Number(amount)) throw Object.assign(new Error('hot_wallet_no_inventory'), { code:'hot_wallet_no_inventory' });
      }

      const tx = {
        TransactionType: 'Payment',
        Account: hot.address,
        Destination: to,
        Amount: { currency: cur, issuer: ISSUER, value: String(amount) },
        Flags: 0
      };

      let { eng, hash } = await signSubmitAndCheck(hot, tx);

      if (eng === 'tecPATH_PARTIAL' && ISSUER_SEED) {
        const issuerW = xrpl.Wallet.fromSeed(ISSUER_SEED, { algorithm:'secp256k1' });
        const res2 = await signSubmitAndCheck(issuerW, { ...tx, Account: issuerW.address });
        eng = res2.eng; hash = res2.hash;
      }

      if (eng !== 'tesSUCCESS') {
        if (eng === 'tecPATH_PARTIAL') throw new Error('path_liquidity');
        throw new Error('claim_failed_engine_'+eng);
      }
      return SHAPE(hash, null);
    }

    const wallet = xrpl.Wallet.fromSeed(HOT_SEED || ISSUER_SEED, { algorithm:'secp256k1' });
    const res = await signSubmitAndCheck(wallet, {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: to,
      Amount: xrpl.xrpToDrops(String(amount)),
      Flags: 0
    });
    if (res.eng !== 'tesSUCCESS') throw new Error('claim_failed_engine_'+res.eng);
    return SHAPE(res.hash, null);
  } finally {
    try { await client.disconnect(); } catch {}
  }
}
