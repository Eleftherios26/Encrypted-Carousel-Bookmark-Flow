/**
 * selection-manager.js — Selection manager (RAM-only)
 *
 * @path     overlay/selection-manager.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Διαχειρίζεται single & multi-selection state για το UI.
 *   Χρησιμοποιείται για drag & drop, keyboard navigation, bulk ops.
 *   ΔΕΝ αποθηκεύει σε IDB / storage — μόνο RAM.
 *
 * USAGE
 *   1. User κάνει action (π.χ. κλικ σε άλλο φάκελο)
 *   2. Καλεί CBF_SELECTION_MANAGER.set(itemId)
 *   3. Το UI φορτώνει νέα items
 *   4. Στο setItems(), ελέγχει getPendingIds()
 *   5. Αν βρει, επιλέγει το item στο νέο view
 *   6. Καλεί removeFound(foundIds)
 *
 * DECISIONS
 *   (architecture §11 — Overlay & Browser Integration)
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "selection"
 */

var CBF_SELECTION_MANAGER = (function() {
  'use strict';

  // ============================================================
  //  State
  // ============================================================
  let pendingId = null;       // single selection
  let pendingIds = [];        // multi selection
  let attempts = 0;           // retry counter
  const MAX_ATTEMPTS = 3;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('[SELECTION]', ...a);
    else console.log('[SELECTION]', ...a);
  }
  function warn(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.warn('[SELECTION]', ...a);
    else console.warn('[SELECTION]', ...a);
  }

  // ============================================================
  //  Single
  // ============================================================
  function set(id) {
    if (typeof id === 'string' && id) {
      pendingId = id;
      pendingIds = [];
      attempts = 0;
      log(`Set: ${id}`);
    } else {
      clear();
    }
  }

  // ============================================================
  //  Multiple
  // ============================================================
  function setMultiple(ids) {
    if (Array.isArray(ids) && ids.length > 0) {
      if (ids.length === 1) {
        set(ids[0]);
        return;
      }
      // Dedupe
      const unique = Array.from(new Set(ids.filter(x => typeof x === 'string' && x)));
      pendingIds = unique;
      pendingId = null;
      attempts = 0;
      log(`Set multiple: ${unique.join(',')}`);
    } else {
      clear();
    }
  }

  // ============================================================
  //  Remove found
  // ============================================================
  function removeFound(foundIds) {
    if (!Array.isArray(foundIds) || foundIds.length === 0) return;

    if (pendingId && foundIds.includes(pendingId)) {
      pendingId = null;
    }

    if (pendingIds.length > 0) {
      pendingIds = pendingIds.filter(id => !foundIds.includes(id));
    }

    if (pendingId === null && pendingIds.length === 0) {
      attempts = 0;
      log('All selections resolved');
    }
  }

  // ============================================================
  //  Clear
  // ============================================================
  function clear() {
    if (pendingId !== null || pendingIds.length > 0) {
      log('Cleared');
    }
    pendingId = null;
    pendingIds = [];
    attempts = 0;
  }

  // ============================================================
  //  Getters
  // ============================================================
  function getPending() {
    if (pendingId) return pendingId;
    if (pendingIds.length > 0) return pendingIds[0];
    return null;
  }

  function getPendingIds() {
    if (pendingIds.length > 0) return pendingIds.slice();
    if (pendingId) return [pendingId];
    return [];
  }

  function consume() {
    const ids = getPendingIds();
    clear();
    return ids;
  }

  function hasSelection() {
    return pendingId !== null || pendingIds.length > 0;
  }

  function isMulti() {
    return pendingIds.length > 1;
  }

  // ============================================================
  //  Retry logic
  // ============================================================
  function shouldRetry() {
    attempts++;
    if (attempts < MAX_ATTEMPTS) return true;
    warn(`Max attempts (${MAX_ATTEMPTS}) reached — clearing`);
    clear();
    return false;
  }

  function resetAttempts() {
    attempts = 0;
  }

  function getAttempts() {
    return attempts;
  }

  function getMaxAttempts() {
    return MAX_ATTEMPTS;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    set,
    setMultiple,
    removeFound,
    clear,
    getPending,
    getPendingIds,
    consume,
    hasSelection,
    isMulti,
    shouldRetry,
    resetAttempts,
    getAttempts,
    getMaxAttempts
  };

  if (typeof window !== 'undefined') window.CBF_SELECTION_MANAGER = api;
  if (typeof self !== 'undefined') self.CBF_SELECTION_MANAGER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_SELECTION_MANAGER = api;

  return api;
})();

console.log('[ECBF:Selection] Ready (v12.0.0)');