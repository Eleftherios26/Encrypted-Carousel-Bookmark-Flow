/**
 * ui-coordinator.js — UI coordinator (space router)
 *
 * @path     overlay/drag_and_drop/ui-coordinator.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Router που επιλέγει το σωστό module βάσει space (firefox / encrypted).
 *   Επίσης διαχειρίζεται:
 *     • C-4: awaited + idempotent reload σε αποτυχία
 *     • M-06: reload fallback chain + user notification
 *     • v1.3.3: state + DOM visual sync μετά από mutation
 *     • v1.5.2: multi-move white-highlight fix
 *
 * ARCHITECTURE
 *   dragdrop.js
 *       │  drop event → moveSingleItem(..., space)
 *       ▼
 *   ui-coordinator.js (this file)
 *       │  router: space === 'firefox' ?
 *       ├── YES → CBF_FIREFOX_REDISTRIBUTION / CBF_FIREFOX_MERGE
 *       └── NO  → CBF_REDISTRIBUTION / CBF_MERGE
 *       │
 *       ▼
 *   (optimistic UI + backend call + rollback + C-4 reload σε αποτυχία)
 *
 * DECISIONS
 *   D-48
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "ui-coordinator"
 */

var CBF_UI_COORDINATOR = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:UICoordinator]', ...a); }
  function warn(...a) { console.warn('[ECBF:UICoordinator]', ...a); }
  function err(...a)  { console.error('[ECBF:UICoordinator]', ...a); }

  // ============================================================
  //  C-4: Reload state
  // ============================================================
  let _reloadInProgress = false;
  let _reloadPromise = null;

  // ============================================================
  //  M-06: Consecutive reload failures
  // ============================================================
  const RELOAD_FAILURE_THRESHOLD = 3;
  let _consecutiveReloadFailures = 0;
  let _reloadAlertShown = false;

  // ============================================================
  //  C3-02: Last reload diagnostics
  // ============================================================
  let _lastReloadInfo = {
    reason: null,
    startedAt: null,
    localSeqAtStart: null,
    localSeqAfterHardReset: null,
    strategiesTried: [],
    outcome: null,
    durationMs: null
  };

  // ============================================================
  //  Space resolver
  // ============================================================
  function _resolveSpace(space) {
    if (space === 'firefox' || space === 'encrypted') return space;
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.getActiveSpace === 'function') {
      return CBF_UI.getActiveSpace() || 'firefox';
    }
    return 'firefox';
  }

  function _getCurrentFolderId() {
    return (typeof CBF_UI !== 'undefined') ? CBF_UI.getCurrentFolderId() : null;
  }

  // ============================================================
  //  Module availability checks
  // ============================================================
  function _hasModule(name) {
    return typeof window !== 'undefined' &&
           typeof window[name] !== 'undefined' &&
           window[name] !== null;
  }

  function _missingModuleError(moduleName, space) {
    warn(`Missing module ${moduleName} (space=${space})`);
    return {
      success: false,
      error: `MODULE_NOT_LOADED: ${moduleName}`
    };
  }

  // ============================================================
  //  v1.3.3: Selection visual sync helpers
  //
  //  Το `CBF_SELECTION_MANAGER` (state) ΔΕΝ έχει πρόσβαση στο DOM.
  //  Χρειάζεται να καλέσουμε τα UI helpers για να ενημερωθούν:
  //    - `.card-selected` / `.card-anchor` classes
  //    - bulk-lock badge visibility
  //    - selection-info banner visibility
  //
  //  Fail-safe: αν λείπει το CBF_UI._internal, απλώς log-άρουμε.
  // ============================================================
  function _syncSelectionVisuals(context) {
    try {
      if (typeof CBF_UI === 'undefined' || !CBF_UI._internal) {
        warn(`${context}: CBF_UI._internal not available — visuals not synced`);
        return;
      }

      if (typeof CBF_UI._internal._applySelectionVisuals === 'function') {
        CBF_UI._internal._applySelectionVisuals();
      } else {
        warn(`${context}: _applySelectionVisuals not available`);
      }

      if (typeof CBF_UI._internal._updateSelectionBadge === 'function') {
        CBF_UI._internal._updateSelectionBadge();
      } else {
        warn(`${context}: _updateSelectionBadge not available`);
      }
    } catch (e) {
      err(`${context}: _syncSelectionVisuals failed:`, e.message);
    }
  }

  // ============================================================
  //  C3-02: Safe accessor για το bridge localSeq
  // ============================================================
  function _safeGetLocalSeq() {
    try {
      if (typeof CBF_BRIDGE === 'undefined') return null;
      if (typeof CBF_BRIDGE._getLocalSeq === 'function') {
        return CBF_BRIDGE._getLocalSeq();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // ============================================================
  //  M-06: Reset failure counter
  // ============================================================
  function _resetReloadFailures() {
    if (_consecutiveReloadFailures > 0) {
      log(`M-06: reset reload failures (was ${_consecutiveReloadFailures})`);
    }
    _consecutiveReloadFailures = 0;
    _reloadAlertShown = false;
  }

  // ============================================================
  //  M-06: Register reload failure + spam-guarded alert
  // ============================================================
  async function _registerReloadFailure(reason) {
    _consecutiveReloadFailures++;
    warn(`M-06: reload failure #${_consecutiveReloadFailures} (reason: ${reason})`);

    // Spam guard: 1 alert ανά σειρά αποτυχιών
    if (_consecutiveReloadFailures >= RELOAD_FAILURE_THRESHOLD && !_reloadAlertShown) {
      _reloadAlertShown = true;

      warn(`M-06: threshold reached (${RELOAD_FAILURE_THRESHOLD}) — showing alert`);

      if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
          typeof CBF_MODAL_SERVICE.showAlert === 'function') {
        try {
          await CBF_MODAL_SERVICE.showAlert(
            'Ενημέρωση',
            'Το UI δεν μπόρεσε να ανανεωθεί αυτόματα μετά από ' +
            'πολλαπλές αποτυχίες.\n\n' +
            'Τα δεδομένα σας είναι ασφαλή, αλλά η οθόνη μπορεί να ' +
            'δείχνει παλιά κατάσταση.\n\n' +
            'Παρακαλώ κλείστε και ξανανοίξτε το overlay (Esc → κλικ εικονίδιο).'
          );
        } catch (e) {
          err('M-06: showAlert failed:', e.message);
        }
      }
    }
  }

  // ============================================================
  //  C-4 + M-06 + C3-01/02: Reload helper
  // ============================================================
  async function _reloadCurrentFolder(reason) {
    // C-4: Mutex — no concurrent reloads
    if (_reloadInProgress) {
      warn(`Reload already in progress — waiting (reason: ${reason})`);
      if (_reloadPromise) {
        return await _reloadPromise;
      }
      return false;
    }

    _reloadInProgress = true;

    // C3-02: Initialize diagnostics state for this reload
    const localSeqAtStart = _safeGetLocalSeq();
    const startedAt = Date.now();
    _lastReloadInfo = {
      reason,
      startedAt,
      localSeqAtStart,
      localSeqAfterHardReset: null,
      strategiesTried: [],
      outcome: null,
      durationMs: null
    };

    _reloadPromise = (async () => {
      log(`M-06: reload start (reason: ${reason}, localSeq=${localSeqAtStart ?? '?'})`);

      const currentFolderId = _getCurrentFolderId();
      const currentSpace = _resolveSpace();

      // ═══════════════════════════════════════════════════════════
      //  STRATEGY 1: hardReset + navigateToFolder
      //
      //  C3-01 NOTE:
      //    Μετά το bridge.js C3-01 fix, το `hardReset()` ΔΕΝ
      //    μηδενίζει το localSeq. Άρα:
      //
      //      ΠΡΙΝ (C2): hardReset() → localSeq=0 → επόμενο send
      //                 requestSeq=1 → server 1 ≤ N → REPLAY → timeout
      //
      //      ΜΕΤΑ (C3): hardReset() → localSeq preserved → επόμενο send
      //                 requestSeq=N+1 > server.lastSequence → ACCEPTED
      // ═══════════════════════════════════════════════════════════
      if (currentFolderId) {
        _lastReloadInfo.strategiesTried.push('strategy1');

        if (typeof CBF_BRIDGE !== 'undefined' &&
            typeof CBF_BRIDGE.hardReset === 'function') {
          const pendingBefore = (typeof CBF_BRIDGE._pendingCount === 'function')
            ? CBF_BRIDGE._pendingCount()
            : -1;

          try {
            const cleared = CBF_BRIDGE.hardReset();
            _lastReloadInfo.localSeqAfterHardReset = _safeGetLocalSeq();

            log(
              `M-06: strategy 1 — hardReset OK ` +
              `(pending before=${pendingBefore}, cleared=${cleared}, ` +
              `localSeq ${localSeqAtStart ?? '?'} → ${_lastReloadInfo.localSeqAfterHardReset ?? '?'})`
            );
          } catch (e) {
            warn('M-06: hardReset failed:', e.message);
            _lastReloadInfo.localSeqAfterHardReset = _safeGetLocalSeq();
          }
        } else {
          log('M-06: strategy 1 — hardReset not available, skipping');
        }

        if (typeof CBF_UI !== 'undefined' &&
            typeof CBF_UI.navigateToFolder === 'function') {
          try {
            await CBF_UI.navigateToFolder(currentFolderId, { preservePath: true });
            log('M-06: strategy 1 SUCCESS (navigate to currentFolderId)');
            _resetReloadFailures();

            _lastReloadInfo.outcome = 'success';
            _lastReloadInfo.durationMs = Date.now() - startedAt;
            return true;
          } catch (e) {
            err('M-06: strategy 1 (navigateToFolder) FAILED:', e.message);
          }
        } else {
          warn('M-06: strategy 1 — CBF_UI.navigateToFolder not available');
        }
      }

      // ═══════════════════════════════════════════════════════════
      //  STRATEGY 2: SKIPPED (by design)
      //
      //  Ίδια με Strategy 1 αν το hardReset απέτυχε. Αν φτάσαμε εδώ,
      //  το navigateToFolder(currentFolderId) θα αποτύχει ξανά με τον
      //  ίδιο τρόπο. Άρα skip.
      // ═══════════════════════════════════════════════════════════

      // ═══════════════════════════════════════════════════════════
      //  STRATEGY 3 (M-06): navigate στο space root (last-resort)
      // ═══════════════════════════════════════════════════════════
      const spaceRootId    = currentSpace === 'encrypted' ? 'ecbf-root' : 'toolbar_____';
      const spaceRootTitle = currentSpace === 'encrypted' ? 'Encrypted Root' : 'Bookmarks Toolbar';

      _lastReloadInfo.strategiesTried.push('strategy3');

      warn(`M-06: falling back to strategy 3 (space root: ${spaceRootId})`);

      if (typeof CBF_UI !== 'undefined' &&
          typeof CBF_UI.navigateToFolder === 'function') {
        try {
          if (typeof CBF_UI.resetNavSeq === 'function') {
            CBF_UI.resetNavSeq();
          }
          if (typeof CBF_UI.setBreadcrumbPath === 'function') {
            CBF_UI.setBreadcrumbPath([{ id: spaceRootId, title: spaceRootTitle }]);
          }
          if (typeof CBF_UI.setCurrentFolderId === 'function') {
            CBF_UI.setCurrentFolderId(spaceRootId);
          }

          await CBF_UI.navigateToFolder(spaceRootId);
          log(`M-06: strategy 3 SUCCESS (navigate to ${spaceRootId})`);

          _reloadAlertShown = false;

          _lastReloadInfo.outcome = 'partial';
          _lastReloadInfo.durationMs = Date.now() - startedAt;
          return true;
        } catch (e) {
          err(`M-06: strategy 3 (space root) FAILED:`, e.message);
        }
      } else {
        warn('M-06: strategy 3 — CBF_UI.navigateToFolder not available');
      }

      // Όλες οι strategies απέτυχαν
      err('M-06: ALL reload strategies FAILED — UI is stale');
      _lastReloadInfo.outcome = 'failed';
      _lastReloadInfo.durationMs = Date.now() - startedAt;

      await _registerReloadFailure(reason);
      return false;
    })();

    try {
      return await _reloadPromise;
    } finally {
      _reloadInProgress = false;
      _reloadPromise = null;
    }
  }

  // ============================================================
  //  MOVE SINGLE ITEM
  // ============================================================
  async function moveSingleItem(itemId, targetFolderId, position = 'inside', targetId = null, space) {
    const effectiveSpace = _resolveSpace(space);
    log(`moveSingleItem: ${itemId} → ${targetFolderId} (${position}, space=${effectiveSpace})`);

    // ---------- Optimistic UI ----------
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.applyLocalMoveSingle === 'function') {
      CBF_UI.applyLocalMoveSingle(itemId, targetFolderId, position, targetId);
    }

    // ---------- Route ----------
    let result;
    if (effectiveSpace === 'firefox') {
      if (!_hasModule('CBF_FIREFOX_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_FIREFOX_REDISTRIBUTION', 'firefox');
      } else {
        result = await CBF_FIREFOX_REDISTRIBUTION.moveSingleItem(
          itemId, targetFolderId, position, targetId
        );
      }
    } else {
      if (!_hasModule('CBF_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_REDISTRIBUTION', 'encrypted');
      } else {
        result = await CBF_REDISTRIBUTION.moveSingleItem(
          itemId, targetFolderId, position, targetId
        );
      }
    }

    // ---------- Handle result ----------
    if (result && result.success) {
      // v1.3.3: Single-move ΚΡΑΤΑΕΙ selection + visual sync
      if (typeof CBF_SELECTION_MANAGER !== 'undefined') {
        CBF_SELECTION_MANAGER.set(itemId);
      }
      _syncSelectionVisuals('moveSingleItem');
      return result;
    }

    // ---------- Rollback ----------
    if (result && result.error && result.error.startsWith('MODULE_NOT_LOADED')) {
      return result;
    }

    warn(`moveSingleItem failed: ${result?.error}`);
    if (result && result.code === 'STALE_GENERATION') {
      warn('STALE_GENERATION → forcing resync');
    }

    // C-4: awaited reload
    await _reloadCurrentFolder('move failed');
    return result;
  }

  // ============================================================
  //  MOVE MULTIPLE ITEMS
  // ============================================================
  async function moveMultipleItems(itemIds, targetFolderId, position = 'inside', targetId = null, space) {
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return { success: false, error: 'Empty ids' };
    }
    const effectiveSpace = _resolveSpace(space);
    log(`moveMultipleItems: [${itemIds.join(',')}] → ${targetFolderId} (${position}, space=${effectiveSpace})`);

    // ---------- Optimistic UI ----------
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.applyLocalMoveMultiple === 'function') {
      CBF_UI.applyLocalMoveMultiple(itemIds, targetFolderId, position, targetId);
    }

    // ---------- Route ----------
    let result;
    if (effectiveSpace === 'firefox') {
      if (!_hasModule('CBF_FIREFOX_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_FIREFOX_REDISTRIBUTION', 'firefox');
      } else {
        result = await CBF_FIREFOX_REDISTRIBUTION.moveMultipleItems(
          itemIds, targetFolderId, position, targetId
        );
      }
    } else {
      if (!_hasModule('CBF_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_REDISTRIBUTION', 'encrypted');
      } else {
        result = await CBF_REDISTRIBUTION.moveMultipleItems(
          itemIds, targetFolderId, position, targetId
        );
      }
    }

    // ---------- Handle result ----------
    if (result && result.success) {
      // ═══════════════════════════════════════════════════════════
      //  v1.5.2 FIX: Multi-move → set FIRST moved item
      //
      //  ΠΡΙΝ (v1.5.1): clear() → no pendingId → white highlight
      //                 έπεφτε στο items[0] αντί στο moved item.
      //
      //  ΜΕΤΑ (v1.5.2): set(itemIds[0]) → το navigateToFolder()
      //                 (καλείται από dragdrop.js handler) θα κάνει
      //                 `_applyPendingSelection()` → white highlight
      //                 στο moved item → μετά removeFound() → SEL=[].
      //
      //  ΣΗΜΑΝΤΙΚΟ:
      //    Multi-REORDER (dragdrop._handleReorder) ΔΕΝ κάνει
      //    navigateToFolder (ίδιος φάκελος) → ο caller καθαρίζει
      //    ρητά τη selection (βλ. dragdrop.js v1.5.2).
      // ═══════════════════════════════════════════════════════════
      if (typeof CBF_SELECTION_MANAGER !== 'undefined' && itemIds.length > 0) {
        CBF_SELECTION_MANAGER.set(itemIds[0]);
        log(`v1.5.2: multi-move → SEL.set(${itemIds[0].slice(0, 8)}) for nav-focus white highlight`);
      }
      _syncSelectionVisuals('moveMultipleItems');
      return result;
    }

    // ---------- Rollback ----------
    if (result && result.error && result.error.startsWith('MODULE_NOT_LOADED')) {
      return result;
    }

    warn(`moveMultipleItems failed: ${result?.error}`);

    // C-4: awaited reload
    await _reloadCurrentFolder('multi-move failed');
    return result;
  }

  // ============================================================
  //  REORDER ITEM (same parent)
  // ============================================================
  async function reorderItem(itemId, targetId, position, space) {
    const effectiveSpace = _resolveSpace(space);
    log(`reorderItem: ${itemId} ${position} ${targetId} (space=${effectiveSpace})`);

    // ---------- Optimistic UI ----------
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.applyLocalMoveSingle === 'function') {
      const currentFolderId = _getCurrentFolderId();
      CBF_UI.applyLocalMoveSingle(itemId, currentFolderId, position, targetId);
    }

    // ---------- Route ----------
    let result;
    if (effectiveSpace === 'firefox') {
      if (!_hasModule('CBF_FIREFOX_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_FIREFOX_REDISTRIBUTION', 'firefox');
      } else {
        result = await CBF_FIREFOX_REDISTRIBUTION.reorderItem(itemId, targetId, position);
      }
    } else {
      if (!_hasModule('CBF_REDISTRIBUTION')) {
        result = _missingModuleError('CBF_REDISTRIBUTION', 'encrypted');
      } else {
        result = await CBF_REDISTRIBUTION.reorderItem(itemId, targetId, position);
      }
    }

    // ---------- Handle result ----------
    if (result && result.success) {
      // v1.3.3: Reorder ΚΡΑΤΑΕΙ selection + visual sync
      if (typeof CBF_SELECTION_MANAGER !== 'undefined') {
        CBF_SELECTION_MANAGER.set(itemId);
      }
      _syncSelectionVisuals('reorderItem');
      return result;
    }

    // ---------- Rollback ----------
    if (result && result.error && result.error.startsWith('MODULE_NOT_LOADED')) {
      return result;
    }

    warn(`reorderItem failed: ${result?.error}`);

    // C-4: awaited reload
    await _reloadCurrentFolder('reorder failed');
    return result;
  }

  // ============================================================
  //  MERGE BOOKMARKS → νέος φάκελος
  // ============================================================
  async function mergeBookmarks(item1Id, item2Id, folderName, parentId, space) {
    const effectiveSpace = _resolveSpace(space);
    log(`mergeBookmarks: ${item1Id} + ${item2Id} → "${folderName}" (space=${effectiveSpace})`);

    // ---------- Route ----------
    let result;
    if (effectiveSpace === 'firefox') {
      if (!_hasModule('CBF_FIREFOX_MERGE')) {
        result = _missingModuleError('CBF_FIREFOX_MERGE', 'firefox');
      } else {
        result = await CBF_FIREFOX_MERGE.mergeBookmarks(
          item1Id, item2Id, folderName, parentId
        );
      }
    } else {
      if (!_hasModule('CBF_MERGE')) {
        result = _missingModuleError('CBF_MERGE', 'encrypted');
      } else {
        result = await CBF_MERGE.mergeBookmarks(
          item1Id, item2Id, folderName, parentId
        );
      }
    }

    // ---------- Handle result ----------
    if (result && result.success) {
      if (typeof CBF_UI !== 'undefined' && CBF_UI.navigateToFolder) {
        if (result.id && typeof CBF_SELECTION_MANAGER !== 'undefined') {
          CBF_SELECTION_MANAGER.set(result.id);
        }
        await CBF_UI.navigateToFolder(parentId);
      }
      return result;
    }

    if (result && result.error && result.error.startsWith('MODULE_NOT_LOADED')) {
      return result;
    }

    warn(`mergeBookmarks failed: ${result?.error}`);

    // C-4: awaited reload
    await _reloadCurrentFolder('merge failed');
    return result;
  }

  // ============================================================
  //  MERGE FOLDERS
  // ============================================================
  async function mergeFolders(sourceId, targetId, space) {
    const effectiveSpace = _resolveSpace(space);
    log(`mergeFolders: ${sourceId} → ${targetId} (space=${effectiveSpace})`);

    // ---------- Route ----------
    let result;
    if (effectiveSpace === 'firefox') {
      if (!_hasModule('CBF_FIREFOX_MERGE')) {
        result = _missingModuleError('CBF_FIREFOX_MERGE', 'firefox');
      } else {
        result = await CBF_FIREFOX_MERGE.mergeFolders(sourceId, targetId);
      }
    } else {
      if (!_hasModule('CBF_MERGE')) {
        result = _missingModuleError('CBF_MERGE', 'encrypted');
      } else {
        result = await CBF_MERGE.mergeFolders(sourceId, targetId);
      }
    }

    // ---------- Handle result ----------
    if (result && result.success) {
      if (typeof CBF_UI !== 'undefined' && CBF_UI.navigateToFolder) {
        if (result.id && typeof CBF_SELECTION_MANAGER !== 'undefined') {
          CBF_SELECTION_MANAGER.set(result.id);
        }
        await CBF_UI.navigateToFolder(targetId);
      }
      return result;
    }

    if (result && result.error && result.error.startsWith('MODULE_NOT_LOADED')) {
      return result;
    }

    warn(`mergeFolders failed: ${result?.error}`);

    // C-4: awaited reload
    await _reloadCurrentFolder('mergeFolders failed');
    return result;
  }

  // ============================================================
  //  CROSS-SPACE TRANSFER
  // ============================================================
  async function transferItemToEncrypted(itemId, itemType) {
    log(`transferItemToEncrypted: ${itemId} (${itemType})`);
    if (!_hasModule('CBF_BOOKMARK_TRANSFER')) {
      return _missingModuleError('CBF_BOOKMARK_TRANSFER', 'cross-space');
    }
    const isFolder = itemType === 'folder';
    return await CBF_BOOKMARK_TRANSFER.transferToEncrypted(itemId, isFolder);
  }

  async function transferItemToFirefox(itemId, itemType) {
    log(`transferItemToFirefox: ${itemId} (${itemType})`);
    if (!_hasModule('CBF_BOOKMARK_TRANSFER')) {
      return _missingModuleError('CBF_BOOKMARK_TRANSFER', 'cross-space');
    }
    const isFolder = itemType === 'folder';
    return await CBF_BOOKMARK_TRANSFER.transferToFirefox(itemId, isFolder);
  }

  // ============================================================
  //  C-4 + C3-02: Diagnostics
  // ============================================================
  function isReloading() {
    return _reloadInProgress;
  }

  function getReloadFailureCount() {
    return _consecutiveReloadFailures;
  }

  function resetReloadFailures() {
    _resetReloadFailures();
  }

  /**
   * C3-02: Επιστρέφει snapshot του _lastReloadInfo.
   */
  function getLastReloadInfo() {
    return {
      reason: _lastReloadInfo.reason,
      startedAt: _lastReloadInfo.startedAt,
      localSeqAtStart: _lastReloadInfo.localSeqAtStart,
      localSeqAfterHardReset: _lastReloadInfo.localSeqAfterHardReset,
      strategiesTried: _lastReloadInfo.strategiesTried.slice(),
      outcome: _lastReloadInfo.outcome,
      durationMs: _lastReloadInfo.durationMs
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // Space-aware mutations
    moveSingleItem,
    moveMultipleItems,
    reorderItem,
    mergeBookmarks,
    mergeFolders,

    // Cross-space transfers
    transferItemToEncrypted,
    transferItemToFirefox,

    // C-4: Diagnostics
    isReloading,

    // M-06: Diagnostics
    getReloadFailureCount,
    resetReloadFailures,
    RELOAD_FAILURE_THRESHOLD,

    // C3-02: Diagnostics
    getLastReloadInfo,

    // Diagnostics
    _internal: {
      _resolveSpace,
      _hasModule,
      _missingModuleError,
      _reloadCurrentFolder,
      _getCurrentFolderId,
      _registerReloadFailure,
      _resetReloadFailures,
      _safeGetLocalSeq,
      _syncSelectionVisuals,
      _getConsecutiveFailures: () => _consecutiveReloadFailures,
      _wasAlertShown: () => _reloadAlertShown,
      _getLastReloadInfoRaw: () => _lastReloadInfo
    }
  };

  if (typeof window !== 'undefined') window.CBF_UI_COORDINATOR = api;
  if (typeof self !== 'undefined') self.CBF_UI_COORDINATOR = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_UI_COORDINATOR = api;

  log(
    'Ready (v12.0.0: space router + C-4 awaited reload + ' +
    'M-06 reload fallback + C3-01 bridge interaction + C3-02 diagnostics + ' +
    'state+visual selection sync + multi-move white-highlight fix)'
  );
  return api;
})();