/**
 * options.js — Options page controller
 *
 * @path     overlay/options/options.js
 * @version  12.3.0
 * @since    v12E / v12.3
 *
 * PURPOSE
 *   Controller για τη σελίδα ρυθμίσεων. Διαχειρίζεται:
 *     • Homepage (save / reset / load)
 *     • Vault status (locked / unlocked / uninitialized)
 *     • Setup vault (createEncrypted)
 *     • Change password (changePassword)
 *     • Unlock (lock screen)
 *     • Strict privacy toggle
 *     • Import favicons
 *
 * ERROR HANDLING (M-05)
 *   • ERROR_MESSAGES whitelist map (code → friendly message)
 *   • friendlyError(code, context) — user-facing message
 *   • logRawError(code, message, context) — console only
 *   Δεν εκθέτουμε internals (stack traces, Argon2 params, file paths).
 *
 * DECISIONS
 *   D-21, D-30
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — SAFE-01 WHITELIST ALIGNMENT
 *   ══════════════════════════════════════════════════════════════════════
 *   SAFE-01 FIX (HIGH): ARGON2_LOW_MEMORY whitelist entry
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Το argon2-loader.js (v12.2) παράγει error code
 *       'ARGON2_LOW_MEMORY' όταν η WASM allocation 64MB αποτύχει
 *       σε low-end hardware. Ο unlock-handler.js και το background.js
 *       το map-άρουν σωστά, ΑΛΛΑ το options.js ERROR_MESSAGES δεν
 *       είχε καταχώρηση → fallback στο _DEFAULT:
 *         "Κάτι πήγε λάθος. Δοκιμάστε ξανά."
 *
 *       Αποτέλεσμα: ο χρήστης δεν καταλάβαινε ότι έπρεπε να
 *       ελευθερώσει RAM.
 *
 *     ΛΥΣΗ:
 *       Προσθήκη 'ARGON2_LOW_MEMORY' στο ERROR_MESSAGES whitelist
 *       (πρώτη θέση στην Argon2 ενότητα για precedence clarity).
 *
 *     Impact:
 *       • Proper UX στο options page (setup/changePassword flow)
 *       • Consistency με unlock-handler + background mappings
 *       • Zero impact σε high-end users (unreachable code path)
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.0.0 → 12.3.0
 *     • Καμία functional αλλαγή πέραν του SAFE-01 whitelist entry
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "options"
 */

