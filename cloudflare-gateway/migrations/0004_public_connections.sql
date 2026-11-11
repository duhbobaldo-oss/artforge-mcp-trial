-- Public OAuth connections have isolated identities and can be deactivated.
-- Migrate existing identities to preserve their tokens, document ownership and test flags.
CREATE TABLE gateway_users (
  user_id TEXT PRIMARY KEY,
  initial_client_id TEXT,
  created_at INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1)),
  is_test INTEGER NOT NULL DEFAULT 0 CHECK(is_test IN (0, 1))
);
INSERT INTO gateway_users (user_id, created_at, disabled, is_test)
SELECT user_id, MIN(created_at), MIN(disabled), MAX(is_test)
FROM access_codes GROUP BY user_id;
