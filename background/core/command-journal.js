// background/core/command-journal.js
//
// ECBF v12E Final 1 — Command Journal (DIAGNOSTICS-ONLY)
//
// @contract ECBF-v12E-Final1-Contract-Freeze v1.1
// @section 10.2 (Idempotency — sequencer in-tx)
// @decision D-15 (command-journal = thin wrapper → ΔΕΝ είναι στη ροή mutations)
//
// ═══════════════════════════════════════════════════════════════════
//  ΣΗΜΑΝΤΙΚΟ — ΓΙΑΤΙ ΑΥΤΟ ΤΟ ΑΡΧΕΙΟ ΔΕΝ ΕΙΝΑΙ ΣΤΟ MANIFEST
// ═══════════════════════════════════════════════════════════════════
//
//  Per D-15 (Locked Decision):
//    «command-journal = thin wrapper over processedCommands → ΚΑΤΑΡΓΗΘΗΚΕ»
//    Rationale: Single transaction — η idempotency γίνεται in-tx
//    από τον CBF_SEQUENCER, στο ίδιο writeTx με το mutation.
//
//  Αυτό το module:
//    ✅ ΔΕΝ εκτελεί mutations
//    ✅ ΔΕΝ έχει δική του DB
//    ✅ ΔΕΝ είναι μέρος της ροής idempotency
//    ✅ ΔΕΝ είναι στο manifest (δεν φορτώνεται αυτόματα)
//
//  Χρήση:
//    - Diagnostics (inspect processedCommands)
//    - Manual cleanup (αν χρειαστεί)
//    - Testing
//
//  Αν θέλεις να το ενεργοποιήσεις:
//    1. Πρόσθεσέ το στο manifest.json ΜΕΤΑ το vault-transaction.js
//    2. Κάλεσε CBF_JOURNAL.startCleanupInterval() από το background.js
//
//  Αν ΔΕΝ το χρειάζεσαι:
//    Διάγραψε το αρχείο. Δεν επηρεάζει τη λειτουργία.
//
// ═══════════════════════════════════════════════════════════════════
//  ΑΛΛΑΓΕΣ (Batch C — cleanup)
// ═══════════════════════════════════════════════════════════════════
//
//  1. Αφαιρέθηκε το top-level `setInterval` (side-effect on load)
//     → Αντικαταστάθηκε με explicit `startCleanupInterval()`
//  2. Διορθώθηκε Korean χαρακτήρας στο docstring (통계 → στατιστικά)
//  3. Προστέθηκε `isStarted()` diagnostic
//  4. Βελτιωμένα σχόλια & docstrings
//  5. Καθαρή σήμανση ως DIAGNOSTICS-ONLY
//
// ═══════════════════════════════════════════════════════════════════

