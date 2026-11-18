-- Commit-email verification (issue #115): operational state only. The
-- verified outcome is an append-only `email/` record in the data repo;
-- this table holds the one-time challenges. The token is stored hashed,
-- single-use, and expiring — a leaked table never yields a usable link.
CREATE TABLE IF NOT EXISTS email_challenges (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  ribose_sub TEXT NOT NULL,
  login TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
