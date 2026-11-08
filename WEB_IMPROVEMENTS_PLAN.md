# CHARRMPASS — Web Bug Fix, Security & Efficiency Roadmap

> **Status:** ✅ **All Phases Implemented & Verified (2026-11-08)** — `47/47` assertions passing in `scratch/verify_web_fixes.js` + `58/58` assertions passing in `scratch/verify_dual_uhf.js`.
> **Purpose:** Persistent engineering backlog created from the full codebase audit on **2026-11-07**.
> **Companion Audit Artifact:** Detailed explanations are also recorded in the session audit report (`web_audit_and_improvements.md`).

---

## Phase 1 — Critical Runtime Crashes & Broken Interactive Controls (P0)

### 1.1 Guard Portal (`guard-app.js` & `guard-dashboard.html`)
- [x] **Fix Visitor Check-In Crash (`ReferenceError: el is not defined`) & Modal Reset Race**
  - **Files:** `guard-app.js`
  - **Fix:** Defined `const el = (id) => document.getElementById(id);` at the top of `confirmVisitorEntry()`, captured and cleared `visitorPendingUid = null` *before* calling `closeVisitorModal()`, and updated both single and `Dual` Entry status elements cleanly.
- [x] **Fix Guard Credential Save SQL Crash (`42P10`)**
  - **Files:** `guard-app.js`, `guard-dashboard.html`, `supabase/schema.sql`, `supabase/migrations/20261107_security_storage_and_fixes.sql`
  - **Fix:** Wired `#settingsModal` to `saveGuardSettings()` targeting the logged-in guard's account via `upsertSystemAccount()` (with graceful PostgREST fallback by `id` / `username`).
- [x] **Fix Guard `#btnDeny` Handler (`ReferenceError` & Legacy DOM IDs)**
  - **Files:** `guard-app.js`
  - **Fix:** Tracked active scan context per lane (`lastGateScanContext`), implemented `handleGuardDenyOverride()`, updated the transaction row to `status = 'DENIED'` in Supabase, and reset the active scanner cleanly.
- [x] **Add Missing `closeSlotModal()` Function**
  - **Files:** `guard-dashboard.html`, `guard-app.js`
  - **Fix:** Implemented `window.closeSlotModal` in `guard-app.js` and added `#toast-container` + RBAC session enforcement in `guard-dashboard.html`.

### 1.2 Admin Portal (`admin-app.js` & `admin-dashboard.html`)
- [x] **Replace `encodeURI` Data-URI CSV Exports with `Blob` + `URL.createObjectURL` (All 5 Exports)**
  - **Files:** `supabase-config.js`, `admin-app.js`
  - **Fix:** Created shared `downloadCsvBlob(filename, csvString)` prepending UTF-8 BOM (`\uFEFF`) via `Blob` + `URL.createObjectURL()`, fixing `#` hash truncation across all 5 CSV exports.
- [x] **Implement `viewFullImage()` & Remove Broken `via.placeholder.com` Fallbacks**
  - **Files:** `admin-dashboard.html`, `admin-app.js`, `entry-dashboard.html`, `exit-dashboard.html`, `entry-app.js`, `exit-app.js`
  - **Fix:** Exposed `window.viewFullImage(src)` opening `#zoomModal` and replaced all broken `https://via.placeholder.com` URLs with offline-ready inline SVG data URIs (`getInlinePlaceholderSvg()`).
- [x] **Fix Dead `initAdminState()` Call in `setupAdminRealtime()`**
  - **Files:** `admin-app.js`
  - **Fix:** Replaced dead `initAdminState()` check with debounced `debouncedLoadData()` + incremental Realtime transaction handling.
- [x] **Fix Inline `onclick` Apostrophe `SyntaxError` Across Dynamic Tables**
  - **Files:** `supabase-config.js`, `admin-app.js`
  - **Fix:** Added `uriAttr(val)` encoding `'` as `%27` across all dynamic table `onclick` handlers (`insideCampusTable`, `userLeaderboardTable`, `specialTagsTable`, `visitorHistoryTable`, `usersTable`).
- [x] **Fix Modal Print CSS (`#reviewModal` & `#userHistoryModal`)**
  - **Files:** `admin-dashboard.html`, `admin-app.js`
  - **Fix:** Added scoped `@media print` rules for `body.printing-review-modal` and `body.printing-user-history` plus `printWithBodyClass()` with `afterprint` cleanup.
