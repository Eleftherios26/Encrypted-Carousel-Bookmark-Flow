/**
 * vault-state-machine.js — Vault state machine (FSM)
 *
 * @path     background/core/vault-state-machine.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Finite State Machine για το vault lifecycle:
 *     INITIAL → LOCKED → UNLOCKING → UNLOCKED → LOCKING → LOCKED
 *
 * GUARANTEES
 *   • Mutex (withLock) — καμία παράλληλη μετάβαση
 *   • onTransition listeners — ειδοποίηση για κάθε αλλαγή
 *   • Fail-safe: κάθε exception → LOCKED (όχι UNLOCKED)
 *   • Busy flag: αποτρέπει concurrent unlock attempts
 *   • Idempotent transitions: beginUnlock σε UNLOCKING → throw
 *
 * API
 *   Lifecycle:  initialize, beginUnlock, completeUnlock, failUnlock, lock
 *   Queries:    getState, isLocked, isUnlocked, isBusy, getStateHistory
 *   Events:     onTransition, offTransition, clearListeners, getListenerCount
 *   Constants:  State.{INITIAL, LOCKED, UNLOCKING, UNLOCKED, LOCKING}
 *
 * DECISIONS
 *   D-27
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "vault-state-machine"
 */

var CBF_VAULT_FSM = (function() {
  'use strict';

  // ============================================================
  //  States — frozen
  // ============================================================
  const State = Object.freeze({
    INITIAL:   'INITIAL',
    LOCKED:    'LOCKED',
    UNLOCKING: 'UNLOCKING',
    UNLOCKED:  'UNLOCKED',
    LOCKING:   'LOCKING'
  });

  // Επιτρεπτές μεταβάσεις
  const VALID_TRANSITIONS = Object.freeze({
    [State.INITIAL]:   [State.LOCKED],
    [State.LOCKED]:    [State.UNLOCKING],
    [State.UNLOCKING]: [State.UNLOCKED, State.LOCKED],
    [State.UNLOCKED]:  [State.LOCKING],
    [State.LOCKING]:   [State.LOCKED]
  });

  // ============================================================
  //  State (RAM only)
  // ============================================================
  let currentState = State.INITIAL;
  let transitionLock = Promise.resolve();
  const listeners = [];
  const stateHistory = [];
  const MAX_HISTORY = 50;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[FSM]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[FSM]', ...a); }
  function err(...a)  { CBF_LOGGER.error('[FSM]', ...a); }

  // ============================================================
  //  Mutex (withLock) — §4.3
  //
  //  Αποτρέπει ταυτόχρονες μεταβάσεις.
  //  Κάθε μετάβαση εκτελείται σειριακά.
  // ============================================================
  function withLock(fn) {
    const result = transitionLock.then(() => fn());
    transitionLock = result.catch(() => {});
    return result;
  }

  // ============================================================
  //  Internal transition
  // ============================================================
  async function _transition(newState, reason) {
    const oldState = currentState;

    // Idempotent: ίδια κατάσταση → no-op
    if (oldState === newState) {
      return { ok: true, noop: true, state: currentState };
    }

    // Validate transition
    const allowed = VALID_TRANSITIONS[oldState] || [];
    if (!allowed.includes(newState)) {
      const msg = `Invalid transition: ${oldState} → ${newState}`;
      warn(msg);
      return { ok: false, error: 'INVALID_TRANSITION', message: msg };
    }

    // Apply
    currentState = newState;

    // Record history
    stateHistory.push({
      from: oldState,
      to: newState,
      at: Date.now(),
      reason: reason || null
    });
    if (stateHistory.length > MAX_HISTORY) {
      stateHistory.shift();
    }

    log(`Transition: ${oldState} → ${newState}` + (reason ? ` (${reason})` : ''));

    // Notify listeners (async, non-blocking)
    await _notifyListeners(newState, oldState);

    return { ok: true, state: newState, previousState: oldState };
  }

  // ============================================================
  //  Notify listeners
  // ============================================================
  async function _notifyListeners(newState, oldState) {
    for (const listener of listeners) {
      try {
        await listener(newState, oldState);
      } catch (e) {
        err('Listener error:', e.message);
      }
    }
  }

  // ============================================================
  //  Lifecycle — initialize
  // ============================================================
  async function initialize() {
    return withLock(async () => {
      if (currentState !== State.INITIAL) {
        warn(`initialize() called in state ${currentState} — ignoring`);
        return { ok: true, state: currentState };
      }
      return await _transition(State.LOCKED, 'initialize');
    });
  }

  // ============================================================
  //  Lifecycle — beginUnlock
  // ============================================================
  async function beginUnlock() {
    return withLock(async () => {
      if (currentState !== State.LOCKED) {
        const msg = `beginUnlock() requires LOCKED, current=${currentState}`;
        warn(msg);
        throw new Error(msg);
      }
      return await _transition(State.UNLOCKING, 'beginUnlock');
    });
  }

  // ============================================================
  //  Lifecycle — completeUnlock
  // ============================================================
  async function completeUnlock() {
    return withLock(async () => {
      if (currentState !== State.UNLOCKING) {
        const msg = `completeUnlock() requires UNLOCKING, current=${currentState}`;
        warn(msg);
        throw new Error(msg);
      }
      return await _transition(State.UNLOCKED, 'completeUnlock');
    });
  }

  // ============================================================
  //  Lifecycle — failUnlock
  // ============================================================
  async function failUnlock() {
    return withLock(async () => {
      if (currentState !== State.UNLOCKING) {
        // Fail-safe: log + ignore
        warn(`failUnlock() called in state ${currentState} — forcing LOCKED`);
        return await _transition(State.LOCKED, 'failUnlock (forced)');
      }
      return await _transition(State.LOCKED, 'failUnlock');
    });
  }

  // ============================================================
  //  Lifecycle — lock
  //
  //  Δύο βήματα: → LOCKING → LOCKED
  //  Το LOCKING επιτρέπει στους listeners να κάνουν cleanup.
  // ============================================================
  async function lock() {
    return withLock(async () => {
      // Αν ήδη LOCKED → no-op
      if (currentState === State.LOCKED) {
        return { ok: true, noop: true, state: State.LOCKED };
      }

      // Αν INITIAL → πήγαινε κατευθείαν LOCKED
      if (currentState === State.INITIAL) {
        return await _transition(State.LOCKED, 'lock (from INITIAL)');
      }

      // UNLOCKED → LOCKING → LOCKED
      if (currentState === State.UNLOCKED) {
        await _transition(State.LOCKING, 'lock');
        return await _transition(State.LOCKED, 'lock complete');
      }

      // UNLOCKING → LOCKED (ακύρωση unlock)
      if (currentState === State.UNLOCKING) {
        return await _transition(State.LOCKED, 'lock (cancel unlock)');
      }

      // LOCKING → LOCKED (συνέχεια)
      if (currentState === State.LOCKING) {
        return await _transition(State.LOCKED, 'lock complete');
      }

      // Fallback (δεν πρέπει να φτάσει εδώ)
      warn(`lock() called in unexpected state ${currentState}`);
      return { ok: false, error: 'INVALID_STATE', state: currentState };
    });
  }

  // ============================================================
  //  Queries
  // ============================================================
  function getState() {
    return currentState;
  }

  function isLocked() {
    return currentState === State.LOCKED || currentState === State.INITIAL;
  }

  function isUnlocked() {
    return currentState === State.UNLOCKED;
  }

  function isBusy() {
    return currentState === State.UNLOCKING || currentState === State.LOCKING;
  }

  function getStateHistory() {
    return stateHistory.slice();
  }

  // ============================================================
  //  Events
  // ============================================================
  function onTransition(fn) {
    if (typeof fn !== 'function') {
      throw new Error('onTransition: fn must be a function');
    }
    listeners.push(fn);

    // Επιστρέφουμε unsubscribe function
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  function offTransition(fn) {
    const idx = listeners.indexOf(fn);
    if (idx !== -1) {
      listeners.splice(idx, 1);
      return true;
    }
    return false;
  }

  function clearListeners() {
    listeners.length = 0;
  }

  function getListenerCount() {
    return listeners.length;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    // Constants
    State,

    // Lifecycle
    initialize,
    beginUnlock,
    completeUnlock,
    failUnlock,
    lock,

    // Queries
    getState,
    isLocked,
    isUnlocked,
    isBusy,
    getStateHistory,

    // Events
    onTransition,
    offTransition,
    clearListeners,
    getListenerCount,

    // Test / debug
    _internal: {
      VALID_TRANSITIONS,
      withLock,
      _transition,
      _notifyListeners,
      MAX_HISTORY,
      // Test helper: force reset state (ΜΟΝΟ για tests)
      _forceReset: (state) => {
        currentState = state || State.INITIAL;
        stateHistory.length = 0;
        transitionLock = Promise.resolve();
      }
    }
  };

  if (typeof self !== 'undefined') self.CBF_VAULT_FSM = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_VAULT_FSM = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Vault State Machine ready (INITIAL → LOCKED → UNLOCKING → UNLOCKED)');
  }

  return api;
})();