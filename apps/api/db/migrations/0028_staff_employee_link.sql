-- Up Migration
-- PRD 4 (v1.32): an Org Admin, HR or Manager account can be linked to the person's own employee record, so the person
-- registers a phone and records their own attendance like any employee, and uses the web app as before.
-- Until now the rule was "an employee account has an employee, staff accounts have none" (0005).
DO $$
DECLARE
  name text;
BEGIN
  SELECT c.conname INTO name
    FROM pg_constraint c
   WHERE c.conrelid = 'user_account'::regclass AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%employee_id IS NOT NULL%';
  IF name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE user_account DROP CONSTRAINT %I', name);
  END IF;
END
$$;

-- An EMPLOYEE account always belongs to an employee; a staff account may (the unique index still allows one account per employee).
ALTER TABLE user_account
  ADD CONSTRAINT user_account_employee_role_check CHECK (role <> 'EMPLOYEE' OR employee_id IS NOT NULL);

-- Down Migration
-- Staff accounts linked to an employee record go back to having none (the older rule).
UPDATE user_account SET employee_id = NULL WHERE role <> 'EMPLOYEE' AND employee_id IS NOT NULL;
ALTER TABLE user_account DROP CONSTRAINT user_account_employee_role_check;
ALTER TABLE user_account ADD CONSTRAINT user_account_check CHECK ((role = 'EMPLOYEE') = (employee_id IS NOT NULL));