- [x] **Wire Up `#generateReportModal` & Historical Report Row Actions**
  - **Files:** `admin-dashboard.html`, `admin-app.js`
  - **Fix:** Connected `"Custom Report Builder"` button to `openReportModal()`, honored portrait/landscape orientation and summary/logs section toggles, and implemented `restoreAndActOnHistoryReport()` for historical audit trail rows.

### 1.3 Entry/Exit Kiosks, Settings & Edge Function (`entry-app.js`, `exit-app.js`, `settings.html`, `supabase/functions/rfid-scan/index.ts`)
- [x] **Fix Kiosk Sign-Out (`doLogout`) & Stuck `btnLogin` State**
  - **Files:** `entry-app.js`, `exit-app.js`
  - **Fix:** Cleared `sessionStorage`/`localStorage` session keys and unsubscribed Realtime channels in `doLogout()`, and restored `btnLogin` inside `finally`.
- [x] **Persist Kiosk `denyLast()` to Supabase**
  - **Files:** `entry-app.js`, `exit-app.js`
  - **Fix:** Updated `transactions` row in Supabase (`status: 'DENIED'`, `remarks: 'Denied by guard manual override'`) and refreshed campus occupancy counts.
- [x] **Unify & Implement Audio Feedback Settings**
  - **Files:** `supabase-config.js`, `settings.html`, `guard-app.js`, `entry-app.js`, `exit-app.js`
  - **Fix:** Standardized Web Audio API chime synthesis (`playGateAudio('entry' | 'denied' | 'duplicate')`) governed by unified `getCharrmpassSettings()`.
- [x] **Fix Edge Function `deno lint` / `deno check` Errors & `ENTRY_EXIT` Constraint Crash**
  - **Files:** `supabase/functions/rfid-scan/index.ts`
  - **Fix:** Replaced `as any` with typed `RfidCardRow`/`VehicleRecord`/`UserRecord` interfaces, typed `catch (error: unknown)`, normalized `ENTRY_EXIT`/`BIDIRECTIONAL` to `'ENTRY'`/`'EXIT'` from prior session state, and formatted LCD clocks in `Asia/Manila`.

---

## Phase 2 — Security, Privacy & Access Control Hardening (P0/P1)

- [x] **Purge `database_backup_before_deploy.json` from Git Tracking & Block Static Exposure**
  - **Files:** `.gitignore`, `.vercelignore`
  - **Fix:** Untracked `database_backup_before_deploy.json` from Git (`git rm --cached`), added `*backup*.json` to `.gitignore`, and created `.vercelignore` excluding backups, SQL dumps, firmware, and scratch scripts from static deployment.
- [x] **Close Guard-to-Admin Privilege Escalation & Input Wipe on `settings.html`**
  - **Files:** `settings.html`
  - **Fix:** Enforced RBAC via `enforceAuthSession()`, stripped `#adminSecuritySection` from DOM for non-admins, blocked non-admins from saving Admin credentials, removed password prefilling, and removed the 30s `supabase:connected` input-wipe listener.
- [x] **Eliminate Stored/DOM XSS Across Dynamic Tables & Toasts**
  - **Files:** `supabase-config.js`, `admin-app.js`, `guard-app.js`, `register.js`, `entry-app.js`, `exit-app.js`, `settings.html`
  - **Fix:** Added global `escapeHtml(str)`, switched `showToast()` message rendering to `textContent`, and escaped dynamic stakeholder/vehicle/visitor/BLE/CSV fields before `.innerHTML` interpolation.
- [x] **Harden Authentication, Session Enforcement & RLS Policies**
  - **Files:** `supabase-config.js`, `index.html`, `admin-dashboard.html`, `guard-dashboard.html`, `admin-app.js`, `supabase/schema.sql`, `supabase/migrations/20261107_security_storage_and_fixes.sql`
  - **Fix:** Removed hardcoded client-side `MASTER_RECOVERY_KEY` and cleartext password display, added 12-hour RBAC session expiration across portals, moved `system_accounts` auth/CRUD/recovery into `pgcrypto` bcrypt `SECURITY DEFINER` RPCs (`REVOKE ALL ON public.system_accounts FROM anon`), and blocked `anon` `DELETE` on `transactions` while preserving ESP32 `anon` REST operations.

---

## Phase 3 — Timezone (`Asia/Manila`), Occupancy & Business Logic Accuracy (P1)

- [x] **Eliminate 8-Hour Morning Blindness (`UTC` vs `Asia/Manila` `UTC+8`)**
  - **Files:** `supabase-config.js`, `admin-app.js`, `guard-app.js`
  - **Fix:** Added `getManilaDateKey()`, `getManilaDateParts()`, `getManilaDayBoundsIso()`, and `getManilaPresetBounds()` (`UTC+8`), eliminating all unshifted UTC `.toISOString().slice(0, 10)` date filters.
