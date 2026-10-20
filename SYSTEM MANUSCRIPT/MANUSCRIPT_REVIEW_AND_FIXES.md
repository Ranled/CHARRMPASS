# CHARRMPASS Manuscript — Review & Fix Log

**Reviewed file:** `CHARRMPASS MANUSCRIPT.pdf` (147 pages)
**Cross-checked against:** `ARCHITECTURE.md`, `supabase/schema.sql`, the ESP32 sketches, and `SESSION_NOTES_2026-10-14.md`
**Companion file:** `CHAPTER_IV_SYSTEM_MODULES_FIXED.md` (the ready-to-paste Chapter IV, plus replacement text for Chapters I, III and V)

Priority: 🔴 Critical (a panel will catch it, or it makes a claim false) · 🟠 Important · 🟡 Polish

---

## 0. Where the manuscript stands

| Section | Status |
|---|---|
| Chapter I (Introduction) | ✅ Mostly written. Has technical and consistency errors (see §1). |
| Chapter II (RRL) | ✅ Written. Has citation and structure gaps (see §2). |
| Chapter III (Methodology) | ⚠️ Written, but the sampling, tense, SDLC and prototype parts contradict each other (see §3). |
| Chapter IV (Results) | ❌ Still the blank template. This is the biggest gap. The corrected version is in the companion file. |
| Chapter V (Conclusions) | ❌ Still the blank template. A fillable version is in the companion file. |
| Front matter, References, Appendices | ❌ Template text is still in place (see §5). |

---

## 1. Chapter I — Introduction

| # | Pri | Issue (page) | Fix |
|---|---|---|---|
| 1.1 | 🔴 | **The RFID technology is described wrongly.** Definitions and RRL (pp. 21–22, 27–28, 38, 43, 54) say people use *"low-frequency (LF) RFID cards"* and the "Passive LF RFID Tag" is defined. The implemented gates use an **MFRC522 reader at 13.56 MHz, ISO/IEC 14443-A (HF/MIFARE)**. Vehicles use a **UHF 860–960 MHz long-range reader** (`esp32_rfid_long_range.ino`). There is no LF (125 kHz) hardware. | Replace every "LF" with "HF (13.56 MHz)". Replace the definition with the one in the companion file, §A. Check the hardware table (§3.7) with your adviser. |
| 1.2 | 🔴 | **The security claims are stronger than the implementation** (p. 11–12: "secured through Row Level Security (RLS), JWT-based authentication and RBAC"). In the repo, `supabase/schema.sql` enables RLS but every policy is `FOR ALL USING (true)`, so it is effectively open to anyone holding the anon key. `system_accounts.password` is a plain `TEXT` column, and `supabase-config.js` uses `persistSession:false` (custom login, not Supabase Auth/JWT). | **Either fix the system** (Supabase Auth with JWT, hashed passwords, restrictive policies by role) **or soften the manuscript** to "role-based access control implemented at the application level with HTTPS transport encryption". Do not claim JWT/RLS if it is not enforced. This also affects the Security evaluation (Confidentiality, Authenticity). |
| 1.3 | 🔴 | **Respondent numbers conflict.** p. 13 says the *preliminary interview* covered 150 respondents, but lists "1 university student council and 1 security personnel". p. 13 also contains a stray ellipsis "(1) security personnel……" and "7 faculties". The same 150 is later the *evaluation* sample. | State separately: (a) the preliminary-needs sample, with the actual number interviewed, and (b) the evaluation sample. Fix the grammar: "seven (7) faculty members, one (1) University Student Council officer, and one (1) security personnel". |
| 1.4 | 🔴 | **Dates are inconsistent.** The title page says December 2025, and the population is "A.Y. 2026–2027" (p. 76). | Use one timeline. Today is Oct 2026, so the title page date and A.Y. need to match your actual defense date. |
| 1.5 | 🟠 | **Tense is mixed** ("This study will focus…" next to "was limited to…", "did not cover…"). | Use *past tense* in the final paper (Chapters I, III, IV, V). Use "will" only in the proposal version. |
| 1.6 | 🟠 | **The population list omits "staff".** Objectives, scope and Module 1.1 include staff, but Table 2 has only Students, Faculty, USC Officers and Security Personnel. | Add staff/administrative personnel to the population, or remove "staff" from the objectives. |
| 1.7 | 🟠 | **Objective 1 lists 7 modules, but Chapter IV only has 4 module slots.** | Chapter IV must present all 7. The companion file already does. |
| 1.8 | 🟠 | **ISO 25010 is inconsistent.** Objective 2 lists 5 criteria (including Security), but the Chapter V results table omits Security. | Keep all 5 everywhere. |
| 1.9 | 🟠 | **There are too many theories (7).** General Systems, Automation, Database, Information Security, HCI, Usability and Agile. The "Information Security Principles" heading is announced but never developed. | Keep 4–5 and tie each to a module. Either write the Information Security section (CIA triad) or drop it. |
| 1.10 | 🟠 | **There is no algorithm figure** even though the "RFID-Based Verification Algorithm" is announced (p. 12). | Add the flowchart or pseudo-code from the companion file, §B. |
| 1.11 | 🟡 | **Weak sources in definitions:** Microsoft Learn (Emergency, User), Dahua Technology n.d. (Entry/Exit Monitoring), NSW Government n.d. | Prefer journal or standards sources. |
| 1.12 | 🟡 | **The expansion "Radio Frequency Identification (RFID)" appears dozens of times** in Chapters I–II. | Expand once, then use "RFID" (APA). |
| 1.14 | 🟠 | **Occupancy Tracking is built but not mentioned.** The live "Occupants Inside Campus" view is not in the objectives, Module 1.3 or the comparison matrix. | Add it as a sub-feature of Module 1.3: "...and track the individuals and vehicles currently inside the campus." Add a "Live Occupancy Tracking" row to the Prior-Arts matrix. Chapter IV Module 3 already covers it. |
| 1.13 | 🟡 | **Naming is inconsistent:** "CHARMPASS" (pp. 41–42), "ASU–Ibajay" and "Aklan State University - Ibajay". The ARCHITECTURE.md title also differs ("Campus Hybrid Automated RFID…"). | Standardize to **CHARRMPASS**. |

