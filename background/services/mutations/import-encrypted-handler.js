/**
 * import-encrypted-handler.js — Bulk import via sequencer
 *
 * @path     background/services/mutations/import-encrypted-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Sequencer handler για bulk import encrypted records.
 *   1 command = 1 transaction = 1 generation increment (D-3, D-56).
 *
 * FLOW
 *   1. Validate payload (records array, mode = 'skip-existing')
 *   2. V12E.E-ROOT-01: SKIP root records (silently)
 *   3. Filter existing IDs (skip-existing mode)
 *   4. Validate parent references
 *   5. Update Merkle
 *   6. New generation (+1)
 *   7. New meta + new state (stateMAC)
 *   8. Return PreparedMutation
 *
 * NON-OBVIOUS
 *   • Τα records είναι ΗΔΗ κρυπτογραφημένα με τον τρέχοντα storeKey —
 *     ο handler ΔΕΝ κάνει decrypt, τα ciphertexts περνάνε διαμπερώς.
 *   • V12E.E-ROOT-01: Το export περιλαμβάνει το `ecbf-root` record.
 *     Χωρίς skip, το import αποτύγχανε με "records[i].id cannot be root".
 *     Λύση: ΑΓΝΟΟΥΜΕ το root record (πάντα υπάρχει σε κάθε vault).
 *   • V12E.E-LOAD-01: ASCII-only source code (encoding-safe).
 *     Greek strings encoded σε \uXXXX escapes.
 *   • No-op optimization: αν όλα τα records είναι root/existing →
 *     return no-op με ίδιο state (χωρίς generation increment).
 *
 * DECISIONS
 *   D-3, D-18, D-19, D-20, D-56
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "import-encrypted-handler"
 */

