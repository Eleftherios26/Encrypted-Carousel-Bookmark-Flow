/**
 * session-capability.js — Session & capability management
 *
 * @path     background/services/session-capability.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Διαχειρίζεται sessions (port connections) + capabilities.
 *   Κάθε session έχει:
 *     • id (UUID v4)
 *     • tabId, frameId
 *     • sessionEpoch (monotonic per-background-lifetime)
 *     • sessionToken (HMAC(random_secret, sessionId:epoch))
 *     • capabilities (Set)
 *
 * SESSION LIFECYCLE
 *   • createSession(port, tabId, frameId) → νέα session
 *   • disconnect(port) → cleanup + memory hygiene
 *   • IDLE_MS GC (5 min) → auto disconnect idle sessions
 *
 * EPOCH ROTATION (B7)
 *   • rotateEpoch(sessionId) — manual rotation
 *   • rotateAllEpochs() — rotate όλα τα sessions
 *   • epochCounter: monotonic per-background-lifetime
 *   • secret: RAM-only (zeroized στο disconnect)
 *
 * CAPABILITIES (H-3 / D-34)
 *   • CAP_READ       — 'encrypted.read'
 *   • CAP_WRITE      — 'encrypted.write'
 *   • CAP_FIREFOX    — 'firefox.write' (granted UNCONDITIONALLY)
 *
 * DECISIONS
 *   D-23.1, D-34
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "session"
 */

