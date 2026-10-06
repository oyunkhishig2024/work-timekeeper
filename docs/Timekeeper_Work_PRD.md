# Timekeeper Work
## Product Requirements Document (PRD)

Version: 1.1
Product: Timekeeper Work
Owner: Onki
Status: Requirements Specification (pre-development review applied)

> v1.1 нь v1.0 MVP PRD-д дутуу байсан бизнес дүрэм, edge case, operational requirement-үүдийг нэмсэн хувилбар.
> Шинэ/өөрчлөгдсөн хэсгийг **[NEW]** / **[CHANGED]** гэж тэмдэглэв. Өөрчлөлтийн бүртгэлийг 20-р бүлгээс үзнэ үү.

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

## Manager

Permissions:
- View dashboard
- View attendance
- View analytics
- Search employees

View-only access.

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
- QR contains no personal information

Device Rules:
- One active device per employee
- New device registration disables previous device
- Attendance accepted only from active device

(See Section 22 for the full Device Lifecycle.)

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

The system determines the expected location of an employee for a given date as follows (first match wins):

1. Not an active employee on that date (disabled/archived, or before start date) → **not expected**, excluded from all counts.
2. Date is a public holiday or non-working day for the tenant → **not expected**, excluded from counts.
3. Active **Temporary Location Assignment** covering the date → **expected at the temporary location**.
4. Otherwise → **expected at the employee's Primary Location**.

Rules:
- Every employee MUST have exactly one Primary Location (mandatory field; Excel import rejects rows without it).
- Attendance is valid only when the geofence entry occurs at the **expected location** for that date. Entry to another tenant location is stored as an event but does not satisfy attendance (flagged "Wrong location" for HR review).
- Dashboard and branch breakdown counts use the **expected location** for the selected date (so a temporarily assigned employee counts toward the temporary location for that period).
- Work Start Time and Grace Minutes are taken from the **expected location**.

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
- Exits shorter than the Minimum Stay (e.g. 1–2 min) are ignored and do not reset the stay; the same applies to re-entry.

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
- The status does **not** mark the employee as present. If no valid arrival is recorded by the no-show cut-off, the employee becomes **Ирээгүй** (HR can then assign a reason or request a manual correction in V2).
- Repeated disabling is logged in the audit log.
- The employee app shows a persistent warning prompting the employee to re-enable location.

## 6.6 Status Precedence **[NEW]**

When multiple conditions apply on one day:

1. Active reason assignment → **Шалтгаантай** (arrival time, if any, is still recorded and shown).
2. Else a confirmed arrival → **Цагтаа** / **Хоцорсон**.
3. Else cut-off passed → **Ирээгүй**.
4. Else → **Хүлээгдэж байна**.

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

- Employee Number (unique per tenant)
- Full Name
- **Department** (required)
- **Primary Location** (required)
- Username
- Status (Active / Disabled / Archived)
- Start Date, End Date (optional)

Excel Import Fields:

- Employee Number
- Full Name
- Department
- **Primary Location** (must match an existing location, rows with unknown location are rejected with a row-level error report)
- Username
- Password

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

---

# 13. Location Management

Fields:

- Location Name
- Address
- Latitude
- Longitude
- Geofence Radius
- Work Start Time
- Grace Minutes
- **No-show Cut-off (hours after start, default 2)** **[NEW]**
- **Minimum Geofence Stay (minutes, default 3)** **[NEW]**

Geofence Radius:
- Minimum: 100m
- Maximum: 500m

Rules **[NEW]**:
- A location cannot be deleted while employees have it as Primary Location; it can be deactivated after reassigning employees.
- Changing Work Start Time / Grace applies from the effective date forward and does not recalculate past attendance.

## 13.1 Departments **[NEW]**

- Org Admin manages the department list (name, active flag).
- Each employee belongs to exactly one department.
- A department can span multiple locations.
- Departments are used for filters, analytics and reports.
- A department cannot be deleted while it has active employees.

---

# 14. Public Holidays and Working Hours

Public Holidays:
- Organization Admin can define official holidays.
- Holidays and non-working days excluded from expected attendance and counts (see 6.1).

Working Hours:

Example:
- Start Time: 08:00
- Grace Minutes: 15

Arrival 08:00–08:15 = Цагтаа; 08:16 and later = Хоцорсон (see 6.2).
No-show is evaluated after Start Time + 2 hours by default (see 6.3).

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
- Role-based access control

Excluded from MVP (see Future Versions):
- Push / notification engine (design hooks only, see 19)

---

# 18. Success Metrics

- Attendance Accuracy > 95%
- Attendance Capture Rate > 99%
- Employee Onboarding < 5 minutes
- Dashboard Load Time < 2 seconds
- Report export (monthly, 320 employees) < 10 seconds **[NEW]**

---

# 19. Future Versions

Version 1 (architecture hook only) **[NEW]**:
- **Notification Engine**: not delivered in V1, but the event model must be designed now so that it can be added without architecture change. Notification-capable events: employee late, employee no-show, location disabled, device replaced, QR generated. Example HR notification: "Бадам Гэндэн — Хоцорсон — 08:24". Channels: FCM push, in-app, email. Per-user subscription settings.

Version 2:
- Push notifications (using the notification engine above)
- Overtime analytics
- Attendance correction workflow

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
- Registering a new device without a valid Replacement QR (or a general onboarding QR where HR has allowed it) is rejected.
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

---

# 22. Open Questions for Confirmation

1. **Status precedence (6.6):** a reason assignment overrides arrival status — confirm.
2. **No-show cut-off default of 2 hours** — confirm, or set per location.
3. **Time zone:** single tenant time zone (Asia/Ulaanbaatar) assumed.
4. **Weekends / shifts:** non-working days and shift schedules are not yet defined (single Work Start Time per location). Confirm whether shift work (e.g. Хамгаалалт, 24h guard duty) is needed in V1.
5. **Manager export permission** default.
6. **Archive retention period** (default 12 months) and audit retention (default 12 months).

---

# 23. Change Log

| Version | Change                                                                                                                                  |
|---------|-----------------------------------------------------------------------------------------------------------------------------------------|
| 1.0     | Initial MVP definition                                                                                                                  |
| 1.1     | Added: Primary Location (12), Temporary Location Assignment (12.1), late rule (6.2), no-show cut-off (6.3), employee lifecycle (12.2), device replacement/loss workflow (21), minimum geofence stay (6.4), location-off state (6.5), Excel/PDF export (20), Reason Report (11.1), Departments (13.1), location-level percentages (8), notification engine hook (19), audit log expansion (15.1) |
