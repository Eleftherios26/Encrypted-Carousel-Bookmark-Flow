/**
 * dragdrop.js — Drag & Drop engine (encrypted + firefox)
 *
 * @path     overlay/drag_and_drop/dragdrop.js
 * @version  12.2.0
 * @since    v12E / v12.2
 *
 * PURPOSE
 *   Drag & Drop engine για cards. Υποστηρίζει:
 *     • Single drag (move/reorder)
 *     • Multi drag (drag badge με "+N")
 *     • Merge detection (bookmark + bookmark, folder + folder)
 *     • Folder enter (drop into folder)
 *     • Breadcrumb drop (move to ancestor)
 *     • Auto-scroll arrows (proximity-based)
 *
 * KEY CONCEPTS
 *   • Multi-drag badge: golden circle με "+N" στο drag canvas
 *   • M-7 caller: getSelectedItemIdsInOrder() νέο shape
 *   • M-16 caller: auto-unlock πριν merge (encrypted)
 *   • Space lock: dragSpace locked at dragstart
 *   • v1.5.2: explicit clear selection μετά multi-reorder
 *     (dragdrop._handleReorder — δεν κάνει navigate)
 *
 * NON-OBVIOUS
 *   • Multi-REORDER (ίδιος φάκελος) → ΔΕΝ κάνει navigate,
 *     οπότε ο caller καθαρίζει ρητά τη selection.
 *     Multi-MOVE (αλλαγή φακέλου) → coordinator.set(id) + navigate.
 *   • Arrow proximity: το drag source μαρκάρεται με `.arrow-near`
 *     όταν ο κέρσορας πλησιάζει τα scroll arrows.
 *   • forceCleanup() είναι idempotent — safe να κληθεί πολλές φορές.
 *
 * DECISIONS
 *   D-13.1, D-47, D-50
 *
 * CHANGELOG v12.2.0 (2026-09-26) — ARROWS VISIBILITY FIX
 *   ═══════════════════════════════════════════════════════════════════
 *   FIX v12.2.1 — Native arrows ΠΑΝΤΑ ορατά (εκτός κατά τη διάρκεια drag)
 *
 *     ΠΡΟΒΛΗΜΑ:
 *       Το `_createArrows()` (init phase) έθετε inline
 *       `style.display = 'none'` στα native arrows
 *       (`.scroll-arrow` elements του ui-controller.js).
 *
 *       Αυτό:
 *         1. Υπερίσχυε του CSS (το `.hidden` class χρησιμοποιεί
 *            `opacity: 0` + `pointer-events: none`, ΟΧΙ `display:none`)
 *         2. Τα arrows έμεναν κρυμμένα μέχρι το 1ο dragend
 *            (που καλεί `forceCleanup() → _hideArrows()`)
 *         3. Δημιουργούσε σύγχυση με τα drag arrows:
 *              • Native arrows: στο `.layer3-wrapper` (shadow DOM)
 *              • Drag arrows: στο `document.body` (fixed position)
 *              • Διαφορετικά positions → "μπερδεύονται"
 *
 *     ΛΥΣΗ:
 *       1. `_createArrows()`: ΔΕΝ αγγίζει τα native arrows.
 *          Μένουν CSS-controlled από το ui-controller.js
 *          (`_updateArrowsForSelection()` → `.hidden` class).
 *
 *       2. `_showArrows()`: Κρύβει temporary τα native arrows
 *          ΜΟΝΟ κατά τη διάρκεια drag (για να μην υπάρχει
 *          visual conflict με τα drag arrows).
 *
 *       3. `_hideArrows()`: Αποκαθιστά τα native arrows
 *          (αφαιρεί το inline `display: none`).
 *
 *     ΑΠΟΤΕΛΕΣΜΑ:
 *       ✓ Arrows ορατά από το init (πριν οποιοδήποτε drag)
 *       ✓ Καμία σύγχυση native vs drag arrows
 *       ✓ Ομαλή εναλλαγή κατά τη διάρκεια drag
 *   ═══════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "dragdrop"
 */

