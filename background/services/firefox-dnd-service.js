/**
 * firefox-dnd-service.js — Firefox space Drag & Drop service
 *
 * @path     background/services/firefox-dnd-service.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Firefox space D&D operations στο managed tree:
 *     • firefoxMove          — move bookmark/folder
 *     • firefoxReorder       — reorder σε ίδιο parent
 *     • firefoxMerge         — 2 bookmarks → νέος φάκελος
 *     • firefoxMergeFolders  — folder → subfolder του target
 *     • firefoxRemove        — recursive delete
 *     • firefoxCreate        — create bookmark/folder (Post-MVP)
 *     • firefoxRename        — rename bookmark/folder (V12E, D-53)
 *
 * KEY CONCEPTS
 *   • D-22: Managed root = 'toolbar_____' (via validator)
 *   • D-34: CAP_FIREFOX enforced από messaging layer
 *   • D-35: Validator enforcement (validateFirefox*)
 *   • D-43: Title truncation > 500 chars (M-17 consistency)
 *
 * NON-OBVIOUS
 *   • S-12: firefoxMerge descendant check με _isDescendantOf() — BFS
 *     με MAX_DESCENDANT_DEPTH = 100 (cycle-safe).
 *   • B-1/B-5: Rollback χρησιμοποιεί ORIGINAL INDEX (όχι 'inside')
 *     για να αποκαταστήσει τη σωστή σειρά.
 *   • B-6: Cache invalidation σε κάθε mutation + rollback.
 *   • D-53: firefoxRename uses validateFirefoxUpdate (ΟΧΙ Write) —
 *     το rename ΔΕΝ αλλάζει parentId.
 *
 * DECISIONS
 *   D-22, D-34, D-35, D-43, D-53
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "firefox-dnd-service"
 */