var CBF_SESSION = (function() {
  'use strict';

  // ============================================================
  //  Κατάσταση (RAM only)
  // ============================================================
  const sessions = new Map();
  const portStates = new Map();

  let epochCounter = 0;   // B7: monotonic, per-background-lifetime

  // ============================================================
  //  Capability constants
  // ============================================================
  const CAP_READ    = 'encrypted.read';
  const CAP_WRITE   = 'encrypted.write';
  const CAP_FIREFOX = 'firefox.write';

  // ============================================================
  //  Session lifecycle
  // ============================================================
  async function createSession(port, tabId, frameId) {
    if (!port) throw new Error('port required');

    const sessionId = crypto.randomUUID();

    // B7: κάθε νέο session παίρνει μοναδικό epoch
    epochCounter++;
    const sessionEpoch = epochCounter;

    // sessionToken = HMAC(random_secret, sessionId:epoch)
    const secret = CBF_CRYPTO.generateRandomBytes(32);
    const tokenInput = `${sessionId}:${sessionEpoch}`;
    const tokenBytes = await CBF_CRYPTO.hmacSign(secret, tokenInput);
    const sessionToken = CBF_CRYPTO.bufToB64(tokenBytes);

    // Memory hygiene: μηδενισμός μόνο των token bytes.
    // Το `secret` κρατείται στη RAM για rotation (μηδενίζεται στο disconnect).
    CBF_CRYPTO.zeroBuffer(tokenBytes);

    const session = {
      id: sessionId,
      tabId: tabId ?? null,
      frameId: frameId ?? null,
      sessionEpoch,
      sessionToken,
      secret,                       // Uint8Array(32) – για rotation
      capabilities: new Set(),
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    // ═══════════════════════════════════════════════════════════
    //  H-3 (D-34): CAP_FIREFOX granted UNCONDITIONALLY
    //
    //  Αιτία:
    //    - Firefox D&D λειτουργεί ανεξάρτητα από vault lock
    //    - ΔΕΝ απαιτείται unlock για native bookmarks
    //    - Το capability δίνει audit trail + kill switch
    //    - Αν αποσυρθεί → όλα τα firefox* commands απορρίπτονται
    // ═══════════════════════════════════════════════════════════
    session.capabilities.add(CAP_FIREFOX);

    sessions.set(sessionId, session);

    portStates.set(port, {
      sessionId,
      sessionEpoch,
      lastSequence: 0,
      creditEpoch: 0,
      credits: 0,
      lastSentVersion: 0
    });

    CBF_LOGGER.security(
      `Session created: ${sessionId} (epoch=${sessionEpoch}, ` +
      `firefox.write auto-granted)`
    );
    return { sessionId, sessionToken, sessionEpoch };
  }

  function disconnect(port) {
    const state = portStates.get(port);
    if (!state) return;
    const session = sessions.get(state.sessionId);
    if (session) {
      CBF_LOGGER.info(`Session disconnected: ${session.id}`);

      // Memory hygiene: μηδενισμός secret + token
      if (session.secret) {
        CBF_CRYPTO.zeroBuffer(session.secret);
        session.secret = null;
      }
      session.sessionToken = null;
      session.capabilities.clear();

      sessions.delete(session.id);
    }
    portStates.delete(port);
  }

  function disconnectAll() {
    const ports = Array.from(portStates.keys());
    for (const port of ports) {
      try { port.disconnect(); } catch (_) {}
      disconnect(port);
    }
    CBF_LOGGER.warn('All sessions disconnected');
  }

  // ============================================================
  //  B7: Epoch rotation
  // ============================================================

  /**
   * Rotate τον epoch του session.
   * Επιστρέφει { sessionEpoch, sessionToken, oldEpoch } ή null.
   *
   * ΣΗΜΑΝΤΙΚΟ: Ο caller είναι υπεύθυνος να στείλει το νέο token
   * στο overlay (μέσω raw postMessage – βλ. messaging.notifyEpochRotation).
   */
  async function rotateEpoch(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (!session.secret) {
      CBF_LOGGER.warn(`Cannot rotate epoch for ${sessionId}: no secret`);
      return null;
    }

    const oldEpoch = session.sessionEpoch;
    epochCounter++;
    session.sessionEpoch = epochCounter;

    const tokenInput = `${session.id}:${session.sessionEpoch}`;
    const tokenBytes = await CBF_CRYPTO.hmacSign(session.secret, tokenInput);
    session.sessionToken = CBF_CRYPTO.bufToB64(tokenBytes);
    CBF_CRYPTO.zeroBuffer(tokenBytes);

    // Update portState
    for (const [port, state] of portStates.entries()) {
      if (state.sessionId === sessionId) {
        state.sessionEpoch = session.sessionEpoch;
        break;
      }
    }

    CBF_LOGGER.security(
      `Epoch rotated: ${sessionId} (${oldEpoch} → ${session.sessionEpoch})`
    );

    return {
      sessionEpoch: session.sessionEpoch,
      sessionToken: session.sessionToken,
      oldEpoch
    };
  }

  /**
   * Rotate όλων των sessions.
   * Επιστρέφει array από { sessionId, sessionEpoch, sessionToken, oldEpoch }.
   */
  async function rotateAllEpochs() {
    const results = [];
    for (const sessionId of Array.from(sessions.keys())) {
      const r = await rotateEpoch(sessionId);
      if (r) results.push({ sessionId, ...r });
    }
    return results;
  }

  function getGlobalEpochCounter() {
    return epochCounter;
  }

  // ============================================================
  //  Getters
  // ============================================================
  function getPortState(port) { return portStates.get(port); }
  function getSession(sessionId) { return sessions.get(sessionId); }
  function getAllPorts() { return Array.from(portStates.keys()); }
  function getAllSessions() { return Array.from(sessions.values()); }

  function getSessionToken(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.sessionToken : null;
  }

  function getSessionEpoch(sessionId) {
    const s = sessions.get(sessionId);
    return s ? s.sessionEpoch : null;
  }

  // B7: helper για wiring rotation notifications
  function getPortBySession(sessionId) {
    for (const [port, state] of portStates.entries()) {
      if (state.sessionId === sessionId) return port;
    }
    return null;
  }

  // ============================================================
  //  Capabilities
  // ============================================================
  function grantCapability(sessionId, capability) {
    const session = sessions.get(sessionId);
    if (!session) {
      CBF_LOGGER.warn(`Cannot grant ${capability} – session not found: ${sessionId}`);
      return false;
    }
    session.capabilities.add(capability);
    CBF_LOGGER.security(`Capability GRANTED: ${capability} → ${sessionId}`);
    return true;
  }

  function revokeCapability(sessionId, capability) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.capabilities.delete(capability);
    CBF_LOGGER.info(`Capability REVOKED: ${capability} ← ${sessionId}`);
    return true;
  }

  function hasCapability(sessionId, capability) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    return session.capabilities.has(capability);
  }

  function grantCapabilitiesToAll(capabilities) {
    if (!Array.isArray(capabilities)) return;
    for (const session of sessions.values()) {
      for (const cap of capabilities) {
        session.capabilities.add(cap);
      }
    }
    CBF_LOGGER.security(`Capabilities granted to all sessions: ${capabilities.join(', ')}`);
  }

  /**
   * Καθαρισμός capabilities.
   *
   * ΣΗΜΑΝΤΙΚΟ (D-34): Το CAP_FIREFOX ΔΕΝ καθαρίζεται.
   * Αιτία: Firefox D&D λειτουργεί ανεξάρτητα από vault lock state.
   * Το CAP_FIREFOX παραμένει μέχρι disconnect της session.
   *
   * Τα CAP_READ / CAP_WRITE καθαρίζονται (encrypted space lock).
   */
  function clearAllCapabilities() {
    for (const session of sessions.values()) {
      session.capabilities.clear();
      // D-34: Επαναφορά CAP_FIREFOX
      session.capabilities.add(CAP_FIREFOX);
    }
    CBF_LOGGER.security(
      'All capabilities cleared (lock) — firefox.write retained (D-34)'
    );
  }

  // ============================================================
  //  Activity tracking
  // ============================================================
  function updateActivity(sessionId) {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
  }

  // ============================================================
  //  Idle GC (5 min)
  // ============================================================
  const IDLE_MS = 5 * 60 * 1000;

  setInterval(() => {
    const now = Date.now();
    for (const session of Array.from(sessions.values())) {
      if (now - session.lastActivity > IDLE_MS) {
        CBF_LOGGER.warn(`Idle session expired: ${session.id}`);
        const port = getPortBySession(session.id);
        if (port) {
          try { port.disconnect(); } catch (_) {}
          disconnect(port);
        }
      }
    }
  }, 60 * 1000);

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    CAP_READ,
    CAP_WRITE,
    CAP_FIREFOX,

    createSession,
    disconnect,
    disconnectAll,

    // B7
    rotateEpoch,
    rotateAllEpochs,
    getGlobalEpochCounter,

    getPortState,
    getPortBySession,
    getSession,
    getAllPorts,
    getAllSessions,

    getSessionToken,
    getSessionEpoch,

    grantCapability,
    revokeCapability,
    hasCapability,
    grantCapabilitiesToAll,
    clearAllCapabilities,

    updateActivity,

    IDLE_MS
  };

  if (typeof window !== 'undefined') window.CBF_SESSION = api;
  if (typeof self !== 'undefined') self.CBF_SESSION = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_SESSION = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Session & Capability Service ready (v12.0.0: B7 epoch rotation, H-3 CAP_FIREFOX + D-34 retention)'
    );
  }

  return api;
})();