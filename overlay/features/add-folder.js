/**
 * add-folder.js — Add new folder (dual-space)
 *
 * @path     overlay/features/add-folder.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Δημιουργεί νέο folder στον τρέχοντα φάκελο του ενεργού space.
 *   Ζητάει όνομα μέσω modal (promptForText), μετά καλεί το σωστό
 *   backend command ανάλογα με το space.
 *
 * DUAL-SPACE
 *   • ENCRYPTED: CBF_BRIDGE.create() + ensureVaultUnlocked()
 *   • FIREFOX:   CBF_BRIDGE.firefoxCreate() (no unlock — D-34)
 *
 * DECISIONS
 *   D-13.1, D-34, D-35, D-50
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "add-folder"
 */

var CBF_FEATURE_ADD_FOLDER = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:AddFolder]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:AddFolder]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:AddFolder]', ...a); }

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
  //  Prompt wrapper
  // ============================================================
  async function _promptFolderName() {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.promptForText === 'function') {
      return await CBF_MODAL_SERVICE.promptForText('Όνομα νέου φακέλου:');
    }

    if (typeof window.CBF_Overlay_promptForText === 'function') {
      return await window.CBF_Overlay_promptForText('Όνομα νέου φακέλου:');
    }

    return window.prompt('Όνομα νέου φακέλου:');
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
      // 1. Prompt
      const name = await _promptFolderName();
      if (!name || !name.trim()) {
        log('prompt cancelled');
        return;
      }

      // 2. Read parent
      const parentId = CBF_UI.getCurrentFolderId();
      if (!parentId) {
        warn('getCurrentFolderId returned null');
        return;
      }

      // 3. Route by space
      if (activeSpace === 'encrypted') {
        await _createInEncrypted(name, parentId);
      } else if (activeSpace === 'firefox') {
        await _createInFirefox(name, parentId);
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
  async function _createInEncrypted(name, parentId) {
    // Auto-unlock (M-16 + D-50)
    let unlocked = false;
    if (typeof CBF_UI.ensureVaultUnlocked === 'function') {
      unlocked = await CBF_UI.ensureVaultUnlocked('για νέο φάκελο');
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

    log(`creating (encrypted) "${name}" → ${parentId} (gen=${gen})`);

    const res = await CBF_BRIDGE.create({
      parentId,
      type: 'folder',
      title: name.trim(),
      url: null,
      insertAfterId: null
    }, gen);

    log(`SUCCESS (encrypted) id=${res.result?.id}`);

    await _postCreateRefresh(parentId, res.result?.id);
  }

  // ============================================================
  //  Firefox space path
  // ============================================================
  async function _createInFirefox(name, parentId) {
    log(`creating (firefox) "${name}" → ${parentId}`);

    const res = await CBF_BRIDGE.firefoxCreate({
      parentId,
      type: 'folder',
      title: name.trim()
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
  //  Init — καλείται από content-overlay.js bootstrap
  // ============================================================
  function init(container, shadowRoot) {
    if (!container) {
      warn('init: container required');
      return false;
    }

    const btn = container.querySelector('#cbf-add-folder');
    if (!btn) {
      warn('init: button #cbf-add-folder not found');
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

    log('initialized (button active, dual-space)');
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
      _promptFolderName,
      _createInEncrypted,
      _createInFirefox,
      _postCreateRefresh,
      _showError
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_FEATURE_ADD_FOLDER = api;
  if (typeof self !== 'undefined') self.CBF_FEATURE_ADD_FOLDER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_ADD_FOLDER = api;

  log('Ready (dual-space: encrypted + firefox)');
  return api;
})();