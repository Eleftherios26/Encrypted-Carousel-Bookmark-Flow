/**
 * content-overlay.js — Injected Overlay Entry Point
 *
 * @path     overlay/content-overlay.js
 * @version  12.3.0
 * @since    v12E / v12.3
 *
 * PURPOSE
 *   Content script entry point. Δημιουργεί το #cbf-overlay-host,
 *   attach-άρει closed Shadow DOM, φορτώνει το UI HTML, κάνει
 *   bootstrap όλων των sub-modules (UI, D&D, features), συνδέεται
 *   με background μέσω CBF_BRIDGE, και διαχειρίζεται lifecycle
 *   (close, pagehide, host removal).
 *
 * KEY CONCEPTS
 *   • Closed Shadow DOM (D-13.1) — page scripts δεν βλέπουν το UI
 *   • D1: MutationObserver host guard (page script removal detection)
 *   • D2: isTrusted check — synthetic events rejected
 *   • D3: sender.id validation — μόνο το δικό μας background
 *   • H-6: Unified space mutex (_spaceInProgress)
 *   • H-8: Lock hierarchy με C-3 + H-8 preflight guards
 *   • M-8: Multi-tab mutation sync listener (skip on search/drag)
 *   • C-5: Modal keyboard isolation guard στο Escape handler
 *   • v1.5.4: Persistent last space (cbf_lastSpace)
 *
 * NON-OBVIOUS
 *   • Το SIGNATURE_DATA_URI είναι placeholder — αντικαθίσταται
 *     χειροκίνητα με το πραγματικό base64 SVG string.
 *   • Το host element έχει pointer-events:none, αλλά το
 *     .win7-aero έχει pointer-events:auto (C3 fix).
 *   • Το pagehide cleanup ΔΕΝ κάνει slideDown — instant remove.
 *
 * DECISIONS
 *   D-13.1, D-23.1, D-42, D-46, D-47, D-49, D-51..D-56
 *
 * CHANGELOG v12.3.0 (2026-09-28) — COSMETIC VERSION BUMP
 *   • Version tag στο DOM: v12.2E → v12.3E (consistency με release)
 *   • 0 functional changes — μόνο display text
 *
 * CHANGELOG v12.2.0 (2026-09-26) — LOW-END HARDWARE OPTIMIZATION
 *   ═══════════════════════════════════════════════════════════════════
 *   Adaptive performance (Tier 2 — zero functional regression):
 *     • CPU-06: _IS_LOW_END detection (hardwareConcurrency/deviceMemory)
 *     • CPU-07: MUTATION_REFRESH_THROTTLE adaptive (500ms low / 200ms high)
 *     • CPU-08: Tooltip delay adaptive (800ms low / 400ms high)
 *     • CPU-09: Resize debounce adaptive (150ms low / 50ms high)
 *     • GPU-01: Automatic .low-end class σε host (CSS blur off)
 *
 *   Latency optimizations (Tier 1):
 *     • LAT-01: Status cache warm-up στο bootstrap (μειώνει το 1ο
 *       getStatus round-trip μετά το open)
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "content-overlay"
 */

