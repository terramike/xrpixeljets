/* XRPixel Jets — wallet-jets-meta.js
   Multi-collection Jets loader

   Supports:
   - Original XRPixel Jets (Taxon 200)
   - LadyCafe Jets (Taxon 1938110184)

   Features:
   - IPFS metadata loading
   - LadyCafe API metadata loading
   - Bonus Attacks Per Turn
   - Damage Shield Per Hit
   - Multi-taxon support
   - Better logging
   - Safe fallbacks
*/

(function(){

  const IPFS_GATEWAYS = [
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/'
  ];

  const JETS_TAXONS = [
    200,
    1938110184
  ];

  const LADYCAFE_TAXON = 1938110184;

  const metaCache = new Map();

  const isR = s =>
    typeof s === 'string' &&
    /^r[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(s);

  const clampStat = n =>
    Math.max(1, Math.min(19, Number(n) || 0));

  function hexToAscii(hex){
    try{
      if(!hex) return null;

      hex = String(hex);

      if(/^0x/i.test(hex)){
        hex = hex.slice(2);
      }

      if(hex.length % 2 !== 0){
        return null;
      }

      const bytes = new Uint8Array(
        hex.match(/.{1,2}/g).map(x => parseInt(x,16))
      );

      return new TextDecoder().decode(bytes);

    }catch(e){
      return null;
    }
  }

  function ipfsCandidates(uri){
    const cid = uri
      .replace(/^ipfs:\/\//,'')
      .replace(/^ipfs\//,'');

    return IPFS_GATEWAYS.map(g => g + cid);
  }

  function candidatesFor(uri){

    if(!uri) return [];

    if(uri.startsWith('ipfs://')){
      return ipfsCandidates(uri);
    }

    return [uri];
  }

  async function fetchJson(url){

    const r = await fetch(url);

    if(!r.ok){
      throw new Error(`HTTP ${r.status}`);
    }

    return await r.json();
  }

  async function fetchWithFallback(urls){

    let lastErr;

    for(const url of urls){

      try{

        const r = await fetch(url);

        if(r.ok){
          return await r.json();
        }

        lastErr = new Error(`HTTP ${r.status}`);

      }catch(e){
        lastErr = e;
      }
    }

    throw lastErr || new Error('fetch failed');
  }

  function parseAttrs(arr){

    let attack = null;
    let speed = null;
    let defense = null;

    let topGun = null;
    let bottomGun = null;

    let jetId = null;

    let damageShieldPerHit = null;
    let bonusAttacksPerTurn = null;

    if(Array.isArray(arr)){

      for(const a of arr){

        const t = String(
          a.trait_type ||
          a.type ||
          ''
        ).toLowerCase().trim();

        const rawVal = a.value;

        const v = String(rawVal || '')
          .toLowerCase()
          .trim();

        const num = prefix => {

          const m = v.match(
            new RegExp(`^${prefix}?(\\d+)`)
          );

          return m
            ? clampStat(parseInt(m[1],10))
            : null;
        };

        if(t === 'attack' || t === 'atk'){
          attack = num('a');
        }

        else if(t === 'speed' || t === 'spd'){
          speed = num('s');
        }

        else if(t === 'defense' || t === 'def'){
          defense = num('d');
        }

        else if(
          t === 'top gun' ||
          t === 'topgun' ||
          t === 'gun_top'
        ){
          topGun = rawVal;
        }

        else if(
          t === 'bottom gun' ||
          t === 'bottomgun' ||
          t === 'gun_bottom'
        ){
          bottomGun = rawVal;
        }

        else if(
          t === 'xrpixeljet' ||
          t === 'jet'
        ){
          jetId = rawVal;
        }

        else if(
          t === 'damage shield per hit' ||
          t === 'damage shield' ||
          t === 'thorns'
        ){
          const n = Number(rawVal);

          if(Number.isFinite(n)){
            damageShieldPerHit = n;
          }
        }

        else if(
          t === 'bonus attacks per turn' ||
          t === 'bonus attack' ||
          t === 'extra attacks'
        ){
          const n = Number(rawVal);

          if(Number.isFinite(n)){
            bonusAttacksPerTurn = n;
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
      damageShieldPerHit,
      bonusAttacksPerTurn
    };
  }

  async function resolveLadyCafeMeta(nft){

    const cacheKey = `lady:${nft.NFTokenID}`;

    if(metaCache.has(cacheKey)){
      return metaCache.get(cacheKey);
    }

    try{

      const url =
        `https://ladycafe.io/api/nfts/token/${nft.NFTokenID}`;

      console.log(
        '[JetsMeta] LadyCafe lookup:',
        nft.NFTokenID
      );

      const j = await fetchJson(url);

      const attrs = parseAttrs(
        j.attributes ||
        j.traits ||
        j.nft?.traits ||
        []
      );

      const meta = {

        meta: j,

        ...attrs,

        image:
          j.image ||
          j.nft?.image ||
          null,

        name:
          j.name ||
          j.nft?.name ||
          'XRPixel Jet',

        descr:
          j.description ||
          j.nft?.description ||
          null,

        source: url
      };

      metaCache.set(cacheKey, meta);

      console.log(
        '[JetsMeta] LadyCafe success:',
        meta.name
      );

      return meta;

    }catch(e){

      console.warn(
        '[JetsMeta] LadyCafe failed:',
        nft.NFTokenID,
        e
      );

      // TEMPORARY HARDCODED FALLBACK for Lady Jets while CORS issue is resolved
      const fallbackMeta = {
        name: 'Lady Jet',
        image: '/jets/assets/jet.png',
        attack: 11,
        speed: 11,
        defense: 11,
        damageShieldPerHit: 3,
        bonusAttacksPerTurn: 1
      };
      console.log(
        '[JetsMeta] Using hardcoded Lady Jet fallback for',
        nft.NFTokenID
      );
      return fallbackMeta;
    }
  }

  async function resolveIPFSMeta(nft){

    const uriHex = nft.URI;

    const ascii = hexToAscii(uriHex);

    if(!ascii){
      return {};
    }

    if(metaCache.has(ascii)){
      return metaCache.get(ascii);
    }

    try{

      const urls = candidatesFor(ascii);

      const j = await fetchWithFallback(urls);

      const attrs = parseAttrs(j.attributes);

      const image =
        j.image ||
        j.image_url ||
        null;

      const imgURL =
        image
          ? candidatesFor(image)[0]
          : null;

      const meta = {

        meta: j,

        ...attrs,

        image: imgURL,

        name:
          j.name ||
          'XRPixel Jet',

        descr:
          j.description ||
          null,

        source: ascii
      };

      metaCache.set(ascii, meta);

      return meta;

    }catch(e){

      console.warn(
        '[JetsMeta] IPFS meta failed:',
        ascii,
        e
      );

      return {};
    }
  }

  function fallbackStats(nft){

    const fee =
      Number(
        nft.TransferFee ||
        nft.transfer_fee ||
        0
      );

    const flags =
      Number(
        nft.Flags ||
        nft.flags ||
        0
      );

    const taxon =
      Number(
        nft.NFTokenTaxon ||
        nft.nftoken_taxon ||
        0
      );

    const toStat = n => {

      const x = Number(n) || 0;

      const r = x % 19;

      return r === 0
        ? 19
        : r;
    };

    return {
      attack: toStat(fee),
      speed: toStat(flags),
      defense: toStat(taxon)
    };
  }

  async function listAllNFTs(addr){

    const XRPL =
      window.XRPL_LIB ||
      window.xrpl;

    const ClientCtor = XRPL?.Client;

    if(typeof ClientCtor !== 'function'){
      throw new Error(
        'xrpl Client missing'
      );
    }

    const client =
      new ClientCtor(
        window.XRPL_NET ||
        'wss://xrplcluster.com'
      );

    await client.connect();

    const out = [];

    let marker = null;

    try{

      do{

        const req = {
          command:'account_nfts',
          account:addr,
          limit:400
        };

        if(marker){
          req.marker = marker;
        }

        const resp =
          await client.request(req);

        out.push(
          ...(resp?.result?.account_nfts || [])
        );

        marker =
          resp?.result?.marker;

      }while(marker);

    }finally{

      try{
        await client.disconnect();
      }catch{}
    }

    return out;
  }

  async function metadataAwareLoader(addr){

    if(!isR(addr)){
      return [];
    }

    console.log(
      '[JetsMeta] loading wallet:',
      addr
    );

    let nfts = [];

    try{
      nfts = await listAllNFTs(addr);
    }
    catch(e){

      console.error(
        '[JetsMeta] NFT load failed',
        e
      );

      return [];
    }

    console.log(
      '[JetsMeta] total NFTs:',
      nfts.length
    );

    const jets = [];

    for(const nft of nfts){

      const taxon =
        Number(
          nft.NFTokenTaxon ||
          nft.nftoken_taxon ||
          0
        );

      if(
        !JETS_TAXONS.includes(taxon)
      ){
        continue;
      }

      let meta;

      if(taxon === LADYCAFE_TAXON){

        meta =
          await resolveLadyCafeMeta(nft);

      }else{

        meta =
          await resolveIPFSMeta(nft);
      }

      const fb =
        fallbackStats(nft);

      const atk =
        Number.isFinite(meta.attack)
          ? meta.attack
          : fb.attack;

      const spd =
        Number.isFinite(meta.speed)
          ? meta.speed
          : fb.speed;

      const def =
        Number.isFinite(meta.defense)
          ? meta.defense
          : fb.defense;

      const jet = {

        id:
          nft.NFTokenID,

        taxon:
          taxon,

        name:
          meta.name ||
          'XRPixel Jet',

        image:
          meta.image ||
          '/jets/assets/jet.png',

        attack: atk,
        speed: spd,
        defense: def,

        atk,
        spd,
        def,

        topGun:
          meta.topGun || null,

        bottomGun:
          meta.bottomGun || null,

        top_gun:
          meta.topGun || null,

        bottom_gun:
          meta.bottomGun || null,

        damageShieldPerHit:
          meta.damageShieldPerHit || 0,

        dmgShield:
          meta.damageShieldPerHit || 0,

        bonusAttacksPerTurn:
          meta.bonusAttacksPerTurn || 0,

        jetKey:
          meta.jetId || null,

        _taxon: taxon,
        _meta: meta.meta || null,
        _raw: nft
      };

      console.log(
        '[JetsMeta] loaded jet:',
        jet.name,
        'taxon:',
        taxon
      );

      jets.push(jet);
    }

    console.log(
      '[JetsMeta] final jet count:',
      jets.length
    );

    return jets;
  }

  window.XRPLWallet =
    window.XRPLWallet || {};

  window.XRPLWallet.loadXRPLJets =
    metadataAwareLoader;

  window.XRPLWallet.debugListNFTs =
    listAllNFTs;

})();