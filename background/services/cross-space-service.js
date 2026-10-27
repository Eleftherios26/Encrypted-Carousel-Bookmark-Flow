/**
 * cross-space-service.js — Cross-space transfer engine (2-phase best-effort)
 *
 * @path     background/services/cross-space-service.js
 * @version  12.3.0
 * @since    v12E / v12.3E
 *
 * PURPOSE
 *   Αμφίδρομη μεταφορά bookmarks/folders μεταξύ Firefox ↔ Encrypted.
 *   Χρησιμοποιεί 2-phase best-effort:
 *     Phase 1: Create copy στο target space
 *     Phase 2: Delete original από source space (με rollback σε αποτυχία)
 *
 * KEY CONCEPTS
 *   • D-35: Validator enforcement — όλα τα Firefox writes περνούν από
 *     CBF_FIREFOX_VALIDATOR (H-1)
 *   • D-36: Non-atomic. 2 transactions με rollback semantics
 *   • C3-SEC-03: Phase 2 re-validation πριν το remove — race protection
 *   • S-14 + D-39: Scan limits (MAX_DEPTH=20, MAX_ITEMS=5000)
 *   • H-05: STALE_GENERATION retry loop (max 3)
 *   • M-19: Inflight deduplication (Map<transferId, Promise>)
 *   • L-1: Failed transfers NOT cached (retry allowed)
 *   • M-20: Warnings propagation για truncations
 *
 * NON-OBVIOUS
 *   • C3-SEC-03: Phase 2 re-validation εκτελείται ΜΟΝΟ στα
 *     moveToEncrypted / moveFolderToEncrypted. Στα moveToFirefox η
 *     Phase 2 είναι encrypted delete (_seqDelete) → δεν χρειάζεται
 *     Firefox validator.
 *   • L-2: "not found" error σε delete → treated ως ALREADY_APPLIED
 *     (idempotent rollback).
 *   • Rollback best-effort: δεν αποκαθιστά το index εντός parent
 *     (το getPath δεν επιστρέφει index).
 *
 * DECISIONS
 *   D-18, D-20, D-22, D-34, D-35, D-36, D-39, D-45, D-48
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — LOG NOISE REDUCTION
 *   ══════════════════════════════════════════════════════════════════════
 *   FIX-5a (LOW): _seqDelete log cleanup
 *
 *     ΠΡΟΒΛΗΜΑ (από logs):
 *       Το _seqDelete λογάρει πάντα:
 *         "_seqDelete attempt 1/3: id=XXXX expectedGen=YY"
 *       Ακόμα και όταν επιτυγχάνει στην 1η προσπάθεια (συνηθισμένη
 *       περίπτωση — 99%+ των κλήσεων). Log noise σε κάθε transfer.
 *
 *     ΛΥΣΗ:
 *       • attempt === 1 → log('_seqDelete: id=XXXX expectedGen=YY')
 *       • attempt > 1  → log('_seqDelete retry N/3: id=... expectedGen=...')
 *
 *   FIX-5b (LOW): _seqCreate log cleanup (consistency)
 *
 *     Ίδιο pattern με το _seqDelete. Λόγος: consistency σε όλο το
 *     module. Τα πραγματικά retries ξεχωρίζουν (word "retry") από
 *     τα first-try attempts.
 *
 *     Impact: Cleaner logs σε bulk transfers (π.χ. folder με 100 items
 *     → 100 first-try logs αντί για 100 "attempt 1/3" logs).
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.0.0 → 12.3.0
 *     • @since v12E → v12E / v12.3E
 *     • Init log string: v12.3E
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "cross-space-service"
 */

