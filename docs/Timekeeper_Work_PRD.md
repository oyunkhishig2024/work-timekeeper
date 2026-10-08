# Timekeeper Work
## Product Requirements Document (PRD)

Version: 1.20
Product: Timekeeper Work
Owner: Onki
Status: Requirements Specification (pre-development review + CTO review + stakeholder decisions applied)

> v1.1 нь v1.0 MVP PRD-д дутуу байсан бизнес дүрэм, edge case, operational requirement-үүдийг нэмсэн хувилбар.
> v1.2 нь CTO review-ийн дагуу attendance integrity, offline/mobile найдвартай байдал, attendance correction (MVP), privacy/compliance, scale/operations, identity, data-model gap-уудыг нэмсэн хувилбар.
> v1.3 нь бизнесийн шийдвэрүүдийг тусгасан: (1) 24 цагийн ээлж MVP-д орно, (2) сэжигтэй event-ийг хүлээн аваад тэмдэглэнэ, (3) correction-д хоёр дахь хүний зөвшөөрөл шаардахгүй, (4) 310-ийн ажилтнуудад зориулсан утасны тохирох шаардлага, (5) ажилтны сайн дурын, гарын үсэгтэй зөвшөөрлийн хуудас.
> v1.1-д нэмсэн хэсгийг **[NEW]** / **[CHANGED]**, v1.2-д нэмсэн хэсгийг **[v1.2]**, v1.3-д нэмсэн/өөрчилсөн хэсгийг **[v1.3]** гэж тэмдэглэв. Өөрчлөлтийн бүртгэлийг 27-р бүлгээс үзнэ үү.

---

# 1. Product Vision

Timekeeper Work is a multi-tenant workforce attendance and presence management platform that automatically tracks employee attendance using geofencing, registered mobile devices, and centralized HR management.

The platform helps organizations:

- Track attendance automatically
- Reduce manual attendance administration
- Monitor multiple locations
- Manage approved absence reasons
- Identify late arrivals and no-shows
- Generate attendance analytics and reports

---

# 2. Multi-Tenant Architecture

Timekeeper Work is designed as a SaaS multi-tenant platform.

Each organization (tenant) has:

- Separate employees
- Separate locations
- Separate departments **[NEW]**
- Separate attendance records
- Separate users and permissions
- Separate reports
- Separate audit log **[NEW]**

Platform Hierarchy:

Super Admin → Organization → Locations / Departments → Employees

---

# 3. Initial Tenant Setup

Organization Name: 310

Employees: 320

Locations:
1. Төв салбар
2. Цагаан даваа
3. Хужирбулан
4. Налайх
5. Найман шарга
6. ЭМАА

Departments **[NEW]** (examples, configurable per tenant):
- Хүний нөөц
- Санхүү
- Хангамж
- Хамгаалалт

Users:
- Super Admin: Onki
- Organization Admin: Khongor
- HR: Ganbat
- Manager: Gantsooj

---

# 4. User Roles

## Super Admin

Permissions:
- Create organizations
- Manage tenants
- Assign Org Admins
- Monitor platform health
- View tenant statistics

## Organization Admin

Permissions:
- Manage locations
- Manage departments **[NEW]**
- Manage employees
- Create HR users
- Create Manager users
- Configure working hours
- Configure holidays
- Configure attendance rules (grace, no-show cut-off, minimum geofence stay) **[NEW]**
- View all reports
- View audit log **[NEW]**
- Manage shift templates and patterns (see 23) **[v1.3]**
- Review monthly Corrections report (see 6.9) **[v1.3]**

## HR

Permissions:
- Add employees
- Excel bulk import
- Generate onboarding QR codes
- Assign reasons
- Assign temporary locations **[NEW]**
- Disable / re-activate employees **[NEW]**
- View attendance
- Export reports (Excel / PDF) **[NEW]**
- Manage devices (disable device, generate replacement QR) **[NEW]**
- Create manual attendance corrections (see 6.9) **[v1.2]**
- Manage shift assignments, overrides and roster (see 23); print consent forms and record signed consent (see 15.4) **[v1.3]**

## Manager

Permissions:
- View dashboard
- View attendance
- View analytics
- Search employees

View-only access.

**Scope [v1.2]:** a Manager (and HR, if the Org Admin configures it) is limited to the **locations and/or departments assigned to them**. Dashboard counts, attendance lists, analytics, exports and search return only in-scope employees. Org Admin sees the whole tenant. A user with no scope assignment sees nothing (deny by default). Scope is enforced server-side on every query, not only in the UI. Gantsooj (Manager) is assigned the scope at user creation.

## Employee

Permissions:
- Login
- Register device
- Grant location permission
- View attendance history

---

# 5. Employee Onboarding

## QR-Assisted Device Registration

1. HR creates employee record
2. HR provides username and password
3. Employee installs Timekeeper Work
4. Employee logs in
5. Employee scans onboarding QR code
6. Employee grants location permission
7. Device registration completes

Rules:
- QR can be generated anytime by HR
- QR can be cancelled anytime
- QR expiration is configurable
- One QR can onboard multiple employees
- **[v1.11]** A shared (general) QR is for the **first registration only**. It may be printed and posted on walls or shown on a large screen so that employees who could not attend a group session (late, absent) can register their phone at any time. It does not identify the employee: the employee signs in with their own account, and the signed-consent gate (15.4) and the one-active-device rule still apply. HR can cancel it or **regenerate** it (old code stops working at once)
- QR contains no personal information

Device Rules:
- One active device per employee
- New device registration disables previous device
- Attendance accepted only from active device

(See Section 21 for the full Device Lifecycle.)

---

# 6. Attendance Logic

Attendance is automatically recorded when a registered employee enters or leaves a configured geofence.

Attendance Classifications:

## Цагтаа
Employee arrived within allowed time (see 6.2).

## Хоцорсон
Employee arrived after configured grace period (see 6.2).

## Шалтгаантай
Employee has an active approved reason assignment.

## Ирээгүй
Employee has:
- No attendance record
AND
- No active reason assignment
AND the no-show cut-off has passed (see 6.3).

## Байршил идэвхгүй **[NEW]**
Employee's active device has not reported a valid location (location services off, permission revoked, or no heartbeat). See 6.5.
This is an informational/diagnostic state shown to HR; it does not by itself count as Ирээгүй until the no-show cut-off passes.

## 6.1 Expected Attendance (Who must attend, and where) **[NEW]**

The system determines whether an employee is expected on a given **work date**, where, and when, as follows (first match wins) **[CHANGED v1.3]**:

1. Not an active employee on that date (disabled/archived, or before start date) → **not expected**, excluded from all counts.
2. Employee has a **Shift Assignment** (see 23): the shift schedule decides. The date is an off day in the pattern → **not expected**. A public holiday excludes the employee only if the shift template is flagged "observes public holidays" (24h guard shifts are not).
3. No shift assignment (standard schedule): the date is a public holiday / day off (14.2) or an off day of the Working Week (14.1), unless a working-day exception (14.1) makes it a working day → **not expected**, excluded from counts. Start and end times come from the expected location's Working Week row for that weekday.
4. Active **Temporary Location Assignment** covering the date → **expected at the temporary location** (using the shift/standard times unless the assignment specifies its own).
5. Otherwise → **expected at the employee's Primary Location**.

The result is always `{expected, location, shift_start, shift_end, grace, cutoff, early_window}` computed by one function (see 23.5), so Sections 6.2–6.4 apply identically to standard days and shifts. For shifts, "Work Start Time" below means the **shift start** and the work date is the **shift start date**.

Rules:
- Every employee MUST have exactly one Primary Location (mandatory field; Excel import rejects rows without it).
- Attendance is valid only when the geofence entry occurs at the **expected location** for that date. Entry to another tenant location is stored as an event but does not satisfy attendance (flagged "Wrong location" for HR review).
- Dashboard and branch breakdown counts use the **expected location** for the selected date (so a temporarily assigned employee counts toward the temporary location for that period).
- Start time (from the Working Week for that weekday) and Grace Minutes are taken from the **expected location**.

## 6.2 Late Calculation Rule **[NEW]**

Parameters (per location):
- Work Start Time (e.g. 08:00)
- Grace Minutes (e.g. 15)