---

## 2. Chapter II — Review of Related Literature

| # | Pri | Issue | Fix |
|---|---|---|---|
| 2.1 | 🔴 | **Several studies are discussed without a citation:** Hasanuddin University barrier, "RFID: Applications, Security, and Privacy", the smart-campus door access (2FA + ABAC) study, the AVAC license-plate study, Ateneo RFID and MSEUF. | Add author and year in the text and the reference list. |
| 2.2 | 🔴 | **Galicia et al. (2021) is cited in the Synthesis but never reviewed.** | Add a review paragraph or remove it from the Synthesis. |
| 2.3 | 🟠 | **Topic labels are inconsistent.** The intro says "(1)…(5)" and "Topic A", the headings use Topic A–D, and the TOC says "Topic 1–5". A stray heading "Review of Related Literature" sits in the middle of Topic B (p. 48). | Use Topic A–D plus Synthesis, and rewrite the intro to match. Delete the stray heading. |
| 2.4 | 🟠 | **The "Prior-Arts Comparison Matrix" is incomplete** (pp. 50–53). The prior-art numbers are broken (e.g., "CN2135821 93", "IN20213104 8820"), the proposed-study column has no values, and there is no legend for 1/0 or totals. | Add a ✔/✘ legend and a CHARRMPASS column of ✔ for all 7 features. Show the counts per column. Appendix C.1–C.5 are empty and must be filled or removed. |
| 2.5 | 🟠 | **There is little local literature.** Most studies are foreign. | Add 3–5 Philippine studies (RFID/QR gate or campus monitoring) and the Data Privacy Act context. |
| 2.6 | 🟠 | **Offline operation is a key differentiator, but the RRL supports it only through Popa et al. (2026).** | Add a sentence in the Synthesis that links the gap to offline-first design. |
| 2.7 | 🟡 | Gap statements repeat the same sentence form for every study. | Vary the transitions. Keep the "present study differs by…" line short. |

---

## 3. Chapter III — Methodology

