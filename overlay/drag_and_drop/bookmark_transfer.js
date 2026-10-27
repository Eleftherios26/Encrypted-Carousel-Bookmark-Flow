/**
 * bookmark_transfer.js — Cross-space transfer leaf
 *
 * @path     overlay/drag_and_drop/bookmark_transfer.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   Leaf module που τυλίγει τα CBF_BRIDGE.crossMoveToEncrypted /
 *   crossMoveToFirefox με validation + αποτελέσματα normalized.
 *   Χρησιμοποιείται από τον ui-coordinator.
 *
 * BEHAVIOR
 *   • Validation: itemId required
 *   • Pre-check: αν target είναι encrypted → απαιτείται
 *     initialized + unlocked vault
 *   • Errors normalized σε { success: false, error, code? }
 *
 * DECISIONS
 *   D-36, D-45
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "bookmark_transfer"
 */

var CBF_BOOKMARK_TRANSFER = (function() {
  'use strict';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { console.log('[ECBF:Transfer]', ...a); }
  function warn(...a) { console.warn('[ECBF:Transfer]', ...a); }

  // ============================================================
  //  Validation (pure)
  // ============================================================
  function canTransferItem(item) {
    if (!item) return false;
    return item.type === 'bookmark' || item.type === 'folder';
  }

  function canTransferToEncrypted(currentSpace) { return currentSpace === 'firefox'; }
  function canTransferToFirefox(currentSpace) { return currentSpace === 'encrypted'; }

  // ============================================================
  //  Pre-check: target space eligibility
  // ============================================================
  async function checkEncryptedStatusForTransfer(status, targetIsEncrypted) {
    if (targetIsEncrypted) {
      if (!status.initialized) return { ok: false, error: 'NOT_INITIALIZED' };
      if (!status.unlocked)    return { ok: false, error: 'LOCKED' };
    }
    return { ok: true };
  }

  // ============================================================
  //  transferToEncrypted — Firefox → Encrypted
  // ============================================================
  async function transferToEncrypted(itemId, isFolder) {
    if (!itemId) return { success: false, error: 'Missing item id' };
    log(`transferToEncrypted: ${itemId} (folder=${isFolder})`);
    try {
      const res = await CBF_BRIDGE.crossMoveToEncrypted(itemId, !!isFolder);
      if (res && res.success) {
        return {
          success: true,
          id: res.result?.id,
          type: res.result?.type || (isFolder ? 'folder' : 'bookmark')
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('transferToEncrypted error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  transferToFirefox — Encrypted → Firefox
  // ============================================================
  async function transferToFirefox(itemId, isFolder) {
    if (!itemId) return { success: false, error: 'Missing item id' };
    log(`transferToFirefox: ${itemId} (folder=${isFolder})`);
    try {
      const res = await CBF_BRIDGE.crossMoveToFirefox(itemId, !!isFolder);
      if (res && res.success) {
        return {
          success: true,
          id: res.result?.id,
          type: res.result?.type || (isFolder ? 'folder' : 'bookmark')
        };
      }
      return { success: false, error: res?.error || 'UNKNOWN' };
    } catch (e) {
      warn('transferToFirefox error:', e.message);
      return { success: false, error: e.message, code: e.code };
    }
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    canTransferItem,
    canTransferToEncrypted,
    canTransferToFirefox,
    checkEncryptedStatusForTransfer,
    transferToEncrypted,
    transferToFirefox
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof window !== 'undefined') window.CBF_BOOKMARK_TRANSFER = api;
  if (typeof self !== 'undefined') self.CBF_BOOKMARK_TRANSFER = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_BOOKMARK_TRANSFER = api;

  log('Ready (v12E: cross-space leaf)');
  return api;
})();