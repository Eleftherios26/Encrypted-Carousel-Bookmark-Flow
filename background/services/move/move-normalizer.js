/**
 * move-normalizer.js — Move normalizer (pure)
 *
 * @path     background/services/move/move-normalizer.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Καθαρίζει τα movingIds: κρατάει μόνο τα top-level nodes
 *   (αφαιρεί descendants που είναι ήδη μέσα σε άλλο moving node).
 *   Επιστρέφει ταξινομημένα κατά positionKey.
 *
 *   Καθαρή συνάρτηση — χωρίς IO, χωρίς crypto, χωρίς IDB.
 *
 * DECISIONS
 *   (architecture §8.5 — normalizeMove alias)
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "move-normalizer"
 */

var CBF_MOVE_NORMALIZER = (function() {

  /**
   * @param {Map} itemsMap — decrypted items
   * @param {string[]} movingIds — raw selected ids
   * @returns {{ok: true, ids: string[]} | {ok: false, error: string}}
   */
  function normalize(itemsMap, movingIds) {
    if (!Array.isArray(movingIds)) {
      return { ok: false, error: 'movingIds must be array' };
    }

    const set = new Set(movingIds);
    const ids = Array.from(set);

    const topLevel = [];
    for (const id of ids) {
      if (!itemsMap.has(id)) {
        return { ok: false, error: `Unknown id: ${id}` };
      }
      if (!_hasAncestorInSet(itemsMap, id, set)) {
        topLevel.push(id);
      }
    }

    if (topLevel.length === 0) {
      return { ok: false, error: 'No top-level nodes in selection' };
    }

    topLevel.sort((a, b) => {
      const na = itemsMap.get(a);
      const nb = itemsMap.get(b);
      return CBF_POSKEYS.compareNodes(na, nb);
    });

    return { ok: true, ids: topLevel };
  }

  // Cycle-safe: visited Set αποτρέπει infinite loop σε corrupted state
  function _hasAncestorInSet(itemsMap, id, idSet) {
    let cur = itemsMap.get(id);
    const visited = new Set();
    while (cur && cur.parentId) {
      if (visited.has(cur.id)) return false;
      visited.add(cur.id);
      if (idSet.has(cur.parentId)) return true;
      cur = itemsMap.get(cur.parentId);
    }
    return false;
  }

  // Architecture §8.5 alias
  const normalizeMove = normalize;

  const api = { normalize, normalizeMove };

  if (typeof self !== 'undefined') self.CBF_MOVE_NORMALIZER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MOVE_NORMALIZER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Move Normalizer ready');
  }

  return api;
})();