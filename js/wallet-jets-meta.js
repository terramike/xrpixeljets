/* XRPixel Jets — wallet-jets-meta.js (2025-11-21-jets19-ds)
   Jets-only XLS-20 loader w/ resilient IPFS + caching.
   - Filters NFTokenTaxon === 200 (Jets)
   - Accessories (taxon 201) are ignored here; handled by accessories.js
   - Parses attributes: Attack aN, Speed sN, Defense dN (N = 1..19)
   - Legendary hook: Damage Shield Per Hit → jet.damageShieldPerHit / jet.dmgShield
*/
(function(){
  const IPFS_GATEWAYS = [
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://cf-ipfs.com/ipfs/'
  ];
  const JETS_TAXON = 200;
  const metaCache = new Map(); // uriAscii -> parsed meta
  const isR = s => typeof s==='string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(s);

  // Allow stats up to 19 instead of capping at 9
  const clampStat = n => Math.max(1, Math.min(19, Number(n) || 0));

  function hexToAscii(hex){
    try{
      if (!hex) return null;
      hex = String(hex);
      if (/^0x/i.test(hex)) hex = hex.slice(2);
      if (hex.length % 2 !== 0) return null;
      const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b,16)));
      return new TextDecoder().decode(bytes);
    }catch{ return null; }
  }

  const ipfsCandidates = (uri) =>
    IPFS_GATEWAYS.map(g =>
      g + uri.replace(/^ipfs:\/\//,'').replace(/^ipfs\//,'')
    );

  const candidatesFor = (uri) => !uri
    ? []
    : (uri.startsWith('ipfs://') ? ipfsCandidates(uri) : [uri]);

  async function fetchWithFallback(urls){
    let lastErr;
    for (const u of urls){
      try{
        const r = await fetch(u, { mode:'cors' });
        if (r.ok) return await r.json();
        lastErr = new Error('HTTP '+r.status);
      }catch(e){ lastErr = e; }
    }
    throw lastErr || new Error('meta fetch failed');
  }

  function parseAttrs(arr){
    let attack=null,
        speed=null,
        defense=null,
        topGun=null,
        bottomGun=null,
        jetId=null,
        damageShieldPerHit=null;

    if (Array.isArray(arr)){
      for (const a of arr){
        const t = String(a.trait_type || a.type || '').toLowerCase();
        const rawVal = a.value;
        const v = String(rawVal ?? '').toLowerCase();

        const num = (prefix)=>{
          const m = v.match(new RegExp(`^${prefix}?(\\d+)`));
          return m ? clampStat(parseInt(m[1],10)) : null;
        };

        if (t==='attack' || t==='atk') {
          attack = num('a');
        } else if (t==='speed' || t==='spd') {
          speed = num('s');
        } else if (t==='defense' || t==='def') {
          defense = num('d');
        } else if (t==='top gun' || t==='topgun' || t==='gun_top') {
          topGun = a.value;
        } else if (t==='bottom gun' || t==='bottomgun' || t==='gun_bottom') {
          bottomGun = a.value;
        } else if (t==='xrpixeljet' || t==='jet' || t==='xrpxmj') {
          jetId = a.value;
        }
        // Legendary hook: Damage Shield on the jet itself
        else if (
          t === 'damage shield per hit' ||
          t === 'damage shield' ||
          t === 'thorns'
        ) {
          const n = Number(rawVal);
          if (Number.isFinite(n)) {
            damageShieldPerHit = clampStat(n);
          }
        }
      }
    }
    return {
      attack,
      speed,
      defense,
      topGun,
      bottomGun,
      jetId,
      damageShieldPerHit
    };
  }

  async function resolveMeta(nft){
    const uriHex = nft.URI || nft.uri || null;
    const ascii  = hexToAscii(uriHex);
    if (!ascii) return {};
    if (metaCache.has(ascii)) return metaCache.get(ascii);

    const urls = candidatesFor(ascii);
    try{
      const j = await fetchWithFallback(urls);
      const attrs  = parseAttrs(j.attributes);
      const image  = j.image || j.image_url || j.imageURI || null;
      const imgURL = image ? candidatesFor(image)[0] : null;
      const meta   = {
        meta:j,
        ...attrs,
        image:imgURL,
        name:j.name||null,
        descr:j.description||null,
        source:ascii
      };
      metaCache.set(ascii, meta);
      console.log('[JetsMeta] meta for', (nft.NFTokenID||'').slice(0,12), '→', ascii);
      return meta;
    } catch(e){
      console.warn('[JetsMeta] meta fetch failed', ascii, e);
      const fallback = {};
      metaCache.set(ascii, fallback);
      return fallback;
    }
  }

  // Fallback path when metadata is missing: map ledger fields into 1..19 band
  function fallbackStats(nft){
    const fee   = Number(nft.transfer_fee ?? nft.TransferFee ?? 0);
    const flags = Number(nft.flags ?? nft.Flags ?? 0);
    const taxon = Number(nft.nftoken_taxon ?? nft.NFTokenTaxon ?? 0);
    const toStat = (n) => {
      const x = Number(n) || 0;
      const r = x % 19;
      return r === 0 ? 19 : r;   // map into 1..19
    };
    return {
      attack:  toStat(fee),
      speed:   toStat(flags),
      defense: toStat(taxon)
    };
  }

  async function listAllNFTs(addr){
    if (!window.xrpl) throw new Error('xrpl.js not loaded');
    const client = new xrpl.Client(window.XRPL_NET || 'wss://xrplcluster.com');
    await client.connect();
    const out=[]; let marker=null;
    try{
      do{
        const req = { command:'account_nfts', account:addr, limit:400 };
        if (marker) req.marker=marker;
        const resp = await client.request(req);
        out.push(...(resp.result.account_nfts||[]));
        marker = resp.result.marker;
      } while (marker);
    } finally { try { await client.disconnect(); } catch {} }
    return out;
  }

  async function metadataAwareLoader(addr){
    if (!isR(addr)) return [];
    console.log('[JetsMeta] Loading NFTs for', addr);
    let nfts = [];
    try { nfts = await listAllNFTs(addr); }
    catch(e){
      console.error('[JetsMeta] account_nfts failed', e);
      return [];
    }
    console.log('[JetsMeta] account_nfts:', nfts.length);

    const jets = [];
    for (const nft of nfts){
      const taxon = Number(nft.NFTokenTaxon ?? nft.nftoken_taxon ?? 0);
      if (taxon !== JETS_TAXON) continue; // ← only Jets

      const meta = await resolveMeta(nft);
      const has  = (v)=> typeof v==='number' && Number.isFinite(v);

      const fb    = fallbackStats(nft);
      const atk   = has(meta.attack)  ? meta.attack  : fb.attack;
      const spd   = has(meta.speed)   ? meta.speed   : fb.speed;
      const def   = has(meta.defense) ? meta.defense : fb.defense;
      const img   = meta.image || '/jets/assets/jet.png';
      const name  = meta.name  || 'XRPixel Jet';
      const ds    = has(meta.damageShieldPerHit) ? meta.damageShieldPerHit : 0;

      jets.push({
        id: nft.NFTokenID || nft.nft_id || nft.id,
        name,
        image: img,

        attack: atk,
        speed:  spd,
        defense:def,
        atk: atk,
        spd: spd,
        def: def,

        topGun:     meta.topGun || null,
        bottomGun:  meta.bottomGun || null,
        top_gun:    meta.topGun || null,
        bottom_gun: meta.bottomGun || null,

        // Legendary DS fields
        damageShieldPerHit: ds,
        dmgShield:          ds,

        jetKey: meta.jetId || null,
        _uri:   meta.source || null,
        _meta:  meta.meta || null,
        _raw:   nft
      });
    }
    console.log('[JetsMeta] jets parsed:', jets.length);
    return jets;
  }

  window.XRPLWallet = window.XRPLWallet || {};
  window.XRPLWallet.loadXRPLJets = metadataAwareLoader;
  window.XRPLWallet.debugListNFTs = listAllNFTs;
  window.XRPLWallet.__metaLoader  = true;
})();
