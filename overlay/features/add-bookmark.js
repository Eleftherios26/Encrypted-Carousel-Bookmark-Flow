/**
 * add-bookmark.js — Add current page as bookmark (dual-space)
 *
 * @path     overlay/features/add-bookmark.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Προσθέτει την ΤΡΕΧΟΥΣΑ σελίδα ως bookmark, χωρίς modal.
 *   Παίρνει url = window.location.href, title = document.title
 *   (fallback → hostname). Ίδιο pattern με Ctrl+D.
 *
 * BEHAVIOR
 *   • ΔΕΝ ανοίγει modal — auto-capture της τρέχουσας σελίδας
 *   • Title truncation: MAX 500 chars (D-43 consistency)
 *   • URL validation: μόνο http(s), MAX 2048 chars
 *
 * DUAL-SPACE
 *   • ENCRYPTED: CBF_BRIDGE.create() + ensureVaultUnlocked()
 *   • FIREFOX:   CBF_BRIDGE.firefoxCreate() (no unlock — D-34)
 *
 * DECISIONS
 *   D-13.1, D-34, D-35, D-50
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "add-bookmark"
 */

var CBF_FEATURE_ADD_BOOKMARK = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_TITLE_LENGTH = 500;
  const MAX_URL_LENGTH   = 2048;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:AddBookmark]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:AddBookmark]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:AddBookmark]', ...a); }

  // ============================================================
  //  Guards
  // ============================================================

  function _isActionInProgress() {
    if (typeof CBF_UI === 'undefined' || !CBF_UI._internal) return false;
    const fn = CBF_UI._internal.isActionInProgress;
    return typeof fn === 'function' ? fn() === true : false;
  }

  function _isSpaceTransitionInProgress() {
    if (typeof window === 'undefined') return false;
    const fn = window.CBF_Overlay_isSpaceTransitionInProgress;
    if (typeof fn !== 'function') return false;
    try {
      return fn() === true;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  //  Current page info (auto-capture)
  //
  //  Παίρνει url + title της ΤΡΕΧΟΥΣΑΣ σελίδας.
  //  Το content script έχει read-only πρόσβαση στο host page.
  // ============================================================
  function _getCurrentPageInfo() {
    let url, title;

    try {
      url = window.location.href;
    } catch (e) {
      warn('Cannot read window.location.href:', e.message);
      return null;
    }

    try {
      title = document.title || '';
    } catch (e) {
      warn('Cannot read document.title:', e.message);
      title = '';
    }

    // URL validation
    if (typeof url !== 'string' || url.length === 0) {
      warn('Invalid current URL');
      return null;
    }
    if (!/^https?:\/\//i.test(url)) {
      warn('Current page is not http(s):', url);
      return null;
    }
    if (url.length > MAX_URL_LENGTH) {
      warn('Current URL too long:', url.length);
      return null;
    }

    // Title fallback → hostname
    if (!title || title.trim().length === 0) {
      try {
        title = new URL(url).hostname.replace(/^www\./, '');
      } catch (_) {
        title = url;
      }
    }

    // Title truncation (D-43)
    title = title.trim();
    if (title.length > MAX_TITLE_LENGTH) {
      title = title.slice(0, MAX_TITLE_LENGTH - 1) + '…';
      warn(`Title truncated to ${MAX_TITLE_LENGTH} chars`);
    }

    return { url, title };
  }

  // ============================================================
  //  Main flow
  // ============================================================
  async function run() {
    if (_isActionInProgress()) {
      log('blocked: action in progress');
      return;
    }

    if (_isSpaceTransitionInProgress()) {
      log('blocked: space transition in progress');
      return;
    }

    if (typeof CBF_UI === 'undefined') {
      warn('CBF_UI not available');
      return;
    }

    const activeSpace = CBF_UI.getActiveSpace();
    log(`run: activeSpace=${activeSpace}`);

    try {
      // 1. Current page info (auto-capture)
      const page = _getCurrentPageInfo();
      if (!page) {
        if (typeof CBF_MODAL_SERVICE !== 'undefined') {
          await CBF_MODAL_SERVICE.showAlert(
            'Μη διαθέσιμο',
            'Δεν μπορώ να διαβάσω το URL αυτής της σελίδας.\n\n' +
            'Υποστηρίζονται μόνο http:// και https:// σελίδες.'
          );
        }
        return;
      }

      log(`current page: "${page.title}" → ${page.url}`);

      // 2. Read parent
      const parentId = CBF_UI.getCurrentFolderId();
      if (!parentId) {
        warn('getCurrentFolderId returned null');
        return;
      }

      // 3. Route by space
      if (activeSpace === 'encrypted') {
        await _createInEncrypted(page, parentId);
      } else if (activeSpace === 'firefox') {
        await _createInFirefox(page, parentId);
      } else {
        warn(`Unknown space: ${activeSpace}`);
      }

    } catch (e) {
      err('FAILED:', e.message);
      await _showError(e);
    }
  }

  // ============================================================
  //  Encrypted space path
  // ============================================================
  async function _createInEncrypted(page, parentId) {
    // Auto-unlock (M-16 + D-50)
    let unlocked = false;
    if (typeof CBF_UI.ensureVaultUnlocked === 'function') {
      unlocked = await CBF_UI.ensureVaultUnlocked('για νέο σελιδοδείκτη');
    } else {
      log('ensureVaultUnlocked not available — skipping');
      unlocked = true;
    }
    if (!unlocked) {
      log('unlock cancelled — aborting');
      return;
    }

    const gen = (typeof CBF_BRIDGE.getGeneration === 'function')
      ? CBF_BRIDGE.getGeneration()
      : 0;

    log(`creating (encrypted) "${page.title}" → ${parentId} (gen=${gen})`);

    const res = await CBF_BRIDGE.create({
      parentId,
      type: 'bookmark',
      title: page.title,
      url: page.url,
      insertAfterId: null
    }, gen);

    log(`SUCCESS (encrypted) id=${res.result?.id}`);

    await _postCreateRefresh(parentId, res.result?.id);
  }

  // ============================================================
  //  Firefox space path
  // ============================================================
  async function _createInFirefox(page, parentId) {
    log(`creating (firefox) "${page.title}" → ${parentId}`);

    const res = await CBF_BRIDGE.firefoxCreate({
      parentId,
      type: 'bookmark',
      title: page.title,
      url: page.url
    });

    log(`SUCCESS (firefox) id=${res.result?.id}`);

    await _postCreateRefresh(parentId, res.result?.id);
  }

  // ============================================================
  //  Post-create refresh + select (fixed order)
  //
  //  1. SEL.set(newId)  ← ΠΡΙΝ το navigate (nav-focus capture)
  //  2. navigateToFolder (θα βρει το pending selection)
  //  3. scrollToItem (defense-in-depth)
  // ============================================================
  async function _postCreateRefresh(parentId, newId) {
    if (newId && typeof CBF_SELECTION_MANAGER !== 'undefined') {
      CBF_SELECTION_MANAGER.set(newId);
    }

    if (typeof CBF_UI.navigateToFolder === 'function') {
      await CBF_UI.navigateToFolder(parentId, { preservePath: true });
    }

    if (newId && typeof CBF_UI.scrollToItem === 'function') {
      try {
        CBF_UI.scrollToItem(newId);
      } catch (e) {
        warn('scrollToItem failed:', e.message);
      }
    }
  }

  // ============================================================
  //  Friendly error display
  // ============================================================
  async function _showError(e) {
    if (typeof CBF_MODAL_SERVICE === 'undefined') return;

    let msg = e.message;

    if (e.code === 'STALE_GENERATION') {
      msg = 'Το UI ήταν ξεπερασμένο. Δοκιμάστε ξανά.';
    } else if (e.code === 'BAD_REQUEST') {
      msg = 'Μη έγκυρα δεδομένα: ' + e.message;
    } else if (e.code === 'NO_CAPABILITY' || /capability/i.test(msg)) {
      msg = 'Λείπει δικαίωμα firefox.write ή encrypted.write.';
    } else if (/PARENT_OUTSIDE_MANAGED_TREE/i.test(msg)) {
      msg = 'Ο προορισμός δεν είναι στο managed tree του Firefox.';
    } else if (/PARENT_FORBIDDEN_ROOT/i.test(msg)) {
      msg = 'Δεν επιτρέπεται προσθήκη σε αυτόν τον root folder.';
    } else if (/PARENT_NOT_FOLDER/i.test(msg)) {
      msg = 'Ο προορισμός δεν είναι φάκελος.';
    } else if (/WRONG_SPACE/i.test(msg)) {
      msg = 'Λάθος χώρος. Δοκιμάστε ξανά.';
    }

    await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Δημιουργία απέτυχε: ' + msg);
  }

  // ============================================================
  //  Init
  // ============================================================
  function init(container, shadowRoot) {
    if (!container) {
      warn('init: container required');
      return false;
    }

    const btn = container.querySelector('#cbf-add-bookmark');
    if (!btn) {
      warn('init: button #cbf-add-bookmark not found');
      return false;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      run();
    });

    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    btn.style.pointerEvents = 'auto';

    log('initialized (button active, dual-space, auto-capture)');
    return true;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    _internal: {
      run,
      _isActionInProgress,
      _isSpaceTransitionInProgress,
      _getCurrentPageInfo,
      _createInEncrypted,
      _createInFirefox,
      _postCreateRefresh,
      _showError,
      MAX_TITLE_LENGTH,
      MAX_URL_LENGTH
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_FEATURE_ADD_BOOKMARK = api;
  if (typeof self !== 'undefined') self.CBF_FEATURE_ADD_BOOKMARK = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_ADD_BOOKMARK = api;

  log('Ready (dual-space, auto-capture current page)');
  return api;
})();