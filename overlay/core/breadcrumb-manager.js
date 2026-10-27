/**
 * breadcrumb-manager.js — Breadcrumb path per space (RAM-only)
 *
 * @path     overlay/core/breadcrumb-manager.js
 * @version  12.1E
 * @since    v12E / v12.1E
 *
 * PURPOSE
 *   Διαχειρίζεται το breadcrumb path ανά space (firefox / encrypted).
 *   ΔΕΝ αποθηκεύει σε IDB / storage — μόνο RAM.
 *
 * SPACE RULES
 *   • Firefox Space
 *       - Root: 'toolbar_____' (Bookmarks Toolbar)
 *       - Φιλτράρει τα: menu________, unfiled_____, mobile______, root________
 *   • Encrypted Space
 *       - Root: 'ecbf-root'
 *       - Φιλτράρει ΟΛΑ τα Firefox roots
 *
 * NON-OBVIOUS
 *   • Το cleanPathForSpace() είναι defense-in-depth: ακόμα και αν ο
 *     caller στείλει λάθος path, το module το διορθώνει silently.
 *   • Το getAllPaths() επιστρέφει deep copy — ο caller δεν μπορεί να
 *     μολύνει το internal state.
 *
 * DECISIONS
 *   D-13.1, D-42
 *
 * CHANGELOG
 *   v12.1E (2026-09-22):
 *     • 🔴 BUG-1 FIX: `unfilled_____` → `unfiled_____` σε 3 arrays:
 *         - FIREFOX_ROOT_IDS
 *         - NON_ENCRYPTED_ROOTS
 *         - NON_FIREFOX_ROOTS
 *       Firefox Places GUID = 'unfiled_____' (7 γράμματα + 5 underscores = 12 chars).
 *       Πριν: τα .filter() checks ήταν dead-code λόγω typo — αν ένα
 *       breadcrumb segment είχε id='unfiled_____', ΔΕΝ φιλτραριζόταν
 *       σωστά (παρέμενε στο path).
 *       Μετά: σωστό φιλτράρισμα + consistency με CBF_FIREFOX_VALIDATOR.
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "breadcrumb-manager"
 */

