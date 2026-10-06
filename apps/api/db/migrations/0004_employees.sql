-- Up Migration
-- Employees and temporary location assignments. PRD 12, 12.1, 12.2.
-- Composite foreign keys (tenant_id, x_id) make it impossible for a row to reference another tenant's row.

CREATE TABLE employee (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  employee_no          text NOT NULL,
  full_name            text NOT NULL,
  department_id        uuid NOT NULL,
  primary_location_id  uuid NOT NULL,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'ARCHIVED')),
  start_date           date,
  end_date             date,
  schedule_mode        text NOT NULL DEFAULT 'STANDARD' CHECK (schedule_mode IN ('STANDARD', 'SHIFT')),
  -- No device: HR records attendance manually (PRD 15.4, 17.1 interim handling of shift staff).
  manual_attendance    boolean NOT NULL DEFAULT false,
  device_model         text,
  os_version           text,
  device_compatible    boolean,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_no),
  FOREIGN KEY (tenant_id, department_id) REFERENCES department (tenant_id, id),
  FOREIGN KEY (tenant_id, primary_location_id) REFERENCES location (tenant_id, id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX employee_status_idx ON employee (tenant_id, status);
CREATE INDEX employee_location_idx ON employee (tenant_id, primary_location_id);
CREATE INDEX employee_department_idx ON employee (tenant_id, department_id);
CREATE TRIGGER employee_updated_at BEFORE UPDATE ON employee
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('employee');

CREATE TABLE temp_location_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  location_id  uuid NOT NULL,
  from_date    date NOT NULL,
  to_date      date NOT NULL,
  reason       text,
  created_by   uuid,   -- FK to user_account added in 0005
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
  CHECK (from_date <= to_date),
  -- Periods for one employee cannot overlap (PRD 12.1).
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  )
);
SELECT apply_tenant_rls('temp_location_assignment');

-- Down Migration
DROP TABLE temp_location_assignment;
DROP TABLE employee;
