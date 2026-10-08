# Database migrations

SQL-first migrations run by [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
(Architecture ADR-9). Files are `NNNN_name.sql` with `-- Up Migration` and `-- Down Migration` sections.

| Migration                             | Contents                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_foundation`                     | `btree_gist`, roles `app_user` / `platform_admin` (no login, no `BYPASSRLS`), `current_tenant_id()`, `set_updated_at()`, `apply_tenant_rls()`   |
| `0002_tenancy`                        | `tenant` (with `code` for login), `resolve_tenant_by_code()`, `tenant_setting`, `platform_user` (Super Admin)                                   |
| `0003_org`                            | `department`, `location` (radius 100–500 m)                                                                                                     |
| `0004_employees`                      | `employee`, `temp_location_assignment` (no overlapping periods)                                                                                 |
| `0005_identity`                       | `user_account`, `user_scope`, `auth_session`, `invite`                                                                                          |
| `0006_audit_log`                      | append-only `audit_log`                                                                                                                         |
| `0007_auth_hardening`                 | TOTP replay step, session families, recovery codes, display name                                                                                |
| `0008_devices_consent`                | `device`, `onboarding_qr` (+ `_use`), `consent_text_version`, `consent_record`, view `employee_consent_status`, consent / deactivation triggers |
| `0009_device_attestation_qr_override` | device attestation state; Org Admin consent override carried by an employee-specific QR                                                         |
| `0010_time_rules`                     | `attendance_rule_version`, `working_week_version` / `working_week_day`, `working_day_exception`, `holiday` / `holiday_location`                 |
| `0011_shifts`                         | `shift_template`, `shift_pattern` / `shift_pattern_day`, `shift_assignment`, `shift_override`                                                   |
| `0012_rank_position`                  | `job_rank` (ordered), `job_position`, `employee_rank_assignment`, `employee_position_assignment` (separate, effective-dated, no overlaps)       |
| `0013_reasons`                        | `absence_reason` (15 predefined, `seed_default_reasons()`), `reason_assignment` (dated, one per employee at a time)                             |

Still to come (in this order of need): device events + heartbeats, `attendance_day` + corrections + anomalies + `daily_summary`, export jobs.

## Rules enforced by the database for devices and consent (0008)

| Rule                                                                                                                  | Mechanism                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| One ACTIVE device per employee (PRD 5)                                                                                | partial unique index `device_one_active_idx`                                                    |
| Same install key cannot be registered under two accounts (PRD 6.7)                                                    | partial unique index on `attestation_key_id`                                                    |
| Registration needs a SIGNED consent, unless an Org Admin override with a reason ≥ 5 characters is recorded (PRD 15.4) | `BEFORE INSERT` trigger `device_consent_gate`; raises SQLSTATE **`TK001`** (`CONSENT_REQUIRED`) |
| Withdrawing consent deactivates the device (PRD 15.4)                                                                 | trigger on `consent_record`                                                                     |
| Disabling or archiving the employee deactivates the device (PRD 12.2)                                                 | trigger on `employee`                                                                           |
| A device that stops being ACTIVE ends every session bound to it (PRD 21.2)                                            | trigger on `device`                                                                             |
| REPLACEMENT QR: one employee, single use; ONBOARDING QR: no employee, any number of uses (PRD 5, 21.1)                | CHECK constraints (NULL-safe)                                                                   |
| One SIGNED consent per employee; a newer signed form moves the old one to `SUPERSEDED`                                | partial unique index; the API does the move in one transaction                                  |
| One active consent text per tenant; `is_draft` texts must not be printed for real employees                           | partial unique index; checked by the API                                                        |

The API replaces a device in this order inside one transaction: mark the old device `REPLACED`
(with `disabled_at`), insert the new `ACTIVE` one, then set `replaced_by_device_id` on the old one.

## Rules enforced by the database for time rules and shifts (0010, 0011)

These tables only **store** configuration and protect its integrity. What the rules _mean_ (who is expected when,
holiday recurrence, late and no-show) lives in `packages/domain`, never in SQL (see CLAUDE.md).

| Rule                                                                                                                                                                                                              | Mechanism                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Versions are half-open `[valid_from, valid_to)`; `valid_to` NULL = until further notice. At most one version of a scope is in force on any date; NULL `location_id` = tenant default, a location row overrides it | `EXCLUDE USING gist` on `attendance_rule_version` and `working_week_version`                                                  |
| Rule ranges: grace 0–240, no-show cut-off 0–1440 min, minimum stay 1–15 (PRD 6.4), early window 0–720                                                                                                             | CHECK constraints                                                                                                             |
| A working week has all 7 ISO weekdays (1 = Monday) when the transaction commits; working days have start < end, off days have no times                                                                            | deferred constraint triggers (SQLSTATE **`TK003`**) + CHECK. Insert a version and its 7 days in **one transaction**           |
| One working-day exception per scope and date                                                                                                                                                                      | unique index with `COALESCE(location_id, zero-uuid)`                                                                          |
| A holiday is at most 31 days long and applies to all locations **or** a non-empty list, never both or neither                                                                                                     | CHECK + deferred constraint triggers (**`TK004`**); `repeats_yearly` is stored, the recurrence logic is in the domain package |
| A shift lasts 1–1440 minutes (may cross midnight)                                                                                                                                                                 | CHECK                                                                                                                         |
| **A shift template or pattern that is in use is immutable** (the past cannot be changed — create a new one and retire the old; only name/active change in place)                                                  | triggers **`TK005`** (template), **`TK006`** (pattern; also blocks deleting an assigned pattern)                              |
| A pattern defines every day `0 … cycle_length_days-1` exactly once at commit                                                                                                                                      | deferred constraint triggers (**`TK007`**)                                                                                    |
| A shift assignment has exactly one of pattern/template, a pattern needs `cycle_start_date`, an employee has at most one assignment at any date (inclusive range, `to_date` NULL = open-ended)                     | CHECK + `EXCLUDE USING gist`                                                                                                  |
| Only employees with `schedule_mode = 'SHIFT'` can be assigned                                                                                                                                                     | trigger **`TK002`**                                                                                                           |
| A shift override is `ADD`/`SWAP` with a template or `REMOVE` without; one per employee and date                                                                                                                   | CHECK + unique                                                                                                                |

## Commands (from the repo root)

```bash
export DATABASE_URL=postgres://timekeeper:timekeeper@localhost:5432/timekeeper
pnpm --filter @timekeeper/api db:migrate        # apply all pending migrations
pnpm --filter @timekeeper/api db:rollback 1     # undo the last migration
pnpm --filter @timekeeper/api db:seed           # tenant 310 with placeholder locations (dev only)
pnpm --filter @timekeeper/api exec node-pg-migrate create my_change -m db/migrations -j sql
```

## Rules

- **Every tenant table** has `tenant_id`, is created through `SELECT apply_tenant_rls('table')` (RLS enabled
  **and forced**, a `tenant_isolation` policy, grants for `app_user`), and uses **composite foreign keys**
  `(tenant_id, x_id)` so a row can never reference another tenant. A test fails if a table with a
  `tenant_id` lacks RLS (`test/db/schema.test.ts`).
- The API/worker run as a login role that is a member of `app_user` and start every transaction with
  `SELECT set_config('app.tenant_id', '<uuid>', true)`. With no tenant set, policies fail closed.
- `app_user` has no grants unless a migration gives them. `platform_user` is reachable only by `platform_admin`.
- `tenant` has RLS enabled but not forced, so `resolve_tenant_by_code()` (SECURITY DEFINER) can look a tenant
  up at login before any tenant is known. Login flow: resolve the code → set the tenant → read `user_account`.
- `audit_log` is append-only for `app_user` (SELECT/INSERT only). Retention deletes will use a controlled
  maintenance function owned by the migration role.
- Migrations are backward compatible: expand → migrate → contract. Never edit an applied migration; add a new one.
- Effective-dated tables use `btree_gist` exclusion constraints to forbid overlaps.
- UUID primary keys use `gen_random_uuid()` (v4); index locality matters little at pilot volume.

## Testing

`apps/api/test/db` runs against a real PostgreSQL when `TEST_DATABASE_URL` is set (CI does; locally
`pnpm db:up` creates `timekeeper_test`). **The schema is dropped and rebuilt on every run**, so the database
name must end in `_test` or the run aborts. Without `TEST_DATABASE_URL` these tests are skipped.
