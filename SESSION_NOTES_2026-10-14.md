# CHARRMPASS — Session Notes & Roadmap (October 14, 2026)

## 📌 Summary of Work Completed Today

### 1. Codebase Pushed to GitHub
- Pushed recent updates on `main` branch (`1c9b019`): occupant tracking, pedestrian detection, gate naming consistency (`CHARRMPASS_GATE_ENTRY` / `CHARRMPASS_GATE_EXIT`), and local data audit rules in `.gitignore`.

### 2. Firmware Anti-Passback Fix (30-Second Debounce)
- **Problem**: When users entered, left campus, and returned later, both the Entry and Exit ESP32 gates permanently denied them with `"ALREADY INSIDE"` or `"ALREADY EXITED"` because local in-memory RAM arrays (`ramInsideList` and `ramRecentExits`) returned `true` forever.
- **Solution Applied**: Changed the local duplicate check to a **30-second debounce window** in both sketches:
  - [`esp32_rfid_exit/esp32_rfid_exit.ino`](file:///c:/Users/User/Desktop/THESIS%20-%20CHARRMPASS/esp32_rfid_exit/esp32_rfid_exit.ino#L1398-L1420)
  - [`esp32_rfid_entry/esp32_rfid_entry.ino`](file:///c:/Users/User/Desktop/THESIS%20-%20CHARRMPASS/esp32_rfid_entry/esp32_rfid_entry.ino#L1289-L1312)
- **Behavior Now**:
  - Double-tapping the **exact same card** within 30 seconds is blocked with `"Wait Xs"` (stops rapid duplicate scans/motor triggers).
  - Tapping again after 30 seconds (or returning hours later) is **allowed**.
  - Throughput between **different cards** remains fast at **0.8 seconds**.
- **Status**: Committed & pushed to GitHub (`f4d697e`).

### 3. Safely Cleared Inside Occupants (Zero Data Loss)
- Executed an administrative sweep that closed 14 unclosed entries from Oct 12–13.
- **No data was deleted**: All 690 original historical `ENTRY` transactions remain 100% intact.
- Backup saved to `cleared_inside_records_backup_20261014.json`.
- Current open entries inside campus: **`0`**.

---

## 🔍 Investigation: The "Yellow Sign" Issue on Scan

### The Issue Observed:
On the Guard Dashboard, after scanning, a yellow banner appears stating:
- At Entry: *"Previous exit logged at 5:30 PM"*
- At Exit: *"Entry logged at 5:30 PM"*

### What Causes This?
1. **History Lookup Feature**: In [`guard-app.js` (lines 1155–1161)](file:///c:/Users/User/Desktop/THESIS%20-%20CHARRMPASS/guard-app.js#L1155-L1161), whenever someone scans, the system queries their **previous transaction** (`lastTxn`) and displays when they were last at the gate.
2. **Hardcoded Yellow/Amber CSS**: In [`guard-dashboard.html` (lines 267, 564)](file:///c:/Users/User/Desktop/THESIS%20-%20CHARRMPASS/guard-dashboard.html#L267), the banner element (`resHistoryBanner`) is permanently styled with:
   ```html
   bg-amber-50 border-amber-300 text-amber-900
   ```
   Because it is colored in **amber/yellow**, it visually looks like an **alert / warning / error**, even though the scan was 100% verified and authorized!
3. **Missing Date Context**: The banner only displays the time (e.g. `5:30 PM`) using `toLocaleTimeString`, without stating whether that 5:30 PM was **today**, **yesterday**, or **days ago**, confusing guards and users.

### Status: ✅ RESOLVED (Oct 16, 2026)
- **Fixed wording**:
  - At Exit: *"Exit logged at [time]"* (previously erroneously showed *"Entry logged at [time]"*).
  - At Entry: *"Entry logged at [time]"*.
- **Dynamic Theming**:
  - Normal `VERIFIED` passes now show in matching theme colors: **Emerald Green** for Entry and **Sky/Blue** for Exit, eliminating confusion with warning alerts.
  - The warning **Amber / Yellow** styling is now reserved exclusively for actual duplicate / conflict alerts (`RE-LOGIN`, `RE-EXIT`, `NO ENTRY RECORD`).

---

## 🧠 Brainstorming: Handling Students Who Forgot to Exit

### The Core Problem:
Students frequently leave campus without tapping out (walking through open vehicle gates, following friends, or rushing out). Because there is no matching `EXIT` transaction, they stay listed in the **"Occupants Inside Campus"** roster indefinitely.

### The Critical Catch: Hostel / Dormitory Residents
- Commuter students go home every afternoon.
- **Hostel / Dorm students sleep on campus** for days or weeks. A flat 12-hour timeout would wrongly remove dorm students while they are genuinely inside.

---

## 🚀 Implemented Solution: Option A ("Self-Healing" Next-Day Re-Entry)
- **Status**: ✅ **IMPLEMENTED & DEPLOYED**
- **How it works**:
  - When a student taps at the **Entry Gate**:
    - If their previous recorded transaction was an unclosed `ENTRY` (> 30s debounce):
    - The system detects they left campus previously without logging an exit.
    - **Self-Healing Resolution**: Automatically logs an `[AUTO_RESOLVED_EXIT]` transaction right before the new entry, pairing and closing the previous phantom visit.
    - **Immediate Access**: Authorizes the new `ENTRY` pass without delay or manual guard override.
- **Why it is superior**:
  - **Zero timers**: No arbitrary cron jobs or timeouts that prematurely expel dorm/hostel students.
  - **100% Data Integrity**: Retains full audit logs; does not delete history.
  - **Multi-layer defense**:
    1. Edge Function (`supabase/functions/rfid-scan/index.ts`)
    2. Guard Station Dashboard (`guard-app.js`)
    3. Entry Kiosk App (`entry-app.js`)
    4. Database Trigger (`supabase/schema.sql` `trg_self_healing_reentry`)
    5. Admin Audit Trail (`admin-app.js` with `AUTO EXIT` badge)

---

## 📋 Checklist
- [x] Fix the Yellow History Banner styling in `guard-dashboard.html` / `guard-app.js` (dynamic Emerald Green for Entry, Sky Blue for Exit).
- [x] Implement Option A: "Self-Healing" Next-Day Re-Entry (Zero Timers) across database trigger, Edge Function, Guard Station, Entry Kiosk, and Admin Dashboard.
- [x] Test 30-second debounce window on Entry & Exit gates.
