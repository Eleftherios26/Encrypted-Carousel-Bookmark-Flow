/**
 * firefox-merge.js — Firefox merge coordinator (leaf)
 *
 * @path     overlay/drag_and_drop/firefox_drag_and_drop/firefox-merge.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Merge operations για Firefox space. Wraps τα
 *   CBF_BRIDGE.firefoxMerge / firefoxMergeFolders μέσω HMAC-signed port.
 *   Ίδια validation λογική με encrypted merge (canMerge*) για consistency.
 *
 * API
 *   • canMergeBookmarks(item1, item2)      — type check (bookmark + bookmark)
 *   • canMergeFolders(source, target)      — type check (folder + folder)
 *   • suggestMergedFolderName(t1, t2)      — auto-generated name
 *   • mergeBookmarks(item1Id, item2Id, folderName, parentId)
 *   • mergeFolders(sourceId, targetId)
 *
 * NON-OBVIOUS
 *   • Το module είναι leaf — ο ui-coordinator το καλεί ρητά (routing
 *     βάσει dragSpace).
 *   • Όλη η server-side logic (cycle checks, rollback) ζει στο
 *     background/firefox-dnd-service.js. Το leaf μόνο validate-άρει
 *     params + normalize-άρει errors.
 *   • Bridge method guard: αν λείπουν τα CBF_BRIDGE.firefoxMerge* →
 *     ρητό error αντί silent fail (C3-03 pattern).
 *
 * DECISIONS
 *   D-34, D-35
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "firefox-merge"
 */

var CBF_FIREFOX_MERGE = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:FF-Merge]', ...a); }
  function warn(...a) { console.warn('[ECBF:FF-Merge]', ...a); }

  // ============================================================
  //  Bridge availability check
  // ============================================================
  function _hasBridge() {
    return typeof CBF_BRIDGE !== 'undefined' &&
           typeof CBF_BRIDGE.firefoxMerge === 'function' &&
           typeof CBF_BRIDGE.firefoxMergeFolders === 'function';
  }

  function _bridgeMissingError() {
    warn('CBF_BRIDGE.firefoxMerge/MergeFolders not available — was bridge.js updated?');
    return {
      success: false,
      error: 'BRIDGE_MISSING_FIREFOX_MERGE_METHODS'
    };
  }

  // ============================================================
  //  Validation (ίδια λογική με encrypted merge)
  // ============================================================
  function canMergeBookmarks(item1, item2) {
    if (!item1 || !item2) return false;
    if (item1.type !== 'bookmark' || item2.type !== 'bookmark') return false;
    if (item1.id === item2.id) return false;
    return true;
  }

  function canMergeFolders(source, target) {
    if (!source || !target) return false;
    if (source.type !== 'folder' || target.type !== 'folder') return false;
    if (source.id === target.id) return false;
    return true;
  }

  function suggestMergedFolderName(title1, title2) {
    const t1 = (title1 || '').trim();
    const t2 = (title2 || '').trim();
    if (!t1 && !t2) return 'Merged Folder';
    if (!t1) return t2;
    if (!t2) return t1;
    const merged = `${t1} + ${t2}`;
    return merged.length > 200 ? merged.slice(0, 197) + '...' : merged;
  }

  // ============================================================
  //  mergeBookmarks
  //
  //  Δημιουργεί νέο folder στο parentId με 2 bookmarks μέσα.
  // ============================================================
  async function mergeBookmarks(item1Id, item2Id, folderName, parentId) {
    if (!item1Id || !item2Id || !folderName || !parentId) {
      return { success: false, error: 'MISSING_PARAMS' };
    }
    if (item1Id === item2Id) {
      return { success: false, error: 'SAME_ITEM' };
    }

    log(`mergeBookmarks: ${item1Id} + ${item2Id} → "${folderName}"`);

    if (!_hasBridge()) return _bridgeMissingError();

    try {
      const res = await CBF_BRIDGE.firefoxMerge({
        item1Id,
        item2Id,
        folderName,
        parentId
      });

      if (res && res.success) {
        return {
          success: true,
          id: res.result?.id,
          parentId,
          title: folderName
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('mergeBookmarks error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  mergeFolders
  //
  //  Δημιουργεί subfolder στο targetId με τα children του sourceId,
  //  μετά διαγράφει τον source.
  // ============================================================
  async function mergeFolders(sourceId, targetId) {
    if (!sourceId || !targetId) {
      return { success: false, error: 'MISSING_PARAMS' };
    }
    if (sourceId === targetId) {
      return { success: false, error: 'SAME_FOLDER' };
    }

    log(`mergeFolders: ${sourceId} → ${targetId}`);

    if (!_hasBridge()) return _bridgeMissingError();

    try {
      const res = await CBF_BRIDGE.firefoxMergeFolders({
        sourceId,
        targetId
      });

      if (res && res.success) {
        return {
          success: true,
          id: res.result?.id,
          parentId: targetId,
          title: res.result?.title
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('mergeFolders error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    canMergeBookmarks,
    canMergeFolders,
    suggestMergedFolderName,

    mergeBookmarks,
    mergeFolders,

    _internal: {
      _hasBridge
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_FIREFOX_MERGE = api;
  if (typeof self !== 'undefined') self.CBF_FIREFOX_MERGE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FIREFOX_MERGE = api;

  log('Ready (v12E)');
  return api;
})();