-- Up Migration
-- Tenant users, scopes, sessions and invites. PRD 4, 15.2.
-- Super Admin accounts live in platform_user (0002); role SUPER_ADMIN does not exist here.

CREATE TABLE user_account (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  username              text NOT NULL,
  password_hash         text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('ORG_ADMIN', 'HR', 'MANAGER', 'EMPLOYEE')),
  employee_id           uuid,
  must_change_password  boolean NOT NULL DEFAULT true,
  totp_secret_enc       text,
  totp_enabled          boolean NOT NULL DEFAULT false,
  failed_login_count    integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  -- An EMPLOYEE account belongs to exactly one employee; staff accounts have none.
  CHECK ((role = 'EMPLOYEE') = (employee_id IS NOT NULL))
);
CREATE UNIQUE INDEX user_account_username_idx ON user_account (tenant_id, lower(username));
CREATE UNIQUE INDEX user_account_employee_idx ON user_account (tenant_id, employee_id)
  WHERE employee_id IS NOT NULL;
CREATE TRIGGER user_account_updated_at BEFORE UPDATE ON user_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('user_account');

ALTER TABLE temp_location_assignment
  ADD FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id);

-- Managers (and scoped HR) see only these locations/departments; no rows = no access (deny by default).
CREATE TABLE user_scope (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  user_id        uuid NOT NULL,
  location_id    uuid,
  department_id  uuid,
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  CHECK (location_id IS NOT NULL OR department_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, location_id, department_id)
);
SELECT apply_tenant_rls('user_scope');

CREATE TABLE auth_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id),
  user_id       uuid NOT NULL,
  device_id     uuid,   -- FK to device added with the devices migration
  refresh_hash  text NOT NULL,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX auth_session_user_idx ON auth_session (tenant_id, user_id);
CREATE UNIQUE INDEX auth_session_refresh_idx ON auth_session (refresh_hash);
SELECT apply_tenant_rls('auth_session');

CREATE TABLE invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  user_id     uuid NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX invite_user_idx ON invite (tenant_id, user_id);
SELECT apply_tenant_rls('invite');

-- Down Migration
DROP TABLE invite;
DROP TABLE auth_session;
DROP TABLE user_scope;
ALTER TABLE temp_location_assignment DROP CONSTRAINT temp_location_assignment_tenant_id_created_by_fkey;
DROP TABLE user_account;
