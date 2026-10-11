-- Baseline for tenant 310 on a fresh server (safe to run repeatedly): default reasons, attendance rules
-- (grace 15 min, minimum stay 3 min), working week Mon-Fri 08:30-17:30, a DRAFT consent text.
-- Run as the database owner:  psql -U timekeeper -d timekeeper -v ON_ERROR_STOP=1 -f baseline-310.sql
DO $$
DECLARE
  t uuid;
BEGIN
  INSERT INTO tenant (code, name) VALUES ('310', '310') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO t FROM tenant WHERE code = '310';

  PERFORM seed_default_reasons(t);

  INSERT INTO tenant_setting (tenant_id, key, value) VALUES
    (t, 'anomaly_mode', '"accept_and_flag"'),
    (t, 'correction_approval', '"off"'),
    (t, 'accuracy_threshold_m', '50')
  ON CONFLICT (tenant_id, key) DO NOTHING;

  INSERT INTO consent_text_version (tenant_id, version, body, is_draft, active)
  SELECT t, 'consent-v1-draft',
         'DRAFT - replace with the legally reviewed text (docs/Timekeeper_Work_PRD.md, Appendix A).', true, true
   WHERE NOT EXISTS (SELECT 1 FROM consent_text_version WHERE tenant_id = t);

  INSERT INTO attendance_rule_version (tenant_id, valid_from)
  SELECT t, DATE '2026-01-01'
   WHERE NOT EXISTS (SELECT 1 FROM attendance_rule_version WHERE tenant_id = t AND location_id IS NULL);

  IF NOT EXISTS (SELECT 1 FROM working_week_version WHERE tenant_id = t AND location_id IS NULL) THEN
    WITH v AS (
      INSERT INTO working_week_version (tenant_id, valid_from) VALUES (t, DATE '2026-01-01') RETURNING id
    )
    INSERT INTO working_week_day (tenant_id, working_week_id, weekday, working, start_time, end_time)
    SELECT t, v.id, d, d <= 5,
           CASE WHEN d <= 5 THEN TIME '08:30' END,
           CASE WHEN d <= 5 THEN TIME '17:30' END
      FROM v, generate_series(1, 7) AS d;
  END IF;
END
$$;
