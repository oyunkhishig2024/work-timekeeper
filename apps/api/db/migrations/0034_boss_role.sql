-- Up Migration
-- A new account role, BOSS: sees the whole organization in the web app, read-only, and is not tracked (no phone, no arrival
-- or departure). Unlike a MANAGER (limited to a scope, tracked like an employee), a BOSS has no employee record.
ALTER TABLE user_account DROP CONSTRAINT user_account_role_check;
ALTER TABLE user_account ADD CONSTRAINT user_account_role_check
  CHECK (role IN ('ORG_ADMIN', 'HR', 'MANAGER', 'BOSS', 'EMPLOYEE'));

-- Down Migration
-- A BOSS account cannot exist under the older rule: keep it as a disabled MANAGER account so nothing is lost or deleted.
UPDATE user_account SET role = 'MANAGER', status = 'DISABLED' WHERE role = 'BOSS';
ALTER TABLE user_account DROP CONSTRAINT user_account_role_check;
ALTER TABLE user_account ADD CONSTRAINT user_account_role_check
  CHECK (role IN ('ORG_ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'));
