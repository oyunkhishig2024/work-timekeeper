-- Up Migration
-- Foundation: extensions, runtime roles and the helpers every tenant table uses.
-- See docs/Timekeeper_Work_Architecture.md Section 5 (conventions, Row-Level Security).

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Runtime roles. They have no login: the API/worker connect with a login role that is a member of
-- app_user (and the Super Admin tooling with one that is a member of platform_admin).
-- Neither role has BYPASSRLS, so Row-Level Security always applies to them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'platform_admin') THEN
    CREATE ROLE platform_admin NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_user, platform_admin;

-- The tenant of the current transaction. Set per transaction with
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- When unset it is NULL and every tenant policy fails closed (no rows, no writes).
CREATE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

-- Standard protection for a tenant-owned table (requires a tenant_id column):
-- enable and force RLS, one policy for app_user, and the usual grants (default deny otherwise).
CREATE FUNCTION apply_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s TO app_user USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
    tbl
  );
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_user', tbl);
END
$$;

-- Down Migration
DROP FUNCTION apply_tenant_rls(regclass);
DROP FUNCTION set_updated_at();
DROP FUNCTION current_tenant_id();
-- Roles and the btree_gist extension are intentionally left in place.
