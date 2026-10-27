/**
 * export-service.js — Export helpers (pure, read-only)
 *
 * @path     background/services/export-service.js
 * @version  12.2.0
 * @since    v12E / v12.2
 *
 * PURPOSE
 *   Pure helper functions για exports. ΔΕΝ γράφουν IDB, ΔΕΝ στέλνουν
 *   network requests, ΔΕΝ κάνουν crypto πέρα από SHA-256 (για restore
 *   format compliance).
 *
 *   5 export types:
 *     1. buildFirefoxRestoreJSON(items)    — v12.4 parity
 *     2. collectFaviconsForExport()        — από storage.local
 *     3. collectFirefoxTreeAsJSON()        — από browser.bookmarks.getTree()
 *     4. collectEncryptedAsPlain()         — από CBF_ES (decrypted)
 *     5. collectEncryptedAsBackup()        — ciphertext backup
 *
 * NON-OBVIOUS
 *   • Όλα τα exports περνάνε μέσω messaging handler → background →
 *     download. Καμία plaintext data δεν φτάνει στο overlay (Invariant #7).
 *   • Το buildFirefoxRestoreJSON() χρησιμοποιεί NUMERIC IDs (1, 2, 3...)
 *     για Firefox restore format compliance — το original UUID πάει
 *     στο `guid` field.
 *   • Το collectEncryptedAsBackup() περιλαμβάνει το KDF config (salt +
 *     params) ώστε ο χρήστης να μπορεί να κάνει restore με τον σωστό
 *     κωδικό.
 *
 * DECISIONS
 *   D-51 (Export/Import μέσω port protocol)
 *   D-55 (downloads permission — restored)
 *
 * CHANGELOG v12.2.0 (2026-09-26) — FAVICON EXPORT FIX
 *   ═══════════════════════════════════════════════════════════════════
 *   FAV-01: Format mismatch fix
 *     ΠΡΟΒΛΗΜΑ: Το favicon-service.js v12E γράφει objects
 *       { dataUrl, fetchedAt } στο storage.local, αλλά το
 *       collectFaviconsForExport() έκανε `if (typeof value !== 'string') continue;`
 *       → όλα τα νέα favicons ΑΓΝΟΟΥΝΤΑΝ σιωπηλά.
 *
 *     ΛΥΣΗ: Handle BOTH formats:
 *       - Legacy: raw string
 *       - New: { dataUrl, fetchedAt }
 *
 *   FAV-02: MAX_FAVICON_SIZE 10KB → 50KB
 *     ΠΡΟΒΛΗΜΑ: Το export limit ήταν 10KB, αλλά το favicon-service
 *       (V12E.E-FAVICON-01) αποθηκεύει μέχρι 50KB (ICO-friendly).
 *       → favicons 10-50KB (Apple, Facebook, insomnia.gr) χάνονταν.
 *
 *     ΛΥΣΗ: Update σε 50KB — consistency με favicon-service.
 *
 *   FAV-03: Diagnostics logging
 *     Προστέθηκαν counters (scanned, skipped-invalid, skipped-not-image,
 *     skipped-too-large) για debugging του export.
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "export-service"
 */

