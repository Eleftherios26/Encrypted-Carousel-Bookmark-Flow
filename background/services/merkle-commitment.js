/**
 * merkle-commitment.js — Incremental Merkle commitment (tamper detection)
 *
 * @path     background/services/merkle-commitment.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Δομικό commitment των records ενός vault. Επιτρέπει ανίχνευση:
 *     ✅ Tampering (αλλαγή δομικών metadata)
 *     ✅ Partial deletion (διαγραφή ενός record)
 *     ✅ Partial rollback (επαναφορά ενός record)
 *     ❌ Whole-vault rollback (ΟΧΙ — βλ. D-20 v1.1 §13)
 *
 * LEAF FORMAT (§5.1)
 *   leaf(record) = HMAC-SHA256(
 *     commitmentKey,
 *     utf8(canonicalJSON({
 *       id, parentId, positionKey, recordType, keyVersion
 *     }))
 *   )
 *
 *   ΔΕΝ περιλαμβάνει: nonce, ciphertext, tag, formatVersion, title, url.
 *
 * ROOT FORMAT (§6.1)
 *   1. Collect leaves (exclude 'vault-meta')
 *   2. Sort by id (ASCII lexicographic)
 *   3. Build bottom-up:
 *        internal = HMAC-SHA256(commitmentKey, left ‖ right)
 *        odd level: duplicate last
 *   4. Empty: 32 zero bytes
 *   5. Single record: root = leaf
 *
 * NON-OBVIOUS
 *   • Ο(η) complexity: updateIncremental κάνει FULL tree rebuild από
 *     όλα τα leaves (ΟΧΙ O(log n)). Για 10k records ~10-50ms. Για 1M
 *     records ~1-5s. Post-MVP: persistent Merkle.
 *   • Το vault-meta record ΔΕΝ συμμετέχει στο Merkle tree (circular
 *     dependency — το meta περιέχει το commitmentRoot).
 *   • Hash length = 32 bytes (HMAC-SHA256 output).
 *
 * CONTRACT
 *   ECBF-v12E-Final1-Contract-Freeze v1.1 §5-§6
 *
 * DECISIONS
 *   D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "merkle-commitment"
 */

