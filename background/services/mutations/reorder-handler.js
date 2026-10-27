/**
 * reorder-handler.js — Reorder handler (sequencer command)
 *
 * @path     background/services/mutations/reorder-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Sequencer command handler για reorder operations (ίδιος parent).
 *   Orchestrates: validate → plan → execute (μέσω CBF_MOVE_* helpers).
 *
 *   ΔΕΝ κάνει crypto / IDB — όλα πάνω μέσω του ctx (sequencer).
 *
 * FLOW
 *   1. Validate payload (id, targetId, position)
 *   2. Read state + meta + all records
 *   3. Validate reorder (CBF_MOVE_VALIDATOR.validateReorder)
 *   4. Plan reorder (CBF_MOVE_PLANNER.planReorder)
 *   5. Execute (CBF_MOVE_EXECUTOR.execute)
 *
 * KEY CONCEPTS
 *   • Reorder = move ΜΕΣΑ στον ίδιο parent (parent invariant)
 *   • recordCount ΑΜΕΤΑΒΛΗΤΟ (δεν προσθέτει/αφαιρεί records)
 *   • Position keys via CBF_MOVE_PLANNER (χειρίζεται rebalance)
 *
 * DECISIONS
 *   D-18, D-19, D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "reorder"
 */

var CBF_MUTATION_REORDER = (function() {
  'use strict';

  const ROOT_ID = 'ecbf-root';

  function _validatePayload(payload) {
    const { id, targetId, position } = payload || {};

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('reorder: id required');
    }
    if (id === ROOT_ID) {
      throw new Error('reorder: cannot reorder root');
    }
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new Error('reorder: targetId required');
    }
    if (targetId === id) {
      throw new Error('reorder: targetId cannot be id');
    }
    if (position !== 'before' && position !== 'after') {
      throw new Error('reorder: position must be before|after');
    }
  }

  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { id, targetId, position } = payload;

    // ---------- 1. Read state + meta ----------
    const state = await ctx.readState();
    if (!state) throw new Error('reorder: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('reorder: vault meta not found');

    // ---------- 2. All records (decrypted) ----------
    const allRecords = await ctx.readAllRecords();
    const itemsMap = new Map();
    for (const r of allRecords) {
      if (!r._corrupted) itemsMap.set(r.id, r);
    }

    // ---------- 3. Validate ----------
    const v = CBF_MOVE_VALIDATOR.validateReorder(itemsMap, id, targetId, ROOT_ID);
    if (!v.ok) throw new Error('reorder: ' + v.error);

    // ---------- 4. Plan ----------
    const planRes = CBF_MOVE_PLANNER.planReorder(
      itemsMap,
      id,
      targetId,
      position,
      {
        commandId: ctx.commandId,
        expectedGeneration: state.treeGeneration,
        recordCount: meta.recordCount
      }
    );
    if (!planRes.ok) throw new Error('reorder: ' + planRes.error);

    const plan = planRes.plan;

    // ---------- 5. Execute ----------
    return await CBF_MOVE_EXECUTOR.execute(plan, itemsMap, ctx, state, meta);
  }

  const api = { prepare };

  if (typeof self !== 'undefined') self.CBF_MUTATION_REORDER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_REORDER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Mutation handler: reorder ready (MovePlan v3 + Merkle)');
  }

  return api;
})();