/**
 * firefox-space-validator.js — Firefox space strict validation
 *
 * @path     background/services/firefox-space-validator.js
 * @version  12.1E
 * @since    v12E / v12.1E
 *
 * PURPOSE
 *   Επιβάλλει strict validation για ΟΛΑ τα writes στο Firefox space.
 *   Το `bookmarks` permission δίνει τεχνικά πλήρη πρόσβαση — ο
 *   validator περιορίζει τη χρήση σε ένα managed subtree.
 *
 *   Προστασίες:
 *     • URL: μόνο http(s), max 2048
 *     • Title: max 500, no control chars
 *     • Parent: υποχρεωτικά descendant του managed root
 *     • Reject writes σε OTHER roots (menu, unfiled, mobile)
 *     • Reject delete/move του managed root
 *     • Audit log σε κάθε write
 *
 * MANAGED ROOT
 *   Default: 'toolbar_____' (Bookmarks Toolbar)
 *
 *   ΑΠΑΓΟΡΕΥΟΝΤΑΙ ρητά:
 *     ❌ menu________      (Bookmarks Menu)
 *     ❌ unfiled_____      (Other Bookmarks / Unsorted — 7 letters + 5 underscores)
 *     ❌ mobile______     (Mobile Bookmarks)
 *     ❌ root________     (root container)
 *     ❌ tags________     (Tags — special)
 *
 * NON-OBVIOUS
 *   • M-6: External bookmark events (onCreated, onMoved, onRemoved,
 *     onChanged) → αυτόματο invalidateCache().
 *     Χωρίς αυτό, το descendantCache παραμένει stale μετά από
 *     manual user changes ή Firefox Sync.
 *   • TTL 30s στο cache = defense-in-depth για missed events.
 *   • Cache eviction: FIFO μισό-μισό όταν φτάσει 1000 entries.
 *
 * FIREFOX COMPATIBILITY
 *   • C3-10: ΑΦΑΙΡΕΘΗΚΕ το onChildrenReordered listener — είναι
 *     Chrome-only API (δεν υλοποιείται σε Firefox). Ο Firefox
 *     fire-άρει onMoved για κάθε reorder, οπότε η cache invalidation
 *     καλύπτεται πλήρως από τα υπόλοιπα events.
 *
 * DECISIONS
 *   D-22, D-41
 *
 * CHANGELOG
 *   v12.1E (2026-09-22):
 *     • 🔴 BUG-1 FIX: `unfilled_____` → `unfiled_____` στο FORBIDDEN_ROOTS
 *       Firefox Places GUID = 'unfiled_____' (7 γράμματα + 5 underscores = 12 chars).
 *       Πριν: το `includes('unfiled_____')` επέστρεφε false → direct check
 *       bypassed → βασιζόμασταν ΜΟΝΟ στο isDescendantOf() fallback.
 *       Μετά: defense-in-depth restored — direct rejection στο
 *       validateParent() + σωστό error code (PARENT_FORBIDDEN_ROOT
 *       αντί PARENT_OUTSIDE_MANAGED_TREE).
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "firefox-space-validator"
 */

