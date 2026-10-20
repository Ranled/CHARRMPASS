# CHARRMPASS — Fixed Manuscript Sections (Paper Format)

> Ready to paste into the Word manuscript. Past tense is used for the final paper.
> `[Figure X]` marks where a screenshot goes. `[__]` marks values that must come from your real survey or tests. Do not invent them.
> Items marked ⚠ VERIFY need confirmation against your actual hardware or deployment.

---

## A. Replacement definitions (Chapter I – Definition of Terms)

**HF RFID Card (13.56 MHz).** Refers to a passive RFID tag that operates at 13.56 MHz and communicates with a reader through near-field inductive coupling under ISO/IEC 14443-A, without an internal battery (Finkenzeller, 2010). In this study, an HF RFID Card refers to the card issued to a registered individual and read by the MFRC522 reader at the campus gate for identification and verification.

**UHF RFID Tag.** Refers to a passive tag that operates in the 860–960 MHz range and can be read from a distance of several meters (Laheurte et al., 2014). In this study, a UHF RFID Tag refers to the tag attached to a registered vehicle and read by the long-range UHF reader at the vehicle gate. ⚠ VERIFY the vehicle-tag arrangement.

*(Delete the "Passive LF RFID Tag" entry. Replace "low-frequency RFID cards" with "HF (13.56 MHz) RFID cards" throughout Chapters I and II.)*

---

## B. Fixed text for the "RFID-Based Verification Algorithm" (Theoretical Framework, p. 12)

The system applied a rule-based verification algorithm, shown in Figure __. When a card or tag was presented, the gate unit read its unique identifier (UID) and applied the following rules in order:

1. **Cooldown check.** A repeated scan of the same UID within the cooldown window was ignored to prevent duplicate logs.
2. **Emergency rule.** If the UID matched an *Emergency* special tag, access was granted unconditionally and logged.
3. **Visitor rule.** If the UID matched a *Visitor* special tag, access was granted and logged as a visitor transaction.
4. **Registered-member rule.** If the UID was linked to a record whose status was *AUTHORIZED*, access was granted and the owner's information was displayed.
5. **Denial rule.** If the status was *PENDING* or *DENIED*, or the UID was unknown, access was denied and the attempt was logged.
6. **Offline rule.** If the cloud database was unreachable, rules 2–4 were evaluated against a whitelist cached on the gate's microSD card, and the transaction was stored locally until synchronization.

```
START → Scan UID → Cooldown active? ─Yes→ Ignore
                         │No
                  Cloud reachable? ─No→ Check SD whitelist → Grant/Deny → Save to SD log
                         │Yes
              Emergency tag? ─Yes→ GRANT
                         │No
               Visitor tag? ─Yes→ GRANT (visitor)
                         │No
        Registered & AUTHORIZED? ─Yes→ GRANT
                         │No
                       DENY → Log transaction → Show result (LCD/LED/buzzer + dashboard)
```

---

## C. Fixed SDLC statement (Chapter III)

The study adopted the **Agile (iterative–incremental) model**. Development was organized in five sprints (Table __):

| Sprint | Focus | Corresponding system module(s) |
|---|---|---|
| 1 | Database design and registration | Module 1 |
| 2 | ESP32 and RFID hardware prototype | Module 2 |
| 3 | Dual-gate operation and real-time dashboards | Module 3 |
| 4 | Visitor/Emergency tags and microSD offline failover | Modules 4, 5, 7 |
| 5 | Analytics, reports and system hardening | Module 6 |

Requirements analysis and planning were carried out before Sprint 1. Testing was done at the end of every sprint. Deployment, evaluation and maintenance followed Sprint 5.

*(Remove "Waterfall" from the Chapter V template and make the 7-phase and 6-phase lists agree with this table.)*

---

## D. Fixed instrument items (Chapter III and Appendix B)

Rate each statement: 5 = Strongly Agree/Very Satisfied … 1 = Strongly Disagree/Very Unsatisfied.

**Functional Suitability**
1. The system provides all the functions needed to register users and vehicles, verify access and record entry and exit. *(completeness)*
2. The system correctly identifies registered cards/tags and correctly records ENTRY/EXIT, time and status. *(correctness)*
3. The functions of the system make gate monitoring tasks easier to complete. *(appropriateness)*

