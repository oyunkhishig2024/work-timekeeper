-- Up Migration
-- Tenants, per-tenant settings and platform (Super Admin) users. PRD 2, 4.

CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]*$'),
  name        text NOT NULL,
  time_zone   text NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  status      text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER tenant_updated_at BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A tenant can read only itself and never writes tenant rows. RLS is enabled but not FORCEd so that
-- the SECURITY DEFINER lookup below (owned by the migration role) can resolve a tenant at login time.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant FOR SELECT TO app_user USING (id = current_tenant_id());
CREATE POLICY platform_all ON tenant TO platform_admin USING (true) WITH CHECK (true);
GRANT SELECT ON tenant TO app_user;
GRANT SELECT, INSERT, UPDATE ON tenant TO platform_admin;

-- Login happens before the tenant is known: resolve the tenant id from the organization code.
-- Returns NULL for unknown or suspended tenants. Exposes nothing but the id.
CREATE FUNCTION resolve_tenant_by_code(org_code text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM tenant WHERE code = lower(org_code) AND status = 'ACTIVE' $$;
REVOKE ALL ON FUNCTION resolve_tenant_by_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_code(text) TO app_user, platform_admin;

CREATE TABLE tenant_setting (
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  key         text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT apply_tenant_rls('tenant_setting');

-- Platform (Super Admin) users are not tenant users: separate table, reachable only by platform_admin.
CREATE TABLE platform_user (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text NOT NULL UNIQUE,
  password_hash    text NOT NULL,
  totp_secret_enc  text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_user_updated_at BEFORE UPDATE ON platform_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE platform_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_user FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON platform_user TO platform_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON platform_user TO platform_admin;

-- Down Migration
DROP TABLE platform_user;
DROP TABLE tenant_setting;
DROP FUNCTION resolve_tenant_by_code(text);
DROP TABLE tenant;
