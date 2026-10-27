/**
 * open-handler.js — Open handler (URL → tab)
 *
 * @path     background/services/open-handler.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Ανοίγει URLs από τον encrypted space με ελαχιστοποίηση διαρροής.
 *   Υποστηρίζει 3 modes (D-52):
 *     1. open(url)                     → νέα καρτέλα (active)
 *     2. openInCurrentTab(url, tabId)  → ίδια καρτέλα (tabs.update)
 *     3. openInNewTab(url)             → νέα καρτέλα (background, active=false)
 *
 * ISOLATION
 *   • Container best-effort (cookieStoreId) — απαιτεί permission που
 *     ΔΕΝ έχουμε (D-23.1). Fallback: χωρίς container.
 *   • openerTabId = null (no window.opener → no referrer)
 *   • loadReplace: true (openInCurrentTab) — αντικαθιστά history entry
 *   • URL validation: http/https, max 2048
 *   • Audit log (sanitized URL)
 *
 * DECISIONS
 *   D-23.1, D-25, D-52
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "open-handler"
 */

var CBF_OPEN_HANDLER = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_URL_LENGTH  = 2048;
  const CONTAINER_ID    = 'firefox-container-ecbf';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)   { CBF_LOGGER.info('[OPEN]', ...a); }
  function warn(...a)  { CBF_LOGGER.warn('[OPEN]', ...a); }
  function err(...a)   { CBF_LOGGER.error('[OPEN]', ...a); }
  function audit(...a) { CBF_LOGGER.security('[OPEN]', ...a); }

  // ============================================================
  //  URL validation
  // ============================================================
  function _validateUrl(url) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('INVALID_URL: empty');
    }
    if (url.length > MAX_URL_LENGTH) {
      throw new Error('URL_TOO_LONG: ' + url.length + ' > ' + MAX_URL_LENGTH);
    }
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('INVALID_URL_PROTOCOL: only http(s)');
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      throw new Error('INVALID_URL: cannot parse');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('INVALID_URL_PROTOCOL: only http(s)');
    }

    return parsed.href;
  }

  // ============================================================
  //  Sanitization για logging (δεν εκτυπώνουμε πλήρες URL)
  // ============================================================
  function _sanitizeUrlForLog(url) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.hostname}/...`;
    } catch (_) {
      return '[invalid-url]';
    }
  }

  // ============================================================
  //  Container detection
  //
  //  Ελέγχει αν το cookieStoreId είναι διαθέσιμο. ΔΕΝ χρησιμοποιεί
  //  contextualIdentities API (δεν το έχουμε στο manifest).
  //
  //  Αντί αυτού, προσπαθεί να ανοίξει το tab και "μαθαίνει" από
  //  το αποτέλεσμα. Cache-άρουμε το αποτέλεσμα για να αποφύγουμε
  //  περιττές αποτυχίες.
  // ============================================================
  let containerAvailable = null;   // null = άγνωστο, true = OK, false = ΟΧΙ

  // Case-sensitivity fix: το `m` είναι lowercase, τα needles πρέπει
  // επίσης να είναι lowercase (String.includes είναι case-sensitive).
  function _isContainerPermissionError(e) {
    if (!e || !e.message) return false;
    const m = e.message.toLowerCase();
    return m.includes('cookiestoreid') ||
           m.includes('contextualidentities') ||
           m.includes('container');
  }

  // ============================================================
  //  tabs.create με graceful degradation (container best-effort)
  // ============================================================
  async function _createTab(safeUrl) {
    // ---------- 1. Αν ο container είναι γνωστό ότι αποτυγχάνει → skip ----------
    if (containerAvailable === false) {
      return await _createTabWithoutContainer(safeUrl);
    }

    // ---------- 2. Δοκίμασε με container ----------
    try {
      const tab = await browser.tabs.create({
        url: safeUrl,
        cookieStoreId: CONTAINER_ID,
        active: true,
        openerTabId: null,
        discarded: false
      });

      // Πρώτη επιτυχία → σήμανε τον container ως διαθέσιμο
      if (containerAvailable === null) {
        containerAvailable = true;
        log('Container isolation ENABLED (first successful open)');
      }

      return { tab, usedContainer: true };

    } catch (e) {
      // ---------- 3. Permission error → fallback χωρίς container ----------
      if (_isContainerPermissionError(e)) {
        if (containerAvailable === null) {
          containerAvailable = false;
          warn(
            'Container isolation DISABLED: Firefox rejected cookieStoreId ' +
            '(missing contextualIdentities permission). ' +
            'Opening without container — openerTabId=null retained.'
          );
          audit('CONTAINER_UNAVAILABLE', { reason: e.message });
        }
        return await _createTabWithoutContainer(safeUrl);
      }

      // Άλλο error → re-throw
      throw e;
    }
  }

  async function _createTabWithoutContainer(safeUrl) {
    const tab = await browser.tabs.create({
      url: safeUrl,
      active: true,
      openerTabId: null,
      discarded: false
    });
    return { tab, usedContainer: false };
  }

  // ============================================================
  //  Internal create helper (για openInNewTab)
  //
  //  Ίδιο isolation model με _createTab, αλλά με active parameter
  //  (για context menu → background tab).
  // ============================================================
  async function _createTabInternal(safeUrl, active) {
    const tab = await browser.tabs.create({
      url: safeUrl,
      active,
      openerTabId: null,
      discarded: false
    });
    return { tab, usedContainer: false };
  }

  // ============================================================
  //  open — νέα καρτέλα (default, active=true)
  //
  //  @param {string} url — validated http(s) URL
  //  @returns {Promise<{ tabId: number, usedContainer: boolean }>}
  // ============================================================
  async function open(url) {
    const safeUrl = _validateUrl(url);

    let result;
    try {
      result = await _createTab(safeUrl);
    } catch (e) {
      err('tabs.create failed:', e.message);
      throw new Error('OPEN_FAILED: ' + e.message);
    }

    const tab = result.tab;
    if (!tab || typeof tab.id !== 'number') {
      throw new Error('OPEN_FAILED: no tab returned');
    }

    audit(
      'Opened',
      _sanitizeUrlForLog(safeUrl),
      'tab=' + tab.id,
      'container=' + (result.usedContainer ? 'yes' : 'no')
    );

    return { tabId: tab.id, usedContainer: result.usedContainer };
  }

  // ============================================================
  //  D-52 — openInCurrentTab
  //
  //  Ανοίγει URL στην ΤΡΕΧΟΥΣΑ καρτέλα (tabs.update).
  //
  //  CONTRACT:
  //    - Ο caller (overlay) ΠΡΕΠΕΙ να έχει ΚΛΕΙΣΕΙ το overlay
  //      ΠΡΙΝ καλέσει αυτή τη μέθοδο.
  //    - loadReplace: true → το history entry αντικαθίσταται
  //      (αποφυγή back-button leak του overlay URL)
  //
  //  SECURITY:
  //    - openerTabId: null δεν εφαρμόζεται (ίδια καρτέλα)
  //    - Container: ΔΕΝ αλλάζει (ίδιο tab → ίδιο cookie jar)
  // ============================================================
  async function openInCurrentTab(url, tabId) {
    const safeUrl = _validateUrl(url);

    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
      throw new Error('OPEN_IN_CURRENT_FAILED: invalid tabId');
    }

    let tab;
    try {
      tab = await browser.tabs.update(tabId, {
        url: safeUrl,
        loadReplace: true   // D-52: αντικατάσταση history entry
      });
    } catch (e) {
      err('tabs.update failed:', e.message);
      throw new Error('OPEN_IN_CURRENT_FAILED: ' + e.message);
    }

    if (!tab || typeof tab.id !== 'number') {
      throw new Error('OPEN_IN_CURRENT_FAILED: no tab returned');
    }

    audit(
      'OpenedInCurrentTab',
      _sanitizeUrlForLog(safeUrl),
      'tab=' + tab.id
    );

    return { tabId: tab.id };
  }

  // ============================================================
  //  D-52 — openInNewTab
  //
  //  Ανοίγει URL σε ΝΕΑ καρτέλα (background, active: false).
  //  Χρησιμοποιείται από το context menu ("Άνοιγμα σε νέα καρτέλα").
  //
  //  Ίδιο isolation model με open():
  //    - Container best-effort (cookieStoreId)
  //    - openerTabId=null (no window.opener, no referrer)
  //    - discarded: false (δεν είναι lazy tab)
  //
  //  ΔΙΑΦΟΡΕΣ από open():
  //    - active: false (background tab)
  //    - ΔΕΝ κάνει fallback σε active:true αν αποτύχει το container
  // ============================================================
  async function openInNewTab(url) {
    const safeUrl = _validateUrl(url);

    let result;

    // ---------- Container best-effort ----------
    if (containerAvailable === false) {
      try {
        result = await _createTabInternal(safeUrl, false);
      } catch (e) {
        err('tabs.create (new tab, no container) failed:', e.message);
        throw new Error('OPEN_IN_NEW_FAILED: ' + e.message);
      }
    } else {
      try {
        const tab = await browser.tabs.create({
          url: safeUrl,
          cookieStoreId: CONTAINER_ID,
          active: false,
          openerTabId: null,
          discarded: false
        });

        if (containerAvailable === null) {
          containerAvailable = true;
          log('Container isolation ENABLED (first successful new-tab open)');
        }

        result = { tab, usedContainer: true };
      } catch (e) {
        if (_isContainerPermissionError(e)) {
          if (containerAvailable === null) {
            containerAvailable = false;
            warn(
              'Container isolation DISABLED (new tab): Firefox rejected cookieStoreId. ' +
              'Opening without container — openerTabId=null retained.'
            );
            audit('CONTAINER_UNAVAILABLE', { reason: e.message, context: 'new-tab' });
          }
          try {
            result = await _createTabInternal(safeUrl, false);
          } catch (e2) {
            err('tabs.create (new tab, fallback) failed:', e2.message);
            throw new Error('OPEN_IN_NEW_FAILED: ' + e2.message);
          }
        } else {
          err('tabs.create (new tab) failed:', e.message);
          throw new Error('OPEN_IN_NEW_FAILED: ' + e.message);
        }
      }
    }

    if (!result.tab || typeof result.tab.id !== 'number') {
      throw new Error('OPEN_IN_NEW_FAILED: no tab returned');
    }

    audit(
      'OpenedInNewTab',
      _sanitizeUrlForLog(safeUrl),
      'tab=' + result.tab.id,
      'container=' + (result.usedContainer ? 'yes' : 'no')
    );

    return { tabId: result.tab.id, usedContainer: result.usedContainer };
  }

  // ============================================================
  //  Diagnostics
  // ============================================================
  function getContainerStatus() {
    return {
      available: containerAvailable,
      containerId: CONTAINER_ID
    };
  }

  function resetContainerStatus() {
    containerAvailable = null;
    log('Container status reset');
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    open,
    openInCurrentTab,
    openInNewTab,

    getContainerStatus,
    resetContainerStatus,

    CONTAINER_ID,
    MAX_URL_LENGTH,

    _internal: {
      _validateUrl,
      _sanitizeUrlForLog,
      _isContainerPermissionError,
      _createTab,
      _createTabWithoutContainer,
      _createTabInternal,
      openInCurrentTab,
      openInNewTab
    }
  };

  if (typeof self !== 'undefined') self.CBF_OPEN_HANDLER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_OPEN_HANDLER = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Open Handler ready (D-25 + D-52: container best-effort, openerTabId=null, ' +
      'openInCurrentTab + openInNewTab)'
    );
  }

  return api;
})();