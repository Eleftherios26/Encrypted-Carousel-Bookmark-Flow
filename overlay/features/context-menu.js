/**
 * context-menu.js — Right-click context menu (dual-space)
 *
 * @path     overlay/features/context-menu.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   V12E feature. Right-click context menu σε cards. 2 items:
 *     • Bookmark → 🌐 Άνοιγμα σε νέα καρτέλα / ✏️ Μετονομασία
 *     • Folder   → ✏️ Μετονομασία φακέλου
 *
 * DUAL-SPACE
 *   • ENCRYPTED: CBF_BRIDGE.rename() (sequencer + stateMAC + Merkle)
 *   • FIREFOX:   CBF_BRIDGE.send('firefoxRename')
 *
 * NON-OBVIOUS
 *   • Document click listener χρησιμοποιεί BUBBLE phase (V12E.E-03).
 *     Σε CAPTURE phase, το shadow DOM retargeting κάνει το
 *     `menuEl.contains(target)` false → close πριν τον handler.
 *   • close({ preserveTarget: true }) στο click handler (V12E.E-02) —
 *     αλλιώς ο handler θα διαβάσει null target.
 *   • _refreshAfterMutation(preserveSelectionId) (V12E.E-04) — SEL.set
 *     πριν το navigate, ώστε το nav-focus restore να βρει το item.
 *   • Κλείνει το main menu αν είναι ανοιχτό (coordination).
 *
 * DECISIONS
 *   D-13.1, D-16, D-52, D-53, D-54
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "context-menu"
 */