var CBF_MUTATION_IMPORT_ENCRYPTED = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_RECORDS_PER_IMPORT = 50000;
  const ROOT_ID = 'ecbf-root';

  // ============================================================
  //  Validation
  //
  //  V12E.E-ROOT-01: Skip root records αντί throw
  // ============================================================
  function _validatePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('importEncrypted: payload must be an object');
    }
    if (!Array.isArray(payload.records)) {
      throw new Error('importEncrypted: records must be an array');
    }
    if (payload.records.length === 0) {
      throw new Error('importEncrypted: records cannot be empty');
    }
    if (payload.records.length > MAX_RECORDS_PER_IMPORT) {
      throw new Error(
        'importEncrypted: too many records (' +
        payload.records.length + ' > ' + MAX_RECORDS_PER_IMPORT + ')'
      );
    }

    const mode = payload.mode || 'skip-existing';
    if (mode !== 'skip-existing') {
      throw new Error('importEncrypted: only mode "skip-existing" is supported (D-56)');
    }

    // Per-record shape validation
    // V12E.E-ROOT-01: SKIP root records (silently)
    const validated = [];
    let rootSkipped = 0;

    for (let i = 0; i < payload.records.length; i++) {
      const rec = payload.records[i];
      const prefix = 'records[' + i + ']';

      if (!rec || typeof rec !== 'object') {
        throw new Error('importEncrypted: ' + prefix + ' must be object');
      }
      if (typeof rec.id !== 'string' || rec.id.length === 0) {
        throw new Error('importEncrypted: ' + prefix + '.id required');
      }

      // V12E.E-ROOT-01: Skip root
      if (rec.id === ROOT_ID) {
        rootSkipped++;
        continue;
      }

      if (rec.parentId !== null && rec.parentId !== ROOT_ID &&
          (typeof rec.parentId !== 'string' || rec.parentId.length === 0)) {
        throw new Error('importEncrypted: ' + prefix + '.parentId must be string|null');
      }
      if (rec.recordType !== 'bookmark' && rec.recordType !== 'folder') {
        throw new Error('importEncrypted: ' + prefix + '.recordType invalid');
      }
      if (typeof rec.positionKey !== 'string' || rec.positionKey.length === 0) {
        throw new Error('importEncrypted: ' + prefix + '.positionKey required');
      }
      if (typeof rec.nonce !== 'string' || rec.nonce.length === 0) {
        throw new Error('importEncrypted: ' + prefix + '.nonce required');
      }
      if (typeof rec.ciphertext !== 'string' || rec.ciphertext.length === 0) {
        throw new Error('importEncrypted: ' + prefix + '.ciphertext required');
      }
      if (typeof rec.tag !== 'string' || rec.tag.length === 0) {
        throw new Error('importEncrypted: ' + prefix + '.tag required');
      }
      if (typeof rec.keyVersion !== 'number' || rec.keyVersion < 1) {
        throw new Error('importEncrypted: ' + prefix + '.keyVersion invalid');
      }
      if (typeof rec.formatVersion !== 'number' || rec.formatVersion < 1) {
        throw new Error('importEncrypted: ' + prefix + '.formatVersion invalid');
      }

      validated.push({
        id: rec.id,
        parentId: rec.parentId || ROOT_ID,
        positionKey: rec.positionKey,
        recordType: rec.recordType,
        keyVersion: rec.keyVersion,
        formatVersion: rec.formatVersion,
        nonce: rec.nonce,
        ciphertext: rec.ciphertext,
        tag: rec.tag
      });
    }

    // Duplicate ID check (fail-fast)
    const seen = new Set();
    for (const rec of validated) {
      if (seen.has(rec.id)) {
        throw new Error('importEncrypted: duplicate ID ' + rec.id);
      }
      seen.add(rec.id);
    }

    return { records: validated, mode, rootSkipped };
  }

  // ============================================================
  //  Filter existing (skip-existing mode)
  // ============================================================
  async function _filterExisting(records, ctx) {
    const allExisting = await ctx.readAllRecords();
    const existingIds = new Set(allExisting.map(r => r.id));

    const toImport = [];
    const skipped = [];

    for (const rec of records) {
      if (existingIds.has(rec.id)) {
        skipped.push(rec.id);
      } else {
        toImport.push(rec);
      }
    }

    return { toImport, skipped };
  }

  // ============================================================
  //  Validate parent references
  // ============================================================
  async function _validateParentRefs(toImport, ctx) {
    const existingIds = new Set(
      (await ctx.readAllRecords()).map(r => r.id)
    );
    existingIds.add(ROOT_ID);

    const importIds = new Set(toImport.map(r => r.id));

    for (const rec of toImport) {
      if (rec.parentId === null || rec.parentId === ROOT_ID) continue;
      if (existingIds.has(rec.parentId)) continue;
      if (importIds.has(rec.parentId)) continue;

      throw new Error(
        'importEncrypted: parentId ' + rec.parentId +
        ' not found (for record ' + rec.id + ')'
      );
    }
  }

  // ============================================================
  //  prepare(payload, ctx) → PreparedMutation
  // ============================================================
  async function prepare(payload, ctx) {
    // 1. Validate (V12E.E-ROOT-01: skips root)
    const validated = _validatePayload(payload);
    const records = validated.records;
    const rootSkipped = validated.rootSkipped;

    // 2. Read state + meta
    const state = await ctx.readState();
    if (!state) throw new Error('importEncrypted: vault state not found');

    const meta = await ctx.readMeta();
    if (!meta) throw new Error('importEncrypted: vault meta not found');

    // 3. Skip-existing filter
    const filterResult = await _filterExisting(records, ctx);
    const toImport = filterResult.toImport;
    const skipped = filterResult.skipped;

    // V12E.E-ROOT-01: Αν όλα τα records ήταν root/existing → no-op
    if (toImport.length === 0) {
      CBF_LOGGER.info(
        '[IMPORT] No-op: 0 records to import ' +
        '(skipped=' + skipped.length + ', rootSkipped=' + rootSkipped + ')'
      );

      return {
        writes: [],
        deletes: [],
        newMetaRecord: null,
        newStateRecord: {
          id: CBF_VAULT_TX.VAULT_STATE_ID,
          treeGeneration: state.treeGeneration,
          schemaVersion: state.schemaVersion,
          _rotation: null,
          _migration: null,
          stateMAC: state.stateMAC
        },
        result: {
          importedCount: 0,
          skippedCount: skipped.length,
          rootSkippedCount: rootSkipped,
          totalCount: payload.records.length,
          noop: true
        }
      };
    }

    // 4. Parent reference validation
    await _validateParentRefs(toImport, ctx);

    // 5. Update Merkle
    const affectedForMerkle = toImport.map(function(w) {
      return {
        id: w.id,
        parentId: w.parentId,
        positionKey: w.positionKey,
        recordType: w.recordType,
        keyVersion: w.keyVersion
      };
    });

    const newCommitmentRoot = await ctx.updateMerkle(affectedForMerkle);

    // 6. New generation
    const newGen = state.treeGeneration + 1;

    // 7. New meta record
    const newRecordCount = meta.recordCount + toImport.length;

    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: newRecordCount,
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // 8. New state record (stateMAC στο prepare)
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // 9. Audit log
    CBF_LOGGER.security(
      '[IMPORT] importEncrypted: ' + toImport.length + ' records ' +
      '(' + skipped.length + ' existing, ' + rootSkipped + ' root skipped) -> gen ' +
      state.treeGeneration + ' -> ' + newGen
    );

    // 10. Return
    return {
      writes: toImport,
      deletes: [],
      newMetaRecord: newMetaRecord,
      newStateRecord: newStateRecord,
      result: {
        importedCount: toImport.length,
        skippedCount: skipped.length,
        rootSkippedCount: rootSkipped,
        totalCount: payload.records.length,
        generation: newGen
      }
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    prepare: prepare,
    MAX_RECORDS_PER_IMPORT: MAX_RECORDS_PER_IMPORT
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_MUTATION_IMPORT_ENCRYPTED = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_IMPORT_ENCRYPTED = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation handler: importEncrypted ready ' +
      '(V12E.E-LOAD-01 + V12E.E-ROOT-01: 1 tx, 1 gen, ' +
      'skip-existing + skip-root, encoding-safe)'
    );
  }

  return api;
})();