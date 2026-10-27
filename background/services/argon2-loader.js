/**
 * argon2-loader.js — Argon2id KDF via hash-wasm (bundled WASM)
 *
 * @path     background/services/argon2-loader.js
 * @version  12.2.0
 * @since    v12E / v12.2
 *
 * PURPOSE
 *   Φορτώνει το bundled hash-wasm module (self.hashwasm) και εκθέτει
 *   το Argon2id deriveKey API. Το WASM είναι inline base64 — δεν
 *   γίνεται fetch / SRI / network call.
 *
 * KDF PROFILE (D-21 — immutable)
 *   • Algorithm: Argon2id
 *   • Memory:    64 MiB (65536 KB)
 *   • Iterations: 3
 *   • Parallelism: 1
 *   • Hash length: 32 bytes
 *   • Library: hash-wasm v4+ (bundled)
 *
 * NON-OBVIOUS
 *   • load() ΔΕΝ είναι async — επιστρέφει shared promise reference
 *     (C2 fix) ώστε παράλληλοι callers να πάρουν το ΙΔΙΟ promise.
 *   • waitForHashWasm() κάνει fail-fast αν το module είναι
 *     malformed (χωρίς argon2id function) — δεν περιμένει timeout.
 *   • ΔΕΝ υπάρχει PBKDF2 fallback (D-21).
 *   • ⚠️ v12.2: ΔΕΝ υπάρχει auto memory-fallback — θα έσπαγε τα
 *     υπάρχοντα vaults (τα kdfInfo params είναι 65536 KB).
 *
 * DECISIONS
 *   D-21, D-21.1, D-26
 *
 * CHANGELOG v12.2.0 (2026-09-26) — LOW-MEMORY SAFETY
 *   ═══════════════════════════════════════════════════════════════════
 *   SAFE-01: ARGON2_LOW_MEMORY error classification
 *
 *     ΠΡΟΒΛΗΜΑ (low-end hardware):
 *       Σε συστήματα με <1 GB ελεύθερη RAM, το WASM allocation για
 *       64 MiB μπορεί να αποτύχει. Ο χρήστης έβλεπε ένα ασαφές
 *       "ARGON2_HASH_FAILED: ..." χωρίς να ξέρει τι να κάνει.
 *
 *     ΛΥΣΗ:
 *       Το deriveKey() τώρα διαβάζει το error message και ανιχνεύει
 *       memory-related failures (memory, alloc, abort, out of, OOM).
 *       Σε αυτή την περίπτωση, πετάει ένα ΣΑΦΕΣ μήνυμα:
 *         "ARGON2_LOW_MEMORY: Ο κρυπτογραφημένος χώρος χρειάζεται
 *          64MB ελεύθερης μνήμης. Κλείστε μερικές καρτέλες..."
 *
 *     ΔΕΝ κάνουμε AUTO-FALLBACK σε 32 MiB:
 *       • Τα vault records είναι κρυπτογραφημένα με storeKey που
 *         προέρχεται από 64 MiB derive.
 *       • Αν κάνουμε derive με 32 MiB → διαφορετικό master →
 *         διαφορετικό storeKey → decrypt FAIL → data corruption.
 *       • Αντί να σπάσουμε σιωπηλά, ζητάμε από τον χρήστη να
 *         ελευθερώσει RAM και να ξαναπροσπαθήσει.
 *
 *     ΚΑΛΥΨΗ:
 *       • Ίδια PROFILE params (65536/3/1/32) — καμία αλλαγή
 *       • Ίδιο flow, ίδιο timing
 *       • Νέα μόνο η error classification + μήνυμα
 *       • Callers (encrypted-space.js, unlock-handler.js) ΔΕΝ
 *         χρειάζονται αλλαγή — το error code αναγνωρίζεται ήδη
 *         από το _mapUnlockError / _mapSetupError (regex ARGON2_*)
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "argon2-loader"
 */

