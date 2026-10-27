/**
 * ui-controller.js — UI controller (carousel + toolbar)
 *
 * @path     overlay/core/ui-controller.js
 * @version  12.3.0
 * @since    v12E / v12.3
 *
 * PURPOSE
 *   Κεντρικός UI controller του overlay. Διαχειρίζεται:
 *     • Layer 1 (toolbar): lock, space switch, search bar, add buttons
 *     • Layer 2 (breadcrumb): home/back + path segments
 *     • Layer 3 (carousel): cards, favicons, hover, selection
 *     • Multi-select: Ctrl/Shift+Click, Ctrl+A, bulk ops
 *     • Keyboard: ArrowLeft/Right, Enter, Escape, Delete
 *     • Navigation: navigateToFolder με race protection (navSeq)
 *
 * KEY CONCEPTS
 *   • Shadow DOM aware (D-13.1)
 *   • Cross-lock coordination (C-3 — _spaceInProgress guard)
 *   • Search hover breadcrumb (V12E.E): breadcrumb δείχνει το path
 *     του hovered search result (cache + debounce + race protection)
 *   • D-52: bookmark click → openInCurrentTab (close overlay first)
 *   • Favicon queue με concurrency limit (adaptive: 1 low-end / 3 high-end)
 *   • Favicon retries με exponential backoff (rate limit aware)
 *
 * DECISIONS
 *   D-13.1, D-46, D-52
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — MEMORY LEAK FIX + VERSION ALIGNMENT
 *   ══════════════════════════════════════════════════════════════════════
 *   BUG-1 FIX (CRITICAL): _faviconPending unbounded growth
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Όταν η favicon queue ήταν γεμάτη (_faviconQueue.length >=
 *       MAX_FAVICON_QUEUE = 50), η _enqueueFavicon() έκανε silently
 *       drop το task — ΧΩΡΙΣ να ενημερώσει τον caller.
 *
 *       ΑΠΟΤΕΛΕΣΜΑ:
 *         • Το promise στο _fetchFaviconAsync έμενε pending για ΠΑΝΤΑ
 *         • Το _faviconPending Map (χωρίς size bound) γέμιζε
 *           απεριόριστα σε low-end scenarios με γρήγορο scroll
 *         • Κάθε entry ~8KB → memory leak
 *
 *     ΛΥΣΗ:
 *       • _enqueueFavicon() επιστρέφει boolean (true = enqueued)
 *       • _fetchFaviconAsync() ελέγχει το return value
 *       • Αν !enqueued → resolve(null) αμέσως (no fetch, no leak)
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.2.0 → 12.3.0 (sync με manifest 12.2+ baseline)
 *     • Διορθώθηκαν stale v12.2.x references σε docs/comments
 *     • Δεν υπάρχουν functional changes πέραν του BUG-1
 *
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.2.0 (2026-09-26) — LOW-END HARDWARE OPTIMIZATION
 *   ══════════════════════════════════════════════════════════════════════
 *   Memory fixes (Tier 1 — zero regression risk):
 *     • MEM-01: Bounded _faviconCache (300 entries, LRU eviction)
 *     • MEM-02: Bounded _faviconColorCache (300 entries, LRU)
 *     • MEM-03: Bounded _faviconRetries (100 entries, LRU)
 *     • MEM-04: Bounded folderNameCache (1000 entries, LRU)
 *     • MEM-05: Bounded _faviconQueue (50 entries, backpressure drop)
 *     • MEM-06: Fix destroy() — folderNameCache + search caches + flags
 *
 *   CPU/GPU adaptive (Tier 2 — low-end smooth operation):
 *     • CPU-01: _IS_LOW_END detection (hardwareConcurrency/deviceMemory)
 *     • CPU-02: Adaptive favicon concurrency (2 low-end / 3 high-end)
 *     • CPU-03: Adaptive inter-favicon delay (30ms / 100ms)
 *     • CPU-04: Skip canvas dominant color extraction σε low-end
 *     • CPU-05: Coalesced scroll → arrows update (RAF single-flight)
 *
 *   Race protection:
 *     • RACE-01: navigateToFolder space-change guard (abort stale nav)
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "ui-controller"
 */

