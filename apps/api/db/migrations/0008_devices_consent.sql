-- Up Migration
-- Devices, onboarding / replacement QR codes and employee consent. PRD 5, 15.4, 21.
--
-- Invariants enforced in the database (defence in depth, Architecture 10):
--   * at most one ACTIVE device per employee                                (PRD 5)
--   * a device can only be registered when the employee has a SIGNED consent, unless an Org Admin
--     recorded an override with a reason                                      (PRD 15.4 gate)
--   * withdrawing consent, or disabling/archiving the employee, deactivates their device   (PRD 12.2, 15.4)
--   * a device that stops being ACTIVE ends every session bound to it        (PRD 21.2)
-- Error code TK001 = CONSENT_REQUIRED (the API maps it to a 409 with that code).

-- ------------------------------------------------------------------ consent text versions

CREATE TABLE consent_text_version (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  version     text NOT NULL,
  language    text NOT NULL DEFAULT 'mn',
  body        text NOT NULL,
  -- A draft text can be previewed but must not be printed for real employees (legal review pending).
  is_draft    boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, version)
);
-- At most one active text per tenant.
CREATE UNIQUE INDEX consent_text_version_active_idx ON consent_text_version (tenant_id) WHERE active;
SELECT apply_tenant_rls('consent_text_version');

-- ------------------------------------------------------------------ consent records

-- One row per printed form. PRINTED -> SIGNED -> (SUPERSEDED by a newer signed form | WITHDRAWN).
CREATE TABLE consent_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id),
  employee_id       uuid NOT NULL,
  form_code         text NOT NULL,   -- printed on the form as text and barcode/QR (PRD 15.4)
  text_version      text NOT NULL,
  status            text NOT NULL DEFAULT 'PRINTED'
                    CHECK (status IN ('PRINTED', 'SIGNED', 'SUPERSEDED', 'WITHDRAWN')),
  printed_at        timestamptz NOT NULL DEFAULT now(),
  printed_by        uuid,
  signed_on         date,
  received_at       timestamptz,
  received_by       uuid,
  scan_object_key   text,
  withdrawn_on      date,
  withdrawn_by      uuid,
  withdrawal_note   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, form_code),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, text_version) REFERENCES consent_text_version (tenant_id, version),
  FOREIGN KEY (tenant_id, printed_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, received_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, withdrawn_by) REFERENCES user_account (tenant_id, id),
  CHECK (status = 'PRINTED' OR signed_on IS NOT NULL),
  CHECK (status = 'PRINTED' OR received_at IS NOT NULL),
  CHECK (status <> 'WITHDRAWN' OR withdrawn_on IS NOT NULL),
  CHECK (withdrawn_on IS NULL OR signed_on IS NULL OR withdrawn_on >= signed_on)
);
-- The currently valid consent: one SIGNED row per employee (a newer signed form supersedes the older one).
CREATE UNIQUE INDEX consent_record_signed_idx ON consent_record (tenant_id, employee_id) WHERE status = 'SIGNED';
CREATE INDEX consent_record_employee_idx ON consent_record (tenant_id, employee_id, status);
CREATE TRIGGER consent_record_updated_at BEFORE UPDATE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('consent_record');

-- Consent state per employee (PRD 15.4: Not requested / Printed / Signed / Withdrawn).
-- security_invoker makes the view obey the caller's Row-Level Security instead of the owner's.
CREATE VIEW employee_consent_status WITH (security_invoker = true) AS
SELECT
  e.tenant_id,
  e.id AS employee_id,
  CASE
    WHEN EXISTS (SELECT 1 FROM consent_record c WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.status = 'SIGNED')
      THEN 'SIGNED'
    WHEN (SELECT c.status FROM consent_record c
           WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.status IN ('PRINTED', 'WITHDRAWN', 'SUPERSEDED')
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1) = 'WITHDRAWN'
      THEN 'WITHDRAWN'
    WHEN EXISTS (SELECT 1 FROM consent_record c WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.status = 'PRINTED')
      THEN 'PRINTED'
    ELSE 'NOT_REQUESTED'
  END AS status,
  (SELECT c.text_version FROM consent_record c
    WHERE c.tenant_id = e.tenant_id AND c.employee_id = e.id AND c.status = 'SIGNED') AS signed_text_version
