-- Up Migration
-- Shift templates, rotation patterns, assignments and overrides. PRD 23, 22.1.
--
-- Storage and integrity only; how a shift turns into "expected on this date" is in packages/domain
-- (the single expectation function, PRD 23.5).
--
-- History is protected like this (PRD 22.1: changing a rule must never rewrite the past):
--   * a shift template or pattern that is already in use is IMMUTABLE — to change it, create a new one and
--     retire the old (`active = false`, optionally `supersedes_id`); only name/active can change in place;
--   * assignments are dated ranges that cannot overlap for one employee.
-- Error codes raised here: TK002 = SHIFT_MODE_REQUIRED, TK005 = SHIFT_TEMPLATE_IN_USE,
-- TK006 = SHIFT_PATTERN_IN_USE, TK007 = SHIFT_PATTERN_INCOMPLETE.

-- ------------------------------------------------------------------ templates (PRD 23.1)

CREATE TABLE shift_template (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  name                  text NOT NULL,
  start_time            time NOT NULL,
  -- Up to 24 h; a shift that starts at 20:00 with 720 minutes ends at 08:00 the next day.
  duration_minutes      integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 1440),
  grace_minutes         integer NOT NULL DEFAULT 15  CHECK (grace_minutes BETWEEN 0 AND 240),
  cutoff_minutes        integer NOT NULL DEFAULT 120 CHECK (cutoff_minutes BETWEEN 0 AND 1440),
  early_window_minutes  integer NOT NULL DEFAULT 120 CHECK (early_window_minutes BETWEEN 0 AND 720),
  -- Guards on 24 h shifts work on public holidays (false); day staff on a shift do not (true).
  observes_holidays     boolean NOT NULL DEFAULT false,
  active                boolean NOT NULL DEFAULT true,
  supersedes_id         uuid,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, supersedes_id) REFERENCES shift_template (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id)
);
-- Active templates have unique names; retired versions keep theirs.
CREATE UNIQUE INDEX shift_template_active_name_idx ON shift_template (tenant_id, name) WHERE active;
CREATE TRIGGER shift_template_updated_at BEFORE UPDATE ON shift_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('shift_template');

-- ------------------------------------------------------------------ patterns (PRD 23.1)

-- A repeating sequence of days, e.g. "24 h on / 48 h off" = cycle_length_days 3 with one template day and two off days.
CREATE TABLE shift_pattern (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id),
  name              text NOT NULL,
  cycle_length_days integer NOT NULL CHECK (cycle_length_days BETWEEN 1 AND 366),
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id)
);
CREATE UNIQUE INDEX shift_pattern_active_name_idx ON shift_pattern (tenant_id, name) WHERE active;
CREATE TRIGGER shift_pattern_updated_at BEFORE UPDATE ON shift_pattern
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('shift_pattern');

-- Day i of the cycle: a template (a working day) or NULL (an off day).
CREATE TABLE shift_pattern_day (
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  pattern_id   uuid NOT NULL,
  day_index    integer NOT NULL CHECK (day_index >= 0),
  template_id  uuid,
  PRIMARY KEY (pattern_id, day_index),
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES shift_pattern (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, template_id) REFERENCES shift_template (tenant_id, id)
);
CREATE INDEX shift_pattern_day_template_idx ON shift_pattern_day (tenant_id, template_id);
SELECT apply_tenant_rls('shift_pattern_day');

-- ------------------------------------------------------------------ assignments (PRD 23.1, 23.4)

CREATE TABLE shift_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant (id),
  employee_id       uuid NOT NULL,
  -- Either a rotation pattern, or one fixed template that applies every day of the range.
  pattern_id        uuid,
  template_id       uuid,
  -- The date that is day 0 of the pattern's cycle; employees on the same team share a pattern with different offsets.
  cycle_start_date  date,
  from_date         date NOT NULL,
  to_date           date,    -- inclusive; NULL = open-ended
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES shift_pattern (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES shift_template (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK ((pattern_id IS NULL) <> (template_id IS NULL)),
  CHECK (pattern_id IS NULL OR cycle_start_date IS NOT NULL),
  CHECK (to_date IS NULL OR to_date >= from_date),
  -- One assignment at a time per employee (PRD 23.4).
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  )
);
CREATE INDEX shift_assignment_pattern_idx ON shift_assignment (tenant_id, pattern_id);
CREATE INDEX shift_assignment_template_idx ON shift_assignment (tenant_id, template_id);
SELECT apply_tenant_rls('shift_assignment');

-- ------------------------------------------------------------------ overrides (PRD 23.1)

-- A change for one date: ADD an extra shift, REMOVE a planned one, SWAP to a different template.
CREATE TABLE shift_override (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  work_date    date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('ADD', 'REMOVE', 'SWAP')),
  template_id  uuid,
  reason       text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, employee_id, work_date),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES shift_template (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK ((kind = 'REMOVE') = (template_id IS NULL))
);
CREATE INDEX shift_override_template_idx ON shift_override (tenant_id, template_id) WHERE template_id IS NOT NULL;
SELECT apply_tenant_rls('shift_override');

-- ------------------------------------------------------------------ triggers

