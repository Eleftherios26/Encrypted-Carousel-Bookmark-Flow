/**
 * vault-transaction.js — Vault transaction helper
 *
 * @path     background/core/vault-transaction.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Χαμηλού επιπέδου IndexedDB helpers για το vault. Ορίζει το DB
 *   schema, τους transaction runners (readTx / writeTx), και τα
 *   migration helpers (v2 → v3).
 *
 * DB SCHEMA v3
 *   Database name: ECBF_Vault
 *   DB_VERSION: 3
 *
 *   Stores:
 *     • records            — { id, parentId, positionKey, recordType,
 *                              keyVersion, formatVersion, nonce,
 *                              ciphertext, tag }
 *     • meta               — { id: 'vault-meta', nonce, ciphertext, tag,
 *                              parentId, positionKey, recordType,
 *                              keyVersion, formatVersion }
 *     • state              — { id: 'vault-state', treeGeneration,
 *                              schemaVersion, _rotation, _migration,
 *                              stateMAC }
 *     • processedCommands  — { commandId, generation, timestamp }
 *
 * KEY CONCEPTS
 *   • D-8: NO crypto μέσα στο tx callback (auto-commit race)
 *   • readTx: read-only, ΔΕΝ περιμένει txComplete (auto-complete safe)
 *   • writeTx: read-write, ΠΕΡΙΜΕΝΕΙ txComplete (πρέπει να ολοκληρωθεί)
 *   • Migration v2 → v3: schema upgrade στο onupgradeneeded,
 *     functional migration στο UNLOCK (out-of-tx)
 *
 * DECISIONS
 *   D-7, D-8, D-9, D-15
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "vault-transaction"
 */