var CBF_FIREFOX_DND = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_TITLE_LENGTH = 500;
  const MAX_URL_LENGTH   = 2048;
  const MAX_DESCENDANT_DEPTH = 100;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)   { CBF_LOGGER.info('[FF-DND]', ...a); }
  function warn(...a)  { CBF_LOGGER.warn('[FF-DND]', ...a); }
  function err(...a)   { CBF_LOGGER.error('[FF-DND]', ...a); }
  function audit(...a) { CBF_LOGGER.security('[FF-DND]', ...a); }

  // ============================================================
  //  Helpers
  // ============================================================
  async function _getNode(id) {
    const nodes = await browser.bookmarks.get(id);
    if (!nodes || nodes.length === 0) throw new Error('NOT_FOUND: ' + id);
    return nodes[0];
  }

  async function _getChildren(parentId) {
    try {
      return await browser.bookmarks.getChildren(parentId);
    } catch (_) {
      return [];
    }
  }

  // ============================================================
  //  M-17: Title validation με truncation
  //
  //  ΠΡΙΝ: throw TITLE_TOO_LONG → merge αποτυγχάνει
  //  ΜΕΤΑ: truncate + warnings → merge συνεχίζει
  //
  //  Rationale (D-43):
  //    - Firefox επιτρέπει titles > 500 chars
  //    - Merge με long folderName δεν πρέπει να αποτυγχάνει
  //    - Consistent με cross-space-service.js (M-17)
  // ============================================================
  function _validateTitle(title, warnings = null) {
    if (typeof title !== 'string') throw new Error('TITLE_REQUIRED');
    if (title.trim().length === 0) throw new Error('TITLE_EMPTY');

    if (title.length > MAX_TITLE_LENGTH) {
      const truncated = title.slice(0, MAX_TITLE_LENGTH - 1) + '…';
      const preview = title.length > 40 ? title.slice(0, 40) + '…' : title;
      const msg = `Title truncated: ${title.length} → ${truncated.length} chars ("${preview}")`;

      warn(`M-17: ${msg}`);

      // M-20 consistency: Collect warning για UI feedback
      if (warnings && Array.isArray(warnings)) {
        warnings.push({
          type: 'TITLE_TRUNCATED',
          message: msg,
          originalLength: title.length,
          newLength: truncated.length,
          preview
        });
      }

      return truncated;
    }

    return title;
  }

  // ============================================================
  //  B-6: Cache invalidation helper
  // ============================================================
  function _invalidateValidatorCache() {
    if (typeof CBF_FIREFOX_VALIDATOR !== 'undefined' &&
        typeof CBF_FIREFOX_VALIDATOR.invalidateCache === 'function') {
      try {
        CBF_FIREFOX_VALIDATOR.invalidateCache();
      } catch (e) {
        warn('invalidateCache failed:', e.message);
      }
    }
  }

  // ============================================================
  //  S-12: Descendant check helper
  //
  //  BFS upward από nodeId προς root — cycle-safe με visited Set
  //  και depth limit (MAX_DESCENDANT_DEPTH = 100).
  // ============================================================
  async function _isDescendantOf(ancestorId, nodeId) {
    if (!ancestorId || !nodeId) return false;
    if (ancestorId === nodeId) return true;

    let cur = nodeId;
    const visited = new Set();
    let depth = 0;

    while (cur && depth++ < MAX_DESCENDANT_DEPTH) {
      if (visited.has(cur)) {
        warn(`Cycle detected in parent chain at ${cur}`);
        return false;
      }
      visited.add(cur);

      try {
        const n = await _getNode(cur);
        if (!n.parentId) return false;
        if (n.parentId === ancestorId) return true;
        cur = n.parentId;
      } catch (_) {
        return false;
      }
    }

    if (depth >= MAX_DESCENDANT_DEPTH) {
      warn(`Descendant check depth limit reached for ${nodeId}`);
    }

    return false;
  }

  // ============================================================
  //  firefoxMove
  //
  //  S-7: self-move noop + sourceIdx handling
  //  B-6: cache invalidation
  // ============================================================
  async function firefoxMove(id, newParentId, position = 'inside', targetId = null) {
    log(`firefoxMove: ${id} → ${newParentId} (${position})`);

    try {
      // S-7: Self-move check (no-op)
      if (id === targetId) {
        log(`firefoxMove: self-move detected (id === targetId) — noop`);
        return {
          success: true,
          result: { id, parentId: newParentId, noop: true },
          mutation: {
            type: 'moved',
            moves: [{ id, parentId: newParentId, noop: true }]
          }
        };
      }

      await CBF_FIREFOX_VALIDATOR.validateFirefoxMove({
        id,
        parentId: newParentId
      });

      const newParent = await _getNode(newParentId);
      if (newParent.type !== 'folder') {
        return { success: false, error: 'TARGET_NOT_FOLDER' };
      }

      const siblings = await _getChildren(newParentId);
      const sourceIdx = siblings.findIndex(s => s.id === id);
      let index;

      if (position === 'before' || position === 'after') {
        if (!targetId) {
          return { success: false, error: 'TARGET_REQUIRED_FOR_POSITION' };
        }
        const targetIdx = siblings.findIndex(s => s.id === targetId);
        if (targetIdx === -1) {
          return { success: false, error: 'TARGET_NOT_FOUND_IN_PARENT' };
        }

        let effIdx = targetIdx;
        if (sourceIdx !== -1 && sourceIdx < targetIdx) {
          effIdx = targetIdx - 1;
        }

        index = position === 'before' ? effIdx : effIdx + 1;
      } else {
        index = sourceIdx !== -1 ? siblings.length - 1 : siblings.length;
      }

      await browser.bookmarks.move(id, { parentId: newParentId, index });

      // B-6: Cache invalidation
      _invalidateValidatorCache();

      audit('FIREFOX_MOVE', { id, newParentId, index, position });

      return {
        success: true,
        result: { id, parentId: newParentId, index },
        mutation: {
          type: 'moved',
          moves: [{ id, parentId: newParentId, index }]
        }
      };
    } catch (e) {
      err('firefoxMove failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  firefoxReorder
  // ============================================================
  async function firefoxReorder(id, targetId, position) {
    log(`firefoxReorder: ${id} ${position} ${targetId}`);

    if (position !== 'before' && position !== 'after') {
      return { success: false, error: 'INVALID_POSITION' };
    }

    try {
      const node = await _getNode(id);
      const parentId = node.parentId;

      if (!parentId) {
        return { success: false, error: 'NO_PARENT' };
      }

      return await firefoxMove(id, parentId, position, targetId);
    } catch (e) {
      err('firefoxReorder failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  firefoxMerge (2 bookmarks → νέος φάκελος)
  //
  //  H-4: direct cycle check (parentId ∈ {item1, item2})
  //  S-12: descendant cycle check
  //  B-1: rollback με original index
  //  B-6: cache invalidation
  //  M-17: title truncate (folderName) + warnings στο result
  // ============================================================
  async function firefoxMerge(item1Id, item2Id, folderName, parentId) {
    log(`firefoxMerge: ${item1Id} + ${item2Id} → "${folderName}" in ${parentId}`);

    const warnings = [];   // M-17

    try {
      if (item1Id === item2Id) {
        return { success: false, error: 'SAME_ITEM' };
      }

      // H-4: Direct cycle check
      if (parentId === item1Id || parentId === item2Id) {
        audit('FIREFOX_MERGE_CYCLE_BLOCKED', {
          context: 'direct',
          item1Id, item2Id, parentId
        });
        return { success: false, error: 'PARENT_IS_SOURCE_ITEM' };
      }

      // S-12: Descendant cycle check
      const isDescendant1 = await _isDescendantOf(item1Id, parentId);
      if (isDescendant1) {
        audit('FIREFOX_MERGE_DESCENDANT_CYCLE', {
          context: 'item1',
          item1Id, item2Id, parentId
        });
        return { success: false, error: 'PARENT_IS_DESCENDANT_OF_SOURCE' };
      }

      const isDescendant2 = await _isDescendantOf(item2Id, parentId);
      if (isDescendant2) {
        audit('FIREFOX_MERGE_DESCENDANT_CYCLE', {
          context: 'item2',
          item1Id, item2Id, parentId
        });
        return { success: false, error: 'PARENT_IS_DESCENDANT_OF_SOURCE' };
      }

      // M-17: Validate + truncate folderName
      const safeFolderName = _validateTitle(folderName, warnings);

      await CBF_FIREFOX_VALIDATOR.validateFirefoxMove({ id: item1Id, parentId });
      await CBF_FIREFOX_VALIDATOR.validateFirefoxMove({ id: item2Id, parentId });

      const item1Before = await _getNode(item1Id);
      const item2Before = await _getNode(item2Id);

      let newFolder = null;
      let item1Moved = false;
      let item2Moved = false;

      try {
        newFolder = await browser.bookmarks.create({
          parentId,
          title: safeFolderName
        });

        await browser.bookmarks.move(item1Id, {
          parentId: newFolder.id,
          index: 0
        });
        item1Moved = true;

        await browser.bookmarks.move(item2Id, {
          parentId: newFolder.id,
          index: 1
        });
        item2Moved = true;

        // B-6: Cache invalidation
        _invalidateValidatorCache();

        audit('FIREFOX_MERGE', {
          item1Id, item2Id,
          newFolderId: newFolder.id,
          warningCount: warnings.length
        });

        return {
          success: true,
          result: {
            id: newFolder.id,
            parentId,
            title: newFolder.title
          },
          warnings,   // M-17
          mutation: {
            type: 'created',
            node: {
              id: newFolder.id,
              parentId,
              type: 'folder',
              title: newFolder.title
            }
          }
        };
      } catch (e) {
        err('firefoxMerge inner failure:', e.message);

        try {
          // B-1: rollback με original index
          if (item2Moved) {
            await browser.bookmarks.move(item2Id, {
              parentId: item2Before.parentId,
              index: item2Before.index
            });
          }
          if (item1Moved) {
            await browser.bookmarks.move(item1Id, {
              parentId: item1Before.parentId,
              index: item1Before.index
            });
          }
          if (newFolder) {
            await browser.bookmarks.remove(newFolder.id);
          }

          // B-6: Cache invalidation και στο rollback
          _invalidateValidatorCache();
        } catch (rbErr) {
          audit('ROLLBACK_FAILED', {
            context: 'firefoxMerge',
            error: rbErr.message,
            item1Id, item2Id,
            newFolderId: newFolder ? newFolder.id : null
          });
        }

        return { success: false, error: e.message };
      }
    } catch (e) {
      err('firefoxMerge failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  firefoxMergeFolders (source folder → subfolder)
  //
  //  B-5: rollback με original index
  //  B-6: cache invalidation
  //  M-17: warnings propagation
  // ============================================================
  async function firefoxMergeFolders(sourceId, targetId) {
    log(`firefoxMergeFolders: ${sourceId} → ${targetId}`);

    const warnings = [];   // M-17 (consistency)

    try {
      const source = await _getNode(sourceId);
      const target = await _getNode(targetId);

      if (source.type !== 'folder') {
        return { success: false, error: 'SOURCE_NOT_FOLDER' };
      }
      if (target.type !== 'folder') {
        return { success: false, error: 'TARGET_NOT_FOLDER' };
      }
      if (sourceId === targetId) {
        return { success: false, error: 'SAME_FOLDER' };
      }

      // Cycle check
      let cur = targetId;
      const visited = new Set();
      while (cur && !visited.has(cur)) {
        if (cur === sourceId) {
          audit('FIREFOX_MERGE_FOLDERS_CYCLE', { sourceId, targetId });
          return { success: false, error: 'CYCLE' };
        }
        visited.add(cur);
        try {
          const n = await _getNode(cur);
          cur = n.parentId;
        } catch (_) {
          break;
        }
      }

      await CBF_FIREFOX_VALIDATOR.validateFirefoxMove({
        id: sourceId,
        parentId: targetId
      });

      let newFolder = null;
      const movedChildren = [];

      try {
        // M-17: Validate + truncate source.title για νέο folder
        const safeTitle = _validateTitle(source.title || 'Merged', warnings);

        newFolder = await browser.bookmarks.create({
          parentId: targetId,
          title: safeTitle
        });

        const children = await _getChildren(sourceId);

        for (let i = 0; i < children.length; i++) {
          const child = children[i];

          // B-5: capture original index
          const originalIndex = (typeof child.index === 'number')
            ? child.index
            : i;

          try {
            await browser.bookmarks.move(child.id, {
              parentId: newFolder.id,
              index: i
            });
            movedChildren.push({
              id: child.id,
              originalIndex
            });
          } catch (e) {
            throw new Error('MOVE_CHILD_FAILED at ' + i + ': ' + e.message);
          }
        }

        await browser.bookmarks.remove(sourceId);

        // B-6: Cache invalidation
        _invalidateValidatorCache();

        audit('FIREFOX_MERGE_FOLDERS', {
          sourceId, targetId,
          newFolderId: newFolder.id,
          childCount: movedChildren.length,
          warningCount: warnings.length
        });

        return {
          success: true,
          result: {
            id: newFolder.id,
            parentId: targetId,
            title: newFolder.title,
            childCount: movedChildren.length
          },
          warnings,   // M-17
          mutation: {
            type: 'created',
            node: {
              id: newFolder.id,
              parentId: targetId,
              type: 'folder',
              title: newFolder.title
            }
          }
        };
      } catch (e) {
        err('firefoxMergeFolders inner failure:', e.message);

        try {
          // B-5: rollback με original index (αντίστροφα)
          for (let i = movedChildren.length - 1; i >= 0; i--) {
            const { id: childId, originalIndex } = movedChildren[i];
            try {
              await browser.bookmarks.move(childId, {
                parentId: sourceId,
                index: originalIndex
              });
            } catch (_) {}
          }

          if (newFolder) {
            try {
              await browser.bookmarks.remove(newFolder.id);
            } catch (_) {}
          }

          // B-6: Cache invalidation και στο rollback
          _invalidateValidatorCache();
        } catch (rbErr) {
          audit('ROLLBACK_FAILED', {
            context: 'firefoxMergeFolders',
            error: rbErr.message,
            sourceId, targetId,
            newFolderId: newFolder ? newFolder.id : null,
            movedChildrenCount: movedChildren.length
          });
        }

        return { success: false, error: e.message };
      }
    } catch (e) {
      err('firefoxMergeFolders failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  firefoxRemove (recursive για folders)
  // ============================================================
  async function firefoxRemove(id) {
    log(`firefoxRemove: ${id}`);

    try {
      await CBF_FIREFOX_VALIDATOR.validateFirefoxRemove({ id });

      const node = await _getNode(id);

      if (node.type === 'folder') {
        await browser.bookmarks.removeTree(id);
      } else {
        await browser.bookmarks.remove(id);
      }

      // B-6: Cache invalidation
      _invalidateValidatorCache();

      audit('FIREFOX_REMOVE', { id, type: node.type });

      return {
        success: true,
        result: { id, type: node.type },
        mutation: {
          type: 'deleted',
          node: { id }
        }
      };
    } catch (e) {
      err('firefoxRemove failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  firefoxCreate (Post-MVP — Add Bookmark / Add Folder)
  // ============================================================
  async function firefoxCreate(parentId, type, title, url = null) {
    log(`firefoxCreate: type=${type} parent=${parentId}`);

    try {
      if (type !== 'bookmark' && type !== 'folder') {
        return { success: false, error: 'INVALID_TYPE' };
      }

      // H-1 + D-35: Validator enforcement
      await CBF_FIREFOX_VALIDATOR.validateFirefoxWrite({
        parentId,
        type,
        title,
        url: type === 'bookmark' ? url : null
      });

      // Parent check
      const parent = await _getNode(parentId);
      if (parent.type !== 'folder') {
        return { success: false, error: 'PARENT_NOT_FOLDER' };
      }

      // Create
      const payload = { parentId, title };
      if (type === 'bookmark') payload.url = url;

      const created = await browser.bookmarks.create(payload);

      // B-6: Cache invalidation
      _invalidateValidatorCache();

      audit('FIREFOX_CREATE', {
        id: created.id,
        type,
        parentId
      });

      return {
        success: true,
        result: {
          id: created.id,
          parentId: created.parentId,
          type: created.type,
          title: created.title,
          url: created.url || null
        },
        mutation: {
          type: 'created',
          node: {
            id: created.id,
            parentId: created.parentId,
            type: created.type,
            title: created.title || '',
            url: created.url || null
          }
        }
      };
    } catch (e) {
      err('firefoxCreate failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  D-53: firefoxRename (V12E)
  //
  //  Μετονομάζει bookmark/folder στο managed Firefox tree.
  //
  //  COMPLIANCE:
  //    • CAP_FIREFOX (D-34) — enforced από messaging
  //    • validateFirefoxUpdate (D-35) — ΟΧΙ Write (δεν αλλάζει parentId)
  //    • Rate limiting (D-30) — firefoxRename: 30/sec
  //    • Cache invalidation (B-6)
  //    • No-op detection
  //
  //  Rationale:
  //    Consistency με encrypted rename. No-op check αποφεύγει
  //    περιττό browser.bookmarks.update() call + mutation broadcast.
  // ============================================================
  async function firefoxRename(id, newTitle) {
    log(`firefoxRename: ${id.slice(0, 8)} → "${String(newTitle).slice(0, 30)}"`);

    try {
      // Basic validation
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'ID_REQUIRED' };
      }
      if (typeof newTitle !== 'string') {
        return { success: false, error: 'TITLE_REQUIRED' };
      }
      if (newTitle.trim().length === 0) {
        return { success: false, error: 'TITLE_EMPTY' };
      }

      // M-17: title truncation
      const safeTitle = _validateTitle(newTitle);

      // Get old node (για mutation payload + no-op detection)
      const oldNode = await _getNode(id);
      const oldTitle = oldNode.title || '';

      // No-op check
      if (oldTitle === safeTitle) {
        log(`firefoxRename: no-op (title unchanged)`);
        return {
          success: true,
          result: {
            id,
            title: safeTitle,
            type: oldNode.type,
            noop: true
          },
          mutation: null
        };
      }

      // H-1 + D-35: Validator enforcement
      await CBF_FIREFOX_VALIDATOR.validateFirefoxUpdate({
        id,
        title: safeTitle
      });

      // Update
      await browser.bookmarks.update(id, { title: safeTitle });

      // B-6: Cache invalidation
      _invalidateValidatorCache();

      // Audit
      audit('FIREFOX_RENAME', {
        id,
        oldTitle: oldTitle.slice(0, 40),
        newTitle: safeTitle.slice(0, 40)
      });

      return {
        success: true,
        result: {
          id,
          title: safeTitle,
          type: oldNode.type
        },
        mutation: {
          type: 'updated',
          node: {
            id,
            title: safeTitle,
            parentId: oldNode.parentId,
            type: oldNode.type,
            url: oldNode.url || null
          }
        }
      };
    } catch (e) {
      err('firefoxRename failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    firefoxMove,
    firefoxReorder,
    firefoxMerge,
    firefoxMergeFolders,
    firefoxRemove,
    firefoxCreate,
    firefoxRename,

    _internal: {
      _getNode,
      _getChildren,
      _validateTitle,
      _invalidateValidatorCache,
      _isDescendantOf,

      // Aliases για consistency με architecture doc
      firefoxCreate,
      firefoxRename,

      MAX_DESCENDANT_DEPTH,
      MAX_TITLE_LENGTH,
      MAX_URL_LENGTH
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_FIREFOX_DND = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FIREFOX_DND = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Firefox DnD Service ready ' +
      '(v12E: S-7 S-12 + H-4 B-1 B-5 B-6 + M-17 truncate + ' +
      'firefoxCreate + firefoxRename D-53)'
    );
  }

  return api;
})();