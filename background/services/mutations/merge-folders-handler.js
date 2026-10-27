/**
 * merge-folders-handler.js — Merge source folder into target folder
 *
 * @path     background/services/mutations/merge-folders-handler.js
 * @version  12.3.1
 * @since    v12E / v12.3.1
 *
 * PURPOSE
 *   Sequencer handler για merge 2 folders στον encrypted space.
 *   Δημιουργεί νέο subfolder στο targetId με τα children του sourceId,
 *   μετά διαγράφει τον source folder.
 *
 * FLOW
 *   1. Validate (sourceId, targetId, not same)
 *   2. Read state + meta
 *   3. Source + target checks (both must be folders)
 *   4. Cycle check (target ∉ descendants of source)
 *   5. Position computation για νέο subfolder στο target
 *   6. Create new subfolder
 *   7. Move children (με sequential positions)
 *   8. Delete source
 *   9. Update Merkle (affected = rebalanced siblings + new folder
 *      + moved children + deleted source)
 *  10. New generation (+1)
 *  11. New meta (recordCount: +1 −1 = 0)
 *  12. New state (stateMAC)
 *  13. Return PreparedMutation
 *
 * NON-OBVIOUS
 *   • Record count change: +1 (νέος subfolder) −1 (source deleted) = 0
 *   • Cycle detection: BFS upward από targetId προς root — αν συναντήσει
 *     sourceId → reject. Cycle-safe με visited Set.
 *   • Children positions: ξεκινάνε από STEP και αυξάνονται κατά STEP —
 *     διατηρεί τη σχετική σειρά τους.
 *   • Source μπορεί να είναι child του target — εξαιρείται από
 *     siblings calculation πριν το rebalance.
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.1 (2026-10-19) — CRITICAL FIX: Merkle commitmentRoot mismatch
 *   ══════════════════════════════════════════════════════════════════════
 *   🐛 BUG (CRITICAL): Το rawWrites ΔΕΝ περιλάμβανε τα rebalanceWrites.
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Όταν το computePositionBetween(lastSibling.positionKey, null)
 *       επέστρεφε null (δεν υπάρχει χώρος για νέο subfolder στο
 *       targetId), ο handler έκανε rebalance — δηλαδή υπολόγιζε ΝΕΑ
 *       positionKeys για όλα τα siblings του targetId και τα έγραφε
 *       στο IDB μέσω των rebalanceWrites.
 *
 *       ΑΛΛΑ:
 *         const rawWrites = [newFolderRecord, ...childWrites].map(...)
 *                             ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                             ΛΕΙΠΟΥΝ τα rebalanceWrites
 *
 *       Το updateMerkle() διαβάζει τα records από το IDB (ΠΑΛΙΑ
 *       positionKeys) και προσθέτει μόνο τα affected. Άρα το
 *       commitmentRoot υπολογιζόταν με:
 *         [sib1: OLD_pos, sib2: OLD_pos, ..., newFolder, children..., deleted]
 *
 *       Ενώ στο IDB γράφονταν:
 *         [sib1: NEW_pos, sib2: NEW_pos, ..., newFolder, children..., deleted]
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
 *         const rawWrites = [
 *           ...rebalanceWrites,
 *           newFolderRecord,
 *           ...childWrites
 *         ].map(...)
 *
 *     CONSISTENCY:
 *       Ίδιο pattern με move-executor.js (το οποίο είναι ΣΩΣΤΟ):
 *         const affectedForMerkle = finalWrites.map(...)
 *         // όπου finalWrites = rebalanceWrites + moves
 *
 *     IMPACT:
 *       • ✅ Διορθώνει το bug οριστικά (μελλοντικά mergeFolders)
 *       • ✅ Δεν επηρεάζει υπάρχοντα vaults (μόνο νέα mutations)
 *       • ✅ Για ήδη σπασμένα vaults → auto-recovery στο unlock
 *          (βλ. encrypted-space.js v12.3.1)
 *       • ✅ Zero regression (ίδιο interface, ίδιο PreparedMutation)
 *
 *   v12.0.0 — Initial release
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "merge-folders-handler"
 */

