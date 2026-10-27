# Privacy Policy — ECBF (Encrypted Carousel Bookmark Flow)

**Last updated:** 2026-09-18
**Version:** 12 (v12E)
**Extension ID:** `ecbf@Eleftherios.gr` (Firefox)
**Contact:** Δες την ενότητα «Επικοινωνία» παρακάτω

---

## 1. Σύνοψη (TL;DR)

Το ECBF είναι ένα **fully offline** extension. Δεν συλλέγει, δεν αποστέλλει, δεν μοιράζεται, και δεν πουλά **κανένα δεδομένο χρήστη** σε κανέναν.

- ✅ **Καμία τηλεμετρία** — κανένα analytics, κανένα crash report, κανένα usage tracking.
- ✅ **Καμία σύνδεση στο διαδίκτυο** από την πλευρά του extension.
- ✅ **Όλα τα δεδομένα μένουν τοπικά** στον υπολογιστή σου (Firefox profile).
- ✅ **Τα κρυπτογραφημένα δεδομένα** (encrypted space) κρυπτογραφούνται με AES-256-GCM και το κλειδί παράγεται τοπικά από τον κωδικό σου με Argon2id.
- ✅ **Ο κωδικός σου δεν αποθηκεύεται πουθενά** — ούτε τοπικά, ούτε σε plaintext.

---

## 2. Ποια δεδομένα επεξεργάζεται το ECBF;

Το ECBF λειτουργεί σε **δύο απομονωμένους χώρους**:

### 2.1 Firefox Space
Κανονικοί σελιδοδείκτες του Firefox, προσβάσιμοι μέσω του επίσημου `bookmarks` API.

- **Δεδομένα:** Τίτλοι, URLs, δομή φακέλων σελιδοδεικτών.
- **Αποθήκευση:** Στη βάση δεδομένων του Firefox (`places.sqlite`), όπως ακριβώς και οι υπόλοιποι σελιδοδείκτες σου.
- **Πρόσβαση:** Μόνο όταν ο χρήστης αλληλεπιδρά με το overlay του ECBF (άνοιγμα, μετακίνηση, μετονομασία, διαγραφή).
- **Περιορισμός:** Ο validator (`firefox-space-validator.js`) **περιορίζει** τις εγγραφές μόνο στο managed subtree (Bookmarks Toolbar), με ρητή απαγόρευση σε `menu________`, `unfiled_____`, `mobile______`, `root________`, `tags________`.

### 2.2 Encrypted Space
Ξεχωριστός, **πλήρως απομονωμένος** χώρος σελιδοδεικτών, αποθηκευμένος αποκλειστικά στο IndexedDB του Firefox.

