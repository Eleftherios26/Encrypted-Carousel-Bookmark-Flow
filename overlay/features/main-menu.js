/**
 * main-menu.js — Main menu ☰ (7 items, V12E)
 *
 * @path     overlay/features/main-menu.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   V12E feature. Κύριο μενού (☰) με 7 items:
 *     1. 📁 Εξαγωγή σελιδοδεικτών        → exportBookmarks
 *     2. 🖼️ Εξαγωγή favicons             → exportFavicons
 *     3. 🔒 Εξαγωγή encrypted (backup)   → exportEncryptedBackup
 *     4. 📄 Εξαγωγή encrypted (plain)    → exportEncryptedPlain (dangerous)
 *     5. 📥 Εισαγωγή στον encrypted      → importEncrypted
 *     6. ⚡ Performance mode             → togglePerformanceMode
 *     7. ⚙️ Περισσότερες ρυθμίσεις       → openOptionsPage
 *
 * KEY CONCEPTS
 *   • V12E.E-05a: openOptionsPage fallback chain
 *     (bridge → runtime.sendMessage → direct API)
 *   • V12E.E-05b-fix: _stripLeadingIcon() αφαιρεί leading emoji
 *     από i18n strings (αποφυγή διπλών εικονιδίων)
 *   • V12E.E-05b: Ξεχωριστά spans για icon + label
 *   • D-54: Menu keyboard isolation (stopPropagation + Escape)
 *   • Coordination: κλείνει το context menu αν ανοιχτό
 *
 * DECISIONS
 *   D-51, D-52, D-53, D-54, D-55, D-56
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "main-menu"
 */