var CBF_MUTATION_MERGE_FOLDERS = (function() {
  'use strict';

  const ROOT_ID = 'ecbf-root';

  // ============================================================
  //  Validation
  // ============================================================
  function _validatePayload(payload) {
    const p = payload || {};

    if (typeof p.sourceId !== 'string' || p.sourceId.length === 0) {
      throw new Error('mergeFolders: sourceId required');
    }
    if (typeof p.targetId !== 'string' || p.targetId.length === 0) {
      throw new Error('mergeFolders: targetId required');
    }
    if (p.sourceId === p.targetId) {
      throw new Error('mergeFolders: sourceId and targetId must be different');
    }
    if (p.sourceId === ROOT_ID) {
      throw new Error('mergeFolders: cannot merge root');
    }
  }

  // ============================================================
  //  Cycle detection: targetId ∉ descendants(sourceId)
  //
  //  Πηγαίνουμε από targetId προς τα πάνω (parent chain).
  //  Αν συναντήσουμε sourceId → cycle.
  // ============================================================
  function _detectCycle(itemsMap, sourceId, targetId) {
    let cur = targetId;
    const visited = new Set();
    while (cur && !visited.has(cur)) {
      if (cur === sourceId) return true;
      visited.add(cur);
      const node = itemsMap.get(cur);
      if (!node) break;
      cur = node.parentId;
    }
    return false;
  }

  // ============================================================
  //  prepare(payload, ctx) → PreparedMutation
  // ============================================================
  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { sourceId, targetId } = payload;

    // ---------- 1. Read state + meta ----------
    const state = await ctx.readState();
    if (!state) throw new Error('mergeFolders: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('mergeFolders: vault meta not found');

    // ---------- 2. Source + target check ----------
    const source = await ctx.readRecord(sourceId);
    if (!source) throw new Error('mergeFolders: source not found');
    if (source._corrupted) throw new Error('mergeFolders: source is corrupted');
    if (source.type !== 'folder') throw new Error('mergeFolders: source is not a folder');

    const target = await ctx.readRecord(targetId);
    if (!target) throw new Error('mergeFolders: target not found');
    if (target._corrupted) throw new Error('mergeFolders: target is corrupted');
    if (target.type !== 'folder') throw new Error('mergeFolders: target is not a folder');

    // ---------- 3. Cycle check ----------
    const allRecords = await ctx.readAllRecords();
    const itemsMap = new Map();
    for (const r of allRecords) {
      if (!r._corrupted) itemsMap.set(r.id, r);
    }
    if (_detectCycle(itemsMap, sourceId, targetId)) {
      throw new Error('mergeFolders: cannot merge folder into its own descendant');
    }

    // ---------- 4. Target siblings (εξαιρώντας τον source) ----------
    //  Ο source μπορεί να είναι child του target — θα διαγραφεί.
    let targetSiblings = await ctx.readChildren(targetId);
    targetSiblings = targetSiblings.filter(s => s.id !== sourceId);
    targetSiblings.sort(CBF_POSKEYS.compareNodes);

    const check = CBF_POSKEYS.validateChildrenCount(targetSiblings.length + 1);
    if (!check.ok) {
      throw new Error('mergeFolders: ' + check.error);
    }

    // ---------- 5. Υπολογισμός θέσης νέου subfolder στο target ----------
    const lastSib = targetSiblings.length > 0
      ? targetSiblings[targetSiblings.length - 1]
      : null;
    const prevKey = lastSib ? lastSib.positionKey : null;
    let newFolderPosBig = CBF_POSKEYS.computePositionBetween(prevKey, null);
    const rebalanceWrites = [];

    if (newFolderPosBig === null) {
      const rebalanced = CBF_POSKEYS.computeRebalance(targetSiblings);
      const rebalanceMap = new Map(rebalanced.map(r => [r.id, r.newPositionKey]));

      for (const sib of targetSiblings) {
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

      const rebalancedSiblings = targetSiblings.map(s => ({
        ...s,
        positionKey: rebalanceMap.get(s.id)
      }));
      rebalancedSiblings.sort(CBF_POSKEYS.compareNodes);

      const lastR = rebalancedSiblings[rebalancedSiblings.length - 1];
      newFolderPosBig = CBF_POSKEYS.computePositionBetween(lastR.positionKey, null);
      if (newFolderPosBig === null) {
        throw new Error('mergeFolders: rebalance failed');
      }
    }

    const newFolderPositionKey = CBF_POSKEYS.toStored(newFolderPosBig);

    // ---------- 6. Νέος subfolder μέσα στο target ----------
    const newFolderId = crypto.randomUUID();
    const newFolderRecord = await ctx.buildRecord({
      id: newFolderId,
      parentId: targetId,
      positionKey: newFolderPositionKey,
      type: 'folder',
      title: source.title,
      url: null
    });

    // ---------- 7. Μεταφορά children του source → νέο subfolder ----------
    const sourceChildren = await ctx.readChildren(sourceId);
    sourceChildren.sort(CBF_POSKEYS.compareNodes);

    const childWrites = [];
    let step = CBF_POSKEYS.POSITION_STEP;
    for (const child of sourceChildren) {
      const newPosKey = CBF_POSKEYS.toStored(step);
      const updated = await ctx.buildRecord({
        id: child.id,
        parentId: newFolderId,
        positionKey: newPosKey,
        type: child.type,
        title: child.title,
        url: child.url
      });
      childWrites.push(updated);
      step += CBF_POSKEYS.POSITION_STEP;
    }

    // ---------- 8. Update Merkle ----------
    // ═══════════════════════════════════════════════════════════
    //  🐛 FIX v12.3.1 (CRITICAL): Περιλαμβάνουμε τα rebalanceWrites.
    //
    //  ΠΡΙΝ (v12.0.0 - v12.3.0):
    //    const rawWrites = [newFolderRecord, ...childWrites].map(...)
    //    → Το commitmentRoot υπολογιζόταν με τα ΠΑΛΙΑ positionKeys
    //      των rebalanced siblings του targetId.
    //    → VAULT_MERKLE_MISMATCH στο επόμενο unlock (fail-closed H-01).
    //
    //  ΜΕΤΑ (v12.3.1):
    //    rawWrites = [...rebalanceWrites, newFolderRecord, ...childWrites]
    //    → Το commitmentRoot υπολογίζεται με τα ΣΩΣΤΑ (νέα) positionKeys.
    //    → Consistency με move-executor.js (finalWrites).
    //
    //  Rationale:
    //    Κάθε record που γράφεται στο IDB μέσω του commit phase
    //    ΠΡΕΠΕΙ να συμμετέχει στο affectedForMerkle, αλλιώς το
    //    commitmentRoot είναι inconsistent με το πραγματικό state.
    //
    //  ΣΗΜΕΙΩΣΗ:
    //    Writes: rebalanced siblings + νέος subfolder + updated children
    //    Deletes: source folder
    // ═══════════════════════════════════════════════════════════
    const rawWrites = [
      ...rebalanceWrites,
      newFolderRecord,
      ...childWrites
    ].map(w => ({
      id: w.id,
      parentId: w.parentId,
      positionKey: w.positionKey,
      recordType: w.recordType,
      keyVersion: w.keyVersion
    }));

    const rawDelete = {
      id: source.id,
      parentId: source.parentId,
      positionKey: source.positionKey,
      recordType: 'folder',
      keyVersion: CBF_ES._internal.getKeyVersion(),
      _deleted: true
    };

    const newCommitmentRoot = await ctx.updateMerkle([...rawWrites, rawDelete]);

    // ---------- 9. New generation + meta ----------
    //  Record count: +1 (νέος subfolder) −1 (source deleted) = 0
    const newGen = state.treeGeneration + 1;

    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: meta.recordCount,
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 10. Return ----------
    return {
      writes: [...rebalanceWrites, newFolderRecord, ...childWrites],
      deletes: [sourceId],
      newMetaRecord,
      newStateRecord,
      result: {
        id: newFolderId,
        parentId: targetId,
        title: source.title,
        movedChildren: sourceChildren.length
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
  if (typeof self !== 'undefined') self.CBF_MUTATION_MERGE_FOLDERS = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_MERGE_FOLDERS = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation handler: mergeFolders ready (v12.3.1: Merkle fix — ' +
      'rebalanceWrites included in updateMerkle)'
    );
  }

  return api;
})();