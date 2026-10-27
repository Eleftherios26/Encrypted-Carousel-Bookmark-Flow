/**
 * redistribution.js — Encrypted redistribution (bridge wrapper)
 *
 * @path     overlay/drag_and_drop/redistribution.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Thin bridge wrapper για encrypted space move/reorder operations.
 *   Καλεί CBF_BRIDGE για moveSingle / moveMulti / reorder.
 *
 *   Χρησιμοποιείται από ui-coordinator (encrypted space router).
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "redistribution"
 */

var CBF_REDISTRIBUTION = (function() {
  'use strict';

  function log(...a)  { console.log('[ECBF:Redistribution]', ...a); }
  function warn(...a) { console.warn('[ECBF:Redistribution]', ...a); }

  async function moveSingleItem(id, newParentId, position = 'inside', targetId = null) {
    if (!id || !newParentId) return { success: false, error: 'Invalid args' };
    log(`moveSingleItem: ${id} → ${newParentId} (${position})`);
    try {
      const res = await CBF_BRIDGE.moveSingle(id, newParentId, position, targetId);
      if (res && res.success) return { success: true, generation: res.generation, result: res.result };
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('moveSingleItem error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  async function moveMultipleItems(ids, newParentId, position = 'inside', targetId = null) {
    if (!Array.isArray(ids) || ids.length === 0) return { success: false, error: 'Invalid ids' };
    if (!newParentId) return { success: false, error: 'Invalid parent' };
    log(`moveMultipleItems: [${ids.join(',')}] → ${newParentId}`);
    try {
      const res = await CBF_BRIDGE.moveMulti(ids, newParentId, position, targetId);
      if (res && res.success) return { success: true, generation: res.generation, result: res.result };
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('moveMultipleItems error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  async function reorderItem(id, targetId, position) {
    if (!id || !targetId) return { success: false, error: 'Invalid args' };
    if (position !== 'before' && position !== 'after') return { success: false, error: 'Bad position' };
    log(`reorderItem: ${id} ${position} ${targetId}`);
    try {
      const res = await CBF_BRIDGE.reorder(id, targetId, position);
      if (res && res.success) return { success: true, generation: res.generation, result: res.result };
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('reorderItem error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  const api = { moveSingleItem, moveMultipleItems, reorderItem };

  if (typeof window !== 'undefined') window.CBF_REDISTRIBUTION = api;
  if (typeof self !== 'undefined') self.CBF_REDISTRIBUTION = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_REDISTRIBUTION = api;

  log('Ready (v12.0.0)');
  return api;
})();