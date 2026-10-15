-- Up Migration
-- Super Admin (platform) sign-in and tenant management. PRD 4 "Super Admin", 15.2, 17.1.
-- Platform users stay in their own table (0002), reachable only by the platform_admin role. They sign in at /v1/platform/auth
-- with a password and a mandatory authenticator code; a platform session is a row here (revocable at once).

ALTER TABLE platform_user
  ADD COLUMN display_name          text,
  ADD COLUMN must_change_password  boolean NOT NULL DEFAULT true,
  ADD COLUMN password_changed_at   timestamptz,
  ADD COLUMN totp_last_step        bigint,
  ADD COLUMN failed_login_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN last_login_at         timestamptz;

CREATE TABLE platform_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES platform_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz
);
CREATE INDEX platform_session_user_idx ON platform_session (user_id);
ALTER TABLE platform_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_session FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON platform_session TO platform_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON platform_session TO platform_admin;

-- Down Migration
DROP TABLE platform_session;
ALTER TABLE platform_user
  DROP COLUMN last_login_at,
  DROP COLUMN locked_until,
  DROP COLUMN failed_login_count,
  DROP COLUMN totp_last_step,
  DROP COLUMN password_changed_at,
  DROP COLUMN must_change_password,
  DROP COLUMN display_name;
