/**
 * background.js — Background Bootstrap (MV3 Event Page)
 *
 * @path     background/background.js
 * @version  12.3.0
 * @since    v12E / v12.3
 *
 * PURPOSE
 *   Κεντρικό bootstrap του background:
 *     • Φορτώνει FSM, mutation registry, projection
 *     • Εγγράφει listeners (onConnect, onMessage, onInstalled, action)
 *     • Περιοδικούς ελέγχους ακεραιότητας (stateMAC 60s, Merkle 300s)
 *     • Rate limiter cleanup interval
 *     • onSuspend cleanup (MV3 lifecycle)
 *
 * KEY CONCEPTS
 *   • INJECTED_SCRIPTS (24) — σειρά φόρτωσης overlay scripts
 *   • L-08 REVISED — sync top-level onConnect (MV3 race fix)
 *   • _pendingPorts[] + _fsmReady — port queue για wake-up race
 *   • M-07 — re-check tab URL πριν το injectOverlay
 *   • M-08 — reset all port spaces σε FSM LOCKED
 *
 * NON-OBVIOUS
 *   • Ο onConnect listener ΠΡΕΠΕΙ να είναι sync (top-level) —
 *     αν είναι μέσα σε async bootstrap, το port χάνεται στο wake-up.
 *   • Το onSuspend ΔΕΝ καλεί CBF_ES.lock() — τα κλειδιά χάνονται
 *     αυτόματα (D-32).
 *   • Δύο onMessage listeners: ένας sync (validation) + ένας async
 *     (handlers). Δεν είναι duplicate.
 *
 * DECISIONS
 *   D-13.1, D-23.1, D-24.1, D-27, D-31, D-32
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — RATE LIMITER CONFIG VERIFICATION
 *   ══════════════════════════════════════════════════════════════════════
 *   FIX-6 (LOW): Startup verification ότι όλα τα HANDLERS έχουν
 *   PER_COMMAND rate limit entry.
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Το rate-limiter.js::check() returns { allowed: true } για
 *       unknown commands — silent bypass. Αν κάποιος προσθέσει νέο
 *       handler στο messaging.js αλλά ξεχάσει το PER_COMMAND, ο
 *       handler λειτουργεί ΧΩΡΙΣ rate limiting (DoS risk).
 *
 *     ΛΥΣΗ:
 *       Step 7 στο bootstrap:
 *         • Διαβάζει Object.keys(HANDLERS) από messaging.js
 *         • Διαβάζει Object.keys(PER_COMMAND) από rate-limiter.js
 *         • Αν υπάρχουν handlers χωρίς config → LOG.warn με λίστα
 *         • Αν όλα OK → LOG.security verified
 *
 *     Impact:
 *       Catch configuration drift σε development. Zero runtime overhead.
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.2.0 → 12.3.0
 *     • Ενοποίηση init log strings (v12.2 → v12.3)
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.2.0 (2026-09-26) — LOW-END HARDWARE OPTIMIZATION
 *   ══════════════════════════════════════════════════════════════════════
 *   SAFE-01 (error mapping):
 *     • _mapSetupError:    + ARGON2_LOW_MEMORY
 *     • _mapUnlockError:   + ARGON2_LOW_MEMORY
 *     • _mapChangePwdError: + ARGON2_LOW_MEMORY (defensive)
 *
 *     Rationale:
 *       Σε low-end μηχανήματα (< 1GB RAM), το WASM allocation για
 *       64 MiB μπορεί να αποτύχει. Το argon2-loader.js v12.2 πετάει
 *       σαφές σφάλμα 'ARGON2_LOW_MEMORY: ...' που τώρα mapped σε
 *       distinct error code (αντί για generic 'ARGON2_ERROR').
 *
 *       Ο client (overlay) μπορεί να δείξει φιλικό μήνυμα:
 *       "Χρειάζονται 64MB ελεύθερης μνήμης."
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "background"
 */