Rule (evaluated on the first valid geofence entry of the day, in the tenant's local time zone, at minute precision):

- Arrival ≤ Start Time + Grace (08:00 – 08:15:59) → **Цагтаа**
- Arrival ≥ Start Time + Grace + 1 minute (08:16:00 and later) → **Хоцорсон**

Employees who arrive before Start Time are Цагтаа.
Late minutes (shown in reports) = Arrival − Start Time (the grace period does not reduce it).

## 6.3 No-show (Ирээгүй) Cut-off Rule **[NEW]**

An employee becomes **Ирээгүй** only after the no-show cut-off time has passed.

- Default cut-off: **Work Start Time + 2 hours** (e.g. 08:00 → 10:00).
- Configurable per location (hours after start time).
- Before the cut-off, an employee with no record and no reason is shown as **Хүлээгдэж байна (Pending)**, not Ирээгүй, and is not counted as No Show.
- An employee who arrives after the start time but before the cut-off is **Хоцорсон**.
- An employee who first arrives **after** the cut-off is still recorded as attended (**Хоцорсон**); the system updates the day's status from Ирээгүй to Хоцорсон and keeps the original no-show evaluation in the audit trail.
- For past dates, any employee with no record and no reason is Ирээгүй.

## 6.4 Minimum Geofence Stay (Anti-bounce) Rule **[NEW]**

To avoid false triggers from GPS drift at the geofence border:

- Parameter: **Minimum Stay = 3 minutes** (tenant default; configurable per location, range 1–15 min).
- A geofence entry is confirmed as **Arrival** only after the device remains inside the geofence continuously for the Minimum Stay.
- **Arrival time = timestamp of the first entry of the confirmed stay** (not the confirmation time).
- **[CHANGED v1.9.1, clarified]** Before arrival is confirmed, a stay shorter than the Minimum Stay is discarded (the timer is cancelled) and a later entry starts a new stay — exactly as in the example table above. **Once an arrival is confirmed, later exits and re-entries (of any length) do not change the day's status or arrival time**; they are stored as raw events only. (v1.1–v1.9 wrongly said short exits "do not reset the stay", contradicting the example; the example and the implementation in `packages/domain` follow the rule stated here.)

Example:

| Time  | Event            | Result                                                       |
|-------|------------------|--------------------------------------------------------------|
| 08:00 | Enter geofence   | Stay timer starts                                            |
| 08:02 | Exit geofence    | Stay < 3 min → no arrival, timer cancelled                   |
| 08:03 | Enter geofence   | Stay timer starts again                                      |
| 08:06 | Still inside     | Stay ≥ 3 min → **Arrival = 08:03**                           |

- Only the **first confirmed arrival** of the day sets the attendance status. Later exits/entries are stored as raw events (for future overtime/presence analytics) and do not change the status.
- Departure (exit) is recorded when the device is outside the geofence continuously for the Minimum Stay.

## 6.5 Location Services Off / Device Unreachable **[NEW]**

If the employee disables GPS, revokes location permission, or the app stops reporting:

- The app reports a **location-disabled event** (when possible) and the backend tracks last heartbeat.
- Status shown to HR: **Байршил идэвхгүй**, with last known time.
- Tracked in a "Location inactive" list on the Daily Attendance screen (filterable) so HR can follow up.
- The status does **not** mark the employee as present. If no valid arrival is recorded by the no-show cut-off, the employee becomes **Ирээгүй** (HR can then assign a reason or apply a manual correction, see 6.9).
- Repeated disabling is logged in the audit log.
- The employee app shows a persistent warning prompting the employee to re-enable location.

## 6.6 Status Precedence **[NEW]**

When multiple conditions apply on one day:

1. Active reason assignment → **Шалтгаантай** (arrival time, if any, is still recorded and shown).
2. Else a confirmed arrival → **Цагтаа** / **Хоцорсон**.
3. Else cut-off passed → **Ирээгүй**.
4. Else → **Хүлээгдэж байна**.

## 6.7 Attendance Integrity (Anti-spoofing) **[v1.2]**

Geofence attendance is easy to cheat with fake-GPS apps, so integrity checks are part of the MVP, not a later add-on.

**Device and app attestation**
- Android: Google **Play Integrity API** verdict required at device registration and attached to every attendance event batch; iOS: **App Attest / DeviceCheck**.
- **Fallback [CHANGED v1.8]:** at **registration** a failed or missing verdict blocks registration. For **event batches**, if the verdict service is unavailable or returns "unavailable" on a legitimate device, the batch is **accepted and flagged** (`ATTESTATION_UNAVAILABLE`) rather than rejected, so an outage at Google/Apple never blocks attendance. A definitive **failed** verdict (tampered app, emulator, rooted) is flagged `ATTESTATION_FAILED` and goes to the Anomaly Review Queue; repeated unavailable verdicts for one device (e.g. 5 batches in a row) are escalated to HR.
- Rooted / jailbroken devices, emulators, tampered or sideloaded app builds are rejected at registration and flagged on events.

**Location authenticity**
- App reports the **mock-location flag** (Android `isMock` / developer "mock location app" setting) and provider type (GPS / network / fused).
- Fixes with **horizontal accuracy worse than 50 m** (configurable per tenant, 20–100 m) do not confirm an arrival; they are stored as low-accuracy events.
- Server-side plausibility checks: impossible speed between consecutive fixes (e.g. > 150 km/h), a "teleport" into a geofence with no preceding movement, and identical coordinates repeated with zero jitter.

**Anomaly handling**
- Any failed check marks the event **Suspicious** with a reason code (MOCK_LOCATION, LOW_ACCURACY, IMPOSSIBLE_SPEED, ATTESTATION_FAILED, CLOCK_SKEW, DEVICE_CONFLICT).
- **Policy [CHANGED v1.3]: accept and flag.** A Suspicious event **is accepted** and sets Цагтаа/Хоцорсон as normal, but carries a visible **Suspicious flag** (icon + reason code) in Daily Attendance, exports and the employee profile. It also appears in the **Anomaly Review Queue** for HR with actions: Confirm (clear the flag), Reject (the event no longer counts; the day is recomputed, normally to Ирээгүй unless another valid arrival exists), or Request re-check. Decisions are audited.
- Because flagged events count immediately, dashboard counts may change after review; the dashboard shows a small "N flagged" indicator next to affected counts.
- The policy is a tenant setting (Org Admin, audited) in case a stricter "hold until reviewed" mode is needed later; the default is accept and flag.
- Repeated anomalies for one employee (e.g. 3 within 7 days) raise a flag on the employee profile and in the audit log.

**Buddy punching**
- One active device per employee remains the baseline. Additionally detect **one physical device claiming attendance for two employees** (same device ID / attestation key under two accounts) and **two employees' devices at identical coordinates with identical movement traces** — both raise DEVICE_CONFLICT.
- Device registration requires the Replacement/Onboarding QR **and** an HR-visible registration record (see 21). A liveness/biometric check at registration is deferred to V3.

## 6.8 Offline and Mobile Reliability **[v1.2]**

- **Offline event queue:** the app stores geofence enter/exit events locally (encrypted, tamper-evident) with the on-device capture time and a monotonic clock reading, and syncs when connectivity returns. Sync is **idempotent** (client-generated event ID; server dedupes).
- **Server time is the authority:** every upload carries device wall-clock and monotonic offsets; the server computes arrival time from the server receive time minus the monotonic delta. If device-clock vs server skew exceeds **2 minutes**, the event is flagged CLOCK_SKEW and the server-derived time is used. Manually changed clocks cannot make an employee on time.
- **Late-sync window:** offline events are accepted up to **24 hours** after capture (configurable). Status for past dates is recomputed when delayed events arrive, with the original evaluation kept in the audit trail (consistent with 6.3).
- **OS-level region monitoring:** geofencing must rely on OS facilities (iOS region monitoring / Significant-Change; Android Geofencing API via Google Play services), not a long-running foreground service. A foreground service is allowed only as a fallback.
- **Background-restriction handling:** many Android OEMs (Xiaomi, Samsung, Huawei, Oppo) kill background apps. The app includes an onboarding checklist: "Always allow location", precise location, battery-optimization exemption, auto-start permission (with OEM-specific instructions), and notification permission. A **Health Check** screen shows green/red for each; the result is reported to the backend.
- **Heartbeat (best effort) [CHANGED v1.8]:** the app tries to send a lightweight heartbeat (target every 15 min during work hours); iOS and aggressive Android OEMs may delay or skip it, so the interval is **not guaranteed** and a missing heartbeat alone is only an indicator (it feeds "Байршил идэвхгүй" after a configurable tolerance, default 60 min), never proof of absence. It carries permission state, battery-saver state and app version (see 6.5). Heartbeat is not location tracking (see 15.3).
- **Battery budget:** background activity must not use more than ~3% battery per working day on reference devices.
- **Supported devices:** see 21.3 (Android 10+ with Google Play services, iOS 15+). The 310 workforce prepares compliant phones before the pilot.
- **Force-upgrade:** the backend publishes a minimum app version; older versions are blocked with an upgrade prompt (see 25.4).

## 6.9 Attendance Correction (basic, in MVP) **[v1.2]**

Without correction, HR cannot recover from a dead phone, GPS failure or a genuine error on day one. A basic workflow is therefore pulled into the MVP (the full workflow remains in V2, see 19).

**Manual override (HR)**
- HR selects Employee + Date, chooses the new status (Цагтаа / Хоцорсон / Ирээгүй) and optionally an arrival time.
- **Mandatory correction reason** (pick-list: Phone dead/lost, GPS fault, App issue, Anomaly review, Data entry error, Other + free text).
- Corrections are stored as separate records layered over the system-computed result: original system value, corrected value, reason, actor, timestamp. The original is never overwritten.
- A corrected day is shown with a "Corrected" badge in Daily Attendance and exports (column "Source: Auto / Corrected").

**No second approval [CHANGED v1.3]**
- HR (and Org Admin) can apply a correction **directly**; it takes effect immediately. No second-person approval is required.
- Compensating controls instead of approval: the **mandatory reason**, immutable audit trail (who, when, before/after), the "Corrected" badge, a monthly **Corrections report** for the Org Admin, and an automatic alert to the Org Admin when one user makes more than **10 corrections in a day** or any correction for their own record (an HR user cannot correct their own attendance; an Org Admin must).
- The tenant may enable an optional approval step later (Org Admin setting, audited); it is off by default.

**Limits and audit**
- Corrections only for the **last 31 days** by default (configurable); older periods are locked once the month is closed (see 25.5).
- Every correction, edit and revocation is written to the audit log (15.1).
- A "Corrections" report lists corrections by period, actor, reason; high correction rates per location are shown as a data-quality indicator (see 18).

---

# 7. Dashboard (Хянах самбар)

Header:
- Organization Name
- Date Navigation

Date Navigation:
- Previous Day
- Today
- Next Day

Main Summary Card:

- Date
- Total Employees (expected employees for the date, see 6.1)
- On Time Count
- Late Count
- No Show Count

Example:

- Total Employees: 320
- On Time: 310
- Late: 2
- No Show: 6

Quick Status Cards:

- Цагтаа
- Хоцорсон
- Шалтгаантай
- Ирээгүй

Cards are clickable and open Daily Attendance.

---

# 8. Branch Attendance Breakdown

Dashboard shall display attendance by location.

Example:

Төв салбар
- Total: 220
- On Time: 212
- Late: 2
- Excused: 3
- No Show: 3
- **On-time rate: 96.4% (212 / 220)** **[NEW]**

Same layout applies to:

- Цагаан даваа
- Хужирбулан
- Налайх
- Найман шарга
- ЭМАА

Percentage definitions **[NEW]**:
- On-time rate = On Time ÷ Total expected at the location
- Late rate = Late ÷ Total
- Excused rate = Excused ÷ Total
- No-show rate = No Show ÷ Total
- Percentages shown with one decimal; counts remain visible alongside.
- Also available per department.

---

# 9. Daily Attendance (Өдрийн ирц)

Filters:

Status Filter:
- Бүгд
- Цагтаа
- Хоцорсон
- Шалтгаантай
- Ирээгүй
- Байршил идэвхгүй **[NEW]**

Location Filter:
- Бүх салбар
- Төв салбар
- Цагаан даваа
- Хужирбулан
- Налайх
- Найман шарга
- ЭМАА

Department Filter: **[NEW]**
- Бүх хэлтэс
- (tenant departments)

Employee List Fields:
- Employee Name
- Department **[NEW]**
- Primary Location **[NEW]**
- Expected Location (shown with a "Temporary" badge when different) **[NEW]**
- Attendance Status
- Arrival Time
- Late minutes **[NEW]**
- Assigned Reason

---

# 10. Analytics (Анализ)

Views:
- Өдрөөр
- 7 хоногоор
- Сараар

Metrics:
- Цагтаа
- Хоцорсон
- Ирээгүй
- Шалтгаантай **[NEW]**
- Percentages per location and per department **[NEW]**

Charts:

Attendance Distribution Bar Chart

Colors:
- Green = Цагтаа
- Yellow = Хоцорсон
- Red = Ирээгүй

Location Comparison (on-time % per location) **[NEW]**

---

# 11. Reason Management (Шалтгааны бүртгэл)

The organization uses 15 predefined reasons.

1. Албан ажилтай
2. Сургалттай
3. Парадны бэлтгэл
4. ЭДА
5. Бүтээн байгуулалт
6. Өвчтэй
7. Чөлөөтэй
8. Ээлжийн амралт
9. Хүний нөөцийн мэдэлд
10. ЭДА бэлтгэл
11. Хээрийн байрлалд
12. Тамирчин
13. Гадна объект
14. Малын суурь
15. Тасалсан

HR can:
- Select reason
- Search employee
- Set start date
- Set end date
- Add description
- Save reason assignment
- Delete / end a reason assignment early (audited) **[NEW]**

Example:

Employee: Бадам Гэндэн
Reason: Сургалттай
Start: 2026-10-06
End: 2026-11-10
Description: Аюулгүй ажиллагааны сургалт

Business Rule:

If selected date falls between start and end date,
employee automatically appears as Шалтгаантай.

**[v1.12]** An employee has one reason at a time (periods cannot overlap); the end date may be left open until HR ends it. A reason that has not started yet can be deleted; once started it is ended early instead, so history is kept.

## 11.1 Reason Report **[NEW]**

Shows how many employees had each reason over a period.

Example:

| Reason    | Employees |
|-----------|-----------|
| Сургалттай | 12        |

- Period: day / week / month / custom range
- Metrics per reason: distinct employees, total employee-days
- Filters: location, department
- Drill-down: click a reason to list employees, with start/end dates and description
- Exportable (Excel / PDF)

---

# 12. Employee Management

Features:
- Add employee
- Edit employee
- Disable employee
- Re-activate employee **[NEW]**
- Search employee
- Bulk import employees
- Generate onboarding QR
- Replace employee device
- Assign temporary location **[NEW]**

Employee Fields **[CHANGED]**:

- **Employee Number [CHANGED v1.14]**: assigned by the system, 16 digits = registration date (YYYYMMDD) + 8 random digits; unique per tenant, never edited; it is the default login name (the password is a random one-time password, never derived from the code)
- **Last name (Овог) and First name (Нэр)** as two separate fields **[v1.14]**; the full name is shown as "Овог Нэр"
- **Department** (required)
- **Primary Location** (required)
- **Rank (цол)** and **Job Position (албан тушаал)** — two separate **free-text** fields, each with its own effective-dated history **[v1.10, CHANGED v1.14]**: any wording (not only military ranks), with suggestions from values already used
- Username
- **Schedule** (Standard / Shift Assignment, see 23) **[v1.3]**
- **Consent status** (Not requested / Printed / Signed / Withdrawn, see 15.4) **[v1.3]**
- **Device model, OS version, Compatible Y/N**, or **Manual attendance (no device)** flag (see 21.3, 15.4) **[v1.3]**
- Status (Active / Disabled / Archived)
- Start Date, End Date (optional)

Excel Import Fields:

- ~~Employee Number~~ **[CHANGED v1.14]** not in the file: the system assigns each new employee a 16-digit code (re-imports match existing employees by that code only when the column is present)
- **Last name (Овог), First name (Нэр)** — two columns **[v1.14]**
- Department
- **Primary Location** (must match an existing location, rows with unknown location are rejected with a row-level error report)
- Username (optional; defaults to the employee code)
- Rank (цол), Position (албан тушаал) — free text, optional **[v1.14]**
- Shift Pattern / Template, Cycle Start Date (optional, see 23.4) **[v1.3]**
- ~~Password~~ **[CHANGED v1.2]** Plaintext passwords are no longer accepted in the Excel file. See 12.3 (Import Safety) and 15.2 (Identity).

## 12.1 Temporary Location Assignment **[NEW]**

Used when an employee works at a different location than their Primary Location for a period.

Fields:
- Employee
- From Date
- To Date
- Target Location
- Reason / Description

Example:

- Primary: Төв салбар
- Today: Цагаан даваа (2026-10-06 → 2026-10-08)

Rules:
- Assignments can be created by HR / Org Admin; creation, edit and deletion are audited.
- Periods for the same employee cannot overlap (system blocks overlapping assignments).
- Bulk assignment of multiple employees to one target location is supported.
- During the period the employee is expected at the target location, using the target location's start time and grace (see 6.1).
- After To Date the employee automatically reverts to the Primary Location; no manual action needed.
- Past assignments are retained for historical reporting and cannot be hard-deleted (end-dated instead).
- Daily Attendance and reports show a "Temporary" badge.
- Interaction with reasons: a reason assignment (Шалтгаантай) overrides the attendance expectation for the same date (see 6.6).

## 12.2 Employee Lifecycle **[NEW]**

### Disable Employee (resignation / termination)
When HR disables an employee:

- Login is blocked immediately and active sessions/tokens are revoked.
- Active device is deactivated (registration kept for audit, no longer accepted).
- Attendance tracking stops from the disable effective date; the employee is excluded from "Total Employees" and no-show counts from that date.
- All historical attendance, reasons and reports are retained and remain visible.
- Open reason and temporary-location assignments after the effective date are ended automatically.
- Effective date can be set (default: today); disabling is audited.
- Disabled employees are hidden from default lists; visible through the "Disabled" filter.

### Re-activate / Re-hire
- HR / Org Admin can **re-activate** a disabled or archived employee; the same Employee record and history are reused (no duplicate record).
- On re-activation: status → Active, new effective start date, password reset required, previous device remains disabled, and a **new device registration (QR) is required**.
- Primary Location and Department must be re-confirmed during re-activation.
- Re-activation is audited.

### Archive
- A Disabled employee can be **Archived** after a configurable retention period (default: 12 months) to hide them from search and imports.
- Archived employees are read-only and retain history; they can be restored by HR / Org Admin (see Re-activate).
- Employee Number remains reserved to the employee (not reused by another person).

## 12.3 Import Safety **[v1.2]**

- **Dry-run first:** every import runs a validation pass that returns a per-row report (valid / warning / error) and writes nothing. HR confirms to commit.
- **All-or-nothing option:** HR chooses "import valid rows only" or "abort if any error".
- **Validation:** unique Employee Number and Username, existing Department and Location, required fields, file size (max 2,000 rows) and type (.xlsx only), formula/macro injection stripped (cells starting with `=`, `+`, `-`, `@` are treated as text).
- **No plaintext credentials:** passwords are not imported. Each imported employee gets an **invite** (one-time activation link/code, expires in 72 hours by default) and sets their own password on first login. A downloadable "invite sheet" (employee, username, activation code) is generated once for HR and is not stored after download.
- **Idempotent:** re-uploading the same file updates existing employees by Employee Number (with a diff preview) rather than creating duplicates.
- Imports are audited (file name, row counts, actor).

---

# 13. Location Management

Fields:

- Location Name
- Address
- Latitude
- Longitude
- Geofence Radius
- **Working schedule: inherit the tenant Working Week (14.1) or override** (optional, effective-dated) **[CHANGED v1.6]**
- Grace Minutes
- **No-show Cut-off (hours after start, default 2)** **[NEW]**
- **Minimum Geofence Stay (minutes, default 3)** **[NEW]**

Geofence Radius:
- Minimum: 100m
- Maximum: 500m

Rules **[NEW]**:
- A location cannot be deleted while employees have it as Primary Location; it can be deactivated after reassigning employees.
- Changing the schedule override / Grace applies from the effective date forward and does not recalculate past attendance.

## 13.1 Departments **[NEW]**

- Org Admin manages the department list (name, active flag).
- Each employee belongs to exactly one department.
- A department can span multiple locations.
- Departments are used for filters, analytics and reports.
- A department cannot be deleted while it has active employees.

---

# 14. Working Week, Working Hours and Holidays **[CHANGED v1.6]**

The **Organization Admin** configures all of this in the web app (no developer involvement). All settings are effective-dated and audited (15.1); past attendance is never silently recalculated (22.1).

## 14.1 Working Week (tenant default)

A weekly table with one row per weekday:

| Weekday | Working? | Start | End |
|---|---|---|---|
| Mon–Fri | Yes | 08:30 | 17:30 |
| Sat, Sun | Off | – | – |

(Example for tenant 310; any day can have different hours, e.g. Friday ends earlier, or Saturday works 09:00–13:00.)

- **Grace** and **No-show cut-off** stay as location attendance rules (13): e.g. start 08:30 + grace 15 → on time until 08:45:59, late from 08:46; no-show after 10:30 (start + 2 h).
- **Work End** is stored for the standard schedule and used for departure recording and V2 presence analytics (6.2, 23.2); in V1 it does not itself change the status.
- **Location override (optional):** a location may use its own weekly table (e.g. ЭМАА 09:00–18:00). Locations without an override inherit the tenant Working Week. Each employee resolves to their expected location's table (6.1).
- **Employees on shifts** (23) ignore the Working Week; it applies only to the standard schedule.
- **Working-day exceptions:** a single date can be marked *working* when it is normally off (e.g. a transferred working Saturday, optionally with its own hours) or *off* when it is normally working. They take priority over the weekly table.

## 14.2 Holiday Setup

Org Admin manages a **Holiday Calendar** per tenant:

- Fields: **Name**, **Date** or **Date range**, **Type** (Public holiday / Company day off / Transferred day off), **Applies to** (All locations or selected locations), **Repeats yearly on the same date** (yes/no).
- Fixed-date holidays can repeat yearly; holidays that move each year (e.g. lunar-calendar holidays) are entered per year. A **"Copy from previous year"** action and **bulk import from Excel/CSV** (name, from, to, type, locations) are provided, with the 12.3 dry-run validation.
- The system does **not** ship holiday dates as authoritative; Org Admin confirms the list each year. A calendar view shows holidays, weekends and exceptions together for the next 12 months.
- Effect on attendance: employees on the standard schedule are **not expected** on a holiday or day off (6.1) and are excluded from counts. Shift templates marked "observes public holidays" behave the same; other shifts (e.g. 24 h guards) still work and are counted (23.2).
- **Worked on a day off:** if a not-expected employee still enters the geofence, the arrival is recorded and shown as **"Ажилласан (амралтын өдөр)"** for information; it does not count as Цагтаа/Хоцорсон and creates no overtime in V1.
- **Changing holidays after the fact:** adding or removing a holiday for a past or current date requires an explicit **Recompute** confirmation showing how many employee-days change; it is audited and blocked for closed periods (25.5).

## 14.3 Example for tenant 310

- Working Week: Mon–Fri 08:30–17:30; Sat, Sun off.
- Grace 15 min → on time up to 08:45:59; late from 08:46; no-show from 10:30 (default start + 2 h).
- Holiday Calendar: entered by Org Admin (Khongor) each year.
- Guards (Хамгаалалт) are on 24 h shift patterns (23) and are not governed by this table.

---

# 15. Security

Authentication:
- JWT Authentication
- Password Hashing
- HTTPS

Access Control:
- Role-Based Permissions

## 15.1 Audit Log **[CHANGED]**

An immutable, tenant-scoped audit log records who did what and when. Entry fields: timestamp, actor (user), role, action, target entity, before/after values (where relevant), source IP/device.

Events recorded:

- Login activity (success / failure)
- QR generated / cancelled
- Device registered / disabled / replaced
- Reason added / edited / deleted
- Reason assignment
- Temporary location assigned / changed / deleted
- Employee created / edited / disabled / re-activated / archived
- Location and department changes
- Attendance rule configuration changes (grace, cut-off, minimum stay)
- Report exports
- Attendance updates
- Location-disabled events (summarized)

Rules:
- Visible to Organization Admin (full) and HR (own actions + operational events).
- Entries cannot be edited or deleted by any tenant user.
- Filterable by date, actor, action, employee; exportable.
- Retention: minimum 12 months (configurable).

## 15.2 Identity and Access **[v1.2]**

- **First-login password change:** accounts created by HR/Admin (or via invite) must set a new password on first login; temporary passwords/codes expire (72 hours).
- **Password policy:** minimum 10 characters, no known-breached passwords (check against a breached-password list), hashed with Argon2id (or bcrypt cost ≥ 12).
- **Password reset:** self-service reset by one-time code to a verified channel (email/phone) or HR-assisted reset (audited). Reset revokes all sessions and, for employees, does **not** change the registered device.
- **Two-step login (TOTP) [CHANGED v1.4]:** required for Super Admin, Organization Admin and HR; optional for Manager; not required for Employee. Method: **TOTP authenticator app (Google Authenticator or any compatible app)**. **No SMS** codes. Setup at first login by scanning a QR; the admin can reset a user's authenticator (audited, requires identity check); 8 one-time recovery codes are issued at setup.
- **Rate limiting and lockout:** login and reset endpoints are rate-limited per IP and per account; progressive lockout after repeated failures (e.g. 5 attempts → 15-minute lock), with alerts to admins on suspected brute-force.
- **Sessions/tokens:** short-lived access tokens (≤ 15 min) with rotating refresh tokens bound to the device for mobile; revocable on disable, reset or device replacement. Web admin sessions expire after 30 minutes idle.
- **Least privilege:** roles and scope (4) enforced server-side; Super Admin access to tenant data is audited and, for tenant business data, requires an explicit support-access grant by the tenant.
- **Secrets and keys:** no secrets in the repo or mobile binary; keys managed in a cloud KMS; database and backups encrypted at rest.

## 15.3 Privacy and Compliance **[v1.2]**

- **Purpose limitation:** location is processed **only to determine attendance at the employee's expected geofence**. The system does **not** record continuous trails or location outside configured geofences/work hours. Outside work hours the app does not collect location.
- **What is stored:** geofence enter/exit events (timestamp, location ID, accuracy flags) and heartbeat metadata. Raw coordinates are retained only for the Suspicious/anomaly window (default 30 days), then reduced to the geofence-level event.
- **Employee transparency:** the app shows a plain-language notice (what is collected, when, who sees it) and an "Attendance history" view of exactly what was recorded about them (see 4).
- **Consent [CHANGED v1.3]:** location processing is based on the employee's **voluntary, written, signed consent** on a paper consent form (see 15.4). In-app acknowledgement at first login is kept as a second record, with version and timestamp, but does not replace the signed form.
- **Legal basis:** employer's attendance obligation under the employment relationship, plus recorded acknowledgement. Compliance with **Mongolia's Law on Personal Data Protection** must be confirmed by legal counsel before launch (see 26); the design assumes: lawful and limited collection, notice, access, correction, deletion/anonymization after retention, cross-border transfer controls. **Decision v1.6: data is hosted outside Mongolia. Decision v1.8: cloud region = Singapore.** Consequences: (a) the signed consent form must explicitly state that data is stored and processed abroad (Appendix A, item 7); (b) a data processing agreement with the cloud provider; (c) encryption at rest and in transit; (d) the hosting country/region is named in the privacy notice. Legal counsel confirms that hosting in Singapore meets the Law on Personal Data Protection.
- **Foreign processors register [v1.7]:** hosting is abroad (Option B, decided). The tenant privacy notice and the consent form list every external service that receives data, what it receives and where it is located; the register is kept current and changes require a new consent version (15.4) when personal data categories change:
  - **Cloud hosting provider** (database, files, backups) – all attendance, employee and audit data, encrypted; region named in the notice.
  - **Google Play Integrity / Apple App Attest** – device and app integrity signals (6.7); no attendance data.
  - **Android location services (Google Play services)** – used on the device for geofence detection.
  - **Firebase Cloud Messaging** (from V2) – device push token and notification text; notification text must avoid sensitive detail.
  - **Monitoring / crash reporting** – technical logs only; personal data (names, coordinates) must be masked before leaving the platform.
  - **Email/SMS provider** (if used) – recipient address/number and message text.
  - Backups are stored in a second foreign region or separate account (25.2); a data processing agreement is signed with each processor.
- **Data-subject requests:** HR/Org Admin can export an employee's personal data and, where legally allowed, anonymize it; requests and outcomes are audited.
- **Retention (defaults, configurable per tenant):** attendance records **2 years [CHANGED v1.4]**; raw coordinates **30 days: after 30 days the latitude/longitude of every event is erased while the geofence-level event (time, location, flags) stays for the 2-year attendance retention [CHANGED v1.8]**; heartbeats 90 days; audit log 12 months minimum (see 15.1); archived employee data per 12.2. Deletion jobs run automatically and are logged.
- **Access scoping:** see Manager/HR scope in 4. Exports containing personal data are audited (see 20) and watermarked with exporter and time.
- **Breach readiness:** documented incident-response process and notification procedure (see 25.6).

## 15.4 Employee Consent Form (printed, signed) **[v1.3]**

Business decision: the employee gives consent **voluntarily and in writing**; HR prints the signed form and files it with the **employment contract**.

**Form generation**
- HR can generate a **printable consent form (PDF, A4)** from Employee → Consent. It is pre-filled with organization name, employee full name, employee number, department, primary location, date, and the current **consent text version** (see Appendix A for the draft text).
- The form states in plain Mongolian: what is collected (geofence enter/exit times at work locations, device and app status), when (work hours/shifts only), who can see it, how long it is kept, that location is not tracked outside work hours or outside work locations, that consent is voluntary, and how to withdraw it.
- The form carries a unique **form ID and QR/barcode** and a version number, so the signed paper can be matched to the record.
- Bulk generation: HR can print forms for many employees at once (e.g. the 320 current employees at rollout), one PDF with a page per employee.

**Recording**
- After the employee signs, HR marks **Consent received** on the employee record with the signing date and form version, and may upload a **scan** (PDF/JPG, stored encrypted, accessible to HR/Org Admin only). Marking is audited (actor, time).
- Employee status shows one of: **Not requested / Printed / Signed**.
- **Gate:** device registration (QR onboarding, 5) cannot complete until HR has marked Consent received (system blocks the registration step with a clear message). Org Admin can override with an audited reason (e.g. paper signed, record pending).
- Consent is stored per form version; if the consent text changes materially, a **new signature** is requested and the employee shows "Re-consent required" before the next registration or after a grace period set by the Org Admin.

**Withdrawal and refusal**
- An employee may withdraw consent at any time by written request to HR. HR marks **Consent withdrawn**: the device is deactivated (21.2) and no further location data is collected. Past attendance records are retained per 15.3.
- **Alternative attendance for employees who do not consent:** because consent must be genuinely voluntary, an employee who declines or withdraws must have a non-location alternative (e.g. manual attendance entered by HR/manager via correction 6.9, or sign-in sheet). The system supports an employee flag **Manual attendance (no device)**: such employees are listed as expected, never auto-marked by geofence, and HR records their attendance by day (bulk entry). They are shown separately in reports so the data-quality metrics (18) are not distorted.

**Legal note:** the business position is that a signed voluntary consent form attached to the employment contract provides the legal basis. This must be **confirmed by Mongolian legal counsel** before launch (see 26), including the wording in Appendix A and whether consent given within an employment relationship is sufficient or an additional contract clause is required.

---

# 16. Technical Stack

Mobile:
- React Native

Frontend:
- Next.js
- TypeScript
- Tailwind CSS

Backend:
- NestJS
- Node.js

Database:
- PostgreSQL

Maps:
- Google Maps API
- Mapbox

Notifications:
- Firebase Cloud Messaging

Storage:
- Azure Blob Storage
- AWS S3

Additions **[v1.2]**:
- Queue / event ingest **[CHANGED v1.5]**: for the pilot, a **PostgreSQL-backed job queue** (e.g. pg-boss / Graphile Worker) in front of the attendance-processing workers, so no extra managed service is needed. The queue is accessed through an interface so it can be replaced by SQS / Azure Service Bus / Redis Streams when scale requires it.
- Cache **[CHANGED v1.5]**: in-process / PostgreSQL for the pilot; Redis is added only when multiple tenants or instances require it
- Mobile attestation: Google Play Integrity API, Apple App Attest
- Observability: structured logging, metrics and tracing (e.g. OpenTelemetry) with a hosted dashboard and alerting
- Secrets / keys: cloud KMS
- Infrastructure as Code and CI/CD pipeline (see 25.4)

---

# 17. MVP Scope

Included:

- Multi-tenant architecture
- Organization management
- Employee management (with Primary Location and Department) **[CHANGED]**
- Temporary location assignment **[NEW]**
- QR onboarding
- Device registration and device replacement / disable workflow **[CHANGED]**
- Geofence attendance (with late, no-show and minimum-stay rules) **[CHANGED]**
- Dashboard (with per-location percentages) **[CHANGED]**
- Daily attendance
- Analytics
- Reason management and Reason Report **[CHANGED]**
- Excel import
- Excel / PDF export of Daily, Weekly, Monthly reports **[NEW]**
- Location management
- Departments **[NEW]**
- Public holidays
- Working hours
- Employee lifecycle (disable, re-activate, archive) **[NEW]**
- Audit log **[NEW]**
- Role-based access control (with location/department scope) **[CHANGED v1.2]**
- Attendance integrity checks (accept-and-flag) and Anomaly Review Queue **[CHANGED v1.3]**
- Shift scheduling: templates, rotation patterns, assignments, overrides, roster view **[v1.3]**
- Supported-device requirements and Device Readiness report **[v1.3]**
- Printable employee consent form with signed-consent tracking and registration gate **[v1.3]**
- Offline event queue, server time authority, background-restriction onboarding **[v1.2]**
- Basic attendance correction (direct HR correction, no second approval, audited) **[CHANGED v1.3]**
- Identity hardening (first-login change, MFA for admins, rate limiting, invite-based onboarding) **[v1.2]**
- Privacy notice, consent capture and retention jobs **[v1.2]**
- Non-functional foundations: tenant isolation (RLS), daily aggregates, observability, backups, versioned rules, force-upgrade **[v1.2]**

Excluded from MVP (see Future Versions):
- Push / notification engine (design hooks only, see 19)

## 17.1 Release Plan **[v1.9]**

Decision: the MVP is delivered in **two releases** by one full-stack developer (see Architecture doc, Section 14). The pilot window (~4 months) refers to the period in which only 1–2 tenants exist; it is **not** the date by which every feature is live. Estimates: Release 1 ≈ 5.5 months, Release 2 ≈ 8 months from start (±40%).

**Release 1 — "Pilot-Lite" (standard-schedule employees):**
- Auth (password + TOTP for admin roles), tenant isolation, users and scopes, audit log (stored + simple viewer)
- Locations, departments, employees, Excel import (dry-run)
- Working Week, working-day exceptions, holidays (14)
- QR device registration with consent gate, consent form printing/tracking (15.4), supported-device readiness list (21.3)
- Mobile geofence attendance with offline outbox, integrity flags (accept-and-flag), health screen (6.2–6.8)
- Attendance engine for the standard schedule, temporary location assignment, reasons, direct corrections (6.9)
- Dashboard, daily attendance, basic anomaly list (flags visible, confirm/reject), basic analytics charts
- Excel export of daily/weekly/monthly reports
- Backups, monitoring, runbooks

**Release 2 — completes the MVP (during the pilot):**
- **24 h shift scheduling** (23): templates, patterns, assignments, overrides, roster
- Full analytics (week/month views, location/department percentages), reason report, full anomaly queue actions
- PDF exports, roster grid, audit-log export, period close
- Super Admin tenant management UI and second-tenant readiness

**Interim handling of guards (Хамгаалалт) until Release 2:** shift employees are flagged **Manual attendance (no device)** (15.4) and HR records their attendance through corrections (6.9). They appear in reports separately so the accuracy metrics (18) are not distorted. The expected-attendance interface (6.1, 23.5) is built in Release 1 so shifts plug in without changing the engine.

**Change control:** new requirements go to Release 2 or V2 unless they block Release 1; each added item must name what it displaces.

---

# 18. Success Metrics

- Attendance Accuracy > 95% **[CHANGED v1.2]** – measured as: of a monthly random sample of at least 200 employee-days per tenant, the % where the system status matches the verified ground truth (HR/manager check or physical roster), **excluding** days with a user-confirmed device/phone fault.
- Attendance Capture Rate > 99% **[CHANGED v1.2]** – % of employee-days with a present-and-expected employee (ground truth) that have a valid auto-recorded arrival, without manual correction.
- Employee Onboarding < 5 minutes (from first login to completed device registration, median)
- Dashboard Load Time < 2 seconds (p95 for the Org Admin view with 320 employees)
- Report export (monthly, 320 employees) < 10 seconds **[NEW]**

Data-quality and reliability metrics **[v1.2]**:
- **False no-show rate** < 1% of expected employee-days (no-show later corrected by HR or by a late-synced event)
- **Correction rate** < 2% of employee-days per tenant per month (alert if exceeded at a location)
- **Suspicious-event rate** and **anomaly resolution time** (median < 1 working day)
- **Mobile crash-free sessions** > 99.5%; **heartbeat coverage** > 95% of expected devices during work hours
- **Ingest lag** (device event to visible in dashboard) p95 < 60 seconds online; **sync success** of offline queues > 99.9%

---

# 19. Future Versions

Version 1 (architecture hook only) **[NEW]**:
- **Notification Engine**: not delivered in V1, but the event model must be designed now so that it can be added without architecture change. Notification-capable events: employee late, employee no-show, location disabled, device replaced, QR generated. Example HR notification: "Бадам Гэндэн — Хоцорсон — 08:24". Channels: FCM push, in-app, email. Per-user subscription settings.

Version 2:
- Push notifications (using the notification engine above)
- Overtime analytics
- Full attendance correction workflow (employee-initiated requests, manager approval chains, bulk corrections) – the basic HR correction flow is already in the MVP (6.9) **[CHANGED v1.2]**
- Presence analytics for shifts (left-early detection, overtime, on-site duration) building on the raw events kept in V1

Version 3:
- Payroll integration
- Advanced reports
- Biometric verification

Version 4:
- AI attendance insights
- Workforce forecasting
- Executive dashboards

---

# 20. Reporting and Export **[NEW]**

Reports:

| Report            | Period                | Content                                                                 |
|-------------------|-----------------------|-------------------------------------------------------------------------|
| Daily Attendance  | One day               | Employee, department, location, status, arrival time, late min, reason  |
| Weekly Report     | 7 days (Mon–Sun)      | Per-employee counts of Цагтаа / Хоцорсон / Шалтгаантай / Ирээгүй + totals |
| Monthly Report    | Calendar month        | Same as weekly plus on-time % per employee, location and department      |
| Reason Report     | Custom                | See 11.1                                                                |
| Location Summary  | Day / week / month    | Totals and percentages per location (see Section 8)                    |

Export:
- Formats: **Excel (.xlsx)** and **PDF**
- Filters applied on screen (location, department, status, date range) are applied to the export
- Excel export is flat/tabular to allow pivoting; PDF is print-ready with organization name, period, generated by and generated at
- Available to HR, Organization Admin; Manager can export view-only reports if the Org Admin allows it (default: no)
- Every export is recorded in the audit log

---

# 21. Device Lifecycle **[NEW]**

## 21.1 Replacement Device (new phone)

Example: old Samsung → new iPhone.

Workflow:
1. Employee requests HR (in person / phone).
2. HR opens Employee → Device → **Generate Replacement QR** (single-use QR bound to that employee, short expiry, default 24 hours).
3. Employee installs the app on the new phone and logs in.
4. Employee scans the Replacement QR and grants location permission.
5. System registers the new device and **automatically disables the old device**.
6. Audit log records: "Device Replaced" (old device, new device, HR user, time).

Rules:
- Replacement QR is single-use, employee-specific and cancellable.
- Until the new device registration completes, the old device keeps working (unless HR disables it).
- **[CHANGED v1.11]** Registering a new phone without a valid Replacement QR is rejected: a shared onboarding QR works only for an employee who has never had a device (no active, replaced or disabled device in their history). There is no tenant setting to relax this (v1.2–v1.10 allowed one).
- Old device receives a "Device deactivated" message at next login/heartbeat and is logged out.
- Attendance from the old device after replacement is rejected; events are logged.

## 21.2 Lost / Stolen Device

Workflow:
1. HR opens Employee → Device → **Disable Device**.
2. The device token is revoked immediately; the app session is terminated at the next request.
3. Attendance from that device is rejected.
4. Employee can continue with a new device through the replacement workflow (21.1).
5. Audit log records: "Device Disabled" with reason (lost / stolen / other).

Rules:
- An employee with no active device is shown as "No device" on the employee profile and treated per 6.5 for attendance.
- HR may re-enable a disabled device only if it was disabled in error (audited); otherwise a new registration is required.

## 21.3 Supported Device Requirements **[v1.3]**

The 310 organization prepares compliant phones for employees before the pilot. Requirements are driven by the geofencing, attestation and background-location features (6.7, 6.8).

**Android (most of the fleet)**

| Requirement | Minimum | Recommended for purchase |
|---|---|---|
| OS version | **Android 10** | **Android 12 or newer** |
| Google services | **Google Play services + Google Play Store, Play Protect-certified device** (needed for Play Integrity and the Geofencing API) | same |
| Location hardware | GPS/GNSS | GPS + GLONASS/Galileo/BeiDou |
| RAM / storage | 3 GB / 32 GB with 1 GB free | 4 GB or more |
| Security state | Not rooted, bootloader locked, no custom ROM | same |
| Developer options | "Mock location app" must be unset | same |
| Battery | Battery optimization allowed to be switched off for the app; "Always allow" location | same |

- **Not supported:** phones without Google Mobile Services (e.g. Huawei devices released after 2019 with HarmonyOS/HMS only), rooted devices, emulators, custom ROMs, very old budget phones with Android 9 or below.
- **Brand notes:** Samsung, Google Pixel, Xiaomi/Redmi/POCO, Oppo/Realme, Vivo, Honor (with GMS) are supported provided the OEM battery/auto-start settings are configured (see 6.8 onboarding checklist). Xiaomi, Oppo, Vivo and Huawei-derived UIs are the most aggressive about killing background apps and need the OEM-specific steps.

**iOS**

| Requirement | Minimum | Recommended |
|---|---|---|
| OS version | **iOS 15** (iPhone 6s and newer) | iOS 16 or newer |
| Location | "Always" location permission with Precise Location on; Background App Refresh on | same |
| Security state | Not jailbroken | same |

**Simple rule for HR/the organization:** "Any Android phone with **Android 10 or newer** and Google Play Store that is not rooted, or any iPhone with **iOS 15 or newer**, will work. Buy **Android 12+ / 4 GB RAM** if purchasing for employees."

**Readiness process before pilot**
1. HR collects each employee's phone make, model and OS version (a short form or a field on the employee record: **Device model, OS version, Compatible Yes/No**).
2. Employees on non-compliant phones are listed in a **Device Readiness report** (count by reason: OS too old, no Google services, rooted, no phone).
3. The organization either upgrades/replaces the phone, issues a company device, or classifies the employee as **Manual attendance (no device)** (15.4).
4. Before go-live, a **pilot test per phone model** group is run at a real location: install, register, enter/leave geofence, verify arrival time, background behaviour after 2 hours idle, battery use.
5. The app collects device model and OS version at registration (non-sensitive technical data) so the readiness report stays accurate.

---

# 22. Data Model and Time Rules **[v1.2]**

## 22.1 Effective-dated Rules (versioning)

- Attendance rules (Work Start Time, Grace, No-show Cut-off, Minimum Stay, accuracy threshold) and **shift templates, patterns and assignments** (23) are stored as **effective-dated versions** (`valid_from`, `valid_to`).
- Status for a given date is always computed with the rule version in force on **that date**; changing a rule never rewrites history.
- Likewise for Primary Location, Department, Temporary Location, **Rank (цол) and Job Position (албан тушаал)** assignments (rank and position are stored separately because a rank changes only by promotion, while a position changes with a transfer or new role — **[v1.10]**): store history with effective dates; reports show the value as of the report date.
- Holidays and non-working days are versioned by date and can be added retroactively only with an audit entry and an explicit "recompute" action.

## 22.2 Time Zones

- All timestamps are stored in **UTC**; each tenant has an IANA time zone (default **Asia/Ulaanbaatar**) used for day boundaries, Work Start Time, cut-offs, holidays and reports.
- A "work day" is evaluated in the **location's** time zone (defaults to the tenant's), supporting tenants with locations in different zones in future.
- Daylight-saving changes are handled by the time zone database, not by fixed offsets.

