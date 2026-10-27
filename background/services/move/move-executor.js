/**
 * move-executor.js — Move executor (plan → prepared mutation)
 *
 * @path     background/services/move/move-executor.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Εκτελεί ένα frozen MovePlan: re-encrypt-άρει τα affected records,
 *   εφαρμόζει rebalance writes + moves, και επιστρέφει ένα
 *   PreparedMutation για τον sequencer (writes + newMetaRecord +
 *   newStateRecord).
 *
 * FLOW
 *   1. Rebalance writes (positionKey updates)
 *   2. Moves (parentId + positionKey updates)
 *   3. Merge rebalanced + moved records (dedupe by id)
 *   4. Merkle update (structural changes only)
 *   5. New generation (state.treeGeneration + 1)
 *   6. New meta record (recordCount unchanged)
 *   7. New state record (stateMAC στο prepare)
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "move-executor"
 */

var CBF_MOVE_EXECUTOR = (function() {
  'use strict';

  /**
   * @param {object} plan — frozen MovePlan
   * @param {Map} itemsMap — decrypted items
   * @param {object} ctx — prepare context
   * @param {object} state — vault state (για treeGeneration)
   * @param {object} meta — vault meta
   * @returns {Promise<PreparedMutation>}
   */
  async function execute(plan, itemsMap, ctx, state, meta) {
    const writes = [];
    const writeIds = new Set();

    // ---------- 1. Rebalance writes ----------
    for (const rw of plan.rebalanceWrites) {
      const node = itemsMap.get(rw.id);
      if (!node) continue;

      const enc = await ctx.buildRecord({
        id: node.id,
        parentId: rw.parentId,
        positionKey: rw.newPositionKey,
        type: node.type,
        title: node.title,
        url: node.url
      });
      writes.push(enc);
      writeIds.add(rw.id);
    }

    // ---------- 2. Moves ----------
    const moveIds = new Set(plan.moves.map(m => m.id));
    const filteredWrites = writes.filter(w =>
      !(moveIds.has(w.id) && plan.rebalanceWrites.some(r => r.id === w.id))
    );

    const finalWrites = [];
    const seen = new Set();

    for (const w of filteredWrites) {
      if (!seen.has(w.id)) {
        finalWrites.push(w);
        seen.add(w.id);
      }
    }

    for (const m of plan.moves) {
      const node = itemsMap.get(m.id);
      if (!node) throw new Error(`move-executor: node ${m.id} not found`);

      const enc = await ctx.buildRecord({
        id: node.id,
        parentId: m.newParentId,
        positionKey: m.newPositionKey,
        type: node.type,
        title: node.title,
        url: node.url
      });

      if (seen.has(m.id)) {
        const idx = finalWrites.findIndex(w => w.id === m.id);
        if (idx !== -1) finalWrites[idx] = enc;
      } else {
        finalWrites.push(enc);
        seen.add(m.id);
      }
    }

    // ---------- 3. Merkle update ----------
    //  affected = moved + rebalanced records (structural changes)
    const affectedForMerkle = finalWrites.map(w => ({
      id: w.id,
      parentId: w.parentId,
      positionKey: w.positionKey,
      recordType: w.recordType,
      keyVersion: w.keyVersion
    }));

    const newCommitmentRoot = await ctx.updateMerkle(affectedForMerkle);

    // ---------- 4. New generation ----------
    const newGen = state.treeGeneration + 1;

    // ---------- 5. New meta record ----------
    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: meta.recordCount,     // move δεν αλλάζει recordCount
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // ---------- 6. New state record ----------
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 7. Result ----------
    const result = {
      movedCount: plan.moves.length,
      rebalancedCount: plan.rebalanceWrites.length,
      moves: plan.moves.map(m => ({
        id: m.id,
        parentId: m.newParentId,
        positionKey: m.newPositionKey
      }))
    };

    if (plan.moves.length === 1) {
      result.id = plan.moves[0].id;
      result.parentId = plan.moves[0].newParentId;
      result.positionKey = plan.moves[0].newPositionKey;
    }

    return {
      writes: finalWrites,
      deletes: [],
      newMetaRecord,
      newStateRecord,
      result
    };
  }

  const api = { execute };

  if (typeof self !== 'undefined') self.CBF_MOVE_EXECUTOR = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MOVE_EXECUTOR = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Move Executor ready (stateMAC + Merkle)');
  }

  return api;
})();