/**
 * import-service.js — Import validators (pure, no IO)
 *
 * @path     background/services/import-service.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Validation ONLY για imports. ΔΕΝ κάνει crypto, ΔΕΝ γράφει IDB,
 *   ΔΕΝ καλεί sequencer. Επιστρέφει normalized items ή throw.
 *
 *   Public API:
 *     1. validateEncryptedBackup(data) → { valid, error?, records? }
 *     2. validatePlainExport(data)     → { valid, error?, items? }
 *     3. validateImportFavicons(items) → { valid, error?, items? }
 *
 * HARD LIMITS (DoS protection — D-56)
 *   • MAX_ITEMS        = 50,000  (records per import)
 *   • MAX_TITLE_LENGTH = 500
 *   • MAX_URL_LENGTH   = 2048
 *   • MAX_DEPTH        = 100     (cycle prevention)
 *
 * NON-OBVIOUS
 *   • validatePlainExport υποστηρίζει 3 formats:
 *       - { type: 'plain', data: [...] }
 *       - Array of items
 *       - Firefox restore format (root container με children)
 *   • Cycle detection (BFS με MAX_DEPTH) σε plain imports —
 *     αποτρέπει malicious backups που δημιουργούν infinite loops.
 *   • validateImportFavicons χρησιμοποιεί το νέο 50KB limit
 *     (V12E.E-FAVICON-01 consistency).
 *
 * DECISIONS
 *   D-51, D-56
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "import-service"
 */

