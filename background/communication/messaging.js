/**
 * messaging.js — Overlay ↔ Background message router (36 handlers)
 *
 * @path     background/communication/messaging.js
 * @version  12.3.0
 * @since    v12E / v12.3E
 *
 * PURPOSE
 *   Κεντρικός router μηνυμάτων Overlay ↔ Background με HMAC-signed
 *   port protocol. Διαχειρίζεται capability enforcement, rate
 *   limiting, και dispatch στα 36 handlers (read, encrypted
 *   mutations, Firefox D&D, cross-space, lifecycle, V12E export/import,
 *   options page).
 *
 * PORT PROTOCOL
 *   • Όλα τα μηνύματα HMAC-sign-άρονται με sessionToken (D-22)
 *   • requestSeq monotonic (replay protection)
 *   • sessionEpoch validation (rotation)
 *   • Centralized capability enforcement (fail-closed — V12E.E-SEC-01)
 *
 * HANDLERS (36)
 *   Read (8):       getStatus, getActiveSpace, setActiveSpace, queryTree,
 *                   getPath, open, getFavicon, searchBookmarks
 *   Open (2):       openInCurrentTab, openInNewTab (D-52)
 *   Encrypted (7):  create, rename, delete, move, reorder, merge, mergeFolders
 *   Firefox (7):    firefoxMove, firefoxReorder, firefoxMerge,
 *                   firefoxMergeFolders, firefoxRemove, firefoxCreate,
 *                   firefoxRename (D-53)
 *   Cross (4):      moveToEncrypted, moveToFirefox,
 *                   moveFolderToEncrypted, moveFolderToFirefox
 *   Export (4):     exportBookmarks, exportFavicons,
 *                   exportEncryptedBackup, exportEncryptedPlain (D-51)
 *   Import (2):     importEncrypted (D-56), importFavicons (D-51)
 *   Lifecycle (1):  lock
 *   Options (1):    openOptionsPage  ← v12.1 (V12E.E-05a native handler)
 *
 * DECISIONS
 *   D-22, D-25, D-28, D-29, D-30, D-34,
 *   D-51, D-52, D-53, D-56
 *
 * CHANGELOG
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.3.0 (2026-09-28) — IMPORT FAVICONS INVALIDATION FIX
 *   ══════════════════════════════════════════════════════════════════════
 *   BUG-FIX (HIGH): handleImportFavicons δεν ενημέρωνε το negative
 *   cache του favicon-service ούτε έκανε broadcast στα overlays.
 *
 *     ΠΡΟΒΛΗΜΑ (consistency με background.js::importFaviconsSimple):
 *       Ο handler έγραφε storage.local απευθείας, αλλά:
 *         ❌ ΔΕΝ invalidated το favicon-service._negativeCache
 *         ❌ ΔΕΝ έκανε broadcast faviconUpdate στα ανοιχτά overlays
 *
 *       Συνέπεια: Ένα overlay που ζήτησε getFavicon πριν το import
 *       έπαιρνε negative cache hit (5min TTL) αντί για το νέο favicon.
 *
 *       Επιβεβαίωση από logs:
 *         14:46:02  getFavicon(x.com) → No favicon → negative-cached
 *         14:46:14  Import 86 favicons
 *         14:46:19  getFavicon(x.com) → NEGATIVE CACHE HIT → null ❌
 *
 *     ΛΥΣΗ:
 *       Ίδιο pattern με background.js::importFaviconsSimple (v12.3.1):
 *         1. CBF_FAVICON.invalidateNegativeCache() — server-side
 *         2. CBF_FAVICON._internal._broadcastFavicon() για κάθε entry
 *            με excludePort = port (ο caller ενημερώνεται από το
 *            importResult response)
 *
 *     Impact:
 *       Consistency μεταξύ των 2 import paths (options page +
 *       overlay port protocol). Imported favicons εμφανίζονται
 *       αμέσως στο overlay.
 *
 *   VERSION ALIGNMENT:
 *     • @version 12.2.0 → 12.3.0
 *     • @since v12E / v12.2 → v12E / v12.3E
 *     • Init log string: v12.3E
 *   ══════════════════════════════════════════════════════════════════════
 *   v12.2.0 (2026-09-26) — LOW-END HARDWARE OPTIMIZATION
 *   ══════════════════════════════════════════════════════════════════════
 *   CPU-10: _broadcastMutationToOthers — SERIALIZED αντί Promise.all
 *     Rationale: Το HMAC sign είναι CPU-bound. Σε 3+ parallel signs,
 *     το low-end CPU κάνει spike (~50-150ms blocking). Serial loop
 *     = ομαλή ροή, χωρίς αντιληπτός κόπος σε 1-2 tabs.
 *
 *   v12.1.0 (2026-09-22):
 *     • BUG-1 FIX: `unfilled_____` → `unfiled_____` στο FIREFOX_ROOT_IDS
 *     • ISSUE-1 FIX: Προσθήκη native `openOptionsPage` handler (36 handlers)
 *   ══════════════════════════════════════════════════════════════════════
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "messaging"
 */

