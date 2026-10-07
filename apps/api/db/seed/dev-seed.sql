-- Development seed for tenant "310" (PRD 3). Safe to run repeatedly.
-- Run as the migration owner (bypasses RLS): DATABASE_URL=... pnpm --filter @timekeeper/api db:seed
--
-- !! Location coordinates and radii below are PLACEHOLDERS (central Ulaanbaatar with small offsets).
-- !! Replace them with the real coordinates in the admin app before any real device test.

DO $$
DECLARE
  t uuid;
BEGIN
  INSERT INTO tenant (code, name) VALUES ('310', '310')
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO t FROM tenant WHERE code = '310';

  INSERT INTO department (tenant_id, name) VALUES
    (t, 'Хүний нөөц'), (t, 'Санхүү'), (t, 'Хангамж'), (t, 'Хамгаалалт')
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO job_rank (tenant_id, name, sort_order) VALUES
    (t, 'Ахлагч', 1), (t, 'Ахлах ахлагч', 2), (t, 'Дэслэгч', 3), (t, 'Ахлах дэслэгч', 4),
    (t, 'Ахмад', 5), (t, 'Хошууч', 6), (t, 'Дэд хурандаа', 7), (t, 'Хурандаа', 8)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO location (tenant_id, name, address, lat, lng, radius_m) VALUES
    (t, 'Төв салбар',     'PLACEHOLDER', 47.9184, 106.9177, 200),
    (t, 'Цагаан даваа',   'PLACEHOLDER', 47.9200, 106.9200, 200),
    (t, 'Хужирбулан',     'PLACEHOLDER', 47.9220, 106.9220, 200),
    (t, 'Налайх',         'PLACEHOLDER', 47.9240, 106.9240, 200),
    (t, 'Найман шарга',   'PLACEHOLDER', 47.9260, 106.9260, 200),
    (t, 'ЭМАА',           'PLACEHOLDER', 47.9280, 106.9280, 200)
  ON CONFLICT (tenant_id, name) DO NOTHING;

  INSERT INTO tenant_setting (tenant_id, key, value) VALUES
    (t, 'anomaly_mode', '"accept_and_flag"'),
    (t, 'correction_approval', '"off"'),
    (t, 'accuracy_threshold_m', '50')
  ON CONFLICT (tenant_id, key) DO NOTHING;

  -- Placeholder consent text. The real text is Appendix A of the PRD, which must be reviewed by legal
  -- counsel before use; is_draft = true keeps it from being printed for real employees.
  INSERT INTO consent_text_version (tenant_id, version, body, is_draft, active) VALUES
    (t, 'consent-v1-draft',
     'DRAFT - replace with the legally reviewed text (docs/Timekeeper_Work_PRD.md, Appendix A).', true, true)
  ON CONFLICT (tenant_id, version) DO NOTHING;
  -- Attendance rules: tenant default (PRD 6.2–6.4, 23.2): grace 15 min, no-show after 2 h, minimum stay 3 min.
  INSERT INTO attendance_rule_version (tenant_id, valid_from)
  SELECT t, DATE '2026-01-01'
   WHERE NOT EXISTS (SELECT 1 FROM attendance_rule_version WHERE tenant_id = t AND location_id IS NULL);

  -- Working week for tenant 310 (PRD 14.1): Mon–Fri 08:30–17:30, Saturday and Sunday off.
  -- No holiday dates are seeded on purpose: the Org Admin enters them each year (PRD 14.2).
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

  -- Example shift templates and a rotation for the guards (Хамгаалалт). PLACEHOLDERS: HR (Ganbat) supplies the
  -- real shift list; these only make the development environment usable (PRD 23.6).
  INSERT INTO shift_template (tenant_id, name, start_time, duration_minutes) VALUES
    (t, '24 цаг 08:00',     TIME '08:00', 1440),
    (t, 'Өдрийн 08:00–20:00', TIME '08:00', 720),
    (t, 'Шөнийн 20:00–08:00', TIME '20:00', 720)
  ON CONFLICT (tenant_id, name) WHERE active DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM shift_pattern WHERE tenant_id = t AND name = '24 цаг ажил / 48 цаг амралт') THEN
    WITH p AS (
      INSERT INTO shift_pattern (tenant_id, name, cycle_length_days)
      VALUES (t, '24 цаг ажил / 48 цаг амралт', 3) RETURNING id
    )
    INSERT INTO shift_pattern_day (tenant_id, pattern_id, day_index, template_id)
    SELECT t, p.id, d.i,
           CASE WHEN d.i = 0 THEN (SELECT id FROM shift_template WHERE tenant_id = t AND name = '24 цаг 08:00' AND active) END
      FROM p, generate_series(0, 2) AS d(i);
  END IF;
END
$$;
