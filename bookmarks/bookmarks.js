// bookmarks/bookmarks.js
//
// ECBF v12E Final 2 — Newtab/Homepage redirect
//
// Στρατηγική (ίδια με v12.4):
//   1. Script εκτελείται αμέσως (body είναι κενό → κανένα flash)
//   2. Αν υπάρχει homepage → redirect
//   3. Αν ΔΕΝ υπάρχει → δημιουργεί fallback UI δυναμικά
//

(function() {
  'use strict';

  async function init() {
    try {
      const { userHomepage } = await browser.storage.local.get('userHomepage');

      // ---------- Case A: υπάρχει homepage → redirect ----------
      if (userHomepage && typeof userHomepage === 'string' &&
          /^https?:\/\//i.test(userHomepage)) {
        console.log('[ECBF:Bookmarks] Redirecting to:', userHomepage);
        window.location.replace(userHomepage);
        return;
      }

      // ---------- Case B: δεν υπάρχει homepage → fallback UI ----------
      renderFallback(
        'Δεν έχετε ορίσει αρχική σελίδα. Ανοίξτε τις ρυθμίσεις για να την ορίσετε.'
      );

    } catch (e) {
      console.error('[ECBF:Bookmarks] Error:', e);
      renderFallback('Σφάλμα φόρτωσης.');
    }
  }

  // ============================================================
  //  renderFallback — δημιουργεί UI δυναμικά (ΜΟΝΟ αν χρειαστεί)
  //
  //  Όταν υπάρχει homepage, αυτή η συνάρτηση ΔΕΝ καλείται ποτέ.
  //  Άρα το body μένει κενό → κανένα flash.
  // ============================================================
  function renderFallback(message) {
    document.title = 'ECBF';

    const wrap = document.createElement('div');
    wrap.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
      background: #1a1a2e;
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    const box = document.createElement('div');
    box.style.cssText = 'text-align: center; max-width: 400px;';

    const h1 = document.createElement('h1');
    h1.textContent = 'ECBF';
    h1.style.cssText = 'font-size: 22px; margin: 0 0 12px; font-weight: 600;';

    const p = document.createElement('p');
    p.textContent = message;
    p.style.cssText = 'opacity: 0.7; font-size: 14px; margin-bottom: 20px; line-height: 1.5;';

    const btn = document.createElement('button');
    btn.textContent = 'Άνοιγμα ρυθμίσεων';
    btn.style.cssText = `
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      background: #3b82f6;
      color: #fff;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    `;
    btn.addEventListener('click', () => {
      browser.runtime.openOptionsPage();
    });

    box.appendChild(h1);
    box.appendChild(p);
    box.appendChild(btn);
    wrap.appendChild(box);

    document.body.style.margin = '0';
    document.body.appendChild(wrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'reloadBookmarksPage') {
      location.reload();
    }
  });
})();