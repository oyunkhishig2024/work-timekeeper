# Working week, holidays and shifts API (PRD 14, 23, 22.1)

Stores and protects the schedule configuration. **How a date turns into "expected / not expected" is not here**: it is
`getExpectation` in `packages/domain` (see its README). All routes are under `/v1`; every change is audited in the same
transaction. Reading is open to Org Admin, HR and Manager; configuration is for the **Org Admin**; rosters
(assignments, overrides) are HR work and respect the caller's data scope (an out-of-scope employee is `404`).

## Working week and exceptions (PRD 14.1)

| Route                                                                    | Who                         |                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /working-week?locationId&asOf`                                      | all                         | The table in force on `asOf` (default today). A location without its own table gets the tenant default with `inherited: true`; `404 WORKING_WEEK_NOT_CONFIGURED` if there is none                                                                     |
| `GET /working-week/versions?locationId`                                  | all                         | History of the tenant default (or one location), newest first                                                                                                                                                                                         |
| `PUT /working-week` `{locationId?, effectiveFrom?, days[7]}`             | Org Admin                   | New table from `effectiveFrom` (default today). `days`: each weekday 1 (Mon) – 7 (Sun) once, `{weekday, working, start, end}` as `HH:MM`; an off day has no times. A `locationId` makes that location use its own table (`workingWeekMode: OVERRIDE`) |
| `POST /working-week/inherit` `{locationId, effectiveFrom?}`              | Org Admin                   | The location goes back to the tenant default from that date                                                                                                                                                                                           |
| `GET/POST /working-day-exceptions`, `DELETE /working-day-exceptions/:id` | read: all; write: Org Admin | One date marked working (optionally with its own hours) or off, for the tenant or one location. One exception per scope and date (`409 EXCEPTION_EXISTS`)                                                                                             |

A new table applies **forward only**: `effectiveFrom` in the past is `400 EFFECTIVE_DATE_IN_PAST` (history is never rewritten);
it must be after the start of the table in force (`409 EFFECTIVE_DATE_NOT_AFTER_CURRENT`). A change that has not started yet is
simply replaced by a new one.

## Holidays (PRD 14.2)

`GET /holidays?from&to&year&locationId`, `GET /holidays/:id`, `POST`, `PATCH /:id`, `DELETE /:id`, `POST /holidays/copy-year`.
Fields: `name, fromDate, toDate (≤ 31 days), kind (PUBLIC_HOLIDAY | COMPANY_DAY_OFF | TRANSFERRED_DAY_OFF), repeatsYearly,
appliesToAll, locationIds` (`appliesToAll` XOR a non-empty `locationIds`). `(name, fromDate)` is unique.
The system ships **no** holiday dates. A holiday that starts **today or in the past** (also when an edit moves one there,
and for a delete) changes attendance that exists, so it needs `confirmRecompute: true` (`409 RECOMPUTE_CONFIRMATION_REQUIRED`;
for DELETE use `?confirmRecompute=true`). The recompute itself comes with the attendance engine.
`copy-year` `{fromYear, toYear}` copies every holiday of one year to another and skips duplicates (29 Feb → 28 Feb).
Excel/CSV import (PRD 14.2) is not built yet.

## Shift templates and patterns (PRD 23.1)

- `/shift-templates` — `POST {name, startTime, endTime | durationMinutes, graceMinutes?, cutoffMinutes?, earlyWindowMinutes?, observesHolidays?}`.
  `endTime` at or before the start means the next day, equal means 24 h. Responses carry `endTime`, `endsNextDay`, `inUse`.
  `PATCH` changes name / active any time and timing only while unused (`409 SHIFT_TEMPLATE_IN_USE`, database rule TK005).
  **`POST /shift-templates/:id/new-version`** retires a used template and creates its successor (`supersedesId`).
- `/shift-patterns` — `POST {name, days: [templateId | null, …]}`: `days[i]` is day _i_ of the cycle (`null` = off), the cycle length is
  `days.length` (24 h on / 48 h off = `[guard, null, null]`). Needs at least one working day and active templates. `PATCH` only
  renames / retires; the days of an assigned pattern never change (TK006) — create a new pattern.

## Assignments and overrides (PRD 23.4; HR and Org Admin write)

- `GET /shift-assignments?employeeId&from&to`, `POST /shift-assignments` `{items:[{employeeId, cycleStartDate?}], patternId | templateId, cycleStartDate?, fromDate, toDate?}`
  — all or nothing, up to 500 employees; staggered teams use a `cycleStartDate` per employee (default: `fromDate`). Only employees with
  `scheduleMode: SHIFT` (`400 SHIFT_MODE_REQUIRED`) who are active; one assignment at a time (`409 SHIFT_ASSIGNMENT_OVERLAP`).
  `POST /shift-assignments/:id/end` `{toDate}` shortens one; `DELETE` only before it starts (`409 ASSIGNMENT_STARTED`).
- `GET/POST /shift-overrides`, `DELETE /shift-overrides/:id` — for one date: `ADD` / `SWAP` need a `templateId`, `REMOVE` has none; one per employee and date.

## Not done yet (deliberate)

- The **roster calendar view** (PRD 23.5) and conflict flags (shift vs reason / temporary assignment) — they need the expectation function
  over a date range; build them with the attendance engine.
- Attendance rule versions (grace, cut-off, minimum stay; table `attendance_rule_version`) have no API yet.
- Holiday Excel/CSV import with dry run, the 12-month calendar view, and recompute after a holiday change.
- A shift template has no validity dates of its own (assignments carry the dates).