-- Only employees whose schedule mode is SHIFT can have shift assignments.
CREATE FUNCTION require_shift_schedule_mode() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM employee WHERE tenant_id = NEW.tenant_id AND id = NEW.employee_id AND schedule_mode = 'SHIFT'
  ) THEN
    RAISE EXCEPTION 'SHIFT_MODE_REQUIRED: employee % is not on a shift schedule', NEW.employee_id
      USING ERRCODE = 'TK002';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shift_assignment_requires_shift_mode
  BEFORE INSERT OR UPDATE OF employee_id ON shift_assignment
  FOR EACH ROW EXECUTE FUNCTION require_shift_schedule_mode();

-- A template that is used anywhere keeps its timing forever (PRD 22.1).
CREATE FUNCTION guard_shift_template_in_use() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.start_time, NEW.duration_minutes, NEW.grace_minutes, NEW.cutoff_minutes,
      NEW.early_window_minutes, NEW.observes_holidays)
     IS DISTINCT FROM
     (OLD.start_time, OLD.duration_minutes, OLD.grace_minutes, OLD.cutoff_minutes,
      OLD.early_window_minutes, OLD.observes_holidays)
  THEN
    IF EXISTS (SELECT 1 FROM shift_pattern_day WHERE tenant_id = OLD.tenant_id AND template_id = OLD.id)
       OR EXISTS (SELECT 1 FROM shift_assignment WHERE tenant_id = OLD.tenant_id AND template_id = OLD.id)
       OR EXISTS (SELECT 1 FROM shift_override WHERE tenant_id = OLD.tenant_id AND template_id = OLD.id)
    THEN
      RAISE EXCEPTION 'SHIFT_TEMPLATE_IN_USE: create a new template instead of changing "%"', OLD.name
        USING ERRCODE = 'TK005';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER shift_template_immutable_when_used
  BEFORE UPDATE ON shift_template
  FOR EACH ROW EXECUTE FUNCTION guard_shift_template_in_use();

-- A pattern that is assigned to anyone keeps its days and cycle length.
CREATE FUNCTION guard_shift_pattern_in_use() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pid uuid;
  tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'shift_pattern' THEN
    IF NEW.cycle_length_days = OLD.cycle_length_days THEN
      RETURN NEW;
    END IF;
    pid := OLD.id;
    tid := OLD.tenant_id;
  ELSE
    pid := COALESCE(NEW.pattern_id, OLD.pattern_id);
    tid := COALESCE(NEW.tenant_id, OLD.tenant_id);
  END IF;
  IF EXISTS (SELECT 1 FROM shift_assignment WHERE tenant_id = tid AND pattern_id = pid) THEN
    RAISE EXCEPTION 'SHIFT_PATTERN_IN_USE: create a new pattern instead of changing an assigned one'
      USING ERRCODE = 'TK006';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
CREATE TRIGGER shift_pattern_immutable_when_used
  BEFORE UPDATE ON shift_pattern
  FOR EACH ROW EXECUTE FUNCTION guard_shift_pattern_in_use();
CREATE TRIGGER shift_pattern_day_immutable_when_used
  BEFORE INSERT OR UPDATE OR DELETE ON shift_pattern_day
  FOR EACH ROW EXECUTE FUNCTION guard_shift_pattern_in_use();

-- A pattern must define every day 0 … cycle_length_days-1 exactly once when the transaction commits.
CREATE FUNCTION check_shift_pattern_complete() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pid uuid;
  len integer;
  n integer;
  max_index integer;
BEGIN
  IF TG_TABLE_NAME = 'shift_pattern' THEN
    pid := NEW.id;
  ELSE
    pid := COALESCE(NEW.pattern_id, OLD.pattern_id);
  END IF;
  SELECT cycle_length_days INTO len FROM shift_pattern WHERE id = pid;
  IF NOT FOUND THEN
    RETURN NULL;   -- the whole pattern was deleted
  END IF;
  SELECT count(*), COALESCE(max(day_index), -1) INTO n, max_index FROM shift_pattern_day WHERE pattern_id = pid;
  IF n <> len OR max_index <> len - 1 THEN
    RAISE EXCEPTION 'SHIFT_PATTERN_INCOMPLETE: pattern needs days 0..% (has % rows, highest index %)', len - 1, n, max_index
      USING ERRCODE = 'TK007';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER shift_pattern_complete
  AFTER INSERT OR UPDATE OF cycle_length_days ON shift_pattern
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shift_pattern_complete();
CREATE CONSTRAINT TRIGGER shift_pattern_day_complete
  AFTER INSERT OR DELETE OR UPDATE OF day_index ON shift_pattern_day
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_shift_pattern_complete();

-- Down Migration
DROP TRIGGER shift_pattern_day_complete ON shift_pattern_day;
DROP TRIGGER shift_pattern_complete ON shift_pattern;
DROP FUNCTION check_shift_pattern_complete();
DROP TRIGGER shift_pattern_day_immutable_when_used ON shift_pattern_day;
DROP TRIGGER shift_pattern_immutable_when_used ON shift_pattern;
DROP FUNCTION guard_shift_pattern_in_use();
DROP TRIGGER shift_template_immutable_when_used ON shift_template;
DROP FUNCTION guard_shift_template_in_use();
DROP TRIGGER shift_assignment_requires_shift_mode ON shift_assignment;
DROP FUNCTION require_shift_schedule_mode();
DROP TABLE shift_override;
DROP TABLE shift_assignment;
DROP TABLE shift_pattern_day;
DROP TABLE shift_pattern;
DROP TABLE shift_template;
