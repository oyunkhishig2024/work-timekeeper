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
END
$$;
