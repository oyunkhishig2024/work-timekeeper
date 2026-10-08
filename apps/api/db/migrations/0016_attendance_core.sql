-- Up Migration
-- Attendance core: device events, derived daily results and their status history. PRD 6, 6.8, 7.
--
-- `device_event` is append-only raw input. `attendance_result` is DERIVED data: it can be dropped and rebuilt
-- from events + schedule + reasons at any time (POST /v1/attendance/recompute). The rules live in
-- packages/domain (`getExpectation`, `deriveStatus`), never in SQL.

CREATE TABLE device_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  employee_id      uuid NOT NULL,
  device_id        uuid NOT NULL,
  location_id      uuid NOT NULL,
  -- Idempotency key generated on the device; a retry of the same upload is accepted once (PRD 6.8).
  client_event_id  text NOT NULL CHECK (length(client_event_id) BETWEEN 8 AND 100),
  type             text NOT NULL CHECK (type IN ('ENTER', 'EXIT')),
  -- Server-authoritative time: received_at minus the device's monotonic age of the event (PRD 6.8).
  occurred_at      timestamptz NOT NULL,
  received_at      timestamptz NOT NULL,
  -- What the phone's wall clock claimed, kept only to detect tampering / skew.
  claimed_at       timestamptz,
  accuracy_m       numeric(7, 1),
  -- CLOCK_SKEW (> 2 min), LATE_SYNC (> 24 h old), LOW_ACCURACY (> 50 m). Flags never reject an event (PRD 6.7).
  flags            text[] NOT NULL DEFAULT '{}',
  -- False when the event is stored for audit but must not count towards attendance.
  counted          boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, device_id, client_event_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES device (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);
CREATE INDEX device_event_employee_time_idx ON device_event (tenant_id, employee_id, occurred_at);
SELECT apply_tenant_rls('device_event');

-- One row per employee and work date (the date a duty starts, PRD 23.2).
CREATE TABLE attendance_result (
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  employee_id    uuid NOT NULL,
  work_date      date NOT NULL,
  status         text NOT NULL CHECK (status IN
                   ('ON_TIME', 'LATE', 'EXCUSED', 'NO_SHOW', 'PENDING', 'WORKED_OFF_DAY', 'NOT_CONFIGURED')),
  -- The duty location (null for WORKED_OFF_DAY / NOT_CONFIGURED).
  location_id    uuid,
  expected_start timestamptz,
  expected_cutoff timestamptz,
  arrival_at     timestamptz,
  late_minutes   integer NOT NULL DEFAULT 0 CHECK (late_minutes >= 0),
  -- Name of the covering reason when status = EXCUSED.
  reason_name    text,
  -- Which configuration is missing when status = NOT_CONFIGURED (shown to HR).
  missing        text,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);
CREATE INDEX attendance_result_date_idx ON attendance_result (tenant_id, work_date, status);
SELECT apply_tenant_rls('attendance_result');

-- Every status change (PENDING -> ON_TIME, PENDING -> NO_SHOW, NO_SHOW -> EXCUSED after a reason, ...). Append-only.
CREATE TABLE attendance_result_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  old_status   text,
  new_status   text NOT NULL,
  changed_at   timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id)
);
CREATE INDEX attendance_result_log_idx ON attendance_result_log (tenant_id, employee_id, work_date, changed_at);
SELECT apply_tenant_rls('attendance_result_log');

-- Down Migration
DROP TABLE attendance_result_log;
DROP TABLE attendance_result;
DROP TABLE device_event;
