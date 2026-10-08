-- Up Migration
-- Temporary IP blocks written by the adaptive abuse protection (apps/api/src/security). Not a tenant table: an
-- address is blocked for the whole service. The API keeps the live state in memory and uses this table so that bans
-- survive a restart, can be listed / lifted by an operator (CLI `ip-blocks`) and can be shared by several API
-- instances. History is kept (a lifted or expired row stays) so repeat offenders escalate to longer bans.

CREATE TABLE ip_block (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip          inet NOT NULL,
  strike      integer NOT NULL CHECK (strike >= 0),     -- 0 = manual block by an operator
  reason      text NOT NULL,
  signals     jsonb NOT NULL DEFAULT '{}'::jsonb,        -- what the detector saw (counts per signal, score)
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  lifted_at   timestamptz,
  lifted_by   text,
  CHECK (expires_at > created_at)
);
CREATE INDEX ip_block_ip_idx ON ip_block (ip, created_at DESC);
CREATE INDEX ip_block_active_idx ON ip_block (expires_at) WHERE lifted_at IS NULL;
-- Service-wide data: only the platform role may touch it (like platform_user); tenant sessions (app_user) cannot.
ALTER TABLE ip_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE ip_block FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_all ON ip_block TO platform_admin USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON ip_block TO platform_admin;

-- Down Migration
DROP TABLE ip_block;
