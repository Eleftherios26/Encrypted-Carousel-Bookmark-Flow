# Privacy Policy — ECBF (Encrypted Carousel Bookmark Flow)

**Last updated:** 2026-09-18
**Version:** 12 (v12E)
**Extension ID:** `ecbf@Eleftherios.gr` (Firefox)
**Contact:** See the "Contact" section below

---

## 1. Summary (TL;DR)

ECBF is a **fully offline** extension. It does not collect, transmit, share, or sell **any user data** to anyone.

- ✅ **No telemetry** — no analytics, no crash reports, no usage tracking.
- ✅ **No internet connections** from the extension side.
- ✅ **All data stays local** on your computer (Firefox profile).
- ✅ **Encrypted data** (encrypted space) is encrypted with AES-256-GCM, and the key is derived locally from your password using Argon2id.
- ✅ **Your password is never stored anywhere** — neither locally nor in plaintext.

---

## 2. What data does ECBF process?

ECBF operates across **two isolated spaces**:

### 2.1 Firefox Space
Regular Firefox bookmarks, accessed through the official `bookmarks` API.

- **Data:** Titles, URLs, bookmark folder structure.
- **Storage:** In the Firefox database (`places.sqlite`), exactly like your other bookmarks.
- **Access:** Only when the user interacts with the ECBF overlay (open, move, rename, delete).
- **Restriction:** The validator (`firefox-space-validator.js`) **restricts** writes to the managed subtree (Bookmarks Toolbar) only, with explicit prohibition on `menu________`, `unfiled_____`, `mobile______`, `root________`, `tags________`.

### 2.2 Encrypted Space
A separate, **fully isolated** bookmark space, stored exclusively in Firefox's IndexedDB.

