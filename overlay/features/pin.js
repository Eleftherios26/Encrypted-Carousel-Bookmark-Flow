/**
 * pin.js — Feature: Pin manager (per-space)
 *
 * @path     overlay/features/pin.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Pin-άρει έναν φάκελο per-space (firefox ≠ encrypted) και παρέχει
 *   γρήγορη πλοήγηση πίσω σε αυτόν. Το pin είναι persistent (storage.local)
 *   και εμφανίζεται ως label δίπλα στο pin-btn.
 *
 * STORAGE MODEL
 *   Key:   `cbf_pin_<space>`  (π.χ. `cbf_pin_firefox`, `cbf_pin_encrypted`)
 *   Value: { id: string, title: string } | null (removed)
 *
 * BEHAVIOR
 *   • Pin btn click → toggle (v1.5.5: unpin-anywhere semantics)
 *   • Pin label click → navigate to pinned folder
 *   • Pin btn ALWAYS active όταν υπάρχει pin (v12.4 semantics)
 *   • Auto-unpin σε folder delete (v1.5.2)
 *   • Auto-unpin σε cross-space transfer (v1.5.4)
 *
 * PUBLIC API
 *   • init(container, shadowRoot)
 *   • loadPinState()           — v1.5.1: restore on overlay open
 *   • onFoldersDeleted(ids)    — v1.5.2: auto-unpin on delete
 *   • onItemTransferred(s,id)  — v1.5.4: auto-unpin on cross-space
 *   • toggle()                 — v1.5.5: unpin-anywhere
 *   • navigate()
 *   • updateUI()
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "pin"
 */

