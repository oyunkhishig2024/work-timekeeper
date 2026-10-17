-- Up Migration
-- When the sign-in that started a session family happened. A refresh creates a new auth_session row in the same family, so the
-- family's start is carried over; web staff sessions end at that start plus STAFF_SESSION_MAX_HOURS however active they are.
-- Rows made before this migration have NULL: the code reads that as created_at.

ALTER TABLE auth_session ADD COLUMN session_started_at timestamptz;

-- Down Migration
ALTER TABLE auth_session DROP COLUMN session_started_at;