## 22.3 Event Model

- Raw events are **immutable and append-only**: `device_event` (enter/exit/heartbeat/permission-change), with client event ID, device ID, server receive time, device time, monotonic delta, accuracy, provider, mock flag, attestation result.
- Daily **attendance_result** (per employee per date) is **derived** from events, reason assignments, assignments, holidays and corrections; it can be recomputed deterministically for any date range (used for late-sync, rule changes and corrections).
- A **daily summary** table (per tenant / location / department / date / status counts) is materialized from attendance_result and drives dashboard and analytics (see 24.2).
- The notification engine (19) subscribes to domain events (late, no-show, location disabled, device replaced, correction approved) emitted when attendance_result changes.

---

# 23. Shifts and Non-working Days **[CHANGED v1.3]**

**Decision:** some employees (e.g. Хамгаалалт / guards) work **24-hour shifts**. Shift scheduling is therefore **in the MVP**. Employees without a shift assignment keep the standard schedule (Working Week, working-day exceptions, public holidays; see 14).

## 23.1 Concepts

- **Shift Template:** name, start time, end time or duration (up to 24 h; may cross midnight), grace minutes, no-show cut-off (hours after start), early-arrival window, location default (optional), flag "observes public holidays".
  Examples: `Өдрийн 08:00–17:00`, `Шөнийн 20:00–08:00`, `24 цаг 08:00–08:00`.
