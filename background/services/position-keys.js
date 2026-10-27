/**
 * position-keys.js — Position key helpers (pure)
 *
 * @path     background/services/position-keys.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Position keys ως BigInt εσωτερικά, zero-padded decimal string στην
 *   αποθήκευση (POSITION_PAD = 40). Παρέχει helpers για sorting,
 *   neighbor lookup, position computation, και rebalance.
 *
 * KEY CONCEPTS
 *   • POSITION_STEP = 1e9 — gap μεταξύ siblings
 *   • POSITION_PAD = 40 — zero-padding για lexicographic sort
 *   • MAX_CHILDREN = 100000 — όριο per parent
 *   • POSITION_KEY_MAX = 10^40 - 1 — max key value
 *
 * API
 *   • toStored(bigint) / fromStored(str)
 *   • validateChildrenCount(count)
 *   • computePositionBetween(prev, next)  — BigInt | null
 *   • compareNodes(a, b)                  — sort comparator
 *   • findNeighborsInSorted(siblings, insertAfterId)
 *   • computeRebalance(sortedSiblings)
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "position-keys"
 */

var CBF_POSKEYS = (function() {
  const POSITION_STEP = 1000000000n;                            // 1e9
  const POSITION_PAD = 40;
  const MAX_CHILDREN = 100000;                                  // όριο per parent
  const POSITION_KEY_MAX = BigInt('9'.repeat(POSITION_PAD));    // 10^40 - 1

  // ============================================================
  //  Store <-> BigInt
  // ============================================================
  function toStored(bigintVal) {
    if (typeof bigintVal !== 'bigint') {
      throw new Error('toStored: bigint required');
    }
    if (bigintVal < 0n) throw new Error('toStored: negative position');
    if (bigintVal > POSITION_KEY_MAX) {
      throw new Error('toStored: POSITION_KEY_MAX exceeded');
    }
    return bigintVal.toString().padStart(POSITION_PAD, '0');
  }

  function fromStored(str) {
    if (typeof str !== 'string' || str.length === 0) return 0n;
    try { return BigInt(str); } catch { return 0n; }
  }

  // ============================================================
  //  Children count validation
  //  Επιστρέφει { ok: true } ή { ok: false, error: '...' }
  //
  //  Worst case: όλα τα children παίρνουν (i+1)*STEP,
  //  άρα max key = count * STEP.
  // ============================================================
  function validateChildrenCount(count) {
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return { ok: false, error: 'count must be a non-negative integer' };
    }
    if (count > MAX_CHILDREN) {
      return {
        ok: false,
        error: `MAX_CHILDREN exceeded (${count} > ${MAX_CHILDREN})`
      };
    }
    const maxKey = BigInt(count) * POSITION_STEP;
    if (maxKey > POSITION_KEY_MAX) {
      return {
        ok: false,
        error: `POSITION_KEY_MAX would be exceeded (${maxKey} > ${POSITION_KEY_MAX})`
      };
    }
    return { ok: true };
  }

  // ============================================================
  //  Compute position between two keys
  //  Επιστρέφει BigInt ή null (αν δεν υπάρχει χώρος → rebalance)
  // ============================================================
  function computePositionBetween(prevStored, nextStored) {
    const p = prevStored === null || prevStored === undefined
      ? null : fromStored(prevStored);
    const n = nextStored === null || nextStored === undefined
      ? null : fromStored(nextStored);

    if (p === null && n === null) return POSITION_STEP;
    if (p === null) {
      if (n <= 1n) return null;
      return n / 2n;
    }
    if (n === null) {
      const candidate = p + POSITION_STEP;
      if (candidate > POSITION_KEY_MAX) return null;
      return candidate;
    }
    if (n - p <= 1n) return null;
    return (p + n) / 2n;
  }

  // ============================================================
  //  Sorting
  // ============================================================
  function compareNodes(a, b) {
    const pa = fromStored(a.positionKey);
    const pb = fromStored(b.positionKey);
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  // ============================================================
  //  Find neighbors in a sorted siblings array
  //    insertAfterId === null → στην αρχή
  //    insertAfterId === id   → μετά από αυτό
  //    αν το id δεν βρεθεί → στο τέλος
  //
  //  Επιστρέφει { prev, next } ως stored positionKey strings (ή null)
  // ============================================================
  function findNeighborsInSorted(sortedSiblings, insertAfterId) {
    if (sortedSiblings.length === 0) {
      return { prev: null, next: null };
    }

    if (insertAfterId === null || insertAfterId === undefined) {
      return { prev: null, next: sortedSiblings[0].positionKey };
    }

    const idx = sortedSiblings.findIndex(s => s.id === insertAfterId);
    if (idx === -1) {
      return {
        prev: sortedSiblings[sortedSiblings.length - 1].positionKey,
        next: null
      };
    }

    return {
      prev: sortedSiblings[idx].positionKey,
      next: idx + 1 < sortedSiblings.length
        ? sortedSiblings[idx + 1].positionKey
        : null
    };
  }

  // ============================================================
  //  Rebalance
  //  Επιστρέφει array από { id, newPositionKey } για όλα τα siblings.
  //  Το πρώτο παίρνει STEP, δεύτερο 2*STEP, κ.λπ.
  // ============================================================
  function computeRebalance(sortedSiblings) {
    const out = [];
    let step = POSITION_STEP;
    for (const sib of sortedSiblings) {
      if (step > POSITION_KEY_MAX) {
        throw new Error('computeRebalance: POSITION_KEY_MAX exceeded');
      }
      out.push({ id: sib.id, newPositionKey: toStored(step) });
      step += POSITION_STEP;
    }
    return out;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    POSITION_STEP,
    POSITION_PAD,
    MAX_CHILDREN,
    POSITION_KEY_MAX,

    toStored,
    fromStored,
    validateChildrenCount,
    computePositionBetween,
    compareNodes,
    findNeighborsInSorted,
    computeRebalance
  };

  if (typeof self !== 'undefined') self.CBF_POSKEYS = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_POSKEYS = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Position Keys ready (MAX_CHILDREN=' + MAX_CHILDREN + ')');
  }

  return api;
})();