-- Up Migration
-- Manual attendance corrections (PRD 6.9) and the anomaly review queue (PRD 6.7).

-- ------------------------------------------------------------------ corrections

-- A correction is layered OVER the system-computed result; the original value is kept next to it and never overwritten.
-- At most one correction is in force per employee and date; editing = revoke the old one and insert a new one.
CREATE TABLE attendance_correction (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  employee_id           uuid NOT NULL,
  work_date             date NOT NULL,
  status                text NOT NULL CHECK (status IN ('ON_TIME', 'LATE', 'NO_SHOW')),
  arrival_at            timestamptz,
  reason_code           text NOT NULL CHECK (reason_code IN
                          ('PHONE_DEAD_LOST', 'GPS_FAULT', 'APP_ISSUE', 'ANOMALY_REVIEW', 'DATA_ENTRY_ERROR', 'OTHER')),
  note                  text,
  -- The system value at the time of the correction.
  original_status       text NOT NULL,
  original_arrival_at   timestamptz,
  created_by            uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  revoked_by            uuid,
  revoke_note           text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES user_account (tenant_id, id),
  CHECK (status <> 'NO_SHOW' OR arrival_at IS NULL),
  CHECK (reason_code <> 'OTHER' OR length(btrim(coalesce(note, ''))) >= 3),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX attendance_correction_active_idx
  ON attendance_correction (tenant_id, employee_id, work_date) WHERE revoked_at IS NULL;
CREATE INDEX attendance_correction_created_idx ON attendance_correction (tenant_id, created_at);
SELECT apply_tenant_rls('attendance_correction');

-- The derived result remembers what the system itself computed and where the shown value came from (PRD 6.9: "Source:
-- Auto / Corrected"), and how many events of the duty still wait for review (PRD 6.7: "N flagged").
ALTER TABLE attendance_result
  ADD COLUMN source             text NOT NULL DEFAULT 'AUTO' CHECK (source IN ('AUTO', 'CORRECTED')),
  ADD COLUMN system_status      text,
  ADD COLUMN system_arrival_at  timestamptz,
  ADD COLUMN flagged_events     integer NOT NULL DEFAULT 0 CHECK (flagged_events >= 0),
  ADD COLUMN correction_id      uuid;
UPDATE attendance_result SET system_status = status, system_arrival_at = arrival_at;

-- ------------------------------------------------------------------ anomaly review

ALTER TABLE device_event
  ADD COLUMN review_status text CHECK (review_status IN ('PENDING', 'CONFIRMED', 'REJECTED', 'RECHECK_REQUESTED')),
  ADD COLUMN reviewed_by   uuid,
  ADD COLUMN reviewed_at   timestamptz,
  ADD COLUMN review_note   text,
  ADD FOREIGN KEY (tenant_id, reviewed_by) REFERENCES user_account (tenant_id, id),
  ADD CHECK ((review_status IS NULL OR review_status = 'PENDING') = (reviewed_by IS NULL));
CREATE INDEX device_event_review_idx ON device_event (tenant_id, occurred_at)
  WHERE review_status IN ('PENDING', 'RECHECK_REQUESTED');

-- Down Migration
DROP INDEX device_event_review_idx;
ALTER TABLE device_event
  DROP COLUMN review_note, DROP COLUMN reviewed_at, DROP COLUMN reviewed_by, DROP COLUMN review_status;
ALTER TABLE attendance_result
  DROP COLUMN correction_id, DROP COLUMN flagged_events, DROP COLUMN system_arrival_at,
  DROP COLUMN system_status, DROP COLUMN source;
DROP TABLE attendance_correction;
