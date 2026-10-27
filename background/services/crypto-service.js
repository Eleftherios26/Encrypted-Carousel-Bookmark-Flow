/**
 * crypto-service.js — Low-level cryptographic primitives
 *
 * @path     background/services/crypto-service.js
 * @version  12.1E
 * @since    v12E / v12.1E
 *
 * PURPOSE
 *   Χαμηλού επιπέδου crypto primitives:
 *     • Encoding (base64, hex)
 *     • Memory hygiene (zeroBuffer)
 *     • KDF: PBKDF2 (legacy) + HKDF chains
 *     • AEAD: AES-256-GCM
 *     • HMAC-SHA256 (sign / verify με timing-safe)
 *     • AAD builders (§8)
 *
 * KEY DERIVATION CHAIN (§7.4)
 *   password → Argon2id → master
 *   master → HKDF(info="ECBF/store/v1")      → storeKey (AES-256-GCM)
 *   master → HKDF(info="ECBF/state-mac/v1")  → stateMACKey (HMAC)
 *   master → HKDF(info="ECBF/commitment/v1") → commitmentKey (HMAC)
 *
 * NON-OBVIOUS
 *   • _normalizeHMACKey πάντα import-άρει με ['sign', 'verify']
 *     (Firefox fix — αποφυγή InvalidAccessError σε spec-compliant browsers).
 *   • M-04: Defensive copy + zeroBuffer στα raw key bytes πριν το importKey.
 *     ΔΕΝ zero-ίζουμε το caller's buffer (μπορεί να το χρειάζεται).
 *   • D-10: .slice() pattern σε κάθε returned Uint8Array — αποφυγή
 *     zero-ισμού του returned view από το finally block.
 *   • Το commitmentRoot ΔΕΝ μπαίνει στο v3 meta AAD (circular dependency).
 *
 * DECISIONS
 *   D-10, D-26, D-28
 *
 * CHANGELOG
 *   v12.1E (2026-09-22):
 *     • MINOR-3: Rename `usage` → `_usage` στο `_normalizeHMACKey()`
 *       με ρητό documentation γιατί δεν χρησιμοποιείται (κρατείται για
 *       API consistency με τους callers). ΔΕΝ αλλάζει τη συμπεριφορά —
 *       το importKey ΠΑΝΤΑ δηλώνει ['sign', 'verify'] ανεξάρτητα.
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "crypto-service"
 */

