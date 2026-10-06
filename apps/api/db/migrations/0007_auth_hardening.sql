-- Up Migration
-- Authentication support. PRD 15.2.
--  * user_account: display name, TOTP replay protection (last accepted step), password change time
--  * auth_session: refresh-token family (rotation + reuse detection) and last use
--  * user_recovery_code: one-time recovery codes for the authenticator app

ALTER TABLE user_account
  ADD COLUMN display_name        text,
  ADD COLUMN totp_last_step      bigint,
  ADD COLUMN password_changed_at timestamptz;

ALTER TABLE auth_session
  ADD COLUMN family_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN last_used_at timestamptz;
CREATE INDEX auth_session_family_idx ON auth_session (tenant_id, family_id);

CREATE TABLE user_recovery_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  user_id     uuid NOT NULL,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES user_account (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, code_hash)
);
SELECT apply_tenant_rls('user_recovery_code');

-- Down Migration
DROP TABLE user_recovery_code;
DROP INDEX auth_session_family_idx;
ALTER TABLE auth_session DROP COLUMN last_used_at, DROP COLUMN family_id;
ALTER TABLE user_account
  DROP COLUMN password_changed_at, DROP COLUMN totp_last_step, DROP COLUMN display_name;