(function() {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Options]', ...a); }
  function warn(...a) { console.warn('[ECBF:Options]', ...a); }
  function err(...a)  { console.error('[ECBF:Options]', ...a); }

  // ============================================================
  //  M-05: Error Message Whitelist
  //
  //  Κάθε error code → φιλικό μήνυμα για τον χρήστη.
  //  Δεν περιλαμβάνουμε technical details / internals.
  //
  //  🔧 v12.3.0 SAFE-01: Προστέθηκε ARGON2_LOW_MEMORY.
  //  Θέση: ΠΡΩΤΗ στην Argon2 ενότητα για precedence clarity
  //  (αν και δεν υπάρχει conflict, είναι καλή πρακτική).
  // ============================================================
  const ERROR_MESSAGES = Object.freeze({
    // ═══ Success-like (δεν είναι σφάλματα αλλά χειρίζονται σαν codes) ═══
    'ALREADY_INITIALIZED': 'Ο κρυπτογραφημένος χώρος έχει ήδη δημιουργηθεί.',

    // ═══ Password errors ═══
    'PASSWORD_REQUIRED':        'Εισάγετε κωδικό πρόσβασης.',
    'PASSWORD_TOO_SHORT':       'Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.',
    'PASSWORD_ERROR':           'Σφάλμα στον κωδικό πρόσβασης.',
    'WRONG_PASSWORD':           'Λάθος κωδικός πρόσβασης.',
    'WRONG_OLD_PASSWORD':       'Ο τρέχων κωδικός δεν είναι σωστός.',
    'OLD_PASSWORD_REQUIRED':    'Εισάγετε τον τρέχοντα κωδικό.',
    'MISSING_PASSWORD':         'Συμπληρώστε όλα τα πεδία.',

    // ═══ Vault state ═══
    'LOCKED':                   'Ο κρυπτογραφημένος χώρος είναι κλειδωμένος.',
    'NOT_INITIALIZED':          'Ο κρυπτογραφημένος χώρος δεν έχει δημιουργηθεί ακόμα.',
    'VAULT_TAMPERED':           '⚠️ Ανιχνεύτηκε αλλοίωση δεδομένων. Επικοινωνήστε με υποστήριξη.',
    'VAULT_CORRUPTED':          '⚠️ Ο κρυπτογραφημένος χώρος είναι κατεστραμμένος.',

    // ═══ Argon2 / KDF ═══
    // 🔧 v12.3.0 SAFE-01: low-memory classification (πρώτο για precedence)
    'ARGON2_LOW_MEMORY':        '⚠️ Χρειάζονται τουλάχιστον 64MB ελεύθερης μνήμης για την κρυπτογράφηση.\n\nΚλείστε μερικές καρτέλες και δοκιμάστε ξανά.',
    'ARGON2_NOT_CONFIGURED':    'Σφάλμα διαμόρφωσης ασφαλείας.',
    'ARGON2_INTEGRITY_FAILED':  '⚠️ Αποτυχία επαλήθευσης ακεραιότητας.',
    'ARGON2_WASM_FETCH_FAILED': 'Αποτυχία φόρτωσης μονάδας ασφαλείας.',
    'ARGON2_NOT_LOADED':        'Η μονάδα ασφαλείας δεν έχει φορτωθεί.',
    'ARGON2_WASM_ERROR':        'Σφάλμα μονάδας ασφαλείας.',
    'ARGON2_ERROR':             'Σφάλμα ασφαλείας.',
    'ARGON2_HASH_FAILED':       'Αποτυχία υπολογισμού ασφαλείας.',

    // ═══ Rate limiting ═══
    'RATE_LIMITED':             'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.',
    'COOLDOWN':                 'Περιμένετε πριν δοκιμάσετε ξανά.',

    // ═══ Concurrency ═══
    'BUSY':                     'Μια άλλη ενέργεια είναι σε εξέλιξη. Δοκιμάστε ξανά.',
    'INVALID_STATE':            'Μη έγκυρη κατάσταση. Δοκιμάστε ξανά.',

    // ═══ Generic ═══
    'SETUP_FAILED':             'Η δημιουργία απέτυχε. Δοκιμάστε ξανά.',
    'UNLOCK_FAILED':            'Το ξεκλείδωμα απέτυχε. Δοκιμάστε ξανά.',
    'CHANGE_PASSWORD_FAILED':   'Η αλλαγή κωδικού απέτυχε. Δοκιμάστε ξανά.',
    'CHANGE_PASSWORD_ABORTED':  'Η αλλαγή κωδικού ακυρώθηκε.',
    'ABORTED':                  'Η ενέργεια ακυρώθηκε.',

    // ═══ Network / communication ═══
    'BRIDGE_NOT_CONNECTED':     'Αποσυνδεδεμένη σύνδεση. Δοκιμάστε ξανά.',
    'BRIDGE_DISCONNECTED':      'Η σύνδεση χάθηκε. Δοκιμάστε ξανά.',
    'BRIDGE_SHUTDOWN':          'Η σύνδεση τερματίστηκε. Ανανεώστε τη σελίδα.',
    'HANDLER_ERROR':            'Σφάλμα επικοινωνίας.',

    // ═══ Default ═══
    '_DEFAULT':                 'Κάτι πήγε λάθος. Δοκιμάστε ξανά.'
  });

  /**
   * M-05: friendlyError(code, context)
   *
   * Μετατρέπει error code → φιλικό μήνυμα.
   * Αν το code δεν είναι στο whitelist → default message.
   */
  function friendlyError(code, context = 'generic') {
    if (!code || typeof code !== 'string') {
      return ERROR_MESSAGES._DEFAULT;
    }

    if (ERROR_MESSAGES[code]) {
      return ERROR_MESSAGES[code];
    }

    log(`friendlyError: unknown code "${code}" (context=${context}) → default`);
    return ERROR_MESSAGES._DEFAULT;
  }

  /**
   * M-05: logRawError(code, message, context)
   *
   * Log-άρει το πραγματικό error message στο console (developers),
   * αλλά ΔΕΝ εμφανίζεται στο UI.
   */
  function logRawError(code, message, context) {
    console.warn(
      `[ECBF:Options] RAW_ERROR [${context}] code=${code || 'UNKNOWN'}: ${message || '(no message)'}`
    );
  }

  // ============================================================
  //  Helper functions
  // ============================================================
  function msg(el, text, type = 'ok') {
    if (!el) return;
    el.textContent = text;
    el.className = 'status-message ' + type;
  }
  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  // ============================================================
  //  translatePage — data-i18n attributes → browser.i18n messages
  // ============================================================
  function translatePage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const message = browser.i18n.getMessage(key);
      if (message) el.textContent = message;
    });
  }

  // ============================================================
  //  URL normalization
  //  Δέχεται: `www.example.com` (χωρίς protocol) → https://
  // ============================================================
  function normalizeUrl(raw) {
    if (typeof raw !== 'string') return null;
    let url = raw.trim().replace(/\s+/g, '');
    if (!url) return null;

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      url = url.startsWith('//') ? 'https:' + url : 'https://' + url;
    }

    let parsed;
    try { parsed = new URL(url); }
    catch (_) { return null; }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    if (parsed.hostname.length < 4) return null;

    return parsed.href;
  }

  // ============================================================
  //  Homepage
  // ============================================================
  async function loadSettings() {
    try {
      const res = await browser.runtime.sendMessage({ type: 'getHomepage' });
      if (res && res.success && res.userHomepage) {
        const el = $('homepageUrl');
        if (el) el.value = res.userHomepage;
        log(`Homepage loaded: ${res.userHomepage}`);
      }
    } catch (e) {
      err('loadSettings failed:', e.message);
    }
  }

  const saveBtn = $('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const raw = $('homepageUrl').value;
      if (!raw || !raw.trim()) return alert('Εισάγετε διεύθυνση');

      const url = normalizeUrl(raw);
      if (!url) {
        return alert(
          'Μη έγκυρη διεύθυνση.\n\n' +
          'Παραδείγματα:\n• www.google.com\n• example.com\n• https://www.example.com'
        );
      }

      try {
        const res = await browser.runtime.sendMessage({ type: 'setHomepage', url });
        if (res && res.success) {
          $('homepageUrl').value = url;
          alert('✅ Αποθηκεύτηκε:\n' + url);
          log(`Homepage saved: ${url}`);
        } else {
          alert('Σφάλμα: ' + ((res && res.error) || 'UNKNOWN'));
        }
      } catch (e) {
        alert('Σφάλμα: ' + e.message);
      }
    });
  }

  const resetBtn = $('resetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Να διαγραφούν οι ρυθμίσεις αρχικής σελίδας;')) return;
      try {
        await browser.runtime.sendMessage({ type: 'resetHomepage' });
        $('homepageUrl').value = '';
        alert('✅ Διαγράφηκαν');
        log('Homepage reset');
      } catch (e) {
        alert('Σφάλμα: ' + e.message);
      }
    });
  }

  // ============================================================
  //  Vault status — lock screen routing
  // ============================================================
  async function checkEncryptedStatusAndShowContent() {
    const mainContent = $('mainContent');
    const lockScreen = $('lockScreen');
    const securityBanner = $('securityBanner');
    const createSection = $('createEncryptedSection');
    const changeSection = $('changePasswordSection');

    // Default: mainContent ΟΡΑΤΟ, τα υπόλοιπα hidden
    show(mainContent);
    hide(lockScreen);
    hide(securityBanner);
    hide(createSection);
    hide(changeSection);

    let status;
    try {
      status = await browser.runtime.sendMessage({ type: 'getStatus' });
    } catch (err2) {
      err('getStatus failed:', err2.message);
      return;
    }

    if (!status) return;

    const initialized = status.initialized === true;
    const unlocked = status.unlocked === true;

    log(`Vault status: initialized=${initialized}, unlocked=${unlocked}`);

    // Locked → lock screen
    if (initialized && !unlocked) {
      hide(mainContent);
      show(lockScreen);
      return;
    }

    // Ξεκλείδωτο ή uninitialized → main content
    show(securityBanner);

    if (!initialized) {
      const txt = $('securityBannerText');
      if (txt) txt.textContent =
        'Δεν έχετε δημιουργήσει κρυπτογραφημένο χώρο. Μπορείτε να δημιουργήσετε παρακάτω.';
      show(createSection);
      hide(changeSection);
    } else {
      const txt = $('securityBannerText');
      if (txt) txt.textContent =
        'Ασφαλής σελίδα — Τα δεδομένα παραμένουν τοπικά στον Firefox';
      hide(createSection);
      show(changeSection);
    }
  }

  // ============================================================
  //  Create vault (M-05: friendly errors)
  // ============================================================
  const createBtn = $('createEncryptedBtn');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const password = $('newEncryptedPassword').value;
      const confirmPassword = $('confirmNewEncryptedPassword').value;
      const statusEl = $('createEncryptedStatus');

      // Local validation
      if (!password || !confirmPassword) {
        return msg(statusEl, friendlyError('MISSING_PASSWORD', 'setup'), 'error');
      }
      if (password.length < 6) {
        return msg(statusEl, friendlyError('PASSWORD_TOO_SHORT', 'setup'), 'error');
      }
      if (password !== confirmPassword) {
        return msg(statusEl, 'Οι κωδικοί δεν ταιριάζουν.', 'error');
      }

      createBtn.disabled = true;
      log('setup: sending request to background');

      try {
        const res = await browser.runtime.sendMessage({ type: 'setupSimple', password });
        if (res && res.success) {
          log('setup: SUCCESS');
          msg(statusEl, 'Ο κρυπτογραφημένος χώρος δημιουργήθηκε!', 'ok');
          $('newEncryptedPassword').value = '';
          $('confirmNewEncryptedPassword').value = '';
          await checkEncryptedStatusAndShowContent();
        } else {
          // M-05: friendly error (όχι raw message)
          const code = res && res.error;
          const rawMessage = res && res.message;

          logRawError(code, rawMessage, 'setup');
          msg(statusEl, friendlyError(code, 'setup'), 'error');
        }
      } catch (e) {
        err('setup exception:', e.message);
        msg(statusEl, friendlyError('HANDLER_ERROR', 'setup'), 'error');
      } finally {
        createBtn.disabled = false;
      }
    });
  }

  // ============================================================
  //  Change password (M-05: friendly errors)
  // ============================================================
  const changePwdBtn = $('changePasswordBtn');
  if (changePwdBtn) {
    changePwdBtn.addEventListener('click', async () => {
      const statusEl = $('changePasswordStatus');
      const oldPassword = $('oldPassword').value;
      const newPassword = $('newPassword').value;
      const confirmNewPassword = $('confirmNewPassword').value;

      // Local validation
      if (!oldPassword || !newPassword || !confirmNewPassword) {
        return msg(statusEl, friendlyError('MISSING_PASSWORD', 'change-password'), 'error');
      }
      if (newPassword.length < 6) {
        return msg(statusEl, friendlyError('PASSWORD_TOO_SHORT', 'change-password'), 'error');
      }
      if (newPassword !== confirmNewPassword) {
        return msg(statusEl, 'Οι νέοι κωδικοί δεν ταιριάζουν.', 'error');
      }

      changePwdBtn.disabled = true;
      log('changePassword: sending request to background');

      try {
        const res = await browser.runtime.sendMessage({
          type: 'changePasswordSimple',
          oldPassword, newPassword
        });
        if (res && res.success) {
          log('changePassword: SUCCESS');
          msg(statusEl, 'Ο κωδικός άλλαξε επιτυχώς!', 'ok');
          $('oldPassword').value = '';
          $('newPassword').value = '';
          $('confirmNewPassword').value = '';
        } else {
          // M-05: friendly error
          const code = res && res.error;
          const rawMessage = res && res.message;

          logRawError(code, rawMessage, 'change-password');
          msg(statusEl, friendlyError(code, 'change-password'), 'error');
        }
      } catch (e) {
        err('changePassword exception:', e.message);
        msg(statusEl, friendlyError('HANDLER_ERROR', 'change-password'), 'error');
      } finally {
        changePwdBtn.disabled = false;
      }
    });
  }

  // ============================================================
  //  Unlock screen (M-05: friendly errors)
  // ============================================================
  const unlockBtn = $('unlockBtn');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', async () => {
      const password = $('unlockPassword').value;
      const statusEl = $('unlockStatus');

      if (!password) {
        return msg(statusEl, friendlyError('PASSWORD_REQUIRED', 'unlock'), 'error');
      }

      unlockBtn.disabled = true;
      log('unlock: sending request to background');

      try {
        const res = await browser.runtime.sendMessage({ type: 'unlockSimple', password });
        if (res && res.success) {
          log('unlock: SUCCESS');
          $('unlockPassword').value = '';
          msg(statusEl, '', 'ok');
          await checkEncryptedStatusAndShowContent();
        } else {
          // M-05: friendly error
          const code = res && res.error;
          const rawMessage = res && res.message;

          logRawError(code, rawMessage, 'unlock');
          msg(statusEl, friendlyError(code, 'unlock'), 'error');
        }
      } catch (e) {
        err('unlock exception:', e.message);
        msg(statusEl, friendlyError('HANDLER_ERROR', 'unlock'), 'error');
      } finally {
        unlockBtn.disabled = false;
      }
    });
  }

  // ============================================================
  //  strictPrivacy toggle
  // ============================================================
  async function loadStrictPrivacy() {
    try {
      const res = await browser.runtime.sendMessage({ type: 'getStrictPrivacySimple' });
      if (res && res.success) {
        const el = $('strictPrivacyToggle');
        if (el) el.checked = res.strictPrivacy === true;
        log(`strictPrivacy loaded: ${res.strictPrivacy}`);
      }
    } catch (e) {
      err('loadStrictPrivacy failed:', e.message);
    }
  }

  const privacyToggle = $('strictPrivacyToggle');
  if (privacyToggle) {
    privacyToggle.addEventListener('change', async (e) => {
      const value = e.target.checked;
      const statusEl = $('strictPrivacyStatus');
      try {
        const res = await browser.runtime.sendMessage({
          type: 'setStrictPrivacySimple',
          value
        });
        if (res && res.success) {
          msg(statusEl, value ? 'Ενεργοποιήθηκε.' : 'Απενεργοποιήθηκε.', 'ok');
          log(`strictPrivacy set: ${value}`);
        } else {
          msg(statusEl, friendlyError(res?.error, 'strict-privacy'), 'error');
          e.target.checked = !value;
        }
      } catch (err2) {
        msg(statusEl, friendlyError('HANDLER_ERROR', 'strict-privacy'), 'error');
        e.target.checked = !value;
      }
    });
  }

  // ============================================================
  //  Import favicons
  // ============================================================
  const importBtn = $('importBtn');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      const fileInput = $('importFile');
      const statusEl = $('importStatus');
      const file = fileInput.files[0];

      if (!file) return msg(statusEl, 'Επιλέξτε αρχείο JSON.', 'error');

      try {
        const text = await file.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) { return msg(statusEl, 'Μη έγκυρο JSON.', 'error'); }

        const items = [];
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const [hostname, entry] of Object.entries(data)) {
            if (!entry) continue;
            let dataUrl = null, color = null;
            if (typeof entry === 'string') dataUrl = entry;
            else if (entry && typeof entry === 'object') {
              dataUrl = entry.dataUrl || null;
              color = entry.color || null;
            }
            if (dataUrl) items.push({ url: `https://${hostname}`, dataUrl, color });
          }
        } else if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry && entry.url && entry.dataUrl) items.push(entry);
          }
        }
        if (items.length === 0) {
          return msg(statusEl, 'Δεν βρέθηκαν έγκυρα δεδομένα.', 'error');
        }

        const res = await browser.runtime.sendMessage({ type: 'importFaviconsSimple', items });
        if (res && res.success) {
          msg(statusEl, `Εισήχθησαν ${res.importedCount} favicons!`, 'ok');
          log(`Favicons imported: ${res.importedCount}`);
        } else {
          msg(statusEl, 'Σφάλμα εισαγωγής.', 'error');
        }
      } catch (e) {
        err('import exception:', e.message);
        msg(statusEl, 'Σφάλμα: ' + e.message, 'error');
      }
    });
  }

  // ============================================================
  //  Init
  // ============================================================
  (async function init() {
    log('Options page init (v12.3.0)');
    translatePage();
    await loadSettings();
    await loadStrictPrivacy();
    await checkEncryptedStatusAndShowContent();
    log('Options page READY (v12.3.0)');
  })();

})();