-- Up Migration
-- Absence reasons (Шалтгааны бүртгэл) and dated reason assignments. PRD 11, 6.6, 12.2.
--
-- A reason assignment covers a calendar date range (inclusive) for one employee; while it covers a date the
-- employee is shown as "Шалтгаантай" instead of Ирээгүй (the rule itself lives in packages/domain / the
-- attendance engine). An employee has at most one reason at a time, so the status of a date is unambiguous.
-- History is kept: assignments are ended, not rewritten (PRD 12.2).

CREATE TABLE absence_reason (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL,
  sort_order  integer NOT NULL CHECK (sort_order > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
SELECT apply_tenant_rls('absence_reason');

CREATE TABLE reason_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  employee_id  uuid NOT NULL,
  reason_id    uuid NOT NULL,
  from_date    date NOT NULL,
  to_date      date,                 -- inclusive; NULL = open until ended
  description  text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_by     uuid,
  ended_at     timestamptz,          -- set when HR ends it early
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employee (tenant_id, id),
  FOREIGN KEY (tenant_id, reason_id) REFERENCES absence_reason (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES user_account (tenant_id, id),
  FOREIGN KEY (tenant_id, ended_by) REFERENCES user_account (tenant_id, id),
  CHECK (to_date IS NULL OR to_date >= from_date),
  EXCLUDE USING gist (
    tenant_id WITH =,
    employee_id WITH =,
    daterange(from_date, to_date, '[]') WITH &&
  )
);
CREATE INDEX reason_assignment_reason_idx ON reason_assignment (tenant_id, reason_id);
CREATE INDEX reason_assignment_dates_idx ON reason_assignment (tenant_id, from_date, to_date);
SELECT apply_tenant_rls('reason_assignment');

-- The 15 predefined reasons of PRD 11, in their listed order. Called when a tenant is set up (and by the dev seed);
-- safe to repeat.
CREATE FUNCTION seed_default_reasons(t uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO absence_reason (tenant_id, name, sort_order)
  SELECT t, r.name, r.ord
    FROM unnest(ARRAY[
      'Албан ажилтай', 'Сургалттай', 'Парадны бэлтгэл', 'ЭДА', 'Бүтээн байгуулалт',
      'Өвчтэй', 'Чөлөөтэй', 'Ээлжийн амралт', 'Хүний нөөцийн мэдэлд', 'ЭДА бэлтгэл',
      'Хээрийн байрлалд', 'Тамирчин', 'Гадна объект', 'Малын суурь', 'Тасалсан'
    ]) WITH ORDINALITY AS r(name, ord)
  ON CONFLICT (tenant_id, name) DO NOTHING
$$;

-- Down Migration
DROP FUNCTION seed_default_reasons(uuid);
DROP TABLE reason_assignment;
DROP TABLE absence_reason;
