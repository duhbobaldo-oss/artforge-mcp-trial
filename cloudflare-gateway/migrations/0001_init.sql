-- Gateway state that is not OAuth (OAuth grants/tokens live in OAUTH_KV, managed by the library).
CREATE TABLE IF NOT EXISTS access_codes (
  code_hash TEXT PRIMARY KEY,          -- SHA-256 of the normalized code; the code itself is never stored
  user_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ownership (
  kind TEXT NOT NULL,                  -- doc | plan | artifact
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS ownership_user ON ownership (user_id, kind);