var CBF_FEATURE_PIN = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:Pin]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:Pin]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:Pin]', ...a); }

  // ============================================================
  //  State
  // ============================================================
  let pinBtn = null;
  let pinLabel = null;
  let pinLabelText = null;
  let initialized = false;

  // ============================================================
  //  Storage helpers
  // ============================================================
  function _storageKey() {
    const space = (typeof CBF_UI !== 'undefined' && typeof CBF_UI.getActiveSpace === 'function')
      ? CBF_UI.getActiveSpace()
      : 'firefox';
    return `cbf_pin_${space}`;
  }

  async function _load() {
    try {
      const key = _storageKey();
      const res = await browser.storage.local.get(key);
      return res[key] || null;
    } catch (e) {
      warn('load failed:', e.message);
      return null;
    }
  }

  async function _save(pin) {
    try {
      const key = _storageKey();
      if (pin) {
        await browser.storage.local.set({ [key]: pin });
      } else {
        await browser.storage.local.remove(key);
      }
    } catch (e) {
      warn('save failed:', e.message);
    }
  }

  // ============================================================
  //  UI update
  //
  //  v12.4 SEMANTICS:
  //    pinBtn.active = TRUE ΠΑΝΤΑ όταν υπάρχει pin
  //    pinLabel      = δείχνει τον pinned folder
  //    Tooltip       = contextual (αλλά active state ίδιο)
  // ============================================================
  async function updateUI() {
    if (!pinLabel || !pinBtn) return;

    const pin = await _load();
    const currentId = (typeof CBF_UI !== 'undefined' && typeof CBF_UI.getCurrentFolderId === 'function')
      ? CBF_UI.getCurrentFolderId()
      : null;

    if (pin) {
      if (pinLabelText) pinLabelText.textContent = pin.title || pin.id;
      pinLabel.classList.add('visible');

      // v1.5.0: ΠΑΝΤΑ active όταν υπάρχει pin
      pinBtn.classList.add('active');

      const isCurrentFolderPinned = (pin.id === currentId);
      pinBtn.setAttribute('title',
        isCurrentFolderPinned
          ? 'Ξεκαρφίτσωμα φακέλου'
          : 'Ξεκαρφίτσωμα (είναι pinned άλλος φάκελος)');
    } else {
      if (pinLabelText) pinLabelText.textContent = '';
      pinLabel.classList.remove('visible');
      pinBtn.classList.remove('active');
      pinBtn.setAttribute('title', 'Καρφίτσωμα φακέλου');
    }
  }

  // ============================================================
  //  v1.5.1: loadPinState — restore pin on overlay open
  // ============================================================
  async function loadPinState() {
    try {
      const pin = await _load();

      if (!pin || !pin.id) {
        log('loadPinState: no pin for current space');
        await updateUI();
        return null;
      }

      log(`loadPinState: restored "${pin.title}" (${pin.id.slice(0, 8)})`);
      await updateUI();

      return { id: pin.id, title: pin.title };
    } catch (e) {
      warn('loadPinState failed:', e.message);
      return null;
    }
  }

  // ============================================================
  //  v1.5.2: onFoldersDeleted — auto-unpin on delete
  // ============================================================
  async function onFoldersDeleted(idsOrId) {
    const ids = Array.isArray(idsOrId) ? idsOrId : [idsOrId];
    if (ids.length === 0) return false;

    const validIds = ids.filter(id => typeof id === 'string' && id.length > 0);
    if (validIds.length === 0) return false;

    let pin;
    try {
      pin = await _load();
    } catch (e) {
      warn('onFoldersDeleted: _load failed:', e.message);
      return false;
    }

    if (!pin || !pin.id) return false;
    if (!validIds.includes(pin.id)) return false;

    try {
      await _save(null);
      await updateUI();
      log(
        `Auto-unpinned (folder deleted): "${pin.title}" ` +
        `(${pin.id.slice(0, 8)}) — was in [${validIds.length} deleted ids]`
      );
      return true;
    } catch (e) {
      warn('onFoldersDeleted: unpin failed:', e.message);
      return false;
    }
  }

  // ============================================================
  //  v1.5.4: onItemTransferred — auto-unpin on cross-space move
  //
  //  Όταν ένα pinned item μεταφέρεται σε άλλο space (cross-space
  //  transfer), το id αλλάζει (νέο record στο target). Το source-space
  //  pin ΠΡΕΠΕΙ να διαγραφεί.
  // ============================================================
  async function onItemTransferred(sourceSpace, itemId) {
    if (sourceSpace !== 'firefox' && sourceSpace !== 'encrypted') return false;
    if (typeof itemId !== 'string' || itemId.length === 0) return false;

    const key = `cbf_pin_${sourceSpace}`;

    let pin;
    try {
      const res = await browser.storage.local.get(key);
      pin = res[key];
    } catch (e) {
      warn('onItemTransferred: storage read failed:', e.message);
      return false;
    }

    if (!pin || !pin.id) return false;
    if (pin.id !== itemId) return false;

    try {
      await browser.storage.local.remove(key);
    } catch (e) {
      warn('onItemTransferred: remove failed:', e.message);
      return false;
    }

    try {
      const currentSpace = (typeof CBF_UI !== 'undefined' && typeof CBF_UI.getActiveSpace === 'function')
        ? CBF_UI.getActiveSpace()
        : 'firefox';
      if (currentSpace === sourceSpace) {
        await updateUI();
      }
    } catch (_) {}

    log(`Auto-unpinned (cross-space move): "${pin.title}" (${pin.id.slice(0, 8)}) from ${sourceSpace}`);
    return true;
  }

  // ============================================================
  //  v1.5.5: Toggle pin — unpin-anywhere semantics
  //
  //  Logic:
  //    if (existing pin) → unpin (ΟΠΟΙΟΔΗΠΟΤΕ id)
  //    else              → pin current folder
  //
  //  Rationale:
  //    Το pin button είναι ALWAYS-active όταν υπάρχει pin (v1.5.0).
  //    Ο χρήστης βλέπει "κάτι καρφιτσωμένο" → κλικ → unpin.
  //    ΔΕΝ περιμένει "pin-άρε το τρέχον".
  // ============================================================
  async function toggle() {
    if (typeof CBF_UI === 'undefined') return;

    const currentId = CBF_UI.getCurrentFolderId();
    if (!currentId) {
      warn('toggle: no current folder');
      return;
    }

    const existing = await _load();

    // v1.5.5: Αν υπάρχει pin → UNPIN (ανεξάρτητα από current)
    if (existing && existing.id) {
      await _save(null);
      log(`Unpinned "${existing.title}" (${existing.id.slice(0, 8)}) [was pinned, current=${currentId.slice(0, 8)}]`);
      await updateUI();
      return;
    }

    // Δεν υπάρχει pin → PIN current folder
    let title = currentId;
    try {
      const path = CBF_UI.getBreadcrumbPath();
      if (Array.isArray(path) && path.length > 0) {
        const last = path[path.length - 1];
        if (last && last.title) title = last.title;
      }
    } catch (_) {}

    await _save({ id: currentId, title });
    log(`Pinned "${title}" (${currentId.slice(0, 8)})`);
    await updateUI();
  }

  // ============================================================
  //  Navigate to pinned folder
  // ============================================================
  async function navigate() {
    if (typeof CBF_UI === 'undefined') return;

    const pin = await _load();
    if (!pin || !pin.id) {
      warn('navigate: no pin');
      return;
    }

    if (pin.id === CBF_UI.getCurrentFolderId()) {
      log('Already in pinned folder — no-op');
      return;
    }

    log(`Navigating to "${pin.title}" (${pin.id.slice(0, 8)})`);

    try {
      CBF_UI.resetNavSeq();
      if (typeof CBF_UI.clearSelection === 'function') {
        CBF_UI.clearSelection();
      }
      CBF_UI.setCurrentFolderId(pin.id);
      await CBF_UI.navigateToFolder(pin.id);
    } catch (e) {
      err('Navigate failed:', e.message);
    }
  }

  // ============================================================
  //  Init — καλείται από content-overlay.js bootstrap
  // ============================================================
  function init(container, shadowRoot) {
    if (initialized) {
      warn('init: already initialized');
      return true;
    }

    if (!container) {
      warn('init: container required');
      return false;
    }

    pinBtn = container.querySelector('#cbf-pin-folder');
    pinLabel = container.querySelector('#cbf-pin-label');
    pinLabelText = container.querySelector('#cbf-pin-label-text');

    if (!pinBtn) {
      warn('init: #cbf-pin-folder not found');
      return false;
    }

    // Wire pin button (toggle pin)
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle().catch(err => warn('Toggle failed:', err.message));
    });
    pinBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    // Wire pin label (navigate to pinned folder)
    if (pinLabel) {
      pinLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        navigate().catch(err => warn('Navigate failed:', err.message));
      });
      pinLabel.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // Subscribe to navigation events
    if (typeof CBF_UI.onNavigate === 'function') {
      CBF_UI.onNavigate(() => {
        updateUI().catch(() => {});
      });
    }

    initialized = true;
    log('initialized (per-space pin + unpin-anywhere toggle + navigate on label click + ALWAYS-active btn + auto-unpin on delete + auto-unpin on cross-space move)');

    // Initial UI state (will be overwritten by loadPinState)
    updateUI().catch(() => {});
    return true;
  }

  // ============================================================
  //  Destroy
  // ============================================================
  function destroy() {
    if (!initialized) return;
    pinBtn = null;
    pinLabel = null;
    pinLabelText = null;
    initialized = false;
    log('destroyed');
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    updateUI,
    loadPinState,
    onFoldersDeleted,
    onItemTransferred,
    toggle,
    navigate,
    _internal: {
      _storageKey,
      _load,
      _save,
      isInitialized: () => initialized
    }
  };

  if (typeof window !== 'undefined')     window.CBF_FEATURE_PIN = api;
  if (typeof self !== 'undefined')       self.CBF_FEATURE_PIN = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_PIN = api;

  log('Ready (v12.0.0 — per-space pin + unpin-anywhere toggle + ALWAYS-active btn + auto-navigate on open + auto-unpin on delete + auto-unpin on cross-space move)');
  return api;
})();