- **Data:** Titles, URLs, folder structure.
- **Encryption:** AES-256-GCM (96-bit nonce, 128-bit tag).
- **Key:** Derived locally from your password using **Argon2id** (64 MiB, t=3, p=1) — [RFC 9106](https://datatracker.ietf.org/doc/html/rfc9106).
- **Storage:** Ciphertext only + structural metadata (id, parentId, positionKey). **Never plaintext.**
- **Not synchronized:** Never sent to Firefox Sync, never uploaded anywhere, never exported automatically.

---

## 3. What data is **NOT** collected

ECBF does **NOT** collect:

- ❌ Names, emails, addresses, phone numbers, or any PII.
- ❌ Browsing history.
- ❌ Cookies or session tokens from websites.
- ❌ IP addresses.
- ❌ Geolocation data.
- ❌ Usage statistics, clicks, or telemetry of any kind.
- ❌ Crash reports.
- ❌ Device fingerprints.
- ❌ Lists of installed extensions or Firefox configuration.

---

## 4. Where is data stored

All data remains in **your local Firefox profile**:

| Data type | Location | Encryption |
|---|---|---|
| Firefox bookmarks | `places.sqlite` (Firefox) | Firefox default |
| Encrypted bookmarks | IndexedDB `ECBF_Vault` | AES-256-GCM |
| KDF salt + parameters | `storage.local` (`cbf_salt`, `cbf_kdf`) | Plaintext (not sensitive) |
| Favicons cache | `storage.local` (`favicon_*`) | Plaintext (data URLs) |
| User homepage | `storage.local` (`userHomepage`) | Plaintext |
| Strict privacy flag | `storage.local` (`cbf_strict_privacy`) | Plaintext |
| Last used space | `storage.local` (`cbf_lastSpace`) | Plaintext |
| Pinned folder (per space) | `storage.local` (`cbf_pin_*`) | Plaintext (id + title) |

**None of this is transmitted outside your device.**

---

## 5. Permissions — Why they are needed

Each permission requested by ECBF has a **specific purpose** and is **never used abusively**:

| Permission | Reason for use |
|---|---|
| `storage` | Store KDF config, homepage, favicons, preferences |
| `unlimitedStorage` | IndexedDB for encrypted records (no storage cap) |
| `bookmarks` | Read/write regular bookmarks — **only within the managed subtree** of the Firefox Space |
| `activeTab` | Inject the overlay when you click the extension button (only in the active tab) |
| `scripting` | `browser.scripting.executeScript` for the overlay (NOT used on background tabs) |
| `tabs` | Passive favicon collection from `tab.favIconUrl` (Firefox-internal) |
| `downloads` | Export data to a file (user chooses location) |

**Not requested** (explicitly absent):
- ❌ `host_permissions` / `<all_urls>`
- ❌ `history`
- ❌ `webRequest` / `webRequestBlocking`
- ❌ `cookies`
- ❌ `contextualIdentities`
- ❌ `externally_connectable`

---

## 6. Network connections

ECBF makes **no** network connection:

- ❌ **No HTTP/HTTPS requests** from the extension.
- ❌ **No DNS lookups.**
- ❌ **No transmission of data to any server** (neither the developer's nor third parties').
- ❌ **No downloading of external resources** (CSS, JS, fonts, images).

### Favicons — How they work

Favicons are **not** downloaded by ECBF. Instead:

1. The user visits a website in Firefox.
2. Firefox loads the favicon (its own network request — not ECBF's).
3. Firefox stores it in `tab.favIconUrl` as a `data:` URL.
4. ECBF **passively reads** this data URL (ZERO-NETWORK).
5. ECBF stores it in `storage.local` for future use (30-day TTL).

**Result:** 0 DNS requests, 0 HTTP requests, 0 leaks from the ECBF side.

### WebAssembly (Argon2id)

The Argon2id WASM module (`hash-wasm`) is **bundled** inside the extension (`vendor/hash-wasm/argon2.umd.min.js`). It is not downloaded from the internet, not loaded remotely.

---

## 7. Encryption & Security

### 7.1 Cryptographic Algorithms

| Function | Algorithm | Parameters |
|---|---|---|
| Key Derivation | Argon2id | 64 MiB, t=3, p=1, 32-byte output |
| Key Derivation (legacy) | PBKDF2-HMAC-SHA256 | 600,000 iterations (v2 vaults only) |
| Symmetric Encryption | AES-256-GCM | 96-bit nonce, 128-bit tag |
| Integrity (state) | HMAC-SHA256 | 32-byte |
| Integrity (records) | Merkle Tree HMAC-SHA256 | — |
| Session Auth | HMAC-SHA256 | per-session token |
| Key Derivation (sub-keys) | HKDF-SHA256 | info strings: `ECBF/store/v1`, `ECBF/state-mac/v1`, `ECBF/commitment/v1` |

### 7.2 Key Management

- The password is **NEVER stored** on any medium (neither in long-term RAM, nor on disk).
- The `storeKey` (AES-256-GCM) remains **only in RAM** of the background process.
- On lock, suspend, or termination: all keys are **zeroized**.
- The KDF salt is a **random 128-bit** value stored in `storage.local` (not a secret).
- The password **never leaves your device**.

### 7.3 What is **NOT** protected (Out of Scope)

As explicitly stated in the architecture:

- ❌ Rootkits / kernel-level malware.
- ❌ OS-level keyloggers.
- ❌ Screen capture / remote control.
- ❌ Modification of the extension code itself.
- ❌ **Structural metadata** (id, parentId, positionKey) is visible to anyone with access to IndexedDB — confidentiality applies to the **content** (URLs, titles).
- ❌ When you open an encrypted bookmark, the URL is temporarily exposed to Firefox's navigation subsystem (like any other URL).

---

## 8. Third Parties

ECBF does **NOT** use:

- ❌ Analytics providers (Google Analytics, Matomo, Plausible, etc.)
- ❌ Crash reporting services (Sentry, Bugsnag, etc.)
- ❌ CDNs for assets.
- ❌ Third-party APIs.
- ❌ Advertising networks.
- ❌ Social media widgets.

**No data transmission to third parties. No sharing. No selling.**

---

## 9. Your Rights

Since ECBF **does not collect data**, GDPR-style rights (access, rectification, erasure, portability) **do not apply to our data** — because we hold no data about you.

However, you have **full local control**:

- **Delete all data:** Uninstall the extension → everything is deleted from `storage.local` and IndexedDB.
- **Export data:** Via the "Export" menu (Bookmarks / Favicons / Encrypted backup / Encrypted plain).
- **Delete individual items:** Via the UI (delete card / folder).
- **Change password:** Via the settings (options page).

---


## 10. Standards Compliance

- **Mozilla Add-ons Policy:** ✅ Full compliance — 0 data collection.
- **Firefox `data_collection_permissions`:** Declared as `"required": ["none"]` in `manifest.json`.
- **GDPR:** No personal data is collected → no data controller exists.
- **CCPA:** No data is sold → no "do not sell" obligation.

---


## 11. Licensing

ECBF is distributed under the license declared on its AMO page.

The source code is available for review (Mozilla review policy compliance).

---

**Date of last update:** September 18, 2026
**Policy version:** 1.0