**Performance Efficiency**
4. The system verifies a scan and shows the result within an acceptable time. *(time behaviour)*
5. The system and gate devices run smoothly without using excessive resources. *(resource utilization)*
6. The system continues to work when many scans and records are present. *(capacity)*

**Reliability**
7. The system performs its functions without errors during normal use. *(faultlessness)*
8. The system is available whenever it is needed at the gate. *(availability)*
9. The gate keeps working when the internet is unavailable. *(fault tolerance)*
10. Records are restored and synchronized after an interruption. *(recoverability)*

**Security**
11. Only authorized users can view personal and vehicle information. *(confidentiality)*
12. Records cannot be altered or deleted without authorization. *(integrity)*
13. Every entry and exit can be proven by a stored record. *(non-repudiation)*
14. Actions in the system can be traced to a specific user or gate. *(accountability)*
15. Users must prove who they are before using the system. *(authenticity)*
16. The system keeps operating when invalid or unauthorized scans are attempted. *(resistance)*

**Maintainability**
17. Parts of the system can be changed without affecting the other parts. *(modularity)*
18. Components, such as the gate unit or the web pages, can be reused. *(reusability)*
19. Problems can be located through logs and records. *(analysability)*
20. The system can be updated without causing new errors. *(modifiability)*
21. Functions can be tested easily. *(testability)*

Add Cronbach's α for each criterion and for the overall instrument (≥ 0.70 = acceptable).

---

## E. Fixed Abstract (Chapter front matter, 150–250 words)

> Manual logbook monitoring at Aklan State University–Ibajay Campus made it difficult to verify individuals and vehicles and to retrieve entry and exit records. This study developed CHARRMPASS, a web-based smart entry and exit monitoring system using Radio Frequency Identification (RFID) technology. The study used a descriptive-developmental design and the Agile model. The system integrates ESP32-based HF (13.56 MHz) and UHF RFID gate units, a cloud database, and web dashboards for guards and administrators. It has seven modules: Registration and Permit, RFID Identification and Access, Centralized Web Dashboard and Monitoring, Visitor Management, Emergency Exemption, Reporting, and Offline. The system was evaluated using five ISO/IEC 25010 characteristics: Functional Suitability, Performance Efficiency, Reliability, Security and Maintainability. [__] respondents, composed of students, faculty, staff and security personnel, were selected using [sampling technique]. Data were analyzed using frequency, percentage, weighted mean and standard deviation. The system obtained an overall weighted mean of [__], interpreted as [__]. The findings indicate that CHARRMPASS provides an organized and centralized approach to campus entry and exit monitoring. It is recommended that the campus adopt the system, strengthen its security configuration, and extend it with additional gates and notifications.
>
> **Keywords:** RFID, entry and exit monitoring, web-based system, ESP32, ISO/IEC 25010

---

# CHAPTER IV
# PRESENTATION, ANALYSIS AND INTERPRETATION OF DATA

This chapter presents the results of the study, the developed system modules, and the evaluation of the system. The discussion of the results is supported by the findings of the related literature and studies reviewed in Chapter II. The results are analyzed to determine how the developed system addresses the identified problems, needs and research gaps.

## SYSTEM MODULES

This section presents the seven major modules of CHARRMPASS: A Web-Based Smart Entry and Exit Monitoring System Using Radio Frequency Identification (RFID) Technology for Aklan State University–Ibajay Campus. Each module is presented through system evidence, followed by a discussion that relates its features to previous studies and to the research gap identified in Chapter II.

---

### Module 1: Registration and Permit Module

**(Evidence)**
*[Figure 3. Welcome page with "Sign In" and "Register Vehicle (Student / Faculty)".]*
*[Figure 4. Registration wizard: Personal Information; Photos and Documents; Vehicle Information; Review; Submitted.]*
*[Figure 5. Admin Approval page showing pending registrations and RFID pairing.]*

**(Discussion)**
The Registration and Permit Module was developed to replace handwritten identification with a digital record of each campus user and vehicle. It enables students, faculty and staff to submit their personal information, a live photo, ID images (front and back), a driver's license, and vehicle details (type, model, plate number and color) through a four-step registration wizard. Each submission is saved in the centralized database with a *PENDING* status. An administrator reviews the documents, pairs a physical RFID card or tag with the record, and sets the status to *AUTHORIZED* or *DENIED*.