FROM employee e;
GRANT SELECT ON employee_consent_status TO app_user;

-- ------------------------------------------------------------------ devices

CREATE TABLE device (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenant (id),
  employee_id               uuid NOT NULL,
  platform                  text NOT NULL CHECK (platform IN ('ANDROID', 'IOS')),
  model                     text,
  os_version                text,
  app_version               text,
  -- Per-install key pair created in secure hardware at registration (Architecture 7.6).
  attestation_key_id        text,
  public_key                text,
  status                    text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'REPLACED')),
  registered_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz,
  disabled_at               timestamptz,
  disabled_reason           text CHECK (disabled_reason IN
                              ('LOST', 'STOLEN', 'REPLACED', 'EMPLOYEE_DISABLED', 'CONSENT_WITHDRAWN', 'OTHER')),
  disabled_note             text,
  disabled_by               uuid,
  replaced_by_device_id     uuid,
  -- Registration without signed consent is allowed only with an Org Admin override and a reason.
  consent_override_reason   text,
  consent_override_by       uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, disabled_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, consent_override_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, replaced_by_device_id) REFERENCES device (tenant_id, id),
  CHECK ((status = 'ACTIVE') = (disabled_at IS NULL)),
  CHECK ((consent_override_reason IS NULL) = (consent_override_by IS NULL)),
  CHECK (consent_override_reason IS NULL OR length(btrim(consent_override_reason)) >= 5),
  CHECK (replaced_by_device_id IS NULL OR status = 'REPLACED')
);
-- PRD 5: one active device per employee.
CREATE UNIQUE INDEX device_one_active_idx ON device (tenant_id, employee_id) WHERE status = 'ACTIVE';
-- The same install key cannot be registered under two accounts (PRD 6.7 DEVICE_CONFLICT).
CREATE UNIQUE INDEX device_attestation_key_idx ON device (tenant_id, attestation_key_id) WHERE attestation_key_id IS NOT NULL;
CREATE INDEX device_employee_idx ON device (tenant_id, employee_id, status);
CREATE TRIGGER device_updated_at BEFORE UPDATE ON device
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('device');

-- Employee sessions can be bound to the device that created them (added column from 0005).
ALTER TABLE auth_session
  ADD FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id);
CREATE INDEX auth_session_device_idx ON auth_session (tenant_id, device_id) WHERE device_id IS NOT NULL;

-- ------------------------------------------------------------------ onboarding / replacement QR

CREATE TABLE onboarding_qr (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  kind           text NOT NULL CHECK (kind IN ('ONBOARDING', 'REPLACEMENT')),
  -- ONBOARDING: general, can onboard many employees (PRD 5). REPLACEMENT: one employee, single use (PRD 21.1).
  employee_id    uuid,
  token_hash     text NOT NULL UNIQUE,   -- SHA-256 of the token; the QR carries no personal data (PRD 5)
  label          text,
  expires_at     timestamptz NOT NULL,
  max_uses       integer CHECK (max_uses IS NULL OR max_uses > 0),
  used_count     integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  cancelled_at   timestamptz,
  cancelled_by   uuid,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, cancelled_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  -- NULL-safe: a NULL max_uses (unlimited) must not satisfy the single-use rule.
  CHECK (kind <> 'REPLACEMENT' OR (employee_id IS NOT NULL AND max_uses IS NOT DISTINCT FROM 1)),
  CHECK (kind <> 'ONBOARDING' OR employee_id IS NULL),
  CHECK (max_uses IS NULL OR used_count <= max_uses)
);
CREATE INDEX onboarding_qr_open_idx ON onboarding_qr (tenant_id, kind, expires_at) WHERE cancelled_at IS NULL;
SELECT apply_tenant_rls('onboarding_qr');