- **Shift Pattern (rotation):** a repeating sequence of days, each day mapped to a template or OFF. Examples: `24 цаг ажил / 48 цаг амралт` (cycle of 3 days: Shift, Off, Off), `2 өдөр / 2 шөнө / 4 амралт` (cycle of 8 days).
- **Shift Assignment:** employee ↔ pattern (or single fixed template) with `from_date`, optional `to_date`, and **cycle start date** (which day of the cycle the employee is on at `from_date`). Several guards on a team share a pattern with different cycle offsets.
- **Shift Override (swap / extra shift):** HR can add or remove a shift on a single date for an employee (swap, replacement, extra duty, sick cover). Overrides are audited and take effect from the selected date forward in the expected-attendance calculation.
- **Standard schedule (implicit):** no assignment = the Working Week (14.1) of the expected location on its working days.

## 23.2 Work Date and Time Rules for Shifts

- The **work date** of a shift is the **date its shift starts** in the location time zone. A `20:00–08:00` shift starting 2026-10-06 belongs to 2026-10-06 and is shown under that date on the dashboard and reports, even though it ends on 2026-10-07.
- **Late (6.2):** Arrival ≤ shift start + grace → Цагтаа; later → Хоцорсон.
- **No-show (6.3):** after shift start + cut-off (default 2 h; per template) with no valid arrival and no reason → Ирээгүй. For 24 h shifts the same 2 h default applies unless the template sets another value.
- **Early-arrival window:** an entry counts for the shift only from `shift start − early window` (default 2 h; per template). Earlier entries are stored but are attributed to the previous shift or ignored.
- **Handover / already on site:** if the device is **already inside the geofence** at the start of the early window (e.g. the guard stayed after the previous duty), the arrival time is the window start and the status is Цагтаа, provided the heartbeat/presence check (6.8) confirms the device was inside at shift start. If presence cannot be confirmed (no heartbeat), the system falls back to the first confirmed entry.
- **Back-to-back shifts and 24 h shifts:** a day's arrival is matched to the **nearest shift start** within its window; one arrival can never satisfy two shifts. For a 24 h shift (08:00 → 08:00 next day) the arrival is judged only at the start; the shift end (08:00 next day) is recorded as the departure when the device leaves the geofence after the shift end (or after the min-stay rule, 6.4).
- **Departure and leaving early:** in V1 departure time is recorded and shown. Automatic "left early / absent mid-shift" detection and overtime calculation are **V2** (presence analytics), but the raw enter/exit events are kept (6.4) so it can be added without change.
- **Minimum geofence stay (6.4)** applies unchanged to shift arrivals.
- **Reasons and shifts (11):** a reason applies per calendar date range; a reason covering the shift's work date makes the shift **Шалтгаантай** (6.6). A reason ending the day before the shift start does not affect it.
- **Public holidays:** a template with "observes public holidays" off (default for 24 h guard templates) means the employee works and is counted on holidays; with it on, the employee is not expected on holidays.

