# Database migrations

SQL-first migrations run by [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate)
(Architecture ADR-9). Files are `NNNN_name.sql` with `-- Up Migration` and `-- Down Migration` sections.

| Migration         | Contents                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_foundation` | `btree_gist`, roles `app_user` / `platform_admin` (no login, no `BYPASSRLS`), `current_tenant_id()`, `set_updated_at()`, `apply_tenant_rls()` |
| `0002_tenancy`    | `tenant` (with `code` for login), `resolve_tenant_by_code()`, `tenant_setting`, `platform_user` (Super Admin)                                 |
| `0003_org`        | `department`, `location` (radius 100–500 m)                                                                                                   |
| `0004_employees`  | `employee`, `temp_location_assignment` (no overlapping periods)                                                                               |
| `0005_identity`   | `user_account`, `user_scope`, `auth_session`, `invite`                                                                                        |
| `0006_audit_log`  | append-only `audit_log`                                                                                                                       |

Still to come (in this order of need): devices + QR + consent, rules / working week / holidays / shifts,
reasons, device events + heartbeats, `attendance_day` + corrections + anomalies + `daily_summary`, export jobs.

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
