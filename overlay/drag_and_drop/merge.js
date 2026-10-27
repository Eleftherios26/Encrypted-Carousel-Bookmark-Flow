// overlay/drag_and_drop/merge.js
//
// ECBF v12E Final 2 (C3) — Encrypted Merge Coordinator
//
// @contract ECBF-v12E-Final1-Contract-Freeze v1.1
// @decision D-18, D-20 (stateMAC + Merkle, server-side)
// @decision D-50 (Merge auto-unlock — caller: dragdrop.js)
//
// ═══════════════════════════════════════════════════════════════════
//  C3 FIXES APPLIED
// ═══════════════════════════════════════════════════════════════════
//
//  C3-01 (FILE RECONSTRUCTION):
//    Το αρχείο ήταν corrupted (truncated header + missing
//    function definitions). Ανακατασκευάστηκε πλήρως ως
//    symmetric mirror του firefox-merge.js για consistency.
//
//  C3-02 (INPUT VALIDATION HARDENING):
//    Πλήρης validation με ρητά errors:
//      - Type checks (string, non-empty)
//      - Same-ID rejection (item1Id !== item2Id / source !== target)
//      - folderName trim + max length (500 chars, D-43 consistency)
//
//  C3-03 (BRIDGE METHOD GUARD):
//    `_hasBridge()` ελέγχει την ύπαρξη των CBF_BRIDGE.merge και
//    CBF_BRIDGE.mergeFolders. Αν λείπουν → ρητό error αντί για
//    σιωπηλό failure.
//
//  C3-04 (ERROR NORMALIZATION):
//    Όλες οι αποτυχίες επιστρέφουν ομοιόμορφα:
//      { success: false, error: string, code?: string }
//    με τον κωδικό σφάλματος από το Error.code (STALE_GENERATION,
//    NO_CAPABILITY, κλπ).
//
//  C3-05 (MAX TITLE LENGTH ENFORCEMENT):
//    Client-side guard για folderName > 500 chars
//    (D-43 consistency με server-side truncation).
//    Truncation αντί throw — δεν σπαταλάμε merge op.
//
//  C3-06 (LOGGING CONSISTENCY):
//    Prefix `[ECBF:Merge]` (αντί `[ECBF:EncryptedMerge]`) για
//    ομοιομορφία με `[ECBF:FF-Merge]`.
//
// ═══════════════════════════════════════════════════════════════════
//  SCOPE
// ═══════════════════════════════════════════════════════════════════
//
//  Encrypted space merge operations:
//    - mergeBookmarks: 2 bookmarks → νέος φάκελος (encrypted)
//    - mergeFolders:   source folder → subfolder του target (encrypted)
//
//  ΔΕΝ επικοινωνεί απευθείας με IDB. Όλα πάνε μέσω:
//    CBF_BRIDGE.merge() → messaging → sequencer → stateMAC + Merkle
//
// ═══════════════════════════════════════════════════════════════════

