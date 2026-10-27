/**
 * favicon-service.js — Favicon service (ZERO-NETWORK, data-URL-only)
 *
 * @path     background/services/favicon-service.js
 * @version  12.3.1
 * @since    v12E / v12.3E
 *
 * PURPOSE
 *   ZERO-NETWORK favicon service. Δεν κάνει fetch — capture-άρει μόνο
 *   το tab.favIconUrl (data: URL) που ο Firefox έχει ήδη φέρει internally.
 *
 *   3-level cache:
 *     • RAM cache (Map<hostname, dataUrl>, 500 entries)
 *     • storage.local cache (30d TTL)
 *     • Passive collection (tabs.onUpdated)
 *
 * KEY CONCEPTS
 *   • C3-01: ΑΦΑΙΡΕΣΗ του _fetchViaInternalApi() — το _favicon/ API
 *     δεν υπάρχει σε Firefox (Chrome-only pattern).
 *   • C3-02: Capture σε 2 events (status='complete' + favIconUrl change).
 *   • C3-03: Retry mechanism — _passiveSeen μαρκάρει μόνο data URLs.
 *   • V12E.E-FAVICON-01: MAX_DATAURL_LENGTH 10KB → 50KB (ICO-friendly).
 *
 * NON-OBVIOUS
 *   • Δεν κάνουμε network fetch. Sites που δεν έχει επισκεφθεί ο χρήστης
 *     → fallback avatar (πρώτο γράμμα hostname).
 *   • Το V12E.E-FAVICON-01 αύξησε το limit για να καλύψει multi-resolution
 *     ICO favicons (Apple, Facebook, Instagram — 20-50 KB).
 *   • _isValidDataUrl() επιστρέφει { valid, reason, length, limit } αντί
 *     boolean (V12E.E-FAVICON-01) — distinguish "not-data-url" από "too-long".
 *
 * DECISIONS
 *   D-25, D-29, D-30
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.1 (2026-09-28) — NEGATIVE CACHE INVALIDATION API
 *   ══════════════════════════════════════════════════════════════════════
 *   BUG-FIX (HIGH): Import favicons δεν εμφανίζονταν στο overlay
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Τα import handlers (background.js::importFaviconsSimple και
 *       messaging.js::handleImportFavicons) γράφουν ΑΠΕΥΘΕΙΑΣ στο
 *       storage.local — ΔΕΝ περνούν από _writeStorageCache(). Έτσι
 *       το _negativeCache (FIX-4 v12.3.0) δεν invalidated.
 *
 *       ΑΠΟΤΕΛΕΣΜΑ (από logs):
 *         14:46:02  getFavicon(x.com) → No favicon → negative-cached 300s
 *         14:46:14  Import 86 favicons → storage.local updated
 *         14:46:19  getFavicon(x.com) → NEGATIVE CACHE HIT → null ❌
 *
 *       Παρόλο που το storage είχε το favicon, το negative cache
 *       επέστρεφε null για 5 λεπτά. Το overlay έδειχνε fallback
 *       avatars αντί για τα imported favicons.
 *
 *     ΛΥΣΗ:
 *       • Νέα public API: invalidateNegativeCache(hostname?)
 *       • Καλείται από τους 2 import handlers (background + messaging)
 *       • Bonus: broadcast faviconUpdate σε ανοιχτά overlays
 *         (για άμεση ενημέρωση των client-side RAM caches)
 *
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — NEGATIVE CACHE + BROADCAST EXCLUDE
 *   ══════════════════════════════════════════════════════════════════════
 *   FIX-4 (MEDIUM): Server-side negative cache (5min TTL)
 *     • _negativeCache Map<hostname, expiryTimestamp>
 *     • NEGATIVE_TTL_MS = 5 * 60 * 1000
 *     • Invalidation: passive capture + manual API (v12.3.1)
 *
 *   FIX-3 (LOW): _broadcastFavicon excludePort parameter
 *     • Consistency με _broadcastMutationToOthers
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "favicon-service"
 */

