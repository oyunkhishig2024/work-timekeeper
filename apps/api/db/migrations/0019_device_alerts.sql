-- Up Migration
-- Event-batch attestation and buddy-punching detection (PRD 6.7): per-device attestation run length and the alerts HR sees.

ALTER TABLE device
  ADD COLUMN attestation_unavailable_streak integer NOT NULL DEFAULT 0 CHECK (attestation_unavailable_streak >= 0),
  ADD COLUMN last_batch_verdict text CHECK (last_batch_verdict IN ('OK', 'FAILED', 'UNAVAILABLE', 'UNVERIFIED')),
  ADD COLUMN last_batch_attested_at timestamptz;

-- Something about a device that HR must look at: five unavailable attestation verdicts in a row, or one device /
-- identical movement trace claimed by two employees. One open alert per device, kind and counterpart.
CREATE TABLE device_alert (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  kind                  text NOT NULL CHECK (kind IN ('ATTESTATION_UNAVAILABLE_STREAK', 'DEVICE_CONFLICT')),
  device_id             uuid NOT NULL,
  employee_id           uuid NOT NULL,
  -- DEVICE_CONFLICT: the other party, when known.
  related_employee_id   uuid,
  detail                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolved_by           uuid,
  resolution_note       text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, related_employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, resolved_by) REFERENCES user_account (tenant_id, id),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK (kind = 'DEVICE_CONFLICT' OR related_employee_id IS NULL)
);
CREATE UNIQUE INDEX device_alert_open_idx ON device_alert
  (tenant_id, device_id, kind, COALESCE(related_employee_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE resolved_at IS NULL;
CREATE INDEX device_alert_created_idx ON device_alert (tenant_id, created_at);
SELECT apply_tenant_rls('device_alert');

-- Down Migration
DROP TABLE device_alert;
ALTER TABLE device
  DROP COLUMN last_batch_attested_at, DROP COLUMN last_batch_verdict, DROP COLUMN attestation_unavailable_streak;
