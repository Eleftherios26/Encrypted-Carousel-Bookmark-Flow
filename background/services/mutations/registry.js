/**
 * registry.js — Mutation handler registry
 *
 * @path     background/services/mutations/registry.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Εγκαθιστά (register) όλους τους mutation handlers στον sequencer.
 *   Idempotent — μπορεί να κληθεί πολλαπλές φορές.
 *
 * HANDLERS (8)
 *   Core (5):       create, rename, delete, move, reorder
 *   D&D merge (2):  merge, mergeFolders
 *   V12E (1):       importEncrypted (D-56)
 *
 * V12E.E-01 GUARDED REGISTRATION
 *   Κάθε registration τυλίγεται σε try/catch. Αν ένα module αποτύχει
 *   να φορτώσει (syntax error, missing file, encoding issue), το
 *   install() ΔΕΝ σπάει — τα άλλα handlers παραμένουν registered.
 *   Install isolation: ένα σπασμένο module δεν σπάει τα υπόλοιπα.
 *
 * DECISIONS
 *   D-6, D-56
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "registry"
 */

var CBF_MUTATION_REGISTRY = (function() {
  'use strict';

  // ============================================================
  //  State
  // ============================================================
  let installed = false;

  // V12E.E-01: Registration result tracking (diagnostics)
  const _registrationResults = {
    attempted: [],
    succeeded: [],
    failed: [],
    skipped: []
  };

  // ============================================================
  //  V12E.E-01: Safe registration helper
  //
  //  Τυλίγει ένα registerCommand() call σε try/catch.
  //  Επιστρέφει true/false για diagnostics.
  //
  //  @param  {string} name           — command name
  //  @param  {object} handler        — handler object (prepare method)
  //  @param  {boolean} [optional]    — αν true, το failure είναι warning
  //  @returns {boolean}              — true αν registered OK
  // ============================================================
  function _safeRegister(name, handler, optional = false) {
    _registrationResults.attempted.push(name);

    // ---------- Guard: handler must exist ----------
    if (!handler) {
      if (optional) {
        _registrationResults.skipped.push(name);
        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.warn(
            `MutationRegistry: handler "${name}" not loaded — ` +
            `command will return UNSUPPORTED_COMMAND`
          );
        }
      } else {
        _registrationResults.failed.push({ name, reason: 'HANDLER_MISSING' });
        if (typeof CBF_LOGGER !== 'undefined') {
          CBF_LOGGER.error(
            `MutationRegistry: REQUIRED handler "${name}" is missing`
          );
        }
      }
      return false;
    }

    // ---------- Guard: handler must have prepare() ----------
    if (typeof handler.prepare !== 'function') {
      _registrationResults.failed.push({ name, reason: 'PREPARE_MISSING' });
      if (typeof CBF_LOGGER !== 'undefined') {
        CBF_LOGGER.error(
          `MutationRegistry: handler "${name}" has no prepare() method`
        );
      }
      return false;
    }

    // ---------- Actual registration ----------
    try {
      CBF_SEQUENCER.registerCommand(name, handler);
      _registrationResults.succeeded.push(name);
      return true;
    } catch (e) {
      _registrationResults.failed.push({ name, reason: e.message });
      if (typeof CBF_LOGGER !== 'undefined') {
        if (optional) {
          CBF_LOGGER.warn(
            `MutationRegistry: optional handler "${name}" registration failed: ${e.message}`
          );
        } else {
          CBF_LOGGER.error(
            `MutationRegistry: REQUIRED handler "${name}" registration failed: ${e.message}`
          );
        }
      }
      return false;
    }
  }

  // ============================================================
  //  Install — idempotent
  // ============================================================
  function install() {
    if (installed) {
      if (typeof CBF_LOGGER !== 'undefined') {
        CBF_LOGGER.warn('MutationRegistry: already installed');
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════
    //  Core mutations (5) — REQUIRED
    // ═══════════════════════════════════════════════════════════
    _safeRegister('create',  typeof CBF_MUTATION_CREATE  !== 'undefined' ? CBF_MUTATION_CREATE  : null, false);
    _safeRegister('rename',  typeof CBF_MUTATION_RENAME  !== 'undefined' ? CBF_MUTATION_RENAME  : null, false);
    _safeRegister('delete',  typeof CBF_MUTATION_DELETE  !== 'undefined' ? CBF_MUTATION_DELETE  : null, false);
    _safeRegister('move',    typeof CBF_MUTATION_MOVE    !== 'undefined' ? CBF_MUTATION_MOVE    : null, false);
    _safeRegister('reorder', typeof CBF_MUTATION_REORDER !== 'undefined' ? CBF_MUTATION_REORDER : null, false);

    // ═══════════════════════════════════════════════════════════
    //  Final 2 (B): D&D merge operations (2) — REQUIRED
    // ═══════════════════════════════════════════════════════════
    _safeRegister('merge',        typeof CBF_MUTATION_MERGE         !== 'undefined' ? CBF_MUTATION_MERGE         : null, false);
    _safeRegister('mergeFolders', typeof CBF_MUTATION_MERGE_FOLDERS !== 'undefined' ? CBF_MUTATION_MERGE_FOLDERS : null, false);

    // ═══════════════════════════════════════════════════════════
    //  V12E (D-56): Import encrypted (1) — OPTIONAL
    //
    //  Αν το import-encrypted-handler.js αποτύχει να φορτώσει,
    //  ΔΕΝ σπάει το install των άλλων 7 handlers.
    // ═══════════════════════════════════════════════════════════
    _safeRegister(
      'importEncrypted',
      typeof CBF_MUTATION_IMPORT_ENCRYPTED !== 'undefined'
        ? CBF_MUTATION_IMPORT_ENCRYPTED
        : null,
      /* optional */ true
    );

    // ═══════════════════════════════════════════════════════════
    //  Mark as installed — ΠΑΝΤΑ true, ανεξάρτητα από optional failures
    // ═══════════════════════════════════════════════════════════
    installed = true;

    // ═══════════════════════════════════════════════════════════
    //  Summary log
    // ═══════════════════════════════════════════════════════════
    const successCount = _registrationResults.succeeded.length;
    const failedCount = _registrationResults.failed.length;
    const skippedCount = _registrationResults.skipped.length;
    const totalAttempted = _registrationResults.attempted.length;

    if (failedCount === 0 && skippedCount === 0) {
      CBF_LOGGER.info(
        `MutationRegistry: installed (${successCount} handlers — ` +
        `5 core + 2 D&D merge + 1 importEncrypted, stateMAC + Merkle)`
      );
    } else if (failedCount === 0 && skippedCount > 0) {
      CBF_LOGGER.info(
        `MutationRegistry: installed (${successCount}/${totalAttempted} handlers — ` +
        `${skippedCount} optional skipped: ${_registrationResults.skipped.join(', ')})`
      );
    } else {
      CBF_LOGGER.warn(
        `MutationRegistry: installed with issues ` +
        `(${successCount} OK, ${failedCount} failed, ${skippedCount} skipped) — ` +
        `failed: ${_registrationResults.failed.map(f => f.name).join(', ')}`
      );
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    install,
    isInstalled: () => installed,

    _internal: {
      getInstalled: () => installed,

      // V12E.E-01: Diagnostics
      getRegistrationResults: () => ({
        attempted: _registrationResults.attempted.slice(),
        succeeded: _registrationResults.succeeded.slice(),
        failed: _registrationResults.failed.slice(),
        skipped: _registrationResults.skipped.slice()
      }),

      // V12E.E-01: Exposed για testing
      _safeRegister
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_MUTATION_REGISTRY = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MUTATION_REGISTRY = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Mutation Registry ready (v12.0.0: 8 handlers — ' +
      '5 core + 2 D&D merge + 1 importEncrypted)'
    );
  }

  return api;
})();