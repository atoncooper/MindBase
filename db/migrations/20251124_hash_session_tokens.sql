-- Hash opaque session tokens at rest.
--
-- Deploy app-user with TokenHash support BEFORE running this migration: the new
-- code still accepts legacy plaintext rows, validates them once, and rewrites
-- that row on demand. This bulk UPDATE removes the remaining plaintext rows.
--
-- The "sha256:" prefix makes the migration unambiguous: raw tokens are 64
-- base64url chars; stored values become "sha256:<64 hex>".
--
-- Apply once against the shared mind_base database.

START TRANSACTION;

UPDATE user_tokens
SET session_token = CONCAT('sha256:', SHA2(session_token, 256))
WHERE session_token NOT LIKE 'sha256:%';

COMMIT;

-- Verification: must return 0.
-- SELECT COUNT(*) FROM user_tokens WHERE session_token NOT LIKE 'sha256:%';