- **Δεδομένα:** Τίτλοι, URLs, δομή φακέλων.
- **Κρυπτογράφηση:** AES-256-GCM (nonce 96-bit, tag 128-bit).
- **Κλειδί:** Παράγεται τοπικά από τον κωδικό σου χρησιμοποιώντας **Argon2id** (64 MiB, t=3, p=1) — [RFC 9106](https://datatracker.ietf.org/doc/html/rfc9106).
- **Αποθήκευση:** Μόνο ciphertext + δομικά metadata (id, parentId, positionKey). **Ποτέ plaintext.**
- **Δεν συγχρονίζεται:** Δεν αποστέλλεται σε Firefox Sync, δεν ανεβαίνει πουθενά, δεν εξάγεται αυτόματα.

---

## 3. Ποια δεδομένα **ΔΕΝ** συλλέγονται

Το ECBF **ΔΕΝ** συλλέγει:

- ❌ Ονόματα, emails, διευθύνσεις, τηλέφωνα, ή οποιοδήποτε PII.
- ❌ Ιστορικό περιήγησης.
- ❌ Cookies ή session tokens από ιστοσελίδες.
- ❌ IP addresses.
- ❌ Γεωγραφικά δεδομένα.
- ❌ Στατιστικά χρήσης, clicks, ή telemetry οποιουδήποτε είδους.
- ❌ Crash reports.
- ❌ Device fingerprints.
- ❌ Λίστες εγκατεστημένων extensions ή Firefox configuration.

---

## 4. Πού αποθηκεύονται τα δεδομένα

Όλα τα δεδομένα παραμένουν **στον τοπικό Firefox profile** σου:

| Τύπος δεδομένων | Τοποθεσία | Κρυπτογράφηση |
|---|---|---|
| Firefox bookmarks | `places.sqlite` (Firefox) | Firefox default |
| Encrypted bookmarks | IndexedDB `ECBF_Vault` | AES-256-GCM |
| KDF salt + parameters | `storage.local` (`cbf_salt`, `cbf_kdf`) | Plaintext (δεν είναι ευαίσθητα) |
| Favicons cache | `storage.local` (`favicon_*`) | Plaintext (data URLs) |
| User homepage | `storage.local` (`userHomepage`) | Plaintext |
| Strict privacy flag | `storage.local` (`cbf_strict_privacy`) | Plaintext |
| Last used space | `storage.local` (`cbf_lastSpace`) | Plaintext |
| Pinned folder (per space) | `storage.local` (`cbf_pin_*`) | Plaintext (id + title) |

**Κανένα από αυτά δεν αποστέλλεται εκτός της συσκευής σου.**

---

## 5. Άδειες (Permissions) — Γιατί τις χρειάζεται

Κάθε άδεια που ζητά το ECBF έχει **συγκεκριμένο σκοπό** και **δεν χρησιμοποιείται ποτέ καταχρηστικά**:

| Permission | Λόγος χρήσης |
|---|---|
| `storage` | Αποθήκευση KDF config, homepage, favicons, preferences |
| `unlimitedStorage` | IndexedDB για κρυπτογραφημένα records (χωρίς όριο χώρου) |
| `bookmarks` | Ανάγνωση/εγγραφή κανονικών σελιδοδεικτών — **μόνο στο managed subtree** του Firefox Space |
| `activeTab` | Ένεση του overlay όταν πατάς το κουμπί του extension (μόνο στο ενεργό tab) |
| `scripting` | `browser.scripting.executeScript` για το overlay (ΔΕΝ χρησιμοποιείται σε background tabs) |
| `tabs` | Παθητική συλλογή favicons από `tab.favIconUrl` (Firefox-internal) |
| `downloads` | Εξαγωγή δεδομένων σε αρχείο (χρήστης επιλέγει τοποθεσία) |

**Δεν ζητούνται** (ρητά απουσιάζουν):
- ❌ `host_permissions` / `<all_urls>`
- ❌ `history`
- ❌ `webRequest` / `webRequestBlocking`
- ❌ `cookies`
- ❌ `contextualIdentities`
- ❌ `externally_connectable`

---

## 6. Δικτυακές συνδέσεις

Το ECBF **ΔΕΝ** κάνει καμία δικτυακή σύνδεση:

- ❌ **Κανένα HTTP/HTTPS request** από το extension.
- ❌ **Κανένα DNS lookup.**
- ❌ **Καμία αποστολή δεδομένων σε server** (ούτε του δημιουργού, ούτε τρίτων).
- ❌ **Καμία λήψη εξωτερικών resources** (CSS, JS, fonts, images).

### Favicons — Πώς λειτουργούν

Τα favicons **δεν** κατεβαίνουν από το ECBF. Αντ' αυτού:

1. Ο χρήστης επισκέπτεται μια ιστοσελίδα στον Firefox.
2. Ο Firefox φορτώνει το favicon (δικό του network request — όχι του ECBF).
3. Ο Firefox το αποθηκεύει στο `tab.favIconUrl` ως `data:` URL.
4. Το ECBF **διαβάζει παθητικά** αυτό το data URL (ZERO-NETWORK).
5. Το αποθηκεύει στο `storage.local` για μελλοντική χρήση (30 ημέρες TTL).

**Αποτέλεσμα:** 0 DNS requests, 0 HTTP requests, 0 leak από την πλευρά του ECBF.

### WebAssembly (Argon2id)

Το Argon2id WASM module (`hash-wasm`) είναι **bundled** μέσα στο extension (`vendor/hash-wasm/argon2.umd.min.js`). Δεν κατεβαίνει από το διαδίκτυο, δεν φορτώνεται remotely.

---

## 7. Κρυπτογράφηση & Ασφάλεια

### 7.1 Κρυπτογραφικοί Αλγόριθμοι

| Λειτουργία | Αλγόριθμος | Παράμετροι |
|---|---|---|
| Key Derivation | Argon2id | 64 MiB, t=3, p=1, 32-byte output |
| Key Derivation (legacy) | PBKDF2-HMAC-SHA256 | 600,000 iterations (μόνο για v2 vaults) |
| Symmetric Encryption | AES-256-GCM | nonce 96-bit, tag 128-bit |
| Integrity (state) | HMAC-SHA256 | 32-byte |
| Integrity (records) | Merkle Tree HMAC-SHA256 | — |
| Session Auth | HMAC-SHA256 | per-session token |
| Key Derivation (sub-keys) | HKDF-SHA256 | info strings: `ECBF/store/v1`, `ECBF/state-mac/v1`, `ECBF/commitment/v1` |

### 7.2 Διαχείριση Κλειδιών

- Ο κωδικός πρόσβασης **δεν αποθηκεύεται ΠΟΤΕ** σε κανένα μέσο (ούτε RAM μακροπρόθεσμα, ούτε δίσκο).
- Το `storeKey` (AES-256-GCM) παραμένει **μόνο στη RAM** του background process.
- Σε lock, suspend, ή τερματισμό: όλα τα κλειδιά **μηδενίζονται** (zeroized).
- Το KDF salt είναι **τυχαίο 128-bit** και αποθηκεύεται στο `storage.local` (δεν είναι secret).
- Ο κωδικός **δεν εγκαταλείπει ποτέ τη συσκευή**.

### 7.3 Τι **ΔΕΝ** προστατεύεται (Out of Scope)

Όπως δηλώνεται ρητά στην αρχιτεκτονική:

- ❌ Rootkits / kernel-level malware.
- ❌ OS-level keyloggers.
- ❌ Screen capture / remote control.
- ❌ Τροποποίηση του ίδιου του extension κώδικα.
- ❌ **Δομικά metadata** (id, parentId, positionKey) είναι ορατά σε όποιον έχει πρόσβαση στο IndexedDB — η εμπιστευτικότητα αφορά το **περιεχόμενο** (URL, τίτλοι).
- ❌ Όταν ανοίγεις έναν κρυπτογραφημένο σελιδοδείκτη, το URL αποκαλύπτεται προσωρινά στο navigation subsystem του Firefox (όπως και κάθε άλλο URL).

---

## 8. Τρίτα Μέρη

Το ECBF **ΔΕΝ** χρησιμοποιεί:

- ❌ Analytics providers (Google Analytics, Matomo, Plausible, κλπ.)
- ❌ Crash reporting services (Sentry, Bugsnag, κλπ.)
- ❌ CDNs για assets.
- ❌ Third-party APIs.
- ❌ Advertising networks.
- ❌ Social media widgets.

**Καμία αποστολή δεδομένων σε τρίτους. Καμία κοινοποίηση. Καμία πώληση.**

---

## 9. Τα Δικαιώματά σου

Επειδή το ECBF **δεν συλλέγει δεδομένα**, τα δικαιώματα τύπου GDPR (πρόσβαση, διόρθωση, διαγραφή, φορητότητα) **δεν έχουν εφαρμογή στα δεδομένα μας** — γιατί δεν κρατάμε δεδομένα σου.

Ωστόσο, έχεις **πλήρη τοπικό έλεγχο**:

- **Διαγραφή όλων των δεδομένων:** Απεγκατάσταση του extension → διαγράφονται όλα από `storage.local` και IndexedDB.
- **Εξαγωγή δεδομένων:** Μέσω του μενού «Εξαγωγή» (Bookmarks / Favicons / Encrypted backup / Encrypted plain).
- **Διαγραφή μεμονωμένων στοιχείων:** Μέσω του UI (delete card / folder).
- **Αλλαγή κωδικού:** Μέσω των ρυθμίσεων (options page).

---


## 10. Συμμόρφωση με Πρότυπα

- **Mozilla Add-ons Policy:** ✅ Πλήρης συμμόρφωση — 0 data collection.
- **Firefox `data_collection_permissions`:** Δηλώνεται `"required": ["none"]` στο `manifest.json`.
- **GDPR:** Δεν συλλέγονται προσωπικά δεδομένα → δεν υπάρχει υπεύθυνος επεξεργασίας δεδομένων.
- **CCPA:** Δεν πωλούνται δεδομένα → δεν υπάρχει «do not sell» obligation.

---

## 11. Άδεια Χρήσης

Το ECBF διανέμεται υπό την άδεια που δηλώνεται στη σελίδα του AMO.

Ο πηγαίος κώδικας είναι διαθέσιμος για έλεγχο (Mozilla review policy compliance).

---

**Ημερομηνία τελευταίας ενημέρωσης:** 18 Σεπτεμβρίου 2026
**Έκδοση πολιτικής:** 1.0