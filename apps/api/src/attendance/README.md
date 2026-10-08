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

- Results are **derived data**; fix the inputs (events, reasons, schedule, corrections) and recompute.
- Refreshing an access token keeps the session's device binding (`SessionService.issue(..., deviceId)`); without it a phone
  would be unrecognised after 15 minutes.
- A holiday or reason that is changed for today/yesterday is applied by the next tick; older dates need `recompute`.
- Tests: `test/e2e/attendance.test.ts` (needs `TEST_DATABASE_URL`), `packages/domain/test/attendance/derive.test.ts`.

## Corrections (PRD 6.9)

HR and Org Admin correct a day directly (no second approval). A correction is a separate row in `attendance_correction`;
the engine layers it over the system value with `applyCorrection` (packages/domain), so recomputes and ticks never lose it.
The result row keeps `system_status` / `system_arrival_at` and `source` (`AUTO` | `CORRECTED`), the correction keeps the
original value. Statuses HR can set: `ON_TIME`, `LATE` (late minutes counted from the start when an arrival is known),
`NO_SHOW` (no arrival). Excused days come from reasons, not corrections.

| Endpoint                                                                                           | Who           | Purpose                                                                        |
| -------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `POST /v1/attendance/corrections`                                                                  | ORG_ADMIN, HR | `{ employeeId, workDate, status, arrivalAt?, reasonCode, note? }`              |
| `POST /v1/attendance/corrections/:id/revoke {note?}`                                               | ORG_ADMIN, HR | back to the system value                                                       |
| `GET /v1/attendance/corrections?from&to[&employeeId&actorId&reasonCode&locationId&includeRevoked]` | ORG_ADMIN, HR | list (data scope applies)                                                      |
| `GET /v1/attendance/corrections/report?from&to`                                                    | ORG_ADMIN     | monthly report: by actor, reason, location (share of duties corrected), alerts |

Rules: reason codes `PHONE_DEAD_LOST | GPS_FAULT | APP_ISSUE | ANOMALY_REVIEW | DATA_ENTRY_ERROR | OTHER` (OTHER needs a
note); only the last **31 days**, never the future; only a day where someone is expected (`NOT_AN_EXPECTED_DAY`); an arrival
time must not be in the future and must be within 24 h of the duty start; a second correction for the same day **replaces**
the first (the old one is kept, revoked with `REPLACED`). Every create / replace / revoke is audited
(`attendance.correction_created|replaced|revoked`). The report lists a user who made **more than 10 corrections in a day**
under `alerts`. Not built: closed-month locking (PRD 25.5), the optional approval step, pushing the alert to the Org Admin
(the report shows it), and "HR cannot correct their own record" (staff accounts have no employee record, so it cannot happen).

## Anomaly review queue (PRD 6.7)

Accept and flag: a suspicious event is stored and, unless it is held back for another reason, counts at once. Codes in the
queue: `MOCK_LOCATION` (the phone sets `mockLocation: true`), `LOW_ACCURACY` (ENTER worse than 50 m; held back, `counted = false`)
and `CLOCK_SKEW` (> 2 min; counts). `LATE_SYNC` (> 24 h old) is not suspicion and not queued. Queued events have
`review_status = PENDING`; the daily result shows `flaggedEvents` and the summary `flagged` ("N flagged").

| Endpoint                                           | Who           | Purpose                                                                                     |
| -------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `GET /v1/attendance/anomalies?status=OPEN\|ALL\|…` | ORG_ADMIN, HR | the queue (data scope applies) and `repeated` = employees with ≥ 3 flagged events in 7 days |
| `POST /v1/attendance/anomalies/:eventId/review`    | ORG_ADMIN, HR | `{ decision: CONFIRM \| REJECT \| REQUEST_RECHECK, note? }` (REJECT needs a note)           |

Confirm clears the flag (and lets a low-accuracy ENTER count; a `LATE_SYNC` event never does); Reject stops the event counting
and rebuilds the day (normally Ирээгүй); Request re-check leaves it open once. Decisions are audited
(`attendance.anomaly_reviewed`). Not built: `IMPOSSIBLE_SPEED` / teleport checks (events carry no coordinates yet),
`ATTESTATION_*` and `DEVICE_CONFLICT`, notifying the employee on a re-check, the tenant "hold until reviewed" policy.
