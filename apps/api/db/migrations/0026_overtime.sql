-- PRD 23.2 (v1.28): minutes stayed after the end of the duty (more than the tolerance); 0 otherwise.
-- Derived like the rest of attendance_result, rebuilt by POST /v1/attendance/recompute.
ALTER TABLE attendance_result
  ADD COLUMN overtime_minutes integer NOT NULL DEFAULT 0 CHECK (overtime_minutes >= 0);
