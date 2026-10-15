-- Up Migration
-- A one-time password handed out by an admin expires after 72 hours, and the account owner can see that an admin reset it.
-- The expiry is set by a trigger, so no code path (admin reset, new account, console tool, reactivation) can forget it.

ALTER TABLE user_account
  ADD COLUMN temp_password_expires_at timestamptz,
  ADD COLUMN password_reset_at        timestamptz,
  ADD COLUMN password_reset_by        text;
ALTER TABLE platform_user ADD COLUMN temp_password_expires_at timestamptz;

CREATE FUNCTION set_temp_password_expiry() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.must_change_password THEN
    -- a new one-time password: a new account, a reset, or a first flag
    IF TG_OP = 'INSERT' OR NOT OLD.must_change_password OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
      NEW.temp_password_expires_at := now() + interval '72 hours';
    END IF;
  ELSE
    NEW.temp_password_expires_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER user_account_temp_password BEFORE INSERT OR UPDATE ON user_account
  FOR EACH ROW EXECUTE FUNCTION set_temp_password_expiry();
CREATE TRIGGER platform_user_temp_password BEFORE INSERT OR UPDATE ON platform_user
  FOR EACH ROW EXECUTE FUNCTION set_temp_password_expiry();

-- One-time passwords already out get the 72 hours from now.
UPDATE user_account SET temp_password_expires_at = now() + interval '72 hours' WHERE must_change_password;
UPDATE platform_user SET temp_password_expires_at = now() + interval '72 hours' WHERE must_change_password;

-- A new kind of notification: an admin reset someone's password or authenticator (one generic notice per event).
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('DEVICE_ALERT_ATTESTATION', 'DEVICE_ALERT_CONFLICT', 'CORRECTION_VOLUME', 'EARLY_LEAVE', 'PASSWORD_RESET', 'TEST'));

-- Down Migration
DELETE FROM notification WHERE kind = 'PASSWORD_RESET';
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('DEVICE_ALERT_ATTESTATION', 'DEVICE_ALERT_CONFLICT', 'CORRECTION_VOLUME', 'EARLY_LEAVE', 'TEST'));
DROP TRIGGER platform_user_temp_password ON platform_user;
DROP TRIGGER user_account_temp_password ON user_account;
DROP FUNCTION set_temp_password_expiry();
ALTER TABLE platform_user DROP COLUMN temp_password_expires_at;
ALTER TABLE user_account
  DROP COLUMN password_reset_by,
  DROP COLUMN password_reset_at,
  DROP COLUMN temp_password_expires_at;
