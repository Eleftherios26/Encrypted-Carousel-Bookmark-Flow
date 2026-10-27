/**
 * firefox-redistribution.js — Firefox move/reorder helpers (leaf)
 *
 * @path     overlay/drag_and_drop/firefox_drag_and_drop/firefox-redistribution.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Move & reorder helpers για Firefox space. Wraps τα
 *   CBF_BRIDGE.firefoxMove / firefoxReorder μέσω HMAC-signed port.
 *   Υποστηρίζει single + multi move με best-effort rollback.
 *
 * API
 *   • moveSingleItem(id, newParentId, position, targetId)
 *   • moveMultipleItems(ids, newParentId, position, targetId)
 *   • reorderItem(id, targetId, position)
 *
 * KEY CONCEPTS
 *   • C-1: Multi-move before/after order preservation (lastMovedId
 *     tracking αντί repeated 'after' firstId)
 *   • B-2: Rollback με original parent (capture πριν τα moves)
 *   • M-5: Post-rollback verification (verify items back in original)
 *   • L-4: Distinguish failed (actual mismatch) από skipped
 *     (verify failure — unknown, όχι wrong)
 *
 * LIMITATIONS
 *   1. Best-effort rollback: ΔΕΝ αποκαθιστά το index εντός parent.
 *      Αιτία: το CBF_BRIDGE.getPath() δεν επιστρέφει index.
 *      Επίπτωση: μετά rollback, items επιστρέφουν στον σωστό parent
 *      αλλά στο τέλος. Data loss = μηδέν.
 *   2. Αν το getPath αποτύχει → rollback skip για το item.
 *
 * DECISIONS
 *   D-36 (non-atomic), D-45 (failed NOT cached)
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "firefox-redistribution"
 */

