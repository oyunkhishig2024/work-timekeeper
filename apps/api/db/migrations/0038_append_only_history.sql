-- Up Migration
-- Defense in depth: the application login can no longer rewrite or erase attendance history, even through a bug or a
-- stolen app credential. Raw events and corrections keep only the narrow updates the app really makes (review, revoke,
-- coordinate erasure, anonymization); the status log is fully append-only. Retention (PRD 15.3) still deletes old rows through
-- purge_old_attendance(), a SECURITY DEFINER function owned by the migration role (0030), so it is not affected.
-- attendance_result stays writable: it is derived data and recompute rewrites it.
--
-- A new column on these tables that the app must UPDATE needs its own GRANT UPDATE (column) in the migration that adds it.

REVOKE DELETE ON device_event, attendance_correction, attendance_result_log FROM app_user;
REVOKE UPDATE ON attendance_result_log FROM app_user;

REVOKE UPDATE ON device_event FROM app_user;
GRANT UPDATE (counted, review_status, reviewed_by, reviewed_at, review_note, lat, lng, coordinates_erased_at)
  ON device_event TO app_user;

REVOKE UPDATE ON attendance_correction FROM app_user;
GRANT UPDATE (note, revoked_at, revoked_by, revoke_note) ON attendance_correction TO app_user;

-- Down Migration
GRANT UPDATE ON attendance_correction TO app_user;
GRANT UPDATE ON device_event TO app_user;
GRANT UPDATE ON attendance_result_log TO app_user;
GRANT DELETE ON device_event, attendance_correction, attendance_result_log TO app_user;