The development of this module is supported by Masri and Ab. Aziz (2025), who reported a web-based RFID vehicle system for UTHM with user registration, secure login and vehicle and user information management. Similarly, Poh and Ngadengon (2021) emphasized that an automated vehicle access system needs a vehicle-user database that administrators can register and edit. However, Poh and Ngadengon recommended linking registered vehicle data with the official premises database, and Wahi (2024) addressed only student movement without vehicle permits. The present study addressed this gap by combining self-service online registration with an administrator approval step and RFID pairing, so only verified users and vehicles receive access. This reduces dependence on manual checking and gives the campus an organized permit record for later review.

---

### Module 2: RFID Identification and Access Module

**(Evidence)**
*[Figure 6. Entry and Exit gate unit (ESP32, MFRC522, LCD, LED and buzzer).]*
*[Figure 7. LCD and LED feedback for AUTHORIZED and DENIED scans.]*
*[Figure 8. Verification algorithm flowchart (Section B above).]*

**(Discussion)**
The RFID Identification and Access Module was developed to identify individuals and vehicles automatically and to decide whether access is permitted. It provides ESP32-based gate units that read the unique identifier (UID) of an HF (13.56 MHz) card through an MFRC522 reader and, for vehicles, a UHF long-range reader. The UID is checked against the database through the rule sequence in Figure 8 (emergency, visitor, authorized member, then denial). The result is shown to the person at the gate on an LCD, LEDs and a buzzer, and the transaction is saved with its direction (ENTRY or EXIT), gate, status and time. A cooldown period prevents duplicate logs when the same card is presented more than once.

This finding is consistent with Poh and Ngadengon (2021), whose UHF RFID system identified vehicles automatically and stored passage data, and with Wang et al. (2022), who reported 99.83% accuracy in movement-direction detection. The study of Hasanuddin University also showed that card identification could operate a parking barrier with an average response time of 0.373 seconds. Despite these developments, previous studies were limited to a single entrance prototype or to one type of user. The present study addressed this limitation through separate entry and exit gate units, one rule hierarchy for individuals and vehicles, and a record for every attempt, including denied ones. This allows the system to verify authorized access consistently at both gates.

---

### Module 3: Centralized Web Dashboard and Monitoring Module

**(Evidence)**
*[Figure 9. Guard Live Scan Monitor (recent scans, counts, scanner status, photo match).]*
*[Figure 10. Scan Logs and History.]*
*[Figure 11. Admin Analytics (peak hours, role distribution, activity).]*
*[Figure 12. User Management and Settings (ESP32 device configuration).]*
*[Figure 12a. Occupants Inside Campus roster (live occupancy tracking).]*

**(Discussion)**
The Centralized Web Dashboard and Monitoring Module was developed to give security personnel and administrators one web interface for monitoring entry and exit activity. The Guard Dashboard shows scans in real time, including the owner's photo and vehicle plate so that the guard can visually confirm the match, and it supports manual entry of a UID. The Admin Dashboard provides analytics (daily activity and peak hours), user management, registration approval, and device settings. Access to each dashboard depends on the role of the account (Guard or Administrator).

The module also includes **Occupancy Tracking**, a live view of the people and vehicles currently inside the campus. Each authorized ENTRY opens a record and the matching EXIT closes it, so the number inside equals authorized entries minus authorized exits. The roster lets guards see who is still on campus after hours or during an emergency, supports headcounts in the analytics, and highlights entries with no matching exit. A same-card cooldown prevents duplicate taps from distorting the count. One limitation is that a person who leaves without tapping out stays listed as inside until a new entry or an administrative sweep closes the record.

The development of this module is supported by Masri and Ab. Aziz (2025), who found that a security dashboard with real-time notifications and a reporting module improved vehicle access monitoring, and by Esomonu and Ikenna (2021), who showed that role-based access control organizes permissions in tertiary institutions. However, the reviewed studies identified gaps: Poh and Ngadengon (2021) used a desktop GUI rather than a web platform, and Popa et al. (2026) did not provide a centralized dashboard across gates. The present study addressed this gap by combining a web-based, role-restricted dashboard with real-time updates from both gates. This provides the campus a single view of people and vehicles, accessible from any device.

