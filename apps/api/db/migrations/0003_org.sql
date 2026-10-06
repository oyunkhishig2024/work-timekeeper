-- Up Migration
-- Departments and locations. PRD 13, 13.1.

CREATE TABLE department (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER department_updated_at BEFORE UPDATE ON department
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('department');

CREATE TABLE location (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  name               text NOT NULL,
  address            text,
  lat                double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng                double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m           integer NOT NULL CHECK (radius_m BETWEEN 100 AND 500),   -- PRD 13
  active             boolean NOT NULL DEFAULT true,
  -- INHERIT = use the tenant Working Week; OVERRIDE = location has its own (PRD 14.1).
  working_week_mode  text NOT NULL DEFAULT 'INHERIT' CHECK (working_week_mode IN ('INHERIT', 'OVERRIDE')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE TRIGGER location_updated_at BEFORE UPDATE ON location
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
SELECT apply_tenant_rls('location');

-- Down Migration
DROP TABLE location;
DROP TABLE department;
