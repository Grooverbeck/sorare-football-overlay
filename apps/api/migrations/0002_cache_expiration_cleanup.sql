-- Existing successful market snapshots were intentionally immutable but had
-- no storage retention. They are never queried after their fixture rolls over,
-- so give them a conservative two-week retention from their last write.
UPDATE cache_entries
SET expires_at = updated_at + 1209600
WHERE cache_key LIKE 'market-odds:v1:%'
  AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cache_entries_expires_at
ON cache_entries (expires_at)
WHERE expires_at IS NOT NULL;
