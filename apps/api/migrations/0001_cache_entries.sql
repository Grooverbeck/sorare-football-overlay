CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
