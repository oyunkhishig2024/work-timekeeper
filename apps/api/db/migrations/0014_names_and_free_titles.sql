-- Up Migration
-- 1. An employee's name is stored as last name (Овог) and first name (Нэр); `full_name` ("Овог Нэр") stays as the
--    display / search column and is kept in step by a trigger, so code that writes only `full_name` keeps working.
-- 2. Rank (цол) and position (албан тушаал) become free text: another organization may use any wording, not only
--    military ranks. Their histories (0012) keep their dates; the catalogs `job_rank` / `job_position` are dropped.
-- PRD 12, 22.1.

-- ------------------------------------------------------------------ names

ALTER TABLE employee ADD COLUMN last_name text, ADD COLUMN first_name text;

-- Legacy "Овог Нэр": the first word is the last name, the rest the first name; a single word is a first name.
UPDATE employee SET
  last_name  = CASE WHEN position(' ' IN btrim(full_name)) > 0 THEN split_part(btrim(full_name), ' ', 1) ELSE '' END,
  first_name = CASE WHEN position(' ' IN btrim(full_name)) > 0
                    THEN btrim(substring(btrim(full_name) FROM position(' ' IN btrim(full_name)) + 1))
                    ELSE btrim(full_name) END;
ALTER TABLE employee ALTER COLUMN last_name SET NOT NULL, ALTER COLUMN first_name SET NOT NULL;

CREATE FUNCTION sync_employee_names() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legacy boolean;
BEGIN
  -- Only `full_name` was written (an old-style insert or update): derive the two parts from it.
  IF TG_OP = 'INSERT' THEN
    legacy := NEW.last_name IS NULL AND NEW.first_name IS NULL AND NEW.full_name IS NOT NULL;
  ELSE
    legacy := NEW.full_name IS DISTINCT FROM OLD.full_name
              AND NEW.last_name IS NOT DISTINCT FROM OLD.last_name
              AND NEW.first_name IS NOT DISTINCT FROM OLD.first_name;
  END IF;
  IF legacy THEN
    IF position(' ' IN btrim(NEW.full_name)) > 0 THEN
      NEW.last_name := split_part(btrim(NEW.full_name), ' ', 1);
      NEW.first_name := btrim(substring(btrim(NEW.full_name) FROM position(' ' IN btrim(NEW.full_name)) + 1));
    ELSE
      NEW.last_name := '';
      NEW.first_name := btrim(NEW.full_name);
    END IF;
  END IF;
  NEW.last_name := COALESCE(NEW.last_name, '');
  NEW.first_name := COALESCE(NEW.first_name, '');
  NEW.full_name := btrim(NEW.last_name || ' ' || NEW.first_name);
  RETURN NEW;
END
$$;
CREATE TRIGGER employee_sync_names BEFORE INSERT OR UPDATE ON employee
  FOR EACH ROW EXECUTE FUNCTION sync_employee_names();

-- ------------------------------------------------------------------ free-text rank and position

ALTER TABLE employee_rank_assignment ADD COLUMN title text;
UPDATE employee_rank_assignment a SET title = r.name FROM job_rank r WHERE r.tenant_id = a.tenant_id AND r.id = a.job_rank_id;
ALTER TABLE employee_rank_assignment
  ALTER COLUMN title SET NOT NULL,
  ADD CONSTRAINT employee_rank_assignment_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 120),
  DROP COLUMN job_rank_id;

ALTER TABLE employee_position_assignment ADD COLUMN title text;
UPDATE employee_position_assignment a SET title = p.name FROM job_position p WHERE p.tenant_id = a.tenant_id AND p.id = a.job_position_id;
ALTER TABLE employee_position_assignment
  ALTER COLUMN title SET NOT NULL,
  ADD CONSTRAINT employee_position_assignment_title_check CHECK (btrim(title) <> '' AND char_length(title) <= 120),
  DROP COLUMN job_position_id;

DROP TABLE job_rank;
DROP TABLE job_position;

-- Suggestions for the text fields and the list filters look titles up case-insensitively.
CREATE INDEX employee_rank_assignment_title_idx ON employee_rank_assignment (tenant_id, lower(title));
CREATE INDEX employee_position_assignment_title_idx ON employee_position_assignment (tenant_id, lower(title));

-- Down Migration
CREATE TABLE job_rank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name), UNIQUE (tenant_id, sort_order)
);
SELECT apply_tenant_rls('job_rank');
CREATE TABLE job_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id), UNIQUE (tenant_id, name)
);
SELECT apply_tenant_rls('job_position');
INSERT INTO job_rank (tenant_id, name, sort_order)
  SELECT tenant_id, title, row_number() OVER (PARTITION BY tenant_id ORDER BY title) FROM
  (SELECT DISTINCT tenant_id, title FROM employee_rank_assignment) t;
INSERT INTO job_position (tenant_id, name)
  SELECT DISTINCT tenant_id, title FROM employee_position_assignment;
DROP INDEX employee_rank_assignment_title_idx;
DROP INDEX employee_position_assignment_title_idx;
ALTER TABLE employee_rank_assignment ADD COLUMN job_rank_id uuid;
UPDATE employee_rank_assignment a SET job_rank_id = r.id FROM job_rank r WHERE r.tenant_id = a.tenant_id AND r.name = a.title;
ALTER TABLE employee_rank_assignment ALTER COLUMN job_rank_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, job_rank_id) REFERENCES job_rank (tenant_id, id),
  DROP CONSTRAINT employee_rank_assignment_title_check, DROP COLUMN title;
ALTER TABLE employee_position_assignment ADD COLUMN job_position_id uuid;
UPDATE employee_position_assignment a SET job_position_id = p.id FROM job_position p WHERE p.tenant_id = a.tenant_id AND p.name = a.title;
ALTER TABLE employee_position_assignment ALTER COLUMN job_position_id SET NOT NULL,
  ADD FOREIGN KEY (tenant_id, job_position_id) REFERENCES job_position (tenant_id, id),
  DROP CONSTRAINT employee_position_assignment_title_check, DROP COLUMN title;
DROP TRIGGER employee_sync_names ON employee;
DROP FUNCTION sync_employee_names();
ALTER TABLE employee DROP COLUMN last_name, DROP COLUMN first_name;