## 23.3 Dashboard, Reports and Counts

- "Total Employees" and the per-location breakdown count **employees expected on the selected work date** (standard schedule + shifts that start that date), so a guard on an off day is not counted.
- Daily Attendance adds the columns **Shift** (template name) and **Shift Start–End**, and a **Shift** filter (Бүгд / Standard / each template).
- Weekly/Monthly reports show shifts worked, late/no-show counts per employee, and expected-vs-attended days according to the assigned pattern.
- Reports on overnight shifts attribute the whole shift to its start date (23.2) to avoid double-counting at midnight.

## 23.4 Management UI and Import

- **Shift Templates:** Org Admin and HR create/edit templates and patterns (HR can assign; Org Admin can also manage templates; changes are effective-dated and audited).
- **Assign shifts:** per employee, per team (bulk), or via Excel import (columns: Employee Number, Pattern or Template, Cycle Start Date, From Date, optional To Date). Import follows the dry-run rules in 12.3.
- **Roster view:** a calendar grid (employees × dates) shows each employee's expected shift/off day for the next 31 days; HR can add an override by clicking a cell. Conflicts (overlapping shifts for one employee, a shift overlapping a reason or temporary assignment) are flagged on save.
- **Validation:** an employee cannot have overlapping assignments; a 24 h shift followed immediately by another shift is allowed but flagged; each assignment's template must be valid for the employee's expected location.