var CBF_MERGE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_TITLE_LENGTH = 500;   // D-43 consistency με server

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Merge]', ...a); }
  function warn(...a) { console.warn('[ECBF:Merge]', ...a); }
  function err(...a)  { console.error('[ECBF:Merge]', ...a); }

  // ============================================================
  //  C3-03: Bridge availability
  // ============================================================
  function _hasBridge() {
    return typeof CBF_BRIDGE !== 'undefined' &&
           typeof CBF_BRIDGE.merge === 'function' &&
           typeof CBF_BRIDGE.mergeFolders === 'function';
  }

  function _bridgeMissingError() {
    warn('CBF_BRIDGE.merge/mergeFolders not available — was bridge.js updated?');
    return {
      success: false,
      error: 'BRIDGE_MISSING_MERGE_METHODS'
    };
  }

  // ============================================================
  //  Validation — pure functions (για testing + UI guards)
  // ============================================================

  /**
   * Ελέγχει αν 2 items μπορούν να γίνουν merge (bookmarks only).
   *
   * @param  {object} item1
   * @param  {object} item2
   * @returns {boolean}
   */
  function canMergeBookmarks(item1, item2) {
    if (!item1 || !item2) return false;
    if (item1.type !== 'bookmark' || item2.type !== 'bookmark') return false;
    if (item1.id === item2.id) return false;
    return true;
  }

  /**
   * Ελέγχει αν 2 folders μπορούν να γίνουν merge (folders only).
   *
   * @param  {object} source
   * @param  {object} target
   * @returns {boolean}
   */
  function canMergeFolders(source, target) {
    if (!source || !target) return false;
    if (source.type !== 'folder' || target.type !== 'folder') return false;
    if (source.id === target.id) return false;
    return true;
  }

  /**
   * Προτείνει όνομα για τον νέο merged folder.
   * Same logic με firefox-merge.js.
   *
   * @param  {string} title1
   * @param  {string} title2
   * @returns {string}
   */
  function suggestMergedFolderName(title1, title2) {
    const t1 = (title1 || '').trim();
    const t2 = (title2 || '').trim();
    if (!t1 && !t2) return 'Merged Folder';
    if (!t1) return t2;
    if (!t2) return t1;
    const merged = `${t1} + ${t2}`;
    return merged.length > MAX_TITLE_LENGTH
      ? merged.slice(0, MAX_TITLE_LENGTH - 3) + '...'
      : merged;
  }

  // ============================================================
  //  C3-02: Input validation helpers
  // ============================================================

  function _requireNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
    return value;
  }

  // C3-05: Title truncation (D-43 consistency)
  function _normalizeTitle(rawTitle) {
    if (typeof rawTitle !== 'string') {
      throw new Error('folderName must be a string');
    }
    const trimmed = rawTitle.trim();
    if (trimmed.length === 0) {
      throw new Error('folderName must be non-empty');
    }
    if (trimmed.length > MAX_TITLE_LENGTH) {
      warn(`C3-05: folderName truncated: ${trimmed.length} → ${MAX_TITLE_LENGTH}`);
      return trimmed.slice(0, MAX_TITLE_LENGTH - 1) + '…';
    }
    return trimmed;
  }

  // C3-04: Error normalization
  function _normalizeError(e, fallbackCode) {
    if (!e) return { success: false, error: 'UNKNOWN', code: fallbackCode };
    return {
      success: false,
      error: e.message || String(e),
      code: e.code || fallbackCode
    };
  }

  // ============================================================
  //  mergeBookmarks
  //
  //  Δημιουργεί νέο folder στο parentId με τα 2 bookmarks μέσα.
  //  Server-side: CBF_MUTATION_MERGE (sequencer + stateMAC + Merkle).
  // ============================================================
  async function mergeBookmarks(item1Id, item2Id, folderName, parentId) {
    // ---------- C3-02: Input validation ----------
    let validItem1Id, validItem2Id, validFolderName, validParentId;
    try {
      validItem1Id  = _requireNonEmptyString(item1Id,  'item1Id');
      validItem2Id  = _requireNonEmptyString(item2Id,  'item2Id');
      validFolderName = _normalizeTitle(folderName);
      validParentId = _requireNonEmptyString(parentId, 'parentId');
    } catch (e) {
      warn('mergeBookmarks: validation failed:', e.message);
      return { success: false, error: e.message, code: 'INVALID_INPUT' };
    }

    if (validItem1Id === validItem2Id) {
      return { success: false, error: 'item1Id and item2Id must be different', code: 'SAME_ITEM' };
    }

    log(`mergeBookmarks: ${validItem1Id.slice(0, 8)} + ${validItem2Id.slice(0, 8)} → "${validFolderName}" in ${validParentId.slice(0, 8)}`);

    // ---------- C3-03: Bridge check ----------
    if (!_hasBridge()) return _bridgeMissingError();

    // ---------- Server call ----------
    try {
      const res = await CBF_BRIDGE.merge(
        validItem1Id,
        validItem2Id,
        validFolderName,
        validParentId
      );

      if (res && res.success) {
        log(`mergeBookmarks OK: id=${res.result?.id?.slice(0, 8)}`);
        return {
          success: true,
          id: res.result?.id,
          parentId: res.result?.parentId || validParentId,
          title: res.result?.title || validFolderName,
          item1Id: validItem1Id,
          item2Id: validItem2Id,
          generation: res.generation,
          warnings: res.warnings || []
        };
      }

      // Server returned success:false
      const errorMsg = res?.error || 'UNKNOWN';
      warn('mergeBookmarks server rejected:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        code: res?.code || 'SERVER_REJECTED'
      };

    } catch (e) {
      // ---------- C3-04: Error normalization ----------
      const normalized = _normalizeError(e, 'MERGE_FAILED');
      warn('mergeBookmarks threw:', normalized.error, '| code:', normalized.code);
      return normalized;
    }
  }

  // ============================================================
  //  mergeFolders
  //
  //  Δημιουργεί subfolder στο targetId με τα children του sourceId,
  //  μετά διαγράφει τον source.
  //  Server-side: CBF_MUTATION_MERGE_FOLDERS.
  // ============================================================
  async function mergeFolders(sourceId, targetId) {
    // ---------- C3-02: Input validation ----------
    let validSourceId, validTargetId;
    try {
      validSourceId = _requireNonEmptyString(sourceId, 'sourceId');
      validTargetId = _requireNonEmptyString(targetId, 'targetId');
    } catch (e) {
      warn('mergeFolders: validation failed:', e.message);
      return { success: false, error: e.message, code: 'INVALID_INPUT' };
    }

    if (validSourceId === validTargetId) {
      return { success: false, error: 'sourceId and targetId must be different', code: 'SAME_FOLDER' };
    }

    log(`mergeFolders: ${validSourceId.slice(0, 8)} → ${validTargetId.slice(0, 8)}`);

    // ---------- C3-03: Bridge check ----------
    if (!_hasBridge()) return _bridgeMissingError();

    // ---------- Server call ----------
    try {
      const res = await CBF_BRIDGE.mergeFolders(validSourceId, validTargetId);

      if (res && res.success) {
        log(`mergeFolders OK: id=${res.result?.id?.slice(0, 8)}`);
        return {
          success: true,
          id: res.result?.id,
          parentId: res.result?.parentId || validTargetId,
          title: res.result?.title,
          movedChildren: res.result?.movedChildren || 0,
          generation: res.generation,
          warnings: res.warnings || []
        };
      }

      // Server returned success:false
      const errorMsg = res?.error || 'UNKNOWN';
      warn('mergeFolders server rejected:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        code: res?.code || 'SERVER_REJECTED'
      };

    } catch (e) {
      // ---------- C3-04: Error normalization ----------
      const normalized = _normalizeError(e, 'MERGE_FOLDERS_FAILED');
      warn('mergeFolders threw:', normalized.error, '| code:', normalized.code);
      return normalized;
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // Validation (UI guards)
    canMergeBookmarks,
    canMergeFolders,
    suggestMergedFolderName,

    // Mutations
    mergeBookmarks,
    mergeFolders,

    // Constants
    MAX_TITLE_LENGTH,

    // Diagnostics
    _internal: {
      _hasBridge,
      _requireNonEmptyString,
      _normalizeTitle,
      _normalizeError
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_MERGE = api;
  if (typeof self !== 'undefined') self.CBF_MERGE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MERGE = api;

  log('Ready (v12E.Final2-C3: reconstructed + validation + error normalization)');
  return api;
})();