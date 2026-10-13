# CHARRMPASS — Session Notes & Roadmap (October 14, 2026)

## 📌 Summary of Work Completed Today

### 1. Codebase Pushed to GitHub
- Pushed recent updates on `main` branch: occupant tracking, pedestrian detection, gate naming consistency (`CHARRMPASS_GATE_ENTRY` / `CHARRMPASS_GATE_EXIT`), and local data audit rules in `.gitignore`.

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

---

## 🧠 Brainstorming: Handling Students Who Forgot to Exit

### The Core Problem:
Students frequently leave campus without tapping out (walking through open vehicle gates, following friends, or rushing out). Because there is no matching `EXIT` transaction, they stay listed in the **"Occupants Inside Campus"** roster indefinitely (accumulating 50+ hours inside).

### The Critical Catch: Hostel / Dormitory Residents
- Commuter students go home every afternoon.
- **Hostel / Dorm students sleep on campus** for days or weeks. A flat 12-hour timeout would wrongly remove dorm students while they are genuinely inside.

---

## 🚀 Recommended Solutions for Tomorrow

### Option A: "Self-Healing" Next-Day Re-Entry *(Recommended - Zero Timers)*
- When a student taps at the **Entry Gate**:
  - If their previous recorded transaction was an unclosed `ENTRY` from yesterday or days ago:
  - The system recognizes they entered previously without logging an exit.
  - Automatically marks the old session as `AUTO_RESOLVED_EXIT` (or logs a virtual exit) and opens the new entry.
- **Why it works**: Works identically for commuters and hostel students without guessing or using arbitrary timers.

### Option B: Commuter vs. Resident (Hostel) Classification
- Add a resident tag / role check (e.g., `role_detail = 'Hostel Resident'`).
- **Commuters**: Expire from the active roster after 16–20 hours if no exit is recorded.
- **Hostel Residents**: Remain inside until they physically exit or re-enter.

### Option C: Admin Dashboard "End-of-Day Sweep" & Overnight Badges
- In [`admin-dashboard.html`](file:///c:/Users/User/Desktop/THESIS%20-%20CHARRMPASS/admin-dashboard.html#L890-L910) on the Inside Campus roster:
  - Add duration badges:
    - 🟢 `Active (< 12h)`
    - 🟡 `Overnight / Hostel (12h - 48h)`
    - 🔴 `Unclosed Visit (> 48h)`
  - Add a **"Clear Overnight Roster"** button or individual **"Sign Out"** button per row for manual administrative control.

---

## 📋 Checklist for Tomorrow
- [ ] Review Option A vs Option C.
- [ ] Decide whether to add a "Hostel Resident" field to user profiles.
- [ ] Implement self-healing re-entry logic in `guard-app.js` and/or Supabase Edge functions if desired.
- [ ] Test the 30-second debounce on the physical ESP32 boards.
