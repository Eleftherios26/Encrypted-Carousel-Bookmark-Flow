/**
 * recovery-manager.js — Recovery manager
 *
 * @path     background/services/recovery-manager.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Recovery helpers για το vault:
 *     • rebuildSnapshot()   — επαναχτίζει το in-RAM projection από IDB
 *     • verifyIntegrity()   — συγκρίνει recordCount vs actual records
 *
 *   Χρησιμοποιείται:
 *     • Μετά από unlock (initial projection build)
 *     • Μετά από importEncrypted (V12E.E-REBUILD-01)
 *     • Σε manual recovery / diagnostics
 *
 * DECISIONS
 *   D-9
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "recovery"
 */

var CBF_RECOVERY = (function() {

  /**
   * Επαναχτίζει το projection από την IndexedDB.
   * Απαιτείται μετά από unlock ή αν το projection είναι σε inconsistent state.
   */
  async function rebuildSnapshot() {
    if (!CBF_ES.isUnlocked()) throw new Error('Vault is locked');
    CBF_LOGGER.info('Recovery: rebuilding snapshot');

    const meta = await CBF_ES._internal.readVaultMeta();
    if (!meta) throw new Error('Vault metadata not found');

    const allRecords = await CBF_VAULT_TX.readTx(
      [CBF_VAULT_TX.STORE_RECORDS],
      async (s) => CBF_VAULT_TX.idbRequest(
        s[CBF_VAULT_TX.STORE_RECORDS].getAll()
      )
    );

    const items = [];
    for (const rec of allRecords) {
      if (rec.id === CBF_ES.ROOT_ID) {
        items.push({
          id: rec.id,
          parentId: null,
          positionKey: rec.positionKey,
          type: 'folder',
          title: 'Root'
        });
        continue;
      }
      try {
        const plain = await CBF_ES._internal.decryptPayload(rec);
        items.push({
          id: rec.id,
          parentId: rec.parentId,
          positionKey: rec.positionKey,
          type: rec.recordType,
          title: plain.title || '',
          url: plain.url || null
        });
      } catch (e) {
        CBF_LOGGER.warn(`Recovery: failed to decrypt ${rec.id}`);
      }
    }

    CBF_PROJECTION.init({ rootId: meta.rootId || CBF_ES.ROOT_ID });
    CBF_PROJECTION.setItems(items);
    CBF_PROJECTION.setGeneration(meta.treeGeneration);

    CBF_LOGGER.security(
      `Recovery complete: ${items.length} items, generation=${meta.treeGeneration}`
    );
    return { itemCount: items.length, generation: meta.treeGeneration };
  }

  /**
   * Verify integrity — συγκρίνει το recordCount του metadata με τα
   * πραγματικά records.
   */
  async function verifyIntegrity() {
    if (!CBF_ES.isUnlocked()) throw new Error('Vault is locked');
    const meta = await CBF_ES._internal.readVaultMeta();

    const count = await CBF_VAULT_TX.readTx(
      [CBF_VAULT_TX.STORE_RECORDS],
      async (s) => CBF_VAULT_TX.idbRequest(
        s[CBF_VAULT_TX.STORE_RECORDS].count()
      )
    );

    const ok = count === meta.recordCount;
    CBF_LOGGER.info(`Integrity check: count=${count}, meta=${meta.recordCount}, ok=${ok}`);
    return { ok, actual: count, expected: meta.recordCount };
  }

  const api = { rebuildSnapshot, verifyIntegrity };

  if (typeof self !== 'undefined') self.CBF_RECOVERY = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_RECOVERY = api;
  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Recovery Manager ready');
  }
  return api;
})();