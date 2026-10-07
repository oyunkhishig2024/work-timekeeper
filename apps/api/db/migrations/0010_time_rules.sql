-- Up Migration
-- Attendance rule versions, working week, working-day exceptions and holidays. PRD 6.2–6.4, 13, 14, 22.1.
--
-- This migration only stores configuration and protects its integrity. WHAT the rules mean (who is expected
-- when, holiday recurrence, late/no-show) lives in packages/domain, not in SQL.
--
-- Versioned tables use half-open validity [valid_from, valid_to): `valid_to` is the first day the row no longer
-- applies; NULL means "until further notice". An exclusion constraint forbids two versions of the same scope
-- from overlapping, so for any date there is at most one version in force. A NULL location_id is the tenant
-- default; a location row overrides it for that location.
-- Error codes raised here: TK003 = WORKING_WEEK_INCOMPLETE, TK004 = HOLIDAY_SCOPE_INVALID.

-- ------------------------------------------------------------------ attendance rules (PRD 6.2–6.4)

CREATE TABLE attendance_rule_version (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant (id),
  location_id            uuid,
  valid_from             date NOT NULL,
  valid_to               date,
  grace_minutes          integer NOT NULL DEFAULT 15  CHECK (grace_minutes BETWEEN 0 AND 240),
  cutoff_minutes         integer NOT NULL DEFAULT 120 CHECK (cutoff_minutes BETWEEN 0 AND 1440),   -- no-show after start + this (PRD 6.3)
  min_stay_minutes       integer NOT NULL DEFAULT 3   CHECK (min_stay_minutes BETWEEN 1 AND 15),    -- PRD 6.4
  early_window_minutes   integer NOT NULL DEFAULT 120 CHECK (early_window_minutes BETWEEN 0 AND 720), -- PRD 23.2
  created_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    tenant_id WITH =,
    (COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
SELECT apply_tenant_rls('attendance_rule_version');

-- ------------------------------------------------------------------ working week (PRD 14.1)

CREATE TABLE working_week_version (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  location_id  uuid,
  valid_from   date NOT NULL,
  valid_to     date,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  EXCLUDE USING gist (
    tenant_id WITH =,
    (COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  )
);
SELECT apply_tenant_rls('working_week_version');

-- One row per ISO weekday (1 = Monday … 7 = Sunday). Working days have start and end; off days have neither.
CREATE TABLE working_week_day (
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  working_week_id  uuid NOT NULL,
  weekday          smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  working          boolean NOT NULL,
  start_time       time,
  end_time         time,
  PRIMARY KEY (working_week_id, weekday),
  FOREIGN KEY (tenant_id, working_week_id) REFERENCES working_week_version (tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (working AND start_time IS NOT NULL AND end_time IS NOT NULL AND start_time < end_time)
    OR (NOT working AND start_time IS NULL AND end_time IS NULL)
  )
);
SELECT apply_tenant_rls('working_week_day');

-- A week version must have all 7 days when the transaction commits (deferred so the version and its days
-- can be inserted in any order inside one transaction).
CREATE FUNCTION check_working_week_complete() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  wid uuid;
  n   integer;
BEGIN
  IF TG_TABLE_NAME = 'working_week_version' THEN
    wid := NEW.id;
  ELSE
    wid := COALESCE(NEW.working_week_id, OLD.working_week_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM working_week_version WHERE id = wid) THEN
    RETURN NULL;   -- the whole version was deleted
  END IF;
  SELECT count(*) INTO n FROM working_week_day WHERE working_week_id = wid;
  IF n <> 7 THEN
    RAISE EXCEPTION 'WORKING_WEEK_INCOMPLETE: a working week needs all 7 weekdays (has %)', n
      USING ERRCODE = 'TK003';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER working_week_version_complete
  AFTER INSERT ON working_week_version
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_working_week_complete();
CREATE CONSTRAINT TRIGGER working_week_day_complete
  AFTER INSERT OR DELETE OR UPDATE OF weekday ON working_week_day
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_working_week_complete();

-- A single date that is working although the week says off (e.g. a transferred working Saturday), or off
-- although the week says working. Takes priority over the weekly table (PRD 14.1).
CREATE TABLE working_day_exception (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  location_id     uuid,
  exception_date  date NOT NULL,
  working         boolean NOT NULL,
  start_time      time,
  end_time        time,
  note            text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (
    (working AND (start_time IS NULL) = (end_time IS NULL) AND (start_time IS NULL OR start_time < end_time))
    OR (NOT working AND start_time IS NULL AND end_time IS NULL)
  )
);
-- One exception per scope and date (NULL location = whole tenant).
CREATE UNIQUE INDEX working_day_exception_scope_date_idx
  ON working_day_exception (tenant_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid), exception_date);
SELECT apply_tenant_rls('working_day_exception');

-- ------------------------------------------------------------------ holidays (PRD 14.2)

CREATE TABLE holiday (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  name            text NOT NULL,
  from_date       date NOT NULL,
  to_date         date NOT NULL,          -- inclusive
  kind            text NOT NULL DEFAULT 'PUBLIC_HOLIDAY'
                  CHECK (kind IN ('PUBLIC_HOLIDAY', 'COMPANY_DAY_OFF', 'TRANSFERRED_DAY_OFF')),
  -- Fixed-date holidays repeat every year on the same dates; moving holidays are entered per year.
  repeats_yearly  boolean NOT NULL DEFAULT false,
  applies_to_all  boolean NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name, from_date),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  CHECK (to_date >= from_date),
  CHECK (to_date - from_date <= 30)
);
CREATE INDEX holiday_dates_idx ON holiday (tenant_id, from_date, to_date);
CREATE TRIGGER holiday_updated_at BEFORE UPDATE ON holiday
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('holiday');

-- Locations a non-global holiday applies to.
CREATE TABLE holiday_location (
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  holiday_id   uuid NOT NULL,
  location_id  uuid NOT NULL,
  PRIMARY KEY (holiday_id, location_id),
  FOREIGN KEY (tenant_id, holiday_id) REFERENCES holiday (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, location_id) REFERENCES location (tenant_id, id)
);
SELECT apply_tenant_rls('holiday_location');

-- A holiday applies either to all locations or to a non-empty list of them — checked at commit.
CREATE FUNCTION check_holiday_scope() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  hid uuid;
  all_locations boolean;
  has_rows boolean;
BEGIN
  IF TG_TABLE_NAME = 'holiday' THEN
    hid := NEW.id;
  ELSE
    hid := COALESCE(NEW.holiday_id, OLD.holiday_id);
  END IF;
  SELECT applies_to_all INTO all_locations FROM holiday WHERE id = hid;
  IF NOT FOUND THEN
    RETURN NULL;   -- the holiday was deleted
  END IF;
  SELECT EXISTS (SELECT 1 FROM holiday_location WHERE holiday_id = hid) INTO has_rows;
  IF all_locations = has_rows THEN
    RAISE EXCEPTION 'HOLIDAY_SCOPE_INVALID: a holiday applies to all locations or to a non-empty list, not both/neither'
      USING ERRCODE = 'TK004';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER holiday_scope_check
  AFTER INSERT OR UPDATE OF applies_to_all ON holiday
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_holiday_scope();
CREATE CONSTRAINT TRIGGER holiday_location_scope_check
  AFTER INSERT OR DELETE ON holiday_location
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_holiday_scope();

-- Down Migration
DROP TRIGGER holiday_location_scope_check ON holiday_location;
DROP TRIGGER holiday_scope_check ON holiday;
DROP FUNCTION check_holiday_scope();
DROP TABLE holiday_location;
DROP TABLE holiday;
DROP TABLE working_day_exception;
DROP TRIGGER working_week_day_complete ON working_week_day;
DROP TRIGGER working_week_version_complete ON working_week_version;
DROP FUNCTION check_working_week_complete();
DROP TABLE working_week_day;
DROP TABLE working_week_version;
DROP TABLE attendance_rule_version;