var CBF_DRAGDROP = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MERGE_RADIUS        = 35;
  const FOLDER_ENTER_RADIUS = 40;
  const FOLDER_MERGE_RADIUS = 35;
  const PROXIMITY_RADIUS    = 80;
  const SCROLL_SPEED        = 50;

  // ============================================================
  //  State
  // ============================================================
  let container = null;
  let layer3 = null;
  let breadcrumb = null;
  let shadowRoot = null;

  let dragSourceId = null;
  let dragSourceIds = [];
  let dragSourceCard = null;
  let dragPlaceholder = null;
  let dropTargetIndicator = null;

  // v12E.Final2-B: Locked space at drag start
  let dragSpace = null;

  let isMultiDrag = false;
  let _isDragging = false;
  let _isDropping = false;

  // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2.1: Native arrows (in shadow DOM, .scroll-arrow)
  //  vs drag arrows (in document.body, .drag-scroll-arrow)
  // ═══════════════════════════════════════════════════════════
  let nativeArrowLeft = null;
  let nativeArrowRight = null;

  // ⭐ v12.2.1: Drag arrows (in document.body)
  let arrowLeft = null;
  let arrowRight = null;
  let dragScrollAnimationId = null;
  let currentArrowDirection = 0;
  let arrowNearLeft = false;
  let arrowNearRight = false;

  let breadcrumbDragEnterCount = 0;
  let currentHoveredCrumb = null;

  let normalDragImage = null;
  let dragImageHotspot = { x: 0, y: 0 };

  let ro = null;
  let draggableObserver = null;
  let draggableIntervalId = null;

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:DragDrop]', ...a); }
  function warn(...a) { console.warn('[ECBF:DragDrop]', ...a); }
  function err(...a)  { console.error('[ECBF:DragDrop]', ...a); }

  // ============================================================
  //  Helpers
  // ============================================================
  function getCardElements() {
    if (!layer3) return [];
    return Array.from(layer3.children).filter(el => el.classList.contains('card'));
  }

  function _getVisibleItems() {
    if (typeof CBF_UI === 'undefined') return [];
    return CBF_UI.getVisibleItems() || [];
  }

  function _getCurrentFolderId() {
    return (typeof CBF_UI !== 'undefined') ? CBF_UI.getCurrentFolderId() : null;
  }

  function _findItem(id) {
    return _getVisibleItems().find(i => i.id === id);
  }

  // ============================================================
  //  M-7: Resolve selected IDs (handle both shapes)
  // ============================================================
  function _resolveSelectedIds() {
    if (typeof CBF_UI === 'undefined' ||
        typeof CBF_UI.getSelectedItemIdsInOrder !== 'function') {
      return { ids: [], missingIds: [], hasMissing: false };
    }

    const selResult = CBF_UI.getSelectedItemIdsInOrder();

    if (Array.isArray(selResult)) {
      // Backward compat: παλιό shape (string[])
      return { ids: selResult.slice(), missingIds: [], hasMissing: false };
    }

    if (selResult && Array.isArray(selResult.ids)) {
      return {
        ids: selResult.ids.slice(),
        missingIds: Array.isArray(selResult.missingIds) ? selResult.missingIds.slice() : [],
        hasMissing: selResult.hasMissing === true
      };
    }

    warn('getSelectedItemIdsInOrder() returned unexpected shape');
    return { ids: [], missingIds: [], hasMissing: false };
  }

  // ============================================================
  //  M-16: Auto-unlock helper για encrypted merge
  // ============================================================
  async function _ensureUnlockedForMerge(space, reason) {
    if (space !== 'encrypted') return true;

    if (typeof CBF_UI === 'undefined' ||
        typeof CBF_UI.ensureVaultUnlocked !== 'function') {
      warn('M-16: CBF_UI.ensureVaultUnlocked not available — skipping');
      return true;
    }

    try {
      const unlocked = await CBF_UI.ensureVaultUnlocked(reason);
      return unlocked === true;
    } catch (e) {
      err('M-16: ensureVaultUnlocked failed:', e.message);
      return false;
    }
  }

  // ============================================================
  //  v1.5.2: Explicit clear για multi-reorder (no navigate)
  // ============================================================
  function _clearSelectionAfterMultiReorder() {
    try {
      if (typeof CBF_SELECTION_MANAGER !== 'undefined' &&
          typeof CBF_SELECTION_MANAGER.clear === 'function') {
        CBF_SELECTION_MANAGER.clear();
      }
    } catch (e) {
      warn('v1.5.2: SEL.clear failed:', e.message);
    }

    try {
      if (typeof CBF_UI !== 'undefined' && CBF_UI._internal) {
        if (typeof CBF_UI._internal._applySelectionVisuals === 'function') {
          CBF_UI._internal._applySelectionVisuals();
        }
        if (typeof CBF_UI._internal._updateSelectionBadge === 'function') {
          CBF_UI._internal._updateSelectionBadge();
        }
      }
    } catch (e) {
      warn('v1.5.2: visuals sync failed:', e.message);
    }

    log('v1.5.2: multi-reorder → explicit selection clear (no navigate)');
  }

  // ============================================================
  //  Mutex
  // ============================================================
  let dropLock = Promise.resolve();
  function withDropLock(fn) {
    const result = dropLock.then(() => fn());
    dropLock = result.catch(() => {});
    return result;
  }

  // ============================================================
  //  Setup draggable state
  // ============================================================
  function _disableChildDraggable(root) {
    if (!root) return;

    const cards = root.querySelectorAll ? root.querySelectorAll('.card') : [];
    for (const card of cards) {
      if (card.draggable !== true) card.draggable = true;
    }

    const selector =
      '.card img, .card span, .card .card-icon, .card .card-title, ' +
      '.card .card-avatar, .card .card-delete, .card .card-lock';
    const nodes = root.querySelectorAll ? root.querySelectorAll(selector) : [];
    for (const node of nodes) {
      if (node.draggable !== false) node.draggable = false;
    }
  }

  // ============================================================
  //  Visual: placeholder
  // ============================================================
  function _createPlaceholder() {
    const ph = document.createElement('div');
    ph.className = 'drag-placeholder';
    ph.style.cssText = `
      flex-shrink: 0;
      width: 10px;
      height: 100px;
      margin: 0 10px;
      border-radius: 8px;
      background: rgba(255,255,255,0.95);
      box-shadow:
        0 0 30px rgba(255,255,255,1),
        0 0 60px rgba(255,255,255,0.8),
        0 0 90px rgba(255,215,0,0.6);
      display: none;
      pointer-events: none;
      transition: all 0.12s ease;
      z-index: 200;
    `;
    return ph;
  }

  function showPlaceholder(index) {
    if (!dragPlaceholder || !layer3) return;
    const cards = getCardElements();
    if (index >= cards.length) {
      layer3.appendChild(dragPlaceholder);
    } else {
      const reference = cards[index];
      if (reference) layer3.insertBefore(dragPlaceholder, reference);
      else layer3.appendChild(dragPlaceholder);
    }
    dragPlaceholder.style.display = 'block';
  }

  function hidePlaceholder() {
    if (dragPlaceholder) dragPlaceholder.style.display = 'none';
  }

  // ============================================================
  //  Visual: scroll arrows
  //
  //  ⭐ v12.2.1 FIX: ΜΗΝ κρύβεις τα native arrows εδώ.
  //  Θα κρυφτούν temporary στο _showArrows() κατά τη διάρκεια drag.
  // ============================================================
  function _createArrows() {
    // ═══════════════════════════════════════════════════════════
    //  ⭐ v12.2.1: ΔΕΝ αγγίζουμε τα native arrows εδώ.
    //
    //  Rationale:
    //    Τα native arrows (.scroll-arrow) είναι μέσα στο shadow DOM,
    //    στο .layer3-wrapper. Τα ελέγχει πλήρως το ui-controller.js
    //    μέσω `_updateArrowsForSelection()` (χρησιμοποιεί .hidden class
    //    με opacity: 0 + pointer-events: none).
    //
    //    Το παλιό `nativeArrow*.style.display = 'none'`:
    //      1. Υπερίσχυε του CSS (inline > class)
    //      2. Άφηνε τα arrows κρυμμένα μέχρι το 1ο dragend
    //      3. Δημιουργούσε σύγχυση με τα drag arrows
    // ═══════════════════════════════════════════════════════════

    // Remove τυχόν προηγούμενα drag arrows (safety, idempotent init)
    if (arrowLeft && arrowLeft.parentNode) arrowLeft.parentNode.removeChild(arrowLeft);
    if (arrowRight && arrowRight.parentNode) arrowRight.parentNode.removeChild(arrowRight);

    // Δημιουργία drag arrows — mount στο document.body (fixed position)
    arrowLeft = document.createElement('div');
    arrowLeft.className = 'drag-scroll-arrow left';
    arrowLeft.textContent = '❮';
    arrowLeft.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      width: 36px;
      height: 36px;
      display: none;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      color: #ffffff;
      background: rgba(255,255,255,0.25);
      backdrop-filter: blur(15px) saturate(180%);
      -webkit-backdrop-filter: blur(15px) saturate(180%);
      border: 1px solid rgba(255,215,0,0.6);
      border-radius: 50%;
      box-shadow: 0 4px 20px rgba(255,215,0,0.5), inset 0 1px 0 rgba(255,255,255,0.4);
      text-shadow: 0 1px 4px rgba(0,0,0,0.6);
      cursor: default;
      pointer-events: none;
      user-select: none;
      transition: background 0.2s, box-shadow 0.2s, transform 0.2s, border 0.2s;
    `;

    arrowRight = document.createElement('div');
    arrowRight.className = 'drag-scroll-arrow right';
    arrowRight.textContent = '❯';
    arrowRight.style.cssText = arrowLeft.style.cssText;

    document.body.appendChild(arrowLeft);
    document.body.appendChild(arrowRight);

    arrowLeft.addEventListener('dragover', onArrowDragOver);
    arrowLeft.addEventListener('dragleave', onArrowDragLeave);
    arrowLeft.addEventListener('drop', onArrowDrop);
    arrowRight.addEventListener('dragover', onArrowDragOver);
    arrowRight.addEventListener('dragleave', onArrowDragLeave);
    arrowRight.addEventListener('drop', onArrowDrop);
  }

  function _positionArrows() {
    if (!layer3 || !arrowLeft || !arrowRight) return;
    const rect = layer3.getBoundingClientRect();
    const size = 36;
    const top = rect.top + 10;
    arrowLeft.style.left = (rect.left + rect.width * 0.3 - size / 2) + 'px';
    arrowLeft.style.top  = top + 'px';
    arrowRight.style.left = (rect.left + rect.width * 0.7 - size / 2) + 'px';
    arrowRight.style.top = top + 'px';
  }

  // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2.1: _showArrows με temporary hide των native
  //
  //  Κατά τη διάρκεια drag:
  //    - Native arrows → hidden (inline display:none, temporary)
  //    - Drag arrows → visible
  //
  //  Αυτό αποφεύγει το visual conflict (ίδια θέση, διαφορετικά
  //  styles, διαφορετικά containers).
  // ═══════════════════════════════════════════════════════════
  function _showArrows() {
    if (!arrowLeft || !arrowRight) return;
    _positionArrows();

    // ⭐ v12.2.1 FIX: Temporary hide native arrows
    if (nativeArrowLeft) nativeArrowLeft.style.display = 'none';
    if (nativeArrowRight) nativeArrowRight.style.display = 'none';

    // Show drag arrows
    arrowLeft.style.display = 'flex';
    arrowLeft.style.pointerEvents = 'auto';
    arrowRight.style.display = 'flex';
    arrowRight.style.pointerEvents = 'auto';
  }

  // ═══════════════════════════════════════════════════════════
  //  ⭐ v12.2.1: _hideArrows με restore των native
  //
  //  Στο τέλος του drag:
  //    - Drag arrows → hidden
  //    - Native arrows → restored (αφαιρείται το inline display:none)
  //
  //  Το ui-controller.js θα επαναφέρει το σωστό visibility (μέσω
  //  .hidden class) στο επόμενο _updateArrowsForSelection() call.
  // ═══════════════════════════════════════════════════════════
  function _hideArrows() {
    if (arrowLeft) {
      arrowLeft.style.display = 'none';
      arrowLeft.style.pointerEvents = 'none';
      arrowLeft.classList.remove('active', 'near');
    }
    if (arrowRight) {
      arrowRight.style.display = 'none';
      arrowRight.style.pointerEvents = 'none';
      arrowRight.classList.remove('active', 'near');
    }
    if (dragSourceCard) dragSourceCard.classList.remove('arrow-near');

    // ⭐ v12.2.1 FIX: Restore native arrows (αφαιρεί inline display:none)
    if (nativeArrowLeft) nativeArrowLeft.style.display = '';
    if (nativeArrowRight) nativeArrowRight.style.display = '';

    arrowNearLeft = false;
    arrowNearRight = false;
  }

  function _updateArrowProximity(clientX, clientY) {
    if (!_isDragging) return;
    const checkArrow = (arrow) => {
      if (!arrow || arrow.style.display === 'none') return false;
      const rect = arrow.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.sqrt((clientX - cx) ** 2 + (clientY - cy) ** 2);
      return dist < PROXIMITY_RADIUS;
    };
    const leftNear = checkArrow(arrowLeft);
    const rightNear = checkArrow(arrowRight);
    if (leftNear !== arrowNearLeft) {
      arrowNearLeft = leftNear;
      if (arrowLeft) {
        if (leftNear) arrowLeft.classList.add('near');
        else arrowLeft.classList.remove('near');
      }
    }
    if (rightNear !== arrowNearRight) {
      arrowNearRight = rightNear;
      if (arrowRight) {
        if (rightNear) arrowRight.classList.add('near');
        else arrowRight.classList.remove('near');
      }
    }
    if (dragSourceCard) {
      dragSourceCard.classList.toggle('arrow-near', leftNear || rightNear);
    }
  }

  function _startArrowScroll(direction) {
    if (dragScrollAnimationId) return;
    const animate = () => {
      if (!_isDragging || currentArrowDirection === 0) {
        dragScrollAnimationId = null;
        return;
      }
      if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.scrollBy === 'function') {
        CBF_UI.scrollBy(direction * SCROLL_SPEED);
      } else if (layer3) {
        layer3.scrollLeft += direction * SCROLL_SPEED;
      }
      const maxScroll = layer3.scrollWidth - layer3.clientWidth;
      if ((direction === -1 && layer3.scrollLeft <= 0) ||
          (direction === 1 && layer3.scrollLeft >= maxScroll)) {
        _stopArrowScroll();
        return;
      }
      dragScrollAnimationId = requestAnimationFrame(animate);
    };
    dragScrollAnimationId = requestAnimationFrame(animate);
  }

  function _stopArrowScroll() {
    if (dragScrollAnimationId) {
      cancelAnimationFrame(dragScrollAnimationId);
      dragScrollAnimationId = null;
    }
    currentArrowDirection = 0;
  }

  // ============================================================
  //  Drag image
  // ============================================================
  function _createDragCanvas(card) {
    const rect = card.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    dragImageHotspot = { x: w / 2, y: h / 2 };

    normalDragImage = document.createElement('canvas');
    normalDragImage.width = w;
    normalDragImage.height = h;
    _drawCardOnCanvas(normalDragImage.getContext('2d'), card, w, h);
  }

  function _drawCardOnCanvas(ctx, card, w, h) {
    const radius = 18;
    const style = getComputedStyle(card);

    ctx.fillStyle = style.getPropertyValue('--card-color') || 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(radius, 0);
    ctx.lineTo(w - radius, 0);
    ctx.quadraticCurveTo(w, 0, w, radius);
    ctx.lineTo(w, h - radius);
    ctx.quadraticCurveTo(w, h, w - radius, h);
    ctx.lineTo(radius, h);
    ctx.quadraticCurveTo(0, h, 0, h - radius);
    ctx.lineTo(0, radius);
    ctx.quadraticCurveTo(0, 0, radius, 0);
    ctx.closePath();
    ctx.fill();

    const iconDiv = card.querySelector('.card-icon');
    if (iconDiv) {
      const iconImg = iconDiv.querySelector('img');
      const avatar = iconDiv.querySelector('.card-avatar');
      const iconRect = iconDiv.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const ox = iconRect.left - cardRect.left;
      const oy = iconRect.top - cardRect.top;

      if (iconImg && iconImg.complete) {
        try {
          ctx.drawImage(iconImg, ox, oy, iconRect.width, iconRect.height);
        } catch (_) {}
      } else if (avatar) {
        ctx.fillStyle = getComputedStyle(avatar).backgroundColor || '#888';
        ctx.beginPath();
        ctx.arc(ox + iconRect.width / 2, oy + iconRect.height / 2,
                iconRect.width / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(avatar.textContent || '?',
                     ox + iconRect.width / 2,
                     oy + iconRect.height / 2);
      }
    }

    const titleDiv = card.querySelector('.card-title');
    if (titleDiv) {
      const titleRect = titleDiv.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      ctx.fillStyle = '#111';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(titleDiv.textContent || '', w / 2,
                   titleRect.top - cardRect.top, w - 12);
    }

    // Multi-select: "+N" badge στο top-right του drag image
    if (isMultiDrag && Array.isArray(dragSourceIds) && dragSourceIds.length > 1) {
      const extraCount = dragSourceIds.length - 1;
      const badgeRadius = 14;
      const badgeX = w - badgeRadius - 2;
      const badgeY = badgeRadius + 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd700';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.fillStyle = '#000000';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${extraCount}`, badgeX, badgeY + 1);
      ctx.restore();
    }
  }

  // ============================================================
  //  Init
  // ============================================================
  function init(containerEl, shadow) {
    log('init called');
    container = containerEl;
    shadowRoot = shadow || null;

    layer3 = container.querySelector('.layer3');
    breadcrumb = container.querySelector('.breadcrumb');

    if (!layer3) {
      err('layer3 not found');
      return;
    }

    dragPlaceholder = _createPlaceholder();
    layer3.appendChild(dragPlaceholder);

    // ⭐ v12.2.1: Capture native arrows (ΔΕΝ τα κρύβουμε εδώ)
    nativeArrowLeft = container.querySelector('.scroll-arrow.left');
    nativeArrowRight = container.querySelector('.scroll-arrow.right');

    _createArrows();

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => _positionArrows());
      ro.observe(layer3);
    }
    window.addEventListener('resize', _positionArrows);

    layer3.addEventListener('dragstart', onDragStart, true);
    layer3.addEventListener('dragover', onDragOver);
    layer3.addEventListener('dragleave', onDragLeave);
    layer3.addEventListener('drop', onDrop);
    layer3.addEventListener('dragend', onDragEnd);

    if (breadcrumb) {
      breadcrumb.addEventListener('dragenter', onBreadcrumbDragEnter);
      breadcrumb.addEventListener('dragleave', onBreadcrumbDragLeave);
      breadcrumb.addEventListener('dragover', onBreadcrumbDragOver);
      breadcrumb.addEventListener('drop', onBreadcrumbDrop);
    }

    document.addEventListener('dragend', () => {
      if (_isDragging) forceCleanup();
    });
    window.addEventListener('blur', () => {
      if (_isDragging && !_isDropping) forceCleanup();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && _isDragging) forceCleanup();
    });

    _disableChildDraggable(layer3);

    if (typeof MutationObserver !== 'undefined') {
      draggableObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList') {
            for (const node of m.addedNodes) {
              if (node.nodeType === 1) _disableChildDraggable(node);
            }
          }
        }
      });
      draggableObserver.observe(layer3, { childList: true, subtree: true });
    }

    draggableIntervalId = setInterval(() => _disableChildDraggable(layer3), 2000);

    log('Child draggable guard installed');

    // DIAGNOSTIC
    setTimeout(() => {
      const cards = layer3.querySelectorAll('.card');
      log(`[DIAG] Cards in layer3: ${cards.length}`);
      if (cards.length > 0) {
        const card = cards[0];
        log(`[DIAG] Card draggable: ${card.draggable}`);
        const img = card.querySelector('img');
        if (img) log(`[DIAG] IMG draggable: ${img.draggable}`);
        const title = card.querySelector('.card-title');
        if (title) log(`[DIAG] Title draggable: ${title.draggable}`);
      }
    }, 1000);

    log('Initialized (v12.2.1: native arrows preserved + multi-drag badge + M-7/M-16 callers)');
  }

  // ============================================================
  //  DRAGSTART (M-7 caller)
  // ============================================================
  function onDragStart(e) {
    const card = e.target.closest ? e.target.closest('.card') : null;
    if (!card) return;

    const id = card.dataset.id;
    if (!id) {
      e.preventDefault();
      return;
    }

    dragSourceId = id;
    dragSourceCard = card;

    // v12E.Final2-B: Lock space
    dragSpace = (typeof CBF_UI !== 'undefined' && CBF_UI.getActiveSpace)
      ? CBF_UI.getActiveSpace()
      : 'firefox';

    // M-7 CALLER: handle new return shape
    const selResult = _resolveSelectedIds();
    const selectedIds = selResult.ids;

    if (selResult.hasMissing) {
      console.warn(
        `[ECBF:DragDrop] ${selResult.missingIds.length} cross-folder item(s) ` +
        `ignored during drag (only visible items dragged): ` +
        selResult.missingIds.slice(0, 3).join(', ') +
        (selResult.missingIds.length > 3 ? '...' : '')
      );
    }

    if (selectedIds.length > 1 && selectedIds.includes(id)) {
      isMultiDrag = true;
      dragSourceIds = selectedIds.slice();
      log(`Multi-drag: ${dragSourceIds.length} items`);
    } else {
      isMultiDrag = false;
      dragSourceIds = [id];
    }

    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', dragSourceIds.join(','));
    } catch (_) {}

    try {
      _createDragCanvas(card);
      e.dataTransfer.setDragImage(
        normalDragImage, dragImageHotspot.x, dragImageHotspot.y
      );
    } catch (_) {}

    card.style.opacity = '0.6';
    _isDragging = true;
    _isDropping = false;
    currentArrowDirection = 0;

    _showArrows();
    log(`dragstart: ${id} (multi=${isMultiDrag}, count=${dragSourceIds.length}, space=${dragSpace})`);
  }

  // ============================================================
  //  DRAGOVER
  // ============================================================
  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const crumb = e.target.closest ? e.target.closest('.crumb:not(.current)') : null;
    const card = e.target.closest ? e.target.closest('.card') : null;

    _clearDropTarget();

    if (crumb && crumb.dataset.folderId) {
      crumb.classList.add('folder-drop-target');
      dropTargetIndicator = crumb;
      hidePlaceholder();
      _updateArrowProximity(e.clientX, e.clientY);
      return;
    }

    if (card) {
      const targetId = card.dataset.id;
      if (!targetId || dragSourceIds.includes(targetId)) {
        hidePlaceholder();
        _updateArrowProximity(e.clientX, e.clientY);
        return;
      }

      const sourceItem = _findItem(dragSourceId);
      const targetItem = _findItem(targetId);
      if (!sourceItem || !targetItem) {
        hidePlaceholder();
        _updateArrowProximity(e.clientX, e.clientY);
        return;
      }

      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.sqrt((e.clientX - cx) ** 2 + (e.clientY - cy) ** 2);

      if (targetItem.type === 'folder' && sourceItem.type === 'folder' && !isMultiDrag) {
        if (dist < FOLDER_MERGE_RADIUS) {
          card.classList.add('merge-target');
          dropTargetIndicator = card;
          hidePlaceholder();
          _updateArrowProximity(e.clientX, e.clientY);
          return;
        }
      }

      if (targetItem.type === 'folder' && dist < FOLDER_ENTER_RADIUS) {
        card.classList.add('folder-drop-target');
        dropTargetIndicator = card;
        hidePlaceholder();
        _updateArrowProximity(e.clientX, e.clientY);
        return;
      }

      if (targetItem.type === 'bookmark' && sourceItem.type === 'bookmark' && !isMultiDrag) {
        if (dist < MERGE_RADIUS) {
          card.classList.add('merge-target');
          dropTargetIndicator = card;
          hidePlaceholder();
          _updateArrowProximity(e.clientX, e.clientY);
          return;
        }
      }

      const cards = getCardElements();
      const targetIdx = cards.indexOf(card);
      if (targetIdx !== -1) {
        const mid = rect.left + rect.width / 2;
        showPlaceholder(e.clientX > mid ? targetIdx + 1 : targetIdx);
        _updateArrowProximity(e.clientX, e.clientY);
        return;
      }
    }

    layer3.classList.add('folder-drop-target');
    dropTargetIndicator = layer3;
    hidePlaceholder();
    _updateArrowProximity(e.clientX, e.clientY);
  }

  function _clearDropTarget() {
    if (dropTargetIndicator) {
      dropTargetIndicator.classList.remove('merge-target', 'folder-drop-target');
      dropTargetIndicator = null;
    }
    if (layer3) layer3.classList.remove('folder-drop-target');
    document.querySelectorAll('.folder-drop-target').forEach(el =>
      el.classList.remove('folder-drop-target'));
    document.querySelectorAll('.merge-target').forEach(el =>
      el.classList.remove('merge-target'));
  }

  function onDragLeave(e) {
    if (!_isDragging) return;
    const related = e.relatedTarget;
    if (related === arrowLeft || related === arrowRight) return;
    if (!related || !layer3.contains(related)) {
      _stopArrowScroll();
      if (arrowNearLeft) {
        if (arrowLeft) arrowLeft.classList.remove('near');
        arrowNearLeft = false;
      }
      if (arrowNearRight) {
        if (arrowRight) arrowRight.classList.remove('near');
        arrowNearRight = false;
      }
      if (dragSourceCard) dragSourceCard.classList.remove('arrow-near');
    }
  }

  // ============================================================
  //  DROP
  // ============================================================
  async function onDrop(e) {
    e.preventDefault();
    _stopArrowScroll();
    _isDropping = true;

    const lockedSpace = dragSpace || (typeof CBF_UI !== 'undefined' && CBF_UI.getActiveSpace
      ? CBF_UI.getActiveSpace()
      : 'firefox');

    try {
      const crumb = e.target.closest ? e.target.closest('.crumb:not(.current)') : null;
      if (crumb && crumb.dataset.folderId) {
        await _handleBreadcrumbDrop(crumb.dataset.folderId, lockedSpace);
        return;
      }

      const card = e.target.closest ? e.target.closest('.card') : null;
      if (!card) { forceCleanup(); return; }
      const targetId = card.dataset.id;
      if (!targetId || dragSourceIds.includes(targetId)) { forceCleanup(); return; }

      const sourceItem = _findItem(dragSourceId);
      const targetItem = _findItem(targetId);
      if (!sourceItem || !targetItem) { forceCleanup(); return; }

      const rect = card.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.sqrt((e.clientX - cx) ** 2 + (e.clientY - cy) ** 2);

      if (targetItem.type === 'folder' && sourceItem.type === 'folder' && !isMultiDrag) {
        if (dist < FOLDER_MERGE_RADIUS) {
          await _handleMergeFolders(dragSourceId, targetId, lockedSpace);
          return;
        }
      }

      if (targetItem.type === 'folder' && dist < FOLDER_ENTER_RADIUS) {
        await _handleMoveIntoFolder(targetId, lockedSpace);
        return;
      }

      if (targetItem.type === 'bookmark' && sourceItem.type === 'bookmark' && !isMultiDrag) {
        if (dist < MERGE_RADIUS) {
          await _handleMergeBookmarks(dragSourceId, targetId, lockedSpace);
          return;
        }
      }

      let position = 'before';
      if (dragPlaceholder && dragPlaceholder.style.display === 'block') {
        const phIdx = Array.from(layer3.children).indexOf(dragPlaceholder);
        let nextCard = null;
        for (let i = phIdx + 1; i < layer3.children.length; i++) {
          if (layer3.children[i].classList.contains('card')) {
            nextCard = layer3.children[i];
            break;
          }
        }
        if (nextCard) {
          await _handleReorder(dragSourceIds, nextCard.dataset.id, 'before', lockedSpace);
        } else {
          const cards = getCardElements();
          const lastCard = cards[cards.length - 1];
          if (lastCard && !dragSourceIds.includes(lastCard.dataset.id)) {
            await _handleReorder(dragSourceIds, lastCard.dataset.id, 'after', lockedSpace);
          } else {
            forceCleanup();
          }
        }
        return;
      }

      const dropAfter = e.clientX > cx;
      await _handleReorder(dragSourceIds, targetId, dropAfter ? 'after' : 'before', lockedSpace);

    } catch (e) {
      err('onDrop error:', e);
      forceCleanup();
    } finally {
      _isDropping = false;
    }
  }

  // ============================================================
  //  Handlers
  // ============================================================
  async function _handleMoveIntoFolder(targetFolderId, space) {
    const result = await withDropLock(async () => {
      if (isMultiDrag) {
        return await CBF_UI_COORDINATOR.moveMultipleItems(
          dragSourceIds.slice(), targetFolderId, 'inside', null, space
        );
      } else {
        return await CBF_UI_COORDINATOR.moveSingleItem(
          dragSourceId, targetFolderId, 'inside', null, space
        );
      }
    });
    if (result && result.success) {
      if (typeof CBF_UI !== 'undefined' && CBF_UI.navigateToFolder) {
        CBF_UI.navigateToFolder(targetFolderId);
      }
    }
    forceCleanup();
  }

  // M-16 CALLER: _handleMergeFolders με auto-unlock
  async function _handleMergeFolders(sourceId, targetId, space) {
    const unlocked = await _ensureUnlockedForMerge(space, 'για συγχώνευση φακέλων');
    if (!unlocked) {
      log('M-16: mergeFolders cancelled (unlock not granted)');
      forceCleanup();
      return;
    }

    const result = await withDropLock(async () => {
      return await CBF_UI_COORDINATOR.mergeFolders(sourceId, targetId, space);
    });
    if (result && !result.success) warn('mergeFolders failed:', result.error);
    forceCleanup();
  }

  // M-16 CALLER: _handleMergeBookmarks με auto-unlock
  async function _handleMergeBookmarks(item1Id, item2Id, space) {
    const unlocked = await _ensureUnlockedForMerge(space, 'για συγχώνευση σελιδοδεικτών');
    if (!unlocked) {
      log('M-16: mergeBookmarks cancelled (unlock not granted)');
      forceCleanup();
      return;
    }

    const promptMsg = browser.i18n.getMessage('prompt_merge_folder') || 'Όνομα νέου φακέλου:';
    const folderName = await _getTextInput(promptMsg);
    if (!folderName || !folderName.trim()) {
      forceCleanup();
      return;
    }

    const parentId = _getCurrentFolderId();

    const result = await withDropLock(async () => {
      return await CBF_UI_COORDINATOR.mergeBookmarks(
        item1Id, item2Id, folderName.trim(), parentId, space
      );
    });

    if (result && !result.success && !result.id) {
      warn('mergeBookmarks failed:', result.error);
    }
    forceCleanup();
  }

  // ⭐ v1.5.2: REORDER (single + multi)
  //
  //  Multi-reorder (ίδιος φάκελος) → ΔΕΝ κάνει navigate.
  //  → Explicit clear selection μετά success.
  async function _handleReorder(ids, targetId, position, space) {
    if (!ids || ids.length === 0) { forceCleanup(); return; }
    if (ids.includes(targetId)) { forceCleanup(); return; }

    // Single reorder
    if (ids.length === 1) {
      const result = await withDropLock(async () => {
        return await CBF_UI_COORDINATOR.reorderItem(ids[0], targetId, position, space);
      });
      if (result && !result.success) warn('reorder failed:', result.error);
      forceCleanup();
      return;
    }

    // Multi-reorder (ίδιος φάκελος)
    const parentId = _getCurrentFolderId();
    const result = await withDropLock(async () => {
      return await CBF_UI_COORDINATOR.moveMultipleItems(
        ids.slice(), parentId, position, targetId, space
      );
    });

    if (result && !result.success) {
      warn('multi reorder failed:', result.error);
    } else if (result && result.success) {
      _clearSelectionAfterMultiReorder();
    }

    forceCleanup();
  }

  async function _handleBreadcrumbDrop(targetFolderId, space) {
    if (!targetFolderId) { forceCleanup(); return; }
    if (targetFolderId === _getCurrentFolderId()) { forceCleanup(); return; }

    const result = await withDropLock(async () => {
      if (isMultiDrag) {
        return await CBF_UI_COORDINATOR.moveMultipleItems(
          dragSourceIds.slice(), targetFolderId, 'inside', null, space
        );
      } else {
        return await CBF_UI_COORDINATOR.moveSingleItem(
          dragSourceId, targetFolderId, 'inside', null, space
        );
      }
    });

    if (result && result.success) {
      if (typeof CBF_UI !== 'undefined' && CBF_UI.navigateToFolder) {
        CBF_UI.navigateToFolder(targetFolderId);
      }
    }
    forceCleanup();
  }

  async function _getTextInput(title) {
    if (typeof CBF_MODAL_SERVICE !== 'undefined' &&
        typeof CBF_MODAL_SERVICE.promptForText === 'function') {
      return await CBF_MODAL_SERVICE.promptForText(title);
    }
    if (typeof window.CBF_Overlay_promptForText === 'function') {
      return await window.CBF_Overlay_promptForText(title);
    }
    return prompt(title);
  }

  // ============================================================
  //  Arrow events
  // ============================================================
  function onArrowDragOver(e) {
    if (!_isDragging) return;
    e.preventDefault();
    e.stopPropagation();
    const arrow = e.currentTarget;
    const direction = (arrow === arrowLeft) ? -1 : 1;
    arrow.classList.add('active');
    arrow.classList.remove('near');
    if (direction !== currentArrowDirection) {
      _stopArrowScroll();
      currentArrowDirection = direction;
      _startArrowScroll(direction);
    }
  }

  function onArrowDragLeave(e) {
    if (!_isDragging) return;
    e.preventDefault();
    e.stopPropagation();
    const arrow = e.currentTarget;
    arrow.classList.remove('active');
    _stopArrowScroll();
    currentArrowDirection = 0;
  }

  function onArrowDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    forceCleanup();
  }

  // ============================================================
  //  Breadcrumb handlers
  // ============================================================
  function onBreadcrumbDragEnter(e) {
    e.preventDefault();
    e.stopPropagation();
    breadcrumbDragEnterCount++;

    const path = (typeof CBF_UI !== 'undefined' && CBF_UI.getBreadcrumbPath)
      ? CBF_UI.getBreadcrumbPath() : [];
    const parentId = path.length > 1 ? path[path.length - 2].id : null;
    const currentId = _getCurrentFolderId();

    if (parentId && parentId !== currentId) {
      breadcrumb.classList.add('drag-active');
      breadcrumb.classList.remove('drag-no-drop');
    } else {
      breadcrumb.classList.add('drag-no-drop');
      breadcrumb.classList.remove('drag-active');
    }
    _stopArrowScroll();
    _hideArrows();
  }

  function onBreadcrumbDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    breadcrumbDragEnterCount = Math.max(0, breadcrumbDragEnterCount - 1);

    if (breadcrumbDragEnterCount === 0) {
      breadcrumb.classList.remove('drag-active', 'drag-no-drop');
      clearCrumbHover();
      if (_isDragging) _showArrows();
    }
  }

  function onBreadcrumbDragOver(e) {
    e.preventDefault();
    e.stopPropagation();

    const path = (typeof CBF_UI !== 'undefined' && CBF_UI.getBreadcrumbPath)
      ? CBF_UI.getBreadcrumbPath() : [];
    const parentId = path.length > 1 ? path[path.length - 2].id : null;
    const currentId = _getCurrentFolderId();

    if (parentId && parentId !== currentId) {
      e.dataTransfer.dropEffect = 'move';
      breadcrumb.classList.add('drag-active');
      breadcrumb.classList.remove('drag-no-drop');

      const crumb = e.target.closest ? e.target.closest('.crumb:not(.current)') : null;
      if (crumb && crumb.dataset.folderId === parentId) {
        if (currentHoveredCrumb && currentHoveredCrumb !== crumb) {
          currentHoveredCrumb.classList.remove('drag-hover');
        }
        crumb.classList.add('drag-hover');
        currentHoveredCrumb = crumb;
      }
    } else {
      e.dataTransfer.dropEffect = 'none';
      breadcrumb.classList.add('drag-no-drop');
      breadcrumb.classList.remove('drag-active');
      clearCrumbHover();
    }
  }

  async function onBreadcrumbDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    breadcrumb.classList.remove('drag-active', 'drag-no-drop');
    breadcrumbDragEnterCount = 0;
    clearCrumbHover();

    const lockedSpace = dragSpace || 'firefox';
    const crumb = e.target.closest ? e.target.closest('.crumb:not(.current)') : null;
    let targetFolderId = crumb ? crumb.dataset.folderId : null;

    if (!targetFolderId) {
      const path = CBF_UI.getBreadcrumbPath();
      if (path.length > 1) targetFolderId = path[path.length - 2].id;
    }

    if (!targetFolderId) { forceCleanup(); return; }
    await _handleBreadcrumbDrop(targetFolderId, lockedSpace);
  }

  function clearCrumbHover() {
    if (currentHoveredCrumb) {
      currentHoveredCrumb.classList.remove('drag-hover');
      currentHoveredCrumb = null;
    }
  }

  // ============================================================
  //  DRAGEND
  // ============================================================
  function onDragEnd() {
    log('dragend');
    forceCleanup();
  }

  function forceCleanup() {
    _isDragging = false;
    _isDropping = false;
    _stopArrowScroll();
    _hideArrows();
    hidePlaceholder();
    _clearDropTarget();

    if (breadcrumb) {
      breadcrumb.classList.remove('drag-active', 'drag-no-drop');
      clearCrumbHover();
    }
    breadcrumbDragEnterCount = 0;

    if (dragSourceCard) dragSourceCard.style.opacity = '1';
    document.querySelectorAll('.card').forEach(c => c.style.opacity = '1');

    dragSourceId = null;
    dragSourceIds = [];
    dragSourceCard = null;
    isMultiDrag = false;
    normalDragImage = null;
    dragSpace = null;

    if (typeof CBF_UI !== 'undefined' && typeof CBF_UI.updateArrowsForSelection === 'function') {
      CBF_UI.updateArrowsForSelection();
    }
  }

  // ============================================================
  //  destroy
  // ============================================================
  function destroy() {
    log('destroy');
    _stopArrowScroll();

    if (draggableObserver) {
      draggableObserver.disconnect();
      draggableObserver = null;
    }
    if (draggableIntervalId) {
      clearInterval(draggableIntervalId);
      draggableIntervalId = null;
    }

    if (arrowLeft && arrowLeft.parentNode) arrowLeft.parentNode.removeChild(arrowLeft);
    if (arrowRight && arrowRight.parentNode) arrowRight.parentNode.removeChild(arrowRight);
    arrowLeft = null;
    arrowRight = null;

    if (ro) { ro.disconnect(); ro = null; }
    window.removeEventListener('resize', _positionArrows);

    forceCleanup();
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    init,
    destroy,
    isDragging: () => _isDragging,
    forceCleanup,
    getDragSpace: () => dragSpace,
    isMultiDrag: () => isMultiDrag,
    getDragSourceIds: () => dragSourceIds.slice(),

    _internal: {
      getCardElements,
      showPlaceholder,
      hidePlaceholder,
      _disableChildDraggable,
      _resolveSelectedIds,
      _ensureUnlockedForMerge,
      _clearSelectionAfterMultiReorder,
      _drawCardOnCanvas,
      _createArrows,
      _showArrows,
      _hideArrows,
      forceCleanup,

      // v12.2.1 diagnostics
      getNativeArrowState: () => ({
        left: nativeArrowLeft ? nativeArrowLeft.style.display : 'missing',
        right: nativeArrowRight ? nativeArrowRight.style.display : 'missing'
      }),
      getDragArrowState: () => ({
        left: arrowLeft ? arrowLeft.style.display : 'missing',
        right: arrowRight ? arrowRight.style.display : 'missing'
      })
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_DRAGDROP = api;
  if (typeof self !== 'undefined') self.CBF_DRAGDROP = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_DRAGDROP = api;

  log('Ready (v12.2.1: native arrows preserved + multi-drag badge + M-7 caller + M-16 caller + multi-reorder explicit clear)');
  return api;
})();