var CBF_CRYPTO = (function() {
  'use strict';

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ============================================================
  //  HKDF info constants (§7.4)
  // ============================================================
  const HKDF_INFO_STORE      = 'ECBF/store/v1';
  const HKDF_INFO_STATE_MAC  = 'ECBF/state-mac/v1';
  const HKDF_INFO_COMMITMENT = 'ECBF/commitment/v1';

  // ============================================================
  //  PBKDF2 — legacy (§7)
  //  Χρησιμοποιείται ΜΟΝΟ για unlock παλιών v2 vaults.
  // ============================================================
  const PBKDF2_ITERATIONS = 600000;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[CRYPTO]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[CRYPTO]', ...a); }
  function err(...a)  { CBF_LOGGER.error('[CRYPTO]', ...a); }

  // ============================================================
  //  Encoding helpers
  // ============================================================
  function bufToB64(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function b64ToBuf(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBuf(hex) {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function generateRandomBytes(length = 32) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  // ============================================================
  //  Memory hygiene (D-10, D-26)
  // ============================================================
  function zeroBuffer(buf) {
    if (!buf) return;
    try {
      if (buf instanceof Uint8Array) buf.fill(0);
      else if (buf instanceof ArrayBuffer) new Uint8Array(buf).fill(0);
    } catch (_) { /* best effort */ }
  }

  // ============================================================
  //  PBKDF2 — legacy only
  // ============================================================
  async function deriveMasterKeyMaterialPBKDF2(password, salt) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Password required');
    }
    if (!(salt instanceof Uint8Array) || salt.length < 16) {
      throw new Error('Salt must be a Uint8Array of at least 16 bytes');
    }

    log(`PBKDF2: starting (${PBKDF2_ITERATIONS} iterations)`);
    const passwordBytes = encoder.encode(password);

    let keyMaterial = null;
    let bits = null;
    try {
      keyMaterial = await crypto.subtle.importKey(
        'raw',
        passwordBytes,
        'PBKDF2',
        false,
        ['deriveBits']
      );

      bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        keyMaterial,
        256
      );

      // D-10: .slice() κάνει COPY — αλλιώς το finally zeroBuffer(bits)
      // μηδενίζει ΚΑΙ το returned view.
      const out = new Uint8Array(bits).slice();
      log('PBKDF2: derived 32 bytes');
      return out;
    } finally {
      zeroBuffer(passwordBytes);
      zeroBuffer(bits);
    }
  }

  // ============================================================
  //  HKDF base — deriveBits
  // ============================================================
  async function hkdfDerive(masterKeyMaterial, infoString, lengthBytes = 32) {
    if (!(masterKeyMaterial instanceof Uint8Array)) {
      throw new Error('hkdf: master key material must be Uint8Array');
    }
    if (typeof infoString !== 'string' || infoString.length === 0) {
      throw new Error('hkdf: info must be non-empty string');
    }

    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      masterKeyMaterial,
      'HKDF',
      false,
      ['deriveBits']
    );

    const info = encoder.encode(infoString);
    let bits = null;
    try {
      bits = await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(0),
          info
        },
        keyMaterial,
        lengthBytes * 8
      );
      return new Uint8Array(bits).slice();   // D-10: copy
    } finally {
      zeroBuffer(bits);
      zeroBuffer(info);
    }
  }

  // ============================================================
  //  HKDF — storeKey (AES-256-GCM)
  // ============================================================
  async function deriveStoreKey(masterKeyMaterial) {
    if (!(masterKeyMaterial instanceof Uint8Array)) {
      throw new Error('Master key material must be Uint8Array');
    }

    const storeKeyBytes = await hkdfDerive(masterKeyMaterial, HKDF_INFO_STORE, 32);

    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        storeKeyBytes,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      log('deriveStoreKey: AES-GCM key imported');
      return cryptoKey;
    } finally {
      zeroBuffer(storeKeyBytes);
    }
  }

  // ============================================================
  //  HKDF — stateMACKey (HMAC-SHA256)
  // ============================================================
  async function deriveStateMACKey(masterKeyMaterial) {
    if (!(masterKeyMaterial instanceof Uint8Array)) {
      throw new Error('Master key material must be Uint8Array');
    }

    const keyBytes = await hkdfDerive(masterKeyMaterial, HKDF_INFO_STATE_MAC, 32);

    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
      log('deriveStateMACKey: HMAC-SHA256 key imported');
      return cryptoKey;
    } finally {
      zeroBuffer(keyBytes);
    }
  }

  // ============================================================
  //  HKDF — commitmentKey (HMAC-SHA256)
  // ============================================================
  async function deriveCommitmentKey(masterKeyMaterial) {
    if (!(masterKeyMaterial instanceof Uint8Array)) {
      throw new Error('Master key material must be Uint8Array');
    }

    const keyBytes = await hkdfDerive(masterKeyMaterial, HKDF_INFO_COMMITMENT, 32);

    try {
      const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
      log('deriveCommitmentKey: HMAC-SHA256 key imported');
      return cryptoKey;
    } finally {
      zeroBuffer(keyBytes);
    }
  }

  // ============================================================
  //  Convenience — full HKDF chain από master
  // ============================================================
  async function deriveAllKeys(masterKeyMaterial) {
    log('deriveAllKeys: deriving 3 keys (store + stateMAC + commitment)');
    const storeKey      = await deriveStoreKey(masterKeyMaterial);
    const stateMACKey   = await deriveStateMACKey(masterKeyMaterial);
    const commitmentKey = await deriveCommitmentKey(masterKeyMaterial);
    log('deriveAllKeys: complete');
    return { storeKey, stateMACKey, commitmentKey };
  }

  // ============================================================
  //  AAD builders (§8)
  // ============================================================

  /**
   * AAD for records (bookmark / folder).
   * "ECBF-RECORD-V1" ‖ formatVersion ‖ keyVersion ‖
   * space ‖ recordType ‖ id ‖ parentId ‖ positionKey
   */
  function buildAADRecord(recordInfo) {
    const {
      formatVersion,
      keyVersion,
      space,
      recordType,
      id,
      parentId,
      positionKey
    } = recordInfo;

    const parts = [
      'ECBF-RECORD-V1',
      String(formatVersion ?? ''),
      String(keyVersion ?? ''),
      String(space ?? ''),
      String(recordType ?? ''),
      String(id ?? ''),
      String(parentId ?? ''),
      String(positionKey ?? '')
    ];

    const joined = parts.map(p => `${p.length}:${p}`).join('|');
    return encoder.encode(joined);
  }

  /**
   * AAD for vault-meta — v2 (legacy).
   */
  function buildAADMetaV2(meta) {
    const parts = [
      'ECBF-META-V1',
      String(meta.formatVersion ?? ''),
      String(meta.keyVersion ?? ''),
      String(meta.space ?? 'encrypted'),
      'vault_metadata',
      String(meta.id ?? ''),
      String(meta.parentId ?? 'vault'),
      String(meta.positionKey ?? '')
    ];
    const joined = parts.map(p => `${p.length}:${p}`).join('|');
    return encoder.encode(joined);
  }

  /**
   * AAD for vault-meta — v3 (D-19).
   *
   * 🔴 ΣΗΜΑΝΤΙΚΟ: ΔΕΝ περιλαμβάνεται το commitmentRoot.
   * (circular dependency — βλ. αρχιτεκτονική §8.3)
   */
  function buildAADMetaV3(meta) {
    const parts = [
      'ECBF-META-V1',
      String(meta.formatVersion ?? ''),
      String(meta.keyVersion ?? ''),
      String(meta.space ?? 'encrypted'),
      'vault_metadata',
      String(meta.id ?? ''),
      String(meta.parentId ?? 'vault'),
      String(meta.positionKey ?? ''),
      String(meta.treeGeneration ?? '')
    ];
    const joined = parts.map(p => `${p.length}:${p}`).join('|');
    return encoder.encode(joined);
  }

  /**
   * Generic builder — dispatch βάσει version.
   */
  function buildAADMeta(meta, version = 3) {
    if (version === 2) return buildAADMetaV2(meta);
    return buildAADMetaV3(meta);
  }

  // ============================================================
  //  AES-256-GCM — Encrypt
  // ============================================================
  async function encryptRecord(plainObj, storeKey, aad) {
    if (!storeKey) throw new Error('storeKey required');
    if (!plainObj || typeof plainObj !== 'object') {
      throw new Error('plainObj must be an object');
    }
    if (!(aad instanceof Uint8Array)) {
      throw new Error('aad must be Uint8Array');
    }

    const nonce = generateRandomBytes(12);
    const plaintext = encoder.encode(JSON.stringify(plainObj));

    let cipherBuffer = null;
    try {
      cipherBuffer = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: aad,
          tagLength: 128
        },
        storeKey,
        plaintext
      );

      const full = new Uint8Array(cipherBuffer);
      const ciphertext = full.slice(0, full.length - 16);
      const tag = full.slice(full.length - 16);

      return {
        nonce: bufToB64(nonce),
        ciphertext: bufToB64(ciphertext),
        tag: bufToB64(tag)
      };
    } finally {
      zeroBuffer(plaintext);
      zeroBuffer(cipherBuffer);
    }
  }

  // ============================================================
  //  AES-256-GCM — Decrypt
  // ============================================================
  async function decryptRecord(encObj, storeKey, aad) {
    if (!storeKey) throw new Error('storeKey required');
    if (!encObj || !encObj.nonce || !encObj.ciphertext || !encObj.tag) {
      throw new Error('Invalid encrypted record shape');
    }
    if (!(aad instanceof Uint8Array)) {
      throw new Error('aad must be Uint8Array');
    }

    const nonce = b64ToBuf(encObj.nonce);
    const ciphertext = b64ToBuf(encObj.ciphertext);
    const tag = b64ToBuf(encObj.tag);

    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);

    let plainBuffer = null;
    try {
      plainBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: aad,
          tagLength: 128
        },
        storeKey,
        combined
      );

      return JSON.parse(decoder.decode(plainBuffer));
    } catch (e) {
      throw new Error('Decryption failed');
    } finally {
      zeroBuffer(nonce);
      zeroBuffer(ciphertext);
      zeroBuffer(tag);
      zeroBuffer(combined);
      zeroBuffer(plainBuffer);
    }
  }

  // ============================================================
  //  HMAC key normalization
  //
  //  Δέχεται:
  //    - CryptoKey (HMAC)         → χρήση απευθείας
  //    - Uint8Array (raw bytes)   → importKey internally
  //    - ArrayBuffer              → convert + importKey
  //
  //  FIXES:
  //    1. Firefox HMAC fix: import με ['sign', 'verify'] ΠΑΝΤΑ —
  //       το hmacVerify καλεί crypto.subtle.sign() εσωτερικά,
  //       οπότε key με μόνο 'verify' → InvalidAccessError.
  //    2. M-04: Defensive copy + zeroBuffer(copy) σε finally.
  //       ΔΕΝ zero-ίζουμε το caller's buffer.
  //
  //  v12.1E MINOR-3: Η παράμετρος `_usage` κρατείται για API consistency
  //  με τους callers (hmacSign/hmacVerify). ΔΕΝ χρησιμοποιείται εσωτερικά
  //  διότι το importKey ΠΑΝΤΑ δηλώνει ['sign', 'verify'] — ανεξάρτητα
  //  από το αν ο caller πρόκειται να κάνει sign ή verify. Αυτό είναι
  //  ΑΠΑΡΑΙΤΗΤΟ γιατί το hmacVerify() καλεί crypto.subtle.sign()
  //  εσωτερικά (για να υπολογίσει το expected MAC) και μετά συγκρίνει
  //  timing-safe με το provided signature.
  //
  //  Το `_` prefix σηματοποιεί "intentionally unused".
  // ============================================================
  async function _normalizeHMACKey(key, _usage) {
    if (!key) throw new Error('HMAC key required');

    // Uint8Array / ArrayBuffer
    if (key instanceof Uint8Array || key instanceof ArrayBuffer) {
      const srcBytes = key instanceof Uint8Array ? key : new Uint8Array(key);

      if (srcBytes.length === 0) {
        throw new Error('HMAC key must not be empty');
      }

      // M-04: Defensive copy (2 βήματα για max safety)
      const keyBytesCopy = new Uint8Array(srcBytes).slice();

      try {
        const cryptoKey = await crypto.subtle.importKey(
          'raw',
          keyBytesCopy,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign', 'verify']   // Firefox fix: ΚΑΙ ΤΑ ΔΥΟ usages
        );

        return { cryptoKey, wasImported: true };
      } finally {
        // M-04: Zero the defensive copy
        zeroBuffer(keyBytesCopy);
      }
    }

    // CryptoKey
    if (typeof key === 'object' && key.type === 'secret' && key.algorithm) {
      return { cryptoKey: key, wasImported: false };
    }

    throw new Error(
      'hmac: key must be CryptoKey, Uint8Array, or ArrayBuffer'
    );
  }

  // ============================================================
  //  HMAC-SHA256 — sign
  // ============================================================
  async function hmacSign(key, data) {
    const { cryptoKey } = await _normalizeHMACKey(key, 'sign');

    let dataBytes;
    let isString = false;
    if (typeof data === 'string') {
      dataBytes = encoder.encode(data);
      isString = true;
    } else if (data instanceof Uint8Array) {
      dataBytes = data;
    } else {
      throw new Error('hmacSign: data must be string or Uint8Array');
    }

    try {
      const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
      return new Uint8Array(sig);
    } finally {
      if (isString) zeroBuffer(dataBytes);
    }
  }

  // ============================================================
  //  HMAC-SHA256 — verify (D-28: timingSafeEqual)
  // ============================================================
  async function hmacVerify(key, data, signature) {
    if (!key) return false;
    if (!(signature instanceof Uint8Array)) return false;

    let cryptoKey;
    try {
      const normalized = await _normalizeHMACKey(key, 'verify');
      cryptoKey = normalized.cryptoKey;
    } catch (_) {
      return false;
    }

    let dataBytes;
    let isString = false;
    if (typeof data === 'string') {
      dataBytes = encoder.encode(data);
      isString = true;
    } else if (data instanceof Uint8Array) {
      dataBytes = data;
    } else {
      return false;
    }

    try {
      const expected = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
      try {
        return CBF_TIMING_SAFE.timingSafeEqual(
          new Uint8Array(expected),
          signature
        );
      } finally {
        zeroBuffer(expected);
      }
    } catch (_) {
      return false;
    } finally {
      if (isString) zeroBuffer(dataBytes);
    }
  }

  // ============================================================
  //  HMAC convenience — sign / verify canonical objects
  // ============================================================
  async function hmacSignCanonical(key, obj) {
    const bytes = CBF_CANONICAL.canonicalBytes(obj);
    try {
      return await hmacSign(key, bytes);
    } finally {
      zeroBuffer(bytes);
    }
  }

  async function hmacVerifyCanonical(key, obj, signature) {
    const bytes = CBF_CANONICAL.canonicalBytes(obj);
    try {
      return await hmacVerify(key, bytes, signature);
    } finally {
      zeroBuffer(bytes);
    }
  }

  // ============================================================
  //  Canonical JSON — re-export για convenience
  // ============================================================
  function canonicalJSON(obj) {
    return CBF_CANONICAL.canonicalJSON(obj);
  }

  function canonicalBytes(obj) {
    return CBF_CANONICAL.canonicalBytes(obj);
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // Encoding
    bufToB64,
    b64ToBuf,
    bufToHex,
    hexToBuf,
    generateRandomBytes,

    // Memory hygiene
    zeroBuffer,

    // KDF — HKDF chains (§7.4)
    deriveStoreKey,
    deriveStateMACKey,
    deriveCommitmentKey,
    deriveAllKeys,

    // KDF — legacy PBKDF2 (§7)
    deriveMasterKeyMaterialPBKDF2,

    // AAD (§8)
    buildAADRecord,
    buildAADMeta,
    buildAADMetaV2,
    buildAADMetaV3,
    buildAAD: buildAADRecord,        // legacy alias

    // AEAD
    encryptRecord,
    decryptRecord,

    // HMAC
    hmacSign,
    hmacVerify,
    hmacSignCanonical,
    hmacVerifyCanonical,

    // Canonical (re-export)
    canonicalJSON,
    canonicalBytes,

    // Constants
    PBKDF2_ITERATIONS,
    HKDF_INFO_STORE,
    HKDF_INFO_STATE_MAC,
    HKDF_INFO_COMMITMENT,
    STORE_KEY_INFO: HKDF_INFO_STORE,     // legacy alias
    AAD_PREFIX: 'ECBF-RECORD-V1',
    TAG_LENGTH_BITS: 128,
    NONCE_LENGTH_BYTES: 12,

    _internal: {
      hkdfDerive,
      _normalizeHMACKey,
      encoder,
      decoder
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_CRYPTO = api;
  if (typeof self !== 'undefined') self.CBF_CRYPTO = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_CRYPTO = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Crypto Service ready (v12.1E: M-04 HMAC key zeroization + ' +
      'HKDF chains + Firefox HMAC fix + MINOR-3 _usage param)'
    );
  }

  return api;
})();