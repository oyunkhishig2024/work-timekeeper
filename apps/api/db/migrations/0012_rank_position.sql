-- Up Migration
-- Rank (цол) and job position (албан тушаал) as two separate, effective-dated attributes of an employee.
-- PRD 12 (employee fields), 22.1 (effective-dated history).
--
-- Why separate: a rank only ever changes through promotion, a position changes with a transfer or a new
-- role, and the two change at different moments. Each has its own history so reports show the rank and
-- position held on the report date. Validity is half-open [valid_from, valid_to) and cannot overlap for
-- one employee (same convention as 0010/0011).

CREATE TABLE job_rank (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL,
  -- Seniority order, lowest first (Ахлагч = 1 ... Хурандаа = 8). Used for sorting and "at least rank X" filters.
  sort_order  integer NOT NULL CHECK (sort_order > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, sort_order)
);
SELECT apply_tenant_rls('job_rank');

CREATE TABLE job_position (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
SELECT apply_tenant_rls('job_position');

CREATE TABLE employee_rank_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  job_rank_id  uuid NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date,
  note         text,          -- e.g. order / decree number
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, job_rank_id) REFERENCES job_rank (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
CREATE INDEX employee_rank_assignment_rank_idx ON employee_rank_assignment (tenant_id, job_rank_id);
SELECT apply_tenant_rls('employee_rank_assignment');

CREATE TABLE employee_position_assignment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  employee_id      uuid NOT NULL,
  job_position_id  uuid NOT NULL,
  valid_from       date NOT NULL,
  valid_to         date,
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, job_position_id) REFERENCES job_position (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
CREATE INDEX employee_position_assignment_position_idx ON employee_position_assignment (tenant_id, job_position_id);
SELECT apply_tenant_rls('employee_position_assignment');

-- Down Migration
DROP TABLE employee_position_assignment;
DROP TABLE employee_rank_assignment;
DROP TABLE job_position;
DROP TABLE job_rank;
