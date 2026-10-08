# @timekeeper/domain

Pure TypeScript attendance rules: no framework, no database, no clock. The API and worker load plain data and call
these functions; they never re-implement the rules (see `CLAUDE.md`). Every rule cites the PRD section it implements,
and the tests are the executable examples.

| Module                                   | What it answers                                                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `arrival.ts`                             | `classifyArrival` — on time or late (PRD 6.2); `findConfirmedArrival` — minimum stay in the geofence (PRD 6.4) |
| `noshow.ts`                              | `noShowCutoff`, `isPastCutoff` (PRD 6.3)                                                                       |
| `schedule/expectation.ts`                | **`getExpectation`** — must this employee attend on this work date, where and when? (PRD 6.1, 14, 23.5)        |
| `schedule/holidays.ts`                   | `holidayCovers`, `isHoliday` — one-off and yearly holidays, location scope                                     |
| `schedule/dates.ts`, `schedule/zoned.ts` | plain-date arithmetic (`"YYYY-MM-DD"`), wall-clock ↔ UTC in a time zone, `candidateWorkDates`                  |

## `getExpectation(input)`

```ts
const e = getExpectation({
  workDate: "2026-10-05",
  tenantTimeZone: "Asia/Ulaanbaatar",
  employee,
  locations,
  tempAssignments,
  workingWeeks,
  workingDayExceptions,
  holidays,
  rules,
  shifts: { templates, patterns, assignments, overrides },
});
// → { expected: false, reason: "INACTIVE" | "HOLIDAY" | "OFF_DAY" | "SHIFT_OFF" }
//   { expected: false, reason: "NOT_CONFIGURED", missing: "WORKING_WEEK" | "ATTENDANCE_RULES" | "SHIFT_ASSIGNMENT" | … }
//   { expected: true, source, workDate, locationId, timeZone, shiftTemplateId, start, end,
//     graceMinutes, cutoff, earlyWindowStart, minStayMinutes }   (start/end/cutoff are UTC instants)
```

The input is plain data in the shape of the database rows (`employee`, `temp_location_assignment`,
`working_week_version` + `working_week_day`, `working_day_exception`, `holiday` + `holiday_location`,
`attendance_rule_version`, `shift_*`); the caller passes only this employee's assignments and overrides.

### Precedence (first match wins)

1. **Not employed on the date** → `INACTIVE`. The last day (`endDate`) itself is still expected; before `startDate` is not.
   A disabled employee without an end date is treated as not employed.
2. **Shift override for the date** (`ADD`/`SWAP`/`REMOVE`) → HR's explicit decision; it **wins over holidays**.
3. **Employee on a shift schedule** → the assignment decides and the working week is ignored: pattern day
   `(date − cycleStart) mod cycleLength` (works for dates before the cycle start), or a fixed template. A holiday only
   makes the day off for templates with `observesHolidays`.
4. **Standard schedule:** working-day exception **>** holiday **>** working week.

Where: a temporary assignment covering the date (inclusive), otherwise the primary location. The holiday calendar, the
working week (own version only if the location is `OVERRIDE`, else the tenant's), the rules and the time zone are those
of that location. **When:** a standard day uses the weekday's hours; a shift starts at the template's `startTime` on the
work date and lasts `durationMinutes` (it may end the next day). Grace, no-show cut-off and early window come from the
template for shifts and from the rule version otherwise; minimum stay always comes from the rule version.

### Not guessed

Anything that must be configured but is missing returns `NOT_CONFIGURED` with what is missing (no working week, no rules,
a shift employee with no assignment on the date, a broken pattern, an unknown template, an exception without hours on an
off weekday). It is for HR to fix; the function never falls back silently. A day that is not expected does not need rules.

### Conventions

- Dates are `"YYYY-MM-DD"` strings and never shift with the machine's time zone; `workDate` is the date a duty **starts**.
- Versioned data is half-open `[validFrom, validTo)`; assignments and temporary assignments are inclusive.
- A yearly holiday repeats from the year it was entered on, never into earlier years, handles ranges that cross New
  Year and falls on 28 February in years without 29 February.
- `candidateWorkDates(instant, tz)` returns the local date and the day before: an event at 01:30 can belong to the
  night shift that started the evening before (a duty lasts at most 24 h).

## `deriveStatus(input)` (attendance/derive.ts)

Turns one expectation + the geofence events of the duty location + "a reason covers this date" + the clock into
`{ status, arrivalAt, lateMinutes }`. Precedence (PRD 6.6), first match wins:

1. Not expected → `NOT_EXPECTED`; `NOT_CONFIGURED` is passed through for HR to fix (never guessed).
2. A reason covers the date → `EXCUSED` (even if the person also arrived).
3. A confirmed stay (PRD 6.4: first ENTER of a stay of at least `minStayMinutes`) → `ON_TIME` / `LATE` (PRD 6.2, minute
   precision, grace). A late arrival **after** the cut-off is still `LATE` (PRD 6.3).
4. `now` is at or past the cut-off → `NO_SHOW`; otherwise `PENDING`.

Events before `earlyWindowStart` are ignored (PRD 23.2). `deriveOffDayStatus` adds `WORKED_OFF_DAY` for a confirmed stay on
a holiday / off day (never for inactive employees). Both are pure; the API supplies events and the clock.

## Not here yet

Corrections overlay (PRD 6.9) and coordinate-based plausibility checks; the location time zone column (the field exists in
the input, the database does not have it yet); effective-dated employee department/location history (PRD 22.1).
