/**
 * projection-manager.js — Projection manager (in-memory snapshot)
 *
 * @path     background/core/projection-manager.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   In-memory snapshot των decrypted items (RAM-only). Παρέχει
 *   sanitized projections στο overlay με strictPrivacy support.
 *   Είναι single-writer aware — μόνο ο sequencer-aware code
 *   επιτρέπεται να κάνει mutations (M-02 read-only proxy).
 *
 * KEY CONCEPTS
 *   • getItemsMap() returns READ-ONLY Proxy (M-02) — block set/delete/clear
 *   • sanitizeNode() ΠΑΝΤΑ include positionKey + url (structural — F-1)
 *   • title respects strictPrivacy (privacy protection)
 *   • strictPrivacy persisted σε storage.local (C3)
 *   • Generation: monotonic counter (S-11 enforcement upstream)
 *
 * DECISIONS
 *   D-13.1
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "projection-manager"
 */

var CBF_PROJECTION = (function() {
  'use strict';

  const STORAGE_KEY = 'cbf_strict_privacy';

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  { CBF_LOGGER.info('[PROJ]', ...a); }
  function warn(...a) { CBF_LOGGER.warn('[PROJ]', ...a); }

  // ============================================================
  //  Κατάσταση (RAM only, εκτός από strictPrivacy flag)
  // ============================================================
  let snapshot = null;
  let strictPrivacy = false;
  let rootId = 'ecbf-root';

  // ============================================================
  //  M-02: Cached read-only Proxy
  //
  //  Δημιουργείται μία φορά ανά snapshot.
  //  Reset σε init() / reset() / setItems() (in-place mutation
  //  δεν χρειάζεται νέο proxy γιατί δείχνει το ίδιο Map).
  // ============================================================
  let _readOnlyProxy = null;

  // ============================================================
  //  M-02: Read-only Proxy factory
  // ============================================================
  const BLOCKED_METHODS = Object.freeze(['set', 'delete', 'clear']);

  function _createReadOnlyProxy(targetMap) {
    return new Proxy(targetMap, {
      // GET: Επιτρέπει reads, block mutations
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);

        // Methods: block list + bind
        if (typeof value === 'function') {
          if (BLOCKED_METHODS.includes(prop)) {
            return function _blockedMutation(...args) {
              warn(
                `M-02: getItemsMap().${String(prop)}() BLOCKED ` +
                `(read-only proxy) — args: ${args.length}`
              );
              // Return-safe values:
              //   set() → return the map (chaining) — but we return undefined
              //   delete() → false (nothing deleted)
              //   clear() → undefined
              if (prop === 'delete') return false;
              return undefined;
            };
          }
          // Allowed methods: bind στο target για σωστό `this`
          return value.bind(target);
        }

        return value;
      },

      // SET: Block property assignment
      set(target, prop, value) {
        warn(
          `M-02: getItemsMap().${String(prop)} = ... BLOCKED ` +
          `(read-only proxy, cannot set)`
        );
        return true;   // true → δεν σκάει σε strict mode
      },

      // DELETE: Block property deletion
      deleteProperty(target, prop) {
        warn(
          `M-02: delete getItemsMap().${String(prop)} BLOCKED ` +
          `(read-only proxy)`
        );
        return true;   // true → δεν σκάει σε strict mode
      },

      // has: keep default behavior
      has(target, prop) {
        return Reflect.has(target, prop);
      },

      // ownKeys: keep default behavior
      ownKeys(target) {
        return Reflect.ownKeys(target);
      },

      // getOwnPropertyDescriptor: needed for ownKeys consistency
      getOwnPropertyDescriptor(target, prop) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
    });
  }

  // ============================================================
  //  Init / Reset
  // ============================================================
  function init(opts = {}) {
    if (typeof opts.strictPrivacy === 'boolean') {
      strictPrivacy = opts.strictPrivacy;
    }
    rootId = opts.rootId || 'ecbf-root';
    snapshot = {
      generation: 0,
      items: new Map()
    };

    // M-02: Fresh proxy για νέο Map
    _readOnlyProxy = _createReadOnlyProxy(snapshot.items);

    log(`init: strict=${strictPrivacy}, root=${rootId}, proxy attached`);
  }

  function reset() {
    snapshot = null;
    _readOnlyProxy = null;
    log('reset');
  }

  function isReady() {
    return snapshot !== null;
  }

  // ============================================================
  //  strictPrivacy persistence (C3)
  // ============================================================
  async function loadFromStorage() {
    try {
      const res = await browser.storage.local.get(STORAGE_KEY);
      if (typeof res[STORAGE_KEY] === 'boolean') {
        strictPrivacy = res[STORAGE_KEY];
        log(`strictPrivacy loaded from storage: ${strictPrivacy}`);
      }
    } catch (e) {
      warn('Failed to load strictPrivacy:', e.message);
    }
    return strictPrivacy;
  }

  async function saveToStorage() {
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: strictPrivacy });
    } catch (e) {
      warn('Failed to save strictPrivacy:', e.message);
    }
  }

  // ============================================================
  //  Generation
  // ============================================================
  function getGeneration() {
    return snapshot ? snapshot.generation : 0;
  }

  function setGeneration(gen) {
    if (!snapshot) return;
    if (typeof gen !== 'number' || gen < snapshot.generation) {
      warn(`Invalid generation transition: ${snapshot.generation} → ${gen}`);
      return;
    }
    if (gen !== snapshot.generation) {
      log(`Generation: ${snapshot.generation} → ${gen}`);
      snapshot.generation = gen;
    }
  }

  function bumpGeneration() {
    if (!snapshot) return 0;
    snapshot.generation++;
    return snapshot.generation;
  }

  // ============================================================
  //  Items
  // ============================================================
  function setItems(items) {
    if (!snapshot) init();

    // Bulk rebuild — επιτρέπεται μόνο internally
    // (Το _readOnlyProxy δείχνει στο ίδιο Map, οπότε δεν χρειάζεται refresh)
    snapshot.items.clear();
    for (const item of items) {
      snapshot.items.set(item.id, { ...item });
    }

    log(`setItems: loaded ${snapshot.items.size} items`);
  }

  function getItem(id) {
    return snapshot ? snapshot.items.get(id) : undefined;
  }

  function hasItem(id) {
    return snapshot ? snapshot.items.has(id) : false;
  }

  function getChildren(parentId) {
    if (!snapshot) return [];
    const children = [];
    for (const node of snapshot.items.values()) {
      if (node.parentId === parentId) children.push(node);
    }
    children.sort(compareByPosition);
    return children;
  }

  function compareByPosition(a, b) {
    const pa = typeof a.positionKey === 'string' ? a.positionKey : '0';
    const pb = typeof b.positionKey === 'string' ? b.positionKey : '0';
    let ba, bb;
    try { ba = BigInt(pa); } catch { ba = 0n; }
    try { bb = BigInt(pb); } catch { bb = 0n; }
    if (ba < bb) return -1;
    if (ba > bb) return 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  }

  // ============================================================
  //  Mutations στο snapshot
  //
  //  ⚠️ SINGLE WRITER: αυτή η function καλείται ΜΟΝΟ από
  //     sequencer-aware code paths (messaging.js, cross-space-service.js).
  // ============================================================
  function applyMutation(mutation) {
    if (!snapshot) return;
    const { type, node } = mutation;
    switch (type) {
      case 'created':
      case 'updated':
      case 'moved':
        if (node && node.id) {
          snapshot.items.set(node.id, { ...node });
        }
        break;
      case 'deleted':
        if (node && node.id) {
          snapshot.items.delete(node.id);
        }
        break;
      default:
        warn(`Unknown mutation type: ${type}`);
    }
  }

  // ============================================================
  //  Sanitized projections
  //
  //  sanitizeNode ΠΡΕΠΕΙ να επιστρέφει:
  //    - id, type, parentId     (structural)
  //    - positionKey            (structural — sorting)
  //    - url                    (structural — rendering + open)
  //    - title                  (respects strictPrivacy)
  // ============================================================
  function sanitizeNode(node) {
    if (!node) return null;

    const out = {
      id: node.id,
      type: node.type,
      parentId: node.parentId,
      positionKey: typeof node.positionKey === 'string' ? node.positionKey : null
    };

    // url πάντα (structural — απαραίτητο για rendering)
    if (typeof node.url === 'string' && node.url.length > 0) {
      out.url = node.url;
    }

    // title respects strictPrivacy
    if (!strictPrivacy && typeof node.title === 'string') {
      out.title = node.title;
    }

    return out;
  }

  function getSanitizedTree(parentId, limit = 100, cursor = null) {
    if (!snapshot) {
      return { generation: 0, items: [], hasMore: false };
    }
    const root = parentId || rootId;
    const children = getChildren(root);

    let startIndex = 0;
    if (cursor) {
      startIndex = children.findIndex(c => c.positionKey === cursor) + 1;
      if (startIndex < 0) startIndex = 0;
    }

    const slice = children.slice(startIndex, startIndex + limit);
    const items = slice.map(sanitizeNode).filter(Boolean);
    const hasMore = startIndex + limit < children.length;

    return {
      generation: snapshot.generation,
      items,
      hasMore
    };
  }

  function getItemSanitized(id) {
    const item = getItem(id);
    return sanitizeNode(item);
  }

  // ============================================================
  //  Info
  // ============================================================
  function getStats() {
    if (!snapshot) {
      return {
        ready: false,
        generation: 0,
        itemCount: 0,
        strictPrivacy,
        rootId
      };
    }
    return {
      ready: true,
      generation: snapshot.generation,
      itemCount: snapshot.items.size,
      strictPrivacy,
      rootId
    };
  }

  function getRootId() {
    return rootId;
  }

  function setRootId(id) {
    if (typeof id === 'string' && id) rootId = id;
  }

  /**
   * setStrictPrivacy πλέον persist-άρει αυτόματα (C3).
   */
  function setStrictPrivacy(value) {
    strictPrivacy = !!value;
    log(`strictPrivacy set: ${strictPrivacy}`);
    // fire-and-forget persist
    saveToStorage().catch(() => {});
  }

  // Direct getter – δεν εξαρτάται από snapshot
  function getStrictPrivacy() {
    return strictPrivacy;
  }

  // ============================================================
  //  M-02: Read-only access στο εσωτερικό Map
  //
  //  Επιστρέφει CACHED Proxy (μία φορά ανά snapshot).
  //
  //  Allowed (read):
  //    get, has, keys, values, entries, forEach, size, [Symbol.iterator], ...
  //
  //  Blocked (mutations):
  //    set, delete, clear + property assignment
  //
  //  Rationale (Single Writer Invariant #4):
  //    Όλες οι αλλαγές ΠΡΕΠΕΙ να περνούν από applyMutation() ή
  //    setItems(). Read-only consumers (tree-utils, messaging getPath)
  //    ΔΕΝ έχουν mutation power.
  // ============================================================
  function getItemsMap() {
    if (!snapshot) {
      // Fallback: empty Map wrapped σε read-only proxy
      // ΔΕΝ cache-άρουμε γιατί θα αντικατασταθεί στο επόμενο init()
      return _createReadOnlyProxy(new Map());
    }

    if (!_readOnlyProxy) {
      // Defensive: αν λείπει (π.χ. από external mutation)
      _readOnlyProxy = _createReadOnlyProxy(snapshot.items);
      warn('M-02: proxy re-created (was missing)');
    }

    return _readOnlyProxy;
  }

  // ============================================================
  //  Δημόσιο API
  // ============================================================
  const api = {
    init,
    reset,
    isReady,

    loadFromStorage,
    saveToStorage,

    getGeneration,
    setGeneration,
    bumpGeneration,

    setItems,
    getItem,
    hasItem,
    getChildren,
    applyMutation,

    getSanitizedTree,
    getItemSanitized,

    getStats,
    getRootId,
    setRootId,
    setStrictPrivacy,
    getStrictPrivacy,

    getItemsMap,

    STORAGE_KEY,

    // Exposed for tests / diagnostics
    _internal: {
      sanitizeNode,
      compareByPosition,

      // M-02: Proxy internals
      _createReadOnlyProxy,
      _getProxy: () => _readOnlyProxy,
      BLOCKED_METHODS
    }
  };

  if (typeof window !== 'undefined') window.CBF_PROJECTION = api;
  if (typeof self !== 'undefined') self.CBF_PROJECTION = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_PROJECTION = api;

  if (typeof CBF_LOGGER !== 'undefined') {
    CBF_LOGGER.info(
      'Projection Manager ready (v12.0.0: M-02 read-only proxy + F-1 url + positionKey)'
    );
  }

  return api;
})();