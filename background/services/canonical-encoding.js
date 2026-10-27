/**
 * canonical-encoding.js — Deterministic canonical serialization
 *
 * @path     background/services/canonical-encoding.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Deterministic serialization για χρήση σε:
 *     • stateMAC computation              (§4)
 *     • Merkle leaf computation           (§5)
 *     • AAD construction                  (§8)
 *     • Session message HMAC signing      (§9)
 *
 * GUARANTEES
 *   • Determinism: ίδιο input → ίδιο output ΠΑΝΤΑ
 *   • Canonical key ordering (ASCII lexicographic)
 *   • NFC normalization για strings
 *   • Reject non-finite numbers, non-plain objects (fail-loud)
 *   • 0 dependency σε network / crypto / IDB / timers
 *
 * NON-OBVIOUS
 *   • __proto__ / constructor keys φιλτράρονται — protection
 *     ενάντια σε prototype pollution από malicious callers.
 *   • undefined values αφαιρούνται (JSON.stringify behavior).
 *   • Class instances (Date, Map, Set) → throw, ΟΧΙ silent data loss.
 *
 * CONTRACT
 *   ECBF-v12E-Final1-Contract-Freeze v1.1 §3
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "canonical-encoding"
 */

var CBF_CANONICAL = (function() {
  'use strict';

  // ============================================================
  //  TextEncoder — shared
  // ============================================================
  const encoder = new TextEncoder();

  // ============================================================
  //  isPlainObject — strict check
  //
  //  Reject: arrays, null, class instances (Date/Map/Set),
  //          primitives.
  //  Accept: Object.prototype ή null prototype.
  // ============================================================
  function isPlainObject(value) {
    if (typeof value !== 'object' || value === null) return false;
    if (Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  // ============================================================
  //  canonicalize — recursive
  // ============================================================
  function canonicalize(value) {
    // null / undefined
    if (value === null) return null;
    if (value === undefined) return undefined;

    // arrays
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }

    // objects
    if (typeof value === 'object') {
      if (!isPlainObject(value)) {
        throw new Error(
          'canonical: unsupported object type ' +
          Object.prototype.toString.call(value)
        );
      }

      const out = {};
      const keys = Object.keys(value)
        .filter(k => k !== '__proto__' && k !== 'constructor')
        .sort();   // ← ASCII lexicographic

      for (const key of keys) {
        const v = canonicalize(value[key]);
        if (v !== undefined) out[key] = v;
      }
      return out;
    }

    // strings — NFC normalization
    if (typeof value === 'string') {
      return value.normalize('NFC');
    }

    // numbers — fail-loud σε NaN / Infinity
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new Error('canonical: non-finite number');
      }
      return value;
    }

    // booleans
    if (typeof value === 'boolean') {
      return value;
    }

    // everything else: bigint, symbol, function
    throw new Error(`canonical: unsupported type ${typeof value}`);
  }

  // ============================================================
  //  canonicalJSON — deterministic string
  // ============================================================
  function canonicalJSON(value) {
    return JSON.stringify(canonicalize(value));
  }

  // ============================================================
  //  canonicalBytes — UTF-8 encoded Uint8Array
  // ============================================================
  function canonicalBytes(value) {
    return encoder.encode(canonicalJSON(value));
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    canonicalJSON,
    canonicalBytes,

    _internal: {
      canonicalize,
      isPlainObject,
      canonicalizeRecursive: canonicalize
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_CANONICAL = api;
  if (typeof self !== 'undefined') self.CBF_CANONICAL = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_CANONICAL = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Canonical Encoding ready (Contract v1.1 §3)');
  }

  return api;
})();