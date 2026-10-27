/**
 * move-validator.js — Move validators (pure)
 *
 * @path     background/services/move/move-validator.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Pure validators για move/reorder operations:
 *     • validateMove()             — cycle + root + target checks
 *     • validateReorder()          — sibling check
 *     • validateTreeInvariants()   — full tree integrity (tests/recovery)
 *
 *   Καθαρές συναρτήσεις — χωρίς IO, χωρίς crypto, χωρίς IDB.
 *
 * DECISIONS
 *   (architecture §8.5 — validateTreeInvariants pure helper)
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "move-validator"
 */

var CBF_MOVE_VALIDATOR = (function() {

  // ============================================================
  //  Move
  // ============================================================
  function validateMove(itemsMap, movingIds, newParentId, rootId) {
    if (!Array.isArray(movingIds) || movingIds.length === 0) {
      return { ok: false, error: 'movingIds must be non-empty array' };
    }

    if (new Set(movingIds).size !== movingIds.length) {
      return { ok: false, error: 'Duplicate ids in movingIds' };
    }

    if (movingIds.includes(rootId)) {
      return { ok: false, error: 'Cannot move root' };
    }

    const target = itemsMap.get(newParentId);
    if (!target) return { ok: false, error: 'Target folder not found' };
    if (target.type !== 'folder') return { ok: false, error: 'Target is not a folder' };

    for (const mid of movingIds) {
      if (mid === newParentId) {
        return { ok: false, error: 'Cannot move node into itself' };
      }
    }

    for (const mid of movingIds) {
      if (_isDescendant(itemsMap, mid, newParentId)) {
        return { ok: false, error: 'Cannot move node into its own descendant' };
      }
    }

    return { ok: true };
  }

  // ============================================================
  //  Reorder
  // ============================================================
  function validateReorder(itemsMap, id, targetId, rootId) {
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: 'id required' };
    }
    if (id === rootId) {
      return { ok: false, error: 'Cannot reorder root' };
    }

    const node = itemsMap.get(id);
    if (!node) return { ok: false, error: 'Record not found' };

    const target = itemsMap.get(targetId);
    if (!target) return { ok: false, error: 'Target not found' };

    if (target.parentId !== node.parentId) {
      return {
        ok: false,
        error: 'Target is not a sibling (reorder requires same parent)'
      };
    }

    return { ok: true };
  }

  // ============================================================
  //  Tree invariants (architecture §8.5)
  //
  //  Ελέγχει:
  //    1. Root υπάρχει και έχει parentId === null
  //    2. Κάθε non-root node έχει έγκυρο parentId που υπάρχει
  //    3. Δεν υπάρχουν κύκλοι
  //    4. Δεν υπάρχουν duplicate positionKeys κάτω από τον ίδιο parent
  //
  //  Επιστρέφει { ok: true } ή { ok: false, errors: [...] }.
  //  Χρήσιμο για tests, recovery, integrity verification.
  // ============================================================
  function validateTreeInvariants(itemsMap, rootId) {
    const errors = [];

    if (!(itemsMap instanceof Map)) {
      return { ok: false, errors: ['itemsMap must be a Map'] };
    }

    // ---------- 1. Root ----------
    const root = itemsMap.get(rootId);
    if (!root) {
      errors.push(`Root "${rootId}" not found`);
    } else if (root.parentId !== null && root.parentId !== undefined) {
      errors.push(`Root has non-null parentId: ${root.parentId}`);
    }

    // ---------- 2. Every non-root has valid parent ----------
    for (const [id, node] of itemsMap) {
      if (id === rootId) continue;
      if (!node.parentId) {
        errors.push(`Node ${id} has no parentId`);
        continue;
      }
      if (!itemsMap.has(node.parentId)) {
        errors.push(`Node ${id} references missing parent ${node.parentId}`);
      }
    }

    // ---------- 3. No cycles ----------
    for (const [id] of itemsMap) {
      const visited = new Set();
      let cur = itemsMap.get(id);
      while (cur && cur.parentId) {
        if (visited.has(cur.id)) {
          errors.push(`Cycle detected involving ${cur.id}`);
          break;
        }
        visited.add(cur.id);
        cur = itemsMap.get(cur.parentId);
      }
    }

    // ---------- 4. Unique positionKey per parent ----------
    const byParent = new Map();
    for (const node of itemsMap.values()) {
      const key = node.parentId ?? '__root__';
      if (!byParent.has(key)) byParent.set(key, new Set());
      const pKey = node.positionKey ?? '';
      const set = byParent.get(key);
      if (set.has(pKey)) {
        errors.push(`Duplicate positionKey "${pKey}" under parent ${key}`);
      }
      set.add(pKey);
    }

    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }

  // ============================================================
  //  Helper — cycle-safe descendant check
  // ============================================================
  function _isDescendant(itemsMap, ancestorId, candidateId) {
    if (ancestorId === candidateId) return true;
    let cur = itemsMap.get(candidateId);
    const visited = new Set();
    while (cur && cur.parentId) {
      if (visited.has(cur.id)) return false;
      visited.add(cur.id);
      if (cur.parentId === ancestorId) return true;
      cur = itemsMap.get(cur.parentId);
    }
    return false;
  }

  const api = { validateMove, validateReorder, validateTreeInvariants };

  if (typeof self !== 'undefined') self.CBF_MOVE_VALIDATOR = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MOVE_VALIDATOR = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Move Validator ready (+validateTreeInvariants)');
  }

  return api;
})();