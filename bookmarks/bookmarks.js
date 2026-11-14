// bookmarks/bookmarks.js
//
// ECBF v12.4 — Newtab/Homepage redirect
//
// @path     bookmarks/bookmarks.js
// @version  12.4.0
// @since    v12E / v12.4
//
// PURPOSE
//   Newtab/Homepage page controller. Διαβάζει το userHomepage από
//   storage.local και:
//     1. Αν υπάρχει → redirect μέσω window.location.replace()
//     2. Αν δεν υπάρχει → fallback UI με κουμπί που ανοίγει options
//
// STRATEGY (ίδια με v12.4)
//   1. Script εκτελείται αμέσως (body κενό → κανένα flash)
//   2. Αν υπάρχει homepage → redirect
//   3. Αν ΔΕΝ υπάρχει → δημιουργεί fallback UI δυναμικά
//
// CHANGELOG
// ══════════════════════════════════════════════════════════════════════
// v12.4.0 (2026-10-27) — L-4 FIX: Complete reloadBookmarksPage flow
// ══════════════════════════════════════════════════════════════════════
// ΠΡΙΝ:
//   Το module είχε orphan listener για 'reloadBookmarksPage' που δεν
//   έστελνε κανείς. Dead code (feature που δεν ολοκληρώθηκε).
//
// ΜΕΤΑ:
//   Ο listener είναι πλέον endpoint του πλήρους flow:
//     options.js (setHomepage) →
//     background.js (broadcast σε tabs) →
//     bookmarks.js (reload → νέο redirect)
//
//   Στο background.js προστέθηκε native handler
//   (msg.type === 'reloadBookmarksPage') που κάνει
//   browser.tabs.query + sendMessage σε όλα τα ανοιχτά
//   bookmarks.html tabs.
//
//   Στο options.js (saveBtn handler) προστέθηκε κλήση
//   browser.runtime.sendMessage({ type: 'reloadBookmarksPage' })
//   μετά από επιτυχές setHomepage.
//
// Impact:
//   Όταν ο χρήστης αλλάζει homepage από options page, όλα τα tabs
//   που έχουν ανοιχτό bookmarks.html ανανεώνονται αυτόματα →
//   redirect στο νέο homepage. Zero χειροκίνητο reload.
//
// Security:
//   Προστέθηκε sender validation (D3 defense-in-depth pattern) —
//   αν και το browser.runtime.onMessage είναι inherently trusted,
//   ο έλεγχος sender.id === browser.runtime.id είναι best practice
//   και consistent με content-overlay.js.
//
// VERSION ALIGNMENT:
//   • @version  (νέο — πρώτη explicit version του file)
//   • @since    v12E / v12.4
// ══════════════════════════════════════════════════════════════════════

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

  // ============================================================
  //  v12.4 L-4: reloadBookmarksPage listener (COMPLETE FLOW)
  //
  //  Endpoint του flow:
  //    options.js::saveBtn
  //      → browser.runtime.sendMessage({ type: 'reloadBookmarksPage' })
  //    background.js::runtime.onMessage
  //      → browser.tabs.query + browser.tabs.sendMessage σε κάθε tab
  //    bookmarks.js (εδώ)
  //      → location.reload() → init() → redirect στο νέο homepage
  //
  //  SECURITY: sender validation (D3 defense-in-depth pattern) —
  //  αν και το onMessage από το ίδιο extension είναι inherently
  //  trusted, ο έλεγχος είναι best practice + consistent με το
  //  content-overlay.js (D3 pattern).
  // ============================================================
  browser.runtime.onMessage.addListener((msg, sender) => {
    // D3: sender validation — μόνο μηνύματα από το ίδιο extension
    if (!sender || sender.id !== browser.runtime.id) {
      console.warn(
        '[ECBF:Bookmarks] REJECTED message from untrusted sender:',
        sender?.id || 'unknown'
      );
      return;
    }

    if (msg && msg.action === 'reloadBookmarksPage') {
      console.log('[ECBF:Bookmarks] reloadBookmarksPage received — reloading to pick up new homepage');
      location.reload();
    }
  });

})();