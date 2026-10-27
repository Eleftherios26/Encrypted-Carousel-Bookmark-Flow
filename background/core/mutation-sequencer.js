/**
 * mutation-sequencer.js — Mutation sequencer (single writer)
 *
 * @path     background/core/mutation-sequencer.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Single writer στο IDB — ο ΜΟΝΑΔΙΚΟΣ που εκτελεί mutations.
 *   Orchestrates: RAM cache → prepare (out-of-tx) → commit (in-tx) →
 *   post-commit. Εγγυάται stateMAC consistency + Merkle commitment
 *   + idempotency (1 command = 1 generation increment).
 *
 * ARCHITECTURE
 *   Overlay → messaging → CBF_SEQUENCER.execute()
 *                               │
 *                               ├─── 1. RAM cache check
 *                               ├─── 2. Handler dispatch
 *                               ├─── 3. prepare()  [out-of-tx]
 *                               │      - reads + crypto + plan
 *                               │      - stateMAC + Merkle
 *                               ├─── 4. commit()   [in-tx]
 *                               │      - generation check
 *                               │      - idempotency check
 *                               │      - writes/deletes
 *                               │      - meta + state + journal
 *                               └─── 5. Post-commit
 *
 * ENVIRONMENT
 *   • storeKey, stateMACKey, commitmentKey: από CBF_ES._internal
 *   • Merkle: fresh instance ανά execute() (αποφυγή shared state)
 *   • Transaction: single readwrite (records + meta + state + journal)
 *
 * COMMANDS (8)
 *   C3 (7):   create, rename, delete, move, reorder, merge, mergeFolders
 *   V12E (1): importEncrypted (D-56)
 *
 * DECISIONS
 *   D-3, D-5, D-6, D-7, D-8, D-9, D-18, D-19, D-20, D-56
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "mutation-sequencer"
 */

