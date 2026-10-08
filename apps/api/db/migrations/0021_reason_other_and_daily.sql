-- Up Migration
-- «Бусад» (Other) reason that needs a written explanation, and what the daily attendance screen shows (PRD 9, 11, 6.5).

ALTER TABLE absence_reason ADD COLUMN requires_description boolean NOT NULL DEFAULT false;

-- The predefined reasons are now 16: «Бусад» comes last. A reason that requires a description cannot be assigned without one
-- (checked by the API); the text is shown next to the day in the daily attendance and reports.
CREATE OR REPLACE FUNCTION seed_default_reasons(t uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO absence_reason (tenant_id, name, sort_order, requires_description)
  SELECT t, r.name, r.ord, r.name = 'Бусад'
    FROM unnest(ARRAY[
      'Албан ажилтай', 'Сургалттай', 'Парадны бэлтгэл', 'ЭДА', 'Бүтээн байгуулалт',
      'Өвчтэй', 'Чөлөөтэй', 'Ээлжийн амралт', 'Хүний нөөцийн мэдэлд', 'ЭДА бэлтгэл',
      'Хээрийн байрлалд', 'Тамирчин', 'Гадна объект', 'Малын суурь', 'Тасалсан', 'Бусад'
    ]) WITH ORDINALITY AS r(name, ord)
  ON CONFLICT (tenant_id, name) DO NOTHING
$$;

-- Tenants that already have their reasons get «Бусад» too (after their last reason), or the flag if they made it themselves.
UPDATE absence_reason SET requires_description = true WHERE name = 'Бусад';
INSERT INTO absence_reason (tenant_id, name, sort_order, requires_description)
SELECT t.tenant_id, 'Бусад', t.next_order, true
  FROM (SELECT tenant_id, max(sort_order) + 1 AS next_order FROM absence_reason GROUP BY tenant_id) t
 WHERE NOT EXISTS (SELECT 1 FROM absence_reason a WHERE a.tenant_id = t.tenant_id AND a.name = 'Бусад');

-- The explanation of an excused day, copied from the assignment (derived data, rebuilt by recompute).
ALTER TABLE attendance_result ADD COLUMN reason_note text;

-- Down Migration
ALTER TABLE attendance_result DROP COLUMN reason_note;
DELETE FROM reason_assignment WHERE reason_id IN (SELECT id FROM absence_reason WHERE requires_description);
DELETE FROM absence_reason WHERE requires_description;
CREATE OR REPLACE FUNCTION seed_default_reasons(t uuid) RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO absence_reason (tenant_id, name, sort_order)
  SELECT t, r.name, r.ord
    FROM unnest(ARRAY[
      'Албан ажилтай', 'Сургалттай', 'Парадны бэлтгэл', 'ЭДА', 'Бүтээн байгуулалт',
      'Өвчтэй', 'Чөлөөтэй', 'Ээлжийн амралт', 'Хүний нөөцийн мэдэлд', 'ЭДА бэлтгэл',
      'Хээрийн байрлалд', 'Тамирчин', 'Гадна объект', 'Малын суурь', 'Тасалсан'
    ]) WITH ORDINALITY AS r(name, ord)
  ON CONFLICT (tenant_id, name) DO NOTHING
$$;
ALTER TABLE absence_reason DROP COLUMN requires_description;