var CBF_ARGON2 = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.security('[ARGON2]', ...a);
    else console.log('[ARGON2]', ...a);
  }
  function info(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('[ARGON2]', ...a);
    else console.log('[ARGON2]', ...a);
  }
  function warn(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.warn('[ARGON2]', ...a);
    else console.warn('[ARGON2]', ...a);
  }
  function err(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.error('[ARGON2]', ...a);
    else console.error('[ARGON2]', ...a);
  }

  // ============================================================
  //  KDF profile — immutable (D-21)
  // ============================================================
  const PROFILE = Object.freeze({
    id: 'argon2id',
    version: 1,
    params: Object.freeze({
      memory: 65536,          // 64 MiB (KB)
      iterations: 3,          // t_cost
      parallelism: 1,         // p
      hashLength: 32          // bytes
    })
  });

  // ============================================================
  //  ⭐ v12.2 SAFE-01: Memory error detection patterns
  //
  //  Το WASM module επιστρέφει διάφορα messages ανάλογα με το πώς
  //  αποτυγχάνει το allocation:
  //    • "Cannot allocate memory"
  //    • "memory access out of bounds"
  //    • "out of memory"
  //    • "OOM"
  //    • "abort(...)"
  //    • "RangeError: Invalid typed array length"
  //
  //  ΔΕΝ χρησιμοποιούμε απλό string.includes() γιατί τα messages
  //  μπορεί να έχουν διαφορετικό casing.
  // ============================================================
  const _MEMORY_ERROR_PATTERN =
    /memory|alloc|abort|out\s*of|oom|rangeerror|typed\s*array|stack/i;

  function _isMemoryError(msg) {
    if (typeof msg !== 'string') return false;
    return _MEMORY_ERROR_PATTERN.test(msg);
  }

  // ============================================================
  //  State (RAM only)
  // ============================================================
  let argon2idFn = null;
  let loadPromise = null;
  let isReady = false;

  // ============================================================
  //  waitForHashWasm — περιμένει το bundled module
  //
  //  3-way branching (fail-fast):
  //    1. candidate === undefined → poll μέχρι timeout (NOT_LOADED)
  //    2. candidate && no argon2id → reject ΑΜΕΣΩΣ (INVALID)
  //    3. candidate && argon2id   → resolve ΑΜΕΣΩΣ
  // ============================================================
  function waitForHashWasm(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let checks = 0;

      const check = () => {
        checks++;

        const candidate =
          (typeof self !== 'undefined' && self.hashwasm) ||
          (typeof globalThis !== 'undefined' && globalThis.hashwasm);

        // Case 2: candidate υπάρχει αλλά invalid → fail-fast
        if (candidate) {
          if (typeof candidate.argon2id !== 'function') {
            return reject(new Error(
              'ARGON2_HASHWASM_INVALID: self.hashwasm exists but ' +
              'argon2id function is missing. ' +
              'The bundled hash-wasm module is malformed or incomplete. ' +
              'Expected: vendor/hash-wasm/argon2.umd.min.js (hash-wasm v4+).'
            ));
          }

          // Case 3: candidate valid
          info(`waitForHashWasm: found after ${checks} check(s) (${Date.now() - start}ms)`);
          return resolve(candidate);
        }

        // Case 1: candidate ΔΕΝ υπάρχει → poll
        if (Date.now() - start > timeoutMs) {
          return reject(new Error(
            'ARGON2_HASHWASM_NOT_LOADED: self.hashwasm not found after ' +
            timeoutMs + 'ms (' + checks + ' checks). ' +
            'Did you add vendor/hash-wasm/argon2.umd.min.js ' +
            'to manifest.json background.scripts BEFORE argon2-loader.js?'
          ));
        }

        setTimeout(check, 50);
      };
      check();
    });
  }

  // ============================================================
  //  load — non-async, shared promise reference (C2 fix)
  //
  //  Επιστρέφει:
  //    - Promise.resolve(true)  αν isReady (cached)
  //    - loadPromise            αν in-flight (SAME reference)
  //    - νέο loadPromise        αν 1η κλήση
  //
  //  Reference equality: A.load() === A.load() (in-flight)
  // ============================================================
  function load() {
    if (isReady) {
      return Promise.resolve(true);
    }

    if (loadPromise) {
      info('load: already in flight — returning SAME promise');
      return loadPromise;
    }

    info('load: starting (first call)');

    const innerPromise = (async () => {
      log('Argon2: waiting for hash-wasm module (self.hashwasm)');

      const hashwasm = await waitForHashWasm();

      if (typeof hashwasm.argon2id !== 'function') {
        throw new Error('ARGON2_HASHWASM_INVALID: argon2id function missing');
      }

      argon2idFn = hashwasm.argon2id;

      info('Argon2: hash-wasm module ready (argon2id)');

      isReady = true;
      return true;
    })();

    loadPromise = innerPromise;

    // Cleanup chain — side-channel (δεν αντικαθιστά το loadPromise)
    innerPromise.catch((e) => {
      if (loadPromise === innerPromise) {
        warn('load: FAILED — resetting state:', e.message);
        loadPromise = null;
        isReady = false;
        argon2idFn = null;
      } else {
        warn('load: FAILED (but loadPromise was replaced) — skip reset');
      }
    });

    return loadPromise;
  }

  // ============================================================
  //  isLoaded
  // ============================================================
  function isLoaded() {
    return isReady && argon2idFn !== null;
  }

  // ============================================================
  //  validateDeriveKeyInputs
  // ============================================================
  function validateDeriveKeyInputs(password, salt) {
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('argon2: password must be non-empty string');
    }
    if (!(salt instanceof Uint8Array) || salt.length < 16) {
      throw new Error('argon2: salt must be Uint8Array >= 16 bytes');
    }
  }

  // ============================================================
  //  deriveKey
  //
  //  Input:  password (string), salt (Uint8Array >=16 bytes)
  //  Output: Uint8Array(32) — το Argon2id hash
  //
  //  ⭐ v12.2 SAFE-01:
  //    Αν το WASM allocation αποτύχει λόγω RAM, πετάμε σαφές
  //    ARGON2_LOW_MEMORY αντί για generic ARGON2_HASH_FAILED.
  //    ΔΕΝ κάνουμε auto-fallback — αυτό θα έσπαγε το vault.
  // ============================================================
  async function deriveKey(password, salt) {
    validateDeriveKeyInputs(password, salt);

    if (!isReady || !argon2idFn) {
      throw new Error('ARGON2_NOT_LOADED: call load() first');
    }

    log(`deriveKey: starting (${PROFILE.params.memory}KB, t=${PROFILE.params.iterations}, p=${PROFILE.params.parallelism})`);

    let result;
    try {
      result = await argon2idFn({
        password: password,
        salt: salt,
        parallelism: PROFILE.params.parallelism,
        iterations: PROFILE.params.iterations,
        memorySize: PROFILE.params.memory,
        hashLength: PROFILE.params.hashLength,
        outputType: 'binary'
      });
    } catch (e) {
      const msg = (e && e.message) || String(e);

      // ⭐ v12.2 SAFE-01: Low-memory classification
      //
      //  Αν το error μοιάζει με memory allocation failure → σαφές μήνυμα.
      //  Ο χρήστης ξέρει τι να κάνει (κλείσιμο καρτελών).
      //  Αν ΔΕΝ κάνουμε classification, ο χρήστης βλέπει ένα
      //  ακατανόητο WASM error και δεν μπορεί να κάνει τίποτα.
      if (_isMemoryError(msg)) {
        err(`deriveKey: MEMORY allocation FAILED for ${PROFILE.params.memory}KB`);
        err(`deriveKey: raw error: ${msg}`);
        throw new Error(
          'ARGON2_LOW_MEMORY: Ο κρυπτογραφημένος χώρος χρειάζεται ' +
          `${Math.round(PROFILE.params.memory / 1024)}MB ελεύθερης μνήμης. ` +
          'Κλείστε μερικές καρτέλες και δοκιμάστε ξανά.'
        );
      }

      // Generic hash failure
      err('deriveKey: hash FAILED:', msg);
      throw new Error('ARGON2_HASH_FAILED: ' + msg);
    }

    if (!(result instanceof Uint8Array)) {
      throw new Error(
        'ARGON2_UNEXPECTED_RESULT: expected Uint8Array, got ' +
        (result === null ? 'null' : typeof result)
      );
    }

    if (result.length !== PROFILE.params.hashLength) {
      throw new Error(
        'ARGON2_HASH_LENGTH_MISMATCH: got ' + result.length +
        ' bytes, expected ' + PROFILE.params.hashLength
      );
    }

    // D-10: copy
    const out = new Uint8Array(result).slice();
    info('deriveKey: complete (32 bytes derived)');
    return out;
  }

  // ============================================================
  //  zeroize — best effort (WASM heap δεν είναι προσβάσιμο)
  // ============================================================
  function zeroize() {
    warn('zeroize: not supported in hash-wasm bundled mode (best-effort)');
  }

  // ============================================================
  //  getProfile
  // ============================================================
  function getProfile() {
    return {
      id: PROFILE.id,
      version: PROFILE.version,
      params: { ...PROFILE.params }
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    load,
    isLoaded,
    deriveKey,
    zeroize,
    getProfile,

    _internal: {
      PROFILE,
      waitForHashWasm,
      getArgon2idFn: () => argon2idFn,
      getLoadPromise: () => loadPromise,
      getIsReady: () => isReady,

      // ⭐ v12.2 SAFE-01: exposed για tests + diagnostics
      isMemoryError: _isMemoryError,
      MEMORY_ERROR_PATTERN: _MEMORY_ERROR_PATTERN
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_ARGON2 = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_ARGON2 = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Argon2 Loader ready (v12.2.0: non-async load — ' +
      'shared promise reference + fail-fast invalid hashwasm + ' +
      'SAFE-01 low-memory classification)'
    );
  }

  return api;
})();