var CBF_BREADCRUMB_MANAGER = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const ENCRYPTED_ROOT_ID = 'ecbf-root';
  const FIREFOX_ROOT_ID   = 'toolbar_____';

  // ============================================================
  //  v12.1E BUG-1 FIX: 'unfilled_____' → 'unfiled_____'
  //
  //  Firefox Places GUIDs (source of truth = PlacesUtils.sys.mjs):
  //    toolbar_____  → Bookmarks Toolbar      (7 letters + 5 underscores)
  //    menu________  → Bookmarks Menu         (4 letters + 8 underscores)
  //    unfiled_____  → Other Bookmarks        (7 letters + 5 underscores)  ← FIXED
  //    mobile______  → Mobile Bookmarks       (6 letters + 6 underscores)
  //    root________  → Root container         (4 letters + 8 underscores)
  //
  //  ΣΗΜΑΝΤΙΚΟ: ΟΛΑ τα GUIDs είναι 12 chars.
  // ============================================================
  const FIREFOX_ROOT_IDS = Object.freeze([
    'toolbar_____', 'menu________', 'unfiled_____',
    'mobile______', 'root________'
  ]);

  // Roots που ΔΕΝ πρέπει να εμφανίζονται στο encrypted breadcrumb
  const NON_ENCRYPTED_ROOTS = Object.freeze([
    'toolbar_____', 'menu________', 'unfiled_____',
    'mobile______', 'root________'
  ]);

  // Roots που ΔΕΝ πρέπει να εμφανίζονται στο firefox breadcrumb
  const NON_FIREFOX_ROOTS = Object.freeze([
    'menu________', 'unfiled_____', 'mobile______', 'root________'
  ]);

  // ============================================================
  //  State (RAM only)
  // ============================================================
  const paths = {
    firefox:   [{ id: FIREFOX_ROOT_ID, title: 'Bookmarks Toolbar' }],
    encrypted: [{ id: ENCRYPTED_ROOT_ID, title: 'Encrypted Root' }]
  };

  // ============================================================
  //  Helpers
  // ============================================================
  function _key(space) {
    return space === 'encrypted' ? 'encrypted' : 'firefox';
  }

  function _clone(p) {
    return p.map(s => ({ id: s.id, title: s.title }));
  }

  function log(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('[BREADCRUMB]', ...a);
    else console.log('[BREADCRUMB]', ...a);
  }
  function warn(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.warn('[BREADCRUMB]', ...a);
    else console.warn('[BREADCRUMB]', ...a);
  }

  // ============================================================
  //  Clean path για space (defense-in-depth)
  //
  //  v12.1E BUG-1: Τα NON_*_ROOTS arrays τώρα περιέχουν το σωστό
  //  'unfiled_____' GUID. Πριν ήταν dead-code λόγω typo.
  // ============================================================
  function cleanPathForSpace(space, rawPath) {
    if (!Array.isArray(rawPath)) return [];

    const key = _key(space);
    let filtered;

    if (key === 'firefox') {
      filtered = rawPath.filter(seg => !NON_FIREFOX_ROOTS.includes(seg.id));
      if (!filtered.some(seg => seg.id === FIREFOX_ROOT_ID)) {
        filtered.unshift({ id: FIREFOX_ROOT_ID, title: 'Bookmarks Toolbar' });
      }
    } else {
      filtered = rawPath.filter(seg => !NON_ENCRYPTED_ROOTS.includes(seg.id));
      if (!filtered.some(seg => seg.id === ENCRYPTED_ROOT_ID)) {
        filtered.unshift({ id: ENCRYPTED_ROOT_ID, title: 'Encrypted Root' });
      }
    }

    return filtered;
  }

  // ============================================================
  //  Default root
  // ============================================================
  function getDefaultRoot(space) {
    if (space === 'encrypted') {
      return [{ id: ENCRYPTED_ROOT_ID, title: 'Encrypted Root' }];
    }
    return [{ id: FIREFOX_ROOT_ID, title: 'Bookmarks Toolbar' }];
  }

  // ============================================================
  //  Get / Set
  // ============================================================
  function getPath(space) {
    const key = _key(space);
    return _clone(paths[key]);
  }

  function setPath(space, rawPath) {
    const key = _key(space);

    if (!Array.isArray(rawPath) || rawPath.length === 0) {
      warn(`Invalid path for ${key} — resetting to default`);
      paths[key] = getDefaultRoot(space);
      return;
    }

    const cleaned = cleanPathForSpace(space, rawPath);
    if (cleaned.length === 0) {
      paths[key] = getDefaultRoot(space);
      return;
    }

    paths[key] = cleaned;
    log(`Path set (${key}): ${cleaned.map(s => s.title).join(' > ')}`);
  }

  // ============================================================
  //  Reset
  // ============================================================
  function reset(space) {
    const key = _key(space);
    paths[key] = getDefaultRoot(space);
    log(`Path reset (${key})`);
    return _clone(paths[key]);
  }

  // ============================================================
  //  Push / Pop
  // ============================================================
  function push(space, segment) {
    if (!segment || !segment.id) return;
    const key = _key(space);
    paths[key].push({
      id: segment.id,
      title: segment.title || segment.id
    });
  }

  function pop(space) {
    const key = _key(space);
    if (paths[key].length > 1) {
      const removed = paths[key].pop();
      log(`Popped (${key}): ${removed.title}`);
      return removed;
    }
    warn(`Cannot pop — already at root (${key})`);
    return null;
  }

  // ============================================================
  //  Current / Previous
  // ============================================================
  function getCurrent(space) {
    const key = _key(space);
    const p = paths[key];
    const c = p[p.length - 1];
    return c ? { id: c.id, title: c.title } : null;
  }

  function getPrevious(space) {
    const key = _key(space);
    const p = paths[key];
    if (p.length > 1) {
      const prev = p[p.length - 2];
      return { id: prev.id, title: prev.title };
    }
    return null;
  }

  // ============================================================
  //  All paths (debug) — deep copy
  // ============================================================
  function getAllPaths() {
    return {
      firefox:   _clone(paths.firefox),
      encrypted: _clone(paths.encrypted)
    };
  }

  // ============================================================
  //  Is root check
  // ============================================================
  function isAtRoot(space) {
    const key = _key(space);
    return paths[key].length <= 1;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    getPath,
    setPath,
    reset,
    getDefaultRoot,
    push,
    pop,
    getCurrent,
    getPrevious,
    getAllPaths,
    isAtRoot,
    cleanPathForSpace,

    // Constants
    ENCRYPTED_ROOT_ID,
    FIREFOX_ROOT_ID,
    FIREFOX_ROOT_IDS,
    NON_ENCRYPTED_ROOTS,
    NON_FIREFOX_ROOTS
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_BREADCRUMB_MANAGER = api;
  if (typeof self !== 'undefined') self.CBF_BREADCRUMB_MANAGER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_BREADCRUMB_MANAGER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Breadcrumb Manager ready (v12.1E: BUG-1 unfiled_____ fix σε 3 arrays)'
    );
  } else {
    console.log('[ECBF:Breadcrumb] Ready (v12.1E — unfiled_____ fix)');
  }

  return api;
})();