(function initJetsRuntimeConfig(globalScope) {
  const pick = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim().replace(/\/+$/, '');
      }
    }
    return '';
  };

  const resolveOrigin = (value) => {
    try {
      return new URL(value, globalScope.location?.href || 'http://localhost').origin;
    } catch {
      return '';
    }
  };

  const config = globalScope.XRPIXELJETS_CONFIG || {};
  const defaultWebBase = 'https://mykeygo.io/jets';
  const defaultApiBase = 'https://xrpixeljets.onrender.com';
  const defaultClientAssetBase =
    globalScope.location?.origin ? `${globalScope.location.origin}/js` : '/js';

  const webBase = pick(config.WEB_BASE_URL, globalScope.JETS_WEB_BASE, defaultWebBase) || defaultWebBase;
  const clientAssetBase =
    pick(config.CLIENT_ASSET_BASE_URL, globalScope.JETS_CLIENT_ASSET_BASE, defaultClientAssetBase) ||
    defaultClientAssetBase;
  const apiBase = pick(config.API_BASE_URL, globalScope.JETS_API_BASE, defaultApiBase) || defaultApiBase;
  const iconUrl = config.ICON_URL || globalScope.JETS_ICON_URL || `${webBase}/assets/favicon.png`;
  const placeholderImg =
    config.PLACEHOLDER_IMG || globalScope.JETS_PLACEHOLDER_IMG || `${webBase}/assets/ghost.png`;
  const registryUrl = config.REGISTRY_URL || globalScope.JETS_REGISTRY_URL || `${webBase}/registry.json`;
  const returnWeb = pick(config.RETURN_WEB_URL, globalScope.JETS_RETURN_WEB, webBase) || webBase;
  const defaultOrigins = [resolveOrigin(webBase)].filter(Boolean);

  globalScope.JETS_WEB_BASE = webBase;
  globalScope.JETS_CLIENT_ASSET_BASE = clientAssetBase;
  globalScope.JETS_API_BASE = apiBase;
  globalScope.JETS_ICON_URL = iconUrl;
  globalScope.JETS_PLACEHOLDER_IMG = placeholderImg;
  globalScope.JETS_REGISTRY_URL = registryUrl;
  globalScope.JETS_RETURN_WEB = returnWeb;
  globalScope.JETS_ALLOWED_WEB_ORIGINS =
    Array.isArray(config.ALLOWED_WEB_ORIGINS) && config.ALLOWED_WEB_ORIGINS.length
      ? config.ALLOWED_WEB_ORIGINS
      : defaultOrigins;
})(window);
