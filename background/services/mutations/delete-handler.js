/**
 * delete-handler.js — Recursive delete (encrypted space)
 *
 * @path     background/services/mutations/delete-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Sequencer handler για recursive delete bookmark/folder (και όλου
 *   του subtree). Εκθέτει prepare(payload, ctx) που επιστρέφει
 *   PreparedMutation με deletes + newMetaRecord + newStateRecord.
 *
 * FLOW
 *   1. Validation (id required, not root)
 *   2. Read state + target
 *   3. BFS για subtree IDs
 *   4. Update Merkle (affected = subtree IDs με _deleted: true)
 *   5. New generation (+1)
 *   6. New meta (recordCount -= subtreeIds.length)
 *   7. New state (stateMAC)
 *   8. Return { writes: [], deletes, newMetaRecord, newStateRecord }
 *
 * NON-OBVIOUS
 *   • Recursive: ένα delete σε folder διαγράφει ΟΛΟ το subtree.
 *   • Record count update: meta.recordCount - subtree.size.
 *   • Merkle: όλα τα deleted IDs περνάνε ως affected με `_deleted: true`.
 *   • Root protection: 'ecbf-root' δεν διαγράφεται ποτέ.
 *
 * DECISIONS
 *   D-18, D-19, D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "delete-handler"
 */

var CBF_MUTATION_DELETE = (function() {
  'use strict';

  const ROOT_ID = 'ecbf-root';

  // ============================================================
  //  Validation
  // ============================================================
  function _validatePayload(payload) {
    const { id } = payload || {};
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('delete: id required');
    }
    if (id === ROOT_ID) {
      throw new Error('delete: cannot delete root');
    }
  }

  // ============================================================
  //  BFS για subtree IDs
  // ============================================================
  function _collectSubtreeIds(allRecords, rootId) {
    const byParent = new Map();
    for (const r of allRecords) {
      if (!byParent.has(r.parentId)) byParent.set(r.parentId, []);
      byParent.get(r.parentId).push(r.id);
    }
    const result = new Set([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const cur = queue.shift();
      const kids = byParent.get(cur) || [];
      for (const k of kids) {
        if (!result.has(k)) {
          result.add(k);
          queue.push(k);
        }
      }
    }
    return result;
  }

  // ============================================================
  //  prepare(payload, ctx) → PreparedMutation
  // ============================================================
  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { id } = payload;

    // ---------- 1. Read state ----------
    const state = await ctx.readState();
    if (!state) throw new Error('delete: vault state not found');

    // ---------- 2. Read target ----------
    const target = await ctx.readRecord(id);
    if (!target) throw new Error('delete: record not found');
    if (target._corrupted) throw new Error('delete: record is corrupted');

    // ---------- 3. Subtree ----------
    const allRecords = await ctx.readAllRecords();
    const subtreeIds = _collectSubtreeIds(allRecords, id);
    const deletes = Array.from(subtreeIds);

    // ---------- 4. Update Merkle ----------
    //  Φτιάχνουμε τα raw records προς διαγραφή (μόνο τα δομικά πεδία)
    const deletedRawRecords = deletes.map(delId => {
      const rec = allRecords.find(r => r.id === delId);
      if (!rec) return { id: delId, _deleted: true };
      return {
        id: rec.id,
        parentId: rec.parentId,
        positionKey: rec.positionKey,
        recordType: rec.type || rec.recordType,
        keyVersion: rec.keyVersion || 1,
        _deleted: true
      };
    });

    const newCommitmentRoot = await ctx.updateMerkle(deletedRawRecords);

    // ---------- 5. New generation ----------
    const newGen = state.treeGeneration + 1;

    // ---------- 6. New meta record ----------
    const meta = await ctx.readMeta();
    if (!meta) throw new Error('delete: vault meta not found');

    const newCount = Math.max(0, meta.recordCount - deletes.length);
    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: newCount,
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // ---------- 7. New state record ----------
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 8. Return ----------
    return {
      writes: [],
      deletes,
      newMetaRecord,
      newStateRecord,
      result: {
        deletedCount: deletes.length,
        deletedIds: deletes
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
  if (typeof self !== 'undefined') self.CBF_MUTATION_DELETE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_DELETE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Mutation handler: delete ready (recursive + Merkle)');
  }

  return api;
})();