var CBF_MESSAGING = (function() {
  'use strict';

  // ============================================================
  //  Constants
  // ============================================================
  const MAX_MESSAGE_SIZE = 50 * 1024;
  const DEFAULT_PAGE_SIZE = 100;
  const PORT_NAME = 'ecbf';
  const MAX_URL_LENGTH = 2048;
  const MAX_TITLE_LENGTH = 500;
  const MAX_SEARCH_QUERY_LENGTH = 100;

  // V12E (D-51): Import size limits (DoS protection)
  const MAX_IMPORT_SIZE_BYTES = 5 * 1024 * 1024;   // 5 MB
  const MAX_FAVICON_IMPORT_SIZE = 3 * 1024 * 1024; // 3 MB

  const UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // ============================================================
  //  ASCII-safe phonetic char map (Unicode escapes)
  // ============================================================
  const CHAR_TO_LATIN = Object.freeze({
    // ---------- Greek lowercase (03B1-03CE) ----------
    '\u03B1': 'a',  // α
    '\u03AC': 'a',  // ά
    '\u03B2': 'b',  // β
    '\u03B3': 'g',  // γ
    '\u03B4': 'd',  // δ
    '\u03B5': 'e',  // ε
    '\u03AD': 'e',  // έ
    '\u03B6': 'z',  // ζ
    '\u03B7': 'h',  // η
    '\u03AE': 'h',  // ή
    '\u03B8': 'th', // θ
    '\u03B9': 'i',  // ι
    '\u03AF': 'i',  // ί
    '\u03CA': 'i',  // ϊ
    '\u03BA': 'k',  // κ
    '\u03BB': 'l',  // λ
    '\u03BC': 'm',  // μ
    '\u03BD': 'n',  // ν
    '\u03BE': 'x',  // ξ
    '\u03BF': 'o',  // ο
    '\u03CC': 'o',  // ό
    '\u03C0': 'p',  // π
    '\u03C1': 'r',  // ρ
    '\u03C3': 's',  // σ
    '\u03C2': 's',  // ς
    '\u03C4': 't',  // τ
    '\u03C5': 'u',  // υ
    '\u03CD': 'u',  // ύ
    '\u03C6': 'f',  // φ
    '\u03C7': 'x',  // χ
    '\u03C8': 'ps', // ψ
    '\u03C9': 'w',  // ω
    '\u03CE': 'w',  // ώ

    // ---------- Cyrillic lowercase (0430-044F + 0451) ----------
    '\u0430': 'a',    // а
    '\u0431': 'b',    // б
    '\u0432': 'v',    // в
    '\u0433': 'g',    // г
    '\u0434': 'd',    // д
    '\u0435': 'e',    // е
    '\u0451': 'yo',   // ё
    '\u0436': 'zh',   // ж
    '\u0437': 'z',    // з
    '\u0438': 'i',    // и
    '\u0439': 'y',    // й
    '\u043A': 'k',    // к
    '\u043B': 'l',    // л
    '\u043C': 'm',    // м
    '\u043D': 'n',    // н
    '\u043E': 'o',    // о
    '\u043F': 'p',    // п
    '\u0440': 'r',    // р
    '\u0441': 's',    // с
    '\u0442': 't',    // т
    '\u0443': 'u',    // у
    '\u0444': 'f',    // ф
    '\u0445': 'h',    // х
    '\u0446': 'ts',   // ц
    '\u0447': 'ch',   // ч
    '\u0448': 'sh',   // ш
    '\u0449': 'shch', // щ
    '\u044A': '',     // ъ
    '\u044B': 'y',    // ы
    '\u044C': '',     // ь
    '\u044D': 'e',    // э
    '\u044E': 'yu',   // ю
    '\u044F': 'ya',   // я

    // ---------- Accented Latin ----------
    '\u00E0': 'a',  // à
    '\u00E2': 'a',  // â
    '\u00E4': 'a',  // ä
    '\u00E8': 'e',  // è
    '\u00E9': 'e',  // é
    '\u00EA': 'e',  // ê
    '\u00EB': 'e',  // ë
    '\u00EC': 'i',  // ì
    '\u00EE': 'i',  // î
    '\u00EF': 'i',  // ï
    '\u00F2': 'o',  // ò
    '\u00F4': 'o',  // ô
    '\u00F6': 'o',  // ö
    '\u00F9': 'u',  // ù
    '\u00FB': 'u',  // û
    '\u00FC': 'u',  // ü
    '\u00FF': 'y',  // ÿ
    '\u00E7': 'c',  // ç
    '\u0153': 'oe', // œ
    '\u00E6': 'ae'  // æ
  });

  function _phoneticKey(str) {
    if (typeof str !== 'string') return '';
    const lower = str.toLowerCase();
    let out = '';
    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];
      const mapped = CHAR_TO_LATIN[ch];
      out += (mapped !== undefined) ? mapped : ch;
    }
    return out;
  }

  // Hostname extraction για URL prefix matching
  function _extractHostname(url) {
    if (typeof url !== 'string' || url.length === 0) return '';
    try {
      const u = new URL(url);
      return (u.hostname || '').toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return '';
    }
  }

  // ============================================================
  //  Firefox root IDs
  //
  //  v12.1 BUG-1 FIX: 'unfilled_____' → 'unfiled_____'
  //  Firefox Places GUID για "Other Bookmarks" = 'unfiled_____'
  //  (7 γράμματα + 5 underscores = 12 chars, ίδιο μήκος με τα υπόλοιπα)
  // ============================================================
  const FIREFOX_ROOT_IDS = [
    'toolbar_____', 'menu________', 'unfiled_____',
    'mobile______', 'root________'
  ];

  const portSpaces = new Map();

  function _getSpace(port) { return portSpaces.get(port) || 'firefox'; }
  function _setSpace(port, space) { portSpaces.set(port, space); }
  function _clearSpace(port) { portSpaces.delete(port); }

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a) { CBF_LOGGER.info('[MSG]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[MSG]', ...a); }
  function err(...a) { CBF_LOGGER.error('[MSG]', ...a); }
  function audit(...a) { CBF_LOGGER.security('[MSG]', ...a); }

  function _short(sid) {
    return typeof sid === 'string' ? sid.slice(0, 8) : 'unknown';
  }

  // ============================================================
  //  sendTo — HMAC-signed message (L-03: returns boolean)
  // ============================================================
  async function sendTo(port, sessionId, type, payload) {
    const token = CBF_SESSION.getSessionToken(sessionId);
    if (!token) {
      warn(`sendTo: no session token for ${_short(sessionId)} — ABORT`);
      return false;
    }

    const message = { type, ...payload };
    const keyBytes = CBF_CRYPTO.b64ToBuf(token);

    try {
      const canonical = CBF_CRYPTO.canonicalJSON(message);
      const sig = await CBF_CRYPTO.hmacSign(keyBytes, canonical);
      const hmac = CBF_CRYPTO.bufToB64(sig);
      CBF_CRYPTO.zeroBuffer(sig);

      try {
        port.postMessage({ ...message, hmac });
        return true;
      } catch (e) {
        warn(`sendTo ${type}: postMessage failed:`, e.message);
        return false;
      }
    } catch (e) {
      warn(`sendTo ${type}: HMAC sign failed:`, e.message);
      return false;
    } finally {
      CBF_CRYPTO.zeroBuffer(keyBytes);
    }
  }

  async function sendError(port, sessionId, commandId, code, message) {
    return await sendTo(port, sessionId, 'commandError', {
      commandId: commandId || null,
      code: code || 'UNKNOWN_ERROR',
      message: message || 'Unknown error'
    });
  }

  // ============================================================
  //  Validation
  // ============================================================
  function isTrustedSender(sender) {
    if (!sender) return false;
    return sender.id === browser.runtime.id;
  }

  function requireString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${name} must be a non-empty string`);
    }
    return value;
  }

  function requireUUID(value, name) {
    const s = requireString(value, name);
    if (!UUID_V4_REGEX.test(s)) throw new Error(`${name} must be a UUID v4`);
    return s;
  }

  function requireGeneration(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('expectedGeneration must be a non-negative integer');
    }
    return value;
  }

  function validateUrl(value) {
    const s = requireString(value, 'url');
    if (s.length > MAX_URL_LENGTH) throw new Error('url too long');
    if (!/^https?:\/\//i.test(s)) throw new Error('url must be http(s)');
    return s;
  }

  function validateTitle(value) {
    const s = requireString(value, 'title');
    if (s.length > MAX_TITLE_LENGTH) throw new Error('title too long');
    return s;
  }

  function checkCapability(sessionId, requiredCap) {
    if (!CBF_SESSION.hasCapability(sessionId, requiredCap)) {
      throw new Error(`Missing capability: ${requiredCap}`);
    }
  }

  function _checkFirefoxCap(sessionId) {
    if (!CBF_SESSION.hasCapability(sessionId, CBF_SESSION.CAP_FIREFOX)) {
      throw new Error('Missing capability: firefox.write');
    }
  }

  // ============================================================
  //  _enforceCapCentralized — M-01 centralized enforcement
  //
  //  V12E.E-SEC-01: fail-closed — unknown cap tag throws.
  //  Αποτρέπει silent allow σε programming errors (typo στο cap).
  // ============================================================
  function _enforceCapCentralized(sessionId, port, capTag) {
    if (capTag === null || capTag === undefined) return;

    const space = _getSpace(port);

    switch (capTag) {
      case 'read':
        if (space === 'encrypted') {
          checkCapability(sessionId, CBF_SESSION.CAP_READ);
        }
        return;

      case 'write':
        checkCapability(sessionId, CBF_SESSION.CAP_WRITE);
        return;

      case 'firefox':
        _checkFirefoxCap(sessionId);
        return;

      default:
        // V12E.E-SEC-01: fail-closed
        err(
          `_enforceCapCentralized: INVALID cap tag "${capTag}" for ${_short(sessionId)} — DENYING`
        );
        throw new Error(`INVALID_CAPABILITY_TAG: ${capTag}`);
    }
  }

  // ============================================================
  //  V12E (D-51): Payload size estimator + download helper
  // ============================================================
  function _estimatePayloadSize(obj) {
    try {
      return JSON.stringify(obj).length;
    } catch (_) {
      return -1;
    }
  }

  async function _downloadJSON(jsonStr, filename) {
    let objectUrl = null;
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      objectUrl = URL.createObjectURL(blob);

      await browser.downloads.download({
        url: objectUrl,
        filename,
        saveAs: true
      });

      setTimeout(() => {
        if (objectUrl) {
          try { URL.revokeObjectURL(objectUrl); } catch (_) {}
        }
      }, 60000);
    } catch (e) {
      if (objectUrl) {
        try { URL.revokeObjectURL(objectUrl); } catch (_) {}
      }
      throw e;
    }
  }

  // ============================================================
  //  Broadcast sanitization (D-29 URL minimization)
  // ============================================================
  function _sanitizeBroadcastNode(node) {
    if (!node || typeof node !== 'object') return node;
    const strictPrivacy =
      (typeof CBF_PROJECTION !== 'undefined' &&
       typeof CBF_PROJECTION.getStrictPrivacy === 'function')
        ? CBF_PROJECTION.getStrictPrivacy() === true
        : false;

    const out = {
      id: node.id, type: node.type,
      parentId: node.parentId, positionKey: node.positionKey
    };
    if (!strictPrivacy && typeof node.title === 'string') {
      out.title = node.title;
    }
    if (typeof node.url === 'string') {
      out.url = node.url;
    }
    return out;
  }

  function _sanitizeBroadcastMutation(mutation) {
    if (!mutation || typeof mutation !== 'object') return mutation;
    const out = { type: mutation.type };
    switch (mutation.type) {
      case 'created':
      case 'updated':
        if (mutation.node) out.node = _sanitizeBroadcastNode(mutation.node);
        break;
      case 'moved': {
        const moves = Array.isArray(mutation.moves) ? mutation.moves : [];
        out.moves = moves.map(m => ({
          id: m.id, parentId: m.parentId,
          positionKey: m.positionKey, index: m.index
        }));
        break;
      }
      case 'deleted':
        if (Array.isArray(mutation.deletedIds)) {
          out.deletedIds = mutation.deletedIds.slice();
        }
        if (mutation.node && mutation.node.id) {
          out.node = { id: mutation.node.id };
        }
        break;
      case 'cross-moved':
        out.from = mutation.from;
        out.to = mutation.to;
        if (mutation.removedId) out.removedId = mutation.removedId;
        if (mutation.createdId) out.createdId = mutation.createdId;
        if (mutation.isFolder) out.isFolder = true;
        break;
      default:
        return mutation;
    }
    return out;
  }

  // ============================================================
  //  Firefox read helpers
  // ============================================================
  function firefoxNodeToItem(node, index) {
    return {
      id: node.id, parentId: node.parentId,
      positionKey: String(index || 0).padStart(6, '0'),
      type: node.type === 'folder' ? 'folder' : 'bookmark',
      title: node.title || '', url: node.url || null
    };
  }

  async function firefoxGetChildren(parentId) {
    if (!parentId) parentId = 'toolbar_____';
    try {
      const children = await browser.bookmarks.getChildren(parentId);
      return children.map((c, i) => firefoxNodeToItem(c, i));
    } catch (e) {
      warn('firefoxGetChildren failed:', e.message);
      return [];
    }
  }

  async function firefoxGetPath(id) {
    const path = [];
    let current = id;
    let safety = 20;
    while (current && safety-- > 0) {
      try {
        const nodes = await browser.bookmarks.get(current);
        if (!nodes || nodes.length === 0) break;
        const node = nodes[0];
        path.unshift({ id: node.id, title: node.title || node.id });
        if (FIREFOX_ROOT_IDS.includes(node.parentId)) {
          try {
            const roots = await browser.bookmarks.get(node.parentId);
            if (roots.length > 0) {
              path.unshift({
                id: roots[0].id,
                title: roots[0].title || roots[0].id
              });
            }
          } catch (_) {}
          break;
        }
        current = node.parentId;
      } catch (e) { break; }
    }
    return path;
  }

  // ============================================================
  //  READ HANDLERS (8)
  // ============================================================
  async function handleGetStatus(port, sessionId, msg) {
    const status = await CBF_ES.getStatus();
    await sendTo(port, sessionId, 'statusResult', {
      commandId: msg.commandId || null,
      initialized: status.initialized,
      unlocked: status.unlocked,
      corruptedCount: status.corruptedCount || 0,
      fsmState: CBF_VAULT_FSM.getState(),
      generation: CBF_PROJECTION.getGeneration(),
      activeSpace: _getSpace(port)
    });
  }

  async function handleGetActiveSpace(port, sessionId, msg) {
    await sendTo(port, sessionId, 'activeSpaceResult', {
      commandId: msg.commandId || null,
      activeSpace: _getSpace(port)
    });
  }

  async function handleSetActiveSpace(port, sessionId, msg) {
    const space = msg.payload?.space;
    if (space === 'firefox') {
      _setSpace(port, 'firefox');
    } else if (space === 'encrypted') {
      const status = await CBF_ES.getStatus();
      if (!status.initialized) {
        await sendTo(port, sessionId, 'setActiveSpaceResult', {
          commandId: msg.commandId || null,
          success: false, error: 'NOT_INITIALIZED'
        });
        return;
      }
      if (!status.unlocked) {
        await sendTo(port, sessionId, 'setActiveSpaceResult', {
          commandId: msg.commandId || null,
          success: false, error: 'LOCKED'
        });
        return;
      }
      _setSpace(port, 'encrypted');
    } else {
      await sendTo(port, sessionId, 'setActiveSpaceResult', {
        commandId: msg.commandId || null,
        success: false, error: 'INVALID_SPACE'
      });
      return;
    }
    await sendTo(port, sessionId, 'setActiveSpaceResult', {
      commandId: msg.commandId || null,
      success: true, activeSpace: _getSpace(port)
    });
  }

  async function handleQueryTree(port, sessionId, msg) {
    const space = _getSpace(port);

    let parentId = msg.payload?.parentId;
    if (space === 'firefox') {
      if (!parentId) parentId = 'toolbar_____';
      const items = await firefoxGetChildren(parentId);
      await sendTo(port, sessionId, 'treeResult', {
        commandId: msg.commandId || null,
        parentId,
        generation: 0,
        items,
        hasMore: false,
        space
      });
    } else {
      if (!parentId) parentId = CBF_ES.ROOT_ID;
      const limit = Math.min(
        typeof msg.payload?.limit === 'number'
          ? msg.payload.limit : DEFAULT_PAGE_SIZE,
        DEFAULT_PAGE_SIZE
      );
      const cursor = msg.payload?.cursor || null;
      const result = CBF_PROJECTION.getSanitizedTree(parentId, limit, cursor);
      await sendTo(port, sessionId, 'treeResult', {
        commandId: msg.commandId || null,
        parentId,
        generation: result.generation,
        items: result.items,
        hasMore: result.hasMore,
        space
      });
    }
  }

  async function handleGetPath(port, sessionId, msg) {
    const space = _getSpace(port);
    const id = requireString(msg.payload?.id, 'id');
    let path = [];
    if (space === 'firefox') {
      path = await firefoxGetPath(id);
    } else {
      const itemsMap = CBF_PROJECTION.getItemsMap();
      path = CBF_TREE.getPath(itemsMap, id, CBF_ES.ROOT_ID);
    }
    await sendTo(port, sessionId, 'pathResult', {
      commandId: msg.commandId || null,
      path,
      space
    });
  }

  async function handleOpen(port, sessionId, msg) {
    const space = _getSpace(port);
    const commandId = msg.commandId || null;

    try {
      const id = requireString(msg.payload?.id, 'id');
      let url = null;
      if (space === 'firefox') {
        const nodes = await browser.bookmarks.get(id);
        if (!nodes || nodes.length === 0) {
          await sendTo(port, sessionId, 'openResult', {
            commandId, success: false, error: 'NOT_FOUND'
          });
          return;
        }
        url = nodes[0].url;
      } else {
        const item = CBF_PROJECTION.getItem(id);
        url = item ? item.url : null;
      }

      if (!url) {
        await sendTo(port, sessionId, 'openResult', {
          commandId, success: false, error: 'NO_URL'
        });
        return;
      }

      const { tabId } = await CBF_OPEN_HANDLER.open(url);
      await sendTo(port, sessionId, 'openResult', {
        commandId, success: true, tabId
      });
    } catch (e) {
      err('open failed:', e.message);
      let code = 'OPEN_FAILED';
      if (/INVALID_URL_PROTOCOL/i.test(e.message)) code = 'INVALID_URL_PROTOCOL';
      else if (/URL_TOO_LONG/i.test(e.message)) code = 'URL_TOO_LONG';
      else if (/INVALID_URL/i.test(e.message)) code = 'INVALID_URL';

      await sendTo(port, sessionId, 'openResult', {
        commandId, success: false, error: code
      });
    }
  }

  async function handleGetFavicon(port, sessionId, msg) {
    const commandId = msg.commandId || null;

    let url;
    try {
      url = validateUrl(msg.payload?.url);
    } catch (e) {
      let code = 'INVALID_URL';
      if (/too long/i.test(e.message)) code = 'URL_TOO_LONG';
      else if (/http\(s\)/i.test(e.message)) code = 'INVALID_URL_PROTOCOL';
      await sendTo(port, sessionId, 'faviconResult', {
        commandId, url: null, dataUrl: null, error: code
      });
      return;
    }

    try {
      const dataUrl = await CBF_FAVICON.getFavicon(url);
      await sendTo(port, sessionId, 'faviconResult', {
        commandId, url, dataUrl: dataUrl || null,
        error: dataUrl ? null : 'FAVICON_UNAVAILABLE'
      });
    } catch (e) {
      warn('getFavicon failed:', e.message);
      await sendTo(port, sessionId, 'faviconResult', {
        commandId, url, dataUrl: null, error: 'FAVICON_ERROR'
      });
    }
  }

  // ============================================================
  //  SEARCH — Global, PREFIX-ONLY + phonetic fallback
  //
  //  Titles: .startsWith(query) αντί .includes()
  //  URLs:   extract hostname → .startsWith(query)
  //  Phonetic fallback: same semantics (startsWith)
  // ============================================================
  async function handleSearchBookmarks(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const rawQuery = (msg.payload?.query || '');
    const query = String(rawQuery).toLowerCase().trim().slice(0, MAX_SEARCH_QUERY_LENGTH);

    if (!query) {
      await sendTo(port, sessionId, 'searchResults', {
        commandId,
        query: '',
        items: [],
        space: _getSpace(port)
      });
      return;
    }

    const phoneticQuery = _phoneticKey(query);

    const space = _getSpace(port);
    const items = [];

    try {
      if (space === 'firefox') {
        const tree = await browser.bookmarks.getTree();

        const collect = (nodes) => {
          for (const node of nodes) {
            if (!node || !node.id) continue;

            const titleLower = (node.title || '').toLowerCase();
            const hostname = _extractHostname(node.url);

            const isRootContainer = (node.id === 'root________');

            const rawMatch =
              titleLower.startsWith(query) ||
              (hostname && hostname.startsWith(query));

            const phoneticMatch = !rawMatch && phoneticQuery && (
              _phoneticKey(titleLower).startsWith(phoneticQuery) ||
              (hostname && _phoneticKey(hostname).startsWith(phoneticQuery))
            );

            const matches = rawMatch || phoneticMatch;

            if (matches && !isRootContainer) {
              items.push({
                id: node.id,
                parentId: node.parentId || null,
                positionKey: String(node.index || 0).padStart(6, '0'),
                type: node.type === 'folder' ? 'folder' : 'bookmark',
                title: node.title || '',
                url: node.url || null
              });
            }

            if (node.children && node.children.length > 0) {
              collect(node.children);
            }
          }
        };

        collect(tree);

      } else {
        const map = CBF_PROJECTION.getItemsMap();

        for (const node of map.values()) {
          if (!node || !node.id) continue;

          const titleLower = (node.title || '').toLowerCase();
          const hostname = _extractHostname(node.url);

          const rawMatch =
            titleLower.startsWith(query) ||
            (hostname && hostname.startsWith(query));

          const phoneticMatch = !rawMatch && phoneticQuery && (
            _phoneticKey(titleLower).startsWith(phoneticQuery) ||
            (hostname && _phoneticKey(hostname).startsWith(phoneticQuery))
          );

          if (rawMatch || phoneticMatch) {
            items.push({
              id: node.id,
              parentId: node.parentId,
              positionKey: node.positionKey,
              type: node.type,
              title: node.title || '',
              url: node.url || null
            });
          }
        }
      }

      items.sort((a, b) => {
        const ta = (a.title || '').toLowerCase();
        const tb = (b.title || '').toLowerCase();
        return ta < tb ? -1 : (ta > tb ? 1 : 0);
      });

      log(
        `searchBookmarks (PREFIX): ${items.length} results for "${query}" ` +
        `(phonetic="${phoneticQuery}", space=${space})`
      );

      await sendTo(port, sessionId, 'searchResults', {
        commandId,
        query,
        items,
        space
      });
    } catch (e) {
      err('searchBookmarks failed:', e.message);
      await sendError(port, sessionId, commandId, 'SEARCH_FAILED', e.message);
    }
  }

  // ============================================================
  //  Helpers — storeKey + space guards
  // ============================================================
  function _getStoreKeyOrThrow() {
    const sk = CBF_ES._internal.getStoreKey();
    if (!sk) throw new Error('Vault is locked');
    return sk;
  }

  function _requireEncryptedSpace(port) {
    if (_getSpace(port) !== 'encrypted') {
      throw new Error('Mutations only in encrypted space');
    }
  }

  function _requireFirefoxSpace(port) {
    if (_getSpace(port) !== 'firefox') {
      throw new Error('Firefox mutations only in firefox space');
    }
  }

  // ============================================================
  //  Broadcast mutation to other ports
  //
  //  🔧 v12.2 CPU-10: SERIALIZED αντί Promise.all
  //
  //  Rationale:
  //    Το HMAC sign (crypto.subtle.sign) είναι CPU-bound.
  //    Σε 3+ parallel signs, ο low-end CPU (2 cores / 2GB RAM)
  //    κάνει spike 50-150ms → UI stutter.
  //
  //  Serial loop:
  //    • Ίδιος συνολικός χρόνος για 1-2 ports (ήδη καταναλώσιμη)
  //    • Ομαλή κατανομή CPU για N>2 ports
  //    • Διατηρεί ΤΗΝ ΙΔΙΑ ΑΚΡΙΒΩΣ σειρά broadcast (deterministic)
  //    • Backward compatible: ίδιο return { sent, failed }
  // ============================================================
  async function _broadcastMutationToOthers(excludePort, event) {
    const ports = CBF_SESSION.getAllPorts();
    const tasks = [];

    for (const p of ports) {
      if (p === excludePort) continue;
      const state = CBF_SESSION.getPortState(p);
      if (!state) continue;
      const sessionId = state.sessionId;
      if (!sessionId) continue;
      tasks.push({ port: p, sessionId });
    }

    if (tasks.length === 0) {
      return { sent: 0, failed: 0 };
    }

    log(`Broadcast mutationEvent to ${tasks.length} port(s): ${event.mutation?.type || 'unknown'}`);

    // 🔧 v12.2 CPU-10: Serial execution (HMAC sign is CPU-bound)
    let sent = 0, failed = 0;
    for (const t of tasks) {
      try {
        const ok = await sendTo(t.port, t.sessionId, 'mutationEvent', event);
        if (ok) {
          sent++;
        } else {
          failed++;
          warn(`Broadcast to ${_short(t.sessionId)} failed`);
        }
      } catch (e) {
        failed++;
        warn(`Broadcast to ${_short(t.sessionId)} threw:`, e.message);
      }
    }

    return { sent, failed };
  }

  // ============================================================
  //  Dispatch mutation outcome (shared by encrypted handlers)
  // ============================================================
  async function _dispatchMutationOutcome(
    port, sessionId, commandId, outcome, onSuccess, broadcast, expectedGen
  ) {
    switch (outcome.status) {
      case 'OK':
        if (typeof onSuccess === 'function') onSuccess(outcome);
        CBF_PROJECTION.setGeneration(outcome.generation);

        if (broadcast) {
          const sanitized = _sanitizeBroadcastMutation(broadcast);
          await _broadcastMutationToOthers(port, {
            commandId,
            generation: outcome.generation,
            mutation: sanitized
          });
        }

        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: true,
          generation: outcome.generation,
          result: outcome.result
        });
        return;

      case 'ALREADY_APPLIED':
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: true,
          alreadyApplied: true,
          generation: outcome.generation
        });
        return;

      case 'STALE_GENERATION':
        throw new Error(
          `Stale generation: expected=${expectedGen ?? 'n/a'}, current=${outcome.currentGeneration}`
        );

      case 'UNSUPPORTED_COMMAND':
        throw new Error(`UNSUPPORTED_COMMAND: ${outcome.command}`);

      case 'ERROR':
      default:
        throw new Error(outcome.error || 'Sequencer error');
    }
  }

  // ============================================================
  //  ENCRYPTED MUTATIONS (7)
  // ============================================================
  async function handleCreate(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const parentId = requireString(msg.payload?.parentId, 'parentId');
    const type = msg.payload?.type;
    if (type !== 'bookmark' && type !== 'folder') {
      throw new Error('type must be bookmark or folder');
    }
    const title = validateTitle(msg.payload?.title);
    const url = type === 'bookmark' ? validateUrl(msg.payload?.url) : undefined;
    const insertAfterId = msg.payload?.insertAfterId ?? null;

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'create',
      payload: { parentId, type, title, url, insertAfterId },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      CBF_PROJECTION.applyMutation({
        type: 'created',
        node: {
          id: o.result.id, parentId: o.result.parentId,
          positionKey: o.result.positionKey,
          type: o.result.type, title: o.result.title,
          url: o.result.url
        }
      });
    }, outcome.status === 'OK' ? {
      type: 'created',
      node: {
        id: outcome.result.id, parentId: outcome.result.parentId,
        positionKey: outcome.result.positionKey,
        type: outcome.result.type, title: outcome.result.title,
        url: outcome.result.url
      }
    } : null, expectedGeneration);
  }

  async function handleRename(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const id = requireString(msg.payload?.id, 'id');
    const title = validateTitle(msg.payload?.title);

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'rename',
      payload: { id, title },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const existing = CBF_PROJECTION.getItem(id);
      if (existing) {
        CBF_PROJECTION.applyMutation({
          type: 'updated',
          node: { ...existing, title: o.result.title }
        });
      }
    }, outcome.status === 'OK' ? {
      type: 'updated',
      node: { id, title: outcome.result.title }
    } : null, expectedGeneration);
  }

  async function handleDelete(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const id = requireString(msg.payload?.id, 'id');

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'delete',
      payload: { id },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const ids = Array.isArray(o.result?.deletedIds) ? o.result.deletedIds : [id];
      for (const delId of ids) {
        CBF_PROJECTION.applyMutation({
          type: 'deleted',
          node: { id: delId }
        });
      }
    }, outcome.status === 'OK' ? {
      type: 'deleted',
      node: { id },
      deletedIds: outcome.result?.deletedIds || [id]
    } : null, expectedGeneration);
  }

  async function handleMove(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const newParentId = requireString(msg.payload?.newParentId, 'newParentId');
    const position = msg.payload?.position || 'inside';
    const targetId = msg.payload?.targetId || null;

    if (position !== 'inside' && position !== 'before' && position !== 'after') {
      throw new Error('position must be inside|before|after');
    }

    let id = null;
    let ids = null;
    if (Array.isArray(msg.payload?.ids) && msg.payload.ids.length > 0) {
      ids = msg.payload.ids.map((x, i) => requireString(x, `ids[${i}]`));
    } else {
      id = requireString(msg.payload?.id, 'id');
    }

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'move',
      payload: { id, ids, newParentId, position, targetId },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const moves = Array.isArray(o.result?.moves) ? o.result.moves : [];
      if (moves.length > 0) {
        for (const m of moves) {
          const existing = CBF_PROJECTION.getItem(m.id);
          if (existing) {
            CBF_PROJECTION.applyMutation({
              type: 'moved',
              node: { ...existing, parentId: m.parentId, positionKey: m.positionKey }
            });
          }
        }
      }
    }, outcome.status === 'OK' ? {
      type: 'moved',
      moves: (outcome.result?.moves || []).map(m => ({
        id: m.id, parentId: m.parentId, positionKey: m.positionKey
      }))
    } : null, expectedGeneration);
  }

  async function handleReorder(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const id = requireString(msg.payload?.id, 'id');
    const targetId = requireString(msg.payload?.targetId, 'targetId');
    const position = msg.payload?.position;
    if (position !== 'before' && position !== 'after') {
      throw new Error('position must be before|after');
    }

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'reorder',
      payload: { id, targetId, position },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const movedId = o.result?.moves?.[0]?.id || id;
      const newPos = o.result?.moves?.[0]?.positionKey || o.result?.positionKey;
      const existing = CBF_PROJECTION.getItem(movedId);
      if (existing && newPos) {
        CBF_PROJECTION.applyMutation({
          type: 'moved',
          node: { ...existing, positionKey: newPos }
        });
      }
    }, outcome.status === 'OK' ? {
      type: 'moved',
      moves: [{
        id,
        parentId: outcome.result?.moves?.[0]?.parentId,
        positionKey: outcome.result?.moves?.[0]?.positionKey
      }]
    } : null, expectedGeneration);
  }

  async function handleMerge(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const item1Id = requireString(msg.payload?.item1Id, 'item1Id');
    const item2Id = requireString(msg.payload?.item2Id, 'item2Id');
    const folderName = validateTitle(msg.payload?.folderName);
    const parentId = requireString(msg.payload?.parentId, 'parentId');

    if (item1Id === item2Id) {
      throw new Error('item1Id and item2Id must be different');
    }

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'merge',
      payload: { item1Id, item2Id, folderName, parentId },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const nf = o.result;
      CBF_PROJECTION.applyMutation({
        type: 'created',
        node: {
          id: nf.id, parentId: nf.parentId,
          positionKey: nf.positionKey,
          type: 'folder', title: nf.title, url: null
        }
      });
      for (const mid of [item1Id, item2Id]) {
        const existing = CBF_PROJECTION.getItem(mid);
        if (existing) {
          CBF_PROJECTION.applyMutation({
            type: 'moved',
            node: { ...existing, parentId: nf.id }
          });
        }
      }
    }, outcome.status === 'OK' ? {
      type: 'created',
      node: {
        id: outcome.result.id, parentId: outcome.result.parentId,
        positionKey: outcome.result.positionKey,
        type: 'folder', title: outcome.result.title, url: null
      }
    } : null, expectedGeneration);
  }

  async function handleMergeFolders(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);
    const sourceId = requireString(msg.payload?.sourceId, 'sourceId');
    const targetId = requireString(msg.payload?.targetId, 'targetId');

    if (sourceId === targetId) {
      throw new Error('sourceId and targetId must be different');
    }

    const outcome = await CBF_SEQUENCER.execute({
      commandId, expectedGeneration,
      command: 'mergeFolders',
      payload: { sourceId, targetId },
      storeKey: _getStoreKeyOrThrow()
    });

    await _dispatchMutationOutcome(port, sessionId, commandId, outcome, (o) => {
      const nf = o.result;
      CBF_PROJECTION.applyMutation({
        type: 'created',
        node: {
          id: nf.id, parentId: nf.parentId,
          positionKey: nf.positionKey,
          type: 'folder', title: nf.title, url: null
        }
      });
      CBF_PROJECTION.applyMutation({
        type: 'deleted',
        node: { id: sourceId }
      });
    }, outcome.status === 'OK' ? {
      type: 'created',
      node: {
        id: outcome.result.id, parentId: outcome.result.parentId,
        positionKey: outcome.result.positionKey,
        type: 'folder', title: outcome.result.title, url: null
      }
    } : null, expectedGeneration);
  }

  // ============================================================
  //  CROSS-SPACE (4)
  // ============================================================
  async function handleMoveToEncrypted(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const transferId = requireString(msg.payload?.transferId, 'transferId');

    try {
      const result = await CBF_CROSS_SPACE.moveToEncrypted(id, transferId);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error,
          details: result.details || null
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId,
        generation: CBF_PROJECTION.getGeneration(),
        mutation: {
          type: 'cross-moved',
          from: 'firefox', to: 'encrypted',
          removedId: id, createdId: result.id
        }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: { id: result.id, type: 'bookmark' }
      });
    } catch (e) {
      err('moveToEncrypted failed:', e.message);
      await sendError(port, sessionId, commandId, 'CROSS_MOVE_FAILED', e.message);
    }
  }

  async function handleMoveToFirefox(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const transferId = requireString(msg.payload?.transferId, 'transferId');

    try {
      const result = await CBF_CROSS_SPACE.moveToFirefox(id, transferId);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error,
          details: result.details || null
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId,
        generation: CBF_PROJECTION.getGeneration(),
        mutation: {
          type: 'cross-moved',
          from: 'encrypted', to: 'firefox',
          removedId: id, createdId: result.id
        }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: { id: result.id, type: 'bookmark' }
      });
    } catch (e) {
      err('moveToFirefox failed:', e.message);
      await sendError(port, sessionId, commandId, 'CROSS_MOVE_FAILED', e.message);
    }
  }

  async function handleMoveFolderToEncrypted(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const transferId = requireString(msg.payload?.transferId, 'transferId');

    try {
      const result = await CBF_CROSS_SPACE.moveFolderToEncrypted(id, transferId);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error,
          details: result.details || null
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId,
        generation: CBF_PROJECTION.getGeneration(),
        mutation: {
          type: 'cross-moved',
          from: 'firefox', to: 'encrypted',
          removedId: id, createdId: result.id,
          isFolder: true
        }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: { id: result.id, type: 'folder' }
      });
    } catch (e) {
      err('moveFolderToEncrypted failed:', e.message);
      await sendError(port, sessionId, commandId, 'CROSS_MOVE_FAILED', e.message);
    }
  }

  async function handleMoveFolderToFirefox(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const transferId = requireString(msg.payload?.transferId, 'transferId');

    try {
      const result = await CBF_CROSS_SPACE.moveFolderToFirefox(id, transferId);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error,
          details: result.details || null
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId,
        generation: CBF_PROJECTION.getGeneration(),
        mutation: {
          type: 'cross-moved',
          from: 'encrypted', to: 'firefox',
          removedId: id, createdId: result.id,
          isFolder: true
        }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: { id: result.id, type: 'folder' }
      });
    } catch (e) {
      err('moveFolderToFirefox failed:', e.message);
      await sendError(port, sessionId, commandId, 'CROSS_MOVE_FAILED', e.message);
    }
  }

  // ============================================================
  //  FIREFOX SPACE D&D (7)
  // ============================================================
  async function handleFirefoxMove(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const newParentId = requireString(msg.payload?.newParentId, 'newParentId');
    const position = msg.payload?.position || 'inside';
    const targetId = msg.payload?.targetId || null;

    if (position !== 'inside' && position !== 'before' && position !== 'after') {
      throw new Error('position must be inside|before|after');
    }

    try {
      const result = await CBF_FIREFOX_DND.firefoxMove(
        id, newParentId, position, targetId
      );

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: { type: 'moved', moves: result.mutation.moves }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });
    } catch (e) {
      err('firefoxMove failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_MOVE_FAILED', e.message);
    }
  }

  async function handleFirefoxReorder(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const targetId = requireString(msg.payload?.targetId, 'targetId');
    const position = msg.payload?.position;

    if (position !== 'before' && position !== 'after') {
      throw new Error('position must be before|after');
    }

    try {
      const result = await CBF_FIREFOX_DND.firefoxReorder(id, targetId, position);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: { type: 'moved', moves: result.mutation.moves }
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });
    } catch (e) {
      err('firefoxReorder failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_REORDER_FAILED', e.message);
    }
  }

  async function handleFirefoxMerge(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const item1Id = requireString(msg.payload?.item1Id, 'item1Id');
    const item2Id = requireString(msg.payload?.item2Id, 'item2Id');
    const folderName = validateTitle(msg.payload?.folderName);
    const parentId = requireString(msg.payload?.parentId, 'parentId');

    if (item1Id === item2Id) {
      throw new Error('item1Id and item2Id must be different');
    }

    try {
      const result = await CBF_FIREFOX_DND.firefoxMerge(
        item1Id, item2Id, folderName, parentId
      );

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: result.mutation
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });
    } catch (e) {
      err('firefoxMerge failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_MERGE_FAILED', e.message);
    }
  }

  async function handleFirefoxMergeFolders(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const sourceId = requireString(msg.payload?.sourceId, 'sourceId');
    const targetId = requireString(msg.payload?.targetId, 'targetId');

    if (sourceId === targetId) {
      throw new Error('sourceId and targetId must be different');
    }

    try {
      const result = await CBF_FIREFOX_DND.firefoxMergeFolders(sourceId, targetId);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: result.mutation
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });
    } catch (e) {
      err('firefoxMergeFolders failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_MERGE_FOLDERS_FAILED', e.message);
    }
  }

  async function handleFirefoxRemove(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');

    try {
      const result = await CBF_FIREFOX_DND.firefoxRemove(id);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: result.mutation
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });
    } catch (e) {
      err('firefoxRemove failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_REMOVE_FAILED', e.message);
    }
  }

  async function handleFirefoxCreate(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const parentId = requireString(msg.payload?.parentId, 'parentId');
    const type = msg.payload?.type;

    if (type !== 'bookmark' && type !== 'folder') {
      throw new Error('type must be bookmark or folder');
    }

    const title = validateTitle(msg.payload?.title);
    const url = type === 'bookmark' ? validateUrl(msg.payload?.url) : null;

    try {
      const result = await CBF_FIREFOX_DND.firefoxCreate(
        parentId, type, title, url
      );

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      await _broadcastMutationToOthers(port, {
        commandId, generation: 0,
        mutation: result.mutation
      });

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });

      log(
        `firefoxCreate OK: id=${result.result.id.slice(0, 8)} ` +
        `type=${type} parent=${parentId.slice(0, 8)}`
      );
    } catch (e) {
      err('firefoxCreate failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_CREATE_FAILED', e.message);
    }
  }

  async function handleFirefoxRename(port, sessionId, msg) {
    _requireFirefoxSpace(port);

    const commandId = msg.commandId || null;
    const id = requireString(msg.payload?.id, 'id');
    const title = validateTitle(msg.payload?.title);

    try {
      const result = await CBF_FIREFOX_DND.firefoxRename(id, title);

      if (!result.success) {
        await sendTo(port, sessionId, 'mutationResult', {
          commandId, success: false, error: result.error
        });
        return;
      }

      if (result.mutation) {
        await _broadcastMutationToOthers(port, {
          commandId, generation: 0,
          mutation: result.mutation
        });
      }

      await sendTo(port, sessionId, 'mutationResult', {
        commandId, success: true, result: result.result
      });

      log(
        `firefoxRename OK: id=${id.slice(0, 8)} ` +
        `noop=${result.result?.noop === true}`
      );
    } catch (e) {
      err('firefoxRename failed:', e.message);
      await sendError(port, sessionId, commandId, 'FIREFOX_RENAME_FAILED', e.message);
    }
  }

  // ============================================================
  //  LOCK
  // ============================================================
  async function handleLock(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    try {
      await CBF_VAULT_FSM.lock();
      _setSpace(port, 'firefox');
      await sendTo(port, sessionId, 'lockResult', {
        commandId, success: true, activeSpace: 'firefox'
      });
    } catch (e) {
      err('lock failed:', e.message);
      await sendTo(port, sessionId, 'lockResult', {
        commandId, success: false, error: e.message
      });
    }
  }

  // ============================================================
  //  V12.1 (V12E.E-05a): OPEN OPTIONS PAGE
  //
  //  ΠΡΙΝ (v12E):
  //    Το main-menu.js._onOpenOptionsPage() προσπαθούσε πρώτα
  //    CBF_BRIDGE.send('openOptionsPage', {}) → απέτυχε με
  //    UNKNOWN_COMMAND (δεν υπήρχε στο HANDLERS) → έπεφτε στο
  //    runtime.sendMessage fallback → 1 περιττό HMAC-signed
  //    round-trip + 2 warning logs + ~50-200ms καθυστέρηση.
  //
  //  ΜΕΤΑ (v12.1):
  //    Native handler → το bridge attempt 1 πετυχαίνει άμεσα.
  //    Τα fallback (runtime.sendMessage, direct API) στο
  //    main-menu.js παραμένουν ως defense-in-depth.
  //
  //  CAPABILITY: null (δεν απαιτεί unlock — η σελίδα ρυθμίσεων
  //  έχει δικό της lock screen που χειρίζεται τον χώρο).
  // ============================================================
  async function handleOpenOptionsPage(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    try {
      await browser.runtime.openOptionsPage();
      await sendTo(port, sessionId, 'openOptionsPageResult', {
        commandId, success: true
      });
      log('openOptionsPage OK');
    } catch (e) {
      err('openOptionsPage failed:', e.message);
      await sendError(port, sessionId, commandId,
        'OPEN_OPTIONS_FAILED', e.message);
    }
  }

  // ============================================================
  //  M-08: resetAllPortSpaces helper
  //
  //  Καλείται από το background.js στο FSM LOCKED transition.
  //  Επαναφέρει όλα τα ports στο firefox space.
  // ============================================================
  function _resetAllPortSpaces() {
    let count = 0;
    for (const [port, space] of portSpaces.entries()) {
      if (space !== 'firefox') {
        portSpaces.set(port, 'firefox');
        count++;
      }
    }
    if (count > 0) {
      log(`M-08: reset ${count} port space(s) → firefox`);
    }
    return count;
  }

  // ============================================================
  //  V12E (D-52): openInCurrentTab / openInNewTab
  // ============================================================
  async function handleOpenInCurrentTab(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const url = requireString(msg.payload?.url, 'url');

    if (url.length > MAX_URL_LENGTH) {
      await sendError(port, sessionId, commandId, 'URL_TOO_LONG',
        `URL exceeds ${MAX_URL_LENGTH} chars`);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      await sendError(port, sessionId, commandId, 'INVALID_URL_PROTOCOL',
        'Only http(s) URLs are supported');
      return;
    }

    const session = CBF_SESSION.getSession(sessionId);
    const tabId = session?.tabId;

    if (typeof tabId !== 'number') {
      await sendError(port, sessionId, commandId, 'NO_TAB_ID',
        'openInCurrentTab requires an active tab');
      return;
    }

    try {
      const result = await CBF_OPEN_HANDLER.openInCurrentTab(url, tabId);
      await sendTo(port, sessionId, 'openInCurrentTabResult', {
        commandId,
        success: true,
        tabId: result.tabId
      });
    } catch (e) {
      err('openInCurrentTab failed:', e.message);
      let code = 'OPEN_FAILED';
      if (/INVALID_URL_PROTOCOL/i.test(e.message)) code = 'INVALID_URL_PROTOCOL';
      else if (/URL_TOO_LONG/i.test(e.message)) code = 'URL_TOO_LONG';
      else if (/INVALID_URL/i.test(e.message)) code = 'INVALID_URL';
      await sendError(port, sessionId, commandId, code, e.message);
    }
  }

  async function handleOpenInNewTab(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const url = requireString(msg.payload?.url, 'url');

    if (url.length > MAX_URL_LENGTH) {
      await sendError(port, sessionId, commandId, 'URL_TOO_LONG',
        `URL exceeds ${MAX_URL_LENGTH} chars`);
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      await sendError(port, sessionId, commandId, 'INVALID_URL_PROTOCOL',
        'Only http(s) URLs are supported');
      return;
    }

    try {
      const result = await CBF_OPEN_HANDLER.openInNewTab(url);
      await sendTo(port, sessionId, 'openInNewTabResult', {
        commandId,
        success: true,
        tabId: result.tabId,
        usedContainer: result.usedContainer
      });
    } catch (e) {
      err('openInNewTab failed:', e.message);
      let code = 'OPEN_FAILED';
      if (/INVALID_URL_PROTOCOL/i.test(e.message)) code = 'INVALID_URL_PROTOCOL';
      else if (/URL_TOO_LONG/i.test(e.message)) code = 'URL_TOO_LONG';
      else if (/INVALID_URL/i.test(e.message)) code = 'INVALID_URL';
      await sendError(port, sessionId, commandId, code, e.message);
    }
  }

  // ============================================================
  //  V12E (D-51): EXPORT HANDLERS
  // ============================================================
  async function handleExportBookmarks(port, sessionId, msg) {
    const commandId = msg.commandId || null;

    try {
      const json = await CBF_EXPORT_SERVICE.collectFirefoxTreeAsJSON();
      const jsonStr = JSON.stringify(json, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      await _downloadJSON(jsonStr, `cbf-bookmarks-${date}.json`);

      audit('EXPORT_BOOKMARKS', { size: jsonStr.length });
      await sendTo(port, sessionId, 'exportResult', {
        commandId,
        success: true,
        type: 'bookmarks',
        size: jsonStr.length
      });
    } catch (e) {
      err('exportBookmarks failed:', e.message);
      await sendError(port, sessionId, commandId, 'EXPORT_FAILED', e.message);
    }
  }

  async function handleExportFavicons(port, sessionId, msg) {
    const commandId = msg.commandId || null;

    try {
      const favicons = await CBF_EXPORT_SERVICE.collectFaviconsForExport();
      const jsonStr = JSON.stringify(favicons, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      await _downloadJSON(jsonStr, `cbf-favicons-${date}.json`);

      const count = Object.keys(favicons).length;
      audit('EXPORT_FAVICONS', { count, size: jsonStr.length });
      await sendTo(port, sessionId, 'exportResult', {
        commandId,
        success: true,
        type: 'favicons',
        count,
        size: jsonStr.length
      });
    } catch (e) {
      err('exportFavicons failed:', e.message);
      await sendError(port, sessionId, commandId, 'EXPORT_FAILED', e.message);
    }
  }

  async function handleExportEncryptedBackup(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = msg.commandId || null;

    if (!CBF_ES.isUnlocked()) {
      await sendError(port, sessionId, commandId, 'LOCKED',
        'Vault must be unlocked');
      return;
    }

    try {
      const backup = await CBF_EXPORT_SERVICE.collectEncryptedAsBackup();
      const jsonStr = JSON.stringify(backup, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      await _downloadJSON(jsonStr, `cbf-encrypted-backup-${date}.json`);

      audit('EXPORT_ENCRYPTED_BACKUP', {
        records: backup.recordCount,
        size: jsonStr.length
      });
      await sendTo(port, sessionId, 'exportResult', {
        commandId,
        success: true,
        type: 'encrypted-backup',
        recordCount: backup.recordCount,
        size: jsonStr.length
      });
    } catch (e) {
      err('exportEncryptedBackup failed:', e.message);
      await sendError(port, sessionId, commandId, 'EXPORT_FAILED', e.message);
    }
  }

  async function handleExportEncryptedPlain(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = msg.commandId || null;

    if (!CBF_ES.isUnlocked()) {
      await sendError(port, sessionId, commandId, 'LOCKED',
        'Vault must be unlocked');
      return;
    }

    try {
      const json = await CBF_EXPORT_SERVICE.collectEncryptedAsPlain();
      const jsonStr = JSON.stringify(json, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      await _downloadJSON(jsonStr, `cbf-encrypted-plain-${date}.json`);

      CBF_LOGGER.security(
        '⚠️ EXPORT_ENCRYPTED_PLAIN: plaintext export performed — ' +
        'user confirmed via UI'
      );
      await sendTo(port, sessionId, 'exportResult', {
        commandId,
        success: true,
        type: 'encrypted-plain',
        size: jsonStr.length
      });
    } catch (e) {
      err('exportEncryptedPlain failed:', e.message);
      await sendError(port, sessionId, commandId, 'EXPORT_FAILED', e.message);
    }
  }

  // ============================================================
  //  V12E (D-56 + V12E.E-CROSS-01): IMPORT ENCRYPTED
  //
  //  V12E.E-CROSS-01 (cross-key import):
  //    Αν salt ≠ current → ζητά password για το ΠΑΛΙΟ vault,
  //    derive old keys, decrypt + re-encrypt κάθε record,
  //    περνάει τα νέα ciphertexts στον sequencer.
  //
  //  Security:
  //    - Password ΔΕΝ αποθηκεύεται
  //    - Old keys zeroized μετά το re-encryption
  //    - Fail-closed (wrong password → decrypt fails → error)
  //    - Read-only για το backup file
  //    - Rate limit + size limit unchanged
  // ============================================================
  async function handleImportEncrypted(port, sessionId, msg) {
    _requireEncryptedSpace(port);

    const commandId = requireUUID(msg.commandId, 'commandId');
    const expectedGeneration = requireGeneration(msg.expectedGeneration);

    const backupData = msg.payload?.data;
    const password = msg.payload?.password || null;

    // ---------- 1. Size check (D-51) ----------
    const size = _estimatePayloadSize(backupData);
    if (size < 0) {
      await sendError(port, sessionId, commandId, 'IMPORT_SERIALIZATION_ERROR',
        'Backup payload cannot be serialized');
      return;
    }
    if (size > MAX_IMPORT_SIZE_BYTES) {
      await sendError(port, sessionId, commandId, 'IMPORT_TOO_LARGE',
        `Payload size ${size} exceeds limit ${MAX_IMPORT_SIZE_BYTES}`);
      return;
    }

    // ---------- 2. Vault must be unlocked ----------
    if (!CBF_ES.isUnlocked()) {
      await sendError(port, sessionId, commandId, 'LOCKED',
        'Vault must be unlocked');
      return;
    }

    // ---------- 3. Validate backup shape (CBF_IMPORT_SERVICE) ----------
    let validated;
    if (backupData && backupData.type === 'encrypted-backup') {
      const v = CBF_IMPORT_SERVICE.validateEncryptedBackup(backupData);
      if (!v.valid) {
        await sendError(port, sessionId, commandId, 'INVALID_BACKUP', v.error);
        return;
      }
      validated = v.records;
    } else {
      const v = CBF_IMPORT_SERVICE.validatePlainExport(backupData);
      if (!v.valid) {
        await sendError(port, sessionId, commandId, 'INVALID_IMPORT', v.error);
        return;
      }
      await sendError(port, sessionId, commandId, 'PLAIN_IMPORT_NOT_SUPPORTED',
        'Plain imports must be encrypted by caller before sending');
      return;
    }

    // ---------- 4. Read current KDF config, check salt ----------
    const config = await CBF_ES._internal.readKdfConfig();
    if (!config) {
      await sendError(port, sessionId, commandId, 'VAULT_CONFIG_MISSING',
        'Vault KDF config not found');
      return;
    }

    let currentSaltB64;
    try {
      currentSaltB64 = CBF_CRYPTO.bufToB64(config.salt);
    } finally {
      CBF_CRYPTO.zeroBuffer(config.salt);
    }

    const saltMatches = (currentSaltB64 === backupData.salt);

    let recordsToImport;

    if (saltMatches) {
      // ═══════════════════════════════════════════════════════════
      //  SAME-KEY MODE (D-56 default)
      // ═══════════════════════════════════════════════════════════
      log(`[IMPORT] Same-key mode: ${validated.length} records (salt matches)`);
      recordsToImport = validated;

    } else {
      // ═══════════════════════════════════════════════════════════
      //  V12E.E-CROSS-01: CROSS-KEY MODE
      // ═══════════════════════════════════════════════════════════
      log(
        `[IMPORT] Cross-key mode detected: ` +
        `backup.salt=${String(backupData.salt).slice(0, 8)}..., ` +
        `current.salt=${currentSaltB64.slice(0, 8)}...`
      );

      if (typeof password !== 'string' || password.length === 0) {
        await sendError(port, sessionId, commandId, 'CROSS_KEY_PASSWORD_REQUIRED',
          'This backup is from a different vault (different salt). ' +
          'Please provide the ORIGINAL password of the source vault ' +
          'so we can decrypt and re-encrypt the records.');
        return;
      }

      // ---------- 4a. Derive OLD keys ----------
      let oldDerived;
      try {
        oldDerived = await CBF_ES._internal.deriveKeysFromPasswordExternal(
          password,
          backupData.salt,
          backupData.kdfId || 'argon2id'
        );
      } catch (e) {
        err('Cross-key: old key derivation failed:', e.message);
        await sendError(port, sessionId, commandId, 'CROSS_KEY_DERIVE_FAILED',
          'Failed to derive old keys: ' + e.message);
        return;
      }

      // ---------- 4b. Decrypt + re-encrypt κάθε record ----------
      const currentStoreKey    = CBF_ES._internal.getStoreKey();
      const currentKeyVersion  = CBF_ES._internal.getKeyVersion();

      const reencrypted = [];
      let decryptFailures = 0;
      let verifySuccess = false;

      try {
        for (let i = 0; i < validated.length; i++) {
          const oldRec = validated[i];

          // OLD AAD (ίδιο metadata, παλιό keyVersion)
          const oldAAD = CBF_CRYPTO.buildAADRecord({
            formatVersion: oldRec.formatVersion,
            keyVersion: oldRec.keyVersion,
            space: 'encrypted',
            recordType: oldRec.recordType,
            id: oldRec.id,
            parentId: oldRec.parentId ?? '',
            positionKey: oldRec.positionKey
          });

          let plain = null;
          try {
            plain = await CBF_CRYPTO.decryptRecord(
              { nonce: oldRec.nonce, ciphertext: oldRec.ciphertext, tag: oldRec.tag },
              oldDerived.storeKey,
              oldAAD
            );
          } catch (e) {
            decryptFailures++;
            warn(`Cross-key: record ${oldRec.id.slice(0, 8)} decrypt failed: ${e.message}`);
            if (decryptFailures > 5) {
              throw new Error(
                'CROSS_KEY_WRONG_PASSWORD_OR_CORRUPTED: too many decrypt failures'
              );
            }
            continue;
          } finally {
            CBF_CRYPTO.zeroBuffer(oldAAD);
          }

          if (!verifySuccess) {
            verifySuccess = true;
            log(`Cross-key: password verified (first record decrypted ✓)`);
          }

          // NEW AAD (νέο keyVersion, τρέχον storeKey)
          const newAAD = CBF_CRYPTO.buildAADRecord({
            formatVersion: 1,
            keyVersion: currentKeyVersion,
            space: 'encrypted',
            recordType: oldRec.recordType,
            id: oldRec.id,
            parentId: oldRec.parentId ?? '',
            positionKey: oldRec.positionKey
          });

          let newEnc;
          try {
            newEnc = await CBF_CRYPTO.encryptRecord(plain, currentStoreKey, newAAD);
          } finally {
            CBF_CRYPTO.zeroBuffer(newAAD);
          }

          reencrypted.push({
            id: oldRec.id,
            parentId: oldRec.parentId,
            positionKey: oldRec.positionKey,
            recordType: oldRec.recordType,
            keyVersion: currentKeyVersion,
            formatVersion: 1,
            nonce: newEnc.nonce,
            ciphertext: newEnc.ciphertext,
            tag: newEnc.tag
          });
        }
      } catch (e) {
        try { if (oldDerived && oldDerived.master) CBF_CRYPTO.zeroBuffer(oldDerived.master); } catch (_) {}
        await sendError(port, sessionId, commandId,
          'CROSS_KEY_DECRYPT_FAILED', e.message);
        return;
      } finally {
        try { if (oldDerived && oldDerived.master) CBF_CRYPTO.zeroBuffer(oldDerived.master); } catch (_) {}
      }

      if (!verifySuccess) {
        await sendError(port, sessionId, commandId, 'CROSS_KEY_WRONG_PASSWORD',
          'Could not decrypt ANY record. Wrong original password ' +
          'or corrupted backup.');
        return;
      }

      if (decryptFailures > 0) {
        log(`Cross-key: ${decryptFailures} record(s) skipped (decrypt failed)`);
      }

      audit('CROSS_KEY_IMPORT_REENCRYPTED', {
        original: validated.length,
        reencrypted: reencrypted.length,
        failed: decryptFailures
      });

      if (reencrypted.length === 0) {
        await sendError(port, sessionId, commandId, 'CROSS_KEY_NO_RECORDS',
          'No records could be decrypted.');
        return;
      }

      recordsToImport = reencrypted;
    }

    // ---------- 5. Sequencer execute ----------
    let outcome;
    try {
      outcome = await CBF_SEQUENCER.execute({
        commandId,
        expectedGeneration,
        command: 'importEncrypted',
        payload: { records: recordsToImport, mode: 'skip-existing' },
        storeKey: _getStoreKeyOrThrow()
      });
    } catch (e) {
      err('importEncrypted sequencer failed:', e.message);
      await sendError(port, sessionId, commandId, 'IMPORT_FAILED', e.message);
      return;
    }

    // ---------- 6. Dispatch outcome ----------
    try {
      await _dispatchMutationOutcome(
        port, sessionId, commandId, outcome,
        null,   // (no per-item projection update — bulk rebuild below)
        null,   // (no broadcast)
        expectedGeneration
      );
    } catch (e) {
      err('importEncrypted dispatch failed:', e.message);
      await sendError(port, sessionId, commandId, 'IMPORT_FAILED', e.message);
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    //  V12E.E-REBUILD-01: Rebuild projection μετά από import
    //
    //  ΠΡΟΒΛΗΜΑ:
    //    Ο sequencer γράφει τα νέα records στο IDB, και το
    //    CBF_PROJECTION.setGeneration() ενημερώνει ΜΟΝΟ τον
    //    generation counter — ΟΧΙ τα items.
    //    → Το overlay χρησιμοποιεί CBF_PROJECTION.getSanitizedTree()
    //      → βλέπει το παλιό snapshot → ΔΕΝ εμφανίζει τα imported items.
    //
    //  ΛΥΣΗ:
    //    Μετά το επιτυχές import, καλούμε CBF_RECOVERY.rebuildSnapshot()
    //    που διαβάζει όλα τα records από IDB, τα decrypt-άρει με τον
    //    τρέχον storeKey, και ανακατασκευάζει το in-RAM projection.
    //
    //  Fail-soft:
    //    Αν το rebuild αποτύχει (π.χ. locked mid-operation), τα records
    //    είναι ΑΚΟΜΑ στο IDB. Θα εμφανιστούν στο επόμενο unlock.
    //    Δεν κάνουμε throw — το import πέτυχε ήδη.
    // ═══════════════════════════════════════════════════════════════
    if (outcome.status === 'OK' && (outcome.result?.importedCount || 0) > 0) {
      try {
        if (typeof CBF_RECOVERY !== 'undefined' &&
            typeof CBF_RECOVERY.rebuildSnapshot === 'function') {
          const rebuildResult = await CBF_RECOVERY.rebuildSnapshot();
          log(
            `[IMPORT] Projection rebuilt: ${rebuildResult.itemCount} items, ` +
            `gen=${rebuildResult.generation}`
          );
        } else {
          warn('[IMPORT] CBF_RECOVERY.rebuildSnapshot not available — ' +
               'imported items not visible until next unlock');
        }
      } catch (e) {
        warn('[IMPORT] Projection rebuild failed:', e.message);
        // Not fatal — items ARE in IDB
      }
    }

    // ---------- 7. Audit ----------
    audit('IMPORT_ENCRYPTED_COMPLETE', {
      imported: outcome.result?.importedCount,
      skipped: outcome.result?.skippedCount,
      total: outcome.result?.totalCount,
      generation: outcome.generation,
      crossKey: !saltMatches
    });

    log(
      `[IMPORT] Complete: ${outcome.result?.importedCount} imported, ` +
      `${outcome.result?.skippedCount} skipped ` +
      `(mode=${saltMatches ? 'same-key' : 'cross-key'})`
    );
  }

  // ============================================================
  //  V12E (D-51): IMPORT FAVICONS
  //
  //  🔧 v12.3.0 BUG-FIX: Invalidate negative cache + broadcast
  //
  //  ΠΡΟΒΛΗΜΑ (consistent με background.js::importFaviconsSimple):
  //    Ο handler έγραφε storage.local απευθείας, αλλά:
  //      ❌ ΔΕΝ invalidated το favicon-service._negativeCache
  //      ❌ ΔΕΝ broadcast faviconUpdate στα ανοιχτά overlays
  //
  //    Συνέπεια: Overlay που ζήτησε getFavicon πριν το import
  //    έπαιρνε negative cache hit (5min TTL) αντί για το νέο favicon.
  //
  //  ΛΥΣΗ:
  //    1. CBF_FAVICON.invalidateNegativeCache() — server-side
  //    2. CBF_FAVICON._internal._broadcastFavicon() για κάθε entry
  //       με excludePort = port (ο caller ενημερώνεται από το
  //       importResult response)
  // ============================================================
  async function handleImportFavicons(port, sessionId, msg) {
    const commandId = msg.commandId || null;
    const items = msg.payload?.items;

    const size = _estimatePayloadSize(items);
    if (size > MAX_FAVICON_IMPORT_SIZE) {
      await sendError(port, sessionId, commandId, 'IMPORT_TOO_LARGE',
        `Favicon payload size ${size} exceeds limit ${MAX_FAVICON_IMPORT_SIZE}`);
      return;
    }

    const validation = CBF_IMPORT_SERVICE.validateImportFavicons(items);
    if (!validation.valid) {
      await sendError(port, sessionId, commandId, 'INVALID_IMPORT',
        validation.error);
      return;
    }

    let imported = 0;
    const importedItems = [];   // 🔧 v12.3.0: για broadcast μετά

    for (const item of validation.items) {
      try {
        const hostname = _extractHostname(item.url);
        if (!hostname) continue;

        const update = { [`favicon_${hostname}`]: item.dataUrl };
        if (item.color) update[`favicon_color_${hostname}`] = item.color;
        await browser.storage.local.set(update);
        importedItems.push({
          hostname,
          dataUrl: item.dataUrl,
          color: item.color || null
        });
        imported++;
      } catch (e) {
        warn('importFavicons item failed:', e.message);
      }
    }

    // ═════════════════════════════════════════════════════════════
    //  🔧 v12.3.0 BUG-FIX: Invalidate negative cache + broadcast
    //
    //  Consistency με background.js::importFaviconsSimple.
    //  Χωρίς αυτό, ένα overlay που ζήτησε getFavicon πριν το import
    //  θα πάρει negative cache hit (5min TTL) αντί για το νέο favicon.
    // ═════════════════════════════════════════════════════════════
    if (imported > 0 && typeof CBF_FAVICON !== 'undefined') {
      // 1. Invalidate server-side negative cache
      if (typeof CBF_FAVICON.invalidateNegativeCache === 'function') {
        const cleared = CBF_FAVICON.invalidateNegativeCache();
        log(
          `importFavicons: invalidated negative cache (${cleared} entries)`
        );
      }

      // 2. Broadcast σε όλα τα ports — excludePort = port (ο caller
      //    θα ενημερωθεί από το importResult response)
      try {
        if (CBF_FAVICON._internal?._broadcastFavicon) {
          for (const entry of importedItems) {
            CBF_FAVICON._internal._broadcastFavicon(
              entry.hostname,
              entry.dataUrl,
              entry.color,
              port   // 🔧 excludePort = ο caller (sender)
            );
          }
          log(
            `importFavicons: broadcast ${importedItems.length} faviconUpdate event(s)`
          );
        }
      } catch (bcErr) {
        warn('importFavicons: broadcast failed:', bcErr.message);
      }
    }

    audit('IMPORT_FAVICONS', {
      imported,
      total: validation.items.length
    });

    await sendTo(port, sessionId, 'importResult', {
      commandId,
      success: true,
      type: 'favicons',
      importedCount: imported,
      totalCount: validation.items.length
    });
  }

  // ============================================================
  //  HANDLERS REGISTRY (36 — v12.1 / v12.2 / v12.3)
  // ============================================================
  const HANDLERS = {
    // Read (8)
    getStatus:       { fn: handleGetStatus,       cap: null },
    getActiveSpace:  { fn: handleGetActiveSpace,  cap: null },
    setActiveSpace:  { fn: handleSetActiveSpace,  cap: null },
    queryTree:       { fn: handleQueryTree,       cap: 'read' },
    getPath:         { fn: handleGetPath,         cap: 'read' },
    open:            { fn: handleOpen,            cap: 'read' },
    getFavicon:      { fn: handleGetFavicon,      cap: 'read' },
    searchBookmarks: { fn: handleSearchBookmarks, cap: 'read' },

    // V12E (D-52): Open
    openInCurrentTab:{ fn: handleOpenInCurrentTab, cap: 'read' },
    openInNewTab:    { fn: handleOpenInNewTab,     cap: 'read' },

    // Encrypted mutations (7)
    create:          { fn: handleCreate,          cap: 'write' },
    rename:          { fn: handleRename,          cap: 'write' },
    delete:          { fn: handleDelete,          cap: 'write' },
    move:            { fn: handleMove,            cap: 'write' },
    reorder:         { fn: handleReorder,         cap: 'write' },
    merge:           { fn: handleMerge,           cap: 'write' },
    mergeFolders:    { fn: handleMergeFolders,    cap: 'write' },

    // Firefox D&D (7)
    firefoxMove:          { fn: handleFirefoxMove,          cap: 'firefox' },
    firefoxReorder:       { fn: handleFirefoxReorder,       cap: 'firefox' },
    firefoxMerge:         { fn: handleFirefoxMerge,         cap: 'firefox' },
    firefoxMergeFolders:  { fn: handleFirefoxMergeFolders,  cap: 'firefox' },
    firefoxRemove:        { fn: handleFirefoxRemove,        cap: 'firefox' },
    firefoxCreate:        { fn: handleFirefoxCreate,        cap: 'firefox' },
    firefoxRename:        { fn: handleFirefoxRename,        cap: 'firefox' },

    // Cross-space (4)
    moveToEncrypted:       { fn: handleMoveToEncrypted,       cap: 'write' },
    moveToFirefox:         { fn: handleMoveToFirefox,         cap: 'firefox' },
    moveFolderToEncrypted: { fn: handleMoveFolderToEncrypted, cap: 'write' },
    moveFolderToFirefox:   { fn: handleMoveFolderToFirefox,   cap: 'firefox' },

    // V12E (D-51): Export
    exportBookmarks:       { fn: handleExportBookmarks,       cap: null },
    exportFavicons:        { fn: handleExportFavicons,        cap: null },
    exportEncryptedBackup: { fn: handleExportEncryptedBackup, cap: 'read' },
    exportEncryptedPlain:  { fn: handleExportEncryptedPlain,  cap: 'read' },

    // V12E (D-56 / D-51): Import
    importEncrypted:       { fn: handleImportEncrypted,       cap: 'write' },
    importFavicons:        { fn: handleImportFavicons,        cap: null },

    // Lifecycle (1)
    lock:            { fn: handleLock,            cap: null },

    // ⭐ v12.1 (V12E.E-05a fix): Options (1)
    openOptionsPage: { fn: handleOpenOptionsPage, cap: null }
  };

  // ============================================================
  //  Route — κεντρικός dispatcher
  // ============================================================
  async function route(port, sessionId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.type !== 'string') return;

    try {
      const size = JSON.stringify(msg).length;
      if (size > MAX_MESSAGE_SIZE) {
        await sendError(port, sessionId, msg.commandId, 'MESSAGE_TOO_LARGE');
        return;
      }
    } catch (_) {}

    if (msg.type === 'unlock') {
      return CBF_UNLOCK_HANDLER.handle(port, sessionId, msg);
    }
    if (msg.type === 'setup') {
      return CBF_UNLOCK_HANDLER.handleSetup(port, sessionId, msg);
    }

    const rateCheck = CBF_RATE_LIMITER.check(sessionId, msg.type);
    if (!rateCheck.allowed) {
      await sendError(port, sessionId, msg.commandId,
        rateCheck.reason || 'RATE_LIMITED',
        `Rate limited: ${rateCheck.reason}`);
      return;
    }

    const handler = HANDLERS[msg.type];
    if (!handler) {
      await sendError(port, sessionId, msg.commandId, 'UNKNOWN_COMMAND',
        `Unknown type: ${msg.type}`);
      return;
    }

    try {
      _enforceCapCentralized(sessionId, port, handler.cap);
      await handler.fn(port, sessionId, msg);
    } catch (e) {
      err(`handler ${msg.type} failed:`, e.message);
      let code = 'HANDLER_ERROR';
      if (/stale generation/i.test(e.message)) code = 'STALE_GENERATION';
      else if (/not found/i.test(e.message)) code = 'NOT_FOUND';
      else if (/capability/i.test(e.message)) code = 'NO_CAPABILITY';
      else if (/INVALID_CAPABILITY_TAG/i.test(e.message)) code = 'NO_CAPABILITY';
      else if (/UNSUPPORTED_COMMAND/i.test(e.message)) code = 'UNSUPPORTED_COMMAND';
      else if (/only in encrypted space/i.test(e.message)) code = 'WRONG_SPACE';
      else if (/only in firefox space/i.test(e.message)) code = 'WRONG_SPACE';
      else if (/validate|invalid|required|must be|too long/i.test(e.message)) {
        code = 'BAD_REQUEST';
      }
      await sendError(port, sessionId, msg.commandId, code, e.message);
    }
  }

  // ============================================================
  //  Port handler — session setup + HMAC verification + dispatch
  // ============================================================
  function handlePort(port) {
    if (!isTrustedSender(port.sender)) {
      warn('Untrusted port sender — disconnecting');
      try { port.disconnect(); } catch (_) {}
      return;
    }
    const tabId = port.sender?.tab?.id ?? null;
    const frameId = port.sender?.frameId ?? null;

    (async () => {
      try {
        const { sessionId, sessionToken, sessionEpoch } =
          await CBF_SESSION.createSession(port, tabId, frameId);

        if (CBF_ES.isUnlocked()) {
          CBF_SESSION.grantCapability(sessionId, CBF_SESSION.CAP_READ);
          CBF_SESSION.grantCapability(sessionId, CBF_SESSION.CAP_WRITE);
          log(`Auto-granted encrypted capabilities to new session (vault unlocked)`);
        }

        _setSpace(port, 'firefox');
        log(`Port connected: session=${_short(sessionId)} tab=${tabId} epoch=${sessionEpoch}`);

        const globalVersion = CBF_PROJECTION.getGeneration();

        await sendTo(port, sessionId, 'initAck', {
          sessionId,
          sessionToken,
          sessionEpoch,
          globalVersion
        });

        log(`initAck sent: session=${_short(sessionId)} epoch=${sessionEpoch} gen=${globalVersion}`);

        port.onMessage.addListener(async (msg) => {
          try {
            if (!msg || typeof msg !== 'object') return;
            const { hmac, ...rest } = msg;

            if (!hmac) {
              CBF_LOGGER.security('Rejected message without HMAC');
              return;
            }

            const session = CBF_SESSION.getSession(sessionId);
            if (!session) {
              CBF_LOGGER.security(`Rejected: session ${_short(sessionId)} not found`);
              return;
            }

            const currentEpoch = session.sessionEpoch;
            const currentToken = session.sessionToken;

            if (!currentToken) {
              CBF_LOGGER.security('Rejected: session token missing');
              return;
            }

            // ═══ L-07: presence → verify → epoch → seq ═══
            const keyBytes = CBF_CRYPTO.b64ToBuf(currentToken);
            const sigBytes = CBF_CRYPTO.b64ToBuf(hmac);
            let valid = false;
            try {
              const canonical = CBF_CRYPTO.canonicalJSON(rest);
              valid = await CBF_CRYPTO.hmacVerify(keyBytes, canonical, sigBytes);
            } finally {
              CBF_CRYPTO.zeroBuffer(keyBytes);
              CBF_CRYPTO.zeroBuffer(sigBytes);
            }

            if (!valid) {
              CBF_LOGGER.security('HMAC verification FAILED');
              return;
            }

            if (rest.sessionEpoch === undefined || rest.sessionEpoch === null) {
              CBF_LOGGER.security('Rejected message without sessionEpoch');
              return;
            }
            if (rest.sessionEpoch !== currentEpoch) {
              CBF_LOGGER.security(
                `Rejected message with wrong epoch: got=${rest.sessionEpoch}, current=${currentEpoch}`
              );
              return;
            }

            const portState = CBF_SESSION.getPortState(port);
            if (!portState) {
              CBF_LOGGER.security('Rejected: port state not found');
              return;
            }

            const lastSeq = portState.lastSequence || 0;

            // ═══ C-01: requestSeq must be a positive integer ═══
            if (typeof rest.requestSeq !== 'number' ||
                !Number.isInteger(rest.requestSeq) ||
                rest.requestSeq < 1) {
              CBF_LOGGER.security(
                `Rejected: invalid requestSeq=${rest.requestSeq} (type=${typeof rest.requestSeq})`
              );
              return;
            }

            // ═══ C-01: requestSeq must be > lastSequence (monotonic) ═══
            if (rest.requestSeq <= lastSeq) {
              CBF_LOGGER.security(
                `REPLAY DETECTED: session=${_short(sessionId)} ` +
                `requestSeq=${rest.requestSeq} <= lastSeq=${lastSeq}`
              );
              return;
            }

            portState.lastSequence = rest.requestSeq;

            log(`Accepted: session=${_short(sessionId)} seq=${rest.requestSeq} type=${rest.type}`);

            CBF_SESSION.updateActivity(sessionId);
            await route(port, sessionId, rest);

          } catch (e) {
            err('Message handling failed:', e.message);
          }
        });

        port.onDisconnect.addListener(() => {
          log(`Port disconnected: session=${_short(sessionId)}`);
          _clearSpace(port);
          CBF_SESSION.disconnect(port);
          CBF_RATE_LIMITER.reset(sessionId);
        });
      } catch (e) {
        err('handlePort failed:', e.message);
        _clearSpace(port);
        try { port.disconnect(); } catch (_) {}
      }
    })();
  }

  // ============================================================
  //  Epoch rotation notification
  // ============================================================
  async function notifyEpochRotation(sessionId) {
    const port = CBF_SESSION.getPortBySession(sessionId);
    if (!port) return false;
    const session = CBF_SESSION.getSession(sessionId);
    if (!session) return false;
    try {
      port.postMessage({
        type: 'epochRotated',
        sessionEpoch: session.sessionEpoch,
        sessionToken: session.sessionToken
      });
      log(`notifyEpochRotation: session=${_short(sessionId)} epoch=${session.sessionEpoch}`);
      return true;
    } catch (e) {
      warn('notifyEpochRotation failed:', e.message);
      return false;
    }
  }

  async function rotateEpochAndNotify(sessionId) {
    const result = await CBF_SESSION.rotateEpoch(sessionId);
    if (!result) return null;
    await notifyEpochRotation(sessionId);
    return result;
  }

  async function rotateAllEpochsAndNotify() {
    const results = await CBF_SESSION.rotateAllEpochs();
    for (const r of results) {
      await notifyEpochRotation(r.sessionId);
    }
    return results;
  }

  // ============================================================
  //  API
  // ============================================================
  const api = {
    handlePort,
    sendTo,
    PORT_NAME,
    rotateEpochAndNotify,
    rotateAllEpochsAndNotify,
    notifyEpochRotation,
    _internal: {
      sanitizeBroadcastNode: _sanitizeBroadcastNode,
      sanitizeBroadcastMutation: _sanitizeBroadcastMutation,
      requireUUID,
      validateUrl,
      validateTitle,
      checkFirefoxCap: _checkFirefoxCap,
      enforceCapCentralized: _enforceCapCentralized,
      resetAllPortSpaces: _resetAllPortSpaces,
      UUID_V4_REGEX,
      HANDLERS,

      // Phonetic + hostname helpers
      phoneticKey: _phoneticKey,
      extractHostname: _extractHostname,
      CHAR_TO_LATIN,

      // V12E (D-51): Payload size + download helpers
      estimatePayloadSize: _estimatePayloadSize,
      downloadJSON: _downloadJSON,

      // V12E constants
      MAX_IMPORT_SIZE_BYTES,
      MAX_FAVICON_IMPORT_SIZE,

      // v12.1: Firefox root IDs (fixed: unfiled_____)
      FIREFOX_ROOT_IDS,

      // 🔧 v12.2: broadcast helper exposed για tests
      broadcastMutationToOthers: _broadcastMutationToOthers
    }
  };

  // ============================================================
  //  Export
  // ============================================================
  if (typeof self !== 'undefined') self.CBF_MESSAGING = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_MESSAGING = api;

  if (typeof CBF_LOGGER !== 'undefined') {
        CBF_LOGGER.info(
      'Messaging ready (v12.3.0: 36 handlers — read + open + encrypted + firefox + cross-space + ' +
      'export + import + lock + openOptionsPage — BUG-1 unfiled_____ fix + ISSUE-1 native options handler + ' +
      'CPU-10 serialized broadcast + importFavicons negative-cache fix)'
    );
  }
  return api;
})();