var CBF_VAULT_TX = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const DB_NAME    = 'ECBF_Vault';
  const DB_VERSION = 3;

  const STORE_RECORDS  = 'records';
  const STORE_META     = 'meta';
  const STORE_STATE    = 'state';
  const STORE_JOURNAL  = 'processedCommands';

  const VAULT_META_ID  = 'vault-meta';
  const VAULT_STATE_ID = 'vault-state';

  let dbPromise = null;

  // ============================================================
  //  Migration helpers — detect v2 state
  // ============================================================

  /**
   * v2 state = έχει treeGeneration αλλά ΟΧΙ stateMAC και ΟΧΙ _migration.
   * Αυτό είναι το σχήμα των vaults που δημιουργήθηκαν πριν το hardening.
   */
  function _isV2State(stateRec) {
    if (!stateRec) return false;
    return (
      typeof stateRec.treeGeneration === 'number' &&
      stateRec.stateMAC === undefined &&
      stateRec._migration === undefined
    );
  }

  /**
   * v3 state = έχει treeGeneration + stateMAC (string ή null) +
   *            _migration (object ή null).
   */
  function _isV3State(stateRec) {
    if (!stateRec) return false;
    return (
      typeof stateRec.treeGeneration === 'number' &&
      (stateRec.stateMAC === null || typeof stateRec.stateMAC === 'string') &&
      (stateRec._migration === null || typeof stateRec._migration === 'object')
    );
  }

  // ============================================================
  //  DB open / upgrade
  // ============================================================
  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        const oldVersion = e.oldVersion;

        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.info(
            `VaultTX: DB upgrade v${oldVersion} → v${DB_VERSION}`
          );
        }

        // ---------- records ----------
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          const recStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
          recStore.createIndex('parentId', 'parentId', { unique: false });
          recStore.createIndex('parentId_positionKey',
            ['parentId', 'positionKey'], { unique: false });
        }

        // ---------- meta ----------
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }

        // ---------- state ----------
        if (!db.objectStoreNames.contains(STORE_STATE)) {
          db.createObjectStore(STORE_STATE, { keyPath: 'id' });
        } else if (oldVersion === 2) {
          // v2 → v3 migration: προσθήκη _migration + stateMAC
          // ΣΗΜΑΝΤΙΚΟ: το πραγματικό functional migration γίνεται
          // στο UNLOCK (encrypted-space.js §11).
          // Εδώ απλώς προσθέτουμε τα πεδία ώστε να ενεργοποιηθεί
          // το migration flow στο επόμενο unlock.
          _migrateStateRecord_V2_to_V3(tx);
        }

        // ---------- processedCommands ----------
        if (!db.objectStoreNames.contains(STORE_JOURNAL)) {
          const jStore = db.createObjectStore(STORE_JOURNAL, { keyPath: 'commandId' });
          jStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.info(`VaultTX: DB upgrade complete (v${DB_VERSION})`);
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.warn('VaultTX: upgrade blocked — close other tabs');
        }
      };
    });

    return dbPromise;
  }

  // ============================================================
  //  Migration v2 → v3 (data-level)
  //
  //  ΣΗΜΑΝΤΙΚΟ: Τρέχει μέσα στο onupgradeneeded (sync, χωρίς await).
  //  ΔΕΝ κάνει crypto — μόνο προσθήκη πεδίων.
  //
  //  Το πραγματικό functional migration (stateMAC + commitmentRoot)
  //  τρέχει στο UNLOCK (βλ. encrypted-space.js §11).
  // ============================================================
  function _migrateStateRecord_V2_to_V3(tx) {
    try {
      const stateStore = tx.objectStore(STORE_STATE);
      const getReq = stateStore.get(VAULT_STATE_ID);

      getReq.onsuccess = () => {
        const stateRec = getReq.result;
        if (!stateRec) return;

        // Αν είναι ήδη v3, δεν κάνουμε τίποτα
        if (_isV3State(stateRec)) return;

        // Προσθήκη πεδίων v3
        const migrated = {
          ...stateRec,
          _migration: stateRec._migration ?? null,
          _rotation:  stateRec._rotation  ?? null,
          stateMAC:   stateRec.stateMAC   ?? null
        };

        // ΣΗΜΑΝΤΙΚΟ: ΔΕΝ θέτουμε _migration.phase = 'started'.
        // Το migration flow το ξεκινάει το encrypted-space.js στο unlock.
        // Απλώς σημειώνουμε ότι το state record είναι v3-compatible.
        stateStore.put(migrated);

        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.security(
            'VaultTX: state record migrated to v3 shape (pending functional migration)'
          );
        }
      };

      getReq.onerror = () => {
        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.error('VaultTX: migration state read failed: ' + getReq.error);
        }
      };
    } catch (e) {
      if (typeof CBF_LOGGER !== 'undefined') {
        CBF_LOGGER.error('VaultTX: migration v2→v3 failed: ' + e.message);
      }
    }
  }

  // ============================================================
  //  IDB helpers
  // ============================================================
  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function txComplete(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Transaction error'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  // ============================================================
  //  Transaction runners
  // ============================================================

  /**
   * Read-only transaction.
   *
   * ΣΗΜΑΝΤΙΚΟ: ΔΕΝ περιμένουμε txComplete.
   * Λόγος: αν ο caller κάνει non-IDB await (crypto decrypt) στο fn,
   * το read-only tx κάνει auto-complete. Το txComplete() θα περίμενε
   * για πάντα.
   *
   * Τα reads είναι valid — δεν έχει side effects, δεν χάνεται consistency.
   */
  async function readTx(storeNames, fn) {
    const db = await openDB();
    const tx = db.transaction(storeNames, 'readonly');
    const stores = _buildStores(tx, storeNames);

    try {
      return await fn(stores, tx);
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      throw e;
    }
  }

  /**
   * Read-write transaction.
   *
   * Το fn ΠΡΕΠΕΙ να περιορίζεται σε:
   *   - synchronous computation
   *   - IDB reads/writes μέσω idbRequest
   *
   * ΑΠΑΓΟΡΕΥΕΤΑΙ (D-8):
   *   - crypto.subtle.*
   *   - fetch / network
   *   - timers
   *   - οποιοδήποτε await σε non-IDB promise
   *
   * Εδώ ΠΕΡΙΜΕΝΟΥΜΕ txComplete (πρέπει να ολοκληρωθεί το commit).
   */
  async function writeTx(storeNames, fn) {
    const db = await openDB();
    const tx = db.transaction(storeNames, 'readwrite');
    const stores = _buildStores(tx, storeNames);

    let result;
    try {
      result = await fn(stores, tx);
    } catch (e) {
      try { tx.abort(); } catch (_) {}
      throw e;
    }

    await txComplete(tx);
    return result;
  }

  function _buildStores(tx, storeNames) {
    const obj = {};
    for (const name of storeNames) obj[name] = tx.objectStore(name);
    return obj;
  }

  // ============================================================
  //  Convenience helpers
  // ============================================================

  /**
   * Διαβάζει το state record.
   * @returns {Promise<object|null>}
   */
  async function readState() {
    return readTx([STORE_STATE], async (s) => {
      return idbRequest(s[STORE_STATE].get(VAULT_STATE_ID));
    });
  }

  /**
   * Διαβάζει το meta record.
   * @returns {Promise<object|null>}
   */
  async function readMeta() {
    return readTx([STORE_META], async (s) => {
      return idbRequest(s[STORE_META].get(VAULT_META_ID));
    });
  }

  /**
   * Διαβάζει όλα τα records.
   * @returns {Promise<Array>}
   */
  async function readAllRecords() {
    return readTx([STORE_RECORDS], async (s) => {
      return idbRequest(s[STORE_RECORDS].getAll());
    });
  }

  /**
   * Ελέγχει αν υπάρχει initialized vault (state record).
   * @returns {Promise<boolean>}
   */
  async function hasVault() {
    const state = await readState();
    return !!state;
  }

  /**
   * Reset DB — ΜΟΝΟ για tests / diagnostics.
   * Κλείνει την cached σύνδεση, διαγράφει τη βάση.
   */
  async function _resetDB() {
    if (dbPromise) {
      try {
        const db = await dbPromise;
        db.close();
      } catch (_) {}
      dbPromise = null;
    }

    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('Delete blocked'));
    });
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // Core
    openDB,
    readTx,
    writeTx,
    idbRequest,
    txComplete,

    // Convenience
    readState,
    readMeta,
    readAllRecords,
    hasVault,

    // Store names
    STORE_RECORDS,
    STORE_META,
    STORE_STATE,
    STORE_JOURNAL,

    // Well-known IDs
    VAULT_META_ID,
    VAULT_STATE_ID,

    // State detection (για encrypted-space.js migration flow)
    _isV2State,
    _isV3State,

    // Test / diagnostics only
    _internal: {
      DB_NAME,
      DB_VERSION,
      _resetDB,
      _migrateStateRecord_V2_to_V3
    }
  };

  if (typeof self !== 'undefined') self.CBF_VAULT_TX = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_VAULT_TX = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Vault Transaction Helper ready (DB v' + DB_VERSION +
      ': records/meta/state/journal)'
    );
  }

  return api;
})();