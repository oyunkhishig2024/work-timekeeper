-- Up Migration
-- Retention deletes (PRD 15.3): attendance data after ATTENDANCE_RETENTION_DAYS (default 2 years), the audit log after
-- AUDIT_RETENTION_DAYS. The application roles have no DELETE on the append-only tables, so the worker calls these two
-- maintenance functions (SECURITY DEFINER, owned by the migration role). They only delete rows older than the cutoff they are given.

-- The function owner must be allowed to delete from these FORCE-RLS tables even when it is not a superuser.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'device_event', 'attendance_result', 'attendance_result_log', 'attendance_correction',
    'reason_assignment', 'device_alert', 'shift_override', 'audit_log'
  ] LOOP
    EXECUTE format('CREATE POLICY retention_purge ON %I FOR DELETE TO %I USING (true)', t, current_user);
  END LOOP;
END
$$;

-- Deletes the current tenant's attendance data older than p_cutoff (a date). Tenant = current_tenant_id() (set by the
-- worker's tenant transaction), so a caller cannot purge another organization. Returns how many rows went per table.
CREATE FUNCTION purge_old_attendance(p_cutoff date) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t uuid := current_tenant_id();
  n_events bigint;
  n_corrections bigint;
  n_log bigint;
  n_results bigint;
  n_reasons bigint;
  n_alerts bigint;
  n_overrides bigint;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'purge_old_attendance needs a tenant context';
  END IF;
  DELETE FROM device_event WHERE tenant_id = t AND occurred_at < p_cutoff;
  GET DIAGNOSTICS n_events = ROW_COUNT;
  DELETE FROM attendance_correction WHERE tenant_id = t AND work_date < p_cutoff;
  GET DIAGNOSTICS n_corrections = ROW_COUNT;
  DELETE FROM attendance_result_log WHERE tenant_id = t AND work_date < p_cutoff;
  GET DIAGNOSTICS n_log = ROW_COUNT;
  DELETE FROM attendance_result WHERE tenant_id = t AND work_date < p_cutoff;
  GET DIAGNOSTICS n_results = ROW_COUNT;
  DELETE FROM reason_assignment WHERE tenant_id = t AND to_date IS NOT NULL AND to_date < p_cutoff;
  GET DIAGNOSTICS n_reasons = ROW_COUNT;
  DELETE FROM device_alert WHERE tenant_id = t AND resolved_at IS NOT NULL AND resolved_at < p_cutoff;
  GET DIAGNOSTICS n_alerts = ROW_COUNT;
  DELETE FROM shift_override WHERE tenant_id = t AND work_date < p_cutoff;
  GET DIAGNOSTICS n_overrides = ROW_COUNT;
  RETURN jsonb_build_object(
    'deviceEvents', n_events, 'corrections', n_corrections, 'resultLog', n_log, 'results', n_results,
    'reasonAssignments', n_reasons, 'deviceAlerts', n_alerts, 'shiftOverrides', n_overrides
  );
END
$$;

-- Deletes audit rows older than p_cutoff (all organizations). Platform role only.
CREATE FUNCTION purge_old_audit(p_cutoff timestamptz) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM audit_log WHERE occurred_at < p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION purge_old_attendance(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_old_audit(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_old_attendance(date) TO app_user;
GRANT EXECUTE ON FUNCTION purge_old_audit(timestamptz) TO platform_admin;

-- Down Migration
DROP FUNCTION purge_old_audit(timestamptz);
DROP FUNCTION purge_old_attendance(date);
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'device_event', 'attendance_result', 'attendance_result_log', 'attendance_correction',
    'reason_assignment', 'device_alert', 'shift_override', 'audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY retention_purge ON %I', t);
  END LOOP;
END
$$;
