-- Up Migration
-- Append-only audit log. PRD 15.1. Rows are written in the same transaction as the change they record.
-- app_user can only SELECT and INSERT; there is no UPDATE/DELETE privilege. Retention deletes (PRD 15.3)
-- will run through a controlled maintenance function owned by the migration role.

CREATE TABLE audit_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid REFERENCES tenant (id),   -- NULL for platform-level actions
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,
  actor_role     text,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  before         jsonb,
  after          jsonb,
  ip             inet,
  user_agent     text,
  prev_hash      text,   -- optional hash chain (Architecture Section 10); verification enabled later
  row_hash       text
);
CREATE INDEX audit_log_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (tenant_id, entity_type, entity_id);
CREATE INDEX audit_log_actor_idx ON audit_log (tenant_id, actor_user_id);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT TO app_user
  USING (tenant_id = current_tenant_id());
CREATE POLICY audit_insert ON audit_log FOR INSERT TO app_user
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY audit_platform ON audit_log TO platform_admin USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON audit_log TO app_user, platform_admin;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_user, platform_admin;

-- Down Migration
DROP TABLE audit_log;
