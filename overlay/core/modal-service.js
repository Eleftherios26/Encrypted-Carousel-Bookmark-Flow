/**
 * modal-service.js — Modal service (Shadow DOM aware)
 *
 * @path     overlay/core/modal-service.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Δημιουργεί modals (prompt, confirm, alert, choice) μέσα στο
 *   closed Shadow DOM του overlay. Παρέχει keyboard event isolation
 *   (C-5) ώστε τα keydown events να μην διαρρέουν στο document.
 *
 * MODALS
 *   • promptForText(title, placeholder)
 *   • promptForPassword(title, confirmField)
 *   • promptForBookmark()           ← Post-MVP Feature
 *   • showConfirm(message)
 *   • showAlert(title, message)
 *   • showChoice(title, choices)
 *
 * KEYBOARD ISOLATION (C-5)
 *   • Όλα τα modals χρησιμοποιούν createOverlay() που κάνει
 *     stopPropagation σε keydown events
 *   • Αποτρέπει shadow DOM retargeting issues
 *   • Όταν ένα modal είναι ανοιχτό, ο χρήστης αλληλεπιδρά ΜΟΝΟ με αυτό
 *
 * DECISIONS
 *   D-13.1, D-49
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "modal-service"
 */

var CBF_MODAL_SERVICE = (function() {
  'use strict';

  // ============================================================
  //  Container (shadow root)
  // ============================================================
  let _shadowRoot = null;

  // Active modals tracking (για cancelAll)
  const _activeModals = new Set();

  function setContainer(shadowRoot) {
    if (shadowRoot && typeof shadowRoot.appendChild === 'function') {
      _shadowRoot = shadowRoot;
    }
  }

  function getContainer() {
    return _shadowRoot || document.body;
  }

  // ============================================================
  //  DOM helpers
  // ============================================================

  /**
   * createOverlay — C-5 keyboard isolation.
   *
   *  1. Δημιουργεί το overlay div
   *  2. Attach keydown listener (bubble phase) που κάνει stopPropagation
   *  3. Έτσι τα keydown events ΔΕΝ φτάνουν στο document listener
   *     (αποτρέπει shadow DOM retargeting issues)
   */
  function createOverlay() {
    const o = document.createElement('div');
    o.className = 'cbf-modal-overlay';

    // C-5: Isolate keyboard events από το document
    o.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });

    return o;
  }

  function createModal() {
    const m = document.createElement('div');
    m.className = 'cbf-modal';
    return m;
  }

  function createHeading(text) {
    const h = document.createElement('h3');
    h.textContent = text;
    return h;
  }

  function createButton(label, style = 'default') {
    const b = document.createElement('button');
    b.className = 'cbf-modal-btn';
    if (style === 'primary') b.classList.add('primary');
    if (style === 'danger')  b.classList.add('danger');
    b.textContent = label;
    return b;
  }

  function createButtonRow() {
    const r = document.createElement('div');
    r.className = 'cbf-modal-buttons';
    return r;
  }

  // ============================================================
  //  Active modal registration (B-7)
  // ============================================================
  function _register(overlay, resolve) {
    const entry = { overlay, resolve };
    _activeModals.add(entry);
    return entry;
  }

  function _unregister(entry) {
    if (entry) _activeModals.delete(entry);
  }

  // ============================================================
  //  cancelAll — B-7: cancel all active modals (overlay close)
  // ============================================================
  function cancelAll() {
    const count = _activeModals.size;
    if (count === 0) return 0;

    const entries = Array.from(_activeModals);
    _activeModals.clear();

    for (const entry of entries) {
      try {
        if (typeof entry.resolve === 'function') {
          entry.resolve(null);
        }
      } catch (_) {}

      try {
        if (entry.overlay && entry.overlay.parentNode) {
          entry.overlay.parentNode.removeChild(entry.overlay);
        }
      } catch (_) {}
    }

    if (typeof CBF_LOGGER !== 'undefined') {
      CBF_LOGGER.info(`[MODAL] cancelAll: ${count} modal(s) cancelled`);
    } else {
      console.log(`[ECBF:Modal] cancelAll: ${count} modal(s) cancelled`);
    }

    return count;
  }

  function activeCount() {
    return _activeModals.size;
  }

  // ============================================================
  //  promptForText
  // ============================================================
  function promptForText(title, placeholder = '') {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      modal.appendChild(createHeading(title));

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder || '';
      modal.appendChild(input);

      const btnRow = createButtonRow();
      const cancel = createButton('Άκυρο', 'default');
      const ok     = createButton('OK', 'primary');

      const entry = _register(overlay, resolve);

      const done = (value) => {
        _unregister(entry);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      };

      cancel.addEventListener('click', () => done(null));
      ok.addEventListener('click', () => done(input.value));

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); done(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });

      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);

      setTimeout(() => input.focus(), 0);
    });
  }

  // ============================================================
  //  promptForPassword
  // ============================================================
  function promptForPassword(title, confirmField = false) {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      modal.appendChild(createHeading(title));

      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Κωδικός πρόσβασης';
      input.autocomplete = 'off';
      modal.appendChild(input);

      let confirmInput = null;
      if (confirmField) {
        confirmInput = document.createElement('input');
        confirmInput.type = 'password';
        confirmInput.placeholder = 'Επιβεβαίωση κωδικού';
        confirmInput.autocomplete = 'off';
        modal.appendChild(confirmInput);
      }

      const err = document.createElement('div');
      err.className = 'cbf-modal-error';
      err.textContent = 'Οι κωδικοί δεν ταιριάζουν.';
      modal.appendChild(err);

      const btnRow = createButtonRow();
      const cancel = createButton('Άκυρο', 'default');
      const ok     = createButton('OK', 'primary');

      const entry = _register(overlay, resolve);

      const done = (value) => {
        _unregister(entry);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      };

      const trySubmit = () => {
        const pw = input.value;
        if (!pw) { input.focus(); return; }
        if (confirmField && pw !== confirmInput.value) {
          err.style.display = 'block';
          confirmInput.focus();
          return;
        }
        done(pw);
      };

      cancel.addEventListener('click', () => done(null));
      ok.addEventListener('click', trySubmit);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); trySubmit(); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });

      if (confirmInput) {
        confirmInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter')  { e.preventDefault(); trySubmit(); }
          if (e.key === 'Escape') { e.preventDefault(); done(null); }
        });
      }

      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);

      setTimeout(() => input.focus(), 0);
    });
  }

  // ============================================================
  //  promptForBookmark — Post-MVP Feature
  //
  //  Modal με δύο fields (Title + URL) για δημιουργία σελιδοδείκτη.
  //
  //  Validation:
  //    - Title: required, non-empty
  //    - URL:   required, must start with http:// or https://
  //
  //  Keyboard:
  //    - Title: Enter → focus URL, Escape → cancel
  //    - URL:   Enter → submit,    Escape → cancel
  //
  //  @returns {Promise<{title: string, url: string}|null>}
  // ============================================================
  function promptForBookmark() {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      modal.appendChild(createHeading('Νέος σελιδοδείκτης'));

      // --- Title ---
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.placeholder = 'Τίτλος';
      titleInput.autocomplete = 'off';
      titleInput.spellcheck = false;
      modal.appendChild(titleInput);

      // --- URL ---
      const urlInput = document.createElement('input');
      urlInput.type = 'url';
      urlInput.placeholder = 'https://example.com';
      urlInput.autocomplete = 'off';
      urlInput.spellcheck = false;
      modal.appendChild(urlInput);

      // --- Error (hidden by default) ---
      const err = document.createElement('div');
      err.className = 'cbf-modal-error';
      err.style.display = 'none';
      modal.appendChild(err);

      // --- Buttons ---
      const btnRow = createButtonRow();
      const cancel = createButton('Άκυρο', 'default');
      const ok     = createButton('Δημιουργία', 'primary');

      const entry = _register(overlay, resolve);

      const done = (value) => {
        _unregister(entry);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      };

      const showError = (msg) => {
        err.textContent = msg;
        err.style.display = 'block';
      };

      const trySubmit = () => {
        const title = titleInput.value.trim();
        const url   = urlInput.value.trim();

        if (!title) {
          showError('Ο τίτλος είναι υποχρεωτικός.');
          titleInput.focus();
          return;
        }
        if (!url) {
          showError('Το URL είναι υποχρεωτικό.');
          urlInput.focus();
          return;
        }
        if (!/^https?:\/\//i.test(url)) {
          showError('Το URL πρέπει να αρχίζει με http:// ή https://');
          urlInput.focus();
          return;
        }

        done({ title, url });
      };

      cancel.addEventListener('click', () => done(null));
      ok.addEventListener('click', trySubmit);

      // --- Keyboard handling ---
      titleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); urlInput.focus(); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });

      urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); trySubmit(); }
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
      });

      // --- Mount ---
      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);

      setTimeout(() => titleInput.focus(), 0);
    });
  }

  // ============================================================
  //  showConfirm
  // ============================================================
  function showConfirm(message) {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      const p = document.createElement('p');
      p.textContent = message;
      p.style.cssText = 'margin:0 0 16px 0;font-size:14px;text-align:center;';
      modal.appendChild(p);

      const btnRow = createButtonRow();
      btnRow.style.justifyContent = 'center';

      const cancel = createButton('Ακύρωση', 'default');
      const ok     = createButton('OK', 'primary');

      const entry = _register(overlay, resolve);

      cancel.addEventListener('click', () => {
        _unregister(entry);
        overlay.remove();
        resolve(false);
      });
      ok.addEventListener('click', () => {
        _unregister(entry);
        overlay.remove();
        resolve(true);
      });

      // C-5: Escape → cancel
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          _unregister(entry);
          overlay.remove();
          resolve(false);
        }
      });

      btnRow.appendChild(cancel);
      btnRow.appendChild(ok);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);
    });
  }

  // ============================================================
  //  showAlert
  // ============================================================
  function showAlert(title, message) {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      modal.appendChild(createHeading(title));

      const p = document.createElement('p');
      p.textContent = message;
      p.style.cssText = 'margin:0 0 16px 0;font-size:14px;text-align:center;';
      modal.appendChild(p);

      const btnRow = createButtonRow();
      btnRow.style.justifyContent = 'center';

      const ok = createButton('OK', 'primary');

      const entry = _register(overlay, resolve);

      ok.addEventListener('click', () => {
        _unregister(entry);
        overlay.remove();
        resolve();
      });

      // C-5: Escape / Enter → close
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          e.preventDefault();
          _unregister(entry);
          overlay.remove();
          resolve();
        }
      });

      btnRow.appendChild(ok);
      modal.appendChild(btnRow);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);
    });
  }

  // ============================================================
  //  showChoice
  // ============================================================
  function showChoice(title, choices) {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = createModal();

      modal.appendChild(createHeading(title));

      const col = document.createElement('div');
      col.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

      const entry = _register(overlay, resolve);

      if (Array.isArray(choices)) {
        for (const choice of choices) {
          const b = createButton(choice.label, choice.style || 'default');
          b.style.width = '100%';
          b.addEventListener('click', () => {
            _unregister(entry);
            overlay.remove();
            resolve(choice.value);
          });
          col.appendChild(b);
        }
      }

      // C-5: Escape → cancel (resolve null)
      overlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          _unregister(entry);
          overlay.remove();
          resolve(null);
        }
      });

      modal.appendChild(col);
      overlay.appendChild(modal);
      getContainer().appendChild(overlay);
    });
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    setContainer,
    promptForText,
    promptForPassword,
    promptForBookmark,
    showConfirm,
    showAlert,
    showChoice,

    // B-7
    cancelAll,
    activeCount,

    // Diagnostics
    _internal: {
      _activeModals,
      _register,
      _unregister
    }
  };

  // Legacy aliases
  if (typeof window !== 'undefined') {
    window.CBF_MODAL_SERVICE = api;
    window.CBF_Overlay_promptForText     = promptForText;
    window.CBF_Overlay_promptForPassword = promptForPassword;
    window.CBF_Overlay_promptForBookmark = promptForBookmark;
    window.CBF_Overlay_showConfirm       = showConfirm;
    window.CBF_Overlay_showAlert         = showAlert;
    window.CBF_Overlay_showChoice        = showChoice;
    window.CBF_Overlay_cancelAllModals   = cancelAll;
  }
  if (typeof self !== 'undefined') self.CBF_MODAL_SERVICE = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MODAL_SERVICE = api;

  console.log('[ECBF:Modal] Ready (v12.0.0 — C-5 keyboard isolation + B-7 cancelAll + promptForBookmark)');

  return api;
})();