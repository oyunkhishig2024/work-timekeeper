# Attendance core

Device events in, daily results out (PRD 6, 7). All rules are in `packages/domain` (`getExpectation`, `deriveStatus`);
this module only loads data, persists and serves it.

## Flow

1. Phone → `POST /v1/events` `{ events: [{ clientEventId, type: ENTER|EXIT, locationId, ageMs, deviceTime?, accuracyM? }] }`
   (EMPLOYEE role, from the registered ACTIVE device only; up to 200 per call, idempotent per `clientEventId`).
   - `occurred_at = now − ageMs` (server time is the authority, PRD 6.8). `deviceTime` is only compared: > 2 min apart → `CLOCK_SKEW`.
   - `ageMs` > 24 h → `LATE_SYNC`; ENTER with `accuracyM` > 50 → `LOW_ACCURACY`. Both are stored, not counted (`counted = false`).
   - Response per event: `ACCEPTED` (with flags), `DUPLICATE`, or `REJECTED` (`UNKNOWN_LOCATION`).
2. The affected employee/work dates are re-evaluated in the same transaction (`candidateWorkDates`: local date and the day before).
3. The worker (`worker.ts` → `AttendanceTicker`) runs `AttendanceService.tick()` every minute: yesterday and today for every
   tenant, so `PENDING → NO_SHOW` happens at the cut-off with no event arriving.
4. `attendance_result` holds one row per employee and work date (never for `NOT_EXPECTED`); `attendance_result_log` every status change.

## Endpoints

| Endpoint                                                         | Who                    | Purpose                                                                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/events`, `POST /v1/heartbeat`                          | EMPLOYEE               | geofence events; device `last_seen_at`                                                                                                                                    |
| `GET /v1/me/attendance?from&to`                                  | EMPLOYEE               | own history (≤ 93 days)                                                                                                                                                   |
| `GET /v1/attendance/daily?date[&status&locationId&departmentId]` | ORG_ADMIN, HR, MANAGER | list with rank, position, department, location, arrival, late minutes, reason (data scope applies)                                                                        |
| `GET /v1/attendance/summary?date`                                | ORG_ADMIN, HR, MANAGER | Total (= everyone expected), on time / late / excused / no show / pending, rates (one decimal), by location and department; `workedOffDay`, `notConfigured` counted apart |
| `POST /v1/attendance/recompute {from,to,employeeId?}`            | ORG_ADMIN, HR          | rebuild derived results (≤ 62 days), e.g. after reasons, holidays or shifts changed                                                                                       |

## Notes

- Results are **derived data**; fix the inputs (events, reasons, schedule) and recompute. Corrections (PRD 6.9) are not built yet.
- Refreshing an access token keeps the session's device binding (`SessionService.issue(..., deviceId)`); without it a phone
  would be unrecognised after 15 minutes.
- A holiday or reason that is changed for today/yesterday is applied by the next tick; older dates need `recompute`.
- Tests: `test/e2e/attendance.test.ts` (needs `TEST_DATABASE_URL`), `packages/domain/test/attendance/derive.test.ts`.