## 23.5 Architecture Requirement

- The "expected attendance for employee on date" function (6.1) is the **single interface** returning `{expected, location, shift_start, shift_end, grace, cutoff, early_window}` for the standard schedule and all shift types. The attendance engine, dashboard summaries and reports consume only this result and never read the shift tables directly.
- Shift data is effective-dated (22.1); recomputation for a date range after a roster change must be idempotent and audited.
- Time handling uses UTC storage and tenant/location time zones (22.2); shifts crossing midnight are stored with explicit start and end instants per work date.

## 23.6 Remaining Questions (non-blocking)

- Required list of shift templates and patterns for 310 (to seed during the pilot): to be supplied by HR (Ganbat).
- Whether guards are required to be physically present continuously (leads to V2 presence analytics) or only at shift start/end.

---

# 24. Scale and Performance **[v1.2]**

> **Pilot scope [v1.5]:** for roughly the next **4 months** the platform runs as a **pilot with 1–2 tenants** (310 and at most one more). Sections 24 and 25 therefore define a **Pilot tier** (what is built and committed to now) and keep the **Production tier** as the target for later. The architecture must not preclude the production tier, but it is **not** built or paid for during the pilot.

## 24.1 Ingest and Processing
- **Morning-peak load:** a single tenant produces ~320 events within ~15 minutes; the platform must handle all tenants peaking at 08:00 local time. **Pilot target [CHANGED v1.5]:** sustain **20 events/second** (one or two tenants, ~640 employees, all arriving within minutes), with p95 event-to-visible < 60 seconds. **Production target (later):** 200 events/second, horizontally scalable.
- Events enter through a **queue** (PostgreSQL-backed in the pilot, see 16); API acknowledges after durable enqueue; workers compute attendance results asynchronously and idempotently (dedupe on client event ID).
- Back-pressure and retry with dead-letter queue and alerting.

