-- PRD 14.2 (v1.31): a day someone came on a day nobody is expected (WORKED_OFF_DAY) says which kind of day it was.
-- Derived like the rest of attendance_result, rebuilt by POST /v1/attendance/recompute.
ALTER TABLE attendance_result
  ADD COLUMN off_day_kind text CHECK (off_day_kind IN ('HOLIDAY', 'OFF_DAY'));
