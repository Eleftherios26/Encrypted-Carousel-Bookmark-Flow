/**
 * rate-limiter.js — Rate limiter (38 commands)
 *
 * @path     background/services/rate-limiter.js
 * @version  12.3.0
 * @since    v12E / v12.3E
 *
 * PURPOSE
 *   Δύο επίπεδα rate limiting:
 *     1. Per-session global (150 / 1000ms sliding window)
 *     2. Per-command (token bucket ή sliding window + cooldown)
 *
 *   Slide window για auth/reads, token bucket για high-throughput
 *   commands. Cooldown για commands που χρειάζονται punishment.
 *
 * ARCHITECTURE
 *   • Sliding window: timestamps array, cutoff στο window
 *   • Token bucket: capacity + refillRatePerMs
 *   • Cooldown: blocked Map με expiry (καθαρίζεται από cleanup())
 *   • Clock injection: _setClock(fn) για testability
 *
 * COMMANDS (38)
 *   Auth (3):       unlock, setup, lock
 *   Read (5):       queryTree, getPath, getStatus, getActiveSpace, setActiveSpace
 *   External (2):   open, getFavicon
 *   Search (1):     searchBookmarks
 *   Encrypted (7):  create, rename, delete, move, reorder, merge, mergeFolders
 *   Cross-space (4): moveToEncrypted, moveToFirefox,
 *                    moveFolderToEncrypted, moveFolderToFirefox
 *   Firefox (7):    firefoxMove, firefoxReorder, firefoxMerge,
 *                   firefoxMergeFolders, firefoxRemove, firefoxCreate,
 *                   firefoxRename
 *   Open (2):       openInCurrentTab, openInNewTab
 *   Export (4):     exportBookmarks, exportFavicons,
 *                   exportEncryptedBackup, exportEncryptedPlain
 *   Import (2):     importEncrypted, importFavicons
 *   Options (1):    openOptionsPage   ← v12.3.0 (FIX-6b)
 *
 * DECISIONS
 *   D-30, D-51, D-52, D-53, D-56
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — OPENOPTIONSPAGE CONFIG (FIX-6b)
 *   ══════════════════════════════════════════════════════════════════════
 *   FIX-6b (CRITICAL): Rate limiter coverage για openOptionsPage
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Το FIX-6 verification (background.js v12.3.0) εντόπισε ότι
 *       ο handler 'openOptionsPage' (στο messaging.js HANDLERS — 36
 *       handlers) ΔΕΝ είχε entry στο PER_COMMAND.
 *
 *       Log:
 *         ⚠️ Rate limiter: MISSING config for 1 command(s) —
 *             these BYPASS rate limiting: openOptionsPage
 *
 *       Συνέπεια: Ο handler λειτουργούσε ΧΩΡΙΣ rate limiting
 *       (silent bypass), σπάζοντας τον invariant "κάθε handler
 *       έχει rate limit".
 *
 *     ΛΥΣΗ:
 *       Προσθήκη entry:
 *         openOptionsPage: { max: 10, window: 60000, algorithm: 'window' }
 *
 *       10/min επαρκεί για UI actions (options page opens) και
 *       προστατεύει από abuse (π.χ. script που ανοίγει το options
 *       page σε loop).
 *
 *     Impact:
 *       • Total commands: 37 → 38
 *       • FIX-6 verification → "config verified (36/36 handlers covered)"
 *       • Consistency με τον invariant "1 handler = 1 rate limit entry"
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.0.0 → 12.3.0
 *     • @since v12E → v12E / v12.3E
 *     • Init log string: v12E (38 commands)
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "rate-limiter"
 */

