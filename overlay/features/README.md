# ECBF Features (Post-MVP)

Αυτός ο φάκελος περιέχει **Post-MVP features** που επεκτείνουν το UI
χωρίς να τροποποιούν τον πυρήνα (`core/`).

## Σύμβαση

Κάθε feature αρχείο:

1. Είναι **IIFE** (`var CBF_FEATURE_XXX = (function() { ... })()`)
2. Εκθέτει `init(container, shadowRoot)` — καλείται από `content-overlay.js`
3. Χρησιμοποιεί **μόνο** public API των:
   - `CBF_BRIDGE`
   - `CBF_UI` (public methods)
   - `CBF_MODAL_SERVICE`
   - `CBF_SELECTION_MANAGER`
4. **ΔΕΝ** παραβιάζει:
   - D-13.1 (Closed Shadow DOM) — λαμβάνει `container` reference
   - Invariant 4 (Single Writer) — περνάει από `CBF_BRIDGE`
   - D-23.1 (Least Privilege) — 0 νέα permissions

## Αρχεία

| Αρχείο | Feature | Space | Command |
|--------|---------|-------|---------|
| `add-bookmark.js` | Προσθήκη σελιδοδείκτη | encrypted | `create` |
| `add-folder.js` | Δημιουργία φακέλου | encrypted | `create` |

## Προσθήκη Νέου Feature

1. Δημιούργησε `features/my-feature.js` με pattern:

```js
var CBF_FEATURE_MY_FEATURE = (function() {
  'use strict';

  function init(container, shadowRoot) {
    const btn = container.querySelector('#cbf-my-button');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _run();
    });
  }

  async function _run() {
    // Λογική — χρησιμοποίησε CBF_BRIDGE / CBF_UI / CBF_MODAL_SERVICE
  }

  return { init, _internal: { _run } };
})();