> ⚠ Before submitting, align this module with the security fix in the review file (§1.2) or limit the claim to "application-level role-based access".

---

### Module 4: Visitor Management Module

**(Evidence)**
*[Figure 13. Visitor tag assignment (special tags) in the Admin/Guard dashboard.]*
*[Figure 14. Visitor entry and exit records in the logs.]*

**(Discussion)**
The Visitor Management Module was developed to record temporary guests and their vehicles without creating a full permanent registration. It allows administrators and guards to issue a temporary RFID tag labeled as *Visitor*. When this tag is scanned, the gate grants access and records the transaction with visitor information, so that visitor entry and exit are kept together with the records of regular users.

The development of this module is related to the findings of Mimbala et al. (2024), who reported that a campus logbook was used to record employees, students and visitors and replaced it with a web-based vehicle monitoring system. Similarly, Morpos et al. (2025) developed SMART ACCESS, which records gate entry and exit for students, employees, vendors and visitors. However, previous studies either focused only on vehicles or reported verification delays caused by connectivity. The present study addressed this gap through a visitor tag that is validated at the gate under the same rule hierarchy and keeps working in offline mode. This provides an organized, retrievable visitor record for the security personnel of ASU–Ibajay.

---

### Module 5: Emergency Exemption Module

**(Evidence)**
*[Figure 15. Emergency tag setup.]*
*[Figure 16. Emergency access record in the logs.]*

**(Discussion)**
The Emergency Exemption Module was developed to give authorized emergency units priority access during urgent situations while keeping a record for accountability. A tag labeled *Emergency* takes the highest priority in the rule hierarchy: access is granted without further checks and the transaction is logged with its gate and time. Because only administrators issue these tags, the exemption remains controlled.

The need for this module is supported by the emergency definition adopted in the study and by access-control research showing that rules, not manual judgment alone, should determine who may enter (Qingwei Wang, 2021). However, the reviewed RFID access systems did not provide a controlled emergency pathway with a corresponding record, as shown in the Prior-Arts Comparison Matrix (Table 1). The present study addressed this gap by combining an unconditional emergency grant with a full audit entry. This lets emergency vehicles enter without delay and lets the campus review each exemption afterward.

---

### Module 6: Reporting Module

**(Evidence)**
*[Figure 17. Filterable transaction records.]*
*[Figure 18. Exported CSV and PDF report.]*

**(Discussion)**
The Reporting Module was developed to give administrators organized, searchable records of entry and exit transactions. It provides filters by date, user, gate and status, and exports to CSV and PDF. Charts of hourly traffic and the distribution of roles help administrators see patterns. Each record keeps the UID, name, direction, gate, status and time, so past activity no longer requires reading a handwritten logbook.

This is consistent with Masri and Ab. Aziz (2025), who included a reporting and analytics module showing vehicle access patterns, and with Poh and Ngadengon (2021), whose system produced reports of date-and-time records. However, Masri and Ab. Aziz identified statistical analysis as a future improvement. The present study addressed this limitation by adding visual analytics (peak hours and user-role activity) and export functions. This helps the campus retrieve records quickly and review traffic patterns for security decisions.

---

### Module 7: Offline Module

**(Evidence)**
*[Figure 19. Offline mode indicator on the gate LCD.]*
*[Figure 20. Offline log file (`offline_txns.csv`) on the microSD card and the synchronized records with "[OFFLINE SYNC]" remarks.]*

**(Discussion)**
The Offline Module was developed to keep the gates operating when the internet connection is interrupted. Each gate unit stores a copy of the authorized-card whitelist (`authorized_cards.csv`) on its microSD card. When the network or database is unreachable, the unit verifies the UID against this list and saves the transaction in `offline_txns.csv`. When the connection returns, the unit uploads the stored records to the database with an "[OFFLINE SYNC]" remark, deletes the local file after successful upload, and refreshes the whitelist.

