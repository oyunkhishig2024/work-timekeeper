-- PRD 23.2 (v1.27): leaving early. The tolerance belongs to the attendance rules; the minutes belong to the derived
-- daily result (rebuilt by POST /v1/attendance/recompute).
ALTER TABLE attendance_rule_version
  ADD COLUMN early_leave_tolerance_minutes integer NOT NULL DEFAULT 15
    CHECK (early_leave_tolerance_minutes BETWEEN 0 AND 240);

-- Minutes between the departure and the end of the duty when the employee left more than the tolerance early; 0 otherwise.
ALTER TABLE attendance_result
  ADD COLUMN early_leave_minutes integer NOT NULL DEFAULT 0 CHECK (early_leave_minutes >= 0);
CREATE INDEX attendance_result_early_leave_idx ON attendance_result (tenant_id, work_date)
  WHERE early_leave_minutes > 0;

-- A new kind of notification: someone left early (one generic notice per day).
ALTER TABLE notification DROP CONSTRAINT notification_kind_check;
ALTER TABLE notification ADD CONSTRAINT notification_kind_check CHECK (kind IN
  ('DEVICE_ALERT_ATTESTATION', 'DEVICE_ALERT_CONFLICT', 'CORRECTION_VOLUME', 'EARLY_LEAVE', 'TEST'));