var CBF_MERKLE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const HASH_LENGTH = 32;
  const EXCLUDED_IDS = Object.freeze(['vault-meta']);   // §5.2 rule 7

  // ============================================================
  //  concatBytes — helper
  // ============================================================
  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // ============================================================
  //  hmacSHA256 — internal HMAC helper
  // ============================================================
  async function hmacSHA256(commitmentKey, data) {
    if (!commitmentKey) {
      throw new Error('merkle: commitmentKey required');
    }
    if (!(data instanceof Uint8Array)) {
      throw new Error('merkle: data must be Uint8Array');
    }

    const sigBuffer = await crypto.subtle.sign('HMAC', commitmentKey, data);
    return new Uint8Array(sigBuffer);
  }

  // ============================================================
  //  computeLeafHash — pure function
  // ============================================================
  async function computeLeafHash(record, commitmentKey) {
    if (!record || typeof record !== 'object') {
      throw new Error('merkle: record must be object');
    }
    if (typeof record.id !== 'string' || record.id.length === 0) {
      throw new Error('merkle: record.id required');
    }
    if (typeof record.parentId !== 'string' && record.parentId !== null) {
      throw new Error('merkle: record.parentId must be string or null');
    }
    if (typeof record.positionKey !== 'string') {
      throw new Error('merkle: record.positionKey must be string');
    }
    if (record.recordType !== 'bookmark' && record.recordType !== 'folder') {
      throw new Error('merkle: record.recordType invalid');
    }
    if (typeof record.keyVersion !== 'number' || record.keyVersion < 1) {
      throw new Error('merkle: record.keyVersion must be ≥ 1');
    }

    const canonicalBytes = CBF_CANONICAL.canonicalBytes({
      id: record.id,
      parentId: record.parentId,
      positionKey: record.positionKey,
      recordType: record.recordType,
      keyVersion: record.keyVersion
    });

    try {
      return await hmacSHA256(commitmentKey, canonicalBytes);
    } finally {
      CBF_CRYPTO.zeroBuffer(canonicalBytes);
    }
  }

  // ============================================================
  //  isExcluded
  // ============================================================
  function isExcluded(recordId) {
    return EXCLUDED_IDS.includes(recordId);
  }

  // ============================================================
  //  compareById — ASCII lexicographic
  // ============================================================
  function compareById(a, b) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }

  // ============================================================
  //  MerkleCommitment — class
  // ============================================================
  class MerkleCommitment {
    /**
     * @param {CryptoKey} commitmentKey — HMAC-SHA256 key
     */
    constructor(commitmentKey) {
      if (!commitmentKey) {
        throw new Error('MerkleCommitment: commitmentKey required');
      }
      this.key = commitmentKey;
      this.leaves = new Map();     // id → Uint8Array(32)
      this._root = null;
      this._dirty = true;
    }

    // ==========================================================
    //  computeLeaf — instance method
    // ==========================================================
    async computeLeaf(record) {
      return await computeLeafHash(record, this.key);
    }

    // ==========================================================
    //  buildTree — full rebuild από όλα τα records
    //
    //  O(n): υπολογίζει όλα τα leaves + χτίζει το δέντρο.
    // ==========================================================
    async buildTree(allRecords) {
      if (!Array.isArray(allRecords)) {
        throw new Error('merkle: allRecords must be array');
      }

      this.leaves.clear();

      // 1. Compute all leaves (except excluded)
      for (const record of allRecords) {
        if (isExcluded(record.id)) continue;
        const leaf = await this.computeLeaf(record);
        this.leaves.set(record.id, leaf);
      }

      // 2. Build tree
      const root = await this._buildRootFromLeaves();
      this._root = root;
      this._dirty = false;
      return root;
    }

    // ==========================================================
    //  updateIncremental
    //
    //  Ενημερώνει μόνο τα affected leaves, μετά κάνει full root
    //  rebuild (O(n) — §6.3).
    //
    //  @param {Array} affectedRecords — records που άλλαξαν
    //         (πρέπει να έχουν flag `_deleted: true` για διαγραφή)
    //  @param {Array} allRecords — ΟΛΑ τα records (για rebuild)
    // ==========================================================
    async updateIncremental(affectedRecords, allRecords) {
      if (!Array.isArray(affectedRecords)) {
        throw new Error('merkle: affectedRecords must be array');
      }

      // 1. Update affected leaves only
      for (const record of affectedRecords) {
        if (isExcluded(record.id)) continue;

        if (record._deleted === true) {
          this.leaves.delete(record.id);
        } else {
          const leaf = await this.computeLeaf(record);
          this.leaves.set(record.id, leaf);
        }
      }

      // 2. Reconcile with allRecords if provided
      //    Αυτό είναι ασφαλές ΜΟΝΟ όταν το affectedRecords περιέχει
      //    ΟΛΕΣ τις αλλαγές. Αν δεν το εμπιστευόμαστε, κάνουμε full
      //    sync (πιο αργό αλλά πιο ασφαλές).
      if (Array.isArray(allRecords)) {
        const allIds = new Set();
        for (const record of allRecords) {
          if (isExcluded(record.id)) continue;
          allIds.add(record.id);
        }
        // Remove leaves που δεν υπάρχουν πια
        for (const id of [...this.leaves.keys()]) {
          if (!allIds.has(id)) {
            this.leaves.delete(id);
          }
        }
        // Add missing leaves
        for (const record of allRecords) {
          if (isExcluded(record.id)) continue;
          if (!this.leaves.has(record.id)) {
            const leaf = await this.computeLeaf(record);
            this.leaves.set(record.id, leaf);
          }
        }
      }

      // 3. Full root rebuild (O(n))
      const root = await this._buildRootFromLeaves();
      this._root = root;
      this._dirty = false;
      return root;
    }

    // ==========================================================
    //  _buildRootFromLeaves — internal
    //
    //  O(n). Deterministic. Handles:
    //    • Empty vault   → 32 zero bytes
    //    • Single record → root = leaf
    //    • Even count    → standard pairing
    //    • Odd count     → duplicate last
    // ==========================================================
    async _buildRootFromLeaves() {
      // Empty vault
      if (this.leaves.size === 0) {
        return new Uint8Array(HASH_LENGTH);
      }

      // Sort by id (ASCII)
      const sorted = [...this.leaves.entries()].sort((a, b) => {
        if (a[0] < b[0]) return -1;
        if (a[0] > b[0]) return 1;
        return 0;
      });

      // Extract hashes
      let level = sorted.map(([_, hash]) => hash);

      // Single record
      if (level.length === 1) {
        return level[0].slice();
      }

      // Build bottom-up
      while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
          const left = level[i];
          const right = (i + 1 < level.length) ? level[i + 1] : left;
          const combined = concatBytes(left, right);
          try {
            const parent = await hmacSHA256(this.key, combined);
            next.push(parent);
          } finally {
            CBF_CRYPTO.zeroBuffer(combined);
          }
        }
        level = next;
      }

      return level[0];
    }

    // ==========================================================
    //  verify — full rebuild + compare με expected root
    // ==========================================================
    async verify(allRecords, expectedRootB64) {
      if (typeof expectedRootB64 !== 'string') {
        throw new Error('merkle: expectedRootB64 must be base64 string');
      }

      const freshRoot = await this.buildTree(allRecords);
      const freshB64 = CBF_CRYPTO.bufToB64(freshRoot);
      return CBF_TIMING_SAFE.timingSafeEqualString(freshB64, expectedRootB64);
    }

    // ==========================================================
    //  Diagnostics
    // ==========================================================
    getLeaf(id) {
      return this.leaves.get(id) || null;
    }

    getLeafCount() {
      return this.leaves.size;
    }

    getRootB64() {
      if (!this._root) return null;
      return CBF_CRYPTO.bufToB64(this._root);
    }

    // ==========================================================
    //  zeroize — καθαρισμός σε lock
    // ==========================================================
    zeroize() {
      for (const hash of this.leaves.values()) {
        CBF_CRYPTO.zeroBuffer(hash);
      }
      this.leaves.clear();
      if (this._root) {
        CBF_CRYPTO.zeroBuffer(this._root);
        this._root = null;
      }
      this.key = null;
      this._dirty = true;
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    MerkleCommitment,
    computeLeafHash,

    _internal: {
      HASH_LENGTH,
      EXCLUDED_IDS,
      hmacSHA256,
      concatBytes,
      isExcluded,
      compareById
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_MERKLE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MERKLE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Merkle Commitment ready (D-20, O(n) rebuild per §6.3)');
  }

  return api;
})();