var CBF_FIREFOX_REDISTRIBUTION = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:FF-Redistribution]', ...a); }
  function warn(...a) { console.warn('[ECBF:FF-Redistribution]', ...a); }

  // ============================================================
  //  Bridge availability check
  // ============================================================
  function _hasBridge() {
    return typeof CBF_BRIDGE !== 'undefined' &&
           typeof CBF_BRIDGE.firefoxMove === 'function' &&
           typeof CBF_BRIDGE.firefoxReorder === 'function';
  }

  function _bridgeMissingError() {
    warn('CBF_BRIDGE.firefoxMove/reorder not available — was bridge.js updated?');
    return {
      success: false,
      error: 'BRIDGE_MISSING_FIREFOX_METHODS'
    };
  }

  // ============================================================
  //  B-2: Capture original parents για rollback
  //
  //  Χρησιμοποιεί CBF_BRIDGE.getPath(id) το οποίο επιστρέφει:
  //    { commandId, path: [{id, title}, ..., {id, title}], space }
  //
  //  Το parent είναι το path[path.length - 2].
  // ============================================================
  async function _captureOriginalParents(ids) {
    const originals = [];

    for (const id of ids) {
      try {
        if (typeof CBF_BRIDGE.getPath !== 'function') {
          warn(`getPath not available — cannot capture parent for ${id}`);
          originals.push({ id, parentId: null });
          continue;
        }

        const res = await CBF_BRIDGE.getPath(id);
        const path = (res && Array.isArray(res.path)) ? res.path : [];

        const parentSeg = path.length >= 2
          ? path[path.length - 2]
          : null;

        originals.push({
          id,
          parentId: parentSeg ? parentSeg.id : null
        });

        log(`Captured: ${id} → parent=${parentSeg ? parentSeg.id : 'null'}`);
      } catch (e) {
        warn(`Cannot capture parent for ${id}: ${e.message}`);
        originals.push({ id, parentId: null });
      }
    }

    return originals;
  }

  // ============================================================
  //  M-5 + L-4: Post-rollback verification
  //
  //  Ελέγχει ότι κάθε item που ήταν στο `movedIds` βρίσκεται τώρα
  //  στον original parent του.
  //
  //  L-4 FIX: Διαχωρισμός failed vs skipped:
  //    - failed:  Πραγματικό mismatch (item σε λάθος parent)
  //    - skipped: Verify failure (getPath timeout, item deleted)
  //
  //  verified = (failed.length === 0)         ← actual correctness
  //  fullyVerified = (failed === 0 && skipped === 0)   ← strict
  //
  //  Rationale (L-4):
  //    Αν το verify αποτύχει (π.χ. timeout), ΔΕΝ σημαίνει ότι
  //    το rollback απέτυχε. Είναι "unknown", όχι "wrong".
  // ============================================================
  async function _verifyRollback(movedIds, originals) {
    if (!Array.isArray(movedIds) || movedIds.length === 0) {
      return {
        verified: true,
        fullyVerified: true,
        failed: [],
        skipped: []
      };
    }

    const failed = [];
    const skipped = [];

    for (const id of movedIds) {
      const orig = originals.find(o => o.id === id);

      // Skip: original parent unknown (δεν καταφέραμε να το capture-άρουμε)
      if (!orig || !orig.parentId) {
        skipped.push({ id, reason: 'NO_ORIGINAL_PARENT' });
        continue;
      }

      try {
        const res = await CBF_BRIDGE.getPath(id);
        const path = (res && Array.isArray(res.path)) ? res.path : [];
        const currentParentSeg = path.length >= 2
          ? path[path.length - 2]
          : null;
        const currentParent = currentParentSeg ? currentParentSeg.id : null;

        if (currentParent !== orig.parentId) {
          failed.push({
            id,
            expected: orig.parentId,
            actual: currentParent
          });
        }
      } catch (e) {
        warn(`Verify failed for ${id}: ${e.message}`);
        skipped.push({ id, reason: 'VERIFY_FAILED: ' + e.message });
      }
    }

    // L-4 FIX: verified = μόνο actual mismatches
    const verified = (failed.length === 0);
    const fullyVerified = (failed.length === 0 && skipped.length === 0);

    return { verified, fullyVerified, failed, skipped };
  }

  // ============================================================
  //  B-2 + M-5 + L-4: Rollback helper με verification
  //
  //  Επαναφέρει τα movedIds στους original parents τους.
  //  Σειρά: reverse (τελευταίο που μετακινήθηκε, πρώτο που επιστρέφει).
  // ============================================================
  async function _rollback(movedIds, originals, newParentId) {
    if (!Array.isArray(movedIds) || movedIds.length === 0) {
      return {
        verified: true,
        fullyVerified: true,
        failed: [],
        skipped: []
      };
    }

    warn(`Rolling back ${movedIds.length} item(s)`);

    const actuallyMovedBack = [];

    // Αντίστροφη σειρά — τελευταίο πρώτο
    for (let i = movedIds.length - 1; i >= 0; i--) {
      const mid = movedIds[i];
      const orig = originals.find(o => o.id === mid);

      if (!orig || !orig.parentId) {
        warn(`No original parent for ${mid} — cannot rollback`);
        continue;
      }

      // Skip: αν ήταν ήδη στον ίδιο parent
      if (orig.parentId === newParentId) {
        log(`Skip rollback for ${mid} (already in original parent)`);
        continue;
      }

      try {
        await CBF_BRIDGE.firefoxMove({
          id: mid,
          newParentId: orig.parentId,
          position: 'inside',
          targetId: null
        });
        log(`Rolled back: ${mid} → ${orig.parentId}`);
        actuallyMovedBack.push(mid);
      } catch (rbErr) {
        warn(`Rollback failed for ${mid}: ${rbErr.message}`);
      }
    }

    // M-5 + L-4: Post-rollback verification
    const verification = await _verifyRollback(movedIds, originals);

    if (!verification.verified) {
      warn('Rollback verification FAILED:', {
        failed: verification.failed.length,
        details: verification.failed
      });
      if (verification.skipped.length > 0) {
        warn('Additionally, verification skipped for:', {
          skipped: verification.skipped.length,
          details: verification.skipped
        });
      }
    } else if (!verification.fullyVerified) {
      // L-4: Verified, αλλά κάποια items δεν μπόρεσαν να επιβεβαιωθούν
      log('Rollback verified (with skipped entries)', {
        skipped: verification.skipped.length
      });
    } else {
      log('Rollback fully verified: all items back in original parents');
    }

    return verification;
  }

  // ============================================================
  //  moveSingleItem
  // ============================================================
  async function moveSingleItem(id, newParentId, position = 'inside', targetId = null) {
    if (!id) return { success: false, error: 'INVALID_ID' };
    if (!newParentId) return { success: false, error: 'INVALID_PARENT' };

    log(`moveSingleItem: ${id} → ${newParentId} (${position})`);

    if (!_hasBridge()) return _bridgeMissingError();

    try {
      const res = await CBF_BRIDGE.firefoxMove({
        id,
        newParentId,
        position,
        targetId
      });

      if (res && res.success) {
        return {
          success: true,
          result: res.result
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('moveSingleItem error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  moveMultipleItems
  //
  //  ΣΗΜΑΝΤΙΚΟ: Το Firefox D&D δεν υποστηρίζει native multi-move.
  //  Το κάνουμε σειριακά (μία-μία move).
  //
  //  B-2: Capture original parents πριν τα moves.
  //  C-1: before/after — lastMovedId tracking (σωστή σειρά).
  //  M-5 + L-4: Post-rollback verification με enriched error.
  // ============================================================
  async function moveMultipleItems(ids, newParentId, position = 'inside', targetId = null) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { success: false, error: 'INVALID_IDS' };
    }
    if (!newParentId) return { success: false, error: 'INVALID_PARENT' };

    log(`moveMultipleItems: [${ids.join(',')}] → ${newParentId} (${position})`);

    if (!_hasBridge()) return _bridgeMissingError();

    // B-2: Capture original parents ΠΡΙΝ από τα moves
    const originals = await _captureOriginalParents(ids);

    const movedIds = [];

    /**
     * Helper: εκτελεί rollback + επιστρέφει enriched error result.
     *
     * M-5 + L-4:
     *   - rollbackVerified:      no actual mismatches
     *   - rollbackFullyVerified: no mismatches + no skipped
     *   - rollbackIncomplete:    actual mismatches (error)
     *   - rollbackUnverified:    verified αλλά με skipped (warning)
     */
    async function _failWithRollback(errorMsg, extra = {}) {
      const verification = await _rollback(movedIds, originals, newParentId);

      const result = {
        success: false,
        error: errorMsg,
        rollbackAttempted: true,
        rollbackVerified: verification.verified,
        rollbackFullyVerified: verification.fullyVerified,
        ...extra
      };

      if (!verification.verified) {
        // Actual failure
        result.rollbackIncomplete = true;
        result.rollbackDetails = {
          failed: verification.failed,
          skipped: verification.skipped
        };
        result.error = errorMsg + ' (rollback incomplete)';
      } else if (!verification.fullyVerified) {
        // L-4: Verified αλλά με skipped
        result.rollbackUnverified = true;
        result.rollbackDetails = {
          skipped: verification.skipped
        };
        // ΔΕΝ προσθέτουμε "(rollback incomplete)" γιατί verified = true
      }

      return result;
    }

    try {
      // Case 1: position = 'inside' (append all)
      if (position === 'inside') {
        for (const id of ids) {
          const res = await CBF_BRIDGE.firefoxMove({
            id,
            newParentId,
            position: 'inside',
            targetId: null
          });

          if (!res || !res.success) {
            return await _failWithRollback(
              res?.error || 'MOVE_FAILED',
              { failedAt: id, movedCount: movedIds.length }
            );
          }
          movedIds.push(id);
        }

        return { success: true, result: { movedCount: ids.length } };
      }

      // Case 2: position = 'before'/'after'
      //
      //  C-1 FIX:
      //    ΠΡΙΝ (buggy): Όλα τα επόμενα → 'after' firstId
      //                  [A, B, C] → [A, C, B]  ← ΑΝΤΙΣΤΡΟΦΗ
      //
      //    ΜΕΤΑ (correct): lastMovedId tracking
      //                  Move A → [A]
      //                  Move B 'after' A → [A, B]
      //                  Move C 'after' B → [A, B, C]  ← ΣΩΣΤΟ
      const firstId = ids[0];
      const firstRes = await CBF_BRIDGE.firefoxMove({
        id: firstId,
        newParentId,
        position,
        targetId
      });

      if (!firstRes || !firstRes.success) {
        // ΔΕΝ χρειάζεται rollback — δεν έχει γίνει καμία αλλαγή
        return { success: false, error: firstRes?.error || 'MOVE_FAILED' };
      }
      movedIds.push(firstId);

      // C-1 FIX: track the last moved item
      let lastMovedId = firstId;

      // Rest: 'after' lastMovedId (chain)
      for (let i = 1; i < ids.length; i++) {
        const id = ids[i];
        const res = await CBF_BRIDGE.firefoxMove({
          id,
          newParentId,
          position: 'after',
          targetId: lastMovedId   // ← C-1 FIX (ήταν firstId)
        });

        if (!res || !res.success) {
          return await _failWithRollback(
            res?.error || 'MOVE_FAILED',
            { failedAt: id, movedCount: movedIds.length }
          );
        }
        movedIds.push(id);
        lastMovedId = id;   // ← C-1 FIX: update για επόμενο iteration
      }

      return { success: true, result: { movedCount: ids.length } };
    } catch (e) {
      warn('moveMultipleItems error:', e.message);
      // B-2 + M-5 + L-4: rollback σε exception
      return await _failWithRollback(e.message, { code: e.code });
    }
  }

  // ============================================================
  //  reorderItem (same parent)
  //
  //  Single operation — δεν χρειάζεται rollback.
  // ============================================================
  async function reorderItem(id, targetId, position) {
    if (!id) return { success: false, error: 'INVALID_ID' };
    if (!targetId) return { success: false, error: 'INVALID_TARGET' };
    if (position !== 'before' && position !== 'after') {
      return { success: false, error: 'INVALID_POSITION' };
    }

    log(`reorderItem: ${id} ${position} ${targetId}`);

    if (!_hasBridge()) return _bridgeMissingError();

    try {
      const res = await CBF_BRIDGE.firefoxReorder({
        id,
        targetId,
        position
      });

      if (res && res.success) {
        return {
          success: true,
          result: res.result
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('reorderItem error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    moveSingleItem,
    moveMultipleItems,
    reorderItem,

    _internal: {
      _hasBridge,
      _captureOriginalParents,
      _rollback,
      _verifyRollback     // M-5 + L-4: exposed για tests
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_FIREFOX_REDISTRIBUTION = api;
  if (typeof self !== 'undefined') self.CBF_FIREFOX_REDISTRIBUTION = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FIREFOX_REDISTRIBUTION = api;

  log('Ready (v12E: B-2 original parent rollback + M-5 verification + C-1 order fix + L-4 verify semantics)');
  return api;
})();