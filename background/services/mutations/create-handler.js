/**
 * create-handler.js — Create bookmark/folder (encrypted space)
 *
 * @path     background/services/mutations/create-handler.js
 * @version  12.3.1
 * @since    v12E / v12.3.1
 *
 * PURPOSE
 *   Sequencer handler για τη δημιουργία bookmark/folder στον encrypted
 *   space. Εκθέτει prepare(payload, ctx) που επιστρέφει PreparedMutation
 *   με writes + newMetaRecord + newStateRecord (stateMAC + Merkle).
 *
 * FLOW
 *   1. Validation (parentId, type, title, url)
 *   2. Read state + meta + parent
 *   3. Siblings + MAX_CHILDREN check
 *   4. Neighbors + compute position (rebalance αν χρειάζεται)
 *   5. New record (encrypted)
 *   6. Update Merkle → new commitmentRoot
 *   7. New generation (+1)
 *   8. New meta + new state record
 *   9. Return { writes, deletes, newMetaRecord, newStateRecord, result }
 *
 * NON-OBVIOUS
 *   • Το crypto (encrypt) τρέχει OUT-of-tx (D-8) — ο sequencer
 *     περνάει το PreparedMutation στο commit phase.
 *   • Rebalance: αν δεν υπάρχει χώρος μεταξύ prev/next, γίνεται
 *     full rebalance όλων των siblings με νέα STEP positions.
 *   • Rebalance writes ΔΕΝ αυξάνουν recordCount — είναι in-place updates.
 *   • D-10: .slice() copy pattern σε κάθε crypto helper.
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.1 (2026-10-19) — CRITICAL FIX: Merkle commitmentRoot mismatch
 *   ══════════════════════════════════════════════════════════════════════
 *   🐛 BUG (CRITICAL): Το updateMerkle() ΔΕΝ περιλάμβανε τα rebalanceWrites.
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Όταν το computePositionBetween() επέστρεφε null (δεν υπάρχει
 *       χώρος μεταξύ prev/next), ο handler έκανε rebalance — δηλαδή
 *       υπολόγιζε ΝΕΑ positionKeys για όλα τα siblings και τα έγραφε
 *       στο IDB μέσω των rebalanceWrites.
 *
 *       ΑΛΛΑ:
 *         const newCommitmentRoot = await ctx.updateMerkle([newRecord]);
 *                                                            ^^^^^^^^^^^
 *                                                            ΜΟΝΟ το νέο
 *
 *       Το updateMerkle() διαβάζει τα records από το IDB (ΠΑΛΙΑ
 *       positionKeys) και προσθέτει μόνο το newRecord. Άρα το
 *       commitmentRoot υπολογιζόταν με:
 *         [sib1: OLD_pos, sib2: OLD_pos, ..., newRecord: NEW_pos]
 *
 *       Ενώ στο IDB γράφονταν:
 *         [sib1: NEW_pos, sib2: NEW_pos, ..., newRecord: NEW_pos]
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
 *       Συμπεριλαμβάνουμε τα rebalanceWrites στο affectedForMerkle:
 *         const affectedForMerkle = [...rebalanceWrites, newRecord];
 *         const newCommitmentRoot = await ctx.updateMerkle(affectedForMerkle);
 *
 *       Έτσι το commitmentRoot υπολογίζεται με τα ΣΩΣΤΑ (νέα)
 *       positionKeys των rebalanced siblings.
 *
 *     CONSISTENCY:
 *       Ίδιο pattern με το move-executor.js (το οποίο είναι ΣΩΣΤΟ):
 *         const affectedForMerkle = finalWrites.map(...)
 *         // όπου finalWrites = rebalanceWrites + moves
 *
 *     IMPACT:
 *       • ✅ Διορθώνει το bug οριστικά (μελλοντικά creates)
 *       • ✅ Δεν επηρεάζει υπάρχοντα vaults (μόνο νέα mutations)
 *       • ✅ Για ήδη σπασμένα vaults → auto-recovery στο unlock
 *          (βλ. encrypted-space.js v12.3.1)
 *       • ✅ Zero regression (ίδιο interface, ίδιο PreparedMutation)
 *
 *   v12.0.0 — Initial release
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "create-handler"
 */