| # | Pri | Issue | Fix |
|---|---|---|---|
| 3.1 | 🔴 | **Sampling contradicts itself.** The text says *proportional allocation* (probability, stratified) and *purposive sampling*. These are different techniques. Also, 3,211/3,396 × 150 = 141.8, which rounds to **142**, not 141. The table was forced to total 150. | Use **stratified purposive** sampling, or state "proportional allocation with rounding adjusted to total 150". Show the Slovin or other basis for n = 150 (Slovin at e = 0.08 gives ≈149–150). |
| 3.2 | 🔴 | **Only 1 security guard and 1 USC officer evaluate the system.** The guard is the primary user, and a sample of 1 cannot support a weighted mean. | Use a census of the 12 guards plus admin staff. Add IT experts (≥ 5) for ISO 25010 technical items (typical practice). |
| 3.3 | 🔴 | **Table 2 and Table 3 are duplicates** (Table 3 is Table 2 without the percentage). | Merge into one. |
| 3.4 | 🔴 | **The SDLC conflicts across the paper.** Chapter III says Agile with 7 phases, the workplan has 6–7 phases with different names, ARCHITECTURE.md says Agile Scrum with 5 sprints, and the Chapter V template says "Waterfall". | Choose **Agile (iterative–incremental)** and map phases to sprints once (see companion §C). |
| 3.5 | 🔴 | **The prototype section is a draft:** "Include the QR Code", "Prototype (without Code)", a Figma link, and the heading "Figure: chcuucuc 1 System Flow Diagram" (garbled). The system is already built. | Replace the Figma with real screenshots and a live URL/QR. Fix the figure caption and numbering (two figures are called "Figure 1"). |
| 3.6 | 🔴 | **The interface walkthrough covers only 5 of 7 modules.** It shows Registration, Login, Guard live scan, Scan Logs, Admin analytics, User Management, Approval and Settings. There are **no screens for Visitor, Emergency, Offline and Reporting**. | Add screenshots for each (see Chapter IV evidence list). |
| 3.7 | 🟠 | **The hardware list is not matched to what is built.** It lists ESP32, RFID card, LCD, jumper wires, breadboard, SD module and an RFID module. The UHF reader, buzzer/LED and gate actuator are missing. Also, "SDHC… holds up to 4 gigabytes" is wrong (SDHC is 4–32 GB). | Add a table of Component / Model / Purpose / Quantity (the MFRC522, UHF reader, ESP32, I2C 16×2 LCD, microSD module, buzzer, LEDs). Fix the SD description. |
| 3.8 | 🟠 | **The DFD and flow diagram are only captions.** Nothing is described. | Add a Context diagram, Level-1 DFD, ERD (schema has 7 tables), architecture diagram (use the ARCHITECTURE.md mermaid) and an offline-sync flowchart. |
| 3.9 | 🟠 | **There are no objective tests,** only a perception survey. ISO 25010 Performance, Reliability and Security are measurable. | Add a *Technical Testing* subsection: scan-to-log latency, read success rate, offline-to-cloud sync completeness, uptime and role-access tests. Report these before the survey results. |
| 3.10 | 🟠 | **The instrument items are only ISO definitions** (e.g., "Time behaviour – Degree to which…"). Respondents cannot rate these. | Rewrite each as a statement (see companion §D). Add instrument reliability (Cronbach's α ≥ 0.70) and the content-validity method (e.g., CVI). |
| 3.11 | 🟠 | **The statistics are inconsistent:** one page lists "frequency, percentage, weighted mean and standard deviation", another omits SD. The Likert tables are pre-filled with "Neutral". | List all four everywhere and blank the interpretation cells. Number the tables continuously. |
| 3.12 | 🟠 | **The inclusion criteria are referred to but never defined.** | Define them (e.g., ASU-Ibajay member, ≥ 18 yrs, has used the gate/system, gave consent). |
| 3.13 | 🟡 | **Table numbers collide** (Table 1–5 in the Chapter III instruments vs Table 1 matrix, Tables 2–3 respondents). | Use one continuous series (see the List of Tables). |
| 3.14 | 🟡 | **The Workplan Gantt is garbled in text.** | Rebuild it as a clean table (Phase × weeks). |

---

## 4. Chapters IV–V

| # | Pri | Issue | Fix |
|---|---|---|---|
| 4.1 | 🔴 | **Chapter IV is still the unfilled template** (blanks, "(Insert screenshot)"). | Use `CHAPTER_IV_SYSTEM_MODULES_FIXED.md`. Insert screenshots and survey values only after data collection. |
| 4.2 | 🔴 | **Chapter V is the unfilled template** and says "Waterfall". | Use the companion's Chapter V. |
| 4.3 | 🔴 | **Don't invent results.** Weighted means must come from the real survey. | Leave `[__]` until data are in. |
| 4.4 | 🟠 | **Known limitations are not reported.** From the session notes: users who forget to tap out remain "inside" campus, and the banner color is confusing. | State these in the Limitations and Recommendations. |

---

## 5. Front matter, references, appendices

| # | Pri | Issue | Fix |
|---|---|---|---|
| 5.1 | 🔴 | **Approval Sheet:** still "TITLE", "NAMES", "Research Code ____". | Fill in. |
| 5.2 | 🔴 | **Acknowledgment:** the instruction text is still there, plus informal text ("ALL THANKS TO RAIAN. TO RAIAN ULIT…") and "(e.g. D. G. R.)". | Rewrite formally, thanking adviser, panel, ASU-Ibajay, respondents, family, and God. Sign with the initials of all four authors. |
| 5.3 | 🔴 | **Abstract:** template text. | Write 150–250 words (see companion §E). |
| 5.4 | 🔴 | **References** is the blank APA template. Many in-text citations are not listed (NEDA 2016, UN 2015, von Bertalanffy 1968, Groover 2015, Elmasri & Navathe 2016, Dix 2004, Beck 2001, ISO 2018, Wahi 2024 and more). | Build the full APA 7 list, and cross-check every in-text citation. |
| 5.5 | 🟠 | **The TOC / List of Tables / List of Figures** are placeholders ("Title of Table"). The TOC page numbers (Ch. I = 1, Ch. IV = 52) do not match the document (Ch. I at PDF 11, Ch. IV at 93). | Regenerate with the Word auto-TOC after finalizing. |
| 5.6 | 🟠 | **Appendix letters are duplicated** (K and L appear twice; the list says A–Q but the body has different titles). | Re-letter A–N in the order they appear. |
| 5.7 | 🟠 | **Appendix B (questionnaire)** has "<Criteria 1 Name>" placeholders. | Insert the final instrument (companion §D). |
| 5.8 | 🟡 | **Three identical CV templates** are unfilled. | Fill in one CV per author. |

---

## 6. Suggested order of work

1. Decide the **hardware truth** (HF vs UHF) and the **security claim** (fix the system or the text). These two are the biggest.
2. Fix Chapter III sampling, SDLC and the instrument.
3. Paste in the fixed Chapter IV modules and add screenshots.
4. Run the technical tests and the survey, then fill in the evaluation tables.
5. Finish Chapter V, the abstract, the references and the front matter.
