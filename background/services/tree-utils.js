/**
 * tree-utils.js — Tree utilities (pure functions)
 *
 * @path     background/services/tree-utils.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Pure helpers για tree operations:
 *     • getSubtreeIds()        — BFS subtree IDs
 *     • isDescendant()         — cycle-safe descendant check
 *     • getPath()              — [{id, title}, ...] root→node
 *     • validateMove()         — cycle + root + target checks
 *     • normalizeSelection()   — top-level only (αφαιρεί descendants)
 *     • findNeighbors()        — prev/next positionKey για insert
 *
 *   Όλα τα helpers είναι pure (no IO, no crypto, no IDB).
 *   Φορτώνεται μετά τον logger.
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "tree-utils"
 */

var CBF_TREE = (function() {
  // ============================================================
  //  Λαμβάνει το snapshot Map<id, node> από το projection
  // ============================================================
  function getItemsMap() {
    // Πρόσβαση στο εσωτερικό Map του projection (read-only χρήση)
    if (typeof CBF_PROJECTION === 'undefined') return new Map();
    // Το projection δεν εκθέτει το Map, οπότε το φτιάχνουμε προσωρινά
    const map = new Map();
    const stats = CBF_PROJECTION.getStats();
    if (!stats.ready) return map;
    // Θα προσθέσουμε στο projection μια μέθοδο getItemsMap
    // (βλ. επόμενη ενημέρωση projection-manager)
    return CBF_PROJECTION.getItemsMap ? CBF_PROJECTION.getItemsMap() : map;
  }

  // ============================================================
  //  Subtree – επιστρέφει Set<id> με root + όλους τους απογόνους
  // ============================================================
  function getSubtreeIds(itemsMap, rootId) {
    const result = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const [id, node] of itemsMap) {
        if (node.parentId === current && !result.has(id)) {
          result.add(id);
          queue.push(id);
        }
      }
    }
    return result;
  }

  // ============================================================
  //  Cycle detection – είναι ο nodeId απόγονος του ancestorId;
  // ============================================================
  function isDescendant(itemsMap, ancestorId, nodeId) {
    if (ancestorId === nodeId) return true;
    let current = itemsMap.get(nodeId);
    const visited = new Set();
    while (current && current.parentId) {
      if (visited.has(current.parentId)) return false; // ασφάλεια
      visited.add(current.id);
      if (current.parentId === ancestorId) return true;
      current = itemsMap.get(current.parentId);
    }
    return false;
  }

  // ============================================================
  //  Path – επιστρέφει [{id, title}, ...] από root προς id
  // ============================================================
  function getPath(itemsMap, id, rootId) {
    const path = [];
    let current = itemsMap.get(id);
    const visited = new Set();
    while (current) {
      path.unshift({ id: current.id, title: current.title || '' });
      if (current.id === rootId) break;
      if (!current.parentId) break;
      if (visited.has(current.id)) break; // ασφάλεια
      visited.add(current.id);
      current = itemsMap.get(current.parentId);
    }
    return path;
  }

  // ============================================================
  //  Validation για move
  //  Επιστρέφει { ok: true } ή { ok: false, error: '...' }
  // ============================================================
  function validateMove(itemsMap, movingIds, newParentId, rootId) {
    if (!Array.isArray(movingIds) || movingIds.length === 0) {
      return { ok: false, error: 'movingIds must be non-empty array' };
    }
    if (new Set(movingIds).size !== movingIds.length) {
      return { ok: false, error: 'Duplicate ids in movingIds' };
    }

    const target = itemsMap.get(newParentId);
    if (!target) return { ok: false, error: 'Target folder not found' };
    if (target.type !== 'folder') return { ok: false, error: 'Target is not a folder' };

    // Δεν μπορούμε να μετακινήσουμε root
    if (movingIds.includes(rootId)) {
      return { ok: false, error: 'Cannot move root' };
    }

    // Το targetId δεν μπορεί να είναι μέσα στα movingIds
    if (movingIds.includes(newParentId)) {
      return { ok: false, error: 'Cannot move node into itself' };
    }

    // Δεν επιτρέπονται κύκλοι: το newParentId δεν μπορεί να είναι απόγονος κάποιου movingId
    for (const mid of movingIds) {
      if (isDescendant(itemsMap, mid, newParentId)) {
        return { ok: false, error: 'Cannot move node into its own descendant' };
      }
    }

    return { ok: true };
  }

  // ============================================================
  //  Canonicalization πολλαπλής επιλογής
  //  Κρατάει μόνο τα top-level nodes (αφαιρεί τα descendants)
  // ============================================================
  function normalizeSelection(itemsMap, ids) {
    const set = new Set(ids);
    const result = [];
    for (const id of ids) {
      let current = itemsMap.get(id);
      let isNested = false;
      const visited = new Set();
      while (current && current.parentId) {
        if (visited.has(current.parentId)) break;
        visited.add(current.id);
        if (set.has(current.parentId)) {
          isNested = true;
          break;
        }
        current = itemsMap.get(current.parentId);
      }
      if (!isNested) result.push(id);
    }
    return result;
  }

  // ============================================================
  //  Neighbors – βρίσκει prev & next positionKey για insert
  //  insertAfterId = null → στην αρχή
  // ============================================================
  function findNeighbors(itemsMap, parentId, insertAfterId) {
    const children = [];
    for (const node of itemsMap.values()) {
      if (node.parentId === parentId) children.push(node);
    }
    children.sort((a, b) => {
      const pa = BigInt(a.positionKey || '0');
      const pb = BigInt(b.positionKey || '0');
      if (pa < pb) return -1;
      if (pa > pb) return 1;
      return a.id < b.id ? -1 : 1;
    });

    if (insertAfterId === null) {
      return {
        prev: null,
        next: children.length > 0 ? children[0].positionKey : null
      };
    }

    const idx = children.findIndex(c => c.id === insertAfterId);
    if (idx === -1) {
      // δεν βρέθηκε – βάλε στο τέλος
      return {
        prev: children.length > 0 ? children[children.length - 1].positionKey : null,
        next: null
      };
    }
    return {
      prev: children[idx].positionKey,
      next: idx + 1 < children.length ? children[idx + 1].positionKey : null
    };
  }

  const api = { getSubtreeIds, isDescendant, getPath, validateMove, normalizeSelection, findNeighbors };
  if (typeof self !== 'undefined') self.CBF_TREE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_TREE = api;
  if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('Tree Utils ready');
  return api;
})();