var CBF_FEATURE_MAIN_MENU = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MENU_WIDTH = 280;
  const MENU_MAX_HEIGHT = 320;
  const MAX_FILE_SIZE = 5 * 1024 * 1024;

  // ============================================================
  //  State
  // ============================================================
  let container = null;
  let shadowRoot = null;
  let menuBtn = null;
  let menuEl = null;

  let isOpen = false;
  let isInitialized = false;
  let _actionInProgress = false;

  let _documentClickHandler = null;
  let _documentKeydownHandler = null;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:MainMenu]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:MainMenu]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:MainMenu]', ...a); }

  // ============================================================
  //  Guards
  // ============================================================
  function _isActionInProgress() {
    if (_actionInProgress) return true;
    if (typeof CBF_UI === 'undefined' || !CBF_UI._internal) return false;
    const fn = CBF_UI._internal.isActionInProgress;
    return typeof fn === 'function' ? fn() === true : false;
  }

  function _isSpaceTransitionInProgress() {
    if (typeof window === 'undefined') return false;
    const fn = window.CBF_Overlay_isSpaceTransitionInProgress;
    if (typeof fn !== 'function') return false;
    try {
      return fn() === true;
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  //  i18n helper
  // ============================================================
  function _t(key, fallback) {
    try {
      if (typeof browser !== 'undefined' && browser.i18n) {
        const msg = browser.i18n.getMessage(key);
        if (msg) return msg;
      }
    } catch (_) {}
    return fallback;
  }

  // ============================================================
  //  V12E.E-05b-fix: Strip leading emoji/whitespace
  //
  //  Το locale μπορεί να έχει emoji (π.χ. "📁 Εξαγωγή..."), αλλά το
  //  emoji τώρα ζει στο ξεχωριστό <span class="cbf-menu-item-icon">.
  //  Χωρίς αυτό → διπλά εικονίδια.
  // ============================================================
  function _stripLeadingIcon(str) {
    if (typeof str !== 'string') return '';
    return str
      // 1. Leading whitespace/BOM
      .replace(/^[\s\uFEFF]+/, '')
      // 2. Leading emoji sequence (Extended_Pictographic + variations + ZWJ + keycap)
      .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]+\s*/u, '');
  }

  // ============================================================
  //  Modal helpers
  // ============================================================
  async function _showConfirm(message) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.showConfirm === 'function') {
      return await CBF_MODAL_SERVICE.showConfirm(message);
    }
    if (typeof window !== 'undefined' &&
        typeof window.CBF_Overlay_showConfirm === 'function') {
      return await window.CBF_Overlay_showConfirm(message);
    }
    return window.confirm(message);
  }

  async function _showAlert(title, message) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.showAlert === 'function') {
      return await CBF_MODAL_SERVICE.showAlert(title, message);
    }
    if (typeof window !== 'undefined' &&
        typeof window.CBF_Overlay_showAlert === 'function') {
      return await window.CBF_Overlay_showAlert(title, message);
    }
    window.alert(title + '\n' + message);
  }

  async function _promptPassword(title, confirmField = false) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.promptForPassword === 'function') {
      return await CBF_MODAL_SERVICE.promptForPassword(title, confirmField);
    }
    if (typeof window !== 'undefined' &&
        typeof window.CBF_Overlay_promptForPassword === 'function') {
      return await window.CBF_Overlay_promptForPassword(title, confirmField);
    }
    return window.prompt(title);
  }

  // ============================================================
  //  Encrypted space guards
  // ============================================================
  async function _ensureEncryptedSpaceUnlocked(reasonText) {
    if (typeof CBF_BRIDGE === 'undefined' ||
        typeof CBF_BRIDGE.getStatus !== 'function') {
      return { ok: false, error: 'BRIDGE_UNAVAILABLE' };
    }

    let status;
    try {
      status = await CBF_BRIDGE.getStatus();
    } catch (e) {
      return { ok: false, error: 'STATUS_FAILED', details: e.message };
    }

    if (!status.initialized) {
      const msg = _t('switch_space_not_initialized',
        'Δεν έχετε δημιουργήσει κρυπτογραφημένο χώρο.\n\n' +
        'Δημιουργήστε τον τώρα με κωδικό πρόσβασης.');
      await _showAlert('Κρυπτογραφημένος Χώρος', msg);
      return { ok: false, error: 'NOT_INITIALIZED' };
    }

    if (!status.unlocked) {
      const password = await _promptPassword(
        `Εισάγετε τον κωδικό ${reasonText || 'για τον κρυπτογραφημένο χώρο'}:`,
        false
      );
      if (!password) {
        return { ok: false, error: 'CANCELLED' };
      }

      try {
        await CBF_BRIDGE.unlock(password);
      } catch (e) {
        const msg = _mapUnlockError(e);
        await _showAlert('Σφάλμα Ξεκλειδώματος', msg);
        return { ok: false, error: 'UNLOCK_FAILED' };
      }
    }

    return { ok: true };
  }

  function _mapUnlockError(e) {
    const code = e?.code || '';
    const msg = String(e?.message || '');

    if (code === 'WRONG_PASSWORD' || /wrong/i.test(msg)) {
      return 'Λάθος κωδικός πρόσβασης.';
    }
    if (code === 'COOLDOWN') {
      return 'Πολλές αποτυχημένες προσπάθειες. Περιμένετε λίγο.';
    }
    if (code === 'RATE_LIMITED') {
      return 'Πολλές προσπάθειες. Δοκιμάστε ξανά σε λίγο.';
    }
    return msg || 'Σφάλμα.';
  }

  // ============================================================
  //  Switch to encrypted space
  // ============================================================
  async function _switchToEncryptedSpace() {
    if (typeof CBF_BRIDGE === 'undefined') return;
    try {
      await CBF_BRIDGE.setActiveSpace('encrypted');
      if (typeof CBF_UI !== 'undefined' && CBF_UI.setActiveSpace) {
        CBF_UI.setActiveSpace('encrypted');
      }
      if (typeof window.CBF_Overlay_updateSpaceIndicator === 'function') {
        window.CBF_Overlay_updateSpaceIndicator('encrypted');
      }
      if (typeof window.CBF_Overlay_refreshLockButtonIcon === 'function') {
        window.CBF_Overlay_refreshLockButtonIcon();
      }
      if (typeof CBF_UI !== 'undefined') {
        CBF_UI.setCurrentFolderId('ecbf-root');
        CBF_UI.setBreadcrumbPath([{ id: 'ecbf-root', title: 'Encrypted Root' }]);
        if (typeof CBF_UI.navigateToFolder === 'function') {
          await CBF_UI.navigateToFolder('ecbf-root');
        }
      }
    } catch (e) {
      warn('_switchToEncryptedSpace failed:', e.message);
    }
  }

  // ============================================================
  //  File picker + read
  // ============================================================
  function _pickFile(accept = '.json') {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        resolve(file || null);
      });

      input.addEventListener('cancel', () => {
        input.remove();
        resolve(null);
      });

      document.body.appendChild(input);
      input.click();
    });
  }

  async function _readJsonFile(file) {
    if (!file) return null;
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${file.size} bytes (max ${MAX_FILE_SIZE})`);
    }
    const text = await file.text();
    if (text.length > MAX_FILE_SIZE) {
      throw new Error(`File content too large: ${text.length} chars`);
    }
    return JSON.parse(text);
  }

  // ============================================================
  //  ITEM HANDLERS
  // ============================================================

  // ─── 1. Export Bookmarks ───
  async function _onExportBookmarks() {
    log('Export bookmarks');

    if (typeof CBF_BRIDGE === 'undefined' || !CBF_BRIDGE.send) {
      await _showAlert('Σφάλμα', 'Bridge not available');
      return;
    }

    try {
      const res = await CBF_BRIDGE.send('exportBookmarks', {});
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Εξαγωγής',
          res?.error || 'Η εξαγωγή απέτυχε.');
        return;
      }
      log(`Export bookmarks OK: ${res.size} bytes`);
    } catch (e) {
      err('exportBookmarks failed:', e.message);
      await _showAlert('Σφάλμα Εξαγωγής', _mapExportError(e));
    }
  }

  // ─── 2. Export Favicons ───
  async function _onExportFavicons() {
    log('Export favicons');

    if (typeof CBF_BRIDGE === 'undefined' || !CBF_BRIDGE.send) {
      await _showAlert('Σφάλμα', 'Bridge not available');
      return;
    }

    try {
      const res = await CBF_BRIDGE.send('exportFavicons', {});
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Εξαγωγής',
          res?.error || 'Η εξαγωγή απέτυχε.');
        return;
      }
      log(`Export favicons OK: ${res.count} items, ${res.size} bytes`);
    } catch (e) {
      err('exportFavicons failed:', e.message);
      await _showAlert('Σφάλμα Εξαγωγής', _mapExportError(e));
    }
  }

  // ─── 3. Export Encrypted (backup) ───
  async function _onExportEncryptedBackup() {
    log('Export encrypted backup');

    const guard = await _ensureEncryptedSpaceUnlocked('για εξαγωγή');
    if (!guard.ok) return;

    const spaceRes = await CBF_BRIDGE.getActiveSpace();
    if (spaceRes.activeSpace !== 'encrypted') {
      await _switchToEncryptedSpace();
    }

    try {
      const res = await CBF_BRIDGE.send('exportEncryptedBackup', {});
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Εξαγωγής',
          res?.error || 'Η εξαγωγή απέτυχε.');
        return;
      }
      log(`Export encrypted backup OK: ${res.recordCount} records, ${res.size} bytes`);
    } catch (e) {
      err('exportEncryptedBackup failed:', e.message);
      await _showAlert('Σφάλμα Εξαγωγής', _mapExportError(e));
    }
  }

  // ─── 4. Export Encrypted (plain — dangerous) ───
  async function _onExportEncryptedPlain() {
    log('Export encrypted plain');

    const confirmMsg = _t('alert_export_plain_confirm',
      'Προσοχή: Η εξαγωγή χωρίς κρυπτογράφηση θα αποκαλύψει\n' +
      'όλους τους σελιδοδείκτες του κρυπτογραφημένου χώρου.\n\n' +
      'Συνέχεια;');

    const confirmed = await _showConfirm(confirmMsg);
    if (!confirmed) return;

    const guard = await _ensureEncryptedSpaceUnlocked('για εξαγωγή');
    if (!guard.ok) return;

    const spaceRes = await CBF_BRIDGE.getActiveSpace();
    if (spaceRes.activeSpace !== 'encrypted') {
      await _switchToEncryptedSpace();
    }

    try {
      const res = await CBF_BRIDGE.send('exportEncryptedPlain', {});
      if (!res || !res.success) {
        await _showAlert('Σφάλμα Εξαγωγής',
          res?.error || 'Η εξαγωγή απέτυχε.');
        return;
      }
      log(`Export encrypted plain OK: ${res.size} bytes`);
    } catch (e) {
      err('exportEncryptedPlain failed:', e.message);
      await _showAlert('Σφάλμα Εξαγωγής', _mapExportError(e));
    }
  }

  // ─── 5. Import Encrypted ───
  async function _onImportEncrypted() {
    log('Import encrypted');

    const guard = await _ensureEncryptedSpaceUnlocked('για εισαγωγή');
    if (!guard.ok) return;

    const file = await _pickFile('.json');
    if (!file) {
      log('Import cancelled (no file)');
      return;
    }

    let data;
    try {
      data = await _readJsonFile(file);
    } catch (e) {
      err('Import file read/parse failed:', e.message);
      await _showAlert('Σφάλμα Αρχείου',
        'Το αρχείο δεν είναι έγκυρο JSON.\n\n' + e.message);
      return;
    }

    if (!data || typeof data !== 'object') {
      await _showAlert('Σφάλμα Αρχείου', 'Μη έγκυρη δομή δεδομένων.');
      return;
    }

    let password = null;
    if (data.type === 'encrypted-backup') {
      password = await _promptPassword(
        'Εισάγετε τον κωδικό με τον οποίο δημιουργήθηκε το backup:',
        false
      );
      if (!password) {
        log('Import cancelled (no password)');
        return;
      }
    } else if (data.type === 'plain' || data.typeCode === 2 || Array.isArray(data)) {
      await _showAlert('Μη Υποστηριζόμενο Format',
        'Η εισαγωγή plain δεδομένων δεν υποστηρίζεται από αυτό το μενού.\n\n' +
        'Χρησιμοποιήστε το options page.');
      return;
    } else {
      await _showAlert('Μη Έγκυρο Backup',
        'Το αρχείο δεν είναι έγκυρο ECBF backup.');
      return;
    }

    const spaceRes = await CBF_BRIDGE.getActiveSpace();
    if (spaceRes.activeSpace !== 'encrypted') {
      await _switchToEncryptedSpace();
    }

    const expectedGen = (typeof CBF_BRIDGE.getGeneration === 'function')
      ? CBF_BRIDGE.getGeneration()
      : 0;

    try {
      const res = await CBF_BRIDGE.send('importEncrypted', {
        data,
        password
      }, expectedGen);

      if (!res || !res.success) {
        const errMsg = res?.error || 'Η εισαγωγή απέτυχε.';
        await _showAlert('Σφάλμα Εισαγωγής', _mapImportError(errMsg));
        return;
      }

      const imported = res.result?.importedCount ?? 0;
      const skipped = res.result?.skippedCount ?? 0;

      let successMsg = `Εισήχθησαν ${imported} στοιχεία.`;
      if (skipped > 0) {
        successMsg += `\n(${skipped} παραλείφθηκαν — υπήρχαν ήδη.)`;
      }

      await _showAlert('Επιτυχία Εισαγωγής', successMsg);
      log(`Import OK: ${imported} imported, ${skipped} skipped`);

      if (typeof CBF_UI !== 'undefined' && CBF_UI.navigateToFolder) {
        const cur = CBF_UI.getCurrentFolderId?.();
        if (cur) {
          try {
            await CBF_UI.navigateToFolder(cur, { preservePath: true });
          } catch (_) {}
        }
      }
    } catch (e) {
      err('importEncrypted failed:', e.message);
      await _showAlert('Σφάλμα Εισαγωγής', _mapImportError(e.message));
    }
  }

  // ─── 6. Performance Mode ───
  async function _onTogglePerformanceMode() {
    log('Toggle performance mode');

    if (typeof window.CBF_Overlay_togglePerf === 'function') {
      try {
        await window.CBF_Overlay_togglePerf();
        return;
      } catch (e) {
        warn('togglePerf failed:', e.message);
      }
    }

    try {
      const { cbf_perfMode } = await browser.storage.local.get('cbf_perfMode');
      const newValue = !cbf_perfMode;
      await browser.storage.local.set({ cbf_perfMode: newValue });
      log(`Perf mode toggled (fallback): ${newValue}`);
    } catch (e) {
      warn('perf toggle fallback failed:', e.message);
    }
  }

  // ─── 7. Options Page ───
  //  V12E.E-05a: 3-level fallback chain
  async function _onOpenOptionsPage() {
    log('Open options page');

    // Attempt 1: CBF_BRIDGE.send
    if (typeof CBF_BRIDGE !== 'undefined' &&
        typeof CBF_BRIDGE.send === 'function') {
      try {
        const res = await CBF_BRIDGE.send('openOptionsPage', {});
        if (res && res.success !== false) {
          log('openOptionsPage via CBF_BRIDGE.send OK');
          return;
        }
        warn('openOptionsPage via bridge rejected:', res?.error || 'unknown');
      } catch (e) {
        warn('openOptionsPage via bridge failed:', e.message);
      }
    }

    // Attempt 2: runtime.sendMessage
    try {
      if (typeof browser !== 'undefined' &&
          browser.runtime &&
          typeof browser.runtime.sendMessage === 'function') {
        const res = await browser.runtime.sendMessage({ type: 'openOptionsPage' });
        if (res && res.success !== false) {
          log('openOptionsPage via runtime.sendMessage OK');
          return;
        }
        warn('openOptionsPage sendMessage rejected:', res?.error || 'unknown');
      }
    } catch (e) {
      warn('openOptionsPage sendMessage failed:', e.message);
    }

    // Attempt 3: direct API
    try {
      if (typeof browser !== 'undefined' &&
          browser.runtime &&
          typeof browser.runtime.openOptionsPage === 'function') {
        browser.runtime.openOptionsPage();
        log('openOptionsPage via direct API OK');
        return;
      }
    } catch (e) {
      err('openOptionsPage direct failed:', e.message);
    }

    err('openOptionsPage: ALL attempts failed');
    await _showAlert(
      'Σφάλμα',
      'Δεν ήταν δυνατό το άνοιγμα των ρυθμίσεων.\n\n' +
      'Δοκιμάστε χειροκίνητα: about:addons → ECBF → Προτιμήσεις'
    );
  }

  // ============================================================
  //  Error mappers
  // ============================================================
  function _mapExportError(e) {
    const code = e?.code || '';
    const msg = String(e?.message || '');

    if (code === 'RATE_LIMITED' || /rate.?limit/i.test(msg)) {
      return 'Πολλές εξαγωγές. Δοκιμάστε ξανά σε λίγο.';
    }
    if (code === 'COOLDOWN') {
      return 'Περιμένετε πριν δοκιμάσετε ξανά.';
    }
    if (code === 'LOCKED' || /locked/i.test(msg)) {
      return 'Ο κρυπτογραφημένος χώρος είναι κλειδωμένος.';
    }
    if (code === 'EXPORT_FAILED') {
      return 'Η εξαγωγή απέτυχε. Δοκιμάστε ξανά.';
    }
    return msg || 'Άγνωστο σφάλμα.';
  }

  function _mapImportError(msg) {
    const s = String(msg || '');

    if (/IMPORT_TOO_LARGE/i.test(s)) return 'Το αρχείο είναι πολύ μεγάλο (max 5MB).';
    if (/INVALID_BACKUP|INVALID_IMPORT/i.test(s)) return 'Το αρχείο δεν είναι έγκυρο backup.';
    if (/CROSS_KEY_IMPORT_NOT_SUPPORTED/i.test(s)) {
      return 'Το backup είναι από άλλο vault.\n\nΚάντε restore στο αρχικό vault.';
    }
    if (/PLAIN_IMPORT_NOT_SUPPORTED/i.test(s)) return 'Η εισαγωγή plain δεδομένων δεν υποστηρίζεται.';
    if (/RATE_LIMITED/i.test(s)) return 'Πολλές εισαγωγές. Δοκιμάστε ξανά σε λίγο.';
    if (/COOLDOWN/i.test(s)) return 'Περιμένετε 60 δευτερόλεπτα πριν δοκιμάσετε ξανά.';
    if (/LOCKED/i.test(s)) return 'Ο κρυπτογραφημένος χώρος είναι κλειδωμένος.';
    if (/STALE_GENERATION/i.test(s)) return 'Το vault άλλαξε. Δοκιμάστε ξανά.';
    return s || 'Άγνωστο σφάλμα.';
  }

  // ============================================================
  //  Menu item factory
  //
  //  V12E.E-05b-fix: label περνάει από _stripLeadingIcon()
  // ============================================================
  function _createMenuItem(item) {
    const el = document.createElement('div');
    el.className = 'cbf-menu-item';
    el.dataset.dangerous = item.dangerous ? 'true' : 'false';
    el.style.cssText = `
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 500;
      color: #ffffff;
      cursor: pointer;
      transition: background 0.2s, color 0.2s;
      text-shadow: 0 1px 3px rgba(0,0,0,0.5);
      border-radius: 6px;
      margin: 2px 6px;
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: normal;
      word-break: break-word;
      line-height: 1.4;
      pointer-events: auto;
    `;

    // Icon span
    const iconEl = document.createElement('span');
    iconEl.className = 'cbf-menu-item-icon';
    iconEl.style.cssText = `
      flex-shrink: 0;
      width: 20px;
      text-align: center;
      font-size: 15px;
      line-height: 1;
      display: inline-block;
      pointer-events: none;
      user-select: none;
    `;
    iconEl.textContent = item.icon || '';
    iconEl.setAttribute('aria-hidden', 'true');
    el.appendChild(iconEl);

    // Label span
    // V12E.E-05b-fix: _stripLeadingIcon() αφαιρεί leading emoji
    const labelEl = document.createElement('span');
    labelEl.className = 'cbf-menu-item-label';
    labelEl.style.cssText = `
      flex: 1;
      min-width: 0;
      word-break: break-word;
    `;
    labelEl.textContent = _stripLeadingIcon(item.label || '');
    el.appendChild(labelEl);

    // Hover
    el.addEventListener('mouseenter', () => {
      el.style.background = item.dangerous
        ? 'rgba(255,107,107,0.25)'
        : 'rgba(255,255,255,0.2)';
    });
    el.addEventListener('mouseleave', () => {
      el.style.background = 'transparent';
    });

    // Click
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (_isActionInProgress()) {
        log('Menu item blocked: action in progress');
        return;
      }
      if (_isSpaceTransitionInProgress()) {
        log('Menu item blocked: space transition in progress');
        return;
      }

      close();

      _actionInProgress = true;
      try {
        await item.handler();
      } catch (e) {
        err(`Menu item "${item.label}" failed:`, e.message);
        await _showAlert('Σφάλμα', e.message || 'Άγνωστο σφάλμα.');
      } finally {
        _actionInProgress = false;
      }
    });

    return el;
  }

  // ============================================================
  //  Menu DOM
  // ============================================================
  function _buildMenu() {
    const menu = document.createElement('div');
    menu.className = 'cbf-main-menu-popup';
    menu.id = 'cbf-main-menu-popup';
    menu.style.cssText = `
      position: fixed;
      background: rgba(20, 15, 50, 0.18);
      background-image: linear-gradient(
        135deg,
        rgba(80,40,140,0.28) 0%,
        rgba(45,65,160,0.22) 40%,
        rgba(55,45,145,0.18) 100%
      );
      backdrop-filter: blur(25px) saturate(200%) brightness(1.05);
      -webkit-backdrop-filter: blur(25px) saturate(200%) brightness(1.05);
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 14px;
      padding: 6px 0;
      z-index: 2147483647;
      display: none;
      width: ${MENU_WIDTH}px;
      max-width: 90vw;
      max-height: ${MENU_MAX_HEIGHT}px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      box-shadow: 0 12px 32px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-sizing: border-box;
      scrollbar-width: thin;
      scrollbar-color: rgba(80,40,140,1) rgba(255,255,255,0.5);
      pointer-events: auto;
    `;

    menu.addEventListener('keydown', (e) => e.stopPropagation());
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => e.stopPropagation());

    const items = [
      {
        icon: '📁',
        label: _t('backup_export_bookmarks', 'Εξαγωγή σελιδοδεικτών'),
        handler: _onExportBookmarks
      },
      {
        icon: '🖼️',
        label: _t('backup_export_favicons', 'Εξαγωγή favicons'),
        handler: _onExportFavicons
      },
      {
        icon: '🔒',
        label: _t('backup_export_encrypted_backup', 'Εξαγωγή encrypted (backup)'),
        handler: _onExportEncryptedBackup
      },
      {
        icon: '📄',
        label: _t('backup_export_encrypted_plain', 'Εξαγωγή encrypted (plain)'),
        handler: _onExportEncryptedPlain,
        dangerous: true
      },
      {
        icon: '📥',
        label: _t('backup_import_encrypted', 'Εισαγωγή στον encrypted'),
        handler: _onImportEncrypted
      },
      {
        icon: '⚡',
        label: _t('tooltip_toggle_performance', 'Performance mode'),
        handler: _onTogglePerformanceMode,
        separator: true
      }
    ];

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.style.cssText = `
          height: 1px;
          background: rgba(255,255,255,0.15);
          margin: 4px 12px;
        `;
        menu.appendChild(sep);
      }

      menu.appendChild(_createMenuItem(item));
    }

    // Separator πριν το settings
    const sep2 = document.createElement('div');
    sep2.style.cssText = `
      height: 1px;
      background: rgba(255,255,255,0.15);
      margin: 4px 12px;
    `;
    menu.appendChild(sep2);

    // Settings item
    const settingsItem = {
      icon: '⚙️',
      label: _t('options_more_settings', 'Περισσότερες ρυθμίσεις'),
      handler: _onOpenOptionsPage
    };
    menu.appendChild(_createMenuItem(settingsItem));

    return menu;
  }

  // ============================================================
  //  Position menu
  // ============================================================
  function _positionMenu() {
    if (!menuEl || !menuBtn) return;

    const btnRect = menuBtn.getBoundingClientRect();
    const menuRect = menuEl.getBoundingClientRect();

    let left = btnRect.left + btnRect.width / 2 - menuRect.width / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - menuRect.width - 10));

    let top = btnRect.top - menuRect.height - 8;
    if (top < 10) {
      top = btnRect.bottom + 8;
    }

    menuEl.style.left = left + 'px';
    menuEl.style.top = top + 'px';
  }

  // ============================================================
  //  Open / Close
  // ============================================================
  function open() {
    if (!menuEl || isOpen) return;

    menuEl.style.display = 'block';
    menuEl.style.visibility = 'hidden';
    menuEl.style.opacity = '0';
    menuEl.style.transform = 'scale(0.95)';

    _positionMenu();

    menuEl.style.visibility = 'visible';
    isOpen = true;

    menuEl.style.transition = 'opacity 0.15s ease-out, transform 0.15s ease-out';
    requestAnimationFrame(() => {
      menuEl.style.opacity = '1';
      menuEl.style.transform = 'scale(1)';
    });

    log('Menu opened');
  }

  function close() {
    if (!menuEl || !isOpen) return;

    menuEl.style.display = 'none';
    menuEl.style.opacity = '0';
    menuEl.style.transform = 'scale(0.95)';
    menuEl.style.visibility = 'hidden';
    isOpen = false;

    log('Menu closed');
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  // ============================================================
  //  Global listeners
  // ============================================================
  function _attachGlobalListeners() {
    _documentClickHandler = (e) => {
      if (!isOpen) return;

      const target = e.composedPath ? e.composedPath()[0] : e.target;

      if (menuEl && menuEl.contains(target)) return;
      if (menuBtn && menuBtn.contains(target)) return;

      close();
    };

    document.addEventListener('click', _documentClickHandler, false);

    _documentKeydownHandler = (e) => {
      if (!isOpen) return;
      if (!e.isTrusted) return;

      if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
          typeof CBF_MODAL_SERVICE.activeCount === 'function' &&
          CBF_MODAL_SERVICE.activeCount() > 0) {
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };

    document.addEventListener('keydown', _documentKeydownHandler, true);
  }

  function _detachGlobalListeners() {
    if (_documentClickHandler) {
      document.removeEventListener('click', _documentClickHandler, false);
      _documentClickHandler = null;
    }
    if (_documentKeydownHandler) {
      document.removeEventListener('keydown', _documentKeydownHandler, true);
      _documentKeydownHandler = null;
    }
  }

  // ============================================================
  //  Wire menu button
  // ============================================================
  function _attachMenuButton() {
    if (!menuBtn) return;

    menuBtn.style.opacity = '1';
    menuBtn.style.cursor = 'pointer';
    menuBtn.style.pointerEvents = 'auto';

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggle();
    });

    menuBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
  }

  // ============================================================
  //  Init
  // ============================================================
  function init(containerEl, shadow) {
    if (isInitialized) {
      warn('init: already initialized');
      return true;
    }

    if (!containerEl) {
      warn('init: container required');
      return false;
    }

    container = containerEl;
    shadowRoot = shadow || null;

    menuBtn = container.querySelector('#cbf-main-menu');
    if (!menuBtn) {
      warn('init: #cbf-main-menu not found');
      return false;
    }

    menuEl = _buildMenu();

    const mountPoint = shadowRoot || document.body;
    mountPoint.appendChild(menuEl);

    _attachMenuButton();
    _attachGlobalListeners();

    isInitialized = true;
    log('initialized (7 items: 4 export + 1 import + perf + options)');
    return true;
  }

  // ============================================================
  //  Destroy
  // ============================================================
  function destroy() {
    if (!isInitialized) return;

    _detachGlobalListeners();

    if (menuEl && menuEl.parentNode) {
      menuEl.parentNode.removeChild(menuEl);
    }
    menuEl = null;
    isOpen = false;

    menuBtn = null;
    container = null;
    shadowRoot = null;
    isInitialized = false;
    _actionInProgress = false;

    log('destroyed');
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    toggle,
    open,
    close,
    isOpen: () => isOpen,

    _internal: {
      _onExportBookmarks,
      _onExportFavicons,
      _onExportEncryptedBackup,
      _onExportEncryptedPlain,
      _onImportEncrypted,
      _onTogglePerformanceMode,
      _onOpenOptionsPage,
      _ensureEncryptedSpaceUnlocked,
      _switchToEncryptedSpace,
      _pickFile,
      _readJsonFile,
      _mapExportError,
      _mapImportError,
      _buildMenu,
      _createMenuItem,
      _stripLeadingIcon,
      isInitialized: () => isInitialized,
      isActionInProgress: () => _actionInProgress,
      MENU_WIDTH,
      MENU_MAX_HEIGHT,
      MAX_FILE_SIZE
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined')     window.CBF_FEATURE_MAIN_MENU = api;
  if (typeof self !== 'undefined')       self.CBF_FEATURE_MAIN_MENU = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_MAIN_MENU = api;

  log('Ready (V12E + V12E.E-05a + V12E.E-05b-fix)');
  return api;
})();