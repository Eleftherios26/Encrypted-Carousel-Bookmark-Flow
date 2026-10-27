/**
 * unlock-handler.js — Unlock & setup handler
 *
 * @path     background/communication/unlock-handler.js
 * @version  12.2.0
 * @since    v12E / v12.2
 *
 * PURPOSE
 *   Χειρίζεται τα unlock/setup requests από τον overlay. Είναι τα
 *   ΜΟΝΑΔΙΚΑ handlers που ΔΕΝ περνούν από capability enforcement
 *   (ο χρήστης δεν έχει ακόμα capabilities).
 *
 * RESPONSIBILITIES
 *   • Rate limit (unified error mapping)
 *   • Validation (password presence + length)
 *   • FSM transitions (LOCKED → UNLOCKING → UNLOCKED/LOCKED)
 *   • Error mapping (Argon2, vault state, password)
 *   • Grant capabilities στo success
 *
 * ERROR MAPPING
 *   • VAULT_MERKLE_MISMATCH → VAULT_TAMPERED (H-06)
 *   • ARGON2_LOW_MEMORY → 'ARGON2_LOW_MEMORY' (v12.2 SAFE-01)
 *   • ARGON2_* → detailed codes
 *   • WRONG_PASSWORD → WRONG_PASSWORD
 *   • Rate limit reasons → COOLDOWN | RATE_LIMITED
 *
 * DECISIONS
 *   D-21, D-30
 *
 * CHANGELOG v12.2.0 (2026-09-26) — LOW-MEMORY SAFETY
 *   ═══════════════════════════════════════════════════════════════════
 *   SAFE-01: ARGON2_LOW_MEMORY mapping
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Σε low-end μηχανήματα (< 1GB RAM), το WASM allocation για
 *       64 MiB μπορεί να αποτύχει. Το argon2-loader.js v12.2 πετάει
 *       σαφές σφάλμα 'ARGON2_LOW_MEMORY: ...' αλλά το unlock-handler
 *       δεν το ξεχώριζε — το mapped σε generic 'ARGON2_ERROR'.
 *
 *     ΛΥΣΗ:
 *       Προσθήκη explicit check για ARGON2_LOW_MEMORY ΠΡΙΝ από το
 *       generic ARGON2_ catch-all στο _mapUnlockError() και
 *       _mapSetupError(). Έτσι ο client (overlay) μπορεί να δείξει
 *       φιλικό μήνυμα:
 *         "⚠️ Χρειάζονται 64MB ελεύθερης μνήμης."
 *
 *     Backward compatible:
 *       • Όλοι οι callers που ελέγχουν /ARGON2_/ συνεχίζουν να δουλεύουν
 *       • Ίδιο flow, ίδια FSM transitions, ίδια grants
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "unlock"
 */