The development of this module is supported by Popa et al. (2026), who showed that access control units that decide locally continued to work during network outages, and by Morpos et al. (2025), who reported verification delays caused by internet connectivity. However, Masri and Ab. Aziz (2025) did not address offline operation, and Popa et al. lacked centralized monitoring. The present study addressed this gap by combining local microSD verification with cloud synchronization, so the gate keeps working offline while the central dashboard stays complete. This gives continuous monitoring at the gates with no lost records.

---

## SYSTEM EVALUATION

The developed system was evaluated using five selected characteristics of the ISO/IEC 25010 Software Product Quality Model. The survey results were analyzed using frequency, percentage, weighted mean and standard deviation. The findings were also related to the literature reviewed in Chapter II to determine whether the system addresses the identified research gap.

### Technical Test Results (objective)

| Test | Procedure | Result |
|---|---|---|
| Scan-to-log time | Time from card tap to saved record, 30 trials | [__] s average |
| Read success rate | Successful reads ÷ attempts, 100 attempts | [__] % |
| Offline operation | Disconnect network, perform [__] scans, reconnect | [__] of [__] synchronized |
| Access rules | Test emergency, visitor, authorized, pending, denied and unknown UIDs | [__] of 6 correct |
| Role access | Guard attempts admin function | [__] |

### Respondent Profile
*Table __. Distribution of respondents by group (frequency and percentage).*

### Functional Suitability
*Table __. Evaluation of the System in Terms of Functional Suitability*

| Item | Mean | SD | Interpretation |
|---|---|---|---|
| 1. Functional completeness | [__] | [__] | [__] |
| 2. Functional correctness | [__] | [__] | [__] |
| 3. Functional appropriateness | [__] | [__] | [__] |
| **Sub-mean** | **[__]** | **[__]** | **[__]** |

**(Interpretation and Discussion)**
The system obtained an overall weighted mean of [__], interpreted as [__]. The result indicates that CHARRMPASS provides [complete / correct / appropriate] functions for registering users, verifying RFID access, recording entry and exit, and monitoring through the dashboard. This is consistent with Masri and Ab. Aziz (2025), who reported that an integrated RFID web system improved access management. Previous studies were limited to single-user types or single entrances, while the present study addressed this gap through its seven integrated modules for both individuals and vehicles. Therefore, the evaluation result demonstrates that the system's functions respond to the identified needs.

### Performance Efficiency
*Table __ (same format: Time behaviour, Resource utilization, Capacity).*

**(Interpretation and Discussion)**
The system obtained an overall weighted mean of [__] for Performance Efficiency, interpreted as [__]. This indicates that scan verification [was completed within __ seconds on average, per the technical test]. The result supports Popa et al. (2026), who reported a 121 ms average authentication latency, and the Hasanuddin University study, which reported a 0.373 s response time. The present study addressed the efficiency gap by using a cooldown for duplicate scans and an offline whitelist that avoids waiting for the network.

### Reliability
*Table __ (Faultlessness, Availability, Fault tolerance, Recoverability).*

**(Interpretation and Discussion)**
The system obtained an overall weighted mean of [__] for Reliability, interpreted as [__]. This indicates that the system [operated consistently and recovered unsent records after interruptions]. This is supported by Popa et al. (2026), who observed no critical failures during a year of deployment. The reviewed studies showed a gap in operation during connectivity loss; the present study addressed it through the Offline Module, contributing to a more reliable system for the security personnel of ASU–Ibajay.

### Security
*Table __ (Confidentiality, Integrity, Non-repudiation, Accountability, Authenticity, Resistance).*

**(Interpretation and Discussion)**
The system obtained an overall weighted mean of [__] for Security, interpreted as [__]. This indicates that [role-based login, transport encryption, and the transaction log protect and trace data]. This is related to Esomonu and Ikenna (2021) on role-based permissions and to Popa et al. (2026) on rejection of unauthorized cards. The present study addressed this through role-based dashboards, HTTPS transport and a complete log of every attempt. ⚠ State in this paragraph the security limits that remain (see the review file §1.2) so that the discussion stays honest.

### Maintainability
*Table __ (Modularity, Reusability, Analysability, Modifiability, Testability).*

