/**
 * timing-safe.js — Constant-time comparison (pure)
 *
 * @path     background/services/timing-safe.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Best-effort constant-time comparison για:
 *     • HMAC values           (§9 — session messages)
 *     • stateMAC values       (§4)
 *     • Merkle roots          (§6)
 *     • Argon2 WASM SRI hash  (§7.5)
 *     • Session tokens
 *
 * GUARANTEES & LIMITS
 *   • Length-independent για ίσο μήκος input (no early-exit)
 *   • XOR-accumulate pattern — όλα τα bytes πάντα διαβάζονται
 *   • Best-effort: V8 JIT δεν εγγυάται formal constant-time
 *   • Length leak: αποδεκτό (public information: 32 bytes / base64)
 *   • Out-of-scope: Spectre-class, compiler opts, hardware timing
 *
 * API
 *   • timingSafeEqual(a, b)        — Uint8Array | ArrayBuffer | Array<number>
 *   • timingSafeEqualString(a, b)  — ASCII-only strings
 *   • timingSafeEqualB64(a, b)     — base64 strings
 *   • timingSafeEqualHex(a, b)     — hex strings (case-insensitive)
 *
 * DECISIONS
 *   D-28
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "timing-safe"
 */

var CBF_TIMING_SAFE = (function() {
  'use strict';

  // ============================================================
  //  Internal: toUint8Array
  //
  //  Κανονικοποίηση input σε Uint8Array.
  //  Απορρίπτει μη-αναμενόμενους τύπους (fail-loud).
  // ============================================================
  function toUint8Array(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (Array.isArray(value)) return new Uint8Array(value);
    throw new Error(
      'timingSafeEqual: unsupported type ' +
      Object.prototype.toString.call(value)
    );
  }

  // ============================================================
  //  timingSafeEqual — κύρια συνάρτηση
  //
  //  Algorithm:
  //    1. Length check (public — αποδεκτό leak)
  //    2. XOR-accumulate όλα τα bytes
  //    3. Return accumulator === 0
  //
  //  ΔΕΝ κάνει early-exit στο loop.
  //  ΔΕΝ χρησιμοποιεί if/break μέσα στο loop.
  // ============================================================
  function timingSafeEqual(a, b) {
    const aBytes = toUint8Array(a);
    const bBytes = toUint8Array(b);

    // Length check — public information, δεν αποκαλύπτει secret.
    if (aBytes.length !== bBytes.length) return false;

    // XOR accumulate — πάντα ίδιος αριθμός iterations για ίδιο μήκος.
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
      diff |= aBytes[i] ^ bBytes[i];
    }

    return diff === 0;
  }

  // ============================================================
  //  timingSafeEqualString
  //
  //  Για ASCII-only strings (π.χ. base64, hex, UUID).
  //  Για UTF-8 strings με multi-byte chars, μετέτρεψε πρώτα σε
  //  Uint8Array και χρησιμοποίησε timingSafeEqual.
  //
  //  ΣΗΜΑΝΤΙΚΟ: ΔΕΝ κάνει UTF-8 encoding αυτόματα.
  //  Συγκρίνει charCodeAt() τιμές. Αν τα strings περιέχουν
  //  non-ASCII, τα αποτελέσματα μπορεί να είναι λανθασμένα.
  //  Για τα δικά μας use cases (base64, hex, UUID) είναι ασφαλές.
  // ============================================================
  function timingSafeEqualString(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new Error('timingSafeEqualString: both arguments must be strings');
    }
    if (a.length !== b.length) return false;

    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  // ============================================================
  //  timingSafeEqualB64 — base64 strings
  //
  //  Convenience wrapper. Στην πραγματικότητα ίδιο με string compare
  //  γιατί το base64 είναι ASCII-only.
  // ============================================================
  function timingSafeEqualB64(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new Error('timingSafeEqualB64: both arguments must be strings');
    }
    if (a.length !== b.length) return false;

    // Validate base64 alphabet (μόνο για assertion consistency)
    // ΣΗΜΑΝΤΙΚΟ: ΔΕΝ κάνουμε early-return εδώ — θα ήταν length leak
    // σε αντίθετη περίπτωση. Όλα τα bytes διαβάζονται πάντα.
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  // ============================================================
  //  timingSafeEqualHex — hex strings
  //
  //  Case-insensitive: 'abc' === 'ABC'.
  //  Δέχεται μόνο [0-9a-fA-F] — αλλά ΔΕΝ το επαληθεύει εδώ
  //  (θα ήταν conditional branch).
  // ============================================================
  function timingSafeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new Error('timingSafeEqualHex: both arguments must be strings');
    }
    if (a.length !== b.length) return false;

    // Lowercase normalization με bitwise OR 0x20 σε letters.
    // ΔΕΝ χρησιμοποιεί toLowerCase() — γιατί θα ήταν data-dependent timing.
    // 0x41-0x5A (A-Z) → OR 0x20 → 0x61-0x7A (a-z)
    // 0x30-0x39 (0-9) → OR 0x20 → 0x30-0x39 (unchanged, γιατί bit 5 set ήδη)
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      const ca = a.charCodeAt(i) | 0x20;
      const cb = b.charCodeAt(i) | 0x20;
      diff |= ca ^ cb;
    }
    return diff === 0;
  }

  // ============================================================
  //  API
  // ============================================================
  const api = {
    timingSafeEqual,
    timingSafeEqualString,
    timingSafeEqualB64,
    timingSafeEqualHex,

    // Exposed for testing
    _internal: {
      toUint8Array
    }
  };

  if (typeof window !== 'undefined') window.CBF_TIMING_SAFE = api;
  if (typeof self !== 'undefined') self.CBF_TIMING_SAFE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_TIMING_SAFE = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info('Timing-safe comparison ready (D-28, Contract v1.1)');
  }

  return api;
})();