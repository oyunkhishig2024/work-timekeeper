-- Up Migration
-- The API and the worker connect as this limited login role instead of the database owner. It owns nothing, is not a
-- superuser and has no grants of its own: every request switches to app_user / platform_admin (SET LOCAL ROLE), which keep
-- Row-Level Security in force. A leaked API credential therefore cannot create, drop or read tables directly.
-- No password here: infra/deploy/app-login.sh (or the test setup) sets it, so no secret is stored in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tk_app') THEN
    CREATE ROLE tk_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
GRANT app_user, platform_admin TO tk_app;

-- Down Migration
REVOKE app_user, platform_admin FROM tk_app;