## 24.2 Dashboard Performance
- The < 2 s dashboard target is met from the **materialized daily summary** (22.3) and cache, not by live aggregation over raw events. Summary rows are updated incrementally on each attendance_result change; a nightly job reconciles and corrects drift.
- Date-range analytics (weekly/monthly) read from summaries; per-employee drill-down reads indexed attendance_result.

## 24.3 Tenant Isolation and Data Layout
- Every table carries `tenant_id`; Postgres **Row-Level Security** enforces tenant isolation as defence in depth, in addition to application checks. Automated tests must prove one tenant cannot read another's data through any API.
- Tenant-scoped composite indexes (`tenant_id`, date, …).
- **[CHANGED v1.8]** Monthly partitioning of the large append-only tables (`device_event`, `audit_log`) is **deferred to the production tier**: at pilot volume (~2 million event rows per year) it adds complexity (partitioned unique constraints complicate idempotent event ingest) with no benefit. Pilot retention is done by batched nightly deletes/updates (15.3). Table design must keep the partitioning option open (time column in indexes; dedupe key separable).
- Per-tenant rate limits and quotas prevent a noisy tenant from degrading others.

---

# 25. Operations **[v1.2]**

## 25.1 Observability and SLOs
- **SLO [CHANGED v1.5]:**
  - **Pilot tier:** **99.5%** API availability during working hours (06:00–20:00 tenant time, Mon–Sun), no overall target; ingest lag per 24.1. Roughly up to ~2 hours of unplanned downtime per month is tolerated. Planned maintenance is announced and done outside 06:00–20:00 (24 h shift staff are covered by the offline queue, 6.8).
  - **Production tier (later):** 99.9% during working hours, 99.5% overall.
- Metrics, structured logs and traces for API, workers, queue depth, ingest lag, event rejection reasons, mobile heartbeat coverage and crash-free rate.
- Alerts (paged): ingest lag > 5 min, queue depth growing, error rate > 2%, failed deployments, attestation-failure spike, backup failure. Public/internal status page.

## 25.2 Backups and Disaster Recovery
- Automated daily full + continuous WAL backup (point-in-time recovery) of PostgreSQL; backups encrypted and stored in a separate region/account.
- **Pilot tier [CHANGED v1.5]:** **RPO ≤ 15 minutes** (managed point-in-time recovery), **RTO ≤ 8 hours**; single region, **no multi-zone standby database**; backup copies kept in a second region or separate account. A restore is **tested before go-live and then once per quarter** and the result recorded.
- **Production tier (later):** RPO ≤ 15 minutes, RTO ≤ 4 hours, multi-zone database standby, cross-region recovery plan.
- Mobile offline queue (6.8) covers short outages without data loss for employees.

## 25.3 Environments
- **Pilot tier [CHANGED v1.5]:** **Production** plus one small **Staging** environment (can be stopped outside testing hours to save cost); developers use local environments for dev. Staging is isolated from production.
- **Production tier (later):** Dev, Staging and Production, isolated. Staging mirrors production topology with **seeded synthetic tenants** (including a 320-employee, 6-location "310-like" tenant) for load, geofence-simulation and regression tests. No production personal data in non-production environments.

## 25.4 Release Strategy
- CI/CD with automated tests (unit, integration, tenant-isolation, attendance-rule golden tests from sections 6.2–6.6), infrastructure as code, and database migrations that are backward compatible (expand → migrate → contract).
- **Feature flags** and **staged rollout per tenant** (internal test tenant → pilot 310 → second pilot tenant → general availability after the pilot).
- **Mobile versioning:** backend publishes `min_supported_version` and `recommended_version`; below minimum the app is blocked with an upgrade prompt; below recommended it nags. Store releases use staged rollout with crash-rate rollback gates.
- API versioning (`/v1`) with a deprecation policy so old app versions keep working until force-upgrade.

## 25.5 Period Close
- Org Admin/HR can **close a month**: attendance results for the closed period are locked against corrections unless a reopen is approved (audited). Closed-period exports are reproducible.

## 25.6 Security Operations
- Dependency and container vulnerability scanning in CI; annual third-party penetration test and an immediate one before launch.
- Documented incident-response and breach-notification runbook (15.3); audit of privileged (Super Admin) access.
- **Traffic protection [v1.15]:** a web application firewall in front of the whole stack (Cloudflare in front of the Hosting VPS) with managed and custom rules and rate limits; the server accepts web traffic only from it; behaviour-based adaptive rate limiting in the API that escalates from throttling to temporary IP bans (signed-in users are not punished for others on a shared address); and a written **DDoS response plan** (roles, notification tree, switches, failover) rehearsed every quarter. Files: `docs/security/`.
- Support access to tenant data requires tenant approval and is time-limited and logged.

---

# 26. Open Questions for Confirmation

1. **Status precedence (6.6):** a reason assignment overrides arrival status — confirm.
2. **No-show cut-off default of 2 hours** — confirm, or set per location.
3. **Time zone:** single tenant time zone (Asia/Ulaanbaatar) assumed.
4. ~~**Weekends / shifts**~~ **Resolved v1.3:** 24 h shifts exist and are in the MVP (23).
5. **Manager export permission** default.
6. **Archive retention period** (default 12 months) and audit retention (default 12 months).

Added in v1.2 **[v1.2]**:

7. ~~**Shift work (23)**~~ **Resolved v1.3:** yes, 24 h shifts in the MVP. Open: list of templates/patterns for 310 (23.6).
8. ~~**Anomaly policy (6.7)**~~ **Resolved v1.3:** accept and flag.
9. ~~**Correction approval (6.9)**~~ **Resolved v1.3:** no second approval; compensating controls apply.
10. ~~**Minimum OS support (6.8)**~~ **Resolved v1.6:** all 310 employees will have compliant phones (21.3); no employee is expected to need a company device or manual attendance. The Device Readiness report (21.3) still verifies this before go-live; the manual-attendance flag (15.4) stays available for consent refusal.
11. ~~**MFA for HR/Admin (15.2)**~~ **Resolved v1.4:** TOTP via Google Authenticator, no SMS.
12. **Legal review [decisions made incl. Option B foreign hosting in Singapore, confirmation pending]:** the business has decided on signed voluntary consent attached to the employment contract (15.4), 2-year retention (15.3) and hosting abroad (15.3). Legal counsel to confirm before go-live that this is lawful under the Law on Personal Data Protection, including the cross-border wording in Appendix A and the alternative for employees who decline.
13. ~~**Retention (15.3)**~~ **Decided v1.4:** attendance records kept 2 years. Legal counsel to confirm this satisfies labour/archival law (also disputes and audits).
14. **Excel import (12.3):** invite-based onboarding replaces password columns — confirm HR is comfortable distributing an invite sheet instead of passwords.
15. ~~**SLO and DR (25)**~~ **Resolved v1.5:** pilot tier only (99.5% working hours, RPO 15 min, RTO 8 h) for the next ~4 months with 1–2 tenants; production tier is deferred.

---

# 27. Change Log