var CBF_RATE_LIMITER = (function() {
  'use strict';

  // ============================================================
  //  Clock — testable
  // ============================================================
  let _clockFn = () => Date.now();
  function _now() { return _clockFn(); }

  function _setClock(fn) {
    _clockFn = (typeof fn === 'function') ? fn : () => Date.now();
  }

  // ============================================================
  //  Per-command configuration
  // ============================================================
  const PER_COMMAND = Object.freeze({
    // ---------- Authentication (3) ----------
    unlock:        { max: 5,   window: 60000, cooldown: 300000, algorithm: 'window' },
    setup:         { max: 3,   window: 60000, cooldown: 300000, algorithm: 'window' },
    lock:          { max: 10,  window: 60000, algorithm: 'window' },

    // ---------- Read (5) ----------
    queryTree:     { max: 100, window: 1000, burst: 20, algorithm: 'bucket' },
    getPath:       { max: 200, window: 1000, burst: 40, algorithm: 'bucket' },
    getStatus:     { max: 300, window: 1000, burst: 60, algorithm: 'bucket' },
    getActiveSpace:{ max: 300, window: 1000, burst: 60, algorithm: 'bucket' },
    setActiveSpace:{ max: 30,  window: 1000, algorithm: 'window' },

    // ---------- External (2) ----------
    open:          { max: 10,  window: 1000, algorithm: 'window' },

    // FAVICON BURST FIX: burst 30 (αρχικά 5) — UI καλεί ΟΛΕΣ τις κάρτες
    getFavicon:    { max: 60,  window: 1000, burst: 30, algorithm: 'bucket' },

    // Global search: 50/sec (burst 15)
    searchBookmarks: { max: 50, window: 1000, burst: 15, algorithm: 'bucket' },

    // ---------- Encrypted mutations (7) ----------
    create:        { max: 50,  window: 1000, burst: 10, algorithm: 'bucket' },
    rename:        { max: 50,  window: 1000, burst: 10, algorithm: 'bucket' },
    delete:        { max: 20,  window: 1000, algorithm: 'window' },
    move:          { max: 20,  window: 1000, algorithm: 'window' },
    reorder:       { max: 20,  window: 1000, algorithm: 'window' },
    merge:         { max: 20,  window: 1000, algorithm: 'window' },
    mergeFolders:  { max: 10,  window: 1000, algorithm: 'window' },

    // ---------- Cross-space (4) ----------
    moveToEncrypted:       { max: 10, window: 1000, algorithm: 'window' },
    moveToFirefox:         { max: 10, window: 1000, algorithm: 'window' },
    moveFolderToEncrypted: { max: 5,  window: 1000, algorithm: 'window' },
    moveFolderToFirefox:   { max: 5,  window: 1000, algorithm: 'window' },

    // ---------- Firefox D&D (7) ----------
    firefoxMove:           { max: 30, window: 1000, algorithm: 'window' },
    firefoxReorder:        { max: 30, window: 1000, algorithm: 'window' },
    firefoxMerge:          { max: 15, window: 1000, algorithm: 'window' },
    firefoxMergeFolders:   { max: 10, window: 1000, algorithm: 'window' },

    // H-5: firefoxRemove — tightened (πριν: 20/sec, μετά: 10/min + 60s cd)
    firefoxRemove:         { max: 10, window: 60000, cooldown: 60000, algorithm: 'window' },

    // firefoxCreate: 30/sec
    firefoxCreate:         { max: 30, window: 1000, algorithm: 'window' },

    // firefoxRename: 30/sec (V12E D-53)
    firefoxRename:         { max: 30, window: 1000, algorithm: 'window' },

    // ---------- V12E (D-52): Open (2) ----------
    openInCurrentTab:      { max: 10, window: 1000, algorithm: 'window' },
    openInNewTab:          { max: 30, window: 1000, algorithm: 'window' },

    // ---------- V12E (D-51): Exports (4) ----------
    exportBookmarks:       { max: 3, window: 60000, algorithm: 'window' },
    exportFavicons:        { max: 3, window: 60000, algorithm: 'window' },
    exportEncryptedBackup: { max: 3, window: 60000, algorithm: 'window' },
    exportEncryptedPlain:  { max: 3, window: 60000, algorithm: 'window' },

    // ---------- V12E (D-56): importEncrypted (1) — POLU ΑΥΣΤΗΡΟ ----------
    // 1/min + 60s cooldown (sequencer transaction, stateMAC + Merkle)
    importEncrypted:       { max: 1, window: 60000, cooldown: 60000, algorithm: 'window' },

    // ---------- V12E (D-51): importFavicons (1) ----------
    importFavicons:        { max: 3, window: 60000, algorithm: 'window' },

    // ---------- 🔧 v12.3.0 FIX-6b: Options page (1) ----------
    //  Native handler (messaging.js). Το FIX-6 verification (background.js)
    //  εντόπισε ότι έλειπε από το PER_COMMAND → bypass rate limiting.
    //  Τιμή: 10/min — αρκετά για UI actions, προστατεύει από abuse.
    openOptionsPage:       { max: 10, window: 60000, algorithm: 'window' }
  });

  // ============================================================
  //  Per-session global
  // ============================================================
  const SESSION_GLOBAL = Object.freeze({
    max: 150,
    window: 1000
  });

  // ============================================================
  //  State
  // ============================================================
  const commandState = new Map();
  const sessionGlobal = new Map();
  const blocked = new Map();

  function _key(sessionId, command) {
    return `${sessionId}:${command}`;
  }

  // ============================================================
  //  Sliding window
  // ============================================================
  function _slidingWindowConsume(state, max, windowMs, now) {
    const cutoff = now - windowMs;
    state.timestamps = state.timestamps.filter(t => t > cutoff);

    if (state.timestamps.length >= max) return false;
    state.timestamps.push(now);
    return true;
  }

  // ============================================================
  //  Token bucket
  // ============================================================
  function _tokenBucketConsume(state, capacity, refillRatePerMs, now) {
    const elapsed = now - state.lastRefill;
    state.tokens = Math.min(
      capacity,
      state.tokens + elapsed * refillRatePerMs
    );
    state.lastRefill = now;

    if (state.tokens >= 1) {
      state.tokens -= 1;
      return true;
    }
    return false;
  }

  // ============================================================
  //  Main check
  // ============================================================
  function check(sessionId, command) {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { allowed: false, reason: 'NO_SESSION' };
    }
    if (typeof command !== 'string' || !command) {
      return { allowed: false, reason: 'NO_COMMAND' };
    }

    const now = _now();

    // ---------- 1. Cooldown check ----------
    const k = _key(sessionId, command);
    const until = blocked.get(k);
    if (until) {
      if (now < until) {
        return {
          allowed: false,
          reason: 'COOLDOWN',
          retryAfterMs: until - now
        };
      }
      blocked.delete(k);
    }

    // ---------- 2. Per-session global ----------
    let sg = sessionGlobal.get(sessionId);
    if (!sg) {
      sg = { timestamps: [] };
      sessionGlobal.set(sessionId, sg);
    }
    if (!_slidingWindowConsume(sg, SESSION_GLOBAL.max, SESSION_GLOBAL.window, now)) {
      return { allowed: false, reason: 'SESSION_LIMIT' };
    }

    // ---------- 3. Per-command ----------
    const cfg = PER_COMMAND[command];
    if (!cfg) {
      // 🔧 v12.3.0: ΠΡΟΣΟΧΗ — bypass με warning (FIX-6 verification
      //             στο bootstrap εντοπίζει configuration drift).
      //  Ο σκοπός αυτού του fallback είναι να ΜΗΝ σπάσει το extension
      //  αν προστεθεί νέος handler χωρίς rate limit config. Αλλά το
      //  background.js FIX-6 verification θα το εμφανίσει ως warning.
      return { allowed: true };
    }

    const stateKey = _key(sessionId, command);
    let state = commandState.get(stateKey);

    if (cfg.algorithm === 'bucket') {
      if (!state) {
        state = {
          tokens: cfg.burst ?? cfg.max,
          lastRefill: now
        };
        commandState.set(stateKey, state);
      }
      const capacity = cfg.burst ?? cfg.max;
      const refillRate = cfg.max / cfg.window;
      if (!_tokenBucketConsume(state, capacity, refillRate, now)) {
        return { allowed: false, reason: 'COMMAND_LIMIT' };
      }
    } else {
      if (!state) {
        state = { timestamps: [] };
        commandState.set(stateKey, state);
      }
      if (!_slidingWindowConsume(state, cfg.max, cfg.window, now)) {
        if (cfg.cooldown) {
          blocked.set(stateKey, now + cfg.cooldown);
        }
        return {
          allowed: false,
          reason: 'COMMAND_LIMIT',
          retryAfterMs: cfg.cooldown || 0
        };
      }
    }

    return { allowed: true };
  }

  // ============================================================
  //  Reset / cleanup
  // ============================================================
  function reset(sessionId, command) {
    if (sessionId && command) {
      const k = _key(sessionId, command);
      commandState.delete(k);
      blocked.delete(k);
      return;
    }
    if (sessionId) {
      for (const k of commandState.keys()) {
        if (k.startsWith(sessionId + ':')) commandState.delete(k);
      }
      for (const k of blocked.keys()) {
        if (k.startsWith(sessionId + ':')) blocked.delete(k);
      }
      sessionGlobal.delete(sessionId);
      return;
    }
    commandState.clear();
    sessionGlobal.clear();
    blocked.clear();
  }

  function cleanup() {
    const now = _now();
    for (const [k, until] of blocked.entries()) {
      if (now >= until) blocked.delete(k);
    }
  }

  // ============================================================
  //  Diagnostics (V12E)
  // ============================================================
  function getStats() {
    return {
      sessionCount: sessionGlobal.size,
      commandStateCount: commandState.size,
      blockedCount: blocked.size,
      commandCount: Object.keys(PER_COMMAND).length
    };
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    check,
    reset,
    cleanup,

    PER_COMMAND,
    SESSION_GLOBAL,

    getStats,

    _internal: {
      _key,
      _slidingWindowConsume,
      _tokenBucketConsume,
      commandState,
      sessionGlobal,
      blocked,
      _setClock,
      _now
    }
  };

  if (typeof self !== 'undefined') self.CBF_RATE_LIMITER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_RATE_LIMITER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
     CBF_LOGGER.info(
      'Rate Limiter ready (v12.3.0: 38 commands — ' +
      'H-5 firefoxRemove cooldown, getFavicon burst 30, firefoxCreate, ' +
      'searchBookmarks 50/s burst 15, openInCurrentTab/openInNewTab, ' +
      'firefoxRename, exports 3/min, importEncrypted 1/min+cooldown, ' +
      'importFavicons 3/min, openOptionsPage 10/min — FIX-6b)'
    );
  }

  return api;
})();