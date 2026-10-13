-- Up Migration
-- Indexes for the foreign keys and filters that the database review found without one (sequential scans at scale: location
-- reports, employee lookups, the retention delete of the audit log by time alone). Holiday and working-week children are
-- already covered by their primary keys. Plain CREATE INDEX: the tables are small at
-- migration time; on a large live table create them with CONCURRENTLY by hand first (IF NOT EXISTS keeps this safe).
CREATE INDEX IF NOT EXISTS device_event_time_idx ON device_event (tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS device_event_location_idx ON device_event (tenant_id, location_id);
CREATE INDEX IF NOT EXISTS attendance_result_location_idx ON attendance_result (tenant_id, location_id);
CREATE INDEX IF NOT EXISTS onboarding_qr_employee_idx ON onboarding_qr (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS device_alert_employee_idx ON device_alert (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS audit_log_global_time_idx ON audit_log (occurred_at);

-- Down Migration
DROP INDEX IF EXISTS audit_log_global_time_idx;
DROP INDEX IF EXISTS device_alert_employee_idx;
DROP INDEX IF EXISTS onboarding_qr_employee_idx;
DROP INDEX IF EXISTS attendance_result_location_idx;
DROP INDEX IF EXISTS device_event_location_idx;
DROP INDEX IF EXISTS device_event_time_idx;
