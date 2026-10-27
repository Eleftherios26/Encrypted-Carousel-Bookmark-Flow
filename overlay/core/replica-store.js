/**
 * replica-store.js — Replica store (RAM-only)
 *
 * @path     overlay/core/replica-store.js
 * @version  12.0.0
 * @since    v12E
 *
 * PURPOSE
 *   In-memory replica των decrypted items στο overlay (RAM-only).
 *   ΔΕΝ αποθηκεύει σε IDB / storage — μόνο mirror του projection.
 *   Παρέχει local search με ASCII-safe phonetic fallback.
 *
 * KEY CONCEPTS
 *   • ASCII-safe: Όλα τα exotic chars με \uXXXX escapes (bulletproof
 *     έναντι non-UTF-8 editors)
 *   • PREFIX-ONLY search: .startsWith() αντί .includes() → "y" βρίσκει
 *     "YouTube" αλλά ΟΧΙ "My Yahoo"
 *   • Phonetic fallback: Greek/Cyrillic/accented → Latin
 *     (π.χ. "α" → "a", "αστείο" → "asteio")
 *
 * DECISIONS
 *   D-13.1
 *
 * FULL HISTORY
 *   → docs/ECBF-Manual.html → search "replica"
 */

var CBF_REPLICA = (function() {
  'use strict';

  // ============================================================
  //  ASCII-safe phonetic char map (Unicode escapes)
  //
  //  Χρησιμοποιούμε \uXXXX escapes αντί για literal chars για
  //  bulletproof encoding safety. Όλοι οι Unicode codepoints:
  //
  //  Greek lowercase (03B1-03CE):
  //    α=03B1  ά=03AC  β=03B2  γ=03B3  δ=03B4  ε=03B5  έ=03AD
  //    ζ=03B6  η=03B7  ή=03AE  θ=03B8  ι=03B9  ί=03AF  ϊ=03CA
  //    κ=03BA  λ=03BB  μ=03BC  ν=03BD  ξ=03BE  ο=03BF  ό=03CC
  //    π=03C0  ρ=03C1  σ=03C3  ς=03C2  τ=03C4  υ=03C5  ύ=03CD
  //    φ=03C6  χ=03C7  ψ=03C8  ω=03C9  ώ=03CE
  //
  //  Cyrillic lowercase (0430-044F + 0451):
  //    а=0430  б=0431  в=0432  г=0433  д=0434  е=0435  ё=0451
  //    ж=0436  з=0437  и=0438  й=0439  к=043A  л=043B  м=043C
  //    н=043D  о=043E  п=043F  р=0440  с=0441  т=0442  у=0443
  //    ф=0444  х=0445  ц=0446  ч=0447  ш=0448  щ=0449  ъ=044A
  //    ы=044B  ь=044C  э=044D  ю=044E  я=044F
  //
  //  Accented Latin (00C0-00FF + 0153, 00E6):
  //    à=00E0  â=00E2  ä=00E4  è=00E8  é=00E9  ê=00EA  ë=00EB
  //    ì=00EC  î=00EE  ï=00EF  ò=00F2  ô=00F4  ö=00F6  ù=00F9
  //    û=00FB  ü=00FC  ÿ=00FF  ç=00E7  œ=0153  æ=00E6
  //
  //  Όλα → canonical LATIN (a-z).
  // ============================================================
  const CHAR_TO_LATIN = Object.freeze({
    // ---------- Greek → Latin ----------
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

    // ---------- Cyrillic → Latin ----------
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

    // ---------- Accented Latin → base Latin ----------
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

  /**
   * Phonetic key: canonical Latin form.
   * Lowercase → apply CHAR_TO_LATIN char-by-char → concat.
   */
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

  /**
   * Extract hostname από URL για prefix matching.
   * π.χ. "https://www.youtube.com/..." → "youtube.com"
   */
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
  //  State (RAM only)
  // ============================================================
  const items = new Map();
  let generation = 0;
  let rootId = 'ecbf-root';
  let currentParentId = 'ecbf-root';
  const pathStack = [];

  // ============================================================
  //  Logging
  // ============================================================
  function log(...a)  {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.info('[REPLICA]', ...a);
    else console.log('[REPLICA]', ...a);
  }
  function warn(...a) {
    if (typeof CBF_LOGGER !== 'undefined') CBF_LOGGER.warn('[REPLICA]', ...a);
    else console.warn('[REPLICA]', ...a);
  }

  // ============================================================
  //  Lifecycle
  // ============================================================
  function reset() {
    items.clear();
    generation = 0;
    pathStack.length = 0;
    currentParentId = rootId;
    log('Reset');
  }

  // ============================================================
  //  Root / Generation
  // ============================================================
  function setRootId(id) {
    if (typeof id === 'string' && id) {
      rootId = id;
      currentParentId = id;
    }
  }

  function getRootId() { return rootId; }

  function setGeneration(gen, force = false) {
    if (typeof gen !== 'number' || gen < 0) return;

    if (!force && gen < generation) {
      warn('Invalid generation transition: ' + generation + ' → ' + gen);
      return;
    }

    if (force && gen < generation) {
      log('Force generation reset: ' + generation + ' → ' + gen);
    }

    generation = gen;
  }

  function getGeneration() { return generation; }

  function bumpGeneration() {
    generation++;
    return generation;
  }

  // ============================================================
  //  Items
  // ============================================================
  function setItems(list) {
    items.clear();
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && item.id) {
        items.set(item.id, Object.assign({}, item));
      }
    }
    log('Loaded ' + items.size + ' items');
  }

  function upsertItem(item) {
    if (!item || !item.id) return;
    const existing = items.get(item.id);
    if (existing) {
      items.set(item.id, Object.assign({}, existing, item));
    } else {
      items.set(item.id, Object.assign({}, item));
    }
  }

  function removeItem(id) { items.delete(id); }
  function getItem(id) { return items.get(id); }
  function hasItem(id) { return items.has(id); }

  function getChildren(parentId) {
    const out = [];
    for (const node of items.values()) {
      if (node.parentId === parentId) out.push(node);
    }
    out.sort(compareByPosition);
    return out;
  }

  function compareByPosition(a, b) {
    const pa = typeof a.positionKey === 'string' ? a.positionKey : '';
    const pb = typeof b.positionKey === 'string' ? b.positionKey : '';
    if (pa < pb) return -1;
    if (pa > pb) return 1;
    const ia = a.id || '';
    const ib = b.id || '';
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return 0;
  }

  function getAllItems() { return Array.from(items.values()); }
  function size() { return items.size; }
  function getItemsMap() { return items; }

  // ============================================================
  //  Current parent
  // ============================================================
  function getCurrentParentId() { return currentParentId; }

  function setCurrentParentId(id) {
    if (typeof id === 'string' && id) currentParentId = id;
  }

  // ============================================================
  //  Path stack
  // ============================================================
  function pushPath(segment) {
    if (!segment || !segment.id) return;
    pathStack.push({ id: segment.id, title: segment.title || segment.id });
  }

  function popPath() {
    return pathStack.pop() || null;
  }

  function setPath(path) {
    pathStack.length = 0;
    if (!Array.isArray(path)) return;
    for (const seg of path) {
      if (seg && seg.id) {
        pathStack.push({ id: seg.id, title: seg.title || seg.id });
      }
    }
  }

  function getPath() { return pathStack.slice(); }

  // ============================================================
  //  Search — PREFIX-ONLY + phonetic fallback
  //
  //  1. Raw prefix: title.startsWith(q) OR hostname.startsWith(q)
  //  2. Phonetic prefix (fallback):
  //     _phoneticKey(title).startsWith(_phoneticKey(q))
  // ============================================================
  function search(query) {
    if (typeof query !== 'string' || query.trim() === '') return [];
    const q = query.toLowerCase().trim();
    const phoneticQ = _phoneticKey(q);

    const out = [];
    for (const node of items.values()) {
      const titleLower = (node.title || '').toLowerCase();
      const hostname = _extractHostname(node.url);

      // ═══ 1. Raw prefix (fast path) ═══
      const rawMatch =
        titleLower.startsWith(q) ||
        (hostname && hostname.startsWith(q));

      if (rawMatch) {
        out.push(node);
        continue;
      }

      // ═══ 2. Phonetic fallback ═══
      if (!phoneticQ) continue;

      const titlePhon = _phoneticKey(titleLower);
      const hostnamePhon = hostname ? _phoneticKey(hostname) : '';

      if (titlePhon.startsWith(phoneticQ) ||
          (hostnamePhon && hostnamePhon.startsWith(phoneticQ))) {
        out.push(node);
      }
    }
    return out;
  }

  // ============================================================
  //  Public API
  // ============================================================
  const api = {
    reset,

    setRootId,
    getRootId,
    setGeneration,
    getGeneration,
    bumpGeneration,

    setItems,
    upsertItem,
    removeItem,
    getItem,
    hasItem,
    getChildren,
    getAllItems,
    size,
    getItemsMap,

    getCurrentParentId,
    setCurrentParentId,

    pushPath,
    popPath,
    setPath,
    getPath,

    search,

    _internal: {
      _phoneticKey,
      _extractHostname,
      CHAR_TO_LATIN
    }
  };

  if (typeof window !== 'undefined') window.CBF_REPLICA = api;
  if (typeof self !== 'undefined') self.CBF_REPLICA = api;
  if (typeof globalThis !== 'undefined') globalThis.CBF_REPLICA = api;

  return api;
})();

console.log('[ECBF:Replica] Ready (v12.0.0 — ASCII-safe prefix-only search)');