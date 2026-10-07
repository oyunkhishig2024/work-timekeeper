# Organization and employees API (PRD 12, 13, 4)

Departments, locations, ranks, positions, employees, employee login accounts and data scope. All routes are under `/v1`.
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

## Ranks `/ranks` and positions `/positions` (PRD 12, 22.1)

The tenant's lists of **ranks (цол**, ordered by seniority, e.g. Ахлагч … Хурандаа) and **job positions (албан тушаал)**.
`GET /`, `GET /:id`, `POST /`, `PATCH /:id`. Org Admin writes; HR and Manager read (Managers get no `activeHolders` count).
Ranks have `sortOrder` (unique; defaults to the next number); names are unique (`409 RANK_NAME_TAKEN` /
`RANK_ORDER_TAKEN` / `POSITION_NAME_TAKEN`). There is no delete: deactivate (`active: false`) — an inactive entry cannot
be newly assigned (`400 RANK_INACTIVE`), but employees who hold it and the history keep it.

## Employees `/employees`

- `GET /employees?q&status&departmentId&locationId&scheduleMode&manualAttendance&hasDevice&consentStatus&sort&order&limit&offset`
  → `{ total, limit, offset, items }`. **Default `status=ACTIVE`**: disabled and archived employees are hidden unless
  `status=DISABLED|ARCHIVED|ALL` (PRD 12.2). `q` matches name or employee number, case-insensitive (Cyrillic too);
  `%` and `_` are literal. Each item has department, location, consent status and `hasActiveDevice`.
- `GET /employees/:id` — adds `account` (login) and the active `device`.
- `POST /employees` `{employeeNo, fullName, departmentId, primaryLocationId, startDate?, endDate?, scheduleMode?, manualAttendance?, rankId?, positionId?}`
  — `rankId` / `positionId` start the histories on the start date (or today if that is in the future or missing).
- `PATCH /employees/:id` — any of those fields. A `rankId` / `positionId` different from the current one takes effect
  **today** (use the routes below for another date); the same one changes nothing. Archived employees are read-only (`409 EMPLOYEE_ARCHIVED`).
- There is **no delete**: employees are disabled and later archived so history is kept.

### Rank and position history (PRD 12, 22.1)

Rank and position are **separate** and each has its own effective-dated history: a promotion does not touch the position,
a transfer does not touch the rank. Employee records and list items carry the current `rankId/rankName` and
`positionId/positionName`; filter the list with `rankId` / `positionId`.

- `GET /employees/:id/rank-history`, `GET /employees/:id/position-history` — newest first, `{id, rankId|positionId, …Name, validFrom, validTo, note}`
  (`validTo` is the first day the row no longer applies; `null` = current). Visible inside the caller's scope (404 otherwise).
- `PUT /employees/:id/rank` `{rankId, effectiveDate?, note?}` and `PUT /employees/:id/position` `{positionId, effectiveDate?, note?}`
  (Org Admin, HR) — the open period ends on `effectiveDate` and a new one starts; returns the history. `note` is for the order / decree number.
  Rules: `effectiveDate` defaults to today and **cannot be in the future** (`400 EFFECTIVE_DATE_IN_FUTURE`) or before the start date;
  choosing what they already hold is `409 RANK_UNCHANGED` / `POSITION_UNCHANGED`; the date must be after the current period began
  (`409 EFFECTIVE_DATE_NOT_AFTER_CURRENT`). Back-dating _inside_ an earlier period (correcting history) is not supported yet.
  Archived employees are read-only. Audited as `employee.rank_changed` / `employee.position_changed`.

### Lifecycle (PRD 12.2)

| Route                                                                            | Effect                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /employees/:id/disable` `{effectiveDate?, reason?}`                        | status `DISABLED`, `end_date` set; **login blocked and all sessions ended**; **device deactivated** (database trigger); temporary assignments that started are ended on that date and future ones removed; open replacement QR codes cancelled. History is kept. `effectiveDate` must be today or earlier (**scheduled future disabling is not supported yet**) and not before the start date |
| `POST /employees/:id/reactivate` `{departmentId, primaryLocationId, startDate?}` | back to `ACTIVE` on the **same record**; department and location **must be re-confirmed**; the login (if any) gets a **new one-time password** and must change it; the old device stays disabled, so **a new QR registration is required**                                                                                                                                                    |
| `POST /employees/:id/archive` `{force?}`                                         | only from `DISABLED` and only `archive_after_months` (tenant setting, default 12) after they left; an Org Admin may `force`                                                                                                                                                                                                                                                                   |
| `POST /employees/:id/account` `{username}`                                       | creates the employee's login (role EMPLOYEE) with a one-time password (PRD 5 step 2). Use `POST /users/:userId/reset-password` later                                                                                                                                                                                                                                                          |

### Data scope

`PUT /users/:id/scope` `{locationIds, departmentIds}` replaces a Manager's or HR user's scope; `GET` reads it.
A Manager sees employees whose **primary location** is in `locationIds` **or** whose **department** is in
`departmentIds`. A Manager with no rows sees nothing; HR with no rows sees everything (PRD 4). Only HR and Manager
accounts have a scope.

## Known gaps (deliberate)

- **No effective-dated history** of department / primary-location changes (PRD 22.1): a change applies from now on and
  is recorded in the audit log. A history table is needed before attendance reports are built on past dates.
- Scheduled disabling on a future date; Excel bulk import (PRD 12.3) and import dry-run; Device Readiness report.
- Reasons (`reason_assignment`) are not ended on disable yet because that table does not exist; do it when it is added.
- Concurrency control (`If-Match`) on edits; scope applies to employees only (not yet to attendance data, which does not exist yet).
