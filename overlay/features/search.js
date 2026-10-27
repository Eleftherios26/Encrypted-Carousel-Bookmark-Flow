/**
 * search.js — Feature: Global search
 *
 * @path     overlay/features/search.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Wires the search bar DOM listeners και καλεί το public API του
 *   CBF_UI (setSearchResults / clearSearch) με debounced global search.
 *
 * FEATURES
 *   • Global search — αναζήτηση σε ΟΛΟΥΣ τους φακέλους (όχι μόνο
 *     στον τρέχοντα), μέσω CBF_BRIDGE.searchBookmarks(query)
 *   • Debounce 200ms — αποφυγή flooding στο background
 *   • Race protection — reqId invalidation για stale responses
 *   • Ctrl+F — focus search bar
 *   • Escape — clear + blur
 *   • Clear button (✕)
 *   • ArrowUp/Down — navigate results
 *   • Enter — activate first result
 *
 * DECISIONS
 *   D-47
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "search"
 */

var CBF_FEATURE_SEARCH = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const DEBOUNCE_MS = 200;      // 200ms αρκεί για smooth typing
  const MAX_QUERY_LENGTH = 100;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Feature:Search]', ...a); }
  function warn(...a) { console.warn('[ECBF:Feature:Search]', ...a); }
  function err(...a)  { console.error('[ECBF:Feature:Search]', ...a); }

  // ============================================================
  //  State
  // ============================================================
  let searchBar = null;
  let searchClear = null;
  let initialized = false;

  // Debounce timer
  let _debounceTimer = null;

  // Race protection: κάθε νέο request παίρνει νέο reqId.
  // Όταν φτάνει η απάντηση, ελέγχουμε αν το reqId ταιριάζει.
  // Αν όχι → stale → ignore.
  let _searchReqId = 0;

  // Pending state flag (για diagnostics)
  let _searchInProgress = false;

  // ============================================================
  //  Core: Execute global search (async)
  // ============================================================
  async function _executeSearch(query) {
    const reqId = ++_searchReqId;
    _searchInProgress = true;

    try {
      log(`Searching (global): "${query}" (reqId=${reqId})`);

      const res = await CBF_BRIDGE.searchBookmarks(query);

      // Race check
      if (reqId !== _searchReqId) {
        log(`Search stale (reqId=${reqId}, current=${_searchReqId}) — ignoring`);
        return;
      }

      const items = (res && Array.isArray(res.items)) ? res.items : [];
      log(`Search result: ${items.length} items (reqId=${reqId})`);

      // Render μέσω CBF_UI
      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.setSearchResults === 'function') {
        CBF_UI.setSearchResults(items);
      } else {
        warn('CBF_UI.setSearchResults not available');
      }
    } catch (e) {
      if (reqId !== _searchReqId) return;

      // Rate limit — αγνοούμε σιωπηλά (ο χρήστης πληκτρολογεί γρήγορα)
      const errMsg = String(e?.message || '');
      if (/RATE_LIMITED|COMMAND_LIMIT|COOLDOWN/i.test(errMsg)) {
        log(`Search rate-limited (reqId=${reqId}) — will retry on next keystroke`);
        return;
      }

      err(`Search failed (reqId=${reqId}):`, e.message);

      // Clear αποτελέσματα σε σφάλμα
      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.setSearchResults === 'function') {
        CBF_UI.setSearchResults([]);
      }
    } finally {
      if (reqId === _searchReqId) {
        _searchInProgress = false;
      }
    }
  }

  // ============================================================
  //  Debounced input handler
  // ============================================================
  function _onInput() {
    if (!searchBar) return;

    const q = (searchBar.value || '').trim();

    // Toggle clear button
    if (searchClear) {
      searchClear.style.display = q.length > 0 ? 'flex' : 'none';
    }

    // Cancel pending debounce
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    // Empty query → άμεσο clear
    if (q.length === 0) {
      _searchReqId++;   // ακύρωση τυχόν pending
      _searchInProgress = false;
      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.clearSearch === 'function') {
        CBF_UI.clearSearch();
      }
      return;
    }

    // Enforce max length (defense-in-depth)
    const safeQ = q.slice(0, MAX_QUERY_LENGTH);

    // Debounced execution
    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      _executeSearch(safeQ);
    }, DEBOUNCE_MS);
  }

  // ============================================================
  //  Keydown inside search bar (isolate + Escape + Enter)
  // ============================================================
  function _onKeydown(e) {
    // Stop propagation → δεν φτάνει στο ui-controller _onKeyDown
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      _cancelPending();
      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.clearSearch === 'function') {
        CBF_UI.clearSearch();
      }
      if (searchBar) searchBar.blur();
      return;
    }

    // Enter → activate first result
    if (e.key === 'Enter') {
      e.preventDefault();
      if (typeof CBF_UI !== 'undefined' &&
          typeof CBF_UI.getVisibleItems === 'function' &&
          typeof CBF_UI._internal?._activateItem === 'function') {
        const items = CBF_UI.getVisibleItems();
        if (items.length > 0) {
          CBF_UI._internal._activateItem(items[0]);
        }
      }
      return;
    }

    // ArrowDown/ArrowUp → navigate results
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (typeof CBF_UI !== 'undefined' &&
          typeof CBF_UI._internal?._moveSelection === 'function') {
        CBF_UI._internal._moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      }
    }
  }

  // ============================================================
  //  Clear button (✕)
  // ============================================================
  function _onClearClick(e) {
    e.stopPropagation();
    _cancelPending();
    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.clearSearch === 'function') {
      CBF_UI.clearSearch();
    }
    if (searchBar) {
      searchBar.value = '';
      searchBar.focus();
    }
  }

  // ============================================================
  //  Cancel pending operations
  // ============================================================
  function _cancelPending() {
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }
    // Invalidate τυχόν in-flight request
    _searchReqId++;
    _searchInProgress = false;
  }

  // ============================================================
  //  Global Ctrl+F (focus search bar)
  // ============================================================
  function _onGlobalKeydown(e) {
    if (!e.isTrusted) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      // Αν είναι σε input/textarea → αφήνουμε τον browser
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }
      e.preventDefault();
      if (searchBar) {
        searchBar.focus();
        searchBar.select();
      }
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

    searchBar = container.querySelector('#cbf-search-bar');
    searchClear = container.querySelector('#cbf-search-clear');

    if (!searchBar) {
      warn('init: #cbf-search-bar not found');
      return false;
    }

    // Wire search bar listeners
    searchBar.addEventListener('input', _onInput);
    searchBar.addEventListener('keydown', _onKeydown);

    if (searchClear) {
      searchClear.addEventListener('click', _onClearClick);
    }

    // Global Ctrl+F
    document.addEventListener('keydown', _onGlobalKeydown);

    // Ensure clear button starts hidden
    if (searchClear) searchClear.style.display = 'none';

    initialized = true;
    log('initialized (Ctrl+F + Escape + Enter + ArrowUp/Down + clear button + GLOBAL search)');
    return true;
  }

  // ============================================================
  //  Destroy — cleanup (καλείται από content-overlay destroy)
  // ============================================================
  function destroy() {
    if (!initialized) return;

    _cancelPending();

    if (searchBar) {
      searchBar.removeEventListener('input', _onInput);
      searchBar.removeEventListener('keydown', _onKeydown);
    }
    if (searchClear) {
      searchClear.removeEventListener('click', _onClearClick);
    }
    document.removeEventListener('keydown', _onGlobalKeydown);

    searchBar = null;
    searchClear = null;
    initialized = false;
    log('destroyed');
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    _internal: {
      _onInput,
      _onKeydown,
      _onClearClick,
      _onGlobalKeydown,
      _executeSearch,
      _cancelPending,
      isInitialized: () => initialized,
      isSearchInProgress: () => _searchInProgress,
      getReqId: () => _searchReqId,
      DEBOUNCE_MS,
      MAX_QUERY_LENGTH
    }
  };

  if (typeof window !== 'undefined')     window.CBF_FEATURE_SEARCH = api;
  if (typeof self !== 'undefined')       self.CBF_FEATURE_SEARCH = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_FEATURE_SEARCH = api;

  log('Ready (v12.0.0 — GLOBAL search + debounce + race protection)');
  return api;
})();