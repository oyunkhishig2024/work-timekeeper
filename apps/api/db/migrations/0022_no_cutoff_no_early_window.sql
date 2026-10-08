-- PRD 6.3 / 23.2 (v1.24): the no-show cut-off and the early-arrival window are gone. An employee with no arrival
-- and no reason is Ирээгүй only once the duty is over, and arriving earlier than the start is never a problem.
-- Nothing in these columns is used any more.

ALTER TABLE attendance_rule_version
  DROP COLUMN cutoff_minutes,
  DROP COLUMN early_window_minutes;

-- The in-use guard of shift templates compared the two columns; it keeps guarding the rest.
CREATE OR REPLACE FUNCTION guard_shift_template_in_use() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.start_time, NEW.duration_minutes, NEW.grace_minutes, NEW.observes_holidays)
     IS DISTINCT FROM
     (OLD.start_time, OLD.duration_minutes, OLD.grace_minutes, OLD.observes_holidays)
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

ALTER TABLE shift_template
  DROP COLUMN cutoff_minutes,
  DROP COLUMN early_window_minutes;
