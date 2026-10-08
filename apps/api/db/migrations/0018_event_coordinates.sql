-- Up Migration
-- Raw coordinates on device events, for the plausibility check IMPOSSIBLE_SPEED (PRD 6.7).
-- PRD 15.3: raw coordinates are erased after 30 days (the event itself, with its geofence level, stays); the worker
-- sets lat/lng to NULL and records the time in coordinates_erased_at.

ALTER TABLE device_event
  ADD COLUMN lat double precision CHECK (lat BETWEEN -90 AND 90),
  ADD COLUMN lng double precision CHECK (lng BETWEEN -180 AND 180),
  ADD COLUMN coordinates_erased_at timestamptz,
  ADD CHECK ((lat IS NULL) = (lng IS NULL)),
  ADD CHECK (coordinates_erased_at IS NULL OR lat IS NULL);
-- Finds the neighbouring fixes of an employee in time order, and the rows the erasure job must clear.
CREATE INDEX device_event_fix_idx ON device_event (tenant_id, employee_id, occurred_at) WHERE lat IS NOT NULL;
CREATE INDEX device_event_erase_idx ON device_event (received_at) WHERE lat IS NOT NULL;

-- Down Migration
DROP INDEX device_event_erase_idx;
DROP INDEX device_event_fix_idx;
ALTER TABLE device_event DROP COLUMN coordinates_erased_at, DROP COLUMN lng, DROP COLUMN lat;
