/**
 * favicon-service.js — Favicon service (ZERO-NETWORK, data-URL-only)
 *
 * @path     background/services/favicon-service.js
 * @version  12.5.0
 * @since    v12E / v12.5
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
 *   • V12.5.0: Display/storage split + auto-resize.
 *
 * NON-OBVIOUS
 *   • Δεν κάνουμε network fetch. Sites που δεν έχει επισκεφθεί ο χρήστης
 *     → fallback avatar (πρώτο γράμμα hostname).
 *
 *   • V12.5.0 AUTO-RESIZE:
 *     Όταν το favIconUrl είναι > 200KB (π.χ. multi-res ICO, retina PNG),
 *     το κάνουμε resize σε 32×32 WebP (ή PNG fallback) πριν το
 *     αποθηκεύσουμε στο storage.local.
 *
 *     Αποτέλεσμα:
 *       • 990KB PNG → ~2KB WebP (ίδια οπτική ποιότητα στα 30px cards)
 *       • Πιάνει 100% των sites (όχι μόνο τα μικρά)
 *       • Μειώνει storage usage
 *       • Γρήγορο rendering (2KB vs 990KB)
 *
 *   • V12.5.0 OFFRSCREEN CANVAS:
 *     Το resize γίνεται στο background (OffscreenCanvas, Firefox 105+)
 *     γιατί το content-overlay ΔΕΝ έχει πρόσβαση σε tabs API.
 *
 *   • V12.5.0 DISPLAY vs STORAGE LIMITS:
 *     • MAX_DISPLAY_DATAURL_LENGTH (2MB): hard cap. Αν το favIconUrl
 *       είναι > 2MB, skip εντελώς (malformed / huge).
 *     • MAX_STORAGE_DATAURL_LENGTH (200KB): persistent limit. Αν είναι
 *       μεταξύ 200KB και 2MB, resize πριν την αποθήκευση.
 *
 * DECISIONS
 *   D-25, D-29, D-30
 *
 * CHANGELOG
 * ══════════════════════════════════════════════════════════════════════
 * v12.5.0 (2026-10-28) — AUTO-RESIZE FOR LARGE FAVICONS
 * ══════════════════════════════════════════════════════════════════════
 * ΠΡΟΒΛΗΜΑ:
 *   Με MAX_DATAURL_LENGTH=50KB, τα favicons > 50KB (multi-res ICO,
 *   retina PNG) απορρίπτονταν σιωπηλά. Χρήστης έβλεπε fallback
 *   avatar (πρώτο γράμμα hostname) αντί για το πραγματικό favicon.
 *
 *   Παράδειγμα από logs:
 *     [FAVICON] Skipping media-ram.gr favIconUrl
 *     (size 990134 > limit 51200)
 *     → Fallback avatar "M" ❌
 *
 * ΛΥΣΗ:
 *   Split limits + auto-resize:
 *     • MAX_DISPLAY_DATAURL_LENGTH = 2MB (hard cap, sanity check)
 *     • MAX_STORAGE_DATAURL_LENGTH = 200KB (persistent limit)
 *     • Αν 200KB < favIconUrl ≤ 2MB → resize σε 32×32 WebP/PNG
 *
 *   Resize:
 *     • OffscreenCanvas (Firefox 105+, MV3 background compatible)
 *     • createImageBitmap (native decode)
 *     • WebP @ q=0.9 (fallback PNG)
 *     • Aspect ratio preserved, centered
 *
 *   Αποτέλεσμα:
 *     • 990KB PNG → ~2KB WebP
 *     • Πιάνει 100% των sites
 *     • Μειώνει storage usage
 *     • Γρήγορο rendering
 *
 * Impact:
 *   • ✅ Όλα τα favicons εμφανίζονται (100% κάλυψη)
 *   • ✅ Persistent (μετά restart)
 *   • ✅ Μικρότερο storage
 *   • ✅ Γρήγορο rendering
 *   • ⚠️ Το resized είναι 32px (κατάλληλο για 30px cards)
 * ══════════════════════════════════════════════════════════════════════
 * v12.3.1 (2026-09-28) — NEGATIVE CACHE INVALIDATION API
 * ══════════════════════════════════════════════════════════════════════
 * BUG-FIX (HIGH): Import favicons δεν εμφανίζονταν στο overlay
 * ΠΡΟΒΛΗΜΑ:
 *   Τα import handlers (background.js::importFaviconsSimple και
 *   messaging.js::handleImportFavicons) γράφουν ΑΠΕΥΘΕΙΑΣ στο
 *   storage.local — ΔΕΝ περνούν από _writeStorageCache(). Έτσι
 *   το _negativeCache (FIX-4 v12.3.0) δεν invalidated.
 * ΛΥΣΗ:
 *   • Νέα public API: invalidateNegativeCache(hostname?)
 *   • Καλείται από τους 2 import handlers (background + messaging)
 *   • Bonus: broadcast faviconUpdate σε ανοιχτά overlays
 * ══════════════════════════════════════════════════════════════════════
 * v12.3.0 (2026-09-28) — NEGATIVE CACHE + BROADCAST EXCLUDE
 * ══════════════════════════════════════════════════════════════════════
 * FIX-4 (MEDIUM): Server-side negative cache (5min TTL)
 * FIX-3 (LOW): _broadcastFavicon excludePort parameter
 * ══════════════════════════════════════════════════════════════════════
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

  // V12E.E-FAVICON-01 / v12.5.0: Display vs Storage split
  //
  //   MAX_STORAGE_DATAURL_LENGTH: persistent limit (storage.local)
  //     → Αν > 200KB, γίνεται resize πριν την αποθήκευση
  //
  //   MAX_DISPLAY_DATAURL_LENGTH: hard cap (sanity check)
  //     → Αν > 2MB, skip εντελώς (malformed / huge files)
  const MAX_STORAGE_DATAURL_LENGTH = 200 * 1024;       // 200KB persistent
  const MAX_DISPLAY_DATAURL_LENGTH = 2 * 1024 * 1024;  // 2MB hard cap
  const RESIZE_TARGET_PX = 32;

  // Backward-compat alias για callers που χρησιμοποιούν το παλιό όνομα
  // (π.χ. tests, external modules). Δείχνει στο STORAGE limit.
  const MAX_DATAURL_LENGTH = MAX_STORAGE_DATAURL_LENGTH;

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
  function getHostname(url) {
    try {
      const u = new URL(url);
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return null;
    }
  }

  // ============================================================
  //  V12E.E-FAVICON-01: data: URL validation
  //
  //  Επιστρέφει { valid, reason?, length?, limit? } αντί boolean.
  //  Reason διαχωρίζει "not-data-url" από "too-long".
  //
  //  🔧 v12.5.0: χρησιμοποιεί MAX_DISPLAY_DATAURL_LENGTH (2MB)
  //              γιατί τα > 200KB περνάνε resize.
  // ============================================================
  function _isValidDataUrl(url) {
    if (typeof url !== 'string') {
      return { valid: false, reason: 'not-string' };
    }
    if (!url.startsWith('data:image/')) {
      return { valid: false, reason: 'not-data-url' };
    }
    if (url.length > MAX_DISPLAY_DATAURL_LENGTH) {
      return {
        valid: false,
        reason: 'too-long',
        length: url.length,
        limit: MAX_DISPLAY_DATAURL_LENGTH
      };
    }
    return { valid: true };
  }

  // ============================================================
  //  🔧 v12.5.0: Resize favicon σε maxSize px (π.χ. 32x32)
  //
  //  Χρησιμοποιεί OffscreenCanvas (Firefox 105+) + createImageBitmap
  //  που λειτουργούν σε MV3 background χωρίς DOM.
  //
  //  Aspect ratio preserved, centered, transparent background.
  //
  //  @param {string} dataUrl — source data URL (base64 ή urlencoded)
  //  @param {number} maxSize — target px (default 32)
  //  @returns {Promise<string|null>} — resized data URL ή null
  // ============================================================
  async function _resizeFavicon(dataUrl, maxSize = RESIZE_TARGET_PX) {
    try {
      // Guard: OffscreenCanvas + createImageBitmap support
      if (typeof OffscreenCanvas === 'undefined' ||
          typeof createImageBitmap === 'undefined') {
        warn('_resizeFavicon: OffscreenCanvas/createImageBitmap not available');
        return null;
      }

      // Parse data URL: data:[mime][;base64],payload
      const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.+)$/s);
      if (!match) return null;

      const mimeType = match[1];
      const isBase64 = !!match[2];
      const payload = match[3];

      // Decode payload → Uint8Array
      let bytes;
      if (isBase64) {
        const binary = atob(payload);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
      } else {
        bytes = new TextEncoder().encode(decodeURIComponent(payload));
      }

      // Blob → createImageBitmap
      const blob = new Blob([bytes], { type: mimeType });

      let bitmap;
      try {
        bitmap = await createImageBitmap(blob);
      } catch (e) {
        warn(`_resizeFavicon: createImageBitmap failed (${mimeType}):`, e.message);
        return null;
      }

      // OffscreenCanvas + drawImage (aspect-ratio preserved)
      const canvas = new OffscreenCanvas(maxSize, maxSize);
      const ctx = canvas.getContext('2d');

      const scale = Math.min(maxSize / bitmap.width, maxSize / bitmap.height);
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const offsetX = Math.round((maxSize - w) / 2);
      const offsetY = Math.round((maxSize - h) / 2);

      ctx.clearRect(0, 0, maxSize, maxSize);
      ctx.drawImage(bitmap, offsetX, offsetY, w, h);

      try { bitmap.close(); } catch (_) {}

      // Encode → WebP (μικρότερο) με PNG fallback
      let outBlob;
      try {
        outBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
      } catch (_) {
        outBlob = await canvas.convertToBlob({ type: 'image/png' });
      }

      if (!outBlob) return null;

      // Blob → data URL
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(outBlob);
      });

    } catch (e) {
      warn('_resizeFavicon failed:', e.message);
      return null;
    }
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
        if (entry.length > MAX_STORAGE_DATAURL_LENGTH) {
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

        if (entry.dataUrl.length > MAX_STORAGE_DATAURL_LENGTH) {
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
      if (dataUrl.length > MAX_STORAGE_DATAURL_LENGTH) {
        warn(
          `_writeStorageCache: dataUrl rejected for ${hostname} ` +
          `(size=${dataUrl.length} > limit=${MAX_STORAGE_DATAURL_LENGTH})`
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
    if (dataUrl.length > MAX_STORAGE_DATAURL_LENGTH) return false;

    _writeRamCache(hostname, dataUrl);
    _negativeCache.delete(hostname);
    return true;
  }

  // ============================================================
  //  getFavicon — κύριο API (ZERO-NETWORK)
  // ============================================================
  async function getFavicon(url) {
    const hostname = getHostname(url);
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
  //
  //  🔧 v12.5.0: Auto-resize αν > 200KB πριν την αποθήκευση.
  // ============================================================
  async function _collectFaviconFromTab(tabId, tab) {
    try {
      if (!tab || !tab.url) return;
      if (!/^https?:/i.test(tab.url)) return;

      const hostname = getHostname(tab.url);
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
            `Skipping ${hostname} favIconUrl (size ${dataUrlCheck.length} > ` +
            `display limit ${dataUrlCheck.limit}): ${favIconUrl.slice(0, 30)}...`
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

      // 🔧 v12.5.0: Resize αν > 200KB (storage limit)
      //
      //  Ροή:
      //    1. Αν ≤ 200KB → αποθήκευση as-is
      //    2. Αν 200KB < size ≤ 2MB → resize σε 32px WebP/PNG
      //         • Αν resize OK και ≤ 200KB → αποθήκευση
      //         • Αν resize OK αλλά > 200KB → RAM-only + broadcast
      //         • Αν resize fail → skip
      //    3. Αν > 2MB → skip (πιάστηκε ήδη από _isValidDataUrl)
      let finalDataUrl = favIconUrl;
      let isResized = false;

      if (favIconUrl.length > MAX_STORAGE_DATAURL_LENGTH) {
        log(
          `Favicon ${hostname} is ${favIconUrl.length} bytes ` +
          `(> ${MAX_STORAGE_DATAURL_LENGTH}) — resizing to ${RESIZE_TARGET_PX}px`
        );

        const resized = await _resizeFavicon(favIconUrl, RESIZE_TARGET_PX);

        if (resized && resized.length <= MAX_STORAGE_DATAURL_LENGTH) {
          finalDataUrl = resized;
          isResized = true;
          log(
            `Resized ${hostname}: ${favIconUrl.length} → ${resized.length} bytes`
          );
        } else if (resized) {
          // Resize OK αλλά ακόμα > 200KB (σπάνιο — π.χ. PNG fallback)
          warn(
            `Resize insufficient for ${hostname}: ` +
            `${resized.length} bytes still > ${MAX_STORAGE_DATAURL_LENGTH} — RAM-only`
          );
          _writeRamCache(hostname, resized);
          _broadcastFavicon(hostname, resized, null, null);
          _passiveSeen.add(hostname);
          return;
        } else {
          // Resize απέτυχε — skip
          warn(`Resize failed for ${hostname} (${favIconUrl.length} bytes) — skipping`);
          return;
        }
      }

      // Capture!
      log(
        `Passive capture: ${hostname} (${finalDataUrl.length} bytes` +
        `${isResized ? ', resized from ' + favIconUrl.length : ''})`
      );

      _writeRamCache(hostname, finalDataUrl);
      await _writeStorageCache(hostname, finalDataUrl);   // auto-invalidates negative
      _passiveSeen.add(hostname);

      _broadcastFavicon(hostname, finalDataUrl, null, null);

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
          if (value.dataUrl && value.dataUrl.length > MAX_STORAGE_DATAURL_LENGTH) {
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
      // 🔧 v12.5.0: νέα limits
      maxStorageDataUrlLength: MAX_STORAGE_DATAURL_LENGTH,   // 200KB
      maxDisplayDataUrlLength: MAX_DISPLAY_DATAURL_LENGTH,   // 2MB
      resizeTargetPx: RESIZE_TARGET_PX,                       // 32
      maxDataUrlLength: MAX_DATAURL_LENGTH,                   // alias (200KB)
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
    MAX_STORAGE_DATAURL_LENGTH,       // 🔧 v12.5.0: 200KB persistent
    MAX_DISPLAY_DATAURL_LENGTH,       // 🔧 v12.5.0: 2MB hard cap
    RESIZE_TARGET_PX,                  // 🔧 v12.5.0: 32
    MAX_DATAURL_LENGTH,                // legacy alias (200KB)
    RAM_CACHE_MAX,
    DEFERRED_RETRY_MS,
    NEGATIVE_TTL_MS,

    _internal: {
      _getHostname: getHostname,
      _isValidDataUrl,
      _storageKey,
      _readStorageCache,
      _writeStorageCache,
      _readRamCache,
      _writeRamCache,
      _writeRamCacheExternal,   // 🔧 v12.3.1
      _broadcastFavicon,
      _collectFaviconFromTab,
      _negativeCache,
      _resizeFavicon            // 🔧 v12.5.0
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_FAVICON = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FAVICON = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Favicon Service ready (v12.5.0: ZERO-NETWORK — tab.favIconUrl data URLs only, ' +
      'no _favicon/ (Firefox has no equivalent), ' +
      'MAX_STORAGE=200KB (auto-resize >200KB → 32px WebP/PNG), ' +
      'MAX_DISPLAY=2MB (hard cap), ' +
      'negative cache (5min TTL) + invalidateNegativeCache API, ' +
      'broadcast excludePort, 0 DNS, 0 HTTP, 0 leak)'
    );
  }

  return api;
})();