var CBF_FAVICON = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const RAM_CACHE_MAX      = 500;
  const STORAGE_TTL_MS     = 30 * 24 * 60 * 60 * 1000;   // 30 ημέρες

  // V12E.E-FAVICON-01: 10 KB → 50 KB (ICO-friendly)
  const MAX_DATAURL_LENGTH = 50 * 1024;

  // C3-03: Delay για deferred retry
  const DEFERRED_RETRY_MS  = 500;

  // 🔧 v12.3.0 FIX-4: Negative cache TTL
  const NEGATIVE_TTL_MS = 5 * 60 * 1000;   // 5 λεπτά

  // ============================================================
  //  RAM cache
  // ============================================================
  const ramCache = new Map();   // hostname → dataUrl

  // 🔧 v12.3.0 FIX-4: Negative cache
  const _negativeCache = new Map();   // hostname → expiry timestamp

  // ============================================================
  //  Passive collection state
  // ============================================================
  let _passiveListener = null;
  const _passiveSeen = new Set();

  const _deferredRetries = new Map();

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[FAVICON]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[FAVICON]', ...a); }
  function err(...a)  { CBF_LOGGER.error('[FAVICON]', ...a); }

  // ============================================================
  //  Hostname extraction
  // ============================================================
  function _getHostname(url) {
    try {
      const u = new URL(url);
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return null;
    }
  }

  // ============================================================
  //  V12E.E-FAVICON-01: data: URL validation
  // ============================================================
  function _isValidDataUrl(url) {
    if (typeof url !== 'string') {
      return { valid: false, reason: 'not-string' };
    }
    if (!url.startsWith('data:image/')) {
      return { valid: false, reason: 'not-data-url' };
    }
    if (url.length > MAX_DATAURL_LENGTH) {
      return {
        valid: false,
        reason: 'too-long',
        length: url.length,
        limit: MAX_DATAURL_LENGTH
      };
    }
    return { valid: true };
  }

  // ============================================================
  //  storage.local cache
  // ============================================================
  function _storageKey(hostname) {
    return `favicon_${hostname}`;
  }

  async function _readStorageCache(hostname) {
    try {
      const key = _storageKey(hostname);
      const res = await browser.storage.local.get(key);
      const entry = res[key];

      if (!entry) return null;

      // Legacy format: raw string
      if (typeof entry === 'string') {
        if (!entry.startsWith('data:image/')) return null;
        if (entry.length > MAX_DATAURL_LENGTH) {
          warn(`_readStorageCache: legacy entry too large, removing: ${hostname} (${entry.length} bytes)`);
          try { await browser.storage.local.remove(key); } catch (_) {}
          return null;
        }
        return entry;
      }

      // Current format: { dataUrl, fetchedAt }
      if (entry && typeof entry === 'object' && entry.dataUrl) {
        const age = Date.now() - (entry.fetchedAt || 0);
        if (age > STORAGE_TTL_MS) {
          try { await browser.storage.local.remove(key); } catch (_) {}
          return null;
        }
        if (!entry.dataUrl.startsWith('data:image/')) return null;

        if (entry.dataUrl.length > MAX_DATAURL_LENGTH) {
          warn(`_readStorageCache: entry too large, removing: ${hostname} (${entry.dataUrl.length} bytes)`);
          try { await browser.storage.local.remove(key); } catch (_) {}
          return null;
        }

        return entry.dataUrl;
      }

      return null;
    } catch (e) {
      warn('storage cache read failed:', e.message);
      return null;
    }
  }

  async function _writeStorageCache(hostname, dataUrl) {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        warn(`_writeStorageCache: invalid dataUrl for ${hostname}`);
        return;
      }
      if (dataUrl.length > MAX_DATAURL_LENGTH) {
        warn(
          `_writeStorageCache: dataUrl rejected for ${hostname} ` +
          `(size=${dataUrl.length} > limit=${MAX_DATAURL_LENGTH})`
        );
        return;
      }

      const key = _storageKey(hostname);
      await browser.storage.local.set({
        [key]: { dataUrl, fetchedAt: Date.now() }
      });

      // 🔧 v12.3.1: Auto-invalidate negative cache σε κάθε write
      _negativeCache.delete(hostname);
    } catch (e) {
      warn('storage cache write failed:', e.message);
    }
  }

  // ============================================================
  //  RAM cache
  // ============================================================
  function _readRamCache(hostname) {
    return ramCache.get(hostname) || null;
  }

  function _writeRamCache(hostname, dataUrl) {
    if (ramCache.size >= RAM_CACHE_MAX) {
      const firstKey = ramCache.keys().next().value;
      if (firstKey !== undefined) ramCache.delete(firstKey);
    }
    ramCache.set(hostname, dataUrl);
  }

  // ============================================================
  //  Broadcast favicon σε όλα τα overlays
  // ============================================================
  function _broadcastFavicon(hostname, dataUrl, color, excludePort = null) {
    try {
      if (typeof CBF_SESSION === 'undefined' ||
          typeof CBF_MESSAGING === 'undefined') return;

      const ports = CBF_SESSION.getAllPorts();
      for (const port of ports) {
        if (port === excludePort) continue;
        const state = CBF_SESSION.getPortState(port);
        if (!state || !state.sessionId) continue;

        CBF_MESSAGING.sendTo(port, state.sessionId, 'faviconUpdate', {
          hostname, dataUrl, color: color || null
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // ============================================================
  //  🔧 v12.3.1 NEW: Invalidate negative cache
  //
  //  Καλείται από import handlers ώστε το επόμενο getFavicon να μην
  //  πάρει negative cache hit για hostnames που μόλις εισήχθησαν.
  //
  //  @param {string|null} hostname
  //    - null (default)  → clear ΟΛΟΚΛΗΡΟ το negative cache
  //    - string          → delete μόνο αυτό το hostname
  //
  //  @returns {number} — πόσα entries διαγράφηκαν
  // ============================================================
  function invalidateNegativeCache(hostname = null) {
    if (hostname && typeof hostname === 'string') {
      const deleted = _negativeCache.delete(hostname) ? 1 : 0;
      if (deleted) log(`invalidateNegativeCache: removed ${hostname}`);
      return deleted;
    }

    const size = _negativeCache.size;
    _negativeCache.clear();
    if (size > 0) {
      log(`invalidateNegativeCache: cleared ${size} entries`);
    }
    return size;
  }

  // ============================================================
  //  🔧 v12.3.1 NEW: Manual RAM cache write
  //
  //  Επιτρέπει σε import handlers να ενημερώσουν το RAM cache χωρίς
  //  full fetch. Δεν καλείται απευθείας από χρήστες — είναι helper.
  // ============================================================
  function _writeRamCacheExternal(hostname, dataUrl) {
    if (typeof hostname !== 'string' || !hostname) return false;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
    if (dataUrl.length > MAX_DATAURL_LENGTH) return false;

    _writeRamCache(hostname, dataUrl);
    _negativeCache.delete(hostname);
    return true;
  }

  // ============================================================
  //  getFavicon — κύριο API (ZERO-NETWORK)
  // ============================================================
  async function getFavicon(url) {
    const hostname = _getHostname(url);
    if (!hostname) {
      warn('Invalid URL for favicon:', typeof url);
      return null;
    }

    // RAM cache
    const ramHit = _readRamCache(hostname);
    if (ramHit) {
      log(`RAM cache hit: ${hostname}`);
      return ramHit;
    }

    // 🔧 v12.3.0 FIX-4: negative cache check
    const negExpiry = _negativeCache.get(hostname);
    if (negExpiry) {
      if (Date.now() < negExpiry) {
        log(`Negative cache hit: ${hostname}`);
        return null;
      }
      _negativeCache.delete(hostname);
    }

    // storage.local cache
    const storageHit = await _readStorageCache(hostname);
    if (storageHit) {
      _writeRamCache(hostname, storageHit);
      log(`Storage cache hit: ${hostname}`);
      return storageHit;
    }

    // C3-01: NO fallback fetch
    _negativeCache.set(hostname, Date.now() + NEGATIVE_TTL_MS);
    log(`No favicon for ${hostname} — will be collected passively on visit (negative-cached ${NEGATIVE_TTL_MS / 1000}s)`);
    return null;
  }

  // ============================================================
  //  Passive collection
  // ============================================================
  async function _collectFaviconFromTab(tabId, tab) {
    try {
      if (!tab || !tab.url) return;
      if (!/^https?:/i.test(tab.url)) return;

      const hostname = _getHostname(tab.url);
      if (!hostname) return;

      if (_passiveSeen.has(hostname)) return;
      if (_readRamCache(hostname)) {
        _passiveSeen.add(hostname);
        return;
      }

      const favIconUrl = tab.favIconUrl;
      if (!favIconUrl) return;

      const dataUrlCheck = _isValidDataUrl(favIconUrl);

      if (!dataUrlCheck.valid) {
        if (dataUrlCheck.reason === 'too-long') {
          log(
            `Skipping ${hostname} favIconUrl (size ${dataUrlCheck.length} > limit ${dataUrlCheck.limit}): ` +
            `${favIconUrl.slice(0, 30)}...`
          );
        } else if (dataUrlCheck.reason === 'not-data-url') {
          log(
            `Skipping ${hostname} favIconUrl (not data URL yet): ` +
            `${favIconUrl.slice(0, 30)}...`
          );
        } else {
          log(`Skipping ${hostname} favIconUrl (invalid: ${dataUrlCheck.reason})`);
        }
        return;
      }

      // Capture!
      log(`Passive capture: ${hostname} (${favIconUrl.length} bytes)`);

      _writeRamCache(hostname, favIconUrl);
      await _writeStorageCache(hostname, favIconUrl);   // auto-invalidates negative
      _passiveSeen.add(hostname);

      _broadcastFavicon(hostname, favIconUrl, null, null);

    } catch (e) {
      warn('_collectFaviconFromTab failed:', e.message);
    }
  }

  function startPassiveCollection() {
    if (_passiveListener) {
      log('Passive collection already running');
      return;
    }

    if (typeof browser === 'undefined' ||
        !browser.tabs ||
        typeof browser.tabs.onUpdated === 'undefined') {
      warn('tabs API not available — passive collection disabled');
      return;
    }

    _passiveListener = (tabId, changeInfo, tab) => {
      const shouldTry =
        changeInfo.status === 'complete' ||
        (changeInfo.favIconUrl !== undefined);

      if (!shouldTry) return;
      if (!tab || !tab.url) return;
      if (!/^https?:/i.test(tab.url)) return;

      _collectFaviconFromTab(tabId, tab).catch(() => {});
    };

    browser.tabs.onUpdated.addListener(_passiveListener);
    log('Passive collection started (tabs.onUpdated — data URL only, ZERO-NETWORK)');
  }

  function stopPassiveCollection() {
    if (_passiveListener) {
      try { browser.tabs.onUpdated.removeListener(_passiveListener); } catch (_) {}
      _passiveListener = null;
      log('Passive collection stopped');
    }

    for (const timeoutId of _deferredRetries.values()) {
      try { clearTimeout(timeoutId); } catch (_) {}
    }
    _deferredRetries.clear();
  }

  function isPassiveCollectionRunning() {
    return _passiveListener !== null;
  }

  // ============================================================
  //  Cache maintenance
  // ============================================================
  async function cleanupExpired() {
    try {
      const all = await browser.storage.local.get(null);
      const now = Date.now();
      const toRemove = [];

      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith('favicon_')) continue;
        if (key.startsWith('favicon_color_')) continue;

        if (value && typeof value === 'object' && value.fetchedAt) {
          if (now - value.fetchedAt > STORAGE_TTL_MS) {
            toRemove.push(key);
            continue;
          }
          if (value.dataUrl && value.dataUrl.length > MAX_DATAURL_LENGTH) {
            warn(`cleanupExpired: oversized entry ${key}`);
            toRemove.push(key);
          }
        }
      }

      if (toRemove.length > 0) {
        await browser.storage.local.remove(toRemove);
        log(`Cleanup: removed ${toRemove.length} expired/oversized entries`);
      }

      // Cleanup expired negative cache
      const now2 = Date.now();
      let negCleaned = 0;
      for (const [hostname, expiry] of _negativeCache.entries()) {
        if (now2 >= expiry) {
          _negativeCache.delete(hostname);
          negCleaned++;
        }
      }
      if (negCleaned > 0) {
        log(`Cleanup: removed ${negCleaned} expired negative-cache entries`);
      }

      return toRemove.length;
    } catch (e) {
      warn('cleanupExpired failed:', e.message);
      return 0;
    }
  }

  function clearRamCache() {
    const size = ramCache.size;
    ramCache.clear();
    log(`RAM cache cleared (${size} entries)`);
    return size;
  }

  async function clearAll() {
    clearRamCache();
    _passiveSeen.clear();
    _negativeCache.clear();

    try {
      const all = await browser.storage.local.get(null);
      const toRemove = Object.keys(all).filter(k =>
        k.startsWith('favicon_') && !k.startsWith('favicon_color_')
      );
      if (toRemove.length > 0) {
        await browser.storage.local.remove(toRemove);
      }
      log(`Storage cache cleared (${toRemove.length} entries)`);
      return toRemove.length;
    } catch (e) {
      warn('clearAll storage failed:', e.message);
      return 0;
    }
  }

  function ramCacheSize() { return ramCache.size; }

  function getStats() {
    return {
      ramCacheSize: ramCache.size,
      passiveSeenSize: _passiveSeen.size,
      passiveRunning: _passiveListener !== null,
      deferredRetries: _deferredRetries.size,
      negativeCacheSize: _negativeCache.size,
      maxDataUrlLength: MAX_DATAURL_LENGTH,
      negativeTtlMs: NEGATIVE_TTL_MS
    };
  }

  // Periodic cleanup — κάθε 24h
  setInterval(() => {
    cleanupExpired().catch(() => {});
  }, 24 * 60 * 60 * 1000);

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    getFavicon,

    startPassiveCollection,
    stopPassiveCollection,
    isPassiveCollectionRunning,

    cleanupExpired,
    clearRamCache,
    clearAll,
    ramCacheSize,
    getStats,

    // 🔧 v12.3.1 NEW: public invalidation API
    invalidateNegativeCache,

    STORAGE_TTL_MS,
    MAX_DATAURL_LENGTH,
    RAM_CACHE_MAX,
    DEFERRED_RETRY_MS,
    NEGATIVE_TTL_MS,

    _internal: {
      _getHostname,
      _isValidDataUrl,
      _storageKey,
      _readStorageCache,
      _writeStorageCache,
      _readRamCache,
      _writeRamCache,
      _writeRamCacheExternal,   // 🔧 v12.3.1
      _broadcastFavicon,
      _collectFaviconFromTab,
      _negativeCache
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_FAVICON = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FAVICON = api;

  if (typeof CBF_LOGGER !== 'undefined') {
      CBF_LOGGER.info(
      'Favicon Service ready (v12.3.1: ZERO-NETWORK — tab.favIconUrl data URLs only, ' +
      'no _favicon/ (Firefox has no equivalent), ' +
      'MAX_DATAURL_LENGTH=50KB (ICO-friendly), ' +
      'negative cache (5min TTL) + invalidateNegativeCache API, ' +
      'broadcast excludePort, 0 DNS, 0 HTTP, 0 leak)'
    );
  }

  return api;
})();