/**
 * move-planner.js — Move planner (pure, plan-only)
 *
 * @path     background/services/move/move-planner.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Pure planning για move/reorder operations. ΔΕΝ εκτελεί IO,
 *   ΔΕΝ κάνει crypto — υπολογίζει θέσεις (position keys) και
 *   επιστρέφει ένα frozen MovePlan v3 για τον executor.
 *
 * MOVEPLAN v3 SHAPE
 *   • moves[]           — { id, oldParentId, oldPositionKey,
 *                           newParentId, newPositionKey }
 *   • rebalanceWrites[] — { id, parentId, newPositionKey }
 *   • affectedParents[] — parent ids που επηρεάστηκαν
 *   • metadataUpdate    — { treeGeneration, recordCount }
 *   • kind              — 'move' | 'reorder'
 *   • ΔΕΝ περιέχει commitmentRoot — υπολογίζεται από τον
 *     executor μέσω ctx.updateMerkle()
 *
 * API
 *   • plan()                 — move (single/multi, inside/before/after)
 *   • planReorder()          — reorder (same parent)
 *   • calculateFinalOrder()  — pure preview του τελικού tree order
 *
 * DECISIONS
 *   D-3, D-8
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "move-planner"
 */

var CBF_MOVE_PLANNER = (function() {
  'use strict';

  // ============================================================
  //  Move plan
  // ============================================================
  function plan(itemsMap, normalizedIds, newParentId, position, targetId, opts) {
    const o = _validateOpts(opts);
    if (!o.ok) return o;

    // ---------- 1. Siblings of new parent (excluding moving) ----------
    const movingSet = new Set(normalizedIds);
    const siblings = _sortedChildren(itemsMap, newParentId, movingSet);

    // ---------- 2. Validate targetId αν before/after ----------
    if (position === 'before' || position === 'after') {
      if (!targetId) {
        return { ok: false, error: `targetId required for "${position}"` };
      }
      const target = itemsMap.get(targetId);
      if (!target) return { ok: false, error: 'Target not found' };
      if (target.parentId !== newParentId) {
        return { ok: false, error: 'Target is not a child of new parent' };
      }
      if (movingSet.has(targetId)) {
        return { ok: false, error: 'Target is in movingIds' };
      }
    }

    // ---------- 3. insertAfterId ----------
    let insertAfterId;
    if (position === 'inside') {
      insertAfterId = siblings.length > 0 ? siblings[siblings.length - 1].id : null;
    } else if (position === 'before') {
      const idx = siblings.findIndex(s => s.id === targetId);
      insertAfterId = idx > 0 ? siblings[idx - 1].id : null;
    } else { // after
      insertAfterId = targetId;
    }

    // ---------- 4. Compute positions ----------
    const { prev, next } = CBF_POSKEYS.findNeighborsInSorted(siblings, insertAfterId);

    const movingNodes = normalizedIds.map(id => itemsMap.get(id));
    const n = movingNodes.length;

    let rebalanceWrites = [];
    const positions = [];

    const computed = _computeNPositions(prev, next, n);
    if (computed === null) {
      // Δεν υπάρχει χώρος → rebalance
      const rebalanceResult = _planRebalance(siblings);
      rebalanceWrites = rebalanceResult.rebalanced;

      const rebalancedSiblings = siblings.map(s => ({
        id: s.id,
        parentId: s.parentId,
        positionKey: _lookup(rebalanceResult.map, s.id) || s.positionKey
      }));
      rebalancedSiblings.sort(CBF_POSKEYS.compareNodes);

      const n2 = CBF_POSKEYS.findNeighborsInSorted(rebalancedSiblings, insertAfterId);
      const computed2 = _computeNPositions(n2.prev, n2.next, n);
      if (computed2 === null) {
        return { ok: false, error: 'Rebalance failed to create space' };
      }
      for (const p of computed2) positions.push(p);
    } else {
      for (const p of computed) positions.push(p);
    }

    // ---------- 5. Build moves[] ----------
    const moves = [];
    for (let i = 0; i < n; i++) {
      const node = movingNodes[i];
      moves.push({
        id: node.id,
        oldParentId: node.parentId,
        oldPositionKey: node.positionKey,
        newParentId,
        newPositionKey: positions[i]
      });
    }

    // ---------- 6. affectedParents ----------
    const affectedSet = new Set([newParentId]);
    for (const node of movingNodes) {
      if (node.parentId !== newParentId) affectedSet.add(node.parentId);
    }

    // ---------- 7. Freeze ----------
    const targetGeneration = o.expectedGeneration + 1;
    const frozenPlan = _freezePlan({
      operationId: crypto.randomUUID(),
      commandId: o.commandId,
      expectedGeneration: o.expectedGeneration,
      targetGeneration,
      moves,
      affectedParents: Array.from(affectedSet),
      deletes: [],
      creates: [],
      metadataUpdate: {
        treeGeneration: targetGeneration,
        recordCount: o.recordCount   // move δεν αλλάζει recordCount
      },
      kind: 'move',
      rebalanceWrites
    });

    return { ok: true, plan: frozenPlan };
  }

  // ============================================================
  //  Reorder plan (same parent)
  // ============================================================
  function planReorder(itemsMap, id, targetId, position, opts) {
    if (position !== 'before' && position !== 'after') {
      return { ok: false, error: 'reorder position must be before|after' };
    }

    const o = _validateOpts(opts);
    if (!o.ok) return o;

    const node = itemsMap.get(id);
    if (!node) return { ok: false, error: 'Record not found' };

    const parentId = node.parentId;
    const siblings = _sortedChildren(itemsMap, parentId, new Set([id]));

    const idx = siblings.findIndex(s => s.id === targetId);
    if (idx === -1) {
      return { ok: false, error: 'Target not found among siblings' };
    }

    let insertAfterId;
    if (position === 'before') {
      insertAfterId = idx > 0 ? siblings[idx - 1].id : null;
    } else {
      insertAfterId = targetId;
    }

    const { prev, next } = CBF_POSKEYS.findNeighborsInSorted(siblings, insertAfterId);

    let newPosBig = CBF_POSKEYS.computePositionBetween(prev, next);
    let rebalanceWrites = [];

    if (newPosBig === null) {
      const rebalanceResult = _planRebalance(siblings);
      rebalanceWrites = rebalanceResult.rebalanced;

      const rebalancedSiblings = siblings.map(s => ({
        id: s.id,
        parentId: s.parentId,
        positionKey: _lookup(rebalanceResult.map, s.id) || s.positionKey
      }));
      rebalancedSiblings.sort(CBF_POSKEYS.compareNodes);

      const n2 = CBF_POSKEYS.findNeighborsInSorted(rebalancedSiblings, insertAfterId);
      newPosBig = CBF_POSKEYS.computePositionBetween(n2.prev, n2.next);
      if (newPosBig === null) {
        return { ok: false, error: 'Rebalance failed' };
      }
    }

    const newPositionKey = CBF_POSKEYS.toStored(newPosBig);
    const targetGeneration = o.expectedGeneration + 1;

    const frozenPlan = _freezePlan({
      operationId: crypto.randomUUID(),
      commandId: o.commandId,
      expectedGeneration: o.expectedGeneration,
      targetGeneration,
      moves: [{
        id: node.id,
        oldParentId: node.parentId,
        oldPositionKey: node.positionKey,
        newParentId: node.parentId,
        newPositionKey
      }],
      affectedParents: [parentId],
      deletes: [],
      creates: [],
      metadataUpdate: {
        treeGeneration: targetGeneration,
        recordCount: o.recordCount
      },
      kind: 'reorder',
      rebalanceWrites
    });

    return { ok: true, plan: frozenPlan };
  }

  // ============================================================
  //  Pure: calculateFinalOrder
  //
  //  Preview του τελικού tree order μετά το plan (για tests).
  // ============================================================
  function calculateFinalOrder(itemsMap, plan) {
    const working = new Map();
    for (const [id, node] of itemsMap) {
      working.set(id, {
        id: node.id,
        parentId: node.parentId,
        positionKey: node.positionKey
      });
    }

    const rebalanceWrites = Array.isArray(plan.rebalanceWrites) ? plan.rebalanceWrites : [];
    for (const rw of rebalanceWrites) {
      const w = working.get(rw.id);
      if (w) w.positionKey = rw.newPositionKey;
    }

    const moves = Array.isArray(plan.moves) ? plan.moves : [];
    for (const m of moves) {
      const w = working.get(m.id);
      if (w) {
        w.parentId = m.newParentId;
        w.positionKey = m.newPositionKey;
      }
    }

    const affected = Array.isArray(plan.affectedParents) ? plan.affectedParents : [];
    const result = new Map();
    for (const parentId of affected) {
      const children = [];
      for (const node of working.values()) {
        if (node.parentId === parentId) children.push(node);
      }
      children.sort((a, b) => {
        const pa = CBF_POSKEYS.fromStored(a.positionKey);
        const pb = CBF_POSKEYS.fromStored(b.positionKey);
        if (pa < pb) return -1;
        if (pa > pb) return 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      result.set(parentId, children.map(c => c.id));
    }

    return result;
  }

  // ============================================================
  //  Helpers
  // ============================================================
  function _validateOpts(opts) {
    if (!opts || typeof opts !== 'object') {
      return { ok: false, error: 'opts required' };
    }
    const { commandId, expectedGeneration, recordCount } = opts;
    if (typeof commandId !== 'string' || commandId.length === 0) {
      return { ok: false, error: 'opts.commandId required' };
    }
    if (typeof expectedGeneration !== 'number' ||
        !Number.isInteger(expectedGeneration) ||
        expectedGeneration < 0) {
      return { ok: false, error: 'opts.expectedGeneration must be non-negative integer' };
    }
    if (typeof recordCount !== 'number' ||
        !Number.isInteger(recordCount) ||
        recordCount < 0) {
      return { ok: false, error: 'opts.recordCount must be non-negative integer' };
    }
    return { ok: true, commandId, expectedGeneration, recordCount };
  }

  function _sortedChildren(itemsMap, parentId, excludeSet) {
    const out = [];
    for (const node of itemsMap.values()) {
      if (node.parentId === parentId && !excludeSet.has(node.id)) {
        out.push(node);
      }
    }
    out.sort(CBF_POSKEYS.compareNodes);
    return out;
  }

  function _computeNPositions(prevStored, nextStored, n) {
    const p = prevStored === null || prevStored === undefined
      ? null : CBF_POSKEYS.fromStored(prevStored);
    const nx = nextStored === null || nextStored === undefined
      ? null : CBF_POSKEYS.fromStored(nextStored);

    let start, end;
    if (p === null && nx === null) {
      start = 0n;
      end = CBF_POSKEYS.POSITION_STEP * BigInt(n + 1);
    } else if (p === null) {
      if (nx <= BigInt(n)) return null;
      start = 0n;
      end = nx;
    } else if (nx === null) {
      start = p;
      end = p + CBF_POSKEYS.POSITION_STEP * BigInt(n + 1);
    } else {
      if (nx - p <= BigInt(n)) return null;
      start = p;
      end = nx;
    }

    const gap = end - start;
    const step = gap / BigInt(n + 1);
    if (step < 1n) return null;

    const positions = [];
    for (let i = 1; i <= n; i++) {
      positions.push(CBF_POSKEYS.toStored(start + step * BigInt(i)));
    }
    return positions;
  }

  function _planRebalance(siblings) {
    const rebalanced = CBF_POSKEYS.computeRebalance(siblings);
    const map = {};
    for (const r of rebalanced) map[r.id] = r.newPositionKey;
    return { rebalanced, map };
  }

  function _lookup(map, id) {
    return map[id];
  }

  function _freezePlan(plan) {
    Object.freeze(plan.moves);
    for (const m of plan.moves) Object.freeze(m);
    Object.freeze(plan.rebalanceWrites);
    for (const r of plan.rebalanceWrites) Object.freeze(r);
    Object.freeze(plan.affectedParents);
    Object.freeze(plan.deletes);
    Object.freeze(plan.creates);
    Object.freeze(plan.metadataUpdate);
    return Object.freeze(plan);
  }

  const api = { plan, planReorder, calculateFinalOrder };

  if (typeof self !== 'undefined') self.CBF_MOVE_PLANNER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MOVE_PLANNER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Move Planner ready (MovePlan v3 + calculateFinalOrder)');
  }

  return api;
})();