var CBF_JOURNAL = (function() {
  'use strict';

  // ============================================================
  //  Σταθερές
  // ============================================================
  const STORE = CBF_VAULT_TX.STORE_JOURNAL;
  const DURABLE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 ώρες
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;   // 1 ώρα

  // ============================================================
  //  State
  // ============================================================
  let cleanupTimerId = null;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[JOURNAL]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[JOURNAL]', ...a); }

  // ============================================================
  //  Read — diagnostics API
  // ============================================================

  /**
   * Επιστρέφει την εγγραφή για ένα commandId ή null.
   *
   * @param  {string} commandId
   * @returns {Promise<{ commandId: string, generation: number, timestamp: number }|null>}
   */
  async function getEntry(commandId) {
    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new Error('getEntry: commandId required');
    }
    const rec = await CBF_VAULT_TX.readTx([STORE], async (s) => {
      return CBF_VAULT_TX.idbRequest(s[STORE].get(commandId));
    });
    return rec || null;
  }

  /**
   * Λίστα πρόσφατων εγγραφών, ταξινομημένες κατά timestamp DESC.
   *
   * @param  {number} [limit=50]
   * @returns {Promise<Array>}
   */
  async function listRecent(limit = 50) {
    const all = await CBF_VAULT_TX.readTx([STORE], async (s) => {
      return CBF_VAULT_TX.idbRequest(s[STORE].getAll());
    });
    all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return all.slice(0, Math.max(0, limit));
  }

  /**
   * Πόσες εγγραφές υπάρχουν.
   *
   * @returns {Promise<number>}
   */
  async function count() {
    return CBF_VAULT_TX.readTx([STORE], async (s) => {
      return CBF_VAULT_TX.idbRequest(s[STORE].count());
    });
  }

  /**
   * Ελέγχει αν ένα commandId υπάρχει.
   * Χρησιμοποιείται ΜΟΝΟ για diagnostics / tests.
   *
   * ⚠️ Για mutations, ο έλεγχος γίνεται in-tx από τον sequencer (D-15).
   *
   * @param  {string} commandId
   * @returns {Promise<boolean>}
   */
  async function has(commandId) {
    const e = await getEntry(commandId);
    return e !== null;
  }

  /**
   * Στατιστικά του journal.
   *
   * @returns {Promise<{ count, oldestTimestamp, newestTimestamp }>}
   */
  async function stats() {
    const all = await CBF_VAULT_TX.readTx([STORE], async (s) => {
      return CBF_VAULT_TX.idbRequest(s[STORE].getAll());
    });
    if (all.length === 0) {
      return { count: 0, oldestTimestamp: null, newestTimestamp: null };
    }
    let oldest = Infinity, newest = -Infinity;
    for (const e of all) {
      const t = e.timestamp || 0;
      if (t < oldest) oldest = t;
      if (t > newest) newest = t;
    }
    return {
      count: all.length,
      oldestTimestamp: oldest === Infinity ? null : oldest,
      newestTimestamp: newest === -Infinity ? null : newest
    };
  }

  // ============================================================
  //  Cleanup
  // ============================================================

  /**
   * Διαγράφει εγγραφές παλαιότερες από TTL.
   *
   * Χρησιμοποιεί writeTx με cursor iteration. Τα cursor events
   * είναι IDB events → το transaction δεν κλείνει πρόωρα (D-8 OK).
   *
   * @param  {number} [ttlMs=DURABLE_TTL_MS] — default 24h
   * @returns {Promise<number>} — πόσες διαγράφηκαν
   */
  async function cleanup(ttlMs = DURABLE_TTL_MS) {
    const cutoff = Date.now() - ttlMs;
    let deleted = 0;

    await CBF_VAULT_TX.writeTx([STORE], async (s) => {
      const store = s[STORE];

      await new Promise((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return resolve();
          if ((cursor.value.timestamp || 0) < cutoff) {
            cursor.delete();
            deleted++;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });

    if (deleted > 0) {
      log(`Cleanup: ${deleted} entries removed`);
    }
    return deleted;
  }

  // ============================================================
  //  Cleanup interval — explicit start / stop
  // ============================================================

  /**
   * Ξεκινάει το periodic cleanup (κάθε 1 ώρα).
   * Idempotent: αν τρέχει ήδη, δεν κάνει τίποτα.
   */
  function startCleanupInterval() {
    if (cleanupTimerId !== null) {
      warn('Cleanup interval already running');
      return;
    }

    cleanupTimerId = setInterval(() => {
      cleanup().catch(e => {
        warn('Cleanup failed:', e.message);
      });
    }, CLEANUP_INTERVAL_MS);

    log('Cleanup interval started (every 1h)');
  }

  /**
   * Σταματάει το periodic cleanup.
   */
  function stopCleanupInterval() {
    if (cleanupTimerId === null) return;
    clearInterval(cleanupTimerId);
    cleanupTimerId = null;
    log('Cleanup interval stopped');
  }

  /**
   * Είναι ενεργό το periodic cleanup;
   */
  function isStarted() {
    return cleanupTimerId !== null;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // ---------- Read (diagnostics) ----------
    getEntry,
    listRecent,
    count,
    has,
    stats,

    // ---------- Maintenance ----------
    cleanup,
    startCleanupInterval,
    stopCleanupInterval,
    isStarted,

    // ---------- Constants ----------
    DURABLE_TTL_MS,
    CLEANUP_INTERVAL_MS,
    STORE
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_JOURNAL = api;
  if (typeof self !== 'undefined') self.CBF_JOURNAL = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_JOURNAL = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Command Journal ready (DIAGNOSTICS-ONLY, per D-15 — NOT in manifest)'
    );
  }

  return api;
})();