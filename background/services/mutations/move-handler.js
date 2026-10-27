/**
 * move-handler.js — Move handler (sequencer command)
 *
 * @path     background/services/mutations/move-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Sequencer command handler για move operations. Orchestrates:
 *   normalize → validate → plan → execute.
 *
 *   ΔΕΝ κάνει crypto / IDB — όλα πάνε μέσω του ctx (sequencer).
 *
 * FLOW
 *   1. Normalize raw ids (CBF_MOVE_NORMALIZER)
 *   2. Validate (CBF_MOVE_VALIDATOR)
 *   3. Plan (CBF_MOVE_PLANNER)
 *   4. Execute (CBF_MOVE_EXECUTOR)
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "move-handler"
 */

var CBF_MUTATION_MOVE = (function() {
  'use strict';

  const ROOT_ID = 'ecbf-root';

  function _validatePayload(payload) {
    const p = payload || {};

    const hasId = typeof p.id === 'string' && p.id.length > 0;
    const hasIds = Array.isArray(p.ids) && p.ids.length > 0;
    if (!hasId && !hasIds) {
      throw new Error('move: id or ids required');
    }

    if (typeof p.newParentId !== 'string' || p.newParentId.length === 0) {
      throw new Error('move: newParentId required');
    }

    const position = p.position || 'inside';
    if (position !== 'inside' && position !== 'before' && position !== 'after') {
      throw new Error('move: position must be inside|before|after');
    }

    if ((position === 'before' || position === 'after') &&
        (typeof p.targetId !== 'string' || p.targetId.length === 0)) {
      throw new Error(`move: targetId required for "${position}"`);
    }
  }

  function _extractRawIds(payload) {
    if (Array.isArray(payload.ids) && payload.ids.length > 0) {
      return payload.ids.slice();
    }
    return [payload.id];
  }

  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { newParentId, position = 'inside', targetId = null } = payload;
    const rawIds = _extractRawIds(payload);

    // ---------- 1. Read state + meta ----------
    const state = await ctx.readState();
    if (!state) throw new Error('move: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('move: vault meta not found');

    // ---------- 2. All records (decrypted) ----------
    const allRecords = await ctx.readAllRecords();
    const itemsMap = new Map();
    for (const r of allRecords) {
      if (!r._corrupted) itemsMap.set(r.id, r);
    }

    // ---------- 3. Normalize ----------
    const normRes = CBF_MOVE_NORMALIZER.normalize(itemsMap, rawIds);
    if (!normRes.ok) throw new Error('move: ' + normRes.error);
    const normalizedIds = normRes.ids;

    // ---------- 4. Validate ----------
    const v = CBF_MOVE_VALIDATOR.validateMove(
      itemsMap, normalizedIds, newParentId, ROOT_ID
    );
    if (!v.ok) throw new Error('move: ' + v.error);

    // ---------- 5. MAX_CHILDREN check ----------
    const movingSet = new Set(normalizedIds);
    let targetExistingChildren = 0;
    for (const node of itemsMap.values()) {
      if (node.parentId === newParentId && !movingSet.has(node.id)) {
        targetExistingChildren++;
      }
    }
    const finalCount = targetExistingChildren + normalizedIds.length;
    const check = CBF_POSKEYS.validateChildrenCount(finalCount);
    if (!check.ok) {
      throw new Error('move: ' + check.error);
    }

    // ---------- 6. Plan ----------
    const planRes = CBF_MOVE_PLANNER.plan(
      itemsMap,
      normalizedIds,
      newParentId,
      position,
      targetId,
      {
        commandId: ctx.commandId,
        expectedGeneration: state.treeGeneration,
        recordCount: meta.recordCount
      }
    );
    if (!planRes.ok) throw new Error('move: ' + planRes.error);

    const plan = planRes.plan;

    // ---------- 7. Execute ----------
    return await CBF_MOVE_EXECUTOR.execute(plan, itemsMap, ctx, state, meta);
  }

  const api = { prepare };

  if (typeof self !== 'undefined') self.CBF_MUTATION_MOVE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_MOVE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Mutation handler: move ready (MovePlan v3 + Merkle)');
  }

  return api;
})();