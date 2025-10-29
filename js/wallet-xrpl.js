/* XRPixel Jets — wallet-jets-meta.js (2025-10-28fix1)
   Metadata-aware loader for XLS-20 NFTs with resilient IPFS gateways + caching.
   - Fetches account_nfts (mainnet)
   - Resolves NFT URI (hex → ascii; ipfs:// → http gateways)
   - Parses attributes: Attack aN, Speed sN, Defense dN (N = 1..9), Top/Bottom Gun, Jet ID
   - Exposes camelCase + snake_case fields for UI compatibility
*/
(function(){
  const IPFS_GATEWAYS = [
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/'
  ];
  const metaCache = new Map(); // uriAscii -> parsed meta

  const isR = s => typeof s==='string' && /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(s);
  const clamp19 = n => Math.max(1, Math.min(9, Number(n)||0));

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

  function ipfsCandidates(uri){
    const cleaned = uri.replace(/^ipfs:\/\//,'').replace(/^ipfs\//,'');
    return IPFS_GATEWAYS.map(g => g + cleaned);
  }
  function candidatesFor(uri){
    if (!uri) return [];
    if (uri.startsWith('ipfs://')) return ipfsCandidates(uri);
    return [uri];
  }

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
    let attack=null,speed=null,defense=null,topGun=null,bottomGun=null,jetId=null;
    if (Array.isArray(arr)){
      for (const a of arr){
        const t = String(a.trait_type || a.type || '').toLowerCase();
        const v = String(a.value || '').toLowerCase();
        const num = (prefix)=>{
          const m = v.match(new RegExp(`^${prefix}?(\\d+)`));
          return m ? clamp19(parseInt(m[1],10)) : null;
        };
        if (t==='attack' || t==='atk') attack = num('a');
        else if (t==='speed' || t==='spd') speed = num('s');
        else if (t==='defense' || t==='def') defense = num('d');
        else if (t==='top gun' || t==='topgun' || t==='gun_top') topGun = a.value;
        else if (t==='bottom gun' || t==='bottomgun' || t==='gun_bottom') bottomGun = a.value;
        else if (t==='xrpixeljet' || t==='jet' || t==='xrpxmj') jetId = a.value;
      }
    }
    return { attack, speed, defense, topGun, bottomGun, jetId };
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
      const imgURL = image ? candidatesFor(image)[0] : null; // rewrite ipfs:// to first gateway
      const meta   = { meta:j, ...attrs, image:imgURL, name:j.name||null, descr:j.description||null, source:ascii };
      metaCache.set(ascii, meta);
      console.log('[JetsMeta] using metadata for', (nft.NFTokenID||'').slice(0,12), '→', ascii);
      return meta;
    } catch(e){
      console.warn('[JetsMeta] meta fetch failed', ascii, e);
      const fallback = {};
      metaCache.set(ascii, fallback);
      return fallback;
    }
  }

  function fallbackStats(nft){
    const fee   = Number(nft.transfer_fee ?? nft.TransferFee ?? 0);
    const flags = Number(nft.flags ?? nft.Flags ?? 0);
    const taxon = Number(nft.nftoken_taxon ?? nft.NFTokenTaxon ?? 0);
    const to19  = (n)=> ((n % 9) + 1); // map to 1..9, not 5..14
    return { attack: to19(fee), speed: to19(flags), defense: to19(taxon) };
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
        const rows = (resp.result.account_nfts||[]);
        out.push(...rows);                       // ← fixed (no stray ".")
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
    catch(e){ console.error('[JetsMeta] account_nfts failed', e); return []; }
    console.log('[JetsMeta] account_nfts:', nfts.length);

    const jets = [];
    for (const nft of nfts){
      const meta = await resolveMeta(nft);
      const has  = (v)=> typeof v==='number' && Number.isFinite(v);

      // Prefer on-metadata a/s/d; fall back to 1..9 derived
      const fb    = fallbackStats(nft);
      const atk   = has(meta.attack)  ? meta.attack  : fb.attack;
      const spd   = has(meta.speed)   ? meta.speed   : fb.speed;
      const def   = has(meta.defense) ? meta.defense : fb.defense;
      const img   = meta.image || '/jets/assets/jet.png';
      const name  = meta.name  || 'XRPixel Jet';

      jets.push({
        id: nft.NFTokenID || nft.nft_id || nft.id,
        name, image: img,
        attack: atk, speed: spd, defense: def,
        atk: atk, spd: spd, def: def,           // aliases for calc
        topGun: meta.topGun || null,
        bottomGun: meta.bottomGun || null,
        top_gun: meta.topGun || null,           // snake_case for older UI
        bottom_gun: meta.bottomGun || null,
        jetKey: meta.jetId || null,
        _uri: meta.source || null,
        _meta: meta.meta || null,
        _raw: nft
      });
    }
    console.log('[JetsMeta] jets parsed:', jets.length);
    return jets;
  }

  window.XRPLWallet = window.XRPLWallet || {};
  window.XRPLWallet.loadXRPLJets = metadataAwareLoader;   // override basic loader
  window.XRPLWallet.debugListNFTs = listAllNFTs;
  window.XRPLWallet.__metaLoader  = true;
})();
