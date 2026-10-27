/**
 * merge-handler.js — Merge 2 bookmarks into new folder
 *
 * @path     background/services/mutations/merge-handler.js
 * @version  12.3.1
 * @since    v12E / v12.3.1
 *
 * PURPOSE
 *   Sequencer handler για merge 2 bookmarks σε νέο φάκελο. Το merge
 *   είναι σημασιολογικά «2 bookmarks → νέος φάκελος» στον encrypted
 *   space, με τους δύο bookmarks να μετακινούνται μέσα.
 *
 * FLOW
 *   1. Validate (item1Id ≠ item2Id, folderName, parentId)
 *   2. Read state + meta
 *   3. Parent check (must be folder)
 *   4. Item1 + item2 check (both must be bookmarks, not root, not corrupted)
 *   5. C3-SEC-01: Server-side type check
 *   6. C3-SEC-02a: Direct cycle check
 *   7. C3-SEC-02b: Descendant cycle check (defense-in-depth)
 *   8. Compute new folder position (append στο τέλος)
 *   9. Create new folder + re-encrypt items με νέο parentId
 *  10. Update Merkle (newFolder + item1 + item2 affected)
 *  11. New generation (+1)
 *  12. New meta (recordCount +1)
 *  13. New state (stateMAC)
 *  14. Return PreparedMutation
 *
 * NON-OBVIOUS
 *   • C3-SEC-01: Ο client (merge.js::canMergeBookmarks) ΚΑΝΕΙ type
 *     check, αλλά ο server ΔΕΝ πρέπει να βασίζεται στον client
 *     (Invariant #9: Αυστηρός Έλεγχος Εισόδου).
 *   • C3-SEC-02a: Direct cycle check (parentId ∈ {item1Id, item2Id}).
 *     Μετά τον type check είναι τεχνικά redundant (bookmarks δεν
 *     έχουν children), αλλά κρατιέται ως fail-safe.
 *   • C3-SEC-02b: Descendant cycle check (defense-in-depth έναντι
 *     corrupted state).
 *   • Item positions: item1 → STEP, item2 → 2*STEP (order preserved).
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.1 (2026-10-19) — CRITICAL FIX: Merkle commitmentRoot mismatch
 *   ══════════════════════════════════════════════════════════════════════
 *   🐛 BUG (CRITICAL): Το affectedForMerkle ΔΕΝ περιλάμβανε τα
 *   rebalanceWrites.
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Όταν το computePositionBetween(lastSibling.positionKey, null)
 *       επέστρεφε null (δεν υπάρχει χώρος για νέο folder), ο handler
 *       έκανε rebalance — δηλαδή υπολόγιζε ΝΕΑ positionKeys για όλα
 *       τα siblings του parentId και τα έγραφε στο IDB μέσω των
 *       rebalanceWrites.
 *
 *       ΑΛΛΑ:
 *         const affectedForMerkle = [newFolderRecord, item1Updated, item2Updated].map(...)
 *                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                                     ΛΕΙΠΟΥΝ τα rebalanceWrites
 *
 *       Το updateMerkle() διαβάζει τα records από το IDB (ΠΑΛΙΑ
 *       positionKeys) και προσθέτει μόνο τα 3 affected. Άρα το
 *       commitmentRoot υπολογιζόταν με:
 *         [sib1: OLD_pos, sib2: OLD_pos, ..., newFolder, item1, item2]
 *
 *       Ενώ στο IDB γράφονταν:
 *         [sib1: NEW_pos, sib2: NEW_pos, ..., newFolder, item1, item2]
 *
 *     ΣΥΝΕΠΕΙΑ (από logs):
 *       Στο επόμενο unlock:
 *         [ES] VAULT_MERKLE_MISMATCH: Merkle root mismatch —
 *              stored=nbsaUQqqjIxRVLHO..., fresh=8WdR9YJAlbz5zF7n...
 *         → fail-closed (H-01) → "wrong password" στον χρήστη
 *
 *       Μία μόνο rebalance αρκεί για να σπάσει το vault για πάντα.
 *
 *     ΛΥΣΗ:
 *       Συμπεριλαμβάνουμε τα rebalanceWrites:
 *         const affectedForMerkle = [
 *           ...rebalanceWrites,
 *           newFolderRecord,
 *           item1Updated,
 *           item2Updated
 *         ].map(...)
 *
 *     CONSISTENCY:
 *       Ίδιο pattern με move-executor.js (το οποίο είναι ΣΩΣΤΟ):
 *         const affectedForMerkle = finalWrites.map(...)
 *         // όπου finalWrites = rebalanceWrites + moves
 *
 *     IMPACT:
 *       • ✅ Διορθώνει το bug οριστικά (μελλοντικά merges)
 *       • ✅ Δεν επηρεάζει υπάρχοντα vaults (μόνο νέα mutations)
 *       • ✅ Για ήδη σπασμένα vaults → auto-recovery στο unlock
 *          (βλ. encrypted-space.js v12.3.1)
 *       • ✅ Zero regression (ίδιο interface, ίδιο PreparedMutation)
 *
 *   v12.0.0 — Initial release (C3-SEC-01/02 fixes)
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "merge-handler"
 */

