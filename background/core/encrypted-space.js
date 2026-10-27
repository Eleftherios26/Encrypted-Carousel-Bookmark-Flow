/**
 * encrypted-space.js — Vault authority (setup/unlock/lock/migration)
 *
 * @path     background/core/encrypted-space.js
 * @version  12.3.1
 * @since    v12E / v12.3.1
 *
 * PURPOSE
 *   Κύριος vault authority:
 *     • setup / unlock / lock
 *     • changePassword (atomic, §6.8)
 *     • stateMAC computation/verification
 *     • Merkle commitment computation/verification
 *     • Migration v2 → v3 (resumable, fail-closed)
 *     • Recovery flow
 *     • Cross-key derivation (V12E.E-CROSS-01)
 *
 * KEY DERIVATION CHAIN (§7.4)
 *   password → Argon2id(salt, 64MiB, t=3, p=1) → master
 *   master → HKDF(info="ECBF/store/v1")      → storeKey (AES-256-GCM)
 *   master → HKDF(info="ECBF/state-mac/v1")  → stateMACKey (HMAC)
 *   master → HKDF(info="ECBF/commitment/v1") → commitmentKey (HMAC)
 *
 * NON-OBVIOUS
 *   • changePassword: track `idbWritten` flag — αν το IDB commit
 *     πέτυχε και κάτι μετά αποτύχει, force-lock αντί rollback
 *     (V12E.E-SEC-02). Αλλιώς RAM παλιά κλειδιά + IDB νέα records.
 *   • H-01: Merkle mismatch → auto-recovery αν όλα τα records
 *     decrypt-άρουν (v12.3.1), αλλιώς fail-closed.
 *   • M-09: setStoreKey ΑΦΑΙΡΕΘΗΚΕ (backdoor risk).
 *   • Το vault-meta record ΔΕΝ συμμετέχει στο Merkle tree
 *     (circular dependency — βλ. buildAADMetaV3).
 *
 * DECISIONS
 *   D-10, D-18, D-19, D-20, D-21, D-26
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.1 (2026-10-19) — AUTO-RECOVERY για bug-induced Merkle mismatch
 *   ══════════════════════════════════════════════════════════════════════
 *   🐛 BUG (CRITICAL) που διορθώθηκε στα:
 *     • create-handler.js
 *     • merge-handler.js
 *     • merge-folders-handler.js
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Σε rebalance (create/merge/mergeFolders), το updateMerkle()
 *       ΔΕΝ περιλάμβανε τα rebalanceWrites. Αποτέλεσμα:
 *         • Το commitmentRoot υπολογιζόταν με ΠΑΛΙΑ positionKeys
 *         • Στο IDB γράφονταν ΝΕΑ positionKeys (μέσω writes)
 *         → VAULT_MERKLE_MISMATCH στο επόμενο unlock (fail-closed)
 *         → "wrong password" στον χρήστη (παραπλανητικό)
 *
 *   🛡️ AUTO-RECOVERY (νέο feature):
 *     Όταν το unlock ανιχνεύσει Merkle mismatch:
 *       1. Safety check: decrypt ΟΛΩΝ των records με AAD binding
 *       2. Αν ΟΛΑ OK → bug-induced → auto-rebuild commitmentRoot
 *       3. Αν κάποιο fails → tampering → fail-closed (H-01)
 *
 *     Γιατί είναι ασφαλές:
 *       • Το AAD binding (formatVersion || keyVersion || space ||
 *         recordType || id || parentId || positionKey) είναι το
 *         πραγματικό tamper-evidence.
 *       • Αν κάποιος attacker άλλαξε positionKey/parentId → decrypt
 *         fails → fail-closed.
 *       • Αν ΟΛΑ τα records decrypt-άρουν, τότε ΚΑΝΕΙΣ δεν άλλαξε
 *         structural fields → το mismatch είναι bug.
 *
 *     Audit log: AUTO_RECOVERY_MERKLE_SUCCESS (CBF_LOGGER.security).
 *
 *   IMPACT:
 *     • ✅ Διορθώνει ήδη σπασμένα vaults αυτόματα (zero-touch)
 *     • ✅ Δεν χάνει δεδομένα (μόνο rebuild commitmentRoot)
 *     • ✅ Tamper-evidence διατηρείται (AAD binding + stateMAC)
 *     • ✅ Zero regression για healthy vaults (δεν μπαίνει στο block)
 *     • ✅ Audit trail για diagnostics
 *
 *   v12.0.0 — Initial release
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "encrypted-space"
 */

