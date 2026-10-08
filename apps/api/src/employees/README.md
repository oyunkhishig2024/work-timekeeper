# Organization and employees API (PRD 12, 13, 4)

Departments, locations, employees, employee login accounts and data scope. All routes are under `/v1`.
Every change is audited (before/after) in the same transaction.

## Who can do what

|                                                                     | Org Admin           | HR                                     | Manager                                        |
| ------------------------------------------------------------------- | ------------------- | -------------------------------------- | ---------------------------------------------- |
| Read departments, locations                                         | ✔ (with headcounts) | ✔ (with headcounts)                    | ✔ (no headcounts)                              |
| Create / edit / deactivate / delete departments and locations       | ✔                   | –                                      | –                                              |
| Read employees                                                      | all                 | all, or only their scope if one is set | **only their scope** (none assigned = nothing) |
| Create / edit employees, disable, reactivate, archive, create login | ✔                   | ✔ (inside their scope if set)          | –                                              |
| Force an early archive                                              | ✔                   | –                                      | –                                              |
| Set a user's data scope (`PUT /users/:id/scope`), list users        | ✔                   | –                                      | –                                              |

An employee outside the caller's scope looks exactly like one that does not exist (`404 EMPLOYEE_NOT_FOUND`).

## Departments `/departments`, locations `/locations`

`GET /` (`?active=true|false`), `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (204).
Locations: `name, address?, lat, lng, radiusM (100–500, integer), workingWeekMode (INHERIT|OVERRIDE)`.
Rules (PRD 13, 13.1): names are unique; one **cannot be deactivated while active employees use it** and
**cannot be deleted once any employee (or temporary assignment) ever referenced it** — deactivate instead
(`409 DEPARTMENT_IN_USE` / `LOCATION_IN_USE`). Inactive ones cannot be assigned to employees.

## Employees `/employees`

- `GET /employees?q&status&departmentId&locationId&scheduleMode&manualAttendance&hasDevice&consentStatus&sort&order&limit&offset`
  → `{ total, limit, offset, items }`. **Default `status=ACTIVE`**: disabled and archived employees are hidden unless
  `status=DISABLED|ARCHIVED|ALL` (PRD 12.2). `q` matches name or employee number, case-insensitive (Cyrillic too);
  `%` and `_` are literal. Each item has department, location, consent status and `hasActiveDevice`.
- `GET /employees/:id` — adds `account` (login) and the active `device`.
- `POST /employees` `{lastName, firstName, departmentId, primaryLocationId, startDate?, endDate?, scheduleMode?, manualAttendance?, rank?, position?}`
  — **Овог** (`lastName`) and **Нэр** (`firstName`) are separate required fields; `fullName` ("Овог Нэр") is derived. The **employee code is assigned by the system**: 16 digits = registration date `YYYYMMDD` (tenant time zone) + 8 random digits, unique, never changed, not accepted from the client. `rank` / `position` are **free text** (1–120 characters; any wording, not only military ranks) and start the histories on the start date (or today if that is in the future or missing).
- `PATCH /employees/:id` — any of those fields except the code. A `rank` / `position` different from the current one (ignoring case) takes effect
  **today** (use the routes below for another date), `null` removes it, the same one changes nothing. A value changed again on the day it was set is corrected in place.
- `GET /employees/job-titles/rank|position` (Org Admin, HR) — values already in use, for the suggestion lists of the text fields. Archived employees are read-only (`409 EMPLOYEE_ARCHIVED`).
- There is **no delete**: employees are disabled and later archived so history is kept.

### Rank and position history (PRD 12, 22.1)

Rank and position are **separate** and each has its own effective-dated history: a promotion does not touch the position,
a transfer does not touch the rank. Employee records and list items carry the current `rank` and `position` (text); filter the list with `rank` / `position` (case-insensitive, exact).

- `GET /employees/:id/rank-history`, `GET /employees/:id/position-history` — newest first, `{id, rank|position, validFrom, validTo, note}`
  (`validTo` is the first day the row no longer applies; `null` = current). Visible inside the caller's scope (404 otherwise).
- `PUT /employees/:id/rank` `{rank, effectiveDate?, note?}` and `PUT /employees/:id/position` `{position, effectiveDate?, note?}` (`null` ends the current period without a successor, `409 …_NOT_SET` when there is none)
  (Org Admin, HR) — the open period ends on `effectiveDate` and a new one starts; returns the history. `note` is for the order / decree number.
  Rules: `effectiveDate` defaults to today and **cannot be in the future** (`400 EFFECTIVE_DATE_IN_FUTURE`) or before the start date;
  choosing what they already hold is `409 RANK_UNCHANGED` / `POSITION_UNCHANGED`; the date must be after the current period began
  (`409 EFFECTIVE_DATE_NOT_AFTER_CURRENT`). Back-dating _inside_ an earlier period (correcting history) is not supported yet.
  Archived employees are read-only. Audited as `employee.rank_changed` / `employee.position_changed`.

### Lifecycle (PRD 12.2)

| Route                                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /employees/:id/disable` `{effectiveDate?, reason?}`                        | status `DISABLED`, `end_date` set; **login blocked and all sessions ended**; **device deactivated** (database trigger); temporary assignments and **reason assignments** that started are ended on that date and future ones removed; open replacement QR codes cancelled. History is kept. `effectiveDate` must be today or earlier (**scheduled future disabling is not supported yet**) and not before the start date |
| `POST /employees/:id/reactivate` `{departmentId, primaryLocationId, startDate?}` | back to `ACTIVE` on the **same record**; department and location **must be re-confirmed**; the login (if any) gets a **new one-time password** and must change it; the old device stays disabled, so **a new QR registration is required**                                                                                                                                                                               |
| `POST /employees/:id/archive` `{force?}`                                         | only from `DISABLED` and only `archive_after_months` (tenant setting, default 12) after they left; an Org Admin may `force`                                                                                                                                                                                                                                                                                              |
| `POST /employees/:id/account` `{username?}`                                      | creates the employee's login (role EMPLOYEE) with a one-time password (PRD 5 step 2). **The login name defaults to the 16-digit employee code**; the password is always random and one-time (the code is not secret, so it is not used as a password). Use `POST /users/:userId/reset-password` later                                                                                                                    |