- [x] **Fix Guard Realtime Self-Feedback Loop & `[AUTO_RESOLVED_EXIT]` False Exit UI**
  - **Files:** `guard-app.js`
  - **Fix:** Added `localInsertedTxnIds` deduplication to suppress Realtime self-echoes on Guard/Visitor scans and filtered synthetic `[AUTO_RESOLVED_EXIT]` rows from triggering physical Exit radar animations or inflating physical Exit KPIs.
- [x] **Unify Campus Occupancy Across All Views via `get_active_inside_entities()`**
  - **Files:** `supabase/schema.sql`, `supabase/migrations/20261107_security_storage_and_fixes.sql`, `admin-app.js`, `guard-app.js`, `exit-app.js`
  - **Fix:** Unified `#adminStatInside`, Analytics Inside Roster, Visitor Hub, Guard Dashboard, and Exit Kiosk around enriched `get_active_inside_entities()` (with local chronological fallback) and updated `resetSpecialTagToVacant()` to close open campus `ENTRY` sessions.
- [x] **Replace Fabricated Analytics Multipliers, Fake Denial Row & Report `[AUTO_RESOLVED_EXIT]` Inflation**
  - **Files:** `admin-app.js`
  - **Fix:** Replaced fabricated weekly/monthly multipliers and fake `'Invalid Access Direction': 1` with real `Asia/Manila` transaction bucketing, preserved real gate names in Official Reports, and separated synthetic auto-resolved exits from physical Gate Exits.
- [x] **Fix Multi-Vehicle RFID Card Approval & Registration Validation Bugs**
  - **Files:** `admin-app.js`, `register.html`, `register.js`, `supabase/migrations/20261107_security_storage_and_fixes.sql`
  - **Fix:** Scoped `approveUser()`, `denyRegistration()`, and `switchReviewRfidType()` to `vehicleId` for multi-vehicle owners; aligned `15–100` age validation; blocked reserved `CP##` IDs; switched to parameterized `.eq()` lookups; released camera `MediaStream` tracks on close; added front/rear `flipCamera()`; raised ID/OR-CR capture quality to `1000px @ 0.82`; and made `generate_cpass_id()` collision-safe.

---

## Phase 4 — Database, Network & Frontend Efficiency Upgrades (P1/P2)

- [x] **Provision Supabase Storage Buckets & Migrate Base64 Blobs**
  - **Files:** `supabase/schema.sql`, `supabase/migrations/20261107_security_storage_and_fixes.sql`, `scratch/migrate_base64_to_storage.js`
  - **Fix:** Added idempotent `avatars`, `documents`, and `vehicles` Storage buckets + RLS policies in SQL and created `scratch/migrate_base64_to_storage.js` (`--dry-run` supported) to migrate existing Base64 rows to Storage URLs.
- [x] **Stop 30-Second Full-Database Reload Storm & Duplicate Realtime Channels**
  - **Files:** `supabase-config.js`, `admin-app.js`, `guard-app.js`
  - **Fix:** Emitted `supabase:connected` only on initial connect or offline-to-online recovery, removed duplicate `setupRealtime()` (`admin-sync`), and switched Realtime `transactions` updates to incremental state patching.
- [x] **Add Partial Composite Index, Server-Side Date Filtering & Batch Bulk Import**
  - **Files:** `supabase/schema.sql`, `supabase/migrations/20261107_security_storage_and_fixes.sql`, `admin-app.js`
  - **Fix:** Added `idx_transactions_uid_auth_ts`, added `fetchTransactionsForRange()` server-side `.gte/.lte` queries for Reports/Analytics/User History, and converted `executeBulkImport()` to 50-row bulk insert chunks.
- [x] **Optimize Static Media, Service Worker, Chart.js & Table Rendering**
  - **Files:** `icon-192.png` (`30 KB`), `icon-512.png` (`155 KB`), `manifest.json`, `index.html`, `styles.css`, `sw.js`, `admin-app.js`
  - **Fix:** Generated lightweight `icon-192.png` and `icon-512.png` (replacing `6.54 MB` `logocharrmpark.png` across favicons/PWA/reports), added `preload="metadata"` on `INTRO_VIDEO.mp4`, reduced stacked GPU blur cost, precomputed O(1) `onCampusCache`, added 50-row `#usersTable` pagination, disabled redundant Chart.js re-animations, and upgraded `sw.js` (`v3`) with protocol/video Range guards and clean-URL support.
