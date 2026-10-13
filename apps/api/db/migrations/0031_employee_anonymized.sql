-- Up Migration
-- An archived employee can be anonymized (PRD 15.3, data-subject requests): the name, free-text titles, account and
-- device details are replaced and the daily attendance numbers stay. Irreversible, so a reactivation is refused afterwards.
ALTER TABLE employee ADD COLUMN anonymized_at timestamptz;

-- Down Migration
ALTER TABLE employee DROP COLUMN anonymized_at;
