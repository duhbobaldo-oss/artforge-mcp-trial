-- Public page statistics and ratings for the OBR "AI Plugins" section.
-- Privacy: no IP address or user agent is stored, only HMAC digests keyed by a Worker secret.
ALTER TABLE access_codes ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
UPDATE access_codes SET is_test = 1 WHERE label LIKE 'beta-test%' OR label LIKE 'e2e%';

CREATE TABLE IF NOT EXISTS plugin_views (
  plugin TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0
);
-- One row per visitor and plugin; a visit is counted again only after 30 minutes. Purged after 2 days.
CREATE TABLE IF NOT EXISTS plugin_view_seen (
  plugin TEXT NOT NULL,
  visitor TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, visitor)
);
-- One rating per visitor: the same network fingerprint or the same browser updates its earlier rating.
CREATE TABLE IF NOT EXISTS plugin_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin TEXT NOT NULL,
  voter TEXT NOT NULL,
  client TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_ratings_voter ON plugin_ratings (plugin, voter);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_ratings_client ON plugin_ratings (plugin, client);
CREATE TABLE IF NOT EXISTS plugin_rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, subject)
);