var CBF_FIREFOX_VALIDATOR = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_URL_LENGTH   = 2048;
  const MAX_TITLE_LENGTH = 500;

  const DEFAULT_MANAGED_ROOT = 'toolbar_____';

  // ============================================================
  //  FORBIDDEN_ROOTS
  //
  //  v12.1E BUG-1 FIX: 'unfilled_____' → 'unfiled_____'
  //
  //  Firefox Places GUIDs (source of truth = PlacesUtils.sys.mjs):
  //    toolbar_____  → Bookmarks Toolbar      (7 letters + 5 underscores)
  //    menu________  → Bookmarks Menu         (4 letters + 8 underscores)
  //    unfiled_____  → Other Bookmarks        (7 letters + 5 underscores)  ← FIXED
  //    mobile______  → Mobile Bookmarks       (6 letters + 6 underscores)
  //    root________  → Root container         (4 letters + 8 underscores)
  //    tags________  → Tags (special)         (4 letters + 8 underscores)
  //
  //  ΣΗΜΑΝΤΙΚΟ: ΟΛΑ τα GUIDs είναι 12 chars. Το 'unfilled_____' ήταν
  //  λάθος (13 chars) — θα αποτύγχανε πάντα το .includes() check.
  // ============================================================
  const FORBIDDEN_ROOTS = Object.freeze([
    'menu________',      // Bookmarks Menu
    'unfiled_____',      // Other Bookmarks (7 letters + 5 underscores) ← v12.1E fix
    'mobile______',      // Mobile Bookmarks
    'root________',      // Root container
    'tags________',      // Tags (special)
    'placesRoot'         // Legacy root ID
  ]);

  const ALLOWED_SCHEMES = Object.freeze(['http:', 'https:']);

  // Control chars regex (ASCII 0x00-0x1F, 0x7F)
  const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

  // M-6: Cache TTL (defense-in-depth)
  const CACHE_TTL_MS = 30 * 1000;   // 30 seconds

  // ============================================================
  //  State
  // ============================================================
  let managedRootId = DEFAULT_MANAGED_ROOT;

  // Cache: Map<nodeId, { value, timestamp }>
  const descendantCache = new Map();

  // M-6: Listener registration flag
  let _listenersRegistered = false;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)   { CBF_LOGGER.info('[FF-VALID]', ...a); }
  function warn(...a)  { CBF_LOGGER.warn('[FF-VALID]', ...a); }
  function err(...a)   { CBF_LOGGER.error('[FF-VALID]', ...a); }
  function audit(action, meta) { CBF_LOGGER.security('[FF-VALID]', action, meta); }

  // ============================================================
  //  M-6: Cache implementation με TTL
  // ============================================================
  function _cacheGet(nodeId) {
    const entry = descendantCache.get(nodeId);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      descendantCache.delete(nodeId);
      return null;
    }

    return entry.value;
  }

  function _cacheSet(nodeId, value) {
    if (descendantCache.size > 1000) {
      // Eviction: καθάρισε τα μισά (FIFO)
      const toDelete = Math.floor(descendantCache.size / 2);
      const keys = descendantCache.keys();
      for (let i = 0; i < toDelete; i++) {
        const k = keys.next().value;
        if (k !== undefined) descendantCache.delete(k);
      }
    }

    descendantCache.set(nodeId, {
      value,
      timestamp: Date.now()
    });
  }

  // ============================================================
  //  M-6: External event listeners
  //
  //  Αυτόματο invalidate όταν το bookmark tree αλλάξει εξωτερικά
  //  (manual user changes, Firefox Sync, άλλα extensions).
  //
  //  FIREFOX COMPATIBILITY (C3-10):
  //    Το onChildrenReordered ΔΕΝ υλοποιείται σε Firefox → αφαιρέθηκε.
  //    Ο Firefox fire-άρει onMoved για κάθε reorder, οπότε η
  //    cache invalidation καλύπτεται πλήρως.
  // ============================================================
  function _registerExternalListeners() {
    if (_listenersRegistered) return;

    if (typeof browser === 'undefined' ||
        !browser.bookmarks ||
        typeof browser.bookmarks.onCreated === 'undefined') {
      warn('browser.bookmarks events not available — cache invalidation disabled');
      return;
    }

    try {
      browser.bookmarks.onCreated.addListener(() => {
        invalidateCache();
        log('Cache invalidated: bookmark created (external)');
      });

      browser.bookmarks.onMoved.addListener(() => {
        invalidateCache();
        log('Cache invalidated: bookmark moved (external)');
      });

      browser.bookmarks.onRemoved.addListener(() => {
        invalidateCache();
        log('Cache invalidated: bookmark removed (external)');
      });

      if (browser.bookmarks.onChanged) {
        browser.bookmarks.onChanged.addListener(() => {
          invalidateCache();
          log('Cache invalidated: bookmark changed (external)');
        });
      }

      // C3-10: onChildrenReordered ΑΦΑΙΡΕΘΗΚΕ (Chrome-only API, invalid σε Firefox)

      _listenersRegistered = true;
      log('External bookmark listeners registered (M-6)');

    } catch (e) {
      err('Failed to register external listeners:', e.message);
    }
  }

  // ============================================================
  //  Managed root management
  // ============================================================
  function getManagedRoot() {
    return managedRootId;
  }

  function setManagedRoot(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('setManagedRoot: id must be non-empty string');
    }
    if (FORBIDDEN_ROOTS.includes(id)) {
      throw new Error(`setManagedRoot: cannot use forbidden root "${id}"`);
    }
    managedRootId = id;
    descendantCache.clear();
    log('Managed root set to:', id);
  }

  // ============================================================
  //  URL validation
  // ============================================================
  function validateUrl(url) {
    if (typeof url !== 'string') {
      throw new Error('URL_REQUIRED');
    }
    if (url.length === 0) {
      throw new Error('URL_EMPTY');
    }
    if (url.length > MAX_URL_LENGTH) {
      throw new Error('URL_TOO_LONG: ' + url.length + ' > ' + MAX_URL_LENGTH);
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      throw new Error('URL_MALFORMED');
    }

    if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
      throw new Error('URL_INVALID_PROTOCOL: ' + parsed.protocol);
    }

    if (!parsed.hostname) {
      throw new Error('URL_NO_HOSTNAME');
    }

    return true;
  }

  // ============================================================
  //  Title validation
  // ============================================================
  function validateTitle(title) {
    if (typeof title !== 'string') {
      throw new Error('TITLE_REQUIRED');
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new Error('TITLE_TOO_LONG: ' + title.length + ' > ' + MAX_TITLE_LENGTH);
    }
    if (CONTROL_CHARS_REGEX.test(title)) {
      throw new Error('TITLE_CONTROL_CHARS');
    }
    return true;
  }

  // ============================================================
  //  Parent validation
  // ============================================================
  async function isDescendantOf(nodeId, rootId) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) return false;
    const root = rootId || managedRootId;

    if (nodeId === root) return true;

    // Cache hit (μόνο για default managed root)
    if (!rootId) {
      const cached = _cacheGet(nodeId);
      if (cached !== null) {
        return cached;
      }
    }

    let current = nodeId;
    const visited = new Set();
    let depth = 0;
    const MAX_DEPTH = 50;

    while (current && depth++ < MAX_DEPTH) {
      if (visited.has(current)) {
        warn('Cycle detected in bookmark tree at', current);
        if (!rootId) _cacheSet(nodeId, false);
        return false;
      }
      visited.add(current);

      if (current === root) {
        if (!rootId) _cacheSet(nodeId, true);
        return true;
      }

      let nodes;
      try {
        nodes = await browser.bookmarks.get(current);
      } catch (_) {
        // Node δεν υπάρχει (π.χ. διαγράφηκε)
        if (!rootId) _cacheSet(nodeId, false);
        return false;
      }

      if (!nodes || nodes.length === 0) {
        if (!rootId) _cacheSet(nodeId, false);
        return false;
      }

      const parentId = nodes[0].parentId;

      // Φτάσαμε σε top-level root (δεν είναι descendant)
      if (!parentId) {
        if (!rootId) _cacheSet(nodeId, false);
        return false;
      }

      // v12.1E BUG-1: Ο parentId είναι ένα από τα forbidden roots →
      // δεν είναι descendant. Τώρα το check δουλεύει σωστά (πριν
      // ήταν dead-code λόγω typo 'unfilled_____').
      if (FORBIDDEN_ROOTS.includes(parentId)) {
        if (!rootId) _cacheSet(nodeId, false);
        return false;
      }

      current = parentId;
    }

    if (!rootId) _cacheSet(nodeId, false);
    return false;
  }

  function invalidateCache(nodeId) {
    if (nodeId) {
      descendantCache.delete(nodeId);
    } else {
      descendantCache.clear();
    }
  }

  async function validateParent(parentId) {
    if (typeof parentId !== 'string' || parentId.length === 0) {
      throw new Error('PARENT_REQUIRED');
    }

    // v12.1E BUG-1: Direct forbidden root check.
    // Πριν ήταν dead-code (typo 'unfilled_____' → never matched).
    // Τώρα: σωστό fail-fast με το σωστό error code.
    if (FORBIDDEN_ROOTS.includes(parentId)) {
      throw new Error('PARENT_FORBIDDEN_ROOT: ' + parentId);
    }

    const ok = await isDescendantOf(parentId);
    if (!ok) {
      throw new Error('PARENT_OUTSIDE_MANAGED_TREE: ' + parentId);
    }

    return true;
  }

  // ============================================================
  //  Full record validation
  // ============================================================
  async function validateFirefoxWrite(record) {
    if (!record || typeof record !== 'object') {
      throw new Error('RECORD_REQUIRED');
    }

    const { url, title, parentId, type } = record;

    validateTitle(title);

    const isFolder = (type === 'folder');
    if (!isFolder) {
      validateUrl(url);
    } else if (url !== undefined && url !== null && url !== '') {
      throw new Error('FOLDER_MUST_NOT_HAVE_URL');
    }

    await validateParent(parentId);

    audit('firefox_write', {
      parentId,
      type: isFolder ? 'folder' : 'bookmark',
      titleLength: title.length,
      urlLength: url ? url.length : 0
    });

    return true;
  }

  // ============================================================
  //  Specific validators
  // ============================================================

  async function validateFirefoxCreate(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('PAYLOAD_REQUIRED');
    }
    const { parentId, type, title, url } = payload;

    if (type !== 'bookmark' && type !== 'folder') {
      throw new Error('TYPE_INVALID: must be bookmark or folder');
    }

    return await validateFirefoxWrite({
      parentId,
      type,
      title,
      url: type === 'bookmark' ? url : null
    });
  }

  async function validateFirefoxUpdate(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('PAYLOAD_REQUIRED');
    }
    const { id, title, url } = payload;

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ID_REQUIRED');
    }

    if (FORBIDDEN_ROOTS.includes(id)) {
      throw new Error('CANNOT_MODIFY_ROOT: ' + id);
    }

    const isDesc = await isDescendantOf(id);
    if (!isDesc) {
      throw new Error('NODE_OUTSIDE_MANAGED_TREE: ' + id);
    }

    if (title !== undefined) validateTitle(title);
    if (url !== undefined) validateUrl(url);

    audit('firefox_update', {
      id,
      hasTitle: title !== undefined,
      hasUrl: url !== undefined
    });

    return true;
  }

  async function validateFirefoxMove(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('PAYLOAD_REQUIRED');
    }
    const { id, parentId } = payload;

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ID_REQUIRED');
    }
    if (FORBIDDEN_ROOTS.includes(id)) {
      throw new Error('CANNOT_MOVE_ROOT: ' + id);
    }
    if (id === managedRootId) {
      throw new Error('CANNOT_MOVE_MANAGED_ROOT');
    }

    const sourceOk = await isDescendantOf(id);
    if (!sourceOk) {
      throw new Error('SOURCE_OUTSIDE_MANAGED_TREE: ' + id);
    }

    await validateParent(parentId);

    audit('firefox_move', { id, parentId });
    return true;
  }

  async function validateFirefoxRemove(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('PAYLOAD_REQUIRED');
    }
    const { id } = payload;

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('ID_REQUIRED');
    }
    if (FORBIDDEN_ROOTS.includes(id)) {
      throw new Error('CANNOT_DELETE_ROOT: ' + id);
    }
    if (id === managedRootId) {
      throw new Error('CANNOT_DELETE_MANAGED_ROOT');
    }

    const isDesc = await isDescendantOf(id);
    if (!isDesc) {
      throw new Error('NODE_OUTSIDE_MANAGED_TREE: ' + id);
    }

    audit('firefox_remove', { id });
    return true;
  }

  // ============================================================
  //  Read-only helper
  // ============================================================
  async function isWithinManagedTree(nodeId) {
    return await isDescendantOf(nodeId);
  }

  // ============================================================
  //  Diagnostics
  // ============================================================
  function getCacheStats() {
    return {
      size: descendantCache.size,
      ttlMs: CACHE_TTL_MS,
      listenersRegistered: _listenersRegistered
    };
  }

  // ============================================================
  //  Init — auto-register listeners
  // ============================================================
  function init() {
    _registerExternalListeners();
  }

  // Auto-init on module load (idempotent)
  init();

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    validateFirefoxWrite,
    validateFirefoxCreate,
    validateFirefoxUpdate,
    validateFirefoxMove,
    validateFirefoxRemove,

    validateUrl,
    validateTitle,
    validateParent,
    isDescendantOf,
    isWithinManagedTree,

    getManagedRoot,
    setManagedRoot,

    invalidateCache,
    getCacheStats,

    init,

    DEFAULT_MANAGED_ROOT,
    FORBIDDEN_ROOTS,
    MAX_URL_LENGTH,
    MAX_TITLE_LENGTH,
    ALLOWED_SCHEMES,
    CACHE_TTL_MS,

    _internal: {
      CONTROL_CHARS_REGEX,
      descendantCache,
      _registerExternalListeners,
      _cacheGet,
      _cacheSet
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_FIREFOX_VALIDATOR = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FIREFOX_VALIDATOR = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Firefox Space Validator ready (v12.1E: D-22 + M-6 — managedRoot=' +
      DEFAULT_MANAGED_ROOT + ', forbidden roots=' +
      FORBIDDEN_ROOTS.length + ', cache TTL=' + CACHE_TTL_MS + 'ms, ' +
      'BUG-1 unfiled_____ fix applied)'
    );
  }

  return api;
})();