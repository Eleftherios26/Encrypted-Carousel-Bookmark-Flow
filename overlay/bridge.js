/**
 * bridge.js — Overlay ↔ Background communication (HMAC-signed port)
 *
 * @path     overlay/bridge.js
 * @version  12.2.0
 * @since    v12E / v12.2
 *
 * PURPOSE
 *   Client-side port wrapper που επικοινωνεί με το background μέσω
 *   HMAC-signed messages. Εκθέτει typed wrappers για όλα τα commands
 *   (read, mutations, D&D, cross-space, V12E features).
 *
 * KEY CONCEPTS
 *   • HMAC-SHA256 signing σε κάθε outgoing message
 *   • Monotonic requestSeq (C3-01: ΔΕΝ reset-άρεται σε hardReset)
 *   • cachedGeneration — S-11 monotonicity (reject downgrades)
 *   • Send serialize queue (C2 fix — αποφυγή interleaved sends)
 *   • Auto-reconnect (D-31) με lazy init
 *   • Timeouts per command (10s–180s ανάλογα το βάρος)
 *
 * NON-OBVIOUS
 *   • loadFreshModule-like pattern: το module φορτώνεται ως IIFE και
 *     εκθέτει μόνο το api. ΔΕΝ υπάρχει named export.
 *   • Το localSeq (client) ΠΡΕΠΕΙ να μένει monotonic — reset γίνεται
 *     ΜΟΝΟ σε port.onDisconnect ή shutdown().
 *   • Το send() είναι serialized — 2 concurrent sends δεν interleave.
 *   • _forceSetGeneration() είναι το μόνο escape hatch από το S-11.
 *
 * DECISIONS
 *   D-25, D-28, D-29, D-31, D-38, D-48, D-51, D-52, D-53, D-56
 *
 * CHANGELOG v12.2.0 (2026-09-26) — LOW-END HARDWARE OPTIMIZATION
 *   ═══════════════════════════════════════════════════════════════════
 *   Latency optimizations (Tier 1 — zero regression risk):
 *     • LAT-01: getStatus() short-lived cache (500ms TTL)
 *         - Απορροφά duplicate calls στο bootstrap και σε feature flows
 *         - Σε low-end: μειώνει 2-3 περιττά round-trips στο init
 *         - Invalidation: shutdown(), hardReset(), port.onDisconnect,
 *           unlock/setup/lock success/failure
 *         - Force fresh: CBF_BRIDGE.getStatus({ force: true })
 *     • LAT-02: Cache diagnostics στο getDiagnostics()
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "bridge"
 */

