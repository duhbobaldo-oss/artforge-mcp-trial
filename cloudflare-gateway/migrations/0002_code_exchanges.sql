-- Strongly consistent single-use guard for authorization codes (Workers KV is eventually consistent).
-- One row per OAuth grant, written on its first authorization_code exchange. Also counts activations.
CREATE TABLE IF NOT EXISTS code_exchanges (
  grant_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exchanged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS code_exchanges_user ON code_exchanges (user_id);
