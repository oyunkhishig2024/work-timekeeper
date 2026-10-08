-- PRD 14.3 (v1.26): hours fixed by HR for one employee over a range of dates, with one or more places.
-- They replace the working week, a holiday or a shift for those dates in getExpectation.

CREATE TABLE personal_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  from_date    date NOT NULL,
  to_date      date NOT NULL,          -- inclusive
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  note         text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (to_date >= from_date),
  CHECK (to_date - from_date <= 30),
  CHECK (end_time > start_time),
  -- One set of personal hours per employee and date.
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  )
);
CREATE INDEX personal_hours_employee_idx ON personal_hours (tenant_id, employee_id, from_date);
SELECT apply_tenant_rls('personal_hours');

-- The places of one set of personal hours; position 0 is the main one. No rows: the employee's usual expected place.
CREATE TABLE personal_hours_location (
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  personal_hours_id  uuid NOT NULL,
  location_id        uuid NOT NULL,
  position           smallint NOT NULL CHECK (position BETWEEN 0 AND 5),
  PRIMARY KEY (personal_hours_id, location_id),
  UNIQUE (personal_hours_id, position),
  FOREIGN KEY (tenant_id, personal_hours_id) REFERENCES personal_hours (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);
SELECT apply_tenant_rls('personal_hours_location');
