-- Up Migration
-- Foreign-key columns that had no index: deleting or changing the parent row has to look for children, and without an index that is a
-- scan of the whole child table. (The `created_by` style audit columns are left out on purpose: no user, person or place is ever
-- deleted, they are only disabled, so those lookups never run.) Plain CREATE INDEX: these tables are small when this migration runs.
CREATE INDEX IF NOT EXISTS consent_record_text_version_idx ON consent_record (tenant_id, text_version);
CREATE INDEX IF NOT EXISTS onboarding_qr_use_employee_idx ON onboarding_qr_use (tenant_id, employee_id);
CREATE INDEX IF NOT EXISTS device_alert_related_employee_idx ON device_alert (tenant_id, related_employee_id);
CREATE INDEX IF NOT EXISTS user_scope_department_idx ON user_scope (tenant_id, department_id);

-- Down Migration
DROP INDEX IF EXISTS user_scope_department_idx;
DROP INDEX IF EXISTS device_alert_related_employee_idx;
DROP INDEX IF EXISTS onboarding_qr_use_employee_idx;
DROP INDEX IF EXISTS consent_record_text_version_idx;