var CBF_MUTATION_MERGE = (function() {
  'use strict';

  const MAX_TITLE_LENGTH = 500;
  const ROOT_ID = 'ecbf-root';

  // ============================================================
  //  C3-SEC-02: Local descendant helper
  //
  //  Self-contained (no namespace collision με:
  //    - CBF_TREE.isDescendant        (tree-utils.js)
  //    - _isDescendantOf              (firefox-dnd-service.js)
  //    - _hasAncestorInSet            (move-normalizer.js)
  //  )
  //
  //  Cycle-safe: visited Set αποτρέπει infinite loop σε corrupted state.
  // ============================================================
  function _isDescendantInMap(itemsMap, ancestorId, candidateId) {
    if (!ancestorId || !candidateId) return false;
    if (ancestorId === candidateId) return true;

    let cur = itemsMap.get(candidateId);
    const visited = new Set();

    while (cur && cur.parentId) {
      if (visited.has(cur.id)) {
        // Cycle detected σε corrupted state — fail-safe
        return false;
      }
      visited.add(cur.id);

      if (cur.parentId === ancestorId) return true;
      cur = itemsMap.get(cur.parentId);
    }

    return false;
  }

  // ============================================================
  //  Validation
  // ============================================================
  function _validatePayload(payload) {
    const p = payload || {};

    if (typeof p.item1Id !== 'string' || p.item1Id.length === 0) {
      throw new Error('merge: item1Id required');
    }
    if (typeof p.item2Id !== 'string' || p.item2Id.length === 0) {
      throw new Error('merge: item2Id required');
    }
    if (p.item1Id === p.item2Id) {
      throw new Error('merge: item1Id and item2Id must be different');
    }
    if (typeof p.folderName !== 'string' || p.folderName.trim().length === 0) {
      throw new Error('merge: folderName must be non-empty string');
    }
    if (p.folderName.length > MAX_TITLE_LENGTH) {
      throw new Error('merge: folderName too long');
    }
    if (typeof p.parentId !== 'string' || p.parentId.length === 0) {
      throw new Error('merge: parentId required');
    }
  }

  // ============================================================
  //  prepare(payload, ctx) → PreparedMutation
  // ============================================================
  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { item1Id, item2Id, folderName, parentId } = payload;

    // ---------- 1. Read state + meta ----------
    const state = await ctx.readState();
    if (!state) throw new Error('merge: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('merge: vault meta not found');

    // ---------- 2. Parent check ----------
    const parent = await ctx.readRecord(parentId);
    if (!parent) throw new Error('merge: parent not found');
    if (parent._corrupted) throw new Error('merge: parent record is corrupted');
    if (parent.type !== 'folder') throw new Error('merge: parent is not a folder');

    // ---------- 3. Items check ----------
    const item1 = await ctx.readRecord(item1Id);
    if (!item1) throw new Error('merge: item1 not found');
    if (item1._corrupted) throw new Error('merge: item1 is corrupted');
    if (item1Id === ROOT_ID) throw new Error('merge: cannot merge root');

    const item2 = await ctx.readRecord(item2Id);
    if (!item2) throw new Error('merge: item2 not found');
    if (item2._corrupted) throw new Error('merge: item2 is corrupted');
    if (item2Id === ROOT_ID) throw new Error('merge: cannot merge root');

    // ---------- 4. C3-SEC-01: Server-side type check ----------
    //  Defense-in-depth έναντι compromised overlay.
    //  Αν item1 είναι folder, τότε το move του item1 στον νέο φάκελο
    //  (που βρίσκεται μέσα στο item1) δημιουργεί cycle.
    if (item1.type !== 'bookmark') {
      throw new Error('merge: item1 must be a bookmark (got ' + item1.type + ')');
    }
    if (item2.type !== 'bookmark') {
      throw new Error('merge: item2 must be a bookmark (got ' + item2.type + ')');
    }

    // ---------- 5. C3-SEC-02a: Direct cycle check ----------
    if (parentId === item1Id || parentId === item2Id) {
      throw new Error('merge: parentId cannot be item1 or item2');
    }

    // ---------- 6. C3-SEC-02b: Descendant cycle check ----------
    const allRecords = await ctx.readAllRecords();
    const itemsMap = new Map();
    for (const r of allRecords) {
      if (!r._corrupted) itemsMap.set(r.id, r);
    }

    if (_isDescendantInMap(itemsMap, item1Id, parentId)) {
      throw new Error('merge: parentId is a descendant of item1');
    }
    if (_isDescendantInMap(itemsMap, item2Id, parentId)) {
      throw new Error('merge: parentId is a descendant of item2');
    }

    // ---------- 7. Siblings of parent ----------
    const siblings = await ctx.readChildren(parentId);
    siblings.sort(CBF_POSKEYS.compareNodes);

    const check = CBF_POSKEYS.validateChildrenCount(siblings.length + 1);
    if (!check.ok) {
      throw new Error('merge: ' + check.error);
    }

    // ---------- 8. Υπολογισμός θέσης νέου φακέλου (στο τέλος) ----------
    const lastSibling = siblings.length > 0 ? siblings[siblings.length - 1] : null;
    const prevKey = lastSibling ? lastSibling.positionKey : null;
    let newFolderPosBig = CBF_POSKEYS.computePositionBetween(prevKey, null);
    const rebalanceWrites = [];

    if (newFolderPosBig === null) {
      // Rebalance needed
      const rebalanced = CBF_POSKEYS.computeRebalance(siblings);
      const rebalanceMap = new Map(rebalanced.map(r => [r.id, r.newPositionKey]));

      for (const sib of siblings) {
        const newKey = rebalanceMap.get(sib.id);
        if (newKey === sib.positionKey) continue;

        const enc = await ctx.buildRecord({
          id: sib.id,
          parentId: sib.parentId,
          positionKey: newKey,
          type: sib.type,
          title: sib.title,
          url: sib.url
        });
        rebalanceWrites.push(enc);
      }

      const rebalancedSiblings = siblings.map(s => ({
        ...s,
        positionKey: rebalanceMap.get(s.id)
      }));
      rebalancedSiblings.sort(CBF_POSKEYS.compareNodes);

      const lastR = rebalancedSiblings[rebalancedSiblings.length - 1];
      newFolderPosBig = CBF_POSKEYS.computePositionBetween(lastR.positionKey, null);
      if (newFolderPosBig === null) {
        throw new Error('merge: rebalance failed to create space');
      }
    }

    const newFolderPositionKey = CBF_POSKEYS.toStored(newFolderPosBig);

    // ---------- 9. Δημιουργία νέου φακέλου ----------
    const newFolderId = crypto.randomUUID();
    const newFolderRecord = await ctx.buildRecord({
      id: newFolderId,
      parentId,
      positionKey: newFolderPositionKey,
      type: 'folder',
      title: folderName.trim(),
      url: null
    });

    // ---------- 10. Re-encrypt item1 + item2 με νέο parentId ----------
    //  Preserve order: item1 → STEP, item2 → 2*STEP
    const item1NewPosKey = CBF_POSKEYS.toStored(CBF_POSKEYS.POSITION_STEP);
    const item2NewPosKey = CBF_POSKEYS.toStored(2n * CBF_POSKEYS.POSITION_STEP);

    const item1Updated = await ctx.buildRecord({
      id: item1.id,
      parentId: newFolderId,
      positionKey: item1NewPosKey,
      type: item1.type,
      title: item1.title,
      url: item1.url
    });

    const item2Updated = await ctx.buildRecord({
      id: item2.id,
      parentId: newFolderId,
      positionKey: item2NewPosKey,
      type: item2.type,
      title: item2.title,
      url: item2.url
    });

    // ---------- 11. Update Merkle ----------
    // ═══════════════════════════════════════════════════════════
    //  🐛 FIX v12.3.1 (CRITICAL): Περιλαμβάνουμε τα rebalanceWrites.
    //
    //  ΠΡΙΝ (v12.0.0 - v12.3.0):
    //    const affectedForMerkle = [newFolderRecord, item1Updated, item2Updated].map(...)
    //    → Το commitmentRoot υπολογιζόταν με τα ΠΑΛΙΑ positionKeys
    //      των rebalanced siblings.
    //    → VAULT_MERKLE_MISMATCH στο επόμενο unlock (fail-closed H-01).
    //
    //  ΜΕΤΑ (v12.3.1):
    //    affectedForMerkle = [...rebalanceWrites, newFolderRecord, item1Updated, item2Updated]
    //    → Το commitmentRoot υπολογίζεται με τα ΣΩΣΤΑ (νέα) positionKeys.
    //    → Consistency με move-executor.js (finalWrites).
    //
    //  Rationale:
    //    Κάθε record που γράφεται στο IDB μέσω του commit phase
    //    ΠΡΕΠΕΙ να συμμετέχει στο affectedForMerkle, αλλιώς το
    //    commitmentRoot είναι inconsistent με το πραγματικό state.
    // ═══════════════════════════════════════════════════════════
    const affectedForMerkle = [
      ...rebalanceWrites,
      newFolderRecord,
      item1Updated,
      item2Updated
    ].map(w => ({
      id: w.id,
      parentId: w.parentId,
      positionKey: w.positionKey,
      recordType: w.recordType,
      keyVersion: w.keyVersion
    }));

    const newCommitmentRoot = await ctx.updateMerkle(affectedForMerkle);

    // ---------- 12. New generation + meta ----------
    //  Record count: +1 (νέος φάκελος μόνο)
    const newGen = state.treeGeneration + 1;

    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: meta.recordCount + 1,
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // ---------- 13. New state record ----------
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 14. Return ----------
    return {
      writes: [...rebalanceWrites, newFolderRecord, item1Updated, item2Updated],
      deletes: [],
      newMetaRecord,
      newStateRecord,
      result: {
        id: newFolderId,
        parentId,
        title: folderName.trim(),
        item1Id,
        item2Id
      }
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = { prepare };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_MUTATION_MERGE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_MERGE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation handler: merge ready (v12.3.1: Merkle fix — ' +
      'rebalanceWrites included + C3-SEC: type check + cycle check)'
    );
  }

  return api;
})();