var CBF_BRIDGE = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const PORT_NAME = 'ecbf';
  const DEFAULT_TIMEOUT_MS = 15000;
  const RECONNECT_TIMEOUT_MS = 8000;

  // ⭐ v12.2 LAT-01: getStatus cache TTL
  const _STATUS_CACHE_MS = 500;

  // ═══════════════════════════════════════════════════════════
  //  TIMEOUTS — per-command timeout (ms)
  //
  //  Βαρύτερα commands (exports/imports) έχουν μεγαλύτερο timeout.
  //  Τα exports/imports περνάνε από sequencer + stateMAC + Merkle,
  //  οπότε χρειάζονται 60s–180s. Τα read commands 10s–15s.
  // ═══════════════════════════════════════════════════════════
  const TIMEOUTS = {
    getFavicon: 10000,
    open:       10000,
    unlock:     60000,
    setup:      60000,
    changePassword: 90000,

    searchBookmarks: 10000,

    // D&D encrypted
    move:           20000,
    reorder:        20000,
    merge:          20000,
    mergeFolders:   20000,

    // D&D firefox
    firefoxMove:         20000,
    firefoxReorder:      20000,
    firefoxMerge:        20000,
    firefoxMergeFolders: 20000,
    firefoxRemove:       20000,
    firefoxCreate:       20000,

    // Cross-space
    moveToEncrypted:       30000,
    moveToFirefox:         30000,
    moveFolderToEncrypted: 60000,
    moveFolderToFirefox:   60000,

    // V12E
    openInCurrentTab:     15000,
    openInNewTab:         15000,
    firefoxRename:        15000,
    exportBookmarks:      60000,
    exportFavicons:       60000,
    exportEncryptedBackup:120000,
    exportEncryptedPlain: 120000,
    importEncrypted:      180000,
    importFavicons:       60000,

    _default:   DEFAULT_TIMEOUT_MS
  };

  function _getTimeout(type) {
    return TIMEOUTS[type] || TIMEOUTS._default;
  }

  // ============================================================
  //  Logging
  // ============================================================
  function log(...args)  { console.log('[ECBF:Bridge]', ...args); }
  function warn(...args) { console.warn('[ECBF:Bridge]', ...args); }
  function err(...args)  { console.error('[ECBF:Bridge]', ...args); }

  function _fmtSeq(seq) {
    return `#${String(seq).padStart(4, '0')}`;
  }

  // ============================================================
  //  State
  // ============================================================
  let port = null;
  let sessionId = null;
  let sessionToken = null;
  let sessionEpoch = null;

  const pending = new Map();
  const eventListeners = new Map();

  let initResolve = null;
  let initReject = null;
  let initPromise = null;
  let initCompleted = false;

  // ═══════════════════════════════════════════════════════════
  //  C3-01: localSeq = monotonic counter
  //
  //  ⚠️ INVARIANT: localSeq > server.lastSequence για κάθε send.
  //
  //  Safe reset σημεία:
  //    1. port.onDisconnect (νέο port → νέο server state)
  //    2. shutdown() (πλήρης teardown)
  //
  //  ⚠️ ΜΗΝ reset-άρεις σε:
  //    - hardReset()  (C3-01 fix — δεν γίνεται disconnect)
  //    - _reloadCurrentFolder()
  //    - retry logic
  // ═══════════════════════════════════════════════════════════
  let localSeq = 0;
  let reconnectInProgress = false;
  let cachedGeneration = 0;

  // ═══ C2 fix: Send serialize queue ═══
  let _sendQueue = Promise.resolve();

  // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2 LAT-01: getStatus cache (500ms TTL)
  //
  //  Rationale:
  //    Το bootstrap του overlay καλεί getStatus 2-3 φορές σε
  //    <100ms (refreshLockIcon + currentStatus + spaceRes flow).
  //    Σε low-end CPU, κάθε round-trip κοστίζει 30-80ms.
  //
  //  Safety:
  //    • Invalidate σε unlock/setup/lock (state change)
  //    • Invalidate σε shutdown / hardReset / port.onDisconnect
  //    • Force fresh: getStatus({ force: true })
  // ═══════════════════════════════════════════════════════════
  let _statusCache = { value: null, at: 0 };

  function _invalidateStatusCache() {
    _statusCache = { value: null, at: 0 };
  }

  // ============================================================
  //  S-11: Generation cache — monotonicity
  //
  //  Multi-tab late broadcasts μπορούν να στείλουν ΠΑΛΙΟ generation.
  //  Το cache κρατάει το max, απορρίπτοντας downgrades.
  // ============================================================
  function _updateCachedGeneration(gen) {
    if (typeof gen !== 'number' || !Number.isInteger(gen) || gen < 0) {
      return false;
    }

    // S-11: Reject downgrade
    if (gen < cachedGeneration) {
      warn(
        `[gen] downgrade REJECTED: ${cachedGeneration} → ${gen} ` +
        `(stale broadcast?)`
      );
      return false;
    }

    if (gen !== cachedGeneration) {
      log(`[gen] updated: ${cachedGeneration} → ${gen}`);
      cachedGeneration = gen;
      return true;
    }

    return false;
  }

  // Force-set (bypass S-11) — μόνο για space switch / firefox D&D
  function _forceSetGeneration(gen) {
    if (typeof gen === 'number' && Number.isInteger(gen) && gen >= 0) {
      log(`[gen] force-set: ${cachedGeneration} → ${gen}`);
      cachedGeneration = gen;
    }
  }

  function getGeneration() {
    return cachedGeneration;
  }

  // ============================================================
  //  Helpers
  // ============================================================
  function generateCommandId() {
    return crypto.randomUUID();
  }

  // ============================================================
  //  Connect (initAck handshake)
  // ============================================================
  function connect() {
    if (initCompleted && port) {
      log('[connect] already connected — session:', sessionId);
      return Promise.resolve({ sessionId, sessionEpoch });
    }
    if (initPromise) {
      log('[connect] handshake already in progress — waiting');
      return initPromise;
    }

    log('[connect] opening port:', PORT_NAME);

    initPromise = new Promise((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
    });

    try {
      port = browser.runtime.connect({ name: PORT_NAME });
      log('[connect] port opened');
    } catch (e) {
      err('[connect] port connect FAILED:', e.message);
      initPromise = null;
      initResolve = null;
      initReject = null;
      return Promise.reject(e);
    }

    port.onMessage.addListener(handleMessage);

    port.onDisconnect.addListener(() => {
      log('[connect] port DISCONNECTED');
      port = null;
      sessionId = null;
      sessionToken = null;
      sessionEpoch = null;
      initCompleted = false;
      initPromise = null;
      initResolve = null;
      initReject = null;

      // C3-01: SAFE reset σημείο #1 — ο server δεν έχει πια portState
      localSeq = 0;

      // ⭐ v12.2 LAT-01: invalidate status cache (no port = no valid cache)
      _invalidateStatusCache();

      const pendingCount = pending.size;
      for (const [cid, entry] of pending.entries()) {
        clearTimeout(entry.timer);
        try { entry.reject(new Error('BRIDGE_DISCONNECTED')); } catch (_) {}
      }
      pending.clear();
      if (pendingCount > 0) {
        warn(`[connect] rejected ${pendingCount} pending command(s)`);
      }

      _emit('bridgeDisconnected');
    });

    setTimeout(() => {
      if (!initCompleted && initReject) {
        warn('[connect] initAck TIMEOUT');
        initReject(new Error('initAck timeout'));
      }
    }, RECONNECT_TIMEOUT_MS);

    return initPromise;
  }

  async function start() {
    return connect();
  }

  // ============================================================
  //  ensureConnected — Lazy reconnect (D-31)
  // ============================================================
  async function ensureConnected() {
    if (port && initCompleted && sessionToken) return;

    if (initPromise) {
      log('[reconnect] waiting for pending connect...');
      try {
        await initPromise;
        return;
      } catch (e) {
        warn('[reconnect] pending connect failed:', e.message);
      }
    }

    if (reconnectInProgress) {
      log('[reconnect] already reconnecting — waiting...');
      while (reconnectInProgress) {
        await new Promise(r => setTimeout(r, 50));
      }
      if (port && initCompleted && sessionToken) return;
    }

    reconnectInProgress = true;
    log('[reconnect] port dead — reconnecting...');
    try {
      await connect();
      log('[reconnect] SUCCESS — session:', sessionId);
      _emit('bridgeReconnected');
    } catch (e) {
      err('[reconnect] FAILED:', e.message);
      throw new Error('BRIDGE_RECONNECT_FAILED: ' + e.message);
    } finally {
      reconnectInProgress = false;
    }
  }

  // ============================================================
  //  send — serialized via _sendQueue (C2 fix)
  //
  //  V12E: Εκτίθεται public — χρησιμοποιείται από main-menu /
  //  context-menu features για ad-hoc commands.
  // ============================================================
  function send(type, payload = {}, expectedGeneration) {
    const cmdIdShort = 'send-' + Math.random().toString(36).slice(2, 8);
    log(`[queue] ${cmdIdShort} enqueue: type=${type}`);

    const result = _sendQueue.then(() => _doSend(type, payload, expectedGeneration));
    _sendQueue = result.catch(() => {});
    return result;
  }

  async function _doSend(type, payload = {}, expectedGeneration) {
    await ensureConnected();

    if (!port) throw new Error('BRIDGE_NOT_CONNECTED');
    if (!sessionToken) throw new Error('BRIDGE_NO_SESSION_TOKEN');

    const commandId = generateCommandId();

    // C3-01: Monotonic increment — ΠΟΤΕ reset εδώ
    const requestSeq = ++localSeq;

    log(`[send] ${_fmtSeq(requestSeq)} type=${type} cmd=${commandId.slice(0, 8)}`);

    const msg = {
      type,
      commandId,
      requestSeq,
      payload,
      sessionEpoch
    };

    if (typeof expectedGeneration === 'number') {
      msg.expectedGeneration = expectedGeneration;
      log(`[send] ${_fmtSeq(requestSeq)} expectedGen=${expectedGeneration}`);
    }

    // ---------- HMAC signing ----------
    const keyBytes = CBF_CRYPTO.b64ToBuf(sessionToken);
    let sig = null;
    let hmac = null;
    try {
      const canonical = CBF_CRYPTO.canonicalJSON(msg);
      sig = await CBF_CRYPTO.hmacSign(keyBytes, canonical);
      hmac = CBF_CRYPTO.bufToB64(sig);
    } catch (e) {
      err(`[send] ${_fmtSeq(requestSeq)} HMAC sign FAILED:`, e.message);
      CBF_CRYPTO.zeroBuffer(keyBytes);
      if (sig) CBF_CRYPTO.zeroBuffer(sig);
      throw e;
    } finally {
      CBF_CRYPTO.zeroBuffer(keyBytes);
      if (sig) CBF_CRYPTO.zeroBuffer(sig);
    }

    // ---------- postMessage με timeout ----------
    return new Promise((resolve, reject) => {
      const timeoutMs = _getTimeout(type);
      const timer = setTimeout(() => {
        pending.delete(commandId);
        err(`[send] ${_fmtSeq(requestSeq)} TIMEOUT (${timeoutMs}ms): ${type}`);
        reject(new Error(`Timeout: ${type} (${timeoutMs}ms)`));
      }, timeoutMs);

      pending.set(commandId, { resolve, reject, timer, type, requestSeq });

      try {
        port.postMessage({ ...msg, hmac });
        log(`[send] ${_fmtSeq(requestSeq)} → posted (timeout=${timeoutMs}ms)`);
      } catch (e) {
        clearTimeout(timer);
        pending.delete(commandId);
        err(`[send] ${_fmtSeq(requestSeq)} postMessage FAILED:`, e.message);
        reject(e);
      }
    });
  }

  // ============================================================
  //  Handle incoming messages
  // ============================================================
  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    const { hmac, ...rest } = msg;

    // ═══ EPOCH ROTATED — raw (πριν από το session token check) ═══
    if (rest.type === 'epochRotated') {
      if (typeof rest.sessionEpoch === 'number' &&
          typeof rest.sessionToken === 'string') {
        const oldEpoch = sessionEpoch;
        sessionEpoch = rest.sessionEpoch;
        sessionToken = rest.sessionToken;
        log(`[epoch] ROTATED: ${oldEpoch} → ${sessionEpoch}`);
        // C3-01: Το epoch rotation ΔΕΝ αλλάζει το server lastSequence
      } else {
        warn('[epoch] epochRotated with INVALID payload');
      }
      return;
    }

    // ═══ initAck — trusted (χωρίς HMAC verify — πριν το token) ═══
    if (rest.type === 'initAck') {
      const token = rest.sessionToken;
      if (!token || typeof token !== 'string') {
        err('[initAck] missing/invalid token');
        if (initReject) initReject(new Error('initAck missing token'));
        return;
      }

      sessionId = rest.sessionId;
      sessionEpoch = rest.sessionEpoch;
      sessionToken = token;
      initCompleted = true;

      // C3-03: H-03 initAck.globalVersion — 3-way handling
      if (typeof rest.globalVersion === 'number' && Number.isInteger(rest.globalVersion) && rest.globalVersion >= 0) {
        if (rest.globalVersion > 0) {
          log(`[initAck] syncing generation from server: ${rest.globalVersion}`);
        } else {
          log('[initAck] globalVersion=0 (fresh vault)');
        }
        _updateCachedGeneration(rest.globalVersion);
      } else {
        warn('[initAck] globalVersion missing — H-03 not implemented server-side');
      }

      log(`[initAck] session=${sessionId} epoch=${sessionEpoch} gen=${cachedGeneration}`);

      if (initResolve) initResolve({ sessionId, sessionEpoch });
      return;
    }

    if (!sessionToken) {
      warn('[msg] received BEFORE session token — ignored:', rest.type);
      return;
    }

    if (!hmac) {
      warn('[msg] missing HMAC field — ignored:', rest.type);
      return;
    }

    // ═══ Pending command resolution ═══
    if (rest.commandId && pending.has(rest.commandId)) {
      const { resolve, reject, timer, requestSeq } = pending.get(rest.commandId);
      pending.delete(rest.commandId);
      clearTimeout(timer);

      const seqTag = requestSeq ? _fmtSeq(requestSeq) : `cmd=${rest.commandId.slice(0, 8)}`;

      if (rest.type === 'commandError') {
        warn(`[recv] ${seqTag} ERROR: ${rest.code} — ${rest.message}`);
        const error = new Error(rest.message || 'Command error');
        error.code = rest.code || 'UNKNOWN';
        reject(error);
        return;
      }
      if (rest.success === false) {
        warn(`[recv] ${seqTag} FAILED: ${rest.error}`);
        const error = new Error(rest.error || 'Unknown error');
        error.code = rest.error;
        reject(error);
        return;
      }

      // S-11: Update cached generation from ANY response
      if (typeof rest.generation === 'number' && rest.generation > 0) {
        _updateCachedGeneration(rest.generation);
      }

      log(`[recv] ${seqTag} OK (gen=${rest.generation ?? 'n/a'})`);
      resolve(rest);
      return;
    }

    // ═══ Async events (mutationEvent broadcast) ═══
    if (typeof rest.generation === 'number' && rest.generation > 0) {
      _updateCachedGeneration(rest.generation);
    }

    const listeners = eventListeners.get(rest.type);
    if (listeners && listeners.length > 0) {
      log(`[event] ${rest.type} → ${listeners.length} listener(s)`);
      for (const fn of listeners) {
        try { fn(rest); } catch (e) {
          err(`[event] listener error for ${rest.type}:`, e.message);
        }
      }
    } else {
      log(`[event] ${rest.type} (no listeners)`);
    }
  }

  // ============================================================
  //  Event system
  // ============================================================
  function on(type, fn) {
    if (!eventListeners.has(type)) eventListeners.set(type, []);
    eventListeners.get(type).push(fn);
    log(`[on] +1 listener for "${type}" (total ${eventListeners.get(type).length})`);
  }

  function off(type, fn) {
    const list = eventListeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) {
      list.splice(idx, 1);
      log(`[off] -1 listener for "${type}" (remaining ${list.length})`);
    }
  }

  function _emit(eventType, payload) {
    const listeners = eventListeners.get(eventType);
    if (!listeners || listeners.length === 0) return;
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch (e) {
        err(`[event] ${eventType} listener error:`, e.message);
      }
    }
  }

  // ============================================================
  //  C3-01: hardReset — clear pending, ΧΩΡΙΣ reset localSeq
  //
  //  ΠΡΙΝ (buggy): localSeq = 0 → REPLAY loop στο server
  //  ΜΕΤΑ: localSeq preserved → επόμενο send N+1 > server.lastSequence
  // ============================================================
  function hardReset() {
    const pendingCount = pending.size;

    warn(`[hardReset] clearing ${pendingCount} pending command(s) (localSeq NOT reset — C3-01)`);

    // Reject όλα τα pending promises
    for (const [cid, entry] of pending.entries()) {
      if (entry.timer) {
        try { clearTimeout(entry.timer); } catch (_) {}
      }
      try {
        entry.reject(new Error('BRIDGE_HARD_RESET'));
      } catch (_) {}
    }
    pending.clear();

    // C3-01: ΔΕΝ μηδενίζουμε το localSeq

    // ⭐ v12.2 LAT-01: invalidate status cache (state may have drifted)
    _invalidateStatusCache();

    reconnectInProgress = false;

    log(
      `[hardReset] complete (pending=${pendingCount} rejected, ` +
      `localSeq=${localSeq} preserved, port=${port ? 'connected' : 'null'})`
    );

    return pendingCount;
  }

  // ============================================================
  //  C3-02: Diagnostics
  // ============================================================
  function _getLocalSeq() {
    return localSeq;
  }

  function getDiagnostics() {
    return {
      localSeq,
      pendingCount: pending.size,
      portConnected: port !== null,
      initCompleted,
      sessionId: sessionId ? sessionId.slice(0, 8) : null,
      sessionEpoch,
      cachedGeneration,
      reconnectInProgress,
      // ⭐ v12.2 LAT-02: status cache diagnostics
      statusCacheAgeMs: _statusCache.value ? (Date.now() - _statusCache.at) : null,
      statusCacheValid: _statusCache.value !== null &&
                        (Date.now() - _statusCache.at) < _STATUS_CACHE_MS
    };
  }

  // ============================================================
  //  Shutdown — πλήρης teardown (SAFE reset #2)
  // ============================================================
  function shutdown() {
    log('[shutdown] starting');

    const pendingCount = pending.size;
    for (const [cid, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      try { entry.reject(new Error('BRIDGE_SHUTDOWN')); } catch (_) {}
    }
    pending.clear();

    if (port) {
      try { port.disconnect(); } catch (_) {}
      port = null;
    }

    sessionToken = null;
    sessionId = null;
    sessionEpoch = null;
    localSeq = 0;   // C3-01: SAFE εδώ (πλήρης teardown)
    initCompleted = false;
    initPromise = null;
    initResolve = null;
    initReject = null;
    reconnectInProgress = false;
    cachedGeneration = 0;

    // ⭐ v12.2 LAT-01: full cache reset
    _invalidateStatusCache();

    _sendQueue = Promise.resolve();

    log(`[shutdown] complete (pending=${pendingCount} rejected, localSeq reset)`);
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // ─── Lifecycle ───
    connect,
    start,
    shutdown,
    isConnected: () => port !== null && initCompleted,

    // C3-01: hardReset (fixed)
    hardReset,

    // V12E: PUBLIC send
    send,

    // ⭐ v12.2 LAT-01: cached getStatus
    //
    //  Χρήση:
    //    await CBF_BRIDGE.getStatus()             → cached (500ms)
    //    await CBF_BRIDGE.getStatus({ force: true }) → fresh
    //
    //  Invalidation:
    //    • shutdown / hardReset / port.onDisconnect
    //    • unlock / setup / lock (επιτυχία ή αποτυχία)
    getStatus: async (opts = {}) => {
      const now = Date.now();
      if (!opts.force &&
          _statusCache.value !== null &&
          (now - _statusCache.at) < _STATUS_CACHE_MS) {
        log(`[status-cache] HIT (age=${now - _statusCache.at}ms)`);
        return _statusCache.value;
      }
      const result = await send('getStatus');
      _statusCache = { value: result, at: Date.now() };
      log(`[status-cache] MISS → cached`);
      return result;
    },

    getActiveSpace: () => send('getActiveSpace'),
    setActiveSpace: (space) => send('setActiveSpace', { space }),
    queryTree:      (parentId, limit) => send('queryTree', { parentId, limit }),
    getPath:        (id) => send('getPath', { id }),

    searchBookmarks: (query) => send('searchBookmarks', { query }),

    // ─── External ───
    open:       (id) => send('open', { id }),
    getFavicon: (url) => send('getFavicon', { url }),

    // ─── Auth ⭐ v12.2: invalidate status cache στο finally ───
    unlock: async (password) => {
      try {
        return await send('unlock', { password });
      } finally {
        _invalidateStatusCache();
      }
    },
    setup: async (password) => {
      try {
        return await send('setup', { password });
      } finally {
        _invalidateStatusCache();
      }
    },
    lock: async () => {
      try {
        return await send('lock');
      } finally {
        _invalidateStatusCache();
      }
    },

    // ─── Core encrypted mutations ───
    create: (payload, expectedGeneration) =>
      send('create', payload, expectedGeneration),
    rename: (payload, expectedGeneration) =>
      send('rename', payload, expectedGeneration),
    delete: (payload, expectedGeneration) =>
      send('delete', payload, expectedGeneration),

    // ─── Encrypted D&D ───
    moveSingle: function(id, newParentId, position = 'inside', targetId = null, expectedGen) {
      const gen = (typeof expectedGen === 'number') ? expectedGen : cachedGeneration;
      return send('move', { id, newParentId, position, targetId }, gen);
    },

    moveMulti: function(ids, newParentId, position = 'inside', targetId = null, expectedGen) {
      if (!Array.isArray(ids) || ids.length === 0) {
        return Promise.reject(new Error('moveMulti: ids must be non-empty array'));
      }
      const gen = (typeof expectedGen === 'number') ? expectedGen : cachedGeneration;
      return send('move', {
        ids: ids.slice(), newParentId, position, targetId
      }, gen);
    },

    reorder: function(id, targetId, position, expectedGen) {
      if (position !== 'before' && position !== 'after') {
        return Promise.reject(new Error('reorder: position must be before|after'));
      }
      const gen = (typeof expectedGen === 'number') ? expectedGen : cachedGeneration;
      return send('reorder', { id, targetId, position }, gen);
    },

    merge: function(item1Id, item2Id, folderName, parentId, expectedGen) {
      if (item1Id === item2Id) {
        return Promise.reject(new Error('merge: item1Id and item2Id must be different'));
      }
      const gen = (typeof expectedGen === 'number') ? expectedGen : cachedGeneration;
      return send('merge', { item1Id, item2Id, folderName, parentId }, gen);
    },

    mergeFolders: function(sourceId, targetId, expectedGen) {
      if (sourceId === targetId) {
        return Promise.reject(new Error('mergeFolders: sourceId and targetId must be different'));
      }
      const gen = (typeof expectedGen === 'number') ? expectedGen : cachedGeneration;
      return send('mergeFolders', { sourceId, targetId }, gen);
    },

    // ─── Firefox D&D ───
    firefoxMove: function(payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('firefoxMove: payload object required'));
      }
      if (!payload.id) return Promise.reject(new Error('firefoxMove: payload.id required'));
      if (!payload.newParentId) return Promise.reject(new Error('firefoxMove: payload.newParentId required'));
      return send('firefoxMove', {
        id: payload.id,
        newParentId: payload.newParentId,
        position: payload.position || 'inside',
        targetId: payload.targetId || null
      });
    },

    firefoxReorder: function(payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('firefoxReorder: payload object required'));
      }
      if (!payload.id) return Promise.reject(new Error('firefoxReorder: payload.id required'));
      if (!payload.targetId) return Promise.reject(new Error('firefoxReorder: payload.targetId required'));
      if (payload.position !== 'before' && payload.position !== 'after') {
        return Promise.reject(new Error('firefoxReorder: position must be before|after'));
      }
      return send('firefoxReorder', {
        id: payload.id,
        targetId: payload.targetId,
        position: payload.position
      });
    },

    firefoxMerge: function(payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('firefoxMerge: payload object required'));
      }
      const { item1Id, item2Id, folderName, parentId } = payload;
      if (!item1Id) return Promise.reject(new Error('firefoxMerge: item1Id required'));
      if (!item2Id) return Promise.reject(new Error('firefoxMerge: item2Id required'));
      if (item1Id === item2Id) {
        return Promise.reject(new Error('firefoxMerge: items must be different'));
      }
      if (!folderName) return Promise.reject(new Error('firefoxMerge: folderName required'));
      if (!parentId) return Promise.reject(new Error('firefoxMerge: parentId required'));
      return send('firefoxMerge', { item1Id, item2Id, folderName, parentId });
    },

    firefoxMergeFolders: function(payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('firefoxMergeFolders: payload object required'));
      }
      const { sourceId, targetId } = payload;
      if (!sourceId) return Promise.reject(new Error('firefoxMergeFolders: sourceId required'));
      if (!targetId) return Promise.reject(new Error('firefoxMergeFolders: targetId required'));
      if (sourceId === targetId) {
        return Promise.reject(new Error('firefoxMergeFolders: folders must be different'));
      }
      return send('firefoxMergeFolders', { sourceId, targetId });
    },

    firefoxRemove: function(id) {
      if (!id || typeof id !== 'string') {
        return Promise.reject(new Error('firefoxRemove: id required'));
      }
      return send('firefoxRemove', { id });
    },

    firefoxCreate: function(payload) {
      if (!payload || typeof payload !== 'object') {
        return Promise.reject(new Error('firefoxCreate: payload required'));
      }
      const { parentId, type, title, url = null } = payload;

      if (!parentId) return Promise.reject(new Error('firefoxCreate: parentId required'));
      if (type !== 'bookmark' && type !== 'folder') {
        return Promise.reject(new Error('firefoxCreate: type must be bookmark|folder'));
      }
      if (!title) return Promise.reject(new Error('firefoxCreate: title required'));
      if (type === 'bookmark' && !url) {
        return Promise.reject(new Error('firefoxCreate: url required for bookmark'));
      }

      const out = { parentId, type, title };
      if (type === 'bookmark') out.url = url;

      return send('firefoxCreate', out);
    },

    // ─── Cross-space ───
    crossMoveToEncrypted: function(id, isFolder = false) {
      const transferId = crypto.randomUUID();
      const type = isFolder ? 'moveFolderToEncrypted' : 'moveToEncrypted';
      return send(type, { id, transferId });
    },

    crossMoveToFirefox: function(id, isFolder = false) {
      const transferId = crypto.randomUUID();
      const type = isFolder ? 'moveFolderToFirefox' : 'moveToFirefox';
      return send(type, { id, transferId });
    },

    // ═══════════════════════════════════════════════════════════
    //  V12E specific wrappers (D-51..D-56)
    // ═══════════════════════════════════════════════════════════

    openInCurrentTab: function(url) {
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('openInCurrentTab: url required'));
      }
      return send('openInCurrentTab', { url });
    },

    openInNewTab: function(url) {
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.reject(new Error('openInNewTab: url required'));
      }
      return send('openInNewTab', { url });
    },

    firefoxRename: function(id, title) {
      if (!id || typeof id !== 'string') {
        return Promise.reject(new Error('firefoxRename: id required'));
      }
      if (!title || typeof title !== 'string') {
        return Promise.reject(new Error('firefoxRename: title required'));
      }
      if (title.trim().length === 0) {
        return Promise.reject(new Error('firefoxRename: title cannot be empty'));
      }
      return send('firefoxRename', { id, title: title.trim() });
    },

    exportBookmarks: function() {
      return send('exportBookmarks', {});
    },

    exportFavicons: function() {
      return send('exportFavicons', {});
    },

    exportEncryptedBackup: function() {
      return send('exportEncryptedBackup', {});
    },

    exportEncryptedPlain: function() {
      return send('exportEncryptedPlain', {});
    },

    importEncrypted: function(data, password, expectedGeneration) {
      if (!data || typeof data !== 'object') {
        return Promise.reject(new Error('importEncrypted: data object required'));
      }
      const gen = (typeof expectedGeneration === 'number')
        ? expectedGeneration
        : cachedGeneration;

      const payload = { data };
      if (typeof password === 'string' && password.length > 0) {
        payload.password = password;
      }

      return send('importEncrypted', payload, gen);
    },

    importFavicons: function(items) {
      if (!Array.isArray(items)) {
        return Promise.reject(new Error('importFavicons: items array required'));
      }
      return send('importFavicons', { items });
    },

    // ─── Events ───
    on,
    off,

    // ─── Debug / Generation ───
    getGeneration,
    _setGeneration: _updateCachedGeneration,
    _forceSetGeneration,

    // C3-02: Diagnostics
    getDiagnostics,
    _getLocalSeq,

    // ⭐ v12.2 LAT-01: status cache control (advanced)
    _invalidateStatusCache,

    _getSessionId: () => sessionId,
    _getSessionEpoch: () => sessionEpoch,
    _pendingCount: () => pending.size,
    _isInitCompleted: () => initCompleted,
    _isReconnecting: () => reconnectInProgress,

    _internal: {
      _getTimeout,
      ensureConnected,
      _emit,
      TIMEOUTS,
      DEFAULT_TIMEOUT_MS,
      RECONNECT_TIMEOUT_MS,
      STATUS_CACHE_MS: _STATUS_CACHE_MS,
      PORT_NAME,
      pending,
      eventListeners,
      _updateCachedGeneration,
      _forceSetGeneration,
      _invalidateStatusCache,
      _getStatusCache: () => ({ ..._statusCache })
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window     !== 'undefined') window.CBF_BRIDGE     = api;
  if (typeof self       !== 'undefined') self.CBF_BRIDGE       = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_BRIDGE = api;

  log('Bridge ready (v12.2.0: C3-01 hardReset + C3-02 diagnostics + V12E send + LAT-01 status cache 500ms)');

  return api;
})();