var CBF_CROSS_SPACE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const RAM_TTL_MS = 10 * 60 * 1000;
  const MAX_TITLE_LENGTH = 500;
  const MAX_URL_LENGTH = 2048;

  // S-14: Scan limits
  const MAX_SCAN_DEPTH = 20;
  const MAX_SCAN_ITEMS = 5000;

  // H-05: Retry limits
  const MAX_STALE_RETRIES = 3;

  // ============================================================
  //  State
  // ============================================================

  // L-1: Only successful transfers cached
  const transferCache = new Map();

  // M-19: Inflight: transferId → Promise
  const _inflightTransfers = new Map();

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)   { CBF_LOGGER.info('[X-SPACE]', ...a); }
  function warn(...a)  { CBF_LOGGER.warn('[X-SPACE]', ...a); }
  function err(...a)   { CBF_LOGGER.error('[X-SPACE]', ...a); }
  function audit(...a) { CBF_LOGGER.security('[X-SPACE]', ...a); }

  // ============================================================
  //  Cache helpers
  // ============================================================
  function _cacheCheck(transferId) {
    const e = transferCache.get(transferId);
    if (!e) return null;
    if (Date.now() - e.timestamp > RAM_TTL_MS) {
      transferCache.delete(transferId);
      return null;
    }
    return e.result;
  }

  // L-1: Cache μόνο successful transfers
  function _cacheStore(transferId, result) {
    if (!result || result.success !== true) {
      log(`L-1: NOT caching failed transfer ${transferId.slice(0, 8)} (retry allowed)`);
      return;
    }
    transferCache.set(transferId, { result, timestamp: Date.now() });
    log(`Cache stored: ${transferId.slice(0, 8)} (success)`);
  }

  // Cache cleanup interval
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, e] of transferCache.entries()) {
      if (now - e.timestamp > RAM_TTL_MS) {
        transferCache.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log(`Cache cleanup: ${cleaned} expired entries removed`);
    }
  }, 60 * 1000);

  // ============================================================
  //  Helpers
  // ============================================================
  function _getStoreKeyOrThrow() {
    const sk = CBF_ES._internal.getStoreKey();
    if (!sk) throw new Error('Vault is locked');
    return sk;
  }

  // M-17 + M-20: Title validation με truncation + warnings
  function _validateTitle(t, warnings = null) {
    if (typeof t !== 'string') throw new Error('title must be string');

    if (t.length > MAX_TITLE_LENGTH) {
      const truncated = t.slice(0, MAX_TITLE_LENGTH - 1) + '…';
      const originalPreview = t.length > 40 ? t.slice(0, 40) + '…' : t;
      const msg = `Title truncated: ${t.length} → ${truncated.length} chars ("${originalPreview}")`;

      warn(`M-17: ${msg}`);

      // M-20: Collect warning για UI feedback
      if (warnings && Array.isArray(warnings)) {
        warnings.push({
          type: 'TITLE_TRUNCATED',
          message: msg,
          originalLength: t.length,
          newLength: truncated.length,
          preview: originalPreview
        });
      }

      return truncated;
    }

    return t;
  }

  // M-18: URL validation (NO truncation)
  function _validateUrl(url, required) {
    if (!required && (url === null || url === undefined || url === '')) return null;
    if (typeof url !== 'string') throw new Error('url must be string');

    if (url.length > MAX_URL_LENGTH) {
      throw new Error(
        `url too long: ${url.length} > ${MAX_URL_LENGTH} chars ` +
        `(URLs cannot be truncated safely)`
      );
    }

    if (!/^https?:\/\//i.test(url)) {
      throw new Error('url must be http(s)');
    }

    return url;
  }

  // H-2: Managed root
  function _getManagedRoot() {
    if (typeof CBF_FIREFOX_VALIDATOR !== 'undefined' &&
        typeof CBF_FIREFOX_VALIDATOR.getManagedRoot === 'function') {
      return CBF_FIREFOX_VALIDATOR.getManagedRoot();
    }
    return 'toolbar_____';
  }

  // H-1: Validator wrappers
  async function _validateFirefoxRemove(id) {
    if (typeof CBF_FIREFOX_VALIDATOR === 'undefined') {
      warn('H-1: CBF_FIREFOX_VALIDATOR not available — validation SKIPPED');
      return;
    }
    await CBF_FIREFOX_VALIDATOR.validateFirefoxRemove({ id });
  }

  async function _validateFirefoxWrite(record) {
    if (typeof CBF_FIREFOX_VALIDATOR === 'undefined') {
      warn('H-1: CBF_FIREFOX_VALIDATOR not available — validation SKIPPED');
      return;
    }
    await CBF_FIREFOX_VALIDATOR.validateFirefoxWrite(record);
  }

  // ============================================================
  //  M-19: Inflight deduplication wrapper
  // ============================================================
  async function _withInflight(transferId, fn) {
    // Inflight hit
    if (_inflightTransfers.has(transferId)) {
      log(`M-19: transfer ${transferId.slice(0, 8)} already in flight — awaiting existing`);
      try {
        return await _inflightTransfers.get(transferId);
      } catch (e) {
        return {
          success: false,
          error: 'INFLIGHT_FAILED: ' + (e?.message || 'unknown')
        };
      }
    }

    // Create inflight promise
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        _inflightTransfers.delete(transferId);
      }
    })();

    _inflightTransfers.set(transferId, promise);

    try {
      return await promise;
    } catch (e) {
      err(`M-19: inflight ${transferId.slice(0, 8)} failed:`, e.message);
      return {
        success: false,
        error: 'INFLIGHT_FAILED: ' + e.message
      };
    }
  }

  // ============================================================
  //  H-05: Seq helpers με STALE_GENERATION retry loop
  // ============================================================

  // ─────────────────────────────────────────────────────────────
  //  🔧 v12.3.0 FIX-5b: Log noise reduction (consistency με _seqDelete)
  //
  //  Πριν: log('_seqCreate attempt 1/3: ...') πάντα
  //  Μετά: attempt === 1 → log('_seqCreate: ...')
  //        attempt >  1 → log('_seqCreate retry N/3: ...')
  //
  //  Rationale: Σε bulk transfers (π.χ. folder με 100 items), τα 100
  //  first-try logs γέμιζαν το console με "attempt 1/3" χωρίς λόγο.
  //  Τα πραγματικά retries ξεχωρίζουν (word "retry").
  // ─────────────────────────────────────────────────────────────
  async function _seqCreate(parentId, type, title, url, insertAfterId = null, warnings = null) {
    let attempt = 0;

    while (attempt < MAX_STALE_RETRIES) {
      attempt++;

      const commandId = crypto.randomUUID();
      const expectedGeneration = CBF_PROJECTION.getGeneration();

      // 🔧 v12.3.0 FIX-5b: log μόνο σε retry για το attempt counter
      if (attempt === 1) {
        log(
          `_seqCreate: parent=${parentId.slice(0, 8)} type=${type} ` +
          `insertAfter=${insertAfterId ? insertAfterId.slice(0, 8) : 'null'} ` +
          `expectedGen=${expectedGeneration}`
        );
      } else {
        log(
          `_seqCreate retry ${attempt}/${MAX_STALE_RETRIES}: ` +
          `parent=${parentId.slice(0, 8)} type=${type} ` +
          `insertAfter=${insertAfterId ? insertAfterId.slice(0, 8) : 'null'} ` +
          `expectedGen=${expectedGeneration}`
        );
      }

      const outcome = await CBF_SEQUENCER.execute({
        commandId,
        expectedGeneration,
        command: 'create',
        payload: {
          parentId,
          type,
          title,
          url: url || null,
          insertAfterId
        },
        storeKey: _getStoreKeyOrThrow()
      });

      // H-05: STALE_GENERATION → sync + retry
      if (outcome && outcome.status === 'STALE_GENERATION') {
        const currentGen = outcome.currentGeneration;

        warn(
          `H-05: STALE_GENERATION on _seqCreate attempt ${attempt} — ` +
          `syncing generation to ${currentGen}`
        );

        if (typeof currentGen === 'number' && currentGen >= 0) {
          CBF_PROJECTION.setGeneration(currentGen);
        }

        if (attempt >= MAX_STALE_RETRIES) {
          err(`H-05: _seqCreate EXHAUSTED ${MAX_STALE_RETRIES} retries — giving up`);
          return outcome;
        }

        continue;
      }

      // B-3: handle OK + ALREADY_APPLIED
      if (outcome && (outcome.status === 'OK' || outcome.status === 'ALREADY_APPLIED')) {
        if (typeof outcome.generation === 'number') {
          CBF_PROJECTION.setGeneration(outcome.generation);
          log(`_seqCreate ${outcome.status}: gen → ${outcome.generation} (attempt ${attempt})`);
        }
      }

      // applyMutation μόνο στο OK
      if (outcome && outcome.status === 'OK' && outcome.result && outcome.result.id) {
        try {
          CBF_PROJECTION.applyMutation({
            type: 'created',
            node: {
              id: outcome.result.id,
              parentId: outcome.result.parentId,
              positionKey: outcome.result.positionKey,
              type: outcome.result.type,
              title: outcome.result.title,
              url: outcome.result.url
            }
          });
        } catch (projErr) {
          warn('_seqCreate: applyMutation failed:', projErr.message);
        }
      }

      return outcome;
    }

    return { status: 'ERROR', error: 'H-05: retry loop exited unexpectedly' };
  }

  // ─────────────────────────────────────────────────────────────
  //  🔧 v12.3.0 FIX-5a: Log noise reduction
  //
  //  Ίδιο pattern με _seqCreate (FIX-5b). 99%+ των κλήσεων πετυχαίνουν
  //  στην 1η προσπάθεια → το "attempt 1/3" ήταν παραπλανητικό.
  // ─────────────────────────────────────────────────────────────
  async function _seqDelete(id, expectedGeneration) {
    let attempt = 0;

    while (attempt < MAX_STALE_RETRIES) {
      attempt++;

      const commandId = crypto.randomUUID();
      const expectedGen = CBF_PROJECTION.getGeneration();

      // 🔧 v12.3.0 FIX-5a: log μόνο σε retry για το attempt counter
      if (attempt === 1) {
        log(`_seqDelete: id=${id.slice(0, 8)} expectedGen=${expectedGen}`);
      } else {
        log(`_seqDelete retry ${attempt}/${MAX_STALE_RETRIES}: id=${id.slice(0, 8)} expectedGen=${expectedGen}`);
      }

      const outcome = await CBF_SEQUENCER.execute({
        commandId,
        expectedGeneration: expectedGen,
        command: 'delete',
        payload: { id },
        storeKey: _getStoreKeyOrThrow()
      });

      // H-05: STALE retry
      if (outcome && outcome.status === 'STALE_GENERATION') {
        warn(`H-05: STALE on _seqDelete attempt ${attempt} — syncing gen to ${outcome.currentGeneration}`);
        if (typeof outcome.currentGeneration === 'number' && outcome.currentGeneration >= 0) {
          CBF_PROJECTION.setGeneration(outcome.currentGeneration);
        }
        if (attempt >= MAX_STALE_RETRIES) {
          err(`H-05: _seqDelete EXHAUSTED retries`);
          return outcome;
        }
        continue;
      }

      // L-2: "not found" → ALREADY_APPLIED (idempotent rollback)
      if (outcome && outcome.status === 'ERROR') {
        const errMsg = outcome.error || '';
        if (/not found/i.test(errMsg) || /record not found/i.test(errMsg)) {
          log(`L-2: _seqDelete(${id.slice(0, 8)}) → already deleted, treating as ALREADY_APPLIED`);
          return {
            status: 'ALREADY_APPLIED',
            generation: expectedGeneration
          };
        }
      }

      // B-3: handle OK + ALREADY_APPLIED
      if (outcome && (outcome.status === 'OK' || outcome.status === 'ALREADY_APPLIED')) {
        if (typeof outcome.generation === 'number') {
          CBF_PROJECTION.setGeneration(outcome.generation);
        }
      }

      if (outcome && outcome.status === 'OK') {
        const deletedIds = Array.isArray(outcome.result?.deletedIds)
          ? outcome.result.deletedIds
          : [id];
        for (const delId of deletedIds) {
          try {
            CBF_PROJECTION.applyMutation({
              type: 'deleted',
              node: { id: delId }
            });
          } catch (projErr) {
            warn('_seqDelete: applyMutation failed:', projErr.message);
          }
        }
      }

      return outcome;
    }

    return { status: 'ERROR', error: 'H-05: retry loop exited unexpectedly' };
  }

  // ============================================================
  //  Firefox helpers
  // ============================================================
  async function _ffGet(id) {
    const nodes = await browser.bookmarks.get(id);
    if (!nodes || nodes.length === 0) throw new Error('Firefox item not found');
    return nodes[0];
  }

  async function _ffChildren(id) {
    try {
      return await browser.bookmarks.getChildren(id);
    } catch (_) {
      return [];
    }
  }

  // ============================================================
  //  L-06: Shared subtree walker
  // ============================================================
  async function _walkSubtree(rootNode, visitor, opts = {}) {
    const maxDepth = opts.maxDepth ?? MAX_SCAN_DEPTH;
    const maxItems = opts.maxItems ?? MAX_SCAN_ITEMS;

    let scanned = 0;
    let maxDepthReached = 0;

    async function walk(node, depth = 0) {
      if (depth > maxDepth) {
        warn(`L-06: depth limit (${maxDepth}) reached at ${node.id.slice(0, 8)}`);
        throw new Error('SCAN_DEPTH_EXCEEDED');
      }
      if (depth > maxDepthReached) maxDepthReached = depth;

      if (scanned++ >= maxItems) {
        warn(`L-06: item limit (${maxItems}) reached`);
        throw new Error('SCAN_ITEM_LIMIT_EXCEEDED');
      }

      await visitor(node, depth);

      if (node.type === 'folder') {
        const children = await _ffChildren(node.id);
        for (const c of children) {
          await walk(c, depth + 1);
        }
      }
    }

    await walk(rootNode, 0);

    return { scanned, maxDepthReached };
  }

  // ============================================================
  //  S-14 + L-06: Pre-scan subtree για invalid URLs
  // ============================================================
  async function _scanInvalidBookmarks(ffNode) {
    const invalid = [];

    try {
      const stats = await _walkSubtree(ffNode, async (node) => {
        if (node.type === 'bookmark') {
          try {
            _validateUrl(node.url, true);
          } catch (e) {
            invalid.push({
              id: node.id,
              url: node.url || null,
              reason: e.message
            });
          }
        }
      });

      log(
        `Scan complete: ${stats.scanned} items scanned, ` +
        `${invalid.length} invalid, depth=${stats.maxDepthReached}`
      );
    } catch (e) {
      if (e.message === 'SCAN_DEPTH_EXCEEDED' || e.message === 'SCAN_ITEM_LIMIT_EXCEEDED') {
        log(`Scan aborted: ${e.message}`);
      }
      throw e;
    }

    return invalid;
  }

  // ============================================================
  //  C-2 + M-20: Recursive copy Firefox → Encrypted
  // ============================================================
  async function _copyFfNodeToEncrypted(
    ffNode,
    encryptedParentId,
    createdIds,
    skipped,
    depth = 0,
    lastCreatedSiblingId = null,
    warnings = null
  ) {
    // S-14: Depth guard
    if (depth > MAX_SCAN_DEPTH) {
      throw new Error('COPY_DEPTH_EXCEEDED');
    }

    if (ffNode.type === 'folder') {
      const title = _validateTitle(ffNode.title || '', warnings);

      const res = await _seqCreate(
        encryptedParentId, 'folder',
        title, null,
        lastCreatedSiblingId,
        warnings
      );
      if (res.status !== 'OK' && res.status !== 'ALREADY_APPLIED') {
        throw new Error('Sequencer create (folder) failed: ' + (res.error || res.status));
      }
      if (!res.result || !res.result.id) {
        throw new Error('Sequencer create (folder) returned no id: ' + res.status);
      }
      const newFolderId = res.result.id;
      createdIds.push(newFolderId);

      const children = await _ffChildren(ffNode.id);
      let lastChildId = null;

      for (const child of children) {
        const newChildId = await _copyFfNodeToEncrypted(
          child,
          newFolderId,
          createdIds,
          skipped,
          depth + 1,
          lastChildId,
          warnings
        );
        if (newChildId) {
          lastChildId = newChildId;
        }
      }
      return newFolderId;
    }

    if (ffNode.type === 'bookmark') {
      let safeUrl;
      try {
        safeUrl = _validateUrl(ffNode.url, true);
      } catch (e) {
        warn(`Skipping bookmark ${ffNode.id.slice(0, 8)} (invalid URL: ${e.message})`);
        if (skipped) {
          skipped.push({ id: ffNode.id, url: ffNode.url || null, reason: e.message });
        }
        return null;
      }

      const title = _validateTitle(ffNode.title || '', warnings);

      const res = await _seqCreate(
        encryptedParentId, 'bookmark',
        title, safeUrl,
        lastCreatedSiblingId,
        warnings
      );
      if (res.status !== 'OK' && res.status !== 'ALREADY_APPLIED') {
        throw new Error('Sequencer create (bookmark) failed: ' + (res.error || res.status));
      }
      if (!res.result || !res.result.id) {
        throw new Error('Sequencer create (bookmark) returned no id: ' + res.status);
      }
      const newId = res.result.id;
      createdIds.push(newId);
      return newId;
    }

    return null;
  }

  // ============================================================
  //  Recursive copy Encrypted → Firefox
  // ============================================================
  async function _copyEncNodeToFirefox(encNodeId, ffParentId, createdIds, depth = 0, warnings = null) {
    if (depth > MAX_SCAN_DEPTH) {
      throw new Error('COPY_DEPTH_EXCEEDED');
    }

    const node = CBF_PROJECTION.getItem(encNodeId);
    if (!node) throw new Error('Encrypted node not found: ' + encNodeId);

    if (node.type === 'folder') {
      await _validateFirefoxWrite({
        parentId: ffParentId,
        type: 'folder',
        title: node.title || 'Folder',
        url: null
      });

      const created = await browser.bookmarks.create({
        parentId: ffParentId,
        title: node.title || 'Folder'
      });
      createdIds.push(created.id);

      const children = CBF_PROJECTION.getChildren(encNodeId);
      for (const child of children) {
        await _copyEncNodeToFirefox(child.id, created.id, createdIds, depth + 1, warnings);
      }
      return created.id;
    }

    if (node.type === 'bookmark') {
      if (!node.url) throw new Error('Bookmark has no url');

      await _validateFirefoxWrite({
        parentId: ffParentId,
        type: 'bookmark',
        title: node.title || '',
        url: node.url
      });

      const created = await browser.bookmarks.create({
        parentId: ffParentId,
        title: node.title || '',
        url: node.url
      });
      createdIds.push(created.id);
      return created.id;
    }

    return null;
  }

  // ============================================================
  //  moveToEncrypted (Firefox → Encrypted)
  //
  //  C3-SEC-03: Phase 2 re-validation πριν το remove(ffId)
  // ============================================================
  async function moveToEncrypted(ffId, transferId) {
    const tidShort = transferId.slice(0, 8);
    log(`moveToEncrypted: ffId=${ffId.slice(0, 8)} tid=${tidShort}`);

    // Cache check
    const cached = _cacheCheck(transferId);
    if (cached) {
      log(`Cache HIT: ${tidShort}`);
      return cached;
    }

    // M-19: Inflight deduplication
    return await _withInflight(transferId, async () => {
      // H-1: Validate
      try {
        await _validateFirefoxRemove(ffId);
      } catch (e) {
        const res = { success: false, error: 'VALIDATION_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      let ffNode;
      try {
        ffNode = await _ffGet(ffId);
      } catch (e) {
        const res = { success: false, error: 'FF_NOT_FOUND: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      if (ffNode.type !== 'bookmark') {
        const res = { success: false, error: 'NOT_A_BOOKMARK (use moveFolderToEncrypted)' };
        _cacheStore(transferId, res);
        return res;
      }

      const createdIds = [];
      const skipped = [];
      const warnings = [];
      let newId = null;

      try {
        newId = await _copyFfNodeToEncrypted(
          ffNode,
          CBF_ES.ROOT_ID,
          createdIds,
          skipped,
          0,
          null,
          warnings
        );
      } catch (e) {
        err(`Phase 1 FAILED (tid=${tidShort}):`, e.message);
        const res = { success: false, error: 'PHASE1_CREATE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      if (!newId) {
        // B-4: invalid URL → δεν ανηγράφηκε
        const res = {
          success: false,
          error: 'INVALID_URL_SKIPPED',
          details: skipped,
          warnings
        };
        _cacheStore(transferId, res);
        return res;
      }

      // ═══════════════════════════════════════════════════════════
      //  C3-SEC-03: Re-validate ffId πριν το Phase 2 delete
      //
      //  Race window: μεταξύ Phase 1 και Phase 2, ένα άλλο tab
      //  μπορεί να έχει μετακινήσει το ffId έξω από το managed tree.
      //  Χωρίς re-validation, το delete θα πετύχει σε unmanaged item.
      //
      //  Σε αποτυχία: rollback το Phase 1 (delete το created copy).
      // ═══════════════════════════════════════════════════════════
      try {
        await _validateFirefoxRemove(ffId);
      } catch (e) {
        audit('PHASE2_REVALIDATION_FAILED', {
          ffId,
          newId,
          reason: e.message
        });
        warn(`C3-SEC-03: Phase 2 re-validation FAILED (tid=${tidShort}) → rollback:`, e.message);

        // Rollback: delete το created copy στο encrypted space
        try {
          const rollbackGen = CBF_PROJECTION.getGeneration();
          const rollbackRes = await _seqDelete(newId, rollbackGen);
          if (rollbackRes.status !== 'OK' && rollbackRes.status !== 'ALREADY_APPLIED') {
            audit('ROLLBACK_FAILED', { newId: newId.slice(0, 8), phase: 'reval-rollback' });
          }
        } catch (rbErr) {
          audit('ROLLBACK_EXCEPTION', {
            newId: newId.slice(0, 8),
            error: rbErr.message
          });
        }

        const res = {
          success: false,
          error: 'PHASE2_REVALIDATION_FAILED: ' + e.message,
          newId
        };
        _cacheStore(transferId, res);
        return res;
      }

      // Phase 2: Delete Firefox original
      try {
        await browser.bookmarks.remove(ffId);
      } catch (e) {
        warn(`Phase 2 FAILED (tid=${tidShort}) → rollback:`, e.message);
        try {
          const rollbackGen = CBF_PROJECTION.getGeneration();
          const rollbackRes = await _seqDelete(newId, rollbackGen);
          if (rollbackRes.status !== 'OK' && rollbackRes.status !== 'ALREADY_APPLIED') {
            audit('ROLLBACK_FAILED', { newId: newId.slice(0, 8), phase: 'delete' });
            const res = {
              success: false, error: 'ROLLBACK_FAILED',
              newId, details: rollbackRes.error || rollbackRes.status
            };
            _cacheStore(transferId, res);
            return res;
          }
        } catch (rbErr) {
          audit('ROLLBACK_EXCEPTION', { newId: newId.slice(0, 8), error: rbErr.message });
          const res = {
            success: false, error: 'ROLLBACK_EXCEPTION',
            newId, details: rbErr.message
          };
          _cacheStore(transferId, res);
          return res;
        }

        const res = { success: false, error: 'PHASE2_DELETE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      audit('MOVE_TO_ENCRYPTED', { ffId, newId, warnings: warnings.length });

      const res = {
        success: true,
        id: newId,
        type: 'bookmark',
        warnings
      };
      _cacheStore(transferId, res);
      return res;
    });
  }

  // ============================================================
  //  moveToFirefox (Encrypted → Firefox)
  //
  //  Phase 2 = _seqDelete (encrypted op) → Δεν χρειάζεται Firefox
  //  re-validation.
  // ============================================================
  async function moveToFirefox(encId, transferId) {
    const tidShort = transferId.slice(0, 8);
    log(`moveToFirefox: encId=${encId.slice(0, 8)} tid=${tidShort}`);

    const cached = _cacheCheck(transferId);
    if (cached) {
      log(`Cache HIT: ${tidShort}`);
      return cached;
    }

    return await _withInflight(transferId, async () => {
      const node = CBF_PROJECTION.getItem(encId);
      if (!node) {
        const res = { success: false, error: 'ENC_NOT_FOUND' };
        _cacheStore(transferId, res);
        return res;
      }

      if (node.type !== 'bookmark') {
        const res = { success: false, error: 'NOT_A_BOOKMARK (use moveFolderToFirefox)' };
        _cacheStore(transferId, res);
        return res;
      }

      if (!node.url) {
        const res = { success: false, error: 'NO_URL' };
        _cacheStore(transferId, res);
        return res;
      }

      const warnings = [];

      // H-1 + H-2: Validate πριν το create
      const managedRoot = _getManagedRoot();
      try {
        await _validateFirefoxWrite({
          parentId: managedRoot,
          type: 'bookmark',
          title: node.title || '',
          url: node.url
        });
      } catch (e) {
        const res = { success: false, error: 'VALIDATION_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      let newFfId = null;
      try {
        const created = await browser.bookmarks.create({
          parentId: managedRoot,
          title: node.title || '',
          url: node.url
        });
        newFfId = created.id;
      } catch (e) {
        err(`Phase 1 FAILED (FF create, tid=${tidShort}):`, e.message);
        const res = { success: false, error: 'PHASE1_CREATE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      // Phase 2: Delete encrypted original (encrypted op — no Firefox re-validation)
      try {
        const curGen = CBF_PROJECTION.getGeneration();
        const delRes = await _seqDelete(encId, curGen);
        if (delRes.status !== 'OK' && delRes.status !== 'ALREADY_APPLIED') {
          throw new Error(delRes.error || delRes.status);
        }
      } catch (e) {
        warn(`Phase 2 FAILED (tid=${tidShort}) → rollback:`, e.message);
        try {
          await _validateFirefoxRemove(newFfId);
          await browser.bookmarks.remove(newFfId);
        } catch (rbErr) {
          audit('ROLLBACK_FAILED', { newFfId, encId, error: rbErr.message });
          const res = {
            success: false, error: 'ROLLBACK_FAILED',
            newFfId, details: rbErr.message
          };
          _cacheStore(transferId, res);
          return res;
        }

        const res = { success: false, error: 'PHASE2_DELETE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      audit('MOVE_TO_FIREFOX', { encId, newFfId });

      const res = {
        success: true,
        id: newFfId,
        type: 'bookmark',
        warnings
      };
      _cacheStore(transferId, res);
      return res;
    });
  }

  // ============================================================
  //  moveFolderToEncrypted (Firefox folder → Encrypted)
  //
  //  C3-SEC-03: Phase 2 re-validation πριν το removeTree(ffId)
  // ============================================================
  async function moveFolderToEncrypted(ffId, transferId) {
    const tidShort = transferId.slice(0, 8);
    log(`moveFolderToEncrypted: ffId=${ffId.slice(0, 8)} tid=${tidShort}`);

    const cached = _cacheCheck(transferId);
    if (cached) {
      log(`Cache HIT: ${tidShort}`);
      return cached;
    }

    return await _withInflight(transferId, async () => {
      // H-1: Validate
      try {
        await _validateFirefoxRemove(ffId);
      } catch (e) {
        const res = { success: false, error: 'VALIDATION_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      let ffNode;
      try {
        ffNode = await _ffGet(ffId);
      } catch (e) {
        const res = { success: false, error: 'FF_NOT_FOUND: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      if (ffNode.type !== 'folder') {
        const res = { success: false, error: 'NOT_A_FOLDER' };
        _cacheStore(transferId, res);
        return res;
      }

      // B-4 + S-14: Pre-scan
      let invalid;
      try {
        invalid = await _scanInvalidBookmarks(ffNode);
      } catch (e) {
        if (e.message === 'SCAN_DEPTH_EXCEEDED' || e.message === 'SCAN_ITEM_LIMIT_EXCEEDED') {
          audit('TRANSFER_ABORTED_SCAN_LIMIT', { ffId, reason: e.message });
          const res = {
            success: false,
            error: 'SCAN_LIMIT_EXCEEDED',
            details: e.message
          };
          _cacheStore(transferId, res);
          return res;
        }
        err(`Scan FAILED (tid=${tidShort}):`, e.message);
        const res = { success: false, error: 'SCAN_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      if (invalid.length > 0) {
        audit('TRANSFER_ABORTED_INVALID_URLS', { ffId, count: invalid.length });
        const res = {
          success: false,
          error: 'CONTAINS_INVALID_URLS',
          details: invalid
        };
        _cacheStore(transferId, res);
        return res;
      }

      const createdIds = [];
      const warnings = [];
      let newRootId = null;

      try {
        newRootId = await _copyFfNodeToEncrypted(
          ffNode,
          CBF_ES.ROOT_ID,
          createdIds,
          null,
          0,
          null,
          warnings
        );
      } catch (e) {
        err(`Phase 1 FAILED (tid=${tidShort}):`, e.message);
        // Rollback: διαγραφή ό,τι δημιουργήθηκε (ανάποδα)
        for (const id of createdIds.reverse()) {
          try {
            await _seqDelete(id, CBF_PROJECTION.getGeneration());
          } catch (_) {}
        }
        const res = { success: false, error: 'PHASE1_CREATE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      // C3-SEC-03: Re-validate ffId πριν το Phase 2 removeTree
      try {
        await _validateFirefoxRemove(ffId);
      } catch (e) {
        audit('PHASE2_REVALIDATION_FAILED', {
          ffId,
          newRootId,
          reason: e.message
        });
        warn(`C3-SEC-03: Phase 2 re-validation FAILED (tid=${tidShort}) → rollback:`, e.message);

        // Rollback: delete ό,τι δημιουργήθηκε (ανάποδα)
        for (const id of createdIds.reverse()) {
          try {
            await _seqDelete(id, CBF_PROJECTION.getGeneration());
          } catch (rbErr) {
            audit('ROLLBACK_PARTIAL', { id: id.slice(0, 8), error: rbErr.message });
          }
        }

        const res = {
          success: false,
          error: 'PHASE2_REVALIDATION_FAILED: ' + e.message,
          newRootId
        };
        _cacheStore(transferId, res);
        return res;
      }

      // Phase 2: removeTree
      try {
        await browser.bookmarks.removeTree(ffId);
      } catch (e) {
        warn(`Phase 2 FAILED (tid=${tidShort}) → rollback:`, e.message);
        for (const id of createdIds.reverse()) {
          try {
            await _seqDelete(id, CBF_PROJECTION.getGeneration());
          } catch (rbErr) {
            audit('ROLLBACK_PARTIAL', { id: id.slice(0, 8), error: rbErr.message });
          }
        }
        const res = { success: false, error: 'PHASE2_DELETE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      audit('MOVE_FOLDER_TO_ENCRYPTED', {
        ffId, newRootId,
        count: createdIds.length,
        warnings: warnings.length
      });

      const res = {
        success: true,
        id: newRootId,
        type: 'folder',
        count: createdIds.length,
        warnings
      };
      _cacheStore(transferId, res);
      return res;
    });
  }

  // ============================================================
  //  moveFolderToFirefox (Encrypted folder → Firefox)
  // ============================================================
  async function moveFolderToFirefox(encId, transferId) {
    const tidShort = transferId.slice(0, 8);
    log(`moveFolderToFirefox: encId=${encId.slice(0, 8)} tid=${tidShort}`);

    const cached = _cacheCheck(transferId);
    if (cached) {
      log(`Cache HIT: ${tidShort}`);
      return cached;
    }

    return await _withInflight(transferId, async () => {
      const node = CBF_PROJECTION.getItem(encId);
      if (!node) {
        const res = { success: false, error: 'ENC_NOT_FOUND' };
        _cacheStore(transferId, res);
        return res;
      }
      if (node.type !== 'folder') {
        const res = { success: false, error: 'NOT_A_FOLDER' };
        _cacheStore(transferId, res);
        return res;
      }

      const warnings = [];

      // H-1 + H-2: Validate root write
      const managedRoot = _getManagedRoot();
      try {
        await _validateFirefoxWrite({
          parentId: managedRoot,
          type: 'folder',
          title: node.title || 'Folder',
          url: null
        });
      } catch (e) {
        const res = { success: false, error: 'VALIDATION_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      const createdIds = [];
      let newRootId = null;
      try {
        newRootId = await _copyEncNodeToFirefox(encId, managedRoot, createdIds, 0, warnings);
      } catch (e) {
        err(`Phase 1 FAILED (tid=${tidShort}):`, e.message);
        for (const id of createdIds.reverse()) {
          try {
            await _validateFirefoxRemove(id);
            await browser.bookmarks.remove(id);
          } catch (_) {}
        }
        const res = { success: false, error: 'PHASE1_CREATE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      try {
        const delRes = await _seqDelete(encId, CBF_PROJECTION.getGeneration());
        if (delRes.status !== 'OK' && delRes.status !== 'ALREADY_APPLIED') {
          throw new Error(delRes.error || delRes.status);
        }
      } catch (e) {
        warn(`Phase 2 FAILED (tid=${tidShort}) → rollback:`, e.message);
        try {
          await _validateFirefoxRemove(newRootId);
          await browser.bookmarks.removeTree(newRootId);
        } catch (rbErr) {
          audit('ROLLBACK_FAILED', { newRootId, encId, error: rbErr.message });
        }
        const res = { success: false, error: 'PHASE2_DELETE_FAILED: ' + e.message };
        _cacheStore(transferId, res);
        return res;
      }

      audit('MOVE_FOLDER_TO_FIREFOX', {
        encId, newRootId,
        count: createdIds.length,
        warnings: warnings.length
      });

      const res = {
        success: true,
        id: newRootId,
        type: 'folder',
        count: createdIds.length,
        warnings
      };
      _cacheStore(transferId, res);
      return res;
    });
  }

  // ============================================================
  //  Diagnostics
  // ============================================================
  function getCacheSize() { return transferCache.size; }
  function getInflightSize() { return _inflightTransfers.size; }
  function clearCache() {
    const cacheSize = transferCache.size;
    const inflightSize = _inflightTransfers.size;
    transferCache.clear();
    _inflightTransfers.clear();
    log(`clearCache: ${cacheSize} cache + ${inflightSize} inflight entries cleared`);
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    moveToEncrypted,
    moveToFirefox,
    moveFolderToEncrypted,
    moveFolderToFirefox,
    getCacheSize,
    getInflightSize,
    clearCache,
    _internal: {
      _cacheCheck,
      _cacheStore,
      _withInflight,
      _copyFfNodeToEncrypted,
      _copyEncNodeToFirefox,
      _seqCreate,
      _seqDelete,
      _getManagedRoot,
      _validateFirefoxRemove,
      _validateFirefoxWrite,
      _scanInvalidBookmarks,
      _walkSubtree,
      _validateTitle,
      _validateUrl,
      RAM_TTL_MS,
      MAX_SCAN_DEPTH,
      MAX_SCAN_ITEMS,
      MAX_TITLE_LENGTH,
      MAX_URL_LENGTH,
      MAX_STALE_RETRIES,
      _inflightTransfers,
      transferCache
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_CROSS_SPACE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_CROSS_SPACE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
      CBF_LOGGER.info(
      'Cross-Space Service ready (v12.3.0 + C3-SEC-03: ' +
      'Phase 2 re-validation σε moveToEncrypted + moveFolderToEncrypted, ' +
      'FIX-5a/b _seqCreate + _seqDelete log cleanup)'
    );
  }

  return api;
})();