-- Who used which QR (a general QR is used by many employees, each at most once).
CREATE TABLE onboarding_qr_use (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  qr_id        uuid NOT NULL,
  employee_id  uuid NOT NULL,
  device_id    uuid NOT NULL,
  used_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, qr_id) REFERENCES onboarding_qr (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id),
  UNIQUE (tenant_id, qr_id, employee_id)
);
SELECT apply_tenant_rls('onboarding_qr_use');

-- ------------------------------------------------------------------ triggers

-- Consent gate (PRD 15.4).
CREATE FUNCTION enforce_consent_before_device() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ACTIVE'
     AND NEW.consent_override_reason IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM consent_record c
        WHERE c.tenant_id = NEW.tenant_id AND c.employee_id = NEW.employee_id AND c.status = 'SIGNED'
     )
  THEN
    RAISE EXCEPTION 'CONSENT_REQUIRED: employee % has no signed consent', NEW.employee_id
      USING ERRCODE = 'TK001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER device_consent_gate BEFORE INSERT ON device
  FOR EACH ROW EXECUTE FUNCTION enforce_consent_before_device();

-- Withdrawn consent: no further collection, so the device is deactivated at once (PRD 15.4).
CREATE FUNCTION disable_device_on_consent_withdrawal() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE device
     SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'CONSENT_WITHDRAWN'
   WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.employee_id AND status = 'ACTIVE';
  RETURN NEW;
END
$$;
CREATE TRIGGER consent_withdrawn_disables_device
  AFTER UPDATE OF status ON consent_record
  FOR EACH ROW WHEN (NEW.status = 'WITHDRAWN' AND OLD.status IS DISTINCT FROM 'WITHDRAWN')
  EXECUTE FUNCTION disable_device_on_consent_withdrawal();

-- Disabled / archived employee: attendance stops, device deactivated (PRD 12.2).
CREATE FUNCTION disable_device_on_employee_exit() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE device
     SET status = 'DISABLED', disabled_at = now(), disabled_reason = 'EMPLOYEE_DISABLED'
   WHERE tenant_id = NEW.tenant_id AND employee_id = NEW.id AND status = 'ACTIVE';
  RETURN NEW;
END
$$;
CREATE TRIGGER employee_exit_disables_device
  AFTER UPDATE OF status ON employee
  FOR EACH ROW WHEN (NEW.status IN ('DISABLED', 'ARCHIVED') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION disable_device_on_employee_exit();

-- A device that stops being ACTIVE ends every session bound to it (PRD 21.2: token revoked immediately).
CREATE FUNCTION revoke_sessions_of_inactive_device() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE auth_session
     SET revoked_at = now()
   WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id AND revoked_at IS NULL;
  RETURN NEW;
END
$$;
CREATE TRIGGER device_inactive_revokes_sessions
  AFTER UPDATE OF status ON device
  FOR EACH ROW WHEN (OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE')
  EXECUTE FUNCTION revoke_sessions_of_inactive_device();

-- Down Migration
DROP TRIGGER device_inactive_revokes_sessions ON device;
DROP FUNCTION revoke_sessions_of_inactive_device();
DROP TRIGGER employee_exit_disables_device ON employee;
DROP FUNCTION disable_device_on_employee_exit();
DROP TRIGGER consent_withdrawn_disables_device ON consent_record;
DROP FUNCTION disable_device_on_consent_withdrawal();
DROP TRIGGER device_consent_gate ON device;
DROP FUNCTION enforce_consent_before_device();
DROP TABLE onboarding_qr_use;
DROP TABLE onboarding_qr;
DROP INDEX auth_session_device_idx;
-- Sessions lose their device binding on rollback; otherwise re-applying would hit dangling device ids.
UPDATE auth_session SET device_id = NULL WHERE device_id IS NOT NULL;
ALTER TABLE auth_session DROP CONSTRAINT auth_session_tenant_id_device_id_fkey;
DROP TABLE device;
DROP VIEW employee_consent_status;
DROP TABLE consent_record;
DROP TABLE consent_text_version;