var CBF_EXPORT_SERVICE = (function() {
  'use strict';

  // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2.0 FAV-02 FIX: 10KB → 50KB
  //
  //  Consistency με favicon-service.js MAX_DATAURL_LENGTH
  //  (V12E.E-FAVICON-01 — ICO-friendly limit).
  //
  //  Γιατί 50KB:
  //    • Apple touch icons: 20-40 KB
  //    • Multi-resolution ICO: 20-50 KB
  //    • Facebook/Instagram: 30-50 KB
  //    • Standard PNG: 1-10 KB
  // ═══════════════════════════════════════════════════════════
  const MAX_FAVICON_SIZE = 50 * 1024;   // 50 KB (was 10 KB in v12E)

  const FIREFOX_ROOT_IDS = [
    'toolbar_____', 'menu________', 'unfiled_____', 'mobile______'
  ];

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[EXPORT]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[EXPORT]', ...a); }

  // ============================================================
  //  1. buildFirefoxRestoreJSON
  //
  //  Μετατρέπει items σε Firefox Restore JSON format.
  //  (Port από v12.4 export_backup_encrypted.js — προσαρμοσμένο)
  //
  //  Format:
  //    {
  //      id: numeric (1, 2, 3...),
  //      guid: original UUID,
  //      typeCode: 1 (bookmark) | 2 (folder),
  //      type: 'text/x-moz-place' | 'text/x-moz-place-container',
  //      title, uri (bookmarks), children (folders),
  //      dateAdded, lastModified,
  //      root: 'placesRoot' | 'toolbarFolder' | ...
  //    }
  // ============================================================
  function buildFirefoxRestoreJSON(items) {
    if (!Array.isArray(items)) {
      throw new Error('buildFirefoxRestoreJSON: items must be array');
    }

    const nowMicro = Math.floor(Date.now() * 1000);
    const itemsMap = new Map();

    // ---------- 1. Wrap items ----------
    for (const item of items) {
      itemsMap.set(item.id, {
        id: item.id,
        parentId: item.parentId,
        index: item.index ?? 0,
        type: item.type,
        title: item.title || '',
        url: item.url || null,
        dateAdded: item.dateAdded || nowMicro,
        lastModified: item.lastModified || nowMicro,
        children: []
      });
    }

    // ---------- 2. Build tree ----------
    for (const item of itemsMap.values()) {
      if (item.parentId === 'root________') continue;  // skip root
      const parent = itemsMap.get(item.parentId);
      if (parent) {
        parent.children.push(item);
      }
      // else: orphan — αγνοείται
    }

    // ---------- 3. Sort recursively ----------
    function sortRecursive(node) {
      if (node.children && node.children.length > 0) {
        node.children.sort((a, b) => (a.index || 0) - (b.index || 0));
        node.children.forEach(sortRecursive);
      }
    }
    for (const item of itemsMap.values()) sortRecursive(item);

    // ---------- 4. Build standard root folders ----------
    const makeRoot = (id, title, rootKey) => ({
      id, type: 'folder', title, parentId: 'root________',
      children: [], dateAdded: nowMicro, lastModified: nowMicro,
      root: rootKey
    });

    const menuFolder    = makeRoot('menu________',    'menu',    'bookmarksMenuFolder');
    const toolbarFolder = makeRoot('toolbar_____',    'toolbar', 'toolbarFolder');
    const unfiledFolder = makeRoot('unfiled_____',    'unfiled', 'unfiledBookmarksFolder');
    const mobileFolder  = makeRoot('mobile______',    'mobile',  'mobileFolder');

    // ---------- 5. Distribute children ----------
    for (const item of itemsMap.values()) {
      switch (item.parentId) {
        case 'toolbar_____': toolbarFolder.children.push(item); break;
        case 'menu________': menuFolder.children.push(item);    break;
        case 'unfiled_____': unfiledFolder.children.push(item); break;
        case 'mobile______': mobileFolder.children.push(item);  break;
        case 'root________': toolbarFolder.children.push(item); break;  // orphan → toolbar
      }
    }

    // ---------- 6. Sort root folders ----------
    [menuFolder, toolbarFolder, unfiledFolder, mobileFolder].forEach(sortRecursive);

    // ---------- 7. Root node ----------
    const rootNode = {
      id: 'root________',
      type: 'folder',
      title: '',
      parentId: null,
      children: [menuFolder, toolbarFolder, unfiledFolder, mobileFolder],
      dateAdded: nowMicro,
      lastModified: nowMicro,
      root: 'placesRoot'
    };

    // ---------- 8. Assign numeric IDs + convert format ----------
    let numericIdCounter = 1;

    function assignIdsAndConvert(node) {
      const out = { ...node };
      out.originalId = node.id;
      out.id = numericIdCounter++;
      out.guid = node.id;

      if (out.type === 'folder') {
        out.typeCode = 2;
        out.type = 'text/x-moz-place-container';
        if (out.children) {
          out.children = out.children.map(assignIdsAndConvert);
        }
        delete out.parentId;
        delete out.url;
      } else {
        out.typeCode = 1;
        out.type = 'text/x-moz-place';
        out.uri = out.url;
        delete out.url;
        delete out.children;
        delete out.parentId;
      }
      delete out.originalId;
      delete out.index;
      delete out.dateGroupModified;
      return out;
    }

    return assignIdsAndConvert(rootNode);
  }

  // ============================================================
  //  2. collectFaviconsForExport
  //
  //  ⭐ v12.2.0 FAV-01 + FAV-02 + FAV-03 FIX
  //
  //  ΠΡΟΒΛΗΜΑ (v12E):
  //    Το favicon-service.js γράφει objects { dataUrl, fetchedAt }
  //    στο storage.local, αλλά η παλιά έκδοση έκανε:
  //      if (typeof value !== 'string') continue;
  //    → όλα τα νέα favicons ΑΓΝΟΟΥΝΤΑΝ σιωπηλά.
  //
  //  ΛΥΣΗ:
  //    • Handle BOTH formats (legacy string + new object)
  //    • Update MAX_FAVICON_SIZE σε 50KB (consistency με favicon-service)
  //    • Diagnostics counters για debugging
  //
  //  Storage format (2 types):
  //    Format 1 (legacy — imported μέσω options):
  //      storage['favicon_google.com'] = 'data:image/png;base64,...'
  //
  //    Format 2 (new — captured από favicon-service):
  //      storage['favicon_google.com'] = {
  //        dataUrl: 'data:image/png;base64,...',
  //        fetchedAt: 1234567890
  //      }
  //
  //  Output format:
  //    {
  //      "google.com": {
  //        "dataUrl": "data:image/png;base64,...",
  //        "color": "#4285f4" | null
  //      },
  //      ...
  //    }
  // ============================================================
  async function collectFaviconsForExport() {
    const all = await browser.storage.local.get(null);
    const out = {};

    // ⭐ FAV-03: Diagnostics counters
    let scanned = 0;
    let skippedInvalid = 0;
    let skippedNotImage = 0;
    let skippedTooLarge = 0;

    for (const [key, value] of Object.entries(all)) {
      // Filter: μόνο favicon_* keys, exclude favicon_color_*
      if (!key.startsWith('favicon_')) continue;
      if (key.startsWith('favicon_color_')) continue;

      const hostname = key.slice('favicon_'.length);
      if (!hostname) continue;

      scanned++;

      // ═══════════════════════════════════════════════════════════
      //  ⭐ FAV-01 FIX: Handle BOTH storage formats
      // ═══════════════════════════════════════════════════════════
      let dataUrl = null;

      if (typeof value === 'string') {
        // Legacy: raw dataUrl string
        dataUrl = value;
      } else if (value && typeof value === 'object' &&
                 typeof value.dataUrl === 'string') {
        // New: { dataUrl, fetchedAt }
        dataUrl = value.dataUrl;
      } else {
        // Unknown format — skip
        skippedInvalid++;
        continue;
      }

      // Validate data URL prefix
      if (!dataUrl.startsWith('data:image/')) {
        skippedNotImage++;
        continue;
      }

      // ⭐ FAV-02 FIX: 10KB → 50KB (consistency με favicon-service)
      if (dataUrl.length > MAX_FAVICON_SIZE) {
        skippedTooLarge++;
        warn(
          `Skipping ${hostname}: dataUrl ${dataUrl.length} bytes > ` +
          `${MAX_FAVICON_SIZE} limit (50KB)`
        );
        continue;
      }

      // Read color (separate key, always string|null)
      const colorKey = `favicon_color_${hostname}`;
      const color = all[colorKey] || null;

      out[hostname] = { dataUrl, color };
    }

    // ⭐ FAV-03: Diagnostics log
    log(
      `Collected ${Object.keys(out).length} favicons ` +
      `(scanned=${scanned}, skipped-invalid=${skippedInvalid}, ` +
      `skipped-not-image=${skippedNotImage}, skipped-too-large=${skippedTooLarge})`
    );

    return out;
  }

  // ============================================================
  //  3. collectFirefoxTreeAsJSON
  //
  //  Παίρνει το Firefox tree και το μετατρέπει σε restore format.
  //  Recursive conversion με numeric IDs.
  // ============================================================
  async function collectFirefoxTreeAsJSON() {
    const tree = await browser.bookmarks.getTree();
    if (!tree || tree.length === 0) {
      throw new Error('Firefox bookmarks tree is empty');
    }

    // Το getTree επιστρέφει array με 1 root
    return convertFirefoxTreeToRestore(tree[0]);
  }

  // ------------------------------------------------------------
  //  Helper: convertFirefoxTreeToRestore
  //
  //  Μετατρέπει Firefox bookmark node σε restore format.
  //  Recursive — χρησιμοποιεί closure counter για unique numeric IDs.
  // ------------------------------------------------------------
  function convertFirefoxTreeToRestore(node) {
    let numericIdCounter = 1;

    function walk(n) {
      const out = {};
      out.guid = n.id;
      out.id = numericIdCounter++;
      out.title = n.title || '';
      out.dateAdded = n.dateAdded || (Date.now() * 1000);
      out.lastModified = n.lastModified || out.dateAdded;

      if (n.type === 'folder') {
        out.typeCode = 2;
        out.type = 'text/x-moz-place-container';
        out.children = (n.children || []).map(walk);

        // Root hints — Firefox restore format απαιτεί αυτά τα strings
        if (n.id === 'toolbar_____')      out.root = 'toolbarFolder';
        else if (n.id === 'menu________') out.root = 'bookmarksMenuFolder';
        else if (n.id === 'unfiled_____') out.root = 'unfiledBookmarksFolder';
        else if (n.id === 'mobile______') out.root = 'mobileFolder';
        else if (n.id === 'root________') out.root = 'placesRoot';
      } else {
        out.typeCode = 1;
        out.type = 'text/x-moz-place';
        out.uri = n.url;
      }

      return out;
    }

    return walk(node);
  }

  // ============================================================
  //  4. collectEncryptedAsPlain
  //
  //  Διαβάζει ΟΛΑ τα decrypted items από τον encrypted space
  //  και τα φτιάχνει σε Firefox restore format.
  //
  //  ⚠️ ΠΡΟΣΟΧΗ: Αυτό το export ΔΕΝ είναι κρυπτογραφημένο.
  //     Ο caller ΠΡΕΠΕΙ να ενημερώσει τον χρήστη (V12E: modal confirm).
  //
  //  Flow:
  //    1. Check vault unlocked
  //    2. Read all records from IDB
  //    3. Decrypt each (skip corrupted — fail-soft για export)
  //    4. Remap parentId: ecbf-root → toolbar_____
  //       (γιατί ο χρήστης εισάγει σε Firefox, όχι σε ECBF vault)
  //    5. Build restore JSON
  // ============================================================
  async function collectEncryptedAsPlain() {
    if (!CBF_ES.isUnlocked()) {
      throw new Error('Vault is locked');
    }

    const allRecords = await CBF_VAULT_TX.readAllRecords();
    const items = [];

    for (const rec of allRecords) {
      if (rec.id === CBF_ES.ROOT_ID) continue;  // skip internal root

      try {
        const plain = await CBF_ES._internal.decryptPayload(rec);
        items.push({
          id: rec.id,
          parentId: rec.parentId,
          type: rec.recordType,
          title: plain.title || '',
          url: plain.url || null
        });
      } catch (e) {
        warn(`Failed to decrypt record ${rec.id}: ${e.message}`);
        // Skip corrupted records (fail-soft για export)
      }
    }

    // Map encrypted root → toolbar_____ για Firefox restore format
    // (καθώς ο χρήστης εισάγει σε Firefox, όχι σε ECBF vault)
    const remapped = items.map(item => ({
      ...item,
      parentId: (item.parentId === CBF_ES.ROOT_ID) ? 'toolbar_____' : item.parentId
    }));

    return buildFirefoxRestoreJSON(remapped);
  }

  // ============================================================
  //  5. collectEncryptedAsBackup
  //
  //  Επιστρέφει raw ciphertext records + salts.
  //  Ο χρήστης μπορεί να κάνει restore μόνο με τον ΣΩΣΤΟ κωδικό.
  //
  //  Περιλαμβάνει:
  //    • KDF config (id, params, keyVersion)
  //    • Salt (base64)
  //    • Όλα τα encrypted records (ciphertext-only)
  //
  //  ΔΕΝ περιλαμβάνει:
  //    • Plaintext data
  //    • Κλειδιά (storeKey, stateMACKey, commitmentKey)
  //    • Password
  //
  //  Restore: χρήστης δίνει password → derive keys → decrypt records
  // ============================================================
  async function collectEncryptedAsBackup() {
    if (!CBF_ES.isUnlocked()) {
      throw new Error('Vault is locked');
    }

    const config = await CBF_ES._internal.readKdfConfig();
    if (!config) throw new Error('KDF config not found');

    try {
      const allRecords = await CBF_VAULT_TX.readAllRecords();

      const records = allRecords.map(rec => ({
        id: rec.id,
        parentId: rec.parentId,
        positionKey: rec.positionKey,
        recordType: rec.recordType,
        keyVersion: rec.keyVersion,
        formatVersion: rec.formatVersion,
        nonce: rec.nonce,
        ciphertext: rec.ciphertext,
        tag: rec.tag
      }));

      return {
        version: 1,
        type: 'encrypted-backup',
        schemaVersion: CBF_ES.SCHEMA_VERSION,
        kdfId: config.kdf.id,
        kdfParams: config.kdf.params,
        kdfVersion: config.kdf.version,
        keyVersion: config.kdf.keyVersion,
        salt: CBF_CRYPTO.bufToB64(config.salt),
        exportedAt: Date.now(),
        recordCount: records.length,
        records
      };
    } finally {
      // Memory hygiene: zero το salt μετά τη χρήση
      CBF_CRYPTO.zeroBuffer(config.salt);
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // ---------- 5 Export types ----------
    buildFirefoxRestoreJSON,
    collectFaviconsForExport,
    collectFirefoxTreeAsJSON,
    collectEncryptedAsPlain,
    collectEncryptedAsBackup,

    // ---------- Constants ----------
    MAX_FAVICON_SIZE,
    FIREFOX_ROOT_IDS,

    // ---------- Internal (exposed for tests) ----------
    _internal: {
      convertFirefoxTreeToRestore
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_EXPORT_SERVICE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_EXPORT_SERVICE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Export Service ready (v12.2.0 FAV-01/02/03: ' +
      'dual-format favicon export (string + object) + ' +
      'MAX_FAVICON_SIZE=50KB (consistency με favicon-service) + ' +
      'diagnostics counters)'
    );
  }

  return api;
})();