var CBF_UI = (function() {
  'use strict';

  // ============================================================
  //  🔧 v12.2 MEMORY CONSTANTS
  //
  //  Όλα τα overlay-side caches έχουν bounded size (LRU).
  //  Rationale: content script heap είναι per-tab. Χωρίς όρια, ο
  //  heap μπορεί να φτάσει 10+ MB ανά tab. Σε 10 tabs = 100 MB.
  // ============================================================
  const MAX_FAVICON_CACHE_SIZE    = 300;
  const MAX_FOLDER_NAME_CACHE     = 1000;
  const MAX_RETRY_MAP             = 100;
  const MAX_FAVICON_QUEUE         = 50;
  const MAX_OVERLAY_FAVICON_CACHE = 300;   // alias για clarity

  // ─────────────────────────────────────────────────────────────
  //  v12.2 FIX: Λιγότερο επιθετικές τιμές low-end
  //
  //  ΠΡΟΒΛΗΜΑ (v12.2):
  //    Με concurrency=1 + delay=150ms, 20 favicons φορτώνονται σε
  //    ~3 δευτερόλεπτα (παρατηρήσιμο lag).
  //
  //  ΛΥΣΗ:
  //    - Concurrency 1 → 2 (δύο parallel fetches)
  //    - Delay 150ms → 30ms (επαρκές για CPU breathing)
  //
  //  ΑΠΟΤΕΛΕΣΜΑ:
  //    20 favicons: ~3s → ~350ms (8.5x γρηγορότερα)
  //    CPU load: παραμένει χαμηλό (max 2 parallel)
  // ─────────────────────────────────────────────────────────────
  const _IS_LOW_END =
    (typeof navigator !== 'undefined' && (
      (navigator.hardwareConcurrency || 4) <= 2 ||
      (navigator.deviceMemory || 4) <= 2
    ));

  const _FAVICON_MAX_CONCURRENT      = _IS_LOW_END ? 2 : 3;
  const _FAVICON_INTER_REQUEST_DELAY = _IS_LOW_END ? 30 : 100;

  // ============================================================
  //  State
  // ============================================================
  let shadowRoot = null;
  let container = null;
  let elements = {};

  let currentFolderId = 'toolbar_____';
  let currentItems = [];
  let originalItems = [];

  let selectedIndex = -1;
  let hoveredIndex = -1;
  let hoveredCardElement = null;

  let activeSpace = 'firefox';
  let isSearchActive = false;
  let currentSearchQuery = '';

  let folderNameCache = new Map();
  let resizeObserver = null;
  let scrollTicking = false;

  // 🔧 v12.2: RAF coalescing για scroll → arrows update
  let _arrowsUpdateScheduled = false;

  // Feature hooks
  let onContextMenu = null;
  let onCardAction = null;

  let _actionInProgress = false;
  let _navSeq = 0;
  let _unlockPromptInProgress = false;

  // MULTI-SELECT
  let _lastAnchorId = null;
  let _selectionInfoTimer = null;

  // MULTI-SELECT v1.2: CARRY-OVER
  let _carryOverSelectionIds = [];

  // v1.3: PENDING CENTER SCROLL (space switch / home)
  let _pendingCenterScroll = false;

  // ============================================================
  //  V12E.E — SEARCH HOVER BREADCRUMB STATE
  //
  //  Όταν κάνει hover σε search result → breadcrumb δείχνει το path
  //  του item. Δεν γίνεται restore σε mouseleave.
  //  Restore μόνο σε clearSearch() (X / Escape).
  //
  //  Reuses:
  //    - CBF_BRIDGE.getPath (rate limit 200/s, 0 νέα commands)
  //    - CBF_BREADCRUMB_MANAGER.setPath
  //    - updateLayer2 (ίδιο render path)
  // ============================================================
  let _preSearchBreadcrumbPath = null;
  let _searchPathReqId = 0;
  let _lastSearchBreadcrumbId = null;
  const _searchPathCache = new Map();
  let _searchBreadcrumbDebounceTimer = null;

  const SEARCH_PATH_CACHE_MAX = 500;
  const SEARCH_BREADCRUMB_DEBOUNCE_MS = 250;

  // V12E_7_C3 D: Navigate listeners
  const _navigateListeners = [];

  const MAX_MISSING_IDS_RETURNED = 50;
  let _faviconUpdateListenerRegistered = false;

  // ============================================================
  //  🔧 v12.2 _boundedMapSet — LRU eviction helper
  //
  //  Ο σκοπός είναι να αποτρέψουμε unbounded Map growth.
  //
  //  Algorithm:
  //    1. Αν το key υπάρχει → delete first (refresh LRU position)
  //    2. Set με νέα τιμή
  //    3. Evict from front (oldest) μέχρι size <= maxSize
  //
  //  Rationale για delete-first:
  //    Τα JS Maps δεν έχουν native LRU. Το pattern "delete + re-set"
  //    κάνει το entry να πάει στο ΤΕΛΟΣ της iteration order, άρα τα
  //    "παλιά" (πρώτα) entries απομακρύνονται πρώτα.
  //
  //  Fail-safe: Αν map δεν είναι Map → warn + return.
  // ============================================================
  function _boundedMapSet(map, key, value, maxSize) {
    if (!(map instanceof Map)) {
      warn('_boundedMapSet: not a Map — skipping');
      return;
    }
    if (typeof maxSize !== 'number' || maxSize < 1) {
      warn('_boundedMapSet: invalid maxSize — skipping');
      return;
    }

    // Delete-first → refresh LRU position
    if (map.has(key)) map.delete(key);
    map.set(key, value);

    // Evict oldest entries
    while (map.size > maxSize) {
      const firstKey = map.keys().next().value;
      if (firstKey === undefined) break;
      map.delete(firstKey);
    }
  }

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('[UI]', ...a);
    else console.log('[UI]', ...a);
  }
  function warn(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.warn('[UI]', ...a);
    else console.warn('[UI]', ...a);
  }
  function err(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.error('[UI]', ...a);
    else console.error('[UI]', ...a);
  }

  // ============================================================
  //  URL sanitization
  // ============================================================
  function _sanitizeUrlForDisplay(url) {
    if (typeof url !== 'string' || url.length === 0) return '(empty)';
    const specialSchemes = [
      'about', 'chrome', 'moz-extension', 'data', 'file',
      'javascript', 'blob', 'view-source', 'resource', 'ws', 'wss'
    ];
    const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):/i);
    if (schemeMatch) {
      const scheme = schemeMatch[1].toLowerCase();
      if (specialSchemes.includes(scheme)) return `(${scheme}:…)`;
    }
    try {
      const u = new URL(url);
      const host = u.hostname || 'unknown';
      return `${u.protocol}//${host}/…`;
    } catch (_) {
      if (url.length > 40) return url.slice(0, 40) + '…';
      return url;
    }
  }

  // ============================================================
  //  Color helpers
  // ============================================================
  function _getHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return ''; }
  }

  function _getInitial(url) {
    const h = _getHostname(url);
    return h ? h.charAt(0).toUpperCase() : '?';
  }

  function _getAvatarColor(url) {
    const h = _getHostname(url);
    if (!h) return '#888';
    let hash = 5381;
    for (let i = 0; i < h.length; i++) {
      hash = ((hash << 5) + hash) + h.charCodeAt(i);
      hash = hash & hash;
    }
    return `hsl(${Math.abs(hash % 360)},60%,55%)`;
  }

  function _getColorFromUrl(url) {
    if (!url) return 'hsla(0,0%,70%,0.35)';
    const h = _getHostname(url);
    if (!h) return 'hsla(0,0%,70%,0.35)';
    let hash = 5381;
    for (let i = 0; i < h.length; i++) {
      hash = ((hash << 5) + hash) + h.charCodeAt(i);
      hash = hash & hash;
    }
    return `hsla(${Math.abs(hash % 360)},60%,70%,0.35)`;
  }

  function _solidColor(c) {
    return c.replace(/hsla\(([^,]+),([^,]+),([^,]+),[^)]+\)/g, 'hsl($1,$2,$3)');
  }

  // ============================================================
  //  FAVICON CACHES + QUEUE (v12.2: bounded)
  // ============================================================
  const _faviconCache = new Map();
  const _faviconPending = new Map();
  const _faviconColorCache = new Map();

  const _faviconQueue = [];
  const _faviconRetries = new Map();
  let _faviconActive = 0;

  // 🔧 v12.2: adaptive queue runner
  function _runFaviconQueue() {
    if (_faviconActive >= _FAVICON_MAX_CONCURRENT) return;
    if (_faviconQueue.length === 0) return;
    const task = _faviconQueue.shift();
    _faviconActive++;
    task().finally(() => {
      _faviconActive--;
      setTimeout(_runFaviconQueue, _FAVICON_INTER_REQUEST_DELAY);
    });
  }

  // ─────────────────────────────────────────────────────────────
  //  🔧 v12.2: backpressure — drop αν γεμίσει
  //  🔧 v12.3.0 BUG-1 FIX: return boolean ώστε ο caller να resolve
  //                       το promise αμέσως όταν το task δεν μπορεί
  //                       να enqueued-αριστεί (αποτρέπει leak στο
  //                       _faviconPending Map).
  // ─────────────────────────────────────────────────────────────
  function _enqueueFavicon(task) {
    if (typeof task !== 'function') return false;
    if (_faviconQueue.length >= MAX_FAVICON_QUEUE) {
      warn(`Favicon queue full (${MAX_FAVICON_QUEUE}) — dropping request`);
      return false;
    }
    _faviconQueue.push(task);
    _runFaviconQueue();
    return true;
  }

  // 🔧 v12.2: skip canvas extraction σε low-end
  function _extractDominantColor(dataUrl) {
    return new Promise((resolve) => {
      // Low-end: skip canvas (GPU/CPU saved)
      if (_IS_LOW_END) return resolve(null);

      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return resolve(null);
      const img = new Image();
      img.onload = () => {
        try {
          const size = 16;
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            r += data[i]; g += data[i + 1]; b += data[i + 2];
            count++;
          }
          if (count === 0) return resolve(null);
          resolve(`rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`);
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  function _rgbToHsla(rgb, alpha) {
    const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const r = parseInt(m[1], 10) / 255;
    const g = parseInt(m[2], 10) / 255;
    const b = parseInt(m[3], 10) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return `hsla(${Math.round(h*360)},${Math.round(s*100)}%,${Math.round(l*100)}%,${alpha})`;
  }

  function _applyCardBackground(cardEl, faviconDataUrl, dominantColor) {
    if (!cardEl) return;
    try {
      if (typeof faviconDataUrl === 'string' && faviconDataUrl.startsWith('data:')) {
        cardEl.style.setProperty('--favicon-bg', `url("${faviconDataUrl}")`);
      }
      if (typeof dominantColor === 'string' && dominantColor.startsWith('rgb')) {
        const hsla = _rgbToHsla(dominantColor, 0.35);
        if (hsla) {
          cardEl.style.setProperty('--card-color', hsla);
          const solid = hsla.replace(/hsla\(([^,]+),([^,]+),([^,]+),[^)]+\)/, 'hsl($1,$2,$3)');
          cardEl.style.setProperty('--card-color-solid', solid);
        }
      }
    } catch (e) { warn('Apply card background failed:', e.message); }
  }

  function _applyFavicon(iconDiv, fallbackAvatar, dataUrl) {
    if (!iconDiv || !fallbackAvatar) return;
    if (fallbackAvatar.parentNode !== iconDiv) return;
    const img = document.createElement('img');
    img.src = dataUrl; img.alt = '';
    img.style.cssText = `
      width: 100%; height: 100%; object-fit: contain; border-radius: 10px;
      background: rgba(255,255,255,0.6); border: 1px solid rgba(255,255,255,0.8);
      box-shadow: 0 2px 6px rgba(0,0,0,0.1);
    `;
    img.addEventListener('error', () => {
      if (img.parentNode === iconDiv) {
        try { iconDiv.replaceChild(fallbackAvatar, img); } catch (_) {}
      }
    });
    try { iconDiv.replaceChild(img, fallbackAvatar); }
    catch (e) { warn('Favicon apply failed:', e.message); }
  }

  // ─────────────────────────────────────────────────────────────
  //  🔧 v12.3.0 BUG-1 FIX
  //
  //  Handle το return value της _enqueueFavicon(): αν το task δεν
  //  έγινε enqueued (queue full), resolve(null) αμέσως ώστε το
  //  promise στο _faviconPending να μην μείνει pending για πάντα.
  // ─────────────────────────────────────────────────────────────
  async function _fetchFaviconAsync(url, iconDiv, fallbackAvatar, cardEl) {
    try {
      const hostname = _getHostname(url);
      if (!hostname) return;
      if (_faviconCache.has(hostname)) {
        const cached = _faviconCache.get(hostname);
        if (cached) {
          _applyFavicon(iconDiv, fallbackAvatar, cached);
          const cachedColor = _faviconColorCache.get(hostname);
          if (cardEl) _applyCardBackground(cardEl, cached, cachedColor);
        }
        return;
      }
      let promise = _faviconPending.get(hostname);
      if (!promise) {
        promise = new Promise((resolve) => {
          // 🔧 v12.3.0 BUG-1 FIX: handle drop (queue full) — resolve(null)
          //    άμεσα, ώστε το promise να ΜΗΝ μείνει pending για πάντα
          //    (αποτρέπει unbounded growth του _faviconPending Map).
          const enqueued = _enqueueFavicon(async () => {
            let result = null;
            try { result = await _doFetchFavicon(url, hostname); }
            catch (e) { warn(`Favicon enqueue task failed for ${hostname}:`, e.message); }
            finally { resolve(result); }
          });
          if (!enqueued) {
            // Queue full → resolve immediately (no fetch, no leak)
            resolve(null);
          }
        });
        _faviconPending.set(hostname, promise);
        promise.finally(() => { _faviconPending.delete(hostname); });
      }
      const dataUrl = await promise;
      if (dataUrl) {
        _applyFavicon(iconDiv, fallbackAvatar, dataUrl);
        const color = _faviconColorCache.get(hostname);
        if (cardEl) _applyCardBackground(cardEl, dataUrl, color);
      }
    } catch (e) { warn('Favicon fetch wrapper failed:', e.message); }
  }

  async function _doFetchFavicon(url, hostname) {
    if (typeof CBF_BRIDGE === 'undefined' ||
        typeof CBF_BRIDGE.getFavicon !== 'function') return null;
    let attempt = (_faviconRetries.get(hostname) || 0);
    try {
      const res = await CBF_BRIDGE.getFavicon(url);
      if (res && typeof res.dataUrl === 'string' && res.dataUrl.length > 0) {
        // 🔧 v12.2: bounded
        _boundedMapSet(_faviconCache, hostname, res.dataUrl, MAX_FAVICON_CACHE_SIZE);
        _faviconRetries.delete(hostname);
        const color = await _extractDominantColor(res.dataUrl);
        // 🔧 v12.2: bounded
        _boundedMapSet(_faviconColorCache, hostname, color, MAX_OVERLAY_FAVICON_CACHE);
        log(`Favicon loaded: ${hostname}${color ? ` (color: ${color})` : ''}`);
        return res.dataUrl;
      }
      const errMsg = String(res?.error || '');
      if (/RATE_LIMITED|COMMAND_LIMIT|COOLDOWN/i.test(errMsg)) {
        if (attempt < _FAVICON_MAX_RETRIES) {
          attempt++;
          // 🔧 v12.2: bounded
          _boundedMapSet(_faviconRetries, hostname, attempt, MAX_RETRY_MAP);
          const backoffMs = 300 * Math.pow(2, attempt - 1);
          log(`Favicon rate limited for ${hostname} — retry ${attempt}/${_FAVICON_MAX_RETRIES} in ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          return await _doFetchFavicon(url, hostname);
        }
        warn(`Favicon gave up after ${_FAVICON_MAX_RETRIES} retries: ${hostname}`);
        return null;
      }
      // 🔧 v12.2: bounded (null = negative cache)
      _boundedMapSet(_faviconCache, hostname, null, MAX_FAVICON_CACHE_SIZE);
      _faviconRetries.delete(hostname);
      log(`Favicon unavailable: ${hostname} (${errMsg || 'no dataUrl'})`);
      return null;
    } catch (e) {
      warn(`Favicon fetch error for ${hostname}:`, e.message);
      return null;
    }
  }

  function _setupFaviconUpdateListener() {
    if (_faviconUpdateListenerRegistered) return;
    if (typeof CBF_BRIDGE === 'undefined' || typeof CBF_BRIDGE.on !== 'function') return;
    CBF_BRIDGE.on('faviconUpdate', (event) => {
      try {
        if (!event || typeof event !== 'object') return;
        const { hostname, dataUrl, color } = event;
        if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) return;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
        if (dataUrl.length > 50 * 1024) return;   // V12E.E-FAVICON-01
        let validColor = null;
        if (typeof color === 'string' && color.startsWith('rgb')) validColor = color;
        log(`faviconUpdate: received ${hostname}${validColor ? ` (color: ${validColor})` : ''}`);
        // 🔧 v12.2: bounded
        _boundedMapSet(_faviconCache, hostname, dataUrl, MAX_FAVICON_CACHE_SIZE);
        if (validColor) {
          _boundedMapSet(_faviconColorCache, hostname, validColor, MAX_OVERLAY_FAVICON_CACHE);
        }
        if (!elements.layer3) return;
        const cards = elements.layer3.querySelectorAll('.card');
        let updatedCount = 0;
        for (const card of cards) {
          const cardId = card.dataset.id;
          if (!cardId) continue;
          const item = currentItems.find(i => i.id === cardId);
          if (!item || !item.url) continue;
          const cardHostname = _getHostname(item.url);
          if (cardHostname !== hostname) continue;
          const iconDiv = card.querySelector('.card-icon');
          const avatar = iconDiv?.querySelector('.card-avatar');
          if (iconDiv && avatar) _applyFavicon(iconDiv, avatar, dataUrl);
          if (validColor) _applyCardBackground(card, dataUrl, validColor);
          updatedCount++;
        }
        if (updatedCount > 0) log(`faviconUpdate: applied to ${updatedCount} card(s)`);
      } catch (e) { err('faviconUpdate error:', e.message); }
    });
    _faviconUpdateListenerRegistered = true;
    log('faviconUpdate listener registered');
  }

  function resetNavSeq() {
    _navSeq = 0;
    log('NavSeq reset');
  }

  // ============================================================
  //  V12E_7_C3 D: Navigate event hook (για features όπως pin)
  // ============================================================
  function onNavigate(cb) {
    if (typeof cb === 'function' && !_navigateListeners.includes(cb)) {
      _navigateListeners.push(cb);
    }
  }

  function _fireNavigate(folderId) {
    for (const cb of _navigateListeners) {
      try { cb(folderId); }
      catch (e) { warn('Navigate listener error:', e.message); }
    }
  }

  function scrollBy(delta) {
    if (!elements.layer3) return;
    elements.layer3.scrollLeft += delta;
  }

  function isActionInProgress() { return _actionInProgress; }

  function _checkSpaceTransitionGuard() {
    if (typeof window === 'undefined') return false;
    if (typeof window.CBF_Overlay_isSpaceTransitionInProgress !== 'function') return false;
    try {
      if (window.CBF_Overlay_isSpaceTransitionInProgress()) {
        warn('C-3: blocked — space transition in progress');
        return true;
      }
    } catch (e) { warn('C-3: guard check failed:', e.message); }
    return false;
  }

  // ============================================================
  //  MULTI-SELECT HELPERS
  // ============================================================
  function _getSelectedItems() {
    const ids = CBF_SELECTION_MANAGER.getPendingIds();
    if (ids.length === 0) return [];
    const selected = new Set(ids);
    const items = [];
    for (const item of currentItems) {
      if (selected.has(item.id)) items.push(item);
    }
    return items;
  }

  function _applySelectionVisuals() {
    if (!elements.layer3) return;
    const selected = new Set(CBF_SELECTION_MANAGER.getPendingIds());
    const cards = elements.layer3.querySelectorAll('.card');
    for (const card of cards) {
      const id = card.dataset.id;
      if (!id) continue;
      const isSel = selected.has(id);
      card.classList.toggle('card-selected', isSel);
      card.classList.toggle('card-anchor', isSel && id === _lastAnchorId);
    }
  }

  function _updateSelectionBadge() {
    const count = CBF_SELECTION_MANAGER.getPendingIds().length;
    if (elements.bulkLock && elements.bulkCount) {
      if (count >= 2) {
        elements.bulkCount.textContent = String(count);
        elements.bulkLock.classList.add('visible');
      } else {
        elements.bulkLock.classList.remove('visible');
      }
    }
    if (elements.selectionInfo && elements.selectionText) {
      if (count >= 2) {
        elements.selectionText.textContent = `${count} επιλεγμένα`;
        elements.selectionInfo.classList.add('visible');
        if (_selectionInfoTimer) clearTimeout(_selectionInfoTimer);
        _selectionInfoTimer = setTimeout(() => {
          if (elements.selectionInfo) elements.selectionInfo.classList.remove('visible');
          _selectionInfoTimer = null;
        }, 3500);
      } else {
        elements.selectionInfo.classList.remove('visible');
        if (_selectionInfoTimer) {
          clearTimeout(_selectionInfoTimer);
          _selectionInfoTimer = null;
        }
      }
    }
  }

  function _toggleSelection(id) {
    if (!id) return;
    const ids = CBF_SELECTION_MANAGER.getPendingIds();
    const has = ids.includes(id);
    if (has) {
      const next = ids.filter(x => x !== id);
      if (next.length === 0) CBF_SELECTION_MANAGER.clear();
      else if (next.length === 1) CBF_SELECTION_MANAGER.set(next[0]);
      else CBF_SELECTION_MANAGER.setMultiple(next);
    } else {
      CBF_SELECTION_MANAGER.setMultiple([...ids, id]);
      _lastAnchorId = id;
    }
  }

  function _selectRange(fromId, toId) {
    if (!fromId || !toId) return;
    const fromIdx = currentItems.findIndex(i => i.id === fromId);
    const toIdx = currentItems.findIndex(i => i.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [start, end] = fromIdx <= toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    const rangeIds = [];
    for (let i = start; i <= end; i++) rangeIds.push(currentItems[i].id);
    if (rangeIds.length === 0) CBF_SELECTION_MANAGER.clear();
    else if (rangeIds.length === 1) CBF_SELECTION_MANAGER.set(rangeIds[0]);
    else CBF_SELECTION_MANAGER.setMultiple(rangeIds);
  }

  function _selectAllVisible() {
    const ids = currentItems.map(i => i.id);
    if (ids.length === 0) { CBF_SELECTION_MANAGER.clear(); return; }
    if (ids.length === 1) CBF_SELECTION_MANAGER.set(ids[0]);
    else CBF_SELECTION_MANAGER.setMultiple(ids);
    _lastAnchorId = ids[0];
  }

  function _clearSelection() {
    CBF_SELECTION_MANAGER.clear();
    _lastAnchorId = null;
    if (_selectionInfoTimer) {
      clearTimeout(_selectionInfoTimer);
      _selectionInfoTimer = null;
    }
  }

  function _onCardClick(item, card, e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    if (ctrl) {
      e.preventDefault(); e.stopPropagation();
      _toggleSelection(item.id);
      _applySelectionVisuals();
      _updateSelectionBadge();
      return 'SELECTION_CHANGED';
    }

    if (shift) {
      e.preventDefault(); e.stopPropagation();
      if (_lastAnchorId && _lastAnchorId !== item.id) {
        _selectRange(_lastAnchorId, item.id);
      } else {
        _toggleSelection(item.id);
      }
      _applySelectionVisuals();
      _updateSelectionBadge();
      return 'SELECTION_CHANGED';
    }

    const wasSelected = CBF_SELECTION_MANAGER.getPendingIds().length > 0;
    if (wasSelected) {
      e.preventDefault(); e.stopPropagation();
      _clearSelection();
      _applySelectionVisuals();
      _updateSelectionBadge();
      log('Plain click: golden selection cleared');
      return 'SELECTION_CLEARED';
    }

    return null;
  }

  // ============================================================
  //  v1.2 + v1.3: SCROLL HELPERS
  // ============================================================
  function _scrollSelectionToCenter() {
    if (!elements.layer3) return;
    const ids = CBF_SELECTION_MANAGER.getPendingIds();
    if (ids.length === 0) return;

    const layer3 = elements.layer3;
    const firstId = ids[0];
    const card = layer3.querySelector(`.card[data-id="${firstId}"]`);
    if (!card) return;

    const tryScroll = (attempt = 0) => {
      const offset = card.offsetLeft;
      const width = card.offsetWidth;
      const view = layer3.clientWidth;
      const scrollWidth = layer3.scrollWidth;
      let desired = offset - (view / 2) + (width / 2);
      desired = Math.max(0, Math.min(desired, scrollWidth - view));
      layer3.scrollLeft = desired;
      if (Math.abs(layer3.scrollLeft - desired) > 1 && attempt < 5) {
        requestAnimationFrame(() => tryScroll(attempt + 1));
      }
    };
    requestAnimationFrame(() => tryScroll(0));
  }

  function _scrollToMiddle() {
    if (!elements.layer3) return;
    const layer3 = elements.layer3;
    const tryScroll = (attempt = 0) => {
      const maxScroll = layer3.scrollWidth - layer3.clientWidth;
      let desired = maxScroll / 2;
      if (desired < 0) desired = 0;
      layer3.scrollLeft = desired;
      if (Math.abs(layer3.scrollLeft - desired) > 1 && attempt < 5) {
        requestAnimationFrame(() => tryScroll(attempt + 1));
      }
    };
    requestAnimationFrame(() => tryScroll(0));
  }

  // ============================================================
  //  V12E.E — SEARCH HOVER BREADCRUMB HELPERS
  // ============================================================

  function _clearSearchBreadcrumbState() {
    _searchPathReqId++;
    _preSearchBreadcrumbPath = null;
    _lastSearchBreadcrumbId = null;
    _searchPathCache.clear();
    if (_searchBreadcrumbDebounceTimer) {
      clearTimeout(_searchBreadcrumbDebounceTimer);
      _searchBreadcrumbDebounceTimer = null;
    }
  }

  function _cachePreSearchBreadcrumb() {
    if (_preSearchBreadcrumbPath === null) {
      _preSearchBreadcrumbPath = getBreadcrumbPath().slice();
      log(`Search breadcrumb: cached pre-search path (${_preSearchBreadcrumbPath.length} segments)`);
    }
  }

  async function _doUpdateSearchBreadcrumb(itemId) {
    if (!isSearchActive) return;
    if (_lastSearchBreadcrumbId === itemId) return;

    _lastSearchBreadcrumbId = itemId;
    const reqId = ++_searchPathReqId;

    const cached = _searchPathCache.get(itemId);
    if (cached) {
      if (reqId === _searchPathReqId && isSearchActive) {
        CBF_BREADCRUMB_MANAGER.setPath(activeSpace, cached);
        updateLayer2();
      }
      return;
    }

    try {
      const res = await CBF_BRIDGE.getPath(itemId);

      if (reqId !== _searchPathReqId) return;
      if (!isSearchActive) return;

      if (res && Array.isArray(res.path) && res.path.length > 0) {
        if (_searchPathCache.size >= SEARCH_PATH_CACHE_MAX) {
          const firstKey = _searchPathCache.keys().next().value;
          if (firstKey !== undefined) _searchPathCache.delete(firstKey);
        }
        _searchPathCache.set(itemId, res.path.slice());

        CBF_BREADCRUMB_MANAGER.setPath(activeSpace, res.path);
        updateLayer2();
        log(`Search breadcrumb: ${itemId.slice(0, 8)} → ${res.path.length} segments`);
      }
    } catch (e) {
      warn('Search breadcrumb: getPath failed:', e.message);
    }
  }

  function _scheduleSearchBreadcrumbUpdate(itemId) {
    if (!isSearchActive) return;
    if (typeof itemId !== 'string' || !itemId) return;

    if (_searchPathCache.has(itemId)) {
      if (_searchBreadcrumbDebounceTimer) {
        clearTimeout(_searchBreadcrumbDebounceTimer);
        _searchBreadcrumbDebounceTimer = null;
      }
      _doUpdateSearchBreadcrumb(itemId).catch(() => {});
      return;
    }

    if (_searchBreadcrumbDebounceTimer) {
      clearTimeout(_searchBreadcrumbDebounceTimer);
    }
    _searchBreadcrumbDebounceTimer = setTimeout(() => {
      _searchBreadcrumbDebounceTimer = null;
      _doUpdateSearchBreadcrumb(itemId).catch(() => {});
    }, SEARCH_BREADCRUMB_DEBOUNCE_MS);
  }

  // ============================================================
  //  v1.5.2 + v1.5.4: Pin notify helpers
  // ============================================================
  function _notifyPinDeleted(deletedIds) {
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;
    if (typeof CBF_FEATURE_PIN === 'undefined') return;
    if (typeof CBF_FEATURE_PIN.onFoldersDeleted !== 'function') return;
    try {
      CBF_FEATURE_PIN.onFoldersDeleted(deletedIds).catch(e => {
        warn('Pin deletion notify failed:', e.message);
      });
    } catch (e) {
      warn('Pin deletion notify threw:', e.message);
    }
  }

  function _notifyPinTransferred(sourceSpace, itemId) {
    if (!sourceSpace || !itemId) return;
    if (typeof CBF_FEATURE_PIN === 'undefined') return;
    if (typeof CBF_FEATURE_PIN.onItemTransferred !== 'function') return;
    try {
      CBF_FEATURE_PIN.onItemTransferred(sourceSpace, itemId).catch(e => {
        warn('Pin transfer notify failed:', e.message);
      });
    } catch (e) {
      warn('Pin transfer notify threw:', e.message);
    }
  }

  // ============================================================
  //  MULTI-DELETE
  // ============================================================
  async function _deleteMultipleCards(ids) {
    if (_actionInProgress) return;
    if (!Array.isArray(ids) || ids.length === 0) return;
    if (_checkSpaceTransitionGuard()) return;

    _actionInProgress = true;
    try {
      if (activeSpace === 'encrypted') {
        const unlocked = await ensureVaultUnlocked('για μαζική διαγραφή');
        if (!unlocked) return;
      }
      const confirmMsg = `Διαγραφή ${ids.length} στοιχείων;\n\nΘα διαγραφούν και τυχόν υπό-φακελοι.`;
      let ok = false;
      if (typeof CBF_MODAL_SERVICE !== 'undefined' && CBF_MODAL_SERVICE.showConfirm) {
        ok = await CBF_MODAL_SERVICE.showConfirm(confirmMsg);
      } else { ok = window.confirm(confirmMsg); }
      if (!ok) return;

      let deleted = 0;
      const failed = [];
      const allDeletedIds = [];

      for (const id of ids) {
        try {
          if (activeSpace === 'encrypted') {
            const gen = (typeof CBF_BRIDGE.getGeneration === 'function') ? CBF_BRIDGE.getGeneration() : 0;
            const res = await CBF_BRIDGE.delete({ id }, gen);
            const subIds = Array.isArray(res?.result?.deletedIds)
              ? res.result.deletedIds
              : [id];
            allDeletedIds.push(...subIds);
          } else {
            await CBF_BRIDGE.firefoxRemove(id);
            allDeletedIds.push(id);
          }
          deleted++;
          _removeItemFromState(id);
          _removeCardFromDOM(id);
        } catch (e) {
          warn(`_deleteMultipleCards failed for ${id}:`, e.message);
          failed.push({ id, error: e.message });
        }
      }

      if (allDeletedIds.length > 0) {
        _notifyPinDeleted(allDeletedIds);
      }

      CBF_SELECTION_MANAGER.clear();
      _lastAnchorId = null;
      _applySelectionVisuals();
      _updateSelectionBadge();
      _refreshSelectionAfterMutation();
      log(`Multi-delete: ${deleted} deleted, ${failed.length} failed, ${allDeletedIds.length} ids for pin check`);

      try { await navigateToFolder(currentFolderId, { preservePath: true }); } catch (_) {}

      if (failed.length > 0 && typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Μερική αποτυχία',
          `${deleted} διαγράφηκαν, ${failed.length} απέτυχαν.`);
      }
    } finally { _actionInProgress = false; }
  }

  // ============================================================
  //  MULTI-TRANSFER
  // ============================================================
  async function _transferMultipleCards(items) {
    if (_actionInProgress) return;
    if (!Array.isArray(items) || items.length === 0) return;
    if (_checkSpaceTransitionGuard()) return;

    _actionInProgress = true;
    try {
      const sourceSpace = activeSpace;

      const targetSpace = activeSpace === 'firefox' ? 'encrypted' : 'firefox';
      if (targetSpace === 'encrypted') {
        const unlocked = await ensureVaultUnlocked('για μαζική μεταφορά');
        if (!unlocked) return;
      }
      log(`Multi-transfer: ${items.length} item(s) → ${targetSpace}`);

      let success = 0;
      const failed = [];
      const newIds = [];
      const transferredSourceIds = [];

      const itemsToTransfer = (targetSpace === 'encrypted')
        ? items.slice().reverse()
        : items;

      for (const item of itemsToTransfer) {
        try {
          let res;
          if (targetSpace === 'encrypted') {
            res = await CBF_UI_COORDINATOR.transferItemToEncrypted(item.id, item.type);
          } else {
            res = await CBF_UI_COORDINATOR.transferItemToFirefox(item.id, item.type);
          }
          if (res && res.success) {
            success++;
            if (res.id) newIds.push(res.id);
            transferredSourceIds.push(item.id);
          } else {
            failed.push({ id: item.id, error: res?.error || 'UNKNOWN' });
          }
        } catch (e) {
          warn(`_transferMultipleCards failed for ${item.id}:`, e.message);
          failed.push({ id: item.id, error: e.message });
        }
      }

      if (transferredSourceIds.length > 0) {
        for (const srcId of transferredSourceIds) {
          _notifyPinTransferred(sourceSpace, srcId);
        }
      }

      _carryOverSelectionIds = [];

      CBF_SELECTION_MANAGER.clear();
      _lastAnchorId = null;
      _applySelectionVisuals();
      _updateSelectionBadge();

      await CBF_BRIDGE.setActiveSpace(targetSpace);
      setActiveSpace(targetSpace);

      if (newIds.length > 0) {
        CBF_SELECTION_MANAGER.set(newIds[0]);
      }

      if (typeof window.CBF_Overlay_updateSpaceIndicator === 'function') {
        window.CBF_Overlay_updateSpaceIndicator(targetSpace);
      }
      if (typeof window.CBF_Overlay_refreshLockButtonIcon === 'function') {
        window.CBF_Overlay_refreshLockButtonIcon();
      }

      const targetRoot = targetSpace === 'encrypted' ? 'ecbf-root' : 'toolbar_____';
      const targetRootTitle = targetSpace === 'encrypted' ? 'Encrypted Root' : 'Bookmarks Toolbar';
      setCurrentFolderId(targetRoot);
      setBreadcrumbPath([{ id: targetRoot, title: targetRootTitle }]);
      await navigateToFolder(targetRoot);

      log(`Multi-transfer DONE: ${success} OK, ${failed.length} failed (carry=${newIds.length})`);
      if (failed.length > 0 && typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Μερική μεταφορά',
          `${success} μεταφέρθηκαν, ${failed.length} απέτυχαν.`);
      }
    } finally { _actionInProgress = false; }
  }

  // ============================================================
  //  M-16: ensureVaultUnlocked
  // ============================================================
  async function ensureVaultUnlocked(reasonText = 'για αυτή την ενέργεια') {
    if (_unlockPromptInProgress) {
      while (_unlockPromptInProgress) await new Promise(r => setTimeout(r, 50));
      try { const s = await CBF_BRIDGE.getStatus(); return s.unlocked === true; }
      catch (_) { return false; }
    }
    _unlockPromptInProgress = true;
    try {
      let status;
      try { status = await CBF_BRIDGE.getStatus(); }
      catch (e) { err('M-16: getStatus failed:', e.message); return false; }
      if (status.unlocked) return true;

      if (!status.initialized) {
        const password = await _promptPassword(
          `Δημιουργήστε κωδικό για τον κρυπτογραφημένο χώρο (${reasonText})`, true);
        if (!password) return false;
        if (password.length < 6) {
          if (typeof CBF_MODAL_SERVICE !== 'undefined') {
            await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.');
          }
          return false;
        }
        try { await CBF_BRIDGE.setup(password); return true; }
        catch (setupErr) {
          if (typeof CBF_MODAL_SERVICE !== 'undefined') {
            await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Δημιουργία απέτυχε: ' + setupErr.message);
          }
          return false;
        }
      }

      const password = await _promptPassword(
        `Ο κρυπτογραφημένος χώρος είναι κλειδωμένος. Εισάγετε κωδικό ${reasonText}:`, false);
      if (!password) return false;
      try { await CBF_BRIDGE.unlock(password); return true; }
      catch (unlockErr) {
        let msg = unlockErr.message;
        if (unlockErr.code === 'WRONG_PASSWORD' || /wrong/i.test(msg)) msg = 'Λάθος κωδικός πρόσβασης.';
        else if (unlockErr.code === 'COOLDOWN') msg = 'Πολλές αποτυχημένες προσπάθειες. Περιμένετε λίγο.';
        else if (unlockErr.code === 'RATE_LIMITED') msg = 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.';
        // 🔧 v12.2: Low-memory friendly message
        else if (/ARGON2_LOW_MEMORY/i.test(msg)) {
          msg = '⚠️ Χρειάζονται 64MB ελεύθερης μνήμης.\n\nΚλείστε μερικές καρτέλες και δοκιμάστε ξανά.';
        }
        if (typeof CBF_MODAL_SERVICE !== 'undefined') {
          await CBF_MODAL_SERVICE.showAlert('Σφάλμα', msg);
        }
        return false;
      }
    } finally { _unlockPromptInProgress = false; }
  }

  if (typeof window !== 'undefined') {
    if (!window.CBF_UI) window.CBF_UI = {};
    window.CBF_UI.ensureVaultUnlocked = ensureVaultUnlocked;
    window.CBF_UI_ensureVaultUnlocked = ensureVaultUnlocked;
  }

  // ============================================================
  //  Init
  // ============================================================
  function init(shadow, containerEl) {
    shadowRoot = shadow;
    container = containerEl;
    if (!container) { err('init: container is required'); return; }

    elements = {
      layer2:         container.querySelector('.layer2'),
      layer3:         container.querySelector('.layer3'),
      layer3Wrapper:  container.querySelector('.layer3-wrapper'),
      homeBtn:        container.querySelector('#cbf-home-btn'),
      backBtn:        container.querySelector('#cbf-back-btn'),
      breadcrumb:     container.querySelector('.breadcrumb'),
      arrowLeft:      container.querySelector('.scroll-arrow.left'),
      arrowRight:     container.querySelector('.scroll-arrow.right'),
      searchBar:      container.querySelector('#cbf-search-bar'),
      searchClear:    container.querySelector('#cbf-search-clear'),
      bulkLock:       container.querySelector('#cbf-bulk-lock'),
      bulkCount:      container.querySelector('#cbf-bulk-count'),
      selectionInfo:  container.querySelector('#cbf-selection-info'),
      selectionText:  container.querySelector('#cbf-selection-info-text')
    };

    attachEvents();
    startResizeObserver();
    updateLayer2();
    _setupFaviconUpdateListener();
    log(`Initialized (v12.3.0: BUG-1 favicon leak fix + bounded caches + adaptive low-end + search hover breadcrumb + multi-select) — low-end=${_IS_LOW_END}`);
  }

  // ============================================================
  //  Attach events
  // ============================================================
  function attachEvents() {
    log('Attaching UI events');

    // HOME BUTTON
    elements.homeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const root = activeSpace === 'encrypted'
        ? { id: 'ecbf-root',  title: 'Encrypted Root' }
        : { id: 'toolbar_____', title: 'Bookmarks Toolbar' };

      _clearSelection();
      setBreadcrumbPath([root]);
      updateLayer2();
      _pendingCenterScroll = true;
      navigateToFolder(root.id);
    });

    // BACK BUTTON
    elements.backBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = getBreadcrumbPath();
      if (path.length <= 1) return;

      const leavingFolderId = currentFolderId;

      path.pop();
      const prev = path[path.length - 1];
      setBreadcrumbPath(path);
      updateLayer2();

      if (leavingFolderId && leavingFolderId !== prev.id &&
          typeof CBF_SELECTION_MANAGER !== 'undefined') {
        CBF_SELECTION_MANAGER.set(leavingFolderId);
      }

      navigateToFolder(prev.id);
    });

    // BREADCRUMB CLICK
    elements.breadcrumb?.addEventListener('click', (e) => {
      const crumb = e.target.closest('.crumb:not(.current)');
      if (!crumb) return;
      e.stopPropagation(); e.preventDefault();
      const fid = crumb.dataset.folderId;
      if (!fid) return;

      const path = getBreadcrumbPath();
      const idx = path.findIndex(s => s.id === fid);
      if (idx === -1) return;

      const descendantId = path[idx + 1]?.id;

      setBreadcrumbPath(path.slice(0, idx + 1));
      updateLayer2();

      if (descendantId && descendantId !== fid &&
          typeof CBF_SELECTION_MANAGER !== 'undefined') {
        CBF_SELECTION_MANAGER.set(descendantId);
      }

      navigateToFolder(fid);
    });

    elements.arrowLeft?.addEventListener('click', (e) => { e.stopPropagation(); _moveSelection(-1); });
    elements.arrowRight?.addEventListener('click', (e) => { e.stopPropagation(); _moveSelection(1); });

    // 🔧 v12.2: scroll coalescing — single-flight RAF
    elements.layer3?.addEventListener('scroll', () => {
      if (_arrowsUpdateScheduled) return;
      _arrowsUpdateScheduled = true;
      requestAnimationFrame(() => {
        _updateArrowsForSelection();
        _arrowsUpdateScheduled = false;
      });
    });

    document.addEventListener('keydown', _onKeyDown);

    elements.bulkLock?.addEventListener('click', async (e) => {
      e.stopPropagation(); e.preventDefault();
      const items = _getSelectedItems();
      if (items.length < 2) {
        warn('Bulk-lock: fewer than 2 items selected — ignoring');
        return;
      }
      await _transferMultipleCards(items);
    });

    elements.bulkLock?.addEventListener('mousedown', (e) => { e.stopPropagation(); });

    log('UI events attached');
  }

  function _onKeyDown(e) {
    if (!e.isTrusted) return;
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.activeCount === 'function' &&
        CBF_MODAL_SERVICE.activeCount() > 0) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (isSearchActive) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      _selectAllVisible();
      _applySelectionVisuals();
      _updateSelectionBadge();
      return;
    }

    if (e.key === 'Escape') {
      if (CBF_SELECTION_MANAGER.hasSelection()) {
        e.preventDefault();
        _clearSelection();
        _applySelectionVisuals();
        _updateSelectionBadge();
        return;
      }
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = CBF_SELECTION_MANAGER.getPendingIds();
      if (ids.length >= 2) { e.preventDefault(); _deleteMultipleCards(ids); return; }
    }

    if (e.key === 'ArrowRight')      { e.preventDefault(); _moveSelection(1); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); _moveSelection(-1); }
    else if (e.key === 'Enter')      { e.preventDefault(); _activateSelection(); }
  }

  function startResizeObserver() {
    if (resizeObserver) resizeObserver.disconnect();
    if (elements.layer3 && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => _updateArrowsForSelection());
      resizeObserver.observe(elements.layer3);
    }
  }

  // ============================================================
  //  Breadcrumb
  // ============================================================
  function getBreadcrumbPath() {
    return CBF_BREADCRUMB_MANAGER.getPath(activeSpace);
  }

  function setBreadcrumbPath(path) {
    CBF_BREADCRUMB_MANAGER.setPath(activeSpace, path);
    updateLayer2();
  }

  function updateLayer2() {
    if (!elements.breadcrumb) return;
    elements.breadcrumb.innerHTML = '';

    const path = getBreadcrumbPath();
    path.forEach((seg, idx) => {
      const isLast = idx === path.length - 1;
      const c = document.createElement('span');
      c.className = 'crumb' + (isLast ? ' current' : '');
      c.textContent = seg.title || seg.id;
      c.dataset.folderId = seg.id;
      elements.breadcrumb.appendChild(c);

      if (!isLast) {
        const sep = document.createElement('span');
        sep.className = 'separator';
        sep.textContent = '›';
        elements.breadcrumb.appendChild(sep);
      }
    });

    if (elements.backBtn) {
      elements.backBtn.style.display = path.length > 1 ? 'flex' : 'none';
    }
    elements.breadcrumb.scrollLeft = elements.breadcrumb.scrollWidth;
  }

  // ============================================================
  //  Navigation (F-2) + v1.2 CARRY-OVER + v1.3 NAV-FOCUS/SCROLL
  //  + v1.3.1 CLEANUP + v1.3.6 SCROLL PRIORITY + v1.3.8 RACE FIX
  //  + 🔧 v12.2 RACE-01 space-change guard
  // ============================================================
  async function navigateToFolder(folderId, opts = {}) {
    const mySeq = ++_navSeq;
    const startSpace = activeSpace;   // 🔧 v12.2 RACE-01: capture start space
    log(`navigateToFolder: ${folderId} (seq=${mySeq}, space=${startSpace})`);

    const _preNavPendingIds = CBF_SELECTION_MANAGER.getPendingIds().slice();

    try {
      if (!opts.preservePath) {
        try {
          const res = await CBF_BRIDGE.getPath(folderId);
          if (mySeq !== _navSeq) return;
          // 🔧 v12.2 RACE-01: abort αν άλλαξε space
          if (activeSpace !== startSpace) {
            warn(`RACE-01: space changed during getPath (${startSpace} → ${activeSpace}) — aborting`);
            return;
          }
          if (res && Array.isArray(res.path) && res.path.length > 0) {
            setBreadcrumbPath(res.path);
          } else {
            setBreadcrumbPath([{ id: folderId, title: folderNameCache.get(folderId) || folderId }]);
          }
        } catch (e) {
          if (mySeq !== _navSeq) return;
          if (activeSpace !== startSpace) return;
          warn('getPath failed:', e.message);
          setBreadcrumbPath([{ id: folderId, title: folderNameCache.get(folderId) || folderId }]);
        }
      }

      const res = await CBF_BRIDGE.queryTree(folderId, 100);
      if (mySeq !== _navSeq) return;
      // 🔧 v12.2 RACE-01: abort αν άλλαξε space
      if (activeSpace !== startSpace) {
        warn(`RACE-01: space changed during queryTree (${startSpace} → ${activeSpace}) — aborting`);
        return;
      }

      if (res && res.space && res.space !== activeSpace) {
        warn(`queryTree space MISMATCH: got=${res.space}, ui=${activeSpace}`);
        return;
      }

      const items = Array.isArray(res.items) ? res.items : [];
      items.sort((a, b) => {
        const pa = a.positionKey || '', pb = b.positionKey || '';
        if (pa < pb) return -1;
        if (pa > pb) return 1;
        const ia = a.id || '', ib = b.id || '';
        return ia < ib ? -1 : (ia > ib ? 1 : 0);
      });

      for (const item of items) {
        if (item.type === 'folder') {
          // 🔧 v12.2: bounded LRU
          _boundedMapSet(folderNameCache, item.id, item.title || '', MAX_FOLDER_NAME_CACHE);
        }
      }

      currentFolderId = folderId;
      currentItems = items;
      originalItems = items.slice();
      isSearchActive = false;
      currentSearchQuery = '';

      _clearSelection();

      let hasCarryOver = false;
      if (_carryOverSelectionIds.length > 0) {
        const carryIds = _carryOverSelectionIds;
        const visibleCarry = carryIds.filter(id => items.some(i => i.id === id));

        if (visibleCarry.length > 0) {
          if (visibleCarry.length === 1) {
            CBF_SELECTION_MANAGER.set(visibleCarry[0]);
          } else {
            CBF_SELECTION_MANAGER.setMultiple(visibleCarry);
          }
          _lastAnchorId = visibleCarry[0];
          hasCarryOver = true;
        }

        _carryOverSelectionIds = [];
      }

      let hasNavFocus = false;
      if (!hasCarryOver && _preNavPendingIds.length > 0) {
        const visible = _preNavPendingIds.filter(id => items.some(i => i.id === id));
        if (visible.length >= 1) {
          CBF_SELECTION_MANAGER.set(visible[0]);
          hasNavFocus = true;
        }
      }

      CBF_REPLICA.setCurrentParentId(folderId);
      CBF_REPLICA.setItems(items);

      const newGen = res.generation || 0;
      const isFirefox = (activeSpace === 'firefox');

      if (isFirefox) {
        CBF_REPLICA.setGeneration(newGen, /* force */ true);
        if (typeof CBF_BRIDGE._forceSetGeneration === 'function') {
          CBF_BRIDGE._forceSetGeneration(0);
        }
      } else {
        CBF_REPLICA.setGeneration(newGen);
        if (typeof CBF_BRIDGE._forceSetGeneration === 'function') {
          CBF_BRIDGE._forceSetGeneration(newGen);
        }
      }

      if (hasNavFocus) {
        _applyPendingSelection();
      } else if (hasCarryOver) {
        const ids = CBF_SELECTION_MANAGER.getPendingIds();
        const idx = ids.length > 0 ? items.findIndex(i => i.id === ids[0]) : -1;
        selectedIndex = idx !== -1 ? idx : (items.length > 0 ? 0 : -1);
      } else {
        selectedIndex = items.length > 0 ? 0 : -1;
      }

      hoveredIndex = -1;
      hoveredCardElement = null;

      renderLayer3();
      _updateCardHighlight();

      if (hasNavFocus) {
        _pendingCenterScroll = false;
        _scrollToSelected();
      } else if (CBF_SELECTION_MANAGER.getPendingIds().length > 0) {
        _pendingCenterScroll = false;
        _scrollSelectionToCenter();
      } else if (_pendingCenterScroll) {
        _pendingCenterScroll = false;
        _scrollToMiddle();
      } else {
        _scrollToSelected();
      }

      _updateArrowsForSelection();

      log(`navigateToFolder DONE: ${items.length} items (seq=${mySeq}, carry=${hasCarryOver}, nav=${hasNavFocus})`);

      _fireNavigate(folderId);

    } catch (e) {
      if (mySeq !== _navSeq) return;
      err('navigateToFolder FAILED:', e.message);
      throw e;
    }
  }

  function _applyPendingSelection() {
    const pendingIds = CBF_SELECTION_MANAGER.getPendingIds();
    if (pendingIds.length === 0) return;

    const foundIdx = [];
    for (const pid of pendingIds) {
      const idx = currentItems.findIndex(i => i.id === pid);
      if (idx !== -1) foundIdx.push(idx);
    }

    if (foundIdx.length > 0) {
      selectedIndex = foundIdx[0];
      const foundIds = foundIdx.map(i => currentItems[i].id);
      CBF_SELECTION_MANAGER.removeFound(foundIds);
    } else {
      if (!CBF_SELECTION_MANAGER.shouldRetry()) {
        selectedIndex = currentItems.length > 0 ? 0 : -1;
      } else {
        selectedIndex = currentItems.length > 0 ? 0 : -1;
      }
    }
  }

  // ============================================================
  //  Render (+ v1.2 auto-scroll)
  // ============================================================
  function renderLayer3() {
    const layer3 = elements.layer3;
    if (!layer3) return;

    while (layer3.firstChild) layer3.removeChild(layer3.firstChild);

    log(`renderLayer3: ${currentItems.length} items, space=${activeSpace}`);

    if (currentItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-message';
      empty.textContent = isSearchActive ? 'Δεν βρέθηκαν αποτελέσματα' : 'Κενός φάκελος';
      layer3.appendChild(empty);
      _updateArrowsForSelection();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < currentItems.length; i++) {
      fragment.appendChild(_createCardElement(currentItems[i], i));
    }
    layer3.appendChild(fragment);

    _applySelectionVisuals();
    _updateSelectionBadge();

    if (CBF_SELECTION_MANAGER.getPendingIds().length > 0) {
      _scrollSelectionToCenter();
    }
  }

  // ============================================================
  //  Card element
  // ============================================================
  function _createCardElement(item, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.draggable = true;
    card.dataset.id = item.id;
    card.dataset.type = item.type;

    card.addEventListener('mouseenter', () => _setHoveredCard(card, index));
    card.addEventListener('mouseleave', () => { if (hoveredIndex === index) _clearHover(); });

    let cardColor = 'rgba(255,255,255,0.25)';
    let faviconBg = 'none';

    if (item.type === 'bookmark' && item.url) {
      const hostname = _getHostname(item.url);
      const cachedColor = _faviconColorCache.get(hostname);
      const cachedImg = _faviconCache.get(hostname);
      if (cachedColor && cachedColor.startsWith('rgb')) {
        const hsla = _rgbToHsla(cachedColor, 0.35);
        cardColor = hsla || _getColorFromUrl(item.url);
      } else {
        cardColor = _getColorFromUrl(item.url);
      }
      if (typeof cachedImg === 'string' && cachedImg.startsWith('data:')) {
        faviconBg = `url("${cachedImg}")`;
      }
    } else if (item.type === 'folder') {
      cardColor = 'hsla(45,70%,55%,0.35)';
    }

    card.style.setProperty('--card-color', cardColor);
    card.style.setProperty('--card-color-solid', _solidColor(cardColor));
    card.style.setProperty('--favicon-bg', faviconBg);

    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'card-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Διαγραφή';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      _deleteCard(item);
    });
    deleteBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    card.appendChild(deleteBtn);

    const lockBtn = document.createElement('span');
    lockBtn.className = 'card-lock';
    lockBtn.title = activeSpace === 'firefox'
      ? (item.type === 'folder' ? 'Μεταφορά φακέλου σε κρυπτογραφημένο χώρο' : 'Μεταφορά σε κρυπτογραφημένο χώρο')
      : (item.type === 'folder' ? 'Μεταφορά φακέλου στον Firefox' : 'Μεταφορά στον Firefox');

    const lockImgEl = document.createElement('img');
    lockImgEl.src = activeSpace === 'firefox'
      ? browser.runtime.getURL('icons/lock.svg')
      : browser.runtime.getURL('icons/unlock.svg');
    lockImgEl.alt = activeSpace === 'firefox' ? 'Lock' : 'Unlock';
    lockImgEl.style.cssText = 'width: 16px; height: 16px; pointer-events: none;';
    lockBtn.appendChild(lockImgEl);
    lockBtn.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      _transferCard(item);
    });
    lockBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    card.appendChild(lockBtn);

    const iconDiv = document.createElement('div');
    iconDiv.className = 'card-icon';

    if (item.type === 'bookmark' && item.url) {
      const avatar = document.createElement('div');
      avatar.className = 'card-avatar';
      avatar.style.backgroundColor = _getAvatarColor(item.url);
      avatar.textContent = _getInitial(item.url);
      iconDiv.appendChild(avatar);
      _fetchFaviconAsync(item.url, iconDiv, avatar, card).catch(() => {});
    } else if (item.type === 'folder') {
      const img = document.createElement('img');
      img.src = browser.runtime.getURL('icons/folder.svg');
      img.alt = 'Folder';
      img.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.4))';
      img.addEventListener('error', () => {
        iconDiv.innerHTML = '';
        iconDiv.textContent = '📁';
        iconDiv.style.fontSize = '30px';
      });
      iconDiv.appendChild(img);
    }
    card.appendChild(iconDiv);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'card-title';
    titleDiv.textContent = item.title || '(χωρίς τίτλο)';
    card.appendChild(titleDiv);

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      const selResult = _onCardClick(item, card, e);
      if (selResult) return;
      if (onCardAction) {
        const handled = onCardAction(item, card, e);
        if (handled) return;
      }
      _activateItem(item);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (onContextMenu) onContextMenu(item, card, e);
    });

    return card;
  }

  // ============================================================
  //  DELETE card (single) — + pin notify
  // ============================================================
  async function _deleteCard(item) {
    if (_actionInProgress) return;
    if (!item || !item.id) return;
    if (_checkSpaceTransitionGuard()) return;

    _actionInProgress = true;
    try {
      if (activeSpace === 'encrypted') {
        const unlocked = await ensureVaultUnlocked('για διαγραφή');
        if (!unlocked) return;
      }

      const title = item.title || item.id;
      const isFolder = item.type === 'folder';
      const confirmMsg = isFolder
        ? `Διαγραφή φακέλου "${title}" και όλου του περιεχομένου του;`
        : `Διαγραφή "${title}";`;

      let ok = false;
      if (typeof CBF_MODAL_SERVICE !== 'undefined' && CBF_MODAL_SERVICE.showConfirm) {
        ok = await CBF_MODAL_SERVICE.showConfirm(confirmMsg);
      } else { ok = window.confirm(confirmMsg); }
      if (!ok) return;

      if (activeSpace === 'encrypted') {
        const gen = (typeof CBF_BRIDGE.getGeneration === 'function') ? CBF_BRIDGE.getGeneration() : 0;
        log(`_deleteCard: id=${item.id.slice(0,8)} gen=${gen}`);
        const res = await CBF_BRIDGE.delete({ id: item.id }, gen);
        const deletedIds = Array.isArray(res?.result?.deletedIds)
          ? res.result.deletedIds
          : [item.id];
        _removeItemFromState(item.id);
        _removeCardFromDOM(item.id);
        _refreshSelectionAfterMutation();
        _notifyPinDeleted(deletedIds);
        log(`Deleted (encrypted): ${item.id} (${deletedIds.length} ids)`);
      } else {
        await CBF_BRIDGE.firefoxRemove(item.id);
        _removeItemFromState(item.id);
        _removeCardFromDOM(item.id);
        _refreshSelectionAfterMutation();
        _notifyPinDeleted([item.id]);
        log(`Deleted (firefox): ${item.id}`);
      }
    } catch (e) {
      err('_deleteCard failed:', e.message);
      if (e.code === 'STALE_GENERATION') {
        try { await navigateToFolder(currentFolderId, { preservePath: true }); } catch (_) {}
      } else if (typeof CBF_BRIDGE.hardReset === 'function') {
        CBF_BRIDGE.hardReset();
        try { await navigateToFolder(currentFolderId); } catch (_) {}
      } else {
        navigateToFolder(currentFolderId);
      }
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Διαγραφή απέτυχε: ' + e.message);
      }
    } finally { _actionInProgress = false; }
  }

  // ============================================================
  //  TRANSFER card (single) — + auto-unpin
  // ============================================================
  async function _transferCard(item) {
    if (_actionInProgress) return;
    if (!item || !item.id) return;
    if (_checkSpaceTransitionGuard()) return;

    _actionInProgress = true;
    try {
      const sourceSpace = activeSpace;

      let targetSpace, res;
      if (activeSpace === 'firefox') {
        targetSpace = 'encrypted';
        const unlocked = await ensureVaultUnlocked('για μεταφορά');
        if (!unlocked) return;
        res = await CBF_UI_COORDINATOR.transferItemToEncrypted(item.id, item.type);
      } else {
        targetSpace = 'firefox';
        res = await CBF_UI_COORDINATOR.transferItemToFirefox(item.id, item.type);
      }

      if (!res || !res.success) {
        let errMsg = res?.error || 'TRANSFER_FAILED';
        if (res?.error === 'SCAN_LIMIT_EXCEEDED') {
          const scanReason = res?.details || 'SCAN_ITEM_LIMIT_EXCEEDED';
          if (scanReason === 'SCAN_DEPTH_EXCEEDED') {
            errMsg = 'Ο φάκελος έχει πολύ βαθιά δομή (πάνω από 20 επίπεδα). Δοκιμάστε να τον αναδιοργανώσετε.';
          } else if (scanReason === 'SCAN_ITEM_LIMIT_EXCEEDED') {
            errMsg = 'Ο φάκελος είναι πολύ μεγάλος (πάνω από 5000 στοιχεία). Δοκιμάστε να τον σπάσετε σε μικρότερους.';
          } else {
            errMsg = 'Ο φάκελος ξεπερνά τα όρια σάρωσης.';
          }
        } else if (res?.details && Array.isArray(res.details) && res.details.length > 0) {
          const preview = res.details.slice(0, 3).map(d =>
            `• ${_sanitizeUrlForDisplay(d.url) || '(χωρίς URL)'} — ${d.reason || 'invalid'}`).join('\n');
          errMsg = `Ο φάκελος περιέχει ${res.details.length} μη έγκυρα URL(s):\n\n${preview}`;
          if (res.details.length > 3) errMsg += `\n... και ${res.details.length - 3} ακόμα`;
        } else if (res?.details && typeof res.details === 'string') {
          errMsg += ': ' + res.details;
        }
        throw new Error(errMsg);
      }

      _notifyPinTransferred(sourceSpace, item.id);

      log(`Transferred ${item.id} → ${targetSpace}`);
      await CBF_BRIDGE.setActiveSpace(targetSpace);
      setActiveSpace(targetSpace);

      if (typeof window.CBF_Overlay_updateSpaceIndicator === 'function') {
        window.CBF_Overlay_updateSpaceIndicator(targetSpace);
      }
      if (typeof window.CBF_Overlay_refreshLockButtonIcon === 'function') {
        window.CBF_Overlay_refreshLockButtonIcon();
      }

      const targetRoot = targetSpace === 'encrypted' ? 'ecbf-root' : 'toolbar_____';
      const targetRootTitle = targetSpace === 'encrypted' ? 'Encrypted Root' : 'Bookmarks Toolbar';
      setCurrentFolderId(targetRoot);
      setBreadcrumbPath([{ id: targetRoot, title: targetRootTitle }]);

      if (res.id && typeof CBF_SELECTION_MANAGER !== 'undefined') {
        CBF_SELECTION_MANAGER.set(res.id);
      }

      await navigateToFolder(targetRoot);

      if (res.warnings && Array.isArray(res.warnings) && res.warnings.length > 0) {
        const preview = res.warnings.slice(0, 5).map(w => `• ${w.message || w.type}`).join('\n');
        if (typeof CBF_MODAL_SERVICE !== 'undefined') {
          await CBF_MODAL_SERVICE.showAlert('Πληροφορία',
            `Η μεταφορά ολοκληρώθηκε με ${res.warnings.length} προειδοποίηση(εις):\n\n${preview}` +
            (res.warnings.length > 5 ? `\n... και ${res.warnings.length - 5} ακόμα` : ''));
        }
      }
    } catch (e) {
      err('_transferCard failed:', e.message);
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα μεταφοράς', e.message);
      }
    } finally { _actionInProgress = false; }
  }

  // ============================================================
  //  Password prompt helpers
  // ============================================================
  async function _promptPassword(title, confirmField = false) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.promptForPassword === 'function') {
      return await CBF_MODAL_SERVICE.promptForPassword(title, confirmField);
    }
    if (typeof window.CBF_Overlay_promptForPassword === 'function') {
      return await window.CBF_Overlay_promptForPassword(title, confirmField);
    }
    return window.prompt(title);
  }

  async function _promptUnlock(title) {
    return await _promptPassword(title, false);
  }

  // ============================================================
  //  V12E (D-52): Bookmark open in current tab
  // ============================================================
  async function _openBookmarkInCurrentTab(item) {
    if (!item || item.type !== 'bookmark') return;

    const url = item.url;
    const sanitized = _sanitizeUrlForDisplay(url);

    if (!url || typeof url !== 'string') {
      warn(`_openBookmarkInCurrentTab: no URL for ${item.id}`);
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Κενός σελιδοδείκτης',
          `Ο σελιδοδείκτης "${item.title || item.id}" δεν έχει URL.`);
      }
      return;
    }

    if (!/^https?:\/\//i.test(url)) {
      warn(`_openBookmarkInCurrentTab: non-http URL: ${sanitized}`);
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Μη υποστηριζόμενο URL',
          `Ο σελιδοδείκτης "${item.title || item.id}" έχει URL που δεν μπορεί να ανοίξει.\n\n` +
          `URL: ${sanitized}\n\n` +
          `Υποστηρίζονται μόνο http:// και https:// σελιδοδείκτες.`);
      }
      return;
    }

    if (typeof CBF_BRIDGE === 'undefined' || typeof CBF_BRIDGE.send !== 'function') {
      err('_openBookmarkInCurrentTab: CBF_BRIDGE.send not available');
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Η γέφυρα δεν είναι διαθέσιμη.');
      }
      return;
    }

    log(`_openBookmarkInCurrentTab: id=${item.id.slice(0,8)} url=${sanitized}`);

    try {
      const res = await CBF_BRIDGE.send('openInCurrentTab', { url });

      if (!res || !res.success) {
        const code = res?.error || 'OPEN_FAILED';
        throw Object.assign(new Error(code), { code });
      }

      log(`_openBookmarkInCurrentTab: SUCCESS tabId=${res.tabId}`);

      if (typeof window.CBF_closeOverlay === 'function') {
        try { window.CBF_closeOverlay(); } catch (_) {}
      } else if (typeof window.CBF !== 'undefined' && typeof window.CBF.closeOverlay === 'function') {
        try { window.CBF.closeOverlay(); } catch (_) {}
      }

    } catch (e) {
      warn(`_openBookmarkInCurrentTab FAILED: ${e.message}`);

      const code = e.code || '';
      const msg = e.message || '';

      let friendly = 'Αποτυχία ανοίγματος σελιδοδείκτη.';

      if (code === 'INVALID_URL_PROTOCOL' || /INVALID_URL_PROTOCOL/.test(msg)) {
        friendly = 'Μη υποστηριζόμενο URL. Υποστηρίζονται μόνο http(s).';
      } else if (code === 'URL_TOO_LONG' || /URL_TOO_LONG/.test(msg)) {
        friendly = 'Το URL είναι πολύ μεγάλο.';
      } else if (code === 'NOT_FOUND' || /NOT_FOUND/.test(msg)) {
        friendly = 'Ο σελιδοδείκτης δεν βρέθηκε. Μπορεί να διαγράφηκε.';
        setTimeout(() => { navigateToFolder(currentFolderId, { preservePath: true }); }, 100);
      } else if (code === 'NO_TAB_ID' || /NO_TAB_ID/.test(msg)) {
        friendly = 'Δεν βρέθηκε ενεργή καρτέλα.';
      } else if (code === 'RATE_LIMITED' || /rate/i.test(msg)) {
        friendly = 'Πολλές ενέργειες. Δοκιμάστε ξανά σε λίγο.';
      } else if (code === 'COOLDOWN') {
        friendly = 'Περιμένετε λίγο πριν δοκιμάσετε ξανά.';
      } else if (code === 'OPEN_FAILED' || code === 'OPEN_IN_CURRENT_FAILED') {
        friendly = 'Αποτυχία ανοίγματος. Δοκιμάστε ξανά.';
      } else if (msg) {
        friendly = msg;
      }

      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα', friendly);
      }
    }
  }

  // ============================================================
  //  Activate item — V12E: bookmark → openInCurrentTab
  // ============================================================
  async function _activateItem(item) {
    if (!item) return;

    log(`_activateItem: id=${item.id.slice(0,8)} type=${item.type}`);

    if (item.type === 'folder') {
      log(`_activateItem: navigating to folder ${item.id.slice(0,8)}`);
      const path = getBreadcrumbPath();
      const newPath = path.concat([{ id: item.id, title: item.title || item.id }]);
      setBreadcrumbPath(newPath);
      await navigateToFolder(item.id, { preservePath: true });
      return;
    }

    if (item.type === 'bookmark') {
      await _openBookmarkInCurrentTab(item);
    }
  }

  function _activateSelection() {
    if (selectedIndex >= 0 && selectedIndex < currentItems.length) {
      _activateItem(currentItems[selectedIndex]);
    }
  }

  // ============================================================
  //  Selection / Navigation — + logging
  // ============================================================
  function _moveSelection(delta) {
    _clearHover();
    if (currentItems.length === 0) {
      selectedIndex = -1;
      _updateArrowsForSelection();
      log(`_moveSelection(${delta}): empty list`);
      return;
    }
    if (selectedIndex === -1) { selectedIndex = 0; }
    else {
      selectedIndex += delta;
      if (selectedIndex < 0) selectedIndex = 0;
      if (selectedIndex >= currentItems.length) selectedIndex = currentItems.length - 1;
    }
    log(`_moveSelection(${delta}): idx=${selectedIndex}/${currentItems.length}`);
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();
  }

  function _updateCardHighlight() {
    if (!elements.layer3) return;
    const cards = elements.layer3.querySelectorAll('.card');
    cards.forEach(c => c.classList.remove('card-center'));
    if (selectedIndex < 0 || selectedIndex >= currentItems.length) return;
    if (hoveredIndex !== -1) return;
    const item = currentItems[selectedIndex];
    if (!item) return;
    const card = elements.layer3.querySelector(`.card[data-id="${item.id}"]`);
    if (card) card.classList.add('card-center');
  }

  function _scrollToSelected() {
    if (selectedIndex === -1 || currentItems.length === 0) return;
    const layer3 = elements.layer3;
    if (!layer3) return;
    const item = currentItems[selectedIndex];
    if (!item) return;
    const card = layer3.querySelector(`.card[data-id="${item.id}"]`);
    if (!card) return;
    const tryScroll = (attempt = 0) => {
      const offset = card.offsetLeft;
      const width  = card.offsetWidth;
      const view   = layer3.clientWidth;
      const scrollWidth = layer3.scrollWidth;
      let desired = offset - (view / 2) + (width / 2);
      desired = Math.max(0, Math.min(desired, scrollWidth - view));
      layer3.scrollLeft = desired;
      if (Math.abs(layer3.scrollLeft - desired) > 1 && attempt < 5) {
        requestAnimationFrame(() => tryScroll(attempt + 1));
      }
    };
    requestAnimationFrame(() => tryScroll(0));
  }

  function _updateArrowsForSelection() {
    if (!elements.arrowLeft || !elements.arrowRight) return;
    if (currentItems.length === 0) {
      elements.arrowLeft.classList.add('hidden');
      elements.arrowRight.classList.add('hidden');
      return;
    }
    elements.arrowLeft.classList.toggle('hidden', selectedIndex <= 0);
    elements.arrowRight.classList.toggle('hidden', selectedIndex >= currentItems.length - 1);
  }

  // ============================================================
  //  Hover — V12E.E: + search breadcrumb update
  // ============================================================
  function _setHoveredCard(cardElement, index) {
    if (hoveredIndex === index) return;
    if (hoveredCardElement) hoveredCardElement.classList.remove('card-center');
    hoveredIndex = index;
    hoveredCardElement = cardElement;
    if (cardElement) cardElement.classList.add('card-center');

    if (isSearchActive && index >= 0 && index < currentItems.length) {
      _scheduleSearchBreadcrumbUpdate(currentItems[index].id);
    }
  }

  function _clearHover() {
    if (hoveredIndex === -1) return;
    if (hoveredCardElement) hoveredCardElement.classList.remove('card-center');
    hoveredIndex = -1;
    hoveredCardElement = null;
    _updateCardHighlight();
  }

  // ============================================================
  //  Search
  // ============================================================
  function search(query) {
    if (typeof query !== 'string' || query.trim() === '') return;
    isSearchActive = true;

    _clearSelection();
    _applySelectionVisuals();
    _updateSelectionBadge();

    const results = CBF_REPLICA.search(query);
    currentItems = results.slice();
    currentItems.sort((a, b) => {
      const ta = (a.title || '').toLowerCase();
      const tb = (b.title || '').toLowerCase();
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });

    selectedIndex = currentItems.length > 0 ? 0 : -1;
    _clearHover();
    renderLayer3();
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();
    log(`Search (local) "${query}": ${currentItems.length} results`);

    if (currentItems.length > 0) {
      _cachePreSearchBreadcrumb();
      if (selectedIndex >= 0) {
        _doUpdateSearchBreadcrumb(currentItems[selectedIndex].id).catch(() => {});
      }
    }
  }

  // ============================================================
  //  v1.5.0 + V12E.E: setSearchResults — GLOBAL search results
  // ============================================================
  function setSearchResults(results) {
    if (!Array.isArray(results)) results = [];

    isSearchActive = true;

    _clearSelection();
    _applySelectionVisuals();
    _updateSelectionBadge();

    currentItems = results.map(item => ({
      id: item.id,
      parentId: item.parentId || null,
      positionKey: item.positionKey || '000000',
      type: item.type === 'folder' ? 'folder' : 'bookmark',
      title: item.title || '',
      url: item.url || null
    }));

    currentItems.sort((a, b) => {
      const ta = (a.title || '').toLowerCase();
      const tb = (b.title || '').toLowerCase();
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });

    selectedIndex = currentItems.length > 0 ? 0 : -1;
    _clearHover();
    renderLayer3();
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();

    log(`Search (global): ${currentItems.length} results rendered`);

    if (currentItems.length > 0) {
      _cachePreSearchBreadcrumb();
      if (selectedIndex >= 0) {
        _doUpdateSearchBreadcrumb(currentItems[selectedIndex].id).catch(() => {});
      }
    }
  }

  function clearSearch() {
    isSearchActive = false;
    currentSearchQuery = '';
    if (elements.searchBar) elements.searchBar.value = '';
    if (elements.searchClear) elements.searchClear.style.display = 'none';
    currentItems = originalItems.slice();
    selectedIndex = currentItems.length > 0 ? 0 : -1;
    _clearHover();
    renderLayer3();
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();

    if (_preSearchBreadcrumbPath !== null) {
      CBF_BREADCRUMB_MANAGER.setPath(activeSpace, _preSearchBreadcrumbPath);
      updateLayer2();
      log(`Search breadcrumb: restored pre-search path (${_preSearchBreadcrumbPath.length} segments)`);
    }
    _clearSearchBreadcrumbState();
  }

  function isSearchActiveFn() { return isSearchActive; }

  // ============================================================
  //  Set items
  // ============================================================
  function setItems(items) {
    currentItems = Array.isArray(items) ? items.slice() : [];
    originalItems = currentItems.slice();

    currentItems.sort((a, b) => {
      const pa = a.positionKey || '', pb = b.positionKey || '';
      if (pa < pb) return -1;
      if (pa > pb) return 1;
      const ia = a.id || '', ib = b.id || '';
      return ia < ib ? -1 : (ia > ib ? 1 : 0);
    });

    for (const item of currentItems) {
      if (item.type === 'folder') {
        // 🔧 v12.2: bounded LRU
        _boundedMapSet(folderNameCache, item.id, item.title || '', MAX_FOLDER_NAME_CACHE);
      }
    }

    if (currentItems.length === 0) selectedIndex = -1;
    else if (selectedIndex < 0 || selectedIndex >= currentItems.length) selectedIndex = 0;

    renderLayer3();
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();
  }

  // ============================================================
  //  Setters / Getters
  // ============================================================
  function setCurrentFolderId(fid) { currentFolderId = fid; selectedIndex = -1; }
  function getCurrentFolderId() { return currentFolderId; }
  function getVisibleItems() { return currentItems.slice(); }

  // ============================================================
  //  M-7 + L-05: getSelectedItemIdsInOrder
  // ============================================================
  function getSelectedItemIdsInOrder() {
    const pendingIds = CBF_SELECTION_MANAGER.getPendingIds();
    if (!Array.isArray(pendingIds) || pendingIds.length === 0) {
      return { ids: [], missingIds: [], totalMissing: 0, hasMissing: false };
    }
    const visibleIds = new Set(currentItems.map(i => i.id));
    const ids = [], missingIds = [];
    for (const id of pendingIds) {
      if (visibleIds.has(id)) ids.push(id);
      else missingIds.push(id);
    }
    const orderMap = new Map();
    currentItems.forEach((item, idx) => orderMap.set(item.id, idx));
    ids.sort((a, b) => {
      const ia = orderMap.get(a) ?? Infinity;
      const ib = orderMap.get(b) ?? Infinity;
      return ia - ib;
    });
    const totalMissing = missingIds.length;
    const missingIdsCapped = missingIds.slice(0, MAX_MISSING_IDS_RETURNED);
    const wasCapped = totalMissing > MAX_MISSING_IDS_RETURNED;
    const hasMissing = totalMissing > 0;
    if (hasMissing) {
      warn(`getSelectedItemIdsInOrder: ${ids.length} visible, ${totalMissing} cross-folder` +
        (wasCapped ? ` (returning first ${MAX_MISSING_IDS_RETURNED})` : '') +
        ` [${missingIdsCapped.slice(0, 3).join(', ')}${missingIdsCapped.length > 3 ? '...' : ''}]`);
    }
    return { ids, missingIds: missingIdsCapped, totalMissing, hasMissing };
  }

  function getSelectedItemIdsInOrderLegacy() {
    const result = getSelectedItemIdsInOrder();
    if (result.hasMissing) {
      warn('getSelectedItemIdsInOrderLegacy: ' + `${result.totalMissing} cross-folder IDs ignored`);
    }
    return result.ids;
  }

  // ============================================================
  //  L-6: setActiveSpace (+ v1.3 pending center scroll)
  // ============================================================
  function setActiveSpace(space) {
    activeSpace = space === 'encrypted' ? 'encrypted' : 'firefox';
    currentItems = [];
    originalItems = [];
    selectedIndex = -1;
    _clearHover();
    _clearSelection();
    _navSeq = 0;

    _pendingCenterScroll = true;

    _clearSearchBreadcrumbState();

    if (elements.layer3) {
      while (elements.layer3.firstChild) elements.layer3.removeChild(elements.layer3.firstChild);
    }
    if (elements.arrowLeft) elements.arrowLeft.classList.add('hidden');
    if (elements.arrowRight) elements.arrowRight.classList.add('hidden');

    log(`setActiveSpace: ${activeSpace} (navSeq reset, pendingCenterScroll=true)`);
  }
  function getActiveSpace() { return activeSpace; }

  // ============================================================
  //  Reset
  // ============================================================
  function reset() {
    log('reset');
    currentItems = [];
    originalItems = [];
    selectedIndex = -1;
    isSearchActive = false;
    currentSearchQuery = '';
    _clearHover();
    _clearSelection();
    _clearSearchBreadcrumbState();
    CBF_BREADCRUMB_MANAGER.reset(activeSpace);
    updateLayer2();
    if (elements.layer3) {
      while (elements.layer3.firstChild) elements.layer3.removeChild(elements.layer3.firstChild);
    }
    _updateArrowsForSelection();
    _updateSelectionBadge();
  }

  function resetKeepBreadcrumb() {
    log('resetKeepBreadcrumb');
    currentItems = [];
    originalItems = [];
    selectedIndex = -1;
    isSearchActive = false;
    currentSearchQuery = '';
    _clearHover();
    _clearSelection();
    _clearSearchBreadcrumbState();
    updateLayer2();
    if (elements.layer3) {
      while (elements.layer3.firstChild) elements.layer3.removeChild(elements.layer3.firstChild);
    }
    _updateArrowsForSelection();
    _updateSelectionBadge();
  }

  // ============================================================
  //  Destroy — 🔧 v12.2: full memory cleanup (MEM-06 fix)
  // ============================================================
  function destroy() {
    log('destroy');
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    document.removeEventListener('keydown', _onKeyDown);

    // ═══ Favicon caches (existing) ═══
    _faviconCache.clear();
    _faviconPending.clear();
    _faviconColorCache.clear();
    _faviconQueue.length = 0;
    _faviconRetries.clear();
    _faviconActive = 0;
    _faviconUpdateListenerRegistered = false;

    // ═══ 🔧 v12.2 MEM-06: folderNameCache cleanup (LEAK FIX) ═══
    folderNameCache.clear();
    folderNameCache = new Map();

    // ═══ 🔧 v12.2: Search breadcrumb cache cleanup ═══
    _searchPathCache.clear();
    _clearSearchBreadcrumbState();

    // ═══ 🔧 v12.2: Flags + counters reset ═══
    _arrowsUpdateScheduled = false;
    _pendingCenterScroll = false;
    _carryOverSelectionIds = [];
    _lastAnchorId = null;
    _navSeq = 0;
    _actionInProgress = false;
    _unlockPromptInProgress = false;

    if (_selectionInfoTimer) {
      clearTimeout(_selectionInfoTimer);
      _selectionInfoTimer = null;
    }

    elements = {};
    shadowRoot = null;
    container = null;
    currentItems = [];
    originalItems = [];
    log('destroy complete (all caches + flags cleared)');
  }

  // ============================================================
  //  Optimistic UI
  // ============================================================
  function applyLocalMoveSingle(itemId, targetFolderId, position = 'inside', targetId = null) {
    log(`applyLocalMoveSingle: ${itemId} → ${targetFolderId} (${position}${targetId ? ' @ ' + targetId : ''})`);
    const sourceIdx = currentItems.findIndex(i => i.id === itemId);
    if (sourceIdx === -1) return;

    if (targetFolderId && targetFolderId !== currentFolderId) {
      currentItems.splice(sourceIdx, 1);
      _removeCardFromDOM(itemId);
      if (currentItems.length === 0) {
        selectedIndex = -1;
        CBF_SELECTION_MANAGER.clear();
      } else {
        selectedIndex = Math.min(sourceIdx, currentItems.length - 1);
        CBF_SELECTION_MANAGER.set(currentItems[selectedIndex]?.id || null);
      }
      _updateCardHighlight();
      _updateArrowsForSelection();
      return;
    }

    let newIndex;
    if (position === 'inside') newIndex = currentItems.length - 1;
    else if (position === 'before' || position === 'after') {
      const targetIdx = currentItems.findIndex(i => i.id === targetId);
      if (targetIdx === -1) { warn(`applyLocalMoveSingle: targetId not found: ${targetId}`); return; }
      let effIdx = targetIdx;
      if (sourceIdx < targetIdx) effIdx = targetIdx - 1;
      newIndex = position === 'before' ? effIdx : effIdx + 1;
    } else return;

    newIndex = Math.max(0, Math.min(newIndex, currentItems.length - 1));
    if (newIndex === sourceIdx) return;

    const [movedItem] = currentItems.splice(sourceIdx, 1);
    currentItems.splice(newIndex, 0, movedItem);

    if (elements.layer3) {
      const fragment = document.createDocumentFragment();
      for (const it of currentItems) {
        const card = elements.layer3.querySelector(`.card[data-id="${it.id}"]`);
        if (card) fragment.appendChild(card);
      }
      while (elements.layer3.firstChild) elements.layer3.removeChild(elements.layer3.firstChild);
      elements.layer3.appendChild(fragment);
    }

    selectedIndex = newIndex;
    CBF_SELECTION_MANAGER.set(itemId);
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();
  }

  function applyLocalMoveMultiple(itemIds, targetFolderId, position = 'inside', targetId = null) {
    log(`applyLocalMoveMultiple: [${itemIds.join(',')}] → ${targetFolderId} (${position})`);
    if (!Array.isArray(itemIds) || itemIds.length === 0) return;

    if (targetFolderId && targetFolderId !== currentFolderId) {
      const toRemove = new Set(itemIds);
      currentItems = currentItems.filter(i => !toRemove.has(i.id));
      for (const id of itemIds) _removeCardFromDOM(id);
      selectedIndex = currentItems.length > 0 ? 0 : -1;
      CBF_SELECTION_MANAGER.clear();
      renderLayer3();
      _updateCardHighlight();
      _updateArrowsForSelection();
      return;
    }

    const selectedItems = [];
    const selectedIds = new Set(itemIds);
    for (const item of currentItems) {
      if (selectedIds.has(item.id)) selectedItems.push(item);
    }
    const remaining = currentItems.filter(i => !selectedIds.has(i.id));

    let insertIdx = remaining.length;
    if (position === 'before' || position === 'after') {
      const targetIdx = remaining.findIndex(i => i.id === targetId);
      if (targetIdx !== -1) insertIdx = position === 'before' ? targetIdx : targetIdx + 1;
    }

    currentItems = [
      ...remaining.slice(0, insertIdx),
      ...selectedItems,
      ...remaining.slice(insertIdx)
    ];

    renderLayer3();
    selectedIndex = insertIdx;
    _updateCardHighlight();
    _scrollToSelected();
    _updateArrowsForSelection();
  }

  // ============================================================
  //  Mutation helpers
  // ============================================================
  function _insertItemAt(index, item) {
    if (index < 0) index = 0;
    if (index > currentItems.length) index = currentItems.length;
    currentItems.splice(index, 0, item);
    renderLayer3();
    _updateCardHighlight();
    _updateArrowsForSelection();
  }

  function _removeItemFromState(id) {
    const idx = currentItems.findIndex(i => i.id === id);
    if (idx !== -1) {
      currentItems.splice(idx, 1);
      if (selectedIndex === idx) selectedIndex = -1;
      else if (selectedIndex > idx) selectedIndex--;
    }
  }

  function _updateItemInState(id, changes) {
    const item = currentItems.find(i => i.id === id);
    if (item) Object.assign(item, changes);
  }

  function _updateItemIndex(id, newIndex) {
    const item = currentItems.find(i => i.id === id);
    if (item) item.index = newIndex;
  }

  function _refreshSelectionAfterMutation() {
    if (currentItems.length === 0) selectedIndex = -1;
    else if (selectedIndex >= currentItems.length) selectedIndex = currentItems.length - 1;
    _updateCardHighlight();
    _updateArrowsForSelection();
  }

  function _removeCardFromDOM(id) {
    const card = elements.layer3?.querySelector(`.card[data-id="${id}"]`);
    if (card) card.remove();
  }

  // ============================================================
  //  Feature hooks
  // ============================================================
  function setContextMenuHandler(fn) {
    onContextMenu = (typeof fn === 'function') ? fn : null;
  }

  function setCardActionHandler(fn) {
    onCardAction = (typeof fn === 'function') ? fn : null;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    reset,
    resetKeepBreadcrumb,

    navigateToFolder,
    renderLayer3,

    setItems,
    getVisibleItems,

    setCurrentFolderId,
    getCurrentFolderId,

    setActiveSpace,
    getActiveSpace,

    getBreadcrumbPath,
    setBreadcrumbPath,
    updateLayer2,

    search,
    setSearchResults,
    clearSearch,
    isSearchActive: isSearchActiveFn,

    updateArrowsForSelection: _updateArrowsForSelection,
    scrollToItem: (id) => {
      const idx = currentItems.findIndex(i => i.id === id);
      if (idx === -1) return;
      selectedIndex = idx;
      _updateCardHighlight();
      _scrollToSelected();
      _updateArrowsForSelection();
    },

    resetNavSeq,
    scrollBy,

    onNavigate,

    getSelectedItemIdsInOrder,
    getSelectedItemIdsInOrderLegacy,

    ensureVaultUnlocked,

    getSelectedItems: _getSelectedItems,
    deleteMultiple: _deleteMultipleCards,
    transferMultiple: _transferMultipleCards,
    clearSelection: () => {
      _clearSelection();
      _applySelectionVisuals();
      _updateSelectionBadge();
    },
    selectAll: () => {
      _selectAllVisible();
      _applySelectionVisuals();
      _updateSelectionBadge();
    },

    applyLocalMoveSingle,
    applyLocalMoveMultiple,

    _insertItemAt,
    _removeItemFromState,
    _updateItemInState,
    _updateItemIndex,
    _refreshSelectionAfterMutation,

    setContextMenuHandler,
    setCardActionHandler,

    MAX_MISSING_IDS_RETURNED,

    // 🔧 v12.2: exposed constants για tests
    _V122_CONSTANTS: {
      MAX_FAVICON_CACHE_SIZE,
      MAX_FOLDER_NAME_CACHE,
      MAX_RETRY_MAP,
      MAX_FAVICON_QUEUE,
      IS_LOW_END: _IS_LOW_END,
      FAVICON_MAX_CONCURRENT: _FAVICON_MAX_CONCURRENT,
      FAVICON_INTER_REQUEST_DELAY: _FAVICON_INTER_REQUEST_DELAY
    },

    // 🔧 v12.3.0: version constant
    _VERSION: '12.3.0',

    _internal: {
      _createCardElement,
      _activateItem,
      _openBookmarkInCurrentTab,
      _deleteCard,
      _transferCard,
      _promptPassword,
      _promptUnlock,
      _moveSelection,
      _updateCardHighlight,
      _scrollToSelected,
      _scrollSelectionToCenter,
      _scrollToMiddle,
      _updateArrowsForSelection,
      _getHostname,
      _getInitial,
      _getAvatarColor,
      _getColorFromUrl,
      _solidColor,
      _sanitizeUrlForDisplay,

      // 🔧 v12.2: LRU helper exposed για tests
      _boundedMapSet,

      // Pin notify helpers
      _notifyPinDeleted,
      _notifyPinTransferred,

      // V12E.E: Search hover breadcrumb
      _scheduleSearchBreadcrumbUpdate,
      _doUpdateSearchBreadcrumb,
      _cachePreSearchBreadcrumb,
      _clearSearchBreadcrumbState,
      getSearchPathCacheSize: () => _searchPathCache.size,
      getPreSearchBreadcrumbPath: () => _preSearchBreadcrumbPath ? _preSearchBreadcrumbPath.slice() : null,
      getLastSearchBreadcrumbId: () => _lastSearchBreadcrumbId,
      SEARCH_PATH_CACHE_MAX,
      SEARCH_BREADCRUMB_DEBOUNCE_MS,

      // FAVICON helpers
      _fetchFaviconAsync,
      _doFetchFavicon,
      _applyFavicon,
      _applyCardBackground,
      _extractDominantColor,
      _rgbToHsla,
      _enqueueFavicon,
      _runFaviconQueue,
      _setupFaviconUpdateListener,
      _faviconCache,
      _faviconPending,
      _faviconColorCache,
      _faviconQueue,
      _faviconRetries,

      getNavSeq: () => _navSeq,
      isActionInProgress,
      isUnlockPromptInProgress: () => _unlockPromptInProgress,
      _checkSpaceTransitionGuard,
      getElements: () => ({ ...elements }),

      // 🔧 v12.2: cache sizes για diagnostics
      getCacheStats: () => ({
        faviconCacheSize: _faviconCache.size,
        faviconColorCacheSize: _faviconColorCache.size,
        faviconRetriesSize: _faviconRetries.size,
        faviconQueueSize: _faviconQueue.length,
        faviconPendingSize: _faviconPending.size,
        folderNameCacheSize: folderNameCache.size,
        searchPathCacheSize: _searchPathCache.size,
        isLowEnd: _IS_LOW_END
      }),

      getFaviconQueueState: () => ({
        active: _faviconActive,
        queued: _faviconQueue.length,
        pending: _faviconPending.size,
        retries: _faviconRetries.size,
        cacheSize: _faviconCache.size,
        colorCacheSize: _faviconColorCache.size,
        maxConcurrent: _FAVICON_MAX_CONCURRENT,
        interDelay: _FAVICON_INTER_REQUEST_DELAY,
        queueMax: MAX_FAVICON_QUEUE
      }),

      isFaviconListenerRegistered: () => _faviconUpdateListenerRegistered,

      _getSelectedItems,
      _applySelectionVisuals,
      _updateSelectionBadge,
      _toggleSelection,
      _selectRange,
      _selectAllVisible,
      _clearSelection,
      _onCardClick,
      _deleteMultipleCards,
      _transferMultipleCards,
      getLastAnchorId: () => _lastAnchorId,
      getCarryOverIds: () => _carryOverSelectionIds.slice(),
      getPendingCenterScroll: () => _pendingCenterScroll,
      isArrowsUpdateScheduled: () => _arrowsUpdateScheduled
    }
  };

  if (typeof window !== 'undefined') window.CBF_UI = api;
  if (typeof self !== 'undefined') self.CBF_UI = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_UI = api;

  log(
    `Ready (v12.3.0: BUG-1 favicon leak fix + bounded caches + adaptive low-end (isLowEnd=${_IS_LOW_END}) + ` +
    `search hover breadcrumb + D-52 openInCurrentTab + Multi-Select + ` +
    `setSearchResults + HOME-FIX + PIN-AUTO-UNPIN + PIN-AUTO-UNPIN-ON-TRANSFER + ` +
    `RACE-01 space-change guard + MEM-06 destroy leak fix)`
  );

  return api;
})();

console.log('[ECBF:UI] Ready (v12.3.0: MEM-01..06 bounded caches + CPU-01..05 adaptive + RACE-01 guard + BUG-1 favicon leak fix)');