var CBF_UNLOCK_HANDLER = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[UNLOCK]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[UNLOCK]', ...a); }
  function err(...a)  { CBF_LOGGER.error('[UNLOCK]', ...a); }
  function sec(...a)  { CBF_LOGGER.security('[UNLOCK]', ...a); }

  function _short(sid) {
    return typeof sid === 'string' ? sid.slice(0, 8) : 'unknown';
  }

  // ============================================================
  //  Rate limit — unified error mapping
  // ============================================================
  function _mapRateLimitError(reason) {
    if (reason === 'COOLDOWN') return 'COOLDOWN';
    return 'RATE_LIMITED';
  }

  function _checkRateLimit(sessionId, command) {
    return CBF_RATE_LIMITER.check(sessionId, command);
  }

  // ============================================================
  //  Error → code mapping (unlock)
  //
  //  Σειρά ελέγχου (SPECIFIC → GENERIC):
  //    1. ARGON2_LOW_MEMORY          ← ⭐ v12.2 SAFE-01 (πριν generic)
  //    2. VAULT_MERKLE_MISMATCH → VAULT_TAMPERED (H-06)
  //    3. VAULT_TAMPERED
  //    4. ARGON2_SRI_NOT_CONFIGURED
  //    5. ARGON2_WASM_INTEGRITY_FAILED
  //    6. ARGON2_WASM_FETCH_FAILED
  //    7. ARGON2_NOT_LOADED
  //    8. ARGON2_WASM (generic WASM)
  //    9. ARGON2_ (generic — ΠΡΕΠΕΙ να είναι τελευταίο)
  //   10. WRONG_PASSWORD
  //   11. Vault state errors
  //   12. Fallback: UNLOCK_FAILED
  //
  //  H-06: VAULT_MERKLE_MISMATCH → VAULT_TAMPERED
  //    Consistency με background.js._mapUnlockError()
  //    Defense-in-depth: δεν αποκαλύπτουμε stateMAC vs Merkle
  // ============================================================
  function _mapUnlockError(e) {
    const msg = (e && e.message) || '';

    // ⭐ v12.2 SAFE-01: Low-memory classification
    //  ΠΡΕΠΕΙ να είναι ΠΡΙΝ από το generic /ARGON2_/
    if (/ARGON2_LOW_MEMORY/i.test(msg))                   return 'ARGON2_LOW_MEMORY';

    // H-06: Merkle mismatch = Tampered
    if (/VAULT_MERKLE_MISMATCH/i.test(msg))               return 'VAULT_TAMPERED';

    // State MAC
    if (/VAULT_TAMPERED/i.test(msg))                      return 'VAULT_TAMPERED';

    // Argon2 errors (specific → generic)
    if (/ARGON2_SRI_NOT_CONFIGURED/i.test(msg))           return 'ARGON2_NOT_CONFIGURED';
    if (/ARGON2_WASM_INTEGRITY_FAILED/i.test(msg))        return 'ARGON2_INTEGRITY_FAILED';
    if (/ARGON2_WASM_FETCH_FAILED/i.test(msg))            return 'ARGON2_WASM_FETCH_FAILED';
    if (/ARGON2_NOT_LOADED/i.test(msg))                   return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASHWASM_NOT_LOADED/i.test(msg))          return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASH_FAILED/i.test(msg))                  return 'ARGON2_HASH_FAILED';
    if (/ARGON2_WASM/i.test(msg))                         return 'ARGON2_WASM_ERROR';
    if (/ARGON2_/i.test(msg))                             return 'ARGON2_ERROR';

    // Password
    if (/WRONG_PASSWORD|Wrong password/i.test(msg))       return 'WRONG_PASSWORD';

    // Vault state
    if (/Vault state not found/i.test(msg))               return 'VAULT_CORRUPTED';
    if (/VAULT_STATE_CORRUPTED/i.test(msg))               return 'VAULT_CORRUPTED';
    if (/not initialized/i.test(msg))                     return 'NOT_INITIALIZED';

    return 'UNLOCK_FAILED';
  }

  // ============================================================
  //  Error → code mapping (setup)
  //
  //  ⭐ v12.2 SAFE-01: ARGON2_LOW_MEMORY check πριν generic ARGON2_
  // ============================================================
  function _mapSetupError(e) {
    const msg = (e && e.message) || '';

    // ⭐ v12.2 SAFE-01: Low-memory classification
    if (/ARGON2_LOW_MEMORY/i.test(msg))                   return 'ARGON2_LOW_MEMORY';

    if (/ARGON2_SRI_NOT_CONFIGURED/i.test(msg))           return 'ARGON2_NOT_CONFIGURED';
    if (/ARGON2_WASM_INTEGRITY_FAILED/i.test(msg))        return 'ARGON2_INTEGRITY_FAILED';
    if (/ARGON2_WASM_FETCH_FAILED/i.test(msg))            return 'ARGON2_WASM_FETCH_FAILED';
    if (/ARGON2_NOT_LOADED/i.test(msg))                   return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASHWASM_NOT_LOADED/i.test(msg))          return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASH_FAILED/i.test(msg))                  return 'ARGON2_HASH_FAILED';
    if (/ARGON2_WASM/i.test(msg))                         return 'ARGON2_WASM_ERROR';
    if (/ARGON2_/i.test(msg))                             return 'ARGON2_ERROR';
    if (/already initialized/i.test(msg))                 return 'ALREADY_INITIALIZED';
    if (/password/i.test(msg))                            return 'PASSWORD_ERROR';

    return 'SETUP_FAILED';
  }

  // ============================================================
  //  Handle unlock
  // ============================================================
  async function handle(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const sidShort = _short(sessionId);

    log(`unlock: request from ${sidShort} cmd=${(commandId || '').slice(0, 8)}`);

    // ---------- Rate limit ----------
    const rl = _checkRateLimit(sessionId, 'unlock');
    if (!rl.allowed) {
      warn(`unlock: RATE_LIMITED (${rl.reason}) for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId,
        success: false,
        error: _mapRateLimitError(rl.reason)
      });
      return;
    }

    // ---------- Validate ----------
    const password = msg.payload?.password;
    if (typeof password !== 'string' || password.length === 0) {
      warn(`unlock: PASSWORD_REQUIRED for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId, success: false, error: 'PASSWORD_REQUIRED'
      });
      return;
    }

    // ---------- Already unlocked ----------
    if (CBF_VAULT_FSM.getState() === CBF_VAULT_FSM.State.UNLOCKED) {
      log(`unlock: ALREADY_UNLOCKED for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId, success: true, alreadyUnlocked: true
      });
      return;
    }

    // ---------- Busy check ----------
    if (CBF_VAULT_FSM.isBusy()) {
      warn(`unlock: FSM BUSY (state=${CBF_VAULT_FSM.getState()}) for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId, success: false, error: 'BUSY'
      });
      return;
    }

    // ---------- FSM transition: LOCKED → UNLOCKING ----------
    try {
      await CBF_VAULT_FSM.beginUnlock();
      log(`unlock: FSM → UNLOCKING`);
    } catch (e) {
      err(`unlock: beginUnlock failed: ${e.message}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId, success: false, error: 'INVALID_STATE'
      });
      return;
    }

    // ============================================================
    //  Core unlock attempt
    // ============================================================
    try {
      await CBF_ES.unlock(password);
      await CBF_VAULT_FSM.completeUnlock();

      CBF_SESSION.grantCapabilitiesToAll([
        CBF_SESSION.CAP_READ,
        CBF_SESSION.CAP_WRITE
      ]);

      CBF_RATE_LIMITER.reset(sessionId, 'unlock');

      sec(`unlock SUCCESS for ${sidShort} — generation=${CBF_PROJECTION.getGeneration()}`);

      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId,
        success: true,
        generation: CBF_PROJECTION.getGeneration()
      });
    } catch (e) {
      // FSM rollback
      try { await CBF_VAULT_FSM.failUnlock(); } catch (_) {}

      const errorCode = _mapUnlockError(e);

      // H-06: Distinguish integrity failures
      if (errorCode === 'VAULT_TAMPERED') {
        sec(
          `unlock TAMPERED for ${sidShort} — ` +
          `integrity failure (stateMAC or Merkle): ${e.message}`
        );
      }
      // ⭐ v12.2 SAFE-01: distinguish low-memory failures
      else if (errorCode === 'ARGON2_LOW_MEMORY') {
        sec(
          `unlock LOW_MEMORY for ${sidShort} — ` +
          `Argon2 allocation failed: ${e.message}`
        );
      } else {
        warn(`unlock FAILED for ${sidShort} — code=${errorCode}: ${e.message}`);
      }

      await CBF_MESSAGING.sendTo(port, sessionId, 'unlockResult', {
        commandId,
        success: false,
        error: errorCode,
        message: e.message   // πραγματικό μήνυμα για debugging
      });
    }
  }

  // ============================================================
  //  Handle setup
  // ============================================================
  async function handleSetup(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const sidShort = _short(sessionId);

    log(`setup: request from ${sidShort} cmd=${(commandId || '').slice(0, 8)}`);

    // ---------- Rate limit ----------
    const rl = _checkRateLimit(sessionId, 'setup');
    if (!rl.allowed) {
      warn(`setup: RATE_LIMITED (${rl.reason}) for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId,
        success: false,
        error: _mapRateLimitError(rl.reason)
      });
      return;
    }

    // ---------- Validate ----------
    const password = msg.payload?.password;
    if (typeof password !== 'string' || password.length < 6) {
      warn(`setup: PASSWORD_TOO_SHORT for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId, success: false, error: 'PASSWORD_TOO_SHORT'
      });
      return;
    }

    // ---------- Already initialized? ----------
    const status = await CBF_ES.getStatus();
    if (status.initialized) {
      warn(`setup: ALREADY_INITIALIZED for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId, success: false, error: 'ALREADY_INITIALIZED'
      });
      return;
    }

    // ---------- Busy check ----------
    if (CBF_VAULT_FSM.isBusy()) {
      warn(`setup: FSM BUSY for ${sidShort}`);
      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId, success: false, error: 'BUSY'
      });
      return;
    }

    // ============================================================
    //  Setup attempt
    // ============================================================
    try {
      await CBF_VAULT_FSM.beginUnlock();
      log(`setup: FSM → UNLOCKING`);

      await CBF_ES.setup(password);
      await CBF_VAULT_FSM.completeUnlock();

      CBF_SESSION.grantCapabilitiesToAll([
        CBF_SESSION.CAP_READ,
        CBF_SESSION.CAP_WRITE
      ]);

      CBF_RATE_LIMITER.reset(sessionId, 'setup');

      sec(`setup SUCCESS for ${sidShort} — generation=${CBF_PROJECTION.getGeneration()}`);

      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId,
        success: true,
        generation: CBF_PROJECTION.getGeneration()
      });
    } catch (e) {
      try { await CBF_VAULT_FSM.failUnlock(); } catch (_) {}

      const errorCode = _mapSetupError(e);

      // ⭐ v12.2 SAFE-01: distinguish low-memory failures
      if (errorCode === 'ARGON2_LOW_MEMORY') {
        sec(
          `setup LOW_MEMORY for ${sidShort} — ` +
          `Argon2 allocation failed: ${e.message}`
        );
      } else {
        err(
          `setup FAILED for ${sidShort} — code=${errorCode}: ${e.message}`,
          '| stack:', e.stack
        );
      }

      await CBF_MESSAGING.sendTo(port, sessionId, 'setupResult', {
        commandId,
        success: false,
        error: errorCode,
        message: e.message   // πραγματικό μήνυμα για debugging
      });
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    handle,
    handleSetup,

    _internal: {
      _mapRateLimitError,
      _mapUnlockError,
      _mapSetupError
    }
  };

  if (typeof self !== 'undefined') self.CBF_UNLOCK_HANDLER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_UNLOCK_HANDLER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Unlock Handler ready (v12.2.0: H-06 VAULT_MERKLE_MISMATCH mapping + ' +
      'SAFE-01 ARGON2_LOW_MEMORY + unified rate limit + detailed error mapping)'
    );
  }

  return api;
})();