var CBF_SEQUENCER = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const RAM_TTL_MS = 10 * 60 * 1000;      // 10 λεπτά
  const SCHEMA_VERSION = 1;

  // ============================================================
  //  COMMANDS — 8 σύνολο (V12E)
  //
  //  C3 (7):   create, rename, delete, move, reorder,
  //            merge, mergeFolders
  //  V12E (1): importEncrypted (D-56)
  // ============================================================
  const COMMANDS = Object.freeze(new Set([
    // ─── Core (5) ───
    'create',
    'rename',
    'delete',
    'move',
    'reorder',

    // ─── Final 2 (B): D&D merge operations (2) ───
    'merge',
    'mergeFolders',

    // ─── V12E (D-56): Import encrypted (1) ───
    'importEncrypted'
  ]));

  // ============================================================
  //  RAM cache (optimization only — D-9)
  // ============================================================
  let queue = Promise.resolve();
  const ramCache = new Map();
  const handlers = new Map();

  function _ramCheck(commandId) {
    const e = ramCache.get(commandId);
    if (!e) return null;
    if (Date.now() - e.timestamp > RAM_TTL_MS) {
      ramCache.delete(commandId);
      return null;
    }
    return e;
  }

  function _ramStore(commandId, generation) {
    ramCache.set(commandId, { generation, timestamp: Date.now() });
  }

  function _ramCleanup() {
    const now = Date.now();
    for (const [id, e] of ramCache.entries()) {
      if (now - e.timestamp > RAM_TTL_MS) ramCache.delete(id);
    }
  }
  setInterval(_ramCleanup, 60 * 1000);

  // ============================================================
  //  Handler registry (D-6)
  // ============================================================
  function registerCommand(name, handler) {
    if (!COMMANDS.has(name)) {
      throw new Error(`registerCommand: unknown command "${name}"`);
    }
    if (!handler || typeof handler.prepare !== 'function') {
      throw new Error(`registerCommand: handler for "${name}" must have prepare()`);
    }
    if (handlers.has(name)) {
      throw new Error(`registerCommand: "${name}" already registered`);
    }
    handlers.set(name, handler);
    CBF_LOGGER.info(`Sequencer: registered command "${name}"`);
  }

  // ============================================================
  //  stateMAC helpers — καλούνται out-of-tx
  // ============================================================
  async function _computeStateMAC(state, stateMACKey) {
    const data = {
      treeGeneration: state.treeGeneration,
      schemaVersion: state.schemaVersion,
      _rotation: state._rotation ?? null,
      _migration: state._migration ?? null
    };
    const bytes = CBF_CANONICAL.canonicalBytes(data);
    try {
      const mac = await CBF_CRYPTO.hmacSign(stateMACKey, bytes);
      try {
        return CBF_CRYPTO.bufToB64(mac);
      } finally {
        CBF_CRYPTO.zeroBuffer(mac);
      }
    } finally {
      CBF_CRYPTO.zeroBuffer(bytes);
    }
  }

  // ============================================================
  //  Prepare context
  //
  //  Δίνει στον handler:
  //    - Reads (async, out-of-tx)
  //    - Crypto (async, out-of-tx)
  //    - Merkle update
  //    - stateMAC compute
  //    - commandId, expectedGeneration (read-only)
  // ============================================================
  function _buildPrepareContext(storeKey, stateMACKey, commitmentKey, commandId, expectedGeneration) {
    return {
      // ---------- pass-through ----------
      commandId,
      expectedGeneration,

      // ---------- reads ----------
      readState: async () => {
        return CBF_VAULT_TX.readState();
      },

      readMeta: async () => {
        const stateRec = await CBF_VAULT_TX.readState();
        if (!stateRec) return null;

        const metaRec = await CBF_VAULT_TX.readMeta();
        if (!metaRec) return null;

        return CBF_ES._internal.decryptMetaV3(metaRec, stateRec.treeGeneration);
      },

      readRecord: async (id) => {
        const rec = await CBF_VAULT_TX.readTx(
          [CBF_VAULT_TX.STORE_RECORDS],
          async (s) => CBF_VAULT_TX.idbRequest(
            s[CBF_VAULT_TX.STORE_RECORDS].get(id)
          )
        );
        if (!rec) return null;
        if (rec.id === CBF_ES.ROOT_ID) {
          return {
            id: rec.id,
            parentId: null,
            positionKey: rec.positionKey,
            type: 'folder',
            title: 'Root',
            url: null
          };
        }
        try {
          const plain = await CBF_ES._internal.decryptPayload(rec);
          return {
            id: rec.id,
            parentId: rec.parentId,
            positionKey: rec.positionKey,
            type: rec.recordType,
            title: plain.title || '',
            url: plain.url || null
          };
        } catch (e) {
          return { id: rec.id, _corrupted: true };
        }
      },

      readAllRecords: async () => {
        const recs = await CBF_VAULT_TX.readAllRecords();
        const out = [];
        for (const rec of recs) {
          if (rec.id === CBF_ES.ROOT_ID) {
            out.push({
              id: rec.id,
              parentId: null,
              positionKey: rec.positionKey,
              type: 'folder',
              title: 'Root',
              url: null
            });
            continue;
          }
          try {
            const plain = await CBF_ES._internal.decryptPayload(rec);
            out.push({
              id: rec.id,
              parentId: rec.parentId,
              positionKey: rec.positionKey,
              type: rec.recordType,
              title: plain.title || '',
              url: plain.url || null
            });
          } catch (e) {
            out.push({ id: rec.id, _corrupted: true });
          }
        }
        return out;
      },

      readChildren: async (parentId) => {
        const recs = await CBF_VAULT_TX.readTx(
          [CBF_VAULT_TX.STORE_RECORDS],
          async (s) => {
            const idx = s[CBF_VAULT_TX.STORE_RECORDS].index('parentId');
            return CBF_VAULT_TX.idbRequest(idx.getAll(parentId));
          }
        );
        const out = [];
        for (const rec of recs) {
          try {
            const plain = await CBF_ES._internal.decryptPayload(rec);
            out.push({
              id: rec.id,
              parentId: rec.parentId,
              positionKey: rec.positionKey,
              type: rec.recordType,
              title: plain.title || '',
              url: plain.url || null
            });
          } catch (_) {}
        }
        return out;
      },

      // ---------- crypto helpers ----------
      buildRecord: async ({ id, parentId, positionKey, type, title, url }) => {
        const plain = {
          title: title || '',
          url: type === 'bookmark' ? (url || null) : null
        };
        const enc = await CBF_ES._internal.encryptPayload(
          plain, id, parentId, positionKey, type
        );
        return {
          id,
          parentId,
          positionKey,
          recordType: type,
          keyVersion: CBF_ES._internal.getKeyVersion(),
          formatVersion: 1,
          nonce: enc.nonce,
          ciphertext: enc.ciphertext,
          tag: enc.tag
        };
      },

      buildMetaRecord: async ({ rootId, recordCount, treeGeneration, commitmentRoot, positionKey }) => {
        return CBF_ES._internal.buildMetaRecord(
          rootId, recordCount, treeGeneration, commitmentRoot, positionKey, true
        );
      },

      // ---------- state ----------
      computeStateMAC: async (state) => {
        return _computeStateMAC(state, stateMACKey);
      },

      buildStateRecord: async ({ treeGeneration, schemaVersion, _rotation, _migration }) => {
        const state = {
          treeGeneration,
          schemaVersion: schemaVersion ?? SCHEMA_VERSION,
          _rotation: _rotation ?? null,
          _migration: _migration ?? null
        };
        const stateMAC = await _computeStateMAC(state, stateMACKey);
        return {
          id: CBF_VAULT_TX.VAULT_STATE_ID,
          ...state,
          stateMAC
        };
      },

      // ---------- Merkle ----------
      /**
       * Φτιάχνει fresh Merkle instance (buildTree από όλα τα records),
       * εφαρμόζει τις αλλαγές, επιστρέφει νέο root B64.
       *
       * @param {Array} affected — records που άλλαξαν
       *   (με _deleted: true για διαγραφές)
       * @returns {Promise<string>} — root ως base64
       */
      updateMerkle: async (affected) => {
        const allRecordsRaw = await CBF_VAULT_TX.readAllRecords();

        const tempMerkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
        await tempMerkle.buildTree(allRecordsRaw);

        if (Array.isArray(affected) && affected.length > 0) {
          await tempMerkle.updateIncremental(affected, null);
        }

        const root = tempMerkle.getRootB64();
        tempMerkle.zeroize();
        return root;
      }
    };
  }

  // ============================================================
  //  Validation
  // ============================================================
  function _validateArgs(args) {
    if (!args || typeof args !== 'object') {
      throw new Error('execute: args object required');
    }
    const { commandId, expectedGeneration, command, payload, storeKey } = args;

    if (typeof commandId !== 'string' || commandId.length === 0) {
      throw new Error('execute: commandId required');
    }
    if (typeof expectedGeneration !== 'number' ||
        !Number.isInteger(expectedGeneration) ||
        expectedGeneration < 0) {
      throw new Error('execute: expectedGeneration must be non-negative integer');
    }
    if (typeof command !== 'string' || !COMMANDS.has(command)) {
      throw new Error(`execute: unknown command "${command}"`);
    }
    if (!storeKey) {
      throw new Error('execute: storeKey required');
    }
    if (payload !== undefined && (payload === null || typeof payload !== 'object')) {
      throw new Error('execute: payload must be an object if provided');
    }
  }

  // ============================================================
  //  Core execute (D-5: data-only caller)
  // ============================================================
  async function execute(args) {
    try {
      _validateArgs(args);
    } catch (e) {
      return { status: 'ERROR', error: e.message };
    }

    const {
      commandId,
      expectedGeneration,
      command,
      payload = {},
      storeKey
    } = args;

    // Λήψη keys από CBF_ES (fail-loud αν locked)
    const stateMACKey = CBF_ES._internal.getStateMACKey();
    const commitmentKey = CBF_ES._internal.getCommitmentKey();

    if (!stateMACKey || !commitmentKey) {
      return { status: 'ERROR', error: 'Vault is locked' };
    }

    const run = async () => {
      // ---------- 1. RAM fast-path (D-9) ----------
      const ramHit = _ramCheck(commandId);
      if (ramHit) {
        CBF_LOGGER.debug(`Sequencer: RAM hit for ${commandId}`);
        return { status: 'ALREADY_APPLIED', generation: ramHit.generation };
      }

      // ---------- 2. Dispatch ----------
      const handler = handlers.get(command);
      if (!handler) {
        return { status: 'UNSUPPORTED_COMMAND', command };
      }

      // ---------- 3. PREPARE (out-of-tx, D-7) ----------
      let prepared;
      try {
        const ctx = _buildPrepareContext(
          storeKey, stateMACKey, commitmentKey,
          commandId, expectedGeneration
        );
        prepared = await handler.prepare(payload, ctx);
      } catch (e) {
        CBF_LOGGER.warn(`Sequencer: prepare failed for ${command}: ${e.message}`);
        return { status: 'ERROR', error: e.message };
      }

      if (!prepared || typeof prepared !== 'object') {
        return { status: 'ERROR', error: 'prepare returned invalid result' };
      }

      const writes          = Array.isArray(prepared.writes) ? prepared.writes : [];
      const deletes         = Array.isArray(prepared.deletes) ? prepared.deletes : [];
      const newMetaRecord   = prepared.newMetaRecord || null;
      const newStateRecord  = prepared.newStateRecord || null;
      const userResult      = prepared.result ?? null;

      if (!newStateRecord) {
        return {
          status: 'ERROR',
          error: 'prepare must return newStateRecord'
        };
      }

      // ---------- 4. COMMIT (single readwrite tx, D-7) ----------
      let outcome;
      try {
        outcome = await CBF_VAULT_TX.writeTx(
          [
            CBF_VAULT_TX.STORE_RECORDS,
            CBF_VAULT_TX.STORE_META,
            CBF_VAULT_TX.STORE_STATE,
            CBF_VAULT_TX.STORE_JOURNAL
          ],
          async (s) => {
            const recStore   = s[CBF_VAULT_TX.STORE_RECORDS];
            const metaStore  = s[CBF_VAULT_TX.STORE_META];
            const stateStore = s[CBF_VAULT_TX.STORE_STATE];
            const jStore     = s[CBF_VAULT_TX.STORE_JOURNAL];

            // 4a. Authoritative generation check
            const stateRec = await CBF_VAULT_TX.idbRequest(
              stateStore.get(CBF_VAULT_TX.VAULT_STATE_ID)
            );
            if (!stateRec) throw new Error('vault-state not found');

            const currentGen = stateRec.treeGeneration;
            if (currentGen !== expectedGeneration) {
              return {
                status: 'STALE_GENERATION',
                currentGeneration: currentGen
              };
            }

            // 4b. Authoritative idempotency check
            const jEntry = await CBF_VAULT_TX.idbRequest(
              jStore.get(commandId)
            );
            if (jEntry) {
              return {
                status: 'ALREADY_APPLIED',
                generation: jEntry.generation
              };
            }

            // 4c. Apply deletes
            for (const id of deletes) recStore.delete(id);

            // 4d. Apply writes
            for (const w of writes) recStore.put(w);

            // 4e. Write new meta (αν δόθηκε)
            if (newMetaRecord) metaStore.put(newMetaRecord);

            // 4f. Write new state (stateMAC υπολογισμένο στο prepare)
            stateStore.put(newStateRecord);

            // 4g. Write journal entry (generation = νέο treeGeneration)
            jStore.put({
              commandId,
              generation: newStateRecord.treeGeneration,
              timestamp: Date.now()
            });

            return {
              status: 'OK',
              result: userResult,
              generation: newStateRecord.treeGeneration
            };
          }
        );
      } catch (e) {
        CBF_LOGGER.error(`Sequencer: commit failed for ${command}: ${e.message}`);
        return { status: 'ERROR', error: e.message };
      }

      // ---------- 5. Post-commit ----------
      if (outcome.status === 'OK' || outcome.status === 'ALREADY_APPLIED') {
        _ramStore(commandId, outcome.generation);
        CBF_LOGGER.debug(
          `Sequencer: ${command} → ${outcome.status}, gen=${outcome.generation}`
        );
      }

      return outcome;
    };

    // Serial execution (Single Writer)
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  }

  // ============================================================
  //  Diagnostics (V12E)
  // ============================================================
  function getStats() {
    return {
      commandsCount: COMMANDS.size,
      commands: Array.from(COMMANDS),
      registeredCount: handlers.size,
      registered: Array.from(handlers.keys()),
      ramCacheSize: ramCache.size,
      queueActive: false   // (δεν μετράμε εδώ)
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    execute,
    registerCommand,
    COMMANDS,

    // V12E: diagnostics
    getStats,

    _internal: {
      ramCache,
      handlers,
      _ramCleanup,
      _computeStateMAC,
      _buildPrepareContext,
      _validateArgs
    }
  };

  if (typeof self !== 'undefined') self.CBF_SEQUENCER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_SEQUENCER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation Sequencer ready (v12.0.0: 8 commands — ' +
      'create/rename/delete/move/reorder/merge/mergeFolders/importEncrypted, ' +
      'stateMAC + Merkle)'
    );
  }

  return api;
})();