(function() {
  'use strict';

  const LOG = CBF_LOGGER;
  const SIMPLE_AUTH_KEY = 'simple-auth';

  // ============================================================
  //  Injected Overlay — Scripts (D-13.1, D-23.1)
  //
  //  ΣΕΙΡΑ ΦΟΡΤΩΣΗΣ D&D (αυστηρή):
  //    leaves → ui-coordinator → dragdrop
  //
  //  ΣΕΙΡΑ ΦΟΡΤΩΣΗΣ FEATURES:
  //    add-bookmark / add-folder / search / pin
  //    main-menu / context-menu (V12E)
  //
  //  ENTRY (LAST):
  //    content-overlay.js (bootstrap — χρειάζεται όλα τα άλλα)
  // ============================================================
  const INJECTED_SCRIPTS = [
    // ─── 1. Foundation ───
    'background/core/logger-service.js',
    'background/services/canonical-encoding.js',
    'background/services/timing-safe.js',
    'background/services/crypto-service.js',

    // ─── 2. Overlay state ───
    'overlay/core/replica-store.js',
    'overlay/core/modal-service.js',
    'overlay/selection-manager.js',
    'overlay/core/breadcrumb-manager.js',

    // ─── 3. Bridge ───
    'overlay/bridge.js',

    // ─── 4. UI Controller ───
    'overlay/core/ui-controller.js',

    // ─── 5. Drag & Drop ───
    'overlay/drag_and_drop/bookmark_transfer.js',
    'overlay/drag_and_drop/merge.js',
    'overlay/drag_and_drop/redistribution.js',
    'overlay/drag_and_drop/firefox_drag_and_drop/firefox-merge.js',
    'overlay/drag_and_drop/firefox_drag_and_drop/firefox-redistribution.js',
    'overlay/drag_and_drop/ui-coordinator.js',
    'overlay/drag_and_drop/dragdrop.js',

    // ─── 6. Post-MVP Features ───
    'overlay/features/add-bookmark.js',
    'overlay/features/add-folder.js',
    'overlay/features/search.js',
    'overlay/features/pin.js',

    // ─── 7. V12E Features ───
    'overlay/features/main-menu.js',
    'overlay/features/context-menu.js',

    // ─── 8. Entry (LAST) ───
    'overlay/content-overlay.js'
  ];

  // ============================================================
  //  L-08 REVISED: Port Queue State
  //
  //  Σε MV3 wake-up, ο Firefox fire-άρει onConnect πριν ολοκληρωθεί
  //  το async bootstrap. Αν ο listener δεν είναι registered, το port
  //  χάνεται → dead client.
  //
  //  Λύση: sync top-level registration + queue + flush μετά FSM init.
  // ============================================================
  const _pendingPorts = [];
  let _fsmReady = false;

  // ============================================================
  //  ensureVaultState — post-unlock hook
  // ============================================================
  async function ensureVaultState() {
    if (!CBF_ES.isUnlocked()) return;
    const storeKey = CBF_ES._internal.getStoreKey();
    if (!storeKey) return;

    try {
      const stateRec = await CBF_VAULT_TX.readState();
      if (stateRec) {
        LOG.debug('ensureVaultState: state already present');
        return;
      }
      LOG.info('ensureVaultState: no state → fresh vault');
    } catch (e) {
      LOG.warn('ensureVaultState failed:', e.message);
    }
  }

  // ============================================================
  //  M-08: Reset all port spaces στο FSM LOCKED
  //
  //  Όταν το vault κλειδώνει, όλα τα ports πρέπει να επιστρέψουν
  //  στο firefox space. Χωρίς αυτό, ένα port που ήταν στο encrypted
  //  space θα στείλει επόμενο command σε λάθος space.
  // ============================================================
  function _resetAllPortSpaces() {
    try {
      if (typeof CBF_MESSAGING !== 'undefined' &&
          CBF_MESSAGING._internal &&
          typeof CBF_MESSAGING._internal.resetAllPortSpaces === 'function') {
        const count = CBF_MESSAGING._internal.resetAllPortSpaces();
        LOG.security(`M-08: reset ${count} port space(s) → firefox`);
        return count;
      }

      LOG.warn(
        'M-08: resetAllPortSpaces helper not available in messaging — ' +
        'ports may be stale (will auto-heal on next setActiveSpace)'
      );
      return 0;
    } catch (e) {
      LOG.warn('M-08: _resetAllPortSpaces failed:', e.message);
      return 0;
    }
  }

  // ============================================================
  //  FSM transition listener
  // ============================================================
  CBF_VAULT_FSM.onTransition(async (newState, oldState) => {
    LOG.info(`FSM transition: ${oldState} → ${newState}`);

    if (newState === CBF_VAULT_FSM.State.LOCKED
        && oldState !== CBF_VAULT_FSM.State.INITIAL) {
      LOG.security('Vault LOCKED — clearing capabilities + keys + port spaces');

      CBF_SESSION.clearAllCapabilities();

      try {
        if (typeof CBF_ES.lock === 'function') CBF_ES.lock();
      } catch (e) {
        LOG.warn('CBF_ES.lock() failed during FSM LOCKED:', e.message);
      }

      _resetAllPortSpaces();

      LOG.security('Vault LOCKED complete (keys zeroized, port spaces reset)');
    }

    if (newState === CBF_VAULT_FSM.State.UNLOCKED) {
      LOG.info('Vault UNLOCKED — ensuring state');
      await ensureVaultState();
    }
  });

  // ============================================================
  //  L-08 REVISED: Port connections (SYNC top-level registration)
  //
  //  Ο onConnect listener ΠΡΕΠΕΙ να είναι registered synchronously
  //  στο top-level. Αν είναι μέσα σε async function → port dropped.
  // ============================================================
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CBF_MESSAGING.PORT_NAME) {
      LOG.debug(`onConnect: ignored port "${port.name}"`);
      return;
    }

    LOG.info(`onConnect: port "${port.name}" received (fsmReady=${_fsmReady})`);

    if (!_fsmReady) {
      LOG.info(`L-08: FSM not ready — queuing port (queue size: ${_pendingPorts.length + 1})`);
      _pendingPorts.push(port);
      return;
    }

    try {
      CBF_MESSAGING.handlePort(port);
    } catch (e) {
      LOG.error('onConnect: handlePort failed:', e.message);
      try { port.disconnect(); } catch (_) {}
    }
  });

  LOG.security('L-08 REVISED: onConnect registered synchronously (top-level)');

  // ============================================================
  //  L-08 REVISED: Flush pending ports (καλείται από bootstrap)
  // ============================================================
  function _flushPendingPorts() {
    const count = _pendingPorts.length;
    if (count === 0) return;

    LOG.security(`L-08: flushing ${count} queued port(s)`);

    const queued = _pendingPorts.splice(0);
    for (const port of queued) {
      try {
        CBF_MESSAGING.handlePort(port);
      } catch (e) {
        LOG.error('L-08: flush port failed:', e.message);
        try { port.disconnect(); } catch (_) {}
      }
    }

    LOG.info(`L-08: flushed ${count} port(s)`);
  }

  // ============================================================
  //  M-03: onSuspend — MV3 lifecycle cleanup (D-32)
  //
  //  Δεν καλούμε CBF_ES.lock() — τα κλειδιά χάνονται αυτόματα.
  //  Καθαρίζουμε επιπλέον: sequencer ramCache + inflight transfers.
  // ============================================================
  browser.runtime.onSuspend.addListener(() => {
    LOG.security('Background suspend — clearing session (no lock)');

    try { CBF_SESSION.clearAllCapabilities(); } catch (_) {}

    try {
      if (typeof CBF_PROJECTION.reset === 'function') CBF_PROJECTION.reset();
    } catch (_) {}

    try {
      if (typeof CBF_FAVICON !== 'undefined' &&
          typeof CBF_FAVICON.stopPassiveCollection === 'function') {
        CBF_FAVICON.stopPassiveCollection();
      }
    } catch (_) {}

    // M-03: Sequencer RAM cache
    try {
      if (typeof CBF_SEQUENCER !== 'undefined' &&
          CBF_SEQUENCER._internal &&
          CBF_SEQUENCER._internal.ramCache) {
        const size = CBF_SEQUENCER._internal.ramCache.size;
        CBF_SEQUENCER._internal.ramCache.clear();
        if (size > 0) {
          LOG.info(`M-03: cleared sequencer ramCache (${size} entries)`);
        }
      }
    } catch (e) {
      LOG.warn('M-03: sequencer ramCache cleanup failed:', e.message);
    }

    // M-03: Inflight transfers
    try {
      if (typeof CBF_CROSS_SPACE !== 'undefined' &&
          CBF_CROSS_SPACE._internal &&
          CBF_CROSS_SPACE._internal._inflightTransfers) {
        const size = CBF_CROSS_SPACE._internal._inflightTransfers.size;
        CBF_CROSS_SPACE._internal._inflightTransfers.clear();
        if (size > 0) {
          LOG.info(`M-03: cleared inflight transfers (${size} entries)`);
        }
      }
    } catch (e) {
      LOG.warn('M-03: inflight transfers cleanup failed:', e.message);
    }

    LOG.security('Background suspend — session cleared (M-03 expanded)');
  });

  // ============================================================
  //  H-02: Rate Limiter periodic cleanup
  // ============================================================
  setInterval(() => {
    try {
      if (typeof CBF_RATE_LIMITER !== 'undefined' &&
          typeof CBF_RATE_LIMITER.cleanup === 'function') {
        CBF_RATE_LIMITER.cleanup();
        LOG.debug('H-02: rate limiter cleanup ran');
      }
    } catch (e) {
      LOG.warn('H-02: rate limiter cleanup failed:', e.message);
    }
  }, 60000);

  LOG.security('H-02: rate limiter cleanup interval installed (60s)');

  // ============================================================
  //  Periodic integrity checks (§10.7)
  // ============================================================
  setInterval(async () => {
    if (!CBF_ES.isUnlocked()) return;
    try {
      const ok = await CBF_ES.verifyStateMAC();
      if (!ok) {
        LOG.security('PERIODIC_STATE_TAMPER_DETECTED');
        await CBF_VAULT_FSM.lock();
      }
    } catch (e) {
      LOG.warn('Periodic stateMAC check failed:', e.message);
    }
  }, 60000);

  setInterval(async () => {
    if (!CBF_ES.isUnlocked()) return;
    try {
      const ok = await CBF_ES.verifyMerkle();
      if (!ok) {
        LOG.security('PERIODIC_MERKLE_MISMATCH');
        await CBF_VAULT_FSM.lock();
      }
    } catch (e) {
      LOG.warn('Periodic Merkle check failed:', e.message);
    }
  }, 300000);

  LOG.info('Periodic integrity checks installed (stateMAC=60s, Merkle=300s)');

  // ============================================================
  //  Error mapping helpers
  //
  //  🔧 v12.2 SAFE-01: ARGON2_LOW_MEMORY mapping
  //
  //  Σειρά ελέγχου (SPECIFIC → GENERIC):
  //    1. ARGON2_LOW_MEMORY          ← νέο v12.2 (πριν από generic)
  //    2. ARGON2_SRI_NOT_CONFIGURED
  //    3. ARGON2_WASM_INTEGRITY_FAILED
  //    4. ARGON2_WASM_FETCH_FAILED
  //    5. ARGON2_NOT_LOADED
  //    6. ARGON2_WASM (generic WASM)
  //    7. ARGON2_HASHWASM_NOT_LOADED
  //    8. ARGON2_HASH_FAILED
  //
  //  ΣΗΜΑΝΤΙΚΟ: Το ARGON2_LOW_MEMORY πρέπει να ελέγχεται ΠΡΙΝ
  //  από τα generic patterns για να μην "καταποντιστεί" από αυτά.
  // ============================================================
  function _mapSetupError(err) {
    const msg = (err && err.message) || '';

    // 🔧 v12.2 SAFE-01
    if (/ARGON2_LOW_MEMORY/i.test(msg))                   return 'ARGON2_LOW_MEMORY';

    if (/ARGON2_SRI_NOT_CONFIGURED/i.test(msg))           return 'ARGON2_NOT_CONFIGURED';
    if (/ARGON2_WASM_INTEGRITY_FAILED/i.test(msg))        return 'ARGON2_INTEGRITY_FAILED';
    if (/ARGON2_WASM_FETCH_FAILED/i.test(msg))            return 'ARGON2_WASM_FETCH_FAILED';
    if (/ARGON2_NOT_LOADED/i.test(msg))                   return 'ARGON2_NOT_LOADED';
    if (/ARGON2_WASM/i.test(msg))                         return 'ARGON2_WASM_ERROR';
    if (/ARGON2_HASHWASM_NOT_LOADED/i.test(msg))          return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASH_FAILED/i.test(msg))                  return 'ARGON2_HASH_FAILED';
    if (/already initialized/i.test(msg))                 return 'ALREADY_INITIALIZED';
    if (/password/i.test(msg))                            return 'PASSWORD_ERROR';
    return 'SETUP_FAILED';
  }

  function _mapUnlockError(err) {
    const msg = (err && err.message) || '';

    // 🔧 v12.2 SAFE-01
    if (/ARGON2_LOW_MEMORY/i.test(msg))                   return 'ARGON2_LOW_MEMORY';

    if (/WRONG_PASSWORD|Wrong password/i.test(msg))       return 'WRONG_PASSWORD';
    if (/ARGON2_SRI_NOT_CONFIGURED/i.test(msg))           return 'ARGON2_NOT_CONFIGURED';
    if (/ARGON2_WASM_INTEGRITY_FAILED/i.test(msg))        return 'ARGON2_INTEGRITY_FAILED';
    if (/ARGON2_WASM_FETCH_FAILED/i.test(msg))            return 'ARGON2_WASM_FETCH_FAILED';
    if (/ARGON2_NOT_LOADED/i.test(msg))                   return 'ARGON2_NOT_LOADED';
    if (/ARGON2_WASM/i.test(msg))                         return 'ARGON2_WASM_ERROR';
    if (/ARGON2_HASHWASM_NOT_LOADED/i.test(msg))          return 'ARGON2_NOT_LOADED';
    if (/ARGON2_HASH_FAILED/i.test(msg))                  return 'ARGON2_HASH_FAILED';
    if (/ARGON2_/i.test(msg))                             return 'ARGON2_ERROR';
    if (/VAULT_TAMPERED/i.test(msg))                      return 'VAULT_TAMPERED';
    return 'UNLOCK_FAILED';
  }

  function _mapChangePwdError(err) {
    const msg = (err && err.message) || '';

    // 🔧 v12.2 SAFE-01 (defensive — changePassword καλεί Argon2 internally)
    if (/ARGON2_LOW_MEMORY/i.test(msg))                   return 'ARGON2_LOW_MEMORY';

    if (/WRONG_OLD_PASSWORD/i.test(msg))                  return 'WRONG_OLD_PASSWORD';
    if (/CHANGE_PASSWORD_ABORTED/i.test(msg))             return 'ABORTED';
    if (/CHANGE_PASSWORD_FAILED/i.test(msg))              return 'CHANGE_PASSWORD_FAILED';
    return 'CHANGE_PASSWORD_FAILED';
  }

  // ============================================================
  //  One-shot runtime messages
  // ============================================================
  browser.runtime.onMessage.addListener(async (msg, sender) => {
    if (!sender || sender.id !== browser.runtime.id) return;
    if (!msg || typeof msg !== 'object') return;

    // ─── getStatus ───
    if (msg.type === 'getStatus') {
      const s = await CBF_ES.getStatus();
      return {
        initialized: s.initialized,
        unlocked: s.unlocked,
        corruptedCount: s.corruptedCount || 0,
        fsmState: CBF_VAULT_FSM.getState(),
        generation: CBF_PROJECTION.getGeneration()
      };
    }

    // ─── setupSimple ───
    if (msg.type === 'setupSimple') {
      const rl = CBF_RATE_LIMITER.check(SIMPLE_AUTH_KEY, 'setup');
      if (!rl.allowed) return { success: false, error: 'RATE_LIMITED' };

      try {
        if (typeof msg.password !== 'string' || msg.password.length < 6) {
          return { success: false, error: 'PASSWORD_TOO_SHORT' };
        }
        const status = await CBF_ES.getStatus();
        if (status.initialized) {
          return { success: false, error: 'ALREADY_INITIALIZED' };
        }
        if (CBF_VAULT_FSM.isBusy()) {
          return { success: false, error: 'BUSY' };
        }
        await CBF_VAULT_FSM.beginUnlock();
        await CBF_ES.setup(msg.password);
        await CBF_VAULT_FSM.completeUnlock();
        CBF_SESSION.grantCapabilitiesToAll([
          CBF_SESSION.CAP_READ, CBF_SESSION.CAP_WRITE
        ]);
        CBF_RATE_LIMITER.reset(SIMPLE_AUTH_KEY);
        LOG.security('Setup succeeded via options');
        return { success: true };
      } catch (e) {
        try { await CBF_VAULT_FSM.failUnlock(); } catch (_) {}
        const errorCode = _mapSetupError(e);
        LOG.error('setupSimple failed:', e.message, '| code:', errorCode, '| stack:', e.stack);
        return { success: false, error: errorCode, message: e.message };
      }
    }

    // ─── unlockSimple ───
    if (msg.type === 'unlockSimple') {
      const rl = CBF_RATE_LIMITER.check(SIMPLE_AUTH_KEY, 'unlock');
      if (!rl.allowed) {
        return {
          success: false,
          error: rl.reason === 'COOLDOWN' ? 'COOLDOWN' : 'RATE_LIMITED'
        };
      }

      try {
        if (typeof msg.password !== 'string' || msg.password.length === 0) {
          return { success: false, error: 'PASSWORD_REQUIRED' };
        }
        if (CBF_VAULT_FSM.getState() === CBF_VAULT_FSM.State.UNLOCKED) {
          return { success: true, alreadyUnlocked: true };
        }
        if (CBF_VAULT_FSM.isBusy()) {
          return { success: false, error: 'BUSY' };
        }
        await CBF_VAULT_FSM.beginUnlock();
        await CBF_ES.unlock(msg.password);
        await CBF_VAULT_FSM.completeUnlock();
        CBF_SESSION.grantCapabilitiesToAll([
          CBF_SESSION.CAP_READ, CBF_SESSION.CAP_WRITE
        ]);
        CBF_RATE_LIMITER.reset(SIMPLE_AUTH_KEY);
        LOG.security('Unlock succeeded via options');
        return { success: true };
      } catch (e) {
        try { await CBF_VAULT_FSM.failUnlock(); } catch (_) {}
        const errorCode = _mapUnlockError(e);
        LOG.warn('unlockSimple failed:', e.message, '| code:', errorCode);
        return { success: false, error: errorCode, message: e.message };
      }
    }

    // ─── lockSimple ───
    if (msg.type === 'lockSimple') {
      try {
        await CBF_VAULT_FSM.lock();
        LOG.security('Lock via options');
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ─── changePasswordSimple ───
    if (msg.type === 'changePasswordSimple') {
      const rl = CBF_RATE_LIMITER.check(SIMPLE_AUTH_KEY, 'unlock');
      if (!rl.allowed) return { success: false, error: 'RATE_LIMITED' };

      try {
        if (typeof msg.oldPassword !== 'string' || msg.oldPassword.length === 0) {
          return { success: false, error: 'OLD_PASSWORD_REQUIRED' };
        }
        if (typeof msg.newPassword !== 'string' || msg.newPassword.length < 6) {
          return { success: false, error: 'PASSWORD_TOO_SHORT' };
        }
        const status = await CBF_ES.getStatus();
        if (!status.unlocked) {
          return { success: false, error: 'LOCKED' };
        }
        await CBF_ES.changePassword(msg.oldPassword, msg.newPassword);
        CBF_RATE_LIMITER.reset(SIMPLE_AUTH_KEY);
        LOG.security('Password changed via options');
        return { success: true };
      } catch (e) {
        const errorCode = _mapChangePwdError(e);
        LOG.error('changePasswordSimple failed:', e.message, '| code:', errorCode);
        return { success: false, error: errorCode, message: e.message };
      }
    }

    // ─── strictPrivacy ───
    if (msg.type === 'getStrictPrivacySimple') {
      return {
        success: true,
        strictPrivacy: CBF_PROJECTION.getStrictPrivacy()
      };
    }

    if (msg.type === 'setStrictPrivacySimple') {
      if (typeof msg.value !== 'boolean') {
        return { success: false, error: 'value must be boolean' };
      }
      CBF_PROJECTION.setStrictPrivacy(msg.value);
      LOG.security(`strictPrivacy set to ${msg.value}`);
      return { success: true, strictPrivacy: CBF_PROJECTION.getStrictPrivacy() };
    }

    // ─── rotateEpochsSimple ───
    if (msg.type === 'rotateEpochsSimple') {
      try {
        const results = await CBF_MESSAGING.rotateAllEpochsAndNotify();
        LOG.security(`Manual epoch rotation: ${results.length} session(s)`);
        return {
          success: true,
          rotated: results.length,
          epochs: results.map(r => ({ sessionId: r.sessionId, epoch: r.sessionEpoch }))
        };
      } catch (e) {
        LOG.error('rotateEpochsSimple failed:', e.message);
        return { success: false, error: e.message };
      }
    }

    // ─── importFaviconsSimple ───
    if (msg.type === 'importFaviconsSimple') {
      try {
        const items = msg.items || [];
        if (!Array.isArray(items)) {
          return { success: false, error: 'items must be array' };
        }
        let imported = 0;
        for (const item of items) {
          try {
            if (!item || !item.dataUrl) continue;
            if (!item.dataUrl.startsWith('data:image/')) continue;
            // 🔧 v12.2.0 FAV-02: 10KB → 50KB (consistency με favicon-service)
            if (item.dataUrl.length > 50 * 1024) continue;
            if (typeof item.url !== 'string') continue;
            if (!/^https?:\/\//i.test(item.url)) continue;

            const hostname = new URL(item.url).hostname.replace(/^www\./, '');
            const update = { [`favicon_${hostname}`]: item.dataUrl };
            if (item.color) update[`favicon_color_${hostname}`] = item.color;
            await browser.storage.local.set(update);
            imported++;
          } catch (_) {}
        }
        LOG.info(`Imported ${imported} favicons`);
        return { success: true, importedCount: imported };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ─── Homepage ───
    if (msg.type === 'setHomepage') {
      const url = (msg.url || '').trim();
      if (!url) return { success: false, error: 'URL required' };
      if (!/^https?:\/\//i.test(url)) return { success: false, error: 'Invalid URL' };
      await browser.storage.local.set({ userHomepage: url });
      LOG.info('Homepage saved');
      return { success: true };
    }

    if (msg.type === 'getHomepage') {
      const { userHomepage } = await browser.storage.local.get('userHomepage');
      return { success: true, userHomepage: userHomepage || '' };
    }

    if (msg.type === 'resetHomepage') {
      await browser.storage.local.remove('userHomepage');
      LOG.info('Homepage reset');
      return { success: true };
    }

    // ─── Options ───
    if (msg.type === 'openOptionsPage') {
      browser.runtime.openOptionsPage();
      return { success: true };
    }

    // ─── DEV: sequencer debug ───
    if (msg.type === 'getSequencerDebug') {
      return {
        success: true,
        commands: Array.from(CBF_SEQUENCER.COMMANDS),
        registered: Array.from(CBF_SEQUENCER._internal.handlers.keys()),
        ramCacheSize: CBF_SEQUENCER._internal.ramCache.size
      };
    }

    // ─── DEV: session debug ───
    if (msg.type === 'getSessionDebug') {
      return {
        success: true,
        epochCounter: CBF_SESSION.getGlobalEpochCounter(),
        sessions: CBF_SESSION.getAllSessions().map(s => ({
          id: s.id,
          epoch: s.sessionEpoch,
          tabId: s.tabId,
          capabilities: Array.from(s.capabilities)
        }))
      };
    }

    // ─── DEV: integrity debug ───
    if (msg.type === 'getIntegrityDebug') {
      try {
        if (!CBF_ES.isUnlocked()) {
          return { success: false, error: 'LOCKED' };
        }
        const stateOk = await CBF_ES.verifyStateMAC();
        const merkleOk = await CBF_ES.verifyMerkle();
        const meta = await CBF_ES._internal.readVaultMeta();
        return {
          success: true,
          stateMAC: stateOk,
          merkle: merkleOk,
          generation: meta ? meta.treeGeneration : null,
          recordCount: meta ? meta.recordCount : null,
          commitmentRoot: meta ? meta.commitmentRoot : null
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ─── DEV: favicon debug ───
    if (msg.type === 'getFaviconDebug') {
      try {
        if (typeof CBF_FAVICON !== 'undefined' &&
            typeof CBF_FAVICON.getStats === 'function') {
          return { success: true, stats: CBF_FAVICON.getStats() };
        }
        return { success: false, error: 'FAVICON_NOT_AVAILABLE' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ─── DEV: port queue debug (L-08) ───
    if (msg.type === 'getPortQueueDebug') {
      return {
        success: true,
        fsmReady: _fsmReady,
        pendingPorts: _pendingPorts.length
      };
    }

    // ─── DEV: rate limiter stats ───
    if (msg.type === 'getRateLimiterDebug') {
      try {
        if (typeof CBF_RATE_LIMITER.getStats === 'function') {
          return { success: true, stats: CBF_RATE_LIMITER.getStats() };
        }
        return { success: false, error: 'STATS_NOT_AVAILABLE' };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    // ─── DEV: V12E commands debug ───
    if (msg.type === 'getV12ECommandsDebug') {
      try {
        const handlers = CBF_MESSAGING._internal.HANDLERS;
        const v12eCommands = [
          'openInCurrentTab', 'openInNewTab', 'firefoxRename',
          'exportBookmarks', 'exportFavicons',
          'exportEncryptedBackup', 'exportEncryptedPlain',
          'importEncrypted', 'importFavicons'
        ];
        const info = v12eCommands.map(cmd => ({
          command: cmd,
          registered: !!handlers[cmd],
          cap: handlers[cmd]?.cap ?? null
        }));
        return {
          success: true,
          totalHandlers: Object.keys(handlers).length,
          v12eCommands: info
        };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }

    return undefined;
  });

  // ============================================================
  //  On Install
  // ============================================================
  browser.runtime.onInstalled.addListener((details) => {
    LOG.security(`onInstalled: reason=${details.reason}`);
    if (details.reason === 'install') {
      browser.runtime.openOptionsPage();
    }
  });

  // ============================================================
  //  Toolbar Action → Inject / Toggle Overlay (D-13.1, D-23.1)
  // ============================================================
  async function _isOverlayOpen(tabId) {
    try {
      const result = await browser.scripting.executeScript({
        target: { tabId },
        func: () => !!document.getElementById('cbf-overlay-host')
      });
      return result?.[0]?.result === true;
    } catch (e) {
      LOG.warn('_isOverlayOpen failed:', e.message);
      return false;
    }
  }

  // ============================================================
  //  M-07: injectOverlay με race re-check
  //
  //  Μεταξύ action.onClicked και scripting.executeScript, ο χρήστης
  //  μπορεί να αλλάξει tab. Χωρίς re-check, η ένεση γίνεται σε λάθος tab.
  // ============================================================
  async function injectOverlay(tabId) {
    try {
      // M-07: Re-fetch tab info (race re-check)
      let tab;
      try {
        tab = await browser.tabs.get(tabId);
      } catch (e) {
        LOG.warn(`M-07: tab ${tabId} no longer exists: ${e.message}`);
        return;
      }

      if (!tab.url) {
        LOG.warn(`M-07: tab ${tabId} has no URL`);
        return;
      }

      if (!/^https?:\/\//i.test(tab.url)) {
        LOG.warn(`M-07: tab ${tabId} URL changed to non-HTTP(S): ${tab.url}`);
        return;
      }

      LOG.info(`M-07: tab ${tabId} URL validated: ${tab.url.slice(0, 60)}...`);

      // Toggle check
      if (await _isOverlayOpen(tabId)) {
        LOG.info(`Overlay open — requesting close (tab=${tabId})`);
        await browser.tabs.sendMessage(tabId, { action: 'closeOverlay' });
        return;
      }

      // Inject
      LOG.info(`Injecting overlay into tab ${tabId}`);
      LOG.info(`Injecting ${INJECTED_SCRIPTS.length} files`);

      await browser.scripting.executeScript({
        target: { tabId },
        files: INJECTED_SCRIPTS
      });

      LOG.security(
        `Overlay injected (tab=${tabId}, ${INJECTED_SCRIPTS.length} files)`
      );
    } catch (e) {
      LOG.error('injectOverlay failed:', e.message);
      LOG.error('stack:', e.stack);
    }
  }

  browser.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id) return;

    LOG.info(`action.onClicked: tab=${tab.id}, url=${tab.url?.slice(0, 60) || 'n/a'}`);

    if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
      LOG.warn(`Cannot inject on non-HTTP(S) page: ${tab.url}`);
      return;
    }

    // M-07: Το injectOverlay θα κάνει re-check
    injectOverlay(tab.id);
  });

  // ============================================================
  //  Bootstrap
  // ============================================================
  (async function bootstrap() {
    LOG.security('Background bootstrap START');

    // Step 1: FSM initialize (BEFORE port flush)
    await CBF_VAULT_FSM.initialize();
    LOG.info(`FSM initialized: state=${CBF_VAULT_FSM.getState()}`);

    // L-08 REVISED: Set _fsmReady + flush pending ports
    _fsmReady = true;
    LOG.security('L-08: _fsmReady = true');
    _flushPendingPorts();

    // Step 2: Load projection strictPrivacy from storage
    try {
      if (typeof CBF_PROJECTION.loadFromStorage === 'function') {
        await CBF_PROJECTION.loadFromStorage();
        LOG.info('Projection strictPrivacy loaded from storage');
      }
    } catch (e) {
      LOG.warn('bootstrap: loadFromStorage failed:', e.message);
    }

    // Step 3: Install mutation handlers registry
    try {
      CBF_MUTATION_REGISTRY.install();
      LOG.info('MutationRegistry installed');
    } catch (e) {
      LOG.error('MutationRegistry install failed:', e.message);
    }

    // Step 4: Start passive favicon collection
    try {
      if (typeof CBF_FAVICON !== 'undefined' &&
          typeof CBF_FAVICON.startPassiveCollection === 'function') {
        CBF_FAVICON.startPassiveCollection();
        LOG.info('Passive favicon collection started');
      } else {
        LOG.warn('Passive favicon collection not available');
      }
    } catch (e) {
      LOG.warn('Passive favicon collection init failed:', e.message);
    }

    // Step 5: Report vault status
    const status = await CBF_ES.getStatus();
    LOG.info(`Vault status: initialized=${status.initialized}, unlocked=${status.unlocked}`);

    // Step 6: Verify V12E handlers registered
    try {
      const handlers = CBF_MESSAGING?._internal?.HANDLERS;
      if (handlers) {
        const v12eCommands = [
          'openInCurrentTab', 'openInNewTab', 'firefoxRename',
          'exportBookmarks', 'exportFavicons',
          'exportEncryptedBackup', 'exportEncryptedPlain',
          'importEncrypted', 'importFavicons'
        ];
        const missing = v12eCommands.filter(c => !handlers[c]);
        if (missing.length > 0) {
          LOG.error(`V12E: MISSING HANDLERS: ${missing.join(', ')}`);
        } else {
          LOG.security(
            `V12E: all ${v12eCommands.length} handlers registered ` +
            `(total: ${Object.keys(handlers).length})`
          );
        }
      }
    } catch (e) {
      LOG.warn('V12E handler verification failed:', e.message);
    }

    // ───────────────────────────────────────────────────────────
    //  🔧 v12.3.0 FIX-6: Rate limiter config coverage check
    //
    //  Αν κάποιος handler δεν έχει PER_COMMAND entry → bypass rate limit.
    //  Το rate-limiter.check() returns { allowed: true } για unknown commands.
    //
    //  Rationale: Catch configuration drift σε development.
    //  Zero runtime overhead (μία φορά στο bootstrap).
    // ───────────────────────────────────────────────────────────
    try {
      const handlers = CBF_MESSAGING?._internal?.HANDLERS;
      const rateConfig = CBF_RATE_LIMITER?.PER_COMMAND;

      if (handlers && rateConfig) {
        const missingRate = Object.keys(handlers).filter(
          cmd => !rateConfig[cmd]
        );

        if (missingRate.length > 0) {
          LOG.warn(
            `Rate limiter: MISSING config for ${missingRate.length} ` +
            `command(s) — these BYPASS rate limiting: ` +
            missingRate.join(', ')
          );
        } else {
          LOG.security(
            `Rate limiter: config verified ` +
            `(${Object.keys(handlers).length}/${Object.keys(handlers).length} handlers covered)`
          );
        }
      } else {
        LOG.warn(
          'Rate limiter: config verification skipped ' +
          '(HANDLERS or PER_COMMAND not available)'
        );
      }
    } catch (e) {
      LOG.warn('Rate limiter config verification failed:', e.message);
    }

    LOG.security('Background bootstrap COMPLETE — ready');
  })().catch(e => {
    LOG.error('Bootstrap FAILED:', e.message);
    LOG.error('stack:', e.stack);
  });

  // ============================================================
  //  Top-level ready log
  // ============================================================
   LOG.security(
    'Background ready (v12.3.0: L-08 REV + M-03 + M-07 + M-08 + H-02 + ' +
    'SAFE-01 low-memory + passive favicons + periodic integrity + ' +
    'rate limiter config verification + V12E main-menu + V12E context-menu — ' +
    '24 injected scripts)'
  );

})();