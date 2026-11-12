-- Join requests: operational state only (docs/design.md §4) — the LEGAL
-- outcome of an approval is an append-only ocla-mod record in the data
-- repo; this table is the pending-work queue the PoC console works from.
CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  ocla_id TEXT NOT NULL,
  login TEXT NOT NULL,
  ribose_sub TEXT NOT NULL,
  email TEXT,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  decided_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS join_requests_one_pending
  ON join_requests (ocla_id, login, status) WHERE status = 'pending';
