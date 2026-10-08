# Working week, holidays, attendance rules, shifts and roster API (PRD 14, 13, 23, 22.1)

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

## Attendance rules (PRD 6.2–6.4, 13)

`GET /attendance-rules?locationId&asOf`, `GET /attendance-rules/versions?locationId`, `PUT /attendance-rules` (Org Admin),
`POST /attendance-rules/inherit` — effective-dated like the working week (same timeline helper, `version-timeline.ts`).
Fields: `graceMinutes` (0–240; late after start + grace), `minStayMinutes` (1–15) and `earlyLeaveToleranceMinutes` (0–240; leaving more than this before the end of the duty is leaving early, PRD 23.2). There is no no-show cut-off and no early-arrival
window (PRD 6.3, 23.2, v1.24): Ирээгүй comes only when the employee's duty is over, and `cutoffMinutes` / `earlyWindowMinutes` are refused
(`400`). A location may have its own version (`source: LOCATION`), else the tenant version
(`TENANT`), else the **PRD defaults 15 / 3 / 15** (`DEFAULT`, `id: null`) until the first version is saved. New rules apply from today or
later only; a version that has not started is replaced.

## Holidays (PRD 14.2)

`GET /holidays?from&to&year&locationId`, `GET /holidays/:id`, `POST`, `PATCH /:id`, `DELETE /:id`, `POST /holidays/copy-year`.
Fields: `name, fromDate, toDate (≤ 31 days), kind (PUBLIC_HOLIDAY | COMPANY_DAY_OFF | TRANSFERRED_DAY_OFF), repeatsYearly,
appliesToAll, locationIds` (`appliesToAll` XOR a non-empty `locationIds`). `(name, fromDate)` is unique.
The system ships **no** holiday dates. A holiday that starts **today or in the past** (also when an edit moves one there,
and for a delete) changes attendance that exists, so it needs `confirmRecompute: true` (`409 RECOMPUTE_CONFIRMATION_REQUIRED`;
for DELETE use `?confirmRecompute=true`). The recompute itself comes with the attendance engine.
`copy-year` `{fromYear, toYear}` copies every holiday of one year to another and skips duplicates (29 Feb → 28 Feb).

**Import** (`POST /holidays/import`, Org Admin): the raw request body is an `.xlsx` or CSV file (type decided from the content; ≤ 5 MB, ≤ 2,000 rows).
Columns (Mongolian or English headers): `Нэр | Эхлэх | Дуусах | Төрөл | Салбар | Жил бүр` (`name, from, to, type, locations, repeats`; name and start are required,
`Салбар` is `all` or location names separated by `,`/`;`). **`dryRun` defaults to true**: nothing is written and the per-row report
(`OK | WARNING | ERROR` with message codes) is returned; pass `dryRun=false` to import. `mode=VALID_ONLY` (default) or `ABORT_ON_ERROR`
(`409 IMPORT_HAS_ERRORS` with the report, nothing imported). A holiday whose name and start date already exist is a WARNING and skipped, so
re-uploading is safe; today/past dates are errors unless `confirmRecompute=true`. Cells are text: `=`, `+`, `-`, `@` are never evaluated.
`GET /holidays/import/template?format=xlsx|csv` gives a template. Imports are audited (`holiday.imported`).

## Shift templates and patterns (PRD 23.1)

- `/shift-templates` — `POST {name, startTime, endTime | durationMinutes, graceMinutes?, observesHolidays?}`.
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

## Roster calendar (PRD 23.5)

`GET /shift-roster?from&to&departmentId&locationId&employeeId&scheduleMode&limit&offset` (≤ 62 days, ≤ 500 employees per page; Managers inside their
scope) → employees × dates. **Every cell comes from `getExpectation` in `packages/domain`**; the API only loads the inputs (tenant zone, locations,
working weeks, exceptions, holidays, rule versions with the PRD-default fallback, templates, patterns, the employees' assignments, overrides, temporary
assignments). A cell: `expected`, `reason` (`HOLIDAY | OFF_DAY | SHIFT_OFF | INACTIVE | NOT_CONFIGURED` + `missing`), `source`, `locationId`, local `start`/`end`
(`endsNextDay`), `absenceReason` (a reason assignment covers the date), `override` (`ADD|REMOVE|SWAP`) and `conflict` — a planned duty that collides with a
reason assignment (flagged, PRD 23.5). The response also lists the shift `templates` (names, times) and the total number of `conflicts`.

## Not done yet (deliberate)

- Roster conflict flags against **temporary location assignments** (the roster already flags reasons); the 12-month holiday calendar view; recompute after a holiday change.
- A shift template has no validity dates of its own (assignments carry the dates).
