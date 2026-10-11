-- A refresh token is used once and then replaced (rotation). The time of that replacement is kept apart from `revoked_at`, so the
-- server can tell a token that was rotated a moment ago (a phone retrying after a lost answer, or two parts of the app refreshing
-- together) from one that was revoked by a logout or by theft detection.
ALTER TABLE auth_session ADD COLUMN rotated_at timestamptz;