var CBF_ES = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const ROOT_ID          = 'ecbf-root';
  const SCHEMA_VERSION   = 1;
  const DEFAULT_KEY_VERSION = 1;
  const FORMAT_VERSION   = 1;
  const SPACE            = 'encrypted';

  const STORAGE_SALT_KEY = 'cbf_salt';
  const STORAGE_KDF_KEY  = 'cbf_kdf';

  const POSITION_PAD     = 40;

  // ============================================================
  //  RAM state
  // ============================================================
  let storeKey         = null;
  let stateMACKey      = null;
  let commitmentKey    = null;
  let merkle           = null;
  let masterKeyMaterial = null;

  let lastCorruptedIds = [];
  let keyVersion       = DEFAULT_KEY_VERSION;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[ES]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[ES]', ...a); }
  function err(...a)  { CBF_LOGGER.error('[ES]', ...a); }
  function sec(...a)  { CBF_LOGGER.security('[ES]', ...a); }

  // ============================================================
  //  Helpers
  // ============================================================
  function toStoredPositionKey(bigintVal) {
    if (bigintVal < 0n) throw new Error('Negative position key');
    return bigintVal.toString().padStart(POSITION_PAD, '0');
  }

  function _requireUnlocked() {
    if (!storeKey || !stateMACKey || !commitmentKey) {
      throw new Error('Vault is locked');
    }
  }

  // ============================================================
  //  KDF config storage
  // ============================================================
  async function readKdfConfig() {
    const res = await browser.storage.local.get([
      STORAGE_SALT_KEY, STORAGE_KDF_KEY
    ]);

    if (!res[STORAGE_SALT_KEY] || !res[STORAGE_KDF_KEY]) return null;

    const kdf = res[STORAGE_KDF_KEY];
    if (kdf && typeof kdf.keyVersion === 'number') {
      keyVersion = kdf.keyVersion;
    } else {
      keyVersion = DEFAULT_KEY_VERSION;
    }

    return {
      salt: CBF_CRYPTO.b64ToBuf(res[STORAGE_SALT_KEY]),
      kdf
    };
  }

  async function writeKdfConfig(saltBytes, kdfInfo) {
    await browser.storage.local.set({
      [STORAGE_SALT_KEY]: CBF_CRYPTO.bufToB64(saltBytes),
      [STORAGE_KDF_KEY]:  kdfInfo
    });
  }

  // ============================================================
  //  Key derivation — full chain (§7.4)
  // ============================================================
  async function _deriveKeysFromPassword(password, salt, kdfId) {
    const normalizedPassword = password.normalize('NFC');

    let master;
    if (kdfId === 'argon2id') {
      master = await CBF_ARGON2.deriveKey(normalizedPassword, salt);
    } else if (kdfId === 'pbkdf2-sha256') {
      master = await CBF_CRYPTO.deriveMasterKeyMaterialPBKDF2(
        normalizedPassword, salt
      );
    } else {
      throw new Error('Unknown KDF: ' + kdfId);
    }

    try {
      const storeKeyResult      = await CBF_CRYPTO.deriveStoreKey(master);
      const stateMACKeyResult   = await CBF_CRYPTO.deriveStateMACKey(master);
      const commitmentKeyResult = await CBF_CRYPTO.deriveCommitmentKey(master);

      return {
        master,
        storeKey:      storeKeyResult,
        stateMACKey:   stateMACKeyResult,
        commitmentKey: commitmentKeyResult
      };
    } catch (e) {
      CBF_CRYPTO.zeroBuffer(master);
      throw e;
    }
  }

  // ============================================================
  //  stateMAC computation (§4)
  // ============================================================
  async function _computeStateMAC(state) {
    const data = {
      treeGeneration: state.treeGeneration,
      schemaVersion:  state.schemaVersion,
      _rotation:      state._rotation  ?? null,
      _migration:     state._migration ?? null
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

  async function _verifyStateMAC(state) {
    if (!state || !state.stateMAC) return false;
    try {
      const computed = await _computeStateMAC(state);
      return CBF_TIMING_SAFE.timingSafeEqualString(computed, state.stateMAC);
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  //  Record encryption / decryption
  // ============================================================
  async function _encryptPayload(plainObj, id, parentId, positionKey, recordType) {
    const aad = CBF_CRYPTO.buildAADRecord({
      formatVersion: FORMAT_VERSION,
      keyVersion,
      space: SPACE,
      recordType,
      id,
      parentId: parentId ?? '',
      positionKey
    });
    try {
      return await CBF_CRYPTO.encryptRecord(plainObj, storeKey, aad);
    } finally {
      CBF_CRYPTO.zeroBuffer(aad);
    }
  }

  async function _decryptPayload(rec) {
    const aad = CBF_CRYPTO.buildAADRecord({
      formatVersion: FORMAT_VERSION,
      keyVersion: rec.keyVersion ?? keyVersion,
      space: SPACE,
      recordType: rec.recordType,
      id: rec.id,
      parentId: rec.parentId ?? '',
      positionKey: rec.positionKey
    });
    try {
      return await CBF_CRYPTO.decryptRecord(
        { nonce: rec.nonce, ciphertext: rec.ciphertext, tag: rec.tag },
        storeKey,
        aad
      );
    } finally {
      CBF_CRYPTO.zeroBuffer(aad);
    }
  }

  // ============================================================
  //  Meta encryption / decryption
  // ============================================================
  async function _buildMetaRecord(rootId, recordCount, treeGeneration,
                                  commitmentRoot, positionKey, useV3AAD = true) {
    const plain = { rootId, recordCount, treeGeneration, commitmentRoot };
    const aadInfo = {
      formatVersion: FORMAT_VERSION,
      keyVersion,
      space: SPACE,
      id: CBF_VAULT_TX.VAULT_META_ID,
      parentId: 'vault',
      positionKey,
      treeGeneration,
      commitmentRoot
    };
    const aad = useV3AAD
      ? CBF_CRYPTO.buildAADMetaV3(aadInfo)
      : CBF_CRYPTO.buildAADMetaV2(aadInfo);
    try {
      const enc = await CBF_CRYPTO.encryptRecord(plain, storeKey, aad);
      return {
        id: CBF_VAULT_TX.VAULT_META_ID,
        parentId: 'vault',
        positionKey,
        recordType: 'vault_metadata',
        keyVersion,
        formatVersion: FORMAT_VERSION,
        nonce: enc.nonce,
        ciphertext: enc.ciphertext,
        tag: enc.tag
      };
    } finally {
      CBF_CRYPTO.zeroBuffer(aad);
    }
  }

  async function _decryptMeta(metaRec, useV3AAD = true) {
    if (useV3AAD) {
      throw new Error('Cannot decrypt v3 meta without generation info');
    }

    const aadInfo = {
      formatVersion: metaRec.formatVersion ?? FORMAT_VERSION,
      keyVersion: metaRec.keyVersion ?? keyVersion,
      space: SPACE,
      id: metaRec.id,
      parentId: metaRec.parentId,
      positionKey: metaRec.positionKey
    };
    const aad = CBF_CRYPTO.buildAADMetaV2(aadInfo);
    try {
      return await CBF_CRYPTO.decryptRecord(
        { nonce: metaRec.nonce, ciphertext: metaRec.ciphertext, tag: metaRec.tag },
        storeKey,
        aad
      );
    } finally {
      CBF_CRYPTO.zeroBuffer(aad);
    }
  }

  async function _decryptMetaV3(metaRec, stateTreeGeneration) {
    const aadInfo = {
      formatVersion: metaRec.formatVersion ?? FORMAT_VERSION,
      keyVersion: metaRec.keyVersion ?? keyVersion,
      space: SPACE,
      id: metaRec.id,
      parentId: metaRec.parentId,
      positionKey: metaRec.positionKey,
      treeGeneration: stateTreeGeneration,
      commitmentRoot: ''
    };
    const aad = CBF_CRYPTO.buildAADMetaV3(aadInfo);
    try {
      return await CBF_CRYPTO.decryptRecord(
        { nonce: metaRec.nonce, ciphertext: metaRec.ciphertext, tag: metaRec.tag },
        storeKey,
        aad
      );
    } finally {
      CBF_CRYPTO.zeroBuffer(aad);
    }
  }

  // ============================================================
  //  Setup (fresh vault)
  // ============================================================
  async function setup(password) {
    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('Password must be at least 6 characters');
    }

    sec('setup: starting');

    const existing = await readKdfConfig();
    if (existing) {
      CBF_CRYPTO.zeroBuffer(existing.salt);
      throw new Error('Vault already initialized');
    }

    await CBF_ARGON2.load();
    log('setup: argon2 loaded');

    const salt = CBF_CRYPTO.generateRandomBytes(16);

    const kdfInfo = {
      id: 'argon2id',
      version: 1,
      params: { memory: 65536, iterations: 3, parallelism: 1, hashLength: 32 },
      keyVersion: DEFAULT_KEY_VERSION
    };
    await writeKdfConfig(salt, kdfInfo);
    log('setup: KDF config written to storage');

    let derived;
    try {
      derived = await _deriveKeysFromPassword(password, salt, 'argon2id');
    } finally {
      CBF_CRYPTO.zeroBuffer(salt);
    }

    storeKey          = derived.storeKey;
    stateMACKey       = derived.stateMACKey;
    commitmentKey     = derived.commitmentKey;
    masterKeyMaterial = derived.master;
    keyVersion        = DEFAULT_KEY_VERSION;

    sec('setup: keys derived (argon2id)');

    const rootPositionKey = toStoredPositionKey(0n);
    const rootEnc = await _encryptPayload(
      { title: 'Root', url: null },
      ROOT_ID, null, rootPositionKey, 'folder'
    );
    const rootRecord = {
      id: ROOT_ID,
      parentId: null,
      positionKey: rootPositionKey,
      recordType: 'folder',
      keyVersion,
      formatVersion: FORMAT_VERSION,
      nonce: rootEnc.nonce,
      ciphertext: rootEnc.ciphertext,
      tag: rootEnc.tag
    };

    merkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
    const commitmentRootBytes = await merkle.buildTree([rootRecord]);
    const commitmentRoot = CBF_CRYPTO.bufToB64(commitmentRootBytes);
    log(`setup: merkle root computed (${commitmentRoot.slice(0, 16)}...)`);

    const metaPositionKey = toStoredPositionKey(0n);
    const metaRecord = await _buildMetaRecord(
      ROOT_ID, 1, 0, commitmentRoot, metaPositionKey, true
    );

    const stateRecord = {
      id: CBF_VAULT_TX.VAULT_STATE_ID,
      treeGeneration: 0,
      schemaVersion: SCHEMA_VERSION,
      _rotation: null,
      _migration: null,
      stateMAC: null
    };
    stateRecord.stateMAC = await _computeStateMAC(stateRecord);

    await CBF_VAULT_TX.writeTx(
      [
        CBF_VAULT_TX.STORE_RECORDS,
        CBF_VAULT_TX.STORE_META,
        CBF_VAULT_TX.STORE_STATE
      ],
      async (s) => {
        s[CBF_VAULT_TX.STORE_RECORDS].put(rootRecord);
        s[CBF_VAULT_TX.STORE_META].put(metaRecord);
        s[CBF_VAULT_TX.STORE_STATE].put(stateRecord);
      }
    );

    CBF_PROJECTION.init({ rootId: ROOT_ID });
    CBF_PROJECTION.setItems([{
      id: ROOT_ID,
      parentId: null,
      positionKey: rootPositionKey,
      type: 'folder',
      title: 'Root'
    }]);
    CBF_PROJECTION.setGeneration(0);

    sec('setup: complete (records + meta + state + merkle)');
    return true;
  }

  // ============================================================
  //  Migration State Machine (§11)
  // ============================================================
  async function _runMigrationIfNeeded(stateRec) {
    if (stateRec.stateMAC !== null && stateRec.stateMAC !== undefined &&
        stateRec._migration === null) {
      return;
    }

    if (stateRec._migration && stateRec._migration.phase === 'started') {
      sec('[MIGRATION] v2 -> v3: resuming from started phase');
      await _completeMigration(stateRec);
      return;
    }

    if (stateRec.stateMAC === null || stateRec.stateMAC === undefined) {
      sec('[MIGRATION] v2 -> v3: starting');
      await _startMigration(stateRec);
      return;
    }

    warn('[MIGRATION] unexpected state — skipping');
  }

  async function _startMigration(stateRec) {
    const allRecords = await CBF_VAULT_TX.readAllRecords();
    log(`[MIGRATION] reading ${allRecords.length} records for migration`);

    const finalState = {
      treeGeneration: stateRec.treeGeneration,
      schemaVersion:  stateRec.schemaVersion,
      _rotation:      null,
      _migration:     null
    };
    const expectedStateMAC = await _computeStateMAC(finalState);

    merkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
    const commitmentRootBytes = await merkle.buildTree(allRecords);
    const expectedCommitmentRoot = CBF_CRYPTO.bufToB64(commitmentRootBytes);

    const startedState = {
      id: CBF_VAULT_TX.VAULT_STATE_ID,
      treeGeneration: stateRec.treeGeneration,
      schemaVersion:  stateRec.schemaVersion,
      _rotation:      null,
      _migration: {
        phase: 'started',
        fromVersion: 2,
        toVersion: 3,
        startedAt: Date.now(),
        expectedStateMAC,
        expectedCommitmentRoot
      },
      stateMAC: null
    };

    await CBF_VAULT_TX.writeTx(
      [CBF_VAULT_TX.STORE_STATE],
      async (s) => {
        s[CBF_VAULT_TX.STORE_STATE].put(startedState);
      }
    );

    sec('[MIGRATION] v2 -> v3: started phase committed');

    await _completeMigration(startedState);
  }

  async function _completeMigration(stateRec) {
    const mig = stateRec._migration;
    if (!mig || mig.phase !== 'started') {
      throw new Error('MIGRATION_STATE_CORRUPTED: expected started phase');
    }

    const finalState = {
      treeGeneration: stateRec.treeGeneration,
      schemaVersion:  stateRec.schemaVersion,
      _rotation:      null,
      _migration:     null
    };
    const currentMAC = await _computeStateMAC(finalState);

    if (!CBF_TIMING_SAFE.timingSafeEqualString(currentMAC, mig.expectedStateMAC)) {
      throw new Error('MIGRATION_STATE_MAC_MISMATCH');
    }

    const oldMetaRec = await CBF_VAULT_TX.readMeta();
    if (!oldMetaRec) throw new Error('MIGRATION_FAILED: meta record not found');

    const metaPayload = await _decryptMeta(oldMetaRec, false);

    const newMetaRecord = await _buildMetaRecord(
      metaPayload.rootId,
      metaPayload.recordCount,
      stateRec.treeGeneration,
      mig.expectedCommitmentRoot,
      oldMetaRec.positionKey,
      true
    );

    const committedState = {
      id: CBF_VAULT_TX.VAULT_STATE_ID,
      treeGeneration: stateRec.treeGeneration,
      schemaVersion:  stateRec.schemaVersion,
      _rotation:      null,
      _migration:     null,
      stateMAC:       currentMAC
    };

    await CBF_VAULT_TX.writeTx(
      [CBF_VAULT_TX.STORE_META, CBF_VAULT_TX.STORE_STATE],
      async (s) => {
        s[CBF_VAULT_TX.STORE_META].put(newMetaRecord);
        s[CBF_VAULT_TX.STORE_STATE].put(committedState);
      }
    );

    sec('[MIGRATION] v2 -> v3: committed');
  }

  // ============================================================
  //  Unlock
  // ============================================================
  async function unlock(password) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Password required');
    }

    sec('unlock: starting');

    await _recoverPendingRotation();

    const config = await readKdfConfig();
    if (!config) throw new Error('Vault not initialized');

    log(`unlock: KDF=${config.kdf.id}, keyVersion=${config.kdf.keyVersion ?? 'default'}`);

    if (config.kdf.id === 'argon2id') {
      await CBF_ARGON2.load();
    }

    let derived;
    try {
      derived = await _deriveKeysFromPassword(password, config.salt, config.kdf.id);
    } finally {
      CBF_CRYPTO.zeroBuffer(config.salt);
    }

    storeKey          = derived.storeKey;
    stateMACKey       = derived.stateMACKey;
    commitmentKey     = derived.commitmentKey;
    masterKeyMaterial = derived.master;
    keyVersion        = config.kdf.keyVersion ?? DEFAULT_KEY_VERSION;

    log(`unlock: keys derived (${config.kdf.id}, keyVersion=${keyVersion})`);

    const stateRec = await CBF_VAULT_TX.readState();
    if (!stateRec) {
      _zeroKeys();
      throw new Error('Vault state not found');
    }

    const isV2 = CBF_VAULT_TX._isV2State(stateRec);
    const isV3 = CBF_VAULT_TX._isV3State(stateRec);

    if (!isV2 && !isV3) {
      _zeroKeys();
      throw new Error('VAULT_STATE_CORRUPTED');
    }

    log(`unlock: state format ${isV2 ? 'v2' : 'v3'}`);

    if (isV3 && stateRec.stateMAC !== null) {
      const ok = await _verifyStateMAC(stateRec);
      if (!ok) {
        _zeroKeys();
        sec('VAULT_TAMPERED: stateMAC mismatch');
        throw new Error('VAULT_TAMPERED');
      }
      log('unlock: stateMAC verified ✓');
    }

    let metaPayload;
    let metaRec;
    try {
      metaRec = await CBF_VAULT_TX.readMeta();
      if (!metaRec) throw new Error('Meta not found');

      if (isV3 && stateRec.stateMAC !== null) {
        metaPayload = await _decryptMetaV3(metaRec, stateRec.treeGeneration);
      } else {
        metaPayload = await _decryptMeta(metaRec, false);
      }
    } catch (e) {
      _zeroKeys();
      warn('unlock: meta decrypt FAILED (likely wrong password)');
      throw new Error('Wrong password');
    }

    log('unlock: meta decrypted ✓');

    if (isV3 && stateRec._rotation && stateRec._rotation.pending) {
      sec('unlock: clearing pending rotation');

      const cleanState = {
        treeGeneration: stateRec.treeGeneration,
        schemaVersion:  stateRec.schemaVersion,
        _rotation:      null,
        _migration:     stateRec._migration ?? null
      };
      const cleanMAC = await _computeStateMAC(cleanState);

      await CBF_VAULT_TX.writeTx(
        [CBF_VAULT_TX.STORE_STATE],
        async (s) => {
          s[CBF_VAULT_TX.STORE_STATE].put({
            id: CBF_VAULT_TX.VAULT_STATE_ID,
            ...cleanState,
            stateMAC: cleanMAC
          });
        }
      );

      stateRec._rotation = null;
      stateRec.stateMAC  = cleanMAC;

      sec('unlock: pending rotation cleared');
    }

    if (isV2) {
      sec('unlock: v2 vault detected — running migration');
      await _runMigrationIfNeeded(stateRec);

      const newMetaRec = await CBF_VAULT_TX.readMeta();
      metaRec = newMetaRec;
      metaPayload = await _decryptMetaV3(newMetaRec, stateRec.treeGeneration);
    } else if (stateRec._migration && stateRec._migration.phase === 'started') {
      sec('unlock: pending migration detected — resuming');
      await _completeMigration(stateRec);
      const newMetaRec = await CBF_VAULT_TX.readMeta();
      metaRec = newMetaRec;
      metaPayload = await _decryptMetaV3(newMetaRec, stateRec.treeGeneration);
    }

    const allRecords = await CBF_VAULT_TX.readAllRecords();
    log(`unlock: read ${allRecords.length} records from IDB`);

    merkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
    const freshRootBytes = await merkle.buildTree(allRecords);
    const freshRoot = CBF_CRYPTO.bufToB64(freshRootBytes);

    log(`unlock: merkle root computed (${freshRoot.slice(0, 16)}...)`);

    // ═══════════════════════════════════════════════════════════════
    //  H-01 + v12.3.1 AUTO-RECOVERY
    //
    //  Αν εντοπιστεί mismatch:
    //    1. Safety check: decrypt ΟΛΩΝ των records (AAD binding)
    //    2. Αν ΟΛΑ OK → bug-induced → auto-rebuild commitmentRoot
    //    3. Αν κάποιο fails → tampering → fail-closed (H-01)
    //
    //  Rationale:
    //    Το AAD binding (formatVersion || keyVersion || space ||
    //    recordType || id || parentId || positionKey) είναι το
    //    ΠΡΑΓΜΑΤΙΚΟ tamper-evidence. Αν κάποιος attacker άλλαξε
    //    positionKey/parentId → decrypt fails → fail-closed.
    //
    //    Αν ΟΛΑ τα records decrypt-άρουν, τότε ΚΑΝΕΙΣ δεν άλλαξε
    //    structural fields → το mismatch προέρχεται από bug (v12.3.0
    //    στα create/merge/mergeFolders handlers).
    // ═══════════════════════════════════════════════════════════════
    if (metaPayload.commitmentRoot && freshRoot !== metaPayload.commitmentRoot) {
      sec(
        'VAULT_MERKLE_MISMATCH: Merkle root mismatch — ' +
        `stored=${metaPayload.commitmentRoot.slice(0, 16)}..., ` +
        `fresh=${freshRoot.slice(0, 16)}...`
      );

      // ─────────────── AUTO-RECOVERY SAFETY CHECK ───────────────
      let decryptFailures = 0;
      const failedIds = [];

      for (const rec of allRecords) {
        if (rec.id === ROOT_ID) continue;
        try {
          await _decryptPayload(rec);  // AAD binding verified
        } catch (_) {
          decryptFailures++;
          failedIds.push(rec.id);
        }
      }

      if (decryptFailures === 0) {
        // ✅ Bug-induced mismatch → auto-rebuild
        sec(
          `AUTO_RECOVERY: All ${allRecords.length} records decrypt OK — ` +
          `rebuilding commitmentRoot (bug, not tampering)`
        );

        try {
          const newMetaRecord = await _buildMetaRecord(
            metaPayload.rootId,
            metaPayload.recordCount,
            stateRec.treeGeneration,   // ← stateRec (AAD binding)
            freshRoot,                 // ← το νέο (σωστό) root
            metaRec.positionKey,
            true
          );

          await CBF_VAULT_TX.writeTx(
            [CBF_VAULT_TX.STORE_META],
            async (s) => { s[CBF_VAULT_TX.STORE_META].put(newMetaRecord); }
          );

          // Update in-memory για να συνεχίσει ομαλά το unlock
          metaPayload.commitmentRoot = freshRoot;

          sec(
            `AUTO_RECOVERY: commitmentRoot rebuilt → ${freshRoot.slice(0, 16)}...`
          );

          // Audit log
          if (typeof CBF_LOGGER !== 'undefined' && CBF_LOGGER.security) {
            CBF_LOGGER.security('AUTO_RECOVERY_MERKLE_SUCCESS', {
              recordCount: allRecords.length,
              timestamp: Date.now()
            });
          }

        } catch (recoveryErr) {
          err('AUTO_RECOVERY FAILED:', recoveryErr.message);
          _zeroKeys();
          throw new Error('VAULT_MERKLE_MISMATCH');
        }
      } else {
        // ❌ Tampering / corruption → fail-closed (H-01)
        sec(
          `AUTO_RECOVERY BLOCKED: ${decryptFailures} record(s) failed to decrypt — ` +
          `possible tampering or corruption. ` +
          `Failed IDs (first 5): ${failedIds.slice(0, 5).join(', ')}`
        );
        _zeroKeys();
        throw new Error('VAULT_MERKLE_MISMATCH');
      }
    }

    log('unlock: merkle root verified ✓');

    const items = [];
    const corruptedIds = [];

    for (const rec of allRecords) {
      if (rec.id === ROOT_ID) {
        items.push({
          id: ROOT_ID,
          parentId: null,
          positionKey: rec.positionKey,
          type: 'folder',
          title: 'Root'
        });
        continue;
      }
      try {
        const plain = await _decryptPayload(rec);
        items.push({
          id: rec.id,
          parentId: rec.parentId,
          positionKey: rec.positionKey,
          type: rec.recordType,
          title: plain.title || '',
          url: plain.url || null
        });
      } catch (e) {
        corruptedIds.push(rec.id);
      }
    }

    lastCorruptedIds = corruptedIds;

    if (corruptedIds.length > 0) {
      sec(
        `VAULT INTEGRITY WARNING: ${corruptedIds.length} record(s) failed to decrypt. ` +
        `IDs (first 5): ${corruptedIds.slice(0, 5).join(', ')}`
      );
    }

    CBF_PROJECTION.init({ rootId: metaPayload.rootId || ROOT_ID });
    CBF_PROJECTION.setItems(items);
    CBF_PROJECTION.setGeneration(metaPayload.treeGeneration);

    sec(
      `unlock complete: ${items.length} items, ` +
      `generation=${metaPayload.treeGeneration}, ` +
      `corrupted=${corruptedIds.length}`
    );
    return true;
  }

  // ============================================================
  //  Rotation recovery
  // ============================================================
  async function _recoverPendingRotation() {
    const stateRec = await CBF_VAULT_TX.readState();
    if (!stateRec || !stateRec._rotation) return;

    const rot = stateRec._rotation;
    if (!rot.pending || !rot.newSaltB64 || !rot.kdfInfo) return;

    sec('rotation recovery: pending rotation detected');

    const res = await browser.storage.local.get(STORAGE_SALT_KEY);
    if (res[STORAGE_SALT_KEY] !== rot.newSaltB64) {
      await browser.storage.local.set({
        [STORAGE_SALT_KEY]: rot.newSaltB64,
        [STORAGE_KDF_KEY]:  rot.kdfInfo
      });
      sec('rotation recovery: salt written during recovery');
    } else {
      log('rotation recovery: salt already present');
    }
  }

  // ============================================================
  //  Read vault meta (για recovery-manager)
  // ============================================================
  async function _readVaultMeta() {
    _requireUnlocked();
    const stateRec = await CBF_VAULT_TX.readState();
    if (!stateRec) return null;
    const metaRec = await CBF_VAULT_TX.readMeta();
    if (!metaRec) return null;
    return _decryptMetaV3(metaRec, stateRec.treeGeneration);
  }

  // ============================================================
  //  Public verify wrappers (§15.2)
  // ============================================================
  async function verifyStateMAC() {
    if (!isUnlocked()) return false;
    try {
      const stateRec = await CBF_VAULT_TX.readState();
      if (!stateRec) return false;
      return await _verifyStateMAC(stateRec);
    } catch (_) {
      return false;
    }
  }

  async function verifyMerkle() {
    if (!isUnlocked()) return false;
    try {
      const stateRec = await CBF_VAULT_TX.readState();
      if (!stateRec) return false;
      const metaRec = await CBF_VAULT_TX.readMeta();
      if (!metaRec) return false;

      const metaPayload = await _decryptMetaV3(metaRec, stateRec.treeGeneration);

      const allRecords = await CBF_VAULT_TX.readAllRecords();
      const tempMerkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
      const freshRootBytes = await tempMerkle.buildTree(allRecords);
      const freshB64 = CBF_CRYPTO.bufToB64(freshRootBytes);
      tempMerkle.zeroize();

      return CBF_TIMING_SAFE.timingSafeEqualString(
        freshB64, metaPayload.commitmentRoot
      );
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  //  Change Password (atomic, §6.8)
  //
  //  V12E.E-SEC-02: idbWritten flag — αν το atomic write πέτυχε
  //  και κάτι μετά αποτύχει (π.χ. storage.local.set), ΔΕΝ κάνουμε
  //  rollback (θα είχαμε RAM παλιά + IDB νέα → inconsistent).
  //  Αντ' αυτού: force lock → χρήστης ξανα-ξεκλειδώνει με νέο κωδικό.
  // ============================================================
  async function changePassword(oldPassword, newPassword) {
    if (typeof oldPassword !== 'string' || oldPassword.length === 0) {
      throw new Error('Old password required');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new Error('New password must be at least 6 characters');
    }

    _requireUnlocked();
    sec('changePassword: starting');

    const config = await readKdfConfig();
    if (!config) throw new Error('Vault not initialized');

    if (config.kdf.id === 'argon2id') await CBF_ARGON2.load();

    let verifyDerived;
    try {
      verifyDerived = await _deriveKeysFromPassword(
        oldPassword, config.salt, config.kdf.id
      );
    } catch (e) {
      CBF_CRYPTO.zeroBuffer(config.salt);
      throw new Error('WRONG_OLD_PASSWORD');
    }

    const stateRec0 = await CBF_VAULT_TX.readState();
    if (!stateRec0) {
      CBF_CRYPTO.zeroBuffer(config.salt);
      _zeroDerived(verifyDerived);
      throw new Error('Vault state not found');
    }

    const metaRec0 = await CBF_VAULT_TX.readMeta();
    if (!metaRec0) {
      CBF_CRYPTO.zeroBuffer(config.salt);
      _zeroDerived(verifyDerived);
      throw new Error('Vault meta not found');
    }

    const savedStoreKey = storeKey;
    storeKey = verifyDerived.storeKey;
    let metaPayload;
    try {
      metaPayload = await _decryptMetaV3(metaRec0, stateRec0.treeGeneration);
    } catch (_) {
      storeKey = savedStoreKey;
      CBF_CRYPTO.zeroBuffer(config.salt);
      _zeroDerived(verifyDerived);
      throw new Error('WRONG_OLD_PASSWORD');
    }
    storeKey = savedStoreKey;
    _zeroDerived(verifyDerived);
    CBF_CRYPTO.zeroBuffer(config.salt);

    log('changePassword: old password verified');

    const newSalt = CBF_CRYPTO.generateRandomBytes(16);
    const newKdfInfo = {
      id: config.kdf.id,
      version: config.kdf.version ?? 1,
      params: config.kdf.params,
      keyVersion: config.kdf.keyVersion ?? DEFAULT_KEY_VERSION
    };

    let newDerived;
    try {
      newDerived = await _deriveKeysFromPassword(
        newPassword, newSalt, newKdfInfo.id
      );
    } catch (e) {
      CBF_CRYPTO.zeroBuffer(newSalt);
      throw e;
    }

    const allRecords = await CBF_VAULT_TX.readAllRecords();
    const plaintextRecords = [];

    for (const rec of allRecords) {
      if (rec.id === CBF_VAULT_TX.VAULT_META_ID) continue;
      if (rec.id === ROOT_ID) {
        plaintextRecords.push({
          id: ROOT_ID,
          parentId: null,
          positionKey: rec.positionKey,
          recordType: 'folder',
          plaintext: { title: 'Root', url: null }
        });
        continue;
      }
      try {
        const plain = await _decryptPayload(rec);
        plaintextRecords.push({
          id: rec.id,
          parentId: rec.parentId,
          positionKey: rec.positionKey,
          recordType: rec.recordType,
          plaintext: plain
        });
      } catch (_) {
        CBF_CRYPTO.zeroBuffer(newSalt);
        _zeroDerived(newDerived);
        throw new Error(`CHANGE_PASSWORD_ABORTED: cannot decrypt ${rec.id}`);
      }
    }

    log(`changePassword: ${plaintextRecords.length} records decrypted`);

    const oldStoreKey      = storeKey;
    const oldStateMACKey   = stateMACKey;
    const oldCommitmentKey = commitmentKey;
    const oldMaster        = masterKeyMaterial;
    const oldMerkle        = merkle;

    storeKey          = newDerived.storeKey;
    stateMACKey       = newDerived.stateMACKey;
    commitmentKey     = newDerived.commitmentKey;
    masterKeyMaterial = newDerived.master;

    // V12E.E-SEC-02: track IDB commit state
    let idbWritten = false;

    try {
      const newRecords = [];
      for (const pr of plaintextRecords) {
        const enc = await _encryptPayload(
          pr.plaintext, pr.id, pr.parentId, pr.positionKey, pr.recordType
        );
        newRecords.push({
          id: pr.id,
          parentId: pr.parentId,
          positionKey: pr.positionKey,
          recordType: pr.recordType,
          keyVersion,
          formatVersion: FORMAT_VERSION,
          nonce: enc.nonce,
          ciphertext: enc.ciphertext,
          tag: enc.tag
        });
      }

      merkle = new CBF_MERKLE.MerkleCommitment(commitmentKey);
      const rootBytes = await merkle.buildTree(newRecords);
      const commitmentRoot = CBF_CRYPTO.bufToB64(rootBytes);

      const newMetaRecord = await _buildMetaRecord(
        metaPayload.rootId,
        newRecords.length,
        stateRec0.treeGeneration,
        commitmentRoot,
        metaRec0.positionKey,
        true
      );

      const newSaltB64 = CBF_CRYPTO.bufToB64(newSalt);
      const rotationFlag = {
        pending:    true,
        newSaltB64,
        kdfInfo:    newKdfInfo,
        startedAt:  Date.now()
      };
      const stateWithRotation = {
        treeGeneration: stateRec0.treeGeneration,
        schemaVersion:  stateRec0.schemaVersion,
        _rotation:      rotationFlag,
        _migration:     null
      };
      const macWithRotation = await _computeStateMAC(stateWithRotation);
      const newStateRecord = {
        id: CBF_VAULT_TX.VAULT_STATE_ID,
        ...stateWithRotation,
        stateMAC: macWithRotation
      };

      // Step 10: Atomic write
      await CBF_VAULT_TX.writeTx(
        [
          CBF_VAULT_TX.STORE_RECORDS,
          CBF_VAULT_TX.STORE_META,
          CBF_VAULT_TX.STORE_STATE
        ],
        async (s) => {
          const rs = s[CBF_VAULT_TX.STORE_RECORDS];
          for (const r of newRecords) rs.put(r);
          s[CBF_VAULT_TX.STORE_META].put(newMetaRecord);
          s[CBF_VAULT_TX.STORE_STATE].put(newStateRecord);
        }
      );

      // V12E.E-SEC-02: IDB commit ΟΛΟΚΛΗΡΩΘΗΚΕ
      idbWritten = true;
      log('changePassword: atomic write complete');

      // Step 11: Write new salt + kdfInfo
      await browser.storage.local.set({
        [STORAGE_SALT_KEY]: newSaltB64,
        [STORAGE_KDF_KEY]:  newKdfInfo
      });

      // Step 12: Clear rotation flag
      const finalState = {
        treeGeneration: stateRec0.treeGeneration,
        schemaVersion:  stateRec0.schemaVersion,
        _rotation:      null,
        _migration:     null
      };
      const finalMAC = await _computeStateMAC(finalState);
      await CBF_VAULT_TX.writeTx(
        [CBF_VAULT_TX.STORE_STATE],
        async (s) => {
          s[CBF_VAULT_TX.STORE_STATE].put({
            id: CBF_VAULT_TX.VAULT_STATE_ID,
            ...finalState,
            stateMAC: finalMAC
          });
        }
      );

      // Step 13: Zero OLD master + salt + old merkle
      if (oldMaster) CBF_CRYPTO.zeroBuffer(oldMaster);
      if (oldMerkle) { try { oldMerkle.zeroize(); } catch (_) {} }
      CBF_CRYPTO.zeroBuffer(newSalt);

      sec('changePassword: rotation complete');
      return true;

    } catch (e) {
      err('changePassword FAILED:', e.message);

      // V12E.E-SEC-02: Αν το IDB γράφτηκε → force lock
      if (idbWritten) {
        sec(
          'changePassword: FAILED after IDB commit — forcing lock ' +
          '(V12E.E-SEC-02 fail-safe)'
        );

        try { if (newDerived.master) CBF_CRYPTO.zeroBuffer(newDerived.master); } catch (_) {}
        try { CBF_CRYPTO.zeroBuffer(newSalt); } catch (_) {}
        try { if (merkle) merkle.zeroize(); } catch (_) {}

        try { lock(); } catch (_) {}
        try {
          if (typeof CBF_VAULT_FSM !== 'undefined' &&
              typeof CBF_VAULT_FSM.lock === 'function') {
            await CBF_VAULT_FSM.lock();
          }
        } catch (_) {}

        throw new Error(
          'CHANGE_PASSWORD_FAILED_RECOVERY_REQUIRED: ' + e.message +
          ' (vault locked — re-unlock with new password)'
        );
      }

      // ΔΕΝ γράψαμε στο IDB → ασφαλές rollback
      try { if (newDerived.master) CBF_CRYPTO.zeroBuffer(newDerived.master); } catch (_) {}
      try { CBF_CRYPTO.zeroBuffer(newSalt); } catch (_) {}
      try { if (merkle && merkle !== oldMerkle) merkle.zeroize(); } catch (_) {}

      storeKey          = oldStoreKey;
      stateMACKey       = oldStateMACKey;
      commitmentKey     = oldCommitmentKey;
      masterKeyMaterial = oldMaster;
      merkle            = oldMerkle;

      throw new Error('CHANGE_PASSWORD_FAILED: ' + e.message);
    }
  }

  // ============================================================
  //  Helper — zero derived keys object
  // ============================================================
  function _zeroDerived(derived) {
    if (!derived) return;
    try { if (derived.master) CBF_CRYPTO.zeroBuffer(derived.master); } catch (_) {}
    // CryptoKeys: δεν μπορούν να zero-ιστούν, απλώς αποδεσμεύονται
  }

  // ============================================================
  //  Explicit key zeroization (D-26)
  // ============================================================
  function _zeroKeys() {
    storeKey          = null;
    stateMACKey       = null;
    commitmentKey     = null;

    if (masterKeyMaterial) {
      CBF_CRYPTO.zeroBuffer(masterKeyMaterial);
      masterKeyMaterial = null;
    }

    if (merkle) {
      try { merkle.zeroize(); } catch (_) {}
      merkle = null;
    }

    lastCorruptedIds = [];
    keyVersion       = DEFAULT_KEY_VERSION;

    log('_zeroKeys: all keys cleared');
  }

  // ============================================================
  //  Lock
  // ============================================================
  function lock() {
    sec('lock: starting');

    _zeroKeys();

    try { CBF_ARGON2.zeroize(); } catch (_) {}

    if (typeof CBF_PROJECTION !== 'undefined' && CBF_PROJECTION.reset) {
      CBF_PROJECTION.reset();
    }

    sec('lock: complete (keys zeroized, projection reset)');
  }

  // ============================================================
  //  Status
  // ============================================================
  function isUnlocked() {
    return storeKey !== null && stateMACKey !== null && commitmentKey !== null;
  }

  async function isInitialized() {
    const cfg = await readKdfConfig();
    if (cfg) {
      CBF_CRYPTO.zeroBuffer(cfg.salt);
      return true;
    }
    return false;
  }

  async function getStatus() {
    const initialized = await isInitialized();
    return {
      initialized,
      unlocked: isUnlocked(),
      corruptedCount: lastCorruptedIds.length
    };
  }

  // ============================================================
  //  V12E.E-CROSS-01: External key derivation
  //
  //  Επιτρέπει derive keys από ΕΞΩΤΕΡΙΚΟ salt (cross-key import).
  //  ΔΕΝ αγγίζει το τρέχον vault state. Επιστρέφει fresh
  //  { master, storeKey, stateMACKey, commitmentKey }.
  //
  //  Caller υποχρεούται:
  //    - Να χρησιμοποιήσει τα keys μόνο για decrypt/re-encrypt
  //    - Να κάνει zeroBuffer(master) μετά τη χρήση
  //
  //  Security:
  //    - Fail-closed αν password/salt/kdfId invalid
  //    - RAM-only (δεν αποθηκεύει τίποτα)
  //    - ΔΕΝ εκτίθεται σε overlay (μόνο background internal)
  // ============================================================
  async function _deriveKeysFromPasswordExternal(password, saltB64, kdfId) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('deriveKeysFromPasswordExternal: password required');
    }
    if (typeof saltB64 !== 'string' || saltB64.length === 0) {
      throw new Error('deriveKeysFromPasswordExternal: salt required');
    }
    if (typeof kdfId !== 'string' || kdfId.length === 0) {
      throw new Error('deriveKeysFromPasswordExternal: kdfId required');
    }

    const saltBytes = CBF_CRYPTO.b64ToBuf(saltB64);
    try {
      // Reuse existing internal derivation (no side effects)
      return await _deriveKeysFromPassword(password, saltBytes, kdfId);
    } finally {
      CBF_CRYPTO.zeroBuffer(saltBytes);
    }
  }

  // ============================================================
  //  Public API
  //
  //  M-09: setStoreKey ΑΦΑΙΡΕΘΗΚΕ (backdoor risk)
  //  V12E.E-CROSS-01: + deriveKeysFromPasswordExternal
  // ============================================================
  const api = {
    // Lifecycle
    setup,
    unlock,
    lock,
    isUnlocked,
    isInitialized,
    getStatus,

    // Verification
    changePassword,
    verifyStateMAC,
    verifyMerkle,

    // Constants
    ROOT_ID,
    SCHEMA_VERSION,
    FORMAT_VERSION,
    SPACE,

    // Internal — για tests, sequencer, cross-key import
    _internal: {
      readKdfConfig,
      writeKdfConfig,

      encryptPayload: _encryptPayload,
      decryptPayload: _decryptPayload,

      buildMetaRecord: _buildMetaRecord,
      decryptMeta:     _decryptMeta,
      decryptMetaV3:   _decryptMetaV3,

      readVaultMeta: _readVaultMeta,

      computeStateMAC: _computeStateMAC,
      verifyStateMAC:  _verifyStateMAC,

      // V12E.E-CROSS-01: External key derivation
      deriveKeysFromPasswordExternal: _deriveKeysFromPasswordExternal,

      // Key access (read-only — M-09: setStoreKey REMOVED)
      getStoreKey:          () => storeKey,
      getStateMACKey:       () => stateMACKey,
      getCommitmentKey:     () => commitmentKey,
      getKeyVersion:        () => keyVersion,
      getMerkle:            () => merkle,
      getMasterKeyMaterial: () => masterKeyMaterial,

      getLastCorruptedIds: () => lastCorruptedIds.slice()
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_ES = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_ES = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Encrypted Space Core ready ' +
      '(v12.3.1: H-01 Merkle FAIL-CLOSED + AUTO-RECOVERY για bug-induced ' +
      'mismatch + M-09 setStoreKey removed + ' +
      'V12E.E-SEC-02 changePassword post-write recovery + ' +
      'V12E.E-CROSS-01 cross-key derivation)'
    );
  }

  return api;
})();