**(Interpretation and Discussion)**
The system obtained an overall weighted mean of [__] for Maintainability, interpreted as [__]. This indicates that [the separate entry, exit, guard and admin applications, and the logs, make changes and diagnosis easier]. The result is related to the modular design principles of Agile development (Beck et al., 2001). Previous studies were limited to single prototypes. The present study addressed this limitation through its modular code structure, separate gate firmware and database schema documentation. Thus, the system provides an approach that responds to the identified gap in maintainability.

### Summary of Evaluation
*Table __. Summary of ISO/IEC 25010 evaluation.*

| ISO/IEC 25010 Characteristic | Weighted Mean | Verbal Interpretation |
|---|---|---|
| Functional Suitability | [__] | [__] |
| Performance Efficiency | [__] | [__] |
| Reliability | [__] | [__] |
| Security | [__] | [__] |
| Maintainability | [__] | [__] |
| **Overall** | **[__]** | **[__]** |

### System Limitations Observed During Testing
1. A person who leaves without tapping out remains listed as inside the campus until a new entry or an administrative sweep closes the record.
2. Repeated taps of the same card within the cooldown window (30 s in the current firmware) are blocked.
3. [Add any limits found during testing.]

---

# CHAPTER V
# SUMMARY, CONCLUSIONS AND RECOMMENDATIONS

## Summary of Findings

This study developed **CHARRMPASS: A Web-Based Smart Entry and Exit Monitoring System Using Radio Frequency Identification (RFID) Technology** for students, faculty, staff, visitors and security personnel of Aklan State University–Ibajay Campus, Ibajay, Aklan. Specifically, it aimed to: (1) develop seven system modules (Registration and Permit; RFID Identification and Access; Centralized Web Dashboard and Monitoring; Visitor Management; Emergency Exemption; Reporting; and Offline); and (2) evaluate the system using Functional Suitability, Performance Efficiency, Reliability, Security and Maintainability of ISO/IEC 25010.

The researchers used a descriptive-developmental research design and the Agile model. The respondents consisted of [__] participants, selected using [sampling technique]. Data were gathered using a researcher-made questionnaire and technical tests, and analyzed using frequency, percentage, weighted mean and standard deviation. The system obtained the following results:

| ISO/IEC 25010 Criterion | Overall Weighted Mean | Verbal Interpretation |
|---|---|---|
| Functional Suitability | [__] | [__] |
| Performance Efficiency | [__] | [__] |
| Reliability | [__] | [__] |
| Security | [__] | [__] |
| Maintainability | [__] | [__] |
| **Overall Evaluation** | **[__]** | **[__]** |

## Conclusions

1. CHARRMPASS addressed the problem of manual, logbook-based entry and exit monitoring at ASU–Ibajay through its seven modules. It was found to be an appropriate solution.
2. The seven modules provided the functions needed to register users, identify individuals and vehicles, monitor transactions, manage visitors and emergencies, produce reports, and continue operating offline.
3. Based on the evaluation, the system demonstrated [__] software quality in the five ISO/IEC 25010 characteristics.
4. The overall weighted mean of [__], interpreted as [__], indicates that the system is [__].
5. The study addressed the gap in earlier work by integrating RFID identification of individuals and vehicles, web-based centralized monitoring, visitor and emergency handling, and offline continuity in one system. It may serve as a functional monitoring tool for the campus.

## Recommendations

1. **For the Intended Users.** The campus is recommended to adopt CHARRMPASS for gate monitoring and to require RFID registration of all vehicles.
2. **For the System Administrators.** Administrators should regularly back up the database, review the transaction logs, update the card whitelist, and close unclosed entries.
3. **For System Enhancement.** Future work may add automatic closing of unclosed entries (e.g., on the next entry), a resident/commuter classification, notifications (SMS/email), and a mobile view.
4. **For Data Security.** The system may be strengthened with Supabase Auth (JWT), hashed passwords, restrictive row-level security policies per role, and scheduled data-retention rules aligned with the Data Privacy Act of 2012.
5. **For Future Researchers.** Researchers may study larger samples and more gates, add anti-collision tests for multi-tag vehicle lanes, compare HF and UHF read ranges, and evaluate additional ISO/IEC 25010 criteria such as usability.

## Areas for Further Research
1. Long-term deployment (a full semester or A.Y.) with measured read accuracy.
2. Integration with the university's enrollment database.
3. Anti-tailgating and pedestrian detection at open gates.
