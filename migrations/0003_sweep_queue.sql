-- The write-back sweep queue (issue #59): logins whose coverage changed
-- (signature, OCLA execution, Schedule A modification, election,
-- revocation) wait here for the bounded sweep. Operational state only —
-- the legal truth stays in the data repo.
CREATE TABLE IF NOT EXISTS sweep_queue (
  login TEXT PRIMARY KEY,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  cursor TEXT
);