var CBF_IMPORT_SERVICE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_ITEMS        = 50000;
  const MAX_TITLE_LENGTH = 500;
  const MAX_URL_LENGTH   = 2048;
  const MAX_DEPTH        = 100;

  const ROOT_ID = 'ecbf-root';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[IMPORT]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[IMPORT]', ...a); }

  // ============================================================
  //  Validation helpers
  // ============================================================
  function _validateTitle(title) {
    if (typeof title !== 'string') return '';
    const trimmed = title.trim();
    if (trimmed.length > MAX_TITLE_LENGTH) {
      return trimmed.slice(0, MAX_TITLE_LENGTH - 1) + '…';
    }
    return trimmed;
  }

  function _validateUrl(url) {
    if (typeof url !== 'string') return null;
    if (url.length > MAX_URL_LENGTH) {
      throw new Error(`URL too long: ${url.length} > ${MAX_URL_LENGTH}`);
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('URL must be http(s)');
    }
    return url;
  }

  function _validateId(id, name = 'id') {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
    return id;
  }

  // ============================================================
  //  1. validateEncryptedBackup
  //
  //  Ελέγχει shape του encrypted backup payload.
  // ============================================================
  function validateEncryptedBackup(data) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'data must be object' };
    }
    if (data.type !== 'encrypted-backup') {
      return { valid: false, error: 'data.type must be "encrypted-backup"' };
    }
    if (data.version !== 1) {
      return { valid: false, error: `Unsupported version: ${data.version}` };
    }
    if (typeof data.kdfId !== 'string') {
      return { valid: false, error: 'kdfId required' };
    }
    if (typeof data.salt !== 'string' || data.salt.length === 0) {
      return { valid: false, error: 'salt required' };
    }
    if (!Array.isArray(data.records)) {
      return { valid: false, error: 'records must be array' };
    }
    if (data.records.length > MAX_ITEMS) {
      return { valid: false, error: `Too many records: ${data.records.length} > ${MAX_ITEMS}` };
    }

    const validated = [];
    for (let i = 0; i < data.records.length; i++) {
      const rec = data.records[i];
      if (!rec || typeof rec !== 'object') {
        return { valid: false, error: `records[${i}] must be object` };
      }
      try {
        _validateId(rec.id, `records[${i}].id`);
        if (rec.parentId !== null && typeof rec.parentId !== 'string') {
          return { valid: false, error: `records[${i}].parentId must be string|null` };
        }
        if (rec.recordType !== 'bookmark' && rec.recordType !== 'folder') {
          return { valid: false, error: `records[${i}].recordType invalid` };
        }
        if (typeof rec.nonce !== 'string' || rec.nonce.length === 0) {
          return { valid: false, error: `records[${i}].nonce required` };
        }
        if (typeof rec.ciphertext !== 'string' || rec.ciphertext.length === 0) {
          return { valid: false, error: `records[${i}].ciphertext required` };
        }
        if (typeof rec.tag !== 'string' || rec.tag.length === 0) {
          return { valid: false, error: `records[${i}].tag required` };
        }
        if (typeof rec.positionKey !== 'string' || rec.positionKey.length === 0) {
          return { valid: false, error: `records[${i}].positionKey required` };
        }
        validated.push(rec);
      } catch (e) {
        return { valid: false, error: e.message };
      }
    }

    return { valid: true, records: validated };
  }

  // ============================================================
  //  2. validatePlainExport
  //
  //  Ελέγχει shape του plain export payload.
  //  Υποστηρίζει 3 formats:
  //    - { type: 'plain', data: [...] }
  //    - Array of items
  //    - Firefox restore format (root container με children)
  // ============================================================
  function validatePlainExport(data) {
    if (!data) {
      return { valid: false, error: 'data required' };
    }

    let items = [];

    // Case 1: { type: 'plain', data: [...] }
    if (typeof data === 'object' && !Array.isArray(data) && data.type === 'plain') {
      if (!Array.isArray(data.data)) {
        return { valid: false, error: 'data.data must be array' };
      }
      items = data.data;
    }
    // Case 2: Array of items
    else if (Array.isArray(data)) {
      items = data;
    }
    // Case 3: Firefox restore format (root container)
    else if (typeof data === 'object' && data.typeCode === 2 && Array.isArray(data.children)) {
      items = flattenFirefoxRestoreFormat(data);
    }
    // Case 4: Unknown
    else {
      return { valid: false, error: 'Unrecognized format' };
    }

    if (items.length > MAX_ITEMS) {
      return { valid: false, error: `Too many items: ${items.length} > ${MAX_ITEMS}` };
    }

    // Validate each item
    const validated = [];
    const seenIds = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') {
        return { valid: false, error: `items[${i}] must be object` };
      }
      try {
        _validateId(item.id, `items[${i}].id`);
        if (seenIds.has(item.id)) {
          warn(`Duplicate ID ${item.id} at items[${i}] — skipping`);
          continue;
        }
        seenIds.add(item.id);

        if (item.parentId !== null && item.parentId !== undefined && typeof item.parentId !== 'string') {
          return { valid: false, error: `items[${i}].parentId must be string|null` };
        }
        if (item.type !== 'bookmark' && item.type !== 'folder') {
          return { valid: false, error: `items[${i}].type must be bookmark|folder` };
        }
        const title = _validateTitle(item.title || '');
        let url = null;
        if (item.type === 'bookmark') {
          url = _validateUrl(item.url);
          if (!url) {
            warn(`Bookmark items[${i}] has no valid URL — skipping`);
            continue;
          }
        }
        validated.push({
          id: item.id,
          parentId: item.parentId || ROOT_ID,
          type: item.type,
          title,
          url,
          index: typeof item.index === 'number' ? item.index : 0
        });
      } catch (e) {
        return { valid: false, error: e.message };
      }
    }

    // Cycle detection
    const cycleCheck = detectCycles(validated);
    if (!cycleCheck.ok) {
      return { valid: false, error: cycleCheck.error };
    }

    return { valid: true, items: validated };
  }

  // ============================================================
  //  3. flattenFirefoxRestoreFormat
  //
  //  Μετατρέπει Firefox restore JSON σε flat array από items.
  // ============================================================
  function flattenFirefoxRestoreFormat(root) {
    const out = [];

    function walk(node, parentGuid) {
      const guid = node.guid || `imp-${out.length}`;
      const isFolder = node.typeCode === 2 || node.type === 'text/x-moz-place-container';
      const type = isFolder ? 'folder' : 'bookmark';

      // Skip top-level container (είναι το root)
      const isRoot = (guid === 'root________');
      if (!isRoot) {
        out.push({
          id: guid,
          parentId: parentGuid || 'toolbar_____',
          type,
          title: node.title || '',
          url: isFolder ? null : (node.uri || null),
          index: node.index || 0
        });
      }

      if (isFolder && Array.isArray(node.children)) {
        for (const child of node.children) {
          walk(child, isRoot ? null : guid);
        }
      }
    }

    // Ξεκινάμε από το root και περνάμε τα standard folders
    if (Array.isArray(root.children)) {
      for (const child of root.children) {
        walk(child, 'root________');
      }
    }

    return out;
  }

  // ============================================================
  //  4. detectCycles
  //
  //  BFS cycle detection σε flat item list.
  // ============================================================
  function detectCycles(items) {
    const byId = new Map(items.map(i => [i.id, i]));

    for (const item of items) {
      const visited = new Set();
      let cur = item;
      let depth = 0;

      while (cur && cur.parentId && cur.parentId !== ROOT_ID) {
        if (visited.has(cur.id)) {
          return { ok: false, error: `Cycle detected involving ${cur.id}` };
        }
        visited.add(cur.id);

        if (++depth > MAX_DEPTH) {
          return { ok: false, error: `Max depth ${MAX_DEPTH} exceeded at ${item.id}` };
        }

        cur = byId.get(cur.parentId);
        if (!cur) break;   // parent not in import set — OK (existing)
      }
    }

    return { ok: true };
  }

  // ============================================================
  //  5. validateImportFavicons
  // ============================================================
  function validateImportFavicons(items) {
    if (!Array.isArray(items)) {
      return { valid: false, error: 'items must be array' };
    }
    if (items.length > MAX_ITEMS) {
      return { valid: false, error: `Too many items: ${items.length} > ${MAX_ITEMS}` };
    }

    const validated = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;

      let url;
      try {
        url = _validateUrl(item.url);
      } catch (_) {
        continue;
      }
      if (!url) continue;

      if (typeof item.dataUrl !== 'string') continue;
      if (!item.dataUrl.startsWith('data:image/')) continue;
      if (item.dataUrl.length > 50 * 1024) continue;   // V12E.E-FAVICON-01 consistency

      let color = null;
      if (typeof item.color === 'string' && item.color.startsWith('rgb')) {
        color = item.color;
      }

      validated.push({ url, dataUrl: item.dataUrl, color });
    }

    return { valid: true, items: validated };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    validateEncryptedBackup,
    validatePlainExport,
    validateImportFavicons,

    _internal: {
      _validateTitle,
      _validateUrl,
      flattenFirefoxRestoreFormat,
      detectCycles
    },

    MAX_ITEMS,
    MAX_TITLE_LENGTH,
    MAX_URL_LENGTH,
    MAX_DEPTH
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_IMPORT_SERVICE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_IMPORT_SERVICE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Import Service ready (D-51: pure validators, ' +
      '50k items max, cycle detection, dual format support)'
    );
  }

  return api;
})();