(function() {
  'use strict';

  console.log('[ECBF:ContentOverlay] Bootstrap v12.3 (injected, κορμός)');

  // ============================================================
  //  ⭐ v12.2 ADAPTIVE DETECTION (must be before any usage)
  //
  //  Χρησιμοποιεί native browser APIs:
  //    • navigator.hardwareConcurrency  — logical cores
  //    • navigator.deviceMemory         — RAM σε GB
  // ============================================================
  const _IS_LOW_END =
    (typeof navigator !== 'undefined' && (
      (navigator.hardwareConcurrency || 4) <= 2 ||
      (navigator.deviceMemory || 4) <= 2
    ));

  // ⭐ v12.2: adaptive constants (αυξημένα σε low-end για ομαλότητα)
  const MUTATION_REFRESH_THROTTLE_MS = _IS_LOW_END ? 500 : 200;
  const TOOLTIP_DELAY_MS             = _IS_LOW_END ? 800 : 400;
  const RESIZE_DEBOUNCE_MS           = _IS_LOW_END ? 150 : 50;

  console.log(
    `[ECBF:ContentOverlay] Adaptive detection: ` +
    `low-end=${_IS_LOW_END}, ` +
    `cores=${navigator.hardwareConcurrency || 'unknown'}, ` +
    `memory=${navigator.deviceMemory || 'unknown'}GB`
  );

  // ============================================================
  //  Idempotency check
  // ============================================================
  if (document.getElementById('cbf-overlay-host')) {
    console.log('[ECBF:ContentOverlay] Already injected — aborting');
    return;
  }

  // ============================================================
  //  State
  // ============================================================
  let shadowRoot = null;
  let container = null;
  let host = null;
  let _hostGuard = null;   // D1: MutationObserver
  let activeSpace = 'firefox';
  let isUnlocked = false;
  let isPerfMode = false;
  let resizeObserver = null;
  let isClosed = false;
  let resizeDebounce = null;
  let tooltipTimer = null;
  let el = {};

  // H-6: Unified space mutex flag
  let _spaceInProgress = false;

  // M-8: Mutation event listener registration flag
  let _mutationListenerRegistered = false;

  // M-8: Throttle timer
  let _mutationRefreshTimer = null;

  // Post-MVP: Bridge lifecycle listener flag
  let _lifecycleListenerRegistered = false;

  // v1.5.4: Persistent last space
  const LAST_SPACE_KEY = 'cbf_lastSpace';

  async function _saveLastSpace(space) {
    if (space !== 'firefox' && space !== 'encrypted') return;
    try {
      await browser.storage.local.set({ [LAST_SPACE_KEY]: space });
      console.log(`[ECBF:ContentOverlay] v1.5.4: saved last space = ${space}`);
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] _saveLastSpace failed:', e.message);
    }
  }

  async function _readLastSpace() {
    try {
      const res = await browser.storage.local.get(LAST_SPACE_KEY);
      const s = res[LAST_SPACE_KEY];
      if (s === 'firefox' || s === 'encrypted') return s;
      return 'firefox';
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] _readLastSpace failed:', e.message);
      return 'firefox';
    }
  }

  // ============================================================
  //  Asset URL helper
  // ============================================================
  const ASSET = (name) => browser.runtime.getURL(`icons/${name}`);

  // ============================================================
  //  1. Δημιουργία host element
  // ============================================================
  console.log('[ECBF:ContentOverlay] Creating host element');

  host = document.createElement('div');
  host.id = 'cbf-overlay-host';
  host.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    pointer-events: none;
    padding: 0 8px 8px 8px;
    box-sizing: border-box;
    background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  document.body.appendChild(host);
  console.log('[ECBF:ContentOverlay] Host added to DOM');

    // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2 FIX: Low-end mode as OPT-IN (respect visuals)
  //
  //  ΠΡΟΒΛΗΜΑ (v12.2):
  //    Auto-detection (hardwareConcurrency ≤ 2 OR deviceMemory ≤ 2)
  //    ήταν πολύ επιθετικό. Σύγχρονα 2-core laptops (Celeron,
  //    Athlon, i3 παλιά) με αρκετή RAM έβγαιναν αυτόματα σε
  //    "flat" mode χωρίς blur effects.
  //
  //    Επιβεβαίωση από logs:
  //      [ECBF:ContentOverlay] Adaptive detection: low-end=true, cores=2
  //      [ECBF:ContentOverlay] GPU-01: low-end mode ENABLED (blur disabled)
  //
  //  ΛΥΣΗ:
  //    Low-end mode (visual part) ενεργοποιείται ΜΟΝΟ με opt-in
  //    (cbf_lowEndMode = true στο storage.local).
  //
  //  ΤΙ ΔΕΝ ΑΛΛΑΖΕΙ:
  //    Οι CPU optimizations (favicon concurrency=1, adaptive delays,
  //    skip canvas color) ΕΞΑΚΟΛΟΥΘΟΥΝ να εφαρμόζονται αυτόματα
  //    βάσει _IS_LOW_END — δεν επηρεάζουν visuals, μόνο perf.
  // ============================================================
  (async () => {
    try {
      const res = await browser.storage.local.get('cbf_lowEndMode');
      const userOptedIn = res.cbf_lowEndMode === true;

      if (userOptedIn) {
        host.classList.add('low-end');
        console.log('[ECBF:ContentOverlay] GPU-01: low-end mode ENABLED (user opt-in)');
      } else {
        console.log(
          `[ECBF:ContentOverlay] GPU-01: low-end mode DISABLED ` +
          `(auto-detect was low-end=${_IS_LOW_END}; user opt-in required)`
        );
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] Failed to read cbf_lowEndMode:', e.message);
    }
  })();

  // ═══════════════════════════════════════════════════════════
  //  D1: HOST GUARD (MutationObserver)
  //
  //  Αν page script αφαιρέσει το host → close overlay cleanly.
  // ============================================================
  _hostGuard = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node === host) {
          console.warn('[ECBF:ContentOverlay] D1: Host removed by page script — closing overlay');
          try { _hostGuard.disconnect(); } catch (_) {}
          try {
            if (typeof closeOverlayAnimated === 'function') {
              closeOverlayAnimated();
            }
          } catch (e) {
            console.error('[ECBF:ContentOverlay] D1: closeOverlayAnimated failed:', e.message);
          }
          return;
        }
      }
    }
  });
  _hostGuard.observe(document.body, { childList: true });
  console.log('[ECBF:ContentOverlay] D1: Host guard installed (MutationObserver)');

  // ============================================================
  //  2. Closed Shadow DOM (D-13.1)
  // ============================================================
  shadowRoot = host.attachShadow({ mode: 'closed' });
  console.log('[ECBF:ContentOverlay] Closed Shadow DOM attached');

  // ============================================================
  //  3. Φόρτωση CSS — inline <style> μέσω fetch
  // ============================================================
  (async function loadCSS() {
    const url = browser.runtime.getURL('overlay/injected-shadow.css');
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const cssText = await resp.text();

      const styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      if (shadowRoot.firstChild) {
        shadowRoot.insertBefore(styleEl, shadowRoot.firstChild);
      } else {
        shadowRoot.appendChild(styleEl);
      }
      console.log(`[ECBF:ContentOverlay] CSS loaded (inline, ${cssText.length} chars)`);
    } catch (e) {
      console.error('[ECBF:ContentOverlay] CSS load failed:', e.message);
      try {
        const cssLink = document.createElement('link');
        cssLink.rel = 'stylesheet';
        cssLink.href = url;
        shadowRoot.appendChild(cssLink);
        console.log('[ECBF:ContentOverlay] CSS fallback via <link>');
      } catch (_) {}
    }
  })();

  // ============================================================
  //  4. Δημιουργία container + HTML
  // ============================================================
  console.log('[ECBF:ContentOverlay] Building container + HTML');

  container = document.createElement('div');
  container.className = 'win7-aero';
  container.style.cssText = `
    width: 100%;
    max-width: 960px;
    min-height: 320px;
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    max-height: 50vh;
    position: relative;
    opacity: 1;
    transform: translateY(100%);
    will-change: transform;
  `;

  container.innerHTML = `
    <div class="overlay-inner">

      <!-- LAYER 1 — Toolbar (+ Search) -->
      <div class="layer1">
        <span class="version-tag">v12.32E</span>

        <div class="search-wrapper" id="cbf-search-wrapper">
          <input type="text"
                 class="search-bar"
                 id="cbf-search-bar"
                 placeholder="Αναζήτηση..."
                 maxlength="80"
                 autocomplete="off"
                 spellcheck="false">
          <span class="search-clear" id="cbf-search-clear">✕</span>
        </div>

        <span class="pin-label" id="cbf-pin-label">
          <img class="pin-label-icon" alt="">
          <span id="cbf-pin-label-text"></span>
        </span>

        <span class="bulk-lock" id="cbf-bulk-lock" title="Μαζική μεταφορά">
          <img alt="Bulk Lock">
          <span class="bulk-count" id="cbf-bulk-count">0</span>
        </span>

        <span class="add-icon" id="cbf-add-bookmark" title="Προσθήκη σελιδοδείκτη">
          <img alt="Bookmark">
        </span>

        <span class="add-icon" id="cbf-add-folder" title="Προσθήκη φακέλου">
          <img alt="Folder">
        </span>

        <span class="pin-btn" id="cbf-pin-folder" title="Καρφίτσωμα φακέλου">
          <img alt="Pin">
        </span>

        <span class="menu-btn" id="cbf-main-menu" title="Μενού">☰</span>

        <span class="space-btn switch" id="cbf-switch-space" title="Εναλλαγή χώρου">
          <img alt="Switch space">
        </span>

        <span class="space-btn lock" id="cbf-lock-button" title="Ξεκλείδωμα">
          <img alt="Lock">
        </span>

        <span class="close-btn" id="cbf-close-btn" title="Κλείσιμο">✕</span>
      </div>

      <!-- LAYER 2 — Breadcrumb -->
      <div class="layer2">
        <span class="home-btn" id="cbf-home-btn" title="Root">
          <img alt="Home">
        </span>
        <span class="back-btn" id="cbf-back-btn" style="display:none;">↩</span>

        <div class="breadcrumb"></div>

        <img id="cbf-space-indicator" alt="Encrypted">
        <span id="cbf-space-label">Κρυπτογραφημένος Χώρος</span>
      </div>

      <!-- MULTI-SELECT: Selection info banner -->
      <div class="selection-info" id="cbf-selection-info">
        <span id="cbf-selection-info-text">0 selected</span>
        <span class="hint">Esc για ακύρωση · Ctrl+A όλα</span>
      </div>

      <!-- LAYER 3 — Carousel -->
      <div class="layer3-wrapper">
        <span class="scroll-arrow left hidden">❮</span>
        <div class="layer3"></div>
        <span class="scroll-arrow right hidden">❯</span>
      </div>

    </div>

    <div class="cbf-tooltip" id="cbf-tooltip"></div>
  `;

  shadowRoot.appendChild(container);
  console.log('[ECBF:ContentOverlay] UI built in Shadow DOM');

  // ============================================================
  // SIGNATURE DATA URI
  // ═══════════════════════════════════════════════════════════
  // ============================================================
  const SIGNATURE_DATA_URI = 'data:image/svg+xml;base64,PHN2ZyB2ZXJzaW9uPSIxLjEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjE0NSIgaGVpZ2h0PSI3MiIgdmlld0JveD0iMCAwIDU4NiAyOTAiPgo8cGF0aCBkPSJNMCAwIEMxLjA2MzQ3NjU2IC0wLjAxNDE3OTY5IDIuMTI2OTUzMTIgLTAuMDI4MzU5MzggMy4yMjI2NTYyNSAtMC4wNDI5Njg3NSBDNS45Mzc1IDAuMTg3NSA1LjkzNzUgMC4xODc1IDcuOTM3NSAyLjE4NzUgQzguODI2OTE1ODYgNS4zMzc3OTc0MSA4LjcwNzA2MTU5IDguMDE3MjkzNDMgNy45Mzc1IDExLjE4NzUgQy0yLjI0NjYxMzM3IDI2Ljk3NjYyOTA4IC0yMi4wMzUyOTY5NyAzOC4wMjU0MjAwNCAtMzguMjUgNDYuNzUgQy0zOC44NDkxNzIzNiA0Ny4wNzI0MjY3NiAtMzkuNDQ4MzQ0NzMgNDcuMzk0ODUzNTIgLTQwLjA2NTY3MzgzIDQ3LjcyNzA1MDc4IEMtNDIuNzc1NTk4ODQgNDkuMTQxOTU3MjEgLTQ1LjM2MDkxMTggNTAuMjgwMDk4MDkgLTQ4LjI4NTE1NjI1IDUxLjE4NzUgQy01MS4yOTc2MjA2MiA1Mi4yNzIxNTY2NSAtNTIuMzU3MDIyMzEgNTMuMTQ5Nzc2OTIgLTU0LjMxMjUgNTUuNjI1IEMtNTcuMDQ2NDg3MzQgNTguOTY0NTQxNTYgLTU5Ljg2Njc0NzE5IDYyLjE1NzAwMjE0IC02Mi44MTI1IDY1LjMxMjUgQy03Mi40NDAyMTQ5MyA3NS41NDE1NDI3NSAtNzIuNDQwMjE0OTMgNzUuNTQxNTQyNzUgLTgwLjA2MjUgODcuMTg3NSBDLTczLjcwNTk5ODQyIDgzLjYxNzAzOTU0IC02Ny45NzY4MjIxOSA3OS43MDQxMzAzMyAtNjIuMzg2NzE4NzUgNzUuMDE5NTMxMjUgQy02MC4wNDI5MjUzNyA3My4xNzIwNzA1OCAtNTcuNjIyNTg1NTUgNzEuNzE0NjM5NjQgLTU1LjA2MjUgNzAuMTg3NSBDLTUzLjY1MDkxNjQxIDY5LjA4MjMyNjk1IC01Mi4yNTQ5ODg1NSA2Ny45NTY4ODA3NSAtNTAuODc1IDY2LjgxMjUgQy00My45NDk5Nzc2NCA2MS4zMzc0NDA0NCAtMzYuMzkzNDczODEgNTcuMDM4ODY5NDYgLTI3LjQzNzUgNTcuMDYyNSBDLTI2LjQ1NTIzNDM4IDU3LjA1OTkyMTg3IC0yNS40NzI5Njg3NSA1Ny4wNTczNDM3NSAtMjQuNDYwOTM3NSA1Ny4wNTQ2ODc1IEMtMjIuMDYyNSA1Ny4xODc1IC0yMi4wNjI1IDU3LjE4NzUgLTIxLjA2MjUgNTguMTg3NSBDLTIwLjU2MjUgNjEuMzc1IC0yMC41NjI1IDYxLjM3NSAtMjEuMDYyNSA2NS4xODc1IEMtMjYuMDE1NzQ3MjggNzEuNzcxMTI2NDggLTM0LjM3OTYxNDUzIDc0Ljg3NzM0NzQyIC00Mi4yNSA3NiBDLTQ3LjA4MDg2MzI3IDc2LjgyMTQ3Mjg1IC00OS4xNjU2ODkzNSA3OC43MDMyNjA3MSAtNTIuMTAxNTYyNSA4Mi41MzEyNSBDLTUzLjIyOTc4MDA3IDg0LjE1NjY4MjE3IC01My4yMjk3ODAwNyA4NC4xNTY2ODIxNyAtNTMuMDYyNSA4Ni4xODc1IEMtNDMuNDQxOTg4MjEgODUuNzUwMjA0MDEgLTM1LjA3NDIzNzYgODAuMjg3OTIwMTQgLTI3LjcyNjU2MjUgNzQuNDIxODc1IEMtMjYuMDYyNSA3My4xODc1IC0yNi4wNjI1IDczLjE4NzUgLTIzLjUgNzIuMTg3NSBDLTIwLjI4MjQ4NzQ5IDcwLjg2NzQ5NDg3IC0xOC4xNDY2MDM5IDY4Ljc3NzY0NTA4IC0xNS42MTMyODEyNSA2Ni40Mjk2ODc1IEMtMTQuMDYyNSA2NS4xODc1IC0xNC4wNjI1IDY1LjE4NzUgLTEyLjA2MjUgNjUuMTg3NSBDLTExLjY5MTI1IDYzLjgyNjI1IC0xMS42OTEyNSA2My44MjYyNSAtMTEuMzEyNSA2Mi40Mzc1IEMtOS45NzEzMDU3MiA1OC45NTAzOTQ4NyAtOS4xMTA3MDc1NyA1Ny4zMjk0ODM3IC02LjA2MjUgNTUuMTg3NSBDLTUuMDMxMjUgNTUuMjQ5Mzc1IC00IDU1LjMxMTI1IC0yLjkzNzUgNTUuMzc1IEM3LjQxNjcyNDY2IDU0Ljg3Mzk4OTEzIDE1LjU2NjQ4MjI2IDQzLjg3MjUxMDcxIDIyLjM3NSAzNi44MTI1IEMyOS41Mjc2NjcxMiAyOS40MjEwNTA2NyAzNi44NDAxMzYzMSAyMi41NjM4NjU1OSA0NC45Mzc1IDE2LjE4NzUgQzQ2LjIwMTE5MDIzIDE1LjE1MzQ0NjI5IDQ3LjQ2MzE3NzE1IDE0LjExNzMwMzc2IDQ4LjcyMjY1NjI1IDEzLjA3ODEyNSBDNjUuNDYwMTc1OSAtMC41MDczNDczNCA2NS40NjAxNzU5IC0wLjUwNzM0NzM0IDc2LjEyNSAtMC4xODM1OTM3NSBDNzcuOTM3NSAwLjE4NzUgNzcuOTM3NSAwLjE4NzUgNzkuOTM3NSAyLjE4NzUgQzgwLjc3MzU5ODE2IDYuMDYyNDkzNCA4MC42ODU0NzEzIDkuNzE2MzA2NDUgNzguODc1IDEzLjI3NzM0Mzc1IEM3Ny4zNDA4ODYwNCAxNS4zODI1ODE2NiA3NS43MTI1NTk4OSAxNy4yODA4MTQ5IDczLjkzNzUgMTkuMTg3NSBDNzMuMjg3ODEyNSAxOS44OTI2MTcxOSA3Mi42MzgxMjUgMjAuNTk3NzM0MzggNzEuOTY4NzUgMjEuMzI0MjE4NzUgQzY4LjI0MTkyNzIzIDI1LjIwMTU0NzgyIDY0LjU0ODY1MTM3IDI4LjQyMDgwOTE4IDU5LjkzNzUgMzEuMTg3NSBDNjIuNTc3NSAzMS41MTc1IDY1LjIxNzUgMzEuODQ3NSA2Ny45Mzc1IDMyLjE4NzUgQzY3LjQxODY4ODg3IDM2LjM1OTkxMDYgNjYuMjI1OTg3MjYgMzguNDQxNjY4MjEgNjMuMzc1IDQxLjUgQzYyLjczNDMzNTk0IDQyLjE5NzM4MjgxIDYyLjA5MzY3MTg4IDQyLjg5NDc2NTYyIDYxLjQzMzU5Mzc1IDQzLjYxMzI4MTI1IEM2MC45Mzk4ODI4MSA0NC4xMzI3NzM0NCA2MC40NDYxNzE4OCA0NC42NTIyNjU2MiA1OS45Mzc1IDQ1LjE4NzUgQzYyLjkwNzUgNDUuNjgyNSA2Mi45MDc1IDQ1LjY4MjUgNjUuOTM3NSA0Ni4xODc1IEM2NS45Mzc1IDQ3LjUwNzUgNjUuOTM3NSA0OC44Mjc1IDY1LjkzNzUgNTAuMTg3NSBDNjUuMTk4ODY3MTkgNTAuMTMyMDcwMzEgNjQuNDYwMjM0MzggNTAuMDc2NjQwNjMgNjMuNjk5MjE4NzUgNTAuMDE5NTMxMjUgQzU4LjU2MzQ2Mzc4IDQ5Ljk4NjkwMjU3IDU1LjEzNzM1MTI1IDUwLjI5Mzg2MDc5IDUwLjkzNzUgNTMuNDIxODc1IEM0OC4xMTc3ODY2MSA1Ni4yNTcyNTM0NiA0NS41MTQ1NDA5MyA1OS4xMzEzOTM3NyA0Mi45Mzc1IDYyLjE4NzUgQzQxLjgzMzc5MzY5IDYzLjQ1ODczMzE3IDQwLjcyOTY4MjU1IDY0LjcyOTYxNTA3IDM5LjYyNSA2NiBDMzkuMTAxNjQwNjIgNjYuNjE3NDYwOTQgMzguNTc4MjgxMjUgNjcuMjM0OTIxODcgMzguMDM5MDYyNSA2Ny44NzEwOTM3NSBDMzQuMzg3NDI5MiA3MS44OTYwMzUyOCAzMC40NjM3MzMgNzUuNjYyMDA5NjIgMjYuNTU5MzI2MTcgNzkuNDQwNjczODMgQzI1Ljk2MzUzNzYgODAuMDI0ODYwODQgMjUuMzY3NzQ5MDIgODAuNjA5MDQ3ODUgMjQuNzUzOTA2MjUgODEuMjEwOTM3NSBDMjQuMjExOTM2MDQgODEuNzM2MDY5MzQgMjMuNjY5OTY1ODIgODIuMjYxMjAxMTcgMjMuMTExNTcyMjcgODIuODAyMjQ2MDkgQzIxLjcyMTk3OTA2IDg0LjEzOTE0MjM3IDIxLjcyMTk3OTA2IDg0LjEzOTE0MjM3IDIxLjkzNzUgODYuMTg3NSBDMzIuMTcxODQ0MTYgODEuMTQyMTExOSA0MC43ODQwMzI3OSA3NC4zOTQ5MzIyNyA0OS41NzAzMTI1IDY3LjIyNjU2MjUgQzUwLjE5Mzg5NjQ4IDY2LjcyMDc2NjYgNTAuODE3NDgwNDcgNjYuMjE0OTcwNyA1MS40NTk5NjA5NCA2NS42OTM4NDc2NiBDNTIuNjI3NTI5MzQgNjQuNzQ0NDY3NDQgNTMuNzkwMzUzNDIgNjMuNzg5MTkzNjEgNTQuOTQ2Mjg5MDYgNjIuODI1NjgzNTkgQzU4LjQ2OTkyOTY5IDU5Ljk1MTk4NTg2IDYyLjA4OTE0Nzg0IDU3LjQ2NDYzNDU5IDY1Ljk1NTQ5MDExIDU1LjA2NzEzODY3IEM3Ni4zODA4NDg4MiA0OC40OTg3NTQ5NCA4NC41MTQxMDIxMiA0MC4wNDQxNzMzOCA5MyAzMS4xODc1IEMxMDIuNzA2NDA4NDkgMjEuMDgxOTU5NjQgMTEyLjEyNjk5NjUgMTEuODAxMzk4MzQgMTIzLjkzNzUgNC4xODc1IEMxMjQuNjk4NjkxNDEgMy42ODY5NDA5MiAxMjUuNDU5ODgyODEgMy4xODYzODE4NCAxMjYuMjQ0MTQwNjIgMi42NzA2NTQzIEMxMzEuODgyNjA4ODQgLTAuODg3ODgzOTcgMTM4LjQ5MTY0MzE5IC0wLjM4OTg4MjE4IDE0NC45Mzc1IDAuMTg3NSBDMTQ2LjU1MTk1OTM5IDEuODAxOTU5MzkgMTQ2LjI2MjYxNzMyIDMuNTE5Mzc0MTcgMTQ2LjM3NSA1Ljc1IEMxNDYuMjczNjY3MDggMTIuODczNzAzOTMgMTQyLjgyOTg3NzM3IDE2LjIyMjgxMzE5IDEzOC4wNjI1IDIxLjEwOTM3NSBDMTI1Ljg4MjU1NDQxIDMyLjY0MzQxNDM5IDExMC40OTc2NzA1MyA0MC43OTEwNDg3MSA5NS40MDYyNSA0Ny44MzU5Mzc1IEM4OS4wMjcxMTk0OSA1MC44MjAyMzM3IDg1LjA3ODczMjk1IDUzLjQzNTc4NzU3IDgwLjkzNzUgNTkuMTg3NSBDODEuNDgxNDg0MzggNTguODYyNjU2MjUgODIuMDI1NDY4NzUgNTguNTM3ODEyNSA4Mi41ODU5Mzc1IDU4LjIwMzEyNSBDODUuMzk3ODcyODEgNTYuOTg4NjY3ODkgODcuNTA4NTYyMiA1Ni45MjEwMzY3MiA5MC41NjI1IDU2LjkzNzUgQzkxLjUyNDE0MDYyIDU2LjkzMjM0Mzc1IDkyLjQ4NTc4MTI1IDU2LjkyNzE4NzUgOTMuNDc2NTYyNSA1Ni45MjE4NzUgQzk1LjkzNzUgNTcuMTg3NSA5NS45Mzc1IDU3LjE4NzUgOTcuOTM3NSA1OS4xODc1IEM5OC43Mjg3MTI4NSA2My43MDY1NDI2MSA5OC44NTMzNDQxMiA2OC4yNDEzMzEyNSA5Ni44NzUgNzIuNDQ1MzEyNSBDOTMuMjk2MzM3NTUgNzcuNDA0ODcxODggODguNjYzNDc4MjQgODEuMzQ5MTQyMDQgODMuOTM3NSA4NS4xODc1IEM4OS45NTQyNDI5MyA4Mi40NDk3MjI3OSA5NC43MjYwNDU5NCA3OC43OTE2NzE4NCA5OS42MjUgNzQuNDM3NSBDMTA4LjkzNTYzMDU3IDY2LjIwNTE4MzM3IDExOS43MTk1NTc3NyA1Ni44MDM5MTk0NyAxMzIuNzUgNTcgQzEzMy43MDUxOTUzMSA1Ny4wMDY0NDUzMSAxMzQuNjYwMzkwNjIgNTcuMDEyODkwNjMgMTM1LjY0NDUzMTI1IDU3LjAxOTUzMTI1IEMxMzcuOTM3NSA1Ny4xODc1IDEzNy45Mzc1IDU3LjE4NzUgMTM4LjkzNzUgNTguMTg3NSBDMTM5LjQzNzUgNjEuMzc1IDEzOS40Mzc1IDYxLjM3NSAxMzguOTM3NSA2NS4xODc1IEMxMzMuOTg0MjUyNzIgNzEuNzcxMTI2NDggMTI1LjYyMDM4NTQ3IDc0Ljg3NzM0NzQyIDExNy43NSA3NiBDMTEyLjkxOTEzNjczIDc2LjgyMTQ3Mjg1IDExMC44MzQzMTA2NSA3OC43MDMyNjA3MSAxMDcuODk4NDM3NSA4Mi41MzEyNSBDMTA2Ljc3MDIxOTkzIDg0LjE1NjY4MjE3IDEwNi43NzAyMTk5MyA4NC4xNTY2ODIxNyAxMDYuOTM3NSA4Ni4xODc1IEMxMTYuNDAyNDA5NDUgODUuNzU3Mjc2ODQgMTI0LjkxNTU0OTY4IDgwLjQzMzUxMzM1IDEzMi4xMjEwOTM3NSA3NC41ODIwMzEyNSBDMTM0LjI5MDUxNjA5IDcyLjkxNjQ3NDc0IDEzNi41ODYxNDEzOSA3MS41ODM1MDkwMSAxMzguOTM3NSA3MC4xODc1IEMxNDUuNzczMjAwNiA2Ni4wMzc3NDM1OSAxNDUuNzczMjAwNiA2Ni4wMzc3NDM1OSAxNDkuNzY5NTMxMjUgNTkuNDc2NTYyNSBDMTQ5Ljk3NzExMDQxIDU3LjAyMDc5NTUyIDE0OS45ODA2Njg1NyA1NC42NDgxMDg0OSAxNDkuOTM3NSA1Mi4xODc1IEMxNTAuOTM3NSA1MS4xODc1IDE1MC45Mzc1IDUxLjE4NzUgMTUyLjc4NTE1NjI1IDUxLjA4OTg0Mzc1IEMxNTQuODM1OTM3NSA1MS4xMjIzOTU4MyAxNTYuODg2NzE4NzUgNTEuMTU0OTQ3OTIgMTU4LjkzNzUgNTEuMTg3NSBDMTU5LjkyNzUgNTQuMTU3NSAxNTkuOTI3NSA1NC4xNTc1IDE2MC45Mzc1IDU3LjE4NzUgQzE2Mi4wMzA2MjUgNTcuMTA1IDE2My4xMjM3NSA1Ny4wMjI1IDE2NC4yNSA1Ni45Mzc1IEMxNjcuOTM3NSA1Ny4xODc1IDE2Ny45Mzc1IDU3LjE4NzUgMTY5Ljg3NSA1OC44NzUgQzE3MS4xNzQxNTg4OSA2MS43MDI1ODExMSAxNzEuMzY4NzY5NjIgNjMuMDkzMDI5MzMgMTcwLjkzNzUgNjYuMTg3NSBDMTY5LjMyOTgzOTA4IDY4LjMzMDA2MjggMTY3LjgwMjk4NDc2IDcwLjExMjg2MjU3IDE2NS45Mzc1IDcyIEMxNjUuMTkzNDI4OTYgNzIuNzgwNjg4NDggMTY1LjE5MzQyODk2IDcyLjc4MDY4ODQ4IDE2NC40MzQzMjYxNyA3My41NzcxNDg0NCBDMTYyLjk0ODkyODI3IDc1LjEyNzgzNTkyIDE2MS40NDY3NTQyNiA3Ni42NjAwNTU4NyAxNTkuOTM3NSA3OC4xODc1IEMxNTkuMTA4NjMyODEgNzkuMDMxODM1OTQgMTU4LjI3OTc2NTYyIDc5Ljg3NjE3MTg4IDE1Ny40MjU3ODEyNSA4MC43NDYwOTM3NSBDMTU1LjYxMDE0NDQgODIuNTc0NzY5MjggMTUzLjc4MzI3NDg5IDg0LjM4OTMyMzg5IDE1MS45Mzc1IDg2LjE4NzUgQzE1OC41ODYyMzA4NiA4My4yNDUwODI5NCAxNjQuMDcwMTgxMTEgNzkuNzY0MDMyMDggMTY5LjYxMzI4MTI1IDc1LjA1NDY4NzUgQzE3MS45Mzc1IDczLjE4NzUgMTcxLjkzNzUgNzMuMTg3NSAxNzQuNDU3MDMxMjUgNzEuNjg3NSBDMTc3LjA1MTY4MzYgNzAuMTE4NDUwMzkgMTc5LjA5MjQ2NjQyIDY4LjM3MjI0MjM0IDE4MS4zMTI1IDY2LjMxMjUgQzE4Mi40OTE5OTIxOSA2NS4yNjQ0OTIxOSAxODIuNDkxOTkyMTkgNjUuMjY0NDkyMTkgMTgzLjY5NTMxMjUgNjQuMTk1MzEyNSBDMTg1LjAyNDEzNzc2IDYzLjAwNTM4ODg0IDE4Ni4zMzgxNzkxMyA2MS43OTgwMDI2MSAxODcuNjE3MTg3NSA2MC41NTQ2ODc1IEMxOTMuMDAwMDczNzggNTUuODY4MDk0OTYgMTk5LjEzODA3NDM2IDU2LjcyNzM4ODQ5IDIwNS45Mzc1IDU3LjE4NzUgQzIwNS40Njg0NTggNjEuODI3NTE4NTEgMjAzLjgyMTcyOTQzIDYzLjc1ODk2NTU2IDIwMC41IDY2Ljk0NTMxMjUgQzE5OS42MDUzOTA2MiA2Ny44MTgwMDc4MSAxOTguNzEwNzgxMjUgNjguNjkwNzAzMTIgMTk3Ljc4OTA2MjUgNjkuNTg5ODQzNzUgQzE5Ni44NDgwNDY4OCA3MC40ODgzMjAzMSAxOTUuOTA3MDMxMjUgNzEuMzg2Nzk2ODggMTk0LjkzNzUgNzIuMzEyNSBDMTkzLjA3ODk4OTQ5IDc0LjEwMjI3MTA4IDE5MS4yMjQ2MDc3MSA3NS44OTYzNDI0NyAxODkuMzc1IDc3LjY5NTMxMjUgQzE4OC41NDg3MTA5NCA3OC40ODU2Njg5NSAxODcuNzIyNDIxODggNzkuMjc2MDI1MzkgMTg2Ljg3MTA5Mzc1IDgwLjA5MDMzMjAzIEMxODQuNzMwNTgxMTQgODIuMTIzOTU5MSAxODQuNzMwNTgxMTQgODIuMTIzOTU5MSAxODMuOTM3NSA4NS4xODc1IEMxODkuNTkxNjIxNjggODEuMjQyNTEzOTYgMTk1LjAzNjQ4MDA1IDc3LjIyMzY3OTI0IDIwMC4xMjUgNzIuNTYyNSBDMjEwLjc4ODEyODI2IDYyLjgyMDA1MDAxIDIyMC40MjY1OTk3MiA1Ni40NTE2OTUyNSAyMzUuNDE3OTY4NzUgNTYuOTE0MDYyNSBDMjM3LjkzNzUgNTcuMTg3NSAyMzcuOTM3NSA1Ny4xODc1IDIzOC45Mzc1IDU4LjE4NzUgQzIzOS40ODMzMjIxNiA2My44NTU2NTMxOCAyMzkuNjM5NTg0OTggNjguNTU5ODkzNzggMjM1LjkzNzUgNzMuMTg3NSBDMjM2LjkyNzUgNzMuMTg3NSAyMzcuOTE3NSA3My4xODc1IDIzOC45Mzc1IDczLjE4NzUgQzIzOS4xMzYwMTU2MyA3Mi42MzMyMDMxMiAyMzkuMzM0NTMxMjUgNzIuMDc4OTA2MjUgMjM5LjUzOTA2MjUgNzEuNTA3ODEyNSBDMjQxLjUwMjAwODMzIDY4LjI1MDg1NzY4IDI0NC4zMTM4NjQ3MyA2Ni4zMDQ2NzU5MiAyNDcuMzEyNSA2NC4wNjI1IEMyNTEuMDY0MDU3NjIgNjEuMjEwNDQxNDkgMjU0Ljc4ODIwOTI2IDU4LjM2ODg3NTAxIDI1OC4zMjAzMTI1IDU1LjI0NjA5Mzc1IEMyNTkuMTEwNDI3MjUgNTQuNTUzMTQyMDkgMjU5LjExMDQyNzI1IDU0LjU1MzE0MjA5IDI1OS45MTY1MDM5MSA1My44NDYxOTE0MSBDMjYxLjM1ODkwNjQzIDUyLjU2OTU2MDk5IDI2Mi43ODkyMDI5NSA1MS4yNzkyOTA3MyAyNjQuMjE4NzUgNDkuOTg4MjgxMjUgQzI2Ny40MDU4MTM3NCA0Ny44NzczMDk0NCAyNjkuMTg5NjM1NCA0Ny44MDcyMDE5NyAyNzIuOTM3NSA0OC4xODc1IEMyNzMuMTg3NSA1MC41IDI3My4xODc1IDUwLjUgMjcyLjkzNzUgNTMuMTg3NSBDMjcyLjI4NzgxMjUgNTMuNTU4NzUgMjcxLjYzODEyNSA1My45MyAyNzAuOTY4NzUgNTQuMzEyNSBDMjY4LjE4MTAwNzA4IDU2Ljg4NTgwMTE1IDI2OC4zODY4Mzg0IDU4LjgxOTQ1MzkzIDI2OC4yMzA0Njg3NSA2Mi40OTQxNDA2MiBDMjY4LjIxNjI4OTA2IDYzLjI3OTgyNDIyIDI2OC4yMDIxMDkzNyA2NC4wNjU1MDc4MSAyNjguMTg3NSA2NC44NzUgQzI2OC4xNTc4NTE1NiA2NS42NzIyODUxNiAyNjguMTI4MjAzMTMgNjYuNDY5NTcwMzEgMjY4LjA5NzY1NjI1IDY3LjI5MTAxNTYyIEMyNjguMDI3MDU5MTggNjkuMjU1OTY3NDkgMjY3Ljk4MDAwMjkyIDcxLjIyMTczOTc3IDI2Ny45Mzc1IDczLjE4NzUgQzI2OS4yNTc1IDczLjE4NzUgMjcwLjU3NzUgNzMuMTg3NSAyNzEuOTM3NSA3My4xODc1IEMyNzIuMjY5NTMxMjUgNzUuNDA2MjUgMjcyLjI2OTUzMTI1IDc1LjQwNjI1IDI3MS45Mzc1IDc4LjE4NzUgQzI2My43ODgwMTc4OCA4Ni40OTM0Mjk0MiAyNTMuMTA5MDk0MTYgOTIuMzg3OTIxMDkgMjQxLjQzNzUgOTIuNjg3NSBDMjM1LjYwNjY1MDExIDkyLjYzNTg5OTU2IDIzNS42MDY2NTAxMSA5Mi42MzU4OTk1NiAyMzMuMDQyOTY4NzUgOTAuOTE3OTY4NzUgQzIzMS4wNTQ3NzE0NCA4Ny44MDU3MDIyOSAyMzEuNzYwMjc3OCA4NC43OTEwMTgwNCAyMzEuOTM3NSA4MS4xODc1IEMyMjcuNzI2MDU1OSA4MS43NjY5NjE2IDIyNC43MTk1MjY2OCA4NC4yNTcxNjkwMiAyMjEuMzc1IDg2LjY4NzUgQzIxNi4wNjIxMDM4NSA5MC41MjIyODMxNCAyMTIuNTM1MjAyODYgOTIuMzM0NTM3MDQgMjA1Ljg3NSA5Mi4zNzUgQzIwNC44MTE1MjM0NCA5Mi4zODkxNzk2OSAyMDMuNzQ4MDQ2ODggOTIuNDAzMzU5MzcgMjAyLjY1MjM0Mzc1IDkyLjQxNzk2ODc1IEMxOTkuOTM3NSA5Mi4xODc1IDE5OS45Mzc1IDkyLjE4NzUgMTk3LjkzNzUgOTAuMTg3NSBDMTk3LjMxMjUgODcuNTYyNSAxOTcuMzEyNSA4Ny41NjI1IDE5Ni45Mzc1IDg1LjE4NzUgQzE5Ni4zMTEwMTU2MiA4NS42MDkwMjM0NCAxOTUuNjg0NTMxMjUgODYuMDMwNTQ2ODcgMTk1LjAzOTA2MjUgODYuNDY0ODQzNzUgQzE5My44MTMxNjQwNiA4Ny4yODY2MjEwOSAxOTMuODEzMTY0MDYgODcuMjg2NjIxMDkgMTkyLjU2MjUgODguMTI1IEMxOTEuNzUwMzkwNjMgODguNjcwMjczNDQgMTkwLjkzODI4MTI1IDg5LjIxNTU0Njg4IDE5MC4xMDE1NjI1IDg5Ljc3NzM0Mzc1IEMxODYuNzg0MjgyOTEgOTEuOTM4OTY0NTcgMTg0Ljg4Mzk2MzExIDkyLjM0NjMxOTMxIDE4MC45Mzc1IDkyLjM3NSBDMTc5LjYwNzE4NzUgOTIuMzk2MjY5NTMgMTc5LjYwNzE4NzUgOTIuMzk2MjY5NTMgMTc4LjI1IDkyLjQxNzk2ODc1IEMxNzUuOTM3NSA5Mi4xODc1IDE3NS45Mzc1IDkyLjE4NzUgMTczLjkzNzUgOTAuMTg3NSBDMTczLjc0MjE4NzUgODguMDIzNDM3NSAxNzMuNzQyMTg3NSA4OC4wMjM0Mzc1IDE3My44MTI1IDg1LjU2MjUgQzE3My44MzA1NDY4NyA4NC43NDUyMzQzNyAxNzMuODQ4NTkzNzUgODMuOTI3OTY4NzUgMTczLjg2NzE4NzUgODMuMDg1OTM3NSBDMTczLjkwMTk5MjE5IDgyLjE0NjIxMDk0IDE3My45MDE5OTIxOSA4Mi4xNDYyMTA5NCAxNzMuOTM3NSA4MS4xODc1IEMxNzMuMzA4NDM3NSA4MS42NDY0MDYyNSAxNzIuNjc5Mzc1IDgyLjEwNTMxMjUgMTcyLjAzMTI1IDgyLjU3ODEyNSBDMTU2LjMyNjQyNjgxIDkzLjgzNjQwMTg2IDE1Ni4zMjY0MjY4MSA5My44MzY0MDE4NiAxNDQuOTM3NSA5Mi4xODc1IEMxNDIuNDY3NTM1NzYgODkuNzE3NTM1NzYgMTQyLjYxNDE4MjIyIDg4Ljg0ODUyNjY3IDE0Mi41NjI1IDg1LjQzNzUgQzE0Mi42NjA3MDU4NSA4MC41NjIyODA5NCAxNDMuNzU4MzA2NzUgNzcuOTg0ODY5NzIgMTQ2LjkzNzUgNzQuMTg3NSBDMTQ4LjA1MTI1IDcyLjc2NDM3NSAxNDguMDUxMjUgNzIuNzY0Mzc1IDE0OS4xODc1IDcxLjMxMjUgQzE0OS43NjUgNzAuNjExMjUgMTUwLjM0MjUgNjkuOTEgMTUwLjkzNzUgNjkuMTg3NSBDMTUwLjQxODAwNzgxIDY5LjY1ODAwNzgxIDE0OS44OTg1MTU2MiA3MC4xMjg1MTU2MyAxNDkuMzYzMjgxMjUgNzAuNjEzMjgxMjUgQzE0NS42OTEwMzA2MSA3My44OTE4MzQwNCAxNDIuMTkxMDUyOTQgNzYuNjk3NjE1MzUgMTM3LjkzNzUgNzkuMTg3NSBDMTM2LjYwMDQyMDcyIDgwLjI4NzEyNzU3IDEzNS4yNjc2MjIyIDgxLjM5MTk2NzE3IDEzMy45Mzc1IDgyLjUgQzEyNS4xODk4NTQ5NSA4OS4zMDY5NDIzNCAxMTYuNzYyNDc1NTEgOTIuODk1NzgxOTUgMTA1LjYxNzE4NzUgOTIuNjkxNDA2MjUgQzEwMi45Mzc1IDkyLjE4NzUgMTAyLjkzNzUgOTIuMTg3NSAxMDEuMTMyODEyNSA5MC45NjQ4NDM3NSBDOTkuNjQ0NDM2MTggODguNzUxNzM1MTYgOTkuMjkxODg2MDMgODYuODA5OTU2NjYgOTguOTM3NSA4NC4xODc1IEM5Ny45MDY4OTQ1MyA4NC45MjgwNjY0MSA5Ny45MDY4OTQ1MyA4NC45MjgwNjY0MSA5Ni44NTU0Njg3NSA4NS42ODM1OTM3NSBDOTUuOTU0NDE0MDYgODYuMzI0MjU3ODEgOTUuMDUzMzU5MzggODYuOTY0OTIxODggOTQuMTI1IDg3LjYyNSBDOTMuMjMxNjc5NjkgODguMjYzMDg1OTQgOTIuMzM4MzU5MzcgODguOTAxMTcxODcgOTEuNDE3OTY4NzUgODkuNTU4NTkzNzUgQzg3LjgzMDYzMTk2IDkxLjkxNDM3MjQgODUuMDc4Mjk0MiA5Mi4zNDQwNDc5MSA4MC44NzUgOTIuMzc1IEM3OS45OTcxNDg0NCA5Mi4zODkxNzk2OSA3OS4xMTkyOTY4OCA5Mi40MDMzNTkzNyA3OC4yMTQ4NDM3NSA5Mi40MTc5Njg3NSBDNzUuOTM3NSA5Mi4xODc1IDc1LjkzNzUgOTIuMTg3NSA3My45Mzc1IDkwLjE4NzUgQzczLjAwNzAzMTQ3IDg2LjM1OTI4NjYgNzMuMDQwMTk2NSA4My4wMTk2MzA0NCA3My45Mzc1IDc5LjE4NzUgQzc2Ljc4NjUzNzMyIDc1LjI2Mzc3NjcgODAuMjIxOTY3MTIgNzIuMjc3NDg1OTggODMuOTM3NSA2OS4xODc1IEM4NC42NzA5NzY1NiA2OC41NDE2Nzk2OSA4NS40MDQ0NTMxMyA2Ny44OTU4NTkzNyA4Ni4xNjAxNTYyNSA2Ny4yMzA0Njg3NSBDODcuNzI4NzU0OSA2NS44NTUxMjY2MSA4OS4zMjkxNDk2NiA2NC41MTYxMzcyNCA5MC45Mzc1IDYzLjE4NzUgQzc5LjU1OTA5NjYzIDY3Ljc1NTk5MzIgNzAuNDg5NDI5MDMgNzUuMjM5NjI4NzEgNjEuNjkxNDA2MjUgODMuNjA5Mzc1IEM2MC4zMjgyMjI2NiA4NC44ODU1NDY4NyA2MC4zMjgyMjI2NiA4NC44ODU1NDY4NyA1OC45Mzc1IDg2LjE4NzUgQzU4LjQ2MjgwMjczIDg2LjY1ODg5NDA0IDU3Ljk4ODEwNTQ3IDg3LjEzMDI4ODA5IDU3LjQ5OTAyMzQ0IDg3LjYxNTk2NjggQzU0LjgxNjI4MDkzIDkwLjExODUzMTcyIDUzLjE3MTA3MjMgOTEuMTU0MjQ2NTQgNDkuNTA3ODEyNSA5MS42NzU3ODEyNSBDNDguMzcwODU5MzggOTEuNjE3NzczNDQgNDcuMjMzOTA2MjUgOTEuNTU5NzY1NjMgNDYuMDYyNSA5MS41IEM0NC4zMzM4NjcxOSA5MS40MzIzMjQyMiA0NC4zMzM4NjcxOSA5MS40MzIzMjQyMiA0Mi41NzAzMTI1IDkxLjM2MzI4MTI1IEM0MS43MDE0ODQzOCA5MS4zMDUyNzM0NCA0MC44MzI2NTYyNSA5MS4yNDcyNjU2MyAzOS45Mzc1IDkxLjE4NzUgQzQwLjQzNjIxMDY0IDg2LjczMDc2ODQxIDQxLjk1NzU0MzYyIDg0LjYxMDYyODIyIDQ1IDgxLjM3NSBDNDUuNzMzNDc2NTYgODAuNTg0ODA0NjkgNDYuNDY2OTUzMTMgNzkuNzk0NjA5MzcgNDcuMjIyNjU2MjUgNzguOTgwNDY4NzUgQzQ3Ljc4ODU1NDY5IDc4LjM4ODc4OTA2IDQ4LjM1NDQ1MzEyIDc3Ljc5NzEwOTM3IDQ4LjkzNzUgNzcuMTg3NSBDNDguNDg3NjE3MTkgNzcuNTM5NDE0MDYgNDguMDM3NzM0MzggNzcuODkxMzI4MTMgNDcuNTc0MjE4NzUgNzguMjUzOTA2MjUgQzI5LjAzMzU1Nzc1IDkyLjQ4NDUxMzc5IDI5LjAzMzU1Nzc1IDkyLjQ4NDUxMzc5IDIwLjMxMjUgOTIuNDM3NSBDMTkuMzUwODU5MzggOTIuNDQyNjU2MjUgMTguMzg5MjE4NzUgOTIuNDQ3ODEyNSAxNy4zOTg0Mzc1IDkyLjQ1MzEyNSBDMTQuOTM3NSA5Mi4xODc1IDE0LjkzNzUgOTIuMTg3NSAxMi45Mzc1IDkwLjE4NzUgQzEyLjc0MjE4NzUgODcuODA0Njg3NSAxMi43NDIxODc1IDg3LjgwNDY4NzUgMTIuODEyNSA4NS4wNjI1IEMxMi44MzA1NDY4NyA4NC4xNTI0MjE4OCAxMi44NDg1OTM3NSA4My4yNDIzNDM3NSAxMi44NjcxODc1IDgyLjMwNDY4NzUgQzEyLjg5MDM5MDYzIDgxLjYwNjAxNTYyIDEyLjkxMzU5Mzc1IDgwLjkwNzM0Mzc1IDEyLjkzNzUgODAuMTg3NSBDMTEuODY1IDgwLjY4MjUgMTAuNzkyNSA4MS4xNzc1IDkuNjg3NSA4MS42ODc1IEM1Ljg3MDQwNjY4IDgzLjE5OTU1MjgxIDMuMjMzNjEyMTYgODMuMDg4MTczMzcgLTAuODEyNSA4Mi42MjUgQy01LjE1MzE1OTU1IDgyLjQ4NzgxMTAxIC02LjcxNjQzMDg0IDgyLjkyOTUzNjU3IC0xMC4yNTM5MDYyNSA4NS41NjY0MDYyNSBDLTEzLjQxMDEyMTgxIDg4LjU3OTkzNzUzIC0xNi4yNTcyMzY0NCA5MS44NDk0OTU3MSAtMTkuMDYyNSA5NS4xODc1IEMtMTkuNjk2NzE4NzUgOTUuOTEwNjY0MDYgLTIwLjMzMDkzNzUgOTYuNjMzODI4MTIgLTIwLjk4NDM3NSA5Ny4zNzg5MDYyNSBDLTIyLjA3MzIyMTUzIDk4LjYyMDcwOTggLTIzLjE1Mjc5NTgyIDk5Ljg3MDcwODUzIC0yNC4yMjI2NTYyNSAxMDEuMTI4OTA2MjUgQy0yNy4wMTgxMDA4OCAxMDQuMjU2NzE3OTcgLTMwLjAyNDI3MDEyIDEwNy4xNzAwMzU5NyAtMzMuMDA5Mjc3MzQgMTEwLjExNDc0NjA5IEMtMzUuNzAwNDk5OTUgMTEyLjc4MzcwNDE5IC0zOC4yODEyMjQ4NiAxMTUuNDk5NDcwMTUgLTQwLjc1IDExOC4zNzUgQy00MS41Njc5MTAxNiAxMTkuMzA4OTI1NzggLTQxLjU2NzkxMDE2IDExOS4zMDg5MjU3OCAtNDIuNDAyMzQzNzUgMTIwLjI2MTcxODc1IEMtNDMuNTg4MjEwNTMgMTIxLjYzNzMyNDIyIC00NC43NDQwMzk1NyAxMjMuMDM5MDU4MDQgLTQ1Ljg3ODkwNjI1IDEyNC40NTcwMzEyNSBDLTUwLjYzNzQ5MjY3IDEyOS45NDYyMjg5MiAtNTAuNjM3NDkyNjcgMTI5Ljk0NjIyODkyIC01NS4wMTU2MjUgMTMwLjY4NzUgQy01Ny43NDU1NzI3NCAxMzAuNjg3NSAtNjAuMzU3Nzk4NzUgMTMwLjU0NTQ3NTE3IC02My4wNjI1IDEzMC4xODc1IEMtNjMuMzgxNTc2NTEgMTI3LjA4ODIzNzIyIC02My40MDA3NTIxNiAxMjUuNjQ2ODQzNTQgLTYxLjUyMTI0MDIzIDEyMy4wOTQ0ODI0MiBDLTYwLjQ1NjkxNzcyIDEyMi4wNzg5ODMxNSAtNjAuNDU2OTE3NzIgMTIyLjA3ODk4MzE1IC01OS4zNzEwOTM3NSAxMjEuMDQyOTY4NzUgQy01OC41OTA1NjY0MSAxMjAuMjgzMDY2NDEgLTU3LjgxMDAzOTA2IDExOS41MjMxNjQwNiAtNTcuMDA1ODU5MzggMTE4Ljc0MDIzNDM4IEMtNTYuMTc4OTI1NzggMTE3Ljk1OTcwNzAzIC01NS4zNTE5OTIxOSAxMTcuMTc5MTc5NjkgLTU0LjUgMTE2LjM3NSBDLTUyLjg5MjEyODQ2IDExNC44MjkzMTg1IC01MS4yODY2MzE3MSAxMTMuMjgxMTYyNjIgLTQ5LjY4MzU5Mzc1IDExMS43MzA0Njg3NSBDLTQ4LjkwMDI0NjU4IDExMC45NzMwNjM5NiAtNDguMTE2ODk5NDEgMTEwLjIxNTY1OTE4IC00Ny4zMDk4MTQ0NSAxMDkuNDM1MzAyNzMgQy00NC41OTI5NzMxOSAxMDYuNzE3ODcxMTcgLTQyLjA3MTI0Njc2IDEwMy44NzMxNDM0NyAtMzkuNTc0OTUxMTcgMTAwLjk1Mzg1NzQyIEMtMzcuNjExNzk1OTkgOTguNjYxMTMzMDEgLTM1LjU1MzIxODQ0IDk2LjQ2MjAzMDkxIC0zMy41IDk0LjI1IEMtMjkuNTEzODYzNzUgODkuODQ3NTAzNjMgLTI2LjE3NDAwNzg4IDg1LjIzOTEyNDU2IC0yMy4wNjI1IDgwLjE4NzUgQy0yMy42NTY3NTc4MSA4MC42MzQ4MDQ2OSAtMjQuMjUxMDE1NjIgODEuMDgyMTA5MzggLTI0Ljg2MzI4MTI1IDgxLjU0Mjk2ODc1IEMtMzQuNDUxMDQ3NTMgODguNTM2MjIyODUgLTQyLjI0MzIxMjkzIDkyLjc3MjMwMDg0IC01NC4zMTI1IDkyLjY1NjI1IEMtNTcuMDYyNSA5Mi4xODc1IC01Ny4wNjI1IDkyLjE4NzUgLTU4Ljg3NSA5MS4wMzEyNSBDLTYwLjQ5OTk1MjU2IDg4LjUwODI5NzM0IC02MC43MzQ2NDY2NiA4Ni4xMzgxODAwMyAtNjEuMDYyNSA4My4xODc1IEMtNjEuNzM3OTY4NzUgODMuNjY5NjA5MzcgLTYyLjQxMzQzNzUgODQuMTUxNzE4NzUgLTYzLjEwOTM3NSA4NC42NDg0Mzc1IEMtNjQuMDAxNDA2MjUgODUuMjgwMDc4MTIgLTY0Ljg5MzQzNzUgODUuOTExNzE4NzUgLTY1LjgxMjUgODYuNTYyNSBDLTY2LjY5NDIxODc1IDg3LjE4ODk4NDM4IC02Ny41NzU5Mzc1IDg3LjgxNTQ2ODc1IC02OC40ODQzNzUgODguNDYwOTM3NSBDLTcyLjc5NjI2NTIzIDkxLjM0ODU5NzMyIC03NS40MzA3MTQwNSA5Mi40NjU4Mzg0NyAtODAuNjg3NSA5Mi40Mzc1IEMtODEuNjQ5MTQwNjMgOTIuNDQyNjU2MjUgLTgyLjYxMDc4MTI1IDkyLjQ0NzgxMjUgLTgzLjYwMTU2MjUgOTIuNDUzMTI1IEMtODYuMDYyNSA5Mi4xODc1IC04Ni4wNjI1IDkyLjE4NzUgLTg4LjA2MjUgOTAuMTg3NSBDLTg4LjI5Mjk2ODc1IDg3LjkxMDE1NjI1IC04OC4yOTI5Njg3NSA4Ny45MTAxNTYyNSAtODguMjUgODUuMjUgQy04OC4yNDM1NTQ2OSA4NC4zNzQ3MjY1NiAtODguMjM3MTA5MzcgODMuNDk5NDUzMTMgLTg4LjIzMDQ2ODc1IDgyLjU5NzY1NjI1IEMtODguMDYyNSA4MC4xODc1IC04OC4wNjI1IDgwLjE4NzUgLTg3LjA2MjUgNzcuMTg3NSBDLTg4LjcxMjUgNzYuODU3NSAtOTAuMzYyNSA3Ni41Mjc1IC05Mi4wNjI1IDc2LjE4NzUgQy05MS40NjIxOTA3IDY5LjU0ODc4NTM2IC04Ni41MTI5NjgwNiA2Ni41NTA0NzI1MiAtODEuNjc2NzU3ODEgNjIuNTA1ODU5MzggQy03MC4yNTg5OTkyMyA1My4xODEwMTExNyAtNzAuMjU4OTk5MjMgNTMuMTgxMDExMTcgLTY2LjEwMTU2MjUgNTEuMzAwNTM3MTEgQy02My43NDc3Mjk0NyA1MC4wMTU2ODAyMSAtNjIuNTA3Njc1MjkgNDguNjMyNjQ4MDEgLTYwLjgwODU5Mzc1IDQ2LjU2NjQwNjI1IEMtNTcuMTEyOTY1MzggNDIuMjAzMTQyMzggLTUzLjE3ODM2MDU5IDM4LjE1NDkwODE2IC00OS4xMjUgMzQuMTI1IEMtNDguMTI4MjMyNDIgMzMuMTIyNDMxNjQgLTQ4LjEyODIzMjQyIDMzLjEyMjQzMTY0IC00Ny4xMTEzMjgxMiAzMi4wOTk2MDkzOCBDLTQyLjU5MzE3MDg3IDI3LjU5MDIxNjczIC0zNy45MDQ3ODYyOSAyMy4zNDQ1NTEyIC0zMy4wNjI1IDE5LjE4NzUgQy0zMS45ODI1NjE0NCAxOC4yNDAxNjYwOSAtMzAuOTAzMTAxMjYgMTcuMjkyMjg2NDQgLTI5LjgyNDIxODc1IDE2LjM0Mzc1IEMtMTEuMDgzMzExNDUgMC4wNjczMzQ4MiAtMTEuMDgzMzExNDUgMC4wNjczMzQ4MiAwIDAgWiBNLTI0LjA2MjUgMjIuMTg3NSBDLTI0LjY2MzA0MTk5IDIyLjc2NzU3ODEyIC0yNS4yNjM1ODM5OCAyMy4zNDc2NTYyNSAtMjUuODgyMzI0MjIgMjMuOTQ1MzEyNSBDLTI3LjY3OTYyNTg3IDI1LjY4NDY2NzU4IC0yOS40NjY5OTc2NiAyNy40MzM0OTc3IC0zMS4yNSAyOS4xODc1IEMtMzEuODAyNjg1NTUgMjkuNzI2OTcyNjYgLTMyLjM1NTM3MTA5IDMwLjI2NjQ0NTMxIC0zMi45MjQ4MDQ2OSAzMC44MjIyNjU2MiBDLTM1LjUyODI5ODM2IDMzLjQyMDg1NjMgLTM3LjcwODQ0NDA1IDM1LjczMTc0OTg0IC0zOS4wNjI1IDM5LjE4NzUgQy0yNC40NzYzMDg1NCAzMy45OTgxODE4OCAtNi41MzQ0NDQ5NyAyMS4yNDk2OTg3OSAxLjkzNzUgOC4xODc1IEMxLjkzNzUgNy4xOTc1IDEuOTM3NSA2LjIwNzUgMS45Mzc1IDUuMTg3NSBDLTguODYwMjU1OTcgNS4xODc1IC0xNi44MTk3NTU2MSAxNS4xMjE4MDQ5OSAtMjQuMDYyNSAyMi4xODc1IFogTTQ0LjA2MjUgMjYuMzc1IEM0My4zMjQ1MTE3MiAyNy4wNjQ0MDY3NCA0Mi41ODY1MjM0NCAyNy43NTM4MTM0OCA0MS44MjYxNzE4OCAyOC40NjQxMTEzMyBDMzguMjQwMTE1NDQgMzEuODU3NDcwNjQgMzQuODg5NDAxMzkgMzUuMjA3ODQyMzcgMzEuOTM3NSAzOS4xODc1IEM0Ny43NzQwMjEzNiAzNS43MTQxMDI1OCA2My40MDI4NTM4MiAyMS42MzU1MTAzIDcyLjkzNzUgOS4xODc1IEM3My43OTAyOTMzOCA2Ljk3MDE0NTYxIDczLjc5MDI5MzM4IDYuOTcwMTQ1NjEgNzMuOTM3NSA1LjE4NzUgQzYzLjMyNzUxMDMyIDUuMTg3NSA1MS4yNTgxNTY3NCAxOS42NDQ2ODQ3MyA0NC4wNjI1IDI2LjM3NSBaIE0xMTkuODI4MTI1IDE3LjQ0OTIxODc1IEMxMTcuNTAwMDIxMTYgMTkuNjU0NjI1MjMgMTE1LjE0MDUwNDk5IDIxLjc1MDYyMzc2IDExMi42ODc1IDIzLjgxMjUgQzEwOC4zNTAyMTEyNCAyNy41NTc1MTE5MyAxMDQuNjQ5NDA2ODIgMzEuODMzOTA3MTYgMTAwLjkzNzUgMzYuMTg3NSBDMTAxLjU5NzUgMzYuNTE3NSAxMDIuMjU3NSAzNi44NDc1IDEwMi45Mzc1IDM3LjE4NzUgQzEwNS41MjQwMjA2NSAzNS45NTc2OTQwNCAxMDcuOTYwMTE3MTEgMzQuNjc0MDc4NjQgMTEwLjQzNzUgMzMuMjUgQzExMS4xNTc4NDQyNCAzMi44NDA0ODA5NiAxMTEuODc4MTg4NDggMzIuNDMwOTYxOTEgMTEyLjYyMDM2MTMzIDMyLjAwOTAzMzIgQzExOC41MjE3MDkwNSAyOC41ODAyOTEzNyAxMjMuNzcyMDQzMTUgMjQuNjQ2NDA2MzcgMTI4LjkzNzUgMjAuMTg3NSBDMTI5Ljc4MzEyNSAxOS41MzUyMzQzOCAxMzAuNjI4NzUgMTguODgyOTY4NzUgMTMxLjUgMTguMjEwOTM3NSBDMTMzLjc4NjkzMzQ4IDE2LjMxMjQ4OTUyIDEzNS40Nzk4MDYwNSAxNC40OTg5ODEwMyAxMzcuMjUgMTIuMTI1IEMxMzguMDE3NjM2NzIgMTEuMTE3NTk3NjYgMTM4LjAxNzYzNjcyIDExLjExNzU5NzY2IDEzOC44MDA3ODEyNSAxMC4wODk4NDM3NSBDMTQwLjE5Mzk2OTggOC4xMjc2MzU0NyAxNDAuMTkzOTY5OCA4LjEyNzYzNTQ3IDEzOS45Mzc1IDUuMTg3NSBDMTMxLjQ4MjkxODQ4IDUuMTg3NSAxMjUuNTUyMzkyNDkgMTIuMDAwNDI2NTMgMTE5LjgyODEyNSAxNy40NDkyMTg3NSBaIE00Ny45Mzc1IDM4LjE4NzUgQzQ1LjY1NDkxMzY3IDM5LjI2NDI0NzAyIDQzLjUwMTg1NjYgNDAuMzgyOTYxMTYgNDEuMzEyNSA0MS42MjUgQzQwLjcwMTQ4NDM4IDQxLjk2MzM3ODkxIDQwLjA5MDQ2ODc1IDQyLjMwMTc1NzgxIDM5LjQ2MDkzNzUgNDIuNjUwMzkwNjIgQzM3Ljk0OTE0NyA0My40ODg5NjE5MiAzNi40NDI3OTYwMSA0NC4zMzczMjU3NyAzNC45Mzc1IDQ1LjE4NzUgQzM0LjkzNzUgNDUuNTE3NSAzNC45Mzc1IDQ1Ljg0NzUgMzQuOTM3NSA0Ni4xODc1IEMzOC4wNDMwODY3NCA0Ni42MjIyODIxNCA0MC44NDcxMTc5NyA0Ni43ODU0NzYzNiA0My45Mzc1IDQ2LjE4NzUgQzQ2LjQzNzM4NDEgNDQuMTcyNDQxOSA0OC4xOTI4Mjc0MyA0MS44Njk1MDY0NyA0OS45Mzc1IDM5LjE4NzUgQzQ5LjI3NzUgMzguODU3NSA0OC42MTc1IDM4LjUyNzUgNDcuOTM3NSAzOC4xODc1IFogTTE1LjE0NDUzMTI1IDU2LjcxMDkzNzUgQzExLjYwNjYwOTY4IDYwLjQxOTUxOTQ4IDguMjU5MzU1NTMgNjQuMjg1ODgxNSA0LjkzNzUgNjguMTg3NSBDMy40ODAyMTE5MiA2OS44MzQyNTg5MiAyLjAyMjE0NDg3IDcxLjQ4MDMyOTcyIDAuNTYyNSA3My4xMjUgQy0wLjMxNTM0NTU4IDc0LjE0MzM4NzM2IC0xLjE5MTgyMDc3IDc1LjE2Mjk3ODk1IC0yLjA2MjUgNzYuMTg3NSBDLTEuNzMyNSA3Ni44NDc1IC0xLjQwMjUgNzcuNTA3NSAtMS4wNjI1IDc4LjE4NzUgQzguODIzOTk3NTIgNzYuNjI4Mjc3NjkgMTYuMTc3Nzk3NTUgNjguNTM1NzEyMyAyMy40NzI2NTYyNSA2Mi4xNzk2ODc1IEMyNy44NDk2NDA4OCA1OC4zNzM5MzAyOSAzMi4zNzE3MzQxNCA1NC43NjQzNjcyNiAzNi45Mzc1IDUxLjE4NzUgQzM2LjI3NzUgNTAuODU3NSAzNS42MTc1IDUwLjUyNzUgMzQuOTM3NSA1MC4xODc1IEMzNC45Mzc1IDQ4Ljg2NzUgMzQuOTM3NSA0Ny41NDc1IDM0LjkzNzUgNDYuMTg3NSBDMjcuODkzMDUwNzIgNDYuMTg3NSAxOS45ODQ3NDM3NSA1MS45NDQ5OTYxNCAxNS4xNDQ1MzEyNSA1Ni43MTA5Mzc1IFogTTIxMi4zNzUgNzYuMzc1IEMyMTEuODYyNjc4MjIgNzYuODczNTQ0OTIgMjExLjM1MDM1NjQ1IDc3LjM3MjA4OTg0IDIxMC44MjI1MDk3NyA3Ny44ODU3NDIxOSBDMjA3Ljk2NDY3MTg3IDgwLjc3OTYzMzU0IDIwNi4xNDE2NjI4IDgzLjI5MDAwMjY2IDIwNC45Mzc1IDg3LjE4NzUgQzIxMS4xMDMyNjc5NiA4Ni44NzEzMDY3NyAyMTUuMTQzOTQ3NDYgODMuNzQ3MjMzOCAyMTkuOTM3NSA4MC4xODc1IEMyMjAuNzY1MDc4MTIgNzkuNTc2NDg0MzggMjIxLjU5MjY1NjI1IDc4Ljk2NTQ2ODc1IDIyMi40NDUzMTI1IDc4LjMzNTkzNzUgQzIyNS4xNzQxNzYxMiA3NS45ODM0Njg4NiAyMjcuMTQyMDYyMTMgNzMuNTQyNzY3MTEgMjI5LjI1IDcwLjYyNSBDMjI5Ljk0NzM4MjgxIDY5LjY3NDk2MDk0IDIzMC42NDQ3NjU2MiA2OC43MjQ5MjE4OCAyMzEuMzYzMjgxMjUgNjcuNzQ2MDkzNzUgQzIzMy4xOTk1MTI0NCA2NS4yNjIzMzA0NiAyMzMuMTk5NTEyNDQgNjUuMjYyMzMwNDYgMjMyLjkzNzUgNjIuMTg3NSBDMjI1LjI4OTAyMDQzIDYyLjE4NzUgMjE3LjYzMTkzMDg0IDcxLjE5NzQxNjA0IDIxMi4zNzUgNzYuMzc1IFogTTI1OC45Mzc1IDYzLjE4NzUgQzI1Ny40OTExNzE4NyA2NC40Njk0NzI2NiAyNTcuNDkxMTcxODcgNjQuNDY5NDcyNjYgMjU2LjAxNTYyNSA2NS43NzczNDM3NSBDMjU0LjczOTkwNTkyIDY2Ljg5MzU5Nzk0IDI1My40NjM4NDYzOCA2OC4wMDk0NjMxMyAyNTIuMTg3NSA2OS4xMjUgQzI1MS4yMzYxNzE4OCA2OS45NzA5NDcyNyAyNTEuMjM2MTcxODggNjkuOTcwOTQ3MjcgMjUwLjI2NTYyNSA3MC44MzM5ODQzOCBDMjQ5LjY0Njg3NSA3MS4zNzIxNjc5NyAyNDkuMDI4MTI1IDcxLjkxMDM1MTU2IDI0OC4zOTA2MjUgNzIuNDY0ODQzNzUgQzI0Ny44MjUwNDg4MyA3Mi45NjIzNDEzMSAyNDcuMjU5NDcyNjYgNzMuNDU5ODM4ODcgMjQ2LjY3Njc1NzgxIDczLjk3MjQxMjExIEMyNDQuOTM3NSA3NS4xODc1IDI0NC45Mzc1IDc1LjE4NzUgMjQyLjc4NDE3OTY5IDc1LjY3MDE2NjAyIEMyNDIuMTc0Nzc1MzkgNzUuODQwODg2MjMgMjQxLjU2NTM3MTA5IDc2LjAxMTYwNjQ1IDI0MC45Mzc1IDc2LjE4NzUgQzI0MC42MDc1IDc3LjE3NzUgMjQwLjI3NzUgNzguMTY3NSAyMzkuOTM3NSA3OS4xODc1IEMyNDAuNTk3NSA3OS41MTc1IDI0MS4yNTc1IDc5Ljg0NzUgMjQxLjkzNzUgODAuMTg3NSBDMjQyLjU2MjUgODMuMjUgMjQyLjU2MjUgODMuMjUgMjQyLjkzNzUgODYuMTg3NSBDMjUwLjI0OTg4MzMzIDgzLjc3MTIzNDIgMjU0LjkxOTU0NzYxIDc3LjUwMTMyMzM0IDI1OC41IDcwLjg3NSBDMjU5LjkzNDYxODg1IDY3LjE5NDg5MDc3IDI2MC4wODk0Njc1NyA2Ni42NDM0MDI3MSAyNTguOTM3NSA2My4xODc1IFogIiBmaWxsPSIjMDEwMDAxIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyOTkuMDYyNSwxNDguODEyNSkiLz4KPHBhdGggZD0iTTAgMCBDMCAxLjMyIDAgMi42NCAwIDQgQy0xLjIyMDc0MjE5IDQuMTU4NTU0NjkgLTIuNDQxNDg0MzggNC4zMTcxMDkzOCAtMy42OTkyMTg3NSA0LjQ4MDQ2ODc1IEMtMjAuNDQ2Mjg5MzQgNi43OTUxNzM4NiAtMzUuMjcwMDI0NzUgMTAuNzQzNDMzMzkgLTQ2LjU4OTg0Mzc1IDI0LjA3MDMxMjUgQy00OS44NzkwNjczNiAyOC41NzEzNTUzNCAtNTAuNjg4OTg0MDIgMzIuNDMyNTY0NjQgLTUwIDM4IEMtNDguNDYyMDgyNTkgNDEuOTgwNDkyMTIgLTQ2LjEzMjA0MjU4IDQ0LjE5MDgyMDIyIC00Mi4zMjAzMTI1IDQ2LjE0NDUzMTI1IEMtMzEuNTg3OTQ2MTQgNTAuMTAxNDEzOCAtMjAuOTYyOTAyMTQgNDguODUwODc5NTggLTEwIDQ3IEMtMTAuMDQ2NDA2MjUgNDYuMjk4NzUgLTEwLjA5MjgxMjUgNDUuNTk3NSAtMTAuMTQwNjI1IDQ0Ljg3NSBDLTEwLjM5NjQ4MTQ4IDM4LjE0OTYyOTU1IC05LjgzMjg4OTI2IDMzLjU3NjE2MTE5IC02IDI4IEMtNS41NzIwMzEyNSAyNy4zNjcwNzAzMSAtNS4xNDQwNjI1IDI2LjczNDE0MDYzIC00LjcwMzEyNSAyNi4wODIwMzEyNSBDNC43NTI5OTE3NiAxMy44NzE5NDIzNCAyMi4xMjQ0OTg0NCA1LjIwMDY5MzUyIDM3IDIgQzM5LjgyNzQ4NTA1IDEuODI4NzIyMzYgNDIuNjA5MDI5MDcgMS43MjM3MzE0OCA0NS40Mzc1IDEuNjg3NSBDNDYuNTYzODE4MzYgMS42NDM5OTQxNCA0Ni41NjM4MTgzNiAxLjY0Mzk5NDE0IDQ3LjcxMjg5MDYyIDEuNTk5NjA5MzggQzUxLjUzNTk4MTg0IDEuNTU1ODk3NjkgNTMuNTk3NDk0NjMgMS43NzQxMTQ4MyA1NyAzLjY4MzU5Mzc1IEM2MC4wNDY2MzkyNiA3LjIxMjIyMDg2IDU5LjY0NTU2NjY2IDkuODQzMzMxODUgNTkuNDAyMzQzNzUgMTQuMzI4MTI1IEM1OC4yMjY3MTExOCAyMi4xMzUyMzg0IDUwLjkxODQ4MDg4IDI3LjM5NDk5OTY5IDQ1IDMyIEMzMi41MjYwNzkzMyA0MC4yNjA3NzQ5NyAxOC44MTk1MTE3NyA0NS41Njc5MTIzMyA0LjM2OTg3MzA1IDQ5LjI2NDQwNDMgQzIuNTUzMzM2NDQgNDkuNzUzMTE5MzYgMC43NzEzNDc4OSA1MC4zNjY3NzQ2OCAtMSA1MSBDLTEuMzMgNTEuOTkgLTEuNjYgNTIuOTggLTIgNTQgQy0wLjg3ODUxNTYzIDUzLjk0Nzc5Mjk3IC0wLjg3ODUxNTYzIDUzLjk0Nzc5Mjk3IDAuMjY1NjI1IDUzLjg5NDUzMTI1IEMxLjI1MDQ2ODc1IDUzLjg2NzQ2MDk0IDIuMjM1MzEyNSA1My44NDAzOTA2MiAzLjI1IDUzLjgxMjUgQzQuMjI0NTMxMjUgNTMuNzc3Njk1MzEgNS4xOTkwNjI1IDUzLjc0Mjg5MDYzIDYuMjAzMTI1IDUzLjcwNzAzMTI1IEM5LjQyMTAwMDg3IDU0LjA0NDA5OTI1IDEwLjc0MjI2ODg0IDU0LjcxMDM5NDk5IDEzIDU3IEMxMy4zMTI1IDYwLjEyNSAxMy4zMTI1IDYwLjEyNSAxMyA2MyBDMTEuMjg1NTMyIDY0LjcxNDQ2OCA5LjA4NjU3OTM0IDY0LjIxMjUxNDc3IDYuNzUgNjQuMjUgQzEuMzYzMzY2MzQgNjQuMjM2MTg4MTIgMS4zNjMzNjYzNCA2NC4yMzYxODgxMiAtMS41IDYyLjM3NSBDLTUuMTU1MzY4NDkgNjAuMzY0NTQ3MzMgLTcuNzA5MTE3MDUgNjEuMDY3OTY2NDggLTExLjcwMzEyNSA2MS45NTMxMjUgQy0yOS4wNTg3NDU5IDY3LjQ2NDE1MTU0IC00Mi42MjM0OTY2NCA3OC40ODk5OTUyMyAtNTEuNDE0MDYyNSA5NC41ODk4NDM3NSBDLTUyLjM5MjE2Njg2IDk2LjcwNDM3ODcyIC01My4yNDA1MjUxOSA5OC43OTg4ODczOCAtNTQgMTAxIEMtNTQuMzA5Mzc1IDEwMS44ODY4NzUgLTU0LjYxODc1IDEwMi43NzM3NSAtNTQuOTM3NSAxMDMuNjg3NSBDLTU1LjAzMzUzMzMzIDEwNy4yNDA3MzMyMiAtNTMuOTkwMjY1ODkgMTA5LjA3Njc5Njk4IC01MiAxMTIgQy00NS4zNTY1OTAwMSAxMTYuODE5NzI4ODIgLTM5LjMwNDI4ODQ0IDExNy40Njg2MTMxNiAtMzEuMzEyNSAxMTYuMzc1IEMtMTcuNzY2OTY2NTMgMTEzLjgxNjAyMDEzIC0xLjQyNDgzMTY5IDEwNy41NDYyMTIxNyA3LjMxMjUgOTYuMzEyNSBDOS45Njc1NTkxOSA5Mi4xODI0MDc5MyAxMC42NTA1NTI2OCA4OC44MzI2NzcwNiAxMCA4NCBDOC40NzQ3ODMzIDgxLjU5MTc2MzEgNy40NTkwMjk2OCA4MS4xMjc3NzExNSA0LjcyNjU2MjUgODAuMzY3MTg3NSBDLTcuNjQ0NzM3MDEgNzguNzAxMTM4NTcgLTIxLjI5ODUxNTEzIDg3LjYxNTc5MTA0IC0zMC44MTI1IDk0LjgxMjUgQy0zNS44NjMwNDc4OSA5OC43MjkwODEyNiAtNDAuMDQ3MzM1NiAxMDMuMTQ2MDMxNTIgLTQ0IDEwOC4xNjQwNjI1IEMtNDYgMTEwIC00NiAxMTAgLTQ4Ljc1IDExMC4yNzM0Mzc1IEMtNDkuNDkyNSAxMTAuMTgzMjAzMTMgLTUwLjIzNSAxMTAuMDkyOTY4NzUgLTUxIDExMCBDLTUxLjQ5NDQ0NzIgMTA2LjQzNDc3NTQ0IC01MS4xMzQ4NTkyNiAxMDUuMTkwMDc3MjMgLTQ5LjAxNTYyNSAxMDIuMjAzMTI1IEMtNDguMTEwMTkzMDggMTAxLjIwMzYwNDc3IC00Ny4xODcwODYzIDEwMC4yMTk5MDU2MiAtNDYuMjUgOTkuMjUgQy00NS43NTQxMTM3NyA5OC43MjcwNDM0NiAtNDUuMjU4MjI3NTQgOTguMjA0MDg2OTEgLTQ0Ljc0NzMxNDQ1IDk3LjY2NTI4MzIgQy0zNC4xMDg3ODY0MyA4Ni43MzI5NTYyIC0xOC41NzkyMzkxMSA3NS40MjU2OTY1OSAtMi43NzM0Mzc1IDc0LjY5OTIxODc1IEMtMS4zMDczNTcxNyA3NC42ODQ4MTk3NSAwLjE1ODg2MzI2IDc0LjY4MTAyNDEzIDEuNjI1IDc0LjY4NzUgQzIuMzYyMzQzNzUgNzQuNjcxMzg2NzIgMy4wOTk2ODc1IDc0LjY1NTI3MzQ0IDMuODU5Mzc1IDc0LjYzODY3MTg4IEM4LjQzMTQyMDMxIDc0LjYzNDU3NTA2IDExLjM5Mzg4NjkgNzUuMTM3ODk5MDggMTUgNzggQzE4LjI3ODMwOTA0IDgyLjkxNzQ2MzU2IDE3LjY0MDgwODc0IDg4LjI1OTk4OTc5IDE3IDk0IEMxNS44ODkzNjI4NSA5Ny4yNDU2NDgzNiAxNC4yODkyODU3MiA5OS40NjY1OTYxMyAxMiAxMDIgQzExLjQxNDc2NTYzIDEwMi42NTM1NTQ2OSAxMC44Mjk1MzEyNSAxMDMuMzA3MTA5MzcgMTAuMjI2NTYyNSAxMDMuOTgwNDY4NzUgQzMuNTk5MTAxMTQgMTEwLjU0NDQ0ODY3IC00LjU0OTgyMjg0IDExNC4zMjQ1MzM2OSAtMTMgMTE4IEMtMTQuNTU4NDc2NTYgMTE4LjY4ODM1OTM4IC0xNC41NTg0NzY1NiAxMTguNjg4MzU5MzggLTE2LjE0ODQzNzUgMTE5LjM5MDYyNSBDLTIzLjE3MDUxNDk4IDEyMi4wMDc3NzcyNCAtMjkuOTU3OTYwMzkgMTIyLjM2OTE5NjQgLTM3LjM3NSAxMjIuNDM3NSBDLTM4LjMxNDg4NzcgMTIyLjQ0NzgxMjUgLTM5LjI1NDc3NTM5IDEyMi40NTgxMjUgLTQwLjIyMzE0NDUzIDEyMi40Njg3NSBDLTQ4LjA2NDg4MDU5IDEyMi4zNjgwNTM1NSAtNTQuMjc0NjM2OTggMTIwLjcyNTM2MzAyIC02MCAxMTUgQy02NS4yMTMwNTMyMyAxMDcuNjczNTQ2ODEgLTY0Ljg1ODQxOTc1IDk5LjYyNzk5NDM4IC02NCA5MSBDLTYzLjE0MjU3NyA4Ny42MDQwMjY4OSAtNjEuODk2MzU3OCA4NC45MzI4NzYzNSAtNjAgODIgQy01OS41NjQyOTY4NyA4MS4zMTY3OTY4NyAtNTkuMTI4NTkzNzUgODAuNjMzNTkzNzUgLTU4LjY3OTY4NzUgNzkuOTI5Njg3NSBDLTQ3LjQyNjc2MjUzIDYzLjc1NzQ1MTA2IC0yOC41NjA2MDg4NyA1Ny42MDg2MTg3NiAtMTAgNTQgQy0xMC44NTY0MjA5IDU0LjAyMDk0NzI3IC0xMS43MTI4NDE4IDU0LjA0MTg5NDUzIC0xMi41OTUyMTQ4NCA1NC4wNjM0NzY1NiBDLTE1LjgxOTQ1NzA5IDU0LjEzMjI3MjAxIC0xOS4wNDMzMjExOSA1NC4xODIwOTgyNiAtMjIuMjY4MDY2NDEgNTQuMjE5NzI2NTYgQy0yMy42NTQ5MTE1NiA1NC4yMzk2NTM0MiAtMjUuMDQxNjc0ODIgNTQuMjY2ODA1NiAtMjYuNDI4MjIyNjYgNTQuMzAxNzU3ODEgQy0zNi4wNjA2MjM5NyA1NC41MzgyMjEwOSAtNDQuNzczNDEzNTggNTQuMzc2MTMwODEgLTUyLjQ3MjY1NjI1IDQ3LjkyOTY4NzUgQy01Mi45OTczMDQ2OSA0Ny4yNTE2NDA2MiAtNTMuNTIxOTUzMTMgNDYuNTczNTkzNzUgLTU0LjA2MjUgNDUuODc1IEMtNTQuNjEwMzUxNTYgNDUuMTkxNzk2ODcgLTU1LjE1ODIwMzEyIDQ0LjUwODU5Mzc1IC01NS43MjI2NTYyNSA0My44MDQ2ODc1IEMtNTkuNDE4MjcwMSAzOC41ODMzNjE1IC01OC40NjAzMjI5MiAzMi4xNDY2NjQ4OCAtNTggMjYgQy01Ni4yOTkwMjA4NyAxOC44NzQyNzY2MSAtNTAuODI5ODMxNDQgMTQuMDU0MTI0NzkgLTQ1IDEwIEMtMzAuNDE1OTk4NDMgMS43NzkwMjk1NSAtMTYuNTgyMjUwMTggLTAuNTM2MTkyNTIgMCAwIFogTTEzIDI0IEMxMi4xODc4OTA2MiAyNC43MzIxODc1IDExLjM3NTc4MTI1IDI1LjQ2NDM3NSAxMC41MzkwNjI1IDI2LjIxODc1IEM1LjI3ODQ3MjkyIDMxLjE4MjIyOTg3IDEuMTUyNzY3OTggMzYuNDU5NTUxOTIgLTIgNDMgQy0yIDQzLjY2IC0yIDQ0LjMyIC0yIDQ1IEMxNy42NTEzMjA2IDQxLjE2NTU5NTk4IDM3LjExMzE0NDk2IDMyLjcwMjEzMDI4IDUxIDE4IEM1Mi44NjUyNzg2MSAxNC44Nzc2ODU4IDUzLjQ4MTI1NDUxIDEyLjY1NzUzNDMgNTMgOSBDNDAuMTcxOTIyODIgMC40NDc5NDg1NSAyMi4wNTA5MDYwNSAxNS42MDk5NTM3NSAxMyAyNCBaICIgZmlsbD0iIzAxMDEwMSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTkxLDExOSkiLz4KPHBhdGggZD0iTTAgMCBDLTEuNjE2OTI3NzkgNC4wODEyODE1OSAtNC41NDI3NzQwNiA2LjgwNjAzOTMzIC03LjYyNSA5LjgxMjUgQy04LjE2NTUyMDAyIDEwLjM0NjU3NDcxIC04LjcwNjA0MDA0IDEwLjg4MDY0OTQxIC05LjI2MjkzOTQ1IDExLjQzMDkwODIgQy0xMi43NDcxNzYzNSAxNC44NDg3MjkyNiAtMTYuMzMzMTQ5ODIgMTguMTA1ODQ4MzcgLTIwLjA0Njg3NSAyMS4yNzM0Mzc1IEMtMjYuODQ4Nzk3MTEgMjYuOTY5NzMzMTEgLTI2Ljg0ODc5NzExIDI2Ljk2OTczMzExIC0zMiAzNCBDLTMxLjA5MjUgMzMuMTc1IC0zMC4xODUgMzIuMzUgLTI5LjI1IDMxLjUgQy0yNi40NjM3NTUwMyAyOC45NjcwNTAwMyAtMjYuMTI3NDE3MzkgMjkgLTIyIDI5IEMtMjMuOTk4MDY5MjQgMzMuNDgzNDcyNDQgLTI2LjgxNDM1NDQxIDM2LjQzODM4NDkgLTMxIDM5IEMtMzQuOTM3NSAzOS4zNzUgLTM0LjkzNzUgMzkuMzc1IC0zOCAzOSBDLTM4LjMzIDM4LjM0IC0zOC42NiAzNy42OCAtMzkgMzcgQy0zOS45OSAzNy42NiAtNDAuOTggMzguMzIgLTQyIDM5IEMtNDUuNTYyNSAzOS4zMTI1IC00NS41NjI1IDM5LjMxMjUgLTQ5IDM5IEMtNDkuNjYgMzguMDEgLTUwLjMyIDM3LjAyIC01MSAzNiBDLTUxLjgyNSAzNi40OTUgLTUyLjY1IDM2Ljk5IC01My41IDM3LjUgQy01Ny43NTQ4ODE4OCAzOS4zMjM1MjA4MSAtNjAuNDIzMDg2NzEgMzkuMjM2NzM2ODkgLTY1IDM5IEMtNjUuOTkgMzcuMDIgLTY1Ljk5IDM3LjAyIC02NyAzNSBDLTY3Ljg0NTYyNSAzNS42NiAtNjguNjkxMjUgMzYuMzIgLTY5LjU2MjUgMzcgQy03My40MzQzNjk0NyAzOS4yNTI3MjQwNSAtNzUuNjAyNzg3OTcgMzkuMzUxNzc2OTYgLTgwIDM5IEMtODAuNjYgMzcuMzUgLTgxLjMyIDM1LjcgLTgyIDM0IEMtODIuODQ1NjI1IDM0LjgyNSAtODMuNjkxMjUgMzUuNjUgLTg0LjU2MjUgMzYuNSBDLTg3LjMyNDUzMTM1IDM4Ljg0MDE0NTg5IC04OC4wMDA0ODE5MSAzOS4wMDAwMzg4NiAtOTEuODc1IDM5LjMxMjUgQy05Mi45MDYyNSAzOS4yMDkzNzUgLTkzLjkzNzUgMzkuMTA2MjUgLTk1IDM5IEMtOTUuMzMgMzguMzQgLTk1LjY2IDM3LjY4IC05NiAzNyBDLTk2LjUzNjI1IDM3LjMzIC05Ny4wNzI1IDM3LjY2IC05Ny42MjUgMzggQy0xMDAuNTM5MTA2MSAzOS4yMjY5OTIwNCAtMTAyLjg2ODY3NzA4IDM5LjE0MjMzMjg2IC0xMDYgMzkgQy0xMDYuNjYgMzcuNjggLTEwNy4zMiAzNi4zNiAtMTA4IDM1IEMtMTA4Ljk5IDM1LjY2IC0xMDkuOTggMzYuMzIgLTExMSAzNyBDLTExNS4xNTA3OTgyIDM5LjQxMDY4ODUzIC0xMTguMjczMTk5NTUgMzkuMzMxNzA1MjkgLTEyMyAzOSBDLTEyMy42NiAzNy42OCAtMTI0LjMyIDM2LjM2IC0xMjUgMzUgQy0xMjUuOTkgMzUuNjYgLTEyNi45OCAzNi4zMiAtMTI4IDM3IEMtMTMyLjE1MDc5ODIgMzkuNDEwNjg4NTMgLTEzNS4yNzMxOTk1NSAzOS4zMzE3MDUyOSAtMTQwIDM5IEMtMTQwIDM2LjY5IC0xNDAgMzQuMzggLTE0MCAzMiBDLTE0MC45OSAzMS42NyAtMTQxLjk4IDMxLjM0IC0xNDMgMzEgQy0xNDEuOTQ0MzczNjIgMjguNDQ4OTAyOTIgLTE0MS4yNzAyMzQ4MyAyNy4xODAxNTY1NSAtMTM4LjkzNzUgMjUuNjI1IEMtMTM2LjI1MjkxMDYzIDIzLjM3MzQwODkyIC0xMzYuMzAxNDMwNiAyMS4zOTEwOTQyOSAtMTM2IDE4IEMtMTM0LjM1IDE4IC0xMzIuNyAxOCAtMTMxIDE4IEMtMTMxIDE4Ljk5IC0xMzEgMTkuOTggLTEzMSAyMSBDLTEyOS4zNSAyMSAtMTI3LjcgMjEgLTEyNiAyMSBDLTEyNS43MTg3NSAyMy4xOTkyMTg3NSAtMTI1LjcxODc1IDIzLjE5OTIxODc1IC0xMjYgMjYgQy0xMjcuOTY4NzUgMjguNDU3MDMxMjUgLTEyNy45Njg3NSAyOC40NTcwMzEyNSAtMTMwLjUgMzAuODEyNSBDLTEzMS4zMzUzMTI1IDMxLjYwMjY5NTMxIC0xMzIuMTcwNjI1IDMyLjM5Mjg5MDYzIC0xMzMuMDMxMjUgMzMuMjA3MDMxMjUgQy0xMzMuNjgwOTM3NSAzMy43OTg3MTA5NCAtMTM0LjMzMDYyNSAzNC4zOTAzOTA2MyAtMTM1IDM1IEMtMTMwLjY0MTE0ODgzIDMyLjk3NjI0NzY3IC0xMjYuNzQ3NDYzNDIgMzAuOTM3NjIzNDYgLTEyMi45Mzc1IDI4IEMtMTE3LjA3NjY0NTc2IDIzLjQ4OTg4OTUxIC0xMTIuNzc5OTAyNiAyMC4zNjQ5MDU5MSAtMTA1IDIxIEMtMTA0LjUgMjMuMTg3NSAtMTA0LjUgMjMuMTg3NSAtMTA1IDI2IEMtMTA4LjIzMjU3MjYxIDI4Ljc2ODUyOTM0IC0xMTEuOTMyNDYyMjUgMzAuNTgyMjY3ODQgLTExNS44NzUgMzIuMTI1IEMtMTE4LjM0MzIwMzI0IDMyLjkxMDExMzQ0IC0xMTguMzQzMjAzMjQgMzIuOTEwMTEzNDQgLTEyMCAzNiBDLTExMy42ODMwMDI2NiAzMy4wODM0Mjg4OSAtMTA4LjAxMzU3MDgyIDI5Ljc5NTI5OTE2IC0xMDIuNDIxODc1IDI1LjY0ODQzNzUgQy05Ni45MjkwMjA2IDIxLjkwOTc1MjczIC05Mi43NTY3OCAyMC41NjE4ODA0MSAtODYuMTI1IDIwLjgxMjUgQy04NS40MzY2NDA2MiAyMC44MjYwMzUxNiAtODQuNzQ4MjgxMjUgMjAuODM5NTcwMzEgLTg0LjAzOTA2MjUgMjAuODUzNTE1NjIgQy04Mi4zNTkwMjk5OSAyMC44ODg1MTYzIC04MC42Nzk0MDY1IDIwLjk0MjMxMDQ2IC03OSAyMSBDLTgwLjQ0NDI0NjM1IDI0LjIzODYxMzAzIC04Mi4yNTc3MjI0NyAyNi42MTk2OTE2MyAtODQuNjI1IDI5LjI1IEMtODUuMjU2NjQwNjMgMjkuOTU2NDA2MjUgLTg1Ljg4ODI4MTI1IDMwLjY2MjgxMjUgLTg2LjUzOTA2MjUgMzEuMzkwNjI1IEMtODcuMDIxMTcxODcgMzEuOTIxNzE4NzUgLTg3LjUwMzI4MTI1IDMyLjQ1MjgxMjUgLTg4IDMzIEMtODMuNTE5MTQ4NzkgMjkuNzc2NzE3MzggLTc5LjE5MTE4OTE2IDI2LjQwNTg5NjczIC03NSAyMi44MTI1IEMtNzMuODU1MzEyNSAyMS44MzIxNjc5NyAtNzMuODU1MzEyNSAyMS44MzIxNjc5NyAtNzIuNjg3NSAyMC44MzIwMzEyNSBDLTcwLjY2MTI1MDk2IDE5LjA0NzM2ODA2IC03MC42NjEyNTA5NiAxOS4wNDczNjgwNiAtNzEgMTYgQy02OS42Njk2ODc1IDE1LjY1OTY4NzUgLTY5LjY2OTY4NzUgMTUuNjU5Njg3NSAtNjguMzEyNSAxNS4zMTI1IEMtNjQuODQ2NDE1NDIgMTQuMTk5NzIwNjYgLTY0Ljg0NjQxNTQyIDE0LjE5OTcyMDY2IC02Mi40Mzc1IDExLjM3NSBDLTYwIDkgLTYwIDkgLTU3LjE4NzUgOC42ODc1IEMtNTYuMTA0Njg3NSA4Ljg0MjE4NzUgLTU2LjEwNDY4NzUgOC44NDIxODc1IC01NSA5IEMtNTYuODc1IDEzLjg3NSAtNTYuODc1IDEzLjg3NSAtNTggMTUgQy01Ny4wMSAxNS4zMyAtNTYuMDIgMTUuNjYgLTU1IDE2IEMtNTUgMTYuNjYgLTU1IDE3LjMyIC01NSAxOCBDLTU2LjAyMzUxNTYzIDE4LjAzMzUxNTYzIC01Ny4wNDcwMzEyNSAxOC4wNjcwMzEyNSAtNTguMTAxNTYyNSAxOC4xMDE1NjI1IEMtNjIuOTkzMDcwNjQgMTguODAzODY5NzEgLTY1LjI5MTk3OTA4IDIxLjc1MzQyNjA2IC02OC4zNzUgMjUuMzc1IEMtNjkuMTczNTc0MjIgMjYuMjYwNTg1OTQgLTY5LjE3MzU3NDIyIDI2LjI2MDU4NTk0IC02OS45ODgyODEyNSAyNy4xNjQwNjI1IEMtNzIuMjYwNjI2MjUgMjkuNzMxMjkxOTcgLTczLjkwNjE0NTk4IDMxLjcxODQzNzk1IC03NSAzNSBDLTc0LjQ4MDUwNzgxIDM0LjYwMTY3OTY5IC03My45NjEwMTU2MyAzNC4yMDMzNTkzNyAtNzMuNDI1NzgxMjUgMzMuNzkyOTY4NzUgQy02OS43MTQ2OTY2OCAzMC45NzM2NDIwMyAtNjYuMDQ1MTUzMjggMjguMzI1OTYzMTMgLTYyIDI2IEMtNjEuMzk0MTQwNjMgMjUuNTc0NjA5MzcgLTYwLjc4ODI4MTI1IDI1LjE0OTIxODc1IC02MC4xNjQwNjI1IDI0LjcxMDkzNzUgQy01NS40OTIzMDg4NSAyMS41MDY5Mzc4NyAtNTIuNjY3ODYwMTYgMjAuNDA5NTk3OSAtNDcgMjEgQy00Ni41IDIzLjE4NzUgLTQ2LjUgMjMuMTg3NSAtNDcgMjYgQy01MC4yMzI1NzI2MSAyOC43Njg1MjkzNCAtNTMuOTMyNDYyMjUgMzAuNTgyMjY3ODQgLTU3Ljg3NSAzMi4xMjUgQy02MC4zNDMyMDMyNCAzMi45MTAxMTM0NCAtNjAuMzQzMjAzMjQgMzIuOTEwMTEzNDQgLTYyIDM2IEMtNTUuMzE1ODYxNTcgMzMuMDQxOTEzMjEgLTQ5Ljg1NzUwMTMzIDI5LjU1Mjg0ODI2IC00NC4zMjQyMTg3NSAyNC43Njk1MzEyNSBDLTQwLjMzMzY4NjQ1IDIxLjczMTM2MTI4IC0zNy42Mjc4MDYzNiAyMC45MTQ2NDA0NSAtMzIuNjk5MjE4NzUgMjEuMzU1NDY4NzUgQy0yOC41NzU4MDk5MyAyMS40NDY4MzQ0IC0yNi44MjgyNjU0OCAyMC40ODI4MjQ5IC0yMy44MzIwMzEyNSAxNy42NzU3ODEyNSBDLTIyLjQ2ODQ2MzExIDE2LjI0MzU3MjcgLTIxLjEyODkxMzU5IDE0Ljc4ODE2NzUzIC0xOS44MTI1IDEzLjMxMjUgQy0xOC40NjcwNjEzMiAxMS44NjkwMjM2IC0xNy4xMTk0NDM4MyAxMC40Mjc1NzQ2MSAtMTUuNzY5NTMxMjUgOC45ODgyODEyNSBDLTE0LjgxMjg4NTc0IDcuOTYwMjEzNjIgLTE0LjgxMjg4NTc0IDcuOTYwMjEzNjIgLTEzLjgzNjkxNDA2IDYuOTExMzc2OTUgQy02LjQ1NjE0MjY1IC0wLjc2ODU4ODQxIC02LjQ1NjE0MjY1IC0wLjc2ODU4ODQxIDAgMCBaIE0tMTAxLjUgMzIuMjUgQy0xMDMuMjE2OTMwNDYgMzMuODY4OTM3ODUgLTEwMy4yMTY5MzA0NiAzMy44Njg5Mzc4NSAtMTAzIDM2IEMtOTguOTkzMDQ3MDMgMzQuNjMzNTA4MDUgLTk2LjMyMzI4MjYgMzIuODI4OTY0NzMgLTkzLjE4NzUgMzAgQy05Mi4zOTczMDQ2OSAyOS4yOTg3NSAtOTEuNjA3MTA5MzcgMjguNTk3NSAtOTAuNzkyOTY4NzUgMjcuODc1IEMtODguNzY5NjI2NjQgMjYuMTkxNDY5MDMgLTg4Ljc2OTYyNjY0IDI2LjE5MTQ2OTAzIC04OSAyNCBDLTkzLjU5NTE3NDYyIDI0IC05OC4yMjYwMjg1NCAyOS4zMDM0MjU2OCAtMTAxLjUgMzIuMjUgWiBNLTQwLjA2MjUgMjguMzEyNSBDLTQwLjk2MDk3NjU2IDI5LjExMzAwNzgxIC00MS44NTk0NTMxMyAyOS45MTM1MTU2MyAtNDIuNzg1MTU2MjUgMzAuNzM4MjgxMjUgQy00NS4yMDE5MTQ2MSAzMi44NzYwMzc0IC00NS4yMDE5MTQ2MSAzMi44NzYwMzc0IC00NiAzNiBDLTQxLjE5NTU1OTc4IDM0LjU0NDEwOTAyIC0zNy4zMjAzNzI3MSAzMS43MzA5NTY0MyAtMzQgMjggQy0zMy4yNjYyNTk3MiAyNS44OTM0ODg4MyAtMzMuMjY2MjU5NzIgMjUuODkzNDg4ODMgLTMzIDI0IEMtMzYuMjMxMjY4NjYgMjQgLTM3LjcyMzQzOTQ0IDI2LjIwMjI5NzE2IC00MC4wNjI1IDI4LjMxMjUgWiAiIGZpbGw9IiMwMjAxMDIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDE5Niw1NSkiLz4KPHBhdGggZD0iTTAgMCBDMC41MjcxNDEwNiAzLjAxMjIzNDYxIDAuNDczODI5ODggNS4xNzIwOTk0NSAtMS4wNjY0MDYyNSA3Ljg2MzI4MTI1IEMtNy4zOTE5MTg5MSAxNS43NzQxMzU0MyAtMTYuODM1MDE5MzQgMjAuOTMyNDIwOCAtMjUuNzUgMjUuNDM3NSBDLTMzLjAwNDM5ODE5IDI5LjMzNjM5OTQgLTM5LjAzNjg3Mzk2IDM1Ljg0MDgwNDU3IC00MyA0MyBDLTM2LjIzNDczMjI3IDM5LjU5MDYyNTk1IC0zMS45Nzc4Nzg5MyAzNi40OTg3NTY1NCAtMjguMzUxNTYyNSAyOS43NTc4MTI1IEMtMjcuOTA1NTQ2ODcgMjkuMTc3NzM0MzggLTI3LjQ1OTUzMTI1IDI4LjU5NzY1NjI1IC0yNyAyOCBDLTI1LjY4IDI4IC0yNC4zNiAyOCAtMjMgMjggQy0yMy41NTcyODkxMyAzMS4zNDM3MzQ3NSAtMjQuMzUxNzM4ODkgMzQuMDMzMTI5OTkgLTI2IDM3IEMtMjUuMTU0Mzc1IDM2LjQ0MzEyNSAtMjQuMzA4NzUgMzUuODg2MjUgLTIzLjQzNzUgMzUuMzEyNSBDLTIyLjYxMzc4OTA2IDM0Ljc3MzAyNzM0IC0yMi42MTM3ODkwNiAzNC43NzMwMjczNCAtMjEuNzczNDM3NSAzNC4yMjI2NTYyNSBDLTE5Ljk3ODAwNDQgMzMuMDE3NDAzMTMgLTE5Ljk3ODAwNDQgMzMuMDE3NDAzMTMgLTE4LjI4OTA2MjUgMzEuNjIxMDkzNzUgQy0xNC4xMTE5MzI2IDI4LjMwMzk2MTE4IC0xMS41MTg4MzU0IDI3LjQzNjg1MzUzIC02IDI4IEMtNS41NjI1IDMwLjYyNSAtNS41NjI1IDMwLjYyNSAtNiAzNCBDLTguMDk0OTQ4OCAzNi4zMzEyMjEyMiAtMTAuNDYwNzM4MjcgMzguMTczMjg2MjEgLTEzIDQwIEMtOC40OTk5NDcxNiAzNy4xMjI0MTUxOSAtNC4yMDk0NTk4NiAzNC4yOTQ3ODI4MyAtMC4zMTI1IDMwLjYyNSBDMi4yNTUxMTc3NiAyOC4zMjEzNDI5NCAyLjgwNzM2NzgzIDI4LjAyMTAxNDQyIDYuNDM3NSAyNy42MjUgQzcuMjgzMTI1IDI3Ljc0ODc1IDguMTI4NzUgMjcuODcyNSA5IDI4IEM3LjU1NTc1MzY1IDMxLjIzODYxMzAzIDUuNzQyMjc3NTMgMzMuNjE5NjkxNjMgMy4zNzUgMzYuMjUgQzIuNzQzMzU5MzggMzYuOTU2NDA2MjUgMi4xMTE3MTg3NSAzNy42NjI4MTI1IDEuNDYwOTM3NSAzOC4zOTA2MjUgQzAuOTc4ODI4MTMgMzguOTIxNzE4NzUgMC40OTY3MTg3NSAzOS40NTI4MTI1IDAgNDAgQzAuOTA3NSAzOS4zNCAxLjgxNSAzOC42OCAyLjc1IDM4IEM2IDM2IDYgMzYgMTAgMzYgQzcuNjU5ODk0OSA0MS42ODQ4NjI2NSAyLjIzNDQ4NTMxIDQ0LjY0MDczOTQ1IC0zLjI3NzM0Mzc1IDQ2Ljk1NzAzMTI1IEMtNC4wMTA4MjAzMSA0Ny4yMzkzMzU5NCAtNC43NDQyOTY4OCA0Ny41MjE2NDA2MyAtNS41IDQ3LjgxMjUgQy0xMC4zMzA5NTIyIDQ5LjgxMjA5NDEzIC0xMy4yNTQ3MzQwMSA1My4wNjE2MjEyIC0xNi44MTI1IDU2LjgwNDY4NzUgQy0yMS4xNDczODY5MiA2MS4xNTUwNTYxNSAtMjUuMjAyNTczMDEgNjQuMjY4MjI5ODYgLTMxLjUgNjQuMzEyNSBDLTMyLjY1NSA2NC4yMDkzNzUgLTMzLjgxIDY0LjEwNjI1IC0zNSA2NCBDLTM1LjQzNzUgNjEuODc1IC0zNS40Mzc1IDYxLjg3NSAtMzUgNTkgQy0zMC40NzY2NzIyNyA1My4yNDAyOTYwMyAtMjMuNTM5NzI4NzYgNTAuNzY0MTEyIC0xNyA0OCBDLTE1LjY2MDg4NTcgNDcuMzQ1MDIyODIgLTE0LjMyNTE2Njc0IDQ2LjY4Mjc1NTcgLTEzIDQ2IEMtMTUuMzEgNDUuNjcgLTE3LjYyIDQ1LjM0IC0yMCA0NSBDLTIwIDQzLjAyIC0yMCA0MS4wNCAtMjAgMzkgQy0yMC42NiAzOS4zMDkzNzUgLTIxLjMyIDM5LjYxODc1IC0yMiAzOS45Mzc1IEMtMjUgNDEgLTI1IDQxIC0yOC45Mzc1IDQxLjM3NSBDLTMyLjIzMTU4ODk5IDQxLjcwMTk0MTQyIC0zMy4xNDQwNjQ5NyA0Mi4wOTcwMjMzNSAtMzYuMDYyNSA0NC4wNjI1IEMtMzkuNjQ0MTIzNDEgNDYuNDI0ODQ3MzUgLTQxLjc5MDM0MTg2IDQ2LjQxMjcxMTU4IC00NiA0NiBDLTQ3IDQ1IC00NyA0NSAtNDcuMDYyNSA0MS40Mzc1IEMtNDcuMDQxODc1IDQwLjMwMzEyNSAtNDcuMDIxMjUgMzkuMTY4NzUgLTQ3IDM4IEMtNDcuNjYgMzggLTQ4LjMyIDM4IC00OSAzOCBDLTQ3LjQzMDY3NTU0IDMzLjY5NzAxMzU5IC00NC4xMjUyNTI5MyAzMS4zNTc4MDcyOSAtNDAuNjg3NSAyOC41NjI1IEMtMzUuNjQ2OTY2MzcgMjQuMzcxNjA0MjQgLTMwLjkzMzA4NTMyIDIwLjAyMTg3Mzc4IC0yNi4zNzUgMTUuMzEyNSBDLTkuNjkzODIxNTcgLTEuNjc3Nzc2ODEgLTkuNjkzODIxNTcgLTEuNjc3Nzc2ODEgMCAwIFogTS0xNiAxMiBDLTE4LjEwMDgwNDc2IDE0LjI3MzgxMjIxIC0yMC4wNTIyOTIzMSAxNi41OTA5OTMxMiAtMjIgMTkgQy0xNC40ODg0NjE3NyAxNi42NTI2NDQzIC04LjU1MTM5NzE4IDExLjI1ODE3MTEyIC00IDUgQy00IDQuMzQgLTQgMy42OCAtNCAzIEMtOC41NDkwMjI4NyAzIC0xMi44Nzc5NTM2MSA4Ljk4Mjk3NjU3IC0xNiAxMiBaIE0tMjkgNTggQy0yOS42NiA1OC45OSAtMzAuMzIgNTkuOTggLTMxIDYxIEMtMjguMjkwNjg1ODEgNjAuODQ1MTgyMDUgLTI2LjUzNDE1OTYxIDYwLjUxODI3OTE5IC0yNC41NTQ2ODc1IDU4LjU5NzY1NjI1IEMtMjMuMzIzMjAzNTggNTcuMTAyMjgyOTIgLTIyLjE1NzAxNjMgNTUuNTUzNzA3NiAtMjEgNTQgQy0yNC4zMzE5NDQ2NSA1NCAtMjYuMzc5OTYyOTggNTYuMDg5NTU2MzQgLTI5IDU4IFogIiBmaWxsPSIjMDIwMjAyIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgyNDAsNDkpIi8+CjxwYXRoIGQ9Ik0wIDAgQzEuMTgyMzkyNTggMC4wMDY3Njc1OCAxLjE4MjM5MjU4IDAuMDA2NzY3NTggMi4zODg2NzE4OCAwLjAxMzY3MTg4IEM0LjMyMTY0NzYxIDAuMDI1Mzg2ODggNi4yNTQ1ODM5MyAwLjA0MzMyMDAyIDguMTg3NSAwLjA2MjUgQzguMTg3NSAwLjcyMjUgOC4xODc1IDEuMzgyNSA4LjE4NzUgMi4wNjI1IEM3LjEzNjkxNDA2IDIuMTYwNDY4NzUgNi4wODYzMjgxMyAyLjI1ODQzNzUgNS4wMDM5MDYyNSAyLjM1OTM3NSBDLTQuMzAwODQzIDMuMzEzNjc5ODQgLTEyLjE4ODAzNTEzIDQuMzQyODIxNzQgLTE5LjY4NzUgMTAuMzc1IEMtMjIuNDQ5OTAzMDQgMTMuODY4NjI3MzcgLTI0Ljk2ODkwODY0IDE3LjUxMjU2NTE4IC0yNC42ODM1OTM3NSAyMi4xNjQwNjI1IEMtMjMuOTU2MzQ1NjcgMjQuMjY5NTQ3MDYgLTIzLjk1NjM0NTY3IDI0LjI2OTU0NzA2IC0yMS42Njc5Njg3NSAyNS4xNDQ1MzEyNSBDLTIwLjM0NzMyNDIyIDI1LjUwNjExMzI4IC0yMC4zNDczMjQyMiAyNS41MDYxMTMyOCAtMTkgMjUuODc1IEMtMTcuNjkwOTU3MDMgMjYuMjU1OTE3OTcgLTE3LjY5MDk1NzAzIDI2LjI1NTkxNzk3IC0xNi4zNTU0Njg3NSAyNi42NDQ1MzEyNSBDLTEzLjY2MjkwNTM3IDI3LjA4NzA4Nzc1IC0xMi4zMTg3NDk3MyAyNy4wOTg2ODg3OSAtOS44MTI1IDI2LjA2MjUgQy03Ljg3MDI4ODg5IDI0LjUxNTgzNTI2IC03Ljg3MDI4ODg5IDI0LjUxNTgzNTI2IC01LjkzNzUgMjIuNTYyNSBDNC41NjAzNzQyNSAxMi45NDUyMDQwMSAxOS4yNDkwMzI2MyAyLjkwNTIwODUgMzMuODEyNSAyLjkzNzUgQzM0Ljk4MDM5MDYyIDIuOTM0OTIxODggMzYuMTQ4MjgxMjUgMi45MzIzNDM3NSAzNy4zNTE1NjI1IDIuOTI5Njg3NSBDNDAuMTg3NSAzLjA2MjUgNDAuMTg3NSAzLjA2MjUgNDEuMTg3NSA0LjA2MjUgQzQxLjcxNTUyMDEyIDcuMzYyNjI1NzUgNDEuODgzMDI5NDYgOS44NzA5MTM2NyA0MC4xNTIzNDM3NSAxMi44MzU5Mzc1IEMzMS4yMTIxNzk1OCAyMi45NDIyMTAwNCAxMy40Mzg1Mzk0NSAyOC4zOTEwMjk5IDAuNSAyOS42MjUgQy01Ljc0NjkyNDYyIDMwLjY0MDIzOTU4IC04Ljg2MTU0NTY0IDM0LjQyNjk0NzEgLTEyLjc2NTYyNSAzOS4xNjQwNjI1IEMtMTUuMzYzNDA3ODEgNDIuODQyNjAyMjggLTE2Ljg2ODU3MzE0IDQ1LjY1NzUwOCAtMTcuODEyNSA1MC4wNjI1IEMtMTYuMTI3NjA3NTQgNTMuMjg4MzI3OTQgLTE2LjEyNzYwNzU0IDUzLjI4ODMyNzk0IC0xMy4wODk4NDM3NSA1My44NTE1NjI1IEMtNi4wNTkxNDg2NyA1NC4zMDQwNzQ0NiAxLjUyNzM2NTE5IDUxLjQ5NDc1ODMzIDcuMzc1IDQ3LjYyNSBDMTAuMTIwNjAxNCA0NS4xMjM0NTIwNiAxMS4yNzI1NzEwOSA0My42MjA1NTY4OCAxMi4xODc1IDQwLjA2MjUgQzkuOTY1NjgxODMgMzguNjk2MzgyMDcgOC43Mzc2MjA1MiAzNy45ODcwMTM1NCA2LjEwOTM3NSAzOC4zNDc2NTYyNSBDLTAuNzA5MzQ5NDcgNDAuNzg4MTcwOTQgLTYuNDY5MjE4MDUgNDMuNzE5MjE4MDUgLTExLjYyNSA0OC44NzUgQy0xMi4zNDY4NzUgNDkuNTk2ODc1IC0xMy4wNjg3NSA1MC4zMTg3NSAtMTMuODEyNSA1MS4wNjI1IEMtMTQuODAyNSA1MS4wNjI1IC0xNS43OTI1IDUxLjA2MjUgLTE2LjgxMjUgNTEuMDYyNSBDLTE2LjQzNTM5NyA0Ny42Njg1NzI5OSAtMTQuOTk3MDM2MSA0NS43NDcwMTc5NiAtMTIuNTQyOTY4NzUgNDMuNDI5Njg3NSBDLTYuMTI1OTUzMTkgMzguMzU5ODEwNjUgMC4wMDk3OTY0MiAzNC45MjUwNjE5OSA4LjI1IDM0Ljg3NSBDOS4zMTM0NzY1NiAzNC44NjA4MjAzMSAxMC4zNzY5NTMxMiAzNC44NDY2NDA2MiAxMS40NzI2NTYyNSAzNC44MzIwMzEyNSBDMTQuMTg3NSAzNS4wNjI1IDE0LjE4NzUgMzUuMDYyNSAxNi4xODc1IDM3LjA2MjUgQzE2LjcwOTgzNTA4IDQwLjM5MjM4NjEyIDE2LjgyOTkwOTM4IDQyLjg3MTI2MDU1IDE1LjE5NTMxMjUgNDUuOTAyMzQzNzUgQzEwLjYxMTE3MjMzIDUxLjgyMDI4NzQxIDQuMTU5NDE0NzkgNTQuNzM4NTI4NCAtMi44MTI1IDU3LjA2MjUgQy01LjEwMDExODQ3IDU3LjIzMzkzMDg3IC03LjM5MzkyOTY5IDU3LjMyODkzNDYzIC05LjY4NzUgNTcuMzc1IEMtMTAuOTAxNzk2ODcgNTcuNDEyMzgyODEgLTEyLjExNjA5Mzc1IDU3LjQ0OTc2NTYyIC0xMy4zNjcxODc1IDU3LjQ4ODI4MTI1IEMtMTcuNDQzODUyNzggNTYuOTg0NDc1NjggLTE5LjA0NTU4ODg2IDU2LjA2Njg2OTkzIC0yMS44MTI1IDUzLjA2MjUgQy0yMy4zNjIwNjYwOCA0Ny43ODQ4NjAyMyAtMjIuMDQxNzY2MjQgNDIuODUzMTQ4NzYgLTE5LjUgMzguMTI1IEMtMTcuODYwNjgxNzEgMzUuNDEyNDk0MzUgLTE2LjEyNjc3MDg3IDMzLjIyNzQ2MzA3IC0xMy44MTI1IDMxLjA2MjUgQy0xNC40MDQxNzk2OSAzMC45NjQ1MzEyNSAtMTQuOTk1ODU5MzggMzAuODY2NTYyNSAtMTUuNjA1NDY4NzUgMzAuNzY1NjI1IEMtMjAuNjYwODQxNDggMjkuODA4OTgwMjQgLTI0LjA2MDE2NzM1IDI4LjgxNDgzMjY1IC0yNy44MTI1IDI1LjA2MjUgQy0yOS43MTUwNzE5OCAyMS4yNTczNTYwNCAtMjkuNTM2MjU0NTkgMTcuMTg3OTAxMTkgLTI4LjgxMjUgMTMuMDYyNSBDLTI1LjQ4NTkxMzk1IDcuMDk4OTg1OTkgLTIwLjE5NDE0ODczIDMuMjc3MzA3NSAtMTMuODEyNSAxLjA2MjUgQy05LjIyNTU0OTQ1IC0wLjE4MDMxMDEzIC00LjcxMzAwNTcxIC0wLjA1MTM1NzE1IDAgMCBaIE0yMS4yODUxNTYyNSA5LjQ3MjY1NjI1IEMxMy41MjU1ODE1MiAxMy43ODU3OTcgNi42OTM5MTE0NyAxOS4wNDA2MDg1NCAwLjE4NzUgMjUuMDYyNSBDMC4xODc1IDI1LjM5MjUgMC4xODc1IDI1LjcyMjUgMC4xODc1IDI2LjA2MjUgQzEzLjI1Nzg0OTI1IDI1LjU5NTcwMTgxIDI1LjkyMDA2MzE1IDE5Ljg3NDI3MDc3IDM1LjkxNzk2ODc1IDExLjYzNjcxODc1IEMzNy42MDYwMDE2MyA5Ljg4MDYxNTI3IDM3LjYwNjAwMTYzIDkuODgwNjE1MjcgMzcuMTg3NSA2LjA2MjUgQzMxLjY0ODY4NjA5IDQuMjE2MjI4NyAyNi4zNDk4MzA0OSA3LjAxMTg5MjU5IDIxLjI4NTE1NjI1IDkuNDcyNjU2MjUgWiAiIGZpbGw9IiMwMjAyMDIiIHRyYW5zZm9ybT0idHJhbnNsYXRlKDM2LjgxMjUsMzYuOTM3NSkiLz4KPHBhdGggZD0iTTAgMCBDNS45Nzg3MzI2NCAwLjExOTM1NzY0IDUuOTc4NzMyNjQgMC4xMTkzNTc2NCA3LjA4OTg0Mzc1IDEuMjMwNDY4NzUgQzcuMjc3MzQzNzUgNC42Njc5Njg3NSA3LjI3NzM0Mzc1IDQuNjY3OTY4NzUgNy4wODk4NDM3NSA4LjIzMDQ2ODc1IEM1LjA4OTg0Mzc1IDEwLjIzMDQ2ODc1IDUuMDg5ODQzNzUgMTAuMjMwNDY4NzUgMy4xNzk2ODc1IDEwLjQ2MDkzNzUgQy0yLjc5OTA0NTE0IDEwLjM0MTU3OTg2IC0yLjc5OTA0NTE0IDEwLjM0MTU3OTg2IC0zLjkxMDE1NjI1IDkuMjMwNDY4NzUgQy00LjA5NzY1NjI1IDUuNzkyOTY4NzUgLTQuMDk3NjU2MjUgNS43OTI5Njg3NSAtMy45MTAxNTYyNSAyLjIzMDQ2ODc1IEMtMS45MTAxNTYyNSAwLjIzMDQ2ODc1IC0xLjkxMDE1NjI1IDAuMjMwNDY4NzUgMCAwIFogIiBmaWxsPSIjMDAwMDAwIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSg1MTAuOTEwMTU2MjUsMTg2Ljc2OTUzMTI1KSIvPgo8L3N2Zz4=';

  const signatureImg = document.createElement('img');
  signatureImg.className = 'signature-img';
  signatureImg.src = SIGNATURE_DATA_URI;
  signatureImg.alt = 'Signature';
  signatureImg.addEventListener('error', () => {
    console.warn('[ECBF:ContentOverlay] Signature failed to load — hiding');
    signatureImg.style.display = 'none';
  });
  const _layer1El = container.querySelector('.layer1');
  if (_layer1El) _layer1El.appendChild(signatureImg);

  // ============================================================
  //  5. Set image srcs
  // ============================================================
  const inner = container.querySelector('.overlay-inner');
  const pinLabelIcon = container.querySelector('.pin-label-icon');
  const bulkLockImg = container.querySelector('#cbf-bulk-lock img');
  const addBookmarkImg = container.querySelector('#cbf-add-bookmark img');
  const addFolderImg = container.querySelector('#cbf-add-folder img');
  const pinImg = container.querySelector('#cbf-pin-folder img');
  const switchSpaceImg = container.querySelector('#cbf-switch-space img');
  const lockImg = container.querySelector('#cbf-lock-button img');
  const homeImg = container.querySelector('#cbf-home-btn img');
  const spaceIndicator = container.querySelector('#cbf-space-indicator');

  pinLabelIcon.src = ASSET('folder.svg');
  bulkLockImg.src = ASSET('lock.svg');
  addBookmarkImg.src = ASSET('bookmarks.svg');
  addFolderImg.src = ASSET('folder.svg');
  pinImg.src = ASSET('pin.svg');
  switchSpaceImg.src = ASSET('switch_space.svg');
  lockImg.src = ASSET('lock.svg');
  homeImg.src = ASSET('home.svg');
  spaceIndicator.src = ASSET('key_lock.svg');

  console.log('[ECBF:ContentOverlay] Icons loaded');

  // ============================================================
  //  6. DOM references
  // ============================================================
  el = {
    inner,
    container,
    versionTag:      container.querySelector('.version-tag'),
    pinLabel:        container.querySelector('#cbf-pin-label'),
    pinLabelText:    container.querySelector('#cbf-pin-label-text'),

    bulkLock:        container.querySelector('#cbf-bulk-lock'),
    bulkLockImg:     container.querySelector('#cbf-bulk-lock img'),
    bulkCount:       container.querySelector('#cbf-bulk-count'),
    selectionInfo:   container.querySelector('#cbf-selection-info'),
    selectionText:   container.querySelector('#cbf-selection-info-text'),

    addBookmarkBtn:  container.querySelector('#cbf-add-bookmark'),
    addFolderBtn:    container.querySelector('#cbf-add-folder'),
    pinBtn:          container.querySelector('#cbf-pin-folder'),
    menuBtn:         container.querySelector('#cbf-main-menu'),
    switchSpaceBtn:  container.querySelector('#cbf-switch-space'),
    lockBtn:         container.querySelector('#cbf-lock-button'),
    closeBtn:        container.querySelector('#cbf-close-btn'),
    layer2:          container.querySelector('.layer2'),
    homeBtn:         container.querySelector('#cbf-home-btn'),
    backBtn:         container.querySelector('#cbf-back-btn'),
    breadcrumb:      container.querySelector('.breadcrumb'),
    searchWrapper:   container.querySelector('#cbf-search-wrapper'),
    searchBar:       container.querySelector('#cbf-search-bar'),
    searchClear:     container.querySelector('#cbf-search-clear'),
    spaceIndicator,
    spaceLabel:      container.querySelector('#cbf-space-label'),
    layer3:          container.querySelector('.layer3'),
    layer3Wrapper:   container.querySelector('.layer3-wrapper'),
    arrowLeft:       container.querySelector('.scroll-arrow.left'),
    arrowRight:      container.querySelector('.scroll-arrow.right'),
    tooltip:         container.querySelector('#cbf-tooltip')
  };

  // ═══════════════════════════════════════════════════════════
  //  V12E: Ξεκλείδωμα του menuBtn (ήταν disabled σε C3)
  // ============================================================
  if (el.menuBtn) {
    el.menuBtn.style.opacity = '1';
    el.menuBtn.style.cursor = 'pointer';
    el.menuBtn.style.pointerEvents = 'auto';
  }

  console.log('[ECBF:ContentOverlay] Feature buttons: pin+search+menu ΕΝΕΡΓΑ (V12E)');

  // ============================================================
  //  7. Adjust overlay size
  // ============================================================
  function adjustOverlaySize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const maxWidth = Math.min(960, vw - 16);
    const maxHeight = Math.min(vh * 0.5, 400);

    container.style.maxWidth = maxWidth + 'px';
    container.style.maxHeight = Math.max(maxHeight, 320) + 'px';
  }

  // ⭐ v12.2 CPU-09: adaptive resize debounce
  function onResize() {
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(adjustOverlaySize, RESIZE_DEBOUNCE_MS);
  }

  resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(document.documentElement);
  adjustOverlaySize();

  console.log(`[ECBF:ContentOverlay] ResizeObserver installed (debounce=${RESIZE_DEBOUNCE_MS}ms)`);

  // ============================================================
  //  8. Tooltip helpers
  //
  //  Χρησιμοποιεί containerRect (σωστό offsetParent) αντί hostRect.
  //  ⭐ v12.2 CPU-08: adaptive delay
  // ============================================================
  function showTooltip(text, anchorEl) {
    if (!el.tooltip || !anchorEl || !text) return;
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      el.tooltip.textContent = text;
      el.tooltip.classList.add('visible');

      const anchorRect    = anchorEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const tipWidth      = el.tooltip.offsetWidth  || 100;
      const tipHeight     = el.tooltip.offsetHeight || 28;

      const GAP  = 8;
      const EDGE = 8;

      let left = (anchorRect.left - containerRect.left)
               + (anchorRect.width / 2)
               - (tipWidth / 2);

      const maxLeft = Math.max(EDGE, containerRect.width - tipWidth - EDGE);
      if (left < EDGE)    left = EDGE;
      if (left > maxLeft) left = maxLeft;

      let top = (anchorRect.top - containerRect.top) - tipHeight - GAP;

      if (top < EDGE) {
        top = (anchorRect.bottom - containerRect.top) + GAP;
      }

      if (top < EDGE) top = EDGE;
      const maxTop = Math.max(EDGE, containerRect.height - tipHeight - EDGE);
      if (top > maxTop) top = maxTop;

      el.tooltip.style.left = left + 'px';
      el.tooltip.style.top  = top  + 'px';
    }, TOOLTIP_DELAY_MS);
  }

  function hideTooltip() {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
    if (el.tooltip) el.tooltip.classList.remove('visible');
  }

  // ═══════════════════════════════════════════════════════════
  //  Wire tooltip σε button (static text)
  //
  //  Αφαιρεί το `title` attribute στο mouseenter για αποφυγή
  //  διπλού tooltip (native + custom).
  // ============================================================
  function attachTooltipToBtn(btn, text) {
    if (!btn) return;

    let _savedTitle = '';

    btn.addEventListener('mouseenter', () => {
      _savedTitle = btn.getAttribute('title') || '';
      if (_savedTitle) btn.removeAttribute('title');
      showTooltip(text, btn);
    });

    btn.addEventListener('mouseleave', () => {
      hideTooltip();
      if (_savedTitle) {
        try { btn.setAttribute('title', _savedTitle); } catch (_) {}
      }
      _savedTitle = '';
    });

    btn.addEventListener('click', () => {
      hideTooltip();
      if (_savedTitle) {
        try { btn.setAttribute('title', _savedTitle); } catch (_) {}
      }
      _savedTitle = '';
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  Dynamic tooltip — διαβάζει το τρέχον title κάθε φορά
  // ============================================================
  function attachDynamicTooltipToBtn(btn) {
    if (!btn) return;

    let _savedTitle = '';

    btn.addEventListener('mouseenter', () => {
      _savedTitle = btn.getAttribute('title') || '';
      if (_savedTitle) btn.removeAttribute('title');
      if (_savedTitle) showTooltip(_savedTitle, btn);
    });

    btn.addEventListener('mouseleave', () => {
      hideTooltip();
      if (_savedTitle) {
        try { btn.setAttribute('title', _savedTitle); } catch (_) {}
      }
      _savedTitle = '';
    });

    btn.addEventListener('click', () => {
      hideTooltip();
      if (_savedTitle) {
        try { btn.setAttribute('title', _savedTitle); } catch (_) {}
      }
      _savedTitle = '';
    });
  }

  // ============================================================
  //  9. Space indicator
  // ============================================================
  function updateSpaceIndicator(space) {
    activeSpace = space === 'encrypted' ? 'encrypted' : 'firefox';
    const isEnc = activeSpace === 'encrypted';

    if (el.spaceIndicator) el.spaceIndicator.style.display = isEnc ? 'block' : 'none';
    if (el.spaceLabel) el.spaceLabel.style.display = isEnc ? 'inline' : 'none';
    if (el.layer2) el.layer2.classList.toggle('encrypted-layer2', isEnc);

    console.log(`[ECBF:ContentOverlay] Space indicator updated: ${activeSpace}`);
  }

  // ============================================================
  //  10. Lock icon
  // ============================================================
  function updateLockIcon(unlocked) {
    isUnlocked = !!unlocked;
    if (!lockImg) return;

    if (isUnlocked) {
      lockImg.src = ASSET('unlock.svg');
      el.lockBtn.setAttribute('title', 'Κλείδωμα');
    } else {
      lockImg.src = ASSET('lock.svg');
      el.lockBtn.setAttribute('title', 'Ξεκλείδωμα');
    }
  }

  async function refreshLockIcon() {
    try {
      const status = await CBF_BRIDGE.getStatus();
      if (isClosed) return;
      updateLockIcon(status.unlocked);
    } catch (e) {
      if (isClosed) return;
      console.warn('[ECBF:ContentOverlay] refreshLockIcon failed:', e.message);
    }
  }

  // Expose globally για cross-module use
  window.CBF_Overlay_refreshLockButtonIcon = refreshLockIcon;
  window.CBF_Overlay_updateSpaceIndicator = updateSpaceIndicator;

  // C-3 EXPOSE: isSpaceTransitionInProgress
  window.CBF_Overlay_isSpaceTransitionInProgress = () => _spaceInProgress;
  console.log('[ECBF:ContentOverlay] C-3 expose: isSpaceTransitionInProgress');

  // ============================================================
  //  11. Performance mode
  // ============================================================
  async function loadPerfMode() {
    try {
      const { cbf_perfMode } = await browser.storage.local.get('cbf_perfMode');
      isPerfMode = !!cbf_perfMode;
      applyPerfMode();
    } catch (_) {}
  }

  function applyPerfMode() {
    if (!host) return;
    host.classList.toggle('perf-mode', isPerfMode);
  }

  async function togglePerformanceMode() {
    isPerfMode = !isPerfMode;
    try {
      await browser.storage.local.set({ cbf_perfMode: isPerfMode });
    } catch (_) {}
    applyPerfMode();
    console.log('[ECBF:ContentOverlay] Performance mode:', isPerfMode ? 'ON' : 'OFF');
  }
  window.CBF_Overlay_togglePerf = togglePerformanceMode;

  // ============================================================
  //  12. Modal password prompt
  // ============================================================
  async function promptForPassword(title, confirmField = false) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' && CBF_MODAL_SERVICE.promptForPassword) {
      return CBF_MODAL_SERVICE.promptForPassword(title, confirmField);
    }
    return window.prompt(title);
  }

  // ============================================================
  //  13. C-3 + H-8: Pre-flight checks για space transitions
  // ============================================================
  async function _preflightSpaceTransition() {
    // C-3: Wait for UI actions
    if (typeof CBF_UI !== 'undefined' &&
        CBF_UI._internal &&
        typeof CBF_UI._internal.isActionInProgress === 'function') {
      let waitCount = 0;
      while (CBF_UI._internal.isActionInProgress()) {
        if (waitCount === 0) {
          console.log('[ECBF:ContentOverlay] C-3: waiting for UI action to complete');
        }
        await new Promise(r => setTimeout(r, 50));
        waitCount++;

        if (waitCount > 200) {
          console.warn('[ECBF:ContentOverlay] C-3: TIMEOUT waiting for UI action');
          return false;
        }
      }
    }

    // H-8: Block if unlock prompt in progress
    if (typeof CBF_UI !== 'undefined' &&
        CBF_UI._internal &&
        typeof CBF_UI._internal.isUnlockPromptInProgress === 'function' &&
        CBF_UI._internal.isUnlockPromptInProgress()) {
      console.log('[ECBF:ContentOverlay] H-8: unlock prompt in progress — BLOCKING transition');
      return false;
    }

    return true;
  }

  // ============================================================
  //  14. Space switching (H-6 + C-3 + H-8 + v1.5.4 persist)
  // ============================================================
  async function switchSpace() {
    console.log('[ECBF:ContentOverlay] switchSpace() called');

    if (isClosed) {
      console.log('[ECBF:ContentOverlay] switchSpace: overlay closed — aborting');
      return;
    }

    // H-6: Unified mutex
    if (_spaceInProgress) {
      console.log('[ECBF:ContentOverlay] switchSpace: mutex LOCKED — ignoring');
      return;
    }
    _spaceInProgress = true;

    try {
      // C-3 + H-8: Preflight
      const canProceed = await _preflightSpaceTransition();
      if (!canProceed) {
        console.log('[ECBF:ContentOverlay] switchSpace: preflight BLOCKED');
        return;
      }

      if (isClosed) return;

      const currentSpaceRes = await CBF_BRIDGE.getActiveSpace();
      if (isClosed) return;
      const current = currentSpaceRes.activeSpace;

      console.log(`[ECBF:ContentOverlay] switchSpace: current=${current}`);

      if (current === 'firefox') {
        const status = await CBF_BRIDGE.getStatus();
        if (isClosed) return;

        if (!status.initialized) {
          console.log('[ECBF:ContentOverlay] switchSpace: prompt for setup');
          const password = await promptForPassword('Δημιουργήστε κωδικό για τον κρυπτογραφημένο χώρο', true);
          if (isClosed) return;
          if (!password || password.length < 6) return;
          await CBF_BRIDGE.setup(password);
        } else if (!status.unlocked) {
          console.log('[ECBF:ContentOverlay] switchSpace: prompt for unlock');
          const password = await promptForPassword('Εισάγετε τον κωδικό', false);
          if (isClosed) return;
          if (!password) return;
          await CBF_BRIDGE.unlock(password);
        }
        if (isClosed) return;

        await CBF_BRIDGE.setActiveSpace('encrypted');
        if (isClosed) return;
        updateSpaceIndicator('encrypted');
        await refreshLockIcon();
        if (isClosed) return;
        await _saveLastSpace('encrypted');
        await loadSpace('encrypted');
        console.log('[ECBF:ContentOverlay] switchSpace: → encrypted DONE');

      } else {
        await CBF_BRIDGE.setActiveSpace('firefox');
        if (isClosed) return;
        updateSpaceIndicator('firefox');
        await refreshLockIcon();
        if (isClosed) return;
        await _saveLastSpace('firefox');
        await loadSpace('firefox');
        console.log('[ECBF:ContentOverlay] switchSpace: → firefox DONE');
      }
    } catch (e) {
      if (isClosed) return;
      console.error('[ECBF:ContentOverlay] switchSpace FAILED:', e.message);
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα', e.message);
      }
    } finally {
      _spaceInProgress = false;
      console.log('[ECBF:ContentOverlay] switchSpace: mutex RELEASED');
    }
  }

  // ============================================================
  //  15. Lock button flow (H-6 + C-3 + H-8 + v1.5.4 persist)
  // ============================================================
  async function handleLockButton() {
    console.log('[ECBF:ContentOverlay] handleLockButton() called');

    if (isClosed) {
      console.log('[ECBF:ContentOverlay] handleLockButton: overlay closed — aborting');
      return;
    }

    // H-6: Unified mutex
    if (_spaceInProgress) {
      console.log('[ECBF:ContentOverlay] handleLockButton: mutex LOCKED — ignoring');
      return;
    }
    _spaceInProgress = true;

    try {
      const canProceed = await _preflightSpaceTransition();
      if (!canProceed) {
        console.log('[ECBF:ContentOverlay] handleLockButton: preflight BLOCKED');
        return;
      }

      if (isClosed) return;

      const status = await CBF_BRIDGE.getStatus();
      if (isClosed) return;

      console.log(
        `[ECBF:ContentOverlay] handleLockButton: initialized=${status.initialized}, unlocked=${status.unlocked}`
      );

      // Case 1: NOT INITIALIZED → setup
      if (!status.initialized) {
        const password = await promptForPassword('Δημιουργήστε κωδικό για τον κρυπτογραφημένο χώρο', true);
        if (isClosed) return;
        if (!password) return;
        if (password.length < 6) {
          if (typeof CBF_MODAL_SERVICE !== 'undefined') {
            await CBF_MODAL_SERVICE.showAlert('Σφάλμα', 'Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.');
          }
          return;
        }
        console.log('[ECBF:ContentOverlay] handleLockButton: setup');
        await CBF_BRIDGE.setup(password);
        if (isClosed) return;
        await CBF_BRIDGE.setActiveSpace('encrypted');
        if (isClosed) return;
        updateSpaceIndicator('encrypted');
        await refreshLockIcon();
        if (isClosed) return;
        await _saveLastSpace('encrypted');
        await loadSpace('encrypted');
        return;
      }

      // Case 2: LOCKED → unlock
      if (!status.unlocked) {
        const password = await promptForPassword('Εισάγετε τον κωδικό', false);
        if (isClosed) return;
        if (!password) return;
        console.log('[ECBF:ContentOverlay] handleLockButton: unlock');
        await CBF_BRIDGE.unlock(password);
        if (isClosed) return;
        await CBF_BRIDGE.setActiveSpace('encrypted');
        if (isClosed) return;
        updateSpaceIndicator('encrypted');
        await refreshLockIcon();
        if (isClosed) return;
        await _saveLastSpace('encrypted');
        await loadSpace('encrypted');
        return;
      }

      // Case 3: UNLOCKED → lock
      console.log('[ECBF:ContentOverlay] handleLockButton: lock');
      await CBF_BRIDGE.lock();
      if (isClosed) return;
      await CBF_BRIDGE.setActiveSpace('firefox');
      if (isClosed) return;
      updateSpaceIndicator('firefox');
      await refreshLockIcon();
      if (isClosed) return;
      await _saveLastSpace('firefox');
      await loadSpace('firefox');

    } catch (e) {
      if (isClosed) return;
      console.error('[ECBF:ContentOverlay] handleLockButton FAILED:', e.message);
      let msg = e.message;
      if (e.code === 'WRONG_PASSWORD' || /wrong/i.test(msg)) {
        msg = 'Λάθος κωδικός πρόσβασης.';
      } else if (e.code === 'ARGON2_NOT_LOADED') {
        msg = 'Το Argon2 δεν έχει φορτωθεί.';
      } else if (e.code === 'ARGON2_HASHWASM_NOT_LOADED') {
        msg = 'Αποτυχία φόρτωσης hash-wasm.';
      } else if (e.code === 'PASSWORD_ERROR') {
        msg = 'Ο κωδικός πρέπει να έχει τουλάχιστον 6 χαρακτήρες.';
      } else if (/ARGON2_LOW_MEMORY/i.test(msg)) {
        // ⭐ v12.2: low-memory friendly message
        msg = '⚠️ Χρειάζονται 64MB ελεύθερης μνήμης.\n\nΚλείστε μερικές καρτέλες και δοκιμάστε ξανά.';
      }
      if (typeof CBF_MODAL_SERVICE !== 'undefined') {
        await CBF_MODAL_SERVICE.showAlert('Σφάλμα', msg);
      }
    } finally {
      _spaceInProgress = false;
      console.log('[ECBF:ContentOverlay] handleLockButton: mutex RELEASED');
    }
  }

  // ============================================================
  //  16. Load space
  //
  //  v1.5.3: Auto-navigate to pin on EVERY space change
  // ============================================================
  async function loadSpace(space, overrideFolderId = null) {
    if (isClosed) return;
    if (typeof CBF_UI === 'undefined' || !CBF_UI) return;

    console.log(`[ECBF:ContentOverlay] loadSpace: ${space}${overrideFolderId ? ` (override: ${overrideFolderId})` : ''}`);

    if (typeof CBF_UI.resetNavSeq === 'function') {
      CBF_UI.resetNavSeq();
    }

    CBF_UI.setActiveSpace(space);

    // v1.5.3: Auto-navigate to pin (αν υπάρχει, και δεν δόθηκε override)
    let effectiveOverride = overrideFolderId;
    if (!effectiveOverride &&
        typeof CBF_FEATURE_PIN !== 'undefined' &&
        typeof CBF_FEATURE_PIN.loadPinState === 'function') {
      try {
        const pin = await CBF_FEATURE_PIN.loadPinState();
        if (pin && pin.id) {
          effectiveOverride = pin.id;
          console.log(
            `[ECBF:ContentOverlay] v1.5.3: loadSpace auto-navigate to pin: ` +
            `"${pin.title}" (${pin.id.slice(0, 8)}) [space=${space}]`
          );
        }
      } catch (e) {
        console.warn('[ECBF:ContentOverlay] loadSpace loadPinState failed:', e.message);
      }
    }

    if (isClosed) return;

    if (space === 'firefox') {
      const folderId = effectiveOverride || 'toolbar_____';
      CBF_UI.setCurrentFolderId(folderId);
      await CBF_UI.navigateToFolder(folderId);
    } else {
      const folderId = effectiveOverride || 'ecbf-root';
      CBF_UI.setCurrentFolderId(folderId);
      await CBF_UI.navigateToFolder(folderId);
    }

    console.log(`[ECBF:ContentOverlay] loadSpace: ${space} DONE`);
  }

  // ============================================================
  //  17. Wire up buttons + keyboard handlers
  // ============================================================
  function attachButtonHandlers() {
    console.log('[ECBF:ContentOverlay] Attaching button handlers');

    el.lockBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleLockButton();
    });

    el.switchSpaceBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      switchSpace();
    });

    el.closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOverlayAnimated();
    });

    // Dynamic tooltips (title αλλάζει δυναμικά)
    attachDynamicTooltipToBtn(el.lockBtn);
    attachDynamicTooltipToBtn(el.pinBtn);

    // Static tooltips
    attachTooltipToBtn(el.switchSpaceBtn, 'Εναλλαγή χώρου (Firefox ↔ Encrypted)');
    attachTooltipToBtn(el.addBookmarkBtn, 'Προσθήκη σελιδοδείκτη (encrypted)');
    attachTooltipToBtn(el.addFolderBtn, 'Προσθήκη φακέλου (encrypted)');
    attachTooltipToBtn(el.bulkLock, 'Μαζική μεταφορά όλων των επιλεγμένων');
    attachTooltipToBtn(el.menuBtn, 'Μενού επιλογών');

    // ═══════════════════════════════════════════════════════════
    //  C-5 ESCAPE GUARD + D2 SYNTHETIC EVENT GUARD
    // ============================================================
    document.addEventListener('keydown', (e) => {
      // D2: Synthetic event guard
      if (!e.isTrusted) {
        console.log('[ECBF:ContentOverlay] D2: synthetic keydown rejected');
        return;
      }

      if (e.key === 'Escape') {
        // C-5 GUARD: modal active → modal handles Escape
        if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
            typeof CBF_MODAL_SERVICE.activeCount === 'function' &&
            CBF_MODAL_SERVICE.activeCount() > 0) {
          console.log('[ECBF:ContentOverlay] C-5: modal active — Escape handled by modal');
          return;
        }

        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        const modal = shadowRoot.querySelector('.cbf-modal-overlay');
        if (modal) return;

        console.log('[ECBF:ContentOverlay] Escape pressed — closing overlay');
        closeOverlayAnimated();
      }
    });

    console.log('[ECBF:ContentOverlay] Button handlers attached (D2 active)');
  }

  // ============================================================
  //  18. Slide animations (L-02: null guards)
  // ============================================================
  function slideUp() {
    return new Promise((resolve) => {
      if (!container) {
        console.warn('[ECBF:ContentOverlay] L-02: slideUp skipped (no container)');
        return resolve();
      }

      let anim = null;
      try {
        anim = container.animate(
          [
            { transform: 'translateY(100%)' },
            { transform: 'translateY(0)' }
          ],
          {
            duration: 400,
            easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
            fill: 'forwards'
          }
        );
      } catch (e) {
        console.error('[ECBF:ContentOverlay] L-02: slideUp animate failed:', e.message);
        try { container.style.transform = 'translateY(0)'; } catch (_) {}
        return resolve();
      }

      if (!anim) {
        console.warn('[ECBF:ContentOverlay] L-02: slideUp animate returned null');
        try { container.style.transform = 'translateY(0)'; } catch (_) {}
        return resolve();
      }

      anim.onfinish = () => {
        console.log('[ECBF:ContentOverlay] Slide-up complete');
        resolve();
      };
      setTimeout(() => {
        if (anim && anim.playState === 'running') {
          try { anim.finish(); } catch (_) {}
        }
      }, 600);
    });
  }

  function slideDown() {
    return new Promise((resolve) => {
      if (!container) {
        console.warn('[ECBF:ContentOverlay] L-02: slideDown skipped (no container)');
        return resolve();
      }

      let anim = null;
      try {
        anim = container.animate(
          [
            { transform: 'translateY(0)' },
            { transform: 'translateY(100%)' }
          ],
          {
            duration: 300,
            easing: 'cubic-bezier(0.55, 0.06, 0.68, 0.19)',
            fill: 'forwards'
          }
        );
      } catch (e) {
        console.error('[ECBF:ContentOverlay] L-02: slideDown animate failed:', e.message);
        try { container.style.transform = 'translateY(100%)'; } catch (_) {}
        return resolve();
      }

      if (!anim) {
        console.warn('[ECBF:ContentOverlay] L-02: slideDown animate returned null');
        try { container.style.transform = 'translateY(100%)'; } catch (_) {}
        return resolve();
      }

      anim.onfinish = () => {
        console.log('[ECBF:ContentOverlay] Slide-down complete');
        resolve();
      };
      setTimeout(() => {
        if (anim && anim.playState === 'running') {
          try { anim.finish(); } catch (_) {}
        }
      }, 500);
    });
  }

  // ============================================================
  //  19. Close / Cleanup
  // ============================================================
  async function closeOverlayAnimated() {
    if (isClosed) {
      console.log('[ECBF:ContentOverlay] closeOverlayAnimated: already closed');
      return;
    }
    isClosed = true;
    console.log('[ECBF:ContentOverlay] Close sequence START');

    // D1: Disconnect host guard
    try {
      if (_hostGuard) {
        _hostGuard.disconnect();
        _hostGuard = null;
        console.log('[ECBF:ContentOverlay] D1: host guard disconnected');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] D1: host guard disconnect failed:', e.message);
    }

    // Post-MVP: Remove visibility listeners
    try {
      if (window.__CBF_visibilityCheck) {
        document.removeEventListener('visibilitychange', window.__CBF_visibilityCheck);
        window.removeEventListener('focus', window.__CBF_visibilityCheck);
        window.__CBF_visibilityCheck = null;
        console.log('[ECBF:ContentOverlay] visibility listeners removed');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] visibility cleanup failed:', e.message);
    }

    // B-7: Cancel pending modals
    try {
      if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
          typeof CBF_MODAL_SERVICE.cancelAll === 'function') {
        const cancelled = CBF_MODAL_SERVICE.cancelAll();
        if (cancelled > 0) {
          console.log(`[ECBF:ContentOverlay] B-7: cancelled ${cancelled} modal(s)`);
        }
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] B-7: cancelAll failed:', e.message);
    }

    // V12E: Destroy features (main-menu, context-menu)
    try {
      if (typeof CBF_FEATURE_MAIN_MENU !== 'undefined' &&
          typeof CBF_FEATURE_MAIN_MENU.destroy === 'function') {
        CBF_FEATURE_MAIN_MENU.destroy();
        console.log('[ECBF:ContentOverlay] V12E: main-menu destroyed');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] V12E: main-menu destroy failed:', e.message);
    }

    try {
      if (typeof CBF_FEATURE_CONTEXT_MENU !== 'undefined' &&
          typeof CBF_FEATURE_CONTEXT_MENU.destroy === 'function') {
        CBF_FEATURE_CONTEXT_MENU.destroy();
        console.log('[ECBF:ContentOverlay] V12E: context-menu destroyed');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] V12E: context-menu destroy failed:', e.message);
    }

    try { await slideDown(); } catch (e) {
      console.warn('[ECBF:ContentOverlay] slideDown failed:', e.message);
    }

    try {
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
    } catch (_) {}

    // D&D cleanup
    try {
      if (typeof CBF_DRAGDROP !== 'undefined' && CBF_DRAGDROP.destroy) {
        CBF_DRAGDROP.destroy();
        console.log('[ECBF:ContentOverlay] D&D destroyed');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] D&D destroy failed:', e.message);
    }

    try {
      if (typeof CBF_BRIDGE !== 'undefined' && CBF_BRIDGE.shutdown) {
        CBF_BRIDGE.shutdown();
        console.log('[ECBF:ContentOverlay] Bridge shutdown');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] Bridge shutdown failed:', e.message);
    }

    try {
      if (typeof CBF_UI !== 'undefined' && CBF_UI.destroy) {
        CBF_UI.destroy();
        console.log('[ECBF:ContentOverlay] UI destroyed');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] UI destroy failed:', e.message);
    }

    try {
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
        console.log('[ECBF:ContentOverlay] Host removed from DOM');
      }
    } catch (e) {
      console.warn('[ECBF:ContentOverlay] Host removal failed:', e.message);
    }

    console.log('[ECBF:ContentOverlay] Close sequence COMPLETE');
  }

  window.CBF_closeOverlay = closeOverlayAnimated;

  // ============================================================
  //  20. Listener: closeOverlay από background (D3 sender validation)
  // ============================================================
  browser.runtime.onMessage.addListener((msg, sender) => {
    // D3: Sender validation — μόνο το δικό μας background
    if (!sender || sender.id !== browser.runtime.id) {
      console.warn(
        '[ECBF:ContentOverlay] D3: REJECTED message from untrusted sender:',
        sender?.id || 'unknown'
      );
      return;
    }

    if (msg && msg.action === 'closeOverlay') {
      console.log('[ECBF:ContentOverlay] closeOverlay received (trusted)');
      closeOverlayAnimated();
    }
  });

  console.log('[ECBF:ContentOverlay] D3: sender validation listener installed');

  // ============================================================
  //  21. pagehide (BFCache)
  // ============================================================
  window.addEventListener('pagehide', () => {
    console.log('[ECBF:ContentOverlay] pagehide — closing');
    isClosed = true;

    try {
      if (_hostGuard) {
        _hostGuard.disconnect();
        _hostGuard = null;
      }
    } catch (_) {}

    try {
      if (window.__CBF_visibilityCheck) {
        document.removeEventListener('visibilitychange', window.__CBF_visibilityCheck);
        window.removeEventListener('focus', window.__CBF_visibilityCheck);
        window.__CBF_visibilityCheck = null;
      }
    } catch (_) {}

    try {
      if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
          typeof CBF_MODAL_SERVICE.cancelAll === 'function') {
        CBF_MODAL_SERVICE.cancelAll();
      }
    } catch (_) {}

    try {
      if (typeof CBF_FEATURE_MAIN_MENU !== 'undefined' &&
          typeof CBF_FEATURE_MAIN_MENU.destroy === 'function') {
        CBF_FEATURE_MAIN_MENU.destroy();
      }
    } catch (_) {}
    try {
      if (typeof CBF_FEATURE_CONTEXT_MENU !== 'undefined' &&
          typeof CBF_FEATURE_CONTEXT_MENU.destroy === 'function') {
        CBF_FEATURE_CONTEXT_MENU.destroy();
      }
    } catch (_) {}

    try {
      if (typeof CBF_DRAGDROP !== 'undefined' && CBF_DRAGDROP.destroy) {
        CBF_DRAGDROP.destroy();
      }
    } catch (_) {}

    try {
      if (typeof CBF_BRIDGE !== 'undefined' && CBF_BRIDGE.shutdown) {
        CBF_BRIDGE.shutdown();
      }
    } catch (_) {}

    try {
      if (host && host.parentNode) host.parentNode.removeChild(host);
    } catch (_) {}
  });

  // ============================================================
  //  22. Stop propagation από clicks
  // ============================================================
  container.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // ============================================================
  //  23. M-8 + H-7: Mutation event listener (multi-tab sync)
  // ============================================================
  function _shouldSkipMutationRefresh() {
    if (typeof CBF_UI !== 'undefined' &&
        typeof CBF_UI.isSearchActive === 'function' &&
        CBF_UI.isSearchActive()) {
      return 'search-active';
    }

    if (typeof CBF_DRAGDROP !== 'undefined' &&
        typeof CBF_DRAGDROP.isDragging === 'function' &&
        CBF_DRAGDROP.isDragging()) {
      return 'drag-in-progress';
    }

    if (typeof CBF_UI !== 'undefined' &&
        CBF_UI._internal &&
        typeof CBF_UI._internal.isUnlockPromptInProgress === 'function' &&
        CBF_UI._internal.isUnlockPromptInProgress()) {
      return 'unlock-prompt';
    }

    if (typeof CBF_UI !== 'undefined' &&
        CBF_UI._internal &&
        typeof CBF_UI._internal.isActionInProgress === 'function' &&
        CBF_UI._internal.isActionInProgress()) {
      return 'action-in-progress';
    }

    return null;
  }

  function _scheduleMutationRefresh(reason) {
    if (_mutationRefreshTimer) return;
    // ⭐ v12.2 CPU-07: adaptive throttle
    _mutationRefreshTimer = setTimeout(async () => {
      _mutationRefreshTimer = null;

      if (isClosed) return;
      if (typeof CBF_UI === 'undefined' || !CBF_UI) return;

      const skipReason = _shouldSkipMutationRefresh();
      if (skipReason) {
        console.log(`[ECBF:ContentOverlay] H-7: M-8 refresh skipped (${skipReason}) — ${reason}`);
        return;
      }

      const currentFolderId = CBF_UI.getCurrentFolderId();
      if (!currentFolderId) return;

      console.log(`[ECBF:ContentOverlay] M-8: refresh due to ${reason}`);

      try {
        await CBF_UI.navigateToFolder(currentFolderId, { preservePath: true });
      } catch (e) {
        console.warn('[ECBF:ContentOverlay] M-8: refresh failed:', e.message);
      }
    }, MUTATION_REFRESH_THROTTLE_MS);
  }

  function _registerMutationListener() {
    if (_mutationListenerRegistered) return;

    if (typeof CBF_BRIDGE === 'undefined' ||
        typeof CBF_BRIDGE.on !== 'function') {
      console.warn('[ECBF:ContentOverlay] M-8: CBF_BRIDGE.on not available');
      return;
    }

    CBF_BRIDGE.on('mutationEvent', (event) => {
      if (isClosed) return;

      try {
        const mutation = event?.mutation;
        if (!mutation || typeof mutation !== 'object') return;

        const currentFolderId = (typeof CBF_UI !== 'undefined' && CBF_UI.getCurrentFolderId)
          ? CBF_UI.getCurrentFolderId()
          : null;

        if (!currentFolderId) return;

        let shouldRefresh = false;
        let reason = mutation.type || 'unknown';

        switch (mutation.type) {
          case 'created':
          case 'updated':
            if (mutation.node && mutation.node.parentId === currentFolderId) {
              shouldRefresh = true;
            }
            break;

          case 'moved':
            if (Array.isArray(mutation.moves)) {
              for (const m of mutation.moves) {
                if (m.parentId === currentFolderId) {
                  shouldRefresh = true;
                  break;
                }
              }
            }
            break;

          case 'deleted':
            shouldRefresh = true;
            break;

          case 'cross-moved':
            shouldRefresh = true;
            break;

          default:
            shouldRefresh = true;
            break;
        }

        if (shouldRefresh) {
          _scheduleMutationRefresh(reason);
        }
      } catch (e) {
        console.warn('[ECBF:ContentOverlay] M-8: mutation handler error:', e.message);
      }
    });

    _mutationListenerRegistered = true;
    console.log('[ECBF:ContentOverlay] M-8: mutation event listener registered');
  }

  // ============================================================
  //  Post-MVP: Bridge Lifecycle Listener
  // ============================================================
  function _registerBridgeLifecycleListener() {
    if (_lifecycleListenerRegistered) return;

    if (typeof CBF_BRIDGE === 'undefined' ||
        typeof CBF_BRIDGE.on !== 'function') {
      console.warn('[ECBF:ContentOverlay] bridge lifecycle: CBF_BRIDGE.on not available');
      return;
    }

    CBF_BRIDGE.on('bridgeDisconnected', () => {
      if (isClosed) return;
      console.log('[ECBF:ContentOverlay] bridgeDisconnected — vault may have suspended (MV3)');
      _handleVaultSuspended();
    });

    CBF_BRIDGE.on('bridgeReconnected', () => {
      if (isClosed) return;
      console.log('[ECBF:ContentOverlay] bridgeReconnected — refreshing status');
      refreshLockIcon();
    });

    _lifecycleListenerRegistered = true;
    console.log('[ECBF:ContentOverlay] bridge lifecycle listeners registered');
  }

  async function _handleVaultSuspended() {
    if (isClosed) return;

    if (activeSpace === 'firefox' && !isUnlocked) {
      return;
    }

    console.log(
      `[ECBF:ContentOverlay] vault suspended — updating UI ` +
      `(space=${activeSpace}, unlocked=${isUnlocked})`
    );

    updateLockIcon(false);

    if (activeSpace === 'encrypted') {
      console.log('[ECBF:ContentOverlay] vault suspended — forcing firefox space');

      activeSpace = 'firefox';
      updateSpaceIndicator('firefox');

      if (typeof CBF_UI !== 'undefined' && CBF_UI.setActiveSpace) {
        CBF_UI.setActiveSpace('firefox');
      }

      try {
        await loadSpace('firefox');
      } catch (e) {
        if (isClosed) return;
        console.warn('[ECBF:ContentOverlay] loadSpace(firefox) failed:', e.message);
      }
    }
  }

  // ============================================================
  //  24. Wait for globals
  // ============================================================
  function waitForGlobals(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const required = [
        'CBF_UI',
        'CBF_BRIDGE',
        'CBF_REPLICA',
        'CBF_SELECTION_MANAGER',
        'CBF_BREADCRUMB_MANAGER',

        'CBF_DRAGDROP',
        'CBF_UI_COORDINATOR',
        'CBF_MERGE',
        'CBF_REDISTRIBUTION',
        'CBF_BOOKMARK_TRANSFER',

        'CBF_FIREFOX_REDISTRIBUTION',
        'CBF_FIREFOX_MERGE'
      ];

      const check = () => {
        const missing = required.filter(name => typeof window[name] === 'undefined');
        if (missing.length === 0) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Timeout waiting for: ' + missing.join(', ')));
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
  }

  // ============================================================
  //  25. Bootstrap
  // ============================================================
  (async function bootstrap() {
    console.log('[ECBF:ContentOverlay] Bootstrapping (v12.3)');

    const stillOpen = () => !isClosed;

    try {
      await waitForGlobals();
      if (!stillOpen()) return;
      console.log('[ECBF:ContentOverlay] All modules loaded');

      // Feature availability check
      const _missingFeatures = [];
      if (typeof window.CBF_FEATURE_ADD_BOOKMARK === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_ADD_BOOKMARK');
      }
      if (typeof window.CBF_FEATURE_ADD_FOLDER === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_ADD_FOLDER');
      }
      if (typeof window.CBF_FEATURE_SEARCH === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_SEARCH');
      }
      if (typeof window.CBF_FEATURE_PIN === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_PIN');
      }
      if (typeof window.CBF_FEATURE_MAIN_MENU === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_MAIN_MENU');
      }
      if (typeof window.CBF_FEATURE_CONTEXT_MENU === 'undefined') {
        _missingFeatures.push('CBF_FEATURE_CONTEXT_MENU');
      }

      if (_missingFeatures.length > 0) {
        console.warn(
          '[ECBF:ContentOverlay] Features NOT loaded: ' +
          _missingFeatures.join(', ') +
          ' — some buttons will be disabled. ' +
          'Check background.js INJECTED_SCRIPTS.'
        );
      } else {
        console.log('[ECBF:ContentOverlay] All features loaded ✓');
      }

      attachButtonHandlers();

      await loadPerfMode();
      if (!stillOpen()) return;

      if (typeof CBF_MODAL_SERVICE !== 'undefined' && CBF_MODAL_SERVICE.setContainer) {
        CBF_MODAL_SERVICE.setContainer(shadowRoot);
        console.log('[ECBF:ContentOverlay] Modal service container set');
      }

      // UI Init
      if (typeof CBF_UI !== 'undefined' && CBF_UI.init) {
        CBF_UI.init(shadowRoot, container);
        console.log('[ECBF:ContentOverlay] UI initialized');
      }

      // Drag & Drop
      if (typeof CBF_DRAGDROP !== 'undefined' && CBF_DRAGDROP.init) {
        CBF_DRAGDROP.init(container, shadowRoot);
        console.log('[ECBF:ContentOverlay] Drag & Drop initialized');
      }

      // Features
      if (typeof CBF_FEATURE_ADD_BOOKMARK !== 'undefined' &&
          typeof CBF_FEATURE_ADD_BOOKMARK.init === 'function') {
        CBF_FEATURE_ADD_BOOKMARK.init(container, shadowRoot);
        console.log('[ECBF:ContentOverlay] Feature: Add Bookmark initialized');
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_ADD_BOOKMARK not available');
      }

      if (typeof CBF_FEATURE_ADD_FOLDER !== 'undefined' &&
          typeof CBF_FEATURE_ADD_FOLDER.init === 'function') {
        CBF_FEATURE_ADD_FOLDER.init(container, shadowRoot);
        console.log('[ECBF:ContentOverlay] Feature: Add Folder initialized');
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_ADD_FOLDER not available');
      }

      if (typeof CBF_FEATURE_SEARCH !== 'undefined' &&
          typeof CBF_FEATURE_SEARCH.init === 'function') {
        CBF_FEATURE_SEARCH.init(container, shadowRoot);
        console.log('[ECBF:ContentOverlay] Feature: Search initialized');
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_SEARCH not available');
      }

      if (typeof CBF_FEATURE_PIN !== 'undefined' &&
          typeof CBF_FEATURE_PIN.init === 'function') {
        CBF_FEATURE_PIN.init(container, shadowRoot);
        console.log('[ECBF:ContentOverlay] Feature: Pin initialized');
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_PIN not available');
      }

      // V12E: Main Menu
      if (typeof CBF_FEATURE_MAIN_MENU !== 'undefined' &&
          typeof CBF_FEATURE_MAIN_MENU.init === 'function') {
        const ok = CBF_FEATURE_MAIN_MENU.init(container, shadowRoot);
        if (ok) {
          console.log('[ECBF:ContentOverlay] Feature: Main Menu initialized');
        } else {
          console.warn('[ECBF:ContentOverlay] Feature: Main Menu init returned false');
        }
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_MAIN_MENU not available');
      }

      // V12E: Context Menu
      if (typeof CBF_FEATURE_CONTEXT_MENU !== 'undefined' &&
          typeof CBF_FEATURE_CONTEXT_MENU.init === 'function') {
        const ok = CBF_FEATURE_CONTEXT_MENU.init(container, shadowRoot);
        if (ok) {
          console.log('[ECBF:ContentOverlay] Feature: Context Menu initialized');
        } else {
          console.warn('[ECBF:ContentOverlay] Feature: Context Menu init returned false');
        }
      } else {
        console.warn('[ECBF:ContentOverlay] CBF_FEATURE_CONTEXT_MENU not available');
      }

      console.log('[ECBF:ContentOverlay] Connecting to background...');
      await CBF_BRIDGE.connect();
      if (!stillOpen()) return;
      CBF_BRIDGE.start();
      console.log('[ECBF:ContentOverlay] Bridge connected');

      // ⭐ v12.2 LAT-01: Status cache warm-up
      //  Γεμίζει το 500ms TTL cache του bridge, ώστε τα επόμενα
      //  getStatus calls (π.χ. refreshLockIcon + bootstrap flow)
      //  να μην κάνουν round-trip.
      try {
        await CBF_BRIDGE.getStatus();
        if (stillOpen()) console.log('[ECBF:ContentOverlay] LAT-01: status cache warmed');
      } catch (_) {}

      // M-8: Mutation listener
      _registerMutationListener();

      // Post-MVP: Bridge lifecycle listener
      _registerBridgeLifecycleListener();

      // Post-MVP: Visibility-based vault status check
      window.__CBF_visibilityCheck = async () => {
        if (isClosed) return;
        if (document.visibilityState !== 'visible') return;
        if (typeof CBF_BRIDGE === 'undefined') return;

        if (!isUnlocked) return;

        try {
          const status = await CBF_BRIDGE.getStatus();
          if (isClosed) return;

          if (!status.unlocked && isUnlocked) {
            console.log('[ECBF:ContentOverlay] visibility check: vault suspended → updating UI');
            await _handleVaultSuspended();
          }
        } catch (_) {}
      };

      document.addEventListener('visibilitychange', window.__CBF_visibilityCheck);
      window.addEventListener('focus', window.__CBF_visibilityCheck);

      console.log('[ECBF:ContentOverlay] visibility-based vault status check installed');

      await refreshLockIcon();
      if (!stillOpen()) return;

      const spaceRes = await CBF_BRIDGE.getActiveSpace();
      if (!stillOpen()) return;

      // v1.5.4: Restore last space (με lock check)
      const savedSpace = await _readLastSpace();
      if (!stillOpen()) return;

      const currentStatus = await CBF_BRIDGE.getStatus();
      if (!stillOpen()) return;

      let initialSpace;
      if (savedSpace === 'encrypted' && currentStatus.unlocked) {
        initialSpace = 'encrypted';
        console.log('[ECBF:ContentOverlay] v1.5.4: restoring last space = encrypted (unlocked)');
      } else if (savedSpace === 'encrypted' && !currentStatus.unlocked) {
        initialSpace = 'firefox';
        console.log('[ECBF:ContentOverlay] v1.5.4: last=encrypted BUT locked → forcing firefox');
      } else {
        initialSpace = 'firefox';
        console.log('[ECBF:ContentOverlay] v1.5.4: restoring last space = firefox');
      }

      console.log(`[ECBF:ContentOverlay] Initial space: ${initialSpace}`);

      // Sync background με το αποφασισμένο space
      try {
        if (spaceRes.activeSpace !== initialSpace) {
          await CBF_BRIDGE.setActiveSpace(initialSpace);
          if (!stillOpen()) return;
        }
      } catch (e) {
        console.warn('[ECBF:ContentOverlay] setActiveSpace sync failed:', e.message);
      }

      updateSpaceIndicator(initialSpace);

      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.setActiveSpace === 'function') {
        CBF_UI.setActiveSpace(initialSpace);
      }

      // loadSpace: auto-navigate to pin (v1.5.3)
      await loadSpace(initialSpace);
      if (!stillOpen()) return;

      await slideUp();

      console.log(`[ECBF:ContentOverlay] Ready ✓ (v12.3, low-end=${_IS_LOW_END})`);

    } catch (e) {
      if (isClosed) {
        console.log('[ECBF:ContentOverlay] Bootstrap aborted (overlay closed)');
        return;
      }
      console.error('[ECBF:ContentOverlay] Bootstrap FAILED:', e);
      try {
        const hint = document.createElement('div');
        hint.style.cssText = `
          padding: 20px; color: #fff; text-align: center;
          background: rgba(200, 50, 50, 0.9);
          border-radius: 12px;
        `;
        hint.textContent = 'Σφάλμα φόρτωσης overlay: ' + e.message;
        container.appendChild(hint);
        await slideUp();
      } catch (_) {}
    }
  })();

})();