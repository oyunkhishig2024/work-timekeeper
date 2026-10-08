# Reasons API (PRD 11, 6.6)

The **15 predefined reasons** (Албан ажилтай … Тасалсан; `seed_default_reasons(tenant)` creates them) and dated **reason assignments**:
while an assignment covers a date the employee is **Шалтгаантай** instead of Ирээгүй (the status rule belongs to the attendance engine
and `packages/domain`, not here). All routes are under `/v1`; every change is audited.

| Route                                                                                               | Who                                   |                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /reasons?active`, `GET /reasons/:id`                                                           | Org Admin, HR, Manager                | Ordered by `sortOrder`; `assignments` count (not for Managers)                                                                                               |
| `POST /reasons` `{name, sortOrder?}`, `PATCH /reasons/:id`, `DELETE /reasons/:id`                   | Org Admin                             | Names unique. Delete only if never assigned (`409 REASON_IN_USE`); otherwise `active: false` (an inactive reason cannot be newly assigned, history keeps it) |
| `GET /reason-assignments?employeeId&reasonId&departmentId&locationId&from&to&activeOn&limit&offset` | Org Admin, HR, Manager (inside scope) | `activeOn=<date>` = who has a reason on that date; `from`/`to` = overlapping that window. Returns `{total, items}`                                           |
| `POST /reason-assignments` `{employeeIds[≤500], reasonId, fromDate, toDate?, description?}`         | HR, Org Admin                         | Same reason for many employees, all or nothing. `toDate` omitted = open until ended. Past dates are allowed (HR explains a day that was already Ирээгүй)     |
| `POST /reason-assignments/:id/end` `{endDate}`                                                      | HR, Org Admin                         | Ends it early (inclusive); the row stays as history (`endedAt`)                                                                                              |
| `DELETE /reason-assignments/:id`                                                                    | HR, Org Admin                         | Only before it starts (`409 REASON_STARTED`)                                                                                                                 |
| `GET /reason-report?from&to&locationId&departmentId`                                                | Org Admin, HR, Manager (inside scope) | Per reason: distinct `employees` and `employeeDays` inside the period (clipped to it; period ≤ 367 days). Drill-down: `reason-assignments?reasonId&from&to`  |

Rules: an employee has **one reason at a time** (`409 REASON_OVERLAP` with `conflicts[]`: the clashing assignments); only **active** employees
get reasons; **disabling** an employee ends their open reasons on the effective date and removes later ones (PRD 12.2).

Not done yet: Excel/PDF export of the report, bulk assignment by Excel, clash flags against shifts and temporary assignments (PRD 23.5).