var CBF_MUTATION_CREATE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_TITLE_LENGTH = 500;
  const MAX_URL_LENGTH = 2048;

  // ============================================================
  //  Validation
  // ============================================================
  function _validatePayload(payload) {
    const { parentId, type, title, url, insertAfterId = null } = payload || {};

    if (typeof parentId !== 'string' || parentId.length === 0) {
      throw new Error('create: parentId required');
    }
    if (type !== 'bookmark' && type !== 'folder') {
      throw new Error('create: type must be "bookmark" or "folder"');
    }
    if (typeof title !== 'string') {
      throw new Error('create: title must be a string');
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new Error('create: title too long');
    }
    if (type === 'bookmark') {
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('create: url required for bookmark');
      }
      if (url.length > MAX_URL_LENGTH) {
        throw new Error('create: url too long');
      }
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('create: url must be http(s)');
      }
    }
    if (insertAfterId !== null && typeof insertAfterId !== 'string') {
      throw new Error('create: insertAfterId must be string or null');
    }
  }

  // ============================================================
  //  prepare(payload, ctx) → PreparedMutation
  // ============================================================
  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const {
      parentId,
      type,
      title,
      url = null,
      insertAfterId = null
    } = payload;

    // ---------- 1. Read state + meta ----------
    const state = await ctx.readState();
    if (!state) throw new Error('create: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('create: vault meta not found');

    // ---------- 2. Parent check ----------
    const parent = await ctx.readRecord(parentId);
    if (!parent) throw new Error('create: parent not found');
    if (parent.type !== 'folder') throw new Error('create: parent is not a folder');
    if (parent._corrupted) throw new Error('create: parent record is corrupted');

    // ---------- 3. Siblings ----------
    const siblings = await ctx.readChildren(parentId);
    siblings.sort(CBF_POSKEYS.compareNodes);

    // ---------- 4. MAX_CHILDREN check ----------
    const check = CBF_POSKEYS.validateChildrenCount(siblings.length + 1);
    if (!check.ok) {
      throw new Error('create: ' + check.error);
    }

    // ---------- 5. Neighbors ----------
    const { prev, next } = CBF_POSKEYS.findNeighborsInSorted(
      siblings, insertAfterId
    );

    // ---------- 6. Compute position ----------
    let newPositionBig = CBF_POSKEYS.computePositionBetween(prev, next);
    const rebalanceWrites = [];

    if (newPositionBig === null) {
      // Rebalance needed
      CBF_LOGGER.info(`create: rebalancing parent ${parentId} (${siblings.length} children)`);

      const rebalanced = CBF_POSKEYS.computeRebalance(siblings);
      const rebalanceMap = new Map(rebalanced.map(r => [r.id, r.newPositionKey]));

      for (const sib of siblings) {
        const newKey = rebalanceMap.get(sib.id);
        if (newKey === sib.positionKey) continue;

        const encRec = await ctx.buildRecord({
          id: sib.id,
          parentId: sib.parentId,
          positionKey: newKey,
          type: sib.type,
          title: sib.title,
          url: sib.url
        });
        rebalanceWrites.push(encRec);
      }

      const rebalancedSiblings = siblings.map(s => ({
        ...s,
        positionKey: rebalanceMap.get(s.id)
      }));
      rebalancedSiblings.sort(CBF_POSKEYS.compareNodes);

      const n2 = CBF_POSKEYS.findNeighborsInSorted(rebalancedSiblings, insertAfterId);
      newPositionBig = CBF_POSKEYS.computePositionBetween(n2.prev, n2.next);

      if (newPositionBig === null) {
        throw new Error('create: rebalance failed to create space');
      }
    }

    const positionKey = CBF_POSKEYS.toStored(newPositionBig);

    // ---------- 7. New record ----------
    const id = crypto.randomUUID();
    const newRecord = await ctx.buildRecord({
      id,
      parentId,
      positionKey,
      type,
      title,
      url
    });

    // ---------- 8. Update Merkle ----------
    // ═══════════════════════════════════════════════════════════
    //  🐛 FIX v12.3.1 (CRITICAL): Περιλαμβάνουμε τα rebalanceWrites.
    //
    //  ΠΡΙΝ (v12.0.0 - v12.3.0):
    //    const newCommitmentRoot = await ctx.updateMerkle([newRecord]);
    //    → Το commitmentRoot υπολογιζόταν με τα ΠΑΛΙΑ positionKeys
    //      των rebalanced siblings.
    //    → VAULT_MERKLE_MISMATCH στο επόμενο unlock (fail-closed H-01).
    //
    //  ΜΕΤΑ (v12.3.1):
    //    affectedForMerkle = [...rebalanceWrites, newRecord]
    //    → Το commitmentRoot υπολογίζεται με τα ΣΩΣΤΑ (νέα) positionKeys.
    //    → Consistency με move-executor.js (finalWrites).
    //
    //  Rationale:
    //    Κάθε record που γράφεται στο IDB μέσω του commit phase
    //    ΠΡΕΠΕΙ να συμμετέχει στο affectedForMerkle, αλλιώς το
    //    commitmentRoot είναι inconsistent με το πραγματικό state.
    // ═══════════════════════════════════════════════════════════
    const affectedForMerkle = [...rebalanceWrites, newRecord];
    const newCommitmentRoot = await ctx.updateMerkle(affectedForMerkle);

    // ---------- 9. New generation ----------
    const newGen = state.treeGeneration + 1;

    // ---------- 10. New meta record ----------
    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: meta.recordCount + 1,
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // ---------- 11. New state record (με stateMAC) ----------
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 12. Return PreparedMutation ----------
    return {
      writes: [...rebalanceWrites, newRecord],
      deletes: [],
      newMetaRecord,
      newStateRecord,
      result: {
        id,
        parentId,
        positionKey,
        type,
        title,
        url
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
  if (typeof self !== 'undefined') self.CBF_MUTATION_CREATE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_CREATE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation handler: create ready (v12.3.1: Merkle fix — ' +
      'rebalanceWrites included in updateMerkle)'
    );
  }

  return api;
})();