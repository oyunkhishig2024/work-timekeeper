# Personal hours (PRD 14.4)

HR fixes the hours, and optionally several places, of chosen employees for a range of dates. `getExpectation` in `packages/domain`
applies them (they win over the working week, holidays and shifts); this module only stores them. Never copy rule logic here.

| Endpoint                        | Roles                  | Notes                                                                                                                                   |
| ------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/personal-hours`       | ORG_ADMIN, HR          | `{employeeIds (≤500), fromDate, toDate (≤31 days), startTime, endTime (HH:MM, later than start), locationIds? (≤6, main first), note?}` |
| `GET /v1/personal-hours`        | ORG_ADMIN, HR, MANAGER | `employeeId, from, to, limit, offset`; a Manager sees their scope. Items carry `locations` (main first)                                 |
| `DELETE /v1/personal-hours/:id` | ORG_ADMIN, HR          | The covered days go back to the usual rules                                                                                             |

Rules: all or nothing; only active employees inside the caller's scope; dates from 31 days back to 90 days ahead; one set per employee
and date (`409 PERSONAL_HOURS_OVERLAP` with the clashing sets); places must exist and be active. Existing days (up to today) are
rebuilt at once, later days are evaluated by the worker when they come. Created and deleted sets are audited. Tables:
`personal_hours`, `personal_hours_location` (migration `0024`).