### Data scope

`PUT /users/:id/scope` `{locationIds, departmentIds}` replaces a Manager's or HR user's scope; `GET` reads it.
A Manager sees employees whose **primary location** is in `locationIds` **or** whose **department** is in
`departmentIds`. A Manager with no rows sees nothing; HR with no rows sees everything (PRD 4). Only HR and Manager
accounts have a scope.

## Bulk import (PRD 12.3)

`GET /employees/import/template?format=xlsx|csv` and `POST /employees/import` (Org Admin, HR; the file is the raw request body, `.xlsx` or CSV, max 5 MB and
2,000 rows, type decided from the content). Query: `dryRun` (default **true**: nothing is written, the per-row report comes back), `mode`
(`VALID_ONLY` default | `ABORT_ON_ERROR`: any error and nothing is imported, `409 IMPORT_HAS_ERRORS` with the report), `onDuplicate` (`SKIP` default | `CREATE`),
`createAccounts` (default false), `fileName` (for the audit).

Columns (Mongolian or English headers): **Код**, **Овог**, **Нэр**, **Нэгж**, **Салбар**, Цол, Албан тушаал, Ажилд орсон, Хуваарь (Энгийн | Ээлжийн), Гараар ирц (тийм | үгүй).
Required: Овог, Нэр, Нэгж, Салбар (the department and location are matched by name and must exist, be active and inside the caller's scope).

- **No code** = a new employee; the system assigns the 16-digit code. A row whose name and department already exist is skipped as `ALREADY_EXISTS` (so re-uploading the
  same file creates nothing) unless `onDuplicate=CREATE`; the same name twice in one file is `DUPLICATE_IN_FILE`.
- **A code** = update that employee. The report lists the differences (`changes`); no difference is the warning `NO_CHANGES`; blank optional cells (rank, position, start
  date, schedule, manual) leave the value alone; an unknown, repeated, disabled or archived code is an error. A rank or position that differs takes effect today, as in `PATCH`.
- Cells are text only (`=`, `+`, `-`, `@` are never evaluated). Every row is checked first; the commit writes all valid rows in **one transaction** (all or nothing), through the same code as
  `POST` and `PATCH /employees`, and is audited as `employee.imported` (file name and counts only).
- **No password is imported.** With `createAccounts=true` each new employee gets a login (username = the code) with a random one-time password, returned once in `credentials`
  (never stored, never audited). At most 400 new employees per import with logins (hashing takes time); more: import first, create logins afterwards.

## Known gaps (deliberate)

- **No effective-dated history** of department / primary-location changes (PRD 22.1): a change applies from now on and
  is recorded in the audit log. A history table is needed before attendance reports are built on past dates.
- Scheduled disabling on a future date; Device Readiness report; the import has no invite link / activation code flow yet (one-time passwords instead), and no "download the sheet again".
- Concurrency control (`If-Match`) on edits; scope applies to employees only (not yet to attendance data, which does not exist yet).
