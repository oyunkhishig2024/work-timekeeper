-- PRD 6.4 / 23.2 (v1.25): the departure shown next to the arrival. Derived data like the rest of attendance_result,
-- rebuilt by POST /v1/attendance/recompute.
ALTER TABLE attendance_result
  ADD COLUMN departure_at    timestamptz,
  -- LEFT (departure_at is the last EXIT), INSIDE (still there), UNKNOWN (never reported leaving); null without an arrival.
  ADD COLUMN departure_state text CHECK (departure_state IN ('LEFT', 'INSIDE', 'UNKNOWN'));