| Version | Change                                                                                                                                  |
|---------|-----------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | Initial MVP definition                                                                                                                  |
| 1.1     | Added: Primary Location (12), Temporary Location Assignment (12.1), late rule (6.2), no-show cut-off (6.3), employee lifecycle (12.2), device replacement/loss workflow (21), minimum geofence stay (6.4), location-off state (6.5), Excel/PDF export (20), Reason Report (11.1), Departments (13.1), location-level percentages (8), notification engine hook (19), audit log expansion (15.1) |
| 1.2     | Added (CTO review): attendance integrity / anti-spoofing / Anomaly Review Queue (6.7); offline queue, server time authority, background-restriction handling, heartbeat, force-upgrade (6.8); basic attendance correction pulled into MVP (6.9, 19); role scope for Manager/HR (4); import safety and invite-based onboarding (12.3); identity and access hardening (15.2); privacy and compliance (15.3); effective-dated rules, time zones, event model (22); shifts and non-working days decision (23); scale and performance (24); operations: SLOs, DR, environments, release, period close, security ops (25); precise success-metric definitions (18); extended open questions (26); fixed section cross-references (device lifecycle 21, changelog 27). |
| 1.3     | Business decisions: 24 h shift scheduling added to MVP and section 23 rewritten (templates, rotation patterns, assignments, overrides, work-date rule, handover, roster view); expected-attendance function extended (6.1); Suspicious events now accept-and-flag (6.7); direct HR correction without second approval, with compensating controls (6.9); supported-device requirements and readiness process (21.3); voluntary signed consent form printed by HR and attached to the employment contract, with registration gate, scan upload, withdrawal and manual-attendance alternative (15.3, 15.4, Appendix A); open questions updated. |
| 1.4     | Decisions: TOTP (Google Authenticator) two-step login for Super Admin / Org Admin / HR, no SMS (15.2); attendance records retained 2 years (15.3); open questions 11 and 13 closed. |
| 1.5     | Pilot-only operations decision (1–2 tenants, ~4 months): pilot tier vs deferred production tier for SLO (99.5% working hours), DR (RPO 15 min / RTO 8 h, no multi-zone standby), environments (prod + small staging), throughput target (20 events/s), PostgreSQL-backed queue and no Redis in the pilot (16, 24, 25); open question 15 closed. |
| 1.6     | Working Week (Mon–Fri 08:30–17:30, Sat/Sun off) configurable by Org Admin with per-location override and working-day exceptions (14.1, 13); Holiday Calendar with ranges, types, per-location scope, yearly copy, import, worked-on-day-off display and recompute (14.2); 6.1 updated; decisions recorded: all employees have compliant phones (26 Q10), data hosted abroad with cross-border consent wording (15.3, Appendix A), 2-year retention in consent text. |
| 1.7     | Decision: foreign cloud hosting (Option B) confirmed over Mongolian hosting; foreign processors register added to 15.3 (hosting, Play Integrity / App Attest, Android location services, FCM, monitoring, email/SMS) and listed in the consent text (Appendix A, item 7); legal confirmation still pending (26 Q12). |
| 1.8     | Applied architecture review deviations: (1) device-event partitioning deferred to production tier (24.3); (2) raw coordinates erased after 30 days while the 2-year geofence-level event stays (15.3); (3) heartbeat is best effort, tolerance 60 min (6.8); (4) attestation: registration strict, event batches accept-and-flag when the verdict service is unavailable (6.7); (5) PostgreSQL-backed queue confirmed (16, 24, no change). Hosting region fixed: Singapore (15.3, Appendix A). |
| 1.9     | Release plan decided (17.1): Release 1 "Pilot-Lite" for standard-schedule employees (≈ 5.5 months), Release 2 with shifts, full analytics, PDF and tenant admin (≈ 8 months); interim manual-attendance handling for guards; "4 months" = period with only 1–2 tenants. |
| 1.9.1   | Clarified 6.4 minimum-stay rule (short stays before confirmation are discarded; after confirmation later exits/entries do not change the status), removing a contradiction with the example table. |
| 1.10    | Rank (цол: e.g. Ахлагч … Хурандаа) and Job Position (албан тушаал) are separate employee fields, each effective-dated (12, 22.1); lists of ranks and positions are tenant-defined; dashboard drill-down lists show both. |
| 1.11    | Shared QR is for first device registration only and may be posted publicly or shown on a screen; a new phone always needs an HR replacement QR (5, 21.1); HR can regenerate a shared QR. |
| 1.12    | Refinements made while building the APIs: an employee has **one reason at a time** and a reason may be open-ended (11); a reason that has not started can be deleted, a started one is ended (11); a new working week applies from today or later only (14.1); a shift template/pattern in use is replaced by a new version, never edited (23, 22.1); holiday changes reaching today or the past need a recompute confirmation (14.2). |
| 1.13    | Refinements: holiday import accepts .xlsx or CSV with the 12.3 dry-run / valid-only / abort rules and skips existing holidays (14.2); attendance rule versions are effective-dated per tenant or location with the PRD defaults until saved (13, 6.2–6.4); the roster calendar flags duties that collide with reasons (23.5); exports are Excel, CSV and PDF, audited, with Manager export off by default via tenant setting `manager_may_export` (20). |
| 1.14    | Employee code is system-assigned (16 digits: date + 8 random) and is the default login name; Овог and Нэр are separate fields; rank (цол) and position (албан тушаал) are free text instead of tenant lists (12, 22.1). Excel import files carry no code column. |
| 1.15    | Security operations: WAF in front of the stack, adaptive IP throttling/ban in the API, DDoS response plan (25.6); hosting assumed to be a Hostinger VPS behind Cloudflare for the pilot (provider choice in the Architecture is still open for managed PostgreSQL with PITR). |
| 1.16    | Attendance core specified as built: device events are timed by the server (receive time minus the phone's monotonic age; CLOCK_SKEW > 2 min flagged, events older than 24 h and ENTER fixes worse than 50 m are stored and flagged but not counted); statuses are derived data that can be rebuilt (`POST /attendance/recompute`), a worker re-evaluates every minute so NO_SHOW appears exactly at the cut-off; dashboard Total = everyone expected (on time + late + excused + no show + not yet decided), rates are shares of it with one decimal. |
| 1.17    | Backups (25.2) specified as built: WAL archiving to an off-site, encrypted store (public-key encryption, private key offline), daily verified base backup, `archive_timeout` 4 min (typical RPO about 5 min), weekly logical dump, retention 7 daily / 4 weekly / 3 monthly bases; the 10-minute check alerts at 10 min and pages at 15 min (= RPO); restore onto a fresh machine rehearsed before go-live and quarterly; RTO is hours (no standby). The backup provider is a processor under 15.3 (DPA and legal clearance needed); object storage and secrets are backed up separately. |
| 1.18    | Corrections (6.9) and the Anomaly Review Queue (6.7) specified as built: a correction replaces an earlier one for the same day (old kept, revoked), only expected days within 31 days; the Corrections report flags a user with more than 10 corrections a day; staff accounts have no employee record, so the self-correction rule cannot arise. Queue codes built: MOCK_LOCATION, LOW_ACCURACY, CLOCK_SKEW; Confirm lets a held-back low-accuracy ENTER count, Reject rebuilds the day; three flagged events in seven days mark an employee. Still open: IMPOSSIBLE_SPEED, attestation and DEVICE_CONFLICT checks, month closing, optional approval step. |
| 1.19    | IMPOSSIBLE_SPEED built (6.7): events carry coordinates; a fix is compared with the trusted fixes before and after it (accuracy radii subtracted, limit 150 km/h); flagged events are accepted, count and enter the review queue. Raw coordinates are erased after 30 days (15.3), the event stays. Still open: teleport-without-movement, zero-jitter, attestation and DEVICE_CONFLICT checks. |
| 1.20    | Batch attestation and DEVICE_CONFLICT built (6.7): one verdict per event batch (FAILED is flagged and queued, UNAVAILABLE is only noted so an outage never blocks attendance, five in a row alert HR); DEVICE_CONFLICT when a batch is signed by another install key or when another employee's device reports the same places at the same times at least three times at two or more places. Alerts for HR in `device-alerts`. The Google Play Integrity and Apple App Attest verifiers themselves are still to be built (Spike 2); until then enforce mode treats a token as unavailable. |

---

# Appendix A. Draft Employee Consent Text **[v1.3]**

> **DRAFT for legal review.** This text is a starting point only and must be reviewed and approved by Mongolian legal counsel before use. Version: `consent-v1-draft`.

**Байршлын мэдээлэл боловсруулах, ирц бүртгэхийн тулд өгөх сайн дурын зөвшөөрлийн хуудас**

Байгууллага: ____________________ (регистр: ____________)
Ажилтны овог, нэр: ____________________  Ажилтны код: ________
Хэлтэс: ____________  Үндсэн салбар: ____________
Маягтын дугаар: ________ Хувилбар: consent-v1-draft Огноо: ________

1. Би **Timekeeper Work** ирцийн системд өөрийн гар утсаар ирцээ автоматаар бүртгүүлэхийг **сайн дураараа** зөвшөөрч байна.
2. **Ямар мэдээлэл цуглуулах вэ:** миний утас ажлын байрны тодорхойлсон бүс (геофенс) руу орсон/гарсан цаг, утасны төрөл ба үйлдлийн системийн хувилбар, аппын төлөв (байршлын зөвшөөрөл асаалттай эсэх).
3. **Хэзээ цуглуулах вэ:** зөвхөн миний ажлын цаг/ээлжийн хугацаанд ажлын байрны бүстэй холбоотой. Ажлын бус цагт болон ажлын байрны бүсээс гадна миний байршлыг хянахгүй, түүхийг нь хадгалахгүй.
4. **Зорилго:** зөвхөн ирц (цагтаа, хоцорсон, ирээгүй) тооцох. Бусад зорилгоор ашиглахгүй, гуравдагч этгээдэд худалдахгүй.
5. **Хэн харах вэ:** Хүний нөөцийн ажилтан, байгууллагын админ, миний харьяа салбар/хэлтсийн менежер (зөвхөн ирцийн мэдээлэл).
6. **Хадгалах хугацаа:** ирцийн бүртгэл 2 жил; сэжигтэй үйл явдлын нарийвчилсан координат 30 хоног; бусад нь хуулийн дагуу.
7. **Мэдээлэл хадгалах газар:** миний мэдээллийг Монгол улсын гадна байрлах үүлэн серверт (улс/бүс: Сингапур) хадгалж, боловсруулахыг зөвшөөрч байна. Мэдээллийг шифрлэж хамгаална. Утасны аюулгүй байдлыг шалгах (Google/Apple), байршил илрүүлэх (Google), мэдэгдэл илгээх үйлчилгээ зэрэг гуравдагч талын үйлчилгээнд зөвхөн техникийн шаардлагатай мэдээлэл дамжих боломжтойг ойлгосон. Эдгээр үйлчилгээний жагсаалтыг Хүний нөөцөөс авч танилцах эрхтэй.
8. **Миний эрх:** би өөрийн ирцийн түүхийг аппаас харах, мэдээллээ засуулах, шаардлагатай бол устгуулах эрхтэй.
9. **Зөвшөөрлөө эргүүлэн татах:** би хүссэн үедээ Хүний нөөцөд бичгээр хандаж зөвшөөрлөө цуцалж болно. Цуцалсан тохиолдолд миний утаснаас байршил цуглуулахаа зогсооно. Энэ нь миний ажлын харилцаанд сөрөг нөлөө үзүүлэхгүй бөгөөд ирцийг надад зориулсан **өөр аргаар** (жишээ нь Хүний нөөц гараар бүртгэх) бүртгэнэ.
10. Би энэ хуудасны агуулгыг уншиж, ойлгосон болно.

Ажилтны гарын үсэг: ____________  Огноо: ________
Хүлээн авсан Хүний нөөцийн ажилтан: ____________  Гарын үсэг: ________  Огноо: ________

*Энэ хуудсыг ажилтны хөдөлмөрийн гэрээний хамт хавсаргаж хадгална.*
