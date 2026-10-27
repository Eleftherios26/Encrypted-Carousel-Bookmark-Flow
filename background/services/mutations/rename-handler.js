/**
 * rename-handler.js — Rename handler (sequencer command)
 *
 * @path     background/services/mutations/rename-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Sequencer command handler για rename operations. Re-encrypt-άρει
 *   το record με νέο title (ίδιο AAD → ίδιο Merkle leaf). Ο
 *   commitmentRoot παραμένει ΑΜΕΤΑΒΛΗΤΟ.
 *
 * KEY CONCEPTS
 *   • Merkle leaf: { id, parentId, positionKey, recordType, keyVersion }
 *     → Το rename ΔΕΝ αλλάζει κανένα από αυτά
 *   • Re-encryption: ΝΕΟ nonce + ciphertext + tag, ΑΛΛΑ ίδιο AAD
 *   • No-op: αν το title είναι ίδιο → skip + ίδιο generation
 *   • updateMerkle([]) καλείται για consistency (ο sequencer απαιτεί
 *     commitmentRoot)
 *
 * DECISIONS
 *   D-18, D-19, D-20
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "rename"
 */

var CBF_MUTATION_RENAME = (function() {
  'use strict';

  const MAX_TITLE_LENGTH = 500;
  const ROOT_ID = 'ecbf-root';

  function _validatePayload(payload) {
    const { id, title } = payload || {};

    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('rename: id required');
    }
    if (id === ROOT_ID) {
      throw new Error('rename: cannot rename root');
    }
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('rename: title must be a non-empty string');
    }
    if (title.length > MAX_TITLE_LENGTH) {
      throw new Error('rename: title too long');
    }
  }

  async function prepare(payload, ctx) {
    _validatePayload(payload);

    const { id, title } = payload;

    // ---------- 1. Read state ----------
    const state = await ctx.readState();
    if (!state) throw new Error('rename: vault state not found');

    // ---------- 2. Read record ----------
    const record = await ctx.readRecord(id);
    if (!record) throw new Error('rename: record not found');
    if (record._corrupted) throw new Error('rename: record is corrupted');

    // ---------- 3. No-op check ----------
    if (record.title === title) {
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
        result: { id, title, noop: true }
      };
    }

    // ---------- 4. Re-encrypt (ίδιο AAD) ----------
    const encrypted = await ctx.buildRecord({
      id: record.id,
      parentId: record.parentId,
      positionKey: record.positionKey,
      type: record.type,
      title,
      url: record.url
    });

    // ---------- 5. Update Merkle ----------
    //  Το leaf του renamed record ΔΕΝ αλλάζει (ίδιο id/parentId/positionKey/
    //  recordType/keyVersion). ΑΛΛΑ καλούμε updateMerkle για consistency.
    const newCommitmentRoot = await ctx.updateMerkle([]);

    // ---------- 6. New generation ----------
    const newGen = state.treeGeneration + 1;

    // ---------- 7. New meta record ----------
    const meta = await ctx.readMeta();
    if (!meta) throw new Error('rename: vault meta not found');

    const newMetaRecord = await ctx.buildMetaRecord({
      rootId: meta.rootId,
      recordCount: meta.recordCount,        // ΔΕΝ αλλάζει
      treeGeneration: newGen,
      commitmentRoot: newCommitmentRoot,
      positionKey: meta.positionKey || CBF_POSKEYS.toStored(0n)
    });

    // ---------- 8. New state record ----------
    const newStateRecord = await ctx.buildStateRecord({
      treeGeneration: newGen,
      schemaVersion: state.schemaVersion,
      _rotation: null,
      _migration: null
    });

    // ---------- 9. Return ----------
    return {
      writes: [encrypted],
      deletes: [],
      newMetaRecord,
      newStateRecord,
      result: { id, title }
    };
  }

  const api = { prepare };

  if (typeof self !== 'undefined') self.CBF_MUTATION_RENAME = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_RENAME = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Mutation handler: rename ready (stateMAC + Merkle)');
  }

  return api;
})();