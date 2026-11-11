-- Additive only: existing OAuth, ownership and statistics tables are untouched.
CREATE TABLE IF NOT EXISTS image_generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  day TEXT NOT NULL,
  neuron_units INTEGER NOT NULL CHECK(neuron_units > 0),
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','cancelled','deleted','expired')),
  spec TEXT NOT NULL,
  image TEXT,
  mime TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, operation_id)
);
CREATE INDEX IF NOT EXISTS image_generation_day ON image_generation_jobs(day);
CREATE INDEX IF NOT EXISTS image_generation_owner ON image_generation_jobs(user_id,day);
CREATE TRIGGER IF NOT EXISTS image_generation_global_quota
BEFORE INSERT ON image_generation_jobs
WHEN (SELECT COALESCE(SUM(neuron_units),0) FROM image_generation_jobs WHERE day=NEW.day) + NEW.neuron_units > 90000
BEGIN SELECT RAISE(ABORT,'GENERATION_DAILY_QUOTA'); END;
CREATE TRIGGER IF NOT EXISTS image_generation_user_quota
BEFORE INSERT ON image_generation_jobs
WHEN (SELECT COUNT(*) FROM image_generation_jobs WHERE user_id=NEW.user_id AND day=NEW.day) >= 3
BEGIN SELECT RAISE(ABORT,'GENERATION_USER_QUOTA'); END;
