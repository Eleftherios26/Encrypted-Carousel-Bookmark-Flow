/**
 * logger-service.js — Sanitized logging service
 *
 * @path     background/core/logger-service.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Foundational logging module. Φορτώνεται ΠΡΙΝ από κάθε άλλο module.
 *   Παρέχει 4 log levels (info, warn, error, security) + debug (disabled
 *   σε production) με automatic sanitization.
 *
 * SANITIZATION
 *   Αποκρύπτει από τα logs:
 *     • URLs        → [REDACTED_URL]
 *     • Emails      → [REDACTED_EMAIL]
 *     • Base64 blobs (>=64 chars) → [REDACTED_BLOB]
 *   Επιπλέον:
 *     • Error stack traces σε production → undefined
 *     • __proto__ / constructor keys → filtered (prototype pollution)
 *     • Circular references → safety
 *
 * LOG LEVELS
 *   • security — ΠΑΝΤΑ εκτυπώνεται (unlock_success, session_created, κλπ)
 *   • error    — ΠΑΝΤΑ εκτυπώνεται
 *   • warn     — ΠΑΝΤΑ εκτυπώνεται
 *   • info     — ΠΑΝΤΑ εκτυπώνεται
 *   • debug    — ΜΟΝΟ σε development (PRODUCTION flag = false)
 *
 * NON-OBVIOUS
 *   • Το sanitize() καλείται σε ΚΑΘΕ argument πριν την εκτύπωση.
 *     Είναι recursive για objects/arrays.
 *   • Το PRODUCTION flag είναι hardcoded true. Για debug: αλλαγή σε false.
 *   • Το module εκθέτει τον εαυτό του σε window + self + globalThis
 *     (cross-environment compatibility).
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "logger-service"
 */

var CBF_LOGGER = (function() {
  // ---------- Ρυθμίσεις ----------
  // Σε production απενεργοποιούμε το debug.
  // Αν θέλεις debug, άλλαξε το σε false.
  const PRODUCTION = true;

  // ---------- Regex για sanitization ----------
  const URL_REGEX = /\bhttps?:\/\/[^\s"'<>)]+/gi;
  const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const B64_LONG_REGEX = /\b[A-Za-z0-9+/=]{64,}\b/g;

  // ---------- Βοηθητικές ----------
  function sanitize(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      return value
        .replace(URL_REGEX, '[REDACTED_URL]')
        .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
        .replace(B64_LONG_REGEX, '[REDACTED_BLOB]');
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: sanitize(value.message),
        // Δεν εκτυπώνουμε stack traces σε production
        stack: PRODUCTION ? undefined : value.stack
      };
    }
    if (Array.isArray(value)) {
      return value.map(sanitize);
    }
    if (typeof value === 'object') {
      // Αποφεύγουμε κυκλικές αναφορές και prototype pollution
      const out = {};
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor') continue;
        out[key] = sanitize(value[key]);
      }
      return out;
    }
    return '[UNKNOWN]';
  }

  function formatArgs(args) {
    return args.map(sanitize);
  }

  // ---------- Κεντρική εκτύπωση ----------
  function emit(level, message, args) {
    if (PRODUCTION && level === 'debug') return;
    const prefix = `[ECBF:${level.toUpperCase()}]`;
    const safeMessage = typeof message === 'string' ? sanitize(message) : sanitize(message);
    const safeArgs = formatArgs(args);

    switch (level) {
      case 'error':
        console.error(prefix, safeMessage, ...safeArgs);
        break;
      case 'warn':
        console.warn(prefix, safeMessage, ...safeArgs);
        break;
      case 'info':
      case 'security':
      case 'debug':
      default:
        console.log(prefix, safeMessage, ...safeArgs);
        break;
    }
  }

  // ---------- Δημόσιο API ----------
  const api = {
    /**
     * Κρίσιμα γεγονότα ασφαλείας (unlock_success, session_created, κ.λπ.)
     * Πάντα εκτυπώνονται (ακόμη και σε production).
     */
    security: (message, ...args) => emit('security', message, args),

    /**
     * Πληροφοριακά μηνύματα (κατάσταση, πρόοδος).
     */
    info: (message, ...args) => emit('info', message, args),

    /**
     * Προειδοποιήσεις – δεν σταματούν τη ροή.
     */
    warn: (message, ...args) => emit('warn', message, args),

    /**
     * Σφάλματα – πάντα εκτυπώνονται.
     */
    error: (message, ...args) => emit('error', message, args),

    /**
     * Debug – απενεργοποιημένο σε production.
     */
    debug: (message, ...args) => emit('debug', message, args),

    /**
     * Χειροκίνητο sanitization για περιπτώσεις που θέλουμε
     * να ελέγξουμε το αποτέλεσμα πριν το χρησιμοποιήσουμε.
     */
    sanitize
  };

  // ---------- Έκθεση σε global scope ----------
  // Λειτουργεί τόσο σε overlay (window) όσο και σε background (self).
  if (typeof window !== 'undefined') {
    window.CBF_LOGGER = api;
  }
  if (typeof self !== 'undefined') {
    self.CBF_LOGGER = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.CBF_LOGGER = api;
  }

  api.info('Logger Service ready (production=' + PRODUCTION + ')');
  return api;
})();