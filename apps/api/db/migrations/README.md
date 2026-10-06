# Database migrations

SQL-first migrations (Architecture ADR-9). The migration runner (e.g. `node-pg-migrate`) and the
first migration (extensions, `app_user` role, tenancy tables with Row-Level Security) are added in
the foundations phase. Rules:

- Every tenant table has `tenant_id`, `ENABLE`/`FORCE ROW LEVEL SECURITY` and a tenant policy
  (Architecture 5.2). CI fails if a tenant table lacks RLS.
- Migrations are backward compatible: expand → migrate → contract.
- Effective-dated tables use `btree_gist` exclusion constraints to forbid overlaps.