var CBF_FEATURE_CONTEXT_MENU = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MENU_WIDTH = 220;
  const MAX_TITLE_LENGTH = 500;

  // ============================================================
  //  State
  // ============================================================
  let container = null;
  let shadowRoot = null;
  let menuEl = null;

  let isOpen = false;
  let isInitialized = false;
  let _actionInProgress = false;

  let _targetItem = null;
  let _targetCard = null;

  let _documentClickHandler = null;
  let _documentKeydownHandler = null;
  let _documentContextMenuHandler = null;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:ContextMenu]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:ContextMenu]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:ContextMenu]', ...a); }

  // ============================================================
  //  Guards
  // ============================================================
  function _isActionInProgress() {
    if (_actionInProgress) return true;
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

  function _isModalActive() {
    if (typeof CBF_MODAL_SERVICE === 'undefined') return false;
    if (typeof CBF_MODAL_SERVICE.activeCount !== 'function') return false;
    return CBF_MODAL_SERVICE.activeCount() > 0;
  }

  // ============================================================
  //  i18n helper
  // ============================================================
  function _t(key, fallback) {
    try {
      if (typeof browser !== 'undefined' && browser.i18n) {
        const msg = browser.i18n.getMessage(key);
        if (msg) return msg;
      }
    } catch (_) {}
    return fallback;
  }

  // ============================================================
  //  Modal helpers
  // ============================================================
  async function _showAlert(title, message) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.showAlert === 'function') {
      return await CBF_MODAL_SERVICE.showAlert(title, message);
    }
    if (typeof window !== 'undefined' &&
        typeof window.CBF_Overlay_showAlert === 'function') {
      return await window.CBF_Overlay_showAlert(title, message);
    }
    window.alert(title + '\n' + message);
  }

  async function _promptText(title, placeholder = '') {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.promptForText === 'function') {
      return await CBF_MODAL_SERVICE.promptForText(title, placeholder);
    }
    if (typeof window !== 'undefined' &&
        typeof window.CBF_Overlay_promptForText === 'function') {
      return await window.CBF_Overlay_promptForText(title, placeholder);
    }
    return window.prompt(title, placeholder);
  }

  // ============================================================
  //  Active space helper
  // ============================================================
  function _getActiveSpace() {
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.getActiveSpace === 'function') {
      return CBF_UI.getActiveSpace() || 'firefox';
    }
    return 'firefox';
  }

  // ============================================================
  //  ACTION: Open in new tab (D-52)
  // ============================================================
  async function _onOpenInNewTab() {
    if (!_targetItem || _targetItem.type !== 'bookmark') {
      warn('openInNewTab: invalid target');
      return;
    }

    const url = _targetItem.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      await _showAlert('Μη Υποστηριζόμενο URL',
        'Ο σελιδοδείκτης δεν έχει έγκυρο http(s) URL.');
      return;
    }

    if (typeof CBF_BRIDGE === 'undefined' || !CBF_BRIDGE.send) {
      await _showAlert('Σφάλμα', 'Bridge not available');
      return;
    }

    try {
      const res = await CBF_BRIDGE.send('openInNewTab', { url });
      if (!res || !res.success) {
        await _showAlert('Σφάλμα',
          res?.error || 'Αποτυχία ανοίγματος σε νέα καρτέλα.');
        return;
      }
      log(`openInNewTab OK: tabId=${res.tabId}`);
    } catch (e) {
      err('openInNewTab failed:', e.message);
      let msg = 'Αποτυχία ανοίγματος σε νέα καρτέλα.';
      if (/INVALID_URL_PROTOCOL/i.test(e.message)) {
        msg = 'Μη υποστηριζόμενο URL. Μόνο http(s).';
      }
      await _showAlert('Σφάλμα', msg);
    }
  }

  // ============================================================
  //  ACTION: Rename (D-53, dual-space)
  // ============================================================
  async function _onRename() {
    if (!_targetItem) {
      warn('rename: no target');
      return;
    }

    const item = _targetItem;
    const isFolder = item.type === 'folder';
    const currentSpace = _getActiveSpace();

    const promptTitle = isFolder
      ? _t('prompt_rename_folder', 'Νέο όνομα φακέλου:')
      : _t('prompt_rename_bookmark', 'Νέο όνομα σελιδοδείκτη:');

    const newTitle = await _promptText(promptTitle, item.title || '');
    if (!newTitle || typeof newTitle !== 'string') {
      log('rename cancelled');
      return;
    }

    const trimmed = newTitle.trim();
    if (!trimmed) {
      await _showAlert('Σφάλμα', 'Ο τίτλος δεν μπορεί να είναι κενός.');
      return;
    }
    if (trimmed.length > MAX_TITLE_LENGTH) {
      await _showAlert('Σφάλμα',
        `Ο τίτλος είναι πολύ μεγάλος (max ${MAX_TITLE_LENGTH}).`);
      return;
    }

    if (trimmed === (item.title || '')) {
      log('rename: no change');
      return;
    }

    if (currentSpace === 'encrypted') {
      await _renameEncrypted(item.id, trimmed);
    } else {
      await _renameFirefox(item.id, trimmed);
    }
  }

  async function _renameEncrypted(id, title) {
    if (typeof CBF_BRIDGE === 'undefined' || typeof CBF_BRIDGE.rename !== 'function') {
      await _showAlert('Σφάλμα', 'Bridge rename not available');
      return;
    }

    const expectedGen = (typeof CBF_BRIDGE.getGeneration === 'function')
      ? CBF_BRIDGE.getGeneration()
      : 0;

    log(`rename (encrypted): ${id.slice(0, 8)} → "${title.slice(0, 30)}"`);

    try {
      const res = await CBF_BRIDGE.rename({ id, title }, expectedGen);
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Μετονομασίας', _mapRenameError(res?.error));
        return;
      }
      log(`rename (encrypted) OK: ${id.slice(0, 8)}`);

      // V12E.E-04: preserve selection μετά rename
      _refreshAfterMutation(id);
    } catch (e) {
      err('rename (encrypted) failed:', e.message);
      await _showAlert('Σφάλμα Μετονομασίας', _mapRenameError(e.message));
    }
  }

  async function _renameFirefox(id, title) {
    if (typeof CBF_BRIDGE === 'undefined' || !CBF_BRIDGE.send) {
      await _showAlert('Σφάλμα', 'Bridge not available');
      return;
    }

    log(`firefoxRename: ${id.slice(0, 8)} → "${title.slice(0, 30)}"`);

    try {
      const res = await CBF_BRIDGE.send('firefoxRename', { id, title });
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Μετονομασίας', _mapRenameError(res?.error));
        return;
      }
      log(`firefoxRename OK: ${id.slice(0, 8)}`);

      // V12E.E-04: preserve selection μετά rename
      _refreshAfterMutation(id);
    } catch (e) {
      err('firefoxRename failed:', e.message);
      await _showAlert('Σφάλμα Μετονομασίας', _mapRenameError(e.message));
    }
  }

  function _mapRenameError(msg) {
    const s = String(msg || '');
    if (/CANNOT_MODIFY_ROOT|FORBIDDEN/i.test(s)) return 'Δεν επιτρέπεται μετονομασία αυτού του στοιχείου.';
    if (/NODE_OUTSIDE_MANAGED_TREE/i.test(s)) return 'Το στοιχείο βρίσκεται έξω από το managed tree.';
    if (/TITLE_TOO_LONG/i.test(s)) return 'Ο τίτλος είναι πολύ μεγάλος.';
    if (/TITLE_CONTROL_CHARS/i.test(s)) return 'Ο τίτλος περιέχει μη έγκυρους χαρακτήρες.';
    if (/NOT_FOUND/i.test(s)) return 'Το στοιχείο δεν βρέθηκε.';
    if (/STALE_GENERATION/i.test(s)) return 'Το vault άλλαξε. Δοκιμάστε ξανά.';
    if (/RATE_LIMITED/i.test(s)) return 'Πολλές ενέργειες. Δοκιμάστε ξανά σε λίγο.';
    if (/NO_CAPABILITY/i.test(s)) return 'Λείπει δικαίωμα. Δοκιμάστε unlock.';
    if (/WRONG_SPACE/i.test(s)) return 'Λάθος χώρος. Δοκιμάστε ξανά.';
    return s || 'Άγνωστο σφάλμα.';
  }

  // ═══════════════════════════════════════════════════════════
  //  V12E.E-04: _refreshAfterMutation με preserve selection
  //
  //  1. SEL.set(id) ΠΡΙΝ το navigate → nav-focus capture
  //  2. navigateToFolder (θα βρει το pending selection)
  //  3. scrollToItem (defense-in-depth)
  // ═══════════════════════════════════════════════════════════
  function _refreshAfterMutation(preserveSelectionId) {
    if (typeof CBF_UI === 'undefined') return;
    if (typeof CBF_UI.navigateToFolder !== 'function') return;

    const cur = (typeof CBF_UI.getCurrentFolderId === 'function')
      ? CBF_UI.getCurrentFolderId()
      : null;
    if (!cur) return;

    // 1. Set selection ΠΡΙΝ το navigate
    if (preserveSelectionId && typeof CBF_SELECTION_MANAGER !== 'undefined') {
      try {
        CBF_SELECTION_MANAGER.set(preserveSelectionId);
        log(`V12E.E-04: SEL.set(${preserveSelectionId.slice(0, 8)}) for post-rename highlight`);
      } catch (e) {
        warn('V12E.E-04: SEL.set failed:', e.message);
      }
    }

    // 2. Navigate (θα βρει το pending selection)
    try {
      const p = CBF_UI.navigateToFolder(cur, { preservePath: true });

      if (p && typeof p.then === 'function') {
        p.then(() => {
          // 3. Force highlight (defense-in-depth)
          if (preserveSelectionId &&
              typeof CBF_UI.scrollToItem === 'function') {
            try {
              CBF_UI.scrollToItem(preserveSelectionId);
            } catch (e) {
              warn('V12E.E-04: scrollToItem failed:', e.message);
            }
          }
        }).catch(() => {});
      }
    } catch (_) {}
  }

  // ============================================================
  //  Menu DOM builder
  // ============================================================
  function _buildMenu() {
    const menu = document.createElement('div');
    menu.className = 'cbf-context-menu-popup';
    menu.id = 'cbf-context-menu-popup';
    menu.style.cssText = `
      position: fixed;
      background: rgba(20, 15, 50, 0.18);
      background-image: linear-gradient(
        135deg,
        rgba(80,40,140,0.28) 0%,
        rgba(45,65,160,0.22) 40%,
        rgba(55,45,145,0.18) 100%
      );
      backdrop-filter: blur(25px) saturate(200%) brightness(1.05);
      -webkit-backdrop-filter: blur(25px) saturate(200%) brightness(1.05);
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 12px;
      padding: 5px 0;
      z-index: 2147483647;
      display: none;
      min-width: ${MENU_WIDTH}px;
      max-width: 90vw;
      max-height: 300px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      box-shadow: 0 10px 28px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-sizing: border-box;
      scrollbar-width: thin;
      scrollbar-color: rgba(80,40,140,1) rgba(255,255,255,0.5);
      pointer-events: auto;
    `;

    // D-54: Keyboard isolation
    menu.addEventListener('keydown', (e) => e.stopPropagation());

    // V12E.E-03: mousedown/click isolation
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => e.stopPropagation());

    // Item: Άνοιγμα σε νέα καρτέλα
    const openItem = _createMenuItem({
      label: _t('context_new_tab', '🌐 Άνοιγμα σε νέα καρτέλα'),
      handler: _onOpenInNewTab,
      type: 'open'
    });
    menu.appendChild(openItem);

    // Item: Μετονομασία (bookmark)
    const renameBookmarkItem = _createMenuItem({
      label: _t('context_rename_bookmark', '✏️ Μετονομασία σελιδοδείκτη'),
      handler: _onRename,
      type: 'rename-bookmark'
    });
    menu.appendChild(renameBookmarkItem);

    // Item: Μετονομασία (folder)
    const renameFolderItem = _createMenuItem({
      label: _t('context_rename_folder', '✏️ Μετονομασία φακέλου'),
      handler: _onRename,
      type: 'rename-folder'
    });
    menu.appendChild(renameFolderItem);

    menu._items = {
      open: openItem,
      renameBookmark: renameBookmarkItem,
      renameFolder: renameFolderItem
    };

    return menu;
  }

  function _createMenuItem({ label, handler, type }) {
    const el = document.createElement('div');
    el.className = 'cbf-context-menu-item';
    el.dataset.type = type;
    el.style.cssText = `
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      color: #ffffff;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      text-shadow: 0 1px 3px rgba(0,0,0,0.5);
      border-radius: 6px;
      margin: 1px 5px;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.3;
      pointer-events: auto;
    `;
    el.textContent = label;

    el.addEventListener('mouseenter', () => {
      el.style.background = 'rgba(255,255,255,0.2)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = 'transparent';
    });

    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (_isActionInProgress()) {
        log('Context menu item blocked: action in progress');
        return;
      }
      if (_isSpaceTransitionInProgress()) {
        log('Context menu item blocked: space transition');
        return;
      }

      // V12E.E-02: preserve target για τον handler
      close({ preserveTarget: true });

      _actionInProgress = true;
      try {
        await handler();
      } catch (e) {
        err(`Context menu item "${type}" failed:`, e.message);
        await _showAlert('Σφάλμα', e.message || 'Άγνωστο σφάλμα.');
      } finally {
        _actionInProgress = false;
        _targetItem = null;
        _targetCard = null;
      }
    });

    return el;
  }

  // ============================================================
  //  Menu item visibility based on target type
  // ============================================================
  function _configureMenuForTarget(item) {
    if (!menuEl || !menuEl._items) return;

    const { open, renameBookmark, renameFolder } = menuEl._items;

    if (item.type === 'bookmark') {
      open.style.display = '';
      renameBookmark.style.display = '';
      renameFolder.style.display = 'none';
    } else if (item.type === 'folder') {
      open.style.display = 'none';
      renameBookmark.style.display = 'none';
      renameFolder.style.display = '';
    } else {
      open.style.display = 'none';
      renameBookmark.style.display = 'none';
      renameFolder.style.display = 'none';
    }
  }

  // ============================================================
  //  Position menu
  // ============================================================
  function _positionMenu(x, y) {
    if (!menuEl) return;

    const rect = menuEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x;
    let top = y;

    if (left + rect.width > vw - 10) {
      left = vw - rect.width - 10;
    }
    if (left < 10) left = 10;

    if (top + rect.height > vh - 10) {
      top = y - rect.height;
      if (top < 10) top = 10;
    }

    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  // ============================================================
  //  Open / Close
  // ============================================================
  function open(item, card, x, y) {
    if (!menuEl) return;

    _closeMainMenuIfOpen();

    _targetItem = item;
    _targetCard = card;

    _configureMenuForTarget(item);

    menuEl.style.display = 'block';
    menuEl.style.visibility = 'hidden';
    menuEl.style.opacity = '0';
    menuEl.style.transform = 'scale(0.95)';

    _positionMenu(x, y);

    menuEl.style.visibility = 'visible';
    isOpen = true;

    menuEl.style.transition = 'opacity 0.12s ease-out, transform 0.12s ease-out';
    requestAnimationFrame(() => {
      menuEl.style.opacity = '1';
      menuEl.style.transform = 'scale(1)';
    });

    log(`Context menu opened: type=${item.type} id=${item.id?.slice(0, 8)}`);
  }

  function close(opts = {}) {
    if (!menuEl || !isOpen) return;

    menuEl.style.display = 'none';
    menuEl.style.opacity = '0';
    menuEl.style.transform = 'scale(0.95)';
    menuEl.style.visibility = 'hidden';
    isOpen = false;

    if (!opts.preserveTarget) {
      _targetItem = null;
      _targetCard = null;
    }

    log(
      'Context menu closed' +
      (opts.preserveTarget ? ' (target preserved for handler)' : '')
    );
  }

  function _closeMainMenuIfOpen() {
    if (typeof CBF_FEATURE_MAIN_MENU === 'undefined') return;
    if (typeof CBF_FEATURE_MAIN_MENU.isOpen !== 'function') return;
    if (CBF_FEATURE_MAIN_MENU.isOpen()) {
      try {
        CBF_FEATURE_MAIN_MENU.close();
      } catch (_) {}
    }
  }

  // ============================================================
  //  Global listeners
  // ============================================================
  function _attachGlobalListeners() {
    // Click-outside → close (BUBBLE phase — V12E.E-03)
    _documentClickHandler = (e) => {
      if (!isOpen) return;

      const target = e.composedPath ? e.composedPath()[0] : e.target;

      if (menuEl && menuEl.contains(target)) return;

      close();   // external close → clear target ✓
    };

    // V12E.E-03: bubble phase (false)
    document.addEventListener('click', _documentClickHandler, false);

    // Escape → close (D-54)
    _documentKeydownHandler = (e) => {
      if (!isOpen) return;
      if (!e.isTrusted) return;

      if (_isModalActive()) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();   // external close → clear target ✓
      }
    };
    document.addEventListener('keydown', _documentKeydownHandler, true);

    // Context menu outside cards → close
    _documentContextMenuHandler = (e) => {
      if (!isOpen) return;

      const target = e.composedPath ? e.composedPath()[0] : e.target;
      if (menuEl && menuEl.contains(target)) return;

      const card = target && target.closest ? target.closest('.card') : null;
      if (!card) {
        close();
      }
    };
    document.addEventListener('contextmenu', _documentContextMenuHandler, true);

    // Scroll → close
    window.addEventListener('scroll', () => close(), true);
    window.addEventListener('resize', () => close(), true);
  }

  function _detachGlobalListeners() {
    if (_documentClickHandler) {
      document.removeEventListener('click', _documentClickHandler, false);
      _documentClickHandler = null;
    }
    if (_documentKeydownHandler) {
      document.removeEventListener('keydown', _documentKeydownHandler, true);
      _documentKeydownHandler = null;
    }
    if (_documentContextMenuHandler) {
      document.removeEventListener('contextmenu', _documentContextMenuHandler, true);
      _documentContextMenuHandler = null;
    }
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close, true);
  }

  // ============================================================
  //  Hook into UI controller
  // ============================================================
  function _registerWithUIController() {
    if (typeof CBF_UI === 'undefined') {
      warn('CBF_UI not available — cannot register context menu handler');
      return false;
    }

    if (typeof CBF_UI.setContextMenuHandler !== 'function') {
      warn('CBF_UI.setContextMenuHandler not available');
      return false;
    }

    CBF_UI.setContextMenuHandler((item, card, event) => {
      if (_isActionInProgress()) return;
      if (_isSpaceTransitionInProgress()) return;

      const x = (event && typeof event.clientX === 'number') ? event.clientX : 0;
      const y = (event && typeof event.clientY === 'number') ? event.clientY : 0;

      open(item, card, x, y);
    });

    log('Registered with CBF_UI.setContextMenuHandler');
    return true;
  }

  // ============================================================
  //  Init
  // ============================================================
  function init(containerEl, shadow) {
    if (isInitialized) {
      warn('init: already initialized');
      return true;
    }

    if (!containerEl) {
      warn('init: container required');
      return false;
    }

    container = containerEl;
    shadowRoot = shadow || null;

    menuEl = _buildMenu();

    const mountPoint = shadowRoot || document.body;
    mountPoint.appendChild(menuEl);

    _attachGlobalListeners();

    const ok = _registerWithUIController();
    if (!ok) {
      warn('Context menu will not function (UI hook failed)');
    }

    isInitialized = true;
    log('initialized (2 items: open in new tab + rename)');
    return true;
  }

  // ============================================================
  //  Destroy
  // ============================================================
  function destroy() {
    if (!isInitialized) return;

    _detachGlobalListeners();

    if (typeof CBF_UI !== 'undefined' &&
        typeof CBF_UI.setContextMenuHandler === 'function') {
      try {
        CBF_UI.setContextMenuHandler(null);
      } catch (_) {}
    }

    if (menuEl && menuEl.parentNode) {
      menuEl.parentNode.removeChild(menuEl);
    }
    menuEl = null;
    isOpen = false;
    _targetItem = null;
    _targetCard = null;

    container = null;
    shadowRoot = null;
    isInitialized = false;
    _actionInProgress = false;

    log('destroyed');
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    open,
    close,
    isOpen: () => isOpen,

    _internal: {
      _onOpenInNewTab,
      _onRename,
      _renameEncrypted,
      _renameFirefox,
      _mapRenameError,
      _buildMenu,
      _configureMenuForTarget,
      _registerWithUIController,
      _refreshAfterMutation,   // V12E.E-04
      isInitialized: () => isInitialized,
      isActionInProgress: () => _actionInProgress,
      getTargetItem: () => _targetItem,
      MENU_WIDTH,
      MAX_TITLE_LENGTH
    }
  };

  if (typeof window !== 'undefined')     window.CBF_FEATURE_CONTEXT_MENU = api;
  if (typeof self !== 'undefined')       self.CBF_FEATURE_CONTEXT_MENU = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_CONTEXT_MENU = api;

  log('Ready (V12E + V12E.E-02/03/04